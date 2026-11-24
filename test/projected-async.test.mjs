// projected.async — stored computed fields updated by post-commit projection
// (ADR #12, SPEC §5.3).

import { text, number, computed, projected, raster, polyline, ref, scope, grant, read, write, subscribe, never, everyone } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity, resolveStrategy, validateMutation, ValidationError, createProjectedAsyncConsumer, resolveProjectedAsyncTriggerTypes, reconcileProjectedRecovery } from '../build/internal.mjs';
import { readProjectedCursorFence } from '../build/projected-async.mjs';
import { principal } from '../build/principal.mjs';
import { defineSqliteSchema, frameworkTableNames } from '../build/server.mjs';

// Fixture tables the tests create out-of-band and the app's projections write;
// declared through the externalTables seam for the settled census.
// Boot validates the settled census against SQLite (fail closed). Each test
// creates only the out-of-band tables it needs, so declare exactly the objects
// present in its database: no missing census entry, no undeclared drift.
// Framework-owned names already have their own authority.
function fixtureSchema(db) {
  const reserved = new Set(frameworkTableNames.map((name) => String(name).toLowerCase()));
  const externalTables = [];
  const externalTriggers = [];
  const objects = db.prepare(
    "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'trigger') ORDER BY type, name",
  ).all();
  for (const object of objects) {
    const name = String(object.name);
    if (reserved.has(name.toLowerCase())) continue;
    if (object.type === 'trigger') {
      externalTriggers.push({ name });
      continue;
    }
    const columns = db.prepare(`PRAGMA table_xinfo("${name.replaceAll('"', '""')}")`).all()
      .filter((column) => Number(column.hidden) === 0)
      .map((column) => String(column.name));
    externalTables.push({ name, columns: columns.length > 0 ? columns : ['id'] });
  }
  return defineSqliteSchema({ name: 'projected-async-fixtures', tables: [], externalTables, externalTriggers });
}

test('projected cursor accessor returns undefined when the fence row is absent', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE _ProjectedCursor (entity TEXT NOT NULL, field TEXT NOT NULL, lastSeq INTEGER NOT NULL, PRIMARY KEY (entity, field))');
  assert.equal(readProjectedCursorFence(db, 'Transcript', 'annotatedText'), undefined);
  db.prepare('INSERT INTO _ProjectedCursor (entity, field, lastSeq) VALUES (?, ?, ?)').run('Transcript', 'annotatedText', 7);
  assert.equal(readProjectedCursorFence(db, 'Transcript', 'annotatedText'), 7);
});

// --- Slice 1: declaration + DDL ---

test('projected.async constructor validates compute is a function', () => {
  assert.throws(() => projected.async({}), /compute function/);
  assert.throws(() => projected.async({ compute: 'not a fn' }), /compute function/);
  const d = projected.async({ compute: async (row) => row.x });
  assert.equal(d.kind, 'projected');
  assert.equal(d.mode, 'async');
  assert.equal(d.readonly, true);
  assert.equal(typeof d.compute, 'function');
});

test('projected kind resolves to a strategy with validate, apply, diff, serialize, deserialize', () => {
  const s = resolveStrategy('projected');
  assert.equal(typeof s.validate, 'function');
  assert.equal(typeof s.apply, 'function');
  assert.equal(typeof s.diff, 'function');
  assert.equal(typeof s.serialize, 'function');
  assert.equal(typeof s.deserialize, 'function');
});

test('projected value serializes to JSON and back', () => {
  const s = resolveStrategy('projected');
  assert.equal(s.serialize(null), null);
  assert.equal(s.serialize(undefined), undefined);
  assert.equal(s.serialize(42), '42');
  assert.deepEqual(s.deserialize('42'), 42);
  assert.deepEqual(s.deserialize('[1,2]'), [1, 2]);
  assert.deepEqual(s.deserialize('{"a":1}'), { a: 1 });
  assert.equal(s.deserialize(null), null);
  assert.equal(s.deserialize(undefined), undefined);
});

test('an entity with a projected.async field compiles and generates DDL', () => {
  const Post = entity('Post', {
        title: text(),
    score: number(),
    hotRank: projected.async({ compute: async (row) => row?.score * 2 }),

    grant: () => [scope(() => everyone()).can(() => grant(read))],
  });
  assert.equal(Post.name, 'Post');
  assert.deepEqual(Object.keys(Post.fields).sort(), ['hotRank', 'score', 'title']);
  assert.equal(Post.fields.hotRank.readonly, true);
  assert.equal(Post.fields.hotRank.kind, 'projected');
  assert.equal(Post.projectedAsyncFields.length, 1);
});

test('a projected field is readonly — validateMutation rejects client writes', () => {
  assert.throws(
    () => validateMutation(
      { fields: { rank: projected.async({ compute: async (r) => r }) } },
      { rank: 42 },
    ),
    ValidationError,
    'readonly projected field rejected',
  );
});

// --- Slice 2: post-commit compute + write-back ---

test('projected.async consumer owns trigger selection, compute, write-back, and cursor advance', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE PostDirect (id TEXT, title TEXT, score REAL, hotRank TEXT)');
  db.exec("INSERT INTO PostDirect (id, title, score) VALUES ('p1', 'Direct', 7)");
  const PostDirect = entity('PostDirect', {
        title: text(),
    score: number(),
    hotRank: projected.async({
      from: 'updated',
      compute: async (row, { db: computeDb }) => {
        assert.equal(computeDb, db);
        return row.score * 4;
      },
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  const { executeFrameworkDDL } = await import('../build/ddl.mjs');
  executeFrameworkDDL(db);
  const consumer = createProjectedAsyncConsumer({ entities: new Map([[PostDirect.name, PostDirect]]) });

  await consumer([{ type: 'PostDirect.created', scope: 'PostDirect:p1', data: { id: 'p1' } }], { db });
  let row = db.prepare("SELECT hotRank FROM PostDirect WHERE id = 'p1'").get();
  assert.equal(row.hotRank, null);
  assert.deepEqual(resolveProjectedAsyncTriggerTypes(PostDirect.fields.hotRank, 'PostDirect'), ['PostDirect.updated']);

  await consumer([{ type: 'PostDirect.updated', scope: 'PostDirect:p1', data: { id: 'p1', score: 7 } }], { db });
  row = db.prepare("SELECT hotRank FROM PostDirect WHERE id = 'p1'").get();
  assert.equal(JSON.parse(row.hotRank), 28);
  const cursor = db.prepare(
    "SELECT lastSeq FROM _ProjectedCursor WHERE entity = 'PostDirect' AND field = 'hotRank'",
  ).get();
  assert.equal(cursor.lastSeq, 1);
  db.close();
});

test('projected.async value is computed and stored after create dispatch', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
        title: text(),
    score: number(),
    hotRank: projected.async({
      compute: async (row) => (row.score ?? 0) * 2,
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ schema: fixtureSchema(db), db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const res = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Test', score: 42 }),
  });
  assert.equal(res.status, 201);

  await new Promise((resolve) => setTimeout(resolve, 100));

  const row = db.prepare('SELECT hotRank FROM Post WHERE title = :t').get({ t: 'Test' });
  assert.ok(row, 'row exists');
  assert.equal(JSON.parse(row.hotRank), 84, `hotRank should be 84, got ${row.hotRank}`);
});

test('projected.async compute receives the committed db handle', async (t) => {
  const appDb = new DatabaseSync(':memory:');
  const ambientDb = new DatabaseSync(':memory:');
  appDb.exec('CREATE TABLE PostCtx (id TEXT, title TEXT, score REAL, hotRank TEXT)');
  ambientDb.exec('CREATE TABLE PostCtx (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const PostCtx = entity('PostCtx', {
        title: text(),
    score: number(),
    hotRank: projected.async({
      compute: async (row, { db }) => {
        assert.equal(db, appDb);
        assert.notEqual(db, ambientDb);
        const stored = db.prepare('SELECT score FROM PostCtx WHERE id = :id').get({ id: row.id });
        return stored.score * 2;
      },
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ schema: fixtureSchema(appDb), db: appDb });
  app.mount('/postctx', PostCtx);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); appDb.close(); ambientDb.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const res = await fetch(`${origin}/postctx`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Test', score: 21 }),
  });
  assert.equal(res.status, 201);

  await new Promise((resolve) => setTimeout(resolve, 100));

  const row = appDb.prepare('SELECT hotRank FROM PostCtx WHERE title = :t').get({ t: 'Test' });
  assert.ok(row, 'row exists');
  assert.equal(JSON.parse(row.hotRank), 42);
});

test('projected.async value is recomputed after update', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
        title: text(),
    score: number(),
    hotRank: projected.async({
      compute: async (row) => (row.score ?? 0) * 3,
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ schema: fixtureSchema(db), db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const r1 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Post', score: 10 }),
  });
  const created = await r1.json();
  // Wait for post-commit projection to finish and verify initial value
  let row;
  for (let i = 0; i < 20; i++) {
    row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
    if (row?.hotRank != null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(JSON.parse(row.hotRank), 30, `initial: should be 30, got ${row.hotRank}`);

  await fetch(`${origin}/posts/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: 20 }),
  });
  for (let i = 0; i < 20; i++) {
    row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
    if (row?.hotRank && JSON.parse(row.hotRank) === 60) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(JSON.parse(row.hotRank), 60, `after update should be 60, got ${row.hotRank}`);
});

test('projected.async compute failure leaves the column unchanged', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
        title: text(),
    score: number(),
    hotRank: projected.async({
      compute: async (row) => {
        if (row.score < 0) throw new Error('negative');
        return row.score * 10;
      },
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ schema: fixtureSchema(db), db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const r1 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Good', score: 5 }),
  });
  const created = await r1.json();
  let row;
  for (let i = 0; i < 20; i++) {
    row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
    if (row?.hotRank != null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(JSON.parse(row.hotRank), 50);

  await fetch(`${origin}/posts/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: -1 }),
  });
  for (let i = 0; i < 20; i++) {
    row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
    if (row?.hotRank != null && JSON.parse(row.hotRank) !== 50) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // If compute fails, value stays at 50 — wait for any change then check
  }
  await new Promise((resolve) => setTimeout(resolve, 50));

  row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
  assert.equal(JSON.parse(row.hotRank), 50, 'failed compute did not overwrite');
});

test('projected.async compute failure is logged on the projected channel', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
    title: text(),
    score: number(),
    hotRank: projected.async({
      compute: async (row) => {
        if (row.score < 0) throw new Error('negative');
        return row.score * 10;
      },
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const lines = [];
  const app = workbench({ schema: fixtureSchema(db), db, log: { output: (level, channel, msg, ctx) => lines.push({ level, channel, msg, ctx }) } });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const r1 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Good', score: 5 }),
  });
  const created = await r1.json();
  for (let i = 0; i < 20; i++) {
    const row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
    if (row?.hotRank != null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  await fetch(`${origin}/posts/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: -1 }),
  });

  let failure;
  for (let i = 0; i < 20; i++) {
    failure = lines.find((l) => l.channel === 'projected' && l.msg === 'compute failed');
    if (failure) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(failure, 'compute failure was logged');
  assert.equal(failure.level, 'warn');
  assert.equal(failure.ctx.entity, 'Post');
  assert.equal(failure.ctx.field, 'hotRank');
  assert.equal(failure.ctx.scope, `Post:${created.id}`);
  assert.equal(failure.ctx.err.message, 'negative');
});

test('projected.async field is rejected in client create payload (readonly)', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
        title: text(),
    score: number(),
    hotRank: projected.async({
      compute: async (row) => row.score,
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ schema: fixtureSchema(db), db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const res = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Hack', score: 5, hotRank: 999 }),
  });
  assert.equal(res.status, 400, 'readonly projected field rejected');
});

// --- computed.stored tests ---

test('computed.stored constructor validates compute is a function', () => {
  assert.throws(() => computed.stored({}), /compute function/);
  const d = computed.stored({ compute: (row) => row.score * 2 });
  assert.equal(d.kind, 'computed');
  assert.equal(d.mode, 'stored');
  assert.equal(d.readonly, true);
  assert.equal(typeof d.compute, 'function');
});

test('computed.stored value is stored immediately in the create response', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Blog (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Blog = entity('Blog', {
        title: text(),
    score: number(),
    hotRank: computed.stored({
      compute: (row) => (row.score ?? 0) * 2,
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ schema: fixtureSchema(db), db });
  app.mount('/blogs', Blog);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const res = await fetch(`${origin}/blogs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Post', score: 42 }),
  });
  assert.equal(res.status, 201);
  const created = await res.json();

  // Inline compute is synchronous with the transaction — value available immediately
  assert.equal(created.hotRank, 84, `hotRank should be 84 in response, got ${created.hotRank}`);

  const row = db.prepare('SELECT hotRank FROM Blog WHERE id = :id').get({ id: created.id });
  assert.equal(JSON.parse(row.hotRank), 84, `hotRank should be 84 in DB`);
});

test('computed.stored value is recomputed on update', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Blog (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Blog = entity('Blog', {
        title: text(),
    score: number(),
    hotRank: computed.stored({
      compute: (row) => (row.score ?? 0) * 3,
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ schema: fixtureSchema(db), db });
  app.mount('/blogs', Blog);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const r1 = await fetch(`${origin}/blogs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Post', score: 10 }),
  });
  const created = await r1.json();
  assert.equal(created.hotRank, 30);

  const r2 = await fetch(`${origin}/blogs/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: 20 }),
  });
  const updated = await r2.json();
  assert.equal(updated.hotRank, 60, `after update should be 60, got ${updated.hotRank}`);

  const row = db.prepare('SELECT hotRank FROM Blog WHERE id = :id').get({ id: created.id });
  assert.equal(JSON.parse(row.hotRank), 60);
});

test('computed.stored compute failure rolls back the mutation', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Blog (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Blog = entity('Blog', {
        title: text(),
    score: number(),
    hotRank: computed.stored({
      compute: (row) => {
        if (row.score < 0) throw new Error('negative score');
        return row.score * 10;
      },
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ schema: fixtureSchema(db), db });
  app.mount('/blogs', Blog);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  // Create with positive score — succeeds
  const r1 = await fetch(`${origin}/blogs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'OK', score: 5 }),
  });
  assert.equal(r1.status, 201);

  // Try to create with negative score — compute fails, transaction rolls back
  const r2 = await fetch(`${origin}/blogs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Bad', score: -1 }),
  });
  // The compute failure should result in a 500
  assert.ok(r2.status >= 400, `expected error status, got ${r2.status}`);

  // Row should NOT exist (rollback)
  const rows = db.prepare('SELECT id FROM Blog WHERE title = :t').all({ t: 'Bad' });
  assert.equal(rows.length, 0, 'failed create rolled back — no row');
});

// --- from trigger filtering ---

test('projected.async with from:created only recomputes on create, not update', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
        title: text(),
    score: number(),
    hotRank: projected.async({
      from: 'created',
      compute: async (row) => (row.score ?? 0) * 2,
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ schema: fixtureSchema(db), db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const r1 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Post', score: 10 }),
  });
  const created = await r1.json();
  await new Promise((resolve) => setTimeout(resolve, 50));

  let row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
  assert.equal(JSON.parse(row.hotRank), 20, 'computed on create');

  // Update — should NOT trigger recompute because from is only 'created'
  await fetch(`${origin}/posts/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: 50 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
  assert.equal(JSON.parse(row.hotRank), 20, 'unchanged — from:created excludes update');
});

test('projected.async with from:updated only recomputes on update', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
        title: text(),
    score: number(),
    hotRank: projected.async({
      from: 'Post.updated',
      compute: async (row) => (row.score ?? 0) * 3,
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ schema: fixtureSchema(db), db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  // Create — should NOT trigger (from is only 'updated')
  const r1 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Post', score: 10 }),
  });
  const created = await r1.json();
  await new Promise((resolve) => setTimeout(resolve, 50));

  let row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
  assert.equal(row.hotRank, null, 'null — from:updated excludes create');

  // Update — should trigger
  await fetch(`${origin}/posts/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: 50 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
  assert.equal(JSON.parse(row.hotRank), 150, 'computed on update');
});

test('projected.async without from recomputes on both create and update (default)', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
        title: text(),
    score: number(),
    hotRank: projected.async({
      compute: async (row) => (row.score ?? 0) * 5,
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ schema: fixtureSchema(db), db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const r1 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Post', score: 10 }),
  });
  const created = await r1.json();
  await new Promise((resolve) => setTimeout(resolve, 50));

  let row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
  assert.equal(JSON.parse(row.hotRank), 50, 'computed on create');

  await fetch(`${origin}/posts/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: 20 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
  assert.equal(JSON.parse(row.hotRank), 100, 'computed on update');
});

// --- sequence watermarking ---

test('compute counter advances with each successful compute, survives across events', async (t) => {
  const db = new DatabaseSync(':memory:');
  const { executeFrameworkDDL } = await import('../build/ddl.mjs');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  let computeCount = 0;
  const Post = entity('Post', {
        title: text(),
    score: number(),
    hotRank: projected.async({
      compute: async (row) => {
        computeCount++;
        return (row.score ?? 0) * 2;
      },
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ schema: fixtureSchema(db), db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  // First create
  const r1 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Post1', score: 10 }),
  });
  await r1.json();
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(computeCount, 1, 'computed once');

  let cursor = db.prepare(
    "SELECT lastSeq FROM _ProjectedCursor WHERE entity = 'Post' AND field = 'hotRank'",
  ).get();
  assert.ok(cursor, 'cursor row exists');
  assert.equal(cursor.lastSeq, 1, 'cursor = 1 after first compute');

  // Second create — counter advances
  computeCount = 0;
  const r2 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Post2', score: 20 }),
  });
  await r2.json();
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(computeCount, 1, 'computed exactly once on second create');
  cursor = db.prepare(
    "SELECT lastSeq FROM _ProjectedCursor WHERE entity = 'Post' AND field = 'hotRank'",
  ).get();
  assert.equal(cursor.lastSeq, 2, 'cursor advanced to 2');

  // Update second post — counter advances again
  computeCount = 0;
  const rows = db.prepare('SELECT id FROM Post WHERE title = :t').all({ t: 'Post2' });
  const post2Id = rows[0].id;
  await fetch(`${origin}/posts/${post2Id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: 30 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(computeCount, 1, 'computed exactly once on update');
  cursor = db.prepare(
    "SELECT lastSeq FROM _ProjectedCursor WHERE entity = 'Post' AND field = 'hotRank'",
  ).get();
  assert.equal(cursor.lastSeq, 3, 'cursor advanced to 3');

  // Compute failure does NOT advance cursor
  computeCount = 0;
  const PostWithFailure = entity('PostWithFail', {
        title: text(),
    score: number(),
    hotRank: projected.async({
      compute: async () => { computeCount++; throw new Error('fail'); },
      from: 'created',
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  // An app owns the one write coordinator for its database handle, so the
  // second app uses its own handle (the boot creates framework DDL on it).
  const db2 = new DatabaseSync(':memory:');
  const app2 = workbench({ schema: fixtureSchema(db2), db: db2 });
  app2.mount('/failposts', PostWithFailure);
  app2.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app2.ready;

  const origin2 = `http://127.0.0.1:${app2.httpServer.address().port}`;
  await fetch(`${origin2}/failposts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Fail', score: 5 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(computeCount, 1, 'compute attempted once');
  const failCursor = db2.prepare(
    "SELECT lastSeq FROM _ProjectedCursor WHERE entity = 'PostWithFail' AND field = 'hotRank'",
  ).get();
  assert.equal(failCursor, undefined, 'no cursor row — compute failure did not advance');

  app2.httpServer.close();
  db2.close();
});

// --- raster.crdt / polyline.crdt constructors ---

test('raster.crdt() returns a crdt-kind descriptor', () => {
  const d = raster.crdt({ mergeStrategy: 'blend' });
  assert.equal(d.kind, 'crdt');
  assert.equal(d.type, 'raster');
  assert.equal(d.mergeStrategy, 'blend');
});

test('polyline.crdt() returns a crdt-kind descriptor', () => {
  const d = polyline.crdt();
  assert.equal(d.kind, 'crdt');
  assert.equal(d.type, 'polyline');
});

test('raster.crdt and polyline.crdt validate structurally', () => {
  const ras = resolveStrategy('crdt');
  assert.equal(ras.validate(Buffer.from('pixels'), { type: 'raster' }), true);
  assert.equal(ras.validate('base64string', { type: 'raster' }), true);
  assert.equal(ras.validate(null, { type: 'raster' }), true);
  assert.equal(ras.validate(42, { type: 'raster' }), 'expected a raster value (Buffer, string, or null)');

  assert.equal(ras.validate([{ x: 1, y: 2 }], { type: 'polyline' }), true);
  assert.equal(ras.validate([], { type: 'polyline' }), true);
  assert.equal(ras.validate(null, { type: 'polyline' }), true);
  assert.equal(ras.validate('not-array', { type: 'polyline' }), 'expected a polyline value (array or null)');
});

test('raster and polyline fields compile into an entity', () => {
  const Canvas = entity('Canvas', {
        imageData: raster.crdt({ mergeStrategy: 'blend' }),
    stroke: polyline.crdt(),

    grant: () => [scope(() => never()).can(() => grant(read))],
  });
  assert.equal(Canvas.fields.imageData.kind, 'crdt');
  assert.equal(Canvas.fields.imageData.type, 'raster');
  assert.equal(Canvas.fields.imageData.mergeStrategy, 'blend');
  assert.equal(Canvas.fields.stroke.kind, 'crdt');
  assert.equal(Canvas.fields.stroke.type, 'polyline');
});

// --- text({ oneOf }) closed text domain ---

test('text({ oneOf }) returns a value/text descriptor with validate', () => {
  const d = text({ oneOf: ['rect', 'ellipse', 'freedraw'] });
  assert.equal(d.kind, 'value');
  assert.equal(d.type, 'text');
  assert.deepEqual(d.oneOf, ['rect', 'ellipse', 'freedraw']);
  assert.ok(Object.isFrozen(d.oneOf));
  assert.equal(typeof d.validate, 'function');
  assert.equal(d.validate('rect'), true);
  assert.equal(d.validate('ellipse'), true);
  assert.notEqual(d.validate('triangle'), true);
});

test('text({ oneOf }) throws on empty or non-array values', () => {
  assert.throws(() => text({ oneOf: 'rect' }), { message: /requires a non-empty array/ });
  assert.throws(() => text({ oneOf: [] }), { message: /requires a non-empty array/ });
});

test('text({ oneOf }) validates through the pipeline', () => {
  const Shape = entity('Shape', {
        type: text({ oneOf: ['rect', 'ellipse', 'freedraw', 'text', 'arrow'] }),

    grant: () => [scope(() => never()).can(() => grant(read))],
  });

  assert.doesNotThrow(() => validateMutation(Shape, { type: 'rect' }));
  assert.throws(
    () => validateMutation(Shape, { type: 'triangle' }),
    { message: /expected one of/ },
  );
});

// --- projected.async compute can query related entities ---

// Existing related-entity compute functions can still use the ambient query API;
// explicit DB-handle access is covered by the committed-db-handle test above.

test('projected.async compute can findAll related entities', async (t) => {
  const db = new DatabaseSync(':memory:');

  let _TCommentBound;

  const TComment = entity('TComment_FindAll', {
        post: ref('TPost_FindAll'),
    body: text(),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const TPost = entity('TPost_FindAll', {
        title: text(),
    score: number({ default: 0 }),
    commentRank: projected.async({
      from: ['created', 'updated'],
      compute: async (post) => {
        const cmts = await _TCommentBound.findAll(_TCommentBound.post.is(post.id));
        return cmts.length + (post.score ?? 0);
      },
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ schema: fixtureSchema(db), db, entities: [TPost, TComment] });
  _TCommentBound = app.entity(TComment);
  app.mount('/tpost', TPost);
  app.mount('/tcomment', TComment);
  await app.ddl();
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  // Create post
  const r1 = await fetch(`${origin}/tpost`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'test', score: 3 }),
  });
  assert.equal(r1.status, 201);
  const { id: postId } = await r1.json();

  await new Promise((r) => setTimeout(r, 500));

  // Verify initial compute fired (0 comments + 3 score = 3)
  let row = db.prepare('SELECT commentRank FROM TPost_FindAll WHERE id = :id').get({ id: postId });
  assert.ok(row, 'post row exists');
  assert.ok(row.commentRank, 'commentRank should be set after create');
  assert.equal(JSON.parse(row.commentRank), 3, 'rank after create = score');

  // Create comments
  for (const body of ['c1', 'c2']) {
    const r = await fetch(`${origin}/tcomment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ post: postId, body }),
    });
    assert.equal(r.status, 201);
    await new Promise((r) => setTimeout(r, 200));
  }

  // Update post to trigger recompute (Comment.created doesn't trigger Post's projected.async)
  const r4 = await fetch(`${origin}/tpost/${postId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'updated' }),
  });
  assert.equal(r4.status, 200);

  await new Promise((r) => setTimeout(r, 500));

  row = db.prepare('SELECT commentRank FROM TPost_FindAll WHERE id = :id').get({ id: postId });
  assert.ok(row, 'post row exists');
  assert.ok(row.commentRank, 'commentRank should not be null');
  const rank = JSON.parse(row.commentRank);
  assert.equal(rank, 5, `commentRank expected 5, got ${rank}`);
});

// --- projected.async staleness indicators (x-workbench-projected-<field>) ---

test('read response includes projected cursor headers for staleness detection', async (t) => {
  const db = new DatabaseSync(':memory:');

  const Post = entity('Post_Stale', {
        title: text(),
    hotRank: projected.async({
      from: ['created', 'updated'],
      compute: (row) => (row.title?.length ?? 0),
    }),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ schema: fixtureSchema(db), db });
  app.mount('/posts', Post);
  await app.ddl();
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const r1 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 't' }),
  });
  assert.equal(r1.status, 201);
  const { id } = await r1.json();

  // Wait for post-commit consumer to compute hotRank
  await new Promise((r) => setTimeout(r, 300));

  // Read the post — should have a projected cursor header
  const r2 = await fetch(`${origin}/posts/${id}`);
  assert.equal(r2.status, 200);
  const cursorHeader = r2.headers.get('x-workbench-projected-hotRank');
  assert.ok(cursorHeader, 'projected cursor header is present');
  assert.ok(Number(cursorHeader) >= 1, `expected cursor >= 1, got ${cursorHeader}`);

  // List responses carry the same staleness header
  const r3 = await fetch(`${origin}/posts`);
  assert.equal(r3.status, 200);
  const listHeader = r3.headers.get('x-workbench-projected-hotRank');
  assert.ok(listHeader, 'list response carries projected cursor header');
  assert.ok(Number(listHeader) >= 1, `list cursor >= 1, got ${listHeader}`);
});

// --- projected.async boot recovery (reconcileProjectedRecovery) ---

// Simulate a crash: events are committed to _Log but the post-commit consumer
// never applied the projection (the recovery cursor is absent). The boot sweep
// must recompute the field from current row state and advance the cursor to the
// scope's log head — closing the crash gap the design identifies.
test('reconcileProjectedRecovery recomputes lagging scopes and advances to head', async () => {
  const db = new DatabaseSync(':memory:');
  const { executeFrameworkDDL } = await import('../build/ddl.mjs');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
    title: text(),
    score: number(),
    hotRank: projected.async({ compute: async (row) => (row.score ?? 0) * 2 }),
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  const entities = new Map([[Post.name, Post]]);

  // Commit a row + a log event WITHOUT running the consumer (simulating a crash
  // between COMMIT and the post-commit consumer). The row exists in current
  // state; the projection was never applied (hotRank stays null).
  db.prepare("INSERT INTO Post (id, title, score, hotRank) VALUES ('p1','t',7,NULL)").run();
  db.prepare("INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES ('Post:p1',1,'Post.created',:d,'a1','2026-01-01T00:00:00Z')").run({ d: '{}' });
  db.prepare("INSERT INTO _Cursor (scope, lastSeq) VALUES ('Post:p1', 1)").run();

  // Before reconcile: no recovery cursor, field stale.
  let recovery = db.prepare("SELECT lastSeq FROM _ConsumerCursor WHERE consumer='projected.async' AND scope='Post:p1'").get();
  assert.equal(recovery, undefined, 'no recovery cursor before sweep');
  let row = db.prepare("SELECT hotRank FROM Post WHERE id='p1'").get();
  assert.equal(row.hotRank, null, 'field stale before sweep');

  const result = await reconcileProjectedRecovery(db, entities);
  assert.equal(result.recomputed, 1, 'one scope recomputed');
  assert.equal(result.cleaned, 0, 'nothing cleaned');

  // After reconcile: field computed from current row state, cursor at head (1).
  row = db.prepare("SELECT hotRank FROM Post WHERE id='p1'").get();
  assert.equal(JSON.parse(row.hotRank), 14, 'field recomputed from row state');
  recovery = db.prepare("SELECT lastSeq FROM _ConsumerCursor WHERE consumer='projected.async' AND scope='Post:p1'").get();
  assert.equal(recovery.lastSeq, 1, 'cursor advanced to log head');

  // Idempotent: a second sweep finds the scope current and changes nothing.
  const result2 = await reconcileProjectedRecovery(db, entities);
  assert.equal(result2.recomputed, 0, 'second sweep: scope already current');
  assert.equal(result2.cleaned, 0, 'second sweep: nothing cleaned');
  row = db.prepare("SELECT hotRank FROM Post WHERE id='p1'").get();
  assert.equal(JSON.parse(row.hotRank), 14, 'value unchanged by idempotent sweep');
  db.close();
});

test('reconcileProjectedRecovery cleans up recovery cursors for removed rows', async () => {
  const db = new DatabaseSync(':memory:');
  const { executeFrameworkDDL } = await import('../build/ddl.mjs');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
    title: text(),
    score: number(),
    hotRank: projected.async({ compute: async (row) => (row.score ?? 0) * 2 }),
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  const entities = new Map([[Post.name, Post]]);

  // A scope has events in _Log and a recovery cursor, but the row was removed.
  db.prepare("INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES ('Post:gone',1,'Post.created',:d,'a1','2026-01-01T00:00:00Z')").run({ d: '{}' });
  db.prepare("INSERT INTO _Cursor (scope, lastSeq) VALUES ('Post:gone', 1)").run();
  db.prepare("INSERT INTO _ConsumerCursor (consumer, scope, lastSeq) VALUES ('projected.async','Post:gone',0)").run();

  const result = await reconcileProjectedRecovery(db, entities);
  assert.equal(result.recomputed, 0, 'nothing recomputed (row gone)');
  assert.equal(result.cleaned, 1, 'phantom cursor cleaned');

  const recovery = db.prepare("SELECT lastSeq FROM _ConsumerCursor WHERE consumer='projected.async' AND scope='Post:gone'").get();
  assert.equal(recovery, undefined, 'recovery cursor for removed row deleted');
  db.close();
});

test('reconcileProjectedRecovery leaves current scopes untouched', async () => {
  const db = new DatabaseSync(':memory:');
  const { executeFrameworkDDL } = await import('../build/ddl.mjs');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
    title: text(),
    score: number(),
    hotRank: projected.async({ compute: async (row) => (row.score ?? 0) * 2 }),
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  const _entities = new Map([[Post.name, Post]]);

  // Scope is fully caught up: recovery cursor at head.
  db.prepare("INSERT INTO Post (id, title, score, hotRank) VALUES ('p1','t',7,'14')").run();
  db.prepare("INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES ('Post:p1',1,'Post.created',:d,'a1','2026-01-01T00:00:00Z')").run({ d: '{}' });
  db.prepare("INSERT INTO _Cursor (scope, lastSeq) VALUES ('Post:p1', 1)").run();
  db.prepare("INSERT INTO _ConsumerCursor (consumer, scope, lastSeq) VALUES ('projected.async','Post:p1',1)").run();

  let computeCount = 0;
  const entitiesTracked = new Map([[Post.name, {
    ...Post,
    projectedAsyncFields: Post.projectedAsyncFields.map(([n, d]) => [n, { ...d, compute: async (row) => { computeCount++; return d.compute(row); } }]),
  }]]);

  const result = await reconcileProjectedRecovery(db, entitiesTracked);
  assert.equal(result.recomputed, 0, 'current scope not recomputed');
  assert.equal(result.cleaned, 0, 'nothing cleaned');
  assert.equal(computeCount, 0, 'compute NOT invoked on a current scope');
  db.close();
});

// Integration: the sweep runs during app.ready, so a freshly-started app back-
// fills any projected fields left stale by a prior crash before serving traffic.
test('app.ready runs the projected recovery sweep (backfill before serving)', async (t) => {
  const db = new DatabaseSync(':memory:');
  const { executeFrameworkDDL } = await import('../build/ddl.mjs');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
    title: text(),
    score: number(),
    hotRank: projected.async({ compute: async (row) => (row.score ?? 0) * 2 }),
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  // Pre-seed the DB as if a prior process crashed: committed row + log event,
  // but the projection never applied (hotRank NULL, no recovery cursor).
  db.prepare("INSERT INTO Post (id, title, score, hotRank) VALUES ('p1','t',21,NULL)").run();
  db.prepare("INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES ('Post:p1',1,'Post.created',:d,'a1','2026-01-01T00:00:00Z')").run({ d: '{}' });
  db.prepare("INSERT INTO _Cursor (scope, lastSeq) VALUES ('Post:p1', 1)").run();

  const app = workbench({ schema: fixtureSchema(db), db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });

  // app.ready ran the sweep under the mutex; the stale field is backfilled.
  const row = db.prepare("SELECT hotRank FROM Post WHERE id='p1'").get();
  assert.equal(JSON.parse(row.hotRank), 42, 'stale field backfilled on startup');
  const recovery = db.prepare("SELECT lastSeq FROM _ConsumerCursor WHERE consumer='projected.async' AND scope='Post:p1'").get();
  assert.equal(recovery.lastSeq, 1, 'recovery cursor at head after startup sweep');
});

test('reconcileProjectedRecovery skips scopes for entities with no projected.async fields', async () => {
  const db = new DatabaseSync(':memory:');
  const { executeFrameworkDDL } = await import('../build/ddl.mjs');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Plain (id TEXT, title TEXT)');

  const Plain = entity('Plain', {
    title: text(),
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  const entities = new Map([[Plain.name, Plain]]);

  db.prepare("INSERT INTO Plain (id, title) VALUES ('x','hi')").run();
  db.prepare("INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES ('Plain:x',1,'Plain.created',:d,'a1','2026-01-01T00:00:00Z')").run({ d: '{}' });

  const result = await reconcileProjectedRecovery(db, entities);
  assert.equal(result.recomputed, 0, 'non-projected entity not touched');
  assert.equal(result.cleaned, 0, 'non-projected entity: nothing cleaned');
  db.close();
});
