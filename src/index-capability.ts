// index-capability.ts — census-authorized search-plugin owned-index access.
//
// Plugins receive statements, never a database handle. SQLite's authorizer is
// installed only while Workbench prepares and executes one of those statements,
// making the settled ownership census the execution authority.

import { txn, type DbHandle } from './driver.ts';
import type { CensusEntry } from './schema-census.ts';
import type { SearchOwnedIndex } from './search-plugin.ts';

// Standard SQLite C-API authorizer return and action codes (sqlite3.h).
// Declared as numeric constants rather than imported from `node:sqlite` so this
// module works identically across Node and Bun runtimes.
const SQLITE_OK = 0;
const SQLITE_DENY = 1;

const SQLITE_CREATE_INDEX = 1;
const SQLITE_CREATE_TABLE = 2;
const SQLITE_CREATE_TEMP_INDEX = 3;
const SQLITE_CREATE_TEMP_TABLE = 4;
const SQLITE_CREATE_TEMP_TRIGGER = 5;
const SQLITE_CREATE_TEMP_VIEW = 6;
const SQLITE_CREATE_TRIGGER = 7;
const SQLITE_CREATE_VIEW = 8;
const SQLITE_DELETE = 9;
const SQLITE_DROP_INDEX = 10;
const SQLITE_DROP_TABLE = 11;
const SQLITE_DROP_TEMP_INDEX = 12;
const SQLITE_DROP_TEMP_TABLE = 13;
const SQLITE_DROP_TEMP_TRIGGER = 14;
const SQLITE_DROP_TEMP_VIEW = 15;
const SQLITE_DROP_TRIGGER = 16;
const SQLITE_DROP_VIEW = 17;
const SQLITE_INSERT = 18;
const SQLITE_PRAGMA = 19;
const SQLITE_READ = 20;
const SQLITE_SELECT = 21;
const SQLITE_TRANSACTION = 22;
const SQLITE_UPDATE = 23;
const SQLITE_ATTACH = 24;
const SQLITE_DETACH = 25;
const SQLITE_ALTER_TABLE = 26;
const SQLITE_REINDEX = 27;
const SQLITE_ANALYZE = 28;
const SQLITE_CREATE_VTABLE = 29;
const SQLITE_DROP_VTABLE = 30;
const SQLITE_FUNCTION = 31;
const SQLITE_SAVEPOINT = 32;

const BARE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SearchIndexStatement {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

export interface SearchIndexAuthorizerHandle extends DbHandle {
  setAuthorizer(callback: ((actionCode: number, arg1: string | null, arg2: string | null, dbName: string | null, triggerOrView: string | null) => number) | null): void;
  enableLoadExtension?(allow: boolean): void;
}

export interface SearchOwnedIndexCapabilityOptions {
  readonly db: SearchIndexAuthorizerHandle;
  readonly census: ReadonlyMap<string, CensusEntry>;
  readonly writeCoordinator: { run<T>(fn: () => T | Promise<T>): Promise<T> };
  readonly fenceOf: (pluginId: string) => number;
  readonly maxStatements?: number;
  readonly maxRows?: number;
}

const DENIED_ACTIONS = new Set<number>([
  SQLITE_ALTER_TABLE, SQLITE_ANALYZE, SQLITE_ATTACH,
  SQLITE_CREATE_INDEX, SQLITE_CREATE_TABLE, SQLITE_CREATE_TEMP_INDEX,
  SQLITE_CREATE_TEMP_TABLE, SQLITE_CREATE_TEMP_TRIGGER, SQLITE_CREATE_TEMP_VIEW,
  SQLITE_CREATE_TRIGGER, SQLITE_CREATE_VIEW, SQLITE_CREATE_VTABLE,
  SQLITE_DETACH, SQLITE_DROP_INDEX, SQLITE_DROP_TABLE,
  SQLITE_DROP_TEMP_INDEX, SQLITE_DROP_TEMP_TABLE, SQLITE_DROP_TEMP_TRIGGER,
  SQLITE_DROP_TEMP_VIEW, SQLITE_DROP_TRIGGER, SQLITE_DROP_VIEW,
  SQLITE_DROP_VTABLE, SQLITE_PRAGMA, SQLITE_REINDEX,
  SQLITE_SAVEPOINT, SQLITE_TRANSACTION,
]);

// These are the only SQL functions an owned-index statement may invoke. FTS5
// needs its auxiliary functions (and MATCH appears as one in the authorizer);
// the scalar/aggregate set supports ordinary result shaping and O(1) row counts
// without admitting connection state, extension loading, or UDFs.
const ALLOWED_FUNCTIONS = new Set([
  'abs', 'coalesce', 'concat', 'concat_ws', 'count', 'format', 'if', 'ifnull', 'iif',
  'instr', 'length', 'lower', 'ltrim', 'max', 'min', 'nullif', 'replace',
  'round', 'rtrim', 'substr', 'substring', 'trim', 'typeof', 'unicode', 'upper',
  'bm25', 'fts5', 'fts5_source_id', 'highlight', 'match', 'snippet',
]);

function ownedBy(census: ReadonlyMap<string, CensusEntry>, pluginId: string, name: string | null): boolean {
  if (name === null) return false;
  for (const kind of ['table', 'virtual-table', 'index', 'trigger'] as const) {
    const entry = census.get(`${kind}:${name.toLowerCase()}`);
    if (entry?.owner === pluginId && (entry.kind === 'plugin' || entry.kind === 'sqlite-artifact')) return true;
  }
  return false;
}

function isOwnedClearableTable(census: ReadonlyMap<string, CensusEntry>, pluginId: string, name: string): boolean {
  const lower = name.toLowerCase();
  for (const kind of ['table', 'virtual-table'] as const) {
    const entry = census.get(`${kind}:${lower}`);
    if (entry?.owner === pluginId && entry.kind === 'plugin') return true;
  }
  return false;
}

function isOwnedVirtualTable(census: ReadonlyMap<string, CensusEntry>, pluginId: string, name: string | null): boolean {
  if (name === null) return false;
  const entry = census.get(`virtual-table:${name.toLowerCase()}`);
  return entry?.kind === 'plugin' && entry.owner === pluginId;
}

function assertStatement(statement: SearchIndexStatement): void {
  if (!statement || typeof statement.sql !== 'string' || statement.sql.length === 0) {
    throw new TypeError('owned-index statement requires non-empty SQL');
  }
  if (statement.params !== undefined && !Array.isArray(statement.params)) {
    throw new TypeError('owned-index statement params must be an array');
  }
}

// Creates per-plugin facades after the lifecycle census has settled. There is no
// fallback for drivers without SQLite's authorizer: capability binding fails
// closed rather than attempting incomplete SQL inspection.
export function createSearchOwnedIndexCapability(options: SearchOwnedIndexCapabilityOptions): (pluginId: string) => SearchOwnedIndex {
  const { db, census, writeCoordinator, fenceOf } = options;
  const maxStatements = options.maxStatements ?? 128;
  const maxRows = options.maxRows ?? 10_000;
  if (typeof db.setAuthorizer !== 'function') {
    throw new Error('owned-index capability requires a SQLite statement authorizer');
  }
  // FTS5 is loaded before the post-census capability binds. Do not leave its
  // connection able to load arbitrary extensions while plugins hold SQL access.
  db.enableLoadExtension?.(false);
  if (!Number.isSafeInteger(maxStatements) || maxStatements < 1) {
    throw new TypeError('owned-index capability maxStatements must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new TypeError('owned-index capability maxRows must be a positive safe integer');
  }

  function execute<T>(pluginId: string, mode: 'query' | 'write', statement: SearchIndexStatement, run: () => T): T {
    assertStatement(statement);
    // FTS5 asks SQLite for the connection data version while it applies a
    // virtual-table operation. Permit that one engine-internal pragma only after
    // its census-owned virtual table has been selected for the operation.
    let virtualTableOperation = false;
    db.setAuthorizer((actionCode, arg1, arg2, dbName) => {
      if (dbName !== null && dbName !== 'main') return SQLITE_DENY;
      if (actionCode === SQLITE_PRAGMA) {
        return virtualTableOperation && arg1 === 'data_version' && arg2 === null
          ? SQLITE_OK
          : SQLITE_DENY;
      }
      if (DENIED_ACTIONS.has(actionCode)) return SQLITE_DENY;
      if (actionCode === SQLITE_READ) {
        if (isOwnedVirtualTable(census, pluginId, arg1)) virtualTableOperation = true;
        return ownedBy(census, pluginId, arg1) ? SQLITE_OK : SQLITE_DENY;
      }
      if (actionCode === SQLITE_INSERT || actionCode === SQLITE_UPDATE || actionCode === SQLITE_DELETE) {
        if (mode === 'write' && isOwnedVirtualTable(census, pluginId, arg1)) virtualTableOperation = true;
        return mode === 'write' && ownedBy(census, pluginId, arg1) ? SQLITE_OK : SQLITE_DENY;
      }
      // SELECT does not name a database object. A function does, however, name
      // executable connection code, so it is explicitly allowlisted.
      return actionCode === SQLITE_SELECT || (actionCode === SQLITE_FUNCTION && arg2 !== null && ALLOWED_FUNCTIONS.has(arg2.toLowerCase()))
        ? SQLITE_OK
        : SQLITE_DENY;
    });
    try {
      return run();
    } finally {
      db.setAuthorizer(null);
    }
  }

  return (pluginId: string): SearchOwnedIndex => {
    const index: SearchOwnedIndex = {
      bound: true,
      query(statement: SearchIndexStatement) {
        return execute(pluginId, 'query', statement, () => db.prepare(statement.sql).all(...(statement.params ?? [])));
      },
      async write({ expectedFence, statements }: { readonly expectedFence: number; readonly statements: readonly SearchIndexStatement[] }) {
        if (!Number.isSafeInteger(expectedFence) || expectedFence < 0) throw new TypeError('owned-index expectedFence must be a non-negative safe integer');
        if (!Array.isArray(statements) || statements.length === 0 || statements.length > maxStatements) {
          throw new Error(`owned-index write requires 1 to ${maxStatements} statements`);
        }
        return writeCoordinator.run(async () => {
          // This check is deliberately inside the coordinator turn and before the
          // transaction: a moved source fence executes no plugin statements.
          if (fenceOf(pluginId) !== expectedFence) return { changes: 0 };
          return txn(db, () => {
            const totalChanges = () => Number(db.prepare('SELECT total_changes() AS changes').get()?.changes ?? 0);
            const before = totalChanges();
            for (const statement of statements) {
              execute(pluginId, 'write', statement, () => db.prepare(statement.sql).run(...(statement.params ?? [])));
              // total_changes() includes rows changed by trigger programs and
              // virtual-table internals. Check before the transaction can commit.
              if (totalChanges() - before > maxRows) {
                throw new Error(`owned-index write exceeds the ${maxRows}-row batch limit`);
              }
            }
            return { changes: totalChanges() - before };
          }) as Promise<{ readonly changes: number }>;
        });
      },
      async clear({ expectedFence, table }: { readonly expectedFence: number; readonly table: string }) {
        if (!Number.isSafeInteger(expectedFence) || expectedFence < 0) {
          throw new TypeError('owned-index expectedFence must be a non-negative safe integer');
        }
        if (typeof table !== 'string' || !BARE_SQL_IDENTIFIER.test(table)) {
          throw new TypeError('owned-index clear requires a bare SQL table identifier');
        }
        if (!isOwnedClearableTable(census, pluginId, table)) {
          throw new Error(`owned-index clear refused: table '${table}' is not owned by plugin '${pluginId}'`);
        }
        return writeCoordinator.run(async () => {
          if (fenceOf(pluginId) !== expectedFence) return { changes: 0 };
          return txn(db, () => {
            const totalChanges = () => Number(db.prepare('SELECT total_changes() AS changes').get()?.changes ?? 0);
            const before = totalChanges();
            const statement: SearchIndexStatement = { sql: `DELETE FROM "${table}"` };
            execute(pluginId, 'write', statement, () => db.prepare(statement.sql).run());
            return { changes: totalChanges() - before };
          }) as Promise<{ readonly changes: number }>;
        });
      },
    };
    return Object.freeze(index);
  };
}
