import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  AUTHORING_STREAM_LIMITS,
  acknowledgeAndPruneSnapshot,
  ensureLease,
  ensureStream,
  issueAuthoringSnapshot,
  issuePositionFrame,
  resolvePosition,
} from '../build/annotated-text-authoring-stream.mjs';
import { annotatedTextAuthoringStreamDDL } from '../build/annotated-text-field.mjs';
import { runWorkbenchMigrations, appliedWorkbenchVersion, ensureWorkbenchMigrationTable, WORKBENCH_MIGRATIONS } from '../build/workbench-migrations.mjs';
import { checksumOf } from '../build/migrations.mjs';
import { applyTextOp, createTextState, textCheckpoint } from '../build/annotated-text.mjs';
import { createTextFamily, materializeText, restoreTextFamily, textFamilyCheckpoint } from '../build/annotated-text-continuous.mjs';
import { defineSqliteSchema } from '../build/server.mjs';

const prefix = 'Doc_body';
const LATEST_WORKBENCH_VERSION = WORKBENCH_MIGRATIONS.at(-1).version;

// The parent entity table the A10 legacy-schema test pre-creates alongside the
// Transcript entity; declared through the externalTables seam so the settled
// census attributes it to this schema (Workbench does not create it).
const fixtureSchema = defineSqliteSchema({
  name: 'authoring-checkpoint-fixtures',
  tables: [],
  externalTables: [
    { name: 'Project', columns: ['id'] },
  ],
});

// Canonical (fresh-DB) authoring stream tables, exactly as the package DDL emits.
function baseDocTable() {
  return 'CREATE TABLE Doc (id TEXT PRIMARY KEY);';
}

function setupCanonical() {
  const db = new DatabaseSync(':memory:');
  db.exec(baseDocTable());
  for (const sql of annotatedTextAuthoringStreamDDL('Doc', 'body')) db.exec(sql);
  return db;
}

function wireDoc(db, ...documentIds) {
  for (const id of documentIds) db.prepare('INSERT OR IGNORE INTO Doc (id) VALUES (?)').run(id);
}

// Legacy (pre-dedup) authoring stream tables: repeated family_checkpoint,
// no checkpoint table, no checkpoint_id column.
function setupLegacy() {
  const db = new DatabaseSync(':memory:');
  db.exec(baseDocTable());
  db.exec(`
    CREATE TABLE ${prefix}_authoring_stream (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_lease (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, client_nonce_hash TEXT NOT NULL, acknowledged_fence INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_position (token TEXT PRIMARY KEY, lease_id TEXT NOT NULL, issued_fence INTEGER NOT NULL, block_id TEXT, family_checkpoint TEXT NOT NULL, visible_at_issue INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_group (token TEXT PRIMARY KEY, lease_id TEXT NOT NULL, issued_fence INTEGER NOT NULL, group_id TEXT, visible_blocks TEXT NOT NULL, assignable INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_snapshot (id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, fence INTEGER NOT NULL, issued_at TEXT NOT NULL, acknowledged_at TEXT);
    CREATE TABLE ${prefix}_authoring_snapshot_position (snapshot_id TEXT NOT NULL, position_token TEXT NOT NULL, PRIMARY KEY (snapshot_id, position_token));
    CREATE TABLE ${prefix}_authoring_split (lease_id TEXT NOT NULL, temporary_block TEXT NOT NULL, authoritative_block_id TEXT NOT NULL, position_token TEXT NOT NULL, action_id TEXT NOT NULL, mutation_id TEXT NOT NULL, fence INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (lease_id, temporary_block));
  `);
  return db;
}

// A large, valid text-family checkpoint. All positions from one snapshot basis
// share it — this is the shape whose 100x repetition used to blow the cap.
function largeCheckpoint(blockCount = 100) {
  const blockIds = [];
  const elements = {};
  for (let i = 0; i < blockCount; i += 1) {
    const blockId = `block-${i}`;
    elements[blockId] = {
      id: blockId,
      type: 'text',
      text: `T${String(i).padStart(6, '0')}`.repeat(7200),
      run: [{ style: 'plain' }],
    };
    blockIds.push(blockId);
  }
  return {
    id: 'unit-test-basis',
    checkpoint: { version: 1, frontier: blockIds, elements },
    blocks: blockIds,
  };
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}

function retainedBytesForLease(db, prefix, leaseId) {
  const byteSum = (sql, ...params) => Number(db.prepare(sql).get(...params).bytes ?? 0);
  const positionBytes = byteSum(
    `SELECT COALESCE(SUM(length(CAST(token AS BLOB)) + length(CAST(lease_id AS BLOB)) + length(CAST(issued_fence AS BLOB)) + length(CAST(checkpoint_id AS BLOB)) + length(CAST(visible_at_issue AS BLOB)) + length(CAST(redactions AS BLOB)) + length(CAST(created_at AS BLOB))), 0) AS bytes FROM ${prefix}_authoring_position WHERE lease_id = ?`,
    leaseId,
  );
  const checkpointBytes = byteSum(
    `SELECT COALESCE(SUM(length(CAST(family_checkpoint AS BLOB))), 0) AS bytes FROM ${prefix}_authoring_checkpoint WHERE lease_id = ?`,
    leaseId,
  );
  return positionBytes + checkpointBytes;
}

test('A1: production-shape bootstrap — one checkpoint, 100 positions, fits cap', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-1');
  const stream = ensureStream({ db, prefix, documentId: 'doc-1', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const familyCheckpoint = largeCheckpoint(100);

  assert.ok(Buffer.byteLength(JSON.stringify(familyCheckpoint), 'utf8') > 700_000, 'fixture checkpoint too small');

  const positions = Array.from({ length: 100 }, () => ({ familyCheckpoint, visibleAtIssue: true }));
  const snapshot = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions });
  assert.ok(snapshot);

  assert.equal(count(db, `${prefix}_authoring_position`), 100);
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1);
  const distinct = db.prepare(`SELECT COUNT(DISTINCT checkpoint_id) AS c FROM ${prefix}_authoring_position`).get().c;
  assert.equal(distinct, 1);

  const retained = retainedBytesForLease(db, prefix, lease.id);
  assert.ok(retained < 16 * 1024 * 1024, `retained bytes too large: ${retained}`);
});

test('A2: capacity refusal — oversized single basis refuses atomically', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-2');
  const stream = ensureStream({ db, prefix, documentId: 'doc-2', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  ensureStream({ db, prefix, documentId: 'doc-2', principalType: 'user', principalId: 'u1' });

  // A single basis whose ONE checkpoint already exceeds the 16 MiB cap must be
  // refused as a unit: no partial checkpoint/position rows may survive.
  const familyCheckpoint = largeCheckpoint(1);
  familyCheckpoint.checkpoint.elements['block-0'].text = 'X'.repeat(18 * 1024 * 1024);
  const positions = [{ familyCheckpoint, visibleAtIssue: true }];

  const result = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions });
  assert.equal(result, null, 'oversized single basis must be refused');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 0, 'no partial checkpoint from refused issuance');
  assert.equal(count(db, `${prefix}_authoring_position`), 0, 'no partial positions from refused issuance');
  assert.ok(db.prepare(`SELECT 1 FROM ${prefix}_authoring_lease WHERE id = ?`).get(lease.id), 'lease survives refusal');
});

test('A2b: capacity refusal — churn beyond the cap refuses while prior state survives', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-2b');
  const stream = ensureStream({ db, prefix, documentId: 'doc-2b', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });

  const positions = Array.from({ length: 100 }, () => ({ familyCheckpoint: largeCheckpoint(100), visibleAtIssue: true }));
  const snapshot = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions });
  assert.ok(snapshot);
  const basisCheckpoint = db.prepare(`SELECT id FROM ${prefix}_authoring_checkpoint WHERE lease_id = ?`).get(lease.id).id;

  // Distinct ~1MB checkpoints per churn frame: 20 frames overshoot the cap.
  let refused = 0;
  let fitted = 0;
  for (let i = 0; i < 20; i += 1) {
    const churnCheckpoint = { ...largeCheckpoint(1), id: `churn-${i}` };
    churnCheckpoint.checkpoint.elements['block-0'].text = 'Y'.repeat(1024 * 1024 + (i * 1024));
    const frame = issuePositionFrame({ db, prefix, leaseId: lease.id, fence: 2, familyCheckpoint: churnCheckpoint, visibleAtIssue: true });
    if (frame) fitted += 1;
    else refused += 1;
  }
  assert.ok(refused > 0, `expected its refined churn frames to be refused (fitted=${fitted})`);

  // Prior valid state survives untouched.
  assert.equal(count(db, `${prefix}_authoring_position WHERE issued_fence = 1`), 100, 'prior snapshot positions must survive');
  assert.ok(db.prepare(`SELECT 1 FROM ${prefix}_authoring_checkpoint WHERE id = ?`).get(basisCheckpoint), 'prior basis checkpoint must survive');
  assert.equal(count(db, `${prefix}_authoring_position`), 100 + fitted, 'only fitted churn positions exist');
});

test('A2c: heterogeneous bases in one snapshot reject atomically with a deterministic invariant error', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-2c');
  const stream = ensureStream({ db, prefix, documentId: 'doc-2c', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });

  const basisA = { ...largeCheckpoint(1), id: 'basis-a' };
  const basisB = { ...largeCheckpoint(1), id: 'basis-b' };

  // A snapshot must be one coherent basis. Mixing serialized family
  // checkpoints is an authoring-invariant violation and must fail atomically.
  const positions = [
    { familyCheckpoint: basisA, visibleAtIssue: true },
    { familyCheckpoint: basisB, visibleAtIssue: true },
  ];
  assert.throws(
    () => issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions }),
    /inconsistent position family checkpoints/,
  );
  // Atomic rejection: no partial checkpoint, position, or snapshot rows.
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 0, 'no partial checkpoint from heterogeneous rejection');
  assert.equal(count(db, `${prefix}_authoring_position`), 0, 'no partial positions from heterogeneous rejection');
  assert.equal(count(db, `${prefix}_authoring_snapshot`), 0, 'no snapshot from heterogeneous rejection');
  assert.equal(count(db, `${prefix}_authoring_snapshot_position`), 0, 'no snapshot-position rows from heterogeneous rejection');

  // The invariant error is deterministic and reserved for this failure, not a
  // plain capacity refusal.
  assert.throws(() => issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions }), /inconsistent position family checkpoints/);

  // Dedup path: identical bases on the same lease dedupe once (equal bases).
  const same = issueAuthoringSnapshot({
    db, prefix, leaseId: lease.id, fence: 2,
    positions: [
      { familyCheckpoint: basisA, visibleAtIssue: true },
      { familyCheckpoint: basisA, visibleAtIssue: true },
    ],
  });
  assert.ok(same, 'homogeneous snapshot issues');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1, 'equal bases dedupe once per lease');
  assert.equal(db.prepare(`SELECT COUNT(DISTINCT checkpoint_id) AS c FROM ${prefix}_authoring_position`).get().c, 1);
});

test('A3: ack/prune keeps tracked checkpoint until unreferenced then removes it', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-3');
  const stream = ensureStream({ db, prefix, documentId: 'doc-3', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });

  const checkpointA = largeCheckpoint(10);
  const snapshotA = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions: Array.from({ length: 10 }, () => ({ familyCheckpoint: checkpointA, visibleAtIssue: true })) });
  const checkpointIdA = db.prepare(`SELECT checkpoint_id FROM ${prefix}_authoring_position WHERE token = ?`).get(snapshotA.positionFrames[0].token).checkpoint_id;
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1);

  // A replacement basis shares nothing; both bases stay tracked.
  const snapshotB = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 2, positions: Array.from({ length: 5 }, () => ({ familyCheckpoint: largeCheckpoint(5), visibleAtIssue: true })) });
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 2);

  // Acknowledge A. Its own position fence equals its fence so nothing prunes,
  // but the snapshot becomes the idempotency marker and A's checkpoint stays
  // referenced.
  acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: snapshotA.snapshot.id });
  assert.ok(db.prepare(`SELECT 1 FROM ${prefix}_authoring_checkpoint WHERE id = ?`).get(checkpointIdA), 'checkpoint A survives while referenced');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 2);

  // Acknowledge B. A's positions (fence 1 < 2) are no longer protected by an
  // outstanding snapshot and are pruned; checkpoint A becomes unreferenced and
  // the sweep removes it. B's checkpoint survives.
  acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: snapshotB.snapshot.id });
  assert.equal(db.prepare(`SELECT 1 FROM ${prefix}_authoring_checkpoint WHERE id = ?`).get(checkpointIdA), undefined, 'unreferenced checkpoint A removed');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1, 'B checkpoint survives');

  // A third basis C replaces B (B already acknowledged): now B's checkpoint is
  // unreferenced after prune and is removed.
  const checkpointIdB = db.prepare(`SELECT checkpoint_id FROM ${prefix}_authoring_position WHERE token = ?`).get(snapshotB.positionFrames[0].token).checkpoint_id;
  const snapshotC = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 3, positions: Array.from({ length: 3 }, () => ({ familyCheckpoint: largeCheckpoint(3), visibleAtIssue: true })) });
  acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: snapshotC.snapshot.id });
  assert.equal(db.prepare(`SELECT 1 FROM ${prefix}_authoring_checkpoint WHERE id = ?`).get(checkpointIdB), undefined, 'B checkpoint removed after its positions pruned');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1, 'only C checkpoint remains');
  assert.equal(count(db, `${prefix}_authoring_position`), 3, 'anew acknowledged snapshot keeps its own positions');
});

test('A4: blockless position-frame lifecycle — basis mint, dedupe, hydration, prune', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-4');
  const stream = ensureStream({ db, prefix, documentId: 'doc-4', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });

  // A document-scoped position frame names the whole family checkpoint basis,
  // not a block. Issuing it must mint a checkpoint row and hydratable frame.
  const basis = largeCheckpoint(3);
  const frame = issuePositionFrame({ db, prefix, leaseId: lease.id, fence: 1, familyCheckpoint: basis, visibleAtIssue: true });
  assert.ok(frame, 'position frame must issue');
  const frameCheckpointId = db.prepare(`SELECT checkpoint_id FROM ${prefix}_authoring_position WHERE token = ?`).get(frame.token).checkpoint_id;
  assert.equal(
    db.prepare(`SELECT family_checkpoint FROM ${prefix}_authoring_checkpoint WHERE id = ?`).get(frameCheckpointId).family_checkpoint,
    JSON.stringify(basis),
    'frame checkpoint payload is the issued family basis',
  );
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1);

  // A second frame built on the identical basis dedupes to the same checkpoint.
  const twin = issuePositionFrame({ db, prefix, leaseId: lease.id, fence: 1, familyCheckpoint: basis, visibleAtIssue: true });
  assert.ok(twin);
  assert.equal(db.prepare(`SELECT checkpoint_id FROM ${prefix}_authoring_position WHERE token = ?`).get(twin.token).checkpoint_id, frameCheckpointId, 'equal bases dedupe to one checkpoint');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1);

  // resolvePosition hydrates the frame: family_checkpoint joins back.
  const resolved = resolvePosition({ db, prefix, positionToken: frame.token, leaseId: lease.id });
  assert.ok(resolved, 'resolvePosition must hydrate a position frame');
  assert.equal(resolved.checkpoint_id, frameCheckpointId);
  assert.deepEqual(JSON.parse(resolved.family_checkpoint), basis);

  // Acknowledge a superseding snapshot: the standalone (unowned) frames are
  // pruned and their checkpoint becomes unreferenced, so the sweep removes it.
  const snapshotB = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 2, positions: [{ familyCheckpoint: largeCheckpoint(2), visibleAtIssue: true }] });
  acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: snapshotB.snapshot.id });
  assert.equal(count(db, `${prefix}_authoring_position`), 1, 'only the acknowledged snapshot position remains');
  assert.equal(db.prepare(`SELECT 1 FROM ${prefix}_authoring_checkpoint WHERE id = ?`).get(frameCheckpointId), undefined, 'unreferenced frame basis checkpoint removed');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1, 'only the snapshotB checkpoint remains');
});

test('A4b: AUTHORING_STREAM_LIMITS — documented capacity caps are enforced', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-4b');
  const stream = ensureStream({ db, prefix, documentId: 'doc-4b', principalType: 'user', principalId: 'u1' });

  // The documented caps are baked into the stream module's limits table.
  assert.equal(AUTHORING_STREAM_LIMITS.maxRetainedPerLease, 16 * 1024 * 1024);
  assert.equal(AUTHORING_STREAM_LIMITS.maxRetainedPerStream, 64 * 1024 * 1024);
  assert.equal(AUTHORING_STREAM_LIMITS.maxLeasesPerStream, 16);
  assert.equal(AUTHORING_STREAM_LIMITS.leaseTtlMs, 24 * 60 * 60 * 1000);

  // A lease whose retained frames alone cross maxRetainedPerLease refuses.
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const big = { basis: 'big', payload: 'x'.repeat(AUTHORING_STREAM_LIMITS.maxRetainedPerLease + 1024) };
  const result = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions: [{ familyCheckpoint: big, visibleAtIssue: true }] });
  assert.equal(result, null, 'single frame exceeding maxRetainedPerLease is refused');
  assert.equal(count(db, `${prefix}_authoring_position`), 0, 'no partial positions from refused frame');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 0, 'no partial checkpoint from refused frame');

  // maxLeasesPerStream: the cap is 16 concurrent leases per stream; the initial
  // 'client' lease already counts toward it, so this stream accepts 15 more.
  for (let i = 0; i < AUTHORING_STREAM_LIMITS.maxLeasesPerStream - 1; i += 1) {
    const l = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: `client-${i}` });
    assert.ok(l, `lease ${i} fits within maxLeasesPerStream`);
  }
  const overflow = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client-overflow' });
  assert.equal(overflow, null, 'lease beyond maxLeasesPerStream is refused');
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS c FROM ${prefix}_authoring_lease WHERE stream_id = ?`).get(stream.id).c,
    AUTHORING_STREAM_LIMITS.maxLeasesPerStream,
    'stream lease count never exceeds maxLeasesPerStream',
  );
});

test('A5: hydrate — resolvePosition returns family_checkpoint for consumers', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-5');
  const stream = ensureStream({ db, prefix, documentId: 'doc-5', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const familyCheckpoint = largeCheckpoint(2);
  const snapshot = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions: [{ familyCheckpoint, visibleAtIssue: true }] });

  const resolved = resolvePosition({ db, prefix, positionToken: snapshot.positionFrames[0].token, leaseId: lease.id });
  assert.ok(resolved, 'resolvePosition must hydrate a position');
  assert.ok(resolved.family_checkpoint, 'family_checkpoint must be present for consumers');
  assert.deepEqual(JSON.parse(resolved.family_checkpoint), familyCheckpoint);
});

test('A6: concurrent leases isolate checkpoints', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-6');
  const stream = ensureStream({ db, prefix, documentId: 'doc-6', principalType: 'user', principalId: 'u1' });
  const lease1 = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client-1' });
  const lease2 = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client-2' });

  issueAuthoringSnapshot({ db, prefix, leaseId: lease1.id, fence: 1, positions: Array.from({ length: 5 }, () => ({ familyCheckpoint: largeCheckpoint(5), visibleAtIssue: true })) });
  issueAuthoringSnapshot({ db, prefix, leaseId: lease2.id, fence: 1, positions: Array.from({ length: 3 }, () => ({ familyCheckpoint: largeCheckpoint(3), visibleAtIssue: true })) });

  assert.equal(count(db, `${prefix}_authoring_checkpoint WHERE lease_id = '${lease1.id}'`), 1);
  assert.equal(count(db, `${prefix}_authoring_checkpoint WHERE lease_id = '${lease2.id}'`), 1);
  const ids1 = db.prepare(`SELECT id FROM ${prefix}_authoring_checkpoint WHERE lease_id = ?`).all(lease1.id).map((row) => row.id);
  const ids2 = db.prepare(`SELECT id FROM ${prefix}_authoring_checkpoint WHERE lease_id = ?`).all(lease2.id).map((row) => row.id);
  assert.equal(ids1.some((id) => ids2.includes(id)), false, 'leases must not share checkpoints');

  // Expire lease1: its checkpoint is removed, lease2 is untouched.
  db.prepare(`UPDATE ${prefix}_authoring_lease SET expires_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), lease1.id);
  db.prepare(`DELETE FROM ${prefix}_authoring_position WHERE lease_id = ?`).run(lease1.id);
  db.prepare(`DELETE FROM ${prefix}_authoring_checkpoint WHERE lease_id = ? AND NOT EXISTS (SELECT 1 FROM ${prefix}_authoring_position WHERE checkpoint_id = ${prefix}_authoring_checkpoint.id)`).run(lease1.id);
  assert.equal(count(db, `${prefix}_authoring_checkpoint WHERE lease_id = '${lease1.id}'`), 0);
  assert.equal(count(db, `${prefix}_authoring_checkpoint WHERE lease_id = '${lease2.id}'`), 1);
});

test('A8: migration — legacy schema upgrades atomically, preserves durable data', async () => {
  const db = setupLegacy();
  // Populate a legacy stream with full chip-slot state.
  const stream = ensureStream({ db, prefix, documentId: 'doc-7', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  db.prepare(`INSERT INTO ${prefix}_authoring_position (token, lease_id, issued_fence, block_id, family_checkpoint, visible_at_issue, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('pos-1', lease.id, 1, 'block-1', JSON.stringify({ a: 1 }), 1, new Date().toISOString());
  db.prepare(`INSERT INTO ${prefix}_authoring_group (token, lease_id, issued_fence, group_id, visible_blocks, assignable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('group-1', lease.id, 1, 'g1', '[]', 1, new Date().toISOString());
  db.prepare(`INSERT INTO ${prefix}_authoring_snapshot (id, lease_id, fence, issued_at, acknowledged_at) VALUES (?, ?, ?, ?, ?)`).run('snap-1', lease.id, 1, new Date().toISOString(), null);
  db.prepare(`INSERT INTO ${prefix}_authoring_snapshot_position (snapshot_id, position_token) VALUES (?, ?)`).run('snap-1', 'pos-1');
  db.prepare(`INSERT INTO ${prefix}_authoring_split (lease_id, temporary_block, authoritative_block_id, position_token, action_id, mutation_id, fence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(lease.id, 'temp-1', 'block-1', 'pos-1', 'a1', 'm1', 1, new Date().toISOString());

  // Durable/table state deliberately NOT authoring ephemeral — keep a marker table.
  db.exec(`CREATE TABLE durable_marker (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.prepare('INSERT INTO durable_marker (id, value) VALUES (?, ?)').run('m1', 'keep');

  // Run the built-in Workbench migration (fresh apply). v6
  // (membership-range-schema-repair) and v7 (framework-legacy-column-upgrades)
  // are no-ops here — this legacy family has no annotated-text `_membership` or
  // framework ledger tables.
  await runWorkbenchMigrations(db);
  assert.equal(appliedWorkbenchVersion(db), LATEST_WORKBENCH_VERSION);

  // Canonical shape: position has checkpoint_id NOT NULL, no family_checkpoint.
  const positionColumns = new Set(db.prepare(`PRAGMA table_info(${prefix}_authoring_position)`).all().map((r) => r.name));
  assert.ok(positionColumns.has('checkpoint_id'), 'position must have checkpoint_id after migration');
  assert.ok(positionColumns.has('family_checkpoint') === false, 'legacy family_checkpoint column removed');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 0, 'all legacy ephemeral state cleared up front');
  assert.equal(count(db, `${prefix}_authoring_position`), 0, 'no legacy positions preserved');

  // Durable data + committed log untouched.
  assert.ok(db.prepare(`SELECT 1 FROM durable_marker WHERE id = 'm1'`).get());

  // Fresh bootstrap works on the migrated schema.
  const freshStream = ensureStream({ db, prefix, documentId: 'doc-8', principalType: 'user', principalId: 'u1' });
  const freshLease = ensureLease({ db, prefix, streamId: freshStream.id, clientNonceHash: 'client-fresh' });
  const snap = issueAuthoringSnapshot({ db, prefix, leaseId: freshLease.id, fence: 1, positions: [{ familyCheckpoint: largeCheckpoint(2), visibleAtIssue: true }] });
  assert.ok(snap);
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1);

  // Second startup is a no-op.
  await runWorkbenchMigrations(db);
  assert.equal(appliedWorkbenchVersion(db), LATEST_WORKBENCH_VERSION);
});

test('A8-rollback: induced migration failure rolls back and leaves legacy schema intact', async () => {
  const db = setupLegacy();
  const stream = ensureStream({ db, prefix, documentId: 'doc-9', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  db.prepare(`INSERT INTO ${prefix}_authoring_position (token, lease_id, issued_fence, block_id, family_checkpoint, visible_at_issue, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('pos-1', lease.id, 1, 'block-1', JSON.stringify({ a: 1 }), 1, new Date().toISOString());

  // Durable marker table that will be preserved even on failure.
  db.exec(`CREATE TABLE durable_marker (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.prepare('INSERT INTO durable_marker (id, value) VALUES (?, ?)').run('keep', 'keep');

  // Force the migration to fail after partial work (READONLY dir on SQLite or
  // a trigger that aborts the rebuild). Simplest: a BEFORE DELETE trigger on
  // legacy position that aborts — failure inside the exclusive txn rolls back.
  db.exec(`CREATE TRIGGER fail_migration BEFORE DELETE ON ${prefix}_authoring_position BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
  assert.throws(() => runWorkbenchMigrations(db), /injected failure/);

  // Rollback: legacy shape preserved, version not recorded, no partial state.
  assert.equal(appliedWorkbenchVersion(db), 0, 'no version on rollback');
  const positionColumns = new Set(db.prepare(`PRAGMA table_info(${prefix}_authoring_position)`).all().map((r) => r.name));
  assert.ok(positionColumns.has('family_checkpoint'), 'legacy position column preserved after rollback');
  assert.ok(db.prepare(`SELECT 1 FROM ${prefix}_authoring_position WHERE token = 'pos-1'`).get(), 'legacy position row survives rollback');
  assert.ok(db.prepare(`SELECT 1 FROM durable_marker WHERE id = 'keep'`).get());

  // With the trigger removed, the same run succeeds (idempotent re-apply after rollback).
  db.exec(`DROP TRIGGER fail_migration`);
  await runWorkbenchMigrations(db);
  assert.equal(appliedWorkbenchVersion(db), LATEST_WORKBENCH_VERSION);
});

test('A8-v2: migration invalidates defective ephemeral state and preserves durable state', async () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-10');
  db.exec('CREATE TABLE durable_marker (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO durable_marker (id, value) VALUES (?, ?)').run('keep', 'durable');
  ensureWorkbenchMigrationTable(db);
  const v1 = WORKBENCH_MIGRATIONS.find((migration) => migration.version === 1);
  db.prepare('INSERT INTO _SchemaMigration (namespace, version, name, checksum, appliedAt, suppliedBy) VALUES (?, ?, ?, ?, ?, ?)').run('workbench', 1, v1.name, checksumOf(v1), new Date().toISOString(), null);
  const stream = ensureStream({ db, prefix, documentId: 'doc-10', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });

  issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions: [{ blockId: 'b', familyCheckpoint: { id: 'defective-build', checkpoint: { version: 1, frontier: ['b'], elements: { b: { id: 'b', type: 'text', text: 'x', run: [] } } }, blocks: ['b'] }, visibleAtIssue: true }], groups: [] });
  assert.equal(count(db, `${prefix}_authoring_position`), 1);
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1);

  // Upgrade from the deployed v1 build invalidates every opaque authoring token.
  await runWorkbenchMigrations(db);
  await runWorkbenchMigrations(db);
  assert.equal(appliedWorkbenchVersion(db), LATEST_WORKBENCH_VERSION);
  assert.equal(count(db, `${prefix}_authoring_stream`), 0, 'streams from the defective build are invalidated');
  assert.equal(count(db, `${prefix}_authoring_lease`), 0, 'leases from the defective build are invalidated');
  assert.equal(count(db, `${prefix}_authoring_position`), 0, 'defective position tokens are removed');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 0, 'defective checkpoint bases are removed');
  assert.equal(db.prepare("SELECT value FROM durable_marker WHERE id = 'keep'").get().value, 'durable');

  // The canonical structure must already be in place (new DDL emitted it);
  // the migration does not regress it.
  const positionColumns = new Set(db.prepare(`PRAGMA table_info(${prefix}_authoring_position)`).all().map((r) => r.name));
  assert.equal(positionColumns.has('checkpoint_id'), true, 'checkpoint_id present');
  assert.equal(positionColumns.has('family_checkpoint'), false, 'no family_checkpoint column');
});

test('A8-incomplete: partial authoring family fails closed and rolls back', async () => {
  const db = setupLegacy();
  wireDoc(db, 'doc-10b');
  // Omit the authoring_group table → incomplete legacy family.
  db.exec('DROP TABLE Doc_body_authoring_group');

  assert.throws(() => runWorkbenchMigrations(db), /incomplete authoring stream table family/);
  assert.equal(appliedWorkbenchVersion(db), 0, 'no version recorded on fail-closed refusal');
  // The legacy position table is untouched (nothing cleared).
  const positionColumns = new Set(db.prepare(`PRAGMA table_info(${prefix}_authoring_position)`).all().map((r) => r.name));
  assert.ok(positionColumns.has('family_checkpoint'), 'legacy position table preserved on refusal');
});

test('A8-parity: migrated schema matches fresh canonical schema exactly', async () => {
  const fresh = setupCanonical();
  const migrated = setupLegacy();
  // Populate a legacy row so the rebuild runs, then migrate.
  const stream = ensureStream({ db: migrated, prefix, documentId: 'd', principalType: 'user', principalId: 'u' });
  const lease = ensureLease({ db: migrated, prefix, streamId: stream.id, clientNonceHash: 'c' });
  migrated.prepare(`INSERT INTO ${prefix}_authoring_position (token, lease_id, issued_fence, block_id, family_checkpoint, visible_at_issue, created_at) VALUES ('p1', ?, 1, 'b1', '{"a":1}', 1, '2020-01-01')`).run(lease.id);
  migrated.prepare(`INSERT INTO ${prefix}_authoring_lease (id, stream_id, client_nonce_hash, acknowledged_fence, created_at, expires_at) VALUES ('lease-x', 's1', 'n1', 0, '2020-01-01', '2099-01-01')`).run();
  await runWorkbenchMigrations(migrated);

  const describe = (db) => ({
    position: db.prepare(`PRAGMA table_info(${prefix}_authoring_position)`).all().map((r) => `${r.name}:${r.type}:${r.notnull}:${r.pk}:${r.dflt_value ?? ''}`),
    checkpoint: db.prepare(`PRAGMA table_info(${prefix}_authoring_checkpoint)`).all().map((r) => `${r.name}:${r.type}:${r.notnull}:${r.pk}:${r.dflt_value ?? ''}`),
    fkeys: db.prepare(`PRAGMA foreign_key_list(${prefix}_authoring_position)`).all().sort((a, b) => a.id - b.id).map((r) => `${r.table}:${r.from}:${r.to}:${r.on_delete}`),
  });
  assert.deepEqual(describe(migrated), describe(fresh), 'position/checkpoint schema identical after migration vs fresh canonical');
});

test('A-emptyp: a snapshot with zero visible blocks issues without touching checkpoints', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-emptyp');
  const stream = ensureStream({ db, prefix, documentId: 'doc-emptyp', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });

  const result = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions: [] });
  assert.ok(result, 'empty-positions snapshot issues successfully');
  assert.equal(result.positionFrames.length, 0);
  assert.equal('groupFrames' in result, false, 'no groupFrames in the blockless contract');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 0, 'no checkpoint created for empty positions');
  assert.equal(count(db, `${prefix}_authoring_position`), 0, 'no position rows for empty positions');
});

test('A9: contract parity — envelope/token fixtures unchanged', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-11');
  const stream = ensureStream({ db, prefix, documentId: 'doc-11', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const snapshot = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions: [{ familyCheckpoint: { id: 'basis', checkpoint: { version: 1, frontier: ['b'], elements: { b: { id: 'b', type: 'text', text: 'x', run: [] } } }, blocks: ['b'] }, visibleAtIssue: true }] });

  assert.ok(snapshot.snapshot.id);
  assert.ok(snapshot.positionFrames.length === 1);
  const frame = snapshot.positionFrames[0];
  assert.ok(frame.token, 'position token still opaque');
  assert.equal(frame.token.includes(':'), false, 'no checkpoint/lease structure leaks into the token');
});

test('A10: app.prepareSchema upgrades a legacy authoring schema via the built-in lane', async () => {
  const internal = await import('../build/internal.mjs');
  const {
    annotation,
    annotatedText,
    entity: appEntity,
    measurement,
    ref,
    registerAnnotatedTextContract,
    registerAnnotatedTextStructuralExtension,
  } = internal;
  const workbench = internal.default;
  registerAnnotatedTextContract('checkpointA10Measurement', Object.freeze({ kind: 'measurement' }));
  registerAnnotatedTextStructuralExtension('checkpointA10Measurement', Object.freeze({
    version: 1,
    validate() {}, edit() {},
    partition({ blockText, utf16Offset, payload }) {
      return Object.freeze({ version: 1, leftPayload: Object.freeze({ ...payload, text: blockText.slice(0, utf16Offset) }), rightPayload: Object.freeze({ ...payload, text: blockText.slice(utf16Offset) }) });
    },
    combine({ left, right }) { return Object.freeze({ version: 1, payload: Object.freeze({ text: `${left?.payload.text ?? ''}${right?.payload.text ?? ''}` }) }); },
  }));
  const db = new DatabaseSync(':memory:');
  // Legacy authoring tables (pre-dedup shape) AND the parent entity table. The
  // prefix must match the registered entity's own annotated-text prefix
  // (Transcript_body) so the legacy family IS the entity's family: the census
  // declares it and the built-in migration rebuilds it in place.
  const legacyPrefix = 'Transcript_body';
  db.exec(`
    CREATE TABLE Transcript (id TEXT PRIMARY KEY);
    CREATE TABLE Project (id TEXT PRIMARY KEY);
    CREATE TABLE User (id TEXT PRIMARY KEY);
    CREATE TABLE ${legacyPrefix}_authoring_stream (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE ${legacyPrefix}_authoring_lease (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, client_nonce_hash TEXT NOT NULL, acknowledged_fence INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE ${legacyPrefix}_authoring_position (token TEXT PRIMARY KEY, lease_id TEXT NOT NULL, issued_fence INTEGER NOT NULL, block_id TEXT, family_checkpoint TEXT NOT NULL, visible_at_issue INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE ${legacyPrefix}_authoring_group (token TEXT PRIMARY KEY, lease_id TEXT NOT NULL, issued_fence INTEGER NOT NULL, group_id TEXT, visible_blocks TEXT NOT NULL, assignable INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE ${legacyPrefix}_authoring_snapshot (id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, fence INTEGER NOT NULL, issued_at TEXT NOT NULL, acknowledged_at TEXT);
    CREATE TABLE ${legacyPrefix}_authoring_snapshot_position (snapshot_id TEXT NOT NULL, position_token TEXT NOT NULL, PRIMARY KEY (snapshot_id, position_token));
    CREATE TABLE ${legacyPrefix}_authoring_split (lease_id TEXT NOT NULL, temporary_block TEXT NOT NULL, authoritative_block_id TEXT NOT NULL, position_token TEXT NOT NULL, action_id TEXT NOT NULL, mutation_id TEXT NOT NULL, fence INTEGER NOT NULL, created_at TEXT NOT NULL);
  `);
  db.prepare(`INSERT INTO ${legacyPrefix}_authoring_lease (id, stream_id, client_nonce_hash, acknowledged_fence, created_at, expires_at) VALUES ('lease-1', 's1', 'n1', 0, '2020-01-01', '2099-01-01')`).run();
  db.prepare(`INSERT INTO ${legacyPrefix}_authoring_position (token, lease_id, issued_fence, block_id, family_checkpoint, visible_at_issue, created_at) VALUES ('pos-1', 'lease-1', 1, 'block-1', '{"a":1}', 1, '2020-01-01')`).run();

  const body = annotatedText({
    project: 'project',
    owner: 'owner',
    annotations: [annotation('note', { fields: {} })],
    measurements: [measurement('source', { extension: 'checkpointA10Measurement' })],
  });
  const TranscriptEntity = appEntity('Transcript', {
    project: ref('Project'),
    owner: ref('User'),
    body,
  });
  const app = workbench({ db, schema: fixtureSchema, entities: [TranscriptEntity] });
  await app.prepareSchema();

  // The built-in migration rebuilt the position table into canonical shape.
  const positionColumns = new Set(db.prepare(`PRAGMA table_info(${legacyPrefix}_authoring_position)`).all().map((r) => r.name));
  assert.ok(positionColumns.has('checkpoint_id'), 'position has checkpoint_id after app boot');
  assert.ok(positionColumns.has('family_checkpoint') === false, 'legacy family_checkpoint column removed after app boot');
  const applied = db.prepare("SELECT MAX(version) AS v FROM _SchemaMigration WHERE namespace = 'workbench'").get();
  assert.equal(applied.v, LATEST_WORKBENCH_VERSION, `Workbench migrations v1–v${LATEST_WORKBENCH_VERSION} recorded`);
  assert.equal(count(db, `${legacyPrefix}_authoring_position`), 0, 'pre-migration legacy positions cleared');
  app.db.close();
});

test('A11: the migration lane upgrades a legacy annotated-text membership table to the canonical range key, preserving rows', async () => {
  // Legacy one-row-per-annotation membership shape (annotation_id PRIMARY KEY)
  // on a real annotated-text family: the annotation row carries a document_id
  // foreign key to the document entity table, exactly as the canonical DDL
  // emits it — v6's repair resolves the owning document through that key.
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE Doc (id TEXT PRIMARY KEY)`);
  db.exec(`CREATE TABLE ${prefix}_annotation (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, project_id TEXT NOT NULL, owner_id TEXT NOT NULL, family TEXT NOT NULL, FOREIGN KEY (document_id) REFERENCES Doc(id))`);
  db.exec(`CREATE TABLE ${prefix}_membership (
    annotation_id TEXT PRIMARY KEY,
    start_point TEXT NOT NULL CHECK (json_valid(start_point)),
    end_point TEXT NOT NULL CHECK (json_valid(end_point)),
    FOREIGN KEY (annotation_id) REFERENCES ${prefix}_annotation(id) ON DELETE CASCADE
  )`);
  db.exec(`INSERT INTO Doc VALUES ('d1')`);
  db.exec(`INSERT INTO ${prefix}_annotation (id, document_id, project_id, owner_id, family) VALUES ('a1', 'd1', 'p1', 'u1', 'speaker')`);
  db.exec(`INSERT INTO ${prefix}_membership (annotation_id, start_point, end_point) VALUES ('a1', '{"p":1}', '{"p":2}')`);

  await runWorkbenchMigrations(db);
  assert.equal(appliedWorkbenchVersion(db), LATEST_WORKBENCH_VERSION);

  // Canonical shape today is the range/document/ordinal schema: v4 moves the
  // legacy table to the (annotation_id, start_point) composite key and v6
  // repairs the intermediate shape onto the shared range table.
  const columns = db.prepare(`PRAGMA table_info(${prefix}_membership)`).all();
  assert.deepEqual(columns.map((column) => column.name), ['annotation_id', 'range_id', 'document_id', 'ordinal'], 'membership lands on the canonical range/document/ordinal shape');
  assert.deepEqual(columns.filter((column) => column.pk > 0).map((column) => column.name), ['annotation_id', 'range_id'], 'composite primary key on (annotation_id, range_id)');
  assert.equal(columns.find((column) => column.name === 'annotation_id').notnull, 1);
  assert.equal(columns.find((column) => column.name === 'ordinal').notnull, 1);

  // The membership row was carried over unchanged and its endpoints preserved
  // on the shared range table, referenced per document.
  const row = db.prepare(`SELECT m.annotation_id, m.range_id, m.document_id, m.ordinal, r.start_point, r.end_point FROM ${prefix}_membership AS m JOIN ${prefix}_range AS r ON r.id = m.range_id AND r.document_id = m.document_id WHERE m.annotation_id = 'a1'`).get();
  assert.deepEqual({ ...row }, { annotation_id: 'a1', range_id: 1, document_id: 'd1', ordinal: 0, start_point: '{"p":1}', end_point: '{"p":2}' });
  const rangeRows = db.prepare(`SELECT id, document_id, start_point, end_point FROM ${prefix}_range`).all();
  assert.equal(rangeRows.length, 1);
  assert.deepEqual(JSON.parse(rangeRows[0].start_point), { p: 1 });
  assert.deepEqual(JSON.parse(rangeRows[0].end_point), { p: 2 });

  // FKs preserved: membership resolves through annotation and range.
  const fks = db.prepare(`PRAGMA foreign_key_list(${prefix}_membership)`).all();
  assert.ok(fks.some((fk) => fk.table === `${prefix}_annotation` && fk.from === 'annotation_id' && fk.on_delete === 'CASCADE'));
  assert.ok(fks.some((fk) => fk.table === `${prefix}_range` && fk.from === 'range_id' && fk.on_delete === 'CASCADE'));

  // Idempotent: a second run leaves the canonical table untouched.
  await runWorkbenchMigrations(db);
  assert.equal(count(db, `${prefix}_membership`), 1, 'canonical membership rows survive a second run');
  db.close();
});

test('A11b: v6 leaves a fresh canonical-shape membership table untouched', async () => {
  // A fresh database's DDL already emits the range/document/ordinal membership
  // table (annotatedTextDDL). v4 skips the canonical composite key and v6 skips
  // the canonical range key — nothing is rebuilt, rows survive untouched.
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE Doc (id TEXT PRIMARY KEY)`);
  db.exec(`CREATE TABLE ${prefix}_annotation (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    family TEXT NOT NULL,
    UNIQUE (id, document_id),
    FOREIGN KEY (document_id) REFERENCES Doc(id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE TABLE ${prefix}_range (
    id INTEGER PRIMARY KEY,
    document_id TEXT NOT NULL,
    start_point TEXT NOT NULL CHECK (json_valid(start_point)),
    end_point TEXT NOT NULL CHECK (json_valid(end_point)),
    UNIQUE (document_id, start_point, end_point),
    UNIQUE (id, document_id),
    FOREIGN KEY (document_id) REFERENCES Doc(id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE TABLE ${prefix}_membership (
    annotation_id TEXT NOT NULL,
    range_id INTEGER NOT NULL,
    document_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (annotation_id, range_id),
    UNIQUE (annotation_id, ordinal),
    FOREIGN KEY (annotation_id, document_id) REFERENCES ${prefix}_annotation(id, document_id) ON DELETE CASCADE,
    FOREIGN KEY (range_id, document_id) REFERENCES ${prefix}_range(id, document_id) ON DELETE CASCADE
  )`);
  db.exec(`INSERT INTO Doc VALUES ('d1')`);
  db.exec(`INSERT INTO ${prefix}_annotation (id, document_id, project_id, owner_id, family) VALUES ('a1', 'd1', 'p1', 'u1', 'speaker')`);
  db.exec(`INSERT INTO ${prefix}_range (document_id, start_point, end_point) VALUES ('d1', '{"p":1}', '{"p":2}')`);
  db.exec(`INSERT INTO ${prefix}_membership (annotation_id, range_id, document_id, ordinal) VALUES ('a1', 1, 'd1', 0)`);

  await runWorkbenchMigrations(db);
  assert.equal(appliedWorkbenchVersion(db), LATEST_WORKBENCH_VERSION);
  const columns = db.prepare(`PRAGMA table_info(${prefix}_membership)`).all();
  assert.deepEqual(columns.filter((column) => column.pk > 0).map((column) => column.name), ['annotation_id', 'range_id']);
  assert.equal(count(db, `${prefix}_membership`), 1, 'canonical membership rows survive the migration untouched');
  assert.equal(count(db, `${prefix}_range`), 1, 'range rows survive the migration untouched');
  db.close();
});

test('A12: v5 compacts durable continuous checkpoints and invalidates oversized authoring frames', async () => {
  const db = setupCanonical();
  wireDoc(db, 'd1');
  const actor = 'a'.repeat(32);
  const text = 'Transcript checkpoint content. '.repeat(100);
  const state = applyTextOp(createTextState(), ['workbench.text', 1, [actor, 1], 1, [], ['insert', ['root'], text]]);
  const family = createTextFamily('d1', textCheckpoint(state));
  const oldSerialized = JSON.stringify(textFamilyCheckpoint(family));
  db.exec(`CREATE TABLE ${prefix}_state (document_id TEXT PRIMARY KEY, structure_version INTEGER NOT NULL, family_checkpoint TEXT NOT NULL CHECK (json_valid(family_checkpoint)))`);
  db.prepare(`INSERT INTO ${prefix}_state VALUES (?, 1, ?)`).run('d1', oldSerialized);
  const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'n'.repeat(64) });
  issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions: [{ familyCheckpoint: textFamilyCheckpoint(family), visibleAtIssue: true }] });

  await runWorkbenchMigrations(db);

  const serialized = db.prepare(`SELECT family_checkpoint FROM ${prefix}_state WHERE document_id = 'd1'`).get().family_checkpoint;
  const compact = JSON.parse(serialized);
  assert.equal(compact.checkpoint.version, 2);
  assert.equal(Object.hasOwn(compact.checkpoint, 'elements'), false);
  assert.equal(materializeText(restoreTextFamily(compact)), text);
  assert.ok(serialized.length < oldSerialized.length / 10);
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${prefix}_authoring_position`).get().c, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${prefix}_authoring_checkpoint`).get().c, 0);
  db.close();
});
