// Registered query families (#225, #289, ADR-0009 phase 2).
//
// App authors register a family over a host entity plus a typed value catalog
// and element rows. Clients name that family and pass host/dynamic predicates
// (flat or composable AND/OR/NOT trees) and host or dynamic sort — never a
// query program or SQL. Execution reuses compiled host/catalog/element grants,
// compileFilterPredicate, single-snapshot read isolation, keyset + bounded
// offset pagination, and filteredTotal + authorized total counts.

import { canonicalStringify } from './canonical-json.mjs';
import {
  compileFilterExpression,
  compileFilterPredicate,
  compileHostFilter,
  queryAuthorizationFields,
  QueryScopedReadError,
  QUERY_EXPRESSION_MAX_LEAVES,
  QUERY_OPERATORS,
  namespaceSqlParams,
  resolveMaxPageSize,
  selectAuthorizedPage,
  withRevisionFence,














} from './query-scoped-read.mjs';

export const DYNAMIC_VALUE_TYPES = Object.freeze(['text', 'number', 'epoch', 'boolean', 'option']         );


const FAMILY_KEYS = Object.freeze([
  'name',
  'host',
  'catalog',
  'elements',
  'hostKey',
  'fieldKey',
  'typeField',
  'valueColumns',
  'maxPageSize',
]);

const REQUEST_KEYS = Object.freeze([
  'fieldId',
  'op',
  'value',
  'filters',
  'dynamicFilters',
  'where',
  'expression',
  'sort',
  'sortByDynamicField',
  'pageSize',
  'cursor',
  'offset',
  'includeCount',
  'includeTotal',
  'hydrate',
]);

const DYNAMIC_FILTER_KEYS = Object.freeze(['fieldId', 'op', 'value']);
const DYNAMIC_TERM_KEYS = Object.freeze(['kind', 'fieldId', 'op', 'value']);
const HOST_SORT_KEYS = Object.freeze(['field', 'direction']);
const DYNAMIC_SORT_KEYS = Object.freeze(['dynamicFieldId', 'direction']);
const SORT_BY_DYNAMIC_KEYS = Object.freeze(['dynamicFieldId', 'fieldId', 'direction']);
const HOST_FILTERS_MAX = 16;

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
  const maxPageSize = resolveMaxPageSize(declaration.maxPageSize);
  return Object.freeze({
    name: declaration.name,
    host: declaration.host,
    catalog: declaration.catalog,
    elements: declaration.elements,
    hostKey,
    fieldKey,
    typeField,
    valueColumns: Object.freeze(valueColumns),
    maxPageSize,
  });
}

function readCatalogType(
  db         ,
  family                     ,
  principal         ,
  fieldId        ,
  cache                               ,
  context                   ,
)                   {
  const cached = cache.get(fieldId);
  if (cached) return cached;
  if (typeof family.catalog.scopeFilter !== 'function') fail('catalog entity has no compiled grant filter.');
  const rawCatalog = family.catalog.scopeFilter(principal);
  if (!rawCatalog || typeof rawCatalog.sql !== 'string') fail('compiled catalog grant filter is malformed.');
  const grant = namespaceSqlParams(rawCatalog.sql, rawCatalog.params, 'qcat');
  const params = { ...grant.params, query_field_id: fieldId };
  const sql = `SELECT t0.${identifier(family.typeField, 'typeField')} AS valueType FROM ${identifier(family.catalog.name, 'catalog entity')} AS t0 WHERE (${grant.sql}) AND t0.id = :query_field_id LIMIT 1`;
  const row = db.prepare(sql).get(params)                                       ;
  const valueType = row?.valueType;
  if (typeof valueType !== 'string' || !(DYNAMIC_VALUE_TYPES                     ).includes(valueType)) {
    fail(context === 'sort' ? 'sort references an unknown field.' : 'a filter references an unknown field.');
  }
  cache.set(fieldId, valueType                    );
  return valueType                    ;
}






function compileElementGrant(family                     , principal         )                       {
  if (typeof family.elements.scopeFilter !== 'function') fail('elements entity has no compiled grant filter.');
  const raw = family.elements.scopeFilter(principal);
  if (!raw || typeof raw.sql !== 'string') fail('compiled elements grant filter is malformed.');
  const grant = namespaceSqlParams(raw.sql, raw.params, 'qelem');
  const table = identifier(family.elements.name, 'elements entity');
  // Re-authorize in a subquery whose only alias is t0 so compiled grants
  // (bare `owner` or `t0.owner`) cannot bind to the outer host row.
  return {
    subquerySql: `e.id IN (SELECT t0.id FROM ${table} AS t0 WHERE (${grant.sql}))`,
    params: grant.params,
  };
}

function elementMatchSql(
  family                     ,
  fieldId        ,
  fieldType                  ,
  op               ,
  value         ,
  elementGrant                      ,
  params                         ,
  index        ,
)         {
  const valueColumn = `e.${identifier(family.valueColumns[fieldType], 'value column')}`;
  const fieldColumn = `e.${identifier(family.fieldKey, 'fieldKey')}`;
  const hostRef = `e.${identifier(family.hostKey, 'hostKey')}`;
  const table = identifier(family.elements.name, 'elements entity');
  const fieldParam = `qdyn_fid_${index}`;
  params[fieldParam] = fieldId;
  Object.assign(params, elementGrant.params);
  if (op === 'isEmpty') {
    if (value !== undefined && value !== null) fail('isEmpty does not accept a value.');
    const nonEmpty = compileFilterPredicate({
      column: valueColumn,
      op: 'isNotEmpty',
      value: undefined,
      fieldType,
      params,
      index,
    });
    return `NOT EXISTS (SELECT 1 FROM ${table} AS e WHERE ${hostRef} = t0.id AND ${fieldColumn} = :${fieldParam} AND ${nonEmpty} AND ${elementGrant.subquerySql})`;
  }
  const predicate = compileFilterPredicate({
    column: valueColumn,
    op,
    value,
    fieldType,
    params,
    index,
  });
  return `EXISTS (SELECT 1 FROM ${table} AS e WHERE ${hostRef} = t0.id AND ${fieldColumn} = :${fieldParam} AND ${predicate} AND ${elementGrant.subquerySql})`;
}

function buildDynamicSort(
  family                     ,
  dynamicFieldId        ,
  fieldType                  ,
  direction                ,
  elementGrant                      ,
)                 {
  const valueColumn = identifier(family.valueColumns[fieldType], 'value column');
  const fieldColumn = identifier(family.fieldKey, 'fieldKey');
  const hostRef = identifier(family.hostKey, 'hostKey');
  const table = identifier(family.elements.name, 'elements entity');
  const joinSql = `LEFT JOIN (
    SELECT __host_id, __sort_val FROM (
      SELECT e.${hostRef} AS __host_id,
             e.${valueColumn} AS __sort_val,
             ROW_NUMBER() OVER (PARTITION BY e.${hostRef} ORDER BY e.id ASC) AS __rn
      FROM ${table} AS e
      WHERE e.${fieldColumn} = :qsort_field_id
        AND ${elementGrant.subquerySql}
    ) WHERE __rn = 1
  ) AS __qsort ON __qsort.__host_id = t0.id`;
  return {
    joinSql,
    sortColumn: '__qsort.__sort_val',
    direction,
    params: {
      ...elementGrant.params,
      qsort_field_id: dynamicFieldId,
    },
  };
}





function resolveFamilySort(input                    )               {
  const hasSort = input.sort !== undefined;
  const hasDynamicSort = input.sortByDynamicField !== undefined;
  if (hasSort && hasDynamicSort) fail('family request cannot specify both sort and sortByDynamicField.');
  if (!hasSort && !hasDynamicSort) fail('sort is required.');

  if (hasDynamicSort) {
    const raw = input.sortByDynamicField;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('sortByDynamicField must be an object.');
    assertKeys(raw, SORT_BY_DYNAMIC_KEYS, 'sortByDynamicField');
    const record = raw                                                                        ;
    if (record.dynamicFieldId !== undefined && record.fieldId !== undefined) {
      fail('sortByDynamicField cannot specify both dynamicFieldId and fieldId.');
    }
    const dynamicFieldId = record.dynamicFieldId ?? record.fieldId;
    if (typeof dynamicFieldId !== 'string' || dynamicFieldId.length === 0) {
      fail('sortByDynamicField dynamicFieldId is required.');
    }
    const direction = record.direction ?? 'asc';
    if (direction !== 'asc' && direction !== 'desc') fail('sort direction must be asc or desc.');
    return { kind: 'dynamic', dynamicFieldId, direction };
  }

  const sort = input.sort;
  if (!sort || typeof sort !== 'object' || Array.isArray(sort)) fail('sort is required.');
  if ('dynamicFieldId' in sort) {
    assertKeys(sort, DYNAMIC_SORT_KEYS, 'sort');
    const dynamicSort = sort                                                     ;
    if (typeof dynamicSort.dynamicFieldId !== 'string' || dynamicSort.dynamicFieldId.length === 0) {
      fail('sort dynamicFieldId is required.');
    }
    const direction = dynamicSort.direction ?? 'asc';
    if (direction !== 'asc' && direction !== 'desc') fail('sort direction must be asc or desc.');
    return { kind: 'dynamic', dynamicFieldId: dynamicSort.dynamicFieldId, direction };
  }
  assertKeys(sort, HOST_SORT_KEYS, 'sort');
  const hostSort = sort                                            ;
  if (typeof hostSort.field !== 'string' || hostSort.field.length === 0) fail('sort is required.');
  const direction = hostSort.direction ?? 'asc';
  if (direction !== 'asc' && direction !== 'desc') fail('sort direction must be asc or desc.');
  return { kind: 'host', sort: { field: hostSort.field, direction } };
}

function normalizeDynamicFilter(raw         , allowKind         , label        )                                                         {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${label} must be an object.`);
  assertKeys(raw, allowKind ? DYNAMIC_TERM_KEYS : DYNAMIC_FILTER_KEYS, label);
  const record = raw                                                        ;
  if (typeof record.fieldId !== 'string' || record.fieldId.length === 0) fail('fieldId is required.');
  const op = (record.op ?? 'eq')                 ;
  if (!(QUERY_OPERATORS                     ).includes(op)) fail('a filter uses an unsupported operator.');
  return { fieldId: record.fieldId, op, value: record.value };
}

function normalizeWhereForIdentity(node         , depth = 1)          {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  if (depth > 16) return node;
  const record = node                           ;
  if (record.kind === 'and' || record.kind === 'or') {
    const children = Array.isArray(record.children) ? record.children.map((c) => normalizeWhereForIdentity(c, depth + 1)) : [];
    return { kind: record.kind, children };
  }
  if (record.kind === 'not') {
    return { kind: 'not', child: normalizeWhereForIdentity(record.child, depth + 1) };
  }
  if (record.kind === 'term') {
    const op = record.op ?? 'eq';
    return op === 'isEmpty' || op === 'isNotEmpty'
      ? { kind: 'term', field: record.field, op }
      : { kind: 'term', field: record.field, op, value: record.value ?? null };
  }
  if (record.kind === 'dynamic') {
    const op = record.op ?? 'eq';
    return op === 'isEmpty' || op === 'isNotEmpty'
      ? { kind: 'dynamic', fieldId: record.fieldId, op }
      : { kind: 'dynamic', fieldId: record.fieldId, op, value: record.value ?? null };
  }
  return node;
}

export function executeQueryFamily(
  db         ,
  family                     ,
  principal         ,
  request         ,
  options                            = {},
)            {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('family request must be an object.');
  assertKeys(request, REQUEST_KEYS, 'family request');
  const input = request                      ;

  const hasLegacyDynamic = input.fieldId !== undefined || input.op !== undefined || input.value !== undefined;
  let legacyFilter                                                                = null;
  if (hasLegacyDynamic) {
    if (typeof input.fieldId !== 'string' || input.fieldId.length === 0) fail('fieldId is required.');
    if (!(QUERY_OPERATORS                     ).includes(input.op          )) fail('a filter uses an unsupported operator.');
    legacyFilter = { fieldId: input.fieldId, op: input.op                 , value: input.value };
  }

  if (input.filters !== undefined && !Array.isArray(input.filters)) fail('filters must be an array.');
  if ((input.filters?.length ?? 0) > HOST_FILTERS_MAX) fail('filters must contain at most 16 entries.');
  if (input.dynamicFilters !== undefined && !Array.isArray(input.dynamicFilters)) fail('dynamicFilters must be an array.');
  const dynamicFilters = (input.dynamicFilters ?? []).map((entry) =>
    normalizeDynamicFilter(entry, false, 'dynamic filter'),
  );

  const hasWhere = input.where !== undefined && input.where !== null;
  const hasExpression = input.expression !== undefined && input.expression !== null;
  if (hasWhere && hasExpression) fail('family request cannot specify both where and expression.');
  const rawWhere = hasWhere ? input.where : hasExpression ? input.expression : null;

  const resolvedSort = resolveFamilySort(input);
  const maxPageSize = resolveMaxPageSize(options.maxPageSize ?? family.maxPageSize);

  const isLegacyOnly =
    legacyFilter !== null
    && input.filters === undefined
    && input.dynamicFilters === undefined
    && rawWhere === null
    && resolvedSort.kind === 'host';

  const identity = isLegacyOnly
    ? canonicalStringify({
      family: family.name,
      fieldId: legacyFilter .fieldId,
      op: legacyFilter .op,
      ...(legacyFilter .op === 'isEmpty' || legacyFilter .op === 'isNotEmpty' ? {} : { value: legacyFilter .value ?? null }),
      sort: resolvedSort.sort,
      pageSize: input.pageSize,
    })
    : canonicalStringify({
      family: family.name,
      ...(legacyFilter ? {
        fieldId: legacyFilter.fieldId,
        op: legacyFilter.op,
        ...(legacyFilter.op === 'isEmpty' || legacyFilter.op === 'isNotEmpty' ? {} : { value: legacyFilter.value ?? null }),
      } : {}),
      ...(input.filters && input.filters.length > 0 ? {
        filters: input.filters.map((f) => {
          const op = f?.op ?? 'eq';
          return op === 'isEmpty' || op === 'isNotEmpty'
            ? { field: f?.field, op }
            : { field: f?.field, op, value: f?.value ?? null };
        }),
      } : {}),
      ...(dynamicFilters.length > 0 ? {
        dynamicFilters: dynamicFilters.map((df) => (
          df.op === 'isEmpty' || df.op === 'isNotEmpty'
            ? { fieldId: df.fieldId, op: df.op }
            : { fieldId: df.fieldId, op: df.op, value: df.value ?? null }
        )),
      } : {}),
      ...(rawWhere !== null ? { where: normalizeWhereForIdentity(rawWhere) } : {}),
      sort: resolvedSort.kind === 'host'
        ? resolvedSort.sort
        : { dynamicFieldId: resolvedSort.dynamicFieldId, direction: resolvedSort.direction },
      pageSize: input.pageSize,
    });

  if (input.cursor && input.cursor.queryIdentity !== identity) fail('page token does not match this query.');

  return withRevisionFence(db, () => {
    const catalogCache = new Map                          ();
    let cachedElementGrant                              = null;
    const getElementGrant = ()                       => {
      if (!cachedElementGrant) cachedElementGrant = compileElementGrant(family, principal);
      return cachedElementGrant;
    };

    const extraParams                          = {};
    const whereParts           = [];
    const state                               = { leaves: 0, paramIndex: 0 };

    const countLeaf = ()       => {
      state.leaves += 1;
      if (state.leaves > QUERY_EXPRESSION_MAX_LEAVES) {
        fail(`filter expression exceeds maximum leaf count of ${QUERY_EXPRESSION_MAX_LEAVES}.`);
      }
    };

    if (legacyFilter) {
      countLeaf();
      const fieldType = readCatalogType(db, family, principal, legacyFilter.fieldId, catalogCache, 'filter');
      whereParts.push(
        elementMatchSql(
          family,
          legacyFilter.fieldId,
          fieldType,
          legacyFilter.op,
          legacyFilter.value,
          getElementGrant(),
          extraParams,
          state.paramIndex++,
        ),
      );
    }

    for (const hostFilter of input.filters ?? []) {
      countLeaf();
      whereParts.push(compileHostFilter(hostFilter, family.host, extraParams, state.paramIndex++).sql);
    }

    for (const df of dynamicFilters) {
      countLeaf();
      const fieldType = readCatalogType(db, family, principal, df.fieldId, catalogCache, 'filter');
      whereParts.push(
        elementMatchSql(
          family,
          df.fieldId,
          fieldType,
          df.op,
          df.value,
          getElementGrant(),
          extraParams,
          state.paramIndex++,
        ),
      );
    }

    if (rawWhere !== null) {
      const compiledExpr = compileFilterExpression(
        rawWhere,
        (node, exprState)                         => {
          if (node.kind === 'term') {
            const compiled = compileHostFilter(node, family.host, extraParams, exprState.paramIndex++, {
              allowKind: true,
              label: 'term expression',
            });
            return { sql: compiled.sql, normalized: node, fields: [compiled.field] };
          }
          if (node.kind === 'dynamic') {
            const df = normalizeDynamicFilter(node, true, 'dynamic expression');
            const fieldType = readCatalogType(db, family, principal, df.fieldId, catalogCache, 'filter');
            const sql = elementMatchSql(
              family,
              df.fieldId,
              fieldType,
              df.op,
              df.value,
              getElementGrant(),
              extraParams,
              exprState.paramIndex++,
            );
            return { sql, normalized: node, fields: [] };
          }
          fail('filter expression uses an unsupported node kind.');
        },
        state,
      );
      whereParts.push(compiledExpr.sql);
    }

    let customSort                        = null;
    if (resolvedSort.kind === 'dynamic') {
      const sortType = readCatalogType(db, family, principal, resolvedSort.dynamicFieldId, catalogCache, 'sort');
      customSort = buildDynamicSort(
        family,
        resolvedSort.dynamicFieldId,
        sortType,
        resolvedSort.direction,
        getElementGrant(),
      );
    }

    return selectAuthorizedPage(db, family.host, principal, {
      identity,
      extraWhere: whereParts.length > 0 ? whereParts.map((part) => `(${part})`).join(' AND ') : null,
      extraParams,
      ...(resolvedSort.kind === 'host' ? { sort: resolvedSort.sort } : { customSort }),
      pageSize: input.pageSize,
      maxPageSize,
      cursor: input.cursor,
      offset: input.offset,
      maxOffset: options.maxOffset,
      includeCount: input.includeCount === true,
      includeTotal: input.includeTotal === true,
      hydrate: input.hydrate,
    });
  });
}

export function queryFamilyDependencies(
  family                     ,
  scope        ,
  scopeField         ,
  hostFields                    = [],
)                             {
  const extra = (entity             , more                   ) =>
    Object.freeze([...new Set([...queryAuthorizationFields(entity), ...more])]);
  return Object.freeze([
    Object.freeze({ entity: family.host.name, fields: extra(family.host, hostFields), scope, ...(scopeField ? { scopeField } : {}) }),
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
  hub.registerMany(queryFamilyDependencies(input.family, input.scope, input.scopeField, input.hostFields).map((dependency) => ({
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













export function createQueryFamilyRegistry()                      {
  const families = new Map                             ();
  return {
    register(declaration         )                      {
      const compiled = compileQueryFamily(declaration);
      if (families.has(compiled.name)) fail(`family '${compiled.name}' is already registered.`);
      families.set(compiled.name, compiled);
      return compiled;
    },
    execute(
      name        ,
      db         ,
      principal         ,
      request         ,
      options                            ,
    )            {
      const family = families.get(name);
      if (!family) fail(`family '${name}' is not registered.`);
      return executeQueryFamily(db, family, principal, request, options);
    },
    get(name        )                                  {
      return families.get(name);
    },
  };
}
