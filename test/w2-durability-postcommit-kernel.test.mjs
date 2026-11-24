// Wave 2 lane w2-durability-postcommit-kernel — focused verification of the
// durability, post-commit, and kernel-thinning seams changed in this lane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import { CONNECTION_PRAGMA_SQL, connectionPragmaSql, applyConnectionPragmas } from '../build/driver.mjs';
import { durableJobId } from '../build/durable-effects.mjs';
import { createServer, durableMutationVariant, writeQueueForDatabase } from '../build/pipeline.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { runDeclaredActionWithBlobClaims } from '../build/pending-blob.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { createLog, withLog } from '../build/log.mjs';
import { createJobQueue } from '../build/job-queue.mjs';
import { createQueryInvalidationHub } from '../build/internal.mjs';
import workbench from '../build/index.mjs';

// ---- 1. synchronous = FULL default with explicit NORMAL opt-out ------------

test('connection PRAGMAs default to WAL synchronous=FULL; NORMAL is an explicit opt-out', () => {
  assert.ok(
    CONNECTION_PRAGMA_SQL.includes('PRAGMA synchronous = FULL'),
    'the default connection PRAGMA list must pin WAL FULL durability',
  );
  assert.ok(
    !CONNECTION_PRAGMA_SQL.includes('PRAGMA synchronous = NORMAL'),
    'NORMAL must not be the default',
  );
  assert.deepEqual([...connectionPragmaSql({ synchronous: 'NORMAL' })], [
    'PRAGMA journal_mode = WAL',
    'PRAGMA foreign_keys = ON',
    'PRAGMA synchronous = NORMAL',
    'PRAGMA busy_timeout = 5000',
  ]);

  const db = new DatabaseSync(':memory:');
  try {
    applyConnectionPragmas(db);
    assert.deepEqual({ ...db.prepare('PRAGMA synchronous').get() }, { synchronous: 2 });
    applyConnectionPragmas(db, { synchronous: 'NORMAL' });
    assert.deepEqual({ ...db.prepare('PRAGMA synchronous').get() }, { synchronous: 1 });
  } finally {
    db.close();
  }
});

// ---- 2. post-commit consumer throws are logged + surfaced, never undo -------

test('a throwing post-commit consumer is logged and reported to onConsumerError; the commit stays intact', async () => {
  const logs = [];
  const log = createLog({ level: 'trace', output: (level, channel, message, ctx) => logs.push({ level, channel, message, ctx }) });
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const hookCalls = [];
  let consumerCalls = 0;

  const server = withLog(log, () => createServer({
    db,
    handlers: { bump: () => [{ type: 'bumped', scope: 'Count:1', data: {} }] },
    authorize: () => true,
    onConsumerError: (err, info) => hookCalls.push({ message: err.message, info }),
    pipeline: durableMutationVariant({
      postCommitConsumers: [async () => {
        consumerCalls += 1;
        throw new Error('consumer boom');
      }],
    }),
  }));

  const result = await withLog(log, () => server.dispatch({
    actionId: 'a1', type: 'bump', payload: {}, principal: { id: 'u1' },
  }));

  assert.equal(result.ok, true, 'a consumer failure cannot turn a committed mutation into a failure');
  assert.equal(consumerCalls, 1);
  assert.equal(db.prepare("SELECT lastSeq FROM _Cursor WHERE scope = 'Count:1'").get().lastSeq, 1, 'the origin committed');
  assert.equal(hookCalls.length, 1, 'the optional hook ran exactly once');
  assert.equal(hookCalls[0].message, 'consumer boom');
  assert.equal(hookCalls[0].info.phase, 'consumer');
  assert.equal(hookCalls[0].info.actionId, 'a1');
  assert.ok(
    logs.some((entry) => entry.channel === 'dispatch' && entry.level === 'warn' && entry.message === 'post-commit consumer failed'),
    'a structured warn was emitted',
  );
  db.close();
});

// ---- 3. durable job id encoding + idempotent enqueue ------------------------

test('durableJobId encodes ambiguous scope/kind segments without changing the canonical format', () => {
  const base = { type: 'E.created', seq: 1, actionId: 'a', committedAt: 't' };
  assert.equal(durableJobId({ ...base, scope: 'Note:n1' }, 'send-title'), 'durable-effect:Note:n1:1:send-title');

  // A ':' inside an id must not blur the (scope, seq, kind) boundaries.
  assert.equal(durableJobId({ ...base, scope: 'E:a:b' }, 'k'), 'durable-effect:E:a%3Ab:1:k');
  const left = durableJobId({ ...base, scope: 'E:a' }, '2:k');
  const right = durableJobId({ ...base, scope: 'E:a:1', seq: 2 }, 'k');
  assert.notEqual(left, right, 'two distinct tuples must never collide on one durable job id');

  // Percent-encoding is unambiguous (a literal '%3A' differs from ':').
  assert.notEqual(
    durableJobId({ ...base, scope: 'E:a:b' }, 'k'),
    durableJobId({ ...base, scope: 'E:a%3Ab' }, 'k'),
  );
});

test('enqueue with a caller-owned id is idempotent — a retry does not crash or double-emit', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const jobs = createJobQueue({ db, sharedSecret: 'w2-lane-secret' });
  const first = jobs.enqueue({ id: 'fixed-id', kind: 'k', scope: 'E:1', payload: { n: 1 } });
  const second = jobs.enqueue({ id: 'fixed-id', kind: 'k', scope: 'E:1', payload: { n: 1 } });
  assert.equal(first.id, 'fixed-id');
  assert.equal(second.id, 'fixed-id');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _Job').get().n, 1, 'one durable job row');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM _Log WHERE eventType = '_Job.created'").get().n,
    1,
    'one enqueued event — no duplicate live-visibility signal',
  );
  db.close();
});

// ---- 4. one write coordinator per db handle --------------------------------

test('createServer reuses the handle-attached write queue and refuses a second uncoordinated one', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const first = createServer({ db, handlers: {}, authorize: () => true });
  const second = createServer({ db, handlers: {}, authorize: () => true });
  assert.equal(first.writeQueue, second.writeQueue, 'two servers on one handle share one mutex');
  assert.equal(writeQueueForDatabase(db), first.writeQueue, 'the queue is attached to the handle');

  const foreign = createWriteQueue();
  assert.throws(
    () => createServer({ db, handlers: {}, authorize: () => true, writeQueue: foreign }),
    /refuses a second write queue/,
    'a different uncoordinated queue on the same handle fails closed',
  );
  db.close();
});

// ---- 5. kernel blob extraction + query-invalidation descriptor --------------

test('kernel delegates declared-action blob claims to pending-blob.ts', async () => {
  const kernelSource = readFileSync(new URL('../build/kernel.mjs', import.meta.url), 'utf8');
  assert.ok(kernelSource.includes('runDeclaredActionWithBlobClaims'), 'kernel calls the extracted helper');
  assert.ok(!kernelSource.includes('containsAttestationMetadata'), 'the attestation scanner no longer lives in kernel');
  assert.equal(typeof runDeclaredActionWithBlobClaims, 'function');

  const captured = [];
  const result = await runDeclaredActionWithBlobClaims({
    declaration: {
      type: 'do',
      handler: (ctx) => {
        captured.push(ctx.payload);
        return [{ type: 'E.did', scope: ctx.scope, data: {} }];
      },
    },
    context: { db: null, scope: 'E:1', actionId: 'a1', principal: { id: 'u1' }, payload: { x: 1 } },
    lifecycle: null,
  });
  assert.deepEqual(captured, [{ x: 1 }]);
  assert.deepEqual(result, [{ type: 'E.did', scope: 'E:1', data: {} }], 'no-lifecycle path is unchanged');
});

test('kernel registers the query-invalidation consumer descriptor when a hub is present', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.queryInvalidationHub = createQueryInvalidationHub();
  app.listen(0);
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.ready;
  const descriptor = app.postCommitConsumerDescriptors.find((d) => d.name === 'query-invalidation');
  assert.ok(descriptor, 'query-invalidation is a kernel post-commit consumer');
  assert.equal(descriptor.kind, 'best-effort-external-consumer');
  assert.equal(typeof descriptor.consumer, 'function');
});
