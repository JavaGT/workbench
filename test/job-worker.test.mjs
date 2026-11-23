// Slice 2b — in-process job worker `work(kind, fn)` + substrate retry/dead-letter.
//
// A durable effect enqueues a _Job post-commit; a worker claims+runs it. The
// HTTP /jobs routes serve an EXTERNAL worker process. `work(kind, fn)` is the
// INTERNAL shortcut: one process enqueues AND runs jobs of a kind without
// standing up a separate worker + bearer auth. The internal worker is a
// privileged in-process path (synthetic workerId, no _Worker row) — the same
// trust boundary as `enqueue`.
//
// Retry + dead-letter live on the SUBSTRATE (one policy, not per-worker): a
// failed job is re-queued with backoff until maxAttempts, then terminal
// 'failed'. A lease-expired job (reaper) is re-queued immediately available
// (a crash is not a failure).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { createJobQueue } from '../build/job-queue.mjs';
import { machinePrincipal } from '../build/schedule.mjs';

const SECRET = 'worker-test-secret';

// S5/A5: every in-process worker runs under an attributable machine principal
// with an explicit allowlist; the handler declares the operations it performs
// via its context (work options), and dispatch validates one against the other.
const WORKER = machinePrincipal({ id: 'worker:test', operations: ['execute', 'update'] });
const HANDLER_OPS = ['execute'];

function freshQueue({ leaseMs = 100_000, now, maxAttempts = 3, backoffMs = 1000, ...rest } = {}) {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const queue = createJobQueue({ db, sharedSecret: SECRET, leaseMs, now, maxAttempts, backoffMs, ...rest });
  return { db, queue };
}

test('work once() runs a job of its kind and marks it completed; fn sees the payload', async () => {
  const { db, queue } = freshQueue();
  queue.enqueue({ kind: 'send-title', payload: { title: 'Hi', n: 1 } });
  // an unrelated kind must be left alone
  queue.enqueue({ kind: 'other', payload: {} });
  const seen = [];
  const w = queue.work('send-title', async (job) => {
    seen.push(job.payload);
    return { sent: true };
  }, { principal: WORKER, operations: HANDLER_OPS, pollIntervalMs: Infinity });
  const res = await w.once();
  assert.equal(res.job.kind, 'send-title');
  assert.deepEqual(seen, [{ title: 'Hi', n: 1 }]);
  const row = db.prepare('SELECT status, payload, output FROM _Job WHERE kind=?').get('send-title');
  assert.equal(row.status, 'completed');
  assert.deepEqual(JSON.parse(row.payload), { title: 'Hi', n: 1 });
  assert.deepEqual(JSON.parse(row.output), { sent: true });
  assert.equal(db.prepare('SELECT status FROM _Job WHERE kind=?').get('other').status, 'queued');
  w.stop();
  db.close();
});

test('work only claims jobs matching its kind (other kinds stay queued)', async () => {
  const { db, queue } = freshQueue();
  queue.enqueue({ kind: 'a', payload: { x: 1 } });
  queue.enqueue({ kind: 'b', payload: { x: 2 } });
  const ran = [];
  const w = queue.work('a', async (job) => { ran.push(job.kind); return {}; }, { principal: WORKER, operations: HANDLER_OPS, pollIntervalMs: Infinity });
  await w.once();
  assert.deepEqual(ran, ['a']);
  assert.equal(db.prepare('SELECT status FROM _Job WHERE kind=?').get('b').status, 'queued');
  w.stop();
  db.close();
});

test('a failed job is retried until maxAttempts, then dead-lettered (terminal failed)', async () => {
  let t = 1000;
  const { db, queue } = freshQueue({ now: () => t, maxAttempts: 3, backoffMs: 10 });
  queue.enqueue({ kind: 'flaky', payload: {} });
  const w = queue.work('flaky', async () => { throw new Error('boom'); }, { principal: WORKER, operations: HANDLER_OPS, pollIntervalMs: Infinity });
  // attempt 1 → fail → re-queued (availableAt = 1010)
  const r1 = await w.once();
  assert.equal(r1.result.retried, true);
  assert.equal(r1.result.attempts, 1);
  // backoff not elapsed → nothing claimable
  t = 1009;
  assert.equal(await w.once(), null);
  // attempt 2
  t = 1010;
  const r2 = await w.once();
  assert.equal(r2.result.retried, true);
  assert.equal(r2.result.attempts, 2);
  // attempt 3 → dead-letter (maxAttempts=3)
  t = 1020;
  const r3 = await w.once();
  assert.equal(r3.result.deadLettered, true);
  assert.equal(r3.result.attempts, 3);
  const row = db.prepare('SELECT status, attempts FROM _Job WHERE kind=?').get('flaky');
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 3);
  w.stop();
  db.close();
});

test('a retried job is not claimable until availableAt (backoff gate)', async () => {
  let t = 5000;
  const { db, queue } = freshQueue({ now: () => t, maxAttempts: 3, backoffMs: 2000 });
  queue.enqueue({ kind: 'once-fail', payload: { n: 1 } });
  let calls = 0;
  const w = queue.work('once-fail', async () => {
    calls += 1;
    if (calls === 1) throw new Error('first-fail');
    return { ok: true };
  }, { principal: WORKER, operations: HANDLER_OPS, pollIntervalMs: Infinity });
  // attempt 1 fails → availableAt = 7000
  await w.once();
  // still within backoff → not claimable
  t = 6999;
  assert.equal(await w.once(), null);
  // backoff elapsed → claimable, succeeds
  t = 7000;
  const r2 = await w.once();
  assert.equal(r2.result.accepted, true);
  const row = db.prepare('SELECT status, attempts FROM _Job WHERE kind=?').get('once-fail');
  assert.equal(row.status, 'completed');
  assert.equal(row.attempts, 1);
  w.stop();
  db.close();
});

test('work stop() halts the poll loop (no job runs after stop)', async () => {
  const { db, queue } = freshQueue();
  queue.enqueue({ kind: 'late', payload: {} });
  const ran = [];
  const w = queue.work('late', async () => { ran.push(true); return {}; }, { principal: WORKER, operations: HANDLER_OPS, pollIntervalMs: 5 });
  w.stop();
  // give a poll loop ample time to NOT run
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran.length, 0, 'stop() prevented the poll loop from running the job');
  assert.equal(db.prepare('SELECT status FROM _Job WHERE kind=?').get('late').status, 'queued');
  db.close();
});

test('reaper re-queues an expired job with the retry backoff (a lease loss is an attempt)', () => {
  let t = 1000;
  const now = () => t;
  const { db, queue } = freshQueue({ leaseMs: 500, now, maxAttempts: 3, backoffMs: 1000 });
  queue.enqueue({ kind: 'k', payload: {} });
  const job = queue.claim('w-any'); // claim with a bare id (no _Worker row needed)
  t = 2000; // past the 1500 lease
  const { reassigned } = queue.reap({ now });
  assert.equal(reassigned, 1);
  const row = db.prepare('SELECT status, availableAt, attempts FROM _Job WHERE id=?').get(job.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 1, 'lease loss counted as an attempt');
  assert.equal(row.availableAt, 2000 + 1000, 'requeued behind the retry backoff — instant reclaim by the same stuck worker is the runaway-loop shape');
  assert.equal(queue.claim('w-any2'), null, 'not claimable inside the backoff window');
  t = 3500; // past the backoff
  const reclaimed = queue.claim('w-any2');
  assert.equal(reclaimed.id, job.id);
  db.close();
});

test('claim with {kind} filters by kind (substrate)', () => {
  const { db, queue } = freshQueue();
  queue.enqueue({ kind: 'a', payload: {} });
  queue.enqueue({ kind: 'b', payload: {} });
  const got = queue.claim('w-x', { kind: 'a' });
  assert.equal(got.kind, 'a');
  assert.equal(queue.claim('w-x', { kind: 'a' }), null, 'no more a-jobs');
  assert.equal(db.prepare('SELECT status FROM _Job WHERE kind=?').get('b').status, 'queued', 'b untouched');
  db.close();
});
