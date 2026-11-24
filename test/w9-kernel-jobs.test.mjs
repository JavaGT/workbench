// Wave 9 lane w9-kernel-jobs — regression coverage for the five verified
// kernel/job-queue P0/P1 defects:
//   1. generated `*.remove` must consult the injected authorization adapter on
//      /action, /batch, and REST CRUD (not just the framework row grant);
//   2. the registered-action projection bypass must be keyed on (declaring
//      actionType, eventType), never borrowed by generated CRUD on the same
//      event type;
//   3. an idle worker polling for work must never be revoked by the reaper;
//   4. a job event buffered inside a caller-owned transaction must not be
//      delivered before commit (and never after a rollback);
//   5. HTTP job bodies must reject non-object JSON with 400 (not a 500
//      TypeError), and claim() must enforce the job's durable machine
//      attribution when a worker principal is presented.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { executeFrameworkDDL } from '../build/ddl.mjs';
import { createJobQueue } from '../build/job-queue.mjs';
import { createAuthorizationAdapter } from '../build/authorization-adapter.mjs';
import { machinePrincipal } from '../build/machine-principal.mjs';
import { text, scope, everyone, grant, deny, read, write, subscribe, principal } from '../build/index.mjs';
import workbench, { entity } from '../build/internal.mjs';

const SECRET = 'w9-lane-shared-secret';

function freshQueue(opts = {}) {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const queue = createJobQueue({ db, sharedSecret: SECRET, ...opts });
  return { db, queue };
}

const alice = principal({ type: 'user', id: 'alice', attributes: {} });
const bob = principal({ type: 'user', id: 'bob', attributes: {} });

// ---------------------------------------------------------------------------
// 1. Generated remove consults the injected authorization adapter everywhere.
// ---------------------------------------------------------------------------

function denyRemoveAdapter(db) {
  const base = createAuthorizationAdapter({ db });
  const refusal = Object.freeze({
    admitted: false,
    operation: null,
    resourceCategory: 'entity',
    resourceId: null,
    reasonCode: 'no-capability',
    capabilities: [],
    trace: null,
  });
  return {
    registerResource: (input) => base.registerResource(input),
    admit: async (input) => {
      if (
        (input.category === 'entity' && input.verb === 'remove')
        || input.operation === 'remove'
        || input.operation === 'delete'
      ) return refusal;
      return base.admit(input);
    },
  };
}

async function bootDenyRemoveApp(t) {
  const db = new DatabaseSync(':memory:');
  const Doc = entity('Doc', {
    title: text(),
    grant: () => [grant(read, write, subscribe)],
  });
  const app = workbench({ db, entities: [Doc] });
  app.mount('/docs', Doc);
  app.listen(0, {
    authorization: denyRemoveAdapter(db),
    principalOf: () => alice,
  });
  await app.ready;
  t.after(async () => {
    app.httpServer.closeAllConnections?.();
    await app.shutdown();
    db.close();
  });
  db.prepare('INSERT INTO Doc (id, title) VALUES (?, ?)').run('d1', 'one');
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  return { db, app, origin };
}

test('W9-1a: an injected adapter that denies remove denies Doc.remove via single dispatch (/action)', async (t) => {
  const { db, app } = await bootDenyRemoveApp(t);
  const result = await app.dispatch({
    actionId: 'w9-action-remove',
    type: 'Doc.remove',
    scope: 'Doc:d1',
    payload: { id: 'd1' },
    principal: alice,
  });
  assert.equal(result.ok, false, 'the injected adapter must deny the generated remove');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Doc WHERE id = ?').get('d1').n, 1, 'the row survives');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM _Log WHERE eventType = 'Doc.removed'").get().n, 0, 'no removed event committed');
});

test('W9-1b: an injected adapter that denies remove denies Doc.remove via batch dispatch (/batch)', async (t) => {
  const { db, app } = await bootDenyRemoveApp(t);
  const result = await app.writeQueue.run(() => app.kernel.dispatchBatch({
    actionId: 'w9-batch-remove',
    scope: 'Doc:d1',
    actions: [{ type: 'Doc.remove', payload: { id: 'd1' } }],
    principal: alice,
  }));
  assert.equal(result.ok, false, 'the injected adapter must deny the generated remove in a batch');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Doc WHERE id = ?').get('d1').n, 1, 'the row survives');
});

test('W9-1c: an injected adapter that denies remove denies REST CRUD DELETE alike', async (t) => {
  const { db, origin } = await bootDenyRemoveApp(t);
  const res = await fetch(`${origin}/docs/d1`, { method: 'DELETE' });
  assert.ok(res.status >= 400 && res.status < 500, 'the delete is denied, never a 500');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Doc WHERE id = ?').get('d1').n, 1, 'the row survives');
});

// ---------------------------------------------------------------------------
// 2. The projection bypass belongs to the declaring action, not the event type.
// ---------------------------------------------------------------------------

async function bootBypassApp(t) {
  const db = new DatabaseSync(':memory:');
  // Nobody may commit a generated create: its after-projection row admission
  // denies every principal. A registered action that DECLARES a projection on
  // Doc.created is the only thing allowed to emit that event type.
  const Doc = entity('Doc', {
    title: text(),
    grant: () => [scope(() => everyone()).can(() => deny('no generated create'))],
  });
  const seed = {
    type: 'seed.doc',
    authorize: () => true,
    projections: [{ eventTypes: ['Doc.created'], apply() {} }],
    handler: ({ payload, scope: eventScope }) => [{
      type: 'Doc.created',
      scope: eventScope,
      data: { id: payload.id, title: payload.title },
    }],
  };
  const app = workbench({ db, entities: [Doc], actions: [seed] });
  await app.start();
  t.after(async () => {
    try { await app.shutdown(); } catch { /* best effort */ }
    db.close();
  });
  return { db, app };
}

test('W9-2a: a registered action projection on Doc.created does not excuse generated Doc.create', async (t) => {
  const { db, app } = await bootBypassApp(t);
  const result = await app.dispatch({
    actionId: 'w9-generated-create',
    type: 'Doc.create',
    scope: 'Doc:gen',
    payload: { id: 'gen', title: 'generated' },
    principal: alice,
  });
  assert.equal(result.ok, false, 'generated create must still pass its own row admission');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Doc WHERE id = ?').get('gen').n, 0, 'no row was projected');
});

test('W9-2b: the declaring registered action keeps its (actionType, eventType) bypass', async (t) => {
  const { db, app } = await bootBypassApp(t);
  const result = await app.dispatch({
    actionId: 'w9-seeded-create',
    type: 'seed.doc',
    scope: 'Doc:seed',
    payload: { id: 'seed', title: 'seeded' },
    principal: bob,
  });
  assert.equal(result.ok, true, 'the declaring action still emits its own projected fact');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Doc WHERE id = ?').get('seed').n, 1, 'the row was projected');
});

// ---------------------------------------------------------------------------
// 3. Idle workers are never revoked by the reaper.
// ---------------------------------------------------------------------------

test('W9-3a: a worker polling claim() without work keeps its liveness fresh', () => {
  let t = 10_000;
  const now = () => t;
  const { db, queue } = freshQueue({ now, heartbeatGraceMs: 3_000, leaseMs: 100_000 });
  const { workerId, token } = queue.registerWorker(SECRET); // lastHeartbeat = 10000
  // Repeated empty polls, each well past the grace window measured from
  // registration, are LIVENESS: the worker is alive, just idle.
  t = 15_000;
  assert.equal(queue.claim(workerId), null, 'idle poll: no work');
  assert.equal(db.prepare('SELECT lastHeartbeat FROM _Worker WHERE id = ?').get(workerId).lastHeartbeat, 15_000);
  t = 17_000;
  assert.equal(queue.reap({ now }).revoked, 0, 'an idle poller is never revoked');
  assert.equal(queue.authenticate(`${workerId}.${token}`), workerId, 'its bearer stays valid');
  db.close();
});

async function bootJobsApp(t, extra = {}) {
  const db = new DatabaseSync(':memory:');
  const app = workbench({
    db,
    jobs: {
      sharedSecret: SECRET,
      leaseMs: 100_000,
      heartbeatGraceMs: 3_000,
      reapIntervalMs: 1_000_000,
      ...extra,
    },
  });
  app.listen(0, { principalOf: () => alice });
  await app.ready;
  t.after(async () => {
    app.httpServer.closeAllConnections?.();
    await app.shutdown();
    db.close();
  });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const registered = await (await fetch(`${origin}/workers/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET }),
  })).json();
  return { db, app, origin, worker: registered };
}

test('W9-3b: HTTP /jobs/claim 204 polls and /workers/heartbeat keep an idle worker alive', async (t) => {
  let t0 = 10_000;
  const now = () => t0;
  const { db, app, origin, worker } = await bootJobsApp(t, { now });
  const auth = { authorization: `Bearer ${worker.workerId}.${worker.token}` };

  t0 = 15_000;
  const poll = await fetch(`${origin}/jobs/claim`, { method: 'POST', headers: auth });
  assert.equal(poll.status, 204, 'idle poll returns no work');
  assert.equal(db.prepare('SELECT lastHeartbeat FROM _Worker WHERE id = ?').get(worker.workerId).lastHeartbeat, 15_000);

  const hb = await fetch(`${origin}/workers/heartbeat`, { method: 'POST', headers: auth });
  assert.equal(hb.status, 200, 'explicit liveness ping is accepted');
  assert.deepEqual(await hb.json(), { ok: true });

  t0 = 17_000;
  assert.equal((await app.jobs.reap({ now })).revoked, 0, 'the idle HTTP worker is not revoked');
  assert.equal(app.jobs.authenticate(`${worker.workerId}.${worker.token}`), worker.workerId);
});

// ---------------------------------------------------------------------------
// 4. No phantom job events from a rolled-back caller transaction.
// ---------------------------------------------------------------------------

test('W9-4a: a job emitted in a caller-owned transaction notifies only after commit', () => {
  const { db, queue } = freshQueue({ now: () => 1000 });
  const received = [];
  queue.onEvent((ev) => received.push(ev));

  db.exec('BEGIN IMMEDIATE');
  queue.enqueue({ id: 'j-commit', kind: 'k', payload: {}, scope: 'project:w9commit' });
  assert.equal(received.length, 0, 'no listener call before the outer commit');
  db.exec('COMMIT');

  // An explicit flush (or the next queue entry point) releases it post-commit.
  assert.equal(queue.flushEvents(), 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].scope, 'project:w9commit');
  assert.equal(received[0].data.transition, 'enqueued');
  assert.equal(queue.flushEvents(), 0, 'a second flush is a no-op');
  db.close();
});

test('W9-4b: a rolled-back caller transaction delivers no listener event at all', () => {
  const { db, queue } = freshQueue({ now: () => 1000 });
  const received = [];
  queue.onEvent((ev) => received.push(ev));

  db.exec('BEGIN IMMEDIATE');
  queue.enqueue({ id: 'j-rollback', kind: 'k', payload: {}, scope: 'project:w9rollback' });
  assert.equal(received.length, 0, 'no listener call before rollback');
  db.exec('ROLLBACK');

  assert.equal(queue.flushEvents(), 0, 'the rolled-back event is never delivered');
  assert.equal(received.length, 0, 'no phantom job event after rollback');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _Log WHERE scope = ?').get('project:w9rollback').n, 0);
  db.close();
});

test('W9-4c: a subsequent entry point flushes a committed caller-txn event automatically', () => {
  const { db, queue } = freshQueue({ now: () => 1000 });
  const received = [];
  queue.onEvent((ev) => received.push(ev));

  db.exec('BEGIN IMMEDIATE');
  queue.enqueue({ kind: 'k', payload: {}, scope: 'project:w9auto' });
  db.exec('COMMIT');
  assert.equal(received.length, 0);

  queue.enqueue({ kind: 'noop', payload: {} }); // next mutation turn flushes the committed event
  assert.equal(received.length, 1, 'the committed event is delivered on the next turn');
  db.close();
});

test('W9-4d: a queue-opened transaction still notifies exactly once after its own commit', () => {
  const { db, queue } = freshQueue({ now: () => 1000 });
  const received = [];
  queue.onEvent((ev) => received.push(ev));
  // No caller-owned transaction: runInTxn opens + commits its own, so the
  // existing post-commit delivery path must remain unchanged.
  queue.enqueue({ kind: 'k', payload: {}, scope: 'project:w9own' });
  assert.equal(received.length, 1);
  assert.equal(received[0].data.transition, 'enqueued');
  db.close();
});

// ---------------------------------------------------------------------------
// 5. HTTP JSON bodies + worker claim attribution.
// ---------------------------------------------------------------------------

async function postJson(origin, path, body, headers = {}) {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('W9-5a: non-object JSON bodies are refused with 400 on every job route', async (t) => {
  const { origin, worker, app } = await bootJobsApp(t);
  const auth = { authorization: `Bearer ${worker.workerId}.${worker.token}` };
  await app.jobs.enqueue({ kind: 'k', payload: {} });
  const claimed = await app.jobs.claim(worker.workerId);

  for (const [path, headers] of [
    ['/workers/register', {}],
    ['/jobs/claim', auth],
    [`/jobs/${claimed.id}/progress`, auth],
    [`/jobs/${claimed.id}/result`, auth],
    [`/jobs/${claimed.id}/cancel`, auth],
  ]) {
    const primitive = await postJson(origin, path, 123, headers);
    assert.equal(primitive.status, 400, `${path} refuses a JSON primitive (not a 500)`);
    const nil = await postJson(origin, path, null, headers);
    assert.ok(nil.status < 500, `${path} never turns JSON null into a 500 TypeError`);
  }
});

test('W9-5b: claim() refuses a job attributed to a different machine principal', () => {
  const { db, queue } = freshQueue();
  const workerId = queue.registerWorker(SECRET).workerId;
  const owner = machinePrincipal({ id: 'owner', operations: ['execute'] });
  const stranger = machinePrincipal({ id: 'stranger', operations: ['execute'] });
  queue.enqueue({ id: 'attributed', kind: 'k', payload: {}, principal: owner });
  queue.enqueue({ id: 'unattributed', kind: 'k', payload: {} });

  const first = queue.claim(workerId, { principal: stranger });
  assert.equal(first.id, 'unattributed', 'only the unattributed job is claimable by a stranger');
  assert.equal(queue.claim(workerId, { principal: stranger }), null, 'the attributed job is skipped');
  const attributed = queue.claim(workerId, { principal: owner });
  assert.equal(attributed.id, 'attributed', 'the declaring machine principal can claim its own job');
  assert.throws(
    () => queue.claim(workerId, { principal: { type: 'system', id: 'forged' } }),
    /machine principal/,
    'a hand-rolled principal is rejected (unforgeable brand)',
  );
  db.close();
});

test('W9-5c: /jobs/claim presents the worker principal, so HTTP workers cannot claim foreign attributed jobs', async (t) => {
  const { db, app, origin, worker } = await bootJobsApp(t);
  const owner = machinePrincipal({ id: 'machine-owner', operations: ['execute'] });
  await app.jobs.enqueue({ id: 'foreign', kind: 'attributed', payload: {}, principal: owner });
  await app.jobs.enqueue({ id: 'mine', kind: 'plain', payload: {} });

  const auth = { authorization: `Bearer ${worker.workerId}.${worker.token}` };
  const denied = await fetch(`${origin}/jobs/claim?kind=attributed`, { method: 'POST', headers: auth });
  assert.equal(denied.status, 204, 'an attributed job is invisible to a worker with a different principal');
  const allowed = await fetch(`${origin}/jobs/claim?kind=plain`, { method: 'POST', headers: auth });
  assert.equal(allowed.status, 200, 'an unattributed job is still claimable');
  assert.equal((await allowed.json()).id, 'mine');
  assert.equal(db.prepare('SELECT status FROM _Job WHERE id = ?').get('foreign').status, 'queued');
});
