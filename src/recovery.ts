// recovery.ts — S1/A4 restore + quarantine (epic scope#23, library/API + tests
// only — no scheduler, no timer, no cron). Part of JavaGT/scope#576.
//
// CONTRACT: `createRecoveryManager` produces a manager whose
// `recover({ backupId })` performs VALIDATE-THEN-ACTIVATE against the backup
// layout `backups/<timestamp>-<id>/` produced by the S1/A3 backup manager
// (snapshot.sqlite + manifest.json + blobs/). Recovery is the only path that
// installs a database file into the owned directory. It validates EVERYTHING
// before activating, quarantines the damaged database (and any failed attempt)
// into `quarantine/<timestamp>-<id>/`, and never marks a restore complete until
// a full schema + blob census passes.
//
// VALIDATE-THEN-ACTIVATE (owner decision #1): the live database is NEVER
// replaced until the chosen backup has passed every gate — manifest shape
// (formatVersion, status 'complete', encryption 'none'), SQLite integrity_check,
// recomputed schema identity vs the manifest, the migration ledger that EXISTS
// in the snapshot (never a fresh-reset assumption; ScopeSchemaVersion stays
// Scope-owned until S8), and referenced-blob availability. Any failure aborts
// with the backup left untouched.
//
// STOP-AND-ASK DEFAULT (owner decision #1): `probe()` returns an explicit
// 'recovery-required' state with a plain-language explanation when the live
// database is damaged, and lists the available backups — it NEVER auto-selects
// one. `recover()` requires an explicit backupId; there is NO code path that
// falls back to an older backup. Interactive prompting belongs to the Operator
// (Scope) in S8, not here. The CLI entry (`scripts/recover.mjs`,
// `--recover <backupId>` / `--list-backups`) drives the same library API.
//
// COORDINATOR-SERIALIZED REPLACEMENT (acceptance): the quarantine + atomic swap
// runs inside the platform write coordinator turn — recovery never restores
// over a live database without that serialization. `createRecoveryManager`
// verifies at construction that the coordinator it is given is the source's
// declared owner (`source.writeCoordinator`); an unbound or foreign-coordinator
// source is refused, exactly like `createBackupManager` (a swap that is not
// serialized against live writes can clobber a database in use).
//
// CRASH SAFETY: the swap is [copy snapshot → staged `data.sqlite.<token>`] →
// [quarantine live data.sqlite + -wal + -shm TOGETHER] → [atomic rename stage →
// data.sqlite]. A crash at any point never leaves a half-written data.sqlite:
// the quarantine moves the damaged database out of the way as a whole (a stale
// WAL/shm sidecar can never pair with the restored file), and the final rename
// is atomic. The full census runs on the staged bytes BEFORE the swap, so a
// failing census leaves the live database and the backup untouched. A crash
// DURING blob materialization into the LIVE target leaves a byte-without-sidecar
// partial in the owned root's persistent blobs/ directory — the manager only
// quarantines the staged database file, never that directory — and the blob
// seam REPAIRS the leftover on the next attempt: it re-materializes the missing
// digest sidecar once the byte final verifies as the generation's own bytes
// (see the seam contract), so a crashed restore never permanently blocks a
// later restore of the same generations.
//
// DIRECTORY PRESERVATION (spec 5): recovery's swap and fresh-directory restore
// never wipe `backups/`, `quarantine/`, or `recycle/` (owned by S1/A3/A4/A6).
// The adapter teardown removes only the db file, -wal/-shm, and lock sidecar —
// a dev/reset path must clear database state, never recovery/backup material.
//
// The blob seam is DELIBERATELY pluggable (S6 owns blob enumeration and
// materialization): this module DECLARES the S6 blob-generation interface
// (`RecoveryBlobSeam`) and only calls into it. Without a seam, a backup that
// references blob generations refuses fail-closed (its bytes cannot be
// verified), mirroring the backup manager's no-seam rule. Verification ALONE is
// never enough: the seam must ALSO materialize the verified generations into
// the target's blob layout before the census runs, or the census would see
// missing bytes (fresh target) or stale bytes (live restore).

import { openSqliteDatabase, type SqliteDatabase } from './sqlite-driver.ts';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { frameworkTableNames } from './schema-table-census.ts';
import { getLog } from './log.ts';
import { createWriteQueue } from './write-queue.ts';
import { MIGRATION_LEDGER_TABLE } from './migration-ledger.ts';
import type { LedgerEntry } from './migration-ledger.ts';
import type {
  BackupWriteCoordinator,
  BackupManifest,
  BackupMigrationLedgerState,
  MaterializedBlobFile,
} from './backup.ts';
import type { IntegrityFinding, IntegrityReport } from './db-adapter.ts';
import { BACKUP_FORMAT_VERSION } from './backup.ts';

// The backup directory naming shared with the S1/A3 backup manager
// (`backups/<timestamp>-<id>/`). A backup id is opaque to restore: it is a
// filesystem name, validated here so a user-supplied id can never escape
// backups/ via a path separator or '..'.
const BACKUP_NAME = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-([0-9a-f]+)$/;

// The owned-directory vocabulary (kept in sync with sqlite-adapter.ts's
// MANAGED_SUBDIRECTORIES — the S1 section's directory-guard tests pin it):
// backups/ + quarantine/ live here, recycle/ is S1/A6's, blobs/ + staging/ are
// the blob store's. The physical database filename is derived the same way the
// adapter derives it.
export const RECOVERY_DATA_FILENAME = 'data.sqlite';
const BACKUPS_DIR = 'backups';
const QUARANTINE_DIR = 'quarantine';
const RECOVERY_MANAGED_SUBDIRECTORIES = Object.freeze(['blobs', 'staging', 'backups', 'quarantine', 'recycle'] as const);
// Staged copies of a snapshot waiting for the atomic swap. A leftover under
// this prefix in the owned directory means a restore crashed mid-swap.
const STAGE_PREFIX = 'data.sqlite.recovering-';

// The ONE DECLARED migration ledger table name (kept in sync with backup.ts's
// manifest type and migration-ledger.ts's MIGRATION_LEDGER_TABLE). This is the
// ONLY name a restore accepts: it is interpolated into SQL, and the manifest is
// untrusted input, so a manifest-chosen table name is refused (review #83).
const MIGRATION_LEDGER = MIGRATION_LEDGER_TABLE;

function foldedNamespace(namespace: string): string {
  return namespace.toLowerCase();
}

// Ordering for the namespaced ledger's applied versions uses the same folded
// namespace identity as the migration runner, then version.
function compareLedgerEntry(a: LedgerEntry, b: LedgerEntry): number {
  const aNamespace = foldedNamespace(a.namespace);
  const bNamespace = foldedNamespace(b.namespace);
  if (aNamespace !== bNamespace) return aNamespace < bNamespace ? -1 : 1;
  return a.version - b.version;
}

// Upper bound on error messages persisted in diagnostics / logged (review #82
// finding 4 policy): stage + identifier + a short sanitized reason, never row
// data and never blob bytes.
export const MAX_RECOVERY_DIAGNOSTIC_ERROR_LENGTH = 500;

function sanitizeMessage(value: string): string {
  const singleLine = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  const redacted = singleLine.replace(/\S{129,}/g, (run) => `<redacted-${run.length}>`);
  return redacted.slice(0, MAX_RECOVERY_DIAGNOSTIC_ERROR_LENGTH);
}

function sanitizeError(err: unknown): string {
  if (err instanceof Error) return sanitizeMessage(err.message);
  if (typeof err === 'string') return sanitizeMessage(err);
  return sanitizeMessage(String(err));
}

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, '-');
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Deep-equality for the manifest comparison surfaces (arrays of strings and the
// migration ledger object). Order matters for both, so JSON comparison is the
// honest check.
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- public types ---------------------------------------------------------

// The pluggable blob-generation seam (S6 declares + implements the concrete
// census). The backup side (`BackupBlobSource`) materializes generations INTO
// the backup; the recovery side verifies those bytes pre-activation, materializes
// them into the target's blob layout, and censuses the live/fresh blob store
// before a restore may be complete.
export type RecoveryBlobSeam = {
  // Verify the backup actually holds verified bytes for one referenced
  // generation. Throws when the generation's bytes are missing or unverifiable
  // → the restore aborts with the backup left untouched.
  verifyBackupGeneration?(generation: string, backupBlobsDir: string): Promise<void> | void;
  // Materialize one verified generation's bytes from the backup's blobs/ into
  // the target's blob-store layout (`destBlobDir` — the target's `blobs/`
  // subdirectory, the same layout the backup side materialized into). Returns
  // the files written (name + size) so recovery can verify the bytes actually
  // landed. Required whenever a backup references generations: verification
  // alone leaves the target with no bytes for the census to see.
  materializeRestoreGeneration?(
    generation: string,
    backupBlobsDir: string,
    destBlobDir: string,
  ): Promise<readonly MaterializedBlobFile[]> | readonly MaterializedBlobFile[];
  // Post-restore blob census: confirm every referenced generation is available
  // in the live blob store of `targetRoot` (the owned directory, or the fresh
  // directory in a fresh restore) before the app is allowed to serve. Throws →
  // the restore is not marked complete (fail closed). S6 provides the concrete
  // census; absent a seam, a backup referencing generations is refused.
  censusAfterRestore?(generations: readonly string[], targetRoot: string): Promise<void> | void;
};

// The migration-ledger validation seam (S1/A4 spec 1: "declared schema identity
// matches the ledger that EXISTS"). ScopeSchemaVersion is Scope-owned until S8,
// so the LIBRARY cannot know the app's declared identity — this seam lets the
// app/Scope assert its declared schema against the ledger the backup actually
// holds. The default validation checks internal consistency + that the snapshot
// recomputes to exactly the manifest's recorded ledger (never a fresh-reset
// assumption).
export type RecoveryMigrationValidator = (
  ledger: BackupMigrationLedgerState,
  manifest: BackupManifest,
) => void | Promise<void>;

// The recovery source: the owned directory plus (for activation) the ONE write
// coordinator that serializes writes to that directory's database. An opened
// sqlite adapter satisfies this shape (`root`, `writeCoordinator`, and the
// read-only `probeRecovery` hook). For a corrupt database the adapter cannot be
// opened (its fail-closed quick_check throws), so a recovery manager may be
// built over a plain `{ root }` source — the manager probes the file directly.
export type RecoverySource = {
  readonly root: string;
  // The physical database filename under root; defaults to the adapter's
  // derived name ('data.sqlite').
  readonly dataFilename?: string;
  // OWNERSHIP BINDING (mirrors backup): REQUIRED for activation. The swap runs
  // through this coordinator; `createRecoveryManager` asserts the passed
  // coordinator is EXACTLY this object.
  readonly writeCoordinator?: BackupWriteCoordinator;
  // Optional read-only adapter-provided probe (sqlite-adapter.ts's recover
  // wiring). The manager uses it when present, else probes the file itself.
  probeRecovery?(): RecoveryProbeResult;
};

export type RecoveryManagerOptions = {
  readonly source: RecoverySource;
  // The ONE platform write coordinator (write-queue.ts) — MUST be the exact
  // coordinator the source declares as its owner (`source.writeCoordinator`).
  readonly writeCoordinator: BackupWriteCoordinator;
  // The pluggable blob seam (S6 implements). Optional; a backup that references
  // blob generations refuses without it (its bytes cannot be verified).
  readonly blobs?: RecoveryBlobSeam | null;
  // Optional declared-identity ledger validator (see RecoveryMigrationValidator).
  readonly validateMigrationLedger?: RecoveryMigrationValidator | null;
  readonly now?: () => Date;
  // Crash-injection seams used by the restore-swap durability tests: throwing
  // from a hook aborts the recovery at that point. The swap must remain
  // crash-safe — data.sqlite is never partially written, and every leftover is
  // quarantined. Never used in production.
  readonly faults?: RecoveryFaultInjection;
};

// Crash-injection seams for the restore-swap durability tests (S1/A4 test list
// `recovery-swap.test.mjs`). Not a production surface.
export type RecoveryFaultInjection = {
  readonly beforeStage?: () => void;
  readonly beforeQuarantine?: () => void;
  readonly beforeRename?: () => void;
};

// The read-only health probe result. `probe()` folds this into the explicit
// 'recovery-required' state; `probeDatabaseFile` is the canonical non-throwing
// file probe the sqlite adapter's `probeRecovery` hook delegates to.
export type RecoveryProbeResult =
  | Readonly<{ ok: true; checkedAt: string }>
  | Readonly<{ ok: false; reason: string; findings: readonly string[] }>;

export type RecoveryListing = Readonly<{
  readonly backupId: string;
  readonly directory: string;
  readonly manifest: BackupManifest;
  readonly createdAt: string;
}>;

// The explicit startup state (spec 3: stop and explain plainly, return an
// explicit 'recovery required' state; NO automatic destructive fallback). The
// healthy branch is `{ ok: true }`; the damaged branch carries a plain-language
// reason plus the available backups, which are listed but never auto-selected.
export type RecoveryState =
  | Readonly<{ ok: true; checkedAt: string }>
  | Readonly<{
      ok: false;
      state: 'recovery-required';
      reason: string;
      findings: readonly string[];
      interruptedRecovery: boolean;
      backups: readonly RecoveryListing[];
    }>;

export type RecoveryCensus = {
  readonly schema: Readonly<{ ok: boolean; findings: readonly string[] }>;
  readonly blobs: Readonly<{ ok: boolean; reason?: string }>;
};

export type RecoveryResult =
  | Readonly<{
      ok: true;
      status: 'restored';
      backupId: string;
      // The owned directory now holds the restored database.
      directory: string;
      // The quarantine dir holding the previous (damaged) database, or null
      // when there was none to quarantine.
      quarantinedDatabase: string | null;
      census: RecoveryCensus;
    }>
  | Readonly<{
      ok: false;
      status: 'rejected' | 'failed';
      backupId: string;
      // Plain-language explanation for the operator.
      reason: string;
      // Structured validation findings (status 'rejected').
      validation?: readonly string[];
      // Quarantine dirs retained on a failed activation (never overwritten).
      quarantined?: readonly string[];
      census?: RecoveryCensus;
    }>;

export type FreshRecoveryResult =
  | Readonly<{ ok: true; status: 'restored'; backupId: string; directory: string; census: RecoveryCensus }>
  | Readonly<{
      ok: false;
      status: 'rejected' | 'failed';
      backupId: string;
      reason: string;
      validation?: readonly string[];
      census?: RecoveryCensus;
    }>;

export type RecoveryManager = {
  // Read-only health probe → the explicit recovery-required state with a
  // plain-language explanation. Never mutates, never auto-selects a backup.
  probe(): RecoveryState;
  // Recoverable (complete) backups, newest first.
  list(): readonly RecoveryListing[];
  // Quarantine crash leftovers: incomplete backup dirs and stale recovery stage
  // files (an interrupted swap). Failures on individual entries are logged and
  // skipped — one broken leftover must not stop the sweep.
  reconcile(): Readonly<{ quarantined: readonly string[] }>;
  // Validate-then-activate restore into the owned directory (coordinator-
  // serialized swap; census-before-serve).
  recover(options: { backupId: string }): Promise<RecoveryResult>;
  // Restore into a FRESH directory (test-strategy requirement) + the full
  // schema + blob census before serving. Refuses a non-empty target.
  recoverIntoFreshDirectory(options: { backupId: string; directory: string }): Promise<FreshRecoveryResult>;
  readonly root: string;
};

// ---- the canonical read-only file probe -----------------------------------

// Non-throwing health probe for a database FILE. Opens the file (read-write,
// like the backup manager's snapshot inspection — a read-only WAL open without
// a -shm can block) and runs the fast quick scan. Reports `ok: false` with a
// plain reason and the integrity findings when the file cannot be opened or is
// corrupt — including a corrupt WAL, which fails at open. Sidecars are NOT
// removed here: a healthy live database may have a connection using them, and
// removing them would damage that connection. A missing file is healthy (a
// brand-new owned directory has nothing to recover).
export function probeDatabaseFile(dbFilePath: string): RecoveryProbeResult {
  if (!existsSync(dbFilePath)) {
    return { ok: true, checkedAt: new Date().toISOString() };
  }
  let db: SqliteDatabase;
  try {
    db = openSqliteDatabase(dbFilePath);
  } catch (err) {
    return { ok: false, reason: 'the database file could not be opened — it is corrupt or damaged', findings: [sanitizeError(err)] };
  }
  try {
    const rows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
    const findings: string[] = [];
    for (const row of rows) {
      if (row.quick_check !== 'ok') findings.push(row.quick_check);
    }
    if (findings.length === 0) return { ok: true, checkedAt: new Date().toISOString() };
    return { ok: false, reason: 'the database failed integrity verification — it is corrupt or damaged', findings };
  } catch (err) {
    return { ok: false, reason: 'the database could not be read — it is corrupt or damaged', findings: [sanitizeError(err)] };
  } finally {
    try {
      db.close();
    } catch {
      /* best-effort close on the probe failure path */
    }
  }
}

// ---- manager --------------------------------------------------------------

export function createRecoveryManager(options: RecoveryManagerOptions): RecoveryManager {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createRecoveryManager requires an options object');
  }
  const source = options.source;
  if (!source || typeof source.root !== 'string' || source.root.length === 0) {
    throw new TypeError('recovery manager requires a FILE-mode source with an owned directory (root)');
  }
  if (!options.writeCoordinator || typeof options.writeCoordinator.run !== 'function') {
    throw new TypeError('recovery manager requires the single write coordinator (writeCoordinator.run) for the coordinated swap');
  }
  const writeCoordinator = options.writeCoordinator;
  // COORDINATOR OWNERSHIP (acceptance: never restore over a live database
  // without coordinator-serialized replacement). Shape is not proof — the swap
  // must run through the ONE coordinator that serializes writes to this
  // directory's database, so the source must declare its owner and the passed
  // coordinator must be exactly it.
  if (source.writeCoordinator === undefined) {
    throw new TypeError(
      'recovery manager requires the source to declare the write coordinator that owns it: bind source.writeCoordinator to the coordinator that serializes writes to this database (an unbound source cannot prove its swap excludes writes)',
    );
  }
  if (source.writeCoordinator !== writeCoordinator) {
    throw new TypeError(
      'recovery manager refuses a foreign write coordinator: the passed writeCoordinator is not the source\'s declared owner (source.writeCoordinator) — its swap would not be serialized against writes to this database',
    );
  }
  const blobs = options.blobs ?? null;
  if (
    blobs !== null &&
    (typeof blobs.verifyBackupGeneration !== 'function' &&
      typeof blobs.materializeRestoreGeneration !== 'function' &&
      typeof blobs.censusAfterRestore !== 'function')
  ) {
    throw new TypeError(
      'recovery blobs source must expose verifyBackupGeneration(generation, backupBlobsDir), materializeRestoreGeneration(generation, backupBlobsDir, destBlobDir), and/or censusAfterRestore(generations, targetRoot)',
    );
  }
  const validateMigrationLedger = options.validateMigrationLedger ?? null;
  if (validateMigrationLedger !== null && typeof validateMigrationLedger !== 'function') {
    throw new TypeError('recovery validateMigrationLedger must be a function');
  }
  const faults = options.faults;
  const now = options.now ?? (() => new Date());

  const root = path.resolve(source.root);
  const dataFilename = source.dataFilename ?? RECOVERY_DATA_FILENAME;
  const dataFile = path.join(root, dataFilename);
  const backupsDir = path.join(root, BACKUPS_DIR);
  const quarantineDir = path.join(root, QUARANTINE_DIR);

  // The recovery manager owns the same managed layout the adapter creates, so
  // it works over a directory that has never been opened (the CLI, and the
  // corrupt-db stop-and-ask path where the adapter refuses to open).
  for (const dir of [root, ...RECOVERY_MANAGED_SUBDIRECTORIES.map((name) => path.join(root, name))]) {
    ensurePrivateDirectory(dir);
  }

  function recoveryToken(): string {
    return `${formatTimestamp(now())}-${randomBytes(6).toString('hex')}`;
  }

  function freshQuarantineDir(): string {
    const base = recoveryToken();
    let target = path.join(quarantineDir, base);
    let suffix = 0;
    while (existsSync(target)) {
      suffix += 1;
      target = path.join(quarantineDir, `${base}.q${suffix}`);
    }
    return target;
  }

  function writeDiagnostic(dir: string, diagnostic: Readonly<{ at: string; stage: string; error: string; detail?: Record<string, unknown> }>): void {
    writeFileSync(path.join(dir, 'diagnostic.json'), `${JSON.stringify(diagnostic, null, 2)}\n`, { mode: 0o600 });
  }

  function moveToQuarantine(dir: string): string {
    let target = path.join(quarantineDir, path.basename(dir));
    let suffix = 0;
    while (existsSync(target)) {
      suffix += 1;
      target = path.join(quarantineDir, `${path.basename(dir)}.q${suffix}`);
    }
    renameSync(dir, target);
    return target;
  }

  function isCompleteBackupDir(dir: string): boolean {
    try {
      if (!existsSync(path.join(dir, 'snapshot.sqlite'))) return false;
      const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
        status?: unknown;
        formatVersion?: unknown;
      };
      return manifest.formatVersion === BACKUP_FORMAT_VERSION && manifest.status === 'complete';
    } catch {
      return false;
    }
  }

  function readCompleteManifest(dir: string): BackupManifest | null {
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as BackupManifest;
      if (manifest.formatVersion !== BACKUP_FORMAT_VERSION || manifest.status !== 'complete') return null;
      return manifest;
    } catch {
      return null;
    }
  }

  function list(): readonly RecoveryListing[] {
    return readdirSync(backupsDir)
      .filter((entry) => isDirectory(path.join(backupsDir, entry)))
      .map((entry) => {
        const dir = path.join(backupsDir, entry);
        const manifest = readCompleteManifest(dir);
        return manifest === null ? null : { backupId: entry, directory: dir, manifest, createdAt: manifest.createdAt };
      })
      .filter((entry): entry is RecoveryListing => entry !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // Quarantine sweep (mirrors backup.ts's reconcile): crash leftovers (a dir
  // without a valid complete manifest) and stale recovery stage files move to
  // quarantine/. Failures on individual entries are logged and skipped.
  function reconcileNow(): { quarantined: string[] } {
    const quarantined: string[] = [];
    for (const entry of readdirSync(backupsDir)) {
      const dir = path.join(backupsDir, entry);
      if (!isDirectory(dir)) continue;
      if (isCompleteBackupDir(dir)) continue;
      try {
        if (!existsSync(path.join(dir, 'diagnostic.json'))) {
          writeDiagnostic(dir, {
            at: now().toISOString(),
            stage: 'quarantine',
            error: 'incomplete backup directory quarantined by recovery reconcile',
            detail: { dir: entry },
          });
        }
        quarantined.push(moveToQuarantine(dir));
      } catch (err) {
        getLog().warn('system', 'recovery reconcile failed to quarantine an incomplete backup', { error: sanitizeError(err), dir });
      }
    }
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith(STAGE_PREFIX)) continue;
      const file = path.join(root, entry);
      try {
        if (isDirectory(file)) continue;
        const target = freshQuarantineDir();
        mkdirSync(target, { mode: 0o700 });
        writeDiagnostic(target, {
          at: now().toISOString(),
          stage: 'quarantine',
          error: 'interrupted recovery stage file quarantined by recovery reconcile',
          detail: { file: entry },
        });
        renameSync(file, path.join(target, entry));
        quarantined.push(target);
      } catch (err) {
        getLog().warn('system', 'recovery reconcile failed to quarantine a stale stage file', { error: sanitizeError(err), file });
      }
    }
    return { quarantined };
  }

  function findStaleStageFiles(): string[] {
    try {
      return readdirSync(root).filter((entry) => entry.startsWith(STAGE_PREFIX));
    } catch {
      return [];
    }
  }

  function probe(): RecoveryState {
    const staleStage = findStaleStageFiles();
    const interruptedRecovery = staleStage.length > 0;
    if (!existsSync(dataFile)) {
      if (interruptedRecovery) {
        return {
          ok: false,
          state: 'recovery-required',
          reason:
            'an earlier restore was interrupted before the database was installed — the recovered copy is in quarantine and the database file is missing. Run reconcile() to quarantine the leftover, then restore from a backup explicitly.',
          findings: staleStage,
          interruptedRecovery,
          backups: list(),
        };
      }
      return { ok: true, checkedAt: new Date().toISOString() };
    }
    const probeResult = source.probeRecovery ? source.probeRecovery() : probeDatabaseFile(dataFile);
    if (probeResult.ok) return { ok: true, checkedAt: probeResult.checkedAt };

    const backups = list();
    const reason =
      `${probeResult.reason}. The application has stopped rather than risk data loss.` +
      (interruptedRecovery ? ' An interrupted recovery attempt was also found.' : '') +
      (backups.length > 0
        ? ` Restore from one of ${backups.length} available backup(s) — use the --recover <backupId> CLI entry or the programmatic recover() API.`
        : ' No backups are available to restore from.') +
      ' No backup was selected automatically.';
    return {
      ok: false,
      state: 'recovery-required',
      reason,
      findings: probeResult.findings,
      interruptedRecovery,
      backups,
    };
  }

  function validateBackupId(backupId: unknown): string | null {
    if (typeof backupId !== 'string' || !BACKUP_NAME.test(backupId)) {
      return 'invalid backupId — expected <ISO-timestamp>-<hex> (e.g. 2026-01-01T00-00-00.000Z-abcd1234ef567890)';
    }
    return null;
  }

  function validationReason(backupId: string, failures: readonly string[]): string {
    return `backup '${backupId}' could not be restored: ${failures.join('; ')}`;
  }

  // ---- the validation gates (ALL before any mutation) ----------------------

  async function validateBackup(
    backupDir: string,
  ): Promise<{ ok: true; manifest: BackupManifest } | { ok: false; failures: string[] }> {
    const snapshotPath = path.join(backupDir, 'snapshot.sqlite');
    if (!existsSync(snapshotPath)) return { ok: false, failures: ['backup has no snapshot.sqlite'] };

    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(readFileSync(path.join(backupDir, 'manifest.json'), 'utf8')) as BackupManifest;
    } catch {
      return { ok: false, failures: ['backup manifest is missing or unreadable'] };
    }
    const shapeFailures = validateManifestShape(manifest);
    if (shapeFailures.length > 0) return { ok: false, failures: shapeFailures };

    const failures: string[] = [];
    let db: SqliteDatabase;
    try {
      db = openSqliteDatabase(snapshotPath);
    } catch (err) {
      return { ok: false, failures: [`backup snapshot could not be opened: ${sanitizeError(err)}`] };
    }
    try {
      const integrity = integrityCheckOf(db);
      for (const finding of integrity.findings) failures.push(`backup snapshot failed integrity_check: ${finding}`);
      // RECOMPUTE the integrity the manifest recorded (the backup side records
      // a quick_check report) and require it to match the manifest — an
      // integrityResult that the snapshot does not reproduce (removed,
      // falsified, or stale) fails closed (issue #82 contract, review #83).
      const recordedIntegrity = quickCheckOf(db);
      if (recordedIntegrity.ok !== manifest.integrityResult.ok) {
        failures.push('snapshot integrity does not match the manifest integrityResult');
      }
      // The snapshot must recompute to EXACTLY the identities the manifest
      // recorded when the backup was taken — a drifted or tampered snapshot is
      // not the backup the manifest describes. A corrupt snapshot can throw at
      // the recompute queries themselves; any throw is a validation failure,
      // never a restore.
      let identity: { platformSchemaIdentity: string; appSchemaIdentity: string[] };
      let ledger: BackupMigrationLedgerState;
      try {
        identity = schemaIdentityOf(db);
        ledger = migrationLedgerOf(db, manifest);
      } catch (err) {
        failures.push(`backup snapshot could not be validated: ${sanitizeError(err)}`);
        return { ok: false, failures };
      }
      if (identity.platformSchemaIdentity !== manifest.platformSchemaIdentity) {
        failures.push('snapshot schema identity does not match the manifest (platform)');
      }
      if (!deepEqual(identity.appSchemaIdentity, manifest.appSchemaIdentity)) {
        failures.push('snapshot schema identity does not match the manifest (app)');
      }
      // The migration ledger that EXISTS in the snapshot (never a fresh-reset
      // assumption) must match the manifest AND be internally consistent.
      if (!deepEqual(ledger, manifest.migrationLedgerState)) {
        failures.push('snapshot migration ledger does not match the manifest');
      }
      failures.push(...validateLedgerConsistency(manifest.migrationLedgerState));
      if (validateMigrationLedger) {
        try {
          await validateMigrationLedger(manifest.migrationLedgerState, manifest);
        } catch (err) {
          failures.push(`migration ledger rejected by the declared schema identity: ${sanitizeError(err)}`);
        }
      }
    } finally {
      try {
        db.close();
      } catch {
        /* best-effort close on the validation path */
      }
    }
    if (failures.length > 0) return { ok: false, failures };

    const blobFailures = await validateBlobAvailability(manifest, backupDir);
    if (blobFailures.length > 0) return { ok: false, failures: blobFailures };
    return { ok: true, manifest };
  }

  // Manifests record timestamps as the canonical UTC ISO-8601 instant the
  // backup side writes (`Date.prototype.toISOString()`: YYYY-MM-DDTHH:mm:ss.sssZ).
  // Both the format AND the round-trip must hold: `Date.parse` normalizes
  // impossible dates (2026-02-30T00:00:00.000Z silently becomes March 2) and
  // lenient forms ('yesterday', no-millis, +00:00), so re-serializing the
  // parsed instant must reproduce the recorded string exactly.
  function isValidIsoUtcTimestamp(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    const instant = Date.parse(value);
    if (Number.isNaN(instant)) return false;
    return new Date(instant).toISOString() === value;
  }

  function validateManifestShape(manifest: BackupManifest): string[] {
    const failures: string[] = [];
    if (typeof manifest !== 'object' || manifest === null) return ['manifest is not an object'];
    if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
      failures.push(`unsupported backup formatVersion ${JSON.stringify(manifest.formatVersion)} (expected ${BACKUP_FORMAT_VERSION})`);
    }
    if (manifest.status !== 'complete') {
      failures.push(`backup is not complete (status ${JSON.stringify(manifest.status)})`);
    }
    if (manifest.encryption !== 'none') {
      failures.push(
        `backup declares encryption ${JSON.stringify(manifest.encryption)} — the platform restores only volume-encrypted (encryption 'none') backups`,
      );
    }
    // Issue #82 manifest contract: validate EVERY enumerated field (types +
    // content), never a subset. A manifest that omits or falsifies a recorded
    // identity/integrity field must not restore (review #83).
    if (typeof manifest.platformSchemaIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.platformSchemaIdentity)) {
      failures.push('manifest platformSchemaIdentity is not a valid schema fingerprint (64 lowercase hex)');
    }
    if (
      !Array.isArray(manifest.appSchemaIdentity) ||
      manifest.appSchemaIdentity.some((id) => typeof id !== 'string' || id.length === 0)
    ) {
      failures.push('manifest appSchemaIdentity is not an array of non-empty strings');
    }
    if (!isValidIsoUtcTimestamp(manifest.createdAt)) {
      failures.push('manifest createdAt is not a valid ISO-8601 UTC timestamp');
    }
    if (!isValidIsoUtcTimestamp(manifest.completedAt)) {
      failures.push('manifest completedAt is not a valid ISO-8601 UTC timestamp');
    }
    if (
      !Array.isArray(manifest.blobGenerations) ||
      manifest.blobGenerations.some((generation) => typeof generation !== 'string' || generation.length === 0)
    ) {
      failures.push('manifest blobGenerations is not an array of generation ids');
    }
    const integrity = manifest.integrityResult as unknown;
    if (!integrity || typeof integrity !== 'object') {
      failures.push('manifest integrityResult is missing');
    } else {
      const ir = integrity as Partial<IntegrityReport>;
      if (typeof ir.ok !== 'boolean') failures.push('manifest integrityResult.ok is not a boolean');
      if (!isValidIsoUtcTimestamp(ir.checkedAt)) {
        failures.push('manifest integrityResult.checkedAt is not a valid ISO-8601 UTC timestamp');
      }
      if (!Array.isArray(ir.findings)) {
        failures.push('manifest integrityResult.findings is not an array');
      } else {
        for (const finding of ir.findings) {
          if (
            !finding ||
            typeof finding !== 'object' ||
            typeof (finding as Partial<IntegrityFinding>).severity !== 'string' ||
            typeof (finding as Partial<IntegrityFinding>).message !== 'string'
          ) {
            failures.push('manifest integrityResult contains a malformed finding');
            break;
          }
        }
        if (ir.ok === true && ir.findings.length > 0) {
          failures.push('manifest integrityResult is contradictory: records ok:true together with findings');
        }
      }
      if (manifest.status === 'complete' && ir.ok !== true) {
        failures.push('manifest records a failed integrity check for a complete backup');
      }
    }
    const ledger = manifest.migrationLedgerState as unknown;
    if (!ledger || typeof ledger !== 'object') {
      failures.push('manifest migrationLedgerState is missing');
    } else {
      failures.push(...validateLedgerShape(ledger as Partial<BackupMigrationLedgerState>));
    }
    return failures;
  }

  function validateLedgerShape(ledger: Partial<BackupMigrationLedgerState>): string[] {
    const failures: string[] = [];
    // The ledger table name is interpolated into SQL when the snapshot is
    // validated — the ONE DECLARED name only, never a manifest-chosen table
    // (review #83). The SQL seam itself re-enforces this before building any
    // statement; this shape check rejects other names up front.
    if (typeof ledger.table !== 'string' || ledger.table.length === 0) {
      failures.push('migration ledger table is not a string');
    } else if (ledger.table !== MIGRATION_LEDGER) {
      failures.push(
        `migration ledger declares an unsupported ledger table '${ledger.table}' — only '${MIGRATION_LEDGER}' is restored`,
      );
    }
    if (typeof ledger.maxVersion !== 'number' || !Number.isSafeInteger(ledger.maxVersion)) {
      failures.push('migration ledger maxVersion is not an integer');
    }
    if (!Array.isArray(ledger.appliedVersions)) {
      failures.push('migration ledger appliedVersions is not an array');
    } else {
      for (const entry of ledger.appliedVersions) {
        if (!entry || typeof entry !== 'object') {
          failures.push('migration ledger appliedVersions contains a non-object entry');
        } else {
          const namespace = (entry as { namespace?: unknown }).namespace;
          if (typeof namespace !== 'string' || namespace.length === 0 || namespace.includes('\0')) {
            failures.push('migration ledger appliedVersions entry is missing a non-empty namespace without NUL bytes');
          }
          const version = (entry as { version?: unknown }).version;
          if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) {
            failures.push('migration ledger appliedVersions entry is missing a positive integer version');
          }
        }
      }
    }
    return failures;
  }

  function validateLedgerConsistency(ledger: BackupMigrationLedgerState): string[] {
    const failures: string[] = [];
    const versions = ledger.appliedVersions;
    if (!Array.isArray(versions)) return failures;
    let previous: LedgerEntry | null = null;
    for (const entry of versions) {
      if (!entry || typeof entry !== 'object' || typeof entry.namespace !== 'string' || !Number.isInteger(entry.version)) {
        failures.push('migration ledger records a malformed applied version');
        continue;
      }
      if (previous !== null && compareLedgerEntry(previous, entry) >= 0) {
        failures.push('migration ledger appliedVersions is not strictly ascending by (namespace, version) (duplicate or out of order)');
      }
      previous = { namespace: entry.namespace, version: entry.version };
    }
    const max = versions.reduce((highest, entry) => {
      const version = typeof entry === 'object' && entry !== null ? (entry as { version?: unknown }).version : undefined;
      return typeof version === 'number' && version > highest ? version : highest;
    }, 0);
    if (typeof ledger.maxVersion === 'number' && ledger.maxVersion !== max) {
      failures.push(`migration ledger maxVersion ${ledger.maxVersion} does not match the highest applied version ${max}`);
    }
    return failures;
  }

  async function validateBlobAvailability(manifest: BackupManifest, backupDir: string): Promise<string[]> {
    const generations = manifest.blobGenerations;
    if (!Array.isArray(generations)) return ['manifest blobGenerations is not an array'];
    if (generations.length === 0) return [];
    if (!blobs || typeof blobs.verifyBackupGeneration !== 'function') {
      return [
        'backup references blob generations but no recovery blob seam was supplied — the referenced bytes cannot be verified before activation (S6 provides the concrete census); refusing to restore',
      ];
    }
    // Verification alone is never enough: the seam must ALSO materialize the
    // verified bytes into the target's blob layout before the census runs, and
    // census the result. A seam missing any of the three refuses fail-closed,
    // like the no-seam rule (review #83).
    const missing: string[] = [];
    if (typeof blobs.materializeRestoreGeneration !== 'function') {
      missing.push('materializeRestoreGeneration(generation, backupBlobsDir, destBlobDir)');
    }
    if (typeof blobs.censusAfterRestore !== 'function') {
      missing.push('censusAfterRestore(generations, targetRoot)');
    }
    if (missing.length > 0) {
      return [
        `backup references blob generations but the recovery blob seam is incomplete — missing ${missing.join(', ')} — the referenced bytes cannot be restored into and censused in the target (S6 provides the concrete seam); refusing to restore`,
      ];
    }
    const failures: string[] = [];
    for (const generation of generations) {
      try {
        await blobs.verifyBackupGeneration(generation, path.join(backupDir, 'blobs'));
      } catch (err) {
        failures.push(`referenced blob generation '${generation}' is unavailable: ${sanitizeError(err)}`);
      }
    }
    return failures;
  }

  // ---- activation ----------------------------------------------------------

  // Move the live database files (data.sqlite + its -wal/-shm sidecars)
  // TOGETHER into a fresh quarantine/<timestamp>-<id>/ directory. Moving the
  // sidecars with the main file is what keeps a stale WAL from ever pairing
  // with the restored database. Orphan sidecars (a crash of a PREVIOUS
  // quarantine left them behind) are swept the same way. Returns the quarantine
  // dir, or null when nothing existed.
  function quarantineDatabaseFiles(): string | null {
    const existing = [dataFilename, `${dataFilename}-wal`, `${dataFilename}-shm`]
      .map((name) => path.join(root, name))
      .filter((file) => existsSync(file));
    if (existing.length === 0) return null;
    const dir = freshQuarantineDir();
    mkdirSync(dir, { recursive: false, mode: 0o700 });
    chmodSync(dir, 0o700);
    try {
      for (const file of existing) {
        renameSync(file, path.join(dir, path.basename(file)));
      }
    } catch (err) {
      // A partial move (e.g. the -wal resisted) must NOT proceed to rename a
      // new db over a stale sidecar — abort and let the caller quarantine the
      // stage. The next recovery attempt sweeps whatever remained.
      getLog().error('system', 'recovery failed to quarantine the damaged database', { error: sanitizeError(err) });
      throw err;
    }
    writeDiagnostic(dir, {
      at: now().toISOString(),
      stage: 'quarantine',
      error: 'damaged database quarantined before restore',
      detail: { files: existing.map((file) => path.basename(file)) },
    });
    getLog().warn('system', 'damaged database quarantined before restore', { quarantine: dir });
    return dir;
  }

  // Fail-closed path for a failed activation: move any leftover stage file into
  // a fresh quarantine dir with a diagnostic, and log. The damaged database (if
  // already quarantined) is never touched.
  function quarantineFailedAttempt(
    backupId: string,
    stagePath: string,
    phase: 'stage' | 'activation',
    quarantinedSoFar: readonly string[],
    err: unknown,
  ): RecoveryResult {
    const quarantined = [...quarantinedSoFar];
    try {
      if (existsSync(stagePath)) {
        const target = freshQuarantineDir();
        mkdirSync(target, { mode: 0o700 });
        writeDiagnostic(target, {
          at: now().toISOString(),
          stage: 'quarantine',
          error: 'failed recovery attempt quarantined',
          detail: { backupId, phase, file: path.basename(stagePath) },
        });
        renameSync(stagePath, path.join(target, path.basename(stagePath)));
        quarantined.push(target);
      }
    } catch (quarantineErr) {
      getLog().error('system', 'recovery failed closed and could not be fully quarantined', {
        error: sanitizeError(quarantineErr),
        backupId,
      });
    }
    getLog().error('system', 'recovery failed closed', { error: sanitizeError(err), backupId, phase });
    return {
      ok: false,
      status: 'failed',
      backupId,
      reason: `restore of backup '${backupId}' failed at ${phase}: ${sanitizeError(err)}`,
      quarantined,
    };
  }

  // Materialize every referenced generation's verified bytes from the backup's
  // blobs/ into the target's blob-store layout BEFORE the census runs — without
  // this a real S6 census would see missing bytes in a fresh target, or stale
  // bytes in a live restore, and could never honestly confirm the restored
  // store (review #83). Each write is verified against disk (lstat + realpath
  // containment, mirroring the backup side), so a seam that lies about writing
  // fails the restore. A crash DURING this step into the LIVE target leaves a
  // byte-without-sidecar partial in the owned root's persistent blobs/
  // directory (the manager quarantines only the staged database file, never
  // that directory); the blob seam REPAIRS it on the next attempt — it
  // re-materializes the missing digest sidecar once the byte final verifies as
  // the generation's own bytes, and treats an already-complete generation as a
  // no-op — so a crash leftover can never permanently block a later restore of
  // that generation (see the seam contract). A fresh-restore failure removes
  // the whole disposable target, crash leftovers included.
  async function materializeRestoredBlobs(manifest: BackupManifest, backupDir: string, targetRoot: string): Promise<void> {
    const generations = manifest.blobGenerations;
    if (generations.length === 0) return;
    if (!blobs || typeof blobs.materializeRestoreGeneration !== 'function') {
      throw new Error(
        'backup references blob generations but the recovery blob seam cannot materialize them into the target blob store — refusing (S6 provides the concrete materializer)',
      );
    }
    const backupBlobsDir = path.join(backupDir, 'blobs');
    const destBlobDir = path.join(targetRoot, 'blobs');
    for (const generation of generations) {
      const report = await blobs.materializeRestoreGeneration(generation, backupBlobsDir, destBlobDir);
      const verified = verifyRestoreMaterialization(generation, destBlobDir, report);
      if (!verified.ok) throw new Error(verified.reason);
    }
  }

  // The full schema + blob census run on the staged bytes BEFORE the swap
  // (census-before-serve): a failing census leaves the live database and the
  // backup untouched — nothing is marked complete until the census passes.
  async function runCensus(dbFilePath: string, manifest: BackupManifest, targetRoot: string): Promise<RecoveryCensus> {
    const schema = schemaCensusOf(dbFilePath, manifest);
    let blobsOutcome: RecoveryCensus['blobs'] = { ok: true };
    if (manifest.blobGenerations.length > 0) {
      if (!blobs || typeof blobs.censusAfterRestore !== 'function') {
        blobsOutcome = {
          ok: false,
          reason: 'backup references blob generations but no recovery blob census seam was supplied — the live blob store cannot be verified (S6 provides the concrete census)',
        };
      } else {
        try {
          await blobs.censusAfterRestore(manifest.blobGenerations, targetRoot);
        } catch (err) {
          blobsOutcome = { ok: false, reason: `blob census failed: ${sanitizeError(err)}` };
        }
      }
    }
    return { schema, blobs: blobsOutcome };
  }

  function schemaCensusOf(dbFilePath: string, manifest: BackupManifest): RecoveryCensus['schema'] {
    const findings: string[] = [];
    let db: SqliteDatabase;
    try {
      db = openSqliteDatabase(dbFilePath);
    } catch (err) {
      return { ok: false, findings: [`restored database could not be opened: ${sanitizeError(err)}`] };
    }
    try {
      const integrity = integrityCheckOf(db);
      for (const finding of integrity.findings) findings.push(`restored database failed integrity_check: ${finding}`);
      let identity: { platformSchemaIdentity: string; appSchemaIdentity: string[] };
      let ledger: BackupMigrationLedgerState;
      try {
        identity = schemaIdentityOf(db);
        ledger = migrationLedgerOf(db, manifest);
      } catch (err) {
        findings.push(`restored database could not be validated: ${sanitizeError(err)}`);
        return { ok: false, findings };
      }
      if (identity.platformSchemaIdentity !== manifest.platformSchemaIdentity) {
        findings.push('restored schema identity does not match the backup manifest (platform)');
      }
      if (!deepEqual(identity.appSchemaIdentity, manifest.appSchemaIdentity)) {
        findings.push('restored schema identity does not match the backup manifest (app)');
      }
      if (!deepEqual(ledger, manifest.migrationLedgerState)) {
        findings.push('restored migration ledger does not match the backup manifest');
      }
      findings.push(...validateLedgerConsistency(manifest.migrationLedgerState));
    } finally {
      try {
        db.close();
      } catch {
        /* best-effort close on the census path */
      }
      // The staged/restored file is OURS (freshly written) — removing the
      // sidecars a read-write inspection leaves behind is safe and keeps the
      // owned directory to exactly the database file.
      for (const sidecar of ['-shm', '-wal']) {
        try {
          rmSync(`${dbFilePath}${sidecar}`, { force: true });
        } catch {
          /* best-effort */
        }
      }
    }
    return { ok: findings.length === 0, findings };
  }

  function quickCheckFile(filePath: string): { ok: true } | { ok: false; reason: string } {
    let db: SqliteDatabase;
    try {
      db = openSqliteDatabase(filePath);
    } catch (err) {
      return { ok: false, reason: sanitizeError(err) };
    }
    try {
      const rows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
      for (const row of rows) {
        if (row.quick_check !== 'ok') return { ok: false, reason: row.quick_check };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: sanitizeError(err) };
    } finally {
      try {
        db.close();
      } catch {
        /* best-effort close on the quick-check path */
      }
      for (const sidecar of ['-shm', '-wal']) {
        try {
          rmSync(`${filePath}${sidecar}`, { force: true });
        } catch {
          /* best-effort */
        }
      }
    }
  }

  async function recover(options: { backupId: string }): Promise<RecoveryResult> {
    const backupId = options.backupId;
    const idError = validateBackupId(backupId);
    if (idError) {
      return { ok: false, status: 'rejected', backupId, reason: idError, validation: [idError] };
    }
    const backupDir = path.join(backupsDir, backupId);
    if (!isDirectory(backupDir)) {
      const missing = `backup '${backupId}' was not found in backups/`;
      return { ok: false, status: 'rejected', backupId, reason: missing, validation: [missing] };
    }

    // A directory that is not a provably-complete backup (a crash leftover, a
    // partial attempt, or an unknown format) is quarantined — never restored,
    // never picked up. This is the partial/invalid-dir handling; a completed
    // manifest dir proceeds to validation and, on failure, is left untouched.
    if (!isCompleteBackupDir(backupDir)) {
      try {
        if (!existsSync(path.join(backupDir, 'diagnostic.json'))) {
          writeDiagnostic(backupDir, {
            at: now().toISOString(),
            stage: 'quarantine',
            error: 'incomplete backup directory quarantined by recovery',
            detail: { backupId },
          });
        }
        const quarantined = moveToQuarantine(backupDir);
        getLog().warn('system', 'incomplete backup quarantined by recovery', { backupId, quarantined });
        const reason = `backup '${backupId}' is incomplete (no valid complete manifest) and was quarantined — restore it is not possible`;
        return { ok: false, status: 'rejected', backupId, reason, validation: [reason], quarantined: [quarantined] };
      } catch (err) {
        const reason = `backup '${backupId}' is incomplete and could not be quarantined: ${sanitizeError(err)}`;
        return { ok: false, status: 'rejected', backupId, reason, validation: [reason] };
      }
    }

    // VALIDATE — everything, before any mutation. Any failure aborts with the
    // backup left untouched (the live database too).
    const validation = await validateBackup(backupDir);
    if (!validation.ok) {
      return { ok: false, status: 'rejected', backupId, reason: validationReason(backupId, validation.failures), validation: validation.failures };
    }

    // STAGE + CENSUS before the swap. The staged file is a faithful copy of the
    // fully-validated snapshot; the census runs on those bytes so a failing
    // census can never leave a half-activated database in the owned directory.
    // Verified blob generations are materialized into the owned directory's
    // blob layout BEFORE the census so the census sees the restored bytes.
    const stagePath = path.join(root, `${STAGE_PREFIX}${recoveryToken()}`);
    // Assigned in the try below; every path that reaches the return has a real
    // census (the catch always returns).
    let census!: RecoveryCensus;
    try {
      if (faults?.beforeStage) faults.beforeStage();
      copyFileSync(path.join(backupDir, 'snapshot.sqlite'), stagePath);
      const staged = quickCheckFile(stagePath);
      if (!staged.ok) throw new Error(`staged restore failed integrity verification: ${staged.reason}`);
      await materializeRestoredBlobs(validation.manifest, backupDir, root);
      census = await runCensus(stagePath, validation.manifest, root);
      if (!census.schema.ok) throw new Error(`schema census failed: ${census.schema.findings.join('; ')}`);
      if (!census.blobs.ok) throw new Error(`blob census failed: ${census.blobs.reason ?? 'referenced blob generations unavailable'}`);
    } catch (err) {
      return quarantineFailedAttempt(backupId, stagePath, 'stage', [], err);
    }

    // ACTIVATE — the coordinator-serialized swap: quarantine the damaged
    // database, then atomically rename the fully-censused staged file into
    // place. A crash at any point leaves the old database quarantined and never
    // a half-written data.sqlite.
    let quarantinedDatabase: string | null = null;
    try {
      await writeCoordinator.run(() => {
        if (faults?.beforeQuarantine) faults.beforeQuarantine();
        quarantinedDatabase = quarantineDatabaseFiles();
        if (faults?.beforeRename) faults.beforeRename();
        renameSync(stagePath, dataFile);
      });
    } catch (err) {
      return quarantineFailedAttempt(
        backupId,
        stagePath,
        'activation',
        quarantinedDatabase === null ? [] : [quarantinedDatabase],
        err,
      );
    }

    getLog().info('system', 'database restored from backup', { backupId, quarantine: quarantinedDatabase });
    return {
      ok: true,
      status: 'restored',
      backupId,
      directory: root,
      quarantinedDatabase,
      census,
    };
  }

  async function recoverIntoFreshDirectory(options: { backupId: string; directory: string }): Promise<FreshRecoveryResult> {
    const backupId = options.backupId;
    const idError = validateBackupId(backupId);
    if (idError) {
      return { ok: false, status: 'rejected', backupId, reason: idError, validation: [idError] };
    }
    const backupDir = path.join(backupsDir, backupId);
    if (!isDirectory(backupDir)) {
      const missing = `backup '${backupId}' was not found in backups/`;
      return { ok: false, status: 'rejected', backupId, reason: missing, validation: [missing] };
    }

    // Same partial/invalid-dir handling as recover(): never restore a dir that
    // cannot prove it is a complete backup.
    if (!isCompleteBackupDir(backupDir)) {
      try {
        if (!existsSync(path.join(backupDir, 'diagnostic.json'))) {
          writeDiagnostic(backupDir, {
            at: now().toISOString(),
            stage: 'quarantine',
            error: 'incomplete backup directory quarantined by recovery',
            detail: { backupId },
          });
        }
        const quarantined = moveToQuarantine(backupDir);
        getLog().warn('system', 'incomplete backup quarantined by recovery', { backupId, quarantined });
        const reason = `backup '${backupId}' is incomplete (no valid complete manifest) and was quarantined — restore it is not possible`;
        return { ok: false, status: 'rejected', backupId, reason, validation: [reason] };
      } catch (err) {
        const reason = `backup '${backupId}' is incomplete and could not be quarantined: ${sanitizeError(err)}`;
        return { ok: false, status: 'rejected', backupId, reason, validation: [reason] };
      }
    }

    const validation = await validateBackup(backupDir);
    if (!validation.ok) {
      return { ok: false, status: 'rejected', backupId, reason: validationReason(backupId, validation.failures), validation: validation.failures };
    }

    // A fresh restore never touches an existing directory: it must not be able
    // to overwrite anything, so a non-empty target (or one already holding a
    // database) is refused. An empty/missing target is disposable — on failure
    // the whole freshly-created directory is removed (fail closed).
    const target = path.resolve(options.directory);
    if (existsSync(target) && readdirSync(target).length > 0) {
      const busy = 'the target directory is not empty — a fresh restore refuses to touch a non-empty directory';
      return { ok: false, status: 'rejected', backupId, reason: busy, validation: [busy] };
    }
    if (existsSync(path.join(target, dataFilename))) {
      const busy = `the target directory already contains a database (${dataFilename})`;
      return { ok: false, status: 'rejected', backupId, reason: busy, validation: [busy] };
    }

    ensurePrivateDirectory(target);
    for (const sub of RECOVERY_MANAGED_SUBDIRECTORIES) {
      ensurePrivateDirectory(path.join(target, sub));
    }

    const targetData = path.join(target, dataFilename);
    const stagePath = path.join(target, `${STAGE_PREFIX}${recoveryToken()}`);
    // Assigned in the try below; every path that reaches the return has a real
    // census (the catch always returns).
    let census!: RecoveryCensus;
    try {
      copyFileSync(path.join(backupDir, 'snapshot.sqlite'), stagePath);
      const staged = quickCheckFile(stagePath);
      if (!staged.ok) throw new Error(`fresh restore failed integrity verification: ${staged.reason}`);
      await materializeRestoredBlobs(validation.manifest, backupDir, target);
      census = await runCensus(stagePath, validation.manifest, target);
      if (!census.schema.ok) throw new Error(`schema census failed: ${census.schema.findings.join('; ')}`);
      if (!census.blobs.ok) throw new Error(`blob census failed: ${census.blobs.reason ?? 'referenced blob generations unavailable'}`);
      renameSync(stagePath, targetData);
    } catch (err) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        /* the disposable fresh directory is removed best-effort */
      }
      return { ok: false, status: 'failed', backupId, reason: `fresh restore of backup '${backupId}' failed: ${sanitizeError(err)}`, census };
    }

    getLog().info('system', 'database restored into a fresh directory', { backupId, directory: target });
    return { ok: true, status: 'restored', backupId, directory: target, census };
  }

  return Object.freeze({
    probe,
    list,
    reconcile: reconcileNow,
    recover,
    recoverIntoFreshDirectory,
    root,
  });
}

// ---- sqlite-snapshot-side helpers (mirror backup.ts) ----------------------

// The SAME quick_check report the backup side records in the manifest
// (backup.ts quickCheckOf) — the faithful recompute comparison for
// integrityResult (review #83).
function quickCheckOf(db: SqliteDatabase): IntegrityReport {
  try {
    const rows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
    const findings: IntegrityFinding[] = [];
    for (const row of rows) {
      if (row.quick_check !== 'ok') findings.push({ severity: 'error', message: row.quick_check });
    }
    return { ok: findings.length === 0, checkedAt: new Date().toISOString(), findings };
  } catch (err) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      findings: [{ severity: 'error', message: sanitizeError(err) }],
    };
  }
}

// Verify a restore-materialization report against what actually landed in the
// target's blob directory (mirrors backup.ts verifyMaterialization): every
// reported file must exist under destBlobDir, be a regular file, and match the
// reported byte size. A symlink is refused outright and every reported path
// must resolve inside the blob directory's OWN realpath — no launderable byte.
type RestoreMaterializationVerification = Readonly<{ ok: true } | { ok: false; reason: string }>;
function verifyRestoreMaterialization(
  generation: string,
  destBlobDir: string,
  report: readonly MaterializedBlobFile[] | undefined,
): RestoreMaterializationVerification {
  if (!Array.isArray(report)) {
    return { ok: false, reason: `materialize for ${generation} did not report the files it wrote` };
  }
  if (report.length === 0) {
    return { ok: false, reason: `materialize for ${generation} reported no files — its bytes were not written` };
  }
  let realBlobDir: string;
  try {
    realBlobDir = realpathSync(destBlobDir);
  } catch {
    return { ok: false, reason: `materialize for ${generation} ran before the target blob directory existed` };
  }
  for (const entry of report) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.size !== 'number' || !Number.isInteger(entry.size) || entry.size < 0) {
      return { ok: false, reason: `materialize for ${generation} reported a malformed file entry` };
    }
    const name = entry.name;
    if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
      return { ok: false, reason: `materialize for ${generation} reported a path outside the target blob directory` };
    }
    const entryPath = path.join(destBlobDir, name);
    let stat: ReturnType<typeof statSync>;
    try {
      const link = lstatSync(entryPath);
      if (link.isSymbolicLink()) {
        return { ok: false, reason: `materialize for ${generation} reported a symlink, which cannot be a verified blob byte: ${name}` };
      }
      const resolved = realpathSync(entryPath);
      if (resolved !== realBlobDir && !resolved.startsWith(realBlobDir + path.sep)) {
        return { ok: false, reason: `materialize for ${generation} resolved outside the target blob directory: ${name}` };
      }
      stat = statSync(resolved);
    } catch {
      return { ok: false, reason: `materialize for ${generation} reported a file that was not written: ${name}` };
    }
    if (!stat.isFile()) {
      return { ok: false, reason: `materialize for ${generation} reported a non-file entry: ${name}` };
    }
    if (stat.size !== entry.size) {
      return { ok: false, reason: `materialize for ${generation} reported ${entry.size} bytes but ${name} is ${stat.size} bytes` };
    }
  }
  return { ok: true };
}

function integrityCheckOf(db: SqliteDatabase): IntegrityReport {
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    const findings: IntegrityFinding[] = [];
    for (const row of rows) {
      if (row.integrity_check !== 'ok') findings.push({ severity: 'error', message: row.integrity_check });
    }
    return { ok: findings.length === 0, checkedAt: new Date().toISOString(), findings };
  } catch (err) {
    // A corrupt file can open (node:sqlite opens lazily) and only fail on the
    // first statement — report that as an integrity failure, not a throw.
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      findings: [{ severity: 'error', message: sanitizeError(err) }],
    };
  }
}

// Recompute the schema identity exactly the way the backup manager derived it
// when the manifest was written (backup.ts schemaIdentityOf): one fingerprint
// over every framework-owned table present, one per remaining app table.
function schemaIdentityOf(db: SqliteDatabase): { platformSchemaIdentity: string; appSchemaIdentity: string[] } {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL")
    .all() as Array<{ name: string; sql: string }>;
  const sqlByName = new Map(rows.map((row) => [row.name, row.sql]));
  const framework = new Set(frameworkTableNames);
  const platformTables = frameworkTableNames.filter((name) => sqlByName.has(name)).slice().sort();
  const platformSchemaIdentity = sha256hex(platformTables.map((name) => `${name}:${sqlByName.get(name)!}`).join('\n'));
  const appSchemaIdentity = rows
    .filter((row) => !framework.has(row.name) && row.name !== MIGRATION_LEDGER)
    .map((row) => `${row.name}:${sha256hex(row.sql)}`)
    .sort();
  return { platformSchemaIdentity, appSchemaIdentity };
}

// Recompute the migration ledger that EXISTS in a snapshot using the table
// name the manifest recorded (never assuming a fresh reset). SECURITY (review
// #83): the manifest is untrusted input and this name is interpolated into
// SQL, so the ONE DECLARED ledger table name is enforced before any statement
// is built — a manifest-chosen table is a validation failure, never SQL.
function migrationLedgerOf(db: SqliteDatabase, manifest: BackupManifest): BackupMigrationLedgerState {
  const declaredTable = manifest.migrationLedgerState?.table ?? MIGRATION_LEDGER;
  if (declaredTable !== MIGRATION_LEDGER) {
    throw new Error(
      `manifest declares an unsupported migration ledger table '${declaredTable}' — only '${MIGRATION_LEDGER}' is restored`,
    );
  }
  const hasTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(MIGRATION_LEDGER));
  if (!hasTable) return { table: MIGRATION_LEDGER, appliedVersions: [], maxVersion: 0 };
  const rows = db
    .prepare(`SELECT namespace, version FROM ${MIGRATION_LEDGER} ORDER BY namespace, version`)
    .all() as Array<{ namespace: string; version: number }>;
  const appliedVersions = rows
    .map((row) => ({ namespace: row.namespace, version: Number(row.version) }))
    .sort(compareLedgerEntry);
  const maxVersion = appliedVersions.reduce((max, entry) => Math.max(max, entry.version), 0);
  return { table: MIGRATION_LEDGER, appliedVersions, maxVersion };
}

// ---- CLI ------------------------------------------------------------------

export type RecoveryCliAction =
  | Readonly<{ action: 'probe' }>
  | Readonly<{ action: 'list' }>
  | Readonly<{ action: 'recover'; backupId: string }>;

export type RecoveryCliArgs = Readonly<{ dir?: string; action: RecoveryCliAction; help: boolean }>;

export function parseRecoveryCliArgs(argv: readonly string[]): RecoveryCliArgs {
  let dir: string | undefined;
  let action: RecoveryCliAction = { action: 'probe' };
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') {
      const value = argv[index + 1];
      if (value === undefined) throw new TypeError('--dir requires a directory path');
      dir = value;
      index += 1;
    } else if (arg === '--recover') {
      const value = argv[index + 1];
      if (value === undefined) throw new TypeError('--recover requires a backupId');
      action = { action: 'recover', backupId: value };
      index += 1;
    } else if (arg === '--list-backups') {
      action = { action: 'list' };
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else {
      throw new TypeError(`unknown recovery CLI argument: ${arg}`);
    }
  }
  return { dir, action, help };
}

export const RECOVERY_CLI_USAGE = [
  'usage:',
  '  node scripts/recover.mjs --dir <owned-directory> [--list-backups]',
  '  node scripts/recover.mjs --dir <owned-directory> --recover <backupId>',
  '  node scripts/recover.mjs --dir <owned-directory>',
  '',
  'with no action, probes the database and prints the recovery state',
  '(an explicit "recovery required" explanation is printed when the database',
  'is corrupt; available backups are listed but never auto-selected).',
].join('\n');

// Programmatic CLI entry: returns the process exit code (0 = ok, 1 = recovery
// required / restore failed, 2 = usage error). The Operator (Scope, S8) drives
// the same recover() API for interactive prompting.
export async function runRecoveryCli(argv: readonly string[]): Promise<number> {
  let parsed: RecoveryCliArgs;
  try {
    parsed = parseRecoveryCliArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(RECOVERY_CLI_USAGE);
    return 2;
  }
  if (parsed.help || !parsed.dir) {
    console.log(RECOVERY_CLI_USAGE);
    return parsed.help ? 0 : 2;
  }

  const writeCoordinator = createWriteQueue();
  // The write queue's declared `run<T>(fn: () => T): Promise<T>` is
  // structurally wider than the coordinator contract's
  // `run<T>(fn: () => Promise<T> | T): Promise<T>`; the platform bridges the
  // two at untyped seams (app.ts wires app.writeCoordinator the same way), so
  // the CLI bridges here. One object, one shape at runtime.
  const source: RecoverySource = { root: parsed.dir, writeCoordinator: writeCoordinator as BackupWriteCoordinator };
  const manager = createRecoveryManager({ source, writeCoordinator: writeCoordinator as BackupWriteCoordinator });

  if (parsed.action.action === 'list') {
    const backups = manager.list();
    if (backups.length === 0) {
      console.log('no backups available');
      return 0;
    }
    console.log(`${backups.length} backup(s) available:`);
    for (const backup of backups) {
      console.log(`  ${backup.backupId}  created ${backup.createdAt}`);
    }
    return 0;
  }

  if (parsed.action.action === 'recover') {
    const result = await manager.recover({ backupId: parsed.action.backupId });
    if (result.ok) {
      console.log(`restored backup ${result.backupId} into ${result.directory}`);
      return 0;
    }
    console.error(result.reason);
    return 1;
  }

  const state = manager.probe();
  if (state.ok) {
    console.log('database OK — no recovery required');
    return 0;
  }
  console.error(state.reason);
  if (state.backups.length > 0) {
    console.error(`${state.backups.length} backup(s) available (restore explicitly, never automatically):`);
    for (const backup of state.backups) {
      console.error(`  ${backup.backupId}  created ${backup.createdAt}`);
    }
  }
  return 1;
}

// ---- small fs helpers -----------------------------------------------------

function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
