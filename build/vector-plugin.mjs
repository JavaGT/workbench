// vector-plugin.ts — model-space-aware, persistent Float32Array vector search.
// A source row may supply one vector, or (with source.parent) one derived segment
// whose CURRENT parent row is re-authorized, revision-fenced and project-fenced
// before disclosure. Bound indexes page BLOBs in bounded windows; unbound
// harnesses keep the in-memory slab. Derived search refills its window after
// denials/fences so pagination is over authorized results.
// An ordinary source keeps the four-column generation schema it has always
// written, so an existing index upgrades with no ALTER and no rebuild; a derived
// source persists the fence in its own tables. While a declared model space is
// not yet materialized, the retained active generation keeps serving ITS space.
import { createHash } from 'node:crypto';
import { Float32VectorSlab, cosineSimilarityFloat32, vectorNorm } from './vector.mjs';
import {
  SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,


} from './search-plugin.mjs';
import {                                                                           } from './search-reconcile.mjs';
import { admitSearchHits } from './search-auth.mjs';
import { SEARCH_MAX_RESULTS_CAP, searchStalenessOf } from './search-response.mjs';


// Closed validation vocabulary; every rejection carries one of these codes.


export class VectorPluginValidationError extends Error {
           code                            ;
  constructor(code                            , message        ) {
    super(message); this.name = 'VectorPluginValidationError'; this.code = code;
  }
}

// Derived segment source: current-parent authorization + revision/project fence.







































const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_WRITE_STATEMENTS = 128;
const SOURCE_PAGE_SIZE = 512;
const DELETE_CHUNK_SIZE = 500;
const CENSUS_BOUNDARY_SAMPLE = 32;
const PERSISTED_SCAN_PAGE_SIZE = 512;
const PERSISTED_LOOKUP_CHUNK = 256;
const PERSISTED_YIELD_PAGES = 8;
function spaceIdOf(modelSpace                  )         { return modelSpace.spaceId ?? `${modelSpace.model}:${modelSpace.dimensions}`; }
function assertModelSpace(modelSpace                  )       {
  if (typeof modelSpace.model !== 'string' || modelSpace.model.length === 0) throw new TypeError('vector model-space requires a non-empty model identity');
  if (!Number.isSafeInteger(modelSpace.dimensions) || modelSpace.dimensions < 1) throw new TypeError('vector model-space dimensions must be a positive safe integer');
  if (modelSpace.spaceId !== undefined && (typeof modelSpace.spaceId !== 'string' || modelSpace.spaceId.length === 0)) throw new TypeError('vector model-space spaceId must be a non-empty string');
}
function generationIdentity(modelSpace                  , sequence        )         { return `${modelSpace.model}:${modelSpace.dimensions}:${sequence}`; }
function validateScope(scope         )                                                         {
  if (scope === undefined || typeof scope === 'string') return scope;
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) throw new TypeError('vector search scope must be a source-row predicate object');
  return scope                                     ;
}
function matchesScope(row                                   , scope                                   )          {
  for (const key of Object.keys(scope)) if (row[key] !== scope[key]) return false;
  return true;
}
function validateVectorToFloat32(value         , model         , modelSpace                  , sourceId        )                                                           {
  if (model !== modelSpace.model) {
    throw new VectorPluginValidationError('model-space-mismatch', `vector source '${sourceId}' has model '${String(model)}'; generation requires '${modelSpace.model}'`);
  }
  if (!Array.isArray(value) && !(value instanceof Float32Array)) {
    throw new VectorPluginValidationError('invalid-vector', `vector source '${sourceId}' must contain a number array`);
  }
  if (value.length !== modelSpace.dimensions) {
    throw new VectorPluginValidationError('dimension-mismatch', `vector source '${sourceId}' has ${value.length} dimensions; generation requires ${modelSpace.dimensions}`);
  }
  const f32 = new Float32Array(modelSpace.dimensions);
  let sumSq = 0;
  for (let i = 0; i < modelSpace.dimensions; i += 1) {
    const item = value[i];
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new VectorPluginValidationError('non-finite-value', `vector source '${sourceId}' contains a non-finite value`);
    }
    const f = Math.fround(item);
    if (!Number.isFinite(f)) throw new VectorPluginValidationError('non-finite-value', `vector source '${sourceId}' contains a non-finite Float32 value`);
    f32[i] = f;
    sumSq += f * f;
  }
  const norm = Math.sqrt(sumSq);
  if (!Number.isFinite(norm)) throw new VectorPluginValidationError('non-finite-value', `vector source '${sourceId}' has a non-finite L2 norm`);
  if (norm <= 0) throw new VectorPluginValidationError('invalid-vector', `vector source '${sourceId}' must have a non-zero L2 norm`);
  return { vector: f32, norm };
}
function float32ToBlob(vector              )             {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}
function blobToFloat32(blob         , dimensions        )               {
  if (!(blob instanceof Uint8Array)) throw new VectorPluginValidationError('invalid-vector', 'persisted vector BLOB must be a Uint8Array');
  const expectedBytes = dimensions * 4;
  if (blob.byteLength !== expectedBytes) throw new VectorPluginValidationError('dimension-mismatch', `persisted vector BLOB has ${blob.byteLength} bytes; expected ${expectedBytes}`);
  const copy = new ArrayBuffer(expectedBytes);
  new Uint8Array(copy).set(blob);
  const vector = new Float32Array(copy);
  let sumSq = 0;
  for (let i = 0; i < vector.length; i += 1) {
    if (!Number.isFinite(vector[i])) throw new VectorPluginValidationError('non-finite-value', 'persisted vector BLOB contains a non-finite value');
    sumSq += vector[i] * vector[i];
  }
  const norm = Math.sqrt(sumSq);
  if (!Number.isFinite(norm) || norm <= 0) throw new VectorPluginValidationError('invalid-vector', 'persisted vector BLOB must have a finite non-zero L2 norm');
  return vector;
}
function scopeValueOf(row                                   , scopeField                    )         {
  if (scopeField === undefined) return '';
  const value = row[scopeField];
  return value === null || value === undefined ? '' : String(value);
}
function assertFieldName(value         , label        )                          {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new TypeError(`vector plugin ${label} must be a SQLite identifier`);
}
function cellValue(value         )                {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

function segmentFence(row                                   , parent                    )                            {
  const parentId = cellValue(row[parent.field]);
  const revision = cellValue(row[parent.revisionField]);
  const projectId = cellValue(row[parent.projectField]);
  return parentId !== null && revision !== null && projectId !== null ? { parentId, revision, projectId } : null;
}

// Current-parent fence: current row, optional ownership, current project/revision.
function parentFenceOf(ctx                     , parent                    , fence                    , silent = false)                           {
  const row = ctx.reader.row(parent.entity, fence.parentId);
  if (row === undefined) return null;
  if (parent.owns !== undefined) {
    let owned = false;
    try { owned = parent.owns(row) === true; } catch {
      if (!silent) throw new Error(`vector parent '${fence.parentId}' ownership could not be verified`);
    }
    if (!owned) return null;
  }
  const projectId = cellValue(row[parent.parentProjectField]);
  const revision = cellValue(row[parent.parentRevisionField]);
  if (projectId === null || revision === null || projectId !== fence.projectId || revision !== fence.revision) return null;
  return { row, projectId, revision };
}
function derivedHit(match             , segmentRow                                   , parentFence                   , parent                    )                                    {
  return Object.freeze({
    id: match.id, score: match.score, sourceId: String(segmentRow[parent.field]),
    segmentId: parent.segmentIdField === undefined ? match.id : segmentRow[parent.segmentIdField],
    projectId: parentFence.projectId, sourceRevision: parentFence.revision,
    // Re-admit the CURRENT parent, not the segment key.
    authorizationEntity: parent.entity, authorizationRowId: String(segmentRow[parent.field]),
  });
}
function boundaryKeyCensus(count        , boundaryIds                   )                     {
  if (count === 0) return { count: 0, digest: createHash('sha256').update('0:').digest('hex') };
  const deduped = [...new Set(boundaryIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { count, digest: createHash('sha256').update(`${count}:${deduped.join('\n')}`).digest('hex') };
}
function hasBoundIndex(ctx                                 )          { return Boolean(ctx && ctx.index && ctx.index.bound !== false); }
function compareIds(a        , b        )         { return a < b ? -1 : a > b ? 1 : 0; }


function compareScoredMatches(a             , b             )         {
  return a.score > b.score ? -1 : a.score < b.score ? 1 : compareIds(a.id, b.id);
}
function createBoundedTopK(limit        )                                                                             {
  const heap                = [];
  const swap = (i        , j        )       => { const t = heap[i]; heap[i] = heap[j]; heap[j] = t; };
  const push = (candidate             )       => {
    heap.push(candidate);
    for (let child = heap.length - 1; child > 0;) {
      const parent = (child - 1) >> 1;
      if (compareScoredMatches(heap[child], heap[parent]) <= 0) break;
      swap(child, parent); child = parent;
    }
  };
  const replaceWorst = (candidate             )       => {
    heap[0] = candidate;
    for (let parent = 0;;) {
      const left = (parent << 1) + 1, right = left + 1;
      let worst = parent;
      if (left < heap.length && compareScoredMatches(heap[left], heap[worst]) > 0) worst = left;
      if (right < heap.length && compareScoredMatches(heap[right], heap[worst]) > 0) worst = right;
      if (worst === parent) return;
      swap(parent, worst); parent = worst;
    }
  };
  return {
    offer(c) { if (heap.length < limit) push(c); else if (compareScoredMatches(c, heap[0]) < 0) replaceWorst(c); },
    results() { return heap.sort(compareScoredMatches); },
  };
}
function yieldToEventLoop()                { return new Promise      ((resolve) => setTimeout(resolve, 0)); }

function resolveScopeFilter(scopeField                    , request               , query                   )                      {
  const rawScopeId = request.scopeId ?? query?.scopeId;
  if (rawScopeId !== undefined) {
    if (typeof rawScopeId !== 'string' || rawScopeId.length === 0) throw new TypeError('vector search scopeId must be a non-empty string');
    return { scopeId: rawScopeId };
  }
  const scope = validateScope(request.scope ?? query?.scope);
  if (scope === undefined) return {};
  if (typeof scope === 'string') return { scopeId: scope };
  const entries = Object.entries(scope);
  if (entries.length === 0) return {};
  if (scopeField !== undefined && entries.length === 1 && (entries[0][0] === scopeField || entries[0][0] === 'scope_id')) {
    return { scopeId: entries[0][1] === null || entries[0][1] === undefined ? '' : String(entries[0][1]) };
  }
  return { predicate: scope };
}




export function createVectorPlugin(options                     )               {
  if (typeof options.source.owns !== 'function') throw new TypeError('vector plugin source requires an ownership predicate');
  const scopeField = options.source.scopeField;
  if (scopeField !== undefined && !IDENTIFIER.test(scopeField)) throw new TypeError('vector plugin scopeField must be a SQLite identifier');
  const parent = options.source.parent;
  if (parent !== undefined) {
    if (parent === null || typeof parent !== 'object') throw new TypeError('vector plugin parent must be a declaration object');
    for (const [label, value] of Object.entries({
      entity: parent.entity, field: parent.field, revisionField: parent.revisionField,
      projectField: parent.projectField, parentRevisionField: parent.parentRevisionField, parentProjectField: parent.parentProjectField,
    })) assertFieldName(value, `parent ${label}`);
    if (parent.entity === options.source.entity) throw new TypeError('vector plugin parent entity must differ from the segment source entity');
    if (parent.owns !== undefined && typeof parent.owns !== 'function') throw new TypeError('vector plugin parent ownership predicate must be a function');
    if (parent.segmentIdField !== undefined) assertFieldName(parent.segmentIdField, 'parent segmentIdField');
  }
  if (options.admission !== undefined && (options.admission === null || typeof options.admission !== 'object' || typeof options.admission.adapter?.admit !== 'function')) {
    throw new TypeError('vector plugin requires a search admission configuration');
  }
  // Plugin-level admission receives the row that will be disclosed: the CURRENT
  // PARENT for a derived source, the source row otherwise. Refuse a declaration
  // naming any other entity — its registered scope would compile over the wrong
  // columns and silently deny every hit.
  const admittedEntity = parent === undefined ? options.source.entity : parent.entity;
  if (typeof options.admission?.entity?.name === 'string' && options.admission.entity.name !== admittedEntity) {
    throw new TypeError(`vector plugin admission entity must be '${admittedEntity}' — the row disclosed for this source`);
  }
  let modelSpace = Object.freeze({ ...options.modelSpace });
  assertModelSpace(modelSpace);
  let sequence = 0;
  const base = `vec_${options.id.replaceAll(/[^A-Za-z0-9_]/g, '_')}`;
  const stateTable = `${base}_state`;
  const manifestTable = `${base}_generations`;
  const tables = [`${base}_g0`, `${base}_g1`]         ;
  // Existing persistent indexes predate the derived-segment fence columns, and
  // the owned-index capability cannot ALTER a table. An ORDINARY source
  // therefore keeps writing the four columns it always wrote (an extra column
  // from an intermediate build is ignored by explicit column lists, so both
  // shapes read and write); only a derived source persists the fence.
  const vectorColumns = parent === undefined ? 'source_key, scope_id, norm, embedding' : 'source_key, scope_id, norm, embedding, parent_key, revision, project_key';
  const upsertSql = (table        ) => `INSERT OR REPLACE INTO ${table} (${vectorColumns}) VALUES (?, ?, ?, ?${parent === undefined ? '' : ', ?, ?, ?'})`;
  const upsertParams = (entry           )                     => parent === undefined
    ? [entry.id, entry.scopeId, entry.norm, float32ToBlob(entry.vector)]
    : [entry.id, entry.scopeId, entry.norm, float32ToBlob(entry.vector), entry.fence?.parentId ?? '', entry.fence?.revision ?? '', entry.fence?.projectId ?? ''];
  let activeGen        = 0;
  let buildingGen               = null;
  let promotedGen               = null;
  let promotedFromGen               = null;
  let activeSlab = new Float32VectorSlab(modelSpace.dimensions);
  let shadowSlab                           = null;
  let previousSlab                           = null;
  let activeWriteGeneration = 0;
  const manifests                                                                     = [null, null];
  function targetSlab()                    { return shadowSlab ?? activeSlab; }
  function isSuperseded(ctx                     )          { return ctx.generation < activeWriteGeneration; }
  function claimGeneration(ctx                     )          {
    if (ctx.generation < activeWriteGeneration) return false;
    activeWriteGeneration = ctx.generation; return true;
  }
  function hasManifestTable(ctx                     )          {
    if (!hasBoundIndex(ctx)) return false;
    try { ctx.index.query({ sql: `SELECT gen FROM ${manifestTable} LIMIT 1` }); return true; } catch { return false; }
  }
  function readPersistedState(ctx                     )                                                                               {
    if (!hasBoundIndex(ctx)) return null;
    const row = ctx.index.query({ sql: `SELECT active, previous, model, dimensions FROM ${stateTable} WHERE slot = 'active'` })[0];
    if (!row) return null;
    return { active: row.active === 1 ? 1 : 0, previous: row.previous === 1 ? 1 : 0, model: String(row.model ?? ''), dimensions: Number(row.dimensions ?? 0) };
  }
  function currentActiveGeneration(ctx                                 )        {
    if (ctx && hasBoundIndex(ctx)) {
      const persisted = readPersistedState(ctx);
      if (persisted !== null) { activeGen = persisted.active; return persisted.active; }
    }
    return activeGen;
  }
  function targetTable(ctx                     )         { return tables[buildingGen ?? currentActiveGeneration(ctx)]; }
  function materializedInDeclaredSpace(ctx                     )          {
    const persisted = readPersistedState(ctx);
    return persisted === null || (persisted.model === modelSpace.model && persisted.dimensions === modelSpace.dimensions);
  }
  function countTable(ctx                     , table        )         {
    return Number(ctx.index.query({ sql: `SELECT COUNT(*) AS count FROM ${table}` })[0]?.count ?? 0);
  }
  function readGenerationManifest(ctx                     , gen       )                                  {
    if (hasManifestTable(ctx)) {
      const row = ctx.index.query({
        sql: `SELECT gen, generation_id, model, dimensions, space_id, status, expected_count, indexed_count, cursor FROM ${manifestTable} WHERE gen = ?`,
        params: [gen],
      })[0];
      if (row) {
        const status = row.status === 'active' || row.status === 'ready' ? row.status : 'staging';
        const cursor = typeof row.cursor === 'string' && row.cursor.length > 0 ? row.cursor : null;
        return manifests[gen] = Object.freeze({
          generation: gen, generationId: String(row.generation_id), model: String(row.model), dimensions: Number(row.dimensions),
          spaceId: String(row.space_id), status, expectedCount: Number(row.expected_count), indexedCount: Number(row.indexed_count), cursor,
        });
      }
    }
    if (manifests[gen] !== null) return manifests[gen];
    if (hasBoundIndex(ctx)) {
      const persisted = readPersistedState(ctx);
      if (persisted !== null && persisted.active === gen) {
        const count = countTable(ctx, tables[gen]);
        if (count > 0) {
          return Object.freeze({
            generation: gen, generationId: `${persisted.model}:${persisted.dimensions}:0:g${gen}`, model: persisted.model,
            dimensions: persisted.dimensions, spaceId: spaceIdOf({ model: persisted.model, dimensions: persisted.dimensions }),
            status: 'active', expectedCount: count, indexedCount: count, cursor: null,
          });
        }
      }
    }
    return null;
  }
  function manifestUpsertStatement(m                          )                                                                {
    return {
      sql: `INSERT OR REPLACE INTO ${manifestTable} (gen, generation_id, model, dimensions, space_id, status, expected_count, indexed_count, cursor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [m.generation, m.generationId, m.model, m.dimensions, m.spaceId, m.status, m.expectedCount, m.indexedCount, m.cursor ?? ''],
    };
  }
  async function saveGenerationManifest(ctx                     , manifest                          )                {
    manifests[manifest.generation] = manifest;
    if (hasManifestTable(ctx)) await ctx.index.write({ expectedFence: ctx.fence, statements: [manifestUpsertStatement(manifest)] });
  }
  async function deleteGenerationManifest(ctx                     , gen       )                {
    manifests[gen] = null;
    if (hasManifestTable(ctx)) await ctx.index.write({ expectedFence: ctx.fence, statements: [{ sql: `DELETE FROM ${manifestTable} WHERE gen = ?`, params: [gen] }] });
  }
  function tableBoundaryIds(ctx                     , table        , count        )                    {
    if (count === 0) return [];
    const keys = (order                , limit        ) => ctx.index.query({ sql: `SELECT source_key FROM ${table} ORDER BY source_key ${order} LIMIT ${limit}` }).map((row) => String(row.source_key));
    if (count <= CENSUS_BOUNDARY_SAMPLE * 2) return keys('ASC', CENSUS_BOUNDARY_SAMPLE * 2);
    return [...keys('ASC', CENSUS_BOUNDARY_SAMPLE), ...keys('DESC', CENSUS_BOUNDARY_SAMPLE)];
  }
  // One page of the plugin's OWN generation table, walking `source_key` in key
  // order. Explicit column lists keep an ordinary index readable whether its
  // table predates the fence columns or carries them unused.
  function persistedPage(ctx                     , table        , columns        , afterKey                    , scopeId         ) {
    const clauses           = [], params            = [];
    if (scopeId !== undefined) { clauses.push('scope_id = ?'); params.push(scopeId); }
    if (afterKey !== undefined) { clauses.push('source_key > ?'); params.push(afterKey); }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    return ctx.index.query({ sql: `SELECT ${columns} FROM ${table}${where} ORDER BY source_key ASC LIMIT ${PERSISTED_SCAN_PAGE_SIZE}`, params });
  }
  function scorePersistedRow(queryVec              , queryNorm        , row                                   , dimensions        )                     {
    let vector              ;
    try { vector = blobToFloat32(row.embedding, dimensions); } catch { return null; }
    const storedNorm = row.norm;
    const norm = typeof storedNorm === 'number' && Number.isFinite(storedNorm) && storedNorm > 0 ? storedNorm : vectorNorm(vector);
    const score = cosineSimilarityFloat32(queryVec, queryNorm, vector, norm);
    if (!Number.isFinite(score)) return null;
    const parentKey = typeof row.parent_key === 'string' && row.parent_key.length > 0 ? row.parent_key : null;
    const fence = parentKey === null ? undefined : { parentId: parentKey, revision: String(row.revision ?? ''), projectId: String(row.project_key ?? '') };
    return { id: String(row.source_key), score, fence };
  }
  // The one walk over the plugin's declared source entity. Every full-corpus
  // reader (rebuild, predicate scan, collected keys) pages through here, so the
  // id cursor and its no-progress guard exist exactly once.
  async function* sourcePages(ctx                     , startAfterId         )                                                     {
    let afterId                     = startAfterId;
    while (true) {
      const page = ctx.reader.rows(options.source.entity, { afterId, limit: SOURCE_PAGE_SIZE, order: 'asc' });
      if (page.length === 0) return;
      yield page;
      if (page.length < SOURCE_PAGE_SIZE) return;
      const lastId = String(page[page.length - 1]?.id ?? '');
      if (lastId.length === 0 || (afterId !== undefined && lastId <= afterId)) return;
      afterId = lastId;
    }
  }
  function countExpectedRows(ctx                     )         {
    if (parent === undefined && typeof ctx.reader.count === 'function') return ctx.reader.count(options.source.entity);
    let count = 0, afterId                    ;
    while (true) {
      const page = ctx.reader.rows(options.source.entity, { afterId, limit: SOURCE_PAGE_SIZE, order: 'asc' });
      if (page.length === 0) break;
      for (const row of page) {
        if (parent !== undefined) {
          const fence = segmentFence(row, parent);
          if (fence === null || parentFenceOf(ctx, parent, fence) === null) continue;
        }
        count += 1;
      }
      if (page.length < SOURCE_PAGE_SIZE) break;
      const lastId = String(page[page.length - 1]?.id ?? '');
      if (lastId.length === 0 || (afterId !== undefined && lastId <= afterId)) break;
      afterId = lastId;
    }
    return count;
  }
  async function scanPersistedPredicate(ctx                     , table        , predicate                                   , queryVec              , queryNorm        , topK                                         , signal                         , dimensions        )                   {
    let pages = 0;
    for await (const page of sourcePages(ctx)) {
      if (signal?.aborted) return false;
      const ids           = [];
      for (const row of page) if (typeof row.id === 'string' && row.id.length > 0 && matchesScope(row, predicate)) ids.push(row.id);
      for (let offset = 0; offset < ids.length; offset += PERSISTED_LOOKUP_CHUNK) {
        if (signal?.aborted) return false;
        const chunk = ids.slice(offset, offset + PERSISTED_LOOKUP_CHUNK);
        const rows = ctx.index.query({ sql: `SELECT ${vectorColumns} FROM ${table} WHERE source_key IN (${chunk.map(() => '?').join(', ')}) LIMIT ${PERSISTED_LOOKUP_CHUNK}`, params: chunk });
        for (const row of rows) {
          const scored = scorePersistedRow(queryVec, queryNorm, row, dimensions);
          if (scored !== null) topK.offer(scored);
        }
      }
      if (++pages % PERSISTED_YIELD_PAGES === 0) await yieldToEventLoop();
    }
    return true;
  }
  async function scanPersistedMatches(ctx                     , table        , queryVec              , queryNorm        , limit        , filter                     , signal                         , dimensions        )                                  {
    const topK = createBoundedTopK(limit);
    if (filter.predicate !== undefined) {
      return (await scanPersistedPredicate(ctx, table, filter.predicate, queryVec, queryNorm, topK, signal, dimensions)) ? topK.results() : [];
    }
    let afterKey                    , pages = 0;
    while (true) {
      if (signal?.aborted) return [];
      const rows = persistedPage(ctx, table, vectorColumns, afterKey, filter.scopeId);
      if (rows.length === 0) break;
      for (const row of rows) {
        const scored = scorePersistedRow(queryVec, queryNorm, row, dimensions);
        if (scored !== null) topK.offer(scored);
      }
      if (rows.length < PERSISTED_SCAN_PAGE_SIZE) break;
      afterKey = String(rows[rows.length - 1].source_key);
      if (++pages % PERSISTED_YIELD_PAGES === 0) {
        await yieldToEventLoop();
        if (signal?.aborted) return [];
      }
    }
    return topK.results();
  }
  function validatePersistedTable(ctx                     , table        , dimensions        )       {
    let afterKey                    ;
    while (true) {
      const rows = persistedPage(ctx, table, 'source_key, embedding', afterKey);
      if (rows.length === 0) break;
      for (const row of rows) blobToFloat32(row.embedding, dimensions);
      if (rows.length < PERSISTED_SCAN_PAGE_SIZE) break;
      afterKey = String(rows[rows.length - 1].source_key);
    }
  }
  async function clearTable(ctx                     , table        , allowSuperseded = false)                {
    if (!hasBoundIndex(ctx) || (!allowSuperseded && isSuperseded(ctx))) return;
    if (typeof ctx.index.clear === 'function') { await ctx.index.clear({ expectedFence: ctx.fence, table }); return; }
    while (allowSuperseded || !isSuperseded(ctx)) {
      const result = await ctx.index.write({
        expectedFence: ctx.fence,
        statements: [{ sql: `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT ${DELETE_CHUNK_SIZE})` }],
      });
      if (result.changes === 0) break;
    }
  }
  function parseAndValidateRow(row                                   )            {
    const id = row.id;
    if (typeof id !== 'string' || id.length === 0) throw new VectorPluginValidationError('unauthorized-source-ownership', 'vector source row requires a non-empty id');
    let owned         ;
    try { owned = options.source.owns(row) === true; } catch {
      throw new VectorPluginValidationError('unauthorized-source-ownership', `vector source '${id}' ownership could not be verified`);
    }
    if (!owned) throw new VectorPluginValidationError('unauthorized-source-ownership', `vector source '${id}' is not owned by this plugin`);
    let sourceVector = row[options.source.vector];
    if (typeof sourceVector === 'string') {
      try { sourceVector = JSON.parse(sourceVector); } catch {
        throw new VectorPluginValidationError('invalid-vector', `vector source '${id}' contains invalid JSON`);
      }
    }
    const { vector, norm } = validateVectorToFloat32(sourceVector, row[options.source.model], modelSpace, id);
    const fence = parent === undefined ? null : segmentFence(row, parent);
    if (parent !== undefined && fence === null) throw new VectorPluginValidationError('invalid-derived-segment', `vector source '${id}' is missing its parent revision fence`);
    return { id, scopeId: scopeValueOf(row, scopeField), vector, norm, fence };
  }
  async function flushUpserts(ctx                     , table        , entries                      , checkpoint                           )                {
    if (!hasBoundIndex(ctx)) return;
    const includeCheckpoint = checkpoint !== undefined && hasManifestTable(ctx);
    if (entries.length === 0) { if (includeCheckpoint) await saveGenerationManifest(ctx, checkpoint); return; }
    const sql = upsertSql(table);
    const chunkSize = includeCheckpoint ? MAX_WRITE_STATEMENTS - 1 : MAX_WRITE_STATEMENTS;
    for (let offset = 0; offset < entries.length; offset += chunkSize) {
      if (isSuperseded(ctx)) return;
      const statements                                                                   = entries
        .slice(offset, offset + chunkSize).map((entry) => ({ sql, params: upsertParams(entry) }));
      if (offset + chunkSize >= entries.length && includeCheckpoint) statements.push(manifestUpsertStatement(checkpoint));
      await ctx.index.write({ expectedFence: ctx.fence, statements });
    }
  }
  function materializedCount(ctx                     )         {
    return hasBoundIndex(ctx) ? countTable(ctx, targetTable(ctx)) : targetSlab().size;
  }
  function selectStagingDestination(ctx                     , persistent         , forceShadow = false)        {
    if (buildingGen !== null) return buildingGen;
    if (!persistent) return 0;
    const active = currentActiveGeneration(ctx), other        = active === 0 ? 1 : 0, spaceId = spaceIdOf(modelSpace);
    const matchesSpace = (m                                 )          =>
      m !== null && m.status === 'staging' && m.model === modelSpace.model && m.dimensions === modelSpace.dimensions && m.spaceId === spaceId;
    if (!forceShadow) {
      if (matchesSpace(readGenerationManifest(ctx, other))) return other;
      if (matchesSpace(readGenerationManifest(ctx, active)) && countTable(ctx, tables[active]) === 0) return active;
      if (countTable(ctx, tables[active]) === 0) return active;
    }
    return other;
  }
  async function stageGenerationInternal(ctx                     , opts                               = {}, forceShadow = false)                                    {
    const persistent = hasBoundIndex(ctx);
    if (opts.expectedCount !== undefined && (!Number.isSafeInteger(opts.expectedCount) || opts.expectedCount < 0)) {
      throw new TypeError('vector stageGeneration expectedCount must be a non-negative safe integer');
    }
    if (!claimGeneration(ctx)) throw new Error('vector generation staging superseded by a newer materialization');
    const destination = selectStagingDestination(ctx, persistent, forceShadow);
    const table = tables[destination], spaceId = spaceIdOf(modelSpace), existing = readGenerationManifest(ctx, destination);
    const canResume = existing !== null && existing.status === 'staging'
      && existing.model === modelSpace.model && existing.dimensions === modelSpace.dimensions
      && existing.spaceId === spaceId && (persistent || shadowSlab !== null);
    const expectedCount = opts.expectedCount ?? (canResume && existing.expectedCount > 0 ? existing.expectedCount : countExpectedRows(ctx));
    const generationId = canResume ? existing.generationId : `${generationIdentity(modelSpace, sequence)}:g${destination}:${ctx.generation}`;
    const resumeCursor = canResume ? (existing.cursor ?? undefined) : undefined;
    let indexedCount = canResume ? (persistent ? countTable(ctx, table) : (shadowSlab?.size ?? 0)) : 0;
    const next = persistent ? null : (canResume && shadowSlab !== null ? shadowSlab : new Float32VectorSlab(modelSpace.dimensions));
    if (!canResume) {
      if (next !== null) { next.clear(); shadowSlab = next; }
      await clearTable(ctx, table, true);
    } else if (next !== null) shadowSlab = next;
    let manifest                           = Object.freeze({
      generation: destination, generationId, model: modelSpace.model, dimensions: modelSpace.dimensions,
      spaceId, status: 'staging', expectedCount, indexedCount, cursor: resumeCursor ?? null,
    });
    await saveGenerationManifest(ctx, manifest);
    let batches = 0;
    try {
      for await (const page of sourcePages(ctx, resumeCursor)) {
        if (isSuperseded(ctx)) return manifest;
        if (opts.signal?.aborted) throw new Error('vector generation staging aborted');
        const parsedPage              = [];
        for (const row of page) {
          // Fence FIRST: a row whose parent revision/project advanced (or whose
          // parent is gone) is not part of this projection, so its bytes are
          // never parsed — a corrupt stale row cannot abort a healthy rebuild.
          if (parent !== undefined) {
            const fence = segmentFence(row, parent);
            if (fence === null || parentFenceOf(ctx, parent, fence) === null) continue;
          }
          const parsed = parseAndValidateRow(row);
          next?.set(parsed.id, parsed.vector, parsed.norm, parsed.scopeId);
          parsedPage.push(parsed);
        }
        const lastId = String(page[page.length - 1]?.id ?? '');
        indexedCount = persistent ? indexedCount + parsedPage.length : next .size;
        manifest = Object.freeze({
          generation: destination, generationId, model: modelSpace.model, dimensions: modelSpace.dimensions,
          spaceId, status: 'staging', expectedCount, indexedCount, cursor: lastId.length > 0 ? lastId : null,
        });
        manifests[destination] = manifest;
        await flushUpserts(ctx, table, parsedPage, manifest);
        if (persistent) indexedCount = countTable(ctx, table);
        if (opts.maxBatches !== undefined && ++batches >= opts.maxBatches) return manifest;
      }
    } catch (err) {
      // Validation errors clean up the partial build; transient/abort errors preserve staged rows & checkpoint for resume.
      if (!isSuperseded(ctx) && err instanceof VectorPluginValidationError) {
        next?.clear(); await clearTable(ctx, table, true); await deleteGenerationManifest(ctx, destination);
      }
      throw err;
    }
    if (isSuperseded(ctx)) return manifest;
    const actualCount = persistent ? countTable(ctx, table) : next .size;
    if (actualCount !== expectedCount) {
      manifest = Object.freeze({ ...manifest, status: 'staging', indexedCount: actualCount });
      await saveGenerationManifest(ctx, manifest);
      return manifest;
    }
    if (persistent) validatePersistedTable(ctx, table, modelSpace.dimensions); else next .validateFinite();
    manifest = Object.freeze({ ...manifest, status: 'ready', indexedCount: actualCount, cursor: null });
    await saveGenerationManifest(ctx, manifest);
    return manifest;
  }
  async function activateGeneration(ctx                     , generation        )                                    {
    const persistent = hasBoundIndex(ctx), spaceId = spaceIdOf(modelSpace);
    const targetGen = generation ?? buildingGen ?? ([0, 1]         ).find((g) => {
      const m = readGenerationManifest(ctx, g);
      return m !== null && m.status === 'ready' && m.model === modelSpace.model && m.dimensions === modelSpace.dimensions && m.spaceId === spaceId;
    });
    if (targetGen === undefined) throw new Error('vector plugin has no ready staged generation to activate');
    const manifest = readGenerationManifest(ctx, targetGen);
    if (manifest === null) throw new Error(`vector generation ${targetGen} has no manifest`);
    if (manifest.status !== 'ready' && manifest.status !== 'active') {
      throw new Error(`cannot activate incomplete vector generation ${targetGen} with status '${manifest.status}' (${manifest.indexedCount}/${manifest.expectedCount})`);
    }
    if (manifest.model !== modelSpace.model || manifest.dimensions !== modelSpace.dimensions || manifest.spaceId !== spaceId) {
      throw new Error(`cannot activate vector generation ${targetGen}: space '${manifest.spaceId}' does not match declared '${spaceId}'`);
    }
    const actualCount = persistent ? countTable(ctx, tables[targetGen]) : (shadowSlab ?? activeSlab).size;
    if (manifest.indexedCount !== manifest.expectedCount || actualCount !== manifest.expectedCount) {
      throw new Error(`cannot activate incomplete vector generation ${targetGen}: indexed ${actualCount}/${manifest.expectedCount}`);
    }
    if (persistent) validatePersistedTable(ctx, tables[targetGen], manifest.dimensions); else (shadowSlab ?? activeSlab).validateFinite();
    if (isSuperseded(ctx)) throw new Error('vector generation activation superseded by a newer materialization');
    const activeManifest                           = Object.freeze({ ...manifest, status: 'active', cursor: null });
    if (persistent) {
      const previous = currentActiveGeneration(ctx), prevState = readPersistedState(ctx);
      const prevExisting = previous !== targetGen ? readGenerationManifest(ctx, previous) : null;
      const prevDemoted                                  = previous !== targetGen
        ? (prevExisting !== null ? Object.freeze({ ...prevExisting, status: 'ready' })
          : prevState !== null ? Object.freeze({
            generation: previous, generationId: `${prevState.model}:${prevState.dimensions}:0:g${previous}`,
            model: prevState.model, dimensions: prevState.dimensions,
            spaceId: spaceIdOf({ model: prevState.model, dimensions: prevState.dimensions }),
            status: 'ready', expectedCount: countTable(ctx, tables[previous]), indexedCount: countTable(ctx, tables[previous]), cursor: null,
          }) : null)
        : null;
      const statements                                                                   = [{
        sql: `INSERT INTO ${stateTable} (slot, active, previous, model, dimensions) VALUES ('active', ?, ?, ?, ?) ON CONFLICT(slot) DO UPDATE SET previous = excluded.previous, active = excluded.active, model = excluded.model, dimensions = excluded.dimensions`,
        params: [targetGen, previous, activeManifest.model, activeManifest.dimensions],
      }];
      if (hasManifestTable(ctx)) {
        if (prevDemoted !== null) statements.push(manifestUpsertStatement(prevDemoted));
        statements.push(manifestUpsertStatement(activeManifest));
      }
      await ctx.index.write({ expectedFence: ctx.fence, statements });
      if (prevDemoted !== null) manifests[previous] = prevDemoted;
      manifests[targetGen] = activeManifest; activeGen = targetGen;
    } else {
      if (shadowSlab !== null) { previousSlab = activeSlab; activeSlab = shadowSlab; shadowSlab = null; }
      manifests[targetGen] = activeManifest;
    }
    return activeManifest;
  }
  async function rebuild(ctx                     )                                   {
    const persistent = hasBoundIndex(ctx);
    if (!claimGeneration(ctx)) return { counts: { vectors: materializedCount(ctx) } };
    const shadowActive = buildingGen !== null;
    const manifest = await stageGenerationInternal(ctx, {});
    if (isSuperseded(ctx)) return { counts: { vectors: materializedCount(ctx) } };
    if (manifest.status !== 'ready') throw new Error(`vector generation ${manifest.generation} is incomplete (${manifest.indexedCount}/${manifest.expectedCount}) and cannot be activated`);
    if (!shadowActive) await activateGeneration(ctx, manifest.generation);
    return {
      counts: { vectors: persistent ? countTable(ctx, tables[shadowActive ? manifest.generation : currentActiveGeneration(ctx)]) : (shadowActive ? shadowSlab .size : activeSlab.size) },
    };
  }
  async function purgeRows(ctx                     , where        , params                    )                {
    if (!hasBoundIndex(ctx) || isSuperseded(ctx)) return;
    await ctx.index.write({ expectedFence: ctx.fence, statements: tables.map((generationTable) => ({ sql: `DELETE FROM ${generationTable} WHERE ${where}`, params })) });
  }
  async function syncManifestCountsAfterPurge(ctx                     )                {
    if (!hasManifestTable(ctx)) return;
    const statements                                                                   = [];
    for (const gen of [0, 1]         ) {
      const m = readGenerationManifest(ctx, gen);
      if (m === null) continue;
      const count = countTable(ctx, tables[gen]);
      const updated = Object.freeze({ ...m, indexedCount: count, expectedCount: m.status === 'active' || m.status === 'ready' ? count : m.expectedCount });
      manifests[gen] = updated; statements.push(manifestUpsertStatement(updated));
    }
    if (statements.length > 0) await ctx.index.write({ expectedFence: ctx.fence, statements });
  }
  async function purgeUnboundParent(ctx                     , rowId         , scopeId         )                {
    if (parent === undefined) return;
    if (scopeId !== undefined) { activeSlab.deleteScope(scopeId); shadowSlab?.deleteScope(scopeId); }
    if (rowId !== undefined) {
      for await (const page of sourcePages(ctx)) {
        for (const row of page) {
          if (cellValue(row[parent.field]) === rowId && typeof row.id === 'string') {
            activeSlab.delete(row.id); shadowSlab?.delete(row.id);
          }
        }
      }
    }
  }
  function isParentRemovedOrExcluded(ctx                     , rowId        , kind                      )          {
    if (kind === 'removed' || parent === undefined) return true;
    const row = ctx.reader.row(parent.entity, rowId);
    if (row === undefined) return true;
    if (parent.owns === undefined) return false;
    try { return parent.owns(row) !== true; } catch { return true; }
  }
  async function reconcile(ctx                     , changes                         )                                   {
    const persistent = hasBoundIndex(ctx), next = persistent ? null : targetSlab();
    if (!claimGeneration(ctx)) return { counts: { vectors: materializedCount(ctx) } };
    if (parent !== undefined && changes.some((change) => change.entity === parent.entity)) {
      const removedParentIds           = [], updatedParentIds           = [];
      for (const change of changes) {
        if (change.entity !== parent.entity) continue;
        if (isParentRemovedOrExcluded(ctx, change.rowId, change.kind)) removedParentIds.push(change.rowId);
        else updatedParentIds.push(change.rowId);
      }
      for (const parentId of removedParentIds) {
        await purgeRows(ctx, 'parent_key = ?', [parentId]);
        if (!persistent) await purgeUnboundParent(ctx, parentId);
      }
      if (updatedParentIds.length === 0 && !changes.some((change) => change.entity === options.source.entity)) {
        await syncManifestCountsAfterPurge(ctx);
        return { counts: { vectors: materializedCount(ctx) } };
      }
      // Safe shadow-first parent-change reconcile: build replacement into the
      // shadow generation BEFORE switching active, so a failed rebuild leaves
      // the last known-good active table intact and searchable.
      const shadowActive = buildingGen !== null;
      const manifest = await stageGenerationInternal(ctx, {}, true);
      if (isSuperseded(ctx)) return { counts: { vectors: materializedCount(ctx) } };
      if (manifest.status !== 'ready') throw new Error(`vector generation ${manifest.generation} is incomplete (${manifest.indexedCount}/${manifest.expectedCount}) and cannot be activated`);
      if (!shadowActive) {
        const previousGen = currentActiveGeneration(ctx);
        await activateGeneration(ctx, manifest.generation);
        if (persistent && previousGen !== manifest.generation) {
          for (const parentId of updatedParentIds) {
            await ctx.index.write({ expectedFence: ctx.fence, statements: [{ sql: `DELETE FROM ${tables[previousGen]} WHERE parent_key = ?`, params: [parentId] }] });
          }
        }
      }
      return { counts: { vectors: materializedCount(ctx) } };
    }
    const table = targetTable(ctx), statements                                                                   = [];
    const flushStatements = async ()                => {
      if (!hasBoundIndex(ctx) || statements.length === 0) { statements.length = 0; return; }
      for (let offset = 0; offset < statements.length; offset += MAX_WRITE_STATEMENTS) {
        if (isSuperseded(ctx)) break;
        await ctx.index.write({ expectedFence: ctx.fence, statements: statements.slice(offset, offset + MAX_WRITE_STATEMENTS) });
      }
      statements.length = 0;
    };
    const removeFromEveryGeneration = (rowId        )       => {
      for (const generationTable of tables) statements.push({ sql: `DELETE FROM ${generationTable} WHERE source_key = ?`, params: [rowId] });
    };
    for (const change of changes) {
      if (change.entity !== options.source.entity) continue;
      if (change.kind === 'removed') { next?.delete(change.rowId); removeFromEveryGeneration(change.rowId); continue; }
      const row = ctx.reader.row(options.source.entity, change.rowId);
      if (row === undefined) { next?.delete(change.rowId); removeFromEveryGeneration(change.rowId); continue; }
      try {
        if (parent !== undefined) {
          const fence = segmentFence(row, parent);
          if (fence === null || parentFenceOf(ctx, parent, fence) === null) { next?.delete(change.rowId); removeFromEveryGeneration(change.rowId); continue; }
        }
        const parsed = parseAndValidateRow(row);
        next?.set(parsed.id, parsed.vector, parsed.norm, parsed.scopeId);
        statements.push({ sql: upsertSql(table), params: upsertParams(parsed) });
      } catch (err) {
        if (err instanceof VectorPluginValidationError && err.code === 'unauthorized-source-ownership') {
          next?.delete(change.rowId); removeFromEveryGeneration(change.rowId); await flushStatements();
        }
        throw err;
      }
    }
    await flushStatements();
    if (buildingGen === null) await syncManifestCountsAfterPurge(ctx);
    return { counts: { vectors: next === null ? countTable(ctx, table) : next.size } };
  }
  async function revoke(ctx                     , target                        )                                   {
    const persistent = hasBoundIndex(ctx), next = persistent ? null : targetSlab();
    if (!claimGeneration(ctx)) return { counts: { vectors: materializedCount(ctx) } };
    if (parent !== undefined && target.entity === parent.entity) {
      // Purge derived vectors across BOTH generations without rebuilding:
      // a revoked/excluded parent must stay purged even while source rows remain.
      if (target.rowId !== undefined) await purgeRows(ctx, 'parent_key = ?', [target.rowId]);
      if (target.scopeId !== undefined) await purgeRows(ctx, 'project_key = ?', [target.scopeId]);
      if (!persistent) await purgeUnboundParent(ctx, target.rowId, target.scopeId);
      await syncManifestCountsAfterPurge(ctx);
      return { counts: { vectors: materializedCount(ctx) } };
    }
    if (target.entity !== options.source.entity) return { counts: { vectors: materializedCount(ctx) } };
    const table = targetTable(ctx);
    if (target.scopeId !== undefined) { next?.deleteScope(target.scopeId); await purgeRows(ctx, 'scope_id = ?', [target.scopeId]); }
    else if (target.rowId !== undefined) { next?.delete(target.rowId); await purgeRows(ctx, 'source_key = ?', [target.rowId]); }
    if (buildingGen === null) await syncManifestCountsAfterPurge(ctx);
    return { counts: { vectors: next === null ? countTable(ctx, table) : next.size } };
  }
  async function collectAllowedKeys(ctx                     , predicate                                   )                               {
    const allowed = new Set        ();
    for await (const page of sourcePages(ctx)) {
      for (const row of page) if (typeof row.id === 'string' && matchesScope(row, predicate)) allowed.add(row.id);
    }
    return allowed;
  }
  // Re-read the current segment and parent; index-time authorization is never trusted.
  function searchCandidate(ctx                     , match             )                               {
    const row = ctx.reader.row(options.source.entity, match.id);
    if (row === undefined) return null;
    if (parent === undefined) return { hit: Object.freeze({ id: match.id, score: match.score }), key: match.id, rank: match.score, row };
    let owned = false;
    try { owned = options.source.owns(row) === true; } catch { owned = false; }
    const fence = owned ? segmentFence(row, parent) : null;
    const stale = hasBoundIndex(ctx) && (match.fence === undefined || fence === null || match.fence.parentId !== fence.parentId || match.fence.revision !== fence.revision || match.fence.projectId !== fence.projectId);
    const parentFence = fence === null || stale ? null : parentFenceOf(ctx, parent, fence, true);
    return parentFence === null ? null : { hit: derivedHit(match, row, parentFence, parent), key: match.id, rank: match.score, row: parentFence.row };
  }
  // Derived hits consume the window only after current-parent admission; refill on denial.
  async function search(ctx                     , request               )                                    {
    if (request.signal?.aborted) return { hits: [] };
    if (request.principal === undefined) throw new VectorPluginValidationError('unauthorized-source-ownership', 'vector search requires a principal for result admission');
    const query = request.query                     , bound = hasBoundIndex(ctx), persisted = bound ? readPersistedState(ctx) : null;
    // Two spaces may be served: the DECLARED space once materialized, and the
    // retained ACTIVE generation's own space while a declared change is still
    // being built (the rollback window). A query never mixes them — it is
    // answered from exactly one generation, or refused.
    const space = query?.model === modelSpace.model ? modelSpace
      : persisted !== null && query?.model === persisted.model ? { model: persisted.model, dimensions: persisted.dimensions } : null;
    if (space === null) {
      throw new VectorPluginValidationError('model-space-mismatch', `vector query has model '${String(query?.model)}'; generation requires '${modelSpace.model}'`);
    }
    const { vector: queryVec, norm: queryNorm } = validateVectorToFloat32(query?.vector, query?.model, space, 'query');
    const declared = space.model === modelSpace.model && space.dimensions === modelSpace.dimensions;
    if (declared && persisted !== null && (persisted.model !== space.model || persisted.dimensions !== space.dimensions)) return { hits: [] };
    const generation = declared ? currentActiveGeneration(ctx) : persisted .active;
    const filter = resolveScopeFilter(scopeField, request, query);
    const requested = typeof request.limit === 'number' && Number.isFinite(request.limit) ? Math.floor(request.limit) : SEARCH_MAX_RESULTS_CAP;
    const limit = Math.max(1, requested), total = bound ? countTable(ctx, tables[generation]) : activeSlab.size;
    const staleness = ctx.state !== undefined ? searchStalenessOf(ctx.state) : 'stale';
    let candidateLimit = limit;
    for (;;) {
      let matches                        ;
      if (bound) {
        matches = await scanPersistedMatches(ctx, tables[generation], queryVec, queryNorm, candidateLimit, filter, request.signal, space.dimensions);
      } else {
        const allowedKeys = filter.predicate !== undefined ? await collectAllowedKeys(ctx, filter.predicate) : undefined;
        const poolSize = filter.scopeId !== undefined ? activeSlab.slotsForScope(filter.scopeId).length : allowedKeys !== undefined ? allowedKeys.size : activeSlab.size;
        if (poolSize === 0) return { hits: [] };
        matches = await activeSlab.topKInterruptibly(queryVec, queryNorm, Math.min(candidateLimit, poolSize), { scopeId: filter.scopeId, allowedKeys, signal: request.signal });
      }
      if (request.signal?.aborted) return { hits: [] };
      const candidates                          = [];
      for (const match of matches) {
        const candidate = searchCandidate(ctx, match);
        if (candidate !== null) candidates.push(candidate);
      }
      const hits                                      = [];
      if (options.admission) {
        const admitted = await admitSearchHits(options.admission.adapter, { pluginId: options.id, generation: ctx.generation, staleness, principal: request.principal, candidates });
        for (const result of admitted.hits) hits.push(result.hit);
      } else if (options.unsafeAllowUnauthorizedSearch === true) {
        for (const candidate of candidates) hits.push(candidate.hit);
      } else {
        throw new VectorPluginValidationError('unauthorized-source-ownership', 'vector search requires a search admission adapter to re-authorize result rows');
      }
      // Admission is part of the index's output contract for EVERY source, not
      // just derived ones: a denied ordinary candidate must not shorten the
      // page while lower-ranked authorized candidates remain.
      if (hits.length >= limit || matches.length < candidateLimit || candidateLimit >= total) return { hits };
      candidateLimit = Math.min(total, candidateLimit * 2);
    }
  }
  const plugin               = {
    contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION, id: options.id, version: options.version, parentSource: parent,
    ownedObjects: Object.freeze([
      {
        kind: 'table'         , name: stateTable,
        disposition: { kind: 'retained'         , reason: 'Vector generation state is rebuilt independently of project rows' },
        ddl: [`CREATE TABLE IF NOT EXISTS ${stateTable} (slot TEXT PRIMARY KEY CHECK (slot = 'active'), active INTEGER NOT NULL CHECK (active IN (0, 1)), previous INTEGER NOT NULL CHECK (previous IN (0, 1)), model TEXT NOT NULL, dimensions INTEGER NOT NULL);`],
      },
      {
        kind: 'table'         , name: manifestTable,
        disposition: { kind: 'retained'         , reason: 'Vector generation staging manifests are rebuilt independently of project rows' },
        ddl: [`CREATE TABLE IF NOT EXISTS ${manifestTable} (gen INTEGER PRIMARY KEY CHECK (gen IN (0, 1)), generation_id TEXT NOT NULL, model TEXT NOT NULL, dimensions INTEGER NOT NULL, space_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('staging', 'ready', 'active')), expected_count INTEGER NOT NULL DEFAULT 0, indexed_count INTEGER NOT NULL DEFAULT 0, cursor TEXT NOT NULL DEFAULT '');`],
      },
      ...tables.map((name) => ({
        kind: 'table'         , name, disposition: { kind: 'retained'         , reason: 'Vector index is derived and rebuilt from the source census' },
        ddl: [`CREATE TABLE IF NOT EXISTS ${name} (source_key TEXT PRIMARY KEY, scope_id TEXT NOT NULL DEFAULT '', norm REAL NOT NULL, embedding BLOB NOT NULL${parent === undefined ? '' : ", parent_key TEXT NOT NULL DEFAULT '', revision TEXT NOT NULL DEFAULT '', project_key TEXT NOT NULL DEFAULT ''"});`],
      })),
      ...tables.map((name) => ({ kind: 'index'         , name: `${name}_scope_idx`, disposition: { kind: 'schema-only'          }, ddl: [`CREATE INDEX IF NOT EXISTS ${name}_scope_idx ON ${name} (scope_id);`] })),
    ]),
    sourceInterests: Object.freeze([{ entity: options.source.entity }, ...(parent !== undefined ? [{ entity: parent.entity }] : [])]),
    get generationIdentity() { return generationIdentity(modelSpace, sequence); },
    get modelSpace() { return modelSpace; },
    validateSourceRow(row) { parseAndValidateRow(row); },
    setModelSpace(nextModelSpace) {
      assertModelSpace(nextModelSpace);
      if (nextModelSpace.model === modelSpace.model && nextModelSpace.dimensions === modelSpace.dimensions && nextModelSpace.spaceId === modelSpace.spaceId) return;
      modelSpace = Object.freeze({ ...nextModelSpace }); sequence += 1;
      activeSlab = new Float32VectorSlab(modelSpace.dimensions); shadowSlab = null; buildingGen = null;
    },
    stalenessKey(change) {
      if (change.entity === options.source.entity) return `${change.entity}:${change.rowId}`;
      return parent !== undefined && change.entity === parent.entity ? `${change.entity}:${change.rowId}` : null;
    },
    async prepare(ctx) {
      if (!hasBoundIndex(ctx)) return;
      // A DERIVED source needs the fence columns. An owned-index statement
      // cannot ALTER a table, so an index created before the derived schema has
      // to be rebuilt rather than silently failing on its first write. Refuse
      // at boot with the exact table and a next step.
      if (parent !== undefined) {
        for (const table of tables) {
          try { ctx.index.query({ sql: `SELECT parent_key FROM ${table} LIMIT 1` }); } catch {
            throw new Error(`vector plugin '${options.id}' needs a derived-segment index rebuild: ${table} predates the segment fence schema (drop it, or register a new plugin id, then rebuild)`);
          }
        }
      }
      await ctx.index.write({
        expectedFence: ctx.fence,
        statements: [{ sql: `INSERT OR IGNORE INTO ${stateTable} (slot, active, previous, model, dimensions) VALUES ('active', 0, 0, ?, ?)`, params: [modelSpace.model, modelSpace.dimensions] }],
      });
    },
    validate(ctx) {
      if (!hasBoundIndex(ctx)) { targetSlab().validateFinite(); return; }
      if (buildingGen !== null) { validatePersistedTable(ctx, tables[buildingGen], modelSpace.dimensions); return; }
      // Validate the generation that is actually served, in ITS OWN space: a retained generation predates the declared model space.
      const persisted = readPersistedState(ctx);
      validatePersistedTable(ctx, persisted === null ? targetTable(ctx) : tables[persisted.active], persisted === null ? modelSpace.dimensions : persisted.dimensions);
    },
    stageGeneration(ctx, opts) { return stageGenerationInternal(ctx, opts); },
    activateGeneration,
    generationManifest(ctx, generation) { return readGenerationManifest(ctx, generation ?? currentActiveGeneration(ctx)); },
    reconcile, revoke, rebuild, search,
    async beginShadow(ctx) {
      claimGeneration(ctx);
      const nextGen        = currentActiveGeneration(ctx) === 0 ? 1 : 0;
      buildingGen = nextGen;
      if (hasBoundIndex(ctx)) { await clearTable(ctx, tables[nextGen]); await deleteGenerationManifest(ctx, nextGen); }
      else { shadowSlab = new Float32VectorSlab(modelSpace.dimensions); manifests[nextGen] = null; }
    },
    indexCensus(ctx)               {
      if (hasBoundIndex(ctx)) {
        const table = targetTable(ctx), count = countTable(ctx, table);
        return Object.freeze({ [options.source.entity]: boundaryKeyCensus(count, tableBoundaryIds(ctx, table, count)) });
      }
      const slab = targetSlab();
      return Object.freeze({ [options.source.entity]: boundaryKeyCensus(slab.size, slab.boundaryIds(CENSUS_BOUNDARY_SAMPLE)) });
    },
    sourceCensus(ctx)               {
      // Parity counts only the currently fenced projection, not raw segment rows.
      if (parent !== undefined) {
        let count = 0, afterId                    ;
        const head           = [], tail           = [];
        while (true) {
          const page = ctx.reader.rows(options.source.entity, { afterId, limit: SOURCE_PAGE_SIZE, order: 'asc' });
          if (page.length === 0) break;
          for (const row of page) {
            const fence = segmentFence(row, parent);
            if (fence === null || parentFenceOf(ctx, parent, fence) === null) continue;
            count += 1;
            if (head.length < CENSUS_BOUNDARY_SAMPLE) head.push(String(row.id));
            tail.push(String(row.id));
            if (tail.length > CENSUS_BOUNDARY_SAMPLE * 2) tail.shift();
          }
          if (page.length < SOURCE_PAGE_SIZE) break;
          const lastId = String(page[page.length - 1]?.id ?? '');
          if (lastId.length === 0 || (afterId !== undefined && lastId <= afterId)) break;
          afterId = lastId;
        }
        return Object.freeze({ [options.source.entity]: boundaryKeyCensus(count, [...head, ...tail.slice(-CENSUS_BOUNDARY_SAMPLE)]) });
      }
      const count = typeof ctx.reader.count === 'function' ? ctx.reader.count(options.source.entity) : ctx.reader.rows(options.source.entity).length;
      if (count === 0) return Object.freeze({ [options.source.entity]: boundaryKeyCensus(0, []) });
      if (count <= CENSUS_BOUNDARY_SAMPLE * 2) {
        return Object.freeze({ [options.source.entity]: boundaryKeyCensus(count, ctx.reader.rows(options.source.entity, { limit: CENSUS_BOUNDARY_SAMPLE * 2, order: 'asc' }).map((row) => String(row.id))) });
      }
      const head = ctx.reader.rows(options.source.entity, { limit: CENSUS_BOUNDARY_SAMPLE, order: 'asc' });
      const tail = ctx.reader.rows(options.source.entity, { limit: CENSUS_BOUNDARY_SAMPLE, order: 'desc' });
      return Object.freeze({ [options.source.entity]: boundaryKeyCensus(count, [...head.map((row) => String(row.id)), ...tail.map((row) => String(row.id))]) });
    },
    async commitShadow(ctx) {
      const promoted = buildingGen;
      if (promoted === null) throw new Error('vector plugin has no shadow generation to commit');
      if (isSuperseded(ctx)) throw new Error('vector shadow generation superseded by a newer materialization');
      if (!hasBoundIndex(ctx) && shadowSlab === null) throw new Error('vector plugin has no shadow slab to commit');
      const prevActive = currentActiveGeneration(ctx);
      await activateGeneration(ctx, promoted);
      promotedGen = promoted; promotedFromGen = prevActive; buildingGen = null;
    },
    async rollbackShadow(ctx) {
      if (promotedGen === null) return;
      const rolledBack = promotedGen;
      if (hasBoundIndex(ctx)) {
        const stateRow = readPersistedState(ctx), prevGen = stateRow?.previous ?? promotedFromGen ?? 0;
        const prevManifest = readGenerationManifest(ctx, prevGen);
        const prevModel = prevManifest?.model ?? modelSpace.model, prevDimensions = prevManifest?.dimensions ?? modelSpace.dimensions;
        const statements                                                                   = [{
          sql: `UPDATE ${stateTable} SET active = previous, model = ?, dimensions = ? WHERE slot = 'active'`,
          params: [prevModel, prevDimensions],
        }];
        if (hasManifestTable(ctx)) {
          if (prevManifest !== null) statements.push(manifestUpsertStatement(Object.freeze({ ...prevManifest, status: 'active' })));
          const rolledManifest = readGenerationManifest(ctx, rolledBack);
          if (rolledManifest !== null && rolledBack !== prevGen) statements.push(manifestUpsertStatement(Object.freeze({ ...rolledManifest, status: 'ready' })));
        }
        await ctx.index.write({ expectedFence: ctx.fence, statements });
        if (prevManifest !== null) manifests[prevGen] = Object.freeze({ ...prevManifest, status: 'active' });
        if (manifests[rolledBack] !== null && rolledBack !== prevGen) manifests[rolledBack] = Object.freeze({ ...manifests[rolledBack] , status: 'ready' });
        activeGen = prevGen;
      } else if (previousSlab !== null) { activeSlab = previousSlab; previousSlab = null; }
      promotedGen = null; promotedFromGen = null;
    },
    async abortShadow(ctx) {
      if (shadowSlab === null && buildingGen === null) return;
      const discarded = buildingGen;
      shadowSlab = null; buildingGen = null;
      if (discarded !== null) { await clearTable(ctx, tables[discarded], true); await deleteGenerationManifest(ctx, discarded); }
    },
    health(ctx) {
      const bound = hasBoundIndex(ctx), persisted = bound ? readPersistedState(ctx) : null, active = persisted?.active ?? activeGen;
      const vectors = bound ? (persisted === null ? 0 : countTable(ctx, tables[persisted.active])) : activeSlab.size;
      const otherManifest = readGenerationManifest(ctx, active === 0 ? 1 : 0);
      const staging = otherManifest !== null && otherManifest.status === 'staging' ? otherManifest : null;
      return Object.freeze({
        generationIdentity: generationIdentity(modelSpace, sequence), modelSpace,
        // The space the retained generation actually holds; differs from
        // `modelSpace` only while a declared change is not yet materialized.
        activeSpace: persisted === null || materializedInDeclaredSpace(ctx) ? modelSpace : { model: persisted.model, dimensions: persisted.dimensions },
        vectors, ...(staging !== null ? { staging } : {}),
      });
    },
  };
  return Object.freeze(plugin);
}
