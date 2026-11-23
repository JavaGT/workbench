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
//   5. Online WAL-safe `backupDatabase()` via `VACUUM INTO` (with proper SQL
//      string quoting, existing-file overwrite parity, and partial-file cleanup
//      on error).
//   6. `enableLoadExtension(false)` no-op / `enableLoadExtension(true)`
//      fail-closed, plus uniform closed-handle errors (`/not open/i`).

import { existsSync, rmSync, statSync } from 'node:fs';
import type { DatabaseSync as NodeDatabaseSync, DatabaseSyncOptions as NodeDatabaseSyncOptions } from 'node:sqlite';
import { setForeignKeys, type DbHandle } from './driver.ts';

export type SqliteRuntime = 'bun' | 'node';

const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

export const SQLITE_RUNTIME: SqliteRuntime = isBunRuntime ? 'bun' : 'node';

export interface SqliteOpenOptions {
  readonly readOnly?: boolean;
  readonly open?: boolean;
  readonly enableForeignKeyConstraints?: boolean;
  readonly allowExtension?: boolean;
  readonly timeout?: number;
  readonly defensive?: boolean;
}

export interface SqliteBackupOptions {
  readonly source?: string;
  readonly target?: string;
  readonly rate?: number;
  readonly progress?: (info: { totalPages: number; remainingPages: number }) => void;
}

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
  setReturnArrays(enabled: boolean): void;
}

export type SqliteAuthorizerCallback = (
  actionCode: number,
  arg1: string | null,
  arg2: string | null,
  dbName: string | null,
  triggerOrView: string | null,
) => number;

export interface SqliteDatabase {
  readonly isOpen: boolean;
  readonly isTransaction: boolean;
  location(dbName?: string): string | null;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  enableLoadExtension?(allow: boolean): void;
  setAuthorizer?(callback: SqliteAuthorizerCallback | null): void;
}

// ---- minimal runtime module shapes ----------------------------------------

interface BunRawStatement {
  run(...params: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint } | undefined;
  get(...params: unknown[]): Record<string, unknown> | null;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  values(...params: unknown[]): unknown[][];
  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
}

interface BunRawDatabase {
  readonly filename: string;
  readonly inTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): BunRawStatement;
  close(throwOnError?: boolean): void;
  setAuthorizer?: (callback: SqliteAuthorizerCallback | null) => void;
}

interface BunSqliteModule {
  Database: new (
    filename: string,
    options?: { readonly?: boolean; create?: boolean; strict?: boolean },
  ) => BunRawDatabase;
}

interface NodeSqliteModule {
  DatabaseSync: new (location: string, options?: NodeDatabaseSyncOptions) => NodeDatabaseSync;
  backup: (
    sourceDb: NodeDatabaseSync,
    path: string,
    options?: SqliteBackupOptions,
  ) => Promise<number>;
}

const NODE_SQLITE_SPECIFIER = 'node:sqlite';
const BUN_SQLITE_SPECIFIER = 'bun:sqlite';

let nodeSqlite: NodeSqliteModule | null = null;
let bunSqlite: BunSqliteModule | null = null;

if (isBunRuntime) {
  bunSqlite = (await import(BUN_SQLITE_SPECIFIER)) as BunSqliteModule;
} else {
  nodeSqlite = (await import(NODE_SQLITE_SPECIFIER)) as NodeSqliteModule;
}

// ---- Bun facade -----------------------------------------------------------

function isMemoryLocation(location: string): boolean {
  return location === '' || location === ':memory:' || location.startsWith('file::memory:');
}

function* arrayIterator(rows: unknown[][]): IterableIterator<unknown[]> {
  for (const row of rows) yield row;
}

class BunSqliteStatement implements SqliteStatement {
  readonly #raw: BunRawStatement;
  #returnArrays = false;

  constructor(raw: BunRawStatement) {
    this.#raw = raw;
  }

  setReturnArrays(enabled: boolean): void {
    this.#returnArrays = Boolean(enabled);
  }

  run(...params: unknown[]): SqliteRunResult {
    const result = this.#raw.run(...params);
    return {
      changes: Number(result?.changes ?? 0),
      lastInsertRowid: result?.lastInsertRowid ?? 0,
    };
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    if (this.#returnArrays) {
      const rows = this.#raw.values(...params);
      return (rows.length > 0 ? rows[0] : undefined) as unknown as Record<string, unknown> | undefined;
    }
    const row = this.#raw.get(...params);
    return row === null ? undefined : row;
  }

  all(...params: unknown[]): Array<Record<string, unknown>> {
    if (this.#returnArrays) {
      return this.#raw.values(...params) as unknown as Array<Record<string, unknown>>;
    }
    return this.#raw.all(...params);
  }

  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>> {
    if (this.#returnArrays) {
      return arrayIterator(this.#raw.values(...params)) as unknown as IterableIterator<Record<string, unknown>>;
    }
    return this.#raw.iterate(...params);
  }
}

class BunSqliteDatabase implements SqliteDatabase {
  readonly #raw: BunRawDatabase;
  readonly #readOnly: boolean;
  readonly #isMemory: boolean;
  #open = true;

  // Exposed only when the underlying bun:sqlite Database actually implements
  // SQLite's statement authorizer — never shimmed as a silent no-op so
  // authorizer-gated subsystems fail closed.
  setAuthorizer?: (callback: SqliteAuthorizerCallback | null) => void;

  constructor(location: string, options?: SqliteOpenOptions) {
    const readOnly = Boolean(options?.readOnly);
    const isMemory = isMemoryLocation(location);
    // bun:sqlite refuses `new Database(':memory:', { readonly: true })` with
    // "Cannot open an anonymous database in read-only mode", whereas a URI
    // form (`file::memory:?mode=ro`) opens cleanly and stays read-only.
    const effectiveLocation = readOnly && (location === ':memory:' || location === '')
      ? 'file::memory:?mode=ro'
      : location;

    this.#raw = new bunSqlite!.Database(effectiveLocation, {
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
      setForeignKeys(this.#raw as unknown as DbHandle, false);
    }
    if (typeof this.#raw.setAuthorizer === 'function') {
      this.setAuthorizer = (callback) => {
        this.#assertOpen();
        this.#raw.setAuthorizer!(callback);
      };
    }
  }

  #assertOpen(): void {
    if (!this.#open) {
      throw new Error('database is not open');
    }
  }

  get isOpen(): boolean {
    return this.#open;
  }

  get isTransaction(): boolean {
    return this.#open ? Boolean(this.#raw.inTransaction) : false;
  }

  location(dbName?: string): string | null {
    this.#assertOpen();
    if (dbName !== undefined && dbName !== 'main') {
      const rows = this.#raw.prepare('PRAGMA database_list').all() as Array<{ name?: string; file?: string }>;
      const match = rows.find((row) => row.name === dbName);
      return match?.file ? match.file : null;
    }
    if (this.#isMemory) return null;
    const filename = this.#raw.filename;
    if (!filename || isMemoryLocation(filename)) return null;
    if (filename.startsWith('file:')) {
      const rows = this.#raw.prepare('PRAGMA database_list').all() as Array<{ name?: string; file?: string }>;
      const main = rows.find((row) => row.name === 'main');
      return main?.file ? main.file : null;
    }
    return filename;
  }

  exec(sql: string): void {
    this.#assertOpen();
    this.#raw.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    this.#assertOpen();
    return new BunSqliteStatement(this.#raw.prepare(sql));
  }

  enableLoadExtension(allow: boolean): void {
    this.#assertOpen();
    if (allow) {
      throw new Error('Cannot enable extension loading because it was disabled at database creation.');
    }
  }

  close(): void {
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

export function openSqliteDatabase(location: string, options?: SqliteOpenOptions): SqliteDatabase {
  if (isBunRuntime) {
    return new BunSqliteDatabase(location, options);
  }
  const db = options === undefined
    ? new nodeSqlite!.DatabaseSync(location)
    : new nodeSqlite!.DatabaseSync(location, options);
  return db as unknown as SqliteDatabase;
}

function quotedSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isSafeSchemaIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * WAL-safe online snapshot of `db` into `destination`.
 *
 * On Node: delegates to `node:sqlite`'s `backup()`.
 * On Bun: runs SQLite's `VACUUM INTO` (which captures a consistent online
 * snapshot including committed WAL frames) with proper SQL quoting and
 * partial-file cleanup on failure.
 */
export async function backupDatabase(
  db: SqliteDatabase,
  destination: string,
  options?: SqliteBackupOptions,
): Promise<number> {
  if (!isBunRuntime) {
    const nativeDb = db as unknown as NodeDatabaseSync;
    return options === undefined
      ? nodeSqlite!.backup(nativeDb, destination)
      : nodeSqlite!.backup(nativeDb, destination, options);
  }

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

  // `VACUUM INTO` refuses an existing target file, whereas `node:sqlite`'s
  // `backup()` overwrites a pre-existing regular file. Remove a pre-existing
  // regular file (never a directory) before writing for cross-runtime parity.
  let existedBefore = false;
  if (existsSync(destination)) {
    existedBefore = true;
    try {
      if (statSync(destination).isFile()) {
        rmSync(destination, { force: true });
      }
    } catch {
      /* let VACUUM INTO report any filesystem error */
    }
  }

  const schemaPrefix = sourceSchema ? `${sourceSchema} ` : '';
  try {
    db.exec(`VACUUM ${schemaPrefix}INTO ${quotedSqlString(destination)}`);
  } catch (err) {
    if (!existedBefore) {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          rmSync(`${destination}${suffix}`, { force: true });
        } catch {
          /* best-effort cleanup of failed snapshot target */
        }
      }
    }
    throw err;
  }

  const pageCountPragma = sourceSchema ? `PRAGMA ${sourceSchema}.page_count` : 'PRAGMA page_count';
  const row = db.prepare(pageCountPragma).get() as { page_count?: number } | undefined;
  const pages = Number(row?.page_count ?? 0);
  options?.progress?.({ totalPages: pages, remainingPages: 0 });
  return pages;
}
