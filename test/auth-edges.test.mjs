// Hardening: auth edge cases — gate rejection, row-grant denial, validation errors.
import { text, ref, computed, date, grant, read, write, scope, requireUser, allowAnonymous } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, generateDDL } from '../build/internal.mjs';

function makeNote() {
  return entity('Note', {
        body: text(),
    wordCount: computed({ compute: (d) => d.body ? d.body.length : 0 }),
    updatedAt: date({ touch: true }),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [scope(({ is }) => is.owner()).can(async ({ is }) => (await is.owner()) ? grant(read, write) : grant(read))],
    gate: { list: allowAnonymous() },
    routes: (r) => r.resource(),
  });
}

function setup({ principal } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  db.exec("INSERT INTO User (id, username, password) VALUES (1, 'alice', 'hash')");
  const Note = makeNote();
  for (const sql of generateDDL(Note)) db.exec(sql);
  const app = workbench({ db }).mount('/notes', Note);
  app.listen(0, { principalOf: () => principal ?? { type: 'anonymous', id: null } });
  return { app, db };
}

test('anonymous is rejected by default-on route gate (401)', async () => {
  const { app } = setup();
  await app.ready;
  const { port } = app.httpServer.address();

  const r = await fetch(`http://127.0.0.1:${port}/notes`);
  // list is allowAnonymous — should pass
  assert.equal(r.status, 200);

  const r2 = await fetch(`http://127.0.0.1:${port}/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'x' }),
  });
  // create defaults to requireUser — anonymous gets 401
  assert.equal(r2.status, 401);

  app.httpServer.close();
});

test('row grant denies a different user (403)', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  db.exec("INSERT INTO User (id, username, password) VALUES (1, 'alice', 'hash')");
  db.exec("INSERT INTO User (id, username, password) VALUES (2, 'bob', 'hash')");
  const Note = makeNote();
  for (const sql of generateDDL(Note)) db.exec(sql);

  const app = workbench({ db }).mount('/notes', Note);
  // Create as alice
  app.listen(0, { principalOf: () => ({ type: 'user', id: '1' }) });
  await app.ready;
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  const r1 = await fetch(`${origin}/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'alices note' }),
  });
  assert.equal(r1.status, 201);
  const doc = await r1.json();

  // Now create a new app with bob as principal. Shut the first app down (not
  // just its listener): shutdown drains and closes its handle-attached write
  // coordinator, which is the one authority that may be reattached to this db.
  await app.shutdown();

  const app2 = workbench({ db }).mount('/notes', Note);
  app2.listen(0, { principalOf: () => ({ type: 'user', id: '2' }) });
  await app2.ready;
  const port2 = app2.httpServer.address().port;

  // Bob can list via allowAnonymous
  const r2 = await fetch(`http://127.0.0.1:${port2}/notes`);
  assert.equal(r2.status, 200);

  // Bob tries to read alices note — the scope filters it out (404, not 403)
  const r3 = await fetch(`http://127.0.0.1:${port2}/notes/${doc.id}`);
  assert.equal(r3.status, 404, 'bob cannot see alices note (scope filter)');

  await app2.shutdown();
});

test('client sending computed/touch/readonly field in payload → 400', async () => {
  const { app } = setup({ principal: { type: 'user', id: '1' } });
  await app.ready;
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  // Computed field
  const r1 = await fetch(`${origin}/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'x', wordCount: 5 }),
  });
  assert.equal(r1.status, 400);

  // Touch field
  const r2 = await fetch(`${origin}/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'x', updatedAt: 'today' }),
  });
  assert.equal(r2.status, 400);

  // Readonly field
  const r3 = await fetch(`${origin}/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'x', owner: 'hacker' }),
  });
  assert.equal(r3.status, 400);

  app.httpServer.close();
});

test('unknown field in payload → 400 (fail closed)', async () => {
  const { app } = setup({ principal: { type: 'user', id: '1' } });
  await app.ready;
  const { port } = app.httpServer.address();

  const r = await fetch(`http://127.0.0.1:${port}/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'x', hack: true }),
  });
  assert.equal(r.status, 400);

  app.httpServer.close();
});
