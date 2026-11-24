import { lowerToSql, rowMatchesScope,                        } from '../scope-sql.mjs';
import { applyNearest,                  } from '../vector.mjs';

import { mayRow,                   } from '../row-grant.mjs';















// The recipient projection is injected by the entity compiler rather than
// imported here: ./projection.ts already imports rawRow from this module, and a
// query.ts → projection.ts import would add a new dependency cycle.


// A principal is MANDATORY on the scoped read helpers. findById/findAll default
// to a null principal precisely to bypass read authorization (trusted internal
// queries); letting an application handler omit it here would silently reopen
// that bypass. Throw before touching the database so an agent can never omit it.
function requirePrincipal(method        , principal         )                                 {
  if (principal === null || principal === undefined) {
    throw new TypeError(
      `${method} requires an explicit principal — use findById/findAll only for trusted internal reads`,
    );
  }
}





// Entity query SQL is stable for a bound entity; only its parameters change.
// Keep one prepared statement per database handle and exact SQL shape so the
// hot read paths do not pay SQLite statement compilation on every call. The
// driver contract is synchronous, so a statement is safe to reuse sequentially.
const preparedEntityStatements = new WeakMap                                     ();

function preparedEntityStatement                          (
  db                             ,
  sql        ,
)    {
  let statements = preparedEntityStatements.get(db);
  if (!statements) {
    statements = new Map();
    preparedEntityStatements.set(db, statements);
  }
  const existing = statements.get(sql);
  if (existing) return existing     ;
  const statement = db.prepare(sql);
  statements.set(sql, statement);
  return statement;
}









// The one shape every caller's db satisfies: only `get` on a prepared statement
// is used, so a driver or app handle returning `unknown` from `get` still works.




// One shared raw-stored-row read: `SELECT * FROM <entity> WHERE id = ?` exactly
// as the inline sites wrote it. Returns the stored cells as they are — no
// hydration, no authorization. The permission-checked, hydrated read is
// findById; a raw read never replaces it.
export function rawRow(
  db                             ,
  entity                           ,
  id         ,
)                  {
  if (!db) return undefined;
  const name = typeof entity === 'string' ? entity : entity.name;
  return preparedEntityStatement(db, `SELECT * FROM ${name} WHERE id = ?`).get(id)                   ;
}

export function makeQueryBuilder({ name, predicate, hydrate, defaultLimit = null, db }





 ) {
  const where = lowerToSql(predicate                                    )                 ;
  const state                                                                                = {
    orderBy: null,
    limit: null,
    selectCols: null,
  };
  const builder = {
    sort(field             , dir = 'asc') {
      const direction = String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      state.orderBy = `${field.fieldName} ${direction}`;
      return builder;
    },
    limit(n        ) {
      state.limit = Number(n);
      return builder;
    },
    select(...handles               ) {
      state.selectCols = handles.map((h) => h.fieldName);
      return builder;
    },
    then(resolve                          , reject                           ) {
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
  record                            ,
  { name, hydrate, deserializeStoredCells, db, projectRead }





   ,
) {
  const entityRecord = record                           ;

  // One fail-closed read decision for a materialized row. Both halves are
  // required: the compiled read scope decides row VISIBILITY (a scope-only
  // grant confers read to every row it is handed, so mayRow alone would fail
  // open across tenants), while the row grant's runtime `.can` decides the
  // read capability (mayVerb). Finally the field-read projection strips every
  // field this principal cannot read. Null means "not found" — never a partial
  // or unauthorized row.
  async function readForPrincipal(row     , principal           )                      {
    if (record.grant == null) return null;
    const readScope = record.readScope                                                                ;
    const scopeAst = record.scopeAst;
    if (readScope) {
      if (!scopeAst || !rowMatchesScope({ ...readScope, ast: scopeAst }                     , row, principal)) return null;
    }
    if (!(await mayRow(entityRecord, 'read', row, principal))) return null;
    return await projectRead(entityRecord, row, principal);
  }
  record.findOne = (predicate         ) => {
    const { sql, params } = lowerToSql(predicate                                    )                 ;
    const row = preparedEntityStatement(db, `SELECT * FROM ${name} AS t0 WHERE ${sql} LIMIT 1`)
      .get(params);
    return row ? hydrate(row) : null;
  };

  record.findAll = (predicate          ) => {
    if (predicate === undefined) {
      const rows = preparedEntityStatement(db, `SELECT * FROM ${name} AS t0`).all().map(hydrate)

       ;
      rows.select = (...handles               ) => {
        const cols = handles.map((h) => h.fieldName);
        return preparedEntityStatement(db, `SELECT ${cols.join(', ')} FROM ${name} AS t0`).all().map(hydrate);
      };
      return rows;
    }
    return makeQueryBuilder({ name, predicate, hydrate, defaultLimit: 1000, db });
  };

  record.findById = (id        , principal          = null) => {
    const row = preparedEntityStatement(db, `SELECT * FROM ${name} AS t0 WHERE t0.id = :id`).get({ id });
    return row ? hydrate(row, principal) : null;
  };

  // Principal-scoped reads: the safe default for application handlers. Unscoped
  // findById/findAll remain available as trusted internal primitives, but these
  // helpers are the ones agent-written handlers should reach for — the
  // principal cannot be omitted, and the row is authorized and projected before
  // it is returned.
  record.findByIdFor = async (id        , principal           )                      => {
    requirePrincipal('findByIdFor', principal);
    const row = (record.findById                                                    )(id, principal);
    return row ? await readForPrincipal(row, principal) : null;
  };

  record.findAllFor = async (principal           , predicate          )                 => {
    requirePrincipal('findAllFor', principal);
    const source = await (record.findAll                                                       )(predicate);
    const rows        = [];
    for (const row of source) {
      const admitted = await readForPrincipal(row, principal);
      if (admitted) rows.push(admitted);
    }
    return rows;
  };

  record.hydrate = (row     , principal          = null, dispatch          = null) =>
    hydrate(row, principal, dispatch);
  record.deserializeRow = (row     ) => deserializeStoredCells(row);

  record.getOrFail = (id        ) => {
    const row = (record.findById                              )(id);
    if (!row) {
      const err = new Error(`${name} ${id} not found`);
      (err                                 ).status = 404;
      throw err;
    }
    return row;
  };

  record.nearest = (fieldName        , queryVec         , k        ) => {
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
