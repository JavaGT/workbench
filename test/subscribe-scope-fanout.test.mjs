// W5 slice 2: scope-keyed fan-out + scope-level snapshot/events-since routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, text, generateDDL, grant, scope, read, write, subscribe as subVerb } from '../build/internal.mjs';
import { createLiveFanout } from '../build/live-fanout.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeConn(id, principalId = id) {
  const messages = [];
  return {
    id, closed: false,
    principal: { type: 'user', id: principalId },
    send(m) { messages.push(m); },
    drain() { const out = [...messages]; messages.length = 0; return out; },
  };
}

// --- Fan-out: scope-keyed registry ---

test('scope-keyed fanout: add by scope string delivers to that scope', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const entity = { name: 'Doc', fields: {}, grant: () => [scope(() => true)], findById(id) { return { id, title: 'v1' }; } };

  fanout.addSubscription('Doc:d1', conn);
  assert.equal(fanout.subscriptionCount(conn), 1);
  assert.equal(fanout.hasSubscription(conn, 'Doc:d1'), true);

  await fanout.emit(entity, 'd1', { id: 'd1', title: 'new' }, { type: 'Doc.created', scope: 'Doc:d1', seq: 3, data: { id: 'd1' } });
  const msgs = conn.drain();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].entity, 'Doc');
  assert.equal(msgs[0].id, 'd1');
  assert.equal(msgs[0].seq, 3);
});

test('scope-keyed fanout: legacy addSubscription(entity, id, conn) still works', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const entity = { name: 'Note', fields: {}, grant: () => [scope(() => true)], findById(id) { return { id, title: 'v1' }; } };

  fanout.addSubscription('Note', 'n1', conn);
  assert.equal(fanout.subscriptionCount(conn), 1);
  assert.equal(fanout.hasSubscription(conn, 'Note', 'n1'), true);

  await fanout.emit(entity, 'n1', { id: 'n1', title: 'new' }, { type: 'Note.created', scope: 'Note:n1', seq: 5, data: { id: 'n1' } });
  assert.equal(conn.drain().length, 1);
});

test('scope-keyed fanout: coarse scope subscription receives all events for that scope', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const entity = { name: 'Card', fields: {}, grant: () => [scope(() => true)], findById(id) { return { id, title: 'v1' }; } };

  fanout.addSubscription('project:p1', conn);

  await fanout.emit(entity, 'card1', { id: 'card1', title: 'c1' }, { type: 'Card.created', scope: 'project:p1', seq: 1, data: { id: 'card1' } });
  await fanout.emit(entity, 'card2', { id: 'card2', title: 'c2' }, { type: 'Card.updated', scope: 'project:p1', seq: 2, data: { id: 'card2' } });

  const msgs = conn.drain();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].seq, 1);
  assert.equal(msgs[1].seq, 2);
});

test('scope-keyed fanout: event with wrong scope does not deliver', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const entity = { name: 'Doc', fields: {}, grant: () => [scope(() => true)], findById(id) { return { id, title: 'v1' }; } };

  fanout.addSubscription('Doc:d1', conn);

  await fanout.emit(entity, 'd1', { id: 'd1', title: 'v1' }, { type: 'Doc.created', scope: 'Doc:d2', seq: 1, data: { id: 'd1' } });
  assert.equal(conn.drain().length, 0, 'event with different scope not delivered');
});

test('scope-keyed fanout: removeSubscription removes by scope', () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');

  fanout.addSubscription('Doc:d1', conn);
  fanout.addSubscription('Doc:d2', conn);
  assert.equal(fanout.subscriptionCount(conn), 2);

  fanout.removeSubscription('Doc:d1', conn);
  assert.equal(fanout.subscriptionCount(conn), 1);
  assert.equal(fanout.hasSubscription(conn, 'Doc:d1'), false);
});

test('scope-keyed fanout: legacy removeSubscription(entity, id, conn) still works', () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');

  fanout.addSubscription('Doc', 'd1', conn);
  assert.equal(fanout.subscriptionCount(conn), 1);

  fanout.removeSubscription('Doc', 'd1', conn);
  assert.equal(fanout.subscriptionCount(conn), 0);
});

// --- HTTP: scope-level snapshot and events-since routes ---

function bootApp() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT)');
  db.exec("INSERT INTO User (id, username) VALUES ('1', 'alice')");
  const Doc = entity('Doc', {
    title: text(),
    grant: () => [scope().can(() => grant(read, write, subVerb))],
  });
  for (const sql of generateDDL(Doc)) db.exec(sql);
  db.prepare("INSERT INTO Doc (id, title) VALUES ('d1', 'hello')").run();
  const app = workbench({ db }).mount('/docs', Doc);
  app.listen(0, { principalOf: () => ({ type: 'user', id: '1' }) });
  return { app, db, Doc };
}

test('scope-level events-since: returns events for exact scope', async () => {
  const { app, db } = bootApp();
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  // Create an event in _Log
  await fetch(`${origin}/docs/d1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'updated' }),
  });

  const res = await fetch(`${origin}/events-since?scope=Doc:d1&cursor=0`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.scope, 'Doc:d1');
  assert.ok(body.events.length >= 1, 'at least one event');
  assert.equal(body.events[0].scope, 'Doc:d1');
  assert.equal(body.events[0].seq, 1);

  app.httpServer.close();
  db.close();
});

test('scope-level events-since: empty when cursor is at tip', async () => {
  const { app, db } = bootApp();
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  const res = await fetch(`${origin}/events-since?scope=Doc:d1&cursor=999`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.events, []);

  app.httpServer.close();
  db.close();
});

test('scope-level events-since never exposes a foreign entity payload', async (t) => {
  const db = new DatabaseSync(':memory:');
  const Project = entity('Project', {
    name: text(),
    grant: () => [scope().can(() => grant(read, write, subVerb))],
  });
  const Comment = entity('Comment', {
    projectId: text(),
    body: text(),
    grant: () => [scope().can(() => grant(read, write, subVerb))],
  });
  for (const sql of [...generateDDL(Project), ...generateDDL(Comment)]) db.exec(sql);
  db.prepare("INSERT INTO Project (id, name) VALUES ('p1', 'one')").run();
  const app = workbench({ db }).mount('/projects', Project).mount('/comments', Comment);
  app.listen(0, { principalOf: () => ({ type: 'user', id: '1' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });

  const result = await app.batch([
    { type: 'Comment.create', payload: { id: 'c1', projectId: 'p1', body: 'private comment body' } },
  ], { principal: { type: 'user', id: '1' }, scope: 'Project:p1' });
  assert.equal(result.ok, true);
  // Model the composed child emission on its authorized parent scope.
  db.prepare('UPDATE _Log SET scope = ? WHERE scope = ?').run('Project:p1', 'Comment:c1');
  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?)').run('Project:p1', 1);

  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const response = await fetch(`${origin}/events-since?scope=Project:p1&cursor=0`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.resync, 'stale');
  assert.equal(body.reason, 'recipient-snapshot-required');
  assert.equal(JSON.stringify(body).includes('private comment body'), false);
  assert.equal(JSON.stringify(body).includes('c1'), false);
});

test('scope-level snapshot: returns row + cursor for entity-shaped scope', async () => {
  const { app, db } = bootApp();
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  // First update to create a cursor entry
  await fetch(`${origin}/docs/d1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'patched' }),
  });

  const res = await fetch(`${origin}/snapshot?scope=Doc:d1`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.snapshot, 'snapshot present');
  assert.equal(body.snapshot.title, 'patched');
  assert.ok(body.cursors, 'cursors present');
  assert.ok(typeof body.cursors['Doc:d1'] === 'number', 'cursor value is number');

  app.httpServer.close();
  db.close();
});

test('scope-level snapshot: returns 404 for unknown scope', async () => {
  const { app, db } = bootApp();
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  const res = await fetch(`${origin}/snapshot?scope=Unknown:x`);
  assert.equal(res.status, 404);

  app.httpServer.close();
  db.close();
});
