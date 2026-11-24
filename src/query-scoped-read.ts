// Query-scoped reads (#225, #289, ADR-0009).
//
// A typed, authorized page over one compiled Entity: allowlisted operators,
// composable boolean filter trees (AND/OR/NOT + flat filters), single-key sort
// with an `id ASC` tie-break (the readRows convention), keyset and bounded
// offset pagination, optional filteredTotal + authorized total counts, entity
// row hydration, and a single atomic SQLite read snapshot with a revision token
// from `_CommittedRevision`. Invalidation is a "changed since R" signal; the
// client refetches. This is not a second write path, not a second auth engine,
// and not a row-patch fold.

import { canonicalStringify } from './canonical-json.ts';
import { getLog } from './log.ts';
import { materializeStoredRow } from './entity/materialize-row.ts';
import { parseEventType, EventKind, type EventIdentityHandle } from './event-handle.ts';
import type { FieldDescriptor } from './field-strategy.ts';
import { tryParseScopeKey } from './scope-handle.ts';

export const QUERY_OPERATORS = Object.freeze(['eq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains', 'isEmpty', 'isNotEmpty'] as const);
export type QueryOperator = (typeof QUERY_OPERATORS)[number];

export const OPERATORS_BY_FIELD_TYPE = Object.freeze({
  text: Object.freeze(['eq', 'in', 'contains', 'isEmpty', 'isNotEmpty'] as const),
  number: Object.freeze(['eq', 'in', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'] as const),
  date: Object.freeze(['eq', 'in', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'] as const),
  epoch: Object.freeze(['eq', 'in', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'] as const),
  boolean: Object.freeze(['eq', 'isEmpty', 'isNotEmpty'] as const),
  ref: Object.freeze(['eq', 'in', 'isEmpty', 'isNotEmpty'] as const),
  option: Object.freeze(['eq', 'in', 'isEmpty', 'isNotEmpty'] as const),
});
export type QueryFieldType = keyof typeof OPERATORS_BY_FIELD_TYPE;

export const QUERY_PAGE_SIZE_MIN = 1;
export const QUERY_PAGE_SIZE_MAX = 100;
export const QUERY_PAGE_SIZE_CEILING = 500;
export const QUERY_OFFSET_MAX = 100_000;
export const QUERY_EXPRESSION_MAX_DEPTH = 8;
export const QUERY_EXPRESSION_MAX_LEAVES = 32;
export const QUERY_REGISTRATION_MAX = 32;
// Idle TTL: an untouched registration is dropped so a long-running server
// cannot accumulate clients that stopped refetching. Reading a signal or
// matching a notice renews it.
export const QUERY_REGISTRATION_TTL_MS = 5 * 60_000;
const IN_VALUES_MAX = 100;
const FILTERS_MAX = 16;

const SCALAR_TYPES = new Set(['text', 'boolean', 'date', 'number', 'ref']);

export class QueryScopedReadError extends Error {
  constructor(message: string) {
    super(`Invalid query-scoped read: ${message}`);
    this.name = 'QueryScopedReadError';
  }
}

export class QueryContentionError extends Error {
  constructor(message = 'query page contended with a concurrent commit') {
    super(message);
    this.name = 'QueryContentionError';
  }
}

type Statement = {
  get(...args: unknown[]): Record<string, unknown> | undefined | unknown;
  all(...args: unknown[]): unknown[];
};

export type QueryDb = {
  prepare(sql: string): Statement;
  exec?(sql: string): unknown;
  readonly isTransaction?: boolean;
};

export type QuerySnapshotDb = QueryDb & { exec(sql: string): unknown };

export interface QueryEntity {
  readonly name: string;
  readonly fields: Readonly<Record<string, { readonly kind?: string; readonly type?: string; readonly role?: unknown; readonly [property: string]: unknown }>>;
  scopeFilter?(principal: unknown): { sql: string; params: Record<string, unknown> };
  deserializeRow?(row: Record<string, unknown>): Record<string, unknown>;
  readonly scopeAst?: unknown;
  /**
   * Compiled SQL read scope. Its presence is what makes an entity queryable:
   * a can-only grant (no scope clause) leaves this undefined, and its
   * scopeFilter admits every row for the runtime .can layer to post-filter.
   * The query layer has no such post-filter, so it must reject the entity.
   */
  readonly readScope?: unknown;
}

export interface QueryFilter {
  readonly field: string;
  readonly op: QueryOperator;
  readonly value?: unknown;
}

export interface QueryFilterTermNode {
  readonly kind: 'term';
  readonly field: string;
  readonly op?: QueryOperator;
  readonly value?: unknown;
}

export interface QueryFilterAndNode {
  readonly kind: 'and';
  readonly children: readonly QueryFilterExpression[];
}

export interface QueryFilterOrNode {
  readonly kind: 'or';
  readonly children: readonly QueryFilterExpression[];
}

export interface QueryFilterNotNode {
  readonly kind: 'not';
  readonly child: QueryFilterExpression;
}

export type QueryFilterExpression =
  | QueryFilterTermNode
  | QueryFilterAndNode
  | QueryFilterOrNode
  | QueryFilterNotNode;

export interface QuerySort {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

export interface QueryContract {
  readonly entity: string;
  readonly filters?: readonly QueryFilter[];
  readonly where?: QueryFilterExpression | null;
  readonly expression?: QueryFilterExpression | null;
  readonly sort: QuerySort;
  readonly pageSize: number;
}

export interface CompileQueryContractOptions {
  readonly maxPageSize?: number;
}

export interface QueryCursor {
  readonly queryIdentity: string;
  readonly sortValue: unknown;
  readonly id: string;
}

export interface CompiledQuery {
  readonly entity: string;
  readonly identity: string;
  readonly filters: readonly QueryFilter[];
  readonly where: QueryFilterExpression | null;
  readonly sort: QuerySort;
  readonly pageSize: number;
  readonly maxPageSize: number;
  readonly dependencyFields: readonly string[];
}

export interface ExecuteQueryPageOptions {
  readonly cursor?: QueryCursor | null;
  readonly offset?: number;
  readonly maxOffset?: number;
  readonly includeCount?: boolean;
  readonly includeTotal?: boolean;
  readonly hydrate?: boolean;
}

export interface QueryPage {
  readonly rows: readonly Record<string, unknown>[];
  readonly revision: number;
  readonly hasMore: boolean;
  readonly nextCursor: QueryCursor | null;
  readonly queryIdentity: string;
  /**
   * The raw sort key of each row, parallel to `rows`. HTTP routes use it to
   * rebuild a keyset cursor AFTER an authorization post-filter removes rows;
   * it is internal pagination evidence, never part of the JSON page body.
   */
  readonly sortValues?: readonly unknown[];
  readonly offset?: number;
  readonly count?: number;
  readonly filteredTotal?: number;
  readonly total?: number;
}

export type QueryPageDecision = 'accept' | 'reject-stale';

export type QueryInvalidationKind = 'unchanged' | 'changed' | 'resync' | 'denied';

export interface QueryInvalidationSignal {
  readonly kind: QueryInvalidationKind;
  readonly revision: number;
}

export interface QueryDependency {
  readonly entity: string;
  readonly fields: readonly string[];
  readonly scope: string;
  readonly scopeField?: string;
}

export interface PendingQueryWrite {
  readonly id: string;
  readonly verb: 'create' | 'update' | 'remove';
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface OptimisticQueryPage {
  readonly rows: readonly Record<string, unknown>[];
  readonly revision: number;
  readonly membershipUncertain: boolean;
}

export interface FilterExpressionCompileState {
  leaves: number;
  paramIndex: number;
}

export interface CompiledExpressionLeaf {
  readonly sql: string;
  readonly normalized: unknown;
  readonly fields: readonly string[];
}

export interface CustomSortSpec {
  readonly joinSql: string;
  readonly sortColumn: string;
  readonly direction: 'asc' | 'desc';
  readonly params?: Record<string, unknown>;
}

const CONTRACT_KEYS = Object.freeze(['entity', 'filters', 'where', 'expression', 'sort', 'pageSize']);
const FILTER_KEYS = Object.freeze(['field', 'op', 'value']);
const TERM_KEYS = Object.freeze(['kind', 'field', 'op', 'value']);
const GROUP_KEYS = Object.freeze(['kind', 'children']);
const NOT_KEYS = Object.freeze(['kind', 'child']);
const SORT_KEYS = Object.freeze(['field', 'direction']);

function fail(message: string): never {
  throw new QueryScopedReadError(message);
}

/**
 * A query can only be authorized when the entity carries a compiled SQL row
 * scope. A `.can-only` grant leaves `readScope` undefined and its scopeFilter
 * returns `1=1` — safe for REST/live, which post-filter each row through the
 * runtime grant, but a full-table leak here because the query layer trusts the
 * compiled scope as the whole authorization decision. Fail closed, in one
 * place, for every query entry point.
 */
export function assertQueryableEntity(entity: QueryEntity): void {
  if (!entity.readScope) {
    fail(`UNSCOPED_ENTITY: entity '${entity.name}' has no compiled readScope; a can-only grant is not queryable.`);
  }
}

function assertKeys(value: object, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} contains an unknown property.`);
  }
}

function identifier(name: string, label: string): string {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError(`${label} must be a SQL identifier`);
  }
  return name;
}

function fieldsOf(entity: QueryEntity): Set<string> {
  return new Set(['id', ...Object.keys(entity.fields ?? {})]);
}

function assertScalarField(entity: QueryEntity, field: string, label: string): void {
  if (field === 'id') return;
  const descriptor = entity.fields[field];
  if (!descriptor || descriptor.kind !== 'value' || !SCALAR_TYPES.has(descriptor.type ?? '')) {
    fail(`${label} '${field}' is not a declared scalar field.`);
  }
}

function assertSqlValue(value: unknown, label: string): void {
  if (value === null) fail(`${label} must not be null; IS NULL is not in the operator set.`);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
  fail(`${label} must be a SQLite scalar value.`);
}

function freezeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeJsonValue(item)));
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = freezeJsonValue(item);
    return Object.freeze(copy);
  }
  return value;
}

function detached(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.freeze({ ...raw });
}

function materializeQueryRow(
  raw: Record<string, unknown>,
  entity: QueryEntity,
  hydrate: boolean,
): Record<string, unknown> {
  if (!hydrate) return detached(raw);
  if (typeof entity.deserializeRow === 'function') {
    return Object.freeze(entity.deserializeRow({ ...raw }));
  }
  if (entity.fields && typeof entity.fields === 'object') {
    return materializeStoredRow(
      raw,
      entity.fields as Record<string, FieldDescriptor>,
      { freeze: true },
    ) as Record<string, unknown>;
  }
  return detached(raw);
}

export function resolveMaxPageSize(maxPageSize?: number): number {
  if (maxPageSize === undefined) return QUERY_PAGE_SIZE_MAX;
  if (!Number.isSafeInteger(maxPageSize) || maxPageSize < QUERY_PAGE_SIZE_MIN || maxPageSize > QUERY_PAGE_SIZE_CEILING) {
    fail(`maxPageSize must be an integer from ${QUERY_PAGE_SIZE_MIN} through ${QUERY_PAGE_SIZE_CEILING}.`);
  }
  return maxPageSize;
}

export function resolveMaxOffset(maxOffset?: number): number {
  if (maxOffset === undefined) return QUERY_OFFSET_MAX;
  if (!Number.isSafeInteger(maxOffset) || maxOffset < 0 || maxOffset > QUERY_OFFSET_MAX) {
    fail(`maxOffset must be an integer from 0 through ${QUERY_OFFSET_MAX}.`);
  }
  return maxOffset;
}

function queryPrincipalKey(principal: unknown): string {
  if (!principal || typeof principal !== 'object') fail('principal is required.');
  const record = principal as { type?: unknown; id?: unknown };
  if (typeof record.type !== 'string') fail('principal type is required.');
  if (record.type === 'anonymous') return 'anonymous';
  if (typeof record.id !== 'string' || record.id.length === 0) fail('principal id is required.');
  return `${record.type}:${record.id}`;
}

function collectAstFields(ast: unknown, result: Set<string>, seen = new Set<object>()): void {
  if (ast === null || typeof ast !== 'object' || seen.has(ast)) return;
  seen.add(ast);
  const record = ast as Record<string, unknown>;
  if (typeof record.field === 'string') result.add(record.field);
  for (const value of Object.values(record)) {
    if (typeof value === 'function') continue;
    if (Array.isArray(value)) {
      for (const entry of value) collectAstFields(entry, result, seen);
    } else {
      collectAstFields(value, result, seen);
    }
  }
}

export function queryAuthorizationFields(entity: QueryEntity): string[] {
  const out = new Set<string>();
  if (entity.scopeAst) collectAstFields(entity.scopeAst, out);
  for (const [name, descriptor] of Object.entries(entity.fields ?? {})) {
    if (descriptor?.role === 'owner' || name === 'owner' || name === 'projectId') out.add(name);
  }
  const declared = fieldsOf(entity);
  return [...out].filter((field) => declared.has(field));
}

function fieldTypeOf(entity: QueryEntity, field: string): QueryFieldType {
  if (field === 'id') return 'text';
  const type = entity.fields[field]?.type;
  if (type && type in OPERATORS_BY_FIELD_TYPE) return type as QueryFieldType;
  fail(`field '${field}' has no queryable type.`);
}

function operatorsFor(fieldType: string): readonly QueryOperator[] {
  const allowed = OPERATORS_BY_FIELD_TYPE[fieldType as QueryFieldType];
  if (!allowed) fail(`field type '${fieldType}' is not queryable.`);
  return allowed;
}

function bindDateValue(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) fail(`${label} must be a finite number or ISO date string.`);
    return ms;
  }
  fail(`${label} must be a finite number or ISO date string.`);
}

function assertTypedValue(fieldType: string, value: unknown, label: string): void {
  assertSqlValue(value, label);
  if (fieldType === 'boolean') {
    if (typeof value !== 'boolean') fail(`${label} must be a boolean.`);
    return;
  }
  if (fieldType === 'date') {
    bindDateValue(value, label);
    return;
  }
  if (fieldType === 'number' || fieldType === 'epoch') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number.`);
    return;
  }
  if (typeof value !== 'string') fail(`${label} must be a string.`);
}

function bindTypedValue(fieldType: string, value: unknown, label: string): unknown {
  if (fieldType === 'date') return bindDateValue(value, label);
  assertTypedValue(fieldType, value, label);
  if (fieldType === 'boolean') return value ? 1 : 0;
  return value;
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export function compileFilterPredicate(input: {
  column: string;
  op: QueryOperator;
  value: unknown;
  fieldType: string;
  params: Record<string, unknown>;
  index: number;
}): string {
  const allowed = operatorsFor(input.fieldType);
  if (!(allowed as readonly string[]).includes(input.op)) fail(`operator '${input.op}' is not supported on ${input.fieldType} fields.`);
  const column = input.column;
  if (input.op === 'isEmpty') {
    if (input.value !== undefined && input.value !== null) fail('isEmpty does not accept a value.');
    return input.fieldType === 'text' ? `(${column} IS NULL OR ${column} = '')` : `${column} IS NULL`;
  }
  if (input.op === 'isNotEmpty') {
    if (input.value !== undefined && input.value !== null) fail('isNotEmpty does not accept a value.');
    return input.fieldType === 'text' ? `(${column} IS NOT NULL AND ${column} != '')` : `${column} IS NOT NULL`;
  }
  if (input.op === 'in') {
    if (!Array.isArray(input.value) || input.value.length === 0 || input.value.length > IN_VALUES_MAX) {
      fail('in requires 1 through 100 values.');
    }
    const names = input.value.map((item, itemIndex) => {
      const name = `query_f${input.index}_${itemIndex}`;
      input.params[name] = bindTypedValue(input.fieldType, item, 'in value');
      return `:${name}`;
    });
    return `${column} IN (${names.join(', ')})`;
  }
  if (input.op === 'contains') {
    if (typeof input.value !== 'string' || input.value.length === 0) fail('contains requires a non-empty string.');
    const name = `query_f${input.index}`;
    input.params[name] = escapeLike(input.value);
    return `${column} LIKE '%' || :${name} || '%' ESCAPE '\\'`;
  }
  const name = `query_f${input.index}`;
  input.params[name] = bindTypedValue(input.fieldType, input.value, 'filter value');
  const operator = ({ eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const)[input.op];
  return `${column} ${operator} :${name}`;
}

export function compileHostFilter(
  filter: unknown,
  entity: QueryEntity,
  params: Record<string, unknown>,
  index: number,
  options: { allowKind?: boolean; label?: string } = {},
): { sql: string; field: string; op: QueryOperator; value: unknown } {
  const label = options.label ?? 'filter';
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) fail(`${label}s must be objects.`);
  assertKeys(filter, options.allowKind ? TERM_KEYS : FILTER_KEYS, label);
  const { field, op = 'eq', value } = filter as QueryFilter;
  const declared = fieldsOf(entity);
  if (typeof field !== 'string' || !declared.has(field)) fail('a filter references an unknown field.');
  assertScalarField(entity, field, 'filter field');
  if (!(QUERY_OPERATORS as readonly string[]).includes(op)) fail('a filter uses an unsupported operator.');
  const fieldType = fieldTypeOf(entity, field);
  const column = `t0.${identifier(field, 'filter field')}`;
  const sql = compileFilterPredicate({ column, op, value, fieldType, params, index });
  if (op === 'isEmpty' || op === 'isNotEmpty') return { sql, field, op, value: null };
  return { sql, field, op, value: freezeJsonValue(value) };
}

export function compileFilterExpression(
  node: unknown,
  compileLeaf: (node: Record<string, unknown>, state: FilterExpressionCompileState) => CompiledExpressionLeaf,
  state: FilterExpressionCompileState = { leaves: 0, paramIndex: 0 },
  depth = 1,
): CompiledExpressionLeaf {
  if (depth > QUERY_EXPRESSION_MAX_DEPTH) {
    fail(`filter expression exceeds maximum nesting depth of ${QUERY_EXPRESSION_MAX_DEPTH}.`);
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    fail('filter expression node must be an object.');
  }
  const record = node as Record<string, unknown>;
  const kind = record.kind;
  if (kind === 'and' || kind === 'or') {
    assertKeys(record, GROUP_KEYS, `${kind} expression`);
    const children = record.children;
    if (!Array.isArray(children) || children.length === 0) {
      fail(`${kind} expression requires a non-empty children array.`);
    }
    const compiled = children.map((child) => compileFilterExpression(child, compileLeaf, state, depth + 1));
    const joiner = kind === 'and' ? ' AND ' : ' OR ';
    const fields = [...new Set(compiled.flatMap((child) => child.fields))];
    return {
      sql: `(${compiled.map((child) => child.sql).join(joiner)})`,
      normalized: Object.freeze({
        kind,
        children: Object.freeze(compiled.map((child) => child.normalized)),
      }),
      fields,
    };
  }
  if (kind === 'not') {
    assertKeys(record, NOT_KEYS, 'not expression');
    const compiled = compileFilterExpression(record.child, compileLeaf, state, depth + 1);
    return {
      // 2-valued complement: SQLite NULLs do not satisfy the inner predicate, so
      // NOT matches them just like in-memory boolean filter semantics.
      sql: `(NOT COALESCE((${compiled.sql}), 0))`,
      normalized: Object.freeze({ kind: 'not', child: compiled.normalized }),
      fields: compiled.fields,
    };
  }
  state.leaves += 1;
  if (state.leaves > QUERY_EXPRESSION_MAX_LEAVES) {
    fail(`filter expression exceeds maximum leaf count of ${QUERY_EXPRESSION_MAX_LEAVES}.`);
  }
  return compileLeaf(record, state);
}

function compileHostTermLeaf(
  node: Record<string, unknown>,
  entity: QueryEntity,
  params: Record<string, unknown>,
  state: FilterExpressionCompileState,
): CompiledExpressionLeaf {
  if (node.kind !== 'term') fail('filter expression uses an unsupported node kind.');
  const compiled = compileHostFilter(node, entity, params, state.paramIndex++, {
    allowKind: true,
    label: 'term expression',
  });
  const normalized: QueryFilterTermNode = compiled.op === 'isEmpty' || compiled.op === 'isNotEmpty'
    ? Object.freeze({ kind: 'term', field: compiled.field, op: compiled.op })
    : Object.freeze({ kind: 'term', field: compiled.field, op: compiled.op, value: compiled.value });
  return {
    sql: compiled.sql,
    normalized,
    fields: [compiled.field],
  };
}

export function compileQueryContract(
  input: unknown,
  entity: QueryEntity,
  options: CompileQueryContractOptions = {},
): CompiledQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('contract must be an object.');
  assertKeys(input, CONTRACT_KEYS, 'contract');
  const contract = input as QueryContract;
  if (contract.entity !== entity.name) fail('contract entity does not match the compiled entity.');
  identifier(entity.name, 'entity name');
  assertQueryableEntity(entity);
  const declared = fieldsOf(entity);
  if (contract.filters !== undefined && !Array.isArray(contract.filters)) fail('filters must be an array.');
  if ((contract.filters?.length ?? 0) > FILTERS_MAX) fail('filters must contain at most 16 entries.');
  const hasWhere = contract.where !== undefined && contract.where !== null;
  const hasExpression = contract.expression !== undefined && contract.expression !== null;
  if (hasWhere && hasExpression) fail('contract cannot specify both where and expression.');
  const rawWhere = hasWhere ? contract.where : hasExpression ? contract.expression : null;

  const params: Record<string, unknown> = {};
  const state: FilterExpressionCompileState = { leaves: 0, paramIndex: 0 };
  const filters = (contract.filters ?? []).map((filter) => {
    state.leaves += 1;
    if (state.leaves > QUERY_EXPRESSION_MAX_LEAVES) {
      fail(`filter expression exceeds maximum leaf count of ${QUERY_EXPRESSION_MAX_LEAVES}.`);
    }
    const compiled = compileHostFilter(filter, entity, params, state.paramIndex++);
    return Object.freeze({ field: compiled.field, op: compiled.op, value: compiled.value });
  });
  const compiledWhere = rawWhere !== null
    ? compileFilterExpression(rawWhere, (node, exprState) => compileHostTermLeaf(node, entity, params, exprState), state)
    : null;

  if (!contract.sort || typeof contract.sort !== 'object' || Array.isArray(contract.sort)) fail('sort is required.');
  assertKeys(contract.sort, SORT_KEYS, 'sort');
  const { field: sortField, direction = 'asc' } = contract.sort;
  if (typeof sortField !== 'string' || !declared.has(sortField)) fail('sort references an unknown field.');
  assertScalarField(entity, sortField, 'sort field');
  if (direction !== 'asc' && direction !== 'desc') fail('sort direction must be asc or desc.');
  const maxPageSize = resolveMaxPageSize(options.maxPageSize);
  const pageSize = contract.pageSize;
  if (!Number.isSafeInteger(pageSize) || pageSize < QUERY_PAGE_SIZE_MIN || pageSize > maxPageSize) {
    fail(`pageSize must be an integer from ${QUERY_PAGE_SIZE_MIN} through ${maxPageSize}.`);
  }
  const whereNode = (compiledWhere?.normalized as QueryFilterExpression | undefined) ?? null;
  const identity = canonicalStringify({
    entity: entity.name,
    filters: filters.map((filter) => (
      filter.op === 'isEmpty' || filter.op === 'isNotEmpty'
        ? { field: filter.field, op: filter.op }
        : { field: filter.field, op: filter.op, value: filter.value }
    )),
    ...(whereNode ? { where: whereNode } : {}),
    sort: { field: sortField, direction },
    pageSize,
  });
  const dependencyFields = Object.freeze([
    ...new Set([
      ...filters.map((filter) => filter.field),
      ...(compiledWhere?.fields ?? []),
      sortField,
      ...queryAuthorizationFields(entity),
    ]),
  ]);
  return Object.freeze({
    entity: entity.name,
    identity,
    filters: Object.freeze(filters),
    where: whereNode,
    sort: Object.freeze({ field: sortField, direction }),
    pageSize,
    maxPageSize,
    dependencyFields,
  });
}

export function asSafeRevision(value: unknown, label: string): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return value;
    fail(`${label} exceeds safe range.`);
  }
  if (typeof value === 'bigint') {
    const converted = Number(value);
    if (!Number.isSafeInteger(converted)) fail(`${label} exceeds safe range.`);
    return converted;
  }
  fail(`${label} is missing.`);
}

export function readCommittedRevision(db: QueryDb): number {
  let row: Record<string, unknown> | undefined;
  try {
    row = db.prepare("SELECT revision FROM _CommittedRevision WHERE name = 'actions'").get() as Record<string, unknown> | undefined;
  } catch (err) {
    throw new QueryScopedReadError(`committed revision is unavailable (${err instanceof Error ? err.message : String(err)}).`);
  }
  try {
    return asSafeRevision(row?.revision, 'committed revision token');
  } catch (err) {
    if (err instanceof QueryScopedReadError) throw err;
    fail('committed revision token is missing.');
  }
}

function grantFilter(entity: QueryEntity, principal: unknown): { sql: string; params: Record<string, unknown> } {
  // Every SQL page (and the invalidation hub's admission recheck) funnels
  // through here; keep the can-only guard on the choke point as well as on the
  // public entry points so a direct selectAuthorizedPage caller cannot bypass it.
  assertQueryableEntity(entity);
  if (typeof entity.scopeFilter !== 'function') fail('entity has no compiled grant filter.');
  const filter = entity.scopeFilter(principal);
  if (!filter || typeof filter.sql !== 'string') fail('compiled grant filter is malformed.');
  return { sql: filter.sql, params: { ...filter.params } };
}

/** Rewrite `:name` placeholders so two compiled grants cannot share a bind key. */
export function namespaceSqlParams(
  sql: string,
  params: Record<string, unknown>,
  prefix: string,
): { sql: string; params: Record<string, unknown> } {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(prefix)) fail('param namespace prefix must be an identifier.');
  const namespaced: Record<string, unknown> = {};
  let rewritten = sql;
  for (const key of Object.keys(params).sort((a, b) => b.length - a.length)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`grant param '${key}' is not a SQL identifier.`);
    const next = `${prefix}_${key}`;
    namespaced[next] = params[key];
    rewritten = rewritten.replace(new RegExp(`:${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g'), `:${next}`);
  }
  return { sql: rewritten, params: namespaced };
}

function isDeniedGrant(sql: string): boolean {
  const compact = sql.replace(/\s+/g, '');
  return compact === '1=0' || compact === '(1=0)';
}

function assertAdmitted(entity: QueryEntity, principal: unknown): { sql: string; params: Record<string, unknown> } {
  const grant = grantFilter(entity, principal);
  if (isDeniedGrant(grant.sql)) fail('principal is not admitted to this entity.');
  return grant;
}

function principalStillAdmitted(entity: QueryEntity, principal: unknown): boolean {
  try {
    const grant = grantFilter(entity, principal);
    return !isDeniedGrant(grant.sql);
  } catch {
    return false;
  }
}

function defaultScopeField(scope: string, entityName: string): string | null {
  const parsed = tryParseScopeKey(scope);
  if (!parsed) return null;
  if (parsed.entity === entityName) return 'id';
  return `${parsed.entity.charAt(0).toLowerCase()}${parsed.entity.slice(1)}Id`;
}

function resolveScopeField(entity: QueryEntity, scope: string, explicit: string | undefined): string {
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || explicit.length === 0) fail('scopeField must be a declared field name.');
  }
  const field = explicit ?? defaultScopeField(scope, entity.name);
  if (typeof field !== 'string' || field.length === 0) fail('scopeField cannot be resolved on the entity.');
  if (field !== 'id' && !entity.fields[field]) fail(`scopeField '${field}' is not a declared field.`);
  return field;
}

function filterSql(compiled: CompiledQuery, entity: QueryEntity, params: Record<string, unknown>): string {
  const state: FilterExpressionCompileState = { leaves: 0, paramIndex: 0 };
  const parts: string[] = [];
  for (const filter of compiled.filters) {
    state.leaves += 1;
    parts.push(compileHostFilter(filter, entity, params, state.paramIndex++).sql);
  }
  if (compiled.where) {
    parts.push(
      compileFilterExpression(
        compiled.where,
        (node, exprState) => compileHostTermLeaf(node, entity, params, exprState),
        state,
      ).sql,
    );
  }
  return parts.join(' AND ');
}

export function keysetSql(sortColumn: string, direction: 'asc' | 'desc', cursor: QueryCursor, params: Record<string, unknown>): string {
  params.query_cursor_sort = cursor.sortValue;
  params.query_cursor_id = cursor.id;
  const sort = sortColumn;
  if (direction === 'asc') {
    return `(
      (:query_cursor_sort IS NULL AND ${sort} IS NULL AND t0.id > :query_cursor_id)
      OR (:query_cursor_sort IS NULL AND ${sort} IS NOT NULL)
      OR (:query_cursor_sort IS NOT NULL AND ${sort} > :query_cursor_sort)
      OR (:query_cursor_sort IS NOT NULL AND ${sort} = :query_cursor_sort AND t0.id > :query_cursor_id)
    )`;
  }
  return `(
    (:query_cursor_sort IS NULL AND ${sort} IS NULL AND t0.id > :query_cursor_id)
    OR (:query_cursor_sort IS NOT NULL AND ${sort} < :query_cursor_sort)
    OR (:query_cursor_sort IS NOT NULL AND ${sort} = :query_cursor_sort AND t0.id > :query_cursor_id)
    OR (:query_cursor_sort IS NOT NULL AND ${sort} IS NULL)
  )`;
}

/**
 * Rebuild the keyset cursor that starts AFTER one row of an executed page.
 * `QueryPage.sortValues` carries the raw (pre-hydration) key so a route that
 * post-filters admitted rows can hand the client a cursor anchored on the last
 * row it actually returned, using the same compiled sort key as the page.
 */
export function queryCursorForRow(page: QueryPage, index: number): QueryCursor | null {
  const row = page.rows[index];
  if (!row || row.id === undefined || row.id === null) return null;
  return Object.freeze({
    queryIdentity: page.queryIdentity,
    sortValue: page.sortValues?.[index] ?? null,
    id: String(row.id),
  });
}

export function selectAuthorizedPage(
  db: QueryDb,
  entity: QueryEntity,
  principal: unknown,
  input: {
    identity: string;
    extraWhere?: string | null;
    extraParams?: Record<string, unknown>;
    sort?: QuerySort;
    customSort?: CustomSortSpec | null;
    pageSize: number;
    maxPageSize?: number;
    cursor?: QueryCursor | null;
    offset?: number;
    maxOffset?: number;
    includeCount?: boolean;
    includeTotal?: boolean;
    hydrate?: boolean;
  },
): Omit<QueryPage, 'revision'> {
  const table = identifier(entity.name, 'entity name');
  const customSort = input.customSort ?? null;
  let sortField: string | null = null;
  let sortColumn: string;
  let sortDirection: 'asc' | 'desc';
  let joinClause = '';

  if (customSort) {
    if (customSort.direction !== 'asc' && customSort.direction !== 'desc') {
      fail('sort direction must be asc or desc.');
    }
    sortColumn = customSort.sortColumn;
    sortDirection = customSort.direction;
    joinClause = customSort.joinSql ? ` ${customSort.joinSql}` : '';
  } else {
    sortField = input.sort?.field ?? null;
    if (typeof sortField !== 'string') fail('sort is required.');
    assertScalarField(entity, sortField, 'sort field');
    if (input.sort!.direction !== 'asc' && input.sort!.direction !== 'desc') {
      fail('sort direction must be asc or desc.');
    }
    sortColumn = `t0.${identifier(sortField, 'sort field')}`;
    sortDirection = input.sort!.direction;
  }

  const maxPageSize = resolveMaxPageSize(input.maxPageSize);
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < QUERY_PAGE_SIZE_MIN || input.pageSize > maxPageSize) {
    fail(`pageSize must be an integer from ${QUERY_PAGE_SIZE_MIN} through ${maxPageSize}.`);
  }
  // A caller that always sends an `offset: 0` alongside its keyset token is
  // still advancing a keyset page; only a positive offset conflicts with a
  // cursor. Treat zero as "no offset" so offset-based and cursor-based callers
  // can share one request shape without a spurious rejection.
  const hasOffset = input.offset !== undefined && input.offset !== 0;
  if (input.cursor && hasOffset) {
    fail('cursor and offset cannot be combined.');
  }
  if (input.cursor) {
    if (input.cursor.queryIdentity !== input.identity) fail('page token does not match this query.');
    if (typeof input.cursor.id !== 'string' || input.cursor.id.length === 0) fail('page token id is required.');
  }
  if (input.offset !== undefined) {
    const maxOffset = resolveMaxOffset(input.maxOffset);
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > maxOffset) {
      fail(`offset must be an integer from 0 through ${maxOffset}.`);
    }
  }

  const params: Record<string, unknown> = {
    ...(input.extraParams ?? {}),
    ...(customSort?.params ?? {}),
  };
  const rawGrant = grantFilter(entity, principal);
  const grant = namespaceSqlParams(rawGrant.sql, rawGrant.params, 'qhost');
  Object.assign(params, grant.params);
  const parts = [grant.sql];
  if (input.extraWhere) parts.push(input.extraWhere);
  if (input.cursor) {
    parts.push(keysetSql(sortColumn, sortDirection, input.cursor, params));
  }
  const where = parts.map((part) => `(${part})`).join(' AND ');
  const direction = sortDirection === 'desc' ? 'DESC' : 'ASC';
  params.query_limit = input.pageSize + 1;
  let offsetClause = '';
  if (hasOffset) {
    params.query_offset = input.offset;
    offsetClause = ' OFFSET :query_offset';
  }
  const selectClause = customSort ? `t0.*, ${sortColumn} AS __wb_sort_value` : 't0.*';
  const sql = `SELECT ${selectClause} FROM ${table} AS t0${joinClause} WHERE ${where} ORDER BY ${sortColumn} ${direction}, t0.id ASC LIMIT :query_limit${offsetClause}`;
  const rawFetched = db.prepare(sql).all(params) as Record<string, unknown>[];
  const hasMore = rawFetched.length > input.pageSize;
  const rawRows = hasMore ? rawFetched.slice(0, input.pageSize) : rawFetched;
  const lastRaw = rawRows.at(-1);
  const nextCursor = hasMore && lastRaw
    ? Object.freeze({
      queryIdentity: input.identity,
      sortValue: customSort ? lastRaw.__wb_sort_value : lastRaw[sortField!],
      id: String(lastRaw.id),
    })
    : null;

  const hydrate = input.hydrate !== false;
  const rows = rawRows.map((raw) => {
    if (customSort) {
      const { __wb_sort_value: _sortValue, ...hostRow } = raw;
      return materializeQueryRow(hostRow, entity, hydrate);
    }
    return materializeQueryRow(raw, entity, hydrate);
  });

  let filteredTotal: number | undefined;
  if (input.includeCount === true) {
    const countParams: Record<string, unknown> = { ...(input.extraParams ?? {}), ...grant.params };
    const countParts = [grant.sql];
    if (input.extraWhere) countParts.push(input.extraWhere);
    const countWhere = countParts.map((part) => `(${part})`).join(' AND ');
    const countRow = db.prepare(`SELECT COUNT(*) AS n FROM ${table} AS t0 WHERE ${countWhere}`).get(countParams) as Record<string, unknown> | undefined;
    filteredTotal = asSafeRevision(countRow?.n ?? 0, 'count');
  }

  let total: number | undefined;
  if (input.includeTotal === true) {
    const totalParams: Record<string, unknown> = { ...grant.params };
    const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM ${table} AS t0 WHERE (${grant.sql})`).get(totalParams) as Record<string, unknown> | undefined;
    total = asSafeRevision(totalRow?.n ?? 0, 'total');
  }

  return {
    rows: Object.freeze(rows),
    hasMore,
    nextCursor,
    queryIdentity: input.identity,
    sortValues: Object.freeze(rawRows.map((raw) => customSort ? raw.__wb_sort_value : raw[sortField!])),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
    ...(input.includeCount === true ? { count: filteredTotal, filteredTotal } : {}),
    ...(input.includeTotal === true ? { total } : {}),
  };
}

let snapshotSeq = 0;

/**
 * Execute `run` inside a single SQLite read snapshot when not already inside a
 * transaction. An outermost SQLite SAVEPOINT opens a deferred read transaction
 * (identical snapshot semantics to BEGIN DEFERRED, taking no write lock), and
 * nests cleanly if a caller already owns an open transaction without exposing
 * `isTransaction`.
 */
export function withReadSnapshot<T>(db: QuerySnapshotDb, run: () => T): T {
  if (db.isTransaction === true) {
    return run();
  }
  if (typeof db.exec !== 'function') {
    throw new QueryScopedReadError('database must support exec for a consistent read snapshot');
  }
  const name = `wb_qsnap_${++snapshotSeq}`;
  db.exec(`SAVEPOINT ${name}`);
  let failed = false;
  try {
    return run();
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    try {
      db.exec(`RELEASE SAVEPOINT ${name}`);
    } catch (releaseErr) {
      if (!failed) throw releaseErr;
    }
  }
}

export function withRevisionFence(db: QuerySnapshotDb, run: () => Omit<QueryPage, 'revision'>): QueryPage {
  return withReadSnapshot(db, () => {
    const revision = readCommittedRevision(db);
    const page = run();
    return Object.freeze({ ...page, revision });
  });
}

function runPage(
  db: QueryDb,
  entity: QueryEntity,
  principal: unknown,
  compiled: CompiledQuery,
  options: ExecuteQueryPageOptions,
): Omit<QueryPage, 'revision'> {
  const extraParams: Record<string, unknown> = {};
  const extra = filterSql(compiled, entity, extraParams);
  return selectAuthorizedPage(db, entity, principal, {
    identity: compiled.identity,
    extraWhere: extra || null,
    extraParams,
    sort: compiled.sort,
    pageSize: compiled.pageSize,
    maxPageSize: compiled.maxPageSize,
    cursor: options.cursor,
    offset: options.offset,
    maxOffset: options.maxOffset,
    includeCount: options.includeCount === true,
    includeTotal: options.includeTotal === true,
    hydrate: options.hydrate,
  });
}

export function executeQueryPage(
  db: QuerySnapshotDb,
  entity: QueryEntity,
  principal: unknown,
  compiled: CompiledQuery,
  options: ExecuteQueryPageOptions = {},
): QueryPage {
  assertQueryableEntity(entity);
  if (compiled.entity !== entity.name) fail('compiled query does not match the entity.');
  return withRevisionFence(db, () => runPage(db, entity, principal, compiled, options));
}

export function acceptQueryPage(heldRevision: number, incomingRevision: number): QueryPageDecision {
  if (!Number.isSafeInteger(heldRevision) || !Number.isSafeInteger(incomingRevision)) {
    fail('revision tokens must be safe integers.');
  }
  return incomingRevision < heldRevision ? 'reject-stale' : 'accept';
}

export function overlayOptimisticQueryPage(
  page: QueryPage,
  pending: readonly PendingQueryWrite[],
  compiled: CompiledQuery,
): OptimisticQueryPage {
  const dependency = new Set(compiled.dependencyFields);
  let membershipUncertain = false;
  const previews = new Map<string, Record<string, unknown>>();
  for (const write of pending) {
    if (write.verb === 'create' || write.verb === 'remove') {
      membershipUncertain = true;
      continue;
    }
    const fields = write.fields ?? {};
    if (Object.keys(fields).some((field) => dependency.has(field))) {
      membershipUncertain = true;
      continue;
    }
    previews.set(write.id, fields);
  }
  const rows = page.rows.map((row) => {
    const preview = previews.get(String(row.id));
    return preview ? Object.freeze({ ...row, ...preview }) : row;
  });
  return Object.freeze({
    rows: Object.freeze(rows),
    revision: page.revision,
    membershipUncertain,
  });
}

interface QueryRegistration {
  id: string;
  entityName: string;
  fields: ReadonlySet<string>;
  scope: string;
  scopeField: string;
  principalKey: string;
  compiledEntity: QueryEntity;
  lastInvalidatedRevision: number | null;
  registeredAtRevision: number;
  registeredAtMs: number;
  lastTouchedMs: number;
}

function eventHandleOf(event: unknown): EventIdentityHandle | null {
  if (!event || typeof event !== 'object') return null;
  const value = event as { handle?: unknown; type?: unknown };
  const handle = value.handle as EventIdentityHandle | undefined;
  if (handle && handle.brand === 'event-handle') return handle;
  if (typeof value.type === 'string') {
    try {
      return parseEventType(value.type);
    } catch {
      return null;
    }
  }
  return null;
}

function eventEntityOf(event: unknown, handle: EventIdentityHandle | null): string | null {
  if (handle) return handle.entity;
  if (!event || typeof event !== 'object') return null;
  const scope = (event as { scope?: unknown }).scope;
  if (typeof scope === 'string') {
    const parsed = tryParseScopeKey(scope);
    return parsed?.entity ?? null;
  }
  return null;
}

function eventTouches(event: unknown, handle: EventIdentityHandle | null, fields: ReadonlySet<string>): boolean {
  if (!handle) return true;
  if (handle.kind === EventKind.created || handle.kind === EventKind.removed) return true;
  if (fields.size === 0) return true;
  if ('field' in handle && typeof handle.field === 'string') return fields.has(handle.field);
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return true;
  return Object.keys(data).some((key) => key !== 'id' && fields.has(key));
}

function eventScopeMatches(event: unknown, registration: QueryRegistration): boolean {
  if (!event || typeof event !== 'object') return false;
  const raw = (event as { scope?: unknown }).scope;
  if (typeof raw !== 'string') return false;
  if (raw === registration.scope) return true;
  const wanted = tryParseScopeKey(registration.scope);
  const got = tryParseScopeKey(raw);
  if (!wanted || !got) return false;
  if (got.key === wanted.key) return true;
  if (got.entity !== registration.entityName || !registration.scopeField) return false;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return false;
  return (data as Record<string, unknown>)[registration.scopeField] === wanted.id;
}

function assertVisibleInScope(
  db: QueryDb,
  entity: QueryEntity,
  principal: unknown,
  scope: string,
  scopeField: string,
): void {
  const grant = assertAdmitted(entity, principal);
  const parsed = tryParseScopeKey(scope);
  if (!parsed) fail('dependency scope must be a Scope handle.');
  if (scopeField !== 'id' && !entity.fields[scopeField]) fail(`scopeField '${scopeField}' is not a declared field.`);
  const params: Record<string, unknown> = { ...grant.params, query_scope_id: parsed.id };
  const sql = `SELECT 1 AS ok FROM ${identifier(entity.name, 'entity name')} AS t0 WHERE (${grant.sql}) AND t0.${identifier(scopeField, 'scope field')} = :query_scope_id LIMIT 1`;
  const row = db.prepare(sql).get(params);
  if (!row) fail('principal cannot see this query scope.');
}

export function createQueryInvalidationHub(options: {
  maxRegistrations?: number;
  ttlMs?: number;
  now?: () => number;
} = {}) {
  const maxRegistrations = options.maxRegistrations ?? QUERY_REGISTRATION_MAX;
  if (!Number.isSafeInteger(maxRegistrations) || maxRegistrations < 1) fail('maxRegistrations must be a positive integer.');
  const ttlMs = options.ttlMs ?? QUERY_REGISTRATION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) fail('ttlMs must be a positive integer.');
  const now = options.now ?? Date.now;
  const registrations = new Map<string, QueryRegistration>();

  function pruneExpired(): void {
    const at = now();
    for (const [key, registration] of registrations) {
      if (at - registration.lastTouchedMs >= ttlMs) registrations.delete(key);
    }
  }

  function slot(principalKey: string, id: string): string {
    return `${principalKey}\n${id}`;
  }

  function prepare(input: {
    id: string;
    dependency: QueryDependency;
    principal: unknown;
    entity: QueryEntity;
    db: QueryDb;
    revision: number;
  }): { key: string; record: QueryRegistration } {
    if (typeof input.id !== 'string' || input.id.length === 0) fail('registration id is required.');
    if (!Number.isSafeInteger(input.revision)) fail('registration revision must be a safe integer.');
    const principalKey = queryPrincipalKey(input.principal);
    if (!input.dependency || typeof input.dependency !== 'object') fail('dependency is required.');
    identifier(input.dependency.entity, 'dependency entity');
    if (input.dependency.entity !== input.entity.name) fail('dependency entity does not match the compiled entity.');
    if (!Array.isArray(input.dependency.fields)) fail('dependency fields must be an array.');
    if (typeof input.dependency.scope !== 'string' || input.dependency.scope.length === 0) fail('dependency scope is required.');
    if (!tryParseScopeKey(input.dependency.scope)) fail('dependency scope must be a Scope handle.');
    const scopeField = resolveScopeField(input.entity, input.dependency.scope, input.dependency.scopeField);
    assertVisibleInScope(input.db, input.entity, input.principal, input.dependency.scope, scopeField);
    return {
      key: slot(principalKey, input.id),
      record: {
        id: input.id,
        entityName: input.dependency.entity,
        fields: new Set(input.dependency.fields),
        scope: input.dependency.scope,
        scopeField,
        principalKey,
        compiledEntity: input.entity,
        lastInvalidatedRevision: null,
        registeredAtRevision: input.revision,
        // Replaced with the commit clock in commitPrepared (atomic batching).
        registeredAtMs: 0,
        lastTouchedMs: 0,
      },
    };
  }

  function commitPrepared(prepared: readonly { key: string; record: QueryRegistration }[]): void {
    pruneExpired();
    const newKeys = new Set(prepared.filter((entry) => !registrations.has(entry.key)).map((entry) => entry.key));
    // A single batch that cannot fit is refused atomically — never a partial
    // family registration. Otherwise evict the least-recently-used entries to
    // make room instead of leaking registrations forever.
    if (newKeys.size > maxRegistrations) {
      fail(`at most ${maxRegistrations} query registrations may be active.`);
    }
    let overflow = registrations.size + newKeys.size - maxRegistrations;
    if (overflow > 0) {
      const incoming = new Set(prepared.map((entry) => entry.key));
      const evictable = [...registrations.entries()]
        .filter(([key]) => !incoming.has(key))
        .sort((a, b) => a[1].lastTouchedMs - b[1].lastTouchedMs);
      for (const [key] of evictable.slice(0, overflow)) registrations.delete(key);
    }
    const at = now();
    for (const entry of prepared) {
      registrations.set(entry.key, {
        ...entry.record,
        registeredAtMs: at,
        lastTouchedMs: at,
      });
    }
  }

  function register(input: {
    id: string;
    dependency: QueryDependency;
    principal: unknown;
    entity: QueryEntity;
    db: QueryDb;
    revision: number;
  }): void {
    commitPrepared([prepare(input)]);
  }

  function registerMany(inputs: ReadonlyArray<{
    id: string;
    dependency: QueryDependency;
    principal: unknown;
    entity: QueryEntity;
    db: QueryDb;
    revision: number;
  }>): void {
    commitPrepared(inputs.map(prepare));
  }

  function unregister(id: string, principal: unknown): void {
    registrations.delete(slot(queryPrincipalKey(principal), id));
  }

  function notice(events: readonly unknown[], revision: number): void {
    if (!Number.isSafeInteger(revision)) fail('invalidation revision must be a safe integer.');
    pruneExpired();
    const at = now();
    for (const event of events) {
      const handle = eventHandleOf(event);
      const entity = eventEntityOf(event, handle);
      if (!entity) continue;
      for (const registration of registrations.values()) {
        if (registration.entityName !== entity) continue;
        if (!eventScopeMatches(event, registration)) continue;
        if (!eventTouches(event, handle, registration.fields)) continue;
        registration.lastTouchedMs = at;
        const previous = registration.lastInvalidatedRevision;
        if (previous !== null && revision < previous) continue;
        registration.lastInvalidatedRevision = previous === null ? revision : Math.max(previous, revision);
      }
    }
  }

  function changedSince(input: {
    id: string;
    principal: unknown;
    sinceRevision: number;
    revision: number;
  }): QueryInvalidationSignal {
    const principalKey = queryPrincipalKey(input.principal);
    if (!Number.isSafeInteger(input.sinceRevision) || !Number.isSafeInteger(input.revision)) {
      fail('revision tokens must be safe integers.');
    }
    if (input.sinceRevision > input.revision) fail('sinceRevision is ahead of the commit lifecycle.');
    pruneExpired();
    const registration = registrations.get(slot(principalKey, input.id));
    // Missing and foreign registrations share one signal so an id is not an
    // existence oracle. Revocation of *this* principal's registration is denied.
    if (!registration || registration.principalKey !== principalKey) {
      return Object.freeze({ kind: 'resync', revision: input.revision });
    }
    if (!principalStillAdmitted(registration.compiledEntity, input.principal)) {
      return Object.freeze({ kind: 'denied', revision: input.revision });
    }
    registration.lastTouchedMs = now();
    if (input.sinceRevision < registration.registeredAtRevision) {
      return Object.freeze({ kind: 'resync', revision: input.revision });
    }
    if (registration.lastInvalidatedRevision !== null && input.sinceRevision < registration.lastInvalidatedRevision) {
      return Object.freeze({ kind: 'changed', revision: input.revision });
    }
    return Object.freeze({ kind: 'unchanged', revision: input.revision });
  }

  return {
    register,
    registerMany,
    unregister,
    notice,
    changedSince,
    get size() {
      pruneExpired();
      return registrations.size;
    },
  };
}

export type QueryInvalidationHub = ReturnType<typeof createQueryInvalidationHub>;

export interface QueryInvalidationConsumerOptions {
  // Optional observer for a failed invalidation. The commit still stands; the
  // hook exists so operators can detect that clients may hold a stale page.
  readonly onError?: (error: unknown, events: readonly unknown[]) => void;
}

export function createQueryInvalidationConsumer(
  hub: QueryInvalidationHub,
  db: QueryDb,
  options: QueryInvalidationConsumerOptions | ((error: unknown, events: readonly unknown[]) => void) = {},
) {
  const onError = typeof options === 'function' ? options : options.onError;
  return async (events: readonly unknown[]): Promise<void> => {
    try {
      hub.notice(events, readCommittedRevision(db));
    } catch (err) {
      // post-commit isolation: an invalidation failure never undoes the commit,
      // but it must no longer be silent — clients may keep a stale page.
      getLog().warn('system', 'query invalidation notice failed', { err });
      try {
        onError?.(err, events);
      } catch (hookError) {
        getLog().warn('system', 'query invalidation onError hook failed', { err: hookError });
      }
    }
  };
}
