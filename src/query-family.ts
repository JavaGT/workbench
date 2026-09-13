// Registered query families (#225, ADR-0009 phase 2).
//
// App authors register a family over a host entity plus a typed value catalog
// and element rows. Clients name that family and pass a field id, operator, and
// value — never a query program or SQL. Execution reuses compiled host grants,
// compileFilterPredicate, the revision fence, and keyset pagination.

import { canonicalStringify } from './canonical-json.ts';
import {
  compileFilterPredicate,
  QueryScopedReadError,
  QUERY_OPERATORS,
  namespaceSqlParams,
  selectAuthorizedPage,
  withRevisionFence,
  type QueryDb,
  type QueryDependency,
  type QueryEntity,
  type QueryInvalidationHub,
  type QueryInvalidationSignal,
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

const VALUE_COLUMN_TYPES: Readonly<Record<DynamicValueType, readonly string[]>> = Object.freeze({
  text: Object.freeze(['text']),
  number: Object.freeze(['number']),
  epoch: Object.freeze(['number', 'date']),
  boolean: Object.freeze(['boolean']),
  option: Object.freeze(['text', 'ref']),
});

function requireColumn(entity: QueryEntity, field: string, label: string, allowedTypes?: readonly string[]): string {
  identifier(field, label);
  if (field === 'id') {
    if (allowedTypes && !allowedTypes.includes('text')) fail(`${label} 'id' is not a ${allowedTypes.join('/')} field.`);
    return field;
  }
  const descriptor = entity.fields[field];
  if (!descriptor) fail(`${label} '${field}' is not a declared field on ${entity.name}.`);
  if (allowedTypes && !allowedTypes.includes(descriptor.type ?? '')) {
    fail(`${label} '${field}' must be a ${allowedTypes.join('/')} field.`);
  }
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
  const hostKey = requireColumn(declaration.elements, declaration.hostKey, 'hostKey', ['text', 'ref']);
  const fieldKey = requireColumn(declaration.elements, declaration.fieldKey, 'fieldKey', ['text', 'ref']);
  const typeField = requireColumn(declaration.catalog, declaration.typeField, 'typeField', ['text']);
  if (!declaration.valueColumns || typeof declaration.valueColumns !== 'object') fail('valueColumns is required.');
  const valueColumns = {} as Record<DynamicValueType, string>;
  for (const type of DYNAMIC_VALUE_TYPES) {
    const column = declaration.valueColumns[type];
    if (typeof column !== 'string') fail(`valueColumns.${type} is required.`);
    valueColumns[type] = requireColumn(declaration.elements, column, `valueColumns.${type}`, VALUE_COLUMN_TYPES[type]);
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
  const rawCatalog = family.catalog.scopeFilter(principal);
  const grant = namespaceSqlParams(rawCatalog.sql, rawCatalog.params, 'qcat');
  const params = { ...grant.params, query_field_id: fieldId };
  const sql = `SELECT t0.${identifier(family.typeField, 'typeField')} AS valueType FROM ${identifier(family.catalog.name, 'catalog entity')} AS t0 WHERE (${grant.sql}) AND t0.id = :query_field_id LIMIT 1`;
  const row = db.prepare(sql).get(params);
  const valueType = row?.valueType;
  if (typeof valueType !== 'string' || !(DYNAMIC_VALUE_TYPES as readonly string[]).includes(valueType)) {
    fail('a filter references an unknown field.');
  }
  return valueType as DynamicValueType;
}

function elementGrantSql(
  family: CompiledQueryFamily,
  principal: unknown,
  params: Record<string, unknown>,
): string {
  if (typeof family.elements.scopeFilter !== 'function') fail('elements entity has no compiled grant filter.');
  const raw = family.elements.scopeFilter(principal);
  const grant = namespaceSqlParams(raw.sql, raw.params, 'qelem');
  Object.assign(params, grant.params);
  const table = identifier(family.elements.name, 'elements entity');
  // Re-authorize in a subquery whose only alias is t0 so compiled grants
  // (bare `owner` or `t0.owner`) cannot bind to the outer host row.
  return `e.id IN (SELECT t0.id FROM ${table} AS t0 WHERE (${grant.sql}))`;
}

function elementMatchSql(
  family: CompiledQueryFamily,
  fieldType: DynamicValueType,
  op: QueryOperator,
  value: unknown,
  principal: unknown,
  params: Record<string, unknown>,
): string {
  const valueColumn = `e.${identifier(family.valueColumns[fieldType], 'value column')}`;
  const fieldColumn = `e.${identifier(family.fieldKey, 'fieldKey')}`;
  const hostRef = `e.${identifier(family.hostKey, 'hostKey')}`;
  const table = identifier(family.elements.name, 'elements entity');
  const visible = elementGrantSql(family, principal, params);
  if (op === 'isEmpty') {
    const nonEmpty = compileFilterPredicate({
      column: valueColumn,
      op: 'isNotEmpty',
      value: undefined,
      fieldType,
      params,
      index: 0,
    });
    return `NOT EXISTS (SELECT 1 FROM ${table} AS e WHERE ${hostRef} = t0.id AND ${fieldColumn} = :query_field_id AND ${nonEmpty} AND ${visible})`;
  }
  const predicate = compileFilterPredicate({
    column: valueColumn,
    op,
    value,
    fieldType,
    params,
    index: 0,
  });
  return `EXISTS (SELECT 1 FROM ${table} AS e WHERE ${hostRef} = t0.id AND ${fieldColumn} = :query_field_id AND ${predicate} AND ${visible})`;
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
  const identity = canonicalStringify({
    family: family.name,
    fieldId: input.fieldId,
    op: input.op,
    ...(input.op === 'isEmpty' || input.op === 'isNotEmpty' ? {} : { value: input.value ?? null }),
    sort: input.sort,
    pageSize: input.pageSize,
  });
  if (input.cursor && input.cursor.queryIdentity !== identity) fail('page token does not match this query.');
  return withRevisionFence(db, () => {
    const fieldType = readCatalogType(db, family, principal, input.fieldId);
    const extraParams: Record<string, unknown> = { query_field_id: input.fieldId };
    const extraWhere = elementMatchSql(family, fieldType, input.op, input.value, principal, extraParams);
    return selectAuthorizedPage(db, family.host, principal, {
      identity,
      extraWhere,
      extraParams,
      sort: input.sort,
      pageSize: input.pageSize,
      cursor: input.cursor,
      includeCount: input.includeCount === true,
    });
  });
}

export function queryFamilyDependencies(
  family: CompiledQueryFamily,
  scope: string,
  scopeField?: string,
): readonly QueryDependency[] {
  const hostFields = Object.freeze(['owner', 'projectId'].filter((name) => Boolean(family.host.fields[name])));
  const elementFields = Object.freeze([
    family.hostKey,
    family.fieldKey,
    ...DYNAMIC_VALUE_TYPES.map((type) => family.valueColumns[type]),
  ]);
  return Object.freeze([
    Object.freeze({ entity: family.host.name, fields: hostFields, scope, ...(scopeField ? { scopeField } : {}) }),
    Object.freeze({ entity: family.catalog.name, fields: Object.freeze([family.typeField]), scope, ...(scopeField ? { scopeField } : {}) }),
    Object.freeze({ entity: family.elements.name, fields: elementFields, scope, ...(scopeField ? { scopeField } : {}) }),
  ]);
}

export function registerQueryFamilyInvalidation(
  hub: QueryInvalidationHub,
  input: {
    id: string;
    family: CompiledQueryFamily;
    principal: unknown;
    db: QueryDb;
    revision: number;
    scope: string;
    scopeField?: string;
  },
): void {
  const entities: Record<string, QueryEntity> = {
    [input.family.host.name]: input.family.host,
    [input.family.catalog.name]: input.family.catalog,
    [input.family.elements.name]: input.family.elements,
  };
  for (const dependency of queryFamilyDependencies(input.family, input.scope, input.scopeField)) {
    hub.register({
      id: `${input.id}:${dependency.entity}`,
      dependency,
      principal: input.principal,
      entity: entities[dependency.entity]!,
      db: input.db,
      revision: input.revision,
    });
  }
}

export function queryFamilyChangedSince(
  hub: QueryInvalidationHub,
  input: {
    id: string;
    family: CompiledQueryFamily;
    principal: unknown;
    sinceRevision: number;
    revision: number;
  },
): QueryInvalidationSignal {
  const names = [input.family.host.name, input.family.catalog.name, input.family.elements.name];
  const signals = names.map((entity) => hub.changedSince({
    id: `${input.id}:${entity}`,
    principal: input.principal,
    sinceRevision: input.sinceRevision,
    revision: input.revision,
  }));
  if (signals.some((signal) => signal.kind === 'denied')) {
    return Object.freeze({ kind: 'denied', revision: input.revision });
  }
  if (signals.some((signal) => signal.kind === 'resync')) {
    return Object.freeze({ kind: 'resync', revision: input.revision });
  }
  if (signals.some((signal) => signal.kind === 'changed')) {
    return Object.freeze({ kind: 'changed', revision: input.revision });
  }
  return Object.freeze({ kind: 'unchanged', revision: input.revision });
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
