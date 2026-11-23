// Wave 3a (#291) — annotatedText clean-break consolidation tests:
// 1. Incremental `_membership` updates on `annotation.update` (zero membership
//    writes on fields-only update; only affected annotation(s) touched on range
//    move, never wiping all document memberships).
// 2. Folded `planAnnotationPaste` single authority (`annotated-text-plan.mjs`
//    and compat shim `annotation-paste-plan.mjs` share the same function).
// 3. Authoring lease lifecycle (#229): explicit `releaseLease`,
//    `releaseLeaseByNonce`, `supersedeLeaseId`/`supersedeNonceHash`, LRU
//    `evictOldest: true` & `evictOldestLease`, and reduced quota query churn.
// 4. Thin core boundaries: `kernel.ts` forwards `app.writeQueue` to
//    `createServer`, and `pipeline.ts` delegates annotatedText compound logic
//    via `commitHook` without importing annotated-text modules directly.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText,
  annotation,
  annotatedTextCreateAction,
  entity,
  everyone,
  grant,
  read,
  ref,
  scope,
  subscribe,
  text,
  write,
} from '../build/index.mjs';
import { executeDDL, executeFrameworkDDL } from '../build/internal.mjs';
import { planAnnotationPaste } from '../build/annotated-text-plan.mjs';
import { planAnnotationPaste as shimPlanAnnotationPaste } from '../build/annotation-paste-plan.mjs';
import {
  AUTHORING_STREAM_LIMITS,
  countLiveLeases,
  ensureLease,
  ensureStream,
  evictOldestLease,
  hashClientNonce,
  issueAuthoringSnapshot,
  releaseLease,
  releaseLeaseByNonce,
  resolveLease,
} from '../build/annotated-text-authoring-stream.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

const user = { type: 'user', id: 'u1', attributes: {} };

function setupAuthoringDb(prefix = 'Doc_body') {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ${prefix}_authoring_stream (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_lease (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, client_nonce_hash TEXT NOT NULL, acknowledged_fence INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_checkpoint (id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, family_checkpoint TEXT NOT NULL CHECK (json_valid(family_checkpoint)), created_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_position (token TEXT PRIMARY KEY, lease_id TEXT NOT NULL, issued_fence INTEGER NOT NULL, checkpoint_id TEXT NOT NULL, visible_at_issue INTEGER NOT NULL, redactions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(redactions)), created_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_snapshot (id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, fence INTEGER NOT NULL, issued_at TEXT NOT NULL, acknowledged_at TEXT);
    CREATE TABLE ${prefix}_authoring_snapshot_position (snapshot_id TEXT NOT NULL, position_token TEXT NOT NULL, PRIMARY KEY (snapshot_id, position_token));
  `);
  return { db, prefix };
}

test('planAnnotationPaste is consolidated into annotated-text-plan with a thin shim', () => {
  assert.strictEqual(planAnnotationPaste, shimPlanAnnotationPaste);
});

test('annotation.update writes _membership incrementally (0 writes for fields-only, affected-only on range move)', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE Project (id TEXT PRIMARY KEY, owner TEXT); CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO Project VALUES ('p1', 'u1'); INSERT INTO User VALUES ('u1')");
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  const Doc = entity('ConsolDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('tag', { fields: { label: text() } }),
        annotation('speaker', { cardinality: 'one', fields: { name: text() } }),
      ],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  executeDDL(Doc, db);

  const app = workbench({ db, entities: [Project, Doc] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });

  const create = annotatedTextCreateAction(Doc, Doc.body, {
    id: 'd1',
    projectId: 'p1',
    ownerId: 'u1',
    source: {
      text: 'alpha beta gamma delta epsilon zeta',
      ranges: [
        { annotationId: 't1', family: 'tag', start: 0, end: 5, fields: { label: 'one' } },
        { annotationId: 't2', family: 'tag', start: 6, end: 10, fields: { label: 'two' } },
        { annotationId: 't3', family: 'tag', start: 11, end: 16, fields: { label: 'three' } },
        { annotationId: 's1', family: 'speaker', start: 0, end: 10, fields: { name: 'A' } },
        { annotationId: 's2', family: 'speaker', start: 11, end: 22, fields: { name: 'B' } },
        { annotationId: 's3', family: 'speaker', start: 23, end: 35, fields: { name: 'C' } },
      ],
    },
  });
  const created = await app.kernel.dispatch({
    actionId: 'create-1',
    type: create.type,
    payload: create.payload,
    scope: 'Project:p1',
    principal: user,
  });
  assert.equal(created.ok, true);

  // Track every DELETE and INSERT on ConsolDoc_body_membership via triggers.
  db.exec(`
    CREATE TABLE _membership_audit (op TEXT NOT NULL, annotation_id TEXT NOT NULL);
    CREATE TRIGGER _audit_mem_del AFTER DELETE ON ConsolDoc_body_membership
    BEGIN INSERT INTO _membership_audit (op, annotation_id) VALUES ('del', OLD.annotation_id); END;
    CREATE TRIGGER _audit_mem_ins AFTER INSERT ON ConsolDoc_body_membership
    BEGIN INSERT INTO _membership_audit (op, annotation_id) VALUES ('ins', NEW.annotation_id); END;
  `);
  const readAudit = () => db.prepare('SELECT op, annotation_id FROM _membership_audit').all().map((row) => ({ op: row.op, annotation_id: row.annotation_id }));
  const clearAudit = () => db.exec('DELETE FROM _membership_audit');

  const docEntity = app.entities.get('ConsolDoc');
  const readDocRow = () => db.prepare('SELECT * FROM ConsolDoc WHERE id = ?').get('d1');
  const bind = () => withAuthoringBinding({
    db, entity: docEntity, Document: docEntity, row: readDocRow(),
    principal: user, fieldName: 'body', descriptor: docEntity.fields.body,
  });

  let auth = await bind();

  // 1. Fields-only update on t1 -> ZERO membership deletes or inserts!
  clearAudit();
  const fieldsOnly = await app.kernel.dispatch({
    actionId: 'upd-fields-1',
    type: 'ConsolDoc.body.operation',
    scope: 'Project:p1',
    principal: user,
    payload: {
      version: 9,
      id: 'd1',
      authoring: { version: 1, stream: auth.streamToken, lease: auth.leaseToken, mutationId: 'm1' },
      edit: { kind: 'annotation.update', annotationId: 't1', fields: { label: 'one-renamed' } },
    },
  });
  assert.equal(fieldsOnly.ok, true);
  assert.deepEqual(readAudit(), [], 'fields-only annotation.update must perform zero _membership writes');

  // 2. Range move on t1 (many-cardinality) -> ONLY t1 deleted & inserted (t2, t3, s1, s2, s3 untouched).
  auth = await bind();
  clearAudit();
  const rangeMove = await app.kernel.dispatch({
    actionId: 'upd-range-1',
    type: 'ConsolDoc.body.operation',
    scope: 'Project:p1',
    principal: user,
    payload: {
      version: 9,
      id: 'd1',
      authoring: { version: 1, stream: auth.streamToken, lease: auth.leaseToken, mutationId: 'm2' },
      edit: {
        kind: 'annotation.update',
        annotationId: 't1',
        fields: { label: 'one-moved' },
        from: { positionToken: auth.documentPositionToken, offset: 1, affinity: 'right' },
        to: { positionToken: auth.documentPositionToken, offset: 5, affinity: 'left' },
      },
    },
  });
  assert.equal(rangeMove.ok, true);
  assert.deepEqual(readAudit(), [
    { op: 'del', annotation_id: 't1' },
    { op: 'ins', annotation_id: 't1' },
  ], 'moving one annotation must only rewrite _membership for that annotation');

  // 3. Exclusive (cardinality: 'one') move on s1 overlapping s2 -> ONLY s1 and s2 touched; s3, t1, t2, t3 untouched!
  auth = await bind();
  clearAudit();
  const exclusiveMove = await app.kernel.dispatch({
    actionId: 'upd-exclusive-1',
    type: 'ConsolDoc.body.operation',
    scope: 'Project:p1',
    principal: user,
    payload: {
      version: 9,
      id: 'd1',
      authoring: { version: 1, stream: auth.streamToken, lease: auth.leaseToken, mutationId: 'm3' },
      edit: {
        kind: 'annotation.update',
        annotationId: 's1',
        fields: { name: 'A-extended' },
        from: { positionToken: auth.documentPositionToken, offset: 0, affinity: 'right' },
        to: { positionToken: auth.documentPositionToken, offset: 15, affinity: 'left' },
      },
    },
  });
  assert.equal(exclusiveMove.ok, true);
  const touched = new Set(readAudit().map((row) => row.annotation_id));
  assert.deepEqual(touched, new Set(['s1', 's2']), 'exclusive move must only touch moved annotation and trimmed neighbor');
});

test('authoring lease lifecycle (#229): releaseLease, supersede, and LRU eviction prevent 24h lockout', () => {
  const { db, prefix } = setupAuthoringDb();
  const stream = ensureStream({ db, prefix, documentId: 'doc-229', principalType: 'user', principalId: 'u1' });
  const cap = AUTHORING_STREAM_LIMITS.maxLeasesPerStream;

  const leases = [];
  for (let i = 0; i < cap; i += 1) {
    const l = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce(`sess-${i}`) });
    assert.ok(l);
    // Give deterministic ascending expiries so leases[0] is oldest, leases[1] second-oldest, etc.
    db.prepare(`UPDATE ${prefix}_authoring_lease SET expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() + 60_000 + i * 1000).toISOString(), l.id);
    leases.push(l);
  }
  assert.equal(countLiveLeases(db, prefix, stream.id), cap);

  // Default ensureLease refuses at cap (preserves #815 lease-budget-exhausted contract).
  assert.equal(ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce('extra-default') }), null);

  // 1. Explicit releaseLease frees a slot immediately.
  assert.equal(releaseLease({ db, prefix, leaseId: leases[0].id, streamId: stream.id }), true);
  assert.equal(releaseLease({ db, prefix, leaseId: leases[0].id, streamId: stream.id }), false);
  assert.equal(countLiveLeases(db, prefix, stream.id), cap - 1);
  const afterRelease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce('after-release') });
  assert.ok(afterRelease?.created);
  assert.equal(countLiveLeases(db, prefix, stream.id), cap);

  // 2. Explicit releaseLeaseByNonce frees a slot by nonce hash.
  assert.equal(releaseLeaseByNonce({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce('after-release') }), true);
  assert.equal(countLiveLeases(db, prefix, stream.id), cap - 1);

  // Refill to cap.
  const refilled = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce('refill') });
  assert.ok(refilled);
  assert.equal(countLiveLeases(db, prefix, stream.id), cap);

  // 3. supersedeLeaseId replaces a prior lease atomically even at cap.
  const superseded = ensureLease({
    db, prefix, streamId: stream.id,
    clientNonceHash: hashClientNonce('rotated-nonce'),
    supersedeLeaseId: refilled.id,
  });
  assert.ok(superseded?.created);
  assert.equal(resolveLease({ db, prefix, leaseToken: refilled.id, streamId: stream.id }), null);
  assert.equal(countLiveLeases(db, prefix, stream.id), cap);

  // 4. evictOldest: true evicts the least-recently-used lease (leases[1], since leases[0] was released).
  // Touch leases[1] via resolveLease so leases[2] becomes the LRU victim!
  assert.ok(resolveLease({ db, prefix, leaseToken: leases[1].id, streamId: stream.id }));
  const evictedNew = ensureLease({
    db, prefix, streamId: stream.id,
    clientNonceHash: hashClientNonce('sess-17-lru'),
    evictOldest: true,
  });
  assert.ok(evictedNew?.created);
  assert.equal(countLiveLeases(db, prefix, stream.id), cap);
  assert.equal(resolveLease({ db, prefix, leaseToken: leases[2].id, streamId: stream.id }), null, 'LRU lease must be evicted');
  assert.ok(resolveLease({ db, prefix, leaseToken: leases[1].id, streamId: stream.id }), 'recently refreshed lease must survive');

  // 5. Explicit evictOldestLease helper with excludeLeaseId.
  const explicitEvict = evictOldestLease({ db, prefix, streamId: stream.id, excludeLeaseId: leases[3].id });
  assert.ok(explicitEvict?.evictedLeaseId);
  assert.notEqual(explicitEvict.evictedLeaseId, leases[3].id);
  assert.equal(countLiveLeases(db, prefix, stream.id), cap - 1);

  db.close();
});

test('issueAuthoringSnapshot runs a single lease quota query on single-lease streams (no redundant CAST scans)', () => {
  const { db, prefix } = setupAuthoringDb();
  const stream = ensureStream({ db, prefix, documentId: 'doc-quota', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce('solo-tab') });

  let castBlobQueries = 0;
  let streamJoinQuotaQueries = 0;
  const origPrepare = db.prepare.bind(db);
  const instrumentedDb = {
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      if (sql.includes('AS BLOB')) {
        castBlobQueries += 1;
        if (sql.includes('lease.stream_id')) streamJoinQuotaQueries += 1;
      }
      return origPrepare(sql);
    },
  };

  const issued = issueAuthoringSnapshot({
    db: instrumentedDb,
    prefix,
    leaseId: lease.id,
    fence: 1,
    positions: [{ familyCheckpoint: { basis: 'v1' }, visibleAtIssue: true, redactions: [] }],
  });
  assert.ok(issued);
  assert.equal(castBlobQueries, 1, 'single-lease snapshot issue should run only 1 combined quota query');
  assert.equal(streamJoinQuotaQueries, 0, 'single-lease stream should skip redundant stream-wide JOIN quota scan');

  // Oversized checkpoint fails in O(1) with 0 SQL quota queries.
  castBlobQueries = 0;
  const oversized = issueAuthoringSnapshot({
    db: instrumentedDb,
    prefix,
    leaseId: lease.id,
    fence: 2,
    positions: [{ familyCheckpoint: { pad: 'x'.repeat(AUTHORING_STREAM_LIMITS.maxRetainedPerLease + 16) }, visibleAtIssue: true }],
  });
  assert.equal(oversized, null);
  assert.equal(castBlobQueries, 0, 'obviously oversized checkpoint must fail before running SQL quota queries');

  db.close();
});

test('kernel forwards app.writeQueue into createServer (#283) and pipeline.ts has no annotated-text imports', async (t) => {
  const pipelineSource = readFileSync(join(process.cwd(), 'src/pipeline.ts'), 'utf8');
  assert.equal(pipelineSource.includes('./annotated-text'), false, 'src/pipeline.ts must not import annotated-text modules');
  assert.equal(pipelineSource.includes('./compound-contribution-fact'), false, 'src/pipeline.ts must not import compound-contribution-fact');

  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const Item = entity('QueueItem', {
    title: text(),
    grant: [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  executeDDL(Item, db);

  const app = workbench({ db, entities: [Item] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });

  let observedOwned = false;
  const origRun = app.writeQueue.run.bind(app.writeQueue);
  let queueRuns = 0;
  app.writeQueue.run = async (fn) => {
    queueRuns += 1;
    return origRun(async () => {
      observedOwned = app.writeQueue.owned;
      return fn();
    });
  };
  // Rebuild kernel after instrumenting app.writeQueue? No — app.kernel was already
  // constructed with the app.writeQueue reference, so wrapping app.writeQueue.run on
  // the same object intercepts kernel dispatches directly!
  const res = await app.kernel.dispatch({
    actionId: 'q-1',
    type: 'QueueItem.create',
    payload: { id: 'i1', title: 'queued' },
    scope: 'QueueItem:i1',
    principal: user,
  });
  assert.equal(res.ok, true);
  assert.equal(queueRuns > 0, true, 'kernel dispatch must serialize through app.writeQueue');
  assert.equal(observedOwned, true, 'dispatch transaction must run inside owned app.writeQueue turn');
});
