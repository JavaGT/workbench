// Priority 5 — job-queue substrate (eng-review spec #5, Walk 2, test plan 716-724).
// A job is a unit of work with its own lifecycle (queued/claimed/running/completed/
// failed/reassigned), NOT a derived read model — so the queue is a SEPARATE seam
// from the projection registry (deletion test: folding it in would only RELOCATE
// the claim/lease/heartbeat/reaper concept). The two compose at the enqueue edge:
// a post-commit consumer may call jobs.enqueue(); the queue's lifecycle is its own.
//
// Auth model (eng-review §5): worker registration uses a shared secret
// (constant-time compared); job operations use a per-worker bearer token
// (constant-time compared, revocable by the reaper). A bearer is per-worker,
// NEVER the shared secret. Fail-closed on unknown/revoked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { createJobQueue } from '../build/job-queue.mjs';

const SECRET = 's3cret-shared-deployment-key';

function freshQueue({ leaseMs = 1000, heartbeatGraceMs = 3000, now, ...rest } = {}) {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const queue = createJobQueue({ db, sharedSecret: SECRET, leaseMs, heartbeatGraceMs, now, ...rest });
  return { db, queue };
}

test('register: correct secret issues a worker + bearer; wrong secret rejected (fail-closed)', () => {
  const { db, queue } = freshQueue();
  const bad = queue.registerWorker('wrong-secret');
  assert.equal(bad, null, 'wrong secret → null, not a worker');
  const w = queue.registerWorker(SECRET);
  assert.ok(w && w.workerId, 'correct secret → workerId');
  assert.ok(w.token, 'correct secret → bearer token');
  // The shared secret is NEVER stored; only the token HASH is.
  const row = db.prepare('SELECT * FROM _Worker WHERE id=?').get(w.workerId);
  assert.ok(row.tokenHash && !row.tokenHash.includes(w.token), 'token stored hashed, not raw');
  db.close();
});

test('authenticate: valid bearer → workerId; tampered/unknown/revoked → null', () => {
  const { db, queue } = freshQueue();
  const { workerId, token } = queue.registerWorker(SECRET);
  assert.equal(queue.authenticate(`${workerId}.${token}`), workerId, 'valid bearer');
  assert.equal(queue.authenticate(`${workerId}.tampered`), null, 'tampered token → null');
  assert.equal(queue.authenticate('unknown.token'), null, 'unknown worker → null');
  assert.equal(queue.authenticate('not-even-a-bearer'), null, 'malformed → null');
  // Revocation: flip the row; the bearer is now rejected.
  db.prepare('UPDATE _Worker SET revoked=1 WHERE id=?').run(workerId);
  assert.equal(queue.authenticate(`${workerId}.${token}`), null, 'revoked bearer → null');
  db.close();
});

test('claim race: two workers, exactly one gets the job (atomic UPDATE…WHERE status=queued)', () => {
  const { db, queue } = freshQueue();
  const w1 = queue.registerWorker(SECRET);
  const w2 = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'transcribe', payload: { url: 'a' } });
  const a = queue.claim(w1.workerId);
  const b = queue.claim(w2.workerId);
  assert.ok(a, 'first claimant got the job');
  assert.equal(b, null, 'second claimant got nothing');
  assert.equal(a.workerId, w1.workerId, 'job owned by first claimant');
  assert.equal(a.status, 'claimed', 'status flipped to claimed');
  // claim with no queued jobs → null (no spurious claim).
  assert.equal(queue.claim(w2.workerId), null, 'no queued work → null');
  db.close();
});

test('heartbeat: extends lease + flips claimed→running; only for the owning worker', () => {
  const { queue, db } = freshQueue({ leaseMs: 1000, now: () => 10_000 });
  const w1 = queue.registerWorker(SECRET);
  const w2 = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: {} });
  const job = queue.claim(w1.workerId);
  // first heartbeat: claimed → running, lease extends
  const ok = queue.heartbeat(job.id, w1.workerId, { now: () => 11_000 });
  assert.equal(ok, true, 'owner heartbeat accepted');
  const running = db.prepare('SELECT status, leaseUntil FROM _Job WHERE id=?').get(job.id);
  assert.equal(running.status, 'running', 'first heartbeat flipped to running');
  assert.equal(running.leaseUntil, 11_000 + 1000, 'lease extended by leaseMs');
  // non-owner heartbeat rejected
  assert.equal(queue.heartbeat(job.id, w2.workerId), false, 'non-owner heartbeat rejected');
  db.close();
});

test('reaper: re-queues a job whose lease expired (claimable again after backoff, attempt counted)', () => {
  let t = 10_000;
  const now = () => t;
  const { db, queue } = freshQueue({ leaseMs: 1000, heartbeatGraceMs: 100_000, backoffMs: 5000, now });
  const w1 = queue.registerWorker(SECRET);
  const w2 = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: {} });     // enqueuedAt=10000
  const job = queue.claim(w1.workerId);          // leaseUntil = 10000 + 1000 = 11000
  t = 20_000;                                    // advance past the lease
  const { reassigned } = queue.reap({ now });
  assert.equal(reassigned, 1, 'one job reassigned');
  const row = db.prepare('SELECT status, workerId, attempts, availableAt FROM _Job WHERE id=?').get(job.id);
  assert.equal(row.status, 'queued', 'expired job back to queued');
  assert.equal(row.workerId, null, 'workerId cleared on reassign');
  assert.equal(row.attempts, 1, 'a lease loss counts as an attempt');
  assert.equal(row.availableAt, 20_000 + 5000, 'requeued with the retry backoff, not immediately');
  // not claimable inside the backoff window (instant reclaim by the same stuck
  // worker is the tight-loop shape) …
  assert.equal(queue.claim(w2.workerId), null, 'not claimable during backoff');
  // … but a DIFFERENT worker can claim it once the backoff elapses
  t = 26_000;
  const reclaimed = queue.claim(w2.workerId);
  assert.equal(reclaimed.id, job.id, 'reassigned job claimable by another worker after backoff');
  db.close();
});

test('reaper: repeated lease losses dead-letter at maxAttempts (the 529× runaway shape)', () => {
  let t = 10_000;
  const now = () => t;
  const { db, queue } = freshQueue({ leaseMs: 1000, heartbeatGraceMs: 100_000, backoffMs: 1000, maxAttempts: 2, now });
  const w = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: { url: 'a' } });
  queue.claim(w.workerId);
  t = 20_000; // lease expired
  const r1 = queue.reap({ now });
  assert.equal(r1.reassigned, 1, 'first loss requeues');
  assert.equal(r1.deadLettered, 0);
  t = 30_000; // past backoff
  const job = queue.claim(w.workerId); // same worker re-claims (heartbeats still broken)
  t = 40_000; // lease expired again — attempts would reach maxAttempts
  const r2 = queue.reap({ now });
  assert.equal(r2.reassigned, 0, 'second loss does not requeue');
  assert.equal(r2.deadLettered, 1, 'second loss dead-letters');
  const row = db.prepare('SELECT status, attempts, workerId, payload FROM _Job WHERE id=?').get(job.id);
  assert.equal(row.status, 'failed', 'terminal failed');
  assert.equal(row.attempts, 2, 'both losses counted');
  assert.equal(row.workerId, w.workerId, 'last owner kept for forensics');
  const payload = JSON.parse(row.payload);
  assert.equal(payload.deadLetterReason, 'lease-expired', 'reason recorded in payload');
  assert.equal(payload.url, 'a', 'original payload fields preserved');
  // a further reap sweep is a no-op — the loop is dead
  t = 50_000;
  const r3 = queue.reap({ now });
  assert.equal(r3.reassigned + r3.deadLettered, 0, 'terminal job never reaped again');
  db.close();
});

test('reaper: revokes a worker whose heartbeat is stale (bearer rejected after)', () => {
  let t = 10_000;
  const now = () => t;
  const { db, queue } = freshQueue({ heartbeatGraceMs: 3000, now });
  const { workerId, token } = queue.registerWorker(SECRET); // lastHeartbeat=10000
  t = 20_000;                                               // 7000 past grace (grace=3000)
  const { revoked } = queue.reap({ now });
  assert.equal(revoked, 1, 'one worker revoked');
  const row = db.prepare('SELECT revoked FROM _Worker WHERE id=?').get(workerId);
  assert.equal(row.revoked, 1, 'worker row flagged revoked');
  assert.equal(queue.authenticate(`${workerId}.${token}`), null, 'stale worker bearer now rejected');
  db.close();
});

test('result: idempotent by job id — a retried result for a completed job is a no-op (no double-apply)', () => {
  const { db, queue } = freshQueue();
  const w = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: { input: 'orig' } });
  const job = queue.claim(w.workerId);
  const r1 = queue.submitResult(job.id, w.workerId, { status: 'completed', output: { url: 'thumb.png' } });
  assert.deepEqual(r1, { accepted: true, noop: false }, 'first result accepted + applied');
  // retry with DIFFERENT output — must NOT overwrite (idempotent: first terminal wins)
  const r2 = queue.submitResult(job.id, w.workerId, { status: 'completed', output: { url: 'evil.png' } });
  assert.deepEqual(r2, { accepted: true, noop: true }, 'retried result is a no-op ack');
  const row = db.prepare('SELECT status, payload, output FROM _Job WHERE id=?').get(job.id);
  assert.equal(row.status, 'completed', 'still completed');
  assert.deepEqual(JSON.parse(row.payload), { input: 'orig' }, 'input payload preserved immutably');
  assert.equal(JSON.parse(row.output).url, 'thumb.png', 'output NOT overwritten by the retry');
  db.close();
});

test('result: failed is retried while under maxAttempts; non-owner result rejected', () => {
  let t = 1000;
  const now = () => t;
  const { db, queue } = freshQueue({ maxAttempts: 5, backoffMs: 1000, now });
  const w1 = queue.registerWorker(SECRET);
  const w2 = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: {} });
  const job = queue.claim(w1.workerId);
  assert.equal(queue.submitResult(job.id, w2.workerId, { status: 'completed', output: {} }).accepted, false, 'non-owner rejected');
  const r = queue.submitResult(job.id, w1.workerId, { status: 'failed', output: { error: 'boom' } });
  assert.deepEqual(r, { accepted: true, retried: true, attempts: 1 }, 'owner failed result retried (not terminal under maxAttempts)');
  const row = db.prepare('SELECT status, attempts, availableAt FROM _Job WHERE id=?').get(job.id);
  assert.equal(row.status, 'queued', 're-queued for retry');
  assert.equal(row.attempts, 1);
  assert.ok(row.availableAt != null, 'backoff scheduled');
  // a failed result at maxAttempts becomes a terminal dead-letter
  let attempts = 1;
  let guard = 0;
  while (attempts < 5 && guard < 20) {
    guard++;
    t += 1000; // advance past backoff
    const c = queue.claim(w1.workerId);
    if (!c) break;
    const rr = queue.submitResult(job.id, w1.workerId, { status: 'failed', output: { error: 'boom' } });
    attempts = rr.attempts;
  }
  const final = db.prepare('SELECT status, attempts FROM _Job WHERE id=?').get(job.id);
  assert.equal(final.status, 'failed', 'dead-lettered at maxAttempts (terminal)');
  assert.equal(final.attempts, 5);
  db.close();
});

test('enqueue: mints an id when absent; preserves a caller-supplied id', () => {
  const { db, queue } = freshQueue();
  const a = queue.enqueue({ kind: 'k', payload: { n: 1 } });
  assert.ok(a.id, 'mints an id');
  assert.equal(a.status, 'queued', 'starts queued');
  const b = queue.enqueue({ kind: 'k', payload: { n: 2 }, id: 'caller-fixed-id' });
  assert.equal(b.id, 'caller-fixed-id', 'preserves caller id');
  db.close();
});

test('jobs are claimed in enqueue order (oldest first, FIFO)', () => {
  let t = 1000;
  const { queue, db } = freshQueue({ now: () => (t += 1000) });
  const w = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: { n: 1 } }); // enqueuedAt 2000
  queue.enqueue({ kind: 'k', payload: { n: 2 } }); // enqueuedAt 3000
  queue.enqueue({ kind: 'k', payload: { n: 3 } }); // enqueuedAt 4000
  const a = queue.claim(w.workerId);
  const b = queue.claim(w.workerId);
  const c = queue.claim(w.workerId);
  assert.deepEqual([a.payload.n, b.payload.n, c.payload.n].map(String), ['1', '2', '3'], 'claimed oldest-first');
  db.close();
});

test('reaper does not revoke an actively-heartbeating worker (heartbeat bumps _Worker.lastHeartbeat)', () => {
  // Regression: heartbeat() used to update only _Job (status/leaseUntil), never
  // _Worker.lastHeartbeat — which the reaper uses to revoke workers. So an
  // active worker was revoked heartbeatGraceMs after REGISTRATION regardless of
  // heartbeats → bearer rejected → its in-flight job reassigned to another
  // worker (duplicate execution).
  let t = 10_000;
  const now = () => t;
  const { db, queue } = freshQueue({ leaseMs: 100_000, heartbeatGraceMs: 3000, now });
  const { workerId, token } = queue.registerWorker(SECRET); // lastHeartbeat = 10000
  queue.enqueue({ kind: 'k', payload: {} });
  const job = queue.claim(workerId);
  // Worker stays alive by heartbeating its job.
  t = 17_000;
  assert.equal(queue.heartbeat(job.id, workerId, { now }), true, 'heartbeat accepted');
  // reg-time (10000) is 9000ms in the past (> grace); the heartbeat (17000) is
  // only 2000ms ago (< grace 3000). An active worker must NOT be revoked at t=19000.
  t = 19_000;
  const { revoked } = queue.reap({ now });
  assert.equal(revoked, 0, 'an actively-heartbeating worker must not be revoked');
  assert.equal(queue.authenticate(`${workerId}.${token}`), workerId, 'bearer still valid after reap');
  const row = db.prepare('SELECT lastHeartbeat FROM _Worker WHERE id=?').get(workerId);
  assert.equal(row.lastHeartbeat, 17_000, 'heartbeat must bump the worker lastHeartbeat');
  db.close();
});

test('result: a non-owner cannot ack an already-terminal job (owner-only idempotent no-op)', () => {
  // Regression: the terminal short-circuit returned {accepted:true,noop:true}
  // WITHOUT verifying the submitter owns the job — so a non-owner probing
  // someone else's terminal job got an accepting ack (info-leak + wrong ack).
  const { queue, db } = freshQueue();
  const w1 = queue.registerWorker(SECRET);
  const w2 = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: {} });
  const job = queue.claim(w1.workerId);
  // owner completes
  assert.deepEqual(
    queue.submitResult(job.id, w1.workerId, { status: 'completed', output: { ok: true } }),
    { accepted: true, noop: false },
  );
  // owner retry → idempotent no-op ack (first terminal wins, output not overwritten)
  assert.deepEqual(
    queue.submitResult(job.id, w1.workerId, { status: 'completed', output: { evil: true } }),
    { accepted: true, noop: true },
    'owner retry is an idempotent no-op',
  );
  const row = db.prepare('SELECT payload, output FROM _Job WHERE id=?').get(job.id);
  assert.deepEqual(JSON.parse(row.payload), {}, 'original input payload preserved immutably');
  assert.equal(JSON.parse(row.output).ok, true, 'terminal output NOT overwritten by owner retry');
  // non-owner probing the terminal job → REJECTED, never a noop ack
  assert.deepEqual(
    queue.submitResult(job.id, w2.workerId, { status: 'failed', output: { x: 1 } }),
    { accepted: false },
    'non-owner must not get an accepting ack for someone else\'s terminal job',
  );
  db.close();
});
