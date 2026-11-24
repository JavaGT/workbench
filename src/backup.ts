// backup.ts — S1/A3 backup: SQLite snapshot + manifest + retention (epic
// scope#23, library/API + tests only — no scheduler, no timer, no cron).
//
// CONTRACT: `createBackupManager` produces a manager whose `backup()` performs
// ONE backup into the adapter-owned layout `backups/<timestamp>-<id>/` with
// `snapshot.sqlite`, `manifest.json`, and `blobs/`. The snapshot is taken via
// node:sqlite's online `backup(sourceDb, destPath)` API (WAL-safe); a plain
// copy of the main database file is NEVER an acceptable snapshot and a
// non-WAL source is refused fail-closed. A single consistency boundary runs
// through the platform write coordinator: inside ONE coordinated turn we
// capture the committed DB state (the snapshot) and the referenced blob set
// (the pluggable census seam); blob BYTES are copied outside the turn (they
// are immutable/content-addressed, so the boundary is the capture, never the
// byte copy).
//
// The manifest is written LAST, after the snapshot and every blob byte: a
// directory with a `complete` manifest is complete by construction, and
// anything else (a crash mid-creation/manifest/byte-copy, a missing blob, a
// failed integrity check) becomes a PARTIAL that is immediately quarantined —
// never a false-complete backup. `reconcile()` quarantines crash leftovers on
// the next run. Retention trims to N daily + M recent hourly (defaults 7/3,
// configurable) and fails closed: a trim that cannot remove every selected
// directory rejects instead of reporting success.
//
// The blob census seam is DELIBERATELY pluggable (S6 owns blob enumeration):
// the module only records whatever `census()` returns and materializes each
// referenced generation through `materialize(generation, destBlobDir)`. No
// blob enumeration lives here. A blob-capable source (its schema declares the
// framework blob-metadata ledger, `BlobStore`) REQUIRES the seam: without a
// census the manager could only record an empty blob set and falsely report
// complete, so `backup()` refuses fail-closed instead. `materialize` must
// return the files it wrote (name + byte size); the manager VERIFIES every
// reported byte on disk before a manifest may say `complete` — a generation
// that throws, reports nothing, or lands with the wrong size is MISSING →
// partial, never complete.
//
// OWNERSHIP (review #82 finding 3): the capture barrier runs through the
// platform write coordinator. `createBackupManager` verifies at construction
// that the coordinator it is given is EXACTLY the coordinator the source
// declares as its owner (`source.writeCoordinator`) — an unbound source or a
// foreign coordinator is refused, because a capture that does not exclude
// writes is no consistency boundary at all.

import { openSqliteDatabase, type SqliteDatabase } from './sqlite-driver.ts';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { getLog } from './log.ts';
import type { DbHandle } from './driver.ts';
import type { IntegrityReport } from './db-adapter.ts';
import type { MIGRATION_LEDGER_TABLE, LedgerEntry } from './migration-ledger.ts';
import {
  BACKUP_FORMAT_VERSION,
  createMessageSanitizer,
  createQuarantineMover,
  formatTimestamp,
  isDirectory,
  listCompleteBackups,
  parseBackupTimestamp,
  quarantineIncompleteBackups,
  quickCheckOf,
  readCompleteManifest,
  readMigrationLedger,
  schemaIdentityOf,
  verifyMaterialization,
  writeDiagnostic,
  type MaterializedBlobFile,
} from './backup/safety.ts';

// Public surface is unchanged: the version constant and the reported-file type
// now come from the one crash-safety authority, re-exported here for existing
// consumers (recovery.ts, internal.ts, blob-seams.ts, backup/recycle.ts).
export { BACKUP_FORMAT_VERSION };
export type { MaterializedBlobFile };

export type BackupRetentionConfig = { readonly daily: number; readonly hourly: number };

export const DEFAULT_RETENTION: Readonly<BackupRetentionConfig> = Object.freeze({
  daily: 7,
  hourly: 3,
});

// The pluggable blob census seam (S6 implements it against the real backend).
// `census()` returns the content-addressed blob generations referenced by the
// committed DB state captured at the barrier; `materialize` writes the
// immutable bytes of ONE generation into the backup's blobs/ directory.
//
// Materialize is VERIFIED (review #82 finding 2): it must return the files it
// wrote under `destBlobDir` (relative `name` + `size` in bytes) and must THROW
// when the generation's bytes are pending finalization or missing. The manager
// stats every reported file against the reported size before a backup may be
// complete — an empty report, a reported-but-unwritten file, or a size
// mismatch marks the generation missing (partial, quarantined, never
// complete). Verification is lstat + realpath CONTAINED: a reported file must
// be a regular file whose realpath stays inside the blob directory's realpath,
// so a symlink inside blobs/ pointing outside is a missing generation, never a
// complete byte.
//
// There is a brief window between verification and the manifest write: blob
// bytes are immutable and content-addressed, so no WRITER can swap them, and a
// same-user attacker with filesystem write access to the owned directory could
// equally rewrite the manifest/snapshot themselves — the window is documented,
// not defended against (an adversary there owns the backup directory outright).
export type BackupBlobSource = {
  census(): Promise<readonly string[]> | readonly string[];
  materialize(
    generation: string,
    destBlobDir: string,
  ): Promise<readonly MaterializedBlobFile[]> | readonly MaterializedBlobFile[];
};

// The namespaced migration ledger state captured in a backup manifest (S2/A4,
// workbench#90): ONE namespaced lane — identity is (namespace, version) — not
// the two legacy global tables. `appliedVersions` is ordered by (namespace,
// version); `maxVersion` is the highest integer version across namespaces.
export type BackupMigrationLedgerState = {
  readonly table: typeof MIGRATION_LEDGER_TABLE;
  readonly appliedVersions: readonly LedgerEntry[];
  readonly maxVersion: number;
};

// The concretely enumerated manifest fields (issue #82 spec §2). `encryption`
// is recorded explicitly per owner decision #3 — the platform encrypts at the
// volume (macOS FileVault) layer, never inside the backup.
//
// `binnedGenerations` is the S1/A6 recycling-bin re-mark, written by
// src/backup/recycle.ts when content is moved out of this backup into the bin
// (owner decision #4: deleted content is recoverable from a bin, never
// silently destroyed). It is OPTIONAL and additive: a backup that has never
// been re-marked carries no such field (manifest stays canonical), recovery
// validation (src/recovery.ts) ignores unknown fields, and the field never
// changes `blobGenerations` — that array is the census recorded at capture and
// stays truthful. `purgedAt` is set when the binned bytes were force-deleted
// earlier than the recovery period (or swept at expiry), so an operator can
// tell destroyed content from restorable content.
export type BackupBinnedGeneration = Readonly<{
  readonly generation: string;
  readonly name: string;
  readonly size: number;
  readonly binnedAt: string;
  readonly purgedAt?: string;
}>;

export type BackupManifest = {
  readonly formatVersion: typeof BACKUP_FORMAT_VERSION;
  readonly platformSchemaIdentity: string;
  readonly appSchemaIdentity: readonly string[];
  readonly migrationLedgerState: BackupMigrationLedgerState;
  readonly integrityResult: IntegrityReport;
  readonly blobGenerations: readonly string[];
  readonly createdAt: string;
  readonly completedAt: string;
  readonly status: 'complete' | 'partial';
  readonly encryption: 'none';
  readonly binnedGenerations?: readonly BackupBinnedGeneration[];
};

// Diagnostics are retained for failure forensics WITHOUT data content: stage,
// error message, and identifiers (generation ids, backup ids) only — never row
// data and never blob bytes.
export type BackupDiagnostic = {
  readonly at: string;
  readonly stage: 'creation' | 'snapshot' | 'capture' | 'blob-copy' | 'manifest' | 'quarantine';
  readonly error: string;
  readonly detail?: Record<string, unknown>;
};

export type BackupResult =
  | Readonly<{
      readonly ok: true;
      readonly status: 'complete';
      readonly backupId: string;
      readonly directory: string;
      readonly manifest: BackupManifest;
    }>
  | Readonly<{
      readonly ok: false;
      readonly status: 'partial' | 'failed';
      readonly backupId: string;
      readonly directory: string;
      readonly quarantined: boolean;
      readonly manifest?: BackupManifest;
      readonly diagnostic: BackupDiagnostic;
    }>;

export type BackupListing = Readonly<{
  readonly backupId: string;
  readonly directory: string;
  readonly manifest: BackupManifest;
  readonly createdAt: string;
}>;

export type TrimResult = Readonly<{ readonly retained: number; readonly removed: readonly string[] }>;

// The snapshot source. The SQLite adapter's opened database satisfies this
// shape: `root` is the owned directory (backups/ + quarantine/ live under it),
// `handle` carries the live connection for the WAL probe, and `backupTo` is the
// adapter's online-backup hook (node:sqlite, never a raw file copy).
export type BackupSource = {
  readonly root: string | null;
  readonly handle: Pick<DbHandle, 'prepare'>;
  backupTo(destPath: string): Promise<number>;
  // OWNERSHIP BINDING (review #82 finding 3): the ONE platform write
  // coordinator (write-queue.ts) that serializes writes to this source's
  // handle. The app fills this in when it opens the adapter under its
  // coordinator. Optional in type because the adapter is opened before the
  // coordinator exists, but REQUIRED at construction: `createBackupManager`
  // asserts its `writeCoordinator` option is EXACTLY this object, so a foreign
  // coordinator can never launder the capture barrier. An unbound source fails
  // closed.
  readonly writeCoordinator?: BackupWriteCoordinator;
};

// The platform write coordinator surface the capture barrier runs through.
// `createBackupManager` requires the coordinator to be the source's declared
// owner (identity, not shape): any object with a `run` method is a foreign
// coordinator and is refused.
export type BackupWriteCoordinator = {
  run<T>(fn: () => Promise<T> | T): Promise<T>;
};

export type BackupManagerOptions = {
  readonly source: BackupSource;
  // The ONE platform write coordinator (write-queue.ts) — MUST be the exact
  // coordinator the source declares as its owner (`source.writeCoordinator`).
  // The capture barrier runs through it; no second mutex, no transaction
  // control of our own. A foreign coordinator (a different queue, or any
  // object shaped like one) throws at construction.
  readonly writeCoordinator: BackupWriteCoordinator;
  readonly blobs?: BackupBlobSource | null;
  readonly retention?: Partial<BackupRetentionConfig>;
  readonly now?: () => Date;
};

export type BackupManager = {
  backup(): Promise<BackupResult>;
  list(): readonly BackupListing[];
  trim(): Promise<TrimResult>;
  reconcile(): Readonly<{ quarantined: readonly string[] }>;
  readonly retention: Readonly<BackupRetentionConfig>;
  readonly root: string;
};

// Directory naming, completeness, quarantine, quick_check, schema identity and
// verified blob containment all come from ./backup/safety.ts — the single
// crash-safety authority shared with recovery.ts.

// The framework blob-metadata ledger. Its presence in a schema means the source
// is blob-capable: adopted blob generations MAY exist, so a backup without a
// census seam cannot safely claim complete (it refuses fail-closed instead).
const BLOB_METADATA_LEDGER = 'BlobStore';

// Upper bound on any error message persisted in a diagnostic or written to the
// log (review #82 finding 4). Errors raised by the blob seam (or anything else)
// can carry content-bearing payloads; a bounded, control-character-stripped,
// long-token-redacted message keeps diagnostics to stage + identifiers + a
// short reason, never the data itself.
export const MAX_DIAGNOSTIC_ERROR_LENGTH = 500;
const { sanitizeMessage, sanitizeError } = createMessageSanitizer(MAX_DIAGNOSTIC_ERROR_LENGTH);

export function createBackupManager(options: BackupManagerOptions): BackupManager {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createBackupManager requires an options object');
  }
  const source = options.source;
  if (!source || typeof source.backupTo !== 'function' || !source.handle || typeof source.handle.prepare !== 'function') {
    throw new TypeError('backup manager requires a source exposing an owned root, a live handle, and backupTo(destPath)');
  }
  if (typeof source.root !== 'string') {
    throw new TypeError('backup manager requires a FILE-mode source with an owned directory (memory databases cannot be backed up into the managed layout)');
  }
  if (!options.writeCoordinator || typeof options.writeCoordinator.run !== 'function') {
    throw new TypeError('backup manager requires the single write coordinator (writeCoordinator.run) for the capture barrier');
  }
  const writeCoordinator = options.writeCoordinator;
  // COORDINATOR OWNERSHIP (review #82 finding 3): the capture barrier is only a
  // consistency boundary if the coordinator it runs through is the ONE that
  // serializes writes to this source. Shape is not proof — any object with a
  // `run` method would launder the barrier — so the source must declare its
  // owner coordinator and the passed coordinator must be exactly it.
  if (source.writeCoordinator === undefined) {
    throw new TypeError(
      'backup manager requires the source to declare the write coordinator that owns it: bind source.writeCoordinator to the coordinator that serializes writes to this connection (an unbound source cannot prove its capture barrier excludes writes)',
    );
  }
  if (source.writeCoordinator !== writeCoordinator) {
    throw new TypeError(
      'backup manager refuses a foreign write coordinator: the passed writeCoordinator is not the source\'s declared owner (source.writeCoordinator) — its capture barrier would not exclude writes to this connection',
    );
  }
  const retention = validateRetention(options.retention);
  const blobs = options.blobs ?? null;
  if (blobs !== null) validateBlobSource(blobs);
  const now = options.now ?? (() => new Date());

  const root = path.resolve(source.root);
  const backupsDir = path.join(root, 'backups');
  const quarantineDir = path.join(root, 'quarantine');

  function backupIdFor(date: Date): string {
    return `${formatTimestamp(date)}-${randomBytes(6).toString('hex')}`;
  }

  // Quarantine policy is the shared authority's: one mover bound to this
  // manager's quarantine/, plus the shared diagnostic writer and completeness
  // check. The backup loop's wording stays exactly as it was.
  const moveToQuarantine = createQuarantineMover(quarantineDir);

  // Quarantine sweep: crash leftovers (a dir without a valid complete
  // manifest) move to quarantine/. Failures on individual entries are logged
  // and skipped — one broken leftover must not stop the sweep.
  function reconcileNow(): { quarantined: string[] } {
    return {
      quarantined: quarantineIncompleteBackups({
        backupsDir,
        diagnosticError: 'incomplete backup directory quarantined by reconcile',
        moveToQuarantine,
        now,
        onFailure: (err, dir) =>
          getLog().warn('system', 'reconcile failed to quarantine an incomplete backup', { error: sanitizeError(err), dir }),
      }),
    };
  }

  // The hard-failure path: snapshot/manifest stage threw. The partial directory
  // is quarantined with a diagnostic and the failure is reported — never a
  // complete marker.
  function quarantineFailed(
    stage: BackupDiagnostic['stage'],
    backupId: string,
    dir: string,
    err: unknown,
    detail: Record<string, unknown>,
  ): BackupResult {
    const diagnostic: BackupDiagnostic = { at: now().toISOString(), stage, error: sanitizeError(err), detail };
    let quarantinePath: string | null = null;
    try {
      writeDiagnostic(dir, diagnostic);
      quarantinePath = moveToQuarantine(dir);
    } catch (moveErr) {
      getLog().error('system', 'backup failed closed and could not be quarantined', {
        error: sanitizeError(moveErr),
        stage,
        backupId,
        dir,
      });
    }
    getLog().error('system', 'backup failed closed', { error: sanitizeError(err), stage, backupId, quarantinePath });
    return {
      ok: false,
      status: 'failed',
      backupId,
      directory: quarantinePath ?? dir,
      quarantined: quarantinePath !== null,
      diagnostic,
    };
  }

  function creationFailed(backupId: string, err: unknown): BackupResult {
    const diagnostic: BackupDiagnostic = { at: now().toISOString(), stage: 'creation', error: sanitizeError(err), detail: { backupId } };
    let quarantinePath: string | null = null;
    try {
      // The backup dir was never created — the diagnostic lands directly in
      // quarantine so the failure is retained without a data-bearing backup.
      quarantinePath = path.join(quarantineDir, `${backupId}.diagnostic.json`);
      writeFileSync(quarantinePath, `${JSON.stringify(diagnostic, null, 2)}\n`, { mode: 0o600 });
    } catch {
      /* the quarantine write itself failed (e.g. disk-full everywhere) — the log entry below is all we have */
    }
    getLog().error('system', 'backup creation failed closed', { backupId, error: sanitizeError(err), quarantinePath });
    return {
      ok: false,
      status: 'failed',
      backupId,
      directory: quarantinePath ?? path.join(backupsDir, backupId),
      quarantined: quarantinePath !== null,
      diagnostic,
    };
  }

  async function backup(): Promise<BackupResult> {
    const startedAt = now();
    const backupId = backupIdFor(startedAt);
    const dir = path.join(backupsDir, backupId);
    const snapshotPath = path.join(dir, 'snapshot.sqlite');
    const blobsDir = path.join(dir, 'blobs');
    const manifestPath = path.join(dir, 'manifest.json');

    // Quarantine crash leftovers first so backups/ only ever holds complete
    // backups (best-effort: a leftover that refuses to move is logged, never
    // allowed to fail the fresh backup).
    try {
      reconcileNow();
    } catch (err) {
      getLog().warn('system', 'backup reconcile sweep failed', { error: sanitizeError(err), backupId });
    }

    try {
      mkdirSync(dir, { recursive: false, mode: 0o700 });
    } catch (err) {
      return creationFailed(backupId, err);
    }
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort tightening */
    }

    // ---- THE single consistency boundary: committed DB state + referenced
    // blob set, inside ONE coordinated turn. The snapshot and the census
    // observe the same committed prefix; nothing can write between them.
    // Only those two hold the mutex: once the snapshot file is sealed it is
    // immutable, so integrity/quick_check, schema identity and migration-ledger
    // reads run OUTSIDE the lock. A long verification can no longer stall every
    // platform writer while the backup is being captured. On Bun the snapshot
    // hook (sqlite-driver.backupDatabase) opens a separate read-only connection
    // on the source file for VACUUM INTO, so the full copy does not hold the
    // live connection's SQLite write transaction either. ----
    let capture: CapturedState;
    try {
      const barrier = await writeCoordinator.run(() => captureCommittedBarrier(snapshotPath));
      const snapshotState = readSnapshotState(snapshotPath);
      // Blob census fail-closed: a blob-capable schema means adopted blob
      // generations MAY exist, and a no-seam capture can only record an empty
      // blob set — which would falsely report complete. Refuse instead.
      if (blobs === null && snapshotState.blobCapableSchema) {
        throw new Error(
          `backup refuses a blob-capable database without a blob census seam: the schema declares ${BLOB_METADATA_LEDGER}, so adopted blob generations may exist — supply a census seam (backupManager blobs) or this backup would silently record an empty blob set`,
        );
      }
      capture = { ...barrier, ...snapshotState };
    } catch (err) {
      return quarantineFailed('snapshot', backupId, dir, err, { backupId });
    }

    // ---- Byte copy OUTSIDE the barrier. Blob bytes are immutable and
    // content-addressed; a referenced generation is never reaped while it is
    // referenced, so the copy cannot race a writer. A generation whose bytes
    // are pending finalization or missing makes materialize throw — partial.
    // The `blobs/` directory is part of the mandated layout (§6) even when no
    // blob seam is configured. ----
    const missingGenerations: string[] = [];
    try {
      mkdirSync(blobsDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      return quarantineFailed('blob-copy', backupId, dir, err, { backupId, blobGenerations: capture.blobGenerations });
    }
    try {
      chmodSync(blobsDir, 0o700);
    } catch {
      /* best-effort tightening */
    }
    // Each referenced generation must land VERIFIED bytes before the backup can
    // be complete (review #82 finding 2): materialize must report the files it
    // wrote and the manager stats every reported file against the reported
    // size. A generation that throws, reports nothing, or writes the wrong
    // bytes is MISSING — partial, never complete.
    for (const generation of capture.blobGenerations) {
      try {
        // `blobGenerations` is [] when no blob seam is configured, so the
        // optional call never fires in that case.
        const report = await blobs?.materialize(generation, blobsDir);
        const verified = verifyMaterialization(generation, blobsDir, report);
        if (verified.ok) continue;
        missingGenerations.push(generation);
        getLog().warn('system', 'backup blob materialization failed verification', {
          backupId,
          generation,
          reason: sanitizeMessage(verified.reason),
        });
      } catch (err) {
        missingGenerations.push(generation);
        getLog().warn('system', 'backup blob materialization failed', { backupId, generation, error: sanitizeError(err) });
      }
    }

    const complete = capture.integrityResult.ok && missingGenerations.length === 0;
    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      platformSchemaIdentity: capture.platformSchemaIdentity,
      appSchemaIdentity: capture.appSchemaIdentity,
      migrationLedgerState: capture.migrationLedgerState,
      integrityResult: capture.integrityResult,
      blobGenerations: capture.blobGenerations,
      createdAt: startedAt.toISOString(),
      completedAt: now().toISOString(),
      status: complete ? 'complete' : 'partial',
      encryption: 'none',
    };

    // Manifest LAST: a `complete` manifest implies the snapshot and every
    // blob byte already landed. A crash before this point leaves no manifest,
    // so the next reconcile quarantines the dir. The verification just above
    // and this write are NOT one atomic filesystem op — the byte window is
    // documented in the module header: blob bytes are immutable/content-
    // addressed so no writer can swap them, and anyone who can alter files in
    // the owned directory could rewrite the manifest itself. Verification is a
    // gate on what the materializer claims, not a defense against a directory
    // owner.
    try {
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    } catch (err) {
      return quarantineFailed('manifest', backupId, dir, err, { backupId, snapshotWritten: true });
    }

    if (!complete) {
      const diagnostic: BackupDiagnostic = {
        at: now().toISOString(),
        stage: 'blob-copy',
        error:
          missingGenerations.length > 0
            ? `referenced blob generations unavailable: ${missingGenerations.join(', ')}`
            : 'snapshot integrity check failed',
        detail:
          missingGenerations.length > 0
            ? { missingGenerations }
            : { integrityFindings: capture.integrityResult.findings.map((finding) => finding.message) },
      };
      try {
        writeDiagnostic(dir, diagnostic);
      } catch {
        /* the partial is quarantined regardless */
      }
      const quarantinePath = moveToQuarantine(dir);
      getLog().warn('system', 'backup completed partial and was quarantined', { backupId, quarantinePath });
      return {
        ok: false,
        status: 'partial',
        backupId,
        directory: quarantinePath,
        quarantined: true,
        manifest,
        diagnostic,
      };
    }

    getLog().info('system', 'backup completed', { backupId, directory: dir, pages: capture.pages });
    return { ok: true, status: 'complete', backupId, directory: dir, manifest };
  }

  // Only the work that MUST share the commit barrier runs inside the mutex:
  // the WAL probe, the SQLite snapshot copy, and the referenced blob census.
  // The snapshot file is sealed when backupTo resolves; every other read is
  // over that immutable file and runs outside the coordinator after this turn.
  async function captureCommittedBarrier(snapshotPath: string): Promise<Pick<CapturedState, 'pages' | 'blobGenerations'>> {
    // WAL fail-closed probe: the ticket's snapshot is WAL-safe by contract, and
    // a plain copy of the main database file would silently drop WAL content —
    // so a non-WAL source is refused outright instead of being approximated.
    const modeRow = source.handle.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    if (modeRow?.journal_mode !== 'wal') {
      throw new Error(
        `backup requires a WAL-mode source (journal_mode=${modeRow?.journal_mode ?? 'unknown'}); a raw main-file copy is not a valid snapshot`,
      );
    }
    const pages = await source.backupTo(snapshotPath);
    const blobGenerations = blobs === null ? [] : Array.from(await blobs.census());
    return { pages, blobGenerations };
  }

  function list(): readonly BackupListing[] {
    return listCompleteBackups<BackupManifest>(backupsDir);
  }

  function backupTimeOf(name: string, manifest: BackupManifest): Date {
    const parsed = parseBackupTimestamp(name);
    if (parsed) return parsed;
    const fromManifest = new Date(manifest.createdAt);
    if (!Number.isNaN(fromManifest.getTime())) return fromManifest;
    return new Date(0);
  }

  async function trim(): Promise<TrimResult> {
    // Sweep first so retention only ever counts genuinely complete backups.
    // reconcileNow throws on an unreadable backups/ dir — trim fails closed.
    reconcileNow();

    const entries = readdirSync(backupsDir)
      .map((name) => ({ name, dir: path.join(backupsDir, name) }))
      .filter((entry) => isDirectory(entry.dir))
      .map((entry) => {
        const manifest = readCompleteManifest<BackupManifest>(entry.dir);
        return manifest === null ? null : { ...entry, manifest, at: backupTimeOf(entry.name, manifest) };
      })
      .filter((entry): entry is TrimEntry => entry !== null)
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    const keep = new Set<string>();
    // An undateable backup is never deleted (fail-safe: retention must not
    // over-delete what it cannot date).
    for (const entry of entries) {
      if (entry.at.getTime() === 0) keep.add(entry.name);
    }

    // Daily keepers: the newest backup of each of the N most recent days.
    const byDay = new Map<string, TrimEntry[]>();
    for (const entry of entries) {
      const day = entry.at.toISOString().slice(0, 10);
      const group = byDay.get(day) ?? [];
      group.push(entry);
      byDay.set(day, group);
    }
    const days = [...byDay.keys()].sort().reverse().slice(0, retention.daily);
    for (const day of days) {
      const newest = byDay.get(day)!.slice().sort((a, b) => b.at.getTime() - a.at.getTime())[0];
      keep.add(newest.name);
    }

    // Hourly keepers: the M most recent backups not already kept.
    const unkept = entries.filter((entry) => !keep.has(entry.name)).slice().sort((a, b) => b.at.getTime() - a.at.getTime());
    for (const entry of unkept.slice(0, retention.hourly)) keep.add(entry.name);

    // Fail closed: rmSync is non-force so a permission/disk error THROWS — a
    // trim that could not remove every selected backup rejects instead of
    // reporting success.
    const removed: string[] = [];
    for (const entry of entries) {
      if (keep.has(entry.name)) continue;
      rmSync(entry.dir, { recursive: true, force: false });
      removed.push(entry.name);
    }
    return { retained: keep.size, removed };
  }

  return Object.freeze({
    backup,
    list,
    trim,
    reconcile: reconcileNow,
    retention,
    root,
  });
}

// ---- internals -----------------------------------------------------------

type CapturedState = {
  pages: number;
  blobGenerations: string[];
  blobCapableSchema: boolean;
  integrityResult: IntegrityReport;
  platformSchemaIdentity: string;
  appSchemaIdentity: string[];
  migrationLedgerState: BackupMigrationLedgerState;
};

type TrimEntry = { name: string; dir: string; manifest: BackupManifest; at: Date };

function validateRetention(retention: Partial<BackupRetentionConfig> | undefined): Readonly<BackupRetentionConfig> {
  const daily = retention?.daily ?? DEFAULT_RETENTION.daily;
  const hourly = retention?.hourly ?? DEFAULT_RETENTION.hourly;
  if (!Number.isInteger(daily) || daily < 1) {
    throw new TypeError('backup retention daily must be a positive integer');
  }
  if (!Number.isInteger(hourly) || hourly < 0) {
    throw new TypeError('backup retention hourly must be a non-negative integer');
  }
  return Object.freeze({ daily, hourly });
}

function validateBlobSource(blobs: BackupBlobSource): void {
  if (typeof blobs.census !== 'function' || typeof blobs.materialize !== 'function') {
    throw new TypeError('backup blobs source must expose census() and materialize(generation, destBlobDir)');
  }
}

// Snapshot-side capture: integrity (quick_check), schema identity, and the
// applied migration ledgers — all read from the snapshot file (the consistent
// committed state), never from the live connection. The snapshot inherits the
// source's WAL mode, so a READ-ONLY open without a -shm can block while SQLite
// retries shared-memory creation; the snapshot is our own freshly-written file,
// so the inspection opens it read-WRITE (no external reader is affected) and
// then removes the `-shm`/`-wal` sidecars a clean read leaves behind — the
// backup directory holds exactly `snapshot.sqlite` + `manifest.json` + `blobs/`.
function readSnapshotState(snapshotPath: string): Omit<CapturedState, 'pages' | 'blobGenerations'> {
  const snapshot = openSqliteDatabase(snapshotPath);
  try {
    return {
      integrityResult: quickCheckOf(snapshot),
      ...schemaIdentityOf(snapshot),
      migrationLedgerState: readMigrationLedger(snapshot),
      blobCapableSchema: hasBlobLedger(snapshot),
    };
  } finally {
    try {
      snapshot.close();
    } finally {
      for (const sidecar of ['-shm', '-wal']) {
        try {
          rmSync(`${snapshotPath}${sidecar}`, { force: true });
        } catch {
          /* best-effort: a leftover sidecar is cosmetic, never data-bearing */
        }
      }
    }
  }
}

// A schema is blob-capable when it declares the framework blob-metadata ledger:
// adopted blob generations may exist, so a census-less backup must refuse.
function hasBlobLedger(db: SqliteDatabase): boolean {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', BLOB_METADATA_LEDGER));
}


