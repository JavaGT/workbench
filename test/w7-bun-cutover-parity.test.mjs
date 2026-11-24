// w7-bun-cutover-parity.test.mjs — Wave 3 lane w7-wire-exports-bun-gate.
//
// The scope2 Bun cutover needs three things to be true of the SAME workbench
// build under both Node and Bun:
//   (a) a scope2-shaped schema is assembled entirely from `workbench/server`
//       (adoptExternalTables + defineSqliteSchema) and booted via
//       `workbench({ db, schema, entities })`;
//   (b) `createFetchHandler` serves the REST surface over Web Request/Response
//       with a custom Bearer `principalOf`;
//   (c) an opaque-snapshot control reason comes from a FieldKindContribution,
//       not from a kind-specific string hardcoded in live fan-out.
//
// Everything here uses `node:test` + `openSqliteDatabase` so the file runs
// unchanged under `node --test` and `bun test` (v1.4.5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import workbench, {
  entity,
  everyone,
  grant,
  map,
  membership,
  principal,
  read,
  ref,
  scope,
  subscribe,
  text,
  write,
} from '../build/index.mjs';
import {
  adoptExternalTables,
  createFetchHandler,
  defineSqliteSchema,
} from '../build/server.mjs';
import { openSqliteDatabase } from '../build/sqlite-driver.mjs';
import { createLiveFanout } from '../build/live-fanout.mjs';
import { EventKind } from '../build/event-handle.mjs';
import { fieldKindContribution, registerFieldKindContribution } from '../build/strategy/index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceOf = (relativePath) => readFileSync(join(root, relativePath), 'utf8');

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// (a) + (b): one scope2-shaped app, booted with an adopted schema, driven over
// the Web Fetch adapter with a Bearer principal.
// ---------------------------------------------------------------------------

function scope2Database() {
  const db = openSqliteDatabase(':memory:');
  db.exec('CREATE TABLE code_application (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT);');
  db.exec('CREATE INDEX idx_code_application_owner ON code_application(owner);');
  return db;
}

function postEntity() {
  return entity('Post', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [scope(() => everyone()).can(async ({ is }) =>
      (await is.owner()) ? grant(read, write, subscribe) : grant(read),
    )],
  });
}

function bearerRequest(path, { method = 'GET', token, body } = {}) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function parseJson(res) {
  const raw = await res.text();
  return raw === '' ? null : JSON.parse(raw);
}

test('server entrypoint exposes the scope2 cutover surface on every runtime', () => {
  // These are the three names scope2 imports from `workbench/server`.
  assert.equal(typeof defineSqliteSchema, 'function');
  assert.equal(typeof adoptExternalTables, 'function');
  assert.equal(typeof createFetchHandler, 'function');
});

test('scope2 cutover parity: adopted schema + workbench + Bearer fetch CRUD', async () => {
  const db = scope2Database();
  // The adopted table is app-owned; the Post table is Workbench-owned through
  // the entity declaration. Both must be attributed before boot can succeed.
  const adopted = adoptExternalTables(db, ['code_application']);
  const schema = defineSqliteSchema({
    name: 'scope2-w7',
    tables: [],
    externalTables: adopted.externalTables,
    externalIndexes: adopted.externalIndexes,
  });
  const post = postEntity();
  const app = workbench({
    db,
    schema,
    entities: [post],
  });
  app.mount('/posts', post);

  let handler;
  try {
    app.start();
    await app.ready;
    handler = createFetchHandler(app, {
      db,
      principalOf: (req) => {
        const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
        if (bearer.startsWith('alice')) return principal({ type: 'user', id: 'alice' });
        if (bearer.startsWith('bob')) return principal({ type: 'user', id: 'bob' });
        return principal({ type: 'anonymous' });
      },
    });

    // (a) the adopted schema is the one that booted, and the census knows the
    // app-owned table + index without Workbench creating or altering them.
    const report = app.schemaReport();
    assert.ok(report, 'the exact-schema census report is published on boot');
    for (const name of ['code_application', 'idx_code_application_owner']) {
      assert.ok(
        report.objects.some((object) => object.name === name),
        `${name} is attributed by the settled census`,
      );
    }
    db.prepare('INSERT INTO code_application (id, title) VALUES (?, ?)').run('app-1', 'untouched');

    // (b) GET / POST / PATCH / DELETE over Web Request/Response, all with a
    // Bearer principal resolved by the custom principalOf above.
    const empty = await handler(bearerRequest('/posts', { token: 'alice' }));
    assert.equal(empty.status, 200);
    assert.deepEqual(await parseJson(empty), []);

    const created = await handler(bearerRequest('/posts', {
      method: 'POST', token: 'alice', body: { title: 'first' },
    }));
    assert.equal(created.status, 201);
    const row = await parseJson(created);
    assert.equal(row.title, 'first');
    assert.equal(row.owner, 'alice');
    assert.ok(Number(created.headers.get('x-workbench-seq')) >= 1);

    const readBack = await handler(bearerRequest(`/posts/${row.id}`, { token: 'alice' }));
    assert.equal(readBack.status, 200);
    assert.equal((await parseJson(readBack)).title, 'first');

    const patched = await handler(bearerRequest(`/posts/${row.id}`, {
      method: 'PATCH', token: 'alice', body: { title: 'second' },
    }));
    assert.equal(patched.status, 200);
    assert.equal(db.prepare('SELECT title FROM Post WHERE id = ?').get(row.id).title, 'second');

    const removed = await handler(bearerRequest(`/posts/${row.id}`, {
      method: 'DELETE', token: 'alice',
    }));
    assert.equal(removed.status, 204);
    assert.equal(db.prepare('SELECT * FROM Post WHERE id = ?').get(row.id), undefined);

    // Bearer principalOf fails closed for an anonymous caller and for a
    // foreign principal attempting a write.
    const anonymous = await handler(bearerRequest('/posts'));
    assert.equal(anonymous.status, 401);
    db.prepare('INSERT INTO Post (id, title, owner) VALUES (?, ?, ?)').run('p1', 'bob post', 'bob');
    const foreignWrite = await handler(bearerRequest('/posts/p1', {
      method: 'PATCH', token: 'alice', body: { title: 'hijack' },
    }));
    assert.equal(foreignWrite.status, 403);

    // Adoption stayed declaration-only throughout the CRUD cycle.
    assert.equal(
      db.prepare('SELECT title FROM code_application WHERE id = ?').get('app-1').title,
      'untouched',
    );
  } finally {
    if (app) await app.shutdown();
    db.close();
  }
});

// ---------------------------------------------------------------------------
// (c): the snapshot control reason is a contribution, not a hardcoded string.
// ---------------------------------------------------------------------------

const W7_KIND = 'w7BunCutoverSnapshotKind';
const W7_REASON = 'w7-bun-cutover-snapshot-required';
const W7_PLAIN_KIND = 'w7BunCutoverPlainKind';

// A kind that owns a native `operated` event and declares its own opaque
// recovery reason. Live fan-out must surface exactly this string.
const w7Contribution = Object.freeze({
  kind: W7_KIND,
  snapshotControlReason: W7_REASON,
  isOperationEvent(context) {
    return context.eventScope === context.directScope
      && context.handle.kind === EventKind.native
      && context.handle.nativeName === 'operated';
  },
  suppressesDelta(context) {
    return !context.scopeAnchored
      && (context.isOperationEvent || (context.ephemeralField !== null && context.entityHasContributedKind));
  },
});

// A second contributed kind with the same delivery behavior but NO declared
// reason: it must fall back to the generic recipient requirement.
const w7PlainContribution = Object.freeze({
  kind: W7_PLAIN_KIND,
  isOperationEvent: w7Contribution.isOperationEvent,
  suppressesDelta: w7Contribution.suppressesDelta,
});

function registerOnce(contribution) {
  if (!fieldKindContribution(contribution.kind)) registerFieldKindContribution(contribution);
}

function fanoutEntity(kind) {
  return {
    name: 'Doc',
    fields: { body: { kind } },
    grant: () => [scope().can(() => true)],
    findById() { return { id: 'd1' }; },
  };
}

async function emitOperated(kind) {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const messages = [];
  const conn = {
    id: 'c1',
    closed: false,
    principal: { type: 'user', id: 'alice' },
    send(message) { messages.push(message); },
  };
  fanout.addSubscription('Doc', 'd1', conn);
  try {
    await fanout.emit(fanoutEntity(kind), 'd1', { id: 'd1' }, {
      type: 'Doc.body.operated',
      seq: 7,
      data: { operation: ['secret'], family: { text: 'secret body' } },
    });
    await nextTurn();
    return messages;
  } finally {
    fanout.close();
  }
}

test('a custom FieldKindContribution drives the live-fanout snapshot control reason', async () => {
  registerOnce(w7Contribution);
  assert.equal(fieldKindContribution(W7_KIND), w7Contribution);

  const messages = await emitOperated(W7_KIND);
  assert.deepEqual(messages, [{
    type: 'resync', entity: 'Doc', id: 'd1', seq: 7,
    reason: W7_REASON,
  }]);
  assert.equal(JSON.stringify(messages).includes('secret'), false, 'no canonical facts cross the wire');
});

test('a contributed kind without a declared reason falls back to the generic reason', async () => {
  registerOnce(w7PlainContribution);

  const messages = await emitOperated(W7_PLAIN_KIND);
  assert.deepEqual(messages, [{
    type: 'resync', entity: 'Doc', id: 'd1', seq: 7,
    reason: 'recipient-snapshot-required',
  }]);
});

test('the annotatedText kind still contributes its own reason (no regression)', async () => {
  const messages = await emitOperated('annotatedText');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].reason, 'annotated-text-snapshot-required');
});

test('live fan-out resolves the reason through the SPI, with no hardcoded kind string', () => {
  for (const path of ['src/live-fanout.ts', 'build/live-fanout.mjs']) {
    const source = sourceOf(path);
    assert.doesNotMatch(source, /['"]annotated-text-snapshot-required['"]/, path);
    assert.match(source, /\bfieldKindSnapshotControlReason\b/, `${path} never queries the SPI`);
    assert.match(source, /['"]recipient-snapshot-required['"]/, `${path} lost its generic fallback`);
  }
});

test('membership and map-role checks fail closed when Statement.get() returns null on miss (bun:sqlite)', async () => {
  const rawDb = openSqliteDatabase(':memory:');
  const db = new Proxy(rawDb, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql) => {
          const stmt = target.prepare(sql);
          return new Proxy(stmt, {
            get(st, sProp, sRecv) {
              if (sProp === 'get') {
                return (...args) => {
                  const res = st.get(...args);
                  return res === undefined ? null : res;
                };
              }
              const v = Reflect.get(st, sProp, sRecv);
              return typeof v === 'function' ? v.bind(st) : v;
            },
          });
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

  const Project = entity('MemberProject', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(text()),
    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read, write))],
  });
  membership(Project, {
    editor: { can: [read, write] },
    viewer: { can: [read] },
  });
  const app = workbench({ db, entities: [Project] });
  app.mount('/member-projects', Project);

  try {
    app.start();
    await app.ready;
    const handler = createFetchHandler(app, {
      db,
      principalOf: (req) => {
        const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
        if (bearer === 'alice') return principal({ type: 'user', id: 'alice' });
        if (bearer === 'bob') return principal({ type: 'user', id: 'bob' });
        return principal({ type: 'anonymous' });
      },
    });

    const created = await handler(bearerRequest('/member-projects', {
      method: 'POST', token: 'alice', body: { title: 'Private' },
    }));
    assert.equal(created.status, 201);
    const createdRow = await parseJson(created);

    const strangerPatch = await handler(bearerRequest(`/member-projects/${createdRow.id}`, {
      method: 'PATCH', token: 'bob', body: { title: 'Hijacked' },
    }));
    assert.ok(
      strangerPatch.status === 403 || strangerPatch.status === 404,
      `stranger must be denied PATCH even when Statement.get() returns null (got ${strangerPatch.status})`,
    );
    assert.equal(rawDb.prepare('SELECT title FROM MemberProject WHERE id = ?').get(createdRow.id).title, 'Private');

    const bound = app.entities.get('MemberProject');
    assert.equal(await bound.findByIdFor(createdRow.id, principal({ type: 'user', id: 'bob' })), null);
    assert.equal((await bound.findByIdFor(createdRow.id, principal({ type: 'user', id: 'alice' })))?.title, 'Private');
  } finally {
    await app.shutdown();
    rawDb.close();
  }
});
