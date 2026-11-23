// blob-store.mjs — durable blob storage with pending/adopted lifecycle.
//
// WRITE-COORDINATOR RED-LINE (S1/A5): blob METADATA writes enter through the
// platform write coordinator (write-queue.ts) via the CALLER'S coordinated
// transaction — never a transaction this module opens itself. `adopt` takes a
// db/txn handle and runs its UPDATE in that (already coordinated) transaction;
// `upload` is invoked from callers inside a coordinator turn (the /blobs HTTP
// route wraps it in .run; the pending-blob staged write is already inside
// .run), and `discard`/`discardPending`/`reap` are likewise called only from
// coordinated framework paths (pending-blob lifecycle, the blob reaper sweep).
// This module issues no BEGIN/COMMIT/ROLLBACK and owns no transaction control
// of its own.
//
// Upload writes atomically to a pending slot with computed hashes, then records
// a 'pending' row. Caller adopts in their txn (status → 'adopted'), then
// finalizes out-of-band (promote pending → final) via the cursor-backed
// blob-finalize consumer (blob-lifecycle.mjs) — crash recovery for a missed
// finalize replays from committed events, not from a reaper scan. The reaper
// here sweeps orphans/danglers only: bytes with no committed-event trail to
// replay from (an abandoned upload, or bytes a removed row no longer
// references).
//
// This module fuses METADATA (the BlobStore table) + LIFECYCLE (the
// pending→adopt→finalize state machine, the reaper's orphan/dangler sweep).
// The BYTE storage — where the bytes physically live — is delegated to an
// injected byte store (`bytes`), defaulting to fsBlobs (seam-review §2.2). Only
// the byte half is swappable; lifecycle + metadata are framework invariants.
//
// S6/A5 (workbench#94) adds: GENERATION REPLACEMENT (replace stages new bytes,
// switchReplacement atomically switches the owning reference inside the
// caller's coordinated turn, a failed switch leaves the old generation readable
// and authoritative, and the reaper reclaims a replaced generation only once it
// is unreferenced AND the named 'replaced-generation' retention elapsed);
// DURABLE CLEANUP STATE (a failed byte deletion is recorded on the row —
// cleanupError/cleanupAttempts — retried by the next sweep, and never reported
// complete until the pending slot, final slot, and metadata row are verified
// gone); RECYCLE ROUTING (replaced and dangling generations are binned through
// the S1/A6 recycle seam BEFORE live bytes are removed, so retained backups
// move their copies into the recoverable bin); and the LOW-DISK GUARD (new
// uploads are refused below a configurable free-disk headroom, fail closed).
//
// `workbench({ blobs: { root } })` constructs fsBlobs internally (back-compat —
// an explicit root, refused on overlap with the owned directory);
// `workbench({ blobs: byteStore })` accepts any conforming byte-store object
// (the deployment reality for a photos app is S3-compatible storage — a future
// `s3Blobs({...})` implements the same interface). With NO blobs config, a
// file-mode app's byte store roots under the owned directory's managed
// `blobs/` + `staging/` pair (S6/A2 relocation — inside the owned directory
// when one exists, beside the db file otherwise; a relative database path
// makes the owned directory cwd-relative, so the root can be cwd-relative in
// that case). A memory database uses the in-memory fake store (S6/A1).

import { createHash, randomUUID } from 'node:crypto';

import { BlobSlotNotFoundError, fsBlobs, hasPathFor,                                            } from './fs-blobs.mjs';



/** Default maximum upload size in bytes for streaming uploads (50 MiB). */
export const DEFAULT_BLOB_MAX_BYTES = 50 * 1024 * 1024;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function safeId(id         )       {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error('invalid blob id');
  }
}

































/**
 * The S1/A6 recycle seam consumed by the reaper (S6/A5). When present, a
 * replaced/dangling generation is routed to the recycling bin BEFORE its live
 * bytes are removed, so every retained backup holding the generation moves its
 * copy into the recoverable bin (bin() is idempotent per generation). The
 * concrete implementation is the S6/A6 `RecycleBlobSeam`-backed recycle
 * manager; `createRecycleManager({ blobs })` in src/backup/recycle.ts satisfies
 * this shape.
 */






                                              




                                                                       



























































































                                                    





                                                 

                                                        




                  


























                                                              

                                                           












// The retired `pathFor` (S6/A2), kept ONLY behind this explicit internal/test
// handle: absent from the portable BlobStore surface, present on the concrete
// store only when the underlying byte store exposes a path key (fs path or
// memory synthetic key). No production caller may use it to authorize, read, or
// locate bytes.

















                              











// The failure a durable byte store throws when free space is below (or
// unknowable against) the configured headroom — fail closed before a new
// upload compromises database durability (#27).
export const BLOB_STORAGE_UNDER_DISK_LIMIT = 'BLOB_STORAGE_UNDER_DISK_LIMIT';

function lowDiskError()                           {
  return Object.assign(new Error(BLOB_STORAGE_UNDER_DISK_LIMIT), { code: BLOB_STORAGE_UNDER_DISK_LIMIT });
}

export function createBlobStore({ root, stagingRoot, db, bytes, lowDiskHeadroomBytes = 0, maxBytes }                  )            {
  // The byte store owns where bytes live (node:fs by default; S3 later). It is
  // the ONLY seam for byte storage — every read/write/remove/finalize goes
  // through it. `root` is accepted for back-compat (`blobs: { root }`): when no
  // byte store is injected, fsBlobs({ root }) is the default. `bytes` may also
  // be passed directly as `root`'s replacement once a caller hands a store in.
  const store            = bytes
    ?? fsBlobs(stagingRoot ? { root: root          , stagingRoot } : { root: root           });
  const configuredMaxBytes = maxBytes ?? store.maxBytes ?? DEFAULT_BLOB_MAX_BYTES;
  if (!Number.isFinite(configuredMaxBytes) || configuredMaxBytes < 0) {
    throw new Error('invalid maxBytes');
  }
  const { writePending, writePendingStream, finalizePending, readRange, readPending, readRangeStream, readPendingStream, remove, exists } = store;

  // The low-disk guard (#27): before accepting a NEW upload, a durable byte
  // store must declare free space at or above the configured headroom — else
  // the upload is refused (fail closed) so disk headroom can never compromise
  // database durability. An ephemeral store (memoryBlobs) has no disk to guard.
  // A durable store that cannot declare free space refuses uploads: the guard
  // never guesses, and a backend that cannot prove headroom cannot prove a
  // durable commit either.
  function assertDiskHeadroom()       {
    if (store.capabilities.durability !== 'durable' || lowDiskHeadroomBytes <= 0) return;
    const freeBytes = typeof (store                                       ).freeBytes === 'function'
      ? (store                                      ).freeBytes()
      : null;
    if (freeBytes === null || freeBytes < lowDiskHeadroomBytes) throw lowDiskError();
  }

  // The metadata half shared by both upload paths: one 'pending' BlobStore row
  // for bytes that already landed (or, for upload, were just written).
  function recordPendingRow(blobId        , attested                                                     , mime               )       {
    db.prepare(
      'INSERT INTO BlobStore (id, status, md5, sha256, size, mime, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(blobId, 'pending', attested.md5, attested.sha256, attested.byteLength, mime, new Date().toISOString());
  }

  function upload({ bytes: uploadBytes, mime, id }                    = { bytes: undefined          }) {
    assertDiskHeadroom();
    let blobId = id ?? randomUUID();
    safeId(blobId);

    if (typeof uploadBytes === 'string') {
      uploadBytes = Buffer.from(uploadBytes);
    }

    const md5Hash = createHash('md5');
    const sha256Hash = createHash('sha256');
    md5Hash.update(uploadBytes);
    sha256Hash.update(uploadBytes);
    const md5 = md5Hash.digest('hex');
    const sha256 = sha256Hash.digest('hex');

    writePending(blobId, uploadBytes);
    try {
      recordPendingRow(blobId, { byteLength: uploadBytes.length, md5, sha256 }, mime ?? null);
    } catch (error) {
      // This invocation created the slot, so remove only its uncommitted bytes.
      try { if (exists(blobId, { pending: true })) remove(blobId, { pending: true }); } catch {}
      throw error;
    }

    return { id: blobId, md5, sha256, size: uploadBytes.length, mime: mime ?? null };
  }

  // adopt runs the metadata UPDATE in the CALLER'S transaction. It touches NO
  // bytes — the in-txn part of the lifecycle is metadata-only, so it can live
  // inside a BEGIN IMMEDIATE…COMMIT bracket with no await (an async byte store
  // would break that; adopt deliberately does not delegate).
  function adopt(dbOrTxn                           , id        )                      {
    safeId(id);
    const stmt = dbOrTxn.prepare('UPDATE BlobStore SET status = ? WHERE id = ? AND status = ?');
    const { changes } = stmt.run('adopted', id, 'pending');
    return { adopted: changes };
  }

  // finalize promotes the pending slot to the final slot via the byte store,
  // post-commit. Idempotent (the byte store swallows a missing pending slot) so
  // the post-commit finalize consumer and its boot-time recovery sweep can both
  // call it without racing each other.
  function finalize(id        )         {
    safeId(id);
    return finalizePending(id);
  }

  function readRangeBytes(id        , range                                 )         {
    safeId(id);
    return readRange(id, range);
  }

  // Pending-slot reads funnel to the byte store, but the ONLY production caller
  // is the pending-blob claim machinery (its durable state transition has
  // already selected a claimed generation). Not an application escape hatch —
  // the /blobs upload route returns the id, and that alone never admits a read.
  function readPendingBytes(id        , range                                 )         {
    safeId(id);
    return readPending(id, range);
  }

  function readRangeStreamBytes(id        , range                                 , options                           )           {
    safeId(id);
    return readRangeStream(id, range, options);
  }

  // Pending-slot stream read (#738 W1): funnels to the byte store exactly like
  // readPendingBytes — the ONLY production caller is the pending-blob claim
  // machinery (its durable state transition has already selected a claimed
  // generation). Not an application escape hatch.
  function readPendingStreamBytes(id        , range                                 , options                           )           {
    safeId(id);
    return readPendingStream(id, range, options);
  }

  // Stream bytes into the pending byte-store slot WITHOUT touching SQLite:
  // callers invoke this OUTSIDE the write coordinator so multi-hundred-MB
  // uploads never stall concurrent database writes.
  async function stagePendingStreamBytes(
    id        ,
    bytes                           ,
    { maxBytes: limit }                        = {},
  )                                                               {
    safeId(id);
    assertDiskHeadroom();
    const effectiveLimit = limit !== undefined ? limit : configuredMaxBytes;
    return await writePendingStream(id, bytes, { maxBytes: effectiveLimit });
  }

  // Record the 'pending' BlobStore metadata row for bytes already staged via
  // stagePendingStreamBytes. Must run inside the caller's write-coordinator turn.
  function recordPending(
    id        ,
    attested                                                     ,
    { mime = null }                           = {},
  )               {
    safeId(id);
    const normalizedMime = mime ?? null;
    recordPendingRow(id, attested, normalizedMime);
    return { id, md5: attested.md5, sha256: attested.sha256, size: attested.byteLength, mime: normalizedMime };
  }

  // Remove ONLY the pending byte-store slot (no SQLite mutation), for cleaning
  // up staged bytes if a coordinated metadata insert fails or aborts.
  function removePendingSlot(id        )       {
    safeId(id);
    if (exists(id, { pending: true })) remove(id, { pending: true });
  }

  // Pending-slot stream write (#738 W2): id validation + the same low-disk
  // guard as upload (a streamed payload lands on disk too), then straight to
  // the byte store — hash-while-write, mid-stream maxBytes abort. On success
  // it records the generation's 'pending' metadata row from the ATTESTED
  // values (the same row upload writes), optionally inside `coordinate` so
  // streaming I/O never holds the write queue.
  async function writePendingStreamBytes(
    id        ,
    bytes                           ,
    {
      mime,
      coordinate,
      ...limits
    }



      = {},
  ) {
    const attested = await stagePendingStreamBytes(id, bytes, limits);
    const register = () => recordPending(id, attested, { mime });
    try {
      if (coordinate) await coordinate(register);
      else register();
    } catch (error) {
      try { removePendingSlot(id); } catch {}
      throw error;
    }
    return attested;
  }

  // Pending-blob lifecycle owns removal of staged generations. This is not an
  // application escape hatch: only the package lifecycle invokes it after its
  // durable state transition has selected an unclaimed generation. Verified
  // (S6/A5 #3): the metadata row is deleted only once the pending slot is
  // confirmed gone, so a failed removal is never reported complete.
  function discardPending(id        )       {
    safeId(id);
    if (exists(id, { pending: true })) remove(id, { pending: true });
    if (exists(id, { pending: true })) throw new Error('pending blob bytes could not be removed');
    db.prepare('DELETE FROM BlobStore WHERE id = ? AND status = ?').run(id, 'pending');
  }

  // Pending-blob deletion is package-owned. Remove both locations because a
  // deletion request may race finalization and either slot may be present.
  // Verified: the row is deleted only after pending AND final slots are
  // confirmed gone — a failed byte deletion keeps the row (durable state) and
  // is never reported complete.
  function discard(id        )       {
    safeId(id);
    if (exists(id, { pending: true })) remove(id, { pending: true });
    if (exists(id, { pending: false })) remove(id, { pending: false });
    if (exists(id, { pending: true }) || exists(id, { pending: false })) {
      throw new Error('blob bytes could not be removed');
    }
    db.prepare('DELETE FROM BlobStore WHERE id = ?').run(id);
  }

  // Stage NEW bytes for an existing adopted generation (S6/A5 #1). The old
  // generation must be adopted AND readable — a failed validation (missing,
  // not adopted, unreadable, or a failed staging write) throws before anything
  // switched, leaving the old generation readable and authoritative. Validates
  // via stored metadata, slot stat, and bounded 1-byte probes so multi-hundred-MB
  // blobs are never buffered whole into RAM. The staged replacement is a normal
  // 'pending' generation the caller switches into the owning reference via
  // switchReplacement inside their coordinated txn.
  function replace(previousId        , options                   )                       {
    safeId(previousId);
    const previous = db.prepare('SELECT status, size FROM BlobStore WHERE id = ?').get(previousId)                                                  ;
    if (!previous) throw new Error(`replaced generation '${previousId}' does not exist`);
    if (previous.status !== 'adopted') {
      throw new Error(`replaced generation '${previousId}' is '${previous.status}', not adopted — refusing to stage a replacement`);
    }
    try {
      if (!exists(previousId, { pending: false })) {
        throw new BlobSlotNotFoundError();
      }
      const expectedSize = typeof previous.size === 'number' && Number.isInteger(previous.size) && previous.size >= 0
        ? previous.size
        : null;
      if (typeof store.statSlot === 'function') {
        const slotStat = store.statSlot(previousId, { pending: false });
        if (!slotStat) throw new BlobSlotNotFoundError();
        if (expectedSize !== null && slotStat.size !== expectedSize) {
          throw new Error(`blob size mismatch (expected ${expectedSize}, found ${slotStat.size})`);
        }
      }
      // Bounded readability probe: never read the entire blob into RAM.
      if (expectedSize === 0) {
        readRangeBytes(previousId, [0, 0]);
      } else {
        const head = readRangeBytes(previousId, [0, 1]);
        if (expectedSize !== null && expectedSize > 0 && head.length !== 1) {
          throw new Error('blob is truncated');
        }
        if (expectedSize !== null && expectedSize > 1) {
          const tail = readRangeBytes(previousId, [expectedSize - 1, expectedSize]);
          if (tail.length !== 1) throw new Error('blob is truncated');
        }
      }
    } catch (error) {
      throw new Error(
        `replaced generation '${previousId}' is unreadable — refusing to stage a replacement: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const staged = upload(options);
    return { id: staged.id, previousId, md5: staged.md5, sha256: staged.sha256, size: staged.size, mime: staged.mime };
  }

  // Atomically switch the generation inside the CALLER'S coordinated turn:
  // the staged replacement is adopted and the previous generation is marked
  // 'replaced' (recording the replacement + switch instant) in ONE metadata
  // pair. A failed transition (replacement not pending, previous not adopted)
  // THROWS — the caller's transaction rolls back and the old generation stays
  // readable and authoritative. Post-commit, the blob-finalize consumer
  // finalizes the replacement's bytes and the reaper reclaims the replaced
  // generation only once it is unreferenced and the named 'replaced-generation'
  // retention has elapsed.
  //
  // OWNING-REFERENCE INVARIANT (S6/A5): the switch is only ONE of the THREE
  // statements that make a replacement real — (1) this pair (adopt the new
  // generation, mark the previous 'replaced') plus (2) the caller's UPDATE of
  // the owning reference row to the new generation id. All three MUST run in
  // the SAME caller-coordinated transaction: a committed switch without the
  // owning-reference update leaves the new generation authoritative in
  // BlobStore but unreferenced by the app row (a future sweep could reap it
  // and the old generation once retention elapses); a committed owning-reference
  // update without the switch leaves the old generation authoritative but
  // unreferenced. Inside one txn, COMMIT lands all three and ROLLBACK undoes
  // all three — the pair and the owning-reference write can never drift.
  function switchReplacement(dbOrTxn                           , previousId        , newId        )                   {
    safeId(previousId);
    safeId(newId);
    const now = new Date().toISOString();
    const adopted = dbOrTxn.prepare('UPDATE BlobStore SET status = ? WHERE id = ? AND status = ?').run('adopted', newId, 'pending');
    const replaced = dbOrTxn.prepare('UPDATE BlobStore SET status = ?, replacedBy = ?, replacedAt = ? WHERE id = ? AND status = ?')
      .run('replaced', newId, now, previousId, 'adopted');
    if (adopted.changes !== 1) {
      throw new Error(`replacement generation '${newId}' is not staged as pending — the switch cannot commit`);
    }
    if (replaced.changes !== 1) {
      throw new Error(`previous generation '${previousId}' is not an adopted generation — the switch cannot commit`);
    }
    return { adopted: adopted.changes, replaced: replaced.changes };
  }

  // Record a failed byte deletion durably on the row (S6/A5 #3): the row
  // survives with its cleanup state so the next sweep retries it. It is never
  // reported complete until the removal verifies — the row is deleted only by
  // a successful, verified reap.
  function recordCleanupFailure(id        , error         )       {
    db.prepare('UPDATE BlobStore SET cleanupError = ?, cleanupAttempts = cleanupAttempts + 1 WHERE id = ?')
      .run(String((error                         )?.message ?? error), id);
  }

  // The one verified removal path for the reaper. With a recycle seam, the
  // generation is routed to the S1/A6 bin BEFORE any live byte is removed (a
  // bin failure keeps the generation durable — never a silently-kept backup
  // copy). Removal is explicit + verified: each slot that exists is removed,
  // and the metadata row is deleted only when BOTH slots are confirmed gone
  // AND the DELETE itself is confirmed to have removed the row (affected rows
  // + a follow-up existence check) — cleanup is never reported complete
  // against a row that is still there (e.g. a re-inserting trigger).
  async function attemptReap(id        , { bin = true, recycle: seam }                                               = {})                                 {
    if (bin && seam) {
      try {
        await seam.bin({ generations: [id] });
      } catch (error) {
        recordCleanupFailure(id, error);
        return 'retained';
      }
    }
    try {
      if (exists(id, { pending: true })) remove(id, { pending: true });
      if (exists(id, { pending: false })) remove(id, { pending: false });
      if (exists(id, { pending: true }) || exists(id, { pending: false })) {
        throw new Error('blob bytes could not be removed');
      }
      const { changes } = db.prepare('DELETE FROM BlobStore WHERE id = ?').run(id);
      if (changes !== 1 || db.prepare('SELECT 1 FROM BlobStore WHERE id = ?').get(id)) {
        throw new Error('blob metadata row could not be removed');
      }
      return 'reaped';
    } catch (error) {
      recordCleanupFailure(id, error);
      return 'retained';
    }
  }

  async function reap({ ttl, census, replacedRetentionMs, recycle }                 )                                                 {
    const now = Date.now();
    let orphans = 0;
    let danglers = 0;

    // The reference existence queries are compiled ONCE per sweep and shared by
    // the cleanup-retry, refcount, and replaced sweeps (a declared table that
    // is not (yet) provisioned holds no rows and so references nothing — the
    // same discipline as the pre-#94 reaper).
    const referenceQueries = prepareReferenceQueries(census);

    // ONE eligibility gate, shared by the durable-cleanup retry and the three
    // fresh sweeps (S6/A5): a row is reapable only when its STATUS's own rule
    // says so — a stale, unowned 'pending' (orphan); an unreferenced,
    // unowned 'adopted' (dangler); an unreferenced, unowned 'replaced' whose
    // retention window elapsed. A row that fails its status's rule is skipped.
    function reapKind(
      row                                                                              ,
    )                                             {
      if (row.status === 'pending') {
        if (db.prepare('SELECT 1 FROM _PendingBlob WHERE blobId = ?').get(row.id)) return 'skip';
        const createdAt = Date.parse(row.createdAt);
        if (!Number.isFinite(createdAt) || now - createdAt < ttl) return 'skip';
        return 'orphan';
      }
      if (isReferenced(referenceQueries, row.id)) return 'skip';
      if (row.status === 'adopted') {
        if (db.prepare("SELECT 1 FROM _PendingBlob WHERE blobId = ? AND status IN ('claimed', 'finalized', 'recovery-failed', 'delete-requested')").get(row.id)) return 'skip';
        return 'dangler';
      }
      if (row.status === 'replaced') {
        if (replacedRetentionMs == null || replacedRetentionMs <= 0) return 'skip';
        if (db.prepare('SELECT 1 FROM _PendingBlob WHERE blobId = ?').get(row.id)) return 'skip';
        if (!row.replacedAt || Number.isNaN(Date.parse(row.replacedAt))) return 'skip';
        if (now - Date.parse(row.replacedAt) < replacedRetentionMs) return 'skip';
        return 'replaced';
      }
      return 'skip';
    }

    // 0. Durable-cleanup retry sweep: rows carrying a previously-failed byte
    // deletion are retried — but ONLY after REVALIDATION against the same
    // eligibility rules the fresh sweeps below apply. A row re-referenced,
    // re-owned by the pending-blob pipeline, or moved back inside a retention
    // window since the failed reap is never deleted by a blind retry. Recycle
    // is re-emitted (bin() is idempotent per generation), removal is verified,
    // and only a fully-verified reap deletes the row — cleanup is never
    // reported complete until then.
    const cleanupRows = db.prepare(
      'SELECT id, status, createdAt, replacedAt FROM BlobStore WHERE cleanupError IS NOT NULL',
    ).all()                                                                                       ;
    for (const row of cleanupRows) {
      if (reapKind(row) === 'skip') continue;
      await attemptReap(row.id, { recycle });
    }

    // 1. Orphan sweep: stale pending blobs (uploaded, never adopted by any
    // committed dispatch — no committed event exists to recover them from).
    // Never routed to the recycle bin: an abandoned upload was never adopted,
    // never censused, and so never reached a backup.
    const staleDate = new Date(now - ttl).toISOString();
    const pendingRows = db.prepare(
      'SELECT id, status, createdAt, replacedAt FROM BlobStore WHERE status = ? AND createdAt < ?',
    ).all('pending', staleDate)                                                                                       ;
    for (const row of pendingRows) {
      if (reapKind(row) !== 'orphan') continue;
      if (await attemptReap(row.id, { bin: false, recycle }) === 'reaped') orphans++;
    }

    // 2. Refcount sweep: adopted blobs with no references, driven by the
    // COMPILED census (S6/A3) — no runtime scan derives blob columns anymore.
    // Each reference's existence query is prepared once per sweep; a declared
    // table that is not (yet) provisioned holds no rows and so references
    // nothing (skipped after one catalog check). Matching content hashes never
    // merge ownership (#7): every id is checked against its own references.
    const adoptedForRefcount = db.prepare(
      'SELECT id, status, createdAt, replacedAt FROM BlobStore WHERE status = ?',
    ).all('adopted')                                                                                       ;
    for (const row of adoptedForRefcount) {
      if (reapKind(row) !== 'dangler') continue;
      if (await attemptReap(row.id, { recycle }) === 'reaped') danglers++;
    }

    // 3. Replaced-generation sweep (S6/A5 #1/#2): a generation the owning
    // reference switched away from is reclaimed ONLY when it is unreferenced
    // AND the named 'replaced-generation' retention window has elapsed.
    // Absent/zero retention refuses the reap (fail closed: retention must
    // explicitly permit). A generation with a live _PendingBlob lifecycle row
    // is owned by the pending-blob pipeline and skipped here.
    if (replacedRetentionMs != null && replacedRetentionMs > 0) {
      const replacedRows = db.prepare(
        'SELECT id, status, createdAt, replacedAt FROM BlobStore WHERE status = ?',
      ).all('replaced')                                                                                       ;
      for (const row of replacedRows) {
        if (reapKind(row) !== 'replaced') continue;
        if (await attemptReap(row.id, { recycle }) === 'reaped') danglers++;
      }
    }

    return { orphans, danglers };
  }

  // Compile the census's reference existence queries ONCE per sweep. A
  // declared table that is not (yet) provisioned holds no rows and so
  // references nothing (skipped after one catalog check) — the same discipline
  // as the pre-#94 reaper, extracted so the adopted + replaced sweeps share one
  // query set.
  function prepareReferenceQueries(census            )                                                 {
    const existingTables = new Set        ();
    const tableStmt = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
    for (const ref of census.references) {
      if (!existingTables.has(ref.table) && tableStmt.get(ref.table)) existingTables.add(ref.table);
    }
    return census.references
      .filter((ref) => existingTables.has(ref.table))
      .map((ref) => ({ query: db.prepare(`SELECT 1 FROM "${ref.table}" WHERE "${ref.column}" = ? LIMIT 1`) }));
  }

  // stat surfaces the row's FULL metadata (S6/A5): replacement state
  // (replacedBy/replacedAt) and durable cleanup state (cleanupError/
  // cleanupAttempts) are visible here so ops + tests can inspect a generation's
  // lifecycle without a second call.
  function stat(id        )                           {
    safeId(id);
    const row = db.prepare(
      'SELECT id, status, md5, sha256, size, mime, createdAt, replacedBy, replacedAt, cleanupError, cleanupAttempts FROM BlobStore WHERE id = ?',
    ).get(id)                            ;
    return row;
  }

  // Durable cleanup state observability (S6/A5 #3): undefined when the row is
  // gone or never failed; otherwise the row's current cleanup/replacement
  // record. Ops and tests use this to confirm a deletion was retried and never
  // reported complete before verification.
  function cleanupState(id        )                               {
    safeId(id);
    const row = db.prepare(
      'SELECT id, status, replacedBy, replacedAt, cleanupError, cleanupAttempts FROM BlobStore WHERE id = ?',
    ).get(id)                                ;
    if (!row) return undefined;
    return {
      id: row.id,
      status: row.status,
      replacedBy: row.replacedBy ?? null,
      replacedAt: row.replacedAt ?? null,
      cleanupError: row.cleanupError ?? null,
      cleanupAttempts: row.cleanupAttempts ?? 0,
    };
  }

  function pendingCleanups()                    {
    return (db.prepare('SELECT id FROM BlobStore WHERE cleanupError IS NOT NULL').all()                         ).map((row) => row.id);
  }

  const internalHandle                          = {};
  if (hasPathFor(store)) internalHandle._pathFor = store.pathFor;

  return {
    safeId,
    upload,
    adopt,
    finalize,
    readRange: readRangeBytes,
    readPending: readPendingBytes,
    readRangeStream: readRangeStreamBytes,
    writePendingStream: writePendingStreamBytes,
    stagePendingStream: stagePendingStreamBytes,
    recordPending,
    removePendingSlot,
    readPendingStream: readPendingStreamBytes,
    maxBytes: configuredMaxBytes,
    discardPending,
    discard,
    replace,
    switchReplacement,
    reap,
    stat,
    cleanupState,
    pendingCleanups,
    capabilities: store.capabilities,
    ...internalHandle,
  };
}

// One reference is enough to keep a generation alive: the shared existence
// test used by the refcount + replaced sweeps.
function isReferenced(referenceQueries                                                , id        )          {
  for (const { query } of referenceQueries) {
    if (query.get(id)) return true;
  }
  return false;
}
