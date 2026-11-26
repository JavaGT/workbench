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

import { buildCheckRegistry } from './registry.ts';
import { compileReadScope, NonCompilableError } from './scope-sql.ts';
import { SEARCH_STALENESS_TABLE_NAME } from './operational-ledger-ddl.ts';
import {
  composeHybridSearch,
  HYBRID_SEARCH_DEFAULT_RRF_K,
  SEARCH_DEFAULT_TIMEOUT_MS,
  SEARCH_MAX_RESULTS_CAP,
  searchPageWindow,
  SearchWindowValidationError,
  searchStalenessOf,
  searchWithDeadline,
  type HybridSearchResult,
  type SearchStaleness,
} from './search-response.ts';
export {
  composeHybridSearch,
  HYBRID_SEARCH_DEFAULT_RRF_K,
  type HybridSearchHit,
  type HybridSearchOptions,
  type HybridSearchResult,
  type HybridSearchSourceContribution,
  type HybridSearchSourceInput,
} from './search-response.ts';
import type { Principal } from './principal.ts';
import { compileProjectPurgePlan, type ProjectPurgePlan } from './owned-resource-purge.ts';

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
export type SearchPluginState = 'building' | 'ready' | 'stale' | 'failed';

// The kinds of DB object a plugin may declare ownership of. The S2 ownership
// census ingests these (table/index/trigger/virtual-table).
export type SearchOwnedObjectKind = 'table' | 'index' | 'trigger' | 'virtual-table';

// The plugin's own index statistics, folded into health after a successful
// materialization (e.g. { documents: 42, tokens: 1337 }).
export type SearchPluginCounts = Readonly<Record<string, number>>;

// A DB object the plugin owns: the object kind, its name, and the DDL
// statements that create it. `ddl` entries are census-ingestible in the
// framework's { source, sql } DdlEntry shape (schema-table-census.ts), and
// `metadata` rides along as census metadata.
export interface SearchOwnedObject {
  readonly kind: SearchOwnedObjectKind;
  readonly name: string;
  readonly ddl: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly disposition: import('./owned-resource-purge.ts').ProjectPurgeDisposition;
}

// A source resource the plugin indexes. `entity` names the source table; the
// optional `fields` supply the field descriptors a declared `scope` may
// reference; an optional `scope` predicate must compile to constrained SQL at
// registration (S5/A2 mirror) or the declaration is refused.
export interface SearchSourceInterest {
  readonly entity: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly scope?: (ctx: { is: unknown; fields: unknown }) => unknown;
}

export type SearchChangeKind = 'created' | 'updated' | 'removed';

// A source change offered to a plugin. `stalenessKey(change)` maps it to the
// index partition it invalidates, or null when the change does not affect the
// plugin's index.
export interface SearchChange {
  readonly entity: string;
  readonly rowId: string;
  readonly kind: SearchChangeKind;
  readonly data?: Readonly<Record<string, unknown>>;
}

// A targeted revocation or erasure directive delivered to a plugin that
// supports incremental removal (avoiding a full-corpus rebuild when a single
// row or scope partition is revoked or erased).
export interface SearchRevocationTarget {
  readonly kind: 'revocation' | 'erasure';
  readonly entity: string;
  readonly rowId?: string;
  readonly scopeId?: string;
}

export interface SearchRequest {
  readonly query: unknown;
  readonly entity?: string;
  readonly principal?: Principal;
  readonly scope?: string | Readonly<Record<string, unknown>>;
  readonly scopeId?: string;
  readonly limit?: number;
  readonly offset?: number;
  // The window the plugin is asked to serve. The registry owns offsetting, so
  // a plugin is ALWAYS invoked with `offset: 0` and `limit` = the full span
  // (caller offset + caller limit) its output will be sliced from — a plugin
  // should return its top `limit` hits in relevance order and never apply an
  // offset of its own (a nonzero offset arriving here would be a contract
  // violation by the registry).
  // The caller's cancellation signal (S4/A6). The registry's search composition
  // races the run against this signal AND a hard deadline (searchTimeoutMs),
  // and hands the plugin a combined signal on the request it runs with, so a
  // cooperative plugin can stop work on either cancellation or timeout.
  readonly signal?: AbortSignal;
}

// The materialization summary a reconcile/rebuild reports; `counts` becomes the
// plugin's disclosed index statistics.
export interface SearchMaterializeResult {
  readonly counts?: SearchPluginCounts;
}

// The plugin-side search return: the hits. The registry stamps the
// authoritative generation/fence/state onto the disclosed SearchSearchOutcome —
// a plugin cannot spoof its own health.
export interface SearchPluginSearchResult {
  readonly hits: readonly unknown[];
}

// The minimal read handle the scoped source reader needs. Intentionally NOT the
// raw DbHandle type: the reader is built over a structurally read-only subset,
// so a plugin can never reach exec/run/transaction through it.
export interface SearchSourceHandle {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
}

// Retained retry info for the last failure (spec 4: an index failure marks the
// plugin failed WITH retained retry info).
export interface SearchRetryInfo {
  readonly message: string;
  readonly at: string;
  readonly attempt: number;
  readonly retryable: boolean;
}

// The disclosed health/generation shape (spec 5). `generation` counts
// materialization cycles; `fence` counts source invalidations; a consumer
// holding results stamped with an older fence knows they are stale.
export interface SearchPluginHealth {
  readonly id: string;
  readonly version: string;
  readonly generation: number;
  readonly fence: number;
  readonly state: SearchPluginState;
  readonly counts: SearchPluginCounts;
  readonly lastError: SearchRetryInfo | null;
}

// The context every plugin lifecycle method receives. It carries ONLY the
// plugin's identity and its scoped source reader — never a raw handle.
export interface SearchPluginContext {
  readonly id: string;
  readonly version: string;
  readonly reader: SearchSourceReader;
  readonly index: SearchOwnedIndex;
  readonly generation: number;
  readonly fence: number;
  readonly state?: SearchPluginState;
}

// Narrow plugin-owned storage capability. The app binds it only after the
// ownership census settles; it intentionally has neither a raw database handle
// nor prepare/exec/transaction verbs.
export interface SearchOwnedIndex {
  readonly bound?: boolean;
  query(request: { readonly sql: string; readonly params?: readonly unknown[] }): readonly Record<string, unknown>[];
  write(request: { readonly expectedFence: number; readonly statements: readonly { readonly sql: string; readonly params?: readonly unknown[] }[] }): Promise<{ readonly changes: number }>;
  clear?(request: { readonly expectedFence: number; readonly table: string }): Promise<{ readonly changes: number }>;
}

// The scoped source reader handed to a plugin. Reachable sources are exactly
// the plugin's declared sourceInterests; the reader exposes no write verb and
// no raw handle (`writeCapable` is the literal `false` — the red-line proof).
export interface SearchSourceReader {
  readonly plugin: string;
  readonly writeCapable: false;
  readonly interests: readonly SearchSourceInterest[];
  sources(): readonly string[];
  rows(entity: string, options?: {
    readonly ids?: readonly string[];
    readonly limit?: number;
    readonly afterId?: string;
    readonly order?: 'asc' | 'desc';
  }): readonly Record<string, unknown>[];
  row(entity: string, id: string): Record<string, unknown> | undefined;
  count?(entity: string): number;
}

export interface SearchLifecycleOutcome {
  readonly ok: boolean;
  readonly generation: number;
  readonly fence: number;
  readonly state: SearchPluginState;
  readonly counts: SearchPluginCounts;
  readonly lastError: SearchRetryInfo | null;
  readonly result: SearchMaterializeResult | null;
}

export interface SearchSearchOutcome {
  readonly ok: boolean;
  readonly generation: number;
  readonly fence: number;
  readonly state: SearchPluginState;
  readonly counts: SearchPluginCounts;
  readonly result: { readonly hits: readonly unknown[]; readonly generation: number; readonly fence: number; readonly state: SearchPluginState } | null;
  readonly lastError: SearchRetryInfo | null;
  // Closed disclosure of a search that did not complete: true when the search
  // was cancelled by the caller's signal or stopped by the deadline (S4/A6).
  // Never both true; false on a completed or failed search. The caller builds
  // a cancelled/timed-out response from these flags.
  readonly cancelled: boolean;
  readonly timedOut: boolean;
}

export interface SearchNotification {
  readonly invalidated: boolean;
  readonly stalenessKey: string | null;
}

// Census-ingestible DDL entry — the same { source, sql } shape the framework's
// table census consumes (schema-table-census.ts / framework-table-names.ts).
export interface SearchPluginCensusEntry {
  readonly source: string;
  readonly sql: string;
}

export interface SearchPluginCensusObject extends SearchOwnedObject {
  readonly owner: string;
  readonly version: string;
}

export interface SearchPluginCensus {
  readonly entries: readonly SearchPluginCensusEntry[];
  readonly objects: readonly SearchPluginCensusObject[];
}

// The plugin declaration (spec 1). `contractVersion` is the S4/A1 contract
// version the plugin targets; `version` is the plugin's own release version.
// `health()` is an OPTIONAL advisory hook — the registry owns the authoritative
// generation/fence/state and folds a plugin-reported value into healthOf() under
// `plugin` (healthOf never throws; a throwing health() reports null). There is
// NO plugin-supplied generation hook: generation/fence are registry-owned
// materialization/invalidation counts (spec 5). `stalenessKey` decides which
// changes invalidate the index (spec: stalenessKey(change) format).
export interface SearchPlugin {
  readonly contractVersion: number;
  readonly id: string;
  readonly version: string;
  readonly ownedObjects: readonly SearchOwnedObject[];
  readonly sourceInterests: readonly SearchSourceInterest[];
  // An optional plugin-owned identity for index content that is invalidated by
  // configuration, rather than by a source-row change (for example a model-space).
  // The registry observes it and marks its authoritative ledger unmaterialized.
  readonly generationIdentity?: string;
  stalenessKey(change: SearchChange): string | null;
  prepare(ctx: SearchPluginContext): void | Promise<void>;
  validate(ctx: SearchPluginContext): void | Promise<void>;
  reconcile(ctx: SearchPluginContext, changes: readonly SearchChange[]): SearchMaterializeResult | Promise<SearchMaterializeResult>;
  rebuild(ctx: SearchPluginContext): SearchMaterializeResult | Promise<SearchMaterializeResult>;
  revoke?(ctx: SearchPluginContext, target: SearchRevocationTarget): SearchMaterializeResult | Promise<SearchMaterializeResult>;
  search(ctx: SearchPluginContext, request: SearchRequest): SearchPluginSearchResult | Promise<SearchPluginSearchResult>;
  health?(ctx: SearchPluginContext): unknown;
}

export interface SearchPluginRegistryOptions {
  now?: () => string;
  // The default hard deadline for a search run, in milliseconds (S4/A6). The
  // search composition races every plugin search against this deadline and the
  // caller's signal, so an uncooperative plugin can never hang a search. A
  // non-positive value disables the timeout (unbounded search).
  searchTimeoutMs?: number;
}

export interface SearchPluginRegistry {
  readonly size: number;
  register(plugin: SearchPlugin): void;
  has(id: string): boolean;
  get(id: string): SearchPlugin | undefined;
  ids(): readonly string[];
  census(): SearchPluginCensus;
  stateOf(id: string): SearchPluginHealth;
  healthOf(id: string): SearchPluginHealth & { readonly plugin: unknown };
  bindSource(handle: SearchSourceHandle | null): void;
  bindIndex(index: ((id: string) => SearchOwnedIndex) | null): void;
  ownedIndex(id: string): SearchOwnedIndex;
  sourceReader(id: string): SearchSourceReader;
  notifyChange(id: string, change: SearchChange): SearchNotification;
  prepare(id: string): Promise<SearchLifecycleOutcome>;
  validate(id: string): Promise<SearchLifecycleOutcome>;
  reconcile(id: string, changes: readonly SearchChange[]): Promise<SearchLifecycleOutcome>;
  rebuild(id: string): Promise<SearchLifecycleOutcome>;
  revoke(id: string, target: SearchRevocationTarget): Promise<SearchLifecycleOutcome>;
  search(id: string, request: SearchRequest): Promise<SearchSearchOutcome>;
  purgePlans(): readonly ProjectPurgePlan[];
}

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

const OWNED_OBJECT_KINDS: ReadonlySet<SearchOwnedObjectKind> = new Set([
  'table',
  'index',
  'trigger',
  'virtual-table',
]);

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length === 0 || id.includes('\0')) {
    throw new Error('search plugin registration requires a non-empty id without NUL bytes');
  }
}

function assertVersion(version: unknown): asserts version is string {
  if (typeof version !== 'string' || version.length === 0 || version.includes('\0')) {
    throw new Error('search plugin registration requires a non-empty version string');
  }
}

function assertFunction(value: unknown, label: string, pluginId: string): void {
  if (typeof value !== 'function') {
    throw new Error(`search plugin '${pluginId}' ${label} must be a function`);
  }
}

function assertIdentifierName(name: unknown, label: string, pluginId: string): void {
  if (typeof name !== 'string' || !BARE_SQL_IDENTIFIER.test(name)) {
    throw new Error(
      `search plugin '${pluginId}' ${label} must be a bare SQL identifier ` +
        `(letters, digits, underscores, no leading digit) — got ${String(name)}`,
    );
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

// The compiled, positionalized form of one interest's declared `scope`. The
// scope compiler lowers the predicate to a SQL fragment with NAMED params
// (`:p1_val`); the scoped reader's handle only binds POSITIONALLY, so the named
// placeholders are rewritten to `?` in key order and the values collected in
// the same order (positionalize). The fragment references the base table under
// the compiler's canonical `t0` alias, so reads alias their table `AS t0`.
export interface CompiledScope {
  readonly sql: string;
  readonly args: readonly unknown[];
}

function positionalize(sql: string, params: Record<string, unknown>): CompiledScope {
  let out = sql;
  const args: unknown[] = [];
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
function compileInterestScope(pluginId: string, interest: SearchSourceInterest): CompiledScope | null {
  if (interest.scope === undefined) return null;
  const fields = interest.fields ?? {};
  const checkRegistry = buildCheckRegistry({
    fields,
    entityName: interest.entity,
  });
  const template = compileReadScope(interest.scope, {
    fields,
    where: `search plugin '${pluginId}' source interest '${interest.entity}'`,
    registry: checkRegistry as unknown as Record<string, unknown>,
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
  handle: SearchSourceHandle | null,
  { plugin, interests }: { plugin: string; interests: readonly SearchSourceInterest[] },
): SearchSourceReader {
  const frozenInterests = Object.freeze([...interests].map((interest) => Object.freeze({
    ...interest,
    fields: interest.fields ? Object.freeze({ ...interest.fields }) : undefined,
  })));
  const entities = new Set(frozenInterests.map((interest) => interest.entity));
  const compiledScopes = new Map<string, CompiledScope>();
  for (const interest of frozenInterests) {
    const compiled = compileInterestScope(plugin, interest);
    if (compiled !== null) compiledScopes.set(interest.entity, compiled);
  }

  function requireEntity(entity: string): void {
    if (typeof entity !== 'string' || !BARE_SQL_IDENTIFIER.test(entity) || !entities.has(entity)) {
      throw new Error(
        `search plugin '${plugin}' source reader refused '${String(entity)}' — ` +
          `it is not a declared source interest (scoped reader; raw access is not available)`,
      );
    }
  }

  function requireHandle(): SearchSourceHandle {
    if (handle === null) {
      throw new Error(`search plugin '${plugin}' source reader has no bound source handle`);
    }
    return handle;
  }

  function rows(
    entity: string,
    options: {
      readonly ids?: readonly string[];
      readonly limit?: number;
      readonly afterId?: string;
      readonly order?: 'asc' | 'desc';
    } = {},
  ): readonly Record<string, unknown>[] {
    requireEntity(entity);
    const connection = requireHandle();
    // The declared scope is enforced on EVERY read, not just validated at
    // registration: a plugin declaring scope 'title === hello' never receives a
    // row whose title differs. Scope args precede the id args in the SQL, so
    // positional binding pushes them in that order.
    const scoped = compiledScopes.get(entity);
    const where: string[] = [];
    const params: unknown[] = [];
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

  function row(entity: string, id: string): Record<string, unknown> | undefined {
    requireEntity(entity);
    const connection = requireHandle();
    // The id placeholder precedes the scope fragment, so the id is the FIRST
    // positional arg and the scope args follow it.
    const scoped = compiledScopes.get(entity);
    let sql = `SELECT * FROM ${quoteIdentifier(entity)} AS t0 WHERE ${quoteIdentifier('id')} = ?`;
    if (scoped) sql += ` AND (${scoped.sql})`;
    return connection.prepare(sql).get(id, ...(scoped ? scoped.args : []));
  }

  function count(entity: string): number {
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
interface PluginLedger {
  plugin: SearchPlugin;
  generation: number;
  fence: number;
  state: SearchPluginState;
  counts: SearchPluginCounts;
  lastError: SearchRetryInfo | null;
  attempts: number;
  generationIdentity: string | undefined;
}

function retryableOf(err: unknown): boolean {
  return !(err instanceof NonCompilableError);
}

export function createSearchPluginRegistry(options: SearchPluginRegistryOptions = {}): SearchPluginRegistry {
  const now = options.now ?? (() => new Date().toISOString());
  // The composition's hard search deadline: bounded by default, disabled only
  // by an explicit non-positive registry option (unbounded search).
  const searchTimeoutMs = options.searchTimeoutMs ?? SEARCH_DEFAULT_TIMEOUT_MS;
  const plugins = new Map<string, SearchPlugin>();
  const ledger = new Map<string, PluginLedger>();
  const purgePlansById = new Map<string, ProjectPurgePlan>();
  const ownedNames = new Set<string>();
  let source: SearchSourceHandle | null = null;
  let indexCapability: ((id: string) => SearchOwnedIndex) | null = null;

  function ledgerOf(id: string): PluginLedger {
    const entry = ledger.get(id);
    if (!entry) {
      throw new Error(`search plugin '${id}' is not registered with this registry`);
    }
    return entry;
  }

  function synchronizeGenerationIdentity(entry: PluginLedger): void {
    if (entry.plugin.generationIdentity === entry.generationIdentity) return;
    entry.generationIdentity = entry.plugin.generationIdentity;
    entry.generation += 1;
    entry.fence += 1;
    entry.state = 'building';
    entry.counts = Object.freeze({});
    entry.lastError = null;
  }

  function stateOf(id: string): SearchPluginHealth {
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

  function contextOf(id: string): SearchPluginContext {
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

  function recordFailure(id: string, message: string, retryable: boolean): void {
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

  function register(plugin: SearchPlugin): void {
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
    const pluginOwnedNames = new Set<string>();
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
      if (!Array.isArray(object.ddl) || object.ddl.length === 0 || object.ddl.some((sql: string) => typeof sql !== 'string' || sql.length === 0)) {
        throw new Error(
          `search plugin '${plugin.id}' owned object '${object.name}' must declare non-empty DDL statements`,
        );
      }
    }
    const purgePlan = compileProjectPurgePlan(plugin);

    if (!Array.isArray(plugin.sourceInterests)) {
      throw new Error(`search plugin '${plugin.id}' sourceInterests must be an array`);
    }
    const interestEntities = new Set<string>();
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

  function census(): SearchPluginCensus {
    const entries: SearchPluginCensusEntry[] = [];
    const objects: SearchPluginCensusObject[] = [];
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

  function purgePlans(): readonly ProjectPurgePlan[] {
    return Object.freeze([...purgePlansById.values()]);
  }


  function bindSource(handle: SearchSourceHandle | null): void {
    source = handle;
  }

  function bindIndex(index: ((id: string) => SearchOwnedIndex) | null): void {
    indexCapability = index;
  }

  function ownedIndex(id: string): SearchOwnedIndex {
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

  function sourceReader(id: string): SearchSourceReader {
    const entry = ledgerOf(id);
    return createSearchSourceReader(source, {
      plugin: id,
      interests: entry.plugin.sourceInterests,
    });
  }

  function notifyChange(id: string, change: SearchChange): SearchNotification {
    const entry = ledgerOf(id);
    // Invalidation runs INSIDE the failure boundary too: a throwing
    // stalenessKey must not escape orchestration. It records the failure in
    // health (fence+1, state 'failed', retained retry info) — the index can no
    // longer be trusted to reflect the source — and the notification reports no
    // successful invalidation.
    let key: string | null;
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
    id: string,
    readyOnSuccess: boolean,
    run: (ctx: SearchPluginContext) => void | SearchMaterializeResult | Promise<void | SearchMaterializeResult>,
  ): Promise<SearchLifecycleOutcome> {
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

  function prepare(id: string): Promise<SearchLifecycleOutcome> {
    return materialize(id, false, (ctx) => ledgerOf(id).plugin.prepare(ctx));
  }

  function validate(id: string): Promise<SearchLifecycleOutcome> {
    return materialize(id, true, (ctx) => ledgerOf(id).plugin.validate(ctx));
  }

  function reconcile(id: string, changes: readonly SearchChange[]): Promise<SearchLifecycleOutcome> {
    return materialize(id, true, (ctx) => ledgerOf(id).plugin.reconcile(ctx, changes));
  }

  function rebuild(id: string): Promise<SearchLifecycleOutcome> {
    return materialize(id, true, (ctx) => ledgerOf(id).plugin.rebuild(ctx));
  }

  function revoke(id: string, target: SearchRevocationTarget): Promise<SearchLifecycleOutcome> {
    return materialize(id, true, (ctx) => {
      const plugin = ledgerOf(id).plugin;
      if (typeof plugin.revoke === 'function') return plugin.revoke(ctx, target);
      return plugin.rebuild(ctx);
    });
  }

  async function search(id: string, request: SearchRequest): Promise<SearchSearchOutcome> {
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
    // An over-wide window is a validation rejection, not an index failure: it
    // is closed BEFORE the plugin runs, without moving the fence or state.
    let window: { readonly offset: number; readonly limit: number };
    try {
      window = searchPageWindow(request);
    } catch (err) {
      if (!(err instanceof SearchWindowValidationError)) throw err;
      return {
        ok: false,
        generation,
        fence,
        state,
        counts: entry.counts,
        result: null,
        lastError: Object.freeze({
          message: err.message,
          at: now(),
          attempt: entry.attempts,
          retryable: false,
        }),
        cancelled: false,
        timedOut: false,
      };
    }
    const { offset, limit } = window;
    const boundedRequest: SearchRequest = { ...request, offset: 0, limit: offset + limit };
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

  function healthOf(id: string): SearchPluginHealth & { readonly plugin: unknown } {
    const entry = ledgerOf(id);
    let pluginHealth: unknown = null;
    try {
      pluginHealth = entry.plugin.health ? entry.plugin.health(contextOf(id)) : null;
    } catch {
      pluginHealth = null;
    }
    return { ...stateOf(id), plugin: pluginHealth };
  }

  return Object.freeze({
    register,
    has: (id: string) => plugins.has(id),
    get: (id: string) => plugins.get(id),
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

export interface HybridPluginBranchRequest {
  readonly pluginId: string;
  readonly query: unknown;
  readonly weight?: number;
  readonly limit?: number;
}

export interface HybridPluginSearchRequest {
  readonly registry: SearchPluginRegistry;
  readonly principal: Principal;
  readonly fts: HybridPluginBranchRequest;
  readonly vector: HybridPluginBranchRequest;
  readonly scope?: string | Readonly<Record<string, unknown>>;
  readonly scopeId?: string;
  readonly k?: number;
  readonly limit?: number;
  readonly offset?: number;
  readonly page?: number;
  readonly pageSize?: number;
  readonly signal?: AbortSignal;
}

export interface HybridPluginSearchOutcome extends HybridSearchResult<Readonly<Record<string, unknown>>> {
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly outcomes: {
    readonly fts: SearchSearchOutcome;
    readonly vector: SearchSearchOutcome;
  };
}

// Run authorized FTS5 and vector searches in parallel through the registry and
// fuse their admitted hits via Reciprocal Rank Fusion (`weight / (k + rank)`),
// with deterministic `(score DESC, key ASC)` tie-breaking.
export async function hybridSearch(request: HybridPluginSearchRequest): Promise<HybridPluginSearchOutcome> {
  const { registry, principal, fts, vector, scope, scopeId, signal } = request;
  const k = request.k ?? HYBRID_SEARCH_DEFAULT_RRF_K;
  const window = searchPageWindow({
    limit: request.limit,
    offset: request.offset,
    page: request.page,
    pageSize: request.pageSize,
  });
  // STABLE FUSION: the branch depth is FIXED, never derived from this page's
  // offset. RRF scores depend on branch rank, so a depth that grew with the
  // offset would re-rank already-returned hits between page requests and make
  // concatenated pages duplicate or skip entries. The fused pool is the union
  // of the two bounded branch lists; a window past it is honestly empty.
  const branchLimit = SEARCH_MAX_RESULTS_CAP;
  const ftsLimit = fts.limit ?? branchLimit;
  const vectorLimit = vector.limit ?? branchLimit;
  const sharedScope = { ...(scope !== undefined ? { scope } : {}), ...(scopeId !== undefined ? { scopeId } : {}) };
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
  const ftsStaleness: SearchStaleness = searchStalenessOf(ftsOutcome.state);
  const vectorStaleness: SearchStaleness = searchStalenessOf(vectorOutcome.state);

  if (cancelled || timedOut || !ftsOutcome.ok || !vectorOutcome.ok || !ftsOutcome.result || !vectorOutcome.result) {
    const worst: SearchStaleness = ftsStaleness === 'stale' || vectorStaleness === 'stale' ? 'stale'
      : ftsStaleness === 'rebuilding' || vectorStaleness === 'rebuilding' ? 'rebuilding' : 'fresh';
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

  const fused = composeHybridSearch<Readonly<Record<string, unknown>>>(
    [
      {
        pluginId: fts.pluginId,
        hits: ftsOutcome.result.hits as readonly Readonly<Record<string, unknown>>[],
        weight: fts.weight,
        generation: ftsOutcome.generation,
        staleness: ftsStaleness,
      },
      {
        pluginId: vector.pluginId,
        hits: vectorOutcome.result.hits as readonly Readonly<Record<string, unknown>>[],
        weight: vector.weight,
        generation: vectorOutcome.generation,
        staleness: vectorStaleness,
      },
    ],
    { k, limit: window.limit, offset: window.offset },
  );

  return Object.freeze({
    ...fused,
    cancelled: false,
    timedOut: false,
    outcomes: Object.freeze({ fts: ftsOutcome, vector: vectorOutcome }),
  });
}
