// Priority 5 — job-queue HTTP wiring (spec #5). The substrate properties (claim
// race, lease, reaper, idempotent result) are covered directly in
// test/job-queue.test.mjs; this file proves the framework-owned routes are wired,
// bearer-auth'd, and map outcomes to HTTP statuses. Routes are framework defaults
// (intercepted before matchRoute, like /blobs), only present when the app engaged
// the job-queue substrate.

import { text, grant, read } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import workbench, { entity } from '../build/internal.mjs';

const SECRET = 's3cret-shared';

function makeApp() {
  const db = new DatabaseSync(':memory:');
  const app = workbench({
    db,
    jobs: { sharedSecret: SECRET, leaseMs: 60_000, heartbeatGraceMs: 60_000, reapIntervalMs: 1_000_000 },
  });
  app.mount('/notes', entity('Note', { body: text(), grant: () => [grant(read)] }));
  return { db, app };
}

async function ready(app) {
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  return `http://127.0.0.1:${app.httpServer.address().port}`;
}

function bearer(workerId, token) {
  return { authorization: `Bearer ${workerId}.${token}` };
}

test('jobs routes absent when substrate not engaged (falls through to 404)', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }); // no `jobs` config
  app.mount('/notes', entity('Note', { body: text(), grant: () => [grant(read)] }));
  const base = await ready(app);
  t.after(() => { app.httpServer.close(); db.close(); });
  const res = await fetch(`${base}/jobs/claim`, { method: 'POST' });
  assert.equal(res.status, 404, 'no job routes mounted → 404, not 401');
});

test('register: wrong secret → 401; correct → 200 {workerId, token}', async (t) => {
  const { db, app } = makeApp();
  const base = await ready(app);
  t.after(() => { app.httpServer.close(); db.close(); });
  const bad = await fetch(`${base}/workers/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: 'wrong' }),
  });
  assert.equal(bad.status, 401);
  const ok = await fetch(`${base}/workers/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET }),
  });
  assert.equal(ok.status, 200);
  const w = await ok.json();
  assert.ok(w.workerId && w.token);
});

test('claim: no bearer → 401; valid bearer, no jobs → 204; with a job → 200 {job}', async (t) => {
  const { db, app } = makeApp();
  const base = await ready(app);
  t.after(() => { app.httpServer.close(); db.close(); });
  // enqueue via the substrate (a post-commit consumer would call this)
  await app.jobs.enqueue({ kind: 'transcribe', payload: { url: 'a' } });
  const w = await (await fetch(`${base}/workers/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET }),
  })).json();
  const noauth = await fetch(`${base}/jobs/claim`, { method: 'POST' });
  assert.equal(noauth.status, 401, 'no bearer → 401');
  const claimed = await fetch(`${base}/jobs/claim`, { method: 'POST', headers: bearer(w.workerId, w.token) });
  assert.equal(claimed.status, 200, 'valid bearer claims the job');
  const job = await claimed.json();
  assert.equal(job.status, 'claimed');
  // queue is now empty
  const empty = await fetch(`${base}/jobs/claim`, { method: 'POST', headers: bearer(w.workerId, w.token) });
  assert.equal(empty.status, 204, 'no queued work → 204');
});

test('heartbeat: non-owner → 403; owner → 200', async (t) => {
  const { db, app } = makeApp();
  const base = await ready(app);
  t.after(() => { app.httpServer.close(); db.close(); });
  await app.jobs.enqueue({ kind: 'k', payload: {} });
  const w1 = await (await fetch(`${base}/workers/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET }),
  })).json();
  const w2 = await (await fetch(`${base}/workers/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET }),
  })).json();
  const job = await (await fetch(`${base}/jobs/claim`, { method: 'POST', headers: bearer(w1.workerId, w1.token) })).json();
  const stranger = await fetch(`${base}/jobs/${job.id}/heartbeat`, { method: 'POST', headers: bearer(w2.workerId, w2.token) });
  assert.equal(stranger.status, 403, 'non-owner heartbeat → 403');
  const owner = await fetch(`${base}/jobs/${job.id}/heartbeat`, { method: 'POST', headers: bearer(w1.workerId, w1.token) });
  assert.equal(owner.status, 200, 'owner heartbeat → 200');
});

test('result: idempotent — retried result for a completed job is a 200 no-op', async (t) => {
  const { db, app } = makeApp();
  const base = await ready(app);
  t.after(() => { app.httpServer.close(); db.close(); });
  await app.jobs.enqueue({ kind: 'k', payload: {} });
  const w = await (await fetch(`${base}/workers/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET }),
  })).json();
  const job = await (await fetch(`${base}/jobs/claim`, { method: 'POST', headers: bearer(w.workerId, w.token) })).json();
  const r1 = await fetch(`${base}/jobs/${job.id}/result`, {
    method: 'POST', headers: { ...bearer(w.workerId, w.token), 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'completed', output: { url: 'thumb.png' } }),
  });
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { accepted: true, noop: false });
  // retry with different output — idempotent no-op (first terminal wins)
  const r2 = await fetch(`${base}/jobs/${job.id}/result`, {
    method: 'POST', headers: { ...bearer(w.workerId, w.token), 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'completed', output: { url: 'evil.png' } }),
  });
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), { accepted: true, noop: true });
});

test('result: revoked bearer → 401 (reaper revoked the worker)', async (t) => {
  const { db, app } = makeApp();
  const base = await ready(app);
  t.after(() => { app.httpServer.close(); db.close(); });
  await app.jobs.enqueue({ kind: 'k', payload: {} });
  const w = await (await fetch(`${base}/workers/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET }),
  })).json();
  const job = await (await fetch(`${base}/jobs/claim`, { method: 'POST', headers: bearer(w.workerId, w.token) })).json();
  // revoke the worker directly (simulating the reaper)
  db.prepare('UPDATE _Worker SET revoked=1 WHERE id=?').run(w.workerId);
  const res = await fetch(`${base}/jobs/${job.id}/result`, {
    method: 'POST', headers: { ...bearer(w.workerId, w.token), 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'completed', output: {} }),
  });
  assert.equal(res.status, 401, 'revoked bearer → 401');
});

test('claim: filters by kind via query (?kind=...) and JSON body ({ kind, scope })', async (t) => {
  const { db, app } = makeApp();
  const base = await ready(app);
  t.after(() => { app.httpServer.close(); db.close(); });
  await app.jobs.enqueue({ kind: 'transcribe', payload: { n: 1 }, scope: 'project:p1' });
  await app.jobs.enqueue({ kind: 'thumbnail', payload: { n: 2 }, scope: 'project:p1' });
  await app.jobs.enqueue({ kind: 'transcribe', payload: { n: 3 }, scope: 'project:p2' });
  const w = await (await fetch(`${base}/workers/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET }),
  })).json();

  // Query param ?kind=thumbnail skips the earlier transcribe job
  const byQuery = await fetch(`${base}/jobs/claim?kind=thumbnail`, {
    method: 'POST', headers: bearer(w.workerId, w.token),
  });
  assert.equal(byQuery.status, 200);
  const thumb = await byQuery.json();
  assert.equal(thumb.kind, 'thumbnail');
  assert.equal(thumb.payload.n, 2);

  // JSON body { kind, scope } targets project:p2 transcribe specifically
  const byBody = await fetch(`${base}/jobs/claim`, {
    method: 'POST',
    headers: { ...bearer(w.workerId, w.token), 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'transcribe', scope: 'project:p2' }),
  });
  assert.equal(byBody.status, 200);
  const p2 = await byBody.json();
  assert.equal(p2.kind, 'transcribe');
  assert.equal(p2.scope, 'project:p2');
  assert.equal(p2.payload.n, 3);

  // No more thumbnail jobs → 204
  const emptyThumb = await fetch(`${base}/jobs/claim`, {
    method: 'POST',
    headers: { ...bearer(w.workerId, w.token), 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'thumbnail' }),
  });
  assert.equal(emptyThumb.status, 204);

  // Remaining project:p1 transcribe job is still queued and claimable
  const remaining = await fetch(`${base}/jobs/claim?kind=transcribe&scope=project:p1`, {
    method: 'POST', headers: bearer(w.workerId, w.token),
  });
  assert.equal(remaining.status, 200);
  const p1 = await remaining.json();
  assert.equal(p1.payload.n, 1);
});
