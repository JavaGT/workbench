// S5/A3 — Field and transition admission (issue #78).
//
// Field-level read admission is enforced uniformly in recipient projections:
// unreadable fields are omitted, unreadable annotated-text fields redact to the
// explicit restricted placeholder, denied writes fail 403 with a generic reason
// code (never a field name), interest/validation errors never reveal which
// field names exist, and update/delete admission evaluates the proposed
// after-row so a transition out of the principal's write scope is rejected even
// though the current row is in scope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { annotatedText, createAuthorizationAdapter, durableHistory, entity, everyone, grant, read, ref, scope, subscribe, text, write } from '../build/index.mjs';
import workbench, { generateDDL } from '../build/internal.mjs';
import { projectRowForRecipient } from '../build/entity/projection.mjs';
import { admitInferenceFields, admitRowTransition, annotatedTextDeniedPlaceholder, mayReadField, readableFieldNames } from '../build/field-admission.mjs';
import { authorizeFieldOp } from '../build/strategy/shared.mjs';
import { authorizeSubscription } from '../build/live-admission.mjs';
import { textCheckpoint, createTextState } from '../build/annotated-text.mjs';

const alice = { type: 'user', id: 'alice' };
const bob = { type: 'user', id: 'bob' };

// A Doc whose row grant grants read/write to the owner and read-only to every
// scoped member, plus a `secret` field whose own `.can` is readable/writable by
// the owner only. `title`/`owner` have no `.can` and strong-inherit the row grant.
function declareDoc() {
  return entity('Doc', {
    title: text(),
    owner: text(),
    secret: text().can(async ({ is }) => (await is.owner() ? grant(read, write) : grant())),
    checks: {
      owner: ({ entity: row, principal }) => row.owner === principal.id,
    },
    grant: () => [scope(() => everyone()).can(async ({ is }) => (
      await is.owner() ? grant(read, write, subscribe) : grant(read, subscribe)
    ))],
  });
}

function bootDoc() {
  const declaration = declareDoc();
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Doc (id TEXT, title TEXT, owner TEXT, secret TEXT)');
  db.prepare('INSERT INTO Doc VALUES (?, ?, ?, ?)').run('d1', 'Report', 'alice', 'top-secret-value');
  const app = workbench({ db, entities: [declaration] });
  return { db, app, Doc: app.entity(declaration) };
}

// ---- Read projection: omit unreadable fields, exactly the readable subset ----

test('projectRowForRecipient omits unreadable fields and keeps the readable subset', async () => {
  const { Doc } = bootDoc();
  const row = Doc.deserializeRow({ id: 'd1', title: 'Report', owner: 'alice', secret: 'top-secret-value' });

  const forAlice = await projectRowForRecipient(Doc, row, alice);
  assert.deepEqual(Object.keys(forAlice).sort(), ['id', 'owner', 'secret', 'title']);
  assert.equal(forAlice.secret, 'top-secret-value');

  // Bob can read the row (member) but not the owner-only `secret` field.
  const forBob = await projectRowForRecipient(Doc, row, bob);
  assert.deepEqual(Object.keys(forBob).sort(), ['id', 'owner', 'title']);
  assert.equal('secret' in forBob, false, 'unreadable field is omitted');
  // No field content can leak through an excerpt/sort/filter/count surface over
  // the projected row.
  assert.equal(JSON.stringify(forBob).includes('top-secret-value'), false);
});

test('readableFieldNames returns exactly the readable field subset', async () => {
  const { Doc } = bootDoc();
  const row = Doc.deserializeRow({ id: 'd1', title: 'Report', owner: 'alice', secret: 'top-secret-value' });

  const aliceReadable = await readableFieldNames(Doc, row, alice);
  assert.equal(aliceReadable.has('secret'), true);
  const bobReadable = await readableFieldNames(Doc, row, bob);
  assert.equal(bobReadable.has('secret'), false);
  assert.equal(bobReadable.has('title'), true);
  assert.equal(bobReadable.has('owner'), true);
});

test('readableFieldNames evaluates the row read grant once across fields without explicit .can', async () => {
  let grantCalls = 0;
  const Multi = entity('Multi', {
    a: text(),
    b: text(),
    c: text(),
    d: text(),
    grant: () => [scope(() => everyone()).can(() => {
      grantCalls += 1;
      return grant(read);
    })],
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [Multi] });
  const compiled = app.entity(Multi);
  const row = compiled.deserializeRow({ id: 'm1', a: '1', b: '2', c: '3', d: '4' });

  const readable = await readableFieldNames(compiled, row, bob);
  assert.deepEqual([...readable].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(grantCalls, 1, 'row read grant should be evaluated once per readableFieldNames call');
  db.close();
});

test('mayReadField denies the unreadable field without any field-name echo', async () => {
  const { Doc } = bootDoc();
  const row = Doc.deserializeRow({ id: 'd1', title: 'Report', owner: 'alice', secret: 'top-secret-value' });

  assert.equal(await mayReadField(Doc, 'secret', row, bob), false);
  assert.equal(await mayReadField(Doc, 'title', row, bob), true);
  assert.equal(await mayReadField(Doc, 'secret', row, alice), true);
});

// ---- Read projection: annotated-text redaction to the explicit placeholder ----

function declareTranscript() {
  return entity('Transcript', {
    title: text(),
    owner: ref('User', { role: 'owner' }),
    project: ref('Project'),
    body: annotatedText({ project: 'project', owner: 'owner' }).can(async ({ is }) => (
      await is.owner() ? grant(read, write) : grant()
    )),
    grant: () => [scope(() => everyone()).can(() => grant(read, write))],
  });
}

test('projectRowForRecipient redacts an unreadable annotated-text field to the explicit placeholder', async () => {
  const declaration = declareTranscript();
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [declaration] });
  const Transcript = app.entity(declaration);
  const row = Transcript.deserializeRow({ id: 't1', title: 'T', owner: 'alice', project: 'p1' });

  // Owner reads the body field (not a stored column, so absent from the row).
  const forAlice = await projectRowForRecipient(Transcript, row, alice);
  assert.equal('body' in forAlice, false);

  // Bob cannot read the body field: it redacts to the explicit restricted
  // recipient placeholder — the same wire shape the existing recipient
  // projection emits for a fully-restricted document, with no canonical facts.
  const forBob = await projectRowForRecipient(Transcript, row, bob);
  assert.equal(forBob.body.kind, 'workbench.annotatedText.recipient');
  assert.equal(forBob.body.version, 1);
  assert.equal(forBob.body.restricted, true);
  assert.equal(forBob.body.text, '');
  assert.deepEqual(forBob.body.annotations, []);
  assert.deepEqual(forBob.body.measurements, []);
  db.close();
});

test('annotatedTextDeniedPlaceholder is a frozen explicit restricted recipient shape', () => {
  const placeholder = annotatedTextDeniedPlaceholder();
  assert.equal(placeholder.kind, 'workbench.annotatedText.recipient');
  assert.equal(placeholder.restricted, true);
  assert.equal(placeholder.text, '');
  assert.ok(Object.isFrozen(placeholder));
});

// ---- Write rejection: 403, generic reason code, no field-name echo ----

test('authorizeFieldOp rejects a write to a protected field with a generic 403 (no field name)', async () => {
  const { Doc } = bootDoc();
  const row = Doc.deserializeRow({ id: 'd1', title: 'Report', owner: 'alice', secret: 'top-secret-value' });

  // Bob cannot write the owner-only `secret` field.
  let thrown = null;
  try {
    await authorizeFieldOp(Doc, 'secret', write, row, bob);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'protected field write must throw');
  assert.equal(thrown.status, 403);
  assert.equal(thrown.message, 'forbidden');
  assert.equal(thrown.reasonCode, 'no-field-access');
  // The failure never echoes the field name or its value.
  assert.equal(thrown.message.includes('secret'), false);
  assert.equal(JSON.stringify(thrown.failure).includes('secret'), false);

  // The owner is admitted — no throw.
  await authorizeFieldOp(Doc, 'secret', write, row, alice);
});

// ---- Inference prevention: errors never distinguish existing vs missing fields ----

test('live subscribe interest error never reveals the requested field name', async () => {
  const { db, app } = bootDoc();
  const conn = { id: 'c1', closed: false, principal: bob, send() {} };
  const fanout = { subscriptionCount: () => 0, collectionSubscriptionCount: () => 0, hasSubscription: () => false };
  const deps = {
    resolveEntity: (name) => app.entities.get(name),
    mayVerb: async () => true,
    db,
    fanout,
  };

  // An unknown field is rejected with a message that carries no field name.
  const unknown = await authorizeSubscription({ entity: 'Doc', id: 'd1', fields: { bogus: true } }, conn, deps);
  assert.equal(unknown.admitted, false);
  assert.equal(unknown.failure.category, 'invalid-input');
  assert.match(unknown.failure.message, /unknown field/i);
  assert.equal(unknown.failure.message.includes('bogus'), false);

  // An existing-but-unreadable field is indistinguishable from a readable one:
  // subscription succeeds (projection omits the field at delivery).
  const existing = await authorizeSubscription({ entity: 'Doc', id: 'd1', fields: { secret: true } }, conn, deps);
  assert.equal(existing.admitted, true);
});

// ---- Proposed-transition mutation admission ----

test('admitRowTransition rejects an update that moves the row out of the principal write scope', async () => {
  const { Doc } = bootDoc();
  const before = { id: 'd1', title: 'Report', owner: 'alice', secret: 'top-secret-value' };
  const afterOutOfScope = { ...before, owner: 'bob' };
  const afterInScope = { ...before, title: 'Updated' };

  // Current row in scope, proposed after-row out of scope -> rejected.
  assert.equal(
    await admitRowTransition({ entity: Doc, verb: 'update', before, after: afterOutOfScope, principal: alice }),
    false,
    'transition out of the write scope must be rejected',
  );
  // Current row in scope and proposed after-row still in scope -> admitted.
  assert.equal(
    await admitRowTransition({ entity: Doc, verb: 'update', before, after: afterInScope, principal: alice }),
    true,
  );
  // A principal already out of scope on the current row stays denied.
  assert.equal(
    await admitRowTransition({ entity: Doc, verb: 'update', before, after: afterInScope, principal: bob }),
    false,
  );
});

test('admitRowTransition evaluates field access against both the current and proposed row', async () => {
  const { Doc } = bootDoc();
  const before = { id: 'd1', title: 'Report', owner: 'alice', secret: 'top-secret-value' };
  const afterOutOfScope = { ...before, owner: 'bob' };

  // Alice writes `secret` on the current row, but the transition re-owns the
  // row so the after-row field access denies -> rejected.
  assert.equal(
    await admitRowTransition({
      entity: Doc, verb: 'update', fieldName: 'secret', capability: write,
      before, after: afterOutOfScope, principal: alice,
    }),
    false,
  );
  // Field access on an in-scope transition is admitted.
  assert.equal(
    await admitRowTransition({
      entity: Doc, verb: 'update', fieldName: 'secret', capability: write,
      before, after: { ...before, title: 'Updated' }, principal: alice,
    }),
    true,
  );
});

test('admitRowTransition delete/revoke evaluates the stable before anchor when no after-row exists', async () => {
  const { Doc } = bootDoc();
  const before = { id: 'd1', title: 'Report', owner: 'alice', secret: 'top-secret-value' };

  // Owner remove: admitted against the current anchor.
  assert.equal(await admitRowTransition({ entity: Doc, verb: 'remove', before, principal: alice }), true);
  // Non-owner remove: denied (no write capability).
  assert.equal(await admitRowTransition({ entity: Doc, verb: 'remove', before, principal: bob }), false);
  // Absent current row fails closed.
  assert.equal(await admitRowTransition({ entity: Doc, verb: 'remove', before: null, principal: alice }), false);
});

// ---- Proposed-transition admission WIRED into the update mutation (end-to-end) ----

function bootStartedDoc(t) {
  const declaration = declareDoc();
  const db = new DatabaseSync(':memory:');
  for (const sql of generateDDL(declaration)) db.exec(sql);
  db.prepare("INSERT INTO Doc (id, title, owner, secret) VALUES (?, ?, ?, ?)").run('d1', 'Report', 'alice', 'top-secret-value');
  const app = workbench({ db, entities: [declaration] });
  app.listen(0);
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  return { app, db };
}

test('end-to-end: an update that moves the row out of the write scope is denied through the mutation pipeline; an in-scope update admits', async (t) => {
  const { app, db } = bootStartedDoc(t);
  await app.ready;

  // Alice owns d1. Re-assigning ownership to bob transitions the row out of her
  // write scope: the update must be rejected even though the CURRENT row is in
  // scope (the acceptance criterion for proposed-transition admission).
  const outOfScope = await app.dispatch({
    actionId: 'reassign-owner', type: 'Doc.update',
    payload: { id: 'd1', owner: 'bob' }, principal: alice,
  });
  assert.equal(outOfScope.ok, false, 'out-of-scope transition is denied');
  assert.equal(outOfScope.failure.category, 'denied');
  assert.equal(outOfScope.failure.message, 'forbidden');
  const stored = db.prepare('SELECT owner FROM Doc WHERE id = ?').get('d1');
  assert.equal(stored.owner, 'alice', 'the denied update leaves the row unchanged');

  // An in-scope transition (title change, ownership unchanged) admits.
  const inScope = await app.dispatch({
    actionId: 'rename', type: 'Doc.update',
    payload: { id: 'd1', title: 'Updated' }, principal: alice,
  });
  assert.equal(inScope.ok, true, 'in-scope transition admits');
  assert.equal(inScope.events[0].data.title, 'Updated');
});

test('end-to-end: an update by a principal out of scope on the current row stays denied', async (t) => {
  const { app } = bootStartedDoc(t);
  await app.ready;

  // Bob has no write capability on d1 even before any transition — the row
  // admission denies at the current row.
  const denied = await app.dispatch({
    actionId: 'bob-edit', type: 'Doc.update',
    payload: { id: 'd1', title: 'Hijacked' }, principal: bob,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.failure.category, 'denied');
});

// ---- HTTP: CRDT checkpoints and catch-up lifecycle data respect field-read admission ----

// A Doc whose `body` (CRDT text) and `secret` (plain text) fields are readable/
// writable by the owner only; non-owners see the row (everyone scope) with read
// capability but not the protected fields.
function declareProtectedDoc() {
  return entity('Doc', {
    title: text(),
    owner: text(),
    body: text.crdt().can(async ({ is }) => (await is.owner() ? grant(read, write) : grant())),
    secret: text().can(async ({ is }) => (await is.owner() ? grant(read, write) : grant())),
    checks: { owner: ({ entity: row, principal }) => row.owner === principal.id },
    grant: () => [scope(() => everyone()).can(async ({ is }) => (
      await is.owner() ? grant(read, write, subscribe) : grant(read, subscribe)
    ))],
  });
}

function bootProtectedHttpApp(t, principalOf, { seed = true } = {}) {
  const declaration = declareProtectedDoc();
  const db = new DatabaseSync(':memory:');
  for (const sql of generateDDL(declaration)) db.exec(sql);
  const checkpoint = JSON.stringify(textCheckpoint(createTextState()));
  if (seed) {
    db.prepare("INSERT INTO Doc (id, title, owner, body, secret) VALUES (?, ?, ?, ?, ?)").run('d1', 'Report', 'alice', checkpoint, 'top-secret-value');
  }
  const app = workbench({ db }).mount('/docs', declaration);
  app.listen(0, { principalOf });
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  return { app, db, checkpoint };
}

test('HTTP snapshot carries no CRDT reducer checkpoint for an unreadable text field (and none leaks to the recipient)', async (t) => {
  const { app } = bootProtectedHttpApp(t, () => bob);
  await app.ready;
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const res = await fetch(`${origin}/snapshot/Doc/d1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  // The snapshot omits the unreadable CRDT field entirely…
  assert.equal('body' in body.snapshot, false, 'unreadable CRDT field is omitted from the snapshot');
  assert.equal('secret' in body.snapshot, false, 'unreadable plain field is omitted from the snapshot');
  // …and the canonical CRDT checkpoint never rides the snapshot's reducers.
  const reducerFields = (body.reducers ?? []).map((seed) => seed.field);
  assert.equal(reducerFields.includes('body'), false, 'unreadable CRDT field carries no checkpoint');
  assert.equal(JSON.stringify(body).includes('elements'), false, 'no canonical document facts leak');
});

test('HTTP snapshot keeps the CRDT reducer checkpoint for a readable field (owner control)', async (t) => {
  const { app } = bootProtectedHttpApp(t, () => alice);
  await app.ready;
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const res = await fetch(`${origin}/snapshot/Doc/d1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const reducerFields = (body.reducers ?? []).map((seed) => seed.field);
  assert.equal(reducerFields.includes('body'), true, 'the owner receives the readable CRDT checkpoint');
  const bodyReducer = (body.reducers ?? []).find((seed) => seed.field === 'body');
  assert.equal(typeof bodyReducer.checkpoint, 'object');
  assert.equal(bodyReducer.checkpoint.version, 1);
  assert.equal('frontier' in bodyReducer.checkpoint, true, 'the checkpoint is the canonical document');
});

test('HTTP events-since catch-up lifecycle data omits an unreadable field', async (t) => {
  const { app } = bootProtectedHttpApp(t, () => bob, { seed: false });
  await app.ready;
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  // The owner creates the row (server-side); the reader then catches up.
  await app.dispatch({
    actionId: 'create-d1', type: 'Doc.create',
    payload: { id: 'd1', title: 'Report', owner: 'alice', secret: 'top-secret-value' },
    principal: alice,
  });

  const res = await fetch(`${origin}/events-since?scope=Doc:d1&cursor=0`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.events.length >= 1, 'catch-up events present');
  const lifecycle = body.events.find((event) => event.data?.id === 'd1');
  assert.ok(lifecycle, 'created lifecycle event present');
  assert.equal('secret' in lifecycle.data, false, 'unreadable field absent from catch-up lifecycle data');
  assert.equal('body' in lifecycle.data, false, 'unreadable CRDT field absent from catch-up lifecycle data');
  assert.equal(JSON.stringify(body).includes('top-secret-value'), false, 'no unreadable field content in the catch-up payload');
});

// ---- Inference prevention: the sort/filter/count gate (spec 3a) ----

test('admitInferenceFields rejects a sort/filter/count on an unreadable field without revealing the field name', async () => {
  const { Doc } = bootDoc();
  const row = Doc.deserializeRow({ id: 'd1', title: 'Report', owner: 'alice', secret: 'top-secret-value' });

  assert.deepEqual(await admitInferenceFields(Doc, row, bob, { sort: ['title'] }), { admitted: true });
  assert.deepEqual(await admitInferenceFields(Doc, row, bob, { sort: ['secret'] }), { admitted: false }, 'sort on an unreadable field is rejected');
  assert.deepEqual(await admitInferenceFields(Doc, row, bob, { filter: ['secret'] }), { admitted: false }, 'filter on an unreadable field is rejected');
  assert.deepEqual(await admitInferenceFields(Doc, row, bob, { count: ['secret'] }), { admitted: false }, 'count on an unreadable field is rejected');
  // An unreadable field is indistinguishable from a nonexistent one (no probe surface).
  assert.deepEqual(await admitInferenceFields(Doc, row, bob, { sort: ['bogus'] }), { admitted: false });
  // A principal that can read the field admits.
  assert.deepEqual(await admitInferenceFields(Doc, row, alice, { sort: ['secret'] }), { admitted: true });
  // The two-valued decision never echoes a field name.
  assert.equal(JSON.stringify(await admitInferenceFields(Doc, row, bob, { sort: ['secret'] })).includes('secret'), false);
});

// ---- History moves (undo/redo) run the proposed-transition update admission ----

// A Doc with conditional update history and an owner-scoped write grant, so a
// history move can be driven end-to-end through the durable undo/redo path.
function declareScopedHistoryDoc() {
  return entity('ScopedDoc', {
    title: text(),
    owner: text(),
    checks: { owner: ({ entity: row, principal }) => row.owner === principal.id },
    grant: () => [scope(() => everyone()).can(async ({ is }) => (
      await is.owner() ? grant(read, write, subscribe) : grant(read, subscribe)
    ))],
    history: { update: 'conditional' },
  });
}

test('end-to-end: an undo that would move the row out of the write scope is denied through the history update path', async (t) => {
  const declaration = declareScopedHistoryDoc();
  const db = new DatabaseSync(':memory:');
  for (const sql of generateDDL(declaration)) db.exec(sql);
  const app = workbench({ db, entities: [declaration], history: durableHistory({ authorize: () => true }) });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();
  const session = 'history-tab';
  const rowScope = 'ScopedDoc:d1';

  const created = await app.dispatch({
    actionId: 'history-create', type: 'ScopedDoc.create',
    payload: { id: 'd1', title: 'first', owner: 'alice' }, principal: alice,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const updated = await app.dispatch({
    actionId: 'history-edit', type: 'ScopedDoc.update',
    payload: { id: 'd1', title: 'second' }, principal: alice,
    scope: rowScope, history: { session },
  });
  assert.equal(updated.ok, true, JSON.stringify(updated));

  // The server narrows the write scope between the commit and the undo: a row
  // titled 'first' is no longer writable even by its owner. The CURRENT row
  // (title 'second') stays in scope — ordinary row admission still admits — but
  // the undo's target after-row (title 'first') lands out of scope.
  const ScopedDoc = app.entities.get('ScopedDoc');
  ScopedDoc.grant = () => [scope(() => everyone()).can(async ({ is, entity }) => {
    if (!(await is.owner())) return grant(read, subscribe);
    return entity?.title === 'first' ? grant(read, subscribe) : grant(read, write, subscribe);
  })];
  const cursor = await app.history.cursor({ scope: rowScope, principal: alice, session });
  const denied = await app.history.undo({ scope: rowScope, principal: alice, session, actionId: 'undo-out', revision: cursor.revision });
  assert.equal(denied.ok, false, JSON.stringify(denied));
  assert.equal(denied.failure.category, 'denied');
  assert.equal(denied.failure.message, 'forbidden');
  assert.deepEqual({ ...db.prepare('SELECT title, owner FROM ScopedDoc WHERE id = ?').get('d1') }, { title: 'second', owner: 'alice' });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE actionId = 'undo-out'").get().count, 0);
  assert.deepEqual(await app.history.cursor({ scope: rowScope, principal: alice, session }), cursor, 'a denied undo moves no history cursor');

  // Restore the original write scope: the same undo is now admitted.
  ScopedDoc.grant = () => [scope(() => everyone()).can(async ({ is }) => (
    await is.owner() ? grant(read, write, subscribe) : grant(read, subscribe)
  ))];
  const admitted = await app.history.undo({ scope: rowScope, principal: alice, session, actionId: 'undo-in', revision: cursor.revision });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  assert.deepEqual({ ...db.prepare('SELECT title, owner FROM ScopedDoc WHERE id = ?').get('d1') }, { title: 'first', owner: 'alice' });
});

// ---- The injected authorization adapter governs the update transition admission ----

test('an injected authorization adapter governs update transition admission (deny and admit cases)', async (t) => {
  const declaration = declareDoc();
  const db = new DatabaseSync(':memory:');
  for (const sql of generateDDL(declaration)) db.exec(sql);
  db.prepare("INSERT INTO Doc (id, title, owner, secret) VALUES (?, ?, ?, ?)").run('d1', 'Report', 'alice', 'top-secret-value');
  const defaultAdapter = createAuthorizationAdapter();
  const transitionCalls = [];
  let adapterDecision = null;
  const adapter = {
    admit: async (input) => {
      if (input.category === 'entity' && input.verb === 'update') {
        transitionCalls.push({ row: input.row, principal: input.principal?.id });
        return adapterDecision
          ? { admitted: true, reasonCode: null }
          : { admitted: false, reasonCode: 'no-capability' };
      }
      return defaultAdapter.admit(input);
    },
    registerResource: (input) => defaultAdapter.registerResource(input),
  };
  const app = workbench({ db, entities: [declaration] });
  app._authorization = adapter; // what serve.ts listen() stashes from { authorization }
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();

  // Deny case: the injected adapter denies a transition the framework grant
  // would admit (Alice renames her own row). The update is denied 403, the row
  // is unchanged, and the transition admission consulted the adapter.
  adapterDecision = false;
  const denied = await app.dispatch({
    actionId: 'adapter-deny', type: 'Doc.update',
    payload: { id: 'd1', title: 'Renamed' }, principal: alice,
  });
  assert.equal(denied.ok, false, JSON.stringify(denied));
  assert.equal(denied.failure.category, 'denied');
  assert.equal(denied.failure.message, 'forbidden');
  assert.ok(transitionCalls.some((c) => c.row?.id === 'd1'), 'the transition admission consulted the injected adapter');
  assert.equal(db.prepare('SELECT title FROM Doc WHERE id = ?').get('d1').title, 'Report', 'the denied update leaves the row unchanged');

  // Admit case: the injected adapter admits a transition the framework grant
  // would deny (Alice re-assigns ownership away — the framework row grant denies
  // write on the after-row). The adapter's decision governs: the update commits.
  transitionCalls.length = 0;
  adapterDecision = true;
  const admitted = await app.dispatch({
    actionId: 'adapter-admit', type: 'Doc.update',
    payload: { id: 'd1', owner: 'bob' }, principal: alice,
  });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  assert.equal(db.prepare('SELECT owner FROM Doc WHERE id = ?').get('d1').owner, 'bob');
  // Exactly-once: the generated handler consults the adapter for the current
  // row AND the proposed after-row — exactly two calls — and the durable
  // pipeline gate must not re-admit the current row through the adapter on top
  // of that (no third consultation that could contradict the handler's decision).
  assert.equal(transitionCalls.length, 2, 'the adapter is consulted exactly once per transition row, with no durable-gate duplicate');
  assert.ok(transitionCalls.every((c) => c.row?.id === 'd1'));
});

// A conditional-history entity runs the generated-history pre-gate (kernel.ts)
// on EVERY update of that type. That gate must not impose a framework-default
// current-row admission on top of the handler's adapter-governed transition
// admission: the injected adapter is THE gate, so an update the adapter admits
// on a row the framework grant would deny commits, and an adapter denial
// rejects — exactly like the non-conditional path above.
test('an injected adapter governs conditional-history update admission (admit and deny on an out-of-framework row)', async (t) => {
  const declaration = declareScopedHistoryDoc();
  const db = new DatabaseSync(':memory:');
  for (const sql of generateDDL(declaration)) db.exec(sql);
  // d1 is owned by bob: the framework row grant denies alice write on the
  // CURRENT row, so the generated-history pre-gate's default admitRow would
  // reject the whole update before the handler ever ran.
  db.prepare("INSERT INTO ScopedDoc (id, title, owner) VALUES (?, ?, ?)").run('d1', 'Report', 'bob');
  const defaultAdapter = createAuthorizationAdapter();
  const transitionCalls = [];
  let adapterDecision = null;
  const adapter = {
    admit: async (input) => {
      if (input.category === 'entity' && input.verb === 'update') {
        transitionCalls.push({ row: input.row, principal: input.principal?.id });
        return adapterDecision
          ? { admitted: true, reasonCode: null }
          : { admitted: false, reasonCode: 'no-capability' };
      }
      return defaultAdapter.admit(input);
    },
    registerResource: (input) => defaultAdapter.registerResource(input),
  };
  const app = workbench({ db, entities: [declaration] });
  app._authorization = adapter; // what serve.ts listen() stashes from { authorization }
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();

  // Admit case: the current row is out of the framework write scope, but the
  // adapter admits the transition. The update commits — no framework-default
  // rejection from the pre-gate or the durable gate.
  adapterDecision = true;
  const admitted = await app.dispatch({
    actionId: 'adapter-admit-scoped', type: 'ScopedDoc.update',
    payload: { id: 'd1', title: 'Renamed' }, principal: alice,
  });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  assert.equal(db.prepare('SELECT title FROM ScopedDoc WHERE id = ?').get('d1').title, 'Renamed');
  assert.ok(transitionCalls.some((c) => c.row?.id === 'd1' && c.principal === 'alice'), 'the transition admission consulted the injected adapter');
  assert.equal(transitionCalls.length, 2, 'the durable gate adds no duplicate adapter consultation on a conditional-history update');

  // Deny case: the injected adapter denies — 403 and the row is unchanged.
  transitionCalls.length = 0;
  adapterDecision = false;
  const denied = await app.dispatch({
    actionId: 'adapter-deny-scoped', type: 'ScopedDoc.update',
    payload: { id: 'd1', title: 'Renamed-again' }, principal: alice,
  });
  assert.equal(denied.ok, false, JSON.stringify(denied));
  assert.equal(denied.failure.category, 'denied');
  assert.equal(denied.failure.message, 'forbidden');
  assert.equal(db.prepare('SELECT title FROM ScopedDoc WHERE id = ?').get('d1').title, 'Renamed', 'the denied update leaves the row unchanged');
});

// The same adapter-governing rule holds on a history move: an undo that would
// land the row in a state the adapter admits commits even when the CURRENT row
// is out of the framework write scope (the generated-history pre-gate used to
// reject it with the framework default before the history handler ran).
test('an injected adapter governs a history undo whose current row is out of the framework write scope', async (t) => {
  const declaration = declareScopedHistoryDoc();
  const db = new DatabaseSync(':memory:');
  for (const sql of generateDDL(declaration)) db.exec(sql);
  const defaultAdapter = createAuthorizationAdapter();
  const transitionCalls = [];
  const adapter = {
    admit: async (input) => {
      if (input.category === 'entity' && input.verb === 'update') {
        transitionCalls.push({ row: input.row, principal: input.principal?.id });
        return { admitted: true, reasonCode: null };
      }
      return defaultAdapter.admit(input);
    },
    registerResource: (input) => defaultAdapter.registerResource(input),
  };
  const app = workbench({ db, entities: [declaration], history: durableHistory({ authorize: () => true }) });
  app._authorization = adapter;
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();
  const session = 'history-tab';
  const rowScope = 'ScopedDoc:d1';

  const created = await app.dispatch({
    actionId: 'history-create', type: 'ScopedDoc.create',
    payload: { id: 'd1', title: 'first', owner: 'alice' }, principal: alice,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const updated = await app.dispatch({
    actionId: 'history-edit', type: 'ScopedDoc.update',
    payload: { id: 'd1', title: 'second' }, principal: alice,
    scope: rowScope, history: { session },
  });
  assert.equal(updated.ok, true, JSON.stringify(updated));

  // Narrow the framework write scope so the CURRENT row (title 'second') is no
  // longer writable even by its owner. The adapter still admits the undo.
  const ScopedDoc = app.entities.get('ScopedDoc');
  ScopedDoc.grant = () => [scope(() => everyone()).can(async ({ is, entity }) => {
    if (!(await is.owner())) return grant(read, subscribe);
    return entity?.title === 'first' ? grant(read, subscribe) : grant(read, subscribe);
  })];
  const cursor = await app.history.cursor({ scope: rowScope, principal: alice, session });
  const undone = await app.history.undo({ scope: rowScope, principal: alice, session, actionId: 'undo-adapter', revision: cursor.revision });
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.deepEqual({ ...db.prepare('SELECT title, owner FROM ScopedDoc WHERE id = ?').get('d1') }, { title: 'first', owner: 'alice' });
  assert.ok(transitionCalls.some((c) => c.row?.id === 'd1' && c.principal === 'alice'), 'the history move consulted the injected adapter');
});
