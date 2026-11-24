// vector-plugin.ts — model-space-aware, persistent Float32Array vector search plugin.
//
// Embeddings are supplied by the application's worker in source rows. This
// plugin stores compact Float32 BLOBs + precomputed L2 norms + optional
// scope_id in census-owned SQLite tables (`vec_...`).
//
// A BOUND index is served from disk: every search applies its scope filter in
// SQL (scope_id equality, or a source-key IN/merge when the caller filters on
// arbitrary source columns) and pages the surviving candidates in bounded
// windows, retaining only one page plus the requested top-K in JS heap. The
// full table is never materialized as a resident slab — including during a
// shadow rebuild, which builds directly into the disposable generation table.
//
// An UNBOUND owned-index capability (registries/harnesses with no durable
// tables) keeps the in-memory Float32VectorSlab path unchanged.

import { createHash } from 'node:crypto';
import { Float32VectorSlab, cosineSimilarityFloat32, vectorNorm } from './vector.ts';
import {
  SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
  type SearchChange,
  type SearchMaterializeResult,
  type SearchPlugin,
  type SearchPluginContext,
  type SearchPluginSearchResult,
  type SearchRequest,
  type SearchRevocationTarget,
} from './search-plugin.ts';
import { type SearchCensus, type SearchEntityCensus, type SearchShadowCapabilities } from './search-reconcile.ts';
import { admitSearchHits } from './search-auth.ts';
import { SEARCH_MAX_RESULTS_CAP, searchStalenessOf } from './search-response.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import type { EntityRecord } from './row-grant.ts';

export type VectorPluginValidationCode =
  | 'dimension-mismatch'
  | 'non-finite-value'
  | 'model-space-mismatch'
  | 'unauthorized-source-ownership'
  | 'invalid-vector';

export class VectorPluginValidationError extends Error {
  readonly code: VectorPluginValidationCode;

  constructor(code: VectorPluginValidationCode, message: string) {
    super(message);
    this.name = 'VectorPluginValidationError';
    this.code = code;
  }
}

export interface VectorModelSpace {
  readonly model: string;
  readonly dimensions: number;
}

export interface VectorPluginSource {
  readonly entity: string;
  readonly vector: string;
  readonly model: string;
  // Optional source column stored as `scope_id` for O(1) SQL pre-filtering
  // before any vector is fetched or scored (e.g. 'projectId').
  readonly scopeField?: string;
  // The source reader only constrains declared table scopes. Every vector source
  // must additionally prove that each row belongs to this plugin's index.
  readonly owns: (row: Readonly<Record<string, unknown>>) => boolean;
}

export interface VectorPluginOptions {
  readonly id: string;
  readonly version: string;
  readonly source: VectorPluginSource;
  readonly modelSpace: VectorModelSpace;
  readonly admission?: { readonly entity: EntityRecord; readonly adapter: AuthorizationAdapter };
  // Escape hatch for LOW-LEVEL UNIT FIXTURES ONLY (never a production app):
  // return raw candidate hits without re-authorizing each row through an
  // admission adapter. The default fails closed — an index whose hits cannot be
  // re-authorized returns no disclosure. A fixture that only exercises query /
  // ranking mechanics opts in explicitly so the insecure path is visible.
  readonly unsafeAllowUnauthorizedSearch?: boolean;
}

export interface VectorSearchQuery {
  readonly model: string;
  readonly vector: readonly number[] | Float32Array;
  // A source-row equality predicate or scope string applied to the index BEFORE
  // nearest-neighbour selection, so a caller's window (limit/offset) is served
  // from the matching partition instead of the whole index.
  readonly scope?: string | Readonly<Record<string, unknown>>;
  readonly scopeId?: string;
}

export interface VectorPlugin extends SearchPlugin, SearchShadowCapabilities {
  readonly generationIdentity: string;
  readonly modelSpace: VectorModelSpace;
  validateSourceRow(row: Readonly<Record<string, unknown>>): void;
  setModelSpace(modelSpace: VectorModelSpace): void;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_WRITE_STATEMENTS = 128;
const SOURCE_PAGE_SIZE = 512;
const DELETE_CHUNK_SIZE = 500;
const CENSUS_BOUNDARY_SAMPLE = 32;
// Bounded page for disk-backed vector scans: 512 rows of a 1536-dimension
// Float32 vector is ~3 MiB, independent of index size.
const PERSISTED_SCAN_PAGE_SIZE = 512;
// Bounded lookup chunk for the arbitrary-predicate fallback.
const PERSISTED_LOOKUP_CHUNK = 256;
// Cooperative yield cadence between persisted pages so abort/deadline can act.
const PERSISTED_YIELD_PAGES = 8;

function assertModelSpace(modelSpace: VectorModelSpace): void {
  if (typeof modelSpace.model !== 'string' || modelSpace.model.length === 0) {
    throw new TypeError('vector model-space requires a non-empty model identity');
  }
  if (!Number.isSafeInteger(modelSpace.dimensions) || modelSpace.dimensions < 1) {
    throw new TypeError('vector model-space dimensions must be a positive safe integer');
  }
}

function generationIdentity(modelSpace: VectorModelSpace, sequence: number): string {
  return `${modelSpace.model}:${modelSpace.dimensions}:${sequence}`;
}

function validateScope(scope: unknown): string | Readonly<Record<string, unknown>> | undefined {
  if (scope === undefined) return undefined;
  if (typeof scope === 'string') return scope;
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new TypeError('vector search scope must be a source-row predicate object');
  }
  return scope as Readonly<Record<string, unknown>>;
}

function matchesScope(row: Readonly<Record<string, unknown>>, scope: Readonly<Record<string, unknown>>): boolean {
  for (const key of Object.keys(scope)) {
    if (row[key] !== scope[key]) return false;
  }
  return true;
}

function validateVectorToFloat32(
  value: unknown,
  model: unknown,
  modelSpace: VectorModelSpace,
  sourceId: string,
): { readonly vector: Float32Array; readonly norm: number } {
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

function float32ToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

function blobToFloat32(blob: unknown, dimensions: number): Float32Array {
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

function scopeValueOf(row: Readonly<Record<string, unknown>>, scopeField: string | undefined): string {
  if (scopeField === undefined) return '';
  const value = row[scopeField];
  return value === null || value === undefined ? '' : String(value);
}

function boundaryKeyCensus(count: number, boundaryIds: readonly string[]): SearchEntityCensus {
  if (count === 0) return { count: 0, digest: createHash('sha256').update('0:').digest('hex') };
  const deduped = [...new Set(boundaryIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = createHash('sha256').update(`${count}:${deduped.join('\n')}`).digest('hex');
  return { count, digest };
}

function hasBoundIndex(ctx: SearchPluginContext | undefined): boolean {
  return Boolean(ctx && ctx.index && ctx.index.bound !== false);
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// A scored source key. Higher cosine similarity ranks first; equal scores use
// the stable source key ascending, exactly like the in-memory slab scan.
interface ScoredMatch {
  readonly id: string;
  readonly score: number;
}

function compareScoredMatches(a: ScoredMatch, b: ScoredMatch): number {
  if (a.score > b.score) return -1;
  if (a.score < b.score) return 1;
  return compareIds(a.id, b.id);
}

// Bounded top-K accumulator: retains at most `limit` candidates regardless of
// how many are offered. The array root is the current worst kept candidate.
function createBoundedTopK(limit: number): { offer(candidate: ScoredMatch): void; results(): readonly ScoredMatch[] } {
  const heap: ScoredMatch[] = [];
  const push = (candidate: ScoredMatch): void => {
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
  const replaceWorst = (candidate: ScoredMatch): void => {
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

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface ResolvedScopeFilter {
  readonly scopeId?: string;
  // Arbitrary source-row equality predicate (when no persistent scope column
  // applies). The persistent path evaluates this against source pages; the
  // in-memory path reduces it to a key set.
  readonly predicate?: Readonly<Record<string, unknown>>;
}

function resolveScopeFilter(
  scopeField: string | undefined,
  request: SearchRequest,
  query: VectorSearchQuery,
): ResolvedScopeFilter {
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
  // A declared scope column (or an explicit scope_id) filters in SQL BEFORE any
  // vector is fetched or scored.
  if (scopeField !== undefined && entries.length === 1) {
    const [key, value] = entries[0];
    if (key === scopeField || key === 'scope_id') {
      return { scopeId: value === null || value === undefined ? '' : String(value) };
    }
  }
  return { predicate: scope };
}

// Creates a persistent SQLite + (unbound-only) compact Float32Array slab vector
// search plugin. A bound index pages BLOB storage in bounded windows and never
// materializes the full vector table in JS heap; an unbound index keeps the
// in-memory slab for harnesses and ephemeral use.
export function createVectorPlugin(options: VectorPluginOptions): VectorPlugin {
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
  const tables = [`${base}_g0`, `${base}_g1`] as const;

  let activeGen: 0 | 1 = 0;
  let buildingGen: 0 | 1 | null = null;
  let promotedGen: 0 | 1 | null = null;
  // The slab is only ever populated when the owned-index capability is unbound.
  // In persistent mode it stays empty (never a resident copy of the table).
  let activeSlab = new Float32VectorSlab(modelSpace.dimensions);
  let shadowSlab: Float32VectorSlab | null = null;
  let activeWriteGeneration = 0;

  function targetSlab(): Float32VectorSlab {
    return shadowSlab ?? activeSlab;
  }

  function isSuperseded(ctx: SearchPluginContext): boolean {
    return ctx.generation < activeWriteGeneration;
  }

  function claimGeneration(ctx: SearchPluginContext): boolean {
    if (ctx.generation < activeWriteGeneration) return false;
    activeWriteGeneration = ctx.generation;
    return true;
  }

  function readPersistedState(ctx: SearchPluginContext): { active: 0 | 1; model: string; dimensions: number } | null {
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

  function currentActiveGeneration(ctx: SearchPluginContext | undefined): 0 | 1 {
    if (ctx && hasBoundIndex(ctx)) {
      const persisted = readPersistedState(ctx);
      if (persisted !== null) {
        activeGen = persisted.active;
        return persisted.active;
      }
    }
    return activeGen;
  }

  function targetTable(ctx: SearchPluginContext): string {
    return tables[buildingGen ?? currentActiveGeneration(ctx)];
  }

  // Is the persisted active generation materialized for the current model
  // space? After a setModelSpace() switch the old table stops being searchable
  // until a rebuild rewrites the state row (mirrors clearing an in-memory slab).
  function persistentModelCurrent(ctx: SearchPluginContext): boolean {
    const persisted = readPersistedState(ctx);
    return persisted === null
      || (persisted.model === modelSpace.model && persisted.dimensions === modelSpace.dimensions);
  }

  function countTable(ctx: SearchPluginContext, table: string): number {
    const row = ctx.index.query({ sql: `SELECT COUNT(*) AS count FROM ${table}` })[0];
    return Number(row?.count ?? 0);
  }

  // Boundary ids for the SQL-backed census: the same head/tail sample shape the
  // source census uses, without reading vector payloads.
  function tableBoundaryIds(ctx: SearchPluginContext, table: string, count: number): readonly string[] {
    if (count === 0) return [];
    if (count <= CENSUS_BOUNDARY_SAMPLE * 2) {
      return ctx.index.query({
        sql: `SELECT source_key FROM ${table} ORDER BY source_key ASC LIMIT ${CENSUS_BOUNDARY_SAMPLE * 2}`,
      }).map((row) => String(row.source_key));
    }
    const head = ctx.index.query({
      sql: `SELECT source_key FROM ${table} ORDER BY source_key ASC LIMIT ${CENSUS_BOUNDARY_SAMPLE}`,
    }).map((row) => String(row.source_key));
    const tail = ctx.index.query({
      sql: `SELECT source_key FROM ${table} ORDER BY source_key DESC LIMIT ${CENSUS_BOUNDARY_SAMPLE}`,
    }).map((row) => String(row.source_key));
    return [...head, ...tail];
  }

  function scorePersistedRow(queryVec: Float32Array, queryNorm: number, row: Readonly<Record<string, unknown>>): ScoredMatch {
    const vector = blobToFloat32(row.embedding, modelSpace.dimensions);
    const storedNorm = row.norm;
    const norm = typeof storedNorm === 'number' && Number.isFinite(storedNorm) ? storedNorm : vectorNorm(vector);
    return { id: String(row.source_key), score: cosineSimilarityFloat32(queryVec, queryNorm, vector, norm) };
  }

  // Arbitrary-predicate fallback: drive from bounded source pages and fetch the
  // vectors for each matching id chunk. Memory stays bounded by the page/chunk,
  // never by the number of matching source rows.
  async function scanPersistedPredicate(
    ctx: SearchPluginContext,
    table: string,
    predicate: Readonly<Record<string, unknown>>,
    queryVec: Float32Array,
    queryNorm: number,
    topK: { offer(candidate: ScoredMatch): void },
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    let afterId: string | undefined;
    let pages = 0;
    while (true) {
      if (signal?.aborted) return false;
      const page = ctx.reader.rows(options.source.entity, {
        afterId,
        limit: SOURCE_PAGE_SIZE,
        order: 'asc',
      });
      if (page.length === 0) break;
      const ids: string[] = [];
      for (const row of page) {
        if (typeof row.id === 'string' && row.id.length > 0 && matchesScope(row, predicate)) {
          ids.push(row.id);
        }
      }
      for (let offset = 0; offset < ids.length; offset += PERSISTED_LOOKUP_CHUNK) {
        if (signal?.aborted) return false;
        const chunk = ids.slice(offset, offset + PERSISTED_LOOKUP_CHUNK);
        const placeholders = chunk.map(() => '?').join(', ');
        const rows = ctx.index.query({
          sql: `SELECT source_key, norm, embedding FROM ${table} WHERE source_key IN (${placeholders}) LIMIT ${PERSISTED_LOOKUP_CHUNK}`,
          params: chunk,
        });
        for (const row of rows) topK.offer(scorePersistedRow(queryVec, queryNorm, row));
      }
      if (page.length < SOURCE_PAGE_SIZE) break;
      const lastId = String(page[page.length - 1]?.id ?? '');
      if (lastId.length === 0 || (afterId !== undefined && lastId <= afterId)) break;
      afterId = lastId;
      pages += 1;
      if (pages % PERSISTED_YIELD_PAGES === 0) await yieldToEventLoop();
    }
    return true;
  }

  // Exact top-K cosine scan over bounded disk pages. The scope predicate is
  // applied in SQL before any of a page's vectors are fetched.
  async function scanPersistedMatches(
    ctx: SearchPluginContext,
    table: string,
    queryVec: Float32Array,
    queryNorm: number,
    limit: number,
    filter: ResolvedScopeFilter,
    signal: AbortSignal | undefined,
  ): Promise<readonly ScoredMatch[]> {
    const topK = createBoundedTopK(limit);
    if (filter.predicate !== undefined) {
      const completed = await scanPersistedPredicate(ctx, table, filter.predicate, queryVec, queryNorm, topK, signal);
      return completed ? topK.results() : [];
    }
    const scopeId = filter.scopeId;
    let afterKey: string | undefined;
    let pages = 0;
    while (true) {
      if (signal?.aborted) return [];
      const rows = scopeId === undefined
        ? (afterKey === undefined
          ? ctx.index.query({ sql: `SELECT source_key, norm, embedding FROM ${table} ORDER BY source_key ASC LIMIT ${PERSISTED_SCAN_PAGE_SIZE}` })
          : ctx.index.query({
            sql: `SELECT source_key, norm, embedding FROM ${table} WHERE source_key > ? ORDER BY source_key ASC LIMIT ${PERSISTED_SCAN_PAGE_SIZE}`,
            params: [afterKey],
          }))
        : (afterKey === undefined
          ? ctx.index.query({
            sql: `SELECT source_key, norm, embedding FROM ${table} WHERE scope_id = ? ORDER BY source_key ASC LIMIT ${PERSISTED_SCAN_PAGE_SIZE}`,
            params: [scopeId],
          })
          : ctx.index.query({
            sql: `SELECT source_key, norm, embedding FROM ${table} WHERE scope_id = ? AND source_key > ? ORDER BY source_key ASC LIMIT ${PERSISTED_SCAN_PAGE_SIZE}`,
            params: [scopeId, afterKey],
          }));
      if (rows.length === 0) break;
      for (const row of rows) topK.offer(scorePersistedRow(queryVec, queryNorm, row));
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

  // Page-validate persisted BLOBs (used on restart and before shadow activation)
  // without hydrating a resident slab.
  function validatePersistedTable(ctx: SearchPluginContext, table: string): void {
    let afterKey: string | undefined;
    while (true) {
      const rows = afterKey === undefined
        ? ctx.index.query({ sql: `SELECT source_key, embedding FROM ${table} ORDER BY source_key ASC LIMIT ${PERSISTED_SCAN_PAGE_SIZE}` })
        : ctx.index.query({
          sql: `SELECT source_key, embedding FROM ${table} WHERE source_key > ? ORDER BY source_key ASC LIMIT ${PERSISTED_SCAN_PAGE_SIZE}`,
          params: [afterKey],
        });
      if (rows.length === 0) break;
      for (const row of rows) {
        const vector = blobToFloat32(row.embedding, modelSpace.dimensions);
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

  async function clearTable(ctx: SearchPluginContext, table: string, allowSuperseded = false): Promise<void> {
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

  function parseAndValidateRow(row: Readonly<Record<string, unknown>>): {
    readonly id: string;
    readonly scopeId: string;
    readonly vector: Float32Array;
    readonly norm: number;
  } {
    const id = row.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new VectorPluginValidationError('unauthorized-source-ownership', 'vector source row requires a non-empty id');
    }
    let owned: boolean;
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
    ctx: SearchPluginContext,
    table: string,
    entries: readonly { readonly id: string; readonly scopeId: string; readonly vector: Float32Array; readonly norm: number }[],
  ): Promise<void> {
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

  function materializedCount(ctx: SearchPluginContext): number {
    if (hasBoundIndex(ctx)) return countTable(ctx, targetTable(ctx));
    return targetSlab().size;
  }

  async function rebuild(ctx: SearchPluginContext): Promise<SearchMaterializeResult> {
    const persistent = hasBoundIndex(ctx);
    if (!claimGeneration(ctx)) return { counts: { vectors: materializedCount(ctx) } };
    const table = targetTable(ctx);
    const next = persistent ? null : targetSlab();
    if (next !== null) next.clear();
    await clearTable(ctx, table);
    try {
      if (persistent && buildingGen === null && !isSuperseded(ctx)) {
        await ctx.index.write({
          expectedFence: ctx.fence,
          statements: [{
            sql: `INSERT INTO ${stateTable} (slot, active, previous, model, dimensions) VALUES ('active', ?, ?, ?, ?) ON CONFLICT(slot) DO UPDATE SET model = excluded.model, dimensions = excluded.dimensions`,
            params: [activeGen, activeGen, modelSpace.model, modelSpace.dimensions],
          }],
        });
      }
      let afterId: string | undefined;
      while (!isSuperseded(ctx)) {
        const page = ctx.reader.rows(options.source.entity, {
          afterId,
          limit: SOURCE_PAGE_SIZE,
          order: 'asc',
        });
        if (page.length === 0) break;
        const parsedPage: { readonly id: string; readonly scopeId: string; readonly vector: Float32Array; readonly norm: number }[] = [];
        for (const row of page) {
          const parsed = parseAndValidateRow(row);
          if (next !== null) next.set(parsed.id, parsed.vector, parsed.norm, parsed.scopeId);
          parsedPage.push(parsed);
        }
        await flushUpserts(ctx, table, parsedPage);
        if (page.length < SOURCE_PAGE_SIZE) break;
        const lastId = String(page[page.length - 1]?.id ?? '');
        if (lastId.length === 0 || (afterId !== undefined && lastId <= afterId)) break;
        afterId = lastId;
      }
    } catch (err) {
      // Do not leave a partially rebuilt direct index or shadow generation.
      if (!isSuperseded(ctx)) {
        if (next !== null) next.clear();
        await clearTable(ctx, table);
      }
      throw err;
    }
    return { counts: { vectors: next === null ? countTable(ctx, table) : next.size } };
  }

  async function reconcile(ctx: SearchPluginContext, changes: readonly SearchChange[]): Promise<SearchMaterializeResult> {
    const persistent = hasBoundIndex(ctx);
    const next = persistent ? null : targetSlab();
    if (!claimGeneration(ctx)) return { counts: { vectors: materializedCount(ctx) } };
    const table = targetTable(ctx);
    const statements: { readonly sql: string; readonly params?: readonly unknown[] }[] = [];
    const flushStatements = async (): Promise<void> => {
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
        next?.delete(change.rowId);
        statements.push({ sql: `DELETE FROM ${table} WHERE source_key = ?`, params: [change.rowId] });
        continue;
      }
      // A missing row is outside the scoped reader (or was concurrently removed),
      // so its prior indexed value must not remain searchable.
      const row = ctx.reader.row(options.source.entity, change.rowId);
      if (row === undefined) {
        next?.delete(change.rowId);
        statements.push({ sql: `DELETE FROM ${table} WHERE source_key = ?`, params: [change.rowId] });
      } else {
        try {
          const parsed = parseAndValidateRow(row);
          next?.set(parsed.id, parsed.vector, parsed.norm, parsed.scopeId);
          statements.push({
            sql: `INSERT OR REPLACE INTO ${table} (source_key, scope_id, norm, embedding) VALUES (?, ?, ?, ?)`,
            params: [parsed.id, parsed.scopeId, parsed.norm, float32ToBlob(parsed.vector)],
          });
        } catch (err) {
          if (err instanceof VectorPluginValidationError && err.code === 'unauthorized-source-ownership') {
            next?.delete(change.rowId);
            statements.push({ sql: `DELETE FROM ${table} WHERE source_key = ?`, params: [change.rowId] });
            await flushStatements();
          }
          throw err;
        }
      }
    }
    await flushStatements();
    return { counts: { vectors: next === null ? countTable(ctx, table) : next.size } };
  }

  async function revoke(ctx: SearchPluginContext, target: SearchRevocationTarget): Promise<SearchMaterializeResult> {
    const persistent = hasBoundIndex(ctx);
    const next = persistent ? null : targetSlab();
    if (target.entity !== options.source.entity || !claimGeneration(ctx)) {
      return { counts: { vectors: materializedCount(ctx) } };
    }
    const table = targetTable(ctx);
    if (target.scopeId !== undefined) {
      next?.deleteScope(target.scopeId);
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
      next?.delete(target.rowId);
      if (hasBoundIndex(ctx)) {
        await ctx.index.write({
          expectedFence: ctx.fence,
          statements: [{ sql: `DELETE FROM ${table} WHERE source_key = ?`, params: [target.rowId] }],
        });
      }
    }
    return { counts: { vectors: next === null ? countTable(ctx, table) : next.size } };
  }

  // In-memory predicate bypass: resolve matching source ids into a key set the
  // slab scan can pre-filter with. Only used by the unbound adapter.
  function collectAllowedKeys(ctx: SearchPluginContext, predicate: Readonly<Record<string, unknown>>): ReadonlySet<string> {
    const allowed = new Set<string>();
    let afterId: string | undefined;
    while (true) {
      const page = ctx.reader.rows(options.source.entity, {
        afterId,
        limit: SOURCE_PAGE_SIZE,
        order: 'asc',
      });
      if (page.length === 0) break;
      for (const row of page) {
        if (typeof row.id === 'string' && matchesScope(row, predicate)) allowed.add(row.id);
      }
      if (page.length < SOURCE_PAGE_SIZE) break;
      const lastId = String(page[page.length - 1]?.id ?? '');
      if (lastId.length === 0 || (afterId !== undefined && lastId <= afterId)) break;
      afterId = lastId;
    }
    return allowed;
  }

  async function search(ctx: SearchPluginContext, request: SearchRequest): Promise<SearchPluginSearchResult> {
    if (request.signal?.aborted) return { hits: [] };
    if (request.principal === undefined) throw new VectorPluginValidationError('unauthorized-source-ownership', 'vector search requires a principal for result admission');
    const query = request.query as VectorSearchQuery;
    const { vector: queryVec, norm: queryNorm } = validateVectorToFloat32(query?.vector, query?.model, modelSpace, 'query');
    const filter = resolveScopeFilter(scopeField, request, query);

    let matches: readonly ScoredMatch[];
    if (hasBoundIndex(ctx)) {
      if (!persistentModelCurrent(ctx)) return { hits: [] };
      const table = tables[currentActiveGeneration(ctx)];
      // The registry always supplies a bounded limit; a capped default keeps
      // top-K memory bounded even when a direct caller omits one. An empty
      // table simply yields no matches — no COUNT probe is needed first.
      const requested = typeof request.limit === 'number' && Number.isFinite(request.limit)
        ? Math.floor(request.limit)
        : SEARCH_MAX_RESULTS_CAP;
      const limit = Math.max(1, requested);
      matches = await scanPersistedMatches(ctx, table, queryVec, queryNorm, limit, filter, request.signal);
    } else {
      const allowedKeys = filter.predicate !== undefined ? collectAllowedKeys(ctx, filter.predicate) : undefined;
      const poolSize = filter.scopeId !== undefined
        ? activeSlab.slotsForScope(filter.scopeId).length
        : allowedKeys !== undefined
          ? allowedKeys.size
          : activeSlab.size;
      if (poolSize === 0) return { hits: [] };
      const requested = typeof request.limit === 'number' && Number.isFinite(request.limit) ? Math.floor(request.limit) : poolSize;
      const limit = Math.max(1, requested);
      matches = await activeSlab.topKInterruptibly(queryVec, queryNorm, limit, {
        scopeId: filter.scopeId,
        allowedKeys,
        signal: request.signal,
      });
    }
    if (request.signal?.aborted) return { hits: [] };
    const hits: Readonly<Record<string, unknown>>[] = [];
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
    } else if (options.unsafeAllowUnauthorizedSearch === true) {
      // Explicit low-level unit-fixture opt-in ONLY. No adapter means no
      // re-authorization of the current row: this path is unsafe by design and
      // must never be used by an application serving protected content.
      for (const candidate of candidates) if (candidate.row !== null) hits.push(candidate.hit);
    } else {
      // Fail closed: without an admission adapter there is no proof that any
      // candidate row is visible to this principal. Never fall back to the raw
      // (grant-filtered-but-not-admitted) reader — index-time authorization is
      // never current, so the disclosed hits would be unverified.
      throw new VectorPluginValidationError(
        'unauthorized-source-ownership',
        'vector search requires a search admission adapter to re-authorize result rows',
      );
    }
    return { hits };
  }

  const plugin: VectorPlugin = {
    contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
    id: options.id,
    version: options.version,
    ownedObjects: Object.freeze([
      {
        kind: 'table' as const,
        name: stateTable,
        disposition: { kind: 'retained' as const, reason: 'Vector generation state is rebuilt independently of project rows' },
        ddl: [`CREATE TABLE IF NOT EXISTS ${stateTable} (slot TEXT PRIMARY KEY CHECK (slot = 'active'), active INTEGER NOT NULL CHECK (active IN (0, 1)), previous INTEGER NOT NULL CHECK (previous IN (0, 1)), model TEXT NOT NULL, dimensions INTEGER NOT NULL);`],
      },
      ...tables.map((name) => ({
        kind: 'table' as const,
        name,
        disposition: { kind: 'retained' as const, reason: 'Vector index is derived and rebuilt from the source census' },
        ddl: [`CREATE TABLE IF NOT EXISTS ${name} (source_key TEXT PRIMARY KEY, scope_id TEXT NOT NULL DEFAULT '', norm REAL NOT NULL, embedding BLOB NOT NULL);`],
      })),
      ...tables.map((name) => ({
        kind: 'index' as const,
        name: `${name}_scope_idx`,
        disposition: { kind: 'schema-only' as const },
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
      // The in-memory slab cannot describe the new space; persistent mode is
      // gated on the persisted state row until a rebuild rewrites it.
      activeSlab = new Float32VectorSlab(modelSpace.dimensions);
      shadowSlab = null;
      buildingGen = null;
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
    },
    validate(ctx) {
      if (hasBoundIndex(ctx)) {
        validatePersistedTable(ctx, targetTable(ctx));
        return;
      }
      targetSlab().validateFinite();
    },
    reconcile,
    revoke,
    rebuild,
    search,
    async beginShadow(ctx) {
      claimGeneration(ctx);
      const nextGen: 0 | 1 = currentActiveGeneration(ctx) === 0 ? 1 : 0;
      buildingGen = nextGen;
      if (hasBoundIndex(ctx)) {
        // Build directly into the disposable generation table — no slab copy.
        await clearTable(ctx, tables[nextGen]);
      } else {
        shadowSlab = new Float32VectorSlab(modelSpace.dimensions);
      }
    },
    indexCensus(ctx): SearchCensus {
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
    sourceCensus(ctx): SearchCensus {
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
        // Restore the durable active pointer; the previous generation table is
        // still intact, so no rehydration is required.
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
      const vectors = hasBoundIndex(ctx) && persistentModelCurrent(ctx)
        ? countTable(ctx, tables[currentActiveGeneration(ctx)])
        : (hasBoundIndex(ctx) ? 0 : activeSlab.size);
      return Object.freeze({
        generationIdentity: generationIdentity(modelSpace, sequence),
        modelSpace,
        vectors,
      });
    },
  };
  return Object.freeze(plugin);
}
