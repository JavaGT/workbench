// sqlite-adapter.ts — the default SQLite adapter (epic scope#23, S1/A2).
//
// CONTRACT: an adapter opens a workbench database from LOGICAL configuration —
// a directory plus a logical name (or a memory database) — never from a
// physical filename (src/db-adapter.ts). `openSqliteAdapter(config)` owns the
// directory: restrictive layout, an OS-backed ownership lock, the centralized
// PRAGMA layer, a fail-closed quick_check at open, a periodic WAL
// checkpoint-starvation guard, and checkpoint-then-close shutdown. `openMemoryAdapter()` preserves the same surface and lifecycle
// ordering for `:memory:` without a directory or lock.
//
// The physical db filename is DERIVED here and never exposed to the app. The
// adapter also exposes the managed-path guard (the owned directory and its
// protected subpaths) wired into static-file serving and blob-root acceptance,
// and a teardown that removes ONLY the db file, -wal/-shm, and lock sidecar —
// backups/, quarantine/, and recycle/ are owned by S1/A3/A4/A6 and survive.

import { backup, DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  applyConnectionPragmas,
  attachDriverHelpers,
  walCheckpointRestart,
  type DbHandle,
} from './driver.ts';
import { getLog } from './log.ts';
import {
  capabilitiesOf,
  type DbAdapter,
  type DbAdapterConfig,
  type IntegrityFinding,
  type IntegrityReport,
  type OpenedDatabase,
  type ReadMirrorDescription,
} from './db-adapter.ts';
import { acquireDirectoryLock, type DirectoryLock } from './directory-lock.ts';
import type { BackupWriteCoordinator } from './backup.ts';
import { probeDatabaseFile, type RecoveryProbeResult } from './recovery.ts';

export { DB_OWNED_ERROR_CODE, DirectoryOwnedError } from './directory-lock.ts';

// Stable package-private layout under the owned root. The physical names are
// derived by the adapter; subdirectory names are the shared vocabulary the
// S1 tickets (blobs/staging here, backups/quarantine/recycle in A3/A4/A6) use.
export const SQLITE_DATA_FILENAME = 'data.sqlite';
export const SQLITE_LOCK_FILENAME = 'lock.sqlite';
export const MANAGED_SUBDIRECTORIES = Object.freeze([
  'blobs',
  'staging',
  'backups',
  'quarantine',
  'recycle',
] as const);

// Teardown removes ONLY these (db file + -wal/-shm + lock sidecar). The
// managed subdirectories and their contents are never touched here.
const TEARDOWN_FILENAMES = Object.freeze([
  'data.sqlite',
  'data.sqlite-wal',
  'data.sqlite-shm',
  'lock.sqlite',
]);

// WAL checkpoint-starvation guard (scope#2727). With a second long-lived READ
// handle on the same file (the app's read mirror), SQLite's automatic
// checkpointing can be starved: the WAL then grows without bound while reads
// never stop (better-sqlite3 performance.md — poll the -wal sidecar and run
// wal_checkpoint(RESTART) once it outgrows a budget). File-mode adapters poll
// at WAL_GUARD_INTERVAL_MS and checkpoint when the sidecar exceeds
// WAL_GUARD_SIZE_THRESHOLD_BYTES.
export const WAL_GUARD_INTERVAL_MS = 60_000;
export const WAL_GUARD_SIZE_THRESHOLD_BYTES = 8 * 1024 * 1024;

// Options for the online-backup hook (S1/A3). Mirrors node:sqlite's BackupOptions:
// `source`/`target` name ATTACHed databases; `rate` is pages per step.
export type SqliteBackupOptions = {
  readonly source?: string;
  readonly target?: string;
  readonly rate?: number;
  readonly progress?: (info: { totalPages: number; remainingPages: number }) => void;
};

export interface OpenedSqliteDatabase extends OpenedDatabase {
  readonly mode: 'file' | 'memory';
  // The owned directory root (file mode) or null (memory). Exposed because the
  // app uses it for the managed-path guard and blob-root overlap refusal; the
  // physical db filename itself is never exposed.
  readonly root: string | null;
  // True when `p` resolves to the owned directory or any protected subpath
  // (db file, -wal/-shm, lock sidecar, blobs/, staging/, backups/, quarantine/,
  // recycle/). Always false for the memory adapter.
  isManagedPath(p: string): boolean;
  // WAL-safe online snapshot (S1/A3) via node:sqlite's backup() API — copies
  // the main database PLUS WAL content into a NEW file at `destPath`, never a
  // plain main-file copy. Resolves with the number of pages transferred and
  // throws on failure (the backup manager quarantines). Works for file AND
  // memory databases (backing up :memory: to a file is a valid use).
  backupTo(destPath: string, options?: SqliteBackupOptions): Promise<number>;
  // OWNERSHIP BINDING (S1/A3 backup, review #82 finding 3): the ONE platform
  // write coordinator (createWriteQueue) that serializes writes to this
  // connection. The app fills this in when it opens the adapter under its
  // coordinator; createBackupManager asserts the coordinator it is given is
  // EXACTLY this object, so a foreign coordinator cannot launder the backup
  // consistency boundary. Left unset until the app binds it (the adapter is
  // opened before the coordinator exists) — an unbound source refuses
  // backup-manager construction.
  writeCoordinator?: BackupWriteCoordinator;
  // S1/A4 recovery wiring (read-only): the recovery health probe bound to this
  // adapter's owned database file. A corrupt database cannot be OPENED (the
  // fail-closed quick_check at open throws), so recovery probes the FILE
  // directly — this hook reports damage without opening the app, powering the
  // stop-and-ask default. Never mutates. Memory mode is always healthy.
  probeRecovery(): RecoveryProbeResult;
  // Remove the db file, -wal/-shm, and lock sidecar. backups/, quarantine/,
  // recycle/ (S1/A3/A4/A6) and blobs//staging/ are left untouched. Closes the
  // adapter first if it is still open.
  teardown(): void;
}

// The bound adapter object (DbAdapter-conforming: async open + readMirror) plus
// the managed-path surface an app wires into serving and blob-root checks.
export interface SqliteDbAdapter extends DbAdapter {
  readonly config: DbAdapterConfig;
  readonly root: string | null;
  isManagedPath(p: string): boolean;
  open(): Promise<OpenedDatabase>;
}

export function openSqliteAdapter(config: DbAdapterConfig = {}): OpenedSqliteDatabase {
  if (config.mode === 'memory') return openMemoryAdapter();
  const directory = config.directory;
  if (!directory) {
    throw new TypeError('openSqliteAdapter requires a `directory` for file mode');
  }
  const root = createOwnedLayout(directory);
  const dbFile = path.join(root, SQLITE_DATA_FILENAME);
  const lock = acquireDirectoryLock(path.join(root, SQLITE_LOCK_FILENAME));

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbFile);
  } catch (err) {
    lock.release();
    throw err;
  }
  try {
    // Centralized PRAGMA layer — the single source of truth (driver.ts). The
    // adapter path FAILS CLOSED here; it never relies on wrapDriver's silent
    // bootstrap. quick_check is the fail-closed integrity gate at open.
    applyConnectionPragmas(db);
    quickCheck(db);
    attachDriverHelpers(db as unknown as DbHandle);
  } catch (err) {
    try {
      db.close();
    } catch {
      /* best-effort close on the failure path */
    }
    lock.release();
    throw err;
  }

  return makeOpenedSqliteDatabase(db, lock, root, 'file');
}

export function openMemoryAdapter(): OpenedSqliteDatabase {
  const db = new DatabaseSync(':memory:');
  try {
    applyConnectionPragmas(db);
    quickCheck(db);
    attachDriverHelpers(db as unknown as DbHandle);
  } catch (err) {
    try {
      db.close();
    } catch {
      /* best-effort close on the failure path */
    }
    throw err;
  }
  return makeOpenedSqliteDatabase(db, null, null, 'memory');
}

// A self-contained adapter bound to its config, ready for app wiring: the app
// can refuse managed paths / blob-root overlap before calling open(). open()
// returns the contract's Promise<OpenedDatabase> shape (the underlying work is
// synchronous).
export function createSqliteAdapter(config: DbAdapterConfig = {}): SqliteDbAdapter {
  const root = config.mode === 'memory' || !config.directory ? null : path.resolve(config.directory);
  // The real root (symlink-resolved) is captured up front so the managed-path
  // predicate compares REAL paths — a symlink into the owned directory (or a
  // symlinked parent chain such as macOS /var → /private/var) cannot bypass it.
  const realRoot = root ? realPathOf(root) : null;
  return {
    config,
    root,
    isManagedPath: (p) => isUnderRoot(realRoot, p),
    // The open is deferred through a microtask so a failure (invalid config,
    // lock contention, corruption) REJECTS the returned promise instead of
    // throwing synchronously — `Promise.resolve(value)` would evaluate the open
    // eagerly and break the Promise<OpenedDatabase> contract.
    open: () => Promise.resolve().then(() => openSqliteAdapter(config)),
    readMirror(): ReadMirrorDescription {
      const dbFile = root ? path.join(root, SQLITE_DATA_FILENAME) : ':memory:';
      return {
        kind: 'read-mirror',
        mode: 'read-only',
        readOnly: true,
        connectionString: `file:${dbFile}?mode=ro`,
      };
    },
  };
}

// ---- internals -----------------------------------------------------------

// Create the owned directory (restrictive 0o700) and the stable package-private
// subdirectory layout under one root.
function createOwnedLayout(directory: string): string {
  const root = path.resolve(directory);
  ensurePrivateDirectory(root);
  for (const sub of MANAGED_SUBDIRECTORIES) {
    ensurePrivateDirectory(path.join(root, sub));
  }
  return root;
}

// mkdirSync's `mode` applies only to NEWLY created directories, so an EXISTING
// root is tightened explicitly. The adapter owns the whole directory, and a
// pre-existing root (e.g. a repo examples dir holding the db file, -wal, lock,
// and blobs) must not stay group/other-readable. Chosen chmod policy (review
// #81): TIGHTEN to 0o700 on open rather than fail — failing would refuse
// pre-existing shared directories the app legitimately owns (the repo's own
// examples own `./examples`, mode 0755). The owned subdirectories are created
// freshly at 0o700; the same explicit chmod covers a subdirectory that already
// existed.
function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

// Fail-closed integrity gate at open. A fresh or healthy database answers the
// quick scan with a single 'ok' row; any other answer means the file is
// corrupt and the open must not proceed.
function quickCheck(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
  if (!row || row.quick_check !== 'ok') {
    throw new Error('database failed quick_check integrity verification at open');
  }
}

// One starvation-guard tick (scope#2727): checkpoint(RESTART) when the -wal
// sidecar has outgrown WAL_GUARD_SIZE_THRESHOLD_BYTES. A missing sidecar
// (nothing written since the last checkpoint) and a busy result (a reader is
// still pinning the WAL) are both no-ops — the next tick re-checks; there is
// no retry loop. The checkpoint runs with busy_timeout 0 so a pinned WAL can
// never stall the shared connection's event loop (driver.ts). Best-effort by
// design: a guard tick must never crash its host.
function walGuardTick(db: DatabaseSync, walFile: string): void {
  let walBytes: number;
  try {
    walBytes = statSync(walFile).size;
  } catch {
    return; // no -wal sidecar yet — nothing to checkpoint
  }
  if (walBytes <= WAL_GUARD_SIZE_THRESHOLD_BYTES) return;
  try {
    const row = walCheckpointRestart(db);
    if (row?.busy) {
      getLog().debug('system', 'wal checkpoint guard: WAL pinned by a reader; deferring to the next tick', { walBytes });
    }
  } catch (err) {
    getLog().debug('system', 'wal checkpoint guard tick failed', { err, walBytes });
  }
}

// Real-path containment for the managed-path predicate. realpath fails on a
// non-existent leaf, so the parent chain is realpath'd and the leaf re-joined:
// a non-existent path under a managed directory still resolves as managed,
// while an unrelated non-existent path is not. This makes the guard immune to
// symlinks (a static root symlinked into the owned directory, or a symlinked
// parent such as macOS /var → /private/var).
function realPathOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const dir = path.dirname(p);
    const base = path.basename(p);
    if (!base || base === '.' || base === dir) return p;
    try {
      return path.join(realpathSync(dir), base);
    } catch {
      return p;
    }
  }
}

function isUnderRoot(realRoot: string | null, p: string): boolean {
  if (!realRoot) return false;
  const real = realPathOf(p);
  return real === realRoot || real.startsWith(realRoot + path.sep);
}

function makeOpenedSqliteDatabase(
  db: DatabaseSync,
  lock: DirectoryLock | null,
  root: string | null,
  mode: 'file' | 'memory',
): OpenedSqliteDatabase {
  let closed = false;
  const handle = db as unknown as DbHandle;
  // The real root (symlink-resolved) — the managed-path predicate compares REAL
  // paths so a symlink cannot bypass containment.
  const realRoot = root ? realPathOf(root) : null;
  const capabilities = capabilitiesOf({
    transactionalDdl: true,
    onlineBackup: true,
    readOnlyConnections: true,
    integrityCheck: true,
    maintenance: true,
  });

  const checkpoint = (): void => {
    if (mode === 'file') db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  };

  // Online WAL-safe snapshot (S1/A3) — additive wiring only. The S1/A3 backup
  // manager runs this inside its single write-coordinator turn (the capture
  // barrier); the hook itself is a plain node:sqlite backup() call, never a
  // raw main-file copy, and works for file and memory sources alike. An
  // explicit `options: undefined` would be refused by node:sqlite, so the
  // third argument is passed only when the caller supplied options.
  const backupTo = (destPath: string, options?: SqliteBackupOptions): Promise<number> =>
    options === undefined ? backup(db, destPath) : backup(db, destPath, options);

  // Starvation-guard wiring (scope#2727): one interval, file mode only (memory
  // has no -wal sidecar). unref'd so a maintenance timer never holds the
  // process open; cleared on the close path below.
  const walGuard =
    mode === 'file' && root
      ? setInterval(() => {
          if (closed) return;
          try {
            walGuardTick(db, path.join(root, SQLITE_DATA_FILENAME) + '-wal');
          } catch (err) {
            getLog().debug('system', 'wal checkpoint guard tick failed', { err });
          }
        }, WAL_GUARD_INTERVAL_MS)
      : undefined;
  walGuard?.unref();

  // Checkpoint-then-close: clean shutdown truncates the WAL into the main db
  // file before the handle (and then the ownership lock) goes away. Idempotent.
  // Failures are NOT swallowed: an explicit close() propagates a failed
  // wal_checkpoint(TRUNCATE) (or db.close()) to the caller so shutdown knows the
  // WAL was not drained — while still releasing the ownership lock.
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(walGuard);
    let failure: unknown = null;
    if (mode === 'file') {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (err) {
        failure = err;
      }
    }
    try {
      db.close();
    } catch (err) {
      failure ??= err;
    }
    lock?.release();
    if (failure) throw failure;
  };

  const integrityCheck = (): IntegrityReport => {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    const findings: IntegrityFinding[] = [];
    for (const row of rows) {
      if (row.integrity_check !== 'ok') {
        findings.push({ severity: 'error', message: row.integrity_check });
      }
    }
    return { ok: findings.length === 0, checkedAt: new Date().toISOString(), findings };
  };

  const teardown = (): void => {
    if (!closed) {
      try {
        close();
      } catch {
        /* teardown removes the files regardless of the close outcome */
      }
    }
    if (!root) return;
    for (const filename of TEARDOWN_FILENAMES) {
      rmSync(path.join(root, filename), { force: true });
    }
  };

  // S1/A4 recovery wiring (read-only): delegates to the canonical file probe,
  // bound to this adapter's owned database file. A memory adapter has no file
  // and is always healthy. Recovery also works over a plain `{ root }` source
  // (the corrupt-db path where this adapter refuses to open), which probes the
  // file the same way via probeDatabaseFile.
  const probeRecovery = (): RecoveryProbeResult => {
    if (!root) return { ok: true, checkedAt: new Date().toISOString() };
    return probeDatabaseFile(path.join(root, SQLITE_DATA_FILENAME));
  };

  return {
    handle,
    capabilities,
    mode,
    root,
    isManagedPath: (p) => isUnderRoot(realRoot, p),
    backupTo,
    close,
    checkpoint,
    integrityCheck,
    probeRecovery,
    teardown,
    // No default: the app binds the platform write coordinator before creating
    // a backup manager (the adapter opens before the coordinator exists). An
    // unbound source refuses backup-manager construction.
    writeCoordinator: undefined,
  };
}
