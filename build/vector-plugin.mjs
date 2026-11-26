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
    super(message);
    this.name = 'VectorPluginValidationError';
    this.code = code;
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
  const vector = new Float32Array(copy);
  for (let i = 0; i < vector.length; i += 1) {
    if (!Number.isFinite(vector[i])) {
      throw new VectorPluginValidationError('non-finite-value', 'persisted vector BLOB contains a non-finite value');
    }
  }
  return vector;
}
function scopeValueOf(row                                   , scopeField                    )         {
  if (scopeField === undefined) return '';
  const value = row[scopeField];
  return value === null || value === undefined ? '' : String(value);
}
function assertFieldName(value         , label        )                          {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new TypeError(`vector plugin ${label} must be a SQLite identifier`);
  }
}
function cellValue(value         )                {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
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
    try {
      owned = parent.owns(row) === true;
    } catch {
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
    id: match.id,
    score: match.score,
    sourceId: String(segmentRow[parent.field]),
    segmentId: parent.segmentIdField === undefined ? match.id : segmentRow[parent.segmentIdField],
    projectId: parentFence.projectId,
    sourceRevision: parentFence.revision,
    // Re-admit the CURRENT parent, not the segment key.
    authorizationEntity: parent.entity,
    authorizationRowId: String(segmentRow[parent.field]),
  });
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
function compareIds(a        , b        )         {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}


function compareScoredMatches(a             , b             )         {
  if (a.score > b.score) return -1;
  if (a.score < b.score) return 1;
  return compareIds(a.id, b.id);
}
function createBoundedTopK(limit        )                                                                             {
  const heap                = [];
  const push = (candidate             )       => {
    heap.push(candidate);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (compareScoredMatches(heap[child], heap[parent]) <= 0) break;
      const tmp = heap[child];
      heap[child] = heap[parent];
      heap[parent] = tmp;
      child = parent;
    }
  };
  const replaceWorst = (candidate             )       => {
    heap[0] = candidate;
    let parent = 0;
    while (true) {
      const left = (parent << 1) + 1;
      const right = left + 1;
      let worst = parent;
      if (left < heap.length && compareScoredMatches(heap[left], heap[worst]) > 0) worst = left;
      if (right < heap.length && compareScoredMatches(heap[right], heap[worst]) > 0) worst = right;
      if (worst === parent) return;
      const tmp = heap[parent];
      heap[parent] = heap[worst];
      heap[worst] = tmp;
      parent = worst;
    }
  };
  return {
    offer(candidate) {
      if (heap.length < limit) push(candidate);
      else if (compareScoredMatches(candidate, heap[0]) < 0) replaceWorst(candidate);
    },
    results() {
      return heap.sort(compareScoredMatches);
    },
  };
}
function yieldToEventLoop()                {
  return new Promise      ((resolve) => setTimeout(resolve, 0));
}




function resolveScopeFilter(
  scopeField                    ,
  request               ,
  query                   ,
)                      {
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
  return { predicate: scope };
}
export function createVectorPlugin(options                     )               {
  if (typeof options.source.owns !== 'function') {
    throw new TypeError('vector plugin source requires an ownership predicate');
  }
  const scopeField = options.source.scopeField;
  if (scopeField !== undefined && !IDENTIFIER.test(scopeField)) {
    throw new TypeError('vector plugin scopeField must be a SQLite identifier');
  }
  const parent = options.source.parent;
  if (parent !== undefined) {
    if (parent === null || typeof parent !== 'object') throw new TypeError('vector plugin parent must be a declaration object');
    const fields = {
      entity: parent.entity, field: parent.field, revisionField: parent.revisionField,
      projectField: parent.projectField, parentRevisionField: parent.parentRevisionField,
      parentProjectField: parent.parentProjectField,
    };
    for (const [label, value] of Object.entries(fields)) assertFieldName(value, `parent ${label}`);
    if (parent.entity === options.source.entity) throw new TypeError('vector plugin parent entity must differ from the segment source entity');
    if (parent.owns !== undefined && typeof parent.owns !== 'function') throw new TypeError('vector plugin parent ownership predicate must be a function');
    if (parent.segmentIdField !== undefined) assertFieldName(parent.segmentIdField, 'parent segmentIdField');
  }
  if (options.admission !== undefined && (
    options.admission === null || typeof options.admission !== 'object' ||
    typeof options.admission.adapter?.admit !== 'function'
  )) {
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
  const tables = [`${base}_g0`, `${base}_g1`]         ;
  // Existing persistent indexes predate the derived-segment fence columns, and
  // the owned-index capability cannot ALTER a table. An ORDINARY source
  // therefore keeps writing the four columns it always wrote (an extra column
  // from an intermediate build is ignored by explicit column lists, so both
  // shapes read and write); only a derived source persists the fence.
  const vectorColumns = parent === undefined
    ? 'source_key, scope_id, norm, embedding'
    : 'source_key, scope_id, norm, embedding, parent_key, revision, project_key';
  const upsertSql = (table        ) => `INSERT OR REPLACE INTO ${table} (${vectorColumns}) VALUES (?, ?, ?, ?${parent === undefined ? '' : ', ?, ?, ?'})`;
  const upsertParams = (entry                                                                                                                                                    )                     => parent === undefined
    ? [entry.id, entry.scopeId, entry.norm, float32ToBlob(entry.vector)]
    : [entry.id, entry.scopeId, entry.norm, float32ToBlob(entry.vector), entry.fence?.parentId ?? '', entry.fence?.revision ?? '', entry.fence?.projectId ?? ''];
  let activeGen        = 0;
  let buildingGen               = null;
  let promotedGen               = null;
  let activeSlab = new Float32VectorSlab(modelSpace.dimensions);
  let shadowSlab                           = null;
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
    const row = ctx.index.query({ sql: `SELECT active, model, dimensions FROM ${stateTable} WHERE slot = 'active'` })[0];
    if (!row) return null;
    return { active: row.active === 1 ? 1 : 0, model: String(row.model ?? ''), dimensions: Number(row.dimensions ?? 0) };
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
  function materializedInDeclaredSpace(ctx                     )          {
    const persisted = readPersistedState(ctx);
    return persisted === null || (persisted.model === modelSpace.model && persisted.dimensions === modelSpace.dimensions);
  }
  function countTable(ctx                     , table        )         {
    const row = ctx.index.query({ sql: `SELECT COUNT(*) AS count FROM ${table}` })[0];
    return Number(row?.count ?? 0);
  }
  function tableBoundaryIds(ctx                     , table        , count        )                    {
    if (count === 0) return [];
    const keys = (order                , limit        ) => ctx.index.query({
      sql: `SELECT source_key FROM ${table} ORDER BY source_key ${order} LIMIT ${limit}`,
    }).map((row) => String(row.source_key));
    if (count <= CENSUS_BOUNDARY_SAMPLE * 2) return keys('ASC', CENSUS_BOUNDARY_SAMPLE * 2);
    return [...keys('ASC', CENSUS_BOUNDARY_SAMPLE), ...keys('DESC', CENSUS_BOUNDARY_SAMPLE)];
  }
  // One page of the plugin's OWN generation table, walking `source_key` in key
  // order. Explicit column lists keep an ordinary index readable whether its
  // table predates the fence columns or carries them unused.
  function persistedPage(ctx                     , table        , columns        , afterKey                    , scopeId         ) {
    const clauses           = [];
    const params            = [];
    if (scopeId !== undefined) { clauses.push('scope_id = ?'); params.push(scopeId); }
    if (afterKey !== undefined) { clauses.push('source_key > ?'); params.push(afterKey); }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    return ctx.index.query({
      sql: `SELECT ${columns} FROM ${table}${where} ORDER BY source_key ASC LIMIT ${PERSISTED_SCAN_PAGE_SIZE}`,
      params,
    });
  }
  function scorePersistedRow(queryVec              , queryNorm        , row                                   , dimensions        )                     {
    let vector              ;
    try {
      vector = blobToFloat32(row.embedding, dimensions);
    } catch {
      return null;
    }
    const storedNorm = row.norm;
    const norm = typeof storedNorm === 'number' && Number.isFinite(storedNorm) ? storedNorm : vectorNorm(vector);
    const score = cosineSimilarityFloat32(queryVec, queryNorm, vector, norm);
    if (!Number.isFinite(score)) return null;
    const parentKey = typeof row.parent_key === 'string' && row.parent_key.length > 0 ? row.parent_key : null;
    const fence = parentKey === null ? undefined : { parentId: parentKey, revision: String(row.revision ?? ''), projectId: String(row.project_key ?? '') };
    return { id: String(row.source_key), score, fence };
  }
  // The one walk over the plugin's declared source entity. Every full-corpus
  // reader (rebuild, predicate scan, collected keys) pages through here, so the
  // id cursor and its no-progress guard exist exactly once.
  async function* sourcePages(ctx                     )                                                     {
    let afterId                    ;
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
  async function scanPersistedPredicate(ctx                     , table        , predicate                                   , queryVec              , queryNorm        , topK                                         , signal                         , dimensions        )                   {
    let pages = 0;
    for await (const page of sourcePages(ctx)) {
      if (signal?.aborted) return false;
      const ids           = [];
      for (const row of page) {
        if (typeof row.id === 'string' && row.id.length > 0 && matchesScope(row, predicate)) ids.push(row.id);
      }
      for (let offset = 0; offset < ids.length; offset += PERSISTED_LOOKUP_CHUNK) {
        if (signal?.aborted) return false;
        const chunk = ids.slice(offset, offset + PERSISTED_LOOKUP_CHUNK);
        const placeholders = chunk.map(() => '?').join(', ');
        const rows = ctx.index.query({
          sql: `SELECT ${vectorColumns} FROM ${table} WHERE source_key IN (${placeholders}) LIMIT ${PERSISTED_LOOKUP_CHUNK}`,
          params: chunk,
        });
        for (const row of rows) {
          const scored = scorePersistedRow(queryVec, queryNorm, row, dimensions);
          if (scored !== null) topK.offer(scored);
        }
      }
      pages += 1;
      if (pages % PERSISTED_YIELD_PAGES === 0) await yieldToEventLoop();
    }
    return true;
  }
  async function scanPersistedMatches(ctx                     , table        , queryVec              , queryNorm        , limit        , filter                     , signal                         , dimensions        )                                  {
    const topK = createBoundedTopK(limit);
    if (filter.predicate !== undefined) {
      const completed = await scanPersistedPredicate(ctx, table, filter.predicate, queryVec, queryNorm, topK, signal, dimensions);
      return completed ? topK.results() : [];
    }
    let afterKey                    ;
    let pages = 0;
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
      pages += 1;
      if (pages % PERSISTED_YIELD_PAGES === 0) {
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
      for (const row of rows) {
        const vector = blobToFloat32(row.embedding, dimensions);
        for (let i = 0; i < vector.length; i += 1) {
          if (!Number.isFinite(vector[i])) {
            throw new Error(`vector '${String(row.source_key)}' contains a non-finite value`);
          }
        }
      }
      if (rows.length < PERSISTED_SCAN_PAGE_SIZE) break;
      afterKey = String(rows[rows.length - 1].source_key);
    }
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
  function parseAndValidateRow(row                                   )                                                                                                                                                     {
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
    const fence = parent === undefined ? null : segmentFence(row, parent);
    if (parent !== undefined && fence === null) throw new VectorPluginValidationError('invalid-derived-segment', `vector source '${id}' is missing its parent revision fence`);
    return { id, scopeId: scopeValueOf(row, scopeField), vector, norm, fence };
  }
  async function flushUpserts(ctx                     , table        , entries                                                                                                                                                               )                {
    if (!hasBoundIndex(ctx) || entries.length === 0) return;
    const sql = upsertSql(table);
    for (let offset = 0; offset < entries.length; offset += MAX_WRITE_STATEMENTS) {
      if (isSuperseded(ctx)) return;
      const statements = entries.slice(offset, offset + MAX_WRITE_STATEMENTS).map((entry) => ({
        sql,
        params: upsertParams(entry),
      }));
      await ctx.index.write({ expectedFence: ctx.fence, statements });
    }
  }
  function materializedCount(ctx                     )         {
    if (hasBoundIndex(ctx)) return countTable(ctx, targetTable(ctx));
    return targetSlab().size;
  }
  async function rebuild(ctx                     )                                   {
    const persistent = hasBoundIndex(ctx);
    if (!claimGeneration(ctx)) return { counts: { vectors: materializedCount(ctx) } };
    const shadowActive = buildingGen !== null;
    const active = currentActiveGeneration(ctx);
    const activeIsEmpty = persistent && countTable(ctx, tables[active]) === 0;
    const destination        = buildingGen ?? (activeIsEmpty ? active : (active === 0 ? 1 : 0));
    const table = tables[destination];
    const next = persistent ? null : (shadowSlab ?? new Float32VectorSlab(modelSpace.dimensions));
    if (next !== null) {
      next.clear();
      shadowSlab = next;
    }
    await clearTable(ctx, table, true);
    try {
      for await (const page of sourcePages(ctx)) {
        if (isSuperseded(ctx)) break;
        const parsedPage                                                                                                                                                       = [];
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
        await flushUpserts(ctx, table, parsedPage);
      }
    } catch (err) {
      if (!isSuperseded(ctx)) {
        next?.clear();
        await clearTable(ctx, table, true);
      }
      throw err;
    }
    if (!shadowActive && !isSuperseded(ctx)) {
      if (persistent) {
        const previous = currentActiveGeneration(ctx);
        await ctx.index.write({
          expectedFence: ctx.fence,
          statements: [{
            sql: `INSERT INTO ${stateTable} (slot, active, previous, model, dimensions) VALUES ('active', ?, ?, ?, ?) ON CONFLICT(slot) DO UPDATE SET previous = excluded.previous, active = excluded.active, model = excluded.model, dimensions = excluded.dimensions`,
            params: [destination, previous, modelSpace.model, modelSpace.dimensions],
          }],
        });
        activeGen = destination;
      } else {
        activeSlab = next ;
        shadowSlab = null;
      }
    }
    return {
      counts: {
        vectors: persistent
          ? countTable(ctx, tables[currentActiveGeneration(ctx)])
          : (shadowActive ? next .size : activeSlab.size),
      },
    };
  }
  async function reconcile(ctx                     , changes                         )                                   {
    const persistent = hasBoundIndex(ctx);
    const next = persistent ? null : targetSlab();
    if (!claimGeneration(ctx)) return { counts: { vectors: materializedCount(ctx) } };
    // A parent change can move the project/revision fence, or remove the parent
    // entirely. Purge that parent's vectors from BOTH generations BEFORE the
    // rebuild, so a normal removal cannot leave readable bytes in the retained
    // generation that only a current-parent check happens to hide.
    if (parent !== undefined && changes.some((change) => change.entity === parent.entity)) {
      for (const change of changes) {
        if (change.entity === parent.entity) await purgeRows(ctx, 'parent_key = ?', [change.rowId]);
      }
      return rebuild(ctx);
    }
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
    const removeFromEveryGeneration = (rowId        )       => { for (const generationTable of tables) statements.push({ sql: `DELETE FROM ${generationTable} WHERE source_key = ?`, params: [rowId] }); };
    for (const change of changes) {
      if (change.entity !== options.source.entity) continue;
      if (change.kind === 'removed') {
        next?.delete(change.rowId);
        removeFromEveryGeneration(change.rowId);
        continue;
      }
      const row = ctx.reader.row(options.source.entity, change.rowId);
      if (row === undefined) {
        next?.delete(change.rowId);
        removeFromEveryGeneration(change.rowId);
      } else {
        try {
          if (parent !== undefined) {
            const fence = segmentFence(row, parent);
            if (fence === null || parentFenceOf(ctx, parent, fence) === null) {
              next?.delete(change.rowId);
              removeFromEveryGeneration(change.rowId);
              continue;
            }
          }
          const parsed = parseAndValidateRow(row);
          next?.set(parsed.id, parsed.vector, parsed.norm, parsed.scopeId);
          statements.push({ sql: upsertSql(table), params: upsertParams(parsed) });
        } catch (err) {
          if (err instanceof VectorPluginValidationError && err.code === 'unauthorized-source-ownership') {
            next?.delete(change.rowId);
            removeFromEveryGeneration(change.rowId);
            await flushStatements();
          }
          throw err;
        }
      }
    }
    await flushStatements();
    return { counts: { vectors: next === null ? countTable(ctx, table) : next.size } };
  }
  async function purgeRows(ctx                     , where        , params                    )                {
    if (!hasBoundIndex(ctx) || isSuperseded(ctx)) return;
    await ctx.index.write({ expectedFence: ctx.fence, statements: tables.map((generationTable) => ({ sql: `DELETE FROM ${generationTable} WHERE ${where}`, params })) });
  }
  async function revoke(ctx                     , target                        )                                   {
    const persistent = hasBoundIndex(ctx);
    const next = persistent ? null : targetSlab();
    if (!claimGeneration(ctx)) {
      return { counts: { vectors: materializedCount(ctx) } };
    }
    if (parent !== undefined && target.entity === parent.entity) {
      if (target.rowId !== undefined) await purgeRows(ctx, 'parent_key = ?', [target.rowId]);
      if (target.scopeId !== undefined) await purgeRows(ctx, 'project_key = ?', [target.scopeId]);
      return rebuild(ctx);
    }
    if (target.entity !== options.source.entity) {
      return { counts: { vectors: materializedCount(ctx) } };
    }
    const table = targetTable(ctx);
    if (target.scopeId !== undefined) {
      next?.deleteScope(target.scopeId);
      await purgeRows(ctx, 'scope_id = ?', [target.scopeId]);
    } else if (target.rowId !== undefined) {
      next?.delete(target.rowId);
      await purgeRows(ctx, 'source_key = ?', [target.rowId]);
    }
    return { counts: { vectors: next === null ? countTable(ctx, table) : next.size } };
  }
  async function collectAllowedKeys(ctx                     , predicate                                   )                               {
    const allowed = new Set        ();
    for await (const page of sourcePages(ctx)) {
      for (const row of page) {
        if (typeof row.id === 'string' && matchesScope(row, predicate)) allowed.add(row.id);
      }
    }
    return allowed;
  }
  // Re-read the current segment and parent; index-time authorization is never trusted.
  function searchCandidate(ctx                     , match             )                               {
    const row = ctx.reader.row(options.source.entity, match.id);
    if (row === undefined) return null;
    if (parent === undefined) {
      return { hit: Object.freeze({ id: match.id, score: match.score }), key: match.id, rank: match.score, row };
    }
    let owned = false;
    try {
      owned = options.source.owns(row) === true;
    } catch {
      owned = false;
    }
    const fence = owned ? segmentFence(row, parent) : null;
    const stale = hasBoundIndex(ctx) && (match.fence === undefined || fence === null || match.fence.parentId !== fence.parentId || match.fence.revision !== fence.revision || match.fence.projectId !== fence.projectId);
    const parentFence = fence === null || stale ? null : parentFenceOf(ctx, parent, fence, true);
    return parentFence === null
      ? null
      : { hit: derivedHit(match, row, parentFence, parent), key: match.id, rank: match.score, row: parentFence.row };
  }
  // Derived hits consume the window only after current-parent admission; refill on denial.
  async function search(ctx                     , request               )                                    {
    if (request.signal?.aborted) return { hits: [] };
    if (request.principal === undefined) throw new VectorPluginValidationError('unauthorized-source-ownership', 'vector search requires a principal for result admission');
    const query = request.query                     ;
    const bound = hasBoundIndex(ctx);
    const persisted = bound ? readPersistedState(ctx) : null;
    // Two spaces may be served: the DECLARED space once materialized, and the
    // retained ACTIVE generation's own space while a declared change is still
    // being built (the rollback window). A query never mixes them — it is
    // answered from exactly one generation, or refused.
    const space = query?.model === modelSpace.model
      ? modelSpace
      : persisted !== null && query?.model === persisted.model
        ? { model: persisted.model, dimensions: persisted.dimensions }
        : null;
    if (space === null) {
      throw new VectorPluginValidationError(
        'model-space-mismatch',
        `vector query has model '${String(query?.model)}'; generation requires '${modelSpace.model}'`,
      );
    }
    const { vector: queryVec, norm: queryNorm } = validateVectorToFloat32(query?.vector, query?.model, space, 'query');
    const declared = space.model === modelSpace.model && space.dimensions === modelSpace.dimensions;
    if (declared && persisted !== null && (persisted.model !== space.model || persisted.dimensions !== space.dimensions)) {
      return { hits: [] };
    }
    const generation = declared ? currentActiveGeneration(ctx) : persisted .active;
    const filter = resolveScopeFilter(scopeField, request, query);
    const requested = typeof request.limit === 'number' && Number.isFinite(request.limit) ? Math.floor(request.limit) : SEARCH_MAX_RESULTS_CAP;
    const limit = Math.max(1, requested);
    const total = bound ? countTable(ctx, tables[generation]) : activeSlab.size;
    const staleness = ctx.state !== undefined ? searchStalenessOf(ctx.state) : 'stale';
    let candidateLimit = limit;
    for (;;) {
      let matches                        ;
      if (bound) {
        matches = await scanPersistedMatches(ctx, tables[generation], queryVec, queryNorm, candidateLimit, filter, request.signal, space.dimensions);
      } else {
        const allowedKeys = filter.predicate !== undefined ? await collectAllowedKeys(ctx, filter.predicate) : undefined;
        const poolSize = filter.scopeId !== undefined
          ? activeSlab.slotsForScope(filter.scopeId).length
          : allowedKeys !== undefined ? allowedKeys.size : activeSlab.size;
        if (poolSize === 0) return { hits: [] };
        matches = await activeSlab.topKInterruptibly(queryVec, queryNorm, Math.min(candidateLimit, poolSize), {
          scopeId: filter.scopeId,
          allowedKeys,
          signal: request.signal,
        });
      }
      if (request.signal?.aborted) return { hits: [] };
      const candidates                          = [];
      for (const match of matches) {
        const candidate = searchCandidate(ctx, match);
        if (candidate !== null) candidates.push(candidate);
      }
      const hits                                      = [];
      if (options.admission) {
        const admitted = await admitSearchHits(options.admission.adapter, {
          pluginId: options.id,
          generation: ctx.generation,
          staleness,
          principal: request.principal,
          candidates,
        });
        for (const result of admitted.hits) hits.push(result.hit);
      } else if (options.unsafeAllowUnauthorizedSearch === true) {
        for (const candidate of candidates) hits.push(candidate.hit);
      } else {
        throw new VectorPluginValidationError(
          'unauthorized-source-ownership',
          'vector search requires a search admission adapter to re-authorize result rows',
        );
      }
      // Admission is part of the index's output contract for EVERY source, not
      // just derived ones: a denied ordinary candidate must not shorten the
      // page while lower-ranked authorized candidates remain.
      if (hits.length >= limit || matches.length < candidateLimit || candidateLimit >= total) {
        return { hits };
      }
      candidateLimit = Math.min(total, candidateLimit * 2);
    }
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
        ddl: [`CREATE TABLE IF NOT EXISTS ${name} (source_key TEXT PRIMARY KEY, scope_id TEXT NOT NULL DEFAULT '', norm REAL NOT NULL, embedding BLOB NOT NULL${parent === undefined ? '' : ", parent_key TEXT NOT NULL DEFAULT '', revision TEXT NOT NULL DEFAULT '', project_key TEXT NOT NULL DEFAULT ''"});`],
      })),
      ...tables.map((name) => ({
        kind: 'index'         ,
        name: `${name}_scope_idx`,
        disposition: { kind: 'schema-only'          },
        ddl: [`CREATE INDEX IF NOT EXISTS ${name}_scope_idx ON ${name} (scope_id);`],
      })),
    ]),
    sourceInterests: Object.freeze([
      { entity: options.source.entity },
      ...(parent !== undefined ? [{ entity: parent.entity }] : []),
    ]),
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
    },
    stalenessKey(change) {
      if (change.entity === options.source.entity) return `${change.entity}:${change.rowId}`;
      if (parent !== undefined && change.entity === parent.entity) return `${change.entity}:${change.rowId}`;
      return null;
    },
    async prepare(ctx) {
      if (!hasBoundIndex(ctx)) return;
      // A DERIVED source needs the fence columns. An owned-index statement
      // cannot ALTER a table, so an index created before the derived schema has
      // to be rebuilt rather than silently failing on its first write. Refuse
      // at boot with the exact table and a next step.
      if (parent !== undefined) {
        for (const table of tables) {
          try {
            ctx.index.query({ sql: `SELECT parent_key FROM ${table} LIMIT 1` });
          } catch {
            throw new Error(`vector plugin '${options.id}' needs a derived-segment index rebuild: ${table} predates the segment fence schema (drop it, or register a new plugin id, then rebuild)`);
          }
        }
      }
      await ctx.index.write({
        expectedFence: ctx.fence,
        statements: [{
          sql: `INSERT OR IGNORE INTO ${stateTable} (slot, active, previous, model, dimensions) VALUES ('active', 0, 0, ?, ?)`,
          params: [modelSpace.model, modelSpace.dimensions],
        }],
      });
    },
    validate(ctx) {
      if (!hasBoundIndex(ctx)) {
        targetSlab().validateFinite();
        return;
      }
      // Validate the generation that is actually served, in ITS OWN space: a
      // retained generation predates the declared model space.
      const persisted = readPersistedState(ctx);
      validatePersistedTable(
        ctx,
        persisted === null ? targetTable(ctx) : tables[persisted.active],
        persisted === null ? modelSpace.dimensions : persisted.dimensions,
      );
    },
    reconcile,
    revoke,
    rebuild,
    search,
    async beginShadow(ctx) {
      claimGeneration(ctx);
      const nextGen        = currentActiveGeneration(ctx) === 0 ? 1 : 0;
      buildingGen = nextGen;
      if (hasBoundIndex(ctx)) {
        await clearTable(ctx, tables[nextGen]);
      } else {
        shadowSlab = new Float32VectorSlab(modelSpace.dimensions);
      }
    },
    indexCensus(ctx)               {
      if (hasBoundIndex(ctx)) {
        const table = targetTable(ctx);
        const count = countTable(ctx, table);
        return Object.freeze({
          [options.source.entity]: boundaryKeyCensus(count, tableBoundaryIds(ctx, table, count)),
        });
      }
      const slab = targetSlab();
      return Object.freeze({
        [options.source.entity]: boundaryKeyCensus(slab.size, slab.boundaryIds(CENSUS_BOUNDARY_SAMPLE)),
      });
    },
    sourceCensus(ctx)               {
      // Parity counts only the currently fenced projection, not raw segment rows.
      if (parent !== undefined) {
        let count = 0;
        const head           = [];
        const tail           = [];
        let afterId                    ;
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
        const boundary = [...head, ...tail.slice(-CENSUS_BOUNDARY_SAMPLE)];
        return Object.freeze({ [options.source.entity]: boundaryKeyCensus(count, boundary) });
      }
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
      const promoted = buildingGen;
      if (promoted === null) throw new Error('vector plugin has no shadow generation to commit');
      if (isSuperseded(ctx)) throw new Error('vector shadow generation superseded by a newer materialization');
      const nextGen = promoted;
      if (hasBoundIndex(ctx)) {
        await ctx.index.write({
          expectedFence: ctx.fence,
          statements: [{
            sql: `UPDATE ${stateTable} SET previous = active, active = ?, model = ?, dimensions = ? WHERE slot = 'active'`,
            params: [nextGen, modelSpace.model, modelSpace.dimensions],
          }],
        });
        activeGen = nextGen;
      } else {
        if (shadowSlab === null) throw new Error('vector plugin has no shadow slab to commit');
        activeSlab = shadowSlab;
        shadowSlab = null;
      }
      promotedGen = nextGen;
      buildingGen = null;
    },
    async rollbackShadow(ctx) {
      if (promotedGen === null) return;
      if (hasBoundIndex(ctx)) {
        await ctx.index.write({
          expectedFence: ctx.fence,
          statements: [{ sql: `UPDATE ${stateTable} SET active = previous WHERE slot = 'active'` }],
        });
        currentActiveGeneration(ctx);
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
      const persisted = hasBoundIndex(ctx) ? readPersistedState(ctx) : null;
      const bound = hasBoundIndex(ctx);
      const vectors = bound
        ? (persisted === null ? 0 : countTable(ctx, tables[persisted.active]))
        : activeSlab.size;
      return Object.freeze({
        generationIdentity: generationIdentity(modelSpace, sequence),
        modelSpace,
        // The space the retained generation actually holds; differs from
        // `modelSpace` only while a declared change is not yet materialized.
        activeSpace: persisted === null || materializedInDeclaredSpace(ctx)
          ? modelSpace
          : { model: persisted.model, dimensions: persisted.dimensions },
        vectors,
      });
    },
  };
  return Object.freeze(plugin);
}
