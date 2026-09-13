// Registered query families (#225, ADR-0009 phase 2).
//
// App authors register a family over a host entity plus a typed value catalog
// and element rows. Clients name that family and pass a field id, operator, and
// value — never a query program or SQL. Execution reuses compiled host grants,
// compileFilterPredicate, the revision fence, and keyset pagination.

import { canonicalStringify } from './canonical-json.ts';
import {
  compileFilterPredicate,
  compileQueryContract,
  QueryContentionError,
  QueryScopedReadError,
  QUERY_OPERATORS,
  QUERY_PAGE_SIZE_MIN,
  QUERY_PAGE_SIZE_MAX,
  readCommittedRevision,
  type QueryDb,
  type QueryEntity,
  type QueryOperator,
  type QuerySort,
  type QueryCursor,
  type QueryPage,
} from './query-scoped-read.ts';

export const DYNAMIC_VALUE_TYPES = Object.freeze(['text', 'number', 'epoch', 'boolean', 'option'] as const);
export type DynamicValueType = (typeof DYNAMIC_VALUE_TYPES)[number];

const FAMILY_KEYS = Object.freeze(['name', 'host', 'catalog', 'elements', 'hostKey', 'fieldKey', 'typeField', 'valueColumns']);
const REQUEST_KEYS = Object.freeze(['fieldId', 'op', 'value', 'sort', 'pageSize', 'cursor', 'includeCount']);

function fail(message: string): never {
  throw new QueryScopedReadError(message);
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

export interface QueryFamilyDeclaration {
  readonly name: string;
  readonly host: QueryEntity;
  readonly catalog: QueryEntity;
  readonly elements: QueryEntity;
  readonly hostKey: string;
  readonly fieldKey: string;
  readonly typeField: string;
  readonly valueColumns: Readonly<Record<DynamicValueType, string>>;
}

export interface CompiledQueryFamily {
  readonly name: string;
  readonly host: QueryEntity;
  readonly catalog: QueryEntity;
  readonly elements: QueryEntity;
  readonly hostKey: string;
  readonly fieldKey: string;
  readonly typeField: string;
  readonly valueColumns: Readonly<Record<DynamicValueType, string>>;
}

export interface QueryFamilyRequest {
  readonly fieldId: string;
  readonly op: QueryOperator;
  readonly value?: unknown;
  readonly sort: QuerySort;
  readonly pageSize: number;
  readonly cursor?: QueryCursor | null;
  readonly includeCount?: boolean;
}

function requireColumn(entity: QueryEntity, field: string, label: string): string {
  identifier(field, label);
  if (field !== 'id' && !entity.fields[field]) fail(`${label} '${field}' is not a declared field on ${entity.name}.`);
  return field;
}

export function compileQueryFamily(input: unknown): CompiledQueryFamily {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('family must be an object.');
  assertKeys(input, FAMILY_KEYS, 'family');
  const declaration = input as QueryFamilyDeclaration;
  if (typeof declaration.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(declaration.name)) {
    fail('family name must be a SQL identifier.');
  }
  if (!declaration.host?.name || !declaration.catalog?.name || !declaration.elements?.name) {
    fail('family host, catalog, and elements must be compiled entities.');
  }
  identifier(declaration.host.name, 'host entity');
  identifier(declaration.catalog.name, 'catalog entity');
  identifier(declaration.elements.name, 'elements entity');
  const hostKey = requireColumn(declaration.elements, declaration.hostKey, 'hostKey');
  const fieldKey = requireColumn(declaration.elements, declaration.fieldKey, 'fieldKey');
  const typeField = requireColumn(declaration.catalog, declaration.typeField, 'typeField');
  if (!declaration.valueColumns || typeof declaration.valueColumns !== 'object') fail('valueColumns is required.');
  const valueColumns = {} as Record<DynamicValueType, string>;
  for (const type of DYNAMIC_VALUE_TYPES) {
    const column = declaration.valueColumns[type];
    if (typeof column !== 'string') fail(`valueColumns.${type} is required.`);
    valueColumns[type] = requireColumn(declaration.elements, column, `valueColumns.${type}`);
  }
  return Object.freeze({
    name: declaration.name,
    host: declaration.host,
    catalog: declaration.catalog,
    elements: declaration.elements,
    hostKey,
    fieldKey,
    typeField,
    valueColumns: Object.freeze(valueColumns),
  });
}

function readCatalogType(
  db: QueryDb,
  family: CompiledQueryFamily,
  principal: unknown,
  fieldId: string,
): DynamicValueType {
  if (typeof family.catalog.scopeFilter !== 'function') fail('catalog entity has no compiled grant filter.');
  const grant = family.catalog.scopeFilter(principal);
  const params = { ...grant.params, query_field_id: fieldId };
  const sql = `SELECT t0.${identifier(family.typeField, 'typeField')} AS valueType FROM ${identifier(family.catalog.name, 'catalog entity')} AS t0 WHERE (${grant.sql}) AND t0.id = :query_field_id LIMIT 1`;
  const row = db.prepare(sql).get(params);
  const valueType = row?.valueType;
  if (typeof valueType !== 'string' || !(DYNAMIC_VALUE_TYPES as readonly string[]).includes(valueType)) {
    fail('a filter references an unknown field.');
  }
  return valueType as DynamicValueType;
}

function elementMatchSql(
  family: CompiledQueryFamily,
  fieldType: DynamicValueType,
  op: QueryOperator,
  value: unknown,
  params: Record<string, unknown>,
): string {
  const valueColumn = `e.${identifier(family.valueColumns[fieldType], 'value column')}`;
  const fieldColumn = `e.${identifier(family.fieldKey, 'fieldKey')}`;
  const hostRef = `e.${identifier(family.hostKey, 'hostKey')}`;
  const table = identifier(family.elements.name, 'elements entity');
  if (op === 'isEmpty') {
    const nonEmpty = compileFilterPredicate({
      column: valueColumn,
      op: 'isNotEmpty',
      value: undefined,
      fieldType,
      params,
      index: 0,
    });
    return `NOT EXISTS (SELECT 1 FROM ${table} AS e WHERE ${hostRef} = t0.id AND ${fieldColumn} = :query_field_id AND ${nonEmpty})`;
  }
  const predicate = compileFilterPredicate({
    column: valueColumn,
    op,
    value,
    fieldType,
    params,
    index: 0,
  });
  return `EXISTS (SELECT 1 FROM ${table} AS e WHERE ${hostRef} = t0.id AND ${fieldColumn} = :query_field_id AND ${predicate})`;
}

export function executeQueryFamily(
  db: QueryDb,
  family: CompiledQueryFamily,
  principal: unknown,
  request: unknown,
): QueryPage {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('family request must be an object.');
  assertKeys(request, REQUEST_KEYS, 'family request');
  const input = request as QueryFamilyRequest;
  if (typeof input.fieldId !== 'string' || input.fieldId.length === 0) fail('fieldId is required.');
  if (!(QUERY_OPERATORS as readonly string[]).includes(input.op)) fail('a filter uses an unsupported operator.');
  const fieldType = readCatalogType(db, family, principal, input.fieldId);

  const params: Record<string, unknown> = { query_field_id: input.fieldId };
  const match = elementMatchSql(family, fieldType, input.op, input.value, params);

  const compiled = compileQueryContract({
    entity: family.host.name,
    filters: [],
    sort: input.sort,
    pageSize: input.pageSize,
  }, family.host);

  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < QUERY_PAGE_SIZE_MIN || input.pageSize > QUERY_PAGE_SIZE_MAX) {
    fail(`pageSize must be an integer from ${QUERY_PAGE_SIZE_MIN} through ${QUERY_PAGE_SIZE_MAX}.`);
  }

  const identity = canonicalStringify({
    family: family.name,
    fieldId: input.fieldId,
    op: input.op,
    ...(input.op === 'isEmpty' || input.op === 'isNotEmpty' ? {} : { value: input.value ?? null }),
    sort: input.sort,
    pageSize: input.pageSize,
  });

  if (input.cursor && input.cursor.queryIdentity !== identity) fail('page token does not match this query.');

  const includeCount = input.includeCount === true;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = readCommittedRevision(db);
    if (typeof family.host.scopeFilter !== 'function') fail('host entity has no compiled grant filter.');
    const grant = family.host.scopeFilter(principal);
    const runParams = { ...grant.params, ...params };
    const sortField = input.sort?.field;
    if (typeof sortField !== 'string') fail('sort is required.');
    const direction = input.sort.direction === 'desc' ? 'DESC' : 'ASC';
    const sortColumn = `t0.${identifier(sortField, 'sort field')}`;
    const parts = [`(${grant.sql})`, `(${match})`];
    if (input.cursor) {
      if (typeof input.cursor.id !== 'string' || input.cursor.id.length === 0) fail('page token id is required.');
      runParams.query_cursor_sort = input.cursor.sortValue;
      runParams.query_cursor_id = input.cursor.id;
      if (direction === 'ASC') {
        parts.push(`(
          (:query_cursor_sort IS NULL AND ${sortColumn} IS NULL AND t0.id > :query_cursor_id)
          OR (:query_cursor_sort IS NULL AND ${sortColumn} IS NOT NULL)
          OR (:query_cursor_sort IS NOT NULL AND ${sortColumn} > :query_cursor_sort)
          OR (:query_cursor_sort IS NOT NULL AND ${sortColumn} = :query_cursor_sort AND t0.id > :query_cursor_id)
        )`);
      } else {
        parts.push(`(
          (:query_cursor_sort IS NULL AND ${sortColumn} IS NULL AND t0.id > :query_cursor_id)
          OR (:query_cursor_sort IS NOT NULL AND ${sortColumn} < :query_cursor_sort)
          OR (:query_cursor_sort IS NOT NULL AND ${sortColumn} = :query_cursor_sort AND t0.id > :query_cursor_id)
          OR (:query_cursor_sort IS NOT NULL AND ${sortColumn} IS NULL)
        )`);
      }
    }
    const where = parts.join(' AND ');
    runParams.query_limit = compiled.pageSize + 1;
    const sql = `SELECT * FROM ${identifier(family.host.name, 'host entity')} AS t0 WHERE ${where} ORDER BY ${sortColumn} ${direction}, t0.id ASC LIMIT :query_limit`;
    const fetched = db.prepare(sql).all(runParams).map((row) => Object.freeze({ ...row }));
    const hasMore = fetched.length > compiled.pageSize;
    const rows = hasMore ? fetched.slice(0, compiled.pageSize) : fetched;
    const last = rows.at(-1);
    const nextCursor = hasMore && last
      ? Object.freeze({ queryIdentity: identity, sortValue: last[sortField], id: String(last.id) })
      : null;
    let count: number | undefined;
    if (includeCount) {
      const countParams = { ...grant.params, ...params };
      const countRow = db.prepare(`SELECT COUNT(*) AS n FROM ${identifier(family.host.name, 'host entity')} AS t0 WHERE (${grant.sql}) AND (${match})`).get(countParams);
      const n = countRow?.n;
      count = typeof n === 'bigint' ? Number(n) : Number(n ?? 0);
    }
    const after = readCommittedRevision(db);
    if (before === after) {
      return Object.freeze({
        rows: Object.freeze(rows),
        revision: after,
        nextCursor,
        queryIdentity: identity,
        ...(includeCount ? { count } : {}),
      });
    }
    lastError = new QueryContentionError();
  }
  throw lastError ?? new QueryContentionError();
}

export function createQueryFamilyRegistry() {
  const families = new Map<string, CompiledQueryFamily>();
  return {
    register(declaration: unknown): CompiledQueryFamily {
      const compiled = compileQueryFamily(declaration);
      if (families.has(compiled.name)) fail(`family '${compiled.name}' is already registered.`);
      families.set(compiled.name, compiled);
      return compiled;
    },
    execute(name: string, db: QueryDb, principal: unknown, request: unknown): QueryPage {
      const family = families.get(name);
      if (!family) fail(`family '${name}' is not registered.`);
      return executeQueryFamily(db, family, principal, request);
    },
    get(name: string): CompiledQueryFamily | undefined {
      return families.get(name);
    },
  };
}
