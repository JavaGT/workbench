// Smoke test — the product app (app.mjs spine) boots and serves CRUD.
//
// This test stands up the real Doc → Comment entity chain against a :memory:
// database, auto-creates tables via generateDDL, seeds a User, and exercises
// the core CRUD path end-to-end through the HTTP server.

import { text, ref, grant, read, write, subscribe, scope, User } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity, generateDDL } from '../build/internal.mjs';

// Re-create the doc.mjs Doc entity inline (avoids the exemplar import cycle
// that's now lazily resolved — this test is the real-usage smoke).
import { Doc } from '../projects/doc.mjs';
import { Comment } from '../projects/comment.mjs';

test('doc entity resolves and DDL generates without error', () => {
  // importing doc.mjs is the acid test — it resolves Comment via lazy import.
  assert.equal(typeof Doc.name, 'string');
  assert.equal(Doc.name, 'Doc');

  const ddl = generateDDL(Doc);
  assert.ok(ddl.length >= 2, `DDL has main table + map side-table, got ${ddl.length}`);

  // Main table must have key columns
  const main = ddl[0];
  assert.ok(main.includes('id TEXT PRIMARY KEY'));
  assert.ok(main.includes('"title" TEXT'));
  assert.ok(main.includes('body')); // crdt text

  // Map side-table
  const side = ddl[1];
  assert.ok(side.includes('Doc_collaborators'));
  assert.ok(side.includes('Doc_id'));
  assert.ok(side.includes('member_id'));
  assert.ok(side.includes('role'));
});

test('app boots with Doc entity and serves the routing table', async () => {
  const db = new DatabaseSync(':memory:');

  // Create tables manually for the entities the app needs (User, Session are
  // framework-entities; Doc is the product entity; Comment is its child).
  for (const stmt of [
    `CREATE TABLE IF NOT EXISTS User (
       id TEXT PRIMARY KEY, username TEXT, password TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS Session (
       id TEXT PRIMARY KEY, token TEXT, userId TEXT, principalType TEXT,
       principalId TEXT, kind TEXT, createdAt TEXT
     )`,
  ]) {
    db.exec(stmt);
  }

  // Generate and execute DDL for Doc (and Comment, transitively)
  const app = workbench({ db });
  app.mount('/docs', Doc);
  generateDDL(Comment).forEach(sql => db.exec(sql));
  await app.ddl();

  // Verify tables exist
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  assert.ok(tables.includes('Doc'));
  assert.ok(tables.includes('Doc_collaborators'));
  assert.ok(tables.includes('Comment'));

  // Seed a user (owner field is readonly, so raw INSERT is the blessed path)
  db.exec("INSERT INTO User (id, username, password) VALUES (1, 'alice', 'hash')");

  // Resolve routes and start
  await app.resolveRoutes();
  assert.ok(Array.isArray(app.routes));
  assert.ok(app.routes.length > 0, 'routes resolved');
});

test('HTTP CRUD: create and read a Doc row through the server', async () => {
  const db = new DatabaseSync(':memory:');

  // Set up tables
  db.exec(`CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS Session (id TEXT PRIMARY KEY, token TEXT, userId TEXT, principalType TEXT, principalId TEXT, kind TEXT, createdAt TEXT)`);

  const app = workbench({ db });
  app.mount('/docs', Doc);
  generateDDL(Comment).forEach(sql => db.exec(sql));
  await app.ddl();

  // Seed owner
  db.exec("INSERT INTO User (id, username, password) VALUES (1, 'alice', 'hash')");

  // Start server with a fixed principal (owner)
  const alice = { type: 'user', id: '1' };
  app.listen(0, { principalOf: () => alice });
  await app.ready;
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  try {
    // Create a Doc
    const createRes = await fetch(`${origin}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'My Doc' }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.title, 'My Doc');
    assert.equal(created.body, '');
    assert.equal(created.owner, '1');
    const docId = created.id;

    const operation = ['workbench.text', 1, ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1], 1, [], ['insert', ['root'], 'hello world']];
    const applyRes = await fetch(`${origin}/docs/${docId}/body/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation }),
    });
    assert.equal(applyRes.status, 200);
    assert.equal((await applyRes.json()).body, 'hello world');

    // Read the Doc
    const readRes = await fetch(`${origin}/docs/${docId}`);
    assert.equal(readRes.status, 200);
    const doc = await readRes.json();
    assert.equal(doc.title, 'My Doc');
    assert.equal(doc.body, 'hello world');

    // List all Docs
    const listRes = await fetch(`${origin}/docs`);
    assert.equal(listRes.status, 200);
    const docs = await listRes.json();
    assert.ok(Array.isArray(docs));
    assert.ok(docs.some((d) => d.id === docId));

    // Update the Doc
    const updateRes = await fetch(`${origin}/docs/${docId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Updated Doc' }),
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.equal(updated.title, 'Updated Doc');

    // Delete the Doc
    const deleteRes = await fetch(`${origin}/docs/${docId}`, { method: 'DELETE' });
    assert.equal(deleteRes.status, 204);

    // Deleted doc is 404
    const goneRes = await fetch(`${origin}/docs/${docId}`);
    assert.equal(goneRes.status, 404);
  } finally {
    app.httpServer.close();
  }
});
