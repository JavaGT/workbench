// job-queue-hardening.test.mjs — hardening tests for GitHub issue #286.
//
// Runs identically under BOTH Node (`node --test`) and Bun (`bun test`) via
// `openSqliteDatabase` from `sqlite-driver.mjs`, covering all 6 hardening items:
//   1. `maxActiveByKind` validation + atomic enforcement (skipping saturated
//      kinds while allowing uncapped/other kinds to claim).
//   2. External HTTP `POST /jobs/claim` `kind` & `scope` filtering (query + body).
//   3. Transactional `_Job` + `_Log` + `_Cursor` mutations (atomic rollback on
//      failure, post-commit listener delivery, and nested `db.isTransaction`
//      participation).
//   4. Dedicated `_Job.output` column + `workbench@8` (`job-output-column`)
//      migration, keeping `_Job.payload` immutable on completion and exposing
//      `job.output` on parsed rows.
//   5. Deterministic FIFO tie-breaking (`ORDER BY enqueuedAt ASC, rowid ASC`).
//   6. Automatic periodic heartbeat inside `work()` keeping leases alive during
//      long-running handlers and clearing timers on resolve/reject.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteDatabase } from '../build/sqlite-driver.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { createJobQueue } from '../build/job-queue.mjs';
import { runWorkbenchMigrations, appliedWorkbenchVersion } from '../build/workbench-migrations.mjs';
import { machinePrincipal } from '../build/schedule.mjs';
import { text, grant, read } from '../build/index.mjs';
import workbench, { entity } from '../build/internal.mjs';

const SECRET = 'hardening-secret-286';
const WORKER_PRINCIPAL = machinePrincipal({ id: 'worker:hardening', operations: ['execute', 'update'] });

function freshQueue(opts = {}) {
  const db = openSqliteDatabase(':memory:');
  executeFrameworkDDL(db);
  const queue = createJobQueue({ db, sharedSecret: SECRET, ...opts });
  return { db, queue };
}

// ── 1. maxActiveByKind validation & atomic concurrency cap ──────────────────

test('maxActiveByKind: rejects invalid cap configurations fail-closed', () => {
  const db = openSqliteDatabase(':memory:');
  try {
    executeFrameworkDDL(db);
    for (const bad of [
      { ser: 0 },
      { ser: -1 },
      { ser: 1.5 },
      { ser: Number.NaN },
      { ser: Infinity },
      { '': 1 },
      ['ser'],
      'ser',
    ]) {
      assert.throws(
        () => createJobQueue({ db, sharedSecret: SECRET, maxActiveByKind: bad }),
        /maxActiveByKind/,
        `invalid maxActiveByKind rejected: ${JSON.stringify(bad)}`,
      );
    }
  } finally {
    db.close();
  }
});

test('maxActiveByKind: caps active jobs per kind while still claiming other kinds', () => {
  let t = 1000;
  const now = () => t;
  const { db, queue } = freshQueue({ maxActiveByKind: { transcribe: 1, index: 2 }, now });
  try {
    const w1 = queue.registerWorker(SECRET).workerId;
    const w2 = queue.registerWorker(SECRET).workerId;
    const w3 = queue.registerWorker(SECRET).workerId;

    const t1 = queue.enqueue({ kind: 'transcribe', payload: { n: 1 } });
    t += 10;
    const t2 = queue.enqueue({ kind: 'transcribe', payload: { n: 2 } });
    t += 10;
    const other = queue.enqueue({ kind: 'thumbnail', payload: { n: 3 } });
    t += 10;
    const i1 = queue.enqueue({ kind: 'index', payload: { n: 4 } });
    t += 10;
    const i2 = queue.enqueue({ kind: 'index', payload: { n: 5 } });
    t += 10;
    const i3 = queue.enqueue({ kind: 'index', payload: { n: 6 } });

    // First claim gets oldest transcribe
    const c1 = queue.claim(w1);
    assert.equal(c1.id, t1.id);

    // Transcribe is saturated (1/1); unfiltered claim skips t2 and claims uncapped thumbnail!
    const c2 = queue.claim(w2);
    assert.equal(c2.id, other.id, 'unfiltered claim skips saturated kind and claims uncapped kind');

    // Targeted claim for saturated kind returns null
    assert.equal(queue.claim(w3, { kind: 'transcribe' }), null);

    // Index has cap 2: two claims succeed, third blocks
    assert.equal(queue.claim(w1, { kind: 'index' }).id, i1.id);
    assert.equal(queue.claim(w2, { kind: 'index' }).id, i2.id);
    assert.equal(queue.claim(w3, { kind: 'index' }), null, 'index capped at 2 active');
    assert.equal(queue.claim(w3), null, 'all remaining queued kinds are saturated');

    // Heartbeat keeps transcribe active (claimed -> running still counts toward cap)
    assert.equal(queue.heartbeat(t1.id, w1, { now }), true);
    assert.equal(queue.claim(w3, { kind: 'transcribe' }), null, 'running job still counts toward cap');

    // Completing t1 frees the slot for t2
    queue.submitResult(t1.id, w1, { status: 'completed', output: { ok: true } });
    const cNext = queue.claim(w3, { kind: 'transcribe' });
    assert.equal(cNext.id, t2.id);

    // Cancelling i1 frees one index slot for i3
    queue.cancelJob({ jobId: i1.id, workerId: w1 });
    assert.equal(queue.claim(w3, { kind: 'index' }).id, i3.id);
  } finally {
    db.close();
  }
});

test('maxActiveByKind: atomic across two SQLite handles and across scopes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-jobs-cap-'));
  const file = join(dir, `cap-${randomUUID()}.db`);
  const dbA = openSqliteDatabase(file);
  const dbB = openSqliteDatabase(file);
  try {
    executeFrameworkDDL(dbA);
    const qa = createJobQueue({ db: dbA, sharedSecret: SECRET, maxActiveByKind: { ser: 1 }, now: () => 1000 });
    const qb = createJobQueue({ db: dbB, sharedSecret: SECRET, maxActiveByKind: { ser: 1 }, now: () => 2000 });
    const wa = qa.registerWorker(SECRET).workerId;
    const wb = qb.registerWorker(SECRET).workerId;

    qa.enqueue({ kind: 'ser', scope: 'project:a' });
    qb.enqueue({ kind: 'ser', scope: 'project:b' });

    const first = qa.claim(wa);
    assert.ok(first && first.scope === 'project:a');
    assert.equal(qb.claim(wb), null, 'cap enforced across handles and scopes');

    qa.submitResult(first.id, wa, { status: 'completed', output: { done: true } });
    const second = qb.claim(wb);
    assert.ok(second && second.scope === 'project:b');
  } finally {
    dbA.close();
    dbB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. HTTP POST /jobs/claim kind & scope filtering ─────────────────────────

test('HTTP POST /jobs/claim: forwards kind and scope from query and JSON body', async () => {
  const db = openSqliteDatabase(':memory:');
  const app = workbench({
    db,
    jobs: { sharedSecret: SECRET, leaseMs: 60_000, heartbeatGraceMs: 60_000, reapIntervalMs: 1_000_000 },
  });
  app.mount('/notes', entity('Note', { body: text(), grant: () => [grant(read)] }));
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;
  try {
    await app.jobs.enqueue({ kind: 'alpha', payload: { n: 1 }, scope: 's:1' });
    await app.jobs.enqueue({ kind: 'beta', payload: { n: 2 }, scope: 's:1' });
    await app.jobs.enqueue({ kind: 'beta', payload: { n: 3 }, scope: 's:2' });

    const w = await (await fetch(`${base}/workers/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: SECRET }),
    })).json();
    const auth = { authorization: `Bearer ${w.workerId}.${w.token}` };

    // Query ?kind=beta + body { scope: 's:2' }
    const res1 = await fetch(`${base}/jobs/claim?kind=beta`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 's:2' }),
    });
    assert.equal(res1.status, 200);
    const j1 = await res1.json();
    assert.equal(j1.kind, 'beta');
    assert.equal(j1.scope, 's:2');
    assert.equal(j1.payload.n, 3);
    assert.equal(j1.output, null);

    // Non-string kind in body → 400
    const bad = await fetch(`${base}/jobs/claim`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 123 }),
    });
    assert.equal(bad.status, 400);

    // Body { kind: 'beta' } claims remaining beta job
    const res2 = await fetch(`${base}/jobs/claim`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'beta' }),
    });
    assert.equal(res2.status, 200);
    assert.equal((await res2.json()).payload.n, 2);

    // No more beta jobs → 204
    const res3 = await fetch(`${base}/jobs/claim?kind=beta`, { method: 'POST', headers: auth });
    assert.equal(res3.status, 204);
  } finally {
    await app.shutdown();
    db.close();
  }
});

// ── 3. Transactional _Job + _Log + _Cursor writes ───────────────────────────

test('transactional writes: failed _Log append rolls back _Job and _Cursor atomically and suppresses listeners', () => {
  const { db, queue } = freshQueue({ now: () => 1000 });
  try {
    const received = [];
    queue.onEvent((ev) => received.push(ev));

    // Abort any INSERT into _Log to simulate mid-mutation failure
    db.exec(`CREATE TRIGGER fail_log_insert BEFORE INSERT ON _Log BEGIN SELECT RAISE(ABORT, 'injected log failure'); END;`);

    assert.throws(
      () => queue.enqueue({ kind: 'k', payload: { x: 1 }, scope: 'project:tx' }),
      /injected log failure/,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _Job').get().n, 0, '_Job insert rolled back');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _Cursor').get().n, 0, '_Cursor update rolled back');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _Log').get().n, 0, '_Log stays empty');
    assert.equal(received.length, 0, 'listener not invoked when transaction rolls back');

    // Remove trigger; enqueue succeeds, then inject failure on claim/progress/submit/cancel
    db.exec('DROP TRIGGER fail_log_insert');
    const job = queue.enqueue({ kind: 'k', payload: { x: 1 }, scope: 'project:tx' });
    assert.equal(received.length, 1);
    const w = queue.registerWorker(SECRET).workerId;

    db.exec(`CREATE TRIGGER fail_log_insert BEFORE INSERT ON _Log BEGIN SELECT RAISE(ABORT, 'injected log failure'); END;`);
    assert.throws(() => queue.claim(w), /injected log failure/);
    assert.equal(db.prepare('SELECT status, workerId FROM _Job WHERE id = ?').get(job.id).status, 'queued', 'claim rolled back _Job');
    assert.equal(db.prepare("SELECT lastSeq FROM _Cursor WHERE scope = 'project:tx'").get().lastSeq, 1, 'claim rolled back _Cursor');
    assert.equal(received.length, 1, 'listener not called for rolled-back claim');
  } finally {
    db.close();
  }
});

test('transactional writes: participates cleanly inside a caller-owned transaction (db.isTransaction)', () => {
  const { db, queue } = freshQueue({ now: () => 1000 });
  try {
    const w = queue.registerWorker(SECRET).workerId;

    // Caller opens a transaction, enqueues + claims inside it, then rolls back
    db.exec('BEGIN IMMEDIATE');
    assert.equal(db.isTransaction, true);
    const j1 = queue.enqueue({ kind: 'k', payload: { n: 1 }, scope: 'project:nested' });
    const c1 = queue.claim(w);
    assert.equal(c1.id, j1.id);
    db.exec('ROLLBACK');
    assert.equal(db.isTransaction, false);

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _Job').get().n, 0, 'outer rollback reverted nested job writes');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _Log').get().n, 0, 'outer rollback reverted nested log writes');

    // Caller opens a transaction, mutates, and commits
    db.exec('BEGIN IMMEDIATE');
    const j2 = queue.enqueue({ kind: 'k', payload: { n: 2 }, scope: 'project:nested' });
    const c2 = queue.claim(w);
    queue.heartbeat(c2.id, w);
    queue.updateProgress({ jobId: c2.id, workerId: w, progress: 50, stage: 'half' });
    queue.submitResult(c2.id, w, { status: 'completed', output: { ok: true } });
    db.exec('COMMIT');
    assert.equal(db.isTransaction, false);

    const listed = queue.list({ scope: 'project:nested' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, j2.id);
    assert.equal(listed[0].status, 'completed');
    assert.deepEqual(listed[0].payload, { n: 2 });
    assert.deepEqual(listed[0].output, { ok: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM _Log WHERE scope = 'project:nested'").get().n, 5);
  } finally {
    db.close();
  }
});

// ── 4. Dedicated output column & workbench@8 migration ──────────────────────

test('dedicated output column: submitResult(COMPLETED) preserves payload immutably and exposes job.output', () => {
  const { db, queue } = freshQueue({ now: () => 1000 });
  try {
    const w = queue.registerWorker(SECRET).workerId;
    const input = { source: 'clip.mp4', channels: 2 };
    const enqueued = queue.enqueue({ kind: 'transcode', payload: input, scope: 'project:out' });
    assert.deepEqual(enqueued.payload, input);
    assert.equal(enqueued.output, null);

    const claimed = queue.claim(w);
    assert.deepEqual(claimed.payload, input);
    assert.equal(claimed.output, null);

    const resultPayload = { url: 'clip-720p.mp4', durationSec: 42 };
    const ack = queue.submitResult(claimed.id, w, { status: 'completed', output: resultPayload });
    assert.deepEqual(ack, { accepted: true, noop: false });

    const [listed] = queue.list({ scope: 'project:out' });
    assert.deepEqual(listed.payload, input, 'payload remains immutable after completion');
    assert.deepEqual(listed.output, resultPayload, 'output exposed on returned JobRow');

    const raw = db.prepare('SELECT payload, output FROM _Job WHERE id = ?').get(claimed.id);
    assert.deepEqual(JSON.parse(raw.payload), input);
    assert.deepEqual(JSON.parse(raw.output), resultPayload);
  } finally {
    db.close();
  }
});

test('workbench@8 (job-output-column): idempotently adds output column to legacy _Job table', () => {
  const db = openSqliteDatabase(':memory:');
  try {
    // Legacy _Job table from before v8 (has v7 columns, no output column)
    db.exec(`CREATE TABLE _Job (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      enqueuedAt INTEGER NOT NULL,
      workerId TEXT,
      claimedAt INTEGER,
      leaseUntil INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      availableAt INTEGER,
      progress INTEGER NOT NULL DEFAULT 0,
      stage TEXT,
      scope TEXT,
      principalKey TEXT,
      operations TEXT
    )`);
    db.prepare("INSERT INTO _Job (id, kind, payload, status, enqueuedAt) VALUES ('legacy-1', 'k', '{\"a\":1}', 'queued', 1000)").run();

    runWorkbenchMigrations(db);
    assert.equal(appliedWorkbenchVersion(db), 8);

    const cols = new Set(db.prepare('PRAGMA table_info(_Job)').all().map((c) => c.name));
    assert.equal(cols.has('output'), true, 'v8 added output column to legacy _Job');

    const row = db.prepare("SELECT payload, output FROM _Job WHERE id = 'legacy-1'").get();
    assert.deepEqual(JSON.parse(row.payload), { a: 1 }, 'existing legacy row preserved');
    assert.equal(row.output, null, 'legacy row output defaults to NULL');

    // Re-running is an idempotent no-op
    runWorkbenchMigrations(db);
    assert.equal(appliedWorkbenchVersion(db), 8);
  } finally {
    db.close();
  }
});

// ── 5. Deterministic FIFO tie-break on equal enqueuedAt ─────────────────────

test('claim FIFO tie-break: breaks equal enqueuedAt deterministically by rowid ASC', () => {
  const { db, queue } = freshQueue({ now: () => 5000 }); // identical enqueuedAt for every job
  try {
    const w = queue.registerWorker(SECRET).workerId;
    // Deliberately use reverse-lexicographical ids to prove ordering is rowid ASC, not id ASC
    const ids = ['id-z', 'id-m', 'id-a', 'id-9', 'id-0'];
    for (const id of ids) {
      queue.enqueue({ id, kind: 'tie', payload: { id } });
    }
    const claimedIds = [];
    let job;
    while ((job = queue.claim(w)) != null) {
      claimedIds.push(job.id);
    }
    assert.deepEqual(claimedIds, ids, 'equal enqueuedAt claimed strictly in insertion (rowid) order');
  } finally {
    db.close();
  }
});

// ── 6. Automatic periodic heartbeat inside work() ───────────────────────────

test('work() auto-heartbeat: keeps lease alive during long-running handler and clears timer on completion', async () => {
  const { db, queue } = freshQueue({ leaseMs: 120, heartbeatGraceMs: 10_000, maxAttempts: 2, backoffMs: 10 });
  const worker = queue.work('long-running', async (job) => {
    // Run ~2.5x leaseMs — without auto-heartbeat, reaper would expire the lease
    await new Promise((r) => setTimeout(r, 150));
    const midReap = queue.reap();
    assert.equal(midReap.reassigned, 0, 'lease stayed fresh mid-execution via auto-heartbeat');
    assert.equal(midReap.deadLettered, 0);
    await new Promise((r) => setTimeout(r, 150));
    const lateReap = queue.reap();
    assert.equal(lateReap.reassigned, 0, 'lease still fresh past 2x leaseMs');
    return { finished: job.payload.tag };
  }, { principal: WORKER_PRINCIPAL, operations: ['execute'], pollIntervalMs: Infinity });

  try {
    const enqueued = queue.enqueue({ kind: 'long-running', payload: { tag: 'alpha' } });
    const initialLease = Date.now() + 120;
    const outcome = await worker.once();
    assert.ok(outcome);
    assert.deepEqual(outcome.result, { accepted: true, noop: false });

    const row = db.prepare('SELECT status, payload, output, leaseUntil FROM _Job WHERE id = ?').get(enqueued.id);
    assert.equal(row.status, 'completed');
    assert.deepEqual(JSON.parse(row.payload), { tag: 'alpha' });
    assert.deepEqual(JSON.parse(row.output), { finished: 'alpha' });
    assert.ok(row.leaseUntil > initialLease, 'leaseUntil was extended by auto-heartbeat while fn ran');

    // Verify timer was cleared after completion: leaseUntil must not keep advancing
    const leaseAfterDone = row.leaseUntil;
    await new Promise((r) => setTimeout(r, 120));
    const afterWait = db.prepare('SELECT leaseUntil FROM _Job WHERE id = ?').get(enqueued.id);
    assert.equal(afterWait.leaseUntil, leaseAfterDone, 'auto-heartbeat timer stopped after resolution');
  } finally {
    worker.stop();
    db.close();
  }
});

test('work() auto-heartbeat: clears timer cleanly when handler throws', async () => {
  const { db, queue } = freshQueue({ leaseMs: 120, maxAttempts: 1, backoffMs: 10 });
  const worker = queue.work('long-fail', async () => {
    await new Promise((r) => setTimeout(r, 90));
    throw new Error('handler exploded');
  }, { principal: WORKER_PRINCIPAL, operations: ['execute'], pollIntervalMs: Infinity });

  try {
    const enqueued = queue.enqueue({ kind: 'long-fail', payload: { n: 1 } });
    const outcome = await worker.once();
    assert.ok(outcome);
    assert.equal(outcome.result.deadLettered, true);

    const leaseAfterFail = db.prepare('SELECT leaseUntil, status FROM _Job WHERE id = ?').get(enqueued.id);
    assert.equal(leaseAfterFail.status, 'failed');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      db.prepare('SELECT leaseUntil FROM _Job WHERE id = ?').get(enqueued.id).leaseUntil,
      leaseAfterFail.leaseUntil,
      'auto-heartbeat timer stopped after rejection',
    );
  } finally {
    worker.stop();
    db.close();
  }
});
