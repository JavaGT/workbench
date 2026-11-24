// Wave 1 lane w5-live-carets-cleanup: focused regression coverage for the
// caret broadcast hot path, revocation dedup lifetime, the single subscribe
// admission seam, and the shared protector-activation policy.

import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  annotatedText, annotation, ephemeral, entity, everyone, measurement, ref,
  registerAnnotatedTextContract, grant, read, subscribe,
} from '../build/index.mjs';
import { registerAnnotatedTextStructuralExtension, scope } from '../build/internal.mjs';
import { createAnnotatedTextCaretLive } from '../build/annotated-text-caret-live.mjs';
import { createLiveDeliveryCore } from '../build/live-delivery-core.mjs';
import { createLiveFanout } from '../build/live-fanout.mjs';
import { isProtectorActive } from '../build/annotated-text-recipient-projection.mjs';
import { executeDDL, executeFrameworkDDL } from '../build/ddl.mjs';
import { importTextToFamily, textFamilyCheckpoint } from '../build/annotated-text-continuous.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

// ── caret broadcast: one document-row load, concurrent recipients ──────────

const CARET_EXT = 'w5CaretCleanup';
registerAnnotatedTextContract(CARET_EXT, Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension(CARET_EXT, Object.freeze({
  version: 1,
  validate() {}, edit() {}, partition() {}, combine() {},
}));

function caretEntity() {
  return entity('CaretDoc', {
    project: ref('Project'), owner: ref('User'),
    presence: ephemeral({ caret: true }),
    body: annotatedText({
      project: 'project', owner: 'owner',
      carets: { field: 'presence', cell: 'caret' },
      annotations: [annotation('coding')],
      measurements: [measurement('words', { extension: CARET_EXT })],
    }),
    // A runtime .can clause (not a bare grant decision) makes an injected
    // mayVerb the subscribe-capability authority, which is what exercises the
    // per-recipient admission path. It still confers read+subscribe to the
    // projection's default row-grant.
    grant: () => [scope(() => everyone()).can(() => grant(read, subscribe))],
  });
}

const ACTOR = 'a'.repeat(32);

function countFullDocumentReads(db) {
  const originalPrepare = db.prepare.bind(db);
  let reads = 0;
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (!/^SELECT \* FROM CaretDoc\b/.test(sql.trim())) return statement;
    return new Proxy(statement, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'get' && typeof value === 'function') {
          return (...args) => { reads += 1; return value.apply(target, args); };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return () => reads;
}

function caretSetup({ recipientCount = 4, mayVerb = async () => true, countReads = false } = {}) {
  const db = new DatabaseSync(':memory:');
  const Doc = caretEntity();
  executeDDL(Doc, db);
  db.exec("CREATE TABLE Project (id TEXT PRIMARY KEY); INSERT INTO Project VALUES ('p1');");
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('u1'), ('u2');");
  db.prepare('INSERT INTO CaretDoc (id, project, owner) VALUES (?, ?, ?)').run('d1', 'p1', 'u1');
  const family = importTextToFamily('d1', ACTOR, '');
  db.prepare('INSERT INTO CaretDoc_body_state (document_id, structure_version, family_checkpoint) VALUES (?, 1, ?)')
    .run('d1', JSON.stringify(textFamilyCheckpoint(family)));

  const makeConn = (id, principalId) => {
    const messages = [];
    return {
      id, principal: { id: principalId }, closed: false,
      send(frame) { messages.push(frame); },
      messages,
    };
  };
  const writer = makeConn('writer', 'u1');
  const recipients = Array.from({ length: recipientCount }, (_, index) => makeConn(`recipient-${index}`, index % 2 === 0 ? 'u1' : 'u2'));
  const all = [writer, ...recipients];
  const fanout = {
    hasCaretInterest: (conn, scopeKey, field) => scopeKey === 'CaretDoc:d1' && field === 'body',
    recipients: (scopeKey, field) => scopeKey === 'CaretDoc:d1' && field === 'body'
      ? all.filter((conn) => !conn.closed).map((conn) => [conn, {}])
      : [],
    setOnCaretInterestChange() {},
  };
  const fullReads = countReads ? countFullDocumentReads(db) : () => 0;
  const live = createAnnotatedTextCaretLive({
    db, resolveEntity: (name) => name === 'CaretDoc' ? Doc : null, mayVerb, fanout,
  });
  const upserts = (conn) => conn.messages.filter((frame) => frame?.change?.op === 'upsert');
  return { db, live, writer, recipients, all, upserts, fullReads };
}

const update = (live, writer, offset) => live.update(writer, {
  type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', offset,
});

test('caret broadcast loads the document row once per turn, not once per recipient', async () => {
  const { db, live, writer, recipients, fullReads, upserts } = caretSetup({ recipientCount: 6, countReads: true });
  try {
    await update(live, writer, 0);
    assert.equal(fullReads(), 1, 'one full row load for the source is reused by all six recipients');
    assert.equal(upserts(writer).length, 1, 'the writer is itself a caret subscriber and gets its own projection');
    for (const recipient of recipients) {
      assert.equal(upserts(recipient).length, 1, 'each recipient still receives its own projection');
    }
    await update(live, writer, 0);
    assert.equal(fullReads(), 2, 'the second broadcast turn loads the row exactly once more');
    for (const recipient of recipients) {
      assert.equal(upserts(recipient).length, 2, 'each recipient gets a projected upsert on the second turn too');
    }
  } finally { db.close(); }
});

test('caret recipients are authorized and projected concurrently', async () => {
  let active = 0;
  let maxActive = 0;
  const mayVerb = async (entityRecord, verb, row, principal) => {
    if (principal?.id === 'writer') return true;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await nextTurn();
    active -= 1;
    return true;
  };
  const { db, live, writer, recipients, upserts } = caretSetup({ recipientCount: 5, mayVerb });
  try {
    await update(live, writer, 0);
    assert.ok(maxActive >= 5, `recipient admissions overlap instead of serializing (max ${maxActive})`);
    for (const recipient of recipients) assert.equal(upserts(recipient).length, 1);
  } finally { db.close(); }
});

test('a denied recipient still retracts on a later turn without reloading the row', async () => {
  let deny = null;
  const mayVerb = async (entityRecord, verb, row, principal) => principal?.id !== deny;
  const { db, live, writer, recipients, fullReads, upserts } = caretSetup({
    recipientCount: 2, mayVerb, countReads: true,
  });
  try {
    await update(live, writer, 0);
    assert.equal(upserts(recipients[0]).length, 1);
    assert.equal(upserts(recipients[1]).length, 1);

    deny = recipients[1].principal.id;
    await update(live, writer, 0);
    assert.equal(upserts(recipients[0]).length, 2, 'the authorized recipient still gets an upsert');
    assert.equal(upserts(recipients[1]).length, 1, 'the revoked recipient gets no second upsert');
    const removes = recipients[1].messages.filter((frame) => frame?.change?.op === 'remove');
    assert.equal(removes.length, 1, 'the revoked recipient is retracted');
    assert.equal(fullReads(), 2, 'one row load per broadcast turn, revocation included');
  } finally { db.close(); }
});

// ── revocation dedup lifetime ──────────────────────────────────────────────

function liveDb() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE IF NOT EXISTS Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)');
  return db;
}

function appendEvent(db, scopeKey, seq, type, data = {}) {
  db.prepare(
    'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(scopeKey, seq, type, JSON.stringify(data), `action-${seq}`, new Date().toISOString());
  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET lastSeq = excluded.lastSeq')
    .run(scopeKey, seq);
}

function noteRecord() {
  return {
    name: 'Note',
    hydrate: (row) => ({ ...row }),
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    grant: () => [scope(() => true).can(async () => true)],
    registry: {},
  };
}

const U1 = { type: 'user', id: 'u1' };

test('delivery-path revocation keys are pruned when the last subscriber detaches', async () => {
  const db = liveDb();
  db.prepare('INSERT INTO Note (id, title, owner) VALUES (?, ?, ?)').run('n1', 'hello', 'u1');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  // Odd auth call admits the subscribe; the even call denies its first catchUp,
  // which publishes a delivery-path revocation keyed on (scope, seq).
  let auths = 0;
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', noteRecord()]]),
    mayVerb: async () => { auths += 1; return auths % 2 === 1; },
    projectRecipient: ({ event }) => [{ seq: event.seq }],
  });
  const fired = [];
  core.onRevocation((_principal, resourceScope) => fired.push(resourceScope));

  for (let cycle = 0; cycle < 2; cycle += 1) {
    await core.subscribe({
      principal: U1, scope: 'Note:n1', after: 0, signal: null,
      deliver: async () => {},
    });
    await nextTurn();
  }

  assert.equal(fired.length, 2, 'the same (scope, seq) publishes again after the last subscriber detached');
  assert.deepEqual(fired, [
    { category: 'entity', key: 'Note:n1' },
    { category: 'entity', key: 'Note:n1' },
  ]);
  core.close();
  db.close();
});

test('many revoked scopes do not suppress later revocations or break the core', async () => {
  const db = liveDb();
  let allow = false;
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', noteRecord()]]),
    mayVerb: async () => { allow = !allow; return allow; },
    projectRecipient: ({ event }) => [{ seq: event.seq }],
  });
  let fired = 0;
  core.onRevocation(() => { fired += 1; });
  // More cycles than the dedup cap: each scope's subscription is removed after
  // its denial, so the map must stay bounded by both prune paths.
  for (let index = 0; index < 160; index += 1) {
    const id = `n${index}`;
    db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run(id, 'hello');
    appendEvent(db, `Note:${id}`, 1, 'Note.created', { title: 'hello' });
    await core.subscribe({
      principal: U1, scope: `Note:${id}`, after: 0, signal: null,
      deliver: async () => {},
    });
  }
  await nextTurn();
  assert.equal(fired, 160, 'every distinct revocation still publishes');
  core.revoke(U1, { category: 'entity', key: 'Note:n159' });
  assert.equal(fired, 161, 'the core still publishes after the stress run');
  core.close();
  db.close();
});

// ── single subscribe-admission seam in fan-out ─────────────────────────────

function fanoutConn(id) {
  const messages = [];
  return {
    id, closed: false, principal: { type: 'user', id },
    send(frame) { messages.push(frame); },
    drain() { const out = [...messages]; messages.length = 0; return out; },
  };
}

function fanoutEntity(fields = {}) {
  return {
    name: 'Doc', fields,
    grant: () => [scope(() => true).can(() => true)],
    findById() { return { id: 'd1', title: 'v1' }; },
  };
}

function denySubscribeAdapter(calls) {
  return {
    admit: async (input) => {
      calls.push({ fieldName: input.fieldName, verb: input.verb, operation: input.operation });
      return {
        admitted: input.fieldName !== undefined ? true : false,
        operation: input.operation ?? null,
        resourceCategory: input.category,
        resourceId: input.resourceId ?? null,
        reasonCode: input.fieldName === undefined ? 'no-capability' : null,
        capabilities: [],
        trace: null,
      };
    },
    registerResource() {},
  };
}

test('fan-out emit re-checks subscribe through the injected authorization adapter', async () => {
  const calls = [];
  const fanout = createLiveFanout({
    mayVerb: async () => true,
    authorization: denySubscribeAdapter(calls),
  });
  const conn = fanoutConn('alice');
  fanout.addSubscription('Doc', 'd1', conn);
  await fanout.emit(fanoutEntity(), 'd1', { id: 'd1', title: 'v1' }, {
    type: 'Doc.updated', seq: 1, data: { id: 'd1', title: 'v2' },
  });

  assert.deepEqual(conn.drain(), [], 'a policy-adapter denial at emit time delivers nothing');
  assert.ok(calls.some((call) => call.verb === 'subscribe' && call.operation === 'subscribe'
    && call.fieldName === undefined), 'the row subscribe decision went through the adapter');
  fanout.close();
});

test('fan-out paced flush re-checks subscribe through the injected authorization adapter', async () => {
  const calls = [];
  const fanout = createLiveFanout({
    mayVerb: async () => true,
    authorization: denySubscribeAdapter(calls),
  });
  const conn = fanoutConn('alice');
  const entityRecord = fanoutEntity({ cursor: { kind: 'ephemeral' } });
  fanout.addSubscription('Doc', 'd1', conn, { cursor: true }, { window: 15, by: 'latest-wins' });
  await fanout.emit(entityRecord, 'd1', { id: 'd1' }, {
    type: 'Doc.cursor.set', seq: 1, data: { x: 1 },
  });
  await sleep(60);

  assert.deepEqual(conn.drain(), [], 'a policy-adapter denial at flush time delivers nothing');
  assert.ok(calls.some((call) => call.verb === 'subscribe' && call.fieldName === undefined),
    'the flush re-check went through the adapter, not bare mayVerb');
  fanout.close();
});

// ── one shared protector-activation policy ─────────────────────────────────

test('the shared protector-activation policy validates every target before returning', () => {
  const ownRanges = [{ start: 0, end: 10 }];
  const rangesForTarget = () => [{ start: 2, end: 4 }];
  const knownTargetIds = new Set(['t1', 't2']);

  assert.equal(isProtectorActive({
    protectedTargetIds: ['t1', 't2'], ownRanges, knownTargetIds, rangesForTarget, textLength: 10,
  }), true, 'an intersecting target activates the protector');

  assert.equal(isProtectorActive({
    protectedTargetIds: ['t1'], ownRanges: [{ start: 5, end: 6 }], knownTargetIds,
    rangesForTarget, textLength: 10,
  }), false, 'a non-intersecting target does not activate');

  assert.equal(isProtectorActive({
    protectedTargetIds: ['t1'], ownRanges: [], knownTargetIds, rangesForTarget, textLength: 10,
  }), false, 'a rangeless protector never activates');

  assert.equal(isProtectorActive({
    protectedTargetIds: ['t1'], ownRanges: [{ start: 0, end: 10 }], knownTargetIds,
    rangesForTarget: () => undefined, textLength: 10, orphan: true,
  }), false, 'an orphan never activates, even whole-document');

  assert.throws(() => isProtectorActive({
    protectedTargetIds: ['t1', 't2'], ownRanges: [{ start: 0, end: 10 }],
    knownTargetIds: new Set(['t1']), rangesForTarget, textLength: 10,
    onUnknownTarget: (id) => { throw new Error(`unknown protected target ${id}`); },
  }), /unknown protected target t2/, 'a stale target fails closed even when t1 already activates');
});
