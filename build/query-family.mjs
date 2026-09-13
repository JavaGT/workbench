// Registered query families (#225, ADR-0009 phase 2).
//
// App authors register a family over a host entity plus a typed value catalog
// and element rows. Clients name that family and pass a field id, operator, and
// value — never a query program or SQL. Execution reuses compiled host grants,
// compileFilterPredicate, the revision fence, and keyset pagination.

import { canonicalStringify } from './canonical-json.mjs';
import {
  compileFilterPredicate,
  queryAuthorizationFields,
  QueryScopedReadError,
  QUERY_OPERATORS,
  namespaceSqlParams,
  selectAuthorizedPage,
  withRevisionFence,









} from './query-scoped-read.mjs';

export const DYNAMIC_VALUE_TYPES = Object.freeze(['text', 'number', 'epoch', 'boolean', 'option']         );


const FAMILY_KEYS = Object.freeze(['name', 'host', 'catalog', 'elements', 'hostKey', 'fieldKey', 'typeField', 'valueColumns']);
const REQUEST_KEYS = Object.freeze(['fieldId', 'op', 'value', 'sort', 'pageSize', 'cursor', 'includeCount']);

function fail(message        )        {
  throw new QueryScopedReadError(message);
}

function assertKeys(value        , allowed                   , label        )       {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} contains an unknown property.`);
  }
}

function identifier(name        , label        )         {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError(`${label} must be a SQL identifier`);
  }
  return name;
}

































const VALUE_COLUMN_TYPES                                                        = Object.freeze({
  text: Object.freeze(['text']),
  number: Object.freeze(['number']),
  epoch: Object.freeze(['number', 'date']),
  boolean: Object.freeze(['boolean']),
  option: Object.freeze(['text', 'ref']),
});

function requireColumn(entity             , field        , label        , allowedTypes                    )         {
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

export function compileQueryFamily(input         )                      {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('family must be an object.');
  assertKeys(input, FAMILY_KEYS, 'family');
  const declaration = input                          ;
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
  const valueColumns = {}                                    ;
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
  db         ,
  family                     ,
  principal         ,
  fieldId        ,
)                   {
  if (typeof family.catalog.scopeFilter !== 'function') fail('catalog entity has no compiled grant filter.');
  const rawCatalog = family.catalog.scopeFilter(principal);
  const grant = namespaceSqlParams(rawCatalog.sql, rawCatalog.params, 'qcat');
  const params = { ...grant.params, query_field_id: fieldId };
  const sql = `SELECT t0.${identifier(family.typeField, 'typeField')} AS valueType FROM ${identifier(family.catalog.name, 'catalog entity')} AS t0 WHERE (${grant.sql}) AND t0.id = :query_field_id LIMIT 1`;
  const row = db.prepare(sql).get(params);
  const valueType = row?.valueType;
  if (typeof valueType !== 'string' || !(DYNAMIC_VALUE_TYPES                     ).includes(valueType)) {
    fail('a filter references an unknown field.');
  }
  return valueType                    ;
}

function elementGrantSql(
  family                     ,
  principal         ,
  params                         ,
)         {
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
  family                     ,
  fieldType                  ,
  op               ,
  value         ,
  principal         ,
  params                         ,
)         {
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
  db         ,
  family                     ,
  principal         ,
  request         ,
)            {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('family request must be an object.');
  assertKeys(request, REQUEST_KEYS, 'family request');
  const input = request                      ;
  if (typeof input.fieldId !== 'string' || input.fieldId.length === 0) fail('fieldId is required.');
  if (!(QUERY_OPERATORS                     ).includes(input.op)) fail('a filter uses an unsupported operator.');
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
    const extraParams                          = { query_field_id: input.fieldId };
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
  family                     ,
  scope        ,
  scopeField         ,
)                             {
  const extra = (entity             , more                   ) =>
    Object.freeze([...new Set([...queryAuthorizationFields(entity), ...more])]);
  return Object.freeze([
    Object.freeze({ entity: family.host.name, fields: extra(family.host, []), scope, ...(scopeField ? { scopeField } : {}) }),
    Object.freeze({ entity: family.catalog.name, fields: extra(family.catalog, [family.typeField]), scope, ...(scopeField ? { scopeField } : {}) }),
    Object.freeze({
      entity: family.elements.name,
      fields: extra(family.elements, [family.hostKey, family.fieldKey, ...DYNAMIC_VALUE_TYPES.map((type) => family.valueColumns[type])]),
      scope,
      ...(scopeField ? { scopeField } : {}),
    }),
  ]);
}

export function registerQueryFamilyInvalidation(
  hub                      ,
  input







   ,
)       {
  const entities                              = {
    [input.family.host.name]: input.family.host,
    [input.family.catalog.name]: input.family.catalog,
    [input.family.elements.name]: input.family.elements,
  };
  hub.registerMany(queryFamilyDependencies(input.family, input.scope, input.scopeField).map((dependency) => ({
    id: `${input.id}:${dependency.entity}`,
    dependency,
    principal: input.principal,
    entity: entities[dependency.entity] ,
    db: input.db,
    revision: input.revision,
  })));
}

export function queryFamilyChangedSince(
  hub                      ,
  input





   ,
)                          {
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
  const families = new Map                             ();
  return {
    register(declaration         )                      {
      const compiled = compileQueryFamily(declaration);
      if (families.has(compiled.name)) fail(`family '${compiled.name}' is already registered.`);
      families.set(compiled.name, compiled);
      return compiled;
    },
    execute(name        , db         , principal         , request         )            {
      const family = families.get(name);
      if (!family) fail(`family '${name}' is not registered.`);
      return executeQueryFamily(db, family, principal, request);
    },
    get(name        )                                  {
      return families.get(name);
    },
  };
}
