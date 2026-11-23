// search-reconcile.ts — the S4/A3 reconcile + rebuild engine (epic scope#23).
//
// A1 (search-plugin.ts) declared the plugin contract and A2 (search-staleness.ts)
// built the durable staleness ledger; neither could run bounded reconciliation or
// a full rebuild that provably cannot lose source changes. This module is that
// engine (considerations #9/#10/#11/#12):
//
//   1. BOUNDED-BATCH RECONCILE — reconcileBatches() drains the A2 ledger in
//      bounded batches. Each source key is processed in its OWN coordinated
//      write-queue turn (the `owned` plugin-index-write category, S1/A5), so no
//      transaction grows with the number of pending keys; one call processes at
//      most `batchSize` records and reports how many remain, so a scheduler can
//      loop until drained. The ledger DELETE is conditional (the row is removed
//      only when it still matches what was processed), so a notification that
//      lands while a reconcile awaits can never be clobbered by the batch that
//      was already processing its key.
//   2. SHADOW-GENERATION REBUILD — rebuildShadow() builds a full rebuild into a
//      DISPOSABLE shadow generation (plugin-provided hooks), validates a
//      deterministic source census against the shadow's index census AND the
//      activation fence, atomically activates the shadow, and retires the old
//      generation. The build phase runs OUTSIDE the coordinator — a long rebuild
//      must not hold the one write mutex (the bounded-transaction red line);
//      plugin callbacks never run inside a coordinator turn. Each callback uses
//      its owned-index capability for its own bounded, atomic write batch.
//   3. FENCE — the plugin's invalidation fence is captured before the rebuild
//      scan and re-verified at activation. A bump (a source change committed
//      during the scan) proves the shadow missed changes and ABORTS activation
//      (retryable — the active generation is untouched).
//   4. PARITY — parity(id) compares the deterministic source census, the index
//      census, and the registry generation/fence, and healthOf(id) folds it into
//      plugin health (a census mismatch surfaces as health, never as an
//      authoritative-write error).
//   5. COMMON HARNESS — the engine is generic over a plugin's reconcile/rebuild/
//      search ops plus the optional shadow hooks below, so FTS5 and vector
//      plugins run the SAME lifecycle/rebuild/fence/parity contract
//      (test/search-reconcile.test.mjs).
//
// AUTHORITY: the A1 registry remains the single source of truth for
// generation/fence/state/counts. The engine READS stateOf() for the fence and
// routes the final activation stamp through registry.validate(), so a successful
// shadow activation is disclosed as ready by the same ledger that serves
// searches, and a fence bump during the scan leaves the registry honestly stale.
// The A2 bridge remains the ledger authority; reconcileBatches() is the bounded
// replacement for its one-shot drain (run one or the other, never both on the
// same bridge).

import { createHash } from 'node:crypto';

import {








} from './search-plugin.mjs';






export const SEARCH_RECONCILE_DEFAULT_BATCH_SIZE = 32;

// The canonical entity census: `count` rows plus a sha256 digest over the rows
// in a deterministic order (id ascending, object keys sorted), or null when a
// plugin cannot afford an exact digest (count parity still applies then).





// entity name → census, covering every source interest.


// The plugin-side shadow hooks rebuildShadow() orchestrates. `beginShadow`
// prepares a separate build target and directs the next `rebuild` into it (the
// ACTIVE index is untouched until commit); `indexCensus` reports the CURRENT
// build target's census (the shadow during a build, the active index otherwise);
// `commitShadow` atomically activates the shadow and retains the prior generation
// until the registry stamp succeeds; `rollbackShadow` restores it when that stamp
// fails. `abortShadow` discards an uncommitted shadow.











// A plugin that can participate in shadow-generation rebuilds. The base contract
// (reconcile/rebuild/search) stays untouched — these hooks are the optional
// A3 extension the engine drives.


export function hasShadowCapabilities(plugin              )                               {
  return (
    typeof (plugin                      ).beginShadow === 'function'
    && typeof (plugin                      ).indexCensus === 'function'
    && typeof (plugin                      ).commitShadow === 'function'
    && typeof (plugin                      ).rollbackShadow === 'function'
    && typeof (plugin                      ).abortShadow === 'function'
  );
}

function sourceCensusOf(plugin                    , ctx                     )               {
  return plugin.sourceCensus?.(ctx) ?? computeSourceCensus(ctx.reader);
}
























































                                




















function canonicalize(value         )          {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value                           ;
    const canonical                          = {};
    for (const key of Object.keys(record).sort()) canonical[key] = canonicalize(record[key]);
    return canonical;
  }
  return value;
}

// Deterministic canonical census over an entity's rows (spec 4): the digest is
// computed over rows ordered by id ascending with object keys sorted, so the
// same content always yields the same digest regardless of read order or key
// insertion order. Plugins expose index content through the SAME scheme (their
// indexCensus uses this helper) so source and index digests are comparable.
export function censusOfRows(rows                                    )                     {
  const sorted = [...rows].sort((a, b) => {
    const aId = String(a.id ?? '');
    const bId = String(b.id ?? '');
    if (aId < bId) return -1;
    if (aId > bId) return 1;
    return 0;
  });
  const hash = createHash('sha256');
  let count = 0;
  for (const row of sorted) {
    if (count > 0) hash.update('\n');
    hash.update(JSON.stringify(canonicalize(row)));
    count += 1;
  }
  return { count, digest: hash.digest('hex') };
}

// The source census: every declared source interest read through the SCOPED
// reader (never a raw handle) and canonicalized deterministically. Streams in
// bounded pages for large tables so the full corpus is not materialized in JS
// RAM at once.
export function computeSourceCensus(reader                    )               {
  const PAGE_SIZE = 512;
  const census                                     = {};
  for (const entity of reader.sources()) {
    const totalCount = typeof reader.count === 'function' ? reader.count(entity) : null;
    if (totalCount !== null && totalCount > PAGE_SIZE) {
      const hash = createHash('sha256');
      let count = 0;
      let afterId                    ;
      while (true) {
        const page = reader.rows(entity, { afterId, limit: PAGE_SIZE, order: 'asc' });
        if (page.length === 0) break;
        for (const row of page) {
          if (count > 0) hash.update('\n');
          hash.update(JSON.stringify(canonicalize(row)));
          count += 1;
        }
        if (page.length < PAGE_SIZE) break;
        const lastId = String(page[page.length - 1]?.id ?? '');
        if (lastId.length === 0 || (afterId !== undefined && lastId <= afterId)) break;
        afterId = lastId;
      }
      census[entity] = { count, digest: hash.digest('hex') };
    } else {
      census[entity] = censusOfRows(reader.rows(entity));
    }
  }
  return Object.freeze(census);
}

// Census equality: counts must match; digests must match when BOTH sides
// provide them (a plugin without digests is compared on counts alone).
export function censusEqual(a              , b              )          {
  const entities = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const entity of entities) {
    const x = a[entity];
    const y = b[entity];
    if (x === undefined || y === undefined) return false;
    if (x.count !== y.count) return false;
    if (x.digest !== null && y.digest !== null && x.digest !== y.digest) return false;
  }
  return true;
}

function parseAffected(affected        , context        )                                     {
  try {
    const parsed = JSON.parse(affected)           ;
    if (!Array.isArray(parsed)) throw new Error('not an array');
    const out                            = [];
    for (const entry of parsed) {
      const record = entry                                                         ;
      if (!record || typeof record.pluginId !== 'string' || typeof record.stalenessKey !== 'string') {
        throw new Error('malformed affected entry');
      }
      out.push({ pluginId: record.pluginId, stalenessKey: record.stalenessKey });
    }
    return Object.freeze(out);
  } catch {
    throw new Error(`search reconcile engine: staleness ledger has a corrupt affected column for '${context}'`);
  }
}

function messageOf(err         , fallback        )         {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 0 ? message : fallback;
}

// The ledger row as re-read at process time (never the pending() snapshot — the
// durable row is the authority, so a notification that coalesced onto the same
// key between batching and processing is picked up).









export function createSearchReconcileEngine(options                        )                        {
  const registry = options.registry;
  const staleness = options.staleness;
  const tableName = staleness.tableName;
  const now = options.now ?? (() => new Date().toISOString());
  const batchSize = options.batchSize ?? SEARCH_RECONCILE_DEFAULT_BATCH_SIZE;
  let db                  = options.db ?? null;
  if (!options.writeQueue || typeof options.writeQueue.run !== 'function') {
    throw new TypeError('search reconcile engine requires the application write queue');
  }
  let writeQueue = options.writeQueue;

  function engage(handle                 )       {
    db = handle;
  }

  function bindWriteQueue(queue                                                  )       {
    if (!queue || typeof queue.run !== 'function') {
      throw new TypeError('search reconcile engine requires the application write queue');
    }
    writeQueue = queue;
  }

  // Framework-owned ledger writes go through the one coordinator. Plugin
  // lifecycle callbacks deliberately do not: their ctx.index.write() capability
  // performs admission, fence validation, and bounded transaction execution.
  function coordinated   (fn                      )             {
    return writeQueue.run(fn);
  }

  function requireDb()           {
    if (db === null) {
      throw new Error(
        'search reconcile engine has no engaged ledger handle; pass the bridge\'s handle as db (or engage())',
      );
    }
    return db;
  }

  function ledgerRow(sourceResource        , sourceKey        )                   {
    const connection = requireDb();
    const row = connection.prepare(
      `SELECT kind, priority, affected AS affectedJson, payload, changedAt FROM ${tableName} WHERE sourceResource = ? AND sourceKey = ?`,
    ).get(sourceResource, sourceKey)                                                                                               ;
    if (row === undefined) return null;
    const affectedJson = row.affectedJson;
    return {
      kind: row.kind,
      priority: row.priority,
      affected: parseAffected(affectedJson, `${sourceResource}:${sourceKey}`),
      affectedJson,
      payload: row.payload,
      changedAt: row.changedAt,
    };
  }

  // Reconcile/rebuild the record's affected plugins from the DURABLE row, then
  // delete the row ONLY if it still matches what was processed (conditional
  // delete — a notification that landed while the materialization awaited must
  // not be clobbered; it stays for the next batch). A corrupt payload or failed
  // materialization throws, retaining the record for the next drain.
  async function processRecord(record                       )                                          {
    const row = ledgerRow(record.sourceResource, record.sourceKey);
    if (row === null) return null; // already processed by another drain — nothing to do
    if (row.kind === 'source-change') {
      let change              ;
      try {
        const parsed = JSON.parse(row.payload)                               ;
        const candidate = parsed?.change                            ;
        if (!candidate || typeof candidate.entity !== 'string' || typeof candidate.rowId !== 'string') {
          throw new Error('malformed payload');
        }
        change = candidate;
      } catch {
        throw new Error(`staleness record '${record.sourceResource}:${record.sourceKey}' has a corrupt change payload`);
      }
      for (const affected of row.affected) {
        const outcome = await registry.reconcile(affected.pluginId, [change]);
        if (!outcome.ok) {
          const state = registry.stateOf(affected.pluginId);
          throw new Error(state.lastError ? state.lastError.message : `reconcile failed for '${affected.pluginId}'`);
        }
      }
      // Plugin lifecycle callbacks run outside the coordinator. The capability
      // they may call schedules only host statement execution into it; ledger
      // deletion remains the small framework-owned coordinated write.
      await coordinated(() => deleteIfUnchanged(record, row));
      return 'reconcile';
    }
    if (row.kind !== 'revocation' && row.kind !== 'erasure') {
      throw new Error(`staleness record '${record.sourceResource}:${record.sourceKey}' has an unknown kind '${row.kind}'`);
    }
    // Revocation / erasure: when the record targets a specific entity key or
    // scope and the plugin supports incremental `revoke()`, delete those rows
    // directly instead of triggering a full-corpus rebuild. Plugins without
    // `revoke()` (or broad principal-scope revocations) fall back to `rebuild()`.
    const revocationKind = row.kind === 'erasure' ? 'erasure' : 'revocation';
    const target                                = record.sourceResource !== '$principal' && record.sourceKey !== '*'
      ? (record.sourceKey.startsWith('scope:')
        ? { kind: revocationKind, entity: record.sourceResource, scopeId: record.sourceKey.slice('scope:'.length) }
        : { kind: revocationKind, entity: record.sourceResource, rowId: record.sourceKey })
      : null;
    let anyRebuilt = false;
    for (const affected of row.affected) {
      const plugin = registry.get(affected.pluginId);
      const canIncremental = target !== null && typeof plugin?.revoke === 'function';
      const outcome = canIncremental
        ? await registry.revoke(affected.pluginId, target)
        : await registry.rebuild(affected.pluginId);
      if (!canIncremental) anyRebuilt = true;
      if (!outcome.ok) {
        const state = registry.stateOf(affected.pluginId);
        throw new Error(state.lastError ? state.lastError.message : `${canIncremental ? 'revoke' : 'rebuild'} failed for '${affected.pluginId}'`);
      }
    }
    await coordinated(() => deleteIfUnchanged(record, row));
    return anyRebuilt ? 'rebuild' : 'reconcile';
  }

  function deleteIfUnchanged(record                       , processed           )       {
    const current = ledgerRow(record.sourceResource, record.sourceKey);
    if (current === null) return;
    if (
      current.kind !== processed.kind
      || current.priority !== processed.priority
      || current.affectedJson !== processed.affectedJson
      || current.payload !== processed.payload
      || current.changedAt !== processed.changedAt
    ) {
      // A newer notification replaced (or coalesced onto) this row while the
      // materialization was in flight — retain it for the next bounded batch.
      return;
    }
    requireDb().prepare(
      `DELETE FROM ${tableName} WHERE sourceResource = ? AND sourceKey = ?`,
    ).run(record.sourceResource, record.sourceKey);
  }

  // Bounded-batch reconcile (spec 1): drain AT MOST `batchSize` source keys,
  // each in its own coordinated write turn. The summary's `remaining` lets a
  // scheduler loop until drained; the engine never processes more than the
  // batch bound in one call, so no transaction grows with source size.
  async function reconcileBatches(
    callOptions                                  = {},
  )                                       {
    const limit = Math.max(1, Math.floor(callOptions.batchSize ?? batchSize));
    const pending = staleness.pending();
    if (pending.length === 0) {
      return Object.freeze({
        processed: 0,
        reconciled: 0,
        rebuilt: 0,
        retained: 0,
        remaining: 0,
        failures: Object.freeze([]),
      });
    }
    const slice = pending.slice(0, limit);
    let reconciled = 0;
    let rebuilt = 0;
    let retained = 0;
    const failures                           = [];
    for (const record of slice) {
      try {
        const kind = await processRecord(record);
        if (kind === 'reconcile') reconciled += 1;
        else if (kind === 'rebuild') rebuilt += 1;
      } catch (err) {
        retained += 1;
        const error = messageOf(err, `drain of '${record.sourceResource}:${record.sourceKey}' failed`);
        for (const affected of record.affected) {
          failures.push({
            sourceResource: record.sourceResource,
            sourceKey: record.sourceKey,
            pluginId: affected.pluginId,
            error,
          });
        }
      }
    }
    return Object.freeze({
      processed: reconciled + rebuilt,
      reconciled,
      rebuilt,
      retained,
      remaining: staleness.pending().length,
      failures: Object.freeze(failures),
    });
  }

  function contextOf(id        , generation        , fence        )                      {
    const plugin = registry.get(id);
    if (plugin === undefined) {
      throw new Error(`search plugin '${id}' is not registered with this registry`);
    }
    return {
      id,
      version: plugin.version,
      reader: registry.sourceReader(id),
      index: registry.ownedIndex(id),
      generation,
      fence,
      state: registry.stateOf(id).state,
    };
  }

  function buildParity(id        , source              , index              )                     {
    const state = registry.stateOf(id);
    const metadataMatches = state.generation > 0
      && state.fence <= state.generation
      && state.state === 'ready';
    const entities = new Set([...Object.keys(source), ...Object.keys(index)]);
    const comparisons                           = [];
    let matches = true;
    for (const entity of [...entities].sort()) {
      const s = source[entity];
      const i = index[entity];
      const countsMatch = s !== undefined && i !== undefined && s.count === i.count;
      const digestMatch = s !== undefined && i !== undefined && s.digest !== null && i.digest !== null
        ? s.digest === i.digest
        : null;
      if (!countsMatch || digestMatch === false) matches = false;
      comparisons.push(Object.freeze({
        entity,
        sourceCount: s?.count ?? 0,
        indexCount: i?.count ?? 0,
        countsMatch,
        digestMatch,
      }));
    }
    return Object.freeze({
      pluginId: id,
      generation: state.generation,
      fence: state.fence,
      state: state.state,
      at: now(),
      source: Object.freeze(source),
      index: Object.freeze(index),
      comparisons: Object.freeze(comparisons),
      matches: matches && metadataMatches,
    });
  }

  // Parity (spec 4): deterministic source census vs index census vs the
  // registry's generation/fence, compared at a point in time.
  function parity(id        )                     {
    const plugin = registry.get(id);
    if (plugin === undefined) {
      throw new Error(`search plugin '${id}' is not registered with this registry`);
    }
    if (!hasShadowCapabilities(plugin)) {
      throw new Error(`search plugin '${id}' does not expose indexCensus — parity is unavailable`);
    }
    const state = registry.stateOf(id);
    const ctx = contextOf(id, state.generation, state.fence);
    const source = sourceCensusOf(plugin, ctx);
    const index = plugin.indexCensus(ctx);
    return buildParity(id, source, index);
  }

  function healthOf(id        )                                                                      {
    let report                            = null;
    try {
      report = parity(id);
    } catch {
      report = null; // parity is advisory health — it never throws at consumers
    }
    return { ...registry.healthOf(id), parity: report };
  }

  function canShadow(id        )          {
    const plugin = registry.get(id);
    return plugin !== undefined && hasShadowCapabilities(plugin);
  }

  // Best-effort shadow discard: a throwing abort must never corrupt the active
  // generation or mask the underlying failure.
  async function safeAbort(plugin                    , id        )                {
    try {
      const state = registry.stateOf(id);
      await plugin.abortShadow(contextOf(id, state.generation, state.fence));
    } catch {
      // the active generation survives a throwing abort by construction
    }
  }

  async function rollbackActivation(plugin                    , id        )                {
    // A failed stamp may have changed the registry fence. Re-read it before the
    // plugin restores its durable active-generation pointer; the capability
    // checks this fresh fence inside its own coordinator turn.
    const state = registry.stateOf(id);
    const rollbackCtx = contextOf(id, state.generation, state.fence);
    await plugin.rollbackShadow(rollbackCtx);
    await safeAbort(plugin, id);
  }

  function failedOutcome(
    id        ,
    error        ,
    retryable         ,
    parityReport                           ,
    fenceAtStart               ,
    before                           ,
  )                             {
    // Read the registry again: an invalidation can have moved its fence while a
    // shadow was building, and the outcome must disclose that current state.
    let state                    ;
    try {
      state = registry.stateOf(id);
    } catch {
      // Unknown plugins have no registry state to disclose.
      state = before ?? {
        id,
        version: '',
        generation: 0,
        fence: 0,
        state: 'failed',
        counts: {},
        lastError: null,
      };
    }
    return Object.freeze({
      ok: false,
      pluginId: id,
      activated: false,
      retired: false,
      retryable,
      fenceAtStart: fenceAtStart ?? state.fence,
      generation: state.generation,
      fence: state.fence,
      state: state.state,
      parity: parityReport,
      lastError: error,
    });
  }

  // Shadow-generation rebuild (spec 2 + 3): fence is captured BEFORE the scan,
  // the plugin builds into a disposable shadow, and activation is granted only
  // when the source census is unchanged across the scan, the shadow's index
  // census matches the source census, and the fence has not moved. The build
  // phase deliberately runs OUTSIDE the coordinator (a long rebuild must not
  // hold the one write mutex). Every plugin lifecycle hook runs outside that
  // mutex and writes only through its owned-index capability.
  async function rebuildShadow(id        )                                      {
    const plugin = registry.get(id);
    if (plugin === undefined) {
      return failedOutcome(id, `search plugin '${id}' is not registered with this registry`, false, null, null, null);
    }
    if (!hasShadowCapabilities(plugin)) {
      return failedOutcome(
        id,
        'plugin does not declare the shadow-generation hooks (beginShadow/indexCensus/commitShadow/abortShadow)',
        false,
        null,
        null,
        null,
      );
    }
    const before = registry.stateOf(id);
    const fenceAtStart = before.fence;
    const ctx = contextOf(id, before.generation + 1, before.fence);
    let sourceBefore              ;
    try {
      sourceBefore = sourceCensusOf(plugin, ctx);
    } catch (err) {
      return failedOutcome(id, messageOf(err, 'source census is unreadable'), false, null, fenceAtStart, before);
    }
    try {
      await plugin.beginShadow(ctx);
    } catch (err) {
      return failedOutcome(id, messageOf(err, 'shadow generation could not be prepared'), true, null, fenceAtStart, before);
    }
    try {
      await plugin.rebuild(ctx);
    } catch (err) {
      await safeAbort(plugin, id);
      return failedOutcome(id, messageOf(err, 'shadow rebuild failed'), true, null, fenceAtStart, before);
    }
    let sourceAfter              ;
    try {
      sourceAfter = sourceCensusOf(plugin, ctx);
    } catch (err) {
      await safeAbort(plugin, id);
      return failedOutcome(id, messageOf(err, 'source census re-read failed'), true, null, fenceAtStart, before);
    }
    let index              ;
    try {
      index = plugin.indexCensus(ctx);
    } catch (err) {
      await safeAbort(plugin, id);
      return failedOutcome(id, messageOf(err, 'shadow index census failed'), true, null, fenceAtStart, before);
    }
    const fenceAfter = registry.stateOf(id).fence;
    const sourceUnchanged = censusEqual(sourceBefore, sourceAfter);
    const indexMatches = censusEqual(sourceAfter, index);
    const fenceUnchanged = fenceAfter === fenceAtStart;
    const parityReport = buildParity(id, sourceAfter, index);
    if (!sourceUnchanged || !indexMatches || !fenceUnchanged) {
      const reason = !fenceUnchanged
        ? 'fence moved during the rebuild scan (a source change committed mid-build) — activation aborted'
        : !sourceUnchanged
          ? 'source census changed during the rebuild scan — activation aborted'
          : 'shadow index census does not match the source census — activation aborted';
      await safeAbort(plugin, id);
      return failedOutcome(id, reason, true, parityReport, fenceAtStart, before);
    }
    let promoted = false;
    try {
      // Check immediately before invoking the plugin, then rely on its
      // capability to repeat the check atomically with the durable promotion.
      // No callback itself is enclosed by the host coordinator.
      if (registry.stateOf(id).fence !== fenceAtStart) {
        throw new Error('fence moved before shadow activation (a source change committed mid-build)');
      }
      await plugin.validate(ctx);
      await plugin.commitShadow(ctx);
      promoted = true;
      // The authoritative stamp remains registry-owned. It is invoked outside
      // the coordinator too, so a plugin validator can use ctx.index.write().
      const stamp = await registry.validate(id);
      if (!stamp.ok) {
        throw new Error(stamp.lastError ? stamp.lastError.message : `activation stamp failed for '${id}'`);
      }
    } catch (err) {
      // commitShadow retains the prior durable pointer until the stamp succeeds.
      // Only a completed promotion needs the fresh-fence rollback; failures
      // before it merely discard the disposable shadow.
      if (promoted) await rollbackActivation(plugin, id);
      else await safeAbort(plugin, id);
      return failedOutcome(
        id,
        `shadow activation failed: ${messageOf(err, 'unknown error')}`,
        true,
        parityReport,
        fenceAtStart,
        before,
      );
    }
    const after = registry.stateOf(id);
    return Object.freeze({
      ok: true,
      pluginId: id,
      activated: true,
      retired: true,
      retryable: false,
      fenceAtStart,
      generation: after.generation,
      fence: after.fence,
      state: after.state,
      parity: parityReport,
      lastError: null,
    });
  }

  return Object.freeze({
    get batchSize() {
      return batchSize;
    },
    engage,
    bindWriteQueue,
    canShadow,
    reconcileBatches,
    rebuildShadow,
    parity,
    healthOf,
  });
}
