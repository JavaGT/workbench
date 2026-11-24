// search-staleness.ts — the S4/A2 staleness + invalidation bridge.
//
// The plugin contract (S4/A1, search-plugin.ts) declares source interests and
// staleness keys but nothing turns a committed source change into durable,
// coalescible, priority-ordered invalidation. This module is that bridge
// (considerations #3/#4/#5/#6/#7):
//
//   1. POST-COMMIT NOTIFICATIONS — registered source changes from BOTH history
//      and no-history tiers yield a coalescible staleness record keyed by
//      (sourceResource, sourceKey). A notification MUST carry a committedAt
//      proof; without one the record is refused (a staleness record never
//      references uncommitted state). Drain reconciles from the COMMITTED
//      source only (the scoped reader reads committed rows), so a plugin can
//      never index uncommitted state.
//   2. DURABILITY — the ledger is a SQLite table (_SearchStaleness) created by
//      the bridge when engaged. It is framework-owned shared operational state
//      (declared centrally in operational-ledger-ddl.ts; no individual plugin
//      owns it), not domain history: it survives restart and a pending set is
//      re-processable by a fresh bridge over the same database.
//   3. COALESCING — the primary key is (sourceResource, sourceKey). Every
//      notification for one source key UPSERTs the same row (collapsing to the
//      newest notification with the highest priority seen), and a drain
//      reconciles each source key exactly once.
//   4. REVOCATION/ERASURE PRIORITY — erasure and access-revocation
//      invalidations are a HIGH-priority channel (S5/A5 onRevocation). Drain
//      orders high-priority records before ordinary reconciliation, and a
//      revocation/erasure record triggers a FULL rebuild (re-reading committed
//      scoped source) so protected content disappears before 'ready' is
//      claimed. The fence bump at notification time marks the plugin stale
//      immediately, so a pending revocation can never sit behind a 'fresh'
//      disclosure.
//   5. WORKBENCH-ISSUED INVALIDATIONS OVER TRIGGERS — the bridge installs NO
//      triggers and mutates no source table. Invalidation is delivered through
//      this seam (S3's post-commit plumbing calls notifySourceChange /
//      registers onRevocation). Any FTS-maintenance trigger on a source table
//      is plugin-declared and plugin-owned (declared in the plugin's
//      ownedObjects; the bridge reports them through triggerCensus()).
//
// SEAM: S3 owns the post-commit plumbing that FEEDS this bridge (kernel.ts /
// app.ts post-commit consumers), and this module EXPORTS the consumer that
// bridge installs: `createSearchStalenessConsumer(bridge)` maps every committed
// lifecycle event to a source change (committedAt proof included) and calls
// `bridge.notifySourceChange(...)` — the kernel registers it as the
// 'search-staleness' post-commit consumer. Recording AND advancing the
// consumer's per-scope _ConsumerCursor happen in ONE transaction; a boot sweep
// (`reconcileSearchStaleness`) replays any _Log row committed before a crash in
// the commit→notify window. The S5/A5 revocation side is wired
// through the live-delivery core: app.ts registers `bridge.onRevocation` as a
// core onRevocation listener when live delivery attaches, so a committed
// deletion, a delivery-time reauthorization denial, or an app mutation's
// explicit revoke fences + records a high-priority rebuild directive. A3
// (JavaGT/workbench#107) owns the reconcile engine and its scheduling; this
// module owns the durable ledger, the dispatch priority, and the drain loop it
// exposes.

import { txn, type DbHandle } from './driver.ts';
import { sweepBehindCursor, upsertConsumerCursor } from './consumer-cursor.ts';
import { decodeConsumerLogRowData, type LogRowLike } from './committed-log.ts';
import { getLog } from './log.ts';
import { EventKind, parseEventType, type EventIdentityHandle } from './event-handle.ts';
import { SEARCH_STALENESS_LEDGER_TABLE, type SearchChange, type SearchChangeKind, type SearchPluginRegistry, type SearchRevocationTarget } from './search-plugin.ts';
import type { Principal } from './principal.ts';
import { normalizeRevocationScope, type RevocationResourceScope } from './live-fanout.ts';
import { renderSearchStalenessDdl } from './operational-ledger-ddl.ts';

// The closed vocabulary of a staleness record's cause. A source change is
// ordinary reconciliation input; a revocation or erasure is a HIGH-priority
// rebuild directive (protected content must leave the index before 'ready').
export type SearchStalenessKind = 'source-change' | 'revocation' | 'erasure';

// The two priority channels. Ordinary source changes reconcile at 0; erasure
// and access-revocation invalidations land at 1 and drain first.
export const SEARCH_STALENESS_PRIORITY_ORDINARY = 0;
export const SEARCH_STALENESS_PRIORITY_HIGH = 1;

export type SearchStalenessPriority = 'ordinary' | 'high';

// A post-commit source change offered to the bridge. `entity`/`rowId` are the
// coalescing key; `kind` is the change verb; `committedAt` is REQUIRED — it is
// the proof the notification fires post-commit, so no staleness record can
// reference uncommitted state. `tier` names which tier produced the change
// (informational; both history and no-history tiers flow through the same
// seam). `priority: 'high'` (or `erasure: true`) marks an erasure-class source
// change so it drains ahead of ordinary reconciliation.
export interface SearchSourceChangeInput {
  readonly entity: string;
  readonly rowId: string;
  readonly kind: SearchChangeKind;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly committedAt: string;
  readonly tier?: 'history' | 'live';
  readonly priority?: SearchStalenessPriority;
  readonly erasure?: boolean;
}

export interface SearchStalenessNotice {
  readonly recorded: boolean;
  readonly priority: SearchStalenessPriority;
  readonly affected: number;
}

// One affected plugin inside a staleness record: the plugin to reconcile/
// rebuild plus the staleness key A1's registry assigned at notification time.
export interface SearchStalenessAffected {
  readonly pluginId: string;
  readonly stalenessKey: string;
}

// A pending staleness record as disclosed by pending(). The durable row's
// JSON columns are parsed back into this shape.
export interface SearchStalenessRecord {
  readonly sourceResource: string;
  readonly sourceKey: string;
  readonly kind: SearchStalenessKind;
  readonly priority: number;
  readonly affected: readonly SearchStalenessAffected[];
  readonly tier: 'history' | 'live' | null;
  readonly changedAt: string;
  readonly committedAt: string;
}

export interface SearchDrainSummary {
  readonly processed: number;
  readonly reconciled: number;
  readonly rebuilt: number;
  readonly retained: number;
  readonly failures: readonly {
    readonly sourceResource: string;
    readonly sourceKey: string;
    readonly pluginId: string;
    readonly error: string;
  }[];
}

// One plugin-declared trigger (ownedObject kind 'trigger'), disclosed so the
// trigger census proves any FTS-maintenance trigger is plugin-declared and
// plugin-owned rather than framework-installed.
export interface SearchStalenessTrigger {
  readonly pluginId: string;
  readonly version: string;
  readonly name: string;
  readonly ddl: readonly string[];
}

export interface SearchStalenessBridge {
  readonly tableName: string;
  engage(db: DbHandle): void;
  bindWriteQueue(writeQueue: { run<T>(fn: () => Promise<T> | T): Promise<T> } | null): void;
  pending(): readonly SearchStalenessRecord[];
  notifySourceChange(input: SearchSourceChangeInput): SearchStalenessNotice;
  onRevocation(principal: Principal, resourceScope: RevocationResourceScope): void;
  drain(): Promise<SearchDrainSummary>;
  triggerCensus(): readonly SearchStalenessTrigger[];
  stalenessDdl(): string;
}

export interface SearchStalenessBridgeOptions {
  readonly registry: SearchPluginRegistry;
  readonly now?: () => string;
  readonly tableName?: string;
  readonly writeQueue?: { run<T>(fn: () => Promise<T> | T): Promise<T> } | null;
}

const BARE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The ledger's default table name is the registry's RESERVED name
// (SEARCH_STALENESS_LEDGER_TABLE): the registry refuses a plugin declaration
// whose source interest or owned object collides with it, so the ledger can
// never be read as plugin-owned source data or clobbered by plugin DDL.
const DEFAULT_TABLE_NAME = SEARCH_STALENESS_LEDGER_TABLE;
// A pseudo source resource for principal-scope revocations. Real source
// entities are bare SQL identifiers, so '$principal' can never collide.
const PRINCIPAL_RESOURCE = '$principal';
// The committed-log consumer identity for staleness intake. The live post-commit
// consumer and the boot reconcile sweep share this ONE per-scope _ConsumerCursor,
// so a commit that lands but whose notification is lost in a crash is replayed
// exactly once (recording coalesces by source key; the cursor cannot rewind).
export const SEARCH_STALENESS_CURSOR = 'search.staleness';

function fail(message: string): never {
  throw new TypeError(`search staleness bridge: ${message}`);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function assertCommitted(input: SearchSourceChangeInput): void {
  // The post-commit guard: a change without a committedAt proof is refused.
  // The bridge NEVER records a staleness record for state that may not have
  // committed — the caller (S3's post-commit plumbing) fires post-commit only,
  // and this check makes that contract explicit and enforceable.
  if (typeof input.committedAt !== 'string' || input.committedAt.length === 0) {
    throw new TypeError(
      'search staleness bridge: a source change must carry committedAt (post-commit proof) — ' +
        'a staleness record never references uncommitted state',
    );
  }
}

function normalizeSourceChange(input: SearchSourceChangeInput): Required<Pick<SearchSourceChangeInput, 'entity' | 'rowId' | 'kind' | 'committedAt'>> {
  if (input === null || typeof input !== 'object') {
    fail('notifySourceChange requires a source change object');
  }
  assertCommitted(input);
  const entity = requireText(input.entity, 'entity');
  if (!BARE_SQL_IDENTIFIER.test(entity)) {
    fail(`entity '${entity}' must be a bare SQL identifier`);
  }
  const rowId = requireText(input.rowId, 'rowId');
  if (!['created', 'updated', 'removed'].includes(input.kind)) {
    fail(`kind must be 'created' | 'updated' | 'removed', got '${String(input.kind)}'`);
  }
  if (input.tier !== undefined && input.tier !== 'history' && input.tier !== 'live') {
    fail(`tier must be 'history' | 'live' | undefined, got '${String(input.tier)}'`);
  }
  if (input.priority !== undefined && input.priority !== 'ordinary' && input.priority !== 'high') {
    fail(`priority must be 'ordinary' | 'high' | undefined, got '${String(input.priority)}'`);
  }
  return { entity, rowId, kind: input.kind, committedAt: input.committedAt };
}

function kindOf(input: SearchSourceChangeInput): SearchStalenessKind {
  if (input.erasure === true) return 'erasure';
  return 'source-change';
}

function priorityOf(input: SearchSourceChangeInput): number {
  return input.priority === 'high' || input.erasure === true
    ? SEARCH_STALENESS_PRIORITY_HIGH
    : SEARCH_STALENESS_PRIORITY_ORDINARY;
}

function priorityLabel(priority: number): SearchStalenessPriority {
  return priority >= SEARCH_STALENESS_PRIORITY_HIGH ? 'high' : 'ordinary';
}

// The durable ledger DDL. Framework-owned shared operational state: declared
// centrally in operational-ledger-ddl.ts (the census owns the framework table
// list), created lazily by the bridge when engaged, and carrying no triggers on
// source tables. The canonical name is declared there; a custom name is
// rendered by the same builder so the executed DDL can never drift from the
// declaration.
export function searchStalenessDdl(tableName: string = DEFAULT_TABLE_NAME): string {
  return renderSearchStalenessDdl(tableName);
}

interface StalenessRow {
  sourceResource: string;
  sourceKey: string;
  kind: string;
  priority: number;
  affected: string;
  tier: string | null;
  changedAt: string;
  committedAt: string;
}

// Parse the JSON-encoded affected array of a ledger row, refusing a corrupt
// column (the row is then reported as corrupt instead of silently dropped).
function parseAffected(affected: string, context: string): SearchStalenessAffected[] {
  try {
    const parsed = JSON.parse(affected);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed.map((entry: unknown) => {
      const record = entry as { pluginId?: unknown; stalenessKey?: unknown } | null;
      if (!record || typeof record.pluginId !== 'string' || typeof record.stalenessKey !== 'string') {
        throw new Error('malformed affected entry');
      }
      return { pluginId: record.pluginId, stalenessKey: record.stalenessKey };
    });
  } catch {
    throw new Error(`search staleness ledger has a corrupt affected column for '${context}'`);
  }
}

function parseRecord(row: StalenessRow): SearchStalenessRecord {
  const affected = parseAffected(row.affected, `${row.sourceResource}:${row.sourceKey}`);
  return Object.freeze({
    sourceResource: row.sourceResource,
    sourceKey: row.sourceKey,
    kind: row.kind as SearchStalenessKind,
    priority: row.priority,
    affected,
    tier: row.tier === 'history' || row.tier === 'live' ? row.tier : null,
    changedAt: row.changedAt,
    committedAt: row.committedAt,
  });
}

export function createSearchStalenessBridge(options: SearchStalenessBridgeOptions): SearchStalenessBridge {
  const registry = options.registry;
  const now = options.now ?? (() => new Date().toISOString());
  const tableName = options.tableName ?? DEFAULT_TABLE_NAME;
  let db: DbHandle | null = null;
  let writeQueue = options.writeQueue ?? null;

  function requireDb(): DbHandle {
    if (db === null) {
      throw new Error('search staleness bridge has no engaged database; call engage(db) before use');
    }
    return db;
  }

  // The ledger table is created lazily on first ledger use (CREATE TABLE IF NOT
  // EXISTS via prepare().run()), so engaging an app whose db handle is a test
  // fake (prepare that throws on use) never touches the database at
  // construction — the table only materializes when a notification or drain
  // actually needs it.
  function ensureTable(): void {
    requireDb().prepare(searchStalenessDdl(tableName)).run();
  }

  function upsert(row: {
    sourceResource: string;
    sourceKey: string;
    kind: SearchStalenessKind;
    priority: number;
    affected: readonly SearchStalenessAffected[];
    payload: string;
    tier: 'history' | 'live' | null;
    committedAt: string;
  }): void {
    const connection = requireDb();
    ensureTable();
    const at = now();
    // The coalescing merge keeps the HIGHEST-priority semantics (review #109
    // finding 1): the ledger holds ONE row per (sourceResource, sourceKey), and
    // a newer ordinary notification must never overwrite a pending
    // revocation/erasure's kind/payload — a priority-1 row whose kind is
    // 'source-change' would reconcile instead of rebuild, re-disclosing
    // protected content. When the pending row is HIGHER priority the record
    // keeps its kind/payload/affected/tier/committedAt and the ordinary change
    // is subsumed (a rebuild re-reads committed state, so it covers it). When
    // priorities are EQUAL the newest payload wins. In every case the affected
    // sets are UNIONED so no affected plugin is dropped by the collapse.
    let merged = row;
    const existing = connection.prepare(
      `SELECT priority, kind, affected, payload, tier, committedAt FROM ${tableName}
       WHERE sourceResource = ? AND sourceKey = ?`,
    ).get(row.sourceResource, row.sourceKey) as Pick<StalenessRow, 'priority' | 'kind' | 'affected' | 'tier' | 'committedAt'> & { payload: string } | undefined;
    if (existing) {
      const existingAffected = parseAffected(existing.affected, `${row.sourceResource}:${row.sourceKey}`);
      const keepExisting = existing.priority > row.priority;
      const winning = keepExisting ? existingAffected : row.affected;
      const losing = keepExisting ? row.affected : existingAffected;
      // Union by pluginId; a later entry wins the collision, so the winning
      // (high-priority, or on ties newest) stalenessKey is retained.
      const byPlugin = new Map<string, SearchStalenessAffected>();
      for (const entry of [...losing, ...winning]) byPlugin.set(entry.pluginId, entry);
      merged = keepExisting
        ? {
          ...row,
          kind: existing.kind as SearchStalenessKind,
          priority: existing.priority,
          affected: [...byPlugin.values()],
          payload: existing.payload,
          tier: existing.tier as 'history' | 'live' | null,
          committedAt: existing.committedAt,
        }
        : { ...row, affected: [...byPlugin.values()] };
    }
    connection.prepare(
      `INSERT INTO ${tableName}
         (sourceResource, sourceKey, kind, priority, affected, payload, tier, changedAt, committedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sourceResource, sourceKey) DO UPDATE SET
         kind = excluded.kind,
         priority = excluded.priority,
         affected = excluded.affected,
         payload = excluded.payload,
         tier = excluded.tier,
         changedAt = excluded.changedAt,
         committedAt = excluded.committedAt`,
    ).run(merged.sourceResource, merged.sourceKey, merged.kind, merged.priority,
      JSON.stringify(merged.affected), merged.payload, merged.tier, at, merged.committedAt);
  }

  function readAll(): StalenessRow[] {
    ensureTable();
    return requireDb().prepare(
      `SELECT sourceResource, sourceKey, kind, priority, affected, tier, changedAt, committedAt
       FROM ${tableName}
       ORDER BY priority DESC, changedAt ASC`,
    ).all() as unknown as StalenessRow[];
  }

  function deleteRecord(record: SearchStalenessRecord): void {
    requireDb().prepare(
      `DELETE FROM ${tableName} WHERE sourceResource = ? AND sourceKey = ?`,
    ).run(record.sourceResource, record.sourceKey);
  }

  // Affected plugins for a change: every registered plugin whose A1
  // stalenessKey accepts the change (fence bump + staleness key returned).
  function affectedPluginsForChange(change: SearchChange): SearchStalenessAffected[] {
    const affected: SearchStalenessAffected[] = [];
    for (const id of registry.ids()) {
      const notification = registry.notifyChange(id, change);
      if (notification.invalidated && notification.stalenessKey !== null) {
        affected.push({ pluginId: id, stalenessKey: notification.stalenessKey });
      }
    }
    return affected;
  }

  // Affected plugins for a revocation: every plugin that could have indexed
  // content under the revoked scope. For an entity scope the synthetic removal
  // change both bumps the fence (immediate 'stale' — a pending revocation can
  // never sit behind a 'fresh' disclosure) and yields the affected set. For a
  // principal scope every registered plugin is affected (any of them may have
  // indexed content the principal could see) — over-invalidate, drain rebuilds
  // against the CURRENT scoped source, so protected content leaves the index
  // before ready is claimed. The synthetic principal bump maps through each
  // plugin's OWN stalenessKey (A1 contract); a plugin that refuses the
  // synthetic key is simply not fence-bumped.
  function affectedPluginsForRevocation(resourceScope: RevocationResourceScope): SearchStalenessAffected[] {
    if (resourceScope.category === 'entity') {
      const [entity, rowId] = splitScopeKey(resourceScope.key);
      if (entity !== null && rowId !== null) {
        return affectedPluginsForChange({ entity, rowId, kind: 'removed' });
      }
      return registry.ids().map((pluginId) => ({ pluginId, stalenessKey: resourceScope.key }));
    }
    for (const id of registry.ids()) {
      const plugin = registry.get(id);
      if (!plugin) continue;
      for (const interest of plugin.sourceInterests) {
        registry.notifyChange(id, { entity: interest.entity, rowId: '*', kind: 'removed' });
      }
    }
    return registry.ids().map((pluginId) => ({ pluginId, stalenessKey: resourceScope.key }));
  }

  function splitScopeKey(key: string): [string, string | null] {
    const index = key.indexOf(':');
    if (index === -1) return [key, null];
    return [key.slice(0, index), key.slice(index + 1)];
  }

  // Route a ledger write or plugin materialization through the ONE write
  // coordinator (S1/A5): inside a coordinated turn, a nested call joins the
  // turn (write-queue reentrancy); without a bound queue the work runs
  // directly. Every ledger write the bridge performs — processRecord's
  // reconcile/rebuild AND drain's delete — enters through here, so a ledger
  // mutation can never interleave with an authoritative write or another drain.
  function coordinated<T>(fn: () => Promise<T> | T): Promise<T> {
    return writeQueue ? writeQueue.run(fn) : Promise.resolve().then(fn);
  }

  async function processRecord(record: SearchStalenessRecord): Promise<{ kind: 'reconcile' | 'rebuild' }> {
    if (record.kind === 'source-change') {
      let change: SearchChange;
      try {
        const payload = requireDb().prepare(
          `SELECT payload FROM ${tableName} WHERE sourceResource = ? AND sourceKey = ?`,
        ).get(record.sourceResource, record.sourceKey) as { payload: string } | undefined;
        const parsed = JSON.parse(payload?.payload ?? '{}');
        const candidate = parsed.change as SearchChange | undefined;
        if (!candidate || typeof candidate.entity !== 'string' || typeof candidate.rowId !== 'string') {
          throw new Error('malformed payload');
        }
        change = candidate;
      } catch {
        // A corrupt payload must not silently drop the invalidation: retain the
        // record (the failure surfaces in the drain summary) rather than
        // reconcile with an empty change.
        throw new Error(`staleness record '${record.sourceResource}:${record.sourceKey}' has a corrupt change payload`);
      }
      for (const affected of record.affected) {
        const outcome = await coordinated(() => registry.reconcile(affected.pluginId, [change])) as { ok: boolean };
        if (!outcome.ok) {
          const state = registry.stateOf(affected.pluginId);
          throw new Error(state.lastError ? state.lastError.message : `reconcile failed for '${affected.pluginId}'`);
        }
      }
      return { kind: 'reconcile' };
    }
    // Revocation / erasure: when the record targets a specific entity key or
    // scope and a plugin supports incremental `revoke()`, delete those rows
    // directly without rebuilding the entire corpus. Plugins without `revoke()`
    // (or broad principal-scope revocations) fall back to full `rebuild()`.
    const revocationKind = record.kind === 'erasure' ? 'erasure' : 'revocation';
    const target: SearchRevocationTarget | null = record.sourceResource !== PRINCIPAL_RESOURCE && record.sourceKey !== '*'
      ? (record.sourceKey.startsWith('scope:')
        ? { kind: revocationKind, entity: record.sourceResource, scopeId: record.sourceKey.slice('scope:'.length) }
        : { kind: revocationKind, entity: record.sourceResource, rowId: record.sourceKey })
      : null;
    let anyRebuilt = false;
    for (const affected of record.affected) {
      const plugin = registry.get(affected.pluginId);
      const canIncremental = target !== null && typeof plugin?.revoke === 'function';
      const outcome = canIncremental
        ? await coordinated(() => registry.revoke(affected.pluginId, target)) as { ok: boolean }
        : await coordinated(() => registry.rebuild(affected.pluginId)) as { ok: boolean };
      if (!canIncremental) anyRebuilt = true;
      if (!outcome.ok) {
        const state = registry.stateOf(affected.pluginId);
        throw new Error(state.lastError ? state.lastError.message : `${canIncremental ? 'revoke' : 'rebuild'} failed for '${affected.pluginId}'`);
      }
    }
    return { kind: anyRebuilt ? 'rebuild' : 'reconcile' };
  }

  function engage(handle: DbHandle): void {
    if (handle === null || typeof handle !== 'object' || typeof handle.prepare !== 'function') {
      fail('engage requires a DbHandle');
    }
    db = handle;
  }

  function bindWriteQueue(next: { run<T>(fn: () => Promise<T> | T): Promise<T> } | null): void {
    writeQueue = next ?? null;
  }

  function pending(): readonly SearchStalenessRecord[] {
    return Object.freeze(readAll().map(parseRecord));
  }

  function notifySourceChange(input: SearchSourceChangeInput): SearchStalenessNotice {
    const normalized = normalizeSourceChange(input);
    // Reserved-name guard (review #109 finding 4): a change whose entity is the
    // ledger's own table name can never be a real source change — it would key
    // a record by the ledger itself. The registry refuses plugin declarations
    // using the reserved name; this second guard also covers a bridge built
    // with a custom tableName.
    if (normalized.entity === tableName) {
      fail(`entity '${normalized.entity}' collides with the staleness ledger table name`);
    }
    const change: SearchChange = {
      entity: normalized.entity,
      rowId: normalized.rowId,
      kind: normalized.kind,
      ...(input.data !== undefined ? { data: { ...input.data } } : {}),
    };
    const affected = affectedPluginsForChange(change);
    const priority = priorityOf(input);
    if (affected.length === 0) {
      return { recorded: false, priority: priorityLabel(priority), affected: 0 };
    }
    upsert({
      sourceResource: normalized.entity,
      sourceKey: normalized.rowId,
      kind: kindOf(input),
      priority,
      affected,
      payload: JSON.stringify({ change }),
      tier: input.tier ?? null,
      committedAt: normalized.committedAt,
    });
    return { recorded: true, priority: priorityLabel(priority), affected: affected.length };
  }

  function onRevocation(principal: Principal, resourceScope: RevocationResourceScope): void {
    // Reuse the S5/A5 normalization seam: a malformed descriptor is rejected
    // deterministically before any record is touched (fail closed).
    const scope = normalizeRevocationScope(principal, resourceScope);
    const affected = affectedPluginsForRevocation(scope);
    if (affected.length === 0) return;
    const resource = scope.category === 'entity'
      ? (splitScopeKey(scope.key)[0] ?? scope.key)
      : PRINCIPAL_RESOURCE;
    const key = scope.category === 'entity'
      ? (splitScopeKey(scope.key)[1] ?? scope.key)
      : scope.key;
    upsert({
      sourceResource: resource,
      sourceKey: key,
      kind: 'revocation',
      priority: SEARCH_STALENESS_PRIORITY_HIGH,
      affected,
      payload: JSON.stringify({ scope, principalKey: principal === null ? null : String((principal as { id?: unknown }).id ?? '') }),
      tier: null,
      committedAt: now(),
    });
  }

  async function drain(): Promise<SearchDrainSummary> {
    const failures: { readonly sourceResource: string; readonly sourceKey: string; readonly pluginId: string; readonly error: string }[] = [];
    let reconciled = 0;
    let rebuilt = 0;
    let retained = 0;
    for (const record of pending()) {
      try {
        // Process AND delete inside the SAME coordinated turn (review #109
        // finding 3): the ledger DELETE is a write like the materialization it
        // follows, so it can never interleave with an authoritative write or
        // another drain. A processRecord failure skips the delete, retaining
        // the record for the next drain (the summary's `retained`).
        const outcome = await coordinated(() => processRecord(record).then((result) => {
          deleteRecord(record);
          return result;
        }));
        if (outcome.kind === 'reconcile') reconciled += 1;
        else rebuilt += 1;
      } catch (err) {
        retained += 1;
        const message = err instanceof Error ? err.message : String(err);
        for (const affected of record.affected) {
          failures.push({
            sourceResource: record.sourceResource,
            sourceKey: record.sourceKey,
            pluginId: affected.pluginId,
            error: message,
          });
        }
      }
    }
    return Object.freeze({
      processed: reconciled + rebuilt,
      reconciled,
      rebuilt,
      retained,
      failures: Object.freeze(failures),
    });
  }

  function triggerCensus(): readonly SearchStalenessTrigger[] {
    const triggers: SearchStalenessTrigger[] = [];
    for (const object of registry.census().objects) {
      if (object.kind !== 'trigger') continue;
      triggers.push(Object.freeze({
        pluginId: object.owner,
        version: object.version,
        name: object.name,
        ddl: Object.freeze([...object.ddl]),
      }));
    }
    return Object.freeze(triggers);
  }

  return Object.freeze({
    get tableName() {
      return tableName;
    },
    engage,
    bindWriteQueue,
    pending,
    notifySourceChange,
    onRevocation,
    drain,
    triggerCensus,
    stalenessDdl: () => searchStalenessDdl(tableName),
  });
}

// Map one pipeline-finalized committed event to a source change for the bridge.
// A lifecycle event (created/updated/removed) and a field/native mutation
// (which changes an existing row like an update) map to a SearchChange; the
// event's `committedAt` (present on finalized events) is the post-commit proof
// the bridge requires. Anything without an entity, a row id, or a committedAt
// is skipped — never a fabricated change.
function sourceChangeFromCommittedEvent(event: unknown): SearchSourceChangeInput | null {
  if (event === null || typeof event !== 'object') return null;
  const value = event as { type?: unknown; handle?: unknown; data?: unknown; committedAt?: unknown };
  const attached = value.handle as { brand?: unknown } | undefined;
  let handle: EventIdentityHandle | undefined;
  if (attached?.brand === 'event-handle') {
    handle = value.handle as EventIdentityHandle;
  } else if (typeof value.type === 'string') {
    // No attached handle: derive identity from the exported Event-type grammar
    // authority, not a bare split('.'). A dotted field event (Note.title.set)
    // is a fieldSet handle and maps to an update, just like a native mutation;
    // a type outside the grammar is skipped rather than fabricating a change.
    try {
      handle = parseEventType(value.type);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  const entity = handle.entity;
  const kind = handle.kind;
  const data = value.data;
  const rowId = data !== null && typeof data === 'object' && 'id' in data
    ? (data as { id?: unknown }).id
    : undefined;
  const committedAt = value.committedAt;
  if (typeof entity !== 'string' || entity.length === 0
    || typeof rowId !== 'string' || rowId.length === 0
    || typeof committedAt !== 'string' || committedAt.length === 0) {
    return null;
  }
  let changeKind: SearchChangeKind;
  if (kind === EventKind.created) changeKind = 'created';
  else if (kind === EventKind.removed) changeKind = 'removed';
  else changeKind = 'updated';
  return {
    entity,
    rowId,
    kind: changeKind,
    ...(data !== undefined && data !== null && typeof data === 'object' ? { data: data as Readonly<Record<string, unknown>> } : {}),
    committedAt,
    tier: 'history',
  };
}

// The ONE reconciliation primitive for staleness intake: record the (optional)
// source change AND advance this consumer's per-scope cursor in a SINGLE
// transaction. Both the live post-commit consumer and the boot reconcile sweep
// call it, so a crash leaves either (a) a recorded change with an advanced
// cursor, or (b) neither — never a half-applied intake. A replayed change is
// harmless because notifySourceChange coalesces by (sourceResource, sourceKey).
async function recordSourceChangeAndAdvance(
  db: DbHandle,
  notify: (input: SearchSourceChangeInput) => SearchStalenessNotice,
  change: SearchSourceChangeInput | null,
  cursor: { scope: string; seq: number },
): Promise<void> {
  await txn(db, () => {
    if (change !== null) notify(change);
    // Advance even for an event that maps to no source change: leaving such an
    // event behind the cursor would replay it on every boot forever.
    upsertConsumerCursor(db, { consumer: SEARCH_STALENESS_CURSOR, scope: cursor.scope, lastSeq: cursor.seq });
  });
}

// The S3 post-commit consumer that FEEDS this bridge (review #109 finding 2).
// The kernel installs it as the 'search-staleness' descriptor, so a committed
// entity mutation records into the durable ledger with its committedAt proof
// AND advances the scope's cursor atomically. A throwing notification is
// isolated (post-commit fan-out contract: it can never undo a committed
// dispatch) and leaves that scope's cursor behind for the boot sweep to retry.
// A later same-scope success never skips past an earlier failure (lastSeq only
// moves up). Events with no _Log seq (live tier / direct fixtures) are recorded
// best-effort, uncursored, exactly as before — they have no cursor to anchor to.
export function createSearchStalenessConsumer(bridge: Pick<SearchStalenessBridge, 'notifySourceChange'>) {
  return async (events: readonly unknown[], context: { db?: DbHandle } = {}): Promise<void> => {
    const db = context.db ?? null;
    const blockedScopes = new Set<string>();
    for (const event of events) {
      const change = sourceChangeFromCommittedEvent(event);
      const anchored = event as { scope?: unknown; seq?: unknown } | null;
      const scope = anchored?.scope;
      const seq = anchored?.seq;
      if (!db || typeof seq !== 'number' || typeof scope !== 'string') {
        if (change !== null) {
          try {
            bridge.notifySourceChange(change);
          } catch {
            // post-commit isolation: a notification failure never undoes a commit
          }
        }
        continue;
      }
      if (blockedScopes.has(scope)) continue;
      try {
        await recordSourceChangeAndAdvance(db, bridge.notifySourceChange, change, { scope, seq });
      } catch (err) {
        blockedScopes.add(scope);
        getLog().warn('system', 'search staleness intake failed', { err, scope, seq });
      }
    }
  };
}

// Boot-time recovery for the commit→notify window: replay every _Log row this
// consumer has not yet acknowledged into the durable staleness ledger. A crash
// after COMMIT but before the post-commit consumer runs leaves a gap in
// _ConsumerCursor; sweepBehindCursor walks exactly that gap (proportional to
// the missed rows, not to retained history). Recording + cursor advance share
// the same transaction as the live consumer, so a replay after a crash between
// ledger write and cursor write is idempotent. A tampered log row BLOCKS its
// scope (fail closed) rather than being skipped. `db` is the bridge's engaged
// handle in every wiring (kernel passes app.db for both); callers must not split
// them across connections or the ledger write and cursor checkpoint could land
// on different databases.
export async function reconcileSearchStaleness(
  db: DbHandle,
  bridge: Pick<SearchStalenessBridge, 'notifySourceChange'>,
): Promise<{ recorded: number; blocked: number }> {
  let recorded = 0;
  const { blocked } = await sweepBehindCursor(db, SEARCH_STALENESS_CURSOR, async (row) => {
    let data: Record<string, unknown>;
    try {
      data = decodeConsumerLogRowData(row as unknown as LogRowLike, {});
    } catch (err) {
      getLog().warn('system', 'search staleness recovery blocked on a tampered log row', { err, scope: row.scope, seq: row.seq });
      return 'block';
    }
    const change = sourceChangeFromCommittedEvent({
      type: row.eventType,
      data,
      committedAt: row.committedAt,
    });
    try {
      await recordSourceChangeAndAdvance(db, bridge.notifySourceChange, change, { scope: row.scope, seq: row.seq });
      if (change !== null) recorded += 1;
      return 'done';
    } catch (err) {
      getLog().warn('system', 'search staleness recovery failed', { err, scope: row.scope, seq: row.seq });
      return 'block';
    }
  });
  return { recorded, blocked };
}
