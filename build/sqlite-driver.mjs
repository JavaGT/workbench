// sqlite-driver.ts — cross-runtime SQLite driver seam (issue #284).
//
// CONTRACT: Workbench targets both Node (`node:sqlite`) and Bun (`bun:sqlite`).
// This module is the single runtime-detection seam that loads the active
// engine's built-in SQLite module and presents a uniform `node:sqlite`
// `DatabaseSync`-compatible surface across both runtimes.
//
// On Node: `openSqliteDatabase()` returns the native `DatabaseSync` instance
// directly (zero wrapper overhead; `instanceof DatabaseSync` stays true) and
// `backupDatabase()` delegates directly to `node:sqlite`'s `backup()`.
//
// On Bun: `openSqliteDatabase()` wraps `bun:sqlite`'s `Database` behind a thin
// `DatabaseSync`-shaped facade that normalizes all 6 engine divergences:
//   1. Strict named parameter binding (`{ strict: true, readonly, create }`):
//      un-prefixed `{ param: val }` objects bind to `:param` identically to
//      `node:sqlite`, and missing parameters throw instead of binding NULL.
//   2. `Statement.get()` returns `undefined` (not Bun's `null`) on a miss, and
//      `Statement.run()` returns `{ changes, lastInsertRowid }`.
//   3. `Statement.setReturnArrays(true)` switches `get()`, `all()`, and
//      `iterate()` to array-row output (matching `node:sqlite`).
//   4. `db.location()`, `db.isTransaction` (`db.inTransaction`), `db.isOpen`,
//      and WAL-draining `db.close()` (`PRAGMA wal_checkpoint(TRUNCATE)` on
//      writable file databases before closing, preventing macOS WAL leftovers).
//      `setAuthorizer` is forwarded only if the underlying engine supports it
//      (never shimmed as a silent no-op so authorizer-gated features fail
//      closed on runtimes without `sqlite3_set_authorizer`).
//   5. Online WAL-safe `backupDatabase()` via `VACUUM INTO` into a sibling temp
//      file, published by one atomic rename (with proper SQL string quoting and
//      temp-file cleanup on error). A pre-existing destination is never removed
//      before the snapshot succeeds.
//   6. `enableLoadExtension(false)` no-op / `enableLoadExtension(true)`
//      fail-closed, plus uniform closed-handle errors (`/not open/i`).

import { randomUUID } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';

import { setForeignKeys,               } from './driver.mjs';



const isBunRuntime = typeof (globalThis                     ).Bun !== 'undefined';

export const SQLITE_RUNTIME                = isBunRuntime ? 'bun' : 'node';

















































// ---- minimal runtime module shapes ----------------------------------------


































const NODE_SQLITE_SPECIFIER = 'node:sqlite';
const BUN_SQLITE_SPECIFIER = 'bun:sqlite';

let nodeSqlite                          = null;
let bunSqlite                         = null;

if (isBunRuntime) {
  bunSqlite = (await import(BUN_SQLITE_SPECIFIER))                   ;
} else {
  nodeSqlite = (await import(NODE_SQLITE_SPECIFIER))                    ;
}

// ---- Bun facade -----------------------------------------------------------

function isMemoryLocation(location        )          {
  return location === '' || location === ':memory:' || location.startsWith('file::memory:');
}

function* arrayIterator(rows             )                              {
  for (const row of rows) yield row;
}

class BunSqliteStatement                            {
           #raw                 ;
  #returnArrays = false;

  constructor(raw                 ) {
    this.#raw = raw;
  }

  setReturnArrays(enabled         )       {
    this.#returnArrays = Boolean(enabled);
  }

  run(...params           )                  {
    const result = this.#raw.run(...params);
    return {
      changes: Number(result?.changes ?? 0),
      lastInsertRowid: result?.lastInsertRowid ?? 0,
    };
  }

  get(...params           )                                      {
    if (this.#returnArrays) {
      const rows = this.#raw.values(...params);
      return (rows.length > 0 ? rows[0] : undefined)                                                  ;
    }
    const row = this.#raw.get(...params);
    return row === null ? undefined : row;
  }

  all(...params           )                                 {
    if (this.#returnArrays) {
      return this.#raw.values(...params)                                             ;
    }
    return this.#raw.all(...params);
  }

  iterate(...params           )                                            {
    if (this.#returnArrays) {
      return arrayIterator(this.#raw.values(...params))                                                        ;
    }
    return this.#raw.iterate(...params);
  }
}

class BunSqliteDatabase                           {
           #raw                ;
           #readOnly         ;
           #isMemory         ;
  #open = true;

  // Exposed only when the underlying bun:sqlite Database actually implements
  // SQLite's statement authorizer — never shimmed as a silent no-op so
  // authorizer-gated subsystems fail closed.
  setAuthorizer                                                      ;

  constructor(location        , options                    ) {
    const readOnly = Boolean(options?.readOnly);
    const isMemory = isMemoryLocation(location);
    // bun:sqlite refuses `new Database(':memory:', { readonly: true })` with
    // "Cannot open an anonymous database in read-only mode", whereas a URI
    // form (`file::memory:?mode=ro`) opens cleanly and stays read-only.
    const effectiveLocation = readOnly && (location === ':memory:' || location === '')
      ? 'file::memory:?mode=ro'
      : location;

    this.#raw = new bunSqlite .Database(effectiveLocation, {
      strict: true,
      readonly: readOnly,
      create: !readOnly,
    });
    this.#readOnly = readOnly;
    this.#isMemory = isMemory;

    if (typeof options?.timeout === 'number' && Number.isFinite(options.timeout) && options.timeout >= 0) {
      this.#raw.exec(`PRAGMA busy_timeout = ${Math.floor(options.timeout)}`);
    }
    if (options?.enableForeignKeyConstraints === false) {
      setForeignKeys(this.#raw                       , false);
    }
    if (typeof this.#raw.setAuthorizer === 'function') {
      this.setAuthorizer = (callback) => {
        this.#assertOpen();
        this.#raw.setAuthorizer (callback);
      };
    }
  }

  #assertOpen()       {
    if (!this.#open) {
      throw new Error('database is not open');
    }
  }

  get isOpen()          {
    return this.#open;
  }

  get isTransaction()          {
    return this.#open ? Boolean(this.#raw.inTransaction) : false;
  }

  location(dbName         )                {
    this.#assertOpen();
    if (dbName !== undefined && dbName !== 'main') {
      const rows = this.#raw.prepare('PRAGMA database_list').all()                                           ;
      const match = rows.find((row) => row.name === dbName);
      return match?.file ? match.file : null;
    }
    if (this.#isMemory) return null;
    const filename = this.#raw.filename;
    if (!filename || isMemoryLocation(filename)) return null;
    if (filename.startsWith('file:')) {
      const rows = this.#raw.prepare('PRAGMA database_list').all()                                           ;
      const main = rows.find((row) => row.name === 'main');
      return main?.file ? main.file : null;
    }
    return filename;
  }

  exec(sql        )       {
    this.#assertOpen();
    this.#raw.exec(sql);
  }

  prepare(sql        )                  {
    this.#assertOpen();
    return new BunSqliteStatement(this.#raw.prepare(sql));
  }

  enableLoadExtension(allow         )       {
    this.#assertOpen();
    if (allow) {
      throw new Error('Cannot enable extension loading because it was disabled at database creation.');
    }
  }

  close()       {
    this.#assertOpen();
    // On Bun (notably macOS WAL databases), drain the WAL cleanly before
    // closing writable file handles so sidecars don't linger unexpectedly.
    if (!this.#readOnly && !this.#isMemory && !this.#raw.inTransaction) {
      try {
        this.#raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* best-effort drain; never mask close or corrupt-file cleanup */
      }
    }
    try {
      this.#raw.close();
    } finally {
      this.#open = false;
    }
  }
}

// ---- Public API -----------------------------------------------------------

export function openSqliteDatabase(location        , options                    )                 {
  if (isBunRuntime) {
    return new BunSqliteDatabase(location, options);
  }
  const db = options === undefined
    ? new nodeSqlite .DatabaseSync(location)
    : new nodeSqlite .DatabaseSync(location, nodeOpenOptions(options));
  return db                             ;
}

// `SqliteOpenOptions` also carries Bun-only flags (`open`, `defensive`). Passing
// them through to Node would change behavior — `open: false` creates a CLOSED
// DatabaseSync — so only the options Node actually understands cross the seam.
function nodeOpenOptions(options                   )                          {
  const filtered                          = {};
  if (options.readOnly !== undefined) filtered.readOnly = options.readOnly;
  if (options.enableForeignKeyConstraints !== undefined) filtered.enableForeignKeyConstraints = options.enableForeignKeyConstraints;
  if (options.allowExtension !== undefined) filtered.allowExtension = options.allowExtension;
  if (options.timeout !== undefined) filtered.timeout = options.timeout;
  return filtered;
}

function quotedSqlString(value        )         {
  return `'${value.replaceAll("'", "''")}'`;
}

function isSafeSchemaIdentifier(name        )          {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * WAL-safe online snapshot of `db` into `destination`.
 *
 * On Node: delegates to `node:sqlite`'s `backup()`.
 * On Bun: the atomic `VACUUM INTO` path below.
 */
export async function backupDatabase(
  db                ,
  destination        ,
  options                      ,
)                  {
  if (!isBunRuntime) {
    const nativeDb = db                               ;
    return options === undefined
      ? nodeSqlite .backup(nativeDb, destination)
      : nodeSqlite .backup(nativeDb, destination, options);
  }
  return backupDatabaseViaVacuum(db, destination, options);
}

/**
 * The Bun `VACUUM INTO` backup path, separated from runtime detection so its
 * atomicity contract is directly testable on any runtime. `VACUUM INTO` captures
 * a consistent online snapshot including committed WAL frames; the snapshot is
 * written to a sibling temp path and published with one atomic rename, so a
 * pre-existing destination is either the old complete file or the new complete
 * file — never deleted, truncated, or half-written.
 */
export async function backupDatabaseViaVacuum(
  db                ,
  destination        ,
  options                      ,
)                  {
  if (!db.isOpen) {
    throw new Error('database is not open');
  }
  if (typeof destination !== 'string' || destination.length === 0 || destination.includes('\0')) {
    throw new TypeError('backup destination must be a non-empty file path without NUL bytes');
  }
  const sourceSchema = options?.source;
  if (sourceSchema !== undefined && !isSafeSchemaIdentifier(sourceSchema)) {
    throw new TypeError(`invalid backup source schema name: ${sourceSchema}`);
  }

  // A file-backed source gets its OWN read-only connection for the VACUUM INTO.
  // Running VACUUM INTO on the live handle holds that handle's SQLite read
  // transaction for the whole copy; a separate connection lets WAL-mode live
  // writes proceed concurrently (it sees the same committed snapshot). The
  // destination rename stays exactly as atomic as before.
  //
  // :memory: databases have no second addressable connection — they keep using
  // the live handle. A fake/embedded handle with no location() does the same.
  let sourcePath                = null;
  try {
    const located = typeof db.location === 'function' ? db.location() : null;
    if (typeof located === 'string' && !isMemoryLocation(located)) sourcePath = located;
  } catch {
    sourcePath = null;
  }
  let snapshotDb                        = null;
  if (sourcePath !== null) {
    try {
      snapshotDb = openSqliteDatabase(sourcePath, { readOnly: true });
    } catch {
      // A read-only WAL open can fail when no -shm exists yet. Fall back to the
      // live handle rather than losing the backup entirely.
      snapshotDb = null;
    }
  }
  const snapshotSource = snapshotDb ?? db;

  // Same directory (same filesystem) keeps the final rename atomic. A UUID
  // suffix means VACUUM INTO never sees an existing target, even on a retry.
  const tmpPath = `${destination}.tmp-${randomUUID()}`;
  const schemaPrefix = sourceSchema ? `${sourceSchema} ` : '';
  try {
    snapshotSource.exec(`VACUUM ${schemaPrefix}INTO ${quotedSqlString(tmpPath)}`);
    renameSync(tmpPath, destination);
  } catch (err) {
    // Clean only our own temp artifacts. The destination is never touched here.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(`${tmpPath}${suffix}`, { force: true });
      } catch {
        /* best-effort cleanup of failed snapshot target */
      }
    }
    throw err;
  } finally {
    if (snapshotDb) {
      try {
        snapshotDb.close();
      } catch {
        /* best-effort close of the read-only snapshot connection */
      }
    }
  }

  const pageCountPragma = sourceSchema ? `PRAGMA ${sourceSchema}.page_count` : 'PRAGMA page_count';
  const row = db.prepare(pageCountPragma).get()                                       ;
  const pages = Number(row?.page_count ?? 0);
  options?.progress?.({ totalPages: pages, remainingPages: 0 });
  return pages;
}
