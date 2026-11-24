// Phase 2, slice 2 — DB-backed CRUD dispatch over the real HTTP transport.
//
// Slice 1 opened a socket, matched a route, ran the route GATE, and returned a
// stub. This slice replaces the stub with real per-verb dispatch against a
// node:sqlite DatabaseSync handle the app owns (workbench({ db })). Both
// default-on auth layers now run end to end:
//   - the route GATE admits the request (slice 1);
//   - the row GRANT's SQL scope filters which rows are VISIBLE (list/read), and
//     its .can capability decides write/remove (the row-grant runtime, slice 2).
//
// The DB handle is an app-level resource read by the transport (DECISIONLOG: the
// SQLite handle is supplied at workbench({ db }), shared by every transport).

import { text, ref, scope, grant, deny, read, write, subscribe, everyone, inherit, principal } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity } from '../build/internal.mjs';

// An owner-scoped Note: only the owner may SEE a row (SQL scope is.owner()), and
// the owner may read+write+subscribe.
function ownedNote() {
  return entity('Note', {
        body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

function canonicalNote() {
  return entity('CanonicalNote', {
    body: text({ canonicalize: (value) => value.trim() }),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

// A public-read Post: everyone may SEE every row (SQL scope everyone()), but only
// the owner may write/remove (the .can capability axis, distinct from visibility).
function publicPost() {
  return entity('Post', {
        title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(() => everyone()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

// Seed a DB with the given CREATE + INSERTs and return the handle.
function seed(ddl, rows = []) {
  const db = new DatabaseSync(':memory:');
  db.exec(ddl);
  for (const { sql, params } of rows) db.prepare(sql).run(...params);
  return db;
}

// Mount an app over a DB, drive it with a fixed test principal (header-free —
// the principal is supplied directly until session hydration lands), open an
// ephemeral socket, and return { origin }. The socket + DB are torn down via the
// test's `after` hook so an assertion failure never leaks an open handle (which
// would hang node:test).
async function serve(t, db, Entity, base, who) {
  const app = workbench({ db });
  app.mount(base, Entity);
  app.listen(0, { principalOf: () => who });
  await app.ready;
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  const { port } = app.httpServer.address();
  return { origin: `http://127.0.0.1:${port}` };
}

const alice = principal({ type: 'user', id: 'alice' });
const bob = principal({ type: 'user', id: 'bob' });

test('list returns only the rows the principal may SEE (SQL scope)', async (t) => {
  const db = seed(
    'CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT, owner TEXT)',
    [
      { sql: 'INSERT INTO Note (id, body, owner) VALUES (?, ?, ?)', params: [1, 'a', 'alice'] },
      { sql: 'INSERT INTO Note (id, body, owner) VALUES (?, ?, ?)', params: [2, 'b', 'bob'] },
    ],
  );
  const a = await serve(t, db, ownedNote(), '/notes', alice);
  const res = await fetch(`${a.origin}/notes`);
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner, 'alice');
});

test('read of an unowned (invisible) row is 404 under owner scope', async (t) => {
  const db = seed(
    'CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT, owner TEXT)',
    [{ sql: 'INSERT INTO Note (id, body, owner) VALUES (?, ?, ?)', params: [1, 'a', 'alice'] }],
  );
  const b = await serve(t, db, ownedNote(), '/notes', bob);
  const res = await fetch(`${b.origin}/notes/1`);
  assert.equal(res.status, 404);
});

test('create inserts a row owned by the principal and 201s', async (t) => {
  const db = seed('CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT, owner TEXT)');
  const a = await serve(t, db, ownedNote(), '/notes', alice);
  const res = await fetch(`${a.origin}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'hello' }),
  });
  assert.equal(res.status, 201);
  assert.ok(Number(res.headers.get('x-workbench-seq')) >= 1);
  assert.ok(res.headers.get('x-workbench-action-id'));
  const created = await res.json();
  assert.equal(created.body, 'hello');
  assert.equal(created.owner, 'alice');
  const stored = db.prepare('SELECT owner FROM Note WHERE id = ?').get(created.id);
  assert.equal(stored.owner, 'alice');
});

test('generated CRUD stores canonicalized text on create and update', async (t) => {
  const db = seed('CREATE TABLE CanonicalNote (id TEXT PRIMARY KEY, body TEXT, owner TEXT)');
  const a = await serve(t, db, canonicalNote(), '/canonical-notes', alice);
  const created = await fetch(`${a.origin}/canonical-notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: '  created  ' }),
  });
  assert.equal(created.status, 201);
  const row = await created.json();
  assert.equal(row.body, 'created');
  assert.equal(db.prepare('SELECT body FROM CanonicalNote WHERE id = ?').get(row.id).body, 'created');

  const updated = await fetch(`${a.origin}/canonical-notes/${row.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: '  updated  ' }),
  });
  assert.equal(updated.status, 200);
  assert.equal(db.prepare('SELECT body FROM CanonicalNote WHERE id = ?').get(row.id).body, 'updated');
});

test('create rejects a readonly field set by the client (400)', async (t) => {
  const db = seed('CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT, owner TEXT)');
  const a = await serve(t, db, ownedNote(), '/notes', alice);
  const res = await fetch(`${a.origin}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'x', owner: 'bob' }),
  });
  assert.equal(res.status, 400);
});

test('entity CRUD rejects urlencoded form bodies instead of storing them', async (t) => {
  const db = seed('CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT, owner TEXT)');
  const a = await serve(t, db, ownedNote(), '/notes', alice);
  const res = await fetch(`${a.origin}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'body=hello',
  });
  assert.equal(res.status, 415);
  const rows = db.prepare('SELECT * FROM Note').all();
  assert.deepEqual(rows, []);
});

test('public-read row is VISIBLE to a non-owner but not WRITABLE (capability axis)', async (t) => {
  const db = seed(
    'CREATE TABLE Post (id TEXT PRIMARY KEY, title TEXT, owner TEXT)',
    [{ sql: 'INSERT INTO Post (id, title, owner) VALUES (?, ?, ?)', params: ['1', 't', 'alice'] }],
  );
  const b = await serve(t, db, publicPost(), '/posts', bob);

  // bob SEES the public row (read scope = everyone)
  const read1 = await fetch(`${b.origin}/posts/1`);
  assert.equal(read1.status, 200);

  // but bob may NOT update it (the .can capability denies write to non-owner)
  const upd = await fetch(`${b.origin}/posts/1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'hijack' }),
  });
  assert.equal(upd.status, 403);

  // and may not remove it
  const del = await fetch(`${b.origin}/posts/1`, { method: 'DELETE' });
  assert.equal(del.status, 403);
});

test('owner may update and remove a public-read row', async (t) => {
  const db = seed(
    'CREATE TABLE Post (id TEXT PRIMARY KEY, title TEXT, owner TEXT)',
    [{ sql: 'INSERT INTO Post (id, title, owner) VALUES (?, ?, ?)', params: ['1', 't', 'alice'] }],
  );
  const a = await serve(t, db, publicPost(), '/posts', alice);
  const upd = await fetch(`${a.origin}/posts/1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'edited' }),
  });
  assert.equal(upd.status, 200);
  assert.ok(Number(upd.headers.get('x-workbench-seq')) >= 1);
  assert.ok(upd.headers.get('x-workbench-action-id'));
  const after = db.prepare('SELECT title FROM Post WHERE id = ?').get('1');
  assert.equal(after.title, 'edited');

  const del = await fetch(`${a.origin}/posts/1`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  assert.ok(Number(del.headers.get('x-workbench-seq')) >= 1);
  assert.ok(del.headers.get('x-workbench-action-id'));
  const gone = db.prepare('SELECT * FROM Post WHERE id = ?').get('1');
  assert.equal(gone, undefined);
});

// Inherit-child entity for testing update/remove through the parent grant.
// The child inherits the parent's scope and capabilities through the declared FK.
function makeDoc() {
  return entity('Doc', {
        title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : deny('not owner'),
      ),
    ],
  });
}

function makeDocComment(doc) {
  return entity('DocComment', {
        doc: ref('Doc', { required: true }),
    body: text(),

    grant: inherit(doc, { via: 'doc' }),
  });
}

test('inherit-child is updateable and removable by the parent owner via HTTP', async (t) => {
  const db = new DatabaseSync(':memory:');
  const Doc = makeDoc();
  const Comment = makeDocComment(Doc);
  const app = workbench({ db });
  app.mount('/docs', Doc);
  app.mount('/comments', Comment);
  await app.ddl();
  app.listen(0, { principalOf: () => alice });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  // Create a doc
  const cr = await fetch(`${origin}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'draft' }),
  });
  assert.equal(cr.status, 201);
  const { id: docId } = await cr.json();

  // Create a comment on that doc
  const comment = await fetch(`${origin}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc: docId, body: 'hello' }),
  });
  assert.equal(comment.status, 201);
  const { id: commentId } = await comment.json();

  // Alice (the doc owner) should be able to update the comment
  const upd = await fetch(`${origin}/comments/${commentId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'edited' }),
  });
  assert.equal(upd.status, 200, 'inherit-child update admitted');
  assert.ok(Number(upd.headers.get('x-workbench-seq')) >= 1);

  // And remove it
  const del = await fetch(`${origin}/comments/${commentId}`, { method: 'DELETE' });
  assert.equal(del.status, 204, 'inherit-child remove admitted');

  // Gone from DB
  const stored = db.prepare('SELECT * FROM DocComment WHERE id = ?').get(commentId);
  assert.equal(stored, undefined);
});

test('non-owner cannot see or mutate an inherit-child row (scope hides it)', async (t) => {
  const db = new DatabaseSync(':memory:');
  const Doc = makeDoc();
  const Comment = makeDocComment(Doc);

  // Alice creates the doc + comment (alice is the owner)
  const aApp = workbench({ db });
  aApp.mount('/docs', Doc);
  aApp.mount('/comments', Comment);
  await aApp.ddl();
  aApp.listen(0, { principalOf: () => alice });
  await aApp.ready;
  const aOrigin = `http://127.0.0.1:${aApp.httpServer.address().port}`;

  const cr = await fetch(`${aOrigin}/docs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'shared' }),
  });
  const { id: docId } = await cr.json();
  const cm = await fetch(`${aOrigin}/comments`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc: docId, body: 'note' }),
  });
  const { id: commentId } = await cm.json();
  // Shut the whole app down before booting another one on the same handle:
  // the handle's single write coordinator must be drained/closed first.
  await aApp.shutdown();

  // Bob (non-owner) tries to update/remove — should get 403
  const bApp = workbench({ db });
  bApp.mount('/docs', Doc);
  bApp.mount('/comments', Comment);
  bApp.listen(0, { principalOf: () => bob });
  await bApp.ready;
  t.after(async () => { await bApp.shutdown(); db.close(); });
  const bOrigin = `http://127.0.0.1:${bApp.httpServer.address().port}`;

  const upd = await fetch(`${bOrigin}/comments/${commentId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'hijack' }),
  });
  assert.equal(upd.status, 404, 'non-owner cannot see inherit-child row (scope hides it)');

  const del = await fetch(`${bOrigin}/comments/${commentId}`, { method: 'DELETE' });
  assert.equal(del.status, 404, 'non-owner cannot see inherit-child row');
});

test('mounting an entity CRUD route without a db succeeds, but data access fails loudly', () => {
  const app = workbench();
  const NoteDeclaration = ownedNote();
  app.mount('/notes', NoteDeclaration);
  const Note = app.entity(NoteDeclaration);

  assert.throws(
    () => Note.findAll(),
    /requires an application database/i,
  );
});
