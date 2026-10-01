// blob-seams.ts — S6/A6 the concrete backup/recovery/recycle blob seams
// (workbench#97, epic scope#23). Implements `BackupBlobSource` (backup.ts),
// `RecoveryBlobSeam` (recovery.ts), and `RecycleBlobSeam` (backup/recycle.ts)
// over the S6/A3 compiled blob-reference census (blob-census.ts) + the blob
// store (blob-store.ts). S1 declared these seams and implemented nothing behind
// them; this module is the real enumeration, materialization, verification, and
// name resolution they consume.
//
// GENERATION-LAYOUT CONTRACT (the stable byte-store generation layout backup,
// recovery, and recycle all agree on):
//
//   BLOB_GENERATION_LAYOUT_VERSION = 1
//
//   - A "generation" is a content-addressed blob id: an ADOPTED `BlobStore`
//     row reachable from committed DB state through the compiled census.
//     `census()` returns exactly those generations — referenced AND adopted.
//     A generation whose row is 'pending' (never adopted into committed state)
//     is never censused (its bytes are not content-addressed yet). An adopted
//     generation whose bytes are missing IS censused — its reference is
//     recorded — and then fails at materialize time: the seam throws (fail
//     closed) rather than silently dropping a referenced blob from the backup
//     or restore.
//
//   - The stable file name under a `blobs/` directory for a generation's
//     immutable bytes IS the generation id itself (already the fsBlobs final
//     slot layout `<blobsRoot>/<generation>`):
//         live final slot:         <blobsRoot>/<generation>
//         backup copy:             backups/<ts>-<id>/blobs/<generation>
//         restore target:          <targetRoot>/blobs/<generation>
//     `materialize` writes this name, `resolveBackupBlobName` resolves exactly
//     it, and recycle bins exactly it — one file name, three seams.
//
//   - `blobs/<generation>.sha256` is the DIGEST SIDECAR: the hex sha256 of the
//     generation's bytes, written by `materialize` as integrity metadata.
//     `verifyBackupGeneration`, `censusAfterRestore`, and
//     `resolveBackupBlobName` all verify the byte file against it, so a
//     corrupted or truncated byte file fails closed in backup, restore, and
//     recycle. The sidecar is never reported to the backup manager (it is not
//     a blob byte), never binned (recycle moves only the byte file), and never
//     an authorization token — content hashes are integrity metadata only
//     (S6 consideration #24).
//
//   - Materialization is CONTAINED and ATOMIC. The destination blob directory
//     itself must be a real directory (never a pre-existing symlink — a
//     symlinked destination would redirect both materializers outside the
//     intended blob dir), and a generation's byte file + sidecar are written to
//     temp names unique to ONE materialize invocation (a fresh random token per
//     call) and published into place only after BOTH writes succeed, so a
//     failing sidecar write never leaves a byte file observable without its
//     sidecar (no partial generation is ever present as complete).
//     Publication is NO-CLOBBER (a hard link created only when the final name
//     is free — never a replace-on-collision rename), so a later writer can
//     NEVER overwrite an earlier winner's final, and rollback is
//     OWNERSHIP-VERIFIED AND ATOMIC: a final is removed only while it is still
//     the exact file this invocation created (same device + inode), and the
//     check is never check-then-act on a shared path — the final is claimed by
//     an atomic rename to a fresh per-call name no other actor holds, the claim
//     is verified, and only a matching claim is removed (a foreign file that
//     replaced this invocation's final is restored in place), so a losing
//     materializer NEVER deletes a winner's final. A mid-sequence failure rolls
//     back exactly the files THAT invocation created — its temps (unique
//     per-call names) and its own published finals (atomic, ownership-verified)
//     — a losing concurrent materializer never deletes the winner's temps or
//     finals, across every context, even separate processes that share no lock
//     state. A partial final left by a CRASHED materializer (its rollback never
//     ran) fails closed on the next materialize — never overwritten, never
//     reclaimed by a writer — and is retired when the destination directory it
//     sits in is quarantined or discarded WHOLE by its manager: a failed backup
//     directory and a failed fresh-restore target are retired directory and
//     all, so their crash leftovers go with them. The LIVE-restore target is
//     the owned root's persistent `blobs/` directory — no manager discards it —
//     so a crash mid-materialize there is REPAIRED by the recovery seam on the
//     next restore attempt instead of blocking every later restore of that
//     generation forever: the byte final a crash leaves behind always holds the
//     generation's own immutable, verified bytes (a crash can only land between
//     the byte publish and the sidecar publish), so the seam re-materializes
//     the missing digest sidecar ONLY, and only after confirming the byte final
//     is a contained regular file whose digest matches the generation's bytes.
//     A byte final whose sidecar verifies it as the generation's own bytes
//     (byte digest AND sidecar digest BOTH equal the expected digest) is left
//     untouched — a retry after a crash that landed post-materialize completes
//     as a no-op. A foreign or unverifiable byte final is a LOUD fail-closed
//     error naming the generation and its remediation — never overwritten and
//     never removed by a writer (see materializeRestoreGeneration /
//     inspectPreexistingGeneration). A byte final that is merely
//     SELF-consistent with its own sidecar (digest == sidecar, but neither
//     equals the expected digest) is foreign, not complete: it is refused loud,
//     never accepted as a no-op.
//
//     A per-destination lock keyed by the destination's resolved realpath
//     additionally serializes writers WITHIN a shared lock buffer (worker
//     threads sharing BlobSeamsOptions.lockBuffer fail a genuinely-contended
//     destination closed, fast). The lock is an optimization and fast-fail, not
//     the correctness authority: the no-clobber publish + atomic
//     ownership-verified rollback are what keep concurrent materializers
//     collision-free even when they never share any lock state (separate
//     processes).
//
// The seam's own digest verification at `materialize` time is against the
// BlobStore's recorded sha256 (the digests the manifest's census links to);
// after the bytes land in a backup, the sidecar is the self-contained digest
// the recovery/recycle sides verify against — the backup never depends on the
// live database's metadata to prove its bytes.

import { createHash, randomBytes } from 'node:crypto';
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { DbHandle } from './driver.ts';
import type { BlobCensus } from './blob-census.ts';
import type { BlobStore } from './blob-store.ts';
import type { MaterializedBlobFile } from './backup.ts';
import type { BackupBlobSource } from './backup.ts';
import type { RecoveryBlobSeam } from './recovery.ts';
import type { RecycleBlobSeam } from './backup/recycle.ts';

// The stable generation-layout version (spec 6): backup, recovery, and recycle
// agree on the file naming below. Bump this when the layout changes so the
// three consumers can detect a mismatch instead of guessing.
export const BLOB_GENERATION_LAYOUT_VERSION = 1 as const;

// Generation ids are bounded token identifiers (the same pattern the blob
// store and the recycle module enforce) and double as safe file names.
const GENERATION_NAME = /^[A-Za-z0-9_-]{1,128}$/;

// The digest sidecar suffix for a generation's byte file.
const DIGEST_SUFFIX = '.sha256';

// The framework blob-metadata ledger. Adopted rows here are the ONLY
// generations the census may record (spec 2).
const BLOB_METADATA_LEDGER = 'BlobStore';

// Defense in depth: census reference identifiers are interpolated into SQL, so
// they must be SQL identifiers. The compiled census validates declared
// references at compile time; entity-derived names are checked here too before
// any statement is built (fail closed, never a guessed identifier).
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The stable file name holding a generation's immutable bytes under `blobs/`. */
export function blobGenerationFileName(generation: string): string {
  return validateGeneration(generation);
}

/** The digest-sidecar file name for a generation under `blobs/`. */
export function blobGenerationDigestFileName(generation: string): string {
  return `${validateGeneration(generation)}${DIGEST_SUFFIX}`;
}

// The per-materialize temp-name token: a safe single path segment (hex/word
// chars), never a separator, so the temp names stay flat inside the
// destination directory.
const TEMP_TOKEN = /^[A-Za-z0-9_]{1,64}$/;

function validateTempToken(token: unknown): string {
  if (typeof token !== 'string' || !TEMP_TOKEN.test(token)) {
    throw new TypeError('invalid blob temp token — expected 1-64 of [A-Za-z0-9_]');
  }
  return token;
}

/**
 * The temp file names one materialize invocation will use for a generation's
 * byte file and digest sidecar inside the destination `blobs/` directory. The
 * token is fresh per invocation (see {@link BlobSeamsOptions.tempToken}), so
 * two concurrent materializers to the same destination can never share a temp
 * path — a losing materializer rolls back only the temps it created and can
 * never delete the winner's files.
 */
export function blobGenerationTempNames(
  generation: string,
  token: string,
): Readonly<{ byte: string; sidecar: string }> {
  const name = blobGenerationFileName(generation);
  const sidecarName = blobGenerationDigestFileName(generation);
  const safeToken = validateTempToken(token);
  return { byte: `.${name}.${safeToken}.tmp`, sidecar: `.${sidecarName}.${safeToken}.tmp` };
}

// ---- per-destination materialize lock -------------------------------------
//
// Two materializers writing the same destination blob directory at the same
// time would interleave temp writes and final publishes; the per-destination
// lock serializes them within a shared context (a lock/mutex keyed by the
// destination's resolved realpath). The materialize path is synchronous on one
// thread, so within a single context the lock is never observed held; the
// acquire FAILS CLOSED rather than blocking, so a genuinely-contended
// destination (a parallel context sharing the lock buffer — e.g. worker
// threads materializing the same directory) aborts the second writer cleanly
// instead of corrupting the first.
//
// The lock is a fast-fail optimization, NOT the sole authority: contexts that
// never share a buffer (separate processes) are kept collision-free by the
// no-clobber final publish (link(2) fails when the final already exists — a
// later writer can never overwrite a winner's final) and the ownership-verified
// rollback (a final is removed only while its device+inode still match what
// this invocation created — a loser never deletes a winner's final).

/** The number of lock slots in the per-destination materialize lock buffer. */
export const BLOB_MATERIALIZE_LOCK_SLOTS = 64 as const;

/** A new SharedArrayBuffer sized for the per-destination materialize lock. */
export function blobMaterializeLockBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * BLOB_MATERIALIZE_LOCK_SLOTS);
}

// The process-wide default lock buffer: every seam instance without an explicit
// buffer shares it, so seam instances in the same process serialize on the same
// slots. Separate processes (and worker threads given a distinct buffer) never
// share it — their materializers stay collision-free via unique temp names.
const defaultLockBuffer = blobMaterializeLockBuffer();

// FNV-1a (32-bit): a stable, allocation-free hash mapping a resolved realpath
// to a lock slot. A hash collision merely serializes two distinct destinations
// — always safe, never a correctness hazard.
function lockSlot(realPath: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < realPath.length; i++) {
    hash ^= realPath.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % BLOB_MATERIALIZE_LOCK_SLOTS;
}

function tryAcquireDestinationLock(slots: Int32Array, realPath: string): boolean {
  return Atomics.compareExchange(slots, lockSlot(realPath), 0, 1) === 0;
}

function releaseDestinationLock(slots: Int32Array, realPath: string): void {
  const wasHeld = Atomics.compareExchange(slots, lockSlot(realPath), 1, 0);
  if (wasHeld !== 1) {
    throw new Error('blob materialize lock released without being held');
  }
}

export type BlobSeamsOptions = {
  /** The live committed DB state reader (queries the census reference tables + BlobStore). */
  readonly db: DbHandle;
  /** The S6/A3 compiled blob-reference census. */
  readonly census: BlobCensus;
  /** The blob store (metadata + byte reads) the live generations live in. */
  readonly blobs: BlobStore;
  /**
   * TEST SEAM: the per-materialize temp-name token source (defaults to a fresh
   * random token per invocation so concurrent materializers never share a temp
   * path). Tests override it with a fixed token to predict the temp names and
   * force a mid-sequence failure deterministically. Production code must never
   * pass this.
   */
  readonly tempToken?: () => string;
  /**
   * TEST SEAM: invoked synchronously immediately after THIS invocation's byte
   * final has been published (and its byte temp removed), before the digest
   * sidecar is published. Tests use it to force a failure AFTER a final was
   * published — planting a blocker at the sidecar final name, or swapping a
   * foreign file onto the byte final — so the atomic ownership-verified
   * rollback of a published final is exercised deterministically. Production
   * code must never pass this.
   */
  readonly afterByteFinalPublish?: () => void;
  /**
   * The SharedArrayBuffer backing the per-destination materialize lock,
   * keyed by the destination's resolved realpath. Defaults to a module-level
   * buffer. Pass the SAME buffer to every context (e.g. worker threads) that
   * materializes into the same destination directories so a genuinely-contended
   * destination fails closed fast on the lock. Contexts with separate buffers
   * (e.g. separate processes) never share it and are kept collision-free by the
   * no-clobber final publish + ownership-verified rollback, so a shared buffer
   * is an optimization, never a correctness requirement.
   */
  readonly lockBuffer?: SharedArrayBuffer;
};

/** The one object satisfying all three seam contracts the managers consume. */
export type BlobSeams = BackupBlobSource & RecoveryBlobSeam & RecycleBlobSeam;

// ---- internals -----------------------------------------------------------

function validateGeneration(generation: unknown): string {
  if (typeof generation !== 'string' || !GENERATION_NAME.test(generation)) {
    throw new TypeError('invalid blob generation id — expected 1-128 of [A-Za-z0-9_-]');
  }
  return generation;
}

function sha256hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

// Verify a file under `dir` is a genuine, contained, regular file (lstat +
// realpath, the same containment discipline as the backup/recovery managers):
// a symlink, a path escape, a missing file, or a non-file is refused.
type Containment = Readonly<{ ok: true; size: number }> | Readonly<{ ok: false; reason: string }>;

function verifyContainedRegularFile(dir: string, name: string): Containment {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
    return { ok: false, reason: `invalid blob file name: ${name}` };
  }
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return { ok: false, reason: `the blob directory does not exist: ${dir}` };
  }
  const filePath = path.join(dir, name);
  let stat: ReturnType<typeof statSync>;
  try {
    const link = lstatSync(filePath);
    if (link.isSymbolicLink()) {
      return { ok: false, reason: `blob file is a symlink: ${name}` };
    }
    const resolved = realpathSync(filePath);
    if (resolved !== realDir && !resolved.startsWith(realDir + path.sep)) {
      return { ok: false, reason: `blob file resolves outside the blob directory: ${name}` };
    }
    stat = statSync(resolved);
  } catch {
    return { ok: false, reason: `blob file was not found: ${name}` };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: `blob path is not a regular file: ${name}` };
  }
  return { ok: true, size: stat.size };
}

// Refuse to write into an occupied destination before materializing a
// generation: a pre-existing file, directory, or (critically) symlink at the
// stable generation path must never be overwritten or followed — a symlink
// planted at the path would redirect the write OUTSIDE the blob directory.
// Combined with the exclusive (O_EXCL) writes below, this is a
// no-write-outside guarantee, not a check-then-write race.
function assertDestinationClear(dir: string, name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
    throw new Error(`blob destination is not a safe single path segment: ${name}`);
  }
  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(path.join(dir, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`blob destination ${name} is not writable`);
  }
  if (link.isSymbolicLink()) {
    throw new Error(`blob destination ${name} is a symlink — refusing to write outside the blob directory`);
  }
  throw new Error(`blob destination ${name} already exists — refusing to overwrite (fail closed)`);
}

// Validate the destination blob DIRECTORY before any write. mkdirSync with
// {recursive:true} follows a pre-existing symlink, so a symlinked destBlobDir
// would redirect both materializers OUTSIDE the intended blob directory: the
// directory itself must be a real directory (lstat), never a link, and is
// created only when absent. Returns the resolved realpath — every subsequent
// write targets it, so even a later swap of the original path for a symlink
// cannot redirect materialization.
function resolveBlobDestinationDir(destBlobDir: string): string {
  let link: ReturnType<typeof lstatSync> | undefined;
  try {
    link = lstatSync(destBlobDir);
    if (link.isSymbolicLink()) {
      throw new Error(
        `blob destination directory is a symlink — refusing to write outside the blob directory: ${destBlobDir}`,
      );
    }
    if (!link.isDirectory()) {
      throw new Error(`blob destination is not a directory: ${destBlobDir}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    mkdirSync(destBlobDir, { recursive: true, mode: 0o700 });
    // A recursive mkdir could have created through a planted symlink; confirm
    // what now exists at the destination is a real directory, not a link.
    link = lstatSync(destBlobDir);
    if (link.isSymbolicLink() || !link.isDirectory()) {
      throw new Error(`blob destination directory is not a real directory: ${destBlobDir}`);
    }
  }
  try {
    return realpathSync(destBlobDir);
  } catch {
    throw new Error(`blob destination directory could not be resolved: ${destBlobDir}`);
  }
}

// The identity (device + inode) of a file this invocation created: recorded at
// publish time so rollback can prove the invocation still owns a final path
// before ever removing it. Keep the temp hard link until rollback completes
// so the inode cannot be freed and reused by a replacement. With that pin, a
// dev+ino match means the file AT the path is the exact file this invocation
// wrote — never a winner's file that replaced it.
type FileIdentity = Readonly<{ dev: number; ino: number }>;

// Publish a temp file to its final name WITHOUT clobbering: link(2) creates a
// hard link only when the destination does not exist (fails with EEXIST
// otherwise), unlike rename(2) which silently replaces a destination. This is
// the load-bearing no-final-overwrite guarantee: a later writer can NEVER
// overwrite an earlier winner's final, no matter which processes or lock
// buffers are involved. Returns the final's identity for the atomic
// ownership-verified rollback.
function publishNoClobber(tmp: string, final: string, what: string): FileIdentity {
  // Record the identity from the TEMP before the link: the temp is exclusively
  // this invocation's (unique token + 'wx' creation), so its dev+ino is the
  // exact identity of the file being published, with no window in which a
  // foreign file at the final path could be attributed to this invocation.
  const st = statSync(tmp);
  const identity = { dev: st.dev, ino: st.ino };
  try {
    linkSync(tmp, final);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`blob destination ${what} already exists — a concurrent materializer won it (fail closed, never overwrite)`);
    }
    throw err;
  }
  return identity;
}

// Ownership-verified rollback of a final this invocation published: remove it
// ONLY while the path is still the exact file this invocation created. The
// check and the removal are made ATOMIC by a RENAME-CLAIM: whatever currently
// sits at the final path is first renamed (rename(2), atomic, same directory →
// same filesystem) to a fresh claim name only THIS call can know, the claim is
// then identity-checked, and only a matching claim is removed. A replacement
// (a winner's final that took over the path) is restored untouched via a
// no-clobber hard link, so a losing materializer never deletes a winner's
// final — and because the claim name is random and known only to this
// invocation, no other actor can race the check against the removal.
function removeOwnedFile(finalPath: string, identity: FileIdentity | undefined): void {
  if (!identity) return;
  const claimPath = `${finalPath}.${randomBytes(6).toString('hex')}.claim`;
  let claimed: ReturnType<typeof lstatSync>;
  try {
    renameSync(finalPath, claimPath);
  } catch {
    return; // already gone — nothing this invocation owns remains
  }
  try {
    claimed = lstatSync(claimPath);
  } catch {
    return; // the claim vanished before it could be inspected
  }
  if (claimed.dev !== identity.dev || claimed.ino !== identity.ino) {
    // A winner's/foreign file now holds the final path — restore it WITHOUT
    // clobbering anything that may have been published into the freed name
    // since the claim: link(2) succeeds only while the final name is free. If
    // the name is already taken again, the claimed file stays under its unique
    // claim name (litter, never deletion or overwrite of a winner's file).
    try {
      linkSync(claimPath, finalPath);
      rmSync(claimPath, { force: true });
    } catch {
      /* best-effort restore of the winner's final */
    }
    return;
  }
  try {
    // The claim is the file this invocation created — remove only that name
    // (never recursive: a matching claim is always the regular file we wrote).
    rmSync(claimPath, { force: true });
  } catch {
    /* best-effort rollback of the partial generation */
  }
}

// The result of inspecting what a destination blob directory already holds for
// a generation before a RESTORE materialization lands (see
// inspectPreexistingGeneration). Only the recovery side consults it: the live
// restore target is the owned root's persistent `blobs/` directory, which no
// manager ever quarantines or discards, so a crash mid-materialize (its
// rollback never ran) leaves a byte final without a sidecar that would
// otherwise block every later restore of that generation.
type PreexistingGeneration =
  // The generation is already fully present with byte AND sidecar digests BOTH
  // equal to the expected digest — a retry after a crash that landed
  // post-materialize completes as a no-op. Self-consistency alone (byte digest
  // == its own sidecar digest) is NEVER enough: the digests must equal the
  // expected digest, or the pair is foreign.
  | Readonly<{ kind: 'complete'; size: number }>
  // No byte final: the caller runs the normal atomic write path.
  | Readonly<{ kind: 'absent' }>
  // The byte final holds the generation's own verified bytes but the digest
  // sidecar is missing (the crash window): only the sidecar was re-published.
  | Readonly<{ kind: 'repaired'; size: number }>
  // A foreign/unverifiable byte or a blocked sidecar name: restore must fail
  // LOUD, naming the generation and its remediation — never overwrite or
  // remove a byte this invocation did not create.
  | Readonly<{ kind: 'blocked'; reason: string }>;

// Inspect a destination blob directory's pre-existing state for one generation
// under the per-destination lock, REPAIRING the one crash-leftover shape the
// live-restore target can legitimately hold (byte-without-sidecar). The crash
// can only land between the byte final publish and the sidecar publish, so a
// leftover byte final always holds the generation's own immutable, verified
// bytes; the repair therefore publishes ONLY the missing digest sidecar — a
// no-clobber link under the same lock as the full materialize — and never
// touches the byte file. Before anything is published the existing byte final
// must pass BOTH the containment check (a contained regular file — never a
// symlink or a path escape) AND a digest match against the generation's bytes;
// a byte final that is foreign, corrupt, or unverifiable is a LOUD blocker
// naming the generation and its remediation (the entry is never overwritten,
// never removed by a writer). A pre-existing byte+sidecar pair is 'complete'
// (left untouched — the retry-after-crash no-op) ONLY when the byte digest AND
// the sidecar digest BOTH equal the generation's expected digest from the
// backup: a foreign byte carrying its OWN valid-but-wrong sidecar is
// self-consistent, but its digest is not the expected digest, so it is refused
// as foreign here — never accepted as a no-op.
function inspectPreexistingGeneration(
  destRealDir: string,
  generation: string,
  expectedDigest: string,
  tempToken: () => string,
  lockSlots: Int32Array,
): PreexistingGeneration {
  if (!tryAcquireDestinationLock(lockSlots, destRealDir)) {
    throw new Error(
      `blob destination ${destRealDir} is being materialized by another writer — refusing to interleave (fail closed)`,
    );
  }
  try {
    const name = blobGenerationFileName(generation);
    const bytePath = path.join(destRealDir, name);
    const contained = verifyContainedRegularFile(destRealDir, name);
    if (!contained.ok) {
      if (contained.reason.startsWith('blob file was not found:')) return { kind: 'absent' };
      return {
        kind: 'blocked',
        reason: `blob generation '${generation}' is blocked in the restore target: '${name}' is not a contained regular file (${contained.reason}) — it will never be overwritten or removed by a writer; remove the entry ${bytePath} to retry the restore`,
      };
    }
    let actualDigest: string;
    try {
      actualDigest = sha256hex(readFileSync(bytePath));
    } catch (err) {
      return {
        kind: 'blocked',
        reason: `blob generation '${generation}' is blocked in the restore target: '${name}' could not be read for verification (${err instanceof Error ? err.message : String(err)}) — it will never be overwritten or removed by a writer; remove ${bytePath} to retry the restore`,
      };
    }
    // A byte file whose digest is not the generation's expected digest is
    // foreign or corrupt — INCLUDING a byte file whose digest matches its own
    // self-consistent sidecar but NOT the expected digest. The 'complete'
    // no-op below demands BOTH digests equal the expected digest, so a
    // self-consistent foreign pair is refused here, never accepted.
    const sidecarName = blobGenerationDigestFileName(generation);
    if (actualDigest !== expectedDigest) {
      return {
        kind: 'blocked',
        reason: `blob generation '${generation}' is blocked in the restore target: '${name}' holds bytes whose digest does not match the generation's verified bytes — the byte entry is foreign or corrupt and will never be overwritten or removed by a writer; remove ${bytePath} (and ${path.join(destRealDir, sidecarName)}) to retry the restore`,
      };
    }

    // The byte final holds the generation's own immutable bytes. The pair is
    // 'complete' (the retry-after-crash no-op) ONLY when the sidecar digest
    // equals the expected digest too — a byte+sidecar pair that is merely
    // SELF-consistent (byte digest == sidecar digest, both different from the
    // expected digest) was refused as foreign above.
    const sidecar = readSidecar(destRealDir, generation);
    if (sidecar.ok && sidecar.digest === expectedDigest) {
      return { kind: 'complete', size: contained.size };
    }

    // The byte final holds the generation's own immutable bytes but the
    // digest sidecar is missing, malformed, or stale (the crash window between
    // the two publishes). Publish just the sidecar — the byte file is never
    // touched. The sidecar name must be clear (no-clobber); an occupied name
    // is a foreign state a crash cannot produce, so it is a loud blocker,
    // never a replacement.
    try {
      assertDestinationClear(destRealDir, sidecarName);
    } catch (err) {
      return {
        kind: 'blocked',
        reason: `blob generation '${generation}' is blocked in the restore target: its byte entry verifies as this generation's bytes but '${sidecarName}' is occupied and cannot be written (${err instanceof Error ? err.message : String(err)}) — remove the stale ${sidecarName} entry in ${destRealDir} to retry the restore`,
      };
    }
    const temps = blobGenerationTempNames(generation, tempToken());
    const sidecarTmp = path.join(destRealDir, temps.sidecar);
    const sidecarFinal = path.join(destRealDir, sidecarName);
    let created = false;
    try {
      writeFileSync(sidecarTmp, `${expectedDigest}\n`, { flag: 'wx', mode: 0o600 });
      created = true;
      publishNoClobber(sidecarTmp, sidecarFinal, `digest sidecar ${sidecarName}`);
      unlinkSync(sidecarTmp);
    } catch (err) {
      if (created) {
        try {
          rmSync(sidecarTmp, { force: true });
        } catch {
          /* best-effort rollback of the sidecar temp */
        }
      }
      return {
        kind: 'blocked',
        reason: `blob generation '${generation}' could not have its missing digest sidecar published in the restore target: ${err instanceof Error ? err.message : String(err)} — remove ${bytePath} to retry a full materialization`,
      };
    }
    return { kind: 'repaired', size: contained.size };
  } finally {
    releaseDestinationLock(lockSlots, destRealDir);
  }
}

// Materialize one generation's byte file + digest sidecar ATOMICALLY into an
// already-validated destination directory (the realpath from
// resolveBlobDestinationDir). Both files are written to temp names unique to
// THIS invocation (a fresh random token, exclusive 'wx' opens) and PUBLISHED
// only after BOTH writes succeed, so a failing sidecar write never leaves a
// byte file observable without its sidecar — no partial generation is complete.
// Publication is no-clobber (publishNoClobber — link(2), never a
// replace-on-collision rename), so a concurrent materializer — even one from a
// separate process sharing no lock state — can NEVER overwrite a winner's
// final. A mid-sequence failure rolls back exactly the files THIS invocation
// created: its own temps (unique names, so a concurrent materializer's files
// can never be removed here) and any final it published, and only while that
// final is still the exact file it wrote (removeOwnedFile — an atomic
// rename-claim + identity check, so a losing materializer never deletes a
// winner's final, with no check-then-remove window). The per-destination lock
// additionally fails a contended destination closed fast within a shared lock
// buffer; the guarantees above hold with or without it.
function writeGenerationAtomically(
  destRealDir: string,
  generation: string,
  bytes: Buffer,
  tempToken: () => string,
  lockSlots: Int32Array,
  afterByteFinalPublish?: () => void,
): void {
  if (!tryAcquireDestinationLock(lockSlots, destRealDir)) {
    throw new Error(
      `blob destination ${destRealDir} is being materialized by another writer — refusing to interleave (fail closed)`,
    );
  }
  try {
    const name = blobGenerationFileName(generation);
    const sidecarName = blobGenerationDigestFileName(generation);
    assertDestinationClear(destRealDir, name);
    assertDestinationClear(destRealDir, sidecarName);
    const temps = blobGenerationTempNames(generation, tempToken());
    const byteTmp = path.join(destRealDir, temps.byte);
    const sidecarTmp = path.join(destRealDir, temps.sidecar);
    const byteFinal = path.join(destRealDir, name);
    const sidecarFinal = path.join(destRealDir, sidecarName);
    let byteCreated = false;
    let sidecarCreated = false;
    let byteFinalIdentity: FileIdentity | undefined;
    let sidecarFinalIdentity: FileIdentity | undefined;
    try {
      writeFileSync(byteTmp, bytes, { flag: 'wx', mode: 0o600 });
      byteCreated = true;
      writeFileSync(sidecarTmp, `${sha256hex(bytes)}\n`, { flag: 'wx', mode: 0o600 });
      sidecarCreated = true;
      byteFinalIdentity = publishNoClobber(byteTmp, byteFinal, `generation ${name}`);
      afterByteFinalPublish?.();
      sidecarFinalIdentity = publishNoClobber(sidecarTmp, sidecarFinal, `digest sidecar ${sidecarName}`);
    } catch (err) {
      // Ownership-aware rollback: remove only the files this invocation
      // created/published — its temps (unique to this invocation) and the
      // finals it published, and only while each final is still the exact
      // file it wrote — never another materializer's temp or final.
      removeOwnedFile(byteFinal, byteFinalIdentity);
      removeOwnedFile(sidecarFinal, sidecarFinalIdentity);
      throw err;
    } finally {
      for (const leftover of [
        byteCreated ? byteTmp : '',
        sidecarCreated ? sidecarTmp : '',
      ]) {
        if (leftover) {
          try {
            rmSync(leftover, { force: true });
          } catch {
            /* best-effort rollback of the partial generation */
          }
        }
      }
    }
  } finally {
    releaseDestinationLock(lockSlots, destRealDir);
  }
}

// Read + shape-check the digest sidecar for a generation. The sidecar is
// containment-checked exactly like the byte file (lstat + realpath inside the
// blob dir): a symlinked sidecar pointing outside the backup/target must never
// be trusted as the generation's digest. A missing or malformed sidecar is a
// verification failure (the byte file cannot be trusted without its recorded
// digest).
function readSidecar(
  dir: string,
  generation: string,
): { readonly ok: true; readonly digest: string } | { readonly ok: false; readonly reason: string } {
  const sidecarName = blobGenerationDigestFileName(generation);
  const contained = verifyContainedRegularFile(dir, sidecarName);
  if (!contained.ok) {
    return { ok: false, reason: `the digest sidecar for ${generation} is not a contained regular file: ${contained.reason}` };
  }
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, sidecarName), 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: `the digest sidecar for ${generation} is missing` };
    }
    return { ok: false, reason: `the digest sidecar for ${generation} is unreadable` };
  }
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    return { ok: false, reason: `the digest sidecar for ${generation} is malformed` };
  }
  return { ok: true, digest: raw };
}

// Verify a generation's byte file + sidecar inside a `blobs/` directory and
// return the byte file name. Shared by verifyBackupGeneration, censusAfterRestore,
// and resolveBackupBlobName — one verification, three consumers.
function verifyGenerationBytes(generation: string, blobsDir: string): { ok: true; name: string; size: number } | { ok: false; reason: string } {
  const name = blobGenerationFileName(generation);
  const bytes = verifyContainedRegularFile(blobsDir, name);
  if (!bytes.ok) return { ok: false, reason: bytes.reason };
  const sidecar = readSidecar(blobsDir, generation);
  if (!sidecar.ok) return { ok: false, reason: sidecar.reason };
  let actual: string;
  try {
    actual = sha256hex(readFileSync(path.join(blobsDir, name)));
  } catch {
    return { ok: false, reason: 'the generation bytes could not be read for digest verification' };
  }
  if (actual !== sidecar.digest) {
    return { ok: false, reason: `the generation bytes failed digest verification (recorded ${sidecar.digest}, found ${actual})` };
  }
  return { ok: true, name, size: bytes.size };
}

export function createBlobSeams(options: BlobSeamsOptions): BlobSeams {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createBlobSeams requires an options object');
  }
  const { db, census: compiledCensus, blobs } = options;
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('blob seams require a database handle exposing prepare()');
  }
  if (!compiledCensus || typeof compiledCensus.references === 'undefined') {
    throw new TypeError('blob seams require the compiled blob census (compileBlobCensus)');
  }
  if (!blobs || typeof blobs.stat !== 'function' || typeof blobs.readRange !== 'function') {
    throw new TypeError('blob seams require a blob store exposing stat() and readRange()');
  }

  // The per-invocation temp-name token source (unique per materialize call) and
  // the per-destination lock buffer. Both default to safe values; tests may
  // pin the token to predict temp names or share the lock buffer across worker
  // threads (see BlobSeamsOptions).
  const materializeToken = options.tempToken ?? (() => randomBytes(6).toString('hex'));
  const lockSlots = new Int32Array(options.lockBuffer ?? defaultLockBuffer);
  const afterByteFinalPublish = options.afterByteFinalPublish;

  // ---- backup side (BackupBlobSource) ------------------------------------

  // Enumerate every referenced content-addressed generation from the committed
  // DB state: the DISTINCT ids the census references' tables/columns hold that
  // also have an ADOPTED BlobStore row. Deterministic (sorted) and stable
  // (same committed state → same census). Runs inside the backup manager's
  // single write-coordinator turn, so it observes one committed prefix.
  async function enumerateGenerations(): Promise<readonly string[]> {
    const referenced = new Set<string>();
    const existingTables = new Set<string>();
    const tableStmt = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
    for (const ref of compiledCensus.references) {
      if (!SQL_IDENTIFIER.test(ref.table) || !SQL_IDENTIFIER.test(ref.column)) {
        throw new Error(
          `blob census: reference ${ref.table}.${ref.column} is not a SQL identifier — refusing to enumerate (fail closed)`,
        );
      }
      if (!existingTables.has(ref.table)) {
        if (!tableStmt.get(ref.table)) continue;
        existingTables.add(ref.table);
      }
      const rows = db
        .prepare(`SELECT DISTINCT "${ref.column}" AS generation FROM "${ref.table}" WHERE "${ref.column}" IS NOT NULL AND "${ref.column}" <> ''`)
        .all() as Array<{ generation: string }>;
      for (const row of rows) {
        if (typeof row.generation === 'string' && row.generation.length > 0) referenced.add(row.generation);
      }
    }
    const adopted = new Set<string>();
    if (tableStmt.get(BLOB_METADATA_LEDGER)) {
      const rows = db.prepare('SELECT id FROM BlobStore WHERE status = ?').all('adopted') as Array<{ id: string }>;
      for (const row of rows) adopted.add(row.id);
    }
    return [...referenced].filter((id) => adopted.has(id)).sort();
  }

  // Write ONE generation's immutable bytes into the backup's blobs/ dir at the
  // stable file name (the same name resolveBackupBlobName resolves), plus the
  // digest sidecar. Reports { name, size } for the backup manager's disk
  // verification. Throws when the generation is pending (never adopted), has no
  // metadata row, has no bytes, or fails digest verification — fail closed.
  function materializeGeneration(generation: string, destBlobDir: string): readonly MaterializedBlobFile[] {
    const name = blobGenerationFileName(generation);
    const row = blobs.stat(generation);
    if (!row) {
      throw new Error(`blob generation '${generation}' is missing from the blob store metadata — its bytes cannot be materialized`);
    }
    if (row.status !== 'adopted') {
      throw new Error(
        `blob generation '${generation}' is '${row.status}', not adopted — its bytes are pending or unavailable (fail closed)`,
      );
    }
    let bytes: Buffer;
    try {
      bytes = blobs.readRange(generation);
    } catch (err) {
      throw new Error(
        `blob generation '${generation}' bytes are missing from the byte store: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const digest = sha256hex(bytes);
    if (digest !== row.sha256) {
      throw new Error(
        `blob generation '${generation}' failed digest verification against the blob store metadata — refusing to materialize corrupt bytes`,
      );
    }
    const destRealDir = resolveBlobDestinationDir(destBlobDir);
    writeGenerationAtomically(destRealDir, generation, bytes, materializeToken, lockSlots, afterByteFinalPublish);
    return [{ name, size: bytes.length }];
  }

  // ---- recovery side (RecoveryBlobSeam) ----------------------------------

  // Verify the backup holds verified bytes for one referenced generation
  // (contained regular file + matching digest sidecar). Throws → the restore
  // aborts with the backup left untouched.
  function verifyBackupGenerationBytes(generation: string, backupBlobsDir: string): void {
    const verified = verifyGenerationBytes(generation, backupBlobsDir);
    if (!verified.ok) {
      throw new Error(`backup blob generation '${generation}' is unavailable: ${verified.reason}`);
    }
  }

  // Materialize one verified generation's bytes from the backup's blobs/ into
  // the target's blobs/ layout (the same stable name), plus its digest sidecar,
  // so censusAfterRestore can verify the target without the backup. Returns the
  // files written for the recovery manager's disk verification.
  function materializeRestoredGeneration(
    generation: string,
    backupBlobsDir: string,
    destBlobDir: string,
  ): readonly MaterializedBlobFile[] {
    const verified = verifyGenerationBytes(generation, backupBlobsDir);
    if (!verified.ok) {
      throw new Error(`backup blob generation '${generation}' is unavailable: ${verified.reason}`);
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(path.join(backupBlobsDir, verified.name));
    } catch (err) {
      throw new Error(
        `backup blob generation '${generation}' bytes could not be read for restore: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const destRealDir = resolveBlobDestinationDir(destBlobDir);
    // The LIVE-restore target is the owned root's persistent `blobs/`
    // directory — no manager ever quarantines or discards it — so it may
    // already hold this generation's bytes: a crash mid-materialize (its
    // rollback never ran) leaves a byte final whose digest sidecar never
    // landed, which would otherwise fail-closed on every later restore of the
    // generation. Inspect what is there and repair/complete/refuse before the
    // normal atomic write: a crash-leftover byte final (matching digest, no
    // sidecar) gets its sidecar re-published; an already-complete generation
    // (byte + sidecar digests BOTH equal the expected digest) is a no-op — a
    // self-consistent foreign byte+sidecar pair is NOT complete and is refused
    // as foreign; a foreign or unverifiable byte final fails LOUD, naming the
    // generation and its remediation.
    const preexisting = inspectPreexistingGeneration(
      destRealDir,
      generation,
      sha256hex(bytes),
      materializeToken,
      lockSlots,
    );
    if (preexisting.kind === 'complete') {
      return [{ name: verified.name, size: preexisting.size }];
    }
    if (preexisting.kind === 'repaired') {
      return [{ name: verified.name, size: preexisting.size }];
    }
    if (preexisting.kind === 'blocked') {
      throw new Error(preexisting.reason);
    }
    writeGenerationAtomically(destRealDir, generation, bytes, materializeToken, lockSlots, afterByteFinalPublish);
    return [{ name: verified.name, size: bytes.length }];
  }

  // Confirm every referenced generation is available in the target's blob
  // store before the app may serve (census-before-serve). Throws on a missing
  // or corrupt generation — the restore is not marked complete (fail closed).
  // Extra, unreferenced files in the target do not fail the census.
  function verifyCensusAfterRestore(generations: readonly string[], targetRoot: string): void {
    const destBlobDir = path.join(targetRoot, 'blobs');
    for (const generation of generations) {
      const verified = verifyGenerationBytes(generation, destBlobDir);
      if (!verified.ok) {
        throw new Error(`referenced blob generation '${generation}' is unavailable in the restored store: ${verified.reason}`);
      }
    }
  }

  // ---- recycle side (RecycleBlobSeam) ------------------------------------

  // Resolve the exact stable file name `materialize` wrote for a generation in
  // a backup's blobs/ dir. Throws when the generation's bytes are missing,
  // pending, or unverifiable — the recycle module never guesses at file names.
  function resolveBackupBlobName(generation: string, backupBlobsDir: string): string {
    const verified = verifyGenerationBytes(generation, backupBlobsDir);
    if (!verified.ok) {
      throw new Error(`blob generation '${generation}' cannot be resolved: ${verified.reason}`);
    }
    return verified.name;
  }

  return Object.freeze({
    census: enumerateGenerations,
    materialize: materializeGeneration,
    verifyBackupGeneration: verifyBackupGenerationBytes,
    materializeRestoreGeneration: materializeRestoredGeneration,
    censusAfterRestore: verifyCensusAfterRestore,
    resolveBackupBlobName,
  });
}
