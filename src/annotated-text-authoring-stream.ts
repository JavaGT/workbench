import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
const LEASE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LEASES_PER_STREAM = 16;
const MAX_RETAINED_PER_LEASE = 16 * 1024 * 1024;
const MAX_RETAINED_PER_STREAM = 64 * 1024 * 1024;

interface Statement {
  run(...args: unknown[]): { changes: number };
  get(...args: unknown[]): any;
  all(...args: unknown[]): any[];
}

interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): unknown;
}

/** Read the durable continuous-family checkpoint for one document. */
export function readAnnotatedTextFamilyCheckpoint(db: Db, prefix: string, documentId: string): string | undefined {
  const row = db.prepare(`SELECT family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(documentId) as
    | { family_checkpoint?: unknown }
    | undefined;
  if (!row) return undefined;
  if (typeof row.family_checkpoint !== 'string') {
    throw new Error('annotated-text authoring: family checkpoint row is malformed');
  }
  return row.family_checkpoint;
}

interface StreamRow {
  id: string;
  document_id: string;
  principal_type: string;
  principal_id: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
}

interface LeaseRow {
  id: string;
  stream_id: string;
  client_nonce_hash: string;
  acknowledged_fence: number;
  created_at: string;
  expires_at: string;
}

interface PositionRow {
  token: string;
  lease_id: string;
  issued_fence: number;
  checkpoint_id: string;
  visible_at_issue: number;
  redactions: string;
  created_at: string;
  family_checkpoint?: string;
}

interface AuthoringPositionInput {
  familyCheckpoint: unknown;
  visibleAtIssue?: boolean;
  redactions?: unknown[];
}

interface IssuedSnapshot {
  id: string;
  fence: number;
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function randomToken(): string {
  return base64url(randomBytes(TOKEN_BYTES));
}

function now(): string {
  return new Date().toISOString();
}

function clientNonceHash(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

export function allocateClientNonce(): string {
  return randomToken();
}

export function hashClientNonce(nonce: string): string {
  return clientNonceHash(nonce);
}

export function ensureStream({ db, prefix, documentId, principalType, principalId }: {
  db: Db;
  prefix: string;
  documentId: string;
  principalType: string;
  principalId: string;
}): { id: string; created: boolean } {
  const existing = db.prepare(`SELECT id, expires_at FROM ${prefix}_authoring_stream WHERE document_id = ? AND principal_type = ? AND principal_id = ?`).get(documentId, principalType, principalId) as StreamRow | undefined;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  if (existing) {
    const expiresAt = new Date(existing.expires_at).getTime();
    const hasLiveLease = db.prepare(`SELECT 1 FROM ${prefix}_authoring_lease WHERE stream_id = ? AND expires_at > ?`).get(existing.id, nowIso);
    if (expiresAt > nowMs || hasLiveLease) {
      db.prepare(`UPDATE ${prefix}_authoring_stream SET last_used_at = ?, expires_at = ? WHERE id = ?`).run(nowIso, new Date(nowMs + LEASE_TTL_MS).toISOString(), existing.id);
      return { id: existing.id, created: false };
    }
    clearStream(db, prefix, existing.id);
  }
  const id = randomToken();
  // Streams do not outlive their leases. A stream expiration is only a
  // backstop for a never-used stream, not a second retention policy.
  const expiresAt = new Date(nowMs + LEASE_TTL_MS).toISOString();
  db.prepare(`INSERT INTO ${prefix}_authoring_stream (id, document_id, principal_type, principal_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, documentId, principalType, principalId, nowIso, nowIso, expiresAt);
  return { id, created: true };
}

/**
 * Explicitly release a single authoring lease and all of its retained frames
 * (positions, snapshots, checkpoints). Closing or unmounting a session calls
 * this so its slot is immediately returned to the stream budget instead of
 * lingering until the 24h TTL (#229).
 */
export function releaseLease({ db, prefix, leaseId, streamId }: {
  db: Db;
  prefix: string;
  leaseId: string;
  streamId?: string;
}): boolean {
  const existing = streamId !== undefined
    ? db.prepare(`SELECT id FROM ${prefix}_authoring_lease WHERE id = ? AND stream_id = ?`).get(leaseId, streamId) as { id: string } | undefined
    : db.prepare(`SELECT id FROM ${prefix}_authoring_lease WHERE id = ?`).get(leaseId) as { id: string } | undefined;
  if (!existing) return false;
  clearLeaseChildren(db, prefix, existing.id);
  db.prepare(`DELETE FROM ${prefix}_authoring_lease WHERE id = ?`).run(existing.id);
  return true;
}

/**
 * Release the authoring lease bound to `(streamId, clientNonceHash)`, if any,
 * along with its retained frames (#229).
 */
export function releaseLeaseByNonce({ db, prefix, streamId, clientNonceHash }: {
  db: Db;
  prefix: string;
  streamId: string;
  clientNonceHash: string;
}): boolean {
  const existing = db.prepare(`SELECT id FROM ${prefix}_authoring_lease WHERE stream_id = ? AND client_nonce_hash = ?`).get(streamId, clientNonceHash) as { id: string } | undefined;
  if (!existing) return false;
  clearLeaseChildren(db, prefix, existing.id);
  db.prepare(`DELETE FROM ${prefix}_authoring_lease WHERE id = ?`).run(existing.id);
  return true;
}

/**
 * Evict the least-recently-used lease on a stream (expired first, then lowest
 * `expires_at` / oldest `created_at`) to reclaim a slot without waiting 24h
 * (#229). Because every authenticated use refreshes `expires_at = now + TTL`,
 * `expires_at ASC` is exact LRU order.
 */
export function evictOldestLease({ db, prefix, streamId, excludeLeaseId }: {
  db: Db;
  prefix: string;
  streamId: string;
  excludeLeaseId?: string;
}): { evictedLeaseId: string } | null {
  const victim = excludeLeaseId !== undefined
    ? db.prepare(`SELECT id FROM ${prefix}_authoring_lease WHERE stream_id = ? AND id <> ? ORDER BY expires_at ASC, created_at ASC LIMIT 1`).get(streamId, excludeLeaseId) as { id: string } | undefined
    : db.prepare(`SELECT id FROM ${prefix}_authoring_lease WHERE stream_id = ? ORDER BY expires_at ASC, created_at ASC LIMIT 1`).get(streamId) as { id: string } | undefined;
  if (!victim) return null;
  clearLeaseChildren(db, prefix, victim.id);
  db.prepare(`DELETE FROM ${prefix}_authoring_lease WHERE id = ?`).run(victim.id);
  return { evictedLeaseId: victim.id };
}

function purgeExpiredLeasesForStream(db: Db, prefix: string, streamId: string, nowIso: string): number {
  const expired = db.prepare(`SELECT id FROM ${prefix}_authoring_lease WHERE stream_id = ? AND expires_at <= ?`).all(streamId, nowIso) as Array<{ id: string }>;
  for (const row of expired) {
    clearLeaseChildren(db, prefix, row.id);
    db.prepare(`DELETE FROM ${prefix}_authoring_lease WHERE id = ?`).run(row.id);
  }
  return expired.length;
}

export function ensureLease({ db, prefix, streamId, clientNonceHash, supersedeLeaseId, supersedeNonceHash, evictOldest = false }: {
  db: Db;
  prefix: string;
  streamId: string;
  clientNonceHash: string;
  /** Optional previous lease id owned by this session to atomically replace (#229). */
  supersedeLeaseId?: string;
  /** Optional previous nonce hash owned by this session to atomically replace (#229). */
  supersedeNonceHash?: string;
  /**
   * When true and the stream is at `maxLeasesPerStream` with no expired leases,
   * evict the least-recently-used live lease so a long-lived stream can never
   * stay locked for 24h (#229). Defaults to false to preserve strict cap refusal
   * for callers that distinguish `lease-budget-exhausted`.
   */
  evictOldest?: boolean;
}): { id: string; created: boolean; acknowledgedFence: number } | null {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const newExpiresAt = new Date(nowMs + LEASE_TTL_MS).toISOString();

  // If the session explicitly supersedes a prior lease/nonce on this stream,
  // reclaim that slot first (skipping only if it names the exact nonce being
  // reused so same-nonce reuse remains idempotent).
  if (supersedeNonceHash && supersedeNonceHash !== clientNonceHash) {
    releaseLeaseByNonce({ db, prefix, streamId, clientNonceHash: supersedeNonceHash });
  }
  const existing = db.prepare(`SELECT id, acknowledged_fence, expires_at FROM ${prefix}_authoring_lease WHERE stream_id = ? AND client_nonce_hash = ?`).get(streamId, clientNonceHash) as LeaseRow | undefined;
  if (supersedeLeaseId && supersedeLeaseId !== existing?.id) {
    releaseLease({ db, prefix, leaseId: supersedeLeaseId, streamId });
  }
  if (existing) {
    const expiresAt = new Date(existing.expires_at).getTime();
    if (expiresAt > nowMs) {
      db.prepare(`UPDATE ${prefix}_authoring_lease SET expires_at = ? WHERE id = ?`).run(newExpiresAt, existing.id);
      db.prepare(`UPDATE ${prefix}_authoring_stream SET last_used_at = ?, expires_at = ? WHERE id = ?`).run(nowIso, newExpiresAt, streamId);
      return { id: existing.id, created: false, acknowledgedFence: existing.acknowledged_fence };
    }
    clearLeaseChildren(db, prefix, existing.id);
    db.prepare(`DELETE FROM ${prefix}_authoring_lease WHERE id = ?`).run(existing.id);
  }

  let count = db.prepare(`SELECT COUNT(*) AS cnt FROM ${prefix}_authoring_lease WHERE stream_id = ?`).get(streamId).cnt as number;
  if (count >= MAX_LEASES_PER_STREAM) {
    const purged = purgeExpiredLeasesForStream(db, prefix, streamId, nowIso);
    count -= purged;
    if (count >= MAX_LEASES_PER_STREAM) {
      if (!evictOldest) return null;
      const toEvict = count - MAX_LEASES_PER_STREAM + 1;
      const victims = db.prepare(
        `SELECT id FROM ${prefix}_authoring_lease WHERE stream_id = ? ORDER BY expires_at ASC, created_at ASC LIMIT ?`,
      ).all(streamId, toEvict) as Array<{ id: string }>;
      for (const victim of victims) {
        clearLeaseChildren(db, prefix, victim.id);
        db.prepare(`DELETE FROM ${prefix}_authoring_lease WHERE id = ?`).run(victim.id);
      }
      if (victims.length < toEvict) return null;
    }
  }
  const id = randomToken();
  db.prepare(`INSERT INTO ${prefix}_authoring_lease (id, stream_id, client_nonce_hash, acknowledged_fence, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, streamId, clientNonceHash, 0, nowIso, newExpiresAt);
  db.prepare(`UPDATE ${prefix}_authoring_stream SET last_used_at = ?, expires_at = ? WHERE id = ?`).run(nowIso, newExpiresAt, streamId);
  return { id, created: true, acknowledgedFence: 0 };
}

export const AUTHORING_STREAM_LIMITS = Object.freeze({
  leaseTtlMs: LEASE_TTL_MS,
  maxLeasesPerStream: MAX_LEASES_PER_STREAM,
  maxRetainedPerLease: MAX_RETAINED_PER_LEASE,
  maxRetainedPerStream: MAX_RETAINED_PER_STREAM,
});

// Live (unexpired) leases held on one stream. The bootstrap seam pairs this
// with AUTHORING_STREAM_LIMITS.maxLeasesPerStream to label a refused lease as
// `lease-budget-exhausted` instead of an unexplained retry (#815) — ensureLease
// itself keeps its `null` refusal contract by default, so existing direct
// callers (host apps included) are unaffected.
export function countLiveLeases(db: Db, prefix: string, streamId: string): number {
  return db.prepare(`SELECT COUNT(*) AS cnt FROM ${prefix}_authoring_lease WHERE stream_id = ? AND expires_at > ?`).get(streamId, now()).cnt as number;
}

function clearLeaseChildren(db: Db, prefix: string, leaseId: string): void {
  db.prepare(`DELETE FROM ${prefix}_authoring_position WHERE lease_id = ?`).run(leaseId);
  db.prepare(`DELETE FROM ${prefix}_authoring_snapshot WHERE lease_id = ?`).run(leaseId);
  db.prepare(`DELETE FROM ${prefix}_authoring_checkpoint WHERE lease_id = ?`).run(leaseId);
}

export function resolveStream({ db, prefix, streamToken, documentId, principalType, principalId }: {
  db: Db;
  prefix: string;
  streamToken: string;
  documentId: string;
  principalType: string;
  principalId: string;
}): StreamRow | null {
  const stream = db.prepare(`SELECT * FROM ${prefix}_authoring_stream WHERE id = ? AND document_id = ? AND principal_type = ? AND principal_id = ?`).get(streamToken, documentId, principalType, principalId) as StreamRow | undefined;
  if (!stream) return null;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const hasLiveLease = db.prepare(`SELECT 1 FROM ${prefix}_authoring_lease WHERE stream_id = ? AND expires_at > ?`).get(stream.id, nowIso);
  const expiresAt = new Date(stream.expires_at).getTime();
  if (expiresAt <= nowMs && !hasLiveLease) {
    clearStream(db, prefix, stream.id);
    return null;
  }
  db.prepare(`UPDATE ${prefix}_authoring_stream SET last_used_at = ?, expires_at = ? WHERE id = ?`).run(nowIso, new Date(nowMs + LEASE_TTL_MS).toISOString(), stream.id);
  return stream;
}

export function resolveLease({ db, prefix, leaseToken, streamId }: {
  db: Db;
  prefix: string;
  leaseToken: string;
  streamId: string;
}): LeaseRow | null {
  const lease = db.prepare(`SELECT * FROM ${prefix}_authoring_lease WHERE id = ? AND stream_id = ?`).get(leaseToken, streamId) as LeaseRow | undefined;
  if (!lease) return null;
  const nowMs = Date.now();
  const expiresAt = new Date(lease.expires_at).getTime();
  if (expiresAt <= nowMs) {
    clearLeaseChildren(db, prefix, lease.id);
    db.prepare(`DELETE FROM ${prefix}_authoring_lease WHERE id = ?`).run(lease.id);
    return null;
  }
  // Any authenticated lease use is activity. This keeps the stream alive through
  // its live lease rather than an independent stream-age deadline.
  const nowIso = new Date(nowMs).toISOString();
  const newExpiresAt = new Date(nowMs + LEASE_TTL_MS).toISOString();
  db.prepare(`UPDATE ${prefix}_authoring_lease SET expires_at = ? WHERE id = ?`).run(newExpiresAt, lease.id);
  db.prepare(`UPDATE ${prefix}_authoring_stream SET last_used_at = ?, expires_at = ? WHERE id = ?`).run(nowIso, newExpiresAt, streamId);
  return lease;
}

export function resolvePosition({ db, prefix, positionToken, leaseId }: {
  db: Db;
  prefix: string;
  positionToken: string;
  leaseId: string;
}): PositionRow | null {
  const position = db.prepare(`SELECT position.*, checkpoint.family_checkpoint AS family_checkpoint FROM ${prefix}_authoring_position AS position LEFT JOIN ${prefix}_authoring_checkpoint AS checkpoint ON checkpoint.id = position.checkpoint_id WHERE position.token = ? AND position.lease_id = ?`).get(positionToken, leaseId) as PositionRow | undefined;
  if (!position) return null;
  return position;
}

function ensureCheckpointForBasis({ db, prefix, leaseId, serializedCheckpoint }: {
  db: Db;
  prefix: string;
  leaseId: string;
  serializedCheckpoint: string;
}): string {
  const existing = db.prepare(`SELECT id FROM ${prefix}_authoring_checkpoint WHERE lease_id = ? AND family_checkpoint = ? LIMIT 1`).get(leaseId, serializedCheckpoint);
  if (existing) return existing.id;
  const id = randomToken();
  db.prepare(`INSERT INTO ${prefix}_authoring_checkpoint (id, lease_id, family_checkpoint, created_at) VALUES (?, ?, ?, ?)`).run(id, leaseId, serializedCheckpoint, now());
  return id;
}

function insertPositionFrameRow({ db, prefix, leaseId, fence, serializedCheckpoint, visibleAtIssue, redactions = [], checkCapacity }: {
  db: Db;
  prefix: string;
  leaseId: string;
  fence: number;
  serializedCheckpoint: string;
  visibleAtIssue?: boolean;
  redactions?: unknown[];
  checkCapacity: boolean;
}): { token: string } | null {
  const token = randomToken();
  const createdAt = now();
  const redactionsJson = JSON.stringify(redactions);
  if (checkCapacity) {
    const estimatedBytes = rowBytes([token, leaseId, fence, token, visibleAtIssue ? 1 : 0, redactionsJson, createdAt]);
    if (estimatedBytes > MAX_RETAINED_PER_LEASE) return null;
  }
  const resolvedCheckpointId = ensureCheckpointForBasis({ db, prefix, leaseId, serializedCheckpoint });
  if (checkCapacity && !hasCapacity({ db, prefix, leaseId, bytes: rowBytes([token, leaseId, fence, resolvedCheckpointId, visibleAtIssue ? 1 : 0, redactionsJson, createdAt]) })) {
    db.prepare(`DELETE FROM ${prefix}_authoring_checkpoint AS checkpoint WHERE checkpoint.id = ? AND NOT EXISTS (SELECT 1 FROM ${prefix}_authoring_position WHERE checkpoint_id = checkpoint.id)`).run(resolvedCheckpointId);
    return null;
  }
  db.prepare(`INSERT INTO ${prefix}_authoring_position (token, lease_id, issued_fence, checkpoint_id, visible_at_issue, redactions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(token, leaseId, fence, resolvedCheckpointId, visibleAtIssue ? 1 : 0, redactionsJson, createdAt);
  return { token };
}

// A position frame is DOCUMENT-scoped (issue #33): one frame names the whole
// document's family checkpoint basis, not a block. The client's edit carries an
// absolute UTF-16 offset against that basis.
export function issuePositionFrame({ db, prefix, leaseId, fence, familyCheckpoint, visibleAtIssue, redactions = [] }: {
  db: Db;
  prefix: string;
  leaseId: string;
  fence: number;
  familyCheckpoint: unknown;
  visibleAtIssue?: boolean;
  redactions?: unknown[];
}): { token: string } | null {
  return insertPositionFrameRow({
    db,
    prefix,
    leaseId,
    fence,
    serializedCheckpoint: JSON.stringify(familyCheckpoint),
    visibleAtIssue,
    redactions,
    checkCapacity: true,
  });
}

// A snapshot is one retained unit. Capacity failure must not leave predecessor
// frames behind because those rows are unacknowledged and cannot be evicted.
// A snapshot is one coherent basis: every position must serialize to the same
// family checkpoint, otherwise the dedup key could split into the pre/post-split
// bases an action was never meant to straddle.
export function issueAuthoringSnapshot({ db, prefix, leaseId, fence, positions }: {
  db: Db;
  prefix: string;
  leaseId: string;
  fence: number;
  positions: AuthoringPositionInput[];
}): { positionFrames: Array<{ token: string }>; snapshot: IssuedSnapshot } | null {
  let serializedCheckpoint: string | null = null;
  if (positions.length > 0) {
    const serialized = positions.map((position) => JSON.stringify(position.familyCheckpoint));
    if (serialized.some((value) => value !== serialized[0])) {
      throw new Error('inconsistent position family checkpoints');
    }
    serializedCheckpoint = serialized[0];
    // Fast O(1) rejection before touching SQLite when a single checkpoint
    // payload alone cannot possibly fit inside MAX_RETAINED_PER_LEASE.
    if (Buffer.byteLength(serializedCheckpoint) > MAX_RETAINED_PER_LEASE) {
      return null;
    }
  }
  const attempt = (): { positionFrames: Array<{ token: string }>; snapshot: IssuedSnapshot } | null => {
    db.exec('SAVEPOINT authoring_snapshot_issue');
    try {
      const positionFrames = positions.map((position) => insertPositionFrameRow({
        db,
        prefix,
        leaseId,
        fence,
        serializedCheckpoint: serializedCheckpoint!,
        visibleAtIssue: position.visibleAtIssue,
        redactions: position.redactions,
        checkCapacity: false,
      })) as Array<{ token: string }>;
      if (positionFrames.some((frame) => !frame)) throw new Error('capacity');
      const snapshotId = randomToken();
      const issuedAt = now();
      db.prepare(`INSERT INTO ${prefix}_authoring_snapshot (id, lease_id, fence, issued_at) VALUES (?, ?, ?, ?)`).run(snapshotId, leaseId, fence, issuedAt);
      const snapshot: IssuedSnapshot = { id: snapshotId, fence };
      const ownPosition = db.prepare(`INSERT INTO ${prefix}_authoring_snapshot_position (snapshot_id, position_token) VALUES (?, ?)`);
      for (const frame of positionFrames) ownPosition.run(snapshot.id, frame.token);
      // Verify the complete post-insert byte quota ONCE for the whole snapshot
      // unit instead of scanning all authoring tables per inserted row.
      if (!hasCapacity({ db, prefix, leaseId, bytes: 0 })) throw new Error('capacity');
      db.exec('RELEASE authoring_snapshot_issue');
      return { positionFrames, snapshot };
    } catch (error) {
      db.exec('ROLLBACK TO authoring_snapshot_issue');
      db.exec('RELEASE authoring_snapshot_issue');
      if ((error as Error).message === 'capacity') return null;
      throw error;
    }
  };
  const first = attempt();
  if (first) return first;
  // The lease's retained frames exhausted capacity. The unacknowledged frames
  // belong to an earlier page session that will never acknowledge them, and the
  // snapshot being issued now supersedes them. Prune the lease's frames and
  // retry once so a reload cannot brick the document with "authoring stream
  // capacity exceeded". If the incoming frames alone still exceed capacity, the
  // retry returns null and the caller refuses (unchanged contract).
  clearLeaseChildren(db, prefix, leaseId);
  return attempt();
}

export function acknowledgeAndPruneSnapshot({ db, prefix, snapshotId, leaseId }: {
  db: Db;
  prefix: string;
  snapshotId: string;
  leaseId: string;
}): { fence: number; alreadyAcknowledged: boolean } | null {
  db.exec('SAVEPOINT authoring_snapshot_acknowledge');
  try {
    const existing = db.prepare(`SELECT id, lease_id, fence, acknowledged_at FROM ${prefix}_authoring_snapshot WHERE id = ? AND lease_id = ?`).get(snapshotId, leaseId);
    if (!existing) {
      db.exec('ROLLBACK TO authoring_snapshot_acknowledge');
      db.exec('RELEASE authoring_snapshot_acknowledge');
      return null;
    }
    if (existing.acknowledged_at) {
      db.exec('RELEASE authoring_snapshot_acknowledge');
      return { fence: existing.fence, alreadyAcknowledged: true };
    }
    db.prepare(`UPDATE ${prefix}_authoring_snapshot SET acknowledged_at = ? WHERE id = ?`).run(now(), snapshotId);
    db.prepare(`UPDATE ${prefix}_authoring_lease SET acknowledged_fence = MAX(acknowledged_fence, ?) WHERE id = ?`).run(existing.fence, leaseId);

    // Never invalidate a token that an outstanding snapshot can still name, or
    // the acknowledged snapshot itself issued. All predicates are lease-scoped.
    db.prepare(`DELETE FROM ${prefix}_authoring_position AS position
      WHERE position.lease_id = ? AND position.issued_fence < ?
        AND NOT EXISTS (
          SELECT 1 FROM ${prefix}_authoring_snapshot_position
          WHERE snapshot_id = ? AND position_token = position.token
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${prefix}_authoring_snapshot AS snapshot
          JOIN ${prefix}_authoring_snapshot_position AS owned ON owned.snapshot_id = snapshot.id
          WHERE snapshot.lease_id = position.lease_id
            AND snapshot.acknowledged_at IS NULL
            AND owned.position_token = position.token
        )`).run(leaseId, existing.fence, snapshotId);

    // The newly acknowledged snapshot is the idempotency marker. Older completed
    // snapshots need no marker; outstanding snapshots are deliberately retained.
    db.prepare(`DELETE FROM ${prefix}_authoring_snapshot
       WHERE lease_id = ? AND id <> ? AND acknowledged_at IS NOT NULL`).run(leaseId, snapshotId);
    db.prepare(`DELETE FROM ${prefix}_authoring_checkpoint AS checkpoint WHERE checkpoint.lease_id = ? AND NOT EXISTS (SELECT 1 FROM ${prefix}_authoring_position AS position WHERE position.checkpoint_id = checkpoint.id)`).run(leaseId);
    db.exec('RELEASE authoring_snapshot_acknowledge');
    return { fence: existing.fence, alreadyAcknowledged: false };
  } catch (error) {
    db.exec('ROLLBACK TO authoring_snapshot_acknowledge');
    db.exec('RELEASE authoring_snapshot_acknowledge');
    throw error;
  }
}

function rowBytes(values: Array<string | number | null | undefined>): number {
  return values.reduce<number>((total, value) => total + (value === null || value === undefined ? 0 : Buffer.byteLength(String(value))), 0);
}

// Single-statement byte accounting across the four authoring tables for one
// lease (replaces four separate full scans per check).
function retainedBytesForLease(db: Db, prefix: string, leaseId: string): number {
  const row = db.prepare(`SELECT
    (SELECT COALESCE(SUM(
      COALESCE(length(CAST(token AS BLOB)), 0)
      + COALESCE(length(CAST(lease_id AS BLOB)), 0)
      + COALESCE(length(CAST(issued_fence AS BLOB)), 0)
      + COALESCE(length(CAST(checkpoint_id AS BLOB)), 0)
      + COALESCE(length(CAST(visible_at_issue AS BLOB)), 0)
      + COALESCE(length(CAST(redactions AS BLOB)), 0)
      + COALESCE(length(CAST(created_at AS BLOB)), 0)
    ), 0) FROM ${prefix}_authoring_position WHERE lease_id = ?)
    + (SELECT COALESCE(SUM(
      length(CAST(id AS BLOB))
      + length(CAST(lease_id AS BLOB))
      + length(CAST(created_at AS BLOB))
      + length(CAST(family_checkpoint AS BLOB))
    ), 0) FROM ${prefix}_authoring_checkpoint WHERE lease_id = ?)
    + (SELECT COALESCE(SUM(
      COALESCE(length(CAST(id AS BLOB)), 0)
      + COALESCE(length(CAST(lease_id AS BLOB)), 0)
      + COALESCE(length(CAST(fence AS BLOB)), 0)
      + COALESCE(length(CAST(issued_at AS BLOB)), 0)
      + COALESCE(length(CAST(acknowledged_at AS BLOB)), 0)
    ), 0) FROM ${prefix}_authoring_snapshot WHERE lease_id = ?)
    + (SELECT COALESCE(SUM(
      length(CAST(owned.snapshot_id AS BLOB))
      + length(CAST(owned.position_token AS BLOB))
    ), 0) FROM ${prefix}_authoring_snapshot_position AS owned
      JOIN ${prefix}_authoring_snapshot AS snapshot ON snapshot.id = owned.snapshot_id
      WHERE snapshot.lease_id = ?) AS bytes`).get(leaseId, leaseId, leaseId, leaseId);
  return Number(row.bytes);
}

function retainedBytesForStream(db: Db, prefix: string, streamId: string): number {
  const row = db.prepare(`SELECT
    (SELECT COALESCE(SUM(
      COALESCE(length(CAST(position.token AS BLOB)), 0)
      + COALESCE(length(CAST(position.lease_id AS BLOB)), 0)
      + COALESCE(length(CAST(position.issued_fence AS BLOB)), 0)
      + COALESCE(length(CAST(position.checkpoint_id AS BLOB)), 0)
      + COALESCE(length(CAST(position.visible_at_issue AS BLOB)), 0)
      + COALESCE(length(CAST(position.redactions AS BLOB)), 0)
      + COALESCE(length(CAST(position.created_at AS BLOB)), 0)
    ), 0) FROM ${prefix}_authoring_position AS position
      JOIN ${prefix}_authoring_lease AS lease ON lease.id = position.lease_id
      WHERE lease.stream_id = ?)
    + (SELECT COALESCE(SUM(
      length(CAST(checkpoint.id AS BLOB))
      + length(CAST(checkpoint.lease_id AS BLOB))
      + length(CAST(checkpoint.created_at AS BLOB))
      + length(CAST(checkpoint.family_checkpoint AS BLOB))
    ), 0) FROM ${prefix}_authoring_checkpoint AS checkpoint
      JOIN ${prefix}_authoring_lease AS lease ON lease.id = checkpoint.lease_id
      WHERE lease.stream_id = ?)
    + (SELECT COALESCE(SUM(
      COALESCE(length(CAST(snapshot.id AS BLOB)), 0)
      + COALESCE(length(CAST(snapshot.lease_id AS BLOB)), 0)
      + COALESCE(length(CAST(snapshot.fence AS BLOB)), 0)
      + COALESCE(length(CAST(snapshot.issued_at AS BLOB)), 0)
      + COALESCE(length(CAST(snapshot.acknowledged_at AS BLOB)), 0)
    ), 0) FROM ${prefix}_authoring_snapshot AS snapshot
      JOIN ${prefix}_authoring_lease AS lease ON lease.id = snapshot.lease_id
      WHERE lease.stream_id = ?)
    + (SELECT COALESCE(SUM(
      length(CAST(owned.snapshot_id AS BLOB))
      + length(CAST(owned.position_token AS BLOB))
    ), 0) FROM ${prefix}_authoring_snapshot_position AS owned
      JOIN ${prefix}_authoring_snapshot AS snapshot ON snapshot.id = owned.snapshot_id
      JOIN ${prefix}_authoring_lease AS lease ON lease.id = snapshot.lease_id
      WHERE lease.stream_id = ?) AS bytes`).get(streamId, streamId, streamId, streamId);
  return Number(row.bytes);
}

function hasCapacity({ db, prefix, leaseId, bytes = 0 }: {
  db: Db;
  prefix: string;
  leaseId: string;
  bytes?: number;
}): boolean {
  if (bytes > MAX_RETAINED_PER_LEASE) return false;
  const leaseInfo = db.prepare(
    `SELECT l.stream_id, (SELECT COUNT(*) FROM ${prefix}_authoring_lease WHERE stream_id = l.stream_id) AS lease_count
       FROM ${prefix}_authoring_lease AS l
      WHERE l.id = ?`,
  ).get(leaseId) as { stream_id?: string; lease_count?: number } | undefined;
  if (!leaseInfo?.stream_id) return false;
  const leaseBytes = retainedBytesForLease(db, prefix, leaseId);
  if (leaseBytes + bytes > MAX_RETAINED_PER_LEASE) return false;
  // When this stream has only one lease (the common single-tab case), its
  // stream total equals its lease total, which is already proven <=
  // MAX_RETAINED_PER_LEASE (16 MiB) <= MAX_RETAINED_PER_STREAM (64 MiB).
  if (Number(leaseInfo.lease_count) <= 1) return true;
  return retainedBytesForStream(db, prefix, leaseInfo.stream_id) + bytes <= MAX_RETAINED_PER_STREAM;
}

export function clearStream(db: Db, prefix: string, streamId: string): void {
  const leases = db.prepare(`SELECT id FROM ${prefix}_authoring_lease WHERE stream_id = ?`).all(streamId);
  for (const lease of leases) clearLeaseChildren(db, prefix, lease.id);
  db.prepare(`DELETE FROM ${prefix}_authoring_lease WHERE stream_id = ?`).run(streamId);
  db.prepare(`DELETE FROM ${prefix}_authoring_stream WHERE id = ?`).run(streamId);
}

export function clearExpiredLeases(db: Db, prefix: string): void {
  const nowIso = now();
  const expired = db.prepare(`SELECT id FROM ${prefix}_authoring_lease WHERE expires_at <= ?`).all(nowIso);
  for (const lease of expired) {
    clearLeaseChildren(db, prefix, lease.id);
    db.prepare(`DELETE FROM ${prefix}_authoring_lease WHERE id = ?`).run(lease.id);
  }
  const orphaned = db.prepare(`SELECT s.id FROM ${prefix}_authoring_stream s WHERE NOT EXISTS (SELECT 1 FROM ${prefix}_authoring_lease l WHERE l.stream_id = s.id AND l.expires_at > ?)`).all(nowIso);
  for (const stream of orphaned) db.prepare(`DELETE FROM ${prefix}_authoring_stream WHERE id = ?`).run(stream.id);
}

export function clearAuthoringState(db: Db, prefix: string, documentId: string): void {
  const streams = db.prepare(`SELECT id FROM ${prefix}_authoring_stream WHERE document_id = ?`).all(documentId);
  for (const stream of streams) clearStream(db, prefix, stream.id);
}

export function buildAuthoringEnvelope({ streamToken, leaseToken, snapshotToken, fence, positionFrames }: {
  streamToken: string;
  leaseToken: string;
  snapshotToken: string;
  fence: number;
  positionFrames: Array<{ token: string }>;
}): {
  version: 1;
  stream: string;
  lease: string;
  snapshot: string;
  acknowledgementFence: number;
  positionFrames: Array<{ positionToken: string }>;
} {
  return {
    version: 1,
    stream: streamToken,
    lease: leaseToken,
    snapshot: snapshotToken,
    acknowledgementFence: fence,
    positionFrames: positionFrames.map((f) => ({ positionToken: f.token })),
  };
}
