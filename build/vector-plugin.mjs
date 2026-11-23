// vector-plugin.ts — model-space-aware, persistent Float32Array vector search plugin.
//
// Embeddings are supplied by the application's worker in source rows. This
// plugin stores compact Float32Array vectors + precomputed norms + optional
// scope_id in census-owned SQLite tables (`vec_...`) mirrored by a flat
// Float32Array slab cache keyed by `(scope_id, source_key)` — never storing
// frozen JS number[] arrays or full source-row copies in JS heap.

import { createHash } from 'node:crypto';
import { Float32VectorSlab, vectorNorm } from './vector.mjs';
import {
  SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,







} from './search-plugin.mjs';
import {                                                                           } from './search-reconcile.mjs';
import { admitSearchHits } from './search-auth.mjs';
import { searchStalenessOf } from './search-response.mjs';










export class VectorPluginValidationError extends Error {
           code                            ;

  constructor(code                            , message        ) {
    super(message);
    this.name = 'VectorPluginValidationError';
    this.code = code;
  }
}











































const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_WRITE_STATEMENTS = 128;
const SOURCE_PAGE_SIZE = 512;
const HYDRATE_PAGE_SIZE = 1024;
const DELETE_CHUNK_SIZE = 500;
const CENSUS_BOUNDARY_SAMPLE = 32;

function assertModelSpace(modelSpace                  )       {
  if (typeof modelSpace.model !== 'string' || modelSpace.model.length === 0) {
    throw new TypeError('vector model-space requires a non-empty model identity');
  }
  if (!Number.isSafeInteger(modelSpace.dimensions) || modelSpace.dimensions < 1) {
    throw new TypeError('vector model-space dimensions must be a positive safe integer');
  }
}

function generationIdentity(modelSpace                  , sequence        )         {
  return `${modelSpace.model}:${modelSpace.dimensions}:${sequence}`;
}

function validateScope(scope         )                                                         {
  if (scope === undefined) return undefined;
  if (typeof scope === 'string') return scope;
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new TypeError('vector search scope must be a source-row predicate object');
  }
  return scope                                     ;
}

function matchesScope(row                                   , scope                                   )          {
  for (const key of Object.keys(scope)) {
    if (row[key] !== scope[key]) return false;
  }
  return true;
}

function validateVectorToFloat32(
  value         ,
  model         ,
  modelSpace                  ,
  sourceId        ,
)                                                           {
  if (model !== modelSpace.model) {
    throw new VectorPluginValidationError(
      'model-space-mismatch',
      `vector source '${sourceId}' has model '${String(model)}'; generation requires '${modelSpace.model}'`,
    );
  }
  const isF32 = value instanceof Float32Array;
  if (!Array.isArray(value) && !isF32) {
    throw new VectorPluginValidationError('invalid-vector', `vector source '${sourceId}' must contain a number array`);
  }
  if (value.length !== modelSpace.dimensions) {
    throw new VectorPluginValidationError(
      'dimension-mismatch',
      `vector source '${sourceId}' has ${value.length} dimensions; generation requires ${modelSpace.dimensions}`,
    );
  }
  const f32 = new Float32Array(modelSpace.dimensions);
  let sumSq = 0;
  for (let i = 0; i < modelSpace.dimensions; i += 1) {
    const item = value[i];
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new VectorPluginValidationError('non-finite-value', `vector source '${sourceId}' contains a non-finite value`);
    }
    const f = Math.fround(item);
    f32[i] = f;
    sumSq += f * f;
  }
  return { vector: f32, norm: Math.sqrt(sumSq) };
}

function float32ToBlob(vector              )             {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

function blobToFloat32(blob         , dimensions        )               {
  if (!(blob instanceof Uint8Array)) {
    throw new VectorPluginValidationError('invalid-vector', 'persisted vector BLOB must be a Uint8Array');
  }
  const expectedBytes = dimensions * 4;
  if (blob.byteLength !== expectedBytes) {
    throw new VectorPluginValidationError('dimension-mismatch', `persisted vector BLOB has ${blob.byteLength} bytes; expected ${expectedBytes}`);
  }
  const copy = new ArrayBuffer(expectedBytes);
  new Uint8Array(copy).set(blob);
  return new Float32Array(copy);
}

function scopeValueOf(row                                   , scopeField                    )         {
  if (scopeField === undefined) return '';
  const value = row[scopeField];
  return value === null || value === undefined ? '' : String(value);
}

function boundaryKeyCensus(count        , boundaryIds                   )                     {
  if (count === 0) return { count: 0, digest: createHash('sha256').update('0:').digest('hex') };
  const deduped = [...new Set(boundaryIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = createHash('sha256').update(`${count}:${deduped.join('\n')}`).digest('hex');
  return { count, digest };
}

function hasBoundIndex(ctx                                 )          {
  return Boolean(ctx && ctx.index && ctx.index.bound !== false);
}

// Creates a persistent SQLite + compact Float32Array slab vector search plugin.
// Persists binary Float32 BLOBs + precomputed L2 norms + scope_id in owned
// `vec_...` tables whenever the owned-index capability is bound, and serves
// fast scoped cosine scans directly from the flat Float32Array slab without
// storing frozen JS number[] arrays or source-row copies in JS heap.
export function createVectorPlugin(options                     )               {
  if (typeof options.source.owns !== 'function') {
    throw new TypeError('vector plugin source requires an ownership predicate');
  }
  const scopeField = options.source.scopeField;
  if (scopeField !== undefined && !IDENTIFIER.test(scopeField)) {
    throw new TypeError('vector plugin scopeField must be a SQLite identifier');
  }
  if (options.admission !== undefined && (
    options.admission === null || typeof options.admission !== 'object' ||
    typeof options.admission.adapter?.admit !== 'function'
  )) {
    throw new TypeError('vector plugin requires a search admission configuration');
  }

  let modelSpace = Object.freeze({ ...options.modelSpace });
  assertModelSpace(modelSpace);
  let sequence = 0;

  const base = `vec_${options.id.replaceAll(/[^A-Za-z0-9_]/g, '_')}`;
  const stateTable = `${base}_state`;
  const tables = [`${base}_g0`, `${base}_g1`]         ;

  let activeGen        = 0;
  let buildingGen               = null;
  let promotedGen               = null;
  let activeSlab = new Float32VectorSlab(modelSpace.dimensions);
  let shadowSlab                           = null;
  let activeHydrated = false;
  let activeWriteGeneration = 0;

  function targetSlab()                    {
    return shadowSlab ?? activeSlab;
  }

  function isSuperseded(ctx                     )          {
    return ctx.generation < activeWriteGeneration;
  }

  function claimGeneration(ctx                     )          {
    if (ctx.generation < activeWriteGeneration) return false;
    activeWriteGeneration = ctx.generation;
    return true;
  }

  function readPersistedState(ctx                     )                                                              {
    if (!hasBoundIndex(ctx)) return null;
    const row = ctx.index.query({
      sql: `SELECT active, model, dimensions FROM ${stateTable} WHERE slot = 'active'`,
    })[0];
    if (!row) return null;
    return {
      active: row.active === 1 ? 1 : 0,
      model: String(row.model ?? ''),
      dimensions: Number(row.dimensions ?? 0),
    };
  }

  function currentActiveGeneration(ctx                                 )        {
    if (ctx && hasBoundIndex(ctx)) {
      const persisted = readPersistedState(ctx);
      if (persisted !== null) {
        activeGen = persisted.active;
        return persisted.active;
      }
    }
    return activeGen;
  }

  function targetTable(ctx                     )         {
    return tables[buildingGen ?? currentActiveGeneration(ctx)];
  }

  // Hydrate the compact Float32Array slab from persisted SQLite BLOBs (e.g.
  // after restart/reopen) without reading source rows or creating JS number[].
  function ensureActiveHydrated(ctx                                 )       {
    if (activeHydrated || !ctx || !hasBoundIndex(ctx)) return;
    const persisted = readPersistedState(ctx);
    if (persisted === null) {
      activeHydrated = true;
      return;
    }
    activeGen = persisted.active;
    if (persisted.model !== modelSpace.model || persisted.dimensions !== modelSpace.dimensions) {
      activeSlab = new Float32VectorSlab(modelSpace.dimensions);
      activeHydrated = true;
      return;
    }
    const table = tables[activeGen];
    const countRow = ctx.index.query({ sql: `SELECT COUNT(*) AS count FROM ${table}` })[0];
    const total = Number(countRow?.count ?? 0);
    const nextSlab = new Float32VectorSlab(modelSpace.dimensions, Math.max(64, total));
    let afterKey                    ;
    while (true) {
      const rows = afterKey === undefined
        ? ctx.index.query({
          sql: `SELECT source_key, scope_id, norm, embedding FROM ${table} ORDER BY source_key ASC LIMIT ${HYDRATE_PAGE_SIZE}`,
        })
        : ctx.index.query({
          sql: `SELECT source_key, scope_id, norm, embedding FROM ${table} WHERE source_key > ? ORDER BY source_key ASC LIMIT ${HYDRATE_PAGE_SIZE}`,
          params: [afterKey],
        });
      if (rows.length === 0) break;
      for (const row of rows) {
        const key = String(row.source_key);
        const scopeId = String(row.scope_id ?? '');
        const vec = blobToFloat32(row.embedding, modelSpace.dimensions);
        const norm = typeof row.norm === 'number' && Number.isFinite(row.norm) ? row.norm : vectorNorm(vec);
        nextSlab.set(key, vec, norm, scopeId);
      }
      if (rows.length < HYDRATE_PAGE_SIZE) break;
      afterKey = String(rows[rows.length - 1].source_key);
    }
    activeSlab = nextSlab;
    activeHydrated = true;
  }

  async function clearTable(ctx                     , table        , allowSuperseded = false)                {
    if (!hasBoundIndex(ctx) || (!allowSuperseded && isSuperseded(ctx))) return;
    if (typeof ctx.index.clear === 'function') {
      await ctx.index.clear({ expectedFence: ctx.fence, table });
      return;
    }
    while (allowSuperseded || !isSuperseded(ctx)) {
      const result = await ctx.index.write({
        expectedFence: ctx.fence,
        statements: [{ sql: `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT ${DELETE_CHUNK_SIZE})` }],
      });
      if (result.changes === 0) break;
    }
  }

  function parseAndValidateRow(row                                   )




    {
    const id = row.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new VectorPluginValidationError('unauthorized-source-ownership', 'vector source row requires a non-empty id');
    }
    let owned         ;
    try {
      owned = options.source.owns(row) === true;
    } catch {
      throw new VectorPluginValidationError('unauthorized-source-ownership', `vector source '${id}' ownership could not be verified`);
    }
    if (!owned) {
      throw new VectorPluginValidationError('unauthorized-source-ownership', `vector source '${id}' is not owned by this plugin`);
    }
    let sourceVector = row[options.source.vector];
    if (typeof sourceVector === 'string') {
      try {
        sourceVector = JSON.parse(sourceVector);
      } catch {
        throw new VectorPluginValidationError('invalid-vector', `vector source '${id}' contains invalid JSON`);
      }
    }
    const { vector, norm } = validateVectorToFloat32(sourceVector, row[options.source.model], modelSpace, id);
    return { id, scopeId: scopeValueOf(row, scopeField), vector, norm };
  }

  async function flushUpserts(
    ctx                     ,
    table        ,
    entries                                                                                                                    ,
  )                {
    if (!hasBoundIndex(ctx) || entries.length === 0) return;
    const sql = `INSERT OR REPLACE INTO ${table} (source_key, scope_id, norm, embedding) VALUES (?, ?, ?, ?)`;
    for (let offset = 0; offset < entries.length; offset += MAX_WRITE_STATEMENTS) {
      if (isSuperseded(ctx)) return;
      const statements = entries.slice(offset, offset + MAX_WRITE_STATEMENTS).map((entry) => ({
        sql,
        params: [entry.id, entry.scopeId, entry.norm, float32ToBlob(entry.vector)],
      }));
      await ctx.index.write({ expectedFence: ctx.fence, statements });
    }
  }

  async function rebuild(ctx                     )                                   {
    const next = targetSlab();
    if (!claimGeneration(ctx)) return { counts: { vectors: next.size } };
    const table = targetTable(ctx);
    next.clear();
    await clearTable(ctx, table);
    try {
      if (hasBoundIndex(ctx) && buildingGen === null && !isSuperseded(ctx)) {
        await ctx.index.write({
          expectedFence: ctx.fence,
          statements: [{
            sql: `INSERT INTO ${stateTable} (slot, active, previous, model, dimensions) VALUES ('active', ?, ?, ?, ?) ON CONFLICT(slot) DO UPDATE SET model = excluded.model, dimensions = excluded.dimensions`,
            params: [activeGen, activeGen, modelSpace.model, modelSpace.dimensions],
          }],
        });
      }
      let afterId                    ;
      while (!isSuperseded(ctx)) {
        const page = ctx.reader.rows(options.source.entity, {
          afterId,
          limit: SOURCE_PAGE_SIZE,
          order: 'asc',
        });
        if (page.length === 0) break;
        const parsedPage                                                                                                            = [];
        for (const row of page) {
          const parsed = parseAndValidateRow(row);
          next.set(parsed.id, parsed.vector, parsed.norm, parsed.scopeId);
          parsedPage.push(parsed);
        }
        await flushUpserts(ctx, table, parsedPage);
        if (page.length < SOURCE_PAGE_SIZE) break;
        const lastId = String(page[page.length - 1]?.id ?? '');
        if (lastId.length === 0 || (afterId !== undefined && lastId <= afterId)) break;
        afterId = lastId;
      }
      if (shadowSlab === null && !isSuperseded(ctx)) activeHydrated = true;
    } catch (err) {
      // Do not leave a partially rebuilt direct index or shadow generation.
      if (!isSuperseded(ctx)) {
        next.clear();
        await clearTable(ctx, table);
      }
      throw err;
    }
    return { counts: { vectors: next.size } };
  }

  async function reconcile(ctx                     , changes                         )                                   {
    if (shadowSlab === null) ensureActiveHydrated(ctx);
    const next = targetSlab();
    if (!claimGeneration(ctx)) return { counts: { vectors: next.size } };
    const table = targetTable(ctx);
    const statements                                                                   = [];
    const flushStatements = async ()                => {
      if (!hasBoundIndex(ctx) || statements.length === 0) {
        statements.length = 0;
        return;
      }
      for (let offset = 0; offset < statements.length; offset += MAX_WRITE_STATEMENTS) {
        if (isSuperseded(ctx)) break;
        await ctx.index.write({
          expectedFence: ctx.fence,
          statements: statements.slice(offset, offset + MAX_WRITE_STATEMENTS),
        });
      }
      statements.length = 0;
    };

    for (const change of changes) {
      if (change.entity !== options.source.entity) continue;
      if (change.kind === 'removed') {
        next.delete(change.rowId);
        statements.push({ sql: `DELETE FROM ${table} WHERE source_key = ?`, params: [change.rowId] });
        continue;
      }
      // A missing row is outside the scoped reader (or was concurrently removed),
      // so its prior indexed value must not remain searchable.
      const row = ctx.reader.row(options.source.entity, change.rowId);
      if (row === undefined) {
        next.delete(change.rowId);
        statements.push({ sql: `DELETE FROM ${table} WHERE source_key = ?`, params: [change.rowId] });
      } else {
        try {
          const parsed = parseAndValidateRow(row);
          next.set(parsed.id, parsed.vector, parsed.norm, parsed.scopeId);
          statements.push({
            sql: `INSERT OR REPLACE INTO ${table} (source_key, scope_id, norm, embedding) VALUES (?, ?, ?, ?)`,
            params: [parsed.id, parsed.scopeId, parsed.norm, float32ToBlob(parsed.vector)],
          });
        } catch (err) {
          if (err instanceof VectorPluginValidationError && err.code === 'unauthorized-source-ownership') {
            next.delete(change.rowId);
            statements.push({ sql: `DELETE FROM ${table} WHERE source_key = ?`, params: [change.rowId] });
            await flushStatements();
          }
          throw err;
        }
      }
    }
    await flushStatements();
    return { counts: { vectors: next.size } };
  }

  async function revoke(ctx                     , target                        )                                   {
    if (shadowSlab === null) ensureActiveHydrated(ctx);
    const next = targetSlab();
    if (target.entity !== options.source.entity || !claimGeneration(ctx)) {
      return { counts: { vectors: next.size } };
    }
    const table = targetTable(ctx);
    if (target.scopeId !== undefined) {
      next.deleteScope(target.scopeId);
      if (hasBoundIndex(ctx)) {
        while (!isSuperseded(ctx)) {
          const result = await ctx.index.write({
            expectedFence: ctx.fence,
            statements: [{
              sql: `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE scope_id = ? LIMIT ${DELETE_CHUNK_SIZE})`,
              params: [target.scopeId],
            }],
          });
          if (result.changes === 0) break;
        }
      }
    } else if (target.rowId !== undefined) {
      next.delete(target.rowId);
      if (hasBoundIndex(ctx)) {
        await ctx.index.write({
          expectedFence: ctx.fence,
          statements: [{ sql: `DELETE FROM ${table} WHERE source_key = ?`, params: [target.rowId] }],
        });
      }
    }
    return { counts: { vectors: next.size } };
  }

  function resolveScopeFilter(
    ctx                     ,
    request               ,
    query                   ,
  )                                                                            {
    const rawScopeId = request.scopeId ?? query?.scopeId;
    if (rawScopeId !== undefined) {
      if (typeof rawScopeId !== 'string' || rawScopeId.length === 0) {
        throw new TypeError('vector search scopeId must be a non-empty string');
      }
      return { scopeId: rawScopeId };
    }
    const scope = validateScope(request.scope ?? query?.scope);
    if (scope === undefined) return {};
    if (typeof scope === 'string') return { scopeId: scope };
    const entries = Object.entries(scope);
    if (entries.length === 0) return {};
    if (scopeField !== undefined && entries.length === 1) {
      const [key, value] = entries[0];
      if (key === scopeField || key === 'scope_id') {
        return { scopeId: value === null || value === undefined ? '' : String(value) };
      }
    }
    // Backwards-compatible fallback when a caller filters on arbitrary source
    // columns without declaring `scopeField`: resolve matching ids from the
    // live scoped reader without retaining source-row copies in the index heap.
    const allowed = new Set        ();
    let afterId                    ;
    while (true) {
      const page = ctx.reader.rows(options.source.entity, {
        afterId,
        limit: SOURCE_PAGE_SIZE,
        order: 'asc',
      });
      if (page.length === 0) break;
      for (const row of page) {
        if (typeof row.id === 'string' && matchesScope(row, scope)) allowed.add(row.id);
      }
      if (page.length < SOURCE_PAGE_SIZE) break;
      const lastId = String(page[page.length - 1]?.id ?? '');
      if (lastId.length === 0 || (afterId !== undefined && lastId <= afterId)) break;
      afterId = lastId;
    }
    return { allowedKeys: allowed };
  }

  async function search(ctx                     , request               )                                    {
    if (request.signal?.aborted) return { hits: [] };
    if (request.principal === undefined) throw new VectorPluginValidationError('unauthorized-source-ownership', 'vector search requires a principal for result admission');
    const query = request.query                     ;
    const { vector: queryVec, norm: queryNorm } = validateVectorToFloat32(query?.vector, query?.model, modelSpace, 'query');
    ensureActiveHydrated(ctx);
    const scopeFilter = resolveScopeFilter(ctx, request, query);
    const poolSize = scopeFilter.scopeId !== undefined
      ? activeSlab.slotsForScope(scopeFilter.scopeId).length
      : scopeFilter.allowedKeys !== undefined
        ? scopeFilter.allowedKeys.size
        : activeSlab.size;
    if (poolSize === 0) return { hits: [] };
    const limit = Math.max(1, request.limit ?? poolSize);
    const matches = await activeSlab.topKInterruptibly(queryVec, queryNorm, limit, {
      scopeId: scopeFilter.scopeId,
      allowedKeys: scopeFilter.allowedKeys,
      signal: request.signal,
    });
    if (request.signal?.aborted) return { hits: [] };
    const hits                                      = [];
    const candidates = matches.map((match) => {
      const row = ctx.reader.row(options.source.entity, match.id) ?? null;
      return {
        // Search returns identity + similarity score only; callers hydrate
        // source rows through their current read path.
        hit: Object.freeze({ id: match.id, score: match.score }),
        key: match.id,
        rank: match.score,
        row,
      };
    });
    const staleness = ctx.state !== undefined ? searchStalenessOf(ctx.state) : 'stale';
    if (options.admission) {
      const admitted = await admitSearchHits(options.admission.adapter, {
        pluginId: options.id,
        generation: ctx.generation,
        staleness,
        principal: request.principal,
        candidates,
      });
      for (const result of admitted.hits) hits.push(result.hit);
    } else {
      // The source reader is the framework's default grant-filtered reader.
      for (const candidate of candidates) if (candidate.row !== null) hits.push(candidate.hit);
    }
    return { hits };
  }

  const plugin               = {
    contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
    id: options.id,
    version: options.version,
    ownedObjects: Object.freeze([
      {
        kind: 'table'         ,
        name: stateTable,
        disposition: { kind: 'retained'         , reason: 'Vector generation state is rebuilt independently of project rows' },
        ddl: [`CREATE TABLE IF NOT EXISTS ${stateTable} (slot TEXT PRIMARY KEY CHECK (slot = 'active'), active INTEGER NOT NULL CHECK (active IN (0, 1)), previous INTEGER NOT NULL CHECK (previous IN (0, 1)), model TEXT NOT NULL, dimensions INTEGER NOT NULL);`],
      },
      ...tables.map((name) => ({
        kind: 'table'         ,
        name,
        disposition: { kind: 'retained'         , reason: 'Vector index is derived and rebuilt from the source census' },
        ddl: [`CREATE TABLE IF NOT EXISTS ${name} (source_key TEXT PRIMARY KEY, scope_id TEXT NOT NULL DEFAULT '', norm REAL NOT NULL, embedding BLOB NOT NULL);`],
      })),
      ...tables.map((name) => ({
        kind: 'index'         ,
        name: `${name}_scope_idx`,
        disposition: { kind: 'schema-only'          },
        ddl: [`CREATE INDEX IF NOT EXISTS ${name}_scope_idx ON ${name} (scope_id);`],
      })),
    ]),
    sourceInterests: Object.freeze([{ entity: options.source.entity }]),
    get generationIdentity() {
      return generationIdentity(modelSpace, sequence);
    },
    get modelSpace() {
      return modelSpace;
    },
    validateSourceRow(row) {
      parseAndValidateRow(row);
    },
    setModelSpace(nextModelSpace) {
      assertModelSpace(nextModelSpace);
      if (nextModelSpace.model === modelSpace.model && nextModelSpace.dimensions === modelSpace.dimensions) return;
      modelSpace = Object.freeze({ ...nextModelSpace });
      sequence += 1;
      activeSlab = new Float32VectorSlab(modelSpace.dimensions);
      shadowSlab = null;
      buildingGen = null;
      activeHydrated = true;
    },
    stalenessKey(change) {
      return change.entity === options.source.entity ? `${change.entity}:${change.rowId}` : null;
    },
    async prepare(ctx) {
      if (!hasBoundIndex(ctx)) return;
      await ctx.index.write({
        expectedFence: ctx.fence,
        statements: [{
          sql: `INSERT OR IGNORE INTO ${stateTable} (slot, active, previous, model, dimensions) VALUES ('active', 0, 0, ?, ?)`,
          params: [modelSpace.model, modelSpace.dimensions],
        }],
      });
      ensureActiveHydrated(ctx);
    },
    validate(ctx) {
      if (shadowSlab === null) ensureActiveHydrated(ctx);
      targetSlab().validateFinite();
    },
    reconcile,
    revoke,
    rebuild,
    search,
    async beginShadow(ctx) {
      claimGeneration(ctx);
      buildingGen = currentActiveGeneration(ctx) === 0 ? 1 : 0;
      shadowSlab = new Float32VectorSlab(modelSpace.dimensions);
      await clearTable(ctx, tables[buildingGen]);
    },
    indexCensus(ctx)               {
      if (shadowSlab === null) ensureActiveHydrated(ctx);
      const slab = targetSlab();
      return Object.freeze({
        [options.source.entity]: boundaryKeyCensus(slab.size, slab.boundaryIds(CENSUS_BOUNDARY_SAMPLE)),
      });
    },
    sourceCensus(ctx)               {
      const count = typeof ctx.reader.count === 'function'
        ? ctx.reader.count(options.source.entity)
        : ctx.reader.rows(options.source.entity).length;
      if (count === 0) return Object.freeze({ [options.source.entity]: boundaryKeyCensus(0, []) });
      if (count <= CENSUS_BOUNDARY_SAMPLE * 2) {
        const rows = ctx.reader.rows(options.source.entity, { limit: CENSUS_BOUNDARY_SAMPLE * 2, order: 'asc' });
        return Object.freeze({
          [options.source.entity]: boundaryKeyCensus(count, rows.map((row) => String(row.id))),
        });
      }
      const head = ctx.reader.rows(options.source.entity, { limit: CENSUS_BOUNDARY_SAMPLE, order: 'asc' });
      const tail = ctx.reader.rows(options.source.entity, { limit: CENSUS_BOUNDARY_SAMPLE, order: 'desc' });
      return Object.freeze({
        [options.source.entity]: boundaryKeyCensus(count, [
          ...head.map((row) => String(row.id)),
          ...tail.map((row) => String(row.id)),
        ]),
      });
    },
    async commitShadow(ctx) {
      if (shadowSlab === null || buildingGen === null) throw new Error('vector plugin has no shadow generation to commit');
      if (isSuperseded(ctx)) throw new Error('vector shadow generation superseded by a newer materialization');
      const nextGen = buildingGen;
      if (hasBoundIndex(ctx)) {
        await ctx.index.write({
          expectedFence: ctx.fence,
          statements: [{
            sql: `UPDATE ${stateTable} SET previous = active, active = ?, model = ?, dimensions = ? WHERE slot = 'active'`,
            params: [nextGen, modelSpace.model, modelSpace.dimensions],
          }],
        });
      }
      activeGen = nextGen;
      activeSlab = shadowSlab;
      activeHydrated = true;
      promotedGen = nextGen;
      shadowSlab = null;
      buildingGen = null;
    },
    async rollbackShadow(ctx) {
      if (promotedGen === null) return;
      if (hasBoundIndex(ctx)) {
        await ctx.index.write({
          expectedFence: ctx.fence,
          statements: [{ sql: `UPDATE ${stateTable} SET active = previous WHERE slot = 'active'` }],
        });
        activeHydrated = false;
        ensureActiveHydrated(ctx);
      }
      promotedGen = null;
    },
    async abortShadow(ctx) {
      if (shadowSlab === null && buildingGen === null) return;
      const discarded = buildingGen;
      shadowSlab = null;
      buildingGen = null;
      if (discarded !== null) await clearTable(ctx, tables[discarded], true);
    },
    health(ctx) {
      if (shadowSlab === null) ensureActiveHydrated(ctx);
      return Object.freeze({
        generationIdentity: generationIdentity(modelSpace, sequence),
        modelSpace,
        vectors: activeSlab.size,
      });
    },
  };
  return Object.freeze(plugin);
}
