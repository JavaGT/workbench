// fs-blobs.mjs — the default byte-store plugin: blob bytes on node:fs.
//
// blob-store.mjs fuses three concerns — byte storage, metadata rows (the
// BlobStore table), and the pending→adopt→finalize lifecycle. Only the BYTE
// half should swap (deployment reality for a photos app is S3-compatible
// storage); lifecycle + metadata are framework invariants. This module is the
// narrow seam: it owns the bytes, nothing else. A future `s3Blobs({...})`
// implements the same interface.
//
// THE BYTE-STORE INTERFACE (what blob-store.mjs delegates to). Each method's
// guarantee is part of the contract — any conforming implementation must keep
// it, because the lifecycle around it depends on these semantics:
//
//   writePending(id, bytes)
//     Write `bytes` to the pending slot for `id`. Must be atomic enough that a
//     crash mid-write leaves NO partial final blob (a torn pending write is
//     fine — the reaper sweeps it; a torn FINAL write is not). `bytes` is a
//     Buffer (callers normalize strings). Synchronous here; may be async in
//     other implementations (the only call site is the /blobs upload HTTP
//     handler, already async — see app.mjs/serve.mjs).
//
//   finalizePending(id)
//     Promote the pending slot to the final slot. The durability MUST of this
//     call is scoped by `capabilities.durability`: on a `durable` backend,
//     after this returns the bytes MUST survive a process restart (an adopted
//     blob's final bytes are the product of a committed dispatch). An
//     `ephemeral` backend (memoryBlobs) conforms STRUCTURALLY — atomic
//     promotion, idempotence, readable final bytes — and documents that its
//     bytes live only in the owning process; losing them at a process boundary
//     is the declared price of `ephemeral`. Idempotent: if there is no pending
//     slot (already finalized, or never uploaded), it is a no-op — the reaper
//     and the post-commit finalize consumer both rely on this (they swallow the
//     missing-pending case rather than treating it as an error).
//
//   readRange(id, [start, end])
//     Return the FINAL-slot bytes in `[start, end)` as a Buffer. There is NO
//     fallback to the pending slot (S6/A4): an unclaimed blob id must never
//     serve bytes — pending bytes are readable ONLY through the uploader's
//     claim (src/pending-blob.mjs), via readPending below. `end` clamps to the
//     byte length; `Infinity` (or an absent/null `end`) is the accepted EOF
//     sentinel — an open-ended range reads to EOF. `start` stays strictly
//     validated: negative / non-finite / inverted bounds are rejected cleanly
//     (→ throw), never passed to the underlying store to misbehave with. A
//     slot with no bytes throws BlobSlotNotFoundError (the contract's typed
//     missing-slot signal — message is backend-specific, never matched on).
//
//   readPending(id, [start, end])
//     Return the PENDING-slot bytes in `[start, end)` as a Buffer. This is the
//     ONLY path to pending bytes; its only caller is the pending-blob claim
//     machinery after its durable state transition selected a claimed
//     generation — a claim is the admission, there is no generic pending read.
//     Same strict bounds as readRange and the same missing-slot signal
//     (BlobSlotNotFoundError).
//
//   readRangeStream(id, [start, end], { signal })
//     Stream the FINAL-slot range `[start, end)` as a Node Readable, for large
//     media. Cancellable: an AbortSignal abort destroys the stream instead of
//     delivering the rest. Same strict bounds as readRange. A conforming
//     backend may serve the whole range as one chunk (memory) or stream it
//     from real storage (fs); the guarantee is the same bytes + cancellation.
//
//   writePendingStream(id, bytes, { maxBytes })
//     Stream `bytes` (an AsyncIterable<Uint8Array>) into the pending slot
//     WITHOUT materializing the whole payload (#738 W2): chunks flow to
//     storage under natural backpressure while md5/sha256 are computed on the
//     way past. Resolves with the attested byteLength + digests of EXACTLY
//     what landed. `maxBytes` (when given) aborts MID-STREAM once exceeded. A
//     failed/aborted write removes the torn pending slot (best-effort; residue
//     is reaper-benign) — only a COMPLETED write leaves a pending slot, and
//     only finalizePending ever creates a final slot, so a torn write can
//     never become readable final bytes. Every chunk must be a Uint8Array.
//
//   remove(id, { pending })
//     Delete the pending (`pending: true`) or final (`pending: false`) slot.
//     Idempotent: a missing slot is a no-op (ENOENT swallowed) — the reaper
//     sweeps slots that may already be gone, and a rolled-back dispatch's
//     pending file is reaped without racing a concurrent finalize.
//
//   exists(id, { pending })
//     True iff the pending / final slot has bytes. Used by the reaper to
//     reconcile (an adopted blob whose pending slot still exists needs
//     finalizing) and by tests.
//
//   freeBytes()
//     OPTIONAL (S6/A5 low-disk guard): free bytes on the backend's storage, or
//     null when the backend cannot declare it. A `durable` backend implements
//     it; `ephemeral` (memory) omits it. The blob store's upload guard fails
//     closed when a durable backend cannot declare free space.
//
//   pathFor(id, { pending }) — RETIRED from the portable contract (S6/A2)
//     The physical path of a slot. No longer part of `ByteStore`: the surface
//     consumed by application code and the /blobs route must not use a physical
//     path to authorize, read, or locate bytes (an S3 implementation has no
//     path). It survives only as the test/debug-only introspection handle on
//     the CONCRETE fsBlobs/memoryBlobs stores (ByteStoreTestDebugHandle), so
//     tests can assert on the filesystem. Callers that must be
//     driver-portable do not use it.
//
//   capabilities
//     A queryable, honest declaration of what this backend guarantees:
//     durability (durable | ephemeral), atomicPromotion, rangeSupport,
//     deleteVerification (a verified backend throws on a failed remove — it
//     never reports an erasure that did not happen, #16), and a consistency
//     tag. Callers (createBlobStore) surface it; a backend must not overstate
//     it. fsBlobs declares durable + atomic + range + verified.
//
// SYNC / ASYNC: every method here is synchronous because node:fs sync APIs are
// the right tool for blob-sized writes under the single-writer discipline, and
// because `adopt` (which does NOT touch bytes — it runs the metadata UPDATE in
// the caller's transaction) must stay synchronous to live inside a BEGIN/COMMIT
// bracket with no await. The byte call sites that COULD be async (the /blobs
// upload handler, the post-commit finalize consumer, the reaper under
// writeQueue) are async at their own layer; an async implementation is a
// conforming interface as long as `adopt`-adjacent byte ops are not awaited
// inside a metadata transaction. The interface therefore permits async
// implementations; fsBlobs itself returns sync functions.

import {
  mkdirSync,
  writeFileSync,
  unlinkSync,
  openSync,
  linkSync,
  readSync,
  closeSync,
  existsSync,
  statSync,
  statfsSync,
  createReadStream,
  createWriteStream,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;





// ─── capability declaration ────────────────────────────────────────────────

// Durability of a byte store: `durable` bytes survive a process restart;
// `ephemeral` bytes live only within the owning process.


// Consistency tag a backend declares for its byte storage. `single-node-strong`
// is the only tag shipped; multi-node backends would declare a different one.


// A backend's closed, queryable declaration of what it guarantees. A backend
// must declare honestly — lifecycle code and callers can branch on it.








// ─── the byte-store contract ────────────────────────────────────────────────
// Each method's guarantee is PART OF THE TYPE: any conforming implementation
// must keep it, because the lifecycle in blob-store.ts depends on these
// semantics. See the module header for the narrative version.

// The contract's typed MISSING-SLOT signal. A conforming backend MUST throw an
// instance of this (never a bare Error) when a read targets a slot that has no
// bytes — the pending-blob claim machinery distinguishes "the pending slot is
// gone, read the final slot" from "the bytes failed to read" by this TYPE,
// never by a message string: a conforming backend phrases its message however
// it likes (ENOENT-style, S3 "NoSuchKey", …). Callers must never treat any
// other error as a missing slot.
export class BlobSlotNotFoundError extends Error {
  constructor(message = 'blob not found') {
    super(message);
    this.name = 'BlobSlotNotFoundError';
  }
}

// The typed signal writePendingStream throws when the streamed payload exceeds
// `maxBytes` — raised MID-STREAM (the write aborts as soon as the bound is
// crossed, never after buffering the whole payload). Carries both the limit
// and the byte count received when the abort fired. Consumers branch on this
// TYPE, never on a message string, exactly like BlobSlotNotFoundError.
export class BlobTooLargeError extends Error {
           limit        ;
           received        ;
  constructor(limit        , received         ) {
    super(received === undefined ? `blob exceeds ${limit} bytes` : `blob exceeds ${limit} bytes (received ${received})`);
    this.name = 'BlobTooLargeError';
    this.limit = limit;
    this.received = received ?? limit;
  }
}







                                             









                                                  



                                                           













                            
            


                 








                                                      



                       





                       




















                                                                      

















                               

























                                                    








// TEST/DEBUG-ONLY introspection handle — pathFor was RETIRED from the portable
// ByteStore surface (S6/A2): no production caller may use a physical path to
// authorize, read, or locate bytes. It survives only on the concrete
// fsBlobs/memoryBlobs stores so tests can assert on the filesystem. An S3
// implementation has no path; it may return a synthetic key or throw if called.




/** True when a byte store still exposes the retired test/debug path handle. */
export function hasPathFor(store           )                                                {
  return typeof (store                                    ).pathFor === 'function';
}

function safeId(id         )       {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error('invalid blob id');
  }
}

// The error a cancelled stream surfaces, shaped like Node's AbortError (name
// 'AbortError', message 'The operation was aborted') so callers and tests treat
// cancellation uniformly whether the backend is fs or memory.
function abortError()        {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export { abortError };





















// Range validation shared by every byte read (buffered and streaming) across
// conforming backends, so the strict-bound guarantees are ONE code path. Reads
// reject negative / non-finite / non-integer / inverted bounds cleanly (→
// throw) rather than handing a bogus position to the underlying store; the
// upper bound clamps to the byte length, so `null`/`undefined` end (and
// open-ended → EOF via Infinity) mean "to the end". Infinity stays an EOF
// sentinel ONLY for `end` — an Infinity `start` is rejected.
export function validateBlobRange(
  size        ,
  [start, end]                                ,
)                                                 {
  const startValue = start ?? 0;
  if (!Number.isFinite(startValue) || startValue < 0 || !Number.isInteger(startValue)) {
    throw new Error('invalid blob range: start');
  }
  const endValue = end == null ? size : Math.min(end, size);
  if (!Number.isFinite(endValue) || endValue < 0 || !Number.isInteger(endValue)) {
    throw new Error('invalid blob range: end');
  }
  if (endValue < startValue) {
    throw new Error('invalid blob range: end < start');
  }
  return { start: startValue, end: endValue, length: endValue - startValue };
}

export function fsBlobs({ root, stagingRoot, maxBytes: defaultMaxBytes }                )                                       {
  if (defaultMaxBytes !== undefined && (!Number.isFinite(defaultMaxBytes) || defaultMaxBytes < 0)) {
    throw new Error('invalid maxBytes');
  }
  mkdirSync(root, { recursive: true });
  if (stagingRoot) mkdirSync(stagingRoot, { recursive: true });

  const capabilities                        = {
    durability: 'durable',
    atomicPromotion: true,
    rangeSupport: true,
    deleteVerification: true,
    consistency: 'single-node-strong',
  };

  // Final slots live at <root>/<id>. Pending slots stage at <stagingRoot>/<id>
  // when a staging root is given (the managed layout: blobs/ + staging/ siblings
  // under the owned directory), or at <root>/<id>.pending otherwise (the legacy
  // back-compat layout for explicit roots).
  function pathFor(id        , { pending }                    = {})         {
    if (pending) return stagingRoot ? path.join(stagingRoot, id) : path.join(root, id + '.pending');
    return path.join(root, id);
  }

  function writePending(id        , bytes            )       {
    safeId(id);
    if (existsSync(pathFor(id, { pending: true })) || existsSync(pathFor(id))) {
      throw new Error(`blob id '${id}' already exists`);
    }
    writeFileSync(pathFor(id, { pending: true }), bytes, { flag: 'wx' });
  }

  // The streaming pending-slot write (#738 W2). One shared pipeline: the
  // source iterable feeds a metering Transform that (a) hashes each chunk on
  // the way past and (b) aborts MID-STREAM once maxBytes is exceeded. fs
  // backpressure bounds in-flight memory to the pipe buffer — the payload is
  // never materialized as one whole buffer. On any failure the torn pending
  // file is removed (best-effort; residue is reaper-benign), so only a
  // COMPLETED write leaves a pending slot.
  async function writePendingStream(
    id        ,
    bytes                           ,
    { maxBytes }                        = {},
  )                                                               {
    safeId(id);
    if (maxBytes !== undefined && (!Number.isFinite(maxBytes) || maxBytes < 0)) {
      throw new Error('invalid maxBytes');
    }
    const md5Hash = createHash('md5');
    const sha256Hash = createHash('sha256');
    let byteLength = 0;
    const filePath = pathFor(id, { pending: true });
    let openedByThisWrite = false;
    let outputFd                    ;
    try {
      // Reserve the slot synchronously so collision cleanup can never remove
      // bytes owned by another invocation.
      outputFd = openSync(filePath, 'wx');
      openedByThisWrite = true;
      const output = createWriteStream(filePath, { fd: outputFd, autoClose: true });
      await pipeline(
        Readable.from(bytes),
        async function* meter(source) {
          for await (const chunk of source) {
            if (!(chunk instanceof Uint8Array)) throw new TypeError('streamed blob chunk must be Uint8Array');
            const size = byteLength + chunk.length;
            if (maxBytes !== undefined && size > maxBytes) throw new BlobTooLargeError(maxBytes, size);
            byteLength = size;
            md5Hash.update(chunk);
            sha256Hash.update(chunk);
            yield chunk;
          }
        },
        output,
      );
    } catch (error) {
      // Torn pending slot: remove it so no readable partial slot survives the
      // failure (the reaper treats residue as benign either way).
      if (openedByThisWrite) {
        try { unlinkSync(filePath); } catch {}
      } else if (outputFd !== undefined) {
        try { closeSync(outputFd); } catch {}
      }
      throw error;
    }
    return { byteLength, sha256: sha256Hash.digest('hex'), md5: md5Hash.digest('hex') };
  }

  function finalizePending(id        )         {
    safeId(id);
    const pendingPath = pathFor(id, { pending: true });
    const finalPath = pathFor(id);
    if (existsSync(finalPath)) {
      if (existsSync(pendingPath)) throw new Error(`blob id '${id}' has conflicting pending and final slots`);
      return finalPath;
    }
    if (!existsSync(pendingPath)) return finalPath;
    // link+unlink promotes without rename's overwrite semantics. A final slot
    // can never be replaced by a later upload generation.
    linkSync(pendingPath, finalPath);
    unlinkSync(pendingPath);
    return finalPath;
  }

  function resolveFinalSlot(id        )         {
    const finalPath = pathFor(id);
    if (!existsSync(finalPath)) throw new BlobSlotNotFoundError();
    return finalPath;
  }

  function readSlot(filePath        , range                                )         {
    const fileSize = statSync(filePath).size;
    const { start: startValue, length } = validateBlobRange(fileSize, range);
    if (length === 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(length);
    const fd = openSync(filePath, 'r');
    try {
      readSync(fd, buffer, 0, length, startValue);
    } finally {
      // sync fds are raw OS descriptors Node will NOT GC — close deterministically.
      closeSync(fd);
    }
    return buffer;
  }

  function readRange(id        , range                                 )         {
    safeId(id);
    return readSlot(resolveFinalSlot(id), range ?? []);
  }

  function readPending(id        , range                                 )         {
    safeId(id);
    const pendingPath = pathFor(id, { pending: true });
    if (!existsSync(pendingPath)) throw new BlobSlotNotFoundError();
    return readSlot(pendingPath, range ?? []);
  }

  // The streaming final-slot read. createReadStream uses an INCLUSIVE `end`, so
  // the half-open range's exclusive end is lowered by one; an empty range (or
  // an already-aborted signal) yields a stream that errors instead of reading.
  function readRangeStream(
    id        ,
    range                                 ,
    { signal }                           = {},
  )           {
    safeId(id);
    const filePath = resolveFinalSlot(id);
    const fileSize = statSync(filePath).size;
    const { start: startValue, end: endValue, length } = validateBlobRange(fileSize, range ?? []);
    if (length === 0) return Readable.from([]);
    if (signal?.aborted) {
      const stream = Readable.from([]);
      stream.destroy(abortError());
      return stream;
    }
    return createReadStream(filePath, { start: startValue, end: endValue - 1, signal });
  }

  // The streaming pending-slot read (#738 W1): identical shape to
  // readRangeStream over the PENDING slot. The typed missing-slot check runs
  // BEFORE any stream is created, so a claim-gated caller sees
  // BlobSlotNotFoundError synchronously — never a stream that errors later.
  function readPendingStream(
    id        ,
    range                                 ,
    { signal }                           = {},
  )           {
    safeId(id);
    const filePath = pathFor(id, { pending: true });
    if (!existsSync(filePath)) throw new BlobSlotNotFoundError();
    const fileSize = statSync(filePath).size;
    const { start: startValue, end: endValue, length } = validateBlobRange(fileSize, range ?? []);
    if (length === 0) return Readable.from([]);
    if (signal?.aborted) {
      const stream = Readable.from([]);
      stream.destroy(abortError());
      return stream;
    }
    return createReadStream(filePath, { start: startValue, end: endValue - 1, signal });
  }

  function remove(id        , { pending }                       = { pending: false })       {
    safeId(id);
    const filePath = pathFor(id, { pending });
    try {
      unlinkSync(filePath);
    } catch (err) {
      // Idempotent: a slot that is already gone is a no-op.
      if ((err                         ).code !== 'ENOENT') throw err;
    }
  }

  function exists(id        , { pending }                       = { pending: false })          {
    safeId(id);
    return existsSync(pathFor(id, { pending }));
  }

  function statSlot(id        , { pending }                    = {})                          {
    safeId(id);
    try {
      return { size: statSync(pathFor(id, { pending })).size };
    } catch (err) {
      if ((err                         ).code === 'ENOENT') return null;
      throw err;
    }
  }

  // Free bytes on the filesystem holding the final slots, via statfs (bavail ×
  // frsize = bytes available to this process). Throws never — an unreadable
  // statfs returns null so the caller can fail closed.
  function freeBytes()                {
    try {
      const stat = statfsSync(root);
      return stat.bavail * stat.frsize;
    } catch {
      return null;
    }
  }

  return {
    capabilities,
    ...(defaultMaxBytes !== undefined ? { maxBytes: defaultMaxBytes } : {}),
    writePending,
    writePendingStream,
    finalizePending,
    readRange,
    readPending,
    readRangeStream,
    readPendingStream,
    remove,
    exists,
    statSlot,
    freeBytes,
    pathFor,
  };
}
