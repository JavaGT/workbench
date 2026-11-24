import { lowerToSql, rowMatchesScope, type ReadScopeTemplate } from '../scope-sql.ts';
import { applyNearest, type NearestSpec } from '../vector.ts';
import type { Principal } from '../principal.ts';
import { mayRow, type EntityRecord } from '../row-grant.ts';

type Row = Record<string, unknown>;
type HydrateFn = (row: Row, principal?: unknown, dispatch?: unknown) => Row;
type DeserializeFn = (row: Row) => Row;

type Statement = {
  run(...args: unknown[]): { changes: number };
  get(...args: unknown[]): Row | undefined;
  all(...args: unknown[]): Row[];
};

type Db = {
  prepare(sql: string): Statement;
};

// The recipient projection is injected by the entity compiler rather than
// imported here: ./projection.ts already imports rawRow from this module, and a
// query.ts → projection.ts import would add a new dependency cycle.
type ProjectRead = (entity: EntityRecord, row: Row, principal: Principal) => Promise<Row>;

// A principal is MANDATORY on the scoped read helpers. findById/findAll default
// to a null principal precisely to bypass read authorization (trusted internal
// queries); letting an application handler omit it here would silently reopen
// that bypass. Throw before touching the database so an agent can never omit it.
function requirePrincipal(method: string, principal: unknown): asserts principal is Principal {
  if (principal === null || principal === undefined) {
    throw new TypeError(
      `${method} requires an explicit principal — use findById/findAll only for trusted internal reads`,
    );
  }
}

type PreparedReader = {
  get(...args: unknown[]): unknown;
};

// Entity query SQL is stable for a bound entity; only its parameters change.
// Keep one prepared statement per database handle and exact SQL shape so the
// hot read paths do not pay SQLite statement compilation on every call. The
// driver contract is synchronous, so a statement is safe to reuse sequentially.
const preparedEntityStatements = new WeakMap<object, Map<string, PreparedReader>>();

function preparedEntityStatement<T extends PreparedReader>(
  db: { prepare(sql: string): T },
  sql: string,
): T {
  let statements = preparedEntityStatements.get(db);
  if (!statements) {
    statements = new Map();
    preparedEntityStatements.set(db, statements);
  }
  const existing = statements.get(sql);
  if (existing) return existing as T;
  const statement = db.prepare(sql);
  statements.set(sql, statement);
  return statement;
}

type CompiledScope = {
  sql: string;
  params: Record<string, unknown>;
  nearest: NearestSpec | null;
};

type FieldHandle = { fieldName: string };

// The one shape every caller's db satisfies: only `get` on a prepared statement
// is used, so a driver or app handle returning `unknown` from `get` still works.
type RawRowDb = {
  prepare(sql: string): { get(...args: unknown[]): unknown };
};

// One shared raw-stored-row read: `SELECT * FROM <entity> WHERE id = ?` exactly
// as the inline sites wrote it. Returns the stored cells as they are — no
// hydration, no authorization. The permission-checked, hydrated read is
// findById; a raw read never replaces it.
export function rawRow(
  db: RawRowDb | null | undefined,
  entity: { name: string } | string,
  id: unknown,
): Row | undefined {
  if (!db) return undefined;
  const name = typeof entity === 'string' ? entity : entity.name;
  return preparedEntityStatement(db, `SELECT * FROM ${name} WHERE id = ?`).get(id) as Row | undefined;
}

export function makeQueryBuilder({ name, predicate, hydrate, defaultLimit = null, db }: {
  name: string;
  predicate: unknown;
  hydrate: HydrateFn;
  defaultLimit?: number | null;
  db: Db;
}) {
  const where = lowerToSql(predicate as Parameters<typeof lowerToSql>[0]) as CompiledScope;
  const state: { orderBy: string | null; limit: number | null; selectCols: string[] | null } = {
    orderBy: null,
    limit: null,
    selectCols: null,
  };
  const builder = {
    sort(field: FieldHandle, dir = 'asc') {
      const direction = String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      state.orderBy = `${field.fieldName} ${direction}`;
      return builder;
    },
    limit(n: number) {
      state.limit = Number(n);
      return builder;
    },
    select(...handles: FieldHandle[]) {
      state.selectCols = handles.map((h) => h.fieldName);
      return builder;
    },
    then(resolve: (rows: Row[]) => unknown, reject: (err: unknown) => unknown) {
      try {
        const cols = state.selectCols ? state.selectCols.join(', ') : '*';
        let sql = `SELECT ${cols} FROM ${name} AS t0 WHERE ${where.sql}`;
        const params = { ...where.params };
        if (state.orderBy) sql += ` ORDER BY ${state.orderBy}`;
        const limit = state.limit !== null ? state.limit : defaultLimit;
        if (limit !== null) {
          sql += ` LIMIT :limit`;
          params.limit = limit;
        }
        let rows = preparedEntityStatement(db, sql).all(params).map(hydrate);
        if (where.nearest) {
          rows = applyNearest(rows, where.nearest, hydrate);
        }
        resolve(rows);
      } catch (err) {
        reject(err);
      }
    },
  };
  return builder;
}

export function installEntityQueries(
  record: { [key: string]: unknown },
  { name, hydrate, deserializeStoredCells, db, projectRead }: {
    name: string;
    hydrate: HydrateFn;
    deserializeStoredCells: DeserializeFn;
    db: Db;
    projectRead: ProjectRead;
  },
) {
  const entityRecord = record as unknown as EntityRecord;

  // One fail-closed read decision for a materialized row. Both halves are
  // required: the compiled read scope decides row VISIBILITY (a scope-only
  // grant confers read to every row it is handed, so mayRow alone would fail
  // open across tenants), while the row grant's runtime `.can` decides the
  // read capability (mayVerb). Finally the field-read projection strips every
  // field this principal cannot read. Null means "not found" — never a partial
  // or unauthorized row.
  async function readForPrincipal(row: Row, principal: Principal): Promise<Row | null> {
    if (record.grant == null) return null;
    const readScope = record.readScope as { sql: string; params: Record<string, unknown> } | undefined;
    const scopeAst = record.scopeAst;
    if (readScope) {
      if (!scopeAst || !rowMatchesScope({ ...readScope, ast: scopeAst } as ReadScopeTemplate, row, principal)) return null;
    }
    if (!(await mayRow(entityRecord, 'read', row, principal))) return null;
    return await projectRead(entityRecord, row, principal);
  }
  record.findOne = (predicate: unknown) => {
    const { sql, params } = lowerToSql(predicate as Parameters<typeof lowerToSql>[0]) as CompiledScope;
    const row = preparedEntityStatement(db, `SELECT * FROM ${name} AS t0 WHERE ${sql} LIMIT 1`)
      .get(params);
    return row ? hydrate(row) : null;
  };

  record.findAll = (predicate?: unknown) => {
    if (predicate === undefined) {
      const rows = preparedEntityStatement(db, `SELECT * FROM ${name} AS t0`).all().map(hydrate) as Row[] & {
        select: (...handles: FieldHandle[]) => Row[];
      };
      rows.select = (...handles: FieldHandle[]) => {
        const cols = handles.map((h) => h.fieldName);
        return preparedEntityStatement(db, `SELECT ${cols.join(', ')} FROM ${name} AS t0`).all().map(hydrate);
      };
      return rows;
    }
    return makeQueryBuilder({ name, predicate, hydrate, defaultLimit: 1000, db });
  };

  record.findById = (id: string, principal: unknown = null) => {
    const row = preparedEntityStatement(db, `SELECT * FROM ${name} AS t0 WHERE t0.id = :id`).get({ id });
    return row ? hydrate(row, principal) : null;
  };

  // Principal-scoped reads: the safe default for application handlers. Unscoped
  // findById/findAll remain available as trusted internal primitives, but these
  // helpers are the ones agent-written handlers should reach for — the
  // principal cannot be omitted, and the row is authorized and projected before
  // it is returned.
  record.findByIdFor = async (id: string, principal: Principal): Promise<Row | null> => {
    requirePrincipal('findByIdFor', principal);
    const row = (record.findById as (id: string, principal: Principal) => Row | null)(id, principal);
    return row ? await readForPrincipal(row, principal) : null;
  };

  record.findAllFor = async (principal: Principal, predicate?: unknown): Promise<Row[]> => {
    requirePrincipal('findAllFor', principal);
    const source = await (record.findAll as (predicate?: unknown) => Row[] | PromiseLike<Row[]>)(predicate);
    const rows: Row[] = [];
    for (const row of source) {
      const admitted = await readForPrincipal(row, principal);
      if (admitted) rows.push(admitted);
    }
    return rows;
  };

  record.hydrate = (row: Row, principal: unknown = null, dispatch: unknown = null) =>
    hydrate(row, principal, dispatch);
  record.deserializeRow = (row: Row) => deserializeStoredCells(row);

  record.getOrFail = (id: string) => {
    const row = (record.findById as (id: string) => Row | null)(id);
    if (!row) {
      const err = new Error(`${name} ${id} not found`);
      (err as unknown as { status: number }).status = 404;
      throw err;
    }
    return row;
  };

  record.nearest = (fieldName: string, queryVec: unknown, k: number) => {
    if (typeof fieldName !== 'string') {
      throw new Error(`nearest() requires a field name (string), got ${typeof fieldName}`);
    }
    if (!Array.isArray(queryVec)) {
      throw new Error(`nearest() requires a query vector (number[]), got ${typeof queryVec}`);
    }
    if (typeof k !== 'number' || k < 1) {
      throw new Error(`nearest() requires a positive integer k, got ${k}`);
    }
    const rows = preparedEntityStatement(db, `SELECT * FROM ${name} AS t0`).all().map(deserializeStoredCells);
    return applyNearest(rows, { field: fieldName, query: queryVec, k }).map(hydrate);
  };
}
