// fts5-plugin.ts — a declared, durable SQLite FTS5 search plugin.

import { createHash } from 'node:crypto';
import {
  SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
  type SearchChange,
  type SearchPlugin,
  type SearchPluginContext,
  type SearchPluginSearchResult,
  type SearchRequest,
  type SearchRevocationTarget,
} from './search-plugin.ts';
import { censusOfRows, type SearchCensus, type SearchEntityCensus, type SearchShadowCapabilities } from './search-reconcile.ts';
import { admitSearchHits } from './search-auth.ts';
import { SEARCH_MAX_WINDOW, searchStalenessOf } from './search-response.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import type { EntityRecord } from './row-grant.ts';

export type Fts5Tokenizer = 'unicode61' | 'porter' | 'trigram';

export class Fts5QueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Fts5QueryValidationError';
  }
}

export interface Fts5PluginSource {
  readonly entity: string;
  readonly fields: readonly string[];
  // Optional source column stored as `scope_id UNINDEXED` so queries scoped to
  // a project/partition pre-filter in SQL (`WHERE scope_id = ?`) before LIMIT.
  readonly scopeField?: string;
}

export interface Fts5SearchAdmission {
  // The current entity declaration supplies field-level excerpt admission; the
  // adapter remains the sole authorization authority for the source row.
  readonly entity: EntityRecord;
  readonly adapter: AuthorizationAdapter;
}

export interface Fts5PluginOptions {
  readonly id: string;
  readonly version: string;
  readonly source: Fts5PluginSource;
  readonly tokenizer?: Fts5Tokenizer;
  readonly snippetLength?: number;
  readonly admission: Fts5SearchAdmission;
}

export interface Fts5SearchHit extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly rank: number;
  readonly excerptField?: string;
  readonly excerpt?: string;
}

export interface Fts5Plugin extends SearchPlugin, SearchShadowCapabilities {
  readonly tokenizer: Fts5Tokenizer;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOKENIZERS = new Set<Fts5Tokenizer>(['unicode61', 'porter', 'trigram']);
const MAX_WRITE_STATEMENTS = 128;
const SOURCE_PAGE_SIZE = 512;
const DELETE_CHUNK_SIZE = 500;
const CENSUS_BOUNDARY_SAMPLE = 32;
const SCOPE_COLUMN = 'scope_id';

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new TypeError(`FTS5 ${label} must be a SQLite identifier`);
}

function tableName(entity: string, field: string): string {
  return `${entity}_${field}_fts`;
}

function ownerColumn(entity: string): string {
  return `${entity}_id`;
}

// Retained for the field strategy's scope-level FTS table declaration.
export function fts5TableDdl(entity: string, field: string, tokenizer?: Fts5Tokenizer): string {
  assertIdentifier(entity, 'entity');
  assertIdentifier(field, 'field');
  if (tokenizer !== undefined && !TOKENIZERS.has(tokenizer)) throw new TypeError(`unsupported FTS5 tokenizer '${tokenizer}'`);
  const configuredTokenizer = tokenizer === undefined ? '' : `, tokenize='${tokenizer}'`;
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName(entity, field)} USING fts5(${field}, ${ownerColumn(entity)} UNINDEXED${configuredTokenizer});`;
}

function pluginName(id: string): string {
  return `SearchFts_${id.replaceAll(/[^A-Za-z0-9_]/g, '_')}`;
}

function rowId(row: Readonly<Record<string, unknown>>): string {
  if (typeof row.id !== 'string' || row.id.length === 0) throw new TypeError('FTS5 source row requires a non-empty string id');
  return row.id;
}

function stringValues(row: Readonly<Record<string, unknown>>, fields: readonly string[]): readonly string[] {
  return fields.map((field) => typeof row[field] === 'string' ? row[field] : '');
}

function scopeValueOf(row: Readonly<Record<string, unknown>>, scopeField: string | undefined): string {
  if (scopeField === undefined) return '';
  const value = row[scopeField];
  return value === null || value === undefined ? '' : String(value);
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function boundedExcerpt(value: string, length: number): string {
  if (value.length <= length) return value;
  if (length <= 3) return '.'.repeat(length);
  return `${value.slice(0, Math.max(0, length - 3))}...`;
}

function indexedRows(rows: readonly Readonly<Record<string, unknown>>[], fields: readonly string[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries([
    ['id', rowId(row)],
    ...fields.map((field) => [field, typeof row[field] === 'string' ? row[field] : '']),
  ]));
}

function boundaryCensus(
  count: number,
  head: readonly Record<string, unknown>[],
  tail: readonly Record<string, unknown>[],
): SearchEntityCensus {
  if (count === 0) return { count: 0, digest: censusOfRows([]).digest };
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of head) byId.set(String(row.id), row);
  for (const row of tail) byId.set(String(row.id), row);
  const sample = censusOfRows([...byId.values()]);
  if (count <= CENSUS_BOUNDARY_SAMPLE * 2 && byId.size === count) {
    return { count, digest: sample.digest };
  }
  const digest = createHash('sha256').update(`${count}:${sample.digest ?? ''}`).digest('hex');
  return { count, digest };
}

function countOf(ctx: SearchPluginContext, table: string): number {
  const row = ctx.index.query({ sql: `SELECT COUNT(*) AS count FROM ${table}` })[0];
  return Number(row?.count ?? 0);
}

function ftsShadowNames(table: string): readonly string[] {
  return Object.freeze(['data', 'idx', 'content', 'docsize', 'config'].map((suffix) => `${table}_${suffix}`));
}

function extractScopeId(
  rawScope: unknown,
  rawScopeId: unknown,
  scopeField: string | undefined,
): string | undefined {
  if (rawScopeId !== undefined) {
    if (scopeField === undefined) {
      throw new Fts5QueryValidationError('FTS5 plugin is not configured with a scopeField for scoped search');
    }
    if (typeof rawScopeId !== 'string' || rawScopeId.length === 0) {
      throw new Fts5QueryValidationError('FTS5 scopeId must be a non-empty string');
    }
    return rawScopeId;
  }
  if (rawScope === undefined) return undefined;
  if (scopeField === undefined) {
    throw new Fts5QueryValidationError('FTS5 plugin is not configured with a scopeField for scoped search');
  }
  if (typeof rawScope === 'string') {
    if (rawScope.length === 0) throw new Fts5QueryValidationError('FTS5 scope must be a non-empty string');
    return rawScope;
  }
  if (rawScope === null || typeof rawScope !== 'object' || Array.isArray(rawScope)) {
    throw new Fts5QueryValidationError('FTS5 scope must be a string or single-field scope predicate object');
  }
  const entries = Object.entries(rawScope as Record<string, unknown>);
  if (entries.length !== 1) {
    throw new Fts5QueryValidationError(`FTS5 scope object must specify exactly '${scopeField}'`);
  }
  const [key, value] = entries[0];
  if (key !== scopeField && key !== SCOPE_COLUMN) {
    throw new Fts5QueryValidationError(`FTS5 scope field '${key}' does not match configured scopeField '${scopeField}'`);
  }
  if (value === null || value === undefined) {
    throw new Fts5QueryValidationError(`FTS5 scope value for '${key}' must not be null or undefined`);
  }
  return String(value);
}

const FTS_QUERY_MAX_LENGTH = 4096;
const FTS_QUERY_MAX_TERMS = 128;
const FTS_OPERATORS = new Set(['AND', 'OR', 'NOT']);
const FTS_WHITESPACE = /\s/;

function quoteFtsTerm(term: string): string {
  // A double-quoted FTS5 string is a literal phrase: punctuation, colons,
  // hyphens and stray operators inside it can never be parsed as syntax.
  return `"${term.replaceAll('"', '""')}"`;
}

/**
 * Turn a raw caller query into a safe FTS5 MATCH expression.
 *
 * Every term is quoted, so punctuation and FTS5 metacharacters in user text
 * are literal content rather than syntax. The three boolean operators and
 * prefix `*` are preserved only in their valid structural positions, so
 * multi-term AND/OR and phrase/prefix search keep working. Malformed syntax
 * (dangling/adjacent operators, unbalanced quotes, stray wildcards) is
 * rejected here instead of reaching SQLite as a parser error.
 */
export function sanitizeFts5Query(query: string): string {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Fts5QueryValidationError('FTS5 query must be a non-empty string');
  }
  if (query.length > FTS_QUERY_MAX_LENGTH) {
    throw new Fts5QueryValidationError(`FTS5 query exceeds ${FTS_QUERY_MAX_LENGTH} characters`);
  }
  const parts: string[] = [];
  const kinds: ('term' | 'operator')[] = [];
  let terms = 0;
  let index = 0;
  while (index < query.length) {
    const char = query[index];
    if (FTS_WHITESPACE.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"') {
      let phrase = '"';
      let cursor = index + 1;
      let closed = false;
      while (cursor < query.length) {
        const part = query[cursor];
        if (part === '"') {
          if (query[cursor + 1] === '"') {
            phrase += '""';
            cursor += 2;
            continue;
          }
          phrase += '"';
          cursor += 1;
          closed = true;
          break;
        }
        phrase += part;
        cursor += 1;
      }
      if (!closed) throw new Fts5QueryValidationError('FTS5 query has an unterminated quoted phrase');
      // A quoted phrase may carry a prefix marker after its closing quote.
      if (query[cursor] === '*') {
        if (cursor + 1 < query.length && !FTS_WHITESPACE.test(query[cursor + 1])) {
          throw new Fts5QueryValidationError('FTS5 query has a stray wildcard');
        }
        phrase += '*';
        cursor += 1;
      }
      parts.push(phrase);
      kinds.push('term');
      terms += 1;
      index = cursor;
    } else {
      let cursor = index;
      while (cursor < query.length && !FTS_WHITESPACE.test(query[cursor]) && query[cursor] !== '"') cursor += 1;
      let token = query.slice(index, cursor);
      index = cursor;
      if (FTS_OPERATORS.has(token)) {
        parts.push(token);
        kinds.push('operator');
        continue;
      }
      let prefix = false;
      if (token.endsWith('*')) {
        prefix = true;
        token = token.slice(0, -1);
      }
      if (token.length === 0 || token.includes('*')) {
        throw new Fts5QueryValidationError('FTS5 query has a stray wildcard');
      }
      parts.push(`${quoteFtsTerm(token)}${prefix ? '*' : ''}`);
      kinds.push('term');
      terms += 1;
    }
    if (terms > FTS_QUERY_MAX_TERMS) {
      throw new Fts5QueryValidationError(`FTS5 query exceeds ${FTS_QUERY_MAX_TERMS} terms`);
    }
  }
  if (parts.length === 0) throw new Fts5QueryValidationError('FTS5 query must be a non-empty string');
  if (kinds[0] === 'operator' || kinds[kinds.length - 1] === 'operator') {
    throw new Fts5QueryValidationError('FTS5 query has a dangling operator');
  }
  for (let position = 1; position < kinds.length; position += 1) {
    if (kinds[position] === 'operator' && kinds[position - 1] === 'operator') {
      throw new Fts5QueryValidationError('FTS5 query has adjacent operators');
    }
  }
  return parts.join(' ');
}

function resolveFtsQuery(
  request: SearchRequest,
  scopeField: string | undefined,
): { readonly queryText: string; readonly scopeId: string | undefined } {
  let queryText: unknown = request.query;
  let queryScope: unknown;
  let queryScopeId: unknown;
  if (request.query !== null && typeof request.query === 'object' && !Array.isArray(request.query)) {
    const obj = request.query as { text?: unknown; query?: unknown; scope?: unknown; scopeId?: unknown };
    queryText = obj.text ?? obj.query;
    queryScope = obj.scope;
    queryScopeId = obj.scopeId;
  }
  if (typeof queryText !== 'string' || queryText.trim().length === 0) {
    throw new Fts5QueryValidationError('FTS5 query must be a non-empty string');
  }
  const scopeId = extractScopeId(request.scope ?? queryScope, request.scopeId ?? queryScopeId, scopeField);
  return { queryText: sanitizeFts5Query(queryText), scopeId };
}

export function createFts5Plugin(options: Fts5PluginOptions): Fts5Plugin {
  assertIdentifier(options.source.entity, 'entity');
  if (!Array.isArray(options.source.fields) || options.source.fields.length === 0) throw new TypeError('FTS5 plugin requires at least one source field');
  for (const field of options.source.fields) assertIdentifier(field, 'field');
  const scopeField = options.source.scopeField;
  if (scopeField !== undefined) assertIdentifier(scopeField, 'scopeField');
  const tokenizer = options.tokenizer ?? 'unicode61';
  if (!TOKENIZERS.has(tokenizer)) throw new TypeError(`unsupported FTS5 tokenizer '${tokenizer}'`);
  const snippetLength = options.snippetLength ?? 24;
  if (!Number.isSafeInteger(snippetLength) || snippetLength < 1) throw new TypeError('FTS5 snippetLength must be a positive safe integer');
  if (options.admission === null || typeof options.admission !== 'object') throw new TypeError('FTS5 plugin requires a search admission configuration');

  const base = pluginName(options.id);
  const stateTable = `${base}_state`;
  const tables = [`${base}_g0`, `${base}_g1`] as const;
  const idColumn = `${options.source.entity}_id`;
  const insertColumns = [...options.source.fields, idColumn, SCOPE_COLUMN];
  const insertSql = `INSERT INTO %TABLE% (${insertColumns.join(', ')}) VALUES (${insertColumns.map(() => '?').join(', ')})`;
  let building: 0 | 1 | null = null;
  let promoted: 0 | 1 | null = null;
  // Monotonic generation watermark for overlapping same-identity writes (#243).
  let activeWriteGeneration = 0;

  function activeGeneration(ctx: SearchPluginContext): 0 | 1 {
    const value = ctx.index.query({ sql: `SELECT active FROM ${stateTable} WHERE slot = 'active'` })[0]?.active;
    return value === 1 ? 1 : 0;
  }

  function targetTable(ctx: SearchPluginContext): string {
    return tables[building ?? activeGeneration(ctx)];
  }

  function isSuperseded(ctx: SearchPluginContext): boolean {
    return ctx.generation < activeWriteGeneration;
  }

  function claimGeneration(ctx: SearchPluginContext): boolean {
    if (ctx.generation < activeWriteGeneration) return false;
    activeWriteGeneration = ctx.generation;
    return true;
  }

  async function clearTable(ctx: SearchPluginContext, table: string, allowSuperseded = false): Promise<void> {
    if (!allowSuperseded && isSuperseded(ctx)) return;
    if (typeof ctx.index.clear === 'function') {
      await ctx.index.clear({ expectedFence: ctx.fence, table });
      return;
    }
    // Fallback for custom SearchOwnedIndex implementations without bulk clear:
    // delete in bounded chunks so total_changes() stays well below maxRows.
    while (allowSuperseded || !isSuperseded(ctx)) {
      const result = await ctx.index.write({
        expectedFence: ctx.fence,
        statements: [{ sql: `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT ${DELETE_CHUNK_SIZE})` }],
      });
      if (result.changes === 0) break;
    }
  }

  async function writeRows(ctx: SearchPluginContext, table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
    const sql = insertSql.replace('%TABLE%', table);
    for (let offset = 0; offset < rows.length; offset += MAX_WRITE_STATEMENTS) {
      if (isSuperseded(ctx)) return;
      const statements = rows.slice(offset, offset + MAX_WRITE_STATEMENTS).map((row) => ({
        sql,
        params: [...stringValues(row, options.source.fields), rowId(row), scopeValueOf(row, scopeField)],
      }));
      if (statements.length > 0) await ctx.index.write({ expectedFence: ctx.fence, statements });
    }
  }

  async function replaceRows(ctx: SearchPluginContext, table: string, changes: readonly SearchChange[]): Promise<void> {
    const sql = insertSql.replace('%TABLE%', table);
    const statements: { readonly sql: string; readonly params?: readonly unknown[] }[] = [];
    for (const change of changes) {
      if (change.entity !== options.source.entity) continue;
      statements.push({ sql: `DELETE FROM ${table} WHERE ${idColumn} = ?`, params: [change.rowId] });
      if (change.kind !== 'removed') {
        const row = ctx.reader.row(options.source.entity, change.rowId);
        if (row !== undefined) {
          statements.push({
            sql,
            params: [...stringValues(row, options.source.fields), rowId(row), scopeValueOf(row, scopeField)],
          });
        }
      }
    }
    for (let offset = 0; offset < statements.length; offset += MAX_WRITE_STATEMENTS) {
      if (isSuperseded(ctx)) return;
      await ctx.index.write({ expectedFence: ctx.fence, statements: statements.slice(offset, offset + MAX_WRITE_STATEMENTS) });
    }
  }

  const plugin: Fts5Plugin = {
    contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
    id: options.id,
    version: options.version,
    tokenizer,
    ownedObjects: Object.freeze([
      { kind: 'table' as const, name: stateTable, disposition: { kind: 'retained' as const, reason: 'FTS generation state is rebuilt independently of project rows' }, ddl: [`CREATE TABLE IF NOT EXISTS ${stateTable} (slot TEXT PRIMARY KEY CHECK (slot = 'active'), active INTEGER NOT NULL CHECK (active IN (0, 1)), previous INTEGER NOT NULL CHECK (previous IN (0, 1)));`] },
      ...tables.map((name) => ({
        kind: 'virtual-table' as const,
        name,
        // Stores only indexed fields plus UNINDEXED source id and scope_id for
        // SQL-level pre-filtering before LIMIT (no full-row JSON payload copy).
        disposition: { kind: 'retained' as const, reason: 'FTS index is derived and rebuilt from the source census' },
        ddl: [`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(${[...options.source.fields, `${idColumn} UNINDEXED`, `${SCOPE_COLUMN} UNINDEXED`].join(', ')}, tokenize='${tokenizer}');`],
      })),
      // FTS5 creates these physical tables with its virtual table. They are
      // declared individually so the census authorizes FTS's internal writes.
      // Lifecycle creation visits virtual tables first, making these fallback
      // DDL entries no-ops on every healthy boot.
      ...tables.flatMap((table) => ftsShadowNames(table).map((name) => ({
        kind: 'table' as const,
        name,
        disposition: { kind: 'schema-only' as const }, ddl: [`-- ${name} is created by its declared FTS5 virtual table.`],
      }))),
    ]),
    sourceInterests: Object.freeze([{ entity: options.source.entity }]),
    stalenessKey: (change) => change.entity === options.source.entity ? `${change.entity}:${change.rowId}` : null,
    async prepare(ctx) {
      await ctx.index.write({
        expectedFence: ctx.fence,
        statements: [{ sql: `INSERT OR IGNORE INTO ${stateTable} (slot, active, previous) VALUES ('active', 0, 0)` }],
      });
    },
    validate(ctx) {
      // Read both FTS generations through the owned capability. This exercises
      // the real virtual tables before a generation is disclosed as ready.
      countOf(ctx, tables[0]);
      countOf(ctx, tables[1]);
    },
    async reconcile(ctx, changes) {
      if (!claimGeneration(ctx)) return { counts: { documents: countOf(ctx, targetTable(ctx)) } };
      await replaceRows(ctx, targetTable(ctx), changes);
      return { counts: { documents: countOf(ctx, targetTable(ctx)) } };
    },
    async revoke(ctx, target: SearchRevocationTarget) {
      const table = targetTable(ctx);
      if (target.entity !== options.source.entity || !claimGeneration(ctx)) {
        return { counts: { documents: countOf(ctx, table) } };
      }
      if (target.scopeId !== undefined) {
        while (!isSuperseded(ctx)) {
          const result = await ctx.index.write({
            expectedFence: ctx.fence,
            statements: [{
              sql: `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${SCOPE_COLUMN} = ? LIMIT ${DELETE_CHUNK_SIZE})`,
              params: [target.scopeId],
            }],
          });
          if (result.changes === 0) break;
        }
      } else if (target.rowId !== undefined) {
        await ctx.index.write({
          expectedFence: ctx.fence,
          statements: [{ sql: `DELETE FROM ${table} WHERE ${idColumn} = ?`, params: [target.rowId] }],
        });
      }
      return { counts: { documents: countOf(ctx, table) } };
    },
    async rebuild(ctx) {
      const table = targetTable(ctx);
      if (!claimGeneration(ctx)) return { counts: { documents: countOf(ctx, table) } };
      await clearTable(ctx, table);
      // Stream source rows in bounded keyset pages so >10k rebuilds never
      // materialize the entire corpus in JS RAM at once.
      let afterId: string | undefined;
      while (!isSuperseded(ctx)) {
        const page = ctx.reader.rows(options.source.entity, {
          afterId,
          limit: SOURCE_PAGE_SIZE,
          order: 'asc',
        });
        if (page.length === 0) break;
        await writeRows(ctx, table, page);
        if (page.length < SOURCE_PAGE_SIZE) break;
        const lastId = rowId(page[page.length - 1]);
        if (afterId !== undefined && lastId <= afterId) break;
        afterId = lastId;
      }
      return { counts: { documents: countOf(ctx, table) } };
    },
    async search(ctx, request): Promise<SearchPluginSearchResult> {
      const { queryText, scopeId } = resolveFtsQuery(request, scopeField);
      if (request.principal === undefined) throw new Fts5QueryValidationError('FTS5 search requires a principal for result admission');
      const table = tables[activeGeneration(ctx)];
      try {
        // Single-query FTS5 projection: pre-filters `scope_id` before LIMIT,
        // attributes per-column matches via highlight(), and refills on denial.
        const matchExprs = options.source.fields
          .map((field, index) => `(highlight(${table}, ${index}, '[', ']') IS NOT ${field}) AS matched_${index}`).join(', ');
        const snippetExprs = options.source.fields
          .map((_, index) => `snippet(${table}, ${index}, '[', ']', '...', ?) AS excerpt_${index}`).join(', ');
        const whereClause = scopeId === undefined ? `${table} MATCH ?` : `${table} MATCH ? AND ${SCOPE_COLUMN} = ?`;
        const whereParams: unknown[] = scopeId === undefined ? [queryText] : [queryText, scopeId];
        const limit = Math.min(SEARCH_MAX_WINDOW, Math.max(0, Math.floor(request.limit ?? 100)));
        if (limit === 0 || request.signal?.aborted) return { hits: [] };
        const snippetTokens = Math.min(64, snippetLength);
        const staleness = ctx.state !== undefined ? searchStalenessOf(ctx.state) : 'stale';
        let candidateLimit = limit;
        for (;;) {
          if (request.signal?.aborted) return { hits: [] };
          const rows = ctx.index.query({
            sql: `SELECT ${idColumn} AS id, bm25(${table}) AS score, ${matchExprs}, ${snippetExprs} FROM ${table} WHERE ${whereClause} ORDER BY score ASC, ${idColumn} ASC LIMIT ?`,
            params: [...options.source.fields.map(() => snippetTokens), ...whereParams, candidateLimit],
          });
          if (request.signal?.aborted) return { hits: [] };
          const greatest = Math.max(0, ...rows.map((row) => -asNumber(row.score)));
          const candidates = rows.map((row) => {
            const id = String(row.id);
            const matchingFieldIndexes: number[] = [];
            for (let index = 0; index < options.source.fields.length; index += 1) {
              if (Number(row[`matched_${index}`]) === 1) matchingFieldIndexes.push(index);
            }
            const fieldIndex = matchingFieldIndexes.length === 1 ? matchingFieldIndexes[0] : undefined;
            const excerpt = fieldIndex === undefined ? undefined : row[`excerpt_${fieldIndex}`];
            const hit = Object.freeze({
              id, rank: greatest === 0 ? 1 : Math.max(0, -asNumber(row.score) / greatest),
              ...(fieldIndex === undefined ? {} : { excerptField: options.source.fields[fieldIndex] }),
            });
            return {
              hit, key: id, rank: hit.rank, row: ctx.reader.row(options.source.entity, id) ?? null,
              ...(typeof excerpt === 'string' && hit.excerptField !== undefined ? {
                excerpt: { entity: options.admission.entity, fieldName: hit.excerptField, text: boundedExcerpt(excerpt, snippetLength) },
              } : {}),
            };
          });
          const admitted = await admitSearchHits(options.admission.adapter, {
            pluginId: options.id, generation: ctx.generation, staleness, principal: request.principal, candidates,
          });
          if (request.signal?.aborted) return { hits: [] };
          const hits = Object.freeze(admitted.hits.slice(0, limit).map(({ hit, excerpt }) => Object.freeze({
            ...hit, ...(excerpt !== undefined ? { excerpt } : {}),
          })));
          const truncated = rows.length >= candidateLimit && candidateLimit >= SEARCH_MAX_WINDOW && hits.length < limit;
          if (hits.length >= limit || rows.length < candidateLimit || candidateLimit >= SEARCH_MAX_WINDOW) {
            return truncated ? { hits, truncated: true } : { hits };
          }
          candidateLimit = Math.min(SEARCH_MAX_WINDOW, candidateLimit * 2);
        }
      } catch (error) {
        if (error instanceof Fts5QueryValidationError) throw error;
        throw new Fts5QueryValidationError(`FTS5 query is malformed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async beginShadow(ctx) {
      claimGeneration(ctx);
      building = activeGeneration(ctx) === 0 ? 1 : 0;
      await clearTable(ctx, tables[building]);
    },
    indexCensus(ctx): SearchCensus {
      const table = targetTable(ctx);
      const count = countOf(ctx, table);
      if (count === 0) return Object.freeze({ [options.source.entity]: boundaryCensus(0, [], []) });
      const selectCols = `${idColumn} AS id, ${options.source.fields.join(', ')}`;
      if (count <= CENSUS_BOUNDARY_SAMPLE * 2) {
        const rows = ctx.index.query({
          sql: `SELECT ${selectCols} FROM ${table} ORDER BY ${idColumn} ASC LIMIT ${CENSUS_BOUNDARY_SAMPLE * 2}`,
        });
        return Object.freeze({ [options.source.entity]: boundaryCensus(count, rows, []) });
      }
      const head = ctx.index.query({
        sql: `SELECT ${selectCols} FROM ${table} ORDER BY ${idColumn} ASC LIMIT ${CENSUS_BOUNDARY_SAMPLE}`,
      });
      const tail = ctx.index.query({
        sql: `SELECT ${selectCols} FROM ${table} ORDER BY ${idColumn} DESC LIMIT ${CENSUS_BOUNDARY_SAMPLE}`,
      });
      return Object.freeze({ [options.source.entity]: boundaryCensus(count, head, tail) });
    },
    sourceCensus(ctx): SearchCensus {
      const count = typeof ctx.reader.count === 'function'
        ? ctx.reader.count(options.source.entity)
        : ctx.reader.rows(options.source.entity).length;
      if (count === 0) return Object.freeze({ [options.source.entity]: boundaryCensus(0, [], []) });
      if (count <= CENSUS_BOUNDARY_SAMPLE * 2) {
        const rows = indexedRows(
          ctx.reader.rows(options.source.entity, { limit: CENSUS_BOUNDARY_SAMPLE * 2, order: 'asc' }),
          options.source.fields,
        );
        return Object.freeze({ [options.source.entity]: boundaryCensus(count, rows, []) });
      }
      const head = indexedRows(
        ctx.reader.rows(options.source.entity, { limit: CENSUS_BOUNDARY_SAMPLE, order: 'asc' }),
        options.source.fields,
      );
      const tail = indexedRows(
        ctx.reader.rows(options.source.entity, { limit: CENSUS_BOUNDARY_SAMPLE, order: 'desc' }),
        options.source.fields,
      );
      return Object.freeze({ [options.source.entity]: boundaryCensus(count, head, tail) });
    },
    async commitShadow(ctx) {
      if (building === null) throw new Error('FTS5 plugin has no shadow generation to commit');
      if (isSuperseded(ctx)) throw new Error('FTS5 shadow generation superseded by a newer materialization');
      const next = building;
      await ctx.index.write({
        expectedFence: ctx.fence,
        statements: [{ sql: `UPDATE ${stateTable} SET previous = active, active = ? WHERE slot = 'active'`, params: [next] }],
      });
      promoted = next;
      building = null;
    },
    async rollbackShadow(ctx) {
      if (promoted === null) return;
      await ctx.index.write({ expectedFence: ctx.fence, statements: [{ sql: `UPDATE ${stateTable} SET active = previous WHERE slot = 'active'` }] });
      promoted = null;
    },
    async abortShadow(ctx) {
      if (building === null) return;
      const discarded = building;
      building = null;
      await clearTable(ctx, tables[discarded], true);
    },
    health(ctx) {
      try {
        const active = activeGeneration(ctx);
        const index = plugin.indexCensus(ctx)[options.source.entity];
        const sourceCensus = plugin.sourceCensus!(ctx)[options.source.entity];
        const shadowCounts = tables.map((table) => countOf(ctx, table));
        return Object.freeze({
          tokenizer,
          integrity: Object.freeze({
            ok: sourceCensus.count === index.count && sourceCensus.digest === index.digest,
            source: sourceCensus,
            index,
            activeGeneration: active,
            shadowCounts: Object.freeze(shadowCounts),
            // FTS5 has no plugin-installed triggers: all maintenance is the
            // post-commit staleness ledger, so source-trigger drift is impossible.
            triggerDrift: false,
          }),
        });
      } catch (error) {
        return Object.freeze({ tokenizer, integrity: Object.freeze({ ok: false, error: error instanceof Error ? error.message : String(error) }) });
      }
    },
  };
  return Object.freeze(plugin);
}
