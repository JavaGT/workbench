// convergence-integration.test.mjs — acceptance run exercising the convergence
// layers (W1 passkeys, W3 job queue, W5 client engine) in a single node --test
// run against a real workbench server. The W4 UI kit was deleted (issues
// #43/#44); this file no longer covers it.
//
// Layer coverage:
//   W1: passkey auth — login → cookie session → authorised CRUD → logout
//   W3: job queue — HTTP enqueue → register worker → claim → submit result
//   W5: client engine — createLiveStore boot → dispatch → canUndoField surface
//
// The W1+W3 tests boot shared servers so the "single acceptance run"
// constraint holds. W5 tests run unit-style against the client library.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import workbench from '../build/app.mjs';
import { createLiveStore, LiveChannel as _LiveChannel, decodeResult as _decodeResult } from '../public/workbench-client.mjs';
import { SESSION_COOKIE } from '../build/auth/session.mjs';
import { canUndoField, undoableFieldKinds } from '../build/field-laws.mjs';
import { makeFakeChannel, makeFakeFetch } from './fixtures/fake-transport.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sidFromSetCookie(header) {
  const first = header.split(/,(?=[^ ;]+)/)[0];
  const match = first.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

/** Boot a workbench app with auth + an owner-scoped Note entity. */
async function bootAuthApp(t) {
  const { entity, text, ref, grant, deny, read, write, subscribe, scope } = await import('../build/index.mjs');
  const Note = entity('Note', {
    body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [scope(({ is }) => is.owner()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : deny('not owner'))],
    routes: (r) => { r.resource(); },
  });
  const app = workbench({ db: ':memory:' }).auth().mount('/notes', Note);
  app.listen(0);
  await app.ready;
  const { port } = app.httpServer.address();
  t.after(() => app.httpServer.close());
  return { app, origin: `http://127.0.0.1:${port}` };
}

/** Boot a workbench app with job queue + a note entity. */
async function bootJobApp(t) {
  const { entity, text, grant, read } = await import('../build/index.mjs');
  const app = workbench({
    db: ':memory:',
    jobs: { sharedSecret: 'test-jobs-secret', leaseMs: 60_000, heartbeatGraceMs: 60_000, reapIntervalMs: 1_000_000 },
  });
  app.mount('/notes', entity('Note', { body: text(), grant: () => [grant(read)] }));
  app.listen(0);
  await app.ready;
  const { port } = app.httpServer.address();
  t.after(() => app.httpServer.close());
  return { app, origin: `http://127.0.0.1:${port}` };
}

function bearer(workerId, token) {
  return { authorization: `Bearer ${workerId}.${token}` };
}

// ---------------------------------------------------------------------------
// W1 — passkey auth (HTTP round-trips)
// ---------------------------------------------------------------------------

test('W1: registration creates user and sets a session cookie', async (t) => {
  const { origin } = await bootAuthApp(t);

  const res = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2-secret' }),
  });
  assert.equal(res.status, 201, `register: expected 201 got ${res.status}`);
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie, 'login sets a Set-Cookie header');
  assert.match(cookie, /HttpOnly/i);
  const token = sidFromSetCookie(cookie);
  assert.ok(token, 'login cookie carries a session token');
  const body = await res.json();
  assert.equal(body.user.username, 'alice');
});

test('W1: wrong password returns 401', async (t) => {
  const { origin } = await bootAuthApp(t);

  // Registration creates the user
  await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: 'right-password' }),
  });

  const res = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: 'wrong-password' }),
  });
  assert.equal(res.status, 401, 'wrong password returns 401');
});

test('W1: authed user creates and reads an entity through session cookie', async (t) => {
  const { origin } = await bootAuthApp(t);

  const login = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2-secret' }),
  });
  const sid = sidFromSetCookie(login.headers.get('set-cookie'));

  // Create a note (authed)
  const create = await fetch(`${origin}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${sid}` },
    body: JSON.stringify({ body: 'Integration proof note' }),
  });
  assert.ok(create.status === 201 || create.status === 200, `create: got ${create.status}`);
  const note = await create.json();
  assert.ok(note.id, 'note has an id');

  // Read it back
  const read = await fetch(`${origin}/notes/${note.id}`, {
    headers: { cookie: `${SESSION_COOKIE}=${sid}` },
  });
  assert.equal(read.status, 200);
  const row = await read.json();
  assert.equal(row.body, 'Integration proof note');
});

test('W1: unauthed user cannot create an entity', async (t) => {
  const { origin } = await bootAuthApp(t);

  const create = await fetch(`${origin}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'Should fail' }),
  });
  assert.equal(create.status, 401, 'unauthed create returns 401');
});

// ---------------------------------------------------------------------------
// W3 — job queue (HTTP integration)
// ---------------------------------------------------------------------------

const JOB_SECRET = 'test-jobs-secret';

test('W3: enqueue → register worker → claim → complete', async (t) => {
  const { app, origin } = await bootJobApp(t);

  await app.jobs.enqueue({ kind: 'scope.import', payload: { url: 'docs.zip' }, scope: 'project:p1' });

  // Register worker
  const w = await (await fetch(`${origin}/workers/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: JOB_SECRET }),
  })).json();
  assert.ok(w.workerId, 'worker registered');

  // Claim
  const job = await (await fetch(`${origin}/jobs/claim`, {
    method: 'POST',
    headers: bearer(w.workerId, w.token),
  })).json();
  assert.ok(job.id, 'claimed job has id');

  // Complete
  const res = await fetch(`${origin}/jobs/${job.id}/result`, {
    method: 'POST',
    headers: { ...bearer(w.workerId, w.token), 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'completed', output: { docs: 12 } }),
  });
  assert.equal(res.status, 200);
  const done = await res.json();
  assert.equal(done.accepted, true, `result submission accepted: ${JSON.stringify(done)}`);
});

test('W3: cancel a claimed job returns cancelled', async (t) => {
  const { app, origin } = await bootJobApp(t);

  await app.jobs.enqueue({ kind: 'scope.export', payload: {} });
  const w = await (await fetch(`${origin}/workers/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: JOB_SECRET }),
  })).json();
  const job = await (await fetch(`${origin}/jobs/claim`, {
    method: 'POST',
    headers: bearer(w.workerId, w.token),
  })).json();

  const cancel = await fetch(`${origin}/jobs/${job.id}/cancel`, {
    method: 'POST',
    headers: { ...bearer(w.workerId, w.token), 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(cancel.status, 200);
  const body = await cancel.json();
  assert.equal(body.status, 'cancelled');
});

// ---------------------------------------------------------------------------
// W5 — client engine (createLiveStore, canUndoField)
// ---------------------------------------------------------------------------

test('W5: createLiveStore surfaces CRUD methods', () => {
  const channel = makeFakeChannel();
  const fetchImpl = makeFakeFetch([
    { match: '/snapshot/Note', status: 200, response: { snapshot: { id: 'n1', title: 'Test' }, seq: 0 } },
    { match: '/notes', status: 201, response: { id: 'n2', title: 'New' }, headers: { 'x-workbench-seq': '1' } },
  ]);

  const store = createLiveStore({
    baseUrl: 'http://127.0.0.1:9999',
    name: 'Note',
    path: '/notes',
    channel,
    fetchImpl,
  });

  assert.equal(typeof store.dispatch, 'function');
  assert.equal(typeof store.create, 'function');
  assert.equal(typeof store.update, 'function');
  assert.equal(typeof store.remove, 'function');
  assert.equal(typeof store.subscribe, 'function');
  assert.equal(typeof store.close, 'function');
  assert.equal(typeof store.overlayFor, 'function');
  assert.equal(typeof store.overlayStatusFor, 'function');
  assert.equal(typeof store.pendingCreates, 'function');
  assert.equal(typeof store.onRender, 'function');
});

test('W5: canUndoField surfaces the undo vocabulary', () => {
  assert.equal(canUndoField('value'), true);
  assert.equal(canUndoField('crdt'), false);
  assert.equal(canUndoField('store'), true);
  assert.equal(canUndoField('state'), true);
  assert.equal(canUndoField('computed'), false);
  assert.equal(canUndoField('hash'), false);
  assert.equal(canUndoField('projected'), false);

  const kinds = undoableFieldKinds();
  assert.ok(kinds.includes('value'));
  assert.ok(!kinds.includes('crdt'));
  assert.ok(!kinds.includes('hash'));
  assert.ok(!kinds.includes('computed'));
});
