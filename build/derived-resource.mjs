// derived-resource.ts — durable state for rebuildable, non-authoritative data.
//
// Callbacks can read the database, but may write only their declared objects.
// Each callback runs in one write-coordinator turn so a claimed rebuild cannot
// overlap another reconciler or an authoritative writer.
//
// Crash recovery: a throw mid-materialize is caught and demoted via the legal
// 'preparing'/'rebuilding' → 'failed' edges, but a process kill is not — the
// row survives as-is. engage() therefore sweeps rows stuck in 'preparing'
// (only reachable outside a live materialize turn, which holds the same
// coordinator) down to 'failed' so the normal prepare/rebuild paths pick the
// work back up on the next boot.


import { DERIVED_RESOURCE_TABLE_DDL, DERIVED_RESOURCE_TABLE_NAME } from './operational-ledger-ddl.mjs';

// Standard SQLite C API authorizer return and action codes (sqlite3.h),
// matching `node:sqlite`'s `constants` without a direct runtime import so the
// module loads cleanly on both Node and Bun.
const SQLITE_OK = 0;
const SQLITE_DENY = 1;
const SQLITE_DELETE = 9;
const SQLITE_INSERT = 18;
const SQLITE_READ = 20;
const SQLITE_SELECT = 21;
const SQLITE_UPDATE = 23;

export const DERIVED_RESOURCE_TABLE = DERIVED_RESOURCE_TABLE_NAME;








































const DDL = DERIVED_RESOURCE_TABLE_DDL;
const STATUSES = new Set                       (['absent', 'preparing', 'current', 'stale', 'rebuilding', 'failed']);
const TRANSITIONS                                                                            = {
  absent: ['preparing'], preparing: ['current', 'failed'], current: ['stale'],
  stale: ['rebuilding'], rebuilding: ['rebuilding', 'current', 'failed'], failed: ['rebuilding'],
};

function messageOf(error         )         {
  return error instanceof Error ? error.message : String(error);
}

function stateFrom(row                         )                       {
  const state = String(row.state);
  if (!STATUSES.has(state                         )) throw new Error(`derived resource '${String(row.id)}' has corrupt durable state '${state}'`);
  const attempts = Number(row.attempts);
  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new Error(`derived resource '${String(row.id)}' has corrupt durable attempts`);
  if (typeof row.updatedAt !== 'string' || row.updatedAt.length === 0) throw new Error(`derived resource '${String(row.id)}' has corrupt durable timestamp`);
  return Object.freeze({ id: String(row.id), state: state                         , attempts, lastError: row.lastError == null ? null : String(row.lastError), updatedAt: row.updatedAt });
}

export function createDerivedResourceRegistry({
  db,
  writeCoordinator,
  batchSize = 100,
  now = () => new Date().toISOString(),
}




 )                          {
  const resources = new Map                         ();
  const resolveDb = ()           => {
    const handle = typeof db === 'function' ? db() : db;
    if (!handle) throw new Error('derived resources require a database');
    return handle;
  };
  const validate = (resource                 )       => {
    if (!resource || typeof resource.id !== 'string' || resource.id.length === 0 || typeof resource.rebuild !== 'function') throw new TypeError('derived resources require a non-empty id and rebuild function');
    if (!Array.isArray(resource.ownedObjects) || resource.ownedObjects.some((name) => typeof name !== 'string' || name.length === 0)) throw new TypeError(`derived resource '${resource.id}' ownedObjects must be non-empty names`);
    if (resource.prepare !== undefined && typeof resource.prepare !== 'function') throw new TypeError(`derived resource '${resource.id}' prepare must be a function`);
    if (resource.onTransition !== undefined && typeof resource.onTransition !== 'function') throw new TypeError(`derived resource '${resource.id}' onTransition must be a function`);
  };
  const read = (id        )                       => {
    const row = resolveDb().prepare(`SELECT id, state, attempts, lastError, updatedAt FROM ${DERIVED_RESOURCE_TABLE} WHERE id = ?`).get(id);
    if (!row) throw new Error(`derived resource '${id}' is not engaged`);
    return stateFrom(row);
  };
  const transition = (id        , expected                       , next                       , lastError                = null, incrementAttempts = false)                              => {
    if (!TRANSITIONS[expected].includes(next)) throw new Error(`derived resource '${id}' cannot transition from '${expected}' to '${next}'`);
    const result = resolveDb().prepare(`UPDATE ${DERIVED_RESOURCE_TABLE} SET state = ?, attempts = attempts + ?, lastError = ?, updatedAt = ? WHERE id = ? AND state = ?`)
      .run(next, incrementAttempts ? 1 : 0, lastError, now(), id, expected);
    if (result.changes === 0) return null;
    const state = read(id);
    resources.get(id)?.onTransition?.(state);
    return state;
  };
  const contextFor = (resource                 , state                      )                         => {
    const handle = resolveDb()                    ;
    if (typeof handle.setAuthorizer !== 'function') throw new Error('derived resources require a SQLite statement authorizer');
    const owned = new Set(resource.ownedObjects.map((name) => name.toLowerCase()));
    const execute =    (statement                          , write         , run         )    => {
      if (!statement || typeof statement.sql !== 'string' || statement.sql.length === 0 || (statement.params !== undefined && !Array.isArray(statement.params))) throw new TypeError('derived resource statement requires SQL and optional array params');
      handle.setAuthorizer((action, arg1, _arg2, dbName) => {
        if (dbName !== null && dbName !== 'main') return SQLITE_DENY;
        if (action === SQLITE_READ || action === SQLITE_SELECT) return SQLITE_OK;
        if (action === SQLITE_INSERT || action === SQLITE_UPDATE || action === SQLITE_DELETE) return write && arg1 !== null && owned.has(arg1.toLowerCase()) ? SQLITE_OK : SQLITE_DENY;
        return SQLITE_DENY;
      });
      try { return run(); } finally { handle.setAuthorizer(null); }
    };
    return Object.freeze({
      state,
      query: (statement) => execute(statement, false, () => handle.prepare(statement.sql).all(...(statement.params ?? []))),
      write: (statement) => execute(statement, true, () => handle.prepare(statement.sql).run(...(statement.params ?? []))),
    });
  };

  async function engage()                {
    if (resources.size === 0) return;
    await writeCoordinator.run(() => {
      const handle = resolveDb(); handle.exec(DDL);
      for (const id of resources.keys()) {
        if (!handle.prepare(`SELECT 1 FROM ${DERIVED_RESOURCE_TABLE} WHERE id = ?`).get(id)) {
          handle.prepare(`INSERT INTO ${DERIVED_RESOURCE_TABLE} (id, state, attempts, lastError, updatedAt) VALUES (?, 'absent', 0, NULL, ?)`).run(id, now());
          resources.get(id)?.onTransition?.(read(id));
        }
      }
      // Boot recovery: a row in 'preparing' inside a coordinator turn cannot
      // belong to a live materialize (that holds the same coordinator), so it
      // is an orphan from a crashed process. Demote it on the legal
      // 'preparing' → 'failed' edge; prepare/rebuild then re-claim the work.
      for (const entry of handle.prepare(`SELECT id FROM ${DERIVED_RESOURCE_TABLE} WHERE state = 'preparing'`).all()) {
        const id = String((entry                           ).id);
        // transition() notifies onTransition itself.
        if (!transition(id, 'preparing', 'failed', 'interrupted by process exit', true)) throw new Error(`derived resource '${id}' has corrupt durable state 'preparing'`);
      }
    });
  }
  function register(resource                 )       { validate(resource); if (resources.has(resource.id)) throw new Error(`derived resource '${resource.id}' is already registered`); resources.set(resource.id, resource); }
  function stateOf(id        )                       { if (!resources.has(id)) throw new Error(`derived resource '${id}' is not registered`); return read(id); }
  function states()                                  {
    if (resources.size === 0) return [];
    return resolveDb().prepare(`SELECT id, state, attempts, lastError, updatedAt FROM ${DERIVED_RESOURCE_TABLE} ORDER BY id`).all().filter((row) => resources.has(String(row.id))).map(stateFrom);
  }
  async function markStale(id        )                                {
    if (!resources.has(id)) throw new Error(`derived resource '${id}' is not registered`); await engage();
    return writeCoordinator.run(() => {
      const current = read(id);
      return current.state === 'current' ? transition(id, 'current', 'stale')  : current;
    });
  }
  async function materialize(id        , kind                       )                                       {
    const resource = resources.get(id) ; const expected = kind === 'prepare' ? 'absent' : (['stale', 'failed', 'rebuilding']         );
    return writeCoordinator.run(async () => {
      const prior = read(id); const from = kind === 'prepare' ? 'absent' : prior.state;
      if (!(kind === 'prepare' ? prior.state === expected : expected.includes(from                                     ))) return null;
      const active = transition(id, from, kind === 'prepare' ? 'preparing' : 'rebuilding');
      if (!active) return null;
      try {
        if (kind === 'prepare') await resource.prepare?.(contextFor(resource, active)); else await resource.rebuild(contextFor(resource, active));
        return transition(id, active.state, 'current') ;
      } catch (error) { return transition(id, active.state, 'failed', messageOf(error), true) ; }
    });
  }
  async function prepareAll()                                           { await engage(); for (const [id] of resources) await materialize(id, 'prepare'); return states(); }
  async function reconcileBatches(options                                  = {})                                                              {
    await engage(); const limit = Math.max(1, Math.floor(options.batchSize ?? batchSize)); let processed = 0;
    for (const id of [...resources.keys()]) { if (processed >= limit) break; if (await materialize(id, 'rebuild')) processed++; }
    const remaining = states().filter((entry) => entry.state === 'stale' || entry.state === 'failed' || entry.state === 'rebuilding').length;
    return Object.freeze({ processed, remaining });
  }
  return Object.freeze({ register, engage, stateOf, states, markStale, prepareAll, reconcileBatches });
}
