import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { txn,               } from './driver.mjs';
import { readSeq } from './committed-log.mjs';
import { principalKeyOf,                } from './principal.mjs';


import { retentionMs,                            } from './blob-retention.mjs';
import { BlobSlotNotFoundError } from './fs-blobs.mjs';

function failure(code        )        { const error = new Error(code)                             ; error.code = code; throw error; }
function token()         { return randomBytes(32).toString('base64url'); }
function hash(value        )         { return createHash('sha256').update(value).digest('hex'); }

function principalKey(principal           )         {
  const key = principalKeyOf(principal);
  if (!key) failure('UNAUTHENTICATED');
  return key;
}

















export function declaredBlobField(field         )                    {
  const candidate = field                                                                                                                                                                                                                                                     ;
  const keys = candidate && typeof candidate === 'object' ? Object.keys(candidate) : [];
  const canonicalEventMetadata = candidate?.canonicalEventMetadata;
  const metadataKeys = canonicalEventMetadata && typeof canonicalEventMetadata === 'object' ? Object.keys(canonicalEventMetadata) : [];
  const validPath = (path         )                   => Array.isArray(path) && path.length > 0
    && path.every((part) => typeof part === 'string' && part.length > 0 && !['__proto__', 'prototype', 'constructor'].includes(part));
  const isErasureCategory = (value         )                               =>
    value === 'deletable' || value === 'retained' || value === 'derived';
  const isOwnership = (value         )                         =>
    value === 'exclusive' || value === 'shared';
  const isLifecycleKind = (value         )                             =>
    value === 'pending' || value === 'adopt' || value === 'finalize';
  if (!candidate || typeof candidate.actionName !== 'string' || typeof candidate.field !== 'string'
    || typeof candidate.resourceField !== 'string'
    || typeof candidate.owningResource !== 'string' || !candidate.owningResource
    || !isErasureCategory(candidate.erasureCategory)
    || keys.some((key) => !['actionName', 'field', 'resourceField', 'purgeActionName', 'owningResource', 'erasureCategory', 'ownership', 'lifecycle', 'canonicalEventMetadata'].includes(key))
    || (candidate.purgeActionName !== undefined && typeof candidate.purgeActionName !== 'string')
    || (candidate.ownership !== undefined && !isOwnership(candidate.ownership))
    || (candidate.lifecycle !== undefined && !isLifecycleKind(candidate.lifecycle))
    || (canonicalEventMetadata !== undefined && (!canonicalEventMetadata || typeof canonicalEventMetadata !== 'object'
      || metadataKeys.length === 0 || metadataKeys.some((key) => !['byteLength', 'mediaType'].includes(key))
      || metadataKeys.some((key) => !validPath((canonicalEventMetadata                           )[key]))))) {
    throw new TypeError('declaredBlobField requires actionName, field, resourceField, owningResource, and erasureCategory');
  }
  const fieldValue = candidate                     ;
  return Object.freeze({ ...fieldValue, ...(canonicalEventMetadata === undefined ? {} : {
    canonicalEventMetadata: Object.freeze(Object.fromEntries(metadataKeys.map((key) => [key, Object.freeze([...(canonicalEventMetadata                                     )[key]])]))),
  }) });
}








/**
 * The S1/A6 recycle seam the delete path routes through (S6/A5): when the app
 * owns a recycle manager (`createRecycleManager` over the backup root with the
 * S6/A6 blob seam), a deleted generation is binned BEFORE its live bytes are
 * removed — every retained backup holding the generation moves its copy into
 * the recoverable recycle bin (idempotent per generation). See
 * BlobRecycleSeam in blob-store.ts — the recycle manager satisfies this shape.
 */










                                       






































/**
 * A bounded read view over ONE staged generation, served only to the claim
 * that staged it (#691). Between staging and dispatch-commit the durable row
 * is 'pending' — unreadable through {@link PendingBlobLifecycle.readClaimed} —
 * yet the stager may need the exact staged bytes BEFORE committing (probing
 * media to decide a transcode). The stage claim IS the capability: every read
 * re-proves the stager principal AND the claim token, size/digest come from
 * the durable attested row (never a fresh whole-generation read), and ranges
 * bound each call's memory instead of materializing the full blob.
 */





















































                                                     




                         












export function createPendingBlobLifecycle(app                , options                             )                       {
  const fields = (options?.fields ?? []).map(declaredBlobField);
  if (!Number.isFinite(options?.pendingTtlMs) || options.pendingTtlMs < 0 || !Number.isFinite(options?.adoptedRecoveryTtlMs) || options.adoptedRecoveryTtlMs < 0) {
    throw new TypeError('blobLifecycle requires non-negative pendingTtlMs and adoptedRecoveryTtlMs');
  }
  const byActionField = new Map(fields.map((field)                              => [`${field.actionName}:${field.field}`, field]));
  if (byActionField.size !== fields.length) throw new TypeError('blobLifecycle fields must not contain duplicate actionName/field pairs');
  async function stage(principal           , request                         )                             {
    const candidate = request                                       ;
    if (!candidate || typeof candidate.scopeId !== 'string' || !candidate.scopeId || typeof candidate.resourceId !== 'string' || !candidate.resourceId) throw new TypeError('scopeId and resourceId are required');
    const authenticatedPrincipalKey = principalKey(principal);
    if (candidate.scopeId.includes('/') || candidate.scopeId === '.' || candidate.scopeId === '..' || candidate.resourceId.includes('/') || candidate.resourceId === '.' || candidate.resourceId === '..') throw new TypeError('scopeId and resourceId must be single safe path segments');
    const direct = candidate.bytes instanceof Uint8Array ? candidate.bytes : undefined;
    // Async wrapper: the uniform AsyncIterable shape both backends stream from.
    const source = direct
      ? (async function* one() { yield direct; })()
      : candidate.bytes;
    if (!source || typeof (source                             )[Symbol.asyncIterator] !== 'function') throw new TypeError('bytes must be Uint8Array or AsyncIterable<Uint8Array>');

    const pendingKey = `${candidate.scopeId}/${candidate.resourceId}.${hash(authenticatedPrincipalKey)}.pending`;
    // Fast-fail read check before streaming potentially hundreds of megabytes
    // to disk. Uniqueness is still enforced atomically inside writeQueue.run
    // below so concurrent staging races cannot collide.
    const existing = app.db.prepare('SELECT 1 FROM _PendingBlob WHERE pendingKey = ?').get(pendingKey);
    if (existing) failure('PENDING_KEY_EXISTS');

    // The streamed write path (#738 W2 / #287): bytes NEVER materialize as one
    // whole buffer AND disk streaming + hashing run OUTSIDE app.writeQueue.run
    // so concurrent SQLite writes commit without stalling during large uploads.
    // The write queue is acquired ONLY for the sub-millisecond SQLite metadata
    // inserts, and any staged bytes are removed on disk if metadata commit fails.
    const blobId = randomUUID();
    const maxBytes = candidate.maxBytes ?? options.maxBytes;
    const claimToken = token();
    const claimTokenHash = hash(claimToken);

    if (typeof app.blobs.stagePendingStream === 'function' && typeof app.blobs.recordPending === 'function') {
      const attested = await app.blobs.stagePendingStream(
        blobId,
        source                             ,
        maxBytes !== undefined ? { maxBytes } : undefined,
      );
      try {
        await app.writeQueue.run(() => txn(app.db, () => {
          const raced = app.db.prepare('SELECT 1 FROM _PendingBlob WHERE pendingKey = ?').get(pendingKey);
          if (raced) failure('PENDING_KEY_EXISTS');
          app.blobs.recordPending(blobId, attested, { mime: candidate.mediaType });
          app.db.prepare(`INSERT INTO _PendingBlob
            (pendingKey, blobId, claimTokenHash, principalKey, resourceId, contentDigest, byteLength, status, scopeId, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
            .run(pendingKey, blobId, claimTokenHash, authenticatedPrincipalKey, candidate.resourceId, attested.sha256, attested.byteLength, candidate.scopeId, new Date().toISOString());
        }));
      } catch (error) {
        try {
          if (typeof app.blobs.removePendingSlot === 'function') app.blobs.removePendingSlot(blobId);
          else app.blobs.discardPending(blobId);
        } catch {}
        throw error;
      }
      return Object.freeze({ claim: Object.freeze({ pendingKey, claimToken }), pendingKey, byteLength: attested.byteLength, contentDigest: attested.sha256 });
    }

    // Fallback for minimal test doubles that only implement writePendingStream.
    const attested = await app.blobs.writePendingStream(
      blobId,
      source                             ,
      { mime: candidate.mediaType, ...(maxBytes !== undefined ? { maxBytes } : {}) },
    );
    try {
      await app.writeQueue.run(() => {
        const raced = app.db.prepare('SELECT 1 FROM _PendingBlob WHERE pendingKey = ?').get(pendingKey);
        if (raced) failure('PENDING_KEY_EXISTS');
        app.db.prepare(`INSERT INTO _PendingBlob
          (pendingKey, blobId, claimTokenHash, principalKey, resourceId, contentDigest, byteLength, status, scopeId, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
          .run(pendingKey, blobId, claimTokenHash, authenticatedPrincipalKey, candidate.resourceId, attested.sha256, attested.byteLength, candidate.scopeId, new Date().toISOString());
      });
    } catch (error) {
      try { app.blobs.discardPending(blobId); } catch {}
      throw error;
    }
    return Object.freeze({ claim: Object.freeze({ pendingKey, claimToken }), pendingKey, byteLength: attested.byteLength, contentDigest: attested.sha256 });
  }
  async function validateClaim({ claim, field, resourceId, actionName, actionId, authenticatedPrincipal, scopeId, committedEventId }                   )                       {
    const candidate = claim                                                              ;
    if (!candidate || typeof candidate.pendingKey !== 'string' || typeof candidate.claimToken !== 'string') failure('INVALID_PENDING_BLOB_CLAIM');
    const row = app.db.prepare('SELECT * FROM _PendingBlob WHERE pendingKey = ?').get(candidate.pendingKey)                              ;
    if (!row || !timingSafeEqual(Buffer.from(hash(candidate.claimToken)), Buffer.from(row.claimTokenHash))) failure('INVALID_PENDING_BLOB_CLAIM');
    const declaration = byActionField.get(`${actionName}:${field}`);
    if (!declaration) failure('UNDECLARED_BLOB_FIELD');
    if (row.principalKey !== principalKey(authenticatedPrincipal)) failure('PENDING_BLOB_WRONG_PRINCIPAL');
    if (row.scopeId !== scopeId) failure('PENDING_BLOB_WRONG_SCOPE');
    if (row.resourceId !== resourceId) failure('PENDING_BLOB_WRONG_RESOURCE');
    const metadata = app.blobs.stat(row.blobId);
    if (!metadata || metadata.sha256 !== row.contentDigest || metadata.size !== row.byteLength) failure('BLOB_UNAVAILABLE');
    const claimedBlob              = Object.freeze({ blobId: row.blobId, resourceId: row.resourceId, sha256: metadata.sha256, md5: metadata.md5, byteLength: metadata.size, mediaType: metadata.mime });
    if (row.status === 'claimed' && row.actionId === actionId) return claimedBlob;
    if (row.status !== 'pending') failure('PENDING_BLOB_ALREADY_CLAIMED');
    if (Date.now() - Date.parse(row.createdAt) >= options.pendingTtlMs) failure('PENDING_BLOB_EXPIRED');
    const claimed = app.db.prepare(`UPDATE _PendingBlob SET status = 'claimed', actionId = ?, committedEventId = ?, scopeId = ?, claimedAt = ?
      WHERE pendingKey = ? AND status = 'pending'`).run(actionId, committedEventId, scopeId, new Date().toISOString(), row.pendingKey);
    if (!claimed.changes) failure('PENDING_BLOB_ALREADY_CLAIMED');
    // BlobStore adoption is metadata-only and shares the dispatch transaction
    // with the claim, event log, projection, and receipt.
    if (app.blobs.adopt(app.db, row.blobId).adopted !== 1) failure('BLOB_UNAVAILABLE');
    return claimedBlob;
  }
  async function requestDeletion({ blobId, resourceId, actionName, actionId, scopeId }                     )                   {
    const declaration = fields.find((field) => field.purgeActionName === actionName);
    if (!declaration) return false;
    if (typeof blobId !== 'string') failure('INVALID_CLAIMED_BLOB_REF');
    const row = app.db.prepare('SELECT * FROM _PendingBlob WHERE blobId = ?').get(blobId)                              ;
    if (!row || row.status === 'deleted') failure('BLOB_NOT_FOUND');
    if (row.scopeId !== scopeId) failure('BLOB_DELETE_WRONG_SCOPE');
    if (row.resourceId !== resourceId) failure('BLOB_DELETE_WRONG_RESOURCE');
    if (row.status === 'delete-requested') return true;
    const changed = app.db.prepare(`UPDATE _PendingBlob SET status = 'delete-requested', deleteActionId = ?, deletedAt = ?
      WHERE blobId = ? AND status IN ('claimed', 'finalized', 'recovery-failed')`).run(actionId, new Date().toISOString(), blobId);
    if (!changed.changes) failure('BLOB_DELETE_CONFLICT');
    return true;
  }
  function markRecoveryFailure(row                , error         )       {
    const claimedAt = Date.parse(row.claimedAt ?? row.createdAt);
    const expired = Number.isFinite(claimedAt) && Date.now() - claimedAt >= options.adoptedRecoveryTtlMs;
    app.db.prepare(`UPDATE _PendingBlob SET recoveryFailure = ?, status = CASE WHEN ? THEN 'recovery-failed' ELSE status END
      WHERE pendingKey = ?`).run(String((error                         )?.message ?? error), expired ? 1 : 0, row.pendingKey);
  }
  // The claim-gated byte read (S6/A4 #1): a CLAIMED generation's bytes live in
  // the pending slot until reconcile finalizes them, then in the final slot.
  // The byte store serves no generic pending→final fallback for unclaimed
  // reads, so this resolves the slot explicitly — pending first (the common
  // claimed-but-not-yet-finalized case), final when the pending slot is already
  // gone (finalized, or finalized-but-status-update-lost). The caller has
  // already admitted the claim; this is never a public escape hatch. The
  // pending→final fallback keys on the byte store's TYPED missing-slot signal
  // (BlobSlotNotFoundError), never on a message string — a conforming backend
  // may phrase a missing slot however it likes.
  function readGeneration(blobId        , range                                 )         {
    try {
      return app.blobs.readPending(blobId, range);
    } catch (error) {
      if (!(error instanceof BlobSlotNotFoundError)) throw error;
      return app.blobs.readRange(blobId, range);
    }
  }
  // The streaming twin of readGeneration's slot fallback (#738 W1): pending
  // first (the common claimed-but-not-yet-finalized case), final when the
  // typed missing-slot signal says the pending slot is gone. Both stream reads
  // throw BlobSlotNotFoundError synchronously BEFORE any stream exists, so the
  // fallback decision happens before streaming starts — identical semantics to
  // the buffered fallback, never a message-string branch.
  function streamGeneration(blobId        , range                                 , signal              )           {
    try {
      return app.blobs.readPendingStream(blobId, range, { signal });
    } catch (error) {
      if (!(error instanceof BlobSlotNotFoundError)) throw error;
      return app.blobs.readRangeStream(blobId, range, { signal });
    }
  }
  // Record a delete-path retry WITHOUT the status flip markRecoveryFailure
  // performs: a 'delete-requested' row must stay 'delete-requested' so the
  // next reconcile sweep retries it. Flipping it to 'recovery-failed' (after
  // adoptedRecoveryTtlMs) would strand the deletion forever — that flip is for
  // claimed/finalize recovery only.
  function recordDeleteRetry(row                , error         )       {
    app.db.prepare('UPDATE _PendingBlob SET recoveryFailure = ? WHERE pendingKey = ?')
      .run(String((error                         )?.message ?? error), row.pendingKey);
  }

  // The named deleted-file / privacy-erasure wait for a delete-requested row
  // (S6/A5 #21): the live bytes of a deleted generation are removed only once
  // the applicable cleanup window has elapsed (0 = immediate, the default).
  // An erasure-class purge (erasureCategory 'retained'/'derived') waits under
  // the 'privacy-erasure' policy; ordinary deletions under 'deleted-file'. The
  // class is read from the durable delete receipt's actionType, so a restart
  // never re-classifies a deletion differently.
  function deletionCleanupWaitMs(row                )         {
    const policies = app.retentionPolicies;
    if (!policies) return 0;
    let erasure = false;
    if (row.deleteActionId && row.scopeId) {
      const receipt = app.db.prepare('SELECT actionType FROM _ActionReceipt WHERE scope = ? AND actionId = ?')
        .get(row.scopeId, row.deleteActionId)                                       ;
      const declaration = receipt?.actionType
        ? fields.find((field) => field.purgeActionName === receipt.actionType)
        : undefined;
      erasure = declaration !== undefined && declaration.erasureCategory !== 'deletable';
    }
    return retentionMs(policies, erasure ? 'privacy-erasure' : 'deleted-file');
  }

  // The delete path (S6/A5 #4): bin the generation through the S1/A6 recycle
  // seam (when one is owned) BEFORE any live byte is removed, then discard the
  // live bytes, emit the derived-store deletion signal (when the staleness
  // bridge is engaged), and only then drop the durable row. A failure at any
  // step records durable retry state and keeps the row, so the next sweep
  // re-runs it (bin + discard + signal are all idempotent). The deletion is
  // never reported complete until the row is gone.
  async function reconcileDeletion(row                )                {
    // S6/A5 #21: within the applicable cleanup window the deletion stays
    // durably requested and nothing is removed yet — the next sweep re-checks.
    const waitMs = deletionCleanupWaitMs(row);
    if (waitMs > 0) {
      const deletedAt = Date.parse(row.deletedAt ?? row.createdAt);
      if (!Number.isFinite(deletedAt) || Date.now() - deletedAt < waitMs) return;
    }
    // Recycle BEFORE live-byte removal: a bin failure THROWS, so the durable
    // row AND the live bytes survive (retry state recorded) and the next sweep
    // retries — a generation whose binning failed is never left with its live
    // bytes already gone.
    if (app.blobRecycleSeam) {
      await app.blobRecycleSeam.bin({ generations: [row.blobId] });
    }
    app.blobs.discard(row.blobId);
    if (app.searchStaleness) {
      // Post-commit proof: the delete action's committedAt from the receipt,
      // falling back to the durable deletedAt (the instant the delete was
      // requested inside the committed action turn) — never a timestamp that
      // could precede commit.
      const receipt = app.db.prepare('SELECT committedAt FROM _ActionReceipt WHERE scope = ? AND actionId = ?')
        .get(row.scopeId, row.deleteActionId)                                        ;
      const committedAt = typeof receipt?.committedAt === 'string' && receipt.committedAt
        ? receipt.committedAt
        : (row.deletedAt ?? new Date().toISOString());
      try {
        app.searchStaleness.notifySourceChange({
          entity: 'BlobStore',
          rowId: row.blobId,
          kind: 'removed',
          committedAt,
          priority: 'high',
          erasure: true,
        });
      } catch (error) {
        // Post-commit isolation: a signal failure never undoes the discard, but
        // it MUST be retried — the durable row stays (outer catch records the
        // retry) so the derived store is told about the deletion before this
        // row is gone.
        throw error;
      }
    }
    app.db.prepare("DELETE FROM _PendingBlob WHERE pendingKey = ? AND status = 'delete-requested'").run(row.pendingKey);
  }

  async function reconcile()                {
    const deleting = app.db.prepare("SELECT * FROM _PendingBlob WHERE status = 'delete-requested'").all()                               ;
    for (const row of deleting) {
      try {
        await reconcileDeletion(row);
      } catch (error) {
        recordDeleteRetry(row, error);
      }
    }
    const claimed = app.db.prepare("SELECT * FROM _PendingBlob WHERE status = 'claimed'").all()                               ;
    for (const row of claimed) {
      try {
        const bytes = readGeneration(row.blobId);
        if (bytes.length !== row.byteLength || createHash('sha256').update(bytes).digest('hex') !== row.contentDigest) {
          markRecoveryFailure(row, 'BLOB_UNAVAILABLE');
          continue;
        }
        app.blobs.finalize(row.blobId);
        app.db.prepare("UPDATE _PendingBlob SET status = 'finalized', finalizedAt = ?, recoveryFailure = NULL WHERE pendingKey = ? AND status = 'claimed'")
          .run(new Date().toISOString(), row.pendingKey);
      } catch (error) {
        // The claimed generation remains durable and readable from its verified
        // pending slot while a later boot reconciliation retries finalization.
        markRecoveryFailure(row, error);
      }
    }
  }
  async function reap()                {
    const stale = new Date(Date.now() - options.pendingTtlMs).toISOString();
    await txn(app.db, () => {
      const rows = app.db.prepare("SELECT pendingKey, blobId FROM _PendingBlob WHERE status = 'pending' AND createdAt < ?").all(stale)                                                 ;
      for (const row of rows) {
        app.blobs.discardPending(row.blobId);
        app.db.prepare("DELETE FROM _PendingBlob WHERE pendingKey = ? AND status = 'pending'").run(row.pendingKey);
      }
    });
  }
  // Claim admission for reads (S6/A4): pending bytes are served ONLY to the
  // uploader's claim, and only once the claim was admitted (the row is
  // 'claimed'/'finalized'). A staged-but-unclaimed blob id, a missing blob, or
  // a read whose bytes fail the digest attestation all yield the SAME generic
  // BLOB_UNAVAILABLE — never a distinguishable existence signal.
  function readClaimed(blobId        , range                                 )         {
    const row = app.db.prepare("SELECT * FROM _PendingBlob WHERE blobId = ? AND status IN ('claimed', 'finalized')").get(blobId)                              ;
    if (!row) failure('BLOB_UNAVAILABLE');
    let bytes        ;
    try {
      bytes = readGeneration(blobId);
      if (bytes.length !== row.byteLength || createHash('sha256').update(bytes).digest('hex') !== row.contentDigest) throw new Error('BLOB_UNAVAILABLE');
    } catch (error) {
      markRecoveryFailure(row, error);
      failure('BLOB_UNAVAILABLE');
    }
    return range === undefined ? bytes : readGeneration(blobId, range);
  }
  // The streaming claimed read (#738 W1): the SAME claim admission as
  // readClaimed — bytes are served ONLY to a row already in
  // 'claimed'/'finalized' (the durable state transition is the admission) —
  // and the SAME slot fallback, via streamGeneration. A missing row fails with
  // BLOB_UNAVAILABLE exactly like readClaimed; a byte-store failure on the
  // selected generation records recovery failure and fails identically. No
  // digest attestation: that would materialize the whole generation, defeating
  // the stream; the claim row is the gate (see the interface doc).
  function readClaimedStream(blobId        , range                                 , { signal }                           = {})           {
    const row = app.db.prepare("SELECT * FROM _PendingBlob WHERE blobId = ? AND status IN ('claimed', 'finalized')").get(blobId)                              ;
    if (!row) failure('BLOB_UNAVAILABLE');
    try {
      return streamGeneration(blobId, range, signal);
    } catch (error) {
      markRecoveryFailure(row, error);
      failure('BLOB_UNAVAILABLE');
    }
  }
  // The staged-claim byte read (#691): between staging and dispatch-commit the
  // generation's row is 'pending' — correctly unreachable through readClaimed —
  // yet its own stager may need the exact staged bytes before the committing
  // action exists (probe media to decide a transcode). The stage claim IS the
  // capability: every call re-proves the stager principal AND the claim token
  // (timing-safe), serves only that generation's slot through the same typed
  // missing-slot fallback as readClaimed, and fails with the SAME generic
  // BLOB_UNAVAILABLE — never a derived storage path, never another principal's
  // staged bytes, never a distinguishable existence signal. Only live rows
  // serve ('pending'/'claimed'/'finalized'); delete-requested, deleted, and
  // recovery-failed rows are dark.
  function readStagedClaim(authenticatedPrincipal           , claim         )                 {
    const candidate = claim                                                              ;
    if (!candidate || typeof candidate.pendingKey !== 'string' || typeof candidate.claimToken !== 'string') failure('BLOB_UNAVAILABLE');
    const row = app.db.prepare('SELECT * FROM _PendingBlob WHERE pendingKey = ?').get(candidate.pendingKey)                              ;
    if (!row || row.status === 'delete-requested' || row.status === 'deleted' || row.status === 'recovery-failed') failure('BLOB_UNAVAILABLE');
    let claimProven = false;
    try {
      claimProven = row.claimTokenHash.length > 0
        && timingSafeEqual(Buffer.from(hash(candidate.claimToken)), Buffer.from(row.claimTokenHash));
    } catch {
      claimProven = false;
    }
    if (!claimProven || row.principalKey !== principalKey(authenticatedPrincipal)) failure('BLOB_UNAVAILABLE');
    // Size/digest come from the durable row (attested at stage time), never
    // from a fresh whole-generation read.
    return Object.freeze({
      byteLength: row.byteLength,
      sha256: row.contentDigest,
      readRange: (range                                 )         => {
        try {
          return readGeneration(row.blobId, range);
        } catch {
          failure('BLOB_UNAVAILABLE');
        }
      }
    });
  }
  function status(blobId        )                {
    const row = app.db.prepare('SELECT status FROM _PendingBlob WHERE blobId = ?').get(blobId)                                  ;
    return row?.status ?? null;
  }
  return Object.freeze({
    stage,
    validateClaim,
    requestDeletion,
    readClaimed,
    readClaimedStream,
    readStagedClaim,
    status,
    reconcile,
    reap,
    // Finalization is package-owned post-commit work. Reconciliation scans the
    // durable claim table, so a crash before this callback is equivalent to a
    // missed wake and is recovered on the next boot.
    consumer: async () => reconcile(),
    fields,
    options: Object.freeze({ ...options }),
  });
}

/**
 * Wraps a registered action's handler with the pending-blob claim lifecycle.
 * Extracted from kernel.ts so the claim grammar and attestation scan live in
 * the module that owns the blob seam; kernel only assembles the seam.
 */
export async function runDeclaredActionWithBlobClaims(args










 )               {
  const { declaration, context, lifecycle } = args;
  const deletion = lifecycle?.fields.find((field) => field.purgeActionName === declaration.type);
  if (deletion && context.payload?.[deletion.field] !== undefined) {
    const blobRef = context.payload[deletion.field];
    const blobId = typeof blobRef === 'string' ? blobRef : blobRef?.blobId;
    await lifecycle .requestDeletion({
      blobId, actionName: declaration.type, actionId: context.actionId,
      scopeId: context.scope, resourceId: context.payload?.[deletion.resourceField],
    });
  }
  let handlerContext      = context;
  const claimedFields                                                      = [];
  if (lifecycle) {
    for (const field of lifecycle.fields) {
      if (field.actionName !== declaration.type) continue;
      const committedEventId = `${context.scope}:${readSeq(context.db, context.scope) + 1}`;
      const claimedBlob = await lifecycle.validateClaim({
        claim: context.payload[field.field], field: field.field, actionName: declaration.type,
        actionId: context.actionId, authenticatedPrincipal: context.principal,
        scopeId: context.scope, resourceId: context.payload[field.resourceField], committedEventId,
      });
      const { blobId } = claimedBlob;
      claimedFields.push({ field, blobId });
      handlerContext = {
        ...handlerContext,
        payload: { ...handlerContext.payload, [field.field]: blobId },
        claimedBlobs: Object.freeze({ ...(handlerContext.claimedBlobs ?? {}), [field.field]: claimedBlob }),
      };
    }
  }
  const result = await declaration.handler(handlerContext);
  const commit      = Array.isArray(result) ? { events: result } : result;
  if (!commit || !Array.isArray(commit.events)) throw new Error(`registered action '${declaration.type}' must return an event array`);
  if (handlerContext.claimedBlobs) {
    const claimedBlobValues = Object.values(handlerContext.claimedBlobs)         ;
    const forbiddenEventMetadata = claimedBlobValues.flatMap((blob) => [blob.sha256, blob.md5, blob.byteLength, blob.mediaType]).filter((value) => value !== null);
    const forbiddenPrivateMetadata = claimedBlobValues.flatMap((blob) => [blob.resourceId, blob.sha256, blob.md5, blob.byteLength, blob.mediaType]).filter((value) => value !== null);
    const attestationKeys = new Set(['resourceId', 'sha256', 'md5', 'byteLength', 'mediaType']);
    const containsAttestationMetadata = (value     , forbidden       , seen = new Set         ())          => {
      if (typeof value !== 'object' || value === null) return forbidden.some((candidate) => Object.is(candidate, value));
      if (seen.has(value)) return false;
      seen.add(value);
      if (Array.isArray(value)) return value.some((item) => containsAttestationMetadata(item, forbidden, seen));
      const keys = Object.keys(value);
      if (keys.includes('claimedBlobs') || keys.includes('resourceId') || keys.filter((key) => attestationKeys.has(key)).length > 1) return true;
      return Object.values(value).some((item) => containsAttestationMetadata(item, forbidden, seen));
    };
    if (containsAttestationMetadata(commit.events, forbiddenEventMetadata)
      || containsAttestationMetadata({ directive: commit.directive, privateFact: commit.privateFact, effects: commit.effects }, forbiddenPrivateMetadata)) {
      throw new Error(`declared blob action '${declaration.type}' cannot serialize claimed blob metadata`);
    }
  }
  if (!lifecycle) return Array.isArray(result) ? result : {
    events: commit.events,
    ...(commit.canonicalPayload === undefined ? {} : { canonicalPayload: commit.canonicalPayload }),
    ...(commit.directive === undefined ? {} : { directive: commit.directive }),
    ...(commit.privateFact === undefined ? {} : { privateFact: commit.privateFact }),
    ...(commit.effects === undefined ? {} : { effects: commit.effects }),
    ...(commit.annotatedText === undefined ? {} : { annotatedText: commit.annotatedText }),
    ...(commit.applicationTransition === undefined ? {} : { applicationTransition: commit.applicationTransition }),
  };
  for (const { field, blobId } of claimedFields) {
    const owningEvents = commit.events.filter((event     ) => event?.scope === context.scope && event.data && Object.prototype.hasOwnProperty.call(event.data, field.field));
    if (owningEvents.length !== 1) throw new Error(`declared blob action '${declaration.type}' must emit exactly one owning event field '${field.field}' in its dispatch scope`);
    if (owningEvents[0].data[field.field] !== blobId) throw new Error(`declared blob action '${declaration.type}' must emit its canonical blob id in field '${field.field}'`);
    for (const [metadataName, path] of Object.entries(field.canonicalEventMetadata ?? {})                        ) {
      let target = owningEvents[0].data;
      for (const part of path.slice(0, -1)) {
        if (!Object.prototype.hasOwnProperty.call(target, part) || typeof target[part] !== 'object' || target[part] === null || Array.isArray(target[part])) {
          throw new Error(`declared blob action '${declaration.type}' canonical metadata path '${path.join('.')}' must already have an object parent`);
        }
        target = target[part];
      }
      const leaf = path.at(-1);
      if (Object.prototype.hasOwnProperty.call(target, leaf)) {
        throw new Error(`declared blob action '${declaration.type}' handler cannot set canonical metadata path '${path.join('.')}'`);
      }
      target[leaf] = handlerContext.claimedBlobs[field.field][metadataName];
    }
  }
  return {
    events: commit.events,
    ...(claimedFields.length === 0
      ? (commit.canonicalPayload === undefined ? {} : { canonicalPayload: commit.canonicalPayload })
      : { canonicalPayload: handlerContext.payload, claimedBlobs: handlerContext.claimedBlobs }),
    ...(commit.directive === undefined ? {} : { directive: commit.directive }),
    ...(commit.privateFact === undefined ? {} : { privateFact: commit.privateFact }),
    ...(commit.effects === undefined ? {} : { effects: commit.effects }),
    ...(commit.annotatedText === undefined ? {} : { annotatedText: commit.annotatedText }),
    ...(commit.applicationTransition === undefined ? {} : { applicationTransition: commit.applicationTransition }),
  };
}










export function pendingBlobStager(workbench                      , authenticatedPrincipal           )                    {
  const lifecycle = workbench.pendingBlobLifecycle;
  if (!lifecycle) throw new Error('blobLifecycle is not configured');
  return Object.freeze({ stage: (request                         ) => lifecycle.stage(authenticatedPrincipal, request) });
}

export function readClaimedBlob(workbench                      , blobId        )         {
  const lifecycle = workbench.pendingBlobLifecycle;
  if (!lifecycle) throw new Error('blobLifecycle is not configured');
  return lifecycle.readClaimed(blobId);
}

// Capability-gated staged-bytes reader for the stager's own pre-commit probe
// (#691): the claim returned by pendingBlobStager().stage() is the only
// credential, so an application never derives a storage path and never reads
// an unclaimed pending blob it did not stage.
export function stagedBlobReader(
  workbench                      ,
  authenticatedPrincipal           ,
  claim
)                 {
  const lifecycle = workbench.pendingBlobLifecycle;
  if (!lifecycle) throw new Error('blobLifecycle is not configured');
  return lifecycle.readStagedClaim(authenticatedPrincipal, claim);
}












export function claimedBlobLifecycle(workbench                      )                       {
  const lifecycle = workbench?.pendingBlobLifecycle;
  if (!lifecycle) throw new Error('blobLifecycle is not configured');

  const inspect = (blobId        )                            => {
    const status = lifecycle.status(blobId);
    if (status === null || status === 'deleted') return Object.freeze({ kind: 'missing' });
    if (status === 'recovery-failed') return Object.freeze({ kind: 'failed' });
    if (status !== 'finalized') return Object.freeze({ kind: 'pending' });
    try {
      lifecycle.readClaimed(blobId);
      return Object.freeze({
        kind: 'available',
        readRange: (range                                 ) => lifecycle.readClaimed(blobId, range),
      });
    } catch {
      return Object.freeze({ kind: 'failed' });
    }
  };

  return Object.freeze({
    inspect,
    reconcile: () => workbench.writeQueue.run(() => lifecycle.reconcile()),
  });
}
