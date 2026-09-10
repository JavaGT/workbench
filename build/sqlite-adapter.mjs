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

} from './driver.mjs';
import { getLog } from './log.mjs';
import {
  capabilitiesOf,






} from './db-adapter.mjs';
import { acquireDirectoryLock,                    } from './directory-lock.mjs';

import { probeDatabaseFile,                          } from './recovery.mjs';

export { DB_OWNED_ERROR_CODE, DirectoryOwnedError } from './directory-lock.mjs';

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
]         );

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

















                                                                      











                                            





               








// The bound adapter object (DbAdapter-conforming: async open + readMirror) plus
// the managed-path surface an app wires into serving and blob-root checks.







export function openSqliteAdapter(config                  = {})                       {
  if (config.mode === 'memory') return openMemoryAdapter();
  const directory = config.directory;
  if (!directory) {
    throw new TypeError('openSqliteAdapter requires a `directory` for file mode');
  }
  const root = createOwnedLayout(directory);
  const dbFile = path.join(root, SQLITE_DATA_FILENAME);
  const lock = acquireDirectoryLock(path.join(root, SQLITE_LOCK_FILENAME));

  let db              ;
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
    attachDriverHelpers(db                       );
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

export function openMemoryAdapter()                       {
  const db = new DatabaseSync(':memory:');
  try {
    applyConnectionPragmas(db);
    quickCheck(db);
    attachDriverHelpers(db                       );
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
export function createSqliteAdapter(config                  = {})                  {
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
    readMirror()                        {
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
function createOwnedLayout(directory        )         {
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
function ensurePrivateDirectory(dir        )       {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

// Fail-closed integrity gate at open. A fresh or healthy database answers the
// quick scan with a single 'ok' row; any other answer means the file is
// corrupt and the open must not proceed.
function quickCheck(db              )       {
  const row = db.prepare('PRAGMA quick_check').get()                                        ;
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
function walGuardTick(db              , walFile        )       {
  let walBytes        ;
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
function realPathOf(p        )         {
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

function isUnderRoot(realRoot               , p        )          {
  if (!realRoot) return false;
  const real = realPathOf(p);
  return real === realRoot || real.startsWith(realRoot + path.sep);
}

function makeOpenedSqliteDatabase(
  db              ,
  lock                      ,
  root               ,
  mode                   ,
)                       {
  let closed = false;
  const handle = db                       ;
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

  const checkpoint = ()       => {
    if (mode === 'file') db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  };

  // Online WAL-safe snapshot (S1/A3) — additive wiring only. The S1/A3 backup
  // manager runs this inside its single write-coordinator turn (the capture
  // barrier); the hook itself is a plain node:sqlite backup() call, never a
  // raw main-file copy, and works for file and memory sources alike. An
  // explicit `options: undefined` would be refused by node:sqlite, so the
  // third argument is passed only when the caller supplied options.
  const backupTo = (destPath        , options                      )                  =>
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
  const close = ()       => {
    if (closed) return;
    closed = true;
    clearInterval(walGuard);
    let failure          = null;
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

  const integrityCheck = ()                  => {
    const rows = db.prepare('PRAGMA integrity_check').all()                                      ;
    const findings                     = [];
    for (const row of rows) {
      if (row.integrity_check !== 'ok') {
        findings.push({ severity: 'error', message: row.integrity_check });
      }
    }
    return { ok: findings.length === 0, checkedAt: new Date().toISOString(), findings };
  };

  const teardown = ()       => {
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
  const probeRecovery = ()                      => {
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
