// search-plugin.ts — the search plugin contract (epic scope#23, S4/A1).
//
// The generic plugin contract the S4 search section is built on. Workbench has
// field-level search primitives (fts-strategy.ts, vector.ts) but no way for a
// plugin to declare stable identity, owned DB objects, source interests,
// staleness keys, prepare/validate, reconcile/rebuild, search, or health and
// generation state. This module declares that contract and the registration
// seam:
//
//   1. DECLARATION — a SearchPlugin declares a stable id + version, the DB
//      objects it owns (tables / indexes / triggers / virtual tables, with the
//      DDL entries that create them), the source resources it indexes, the
//      staleness-key format, prepare/validate, reconcile (incremental), rebuild
//      (full), search, and health/generation state.
//   2. REGISTRY — createSearchPluginRegistry() validates every declaration at
//      registration (duplicate id, unknown owned-object kind, non-compilable
//      source scope, unsupported contract version) mirroring the S5/A2
//      registration-time-fail rule, and owns the health/generation state
//      machine below.
//   3. SCOPED SOURCE READERS — a plugin NEVER receives the raw DbHandle. It
//      receives a SearchSourceReader scoped to exactly its declared
//      sourceInterests: only the declared source tables are reachable, the
//      reader has no write verbs at all (writeCapable is a literal `false`),
//      and every read is constrained by the interest's declared `scope`
//      (compiled to a WHERE clause — a plugin declaring scope 'title === hello'
//      cannot read other rows).
//   4. FAILURE ISOLATION — an index failure marks that plugin failed (fence+1,
//      state 'failed') with retained retry info (message, at, attempt,
//      retryable); it never propagates as an authoritative-write error. The
//      write coordinator's `owned` plugin-index-write category (S1/A5) is where
//      a later wave materializes plugin-owned objects; this wave only declares
//      and orchestrates.
//   5. HEALTH + GENERATION — stateOf(id) / healthOf(id) disclose the shape S8
//      and search responses carry: { generation, fence, state, counts,
//      lastError }.
//
// The registry never imports a Scope noun. It is a pure typed contract plus an
// in-memory registry; the only runtime dependencies are the scope-compile seam
// (registration-time source-scope compilation, mirroring the authorization
// adapter) and the check registry.

import { buildCheckRegistry } from './registry.mjs';
import { compileReadScope, NonCompilableError } from './scope-sql.mjs';
import { SEARCH_STALENESS_TABLE_NAME } from './operational-ledger-ddl.mjs';
import {
  composeHybridSearch,
  HYBRID_SEARCH_DEFAULT_RRF_K,
  SEARCH_DEFAULT_TIMEOUT_MS,
  searchPageWindow,
  searchStalenessOf,
  searchWithDeadline,


} from './search-response.mjs';
export {
  composeHybridSearch,
  HYBRID_SEARCH_DEFAULT_RRF_K,





} from './search-response.mjs';

import { compileProjectPurgePlan,                       } from './owned-resource-purge.mjs';

// The contract version this package's registry supports. A plugin declares the
// version it was built against; anything else fails registration (version
// compatibility — a declaration cannot silently bind to a contract it was not
// written for).
export const SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION = 2;

// The closed plugin-state vocabulary. `building` = a materialization cycle is
// in progress (or nothing has materialized yet); `ready` = the index reflects
// the source up to the current fence; `stale` = a source change invalidated the
// index but reconciliation has not consumed it; `failed` = the last
// materialization attempt threw (retry info retained).


// The kinds of DB object a plugin may declare ownership of. The S2 ownership
// census ingests these (table/index/trigger/virtual-table).


// The plugin's own index statistics, folded into health after a successful
// materialization (e.g. { documents: 42, tokens: 1337 }).


// A DB object the plugin owns: the object kind, its name, and the DDL
// statements that create it. `ddl` entries are census-ingestible in the
// framework's { source, sql } DdlEntry shape (schema-table-census.ts), and
// `metadata` rides along as census metadata.








// A source resource the plugin indexes. `entity` names the source table; the
// optional `fields` supply the field descriptors a declared `scope` may
// reference; an optional `scope` predicate must compile to constrained SQL at
// registration (S5/A2 mirror) or the declaration is refused.








// A source change offered to a plugin. `stalenessKey(change)` maps it to the
// index partition it invalidates, or null when the change does not affect the
// plugin's index.







// A targeted revocation or erasure directive delivered to a plugin that
// supports incremental removal (avoiding a full-corpus rebuild when a single
// row or scope partition is revoked or erased).

















                                                                    










// The materialization summary a reconcile/rebuild reports; `counts` becomes the
// plugin's disclosed index statistics.




// The plugin-side search return: the hits. The registry stamps the
// authoritative generation/fence/state onto the disclosed SearchSearchOutcome —
// a plugin cannot spoof its own health.




// The minimal read handle the scoped source reader needs. Intentionally NOT the
// raw DbHandle type: the reader is built over a structurally read-only subset,
// so a plugin can never reach exec/run/transaction through it.







// Retained retry info for the last failure (spec 4: an index failure marks the
// plugin failed WITH retained retry info).







// The disclosed health/generation shape (spec 5). `generation` counts
// materialization cycles; `fence` counts source invalidations; a consumer
// holding results stamped with an older fence knows they are stale.










// The context every plugin lifecycle method receives. It carries ONLY the
// plugin's identity and its scoped source reader — never a raw handle.










// Narrow plugin-owned storage capability. The app binds it only after the
// ownership census settles; it intentionally has neither a raw database handle
// nor prepare/exec/transaction verbs.







// The scoped source reader handed to a plugin. Reachable sources are exactly
// the plugin's declared sourceInterests; the reader exposes no write verb and
// no raw handle (`writeCapable` is the literal `false` — the red-line proof).














































// Census-ingestible DDL entry — the same { source, sql } shape the framework's
// table census consumes (schema-table-census.ts / framework-table-names.ts).















// The plugin declaration (spec 1). `contractVersion` is the S4/A1 contract
// version the plugin targets; `version` is the plugin's own release version.
// `health()` is an OPTIONAL advisory hook — the registry owns the authoritative
// generation/fence/state and folds a plugin-reported value into healthOf() under
// `plugin` (healthOf never throws; a throwing health() reports null). There is
// NO plugin-supplied generation hook: generation/fence are registry-owned
// materialization/invalidation counts (spec 5). `stalenessKey` decides which
// changes invalidate the index (spec: stalenessKey(change) format).




















































// A bare SQL identifier: letters, digits, underscores, no leading digit. Owned
// object names and source-interest entities are validated against this, so the
// scoped reader's `SELECT * FROM <name>` interpolation is safe (fail closed —
// a plugin needing an exotic identifier is refused rather than interpolated).
const BARE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The S4/A2 staleness ledger's reserved table name (search-staleness.ts uses it
// as the default ledger table). A plugin source interest or owned object that
// collides with the ledger would read or clobber framework operational state as
// if it were plugin-owned domain data, so the registry REFUSES declarations
// that use it (namespace guarantee, review #109 finding 4). A bridge built with
// a custom tableName is the caller's own naming choice; the guarantee covers
// the framework default.
export const SEARCH_STALENESS_LEDGER_TABLE = SEARCH_STALENESS_TABLE_NAME;

const OWNED_OBJECT_KINDS                                     = new Set([
  'table',
  'index',
  'trigger',
  'virtual-table',
]);

function assertId(id         )                       {
  if (typeof id !== 'string' || id.length === 0 || id.includes('\0')) {
    throw new Error('search plugin registration requires a non-empty id without NUL bytes');
  }
}

function assertVersion(version         )                            {
  if (typeof version !== 'string' || version.length === 0 || version.includes('\0')) {
    throw new Error('search plugin registration requires a non-empty version string');
  }
}

function assertFunction(value         , label        , pluginId        )       {
  if (typeof value !== 'function') {
    throw new Error(`search plugin '${pluginId}' ${label} must be a function`);
  }
}

function assertIdentifierName(name         , label        , pluginId        )       {
  if (typeof name !== 'string' || !BARE_SQL_IDENTIFIER.test(name)) {
    throw new Error(
      `search plugin '${pluginId}' ${label} must be a bare SQL identifier ` +
        `(letters, digits, underscores, no leading digit) — got ${String(name)}`,
    );
  }
}

function quoteIdentifier(name        )         {
  return `"${name.replaceAll('"', '""')}"`;
}

// The compiled, positionalized form of one interest's declared `scope`. The
// scope compiler lowers the predicate to a SQL fragment with NAMED params
// (`:p1_val`); the scoped reader's handle only binds POSITIONALLY, so the named
// placeholders are rewritten to `?` in key order and the values collected in
// the same order (positionalize). The fragment references the base table under
// the compiler's canonical `t0` alias, so reads alias their table `AS t0`.





function positionalize(sql        , params                         )                {
  let out = sql;
  const args            = [];
  for (const [key, value] of Object.entries(params)) {
    out = out.replaceAll(`:${key}`, '?');
    args.push(value);
  }
  return { sql: out, args };
}

// Compile ONE interest's declared scope to its enforced WHERE fragment, or null
// when the interest declares no scope. Shared by registration (validation-only)
// and the scoped reader (enforcement): the exact same compile seam, so the
// reader can never admit a scope registration refused. A principal-bound param
// (is.<role>() from a ref-role field) binds NULL here — the plugin reader has
// no principal to rebind, so such a scope admits no rows (fail closed, matching
// anonymous-principal semantics).
function compileInterestScope(pluginId        , interest                      )                       {
  if (interest.scope === undefined) return null;
  const fields = interest.fields ?? {};
  const checkRegistry = buildCheckRegistry({
    fields,
    entityName: interest.entity,
  });
  const template = compileReadScope(interest.scope, {
    fields,
    where: `search plugin '${pluginId}' source interest '${interest.entity}'`,
    registry: checkRegistry                                      ,
    entityName: interest.entity,
  });
  return positionalize(template.sql, template.params);
}

// Build the scoped source reader for ONE plugin over a concrete read handle.
// `interests` must be the plugin's DECLARED sourceInterests (the registry
// passes exactly those); an entity outside the declared set is refused with a
// scoping error. The returned reader exposes no write verb and no raw handle,
// and every read enforces the interest's declared `scope` as a WHERE clause.
export function createSearchSourceReader(
  handle                           ,
  { plugin, interests }                                                                ,
)                     {
  const frozenInterests = Object.freeze([...interests].map((interest) => Object.freeze({
    ...interest,
    fields: interest.fields ? Object.freeze({ ...interest.fields }) : undefined,
  })));
  const entities = new Set(frozenInterests.map((interest) => interest.entity));
  const compiledScopes = new Map                       ();
  for (const interest of frozenInterests) {
    const compiled = compileInterestScope(plugin, interest);
    if (compiled !== null) compiledScopes.set(interest.entity, compiled);
  }

  function requireEntity(entity        )       {
    if (typeof entity !== 'string' || !BARE_SQL_IDENTIFIER.test(entity) || !entities.has(entity)) {
      throw new Error(
        `search plugin '${plugin}' source reader refused '${String(entity)}' — ` +
          `it is not a declared source interest (scoped reader; raw access is not available)`,
      );
    }
  }

  function requireHandle()                     {
    if (handle === null) {
      throw new Error(`search plugin '${plugin}' source reader has no bound source handle`);
    }
    return handle;
  }

  function rows(
    entity        ,
    options




      = {},
  )                                     {
    requireEntity(entity);
    const connection = requireHandle();
    // The declared scope is enforced on EVERY read, not just validated at
    // registration: a plugin declaring scope 'title === hello' never receives a
    // row whose title differs. Scope args precede the id args in the SQL, so
    // positional binding pushes them in that order.
    const scoped = compiledScopes.get(entity);
    const where           = [];
    const params            = [];
    if (scoped) {
      where.push(`(${scoped.sql})`);
      params.push(...scoped.args);
    }
    const ids = options.ids;
    if (ids !== undefined && ids.length > 0) {
      where.push(`${quoteIdentifier('id')} IN (${ids.map(() => '?').join(', ')})`);
      params.push(...ids);
    }
    if (options.afterId !== undefined) {
      where.push(`${quoteIdentifier('id')} > ?`);
      params.push(options.afterId);
    }
    let sql = `SELECT * FROM ${quoteIdentifier(entity)} AS t0`;
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    if (options.order === 'desc') {
      sql += ` ORDER BY ${quoteIdentifier('id')} DESC`;
    } else if (options.order === 'asc' || options.afterId !== undefined) {
      sql += ` ORDER BY ${quoteIdentifier('id')} ASC`;
    }
    if (typeof options.limit === 'number' && Number.isFinite(options.limit)) {
      sql += ` LIMIT ${Math.max(0, Math.floor(options.limit))}`;
    }
    return connection.prepare(sql).all(...params);
  }

  function row(entity        , id        )                                      {
    requireEntity(entity);
    const connection = requireHandle();
    // The id placeholder precedes the scope fragment, so the id is the FIRST
    // positional arg and the scope args follow it.
    const scoped = compiledScopes.get(entity);
    let sql = `SELECT * FROM ${quoteIdentifier(entity)} AS t0 WHERE ${quoteIdentifier('id')} = ?`;
    if (scoped) sql += ` AND (${scoped.sql})`;
    return connection.prepare(sql).get(id, ...(scoped ? scoped.args : []));
  }

  function count(entity        )         {
    requireEntity(entity);
    const connection = requireHandle();
    const scoped = compiledScopes.get(entity);
    let sql = `SELECT COUNT(*) AS count FROM ${quoteIdentifier(entity)} AS t0`;
    if (scoped) sql += ` WHERE (${scoped.sql})`;
    const result = connection.prepare(sql).get(...(scoped ? scoped.args : []));
    if (result && typeof result.count === 'number') return result.count;
    return rows(entity).length;
  }

  return Object.freeze({
    plugin,
    writeCapable: false,
    interests: frozenInterests,
    sources: () => Object.freeze([...entities]),
    rows,
    row,
    count,
  });
}

// Per-plugin health ledger: the registry's authoritative state plus retry
// accounting. A successful materialization folds result counts; a failure bumps
// fence (the index no longer matches the source) and records retry info.











function retryableOf(err         )          {
  return !(err instanceof NonCompilableError);
}

export function createSearchPluginRegistry(options                              = {})                       {
  const now = options.now ?? (() => new Date().toISOString());
  // The composition's hard search deadline: bounded by default, disabled only
  // by an explicit non-positive registry option (unbounded search).
  const searchTimeoutMs = options.searchTimeoutMs ?? SEARCH_DEFAULT_TIMEOUT_MS;
  const plugins = new Map                      ();
  const ledger = new Map                      ();
  const purgePlansById = new Map                          ();
  const ownedNames = new Set        ();
  let source                            = null;
  let indexCapability                                            = null;

  function ledgerOf(id        )               {
    const entry = ledger.get(id);
    if (!entry) {
      throw new Error(`search plugin '${id}' is not registered with this registry`);
    }
    return entry;
  }

  function synchronizeGenerationIdentity(entry              )       {
    if (entry.plugin.generationIdentity === entry.generationIdentity) return;
    entry.generationIdentity = entry.plugin.generationIdentity;
    entry.generation += 1;
    entry.fence += 1;
    entry.state = 'building';
    entry.counts = Object.freeze({});
    entry.lastError = null;
  }

  function stateOf(id        )                     {
    const entry = ledgerOf(id);
    synchronizeGenerationIdentity(entry);
    return {
      id,
      version: entry.plugin.version,
      generation: entry.generation,
      fence: entry.fence,
      state: entry.state,
      counts: entry.counts,
      lastError: entry.lastError,
    };
  }

  function contextOf(id        )                      {
    const entry = ledgerOf(id);
    synchronizeGenerationIdentity(entry);
    return {
      id,
      version: entry.plugin.version,
      reader: createSearchSourceReader(source, {
        plugin: id,
        interests: entry.plugin.sourceInterests,
      }),
      index: ownedIndex(id),
      generation: entry.generation,
      fence: entry.fence,
      state: entry.state,
    };
  }

  function recordFailure(id        , message        , retryable         )       {
    const entry = ledgerOf(id);
    entry.attempts += 1;
    entry.fence += 1;
    entry.state = 'failed';
    entry.lastError = Object.freeze({
      message,
      at: now(),
      attempt: entry.attempts,
      retryable,
    });
  }

  function register(plugin              )       {
    if (plugin === null || typeof plugin !== 'object') {
      throw new Error('search plugin registration requires a declaration object');
    }
    if (plugin.contractVersion !== SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION) {
      throw new Error(
        `search plugin '${String(plugin.id)}' declares contract version ${String(plugin.contractVersion)} — ` +
          `this registry supports ${SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION} (version compatibility: ` +
          'a declaration cannot bind to a contract it was not written for)',
      );
    }
    assertId(plugin.id);
    assertVersion(plugin.version);
    if (plugins.has(plugin.id)) {
      throw new Error(`search plugin id '${plugin.id}' is already registered (duplicate id)`);
    }
    assertFunction(plugin.stalenessKey, 'stalenessKey', plugin.id);
    assertFunction(plugin.prepare, 'prepare', plugin.id);
    assertFunction(plugin.validate, 'validate', plugin.id);
    assertFunction(plugin.reconcile, 'reconcile', plugin.id);
    assertFunction(plugin.rebuild, 'rebuild', plugin.id);
    assertFunction(plugin.search, 'search', plugin.id);
    if (plugin.revoke !== undefined) assertFunction(plugin.revoke, 'revoke', plugin.id);
    if (plugin.health !== undefined) assertFunction(plugin.health, 'health', plugin.id);

    if (!Array.isArray(plugin.ownedObjects)) {
      throw new Error(`search plugin '${plugin.id}' ownedObjects must be an array`);
    }
    // Intra-plugin duplicate detection happens BEFORE the global ownedNames
    // pass: a plugin naming the same object twice must not slip past on its
    // own second mention (ownedNames only gains this plugin's objects after
    // the whole array validated).
    const pluginOwnedNames = new Set        ();
    for (const object of plugin.ownedObjects) {
      if (object === null || typeof object !== 'object') {
        throw new Error(`search plugin '${plugin.id}' ownedObjects entries must be objects`);
      }
      if (!OWNED_OBJECT_KINDS.has(object.kind)) {
        throw new Error(
          `search plugin '${plugin.id}' owns an object of unknown kind '${String(object.kind)}' ` +
            `(allowed: ${[...OWNED_OBJECT_KINDS].join(', ')})`,
        );
      }
      assertIdentifierName(object.name, `owned object name`, plugin.id);
      if (object.name === SEARCH_STALENESS_LEDGER_TABLE) {
        throw new Error(
          `search plugin '${plugin.id}' owns object '${object.name}' which collides with the reserved staleness ledger table (${SEARCH_STALENESS_LEDGER_TABLE})`,
        );
      }
      if (pluginOwnedNames.has(object.name)) {
        throw new Error(
          `search plugin '${plugin.id}' declares owned object '${object.name}' more than once`,
        );
      }
      pluginOwnedNames.add(object.name);
      if (ownedNames.has(object.name)) {
        throw new Error(
          `search plugin '${plugin.id}' declares owned object '${object.name}' which is already owned by another plugin`,
        );
      }
      if (!Array.isArray(object.ddl) || object.ddl.length === 0 || object.ddl.some((sql        ) => typeof sql !== 'string' || sql.length === 0)) {
        throw new Error(
          `search plugin '${plugin.id}' owned object '${object.name}' must declare non-empty DDL statements`,
        );
      }
    }
    const purgePlan = compileProjectPurgePlan(plugin);

    if (!Array.isArray(plugin.sourceInterests)) {
      throw new Error(`search plugin '${plugin.id}' sourceInterests must be an array`);
    }
    const interestEntities = new Set        ();
    for (const interest of plugin.sourceInterests) {
      if (interest === null || typeof interest !== 'object') {
        throw new Error(`search plugin '${plugin.id}' sourceInterests entries must be objects`);
      }
      assertIdentifierName(interest.entity, 'source interest entity', plugin.id);
      if (interest.entity === SEARCH_STALENESS_LEDGER_TABLE) {
        throw new Error(
          `search plugin '${plugin.id}' declares a source interest in '${interest.entity}' which collides with the reserved staleness ledger table (${SEARCH_STALENESS_LEDGER_TABLE})`,
        );
      }
      if (interestEntities.has(interest.entity)) {
        throw new Error(
          `search plugin '${plugin.id}' declares source interest '${interest.entity}' more than once`,
        );
      }
      interestEntities.add(interest.entity);
      if (interest.scope !== undefined) {
        if (typeof interest.scope !== 'function') {
          throw new Error(
            `search plugin '${plugin.id}' source interest '${interest.entity}' scope must be a function`,
          );
        }
        // Registration-time compile (S5/A2 mirror): a scope that does not
        // compile to constrained SQL refuses the whole declaration. The SAME
        // seam the scoped reader uses to ENFORCE the scope on every read.
        compileInterestScope(plugin.id, interest);
      }
    }

    for (const object of plugin.ownedObjects) ownedNames.add(object.name);
    plugins.set(plugin.id, plugin);
    ledger.set(plugin.id, {
      plugin,
      generation: 0,
      fence: 0,
      state: 'building',
      counts: Object.freeze({}),
      lastError: null,
      attempts: 0,
      generationIdentity: plugin.generationIdentity,
    });
    purgePlansById.set(plugin.id, purgePlan);
  }

  function census()                     {
    const entries                            = [];
    const objects                             = [];
    for (const plugin of plugins.values()) {
      for (const object of plugin.ownedObjects) {
        for (const sql of object.ddl) {
          entries.push({ source: `search plugin '${plugin.id}' object '${object.name}'`, sql });
        }
        objects.push({ ...object, owner: plugin.id, version: plugin.version });
      }
    }
    return Object.freeze({ entries: Object.freeze(entries), objects: Object.freeze(objects) });
  }

  function purgePlans()                              {
    return Object.freeze([...purgePlansById.values()]);
  }


  function bindSource(handle                           )       {
    source = handle;
  }

  function bindIndex(index                                           )       {
    indexCapability = index;
  }

  function ownedIndex(id        )                   {
    ledgerOf(id);
    if (indexCapability === null) {
      // Direct registry/reconcile harnesses may run before application lifecycle
      // binding. They still receive the v2 shape, but every capability use fails
      // closed until the post-census app binding supplies an executor.
      return Object.freeze({
        bound: false,
        query: () => { throw new Error(`search plugin '${id}' owned-index capability is not bound until schema census succeeds`); },
        write: async () => { throw new Error(`search plugin '${id}' owned-index capability is not bound until schema census succeeds`); },
        clear: async () => { throw new Error(`search plugin '${id}' owned-index capability is not bound until schema census succeeds`); },
      });
    }
    return indexCapability(id);
  }

  function sourceReader(id        )                     {
    const entry = ledgerOf(id);
    return createSearchSourceReader(source, {
      plugin: id,
      interests: entry.plugin.sourceInterests,
    });
  }

  function notifyChange(id        , change              )                     {
    const entry = ledgerOf(id);
    // Invalidation runs INSIDE the failure boundary too: a throwing
    // stalenessKey must not escape orchestration. It records the failure in
    // health (fence+1, state 'failed', retained retry info) — the index can no
    // longer be trusted to reflect the source — and the notification reports no
    // successful invalidation.
    let key               ;
    try {
      key = entry.plugin.stalenessKey(change);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordFailure(id, message, retryableOf(err));
      return { invalidated: false, stalenessKey: null };
    }
    if (key === null) {
      return { invalidated: false, stalenessKey: null };
    }
    entry.fence += 1;
    if (entry.state === 'ready') entry.state = 'stale';
    return { invalidated: true, stalenessKey: key };
  }

  // Shared failure-isolation wrapper for the materialization methods. A throw
  // marks the plugin failed with retained retry info and is RETURNED as an
  // outcome — never thrown through the authoritative write path.
  async function materialize(
    id        ,
    readyOnSuccess         ,
    run                                                                                                        ,
  )                                  {
    const entry = ledgerOf(id);
    synchronizeGenerationIdentity(entry);
    entry.generation += 1;
    const generation = entry.generation;
    // CAS-style fence guard: a source change that lands while this cycle is
    // in flight means the materialized index does NOT reflect the current
    // fence. A success may only claim 'ready' when the fence it started with
    // is still current; otherwise the staleness is re-applied ('stale'), so an
    // older in-flight rebuild can never overwrite a newer invalidation with a
    // premature ready.
    const fenceAtStart = entry.fence;
    const identityAtStart = entry.plugin.generationIdentity;
    const ctx = contextOf(id);
    try {
      const result = await run(ctx);
      // A plugin-owned identity can change while an async materialization is
      // running (for example, a vector model-space switch). Its result belongs
      // to the old identity and cannot make the new one ready. The comparison
      // must be against the identity captured at START: if a newer
      // materialization synchronized the ledger while this one was in flight,
      // the current values would match and a stale result could overwrite the
      // newer generation's counts/state.
      if (entry.plugin.generationIdentity !== identityAtStart) {
        synchronizeGenerationIdentity(entry);
        return {
          ok: true,
          generation: entry.generation,
          fence: entry.fence,
          state: entry.state,
          counts: entry.counts,
          lastError: null,
          result: null,
        };
      }
      // Generation fence (#243): an overlapping same-identity materialization
      // that started later has already advanced `entry.generation`. Never allow
      // an older in-flight cycle to publish stale counts or state out of order.
      if (entry.generation !== generation) {
        return {
          ok: true,
          generation: entry.generation,
          fence: entry.fence,
          state: entry.state,
          counts: entry.counts,
          lastError: entry.lastError,
          result: null,
        };
      }
      // prepare success leaves the plugin building (owned objects exist, the
      // index is not materialized yet); validate/reconcile/rebuild success
      // makes the index ready — unless the fence moved mid-flight, in which
      // case the index stays stale regardless of this cycle's success.
      entry.lastError = null;
      const counts = result && result.counts ? Object.freeze({ ...result.counts }) : entry.counts;
      entry.counts = counts;
      entry.state = readyOnSuccess
        ? (entry.fence === fenceAtStart ? 'ready' : 'stale')
        : 'building';
      return {
        ok: true,
        generation,
        fence: entry.fence,
        state: entry.state,
        counts,
        lastError: null,
        result: result ?? null,
      };
    } catch (err) {
      if (entry.plugin.generationIdentity !== identityAtStart || entry.generation !== generation) {
        return {
          ok: false,
          generation: entry.generation,
          fence: entry.fence,
          state: entry.state,
          counts: entry.counts,
          lastError: entry.lastError,
          result: null,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      recordFailure(id, message, retryableOf(err));
      return {
        ok: false,
        generation,
        fence: entry.fence,
        state: entry.state,
        counts: entry.counts,
        lastError: entry.lastError,
        result: null,
      };
    }
  }

  function prepare(id        )                                  {
    return materialize(id, false, (ctx) => ledgerOf(id).plugin.prepare(ctx));
  }

  function validate(id        )                                  {
    return materialize(id, true, (ctx) => ledgerOf(id).plugin.validate(ctx));
  }

  function reconcile(id        , changes                         )                                  {
    return materialize(id, true, (ctx) => ledgerOf(id).plugin.reconcile(ctx, changes));
  }

  function rebuild(id        )                                  {
    return materialize(id, true, (ctx) => ledgerOf(id).plugin.rebuild(ctx));
  }

  function revoke(id        , target                        )                                  {
    return materialize(id, true, (ctx) => {
      const plugin = ledgerOf(id).plugin;
      if (typeof plugin.revoke === 'function') return plugin.revoke(ctx, target);
      return plugin.rebuild(ctx);
    });
  }

  async function search(id        , request               )                               {
    const entry = ledgerOf(id);
    synchronizeGenerationIdentity(entry);
    // The S4/A6 search composition seam. The registry — never the plugin —
    // owns the result window, cancellation/timeout, and the authoritative index
    // metadata:
    //   - START-STAMP: generation/fence/state are captured BEFORE the run. A
    //     search may take arbitrarily long; labeling old-index hits with
    //     post-await metadata would stamp them newer than they are.
    //   - WINDOW (registry-owned, single application): the caller's clamped
    //     window is applied to the plugin's OUTPUT exactly once, so nothing
    //     unbounded ever escapes the plugin. The plugin is ALWAYS asked from
    //     offset 0 for the full span the window needs (offset + limit) — the
    //     caller's offset is never forwarded, so a plugin that honors its
    //     request.offset can never have its output windowed a second time.
    //   - DEADLINE + ABORT: the run races the caller's signal and the hard
    //     deadline, so an uncooperative plugin can never hang the search; the
    //     plugin additionally receives the combined signal on its request so a
    //     cooperative plugin can stop work early.
    const generation = entry.generation;
    const fence = entry.fence;
    const state = entry.state;
    const ctx = contextOf(id);
    const { offset, limit } = searchPageWindow(request);
    const boundedRequest                = { ...request, offset: 0, limit: offset + limit };
    try {
      const run = await searchWithDeadline(
        (signal) => entry.plugin.search(ctx, { ...boundedRequest, signal }),
        { timeoutMs: searchTimeoutMs, signal: request.signal },
      );
      if (run.kind !== 'completed') {
        // A cancelled or timed-out search is a closed non-ok outcome with no
        // result and no hits. A query-side interruption does not invalidate
        // the index: state/fence/metadata are untouched and lastError stays
        // as it was — the closed flags are the disclosure.
        return {
          ok: false,
          generation,
          fence,
          state,
          counts: entry.counts,
          result: null,
          lastError: entry.lastError,
          cancelled: run.kind === 'cancelled',
          timedOut: run.kind === 'timed-out',
        };
      }
      const hits = run.value.hits.slice(offset, offset + limit);
      return {
        ok: true,
        generation,
        fence,
        state,
        counts: entry.counts,
        result: {
          hits,
          generation,
          fence,
          state,
        },
        lastError: null,
        cancelled: false,
        timedOut: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.attempts += 1;
      const lastError = Object.freeze({
        message,
        at: now(),
        attempt: entry.attempts,
        retryable: retryableOf(err),
      });
      entry.lastError = lastError;
      // A query-side failure does not invalidate the index: state/fence are
      // untouched, the failure is recorded for disclosure and retry accounting.
      return {
        ok: false,
        generation,
        fence,
        state,
        counts: entry.counts,
        result: null,
        lastError,
        cancelled: false,
        timedOut: false,
      };
    }
  }

  function healthOf(id        )                                                    {
    const entry = ledgerOf(id);
    let pluginHealth          = null;
    try {
      pluginHealth = entry.plugin.health ? entry.plugin.health(contextOf(id)) : null;
    } catch {
      pluginHealth = null;
    }
    return { ...stateOf(id), plugin: pluginHealth };
  }

  return Object.freeze({
    register,
    has: (id        ) => plugins.has(id),
    get: (id        ) => plugins.get(id),
    ids: () => Object.freeze([...plugins.keys()]),
    get size() {
      return plugins.size;
    },
    census,
    stateOf,
    healthOf,
    bindSource,
    bindIndex,
    ownedIndex,
    sourceReader,
    notifyChange,
    prepare,
    validate,
    reconcile,
    rebuild,
    revoke,
    search,
    purgePlans,
  });
}

// ---- built-in hybrid retrieval composer (FTS5 + vector RRF) -----------------
































// Run authorized FTS5 and vector searches in parallel through the registry and
// fuse their admitted hits via Reciprocal Rank Fusion (`weight / (k + rank)`),
// with deterministic `(score DESC, key ASC)` tie-breaking.
export async function hybridSearch(request                           )                                     {
  const { registry, principal, fts, vector, scope, scopeId, signal } = request;
  const k = request.k ?? HYBRID_SEARCH_DEFAULT_RRF_K;
  const window = searchPageWindow({
    limit: request.limit,
    offset: request.offset,
    page: request.page,
    pageSize: request.pageSize,
  });
  const defaultBranchLimit = Math.max(window.offset + window.limit, (window.offset + window.limit) * 2);
  const ftsLimit = fts.limit ?? defaultBranchLimit;
  const vectorLimit = vector.limit ?? defaultBranchLimit;

  const sharedScope = {
    ...(scope !== undefined ? { scope } : {}),
    ...(scopeId !== undefined ? { scopeId } : {}),
  };

  const [ftsOutcome, vectorOutcome] = await Promise.all([
    registry.search(fts.pluginId, {
      query: fts.query,
      principal,
      limit: ftsLimit,
      ...sharedScope,
      ...(signal !== undefined ? { signal } : {}),
    }),
    registry.search(vector.pluginId, {
      query: vector.query,
      principal,
      limit: vectorLimit,
      ...sharedScope,
      ...(signal !== undefined ? { signal } : {}),
    }),
  ]);

  const cancelled = ftsOutcome.cancelled || vectorOutcome.cancelled;
  const timedOut = !cancelled && (ftsOutcome.timedOut || vectorOutcome.timedOut);
  const ftsStaleness                  = searchStalenessOf(ftsOutcome.state);
  const vectorStaleness                  = searchStalenessOf(vectorOutcome.state);

  if (cancelled || timedOut || !ftsOutcome.ok || !vectorOutcome.ok || !ftsOutcome.result || !vectorOutcome.result) {
    const worst                  = ftsStaleness === 'stale' || vectorStaleness === 'stale'
      ? 'stale'
      : ftsStaleness === 'rebuilding' || vectorStaleness === 'rebuilding'
        ? 'rebuilding'
        : 'fresh';
    return Object.freeze({
      ok: false,
      cancelled,
      timedOut,
      hits: Object.freeze([]),
      totalCandidates: 0,
      staleness: worst,
      k,
      outcomes: Object.freeze({ fts: ftsOutcome, vector: vectorOutcome }),
    });
  }

  const fused = composeHybridSearch                                   (
    [
      {
        pluginId: fts.pluginId,
        hits: ftsOutcome.result.hits                                                ,
        weight: fts.weight,
        generation: ftsOutcome.generation,
        staleness: ftsStaleness,
      },
      {
        pluginId: vector.pluginId,
        hits: vectorOutcome.result.hits                                                ,
        weight: vector.weight,
        generation: vectorOutcome.generation,
        staleness: vectorStaleness,
      },
    ],
    {
      k,
      limit: window.limit,
      offset: window.offset,
    },
  );

  return Object.freeze({
    ...fused,
    cancelled: false,
    timedOut: false,
    outcomes: Object.freeze({ fts: ftsOutcome, vector: vectorOutcome }),
  });
}
