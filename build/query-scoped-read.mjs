// Query-scoped reads (#225, ADR-0009).
//
// A typed, authorized page over one compiled Entity: allowlisted operators,
// single-key sort with an `id ASC` tie-break (the readRows convention), keyset
// pagination, optional count, and a revision token from `_CommittedRevision`.
// Invalidation is a "changed since R" signal; the client refetches. This is
// not a second write path, not a second auth engine, and not a row-patch fold.

import { canonicalStringify } from './canonical-json.mjs';
import { parseEventType, EventKind,                          } from './event-handle.mjs';
import { tryParseScopeKey } from './scope-handle.mjs';

export const QUERY_OPERATORS = Object.freeze(['eq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains', 'isEmpty', 'isNotEmpty']         );


export const OPERATORS_BY_FIELD_TYPE = Object.freeze({
  text: Object.freeze(['eq', 'in', 'contains', 'isEmpty', 'isNotEmpty']         ),
  number: Object.freeze(['eq', 'in', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty']         ),
  date: Object.freeze(['eq', 'in', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty']         ),
  epoch: Object.freeze(['eq', 'in', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty']         ),
  boolean: Object.freeze(['eq', 'isEmpty', 'isNotEmpty']         ),
  ref: Object.freeze(['eq', 'in', 'isEmpty', 'isNotEmpty']         ),
  option: Object.freeze(['eq', 'in', 'isEmpty', 'isNotEmpty']         ),
});


export const QUERY_PAGE_SIZE_MIN = 1;
export const QUERY_PAGE_SIZE_MAX = 100;
export const QUERY_REGISTRATION_MAX = 32;
const IN_VALUES_MAX = 100;
const FILTERS_MAX = 16;

const SCALAR_TYPES = new Set(['text', 'boolean', 'date', 'number', 'ref']);

export class QueryScopedReadError extends Error {
  constructor(message        ) {
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






















































































const CONTRACT_KEYS = Object.freeze(['entity', 'filters', 'sort', 'pageSize']);
const FILTER_KEYS = Object.freeze(['field', 'op', 'value']);
const SORT_KEYS = Object.freeze(['field', 'direction']);

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

function fieldsOf(entity             )              {
  return new Set(['id', ...Object.keys(entity.fields ?? {})]);
}

function assertScalarField(entity             , field        , label        )       {
  if (field === 'id') return;
  const descriptor = entity.fields[field];
  if (!descriptor || descriptor.kind !== 'value' || !SCALAR_TYPES.has(descriptor.type ?? '')) {
    fail(`${label} '${field}' is not a declared scalar field.`);
  }
}

function assertSqlValue(value         , label        )       {
  if (value === null) fail(`${label} must not be null; IS NULL is not in the operator set.`);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
  fail(`${label} must be a SQLite scalar value.`);
}

function freezeJsonValue(value         )          {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeJsonValue(item)));
  if (value && typeof value === 'object') {
    const copy                          = {};
    for (const [key, item] of Object.entries(value)) copy[key] = freezeJsonValue(item);
    return Object.freeze(copy);
  }
  return value;
}

function detached(raw                         )                          {
  return Object.freeze({ ...raw });
}

function queryPrincipalKey(principal         )         {
  if (!principal || typeof principal !== 'object') fail('principal is required.');
  const record = principal                                    ;
  if (typeof record.type !== 'string') fail('principal type is required.');
  if (record.type === 'anonymous') return 'anonymous';
  if (typeof record.id !== 'string' || record.id.length === 0) fail('principal id is required.');
  return `${record.type}:${record.id}`;
}

function collectAstFields(ast         , result             , seen = new Set        ())       {
  if (ast === null || typeof ast !== 'object' || seen.has(ast)) return;
  seen.add(ast);
  const record = ast                           ;
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

function authorizationFields(entity             )           {
  const out = new Set        ();
  if (entity.scopeAst) collectAstFields(entity.scopeAst, out);
  for (const [name, descriptor] of Object.entries(entity.fields ?? {})) {
    if (descriptor?.role === 'owner' || name === 'owner' || name === 'projectId') out.add(name);
  }
  const declared = fieldsOf(entity);
  return [...out].filter((field) => declared.has(field));
}

function fieldTypeOf(entity             , field        )                 {
  if (field === 'id') return 'text';
  const type = entity.fields[field]?.type;
  if (type && type in OPERATORS_BY_FIELD_TYPE) return type                  ;
  fail(`field '${field}' has no queryable type.`);
}

function operatorsFor(fieldType        )                           {
  const allowed = OPERATORS_BY_FIELD_TYPE[fieldType                  ];
  if (!allowed) fail(`field type '${fieldType}' is not queryable.`);
  return allowed;
}

function bindDateValue(value         , label        )         {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) fail(`${label} must be a finite number or ISO date string.`);
    return ms;
  }
  fail(`${label} must be a finite number or ISO date string.`);
}

function assertTypedValue(fieldType        , value         , label        )       {
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

function bindTypedValue(fieldType        , value         , label        )          {
  if (fieldType === 'date') return bindDateValue(value, label);
  assertTypedValue(fieldType, value, label);
  if (fieldType === 'boolean') return value ? 1 : 0;
  return value;
}

function escapeLike(value        )         {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export function compileFilterPredicate(input






 )         {
  const allowed = operatorsFor(input.fieldType);
  if (!(allowed                     ).includes(input.op)) fail(`operator '${input.op}' is not supported on ${input.fieldType} fields.`);
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
  const operator = ({ eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' }         )[input.op];
  return `${column} ${operator} :${name}`;
}

function compileFilter(
  filter         ,
  declared             ,
  entity             ,
  params                         ,
  index        ,
)                                                                    {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) fail('filters must be objects.');
  assertKeys(filter, FILTER_KEYS, 'filter');
  const { field, op = 'eq', value } = filter               ;
  if (typeof field !== 'string' || !declared.has(field)) fail('a filter references an unknown field.');
  assertScalarField(entity, field, 'filter field');
  if (!(QUERY_OPERATORS                     ).includes(op)) fail('a filter uses an unsupported operator.');
  const fieldType = fieldTypeOf(entity, field);
  const column = `t0.${identifier(field, 'filter field')}`;
  const sql = compileFilterPredicate({ column, op, value, fieldType, params, index });
  if (op === 'isEmpty' || op === 'isNotEmpty') return { sql, field, op, value: null };
  return { sql, field, op, value: freezeJsonValue(value) };
}

export function compileQueryContract(input         , entity             )                {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('contract must be an object.');
  assertKeys(input, CONTRACT_KEYS, 'contract');
  const contract = input                 ;
  if (contract.entity !== entity.name) fail('contract entity does not match the compiled entity.');
  identifier(entity.name, 'entity name');
  const declared = fieldsOf(entity);
  if (contract.filters !== undefined && !Array.isArray(contract.filters)) fail('filters must be an array.');
  if ((contract.filters?.length ?? 0) > FILTERS_MAX) fail('filters must contain at most 16 entries.');
  const params                          = {};
  const filters = (contract.filters ?? []).map((filter, index) => {
    const compiled = compileFilter(filter, declared, entity, params, index);
    return Object.freeze({ field: compiled.field, op: compiled.op, value: compiled.value });
  });
  if (!contract.sort || typeof contract.sort !== 'object' || Array.isArray(contract.sort)) fail('sort is required.');
  assertKeys(contract.sort, SORT_KEYS, 'sort');
  const { field: sortField, direction = 'asc' } = contract.sort;
  if (typeof sortField !== 'string' || !declared.has(sortField)) fail('sort references an unknown field.');
  assertScalarField(entity, sortField, 'sort field');
  if (direction !== 'asc' && direction !== 'desc') fail('sort direction must be asc or desc.');
  const pageSize = contract.pageSize;
  if (!Number.isSafeInteger(pageSize) || pageSize < QUERY_PAGE_SIZE_MIN || pageSize > QUERY_PAGE_SIZE_MAX) {
    fail(`pageSize must be an integer from ${QUERY_PAGE_SIZE_MIN} through ${QUERY_PAGE_SIZE_MAX}.`);
  }
  const identity = canonicalStringify({
    entity: entity.name,
    filters: filters.map((filter) => (
      filter.op === 'isEmpty' || filter.op === 'isNotEmpty'
        ? { field: filter.field, op: filter.op }
        : { field: filter.field, op: filter.op, value: filter.value }
    )),
    sort: { field: sortField, direction },
    pageSize,
  });
  const dependencyFields = Object.freeze([
    ...new Set([...filters.map((filter) => filter.field), sortField, ...authorizationFields(entity)]),
  ]);
  return Object.freeze({
    entity: entity.name,
    identity,
    filters: Object.freeze(filters),
    sort: Object.freeze({ field: sortField, direction }),
    pageSize,
    dependencyFields,
  });
}

export function asSafeRevision(value         , label        )         {
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

export function readCommittedRevision(db         )         {
  let row                                     ;
  try {
    row = db.prepare("SELECT revision FROM _CommittedRevision WHERE name = 'actions'").get();
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

function grantFilter(entity             , principal         )                                                   {
  if (typeof entity.scopeFilter !== 'function') fail('entity has no compiled grant filter.');
  const filter = entity.scopeFilter(principal);
  if (!filter || typeof filter.sql !== 'string') fail('compiled grant filter is malformed.');
  return { sql: filter.sql, params: { ...filter.params } };
}

function isDeniedGrant(sql        )          {
  const compact = sql.replace(/\s+/g, '');
  return compact === '1=0' || compact === '(1=0)';
}

function assertAdmitted(entity             , principal         )                                                   {
  const grant = grantFilter(entity, principal);
  if (isDeniedGrant(grant.sql)) fail('principal is not admitted to this entity.');
  return grant;
}

function principalStillAdmitted(entity             , principal         )          {
  try {
    const grant = grantFilter(entity, principal);
    return !isDeniedGrant(grant.sql);
  } catch {
    return false;
  }
}

function defaultScopeField(scope        , entityName        )                {
  const parsed = tryParseScopeKey(scope);
  if (!parsed) return null;
  if (parsed.entity === entityName) return 'id';
  return `${parsed.entity.charAt(0).toLowerCase()}${parsed.entity.slice(1)}Id`;
}

function resolveScopeField(entity             , scope        , explicit                    )         {
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || explicit.length === 0) fail('scopeField must be a declared field name.');
  }
  const field = explicit ?? defaultScopeField(scope, entity.name);
  if (typeof field !== 'string' || field.length === 0) fail('scopeField cannot be resolved on the entity.');
  if (field !== 'id' && !entity.fields[field]) fail(`scopeField '${field}' is not a declared field.`);
  return field;
}

function filterSql(compiled               , entity             , params                         )         {
  const declared = fieldsOf(entity);
  return compiled.filters.map((filter, index) => compileFilter(filter, declared, entity, params, index).sql).join(' AND ');
}

export function keysetSql(sortColumn        , direction                , cursor             , params                         )         {
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

export function selectAuthorizedPage(
  db         ,
  entity             ,
  principal         ,
  input







   ,
)                              {
  identifier(entity.name, 'entity name');
  const sortField = input.sort?.field;
  if (typeof sortField !== 'string') fail('sort is required.');
  assertScalarField(entity, sortField, 'sort field');
  if (input.sort.direction !== 'asc' && input.sort.direction !== 'desc') fail('sort direction must be asc or desc.');
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < QUERY_PAGE_SIZE_MIN || input.pageSize > QUERY_PAGE_SIZE_MAX) {
    fail(`pageSize must be an integer from ${QUERY_PAGE_SIZE_MIN} through ${QUERY_PAGE_SIZE_MAX}.`);
  }
  if (input.cursor) {
    if (input.cursor.queryIdentity !== input.identity) fail('page token does not match this query.');
    if (typeof input.cursor.id !== 'string' || input.cursor.id.length === 0) fail('page token id is required.');
  }
  const params                          = { ...(input.extraParams ?? {}) };
  const grant = grantFilter(entity, principal);
  Object.assign(params, grant.params);
  const parts = [grant.sql];
  if (input.extraWhere) parts.push(input.extraWhere);
  if (input.cursor) {
    const sortColumn = `t0.${identifier(sortField, 'sort field')}`;
    parts.push(keysetSql(sortColumn, input.sort.direction, input.cursor, params));
  }
  const where = parts.map((part) => `(${part})`).join(' AND ');
  const sortColumn = `t0.${identifier(sortField, 'sort field')}`;
  const direction = input.sort.direction === 'desc' ? 'DESC' : 'ASC';
  params.query_limit = input.pageSize + 1;
  const sql = `SELECT * FROM ${identifier(entity.name, 'entity name')} AS t0 WHERE ${where} ORDER BY ${sortColumn} ${direction}, t0.id ASC LIMIT :query_limit`;
  const fetched = db.prepare(sql).all(params).map(detached);
  const hasMore = fetched.length > input.pageSize;
  const rows = hasMore ? fetched.slice(0, input.pageSize) : fetched;
  const last = rows.at(-1);
  const nextCursor = hasMore && last
    ? Object.freeze({
      queryIdentity: input.identity,
      sortValue: last[sortField],
      id: String(last.id),
    })
    : null;
  let count                    ;
  if (input.includeCount === true) {
    const countParams                          = { ...(input.extraParams ?? {}), ...grant.params };
    const countParts = [grant.sql];
    if (input.extraWhere) countParts.push(input.extraWhere);
    const countWhere = countParts.map((part) => `(${part})`).join(' AND ');
    const countRow = db.prepare(`SELECT COUNT(*) AS n FROM ${identifier(entity.name, 'entity name')} AS t0 WHERE ${countWhere}`).get(countParams);
    count = asSafeRevision(countRow?.n ?? 0, 'count');
  }
  return {
    rows: Object.freeze(rows),
    nextCursor,
    queryIdentity: input.identity,
    ...(input.includeCount === true ? { count } : {}),
  };
}

export function withRevisionFence(db         , run                                   )            {
  let lastContention                              = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = readCommittedRevision(db);
    const page = run();
    const after = readCommittedRevision(db);
    if (before === after) return Object.freeze({ ...page, revision: after });
    lastContention = new QueryContentionError();
  }
  throw lastContention ?? new QueryContentionError();
}

function runPage(
  db         ,
  entity             ,
  principal         ,
  compiled               ,
  cursor                                ,
  includeCount         ,
)                              {
  const extraParams                          = {};
  const extra = filterSql(compiled, entity, extraParams);
  return selectAuthorizedPage(db, entity, principal, {
    identity: compiled.identity,
    extraWhere: extra || null,
    extraParams,
    sort: compiled.sort,
    pageSize: compiled.pageSize,
    cursor,
    includeCount,
  });
}

export function executeQueryPage(
  db         ,
  entity             ,
  principal         ,
  compiled               ,
  options                                                          = {},
)            {
  if (compiled.entity !== entity.name) fail('compiled query does not match the entity.');
  return withRevisionFence(db, () => runPage(db, entity, principal, compiled, options.cursor, options.includeCount === true));
}

export function acceptQueryPage(heldRevision        , incomingRevision        )                    {
  if (!Number.isSafeInteger(heldRevision) || !Number.isSafeInteger(incomingRevision)) {
    fail('revision tokens must be safe integers.');
  }
  return incomingRevision < heldRevision ? 'reject-stale' : 'accept';
}

export function overlayOptimisticQueryPage(
  page           ,
  pending                              ,
  compiled               ,
)                      {
  const dependency = new Set(compiled.dependencyFields);
  let membershipUncertain = false;
  const previews = new Map                                 ();
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













function eventHandleOf(event         )                             {
  if (!event || typeof event !== 'object') return null;
  const value = event                                        ;
  const handle = value.handle                                   ;
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

function eventEntityOf(event         , handle                            )                {
  if (handle) return handle.entity;
  if (!event || typeof event !== 'object') return null;
  const scope = (event                       ).scope;
  if (typeof scope === 'string') {
    const parsed = tryParseScopeKey(scope);
    return parsed?.entity ?? null;
  }
  return null;
}

function eventTouches(event         , handle                            , fields                     )          {
  if (!handle) return true;
  if (handle.kind === EventKind.created || handle.kind === EventKind.removed) return true;
  if (fields.size === 0) return true;
  if ('field' in handle && typeof handle.field === 'string') return fields.has(handle.field);
  const data = (event                      ).data;
  if (!data || typeof data !== 'object') return true;
  return Object.keys(data).some((key) => key !== 'id' && fields.has(key));
}

function eventScopeMatches(event         , registration                   )          {
  if (!event || typeof event !== 'object') return false;
  const raw = (event                       ).scope;
  if (typeof raw !== 'string') return false;
  if (raw === registration.scope) return true;
  const wanted = tryParseScopeKey(registration.scope);
  const got = tryParseScopeKey(raw);
  if (!wanted || !got) return false;
  if (got.key === wanted.key) return true;
  if (got.entity !== registration.entityName || !registration.scopeField) return false;
  const data = (event                      ).data;
  if (!data || typeof data !== 'object') return false;
  return (data                           )[registration.scopeField] === wanted.id;
}

function assertVisibleInScope(
  db         ,
  entity             ,
  principal         ,
  scope        ,
  scopeField        ,
)       {
  const grant = assertAdmitted(entity, principal);
  const parsed = tryParseScopeKey(scope);
  if (!parsed) fail('dependency scope must be a Scope handle.');
  if (scopeField !== 'id' && !entity.fields[scopeField]) fail(`scopeField '${scopeField}' is not a declared field.`);
  const params                          = { ...grant.params, query_scope_id: parsed.id };
  const sql = `SELECT 1 AS ok FROM ${identifier(entity.name, 'entity name')} AS t0 WHERE (${grant.sql}) AND t0.${identifier(scopeField, 'scope field')} = :query_scope_id LIMIT 1`;
  const row = db.prepare(sql).get(params);
  if (!row) fail('principal cannot see this query scope.');
}

export function createQueryInvalidationHub(options                                = {}) {
  const maxRegistrations = options.maxRegistrations ?? QUERY_REGISTRATION_MAX;
  if (!Number.isSafeInteger(maxRegistrations) || maxRegistrations < 1) fail('maxRegistrations must be a positive integer.');
  const registrations = new Map                           ();

  function slot(principalKey        , id        )         {
    return `${principalKey}\n${id}`;
  }

  function register(input






   )       {
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
    const key = slot(principalKey, input.id);
    if (!registrations.has(key) && registrations.size >= maxRegistrations) {
      fail(`at most ${maxRegistrations} query registrations may be active.`);
    }
    registrations.set(key, {
      id: input.id,
      entityName: input.dependency.entity,
      fields: new Set(input.dependency.fields),
      scope: input.dependency.scope,
      scopeField,
      principalKey,
      compiledEntity: input.entity,
      lastInvalidatedRevision: null,
      registeredAtRevision: input.revision,
    });
  }

  function unregister(id        , principal         )       {
    registrations.delete(slot(queryPrincipalKey(principal), id));
  }

  function notice(events                    , revision        )       {
    if (!Number.isSafeInteger(revision)) fail('invalidation revision must be a safe integer.');
    for (const event of events) {
      const handle = eventHandleOf(event);
      const entity = eventEntityOf(event, handle);
      if (!entity) continue;
      for (const registration of registrations.values()) {
        if (registration.entityName !== entity) continue;
        if (!eventScopeMatches(event, registration)) continue;
        if (!eventTouches(event, handle, registration.fields)) continue;
        const previous = registration.lastInvalidatedRevision;
        if (previous !== null && revision < previous) continue;
        registration.lastInvalidatedRevision = previous === null ? revision : Math.max(previous, revision);
      }
    }
  }

  function changedSince(input




   )                          {
    const principalKey = queryPrincipalKey(input.principal);
    if (!Number.isSafeInteger(input.sinceRevision) || !Number.isSafeInteger(input.revision)) {
      fail('revision tokens must be safe integers.');
    }
    if (input.sinceRevision > input.revision) fail('sinceRevision is ahead of the commit lifecycle.');
    const registration = registrations.get(slot(principalKey, input.id));
    // Missing and foreign registrations share one signal so an id is not an
    // existence oracle. Revocation of *this* principal's registration is denied.
    if (!registration || registration.principalKey !== principalKey) {
      return Object.freeze({ kind: 'resync', revision: input.revision });
    }
    if (!principalStillAdmitted(registration.compiledEntity, input.principal)) {
      return Object.freeze({ kind: 'denied', revision: input.revision });
    }
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
    unregister,
    notice,
    changedSince,
    get size() { return registrations.size; },
  };
}



export function createQueryInvalidationConsumer(hub                      , db         ) {
  return async (events                    )                => {
    try {
      hub.notice(events, readCommittedRevision(db));
    } catch {
      // post-commit isolation: an invalidation failure never undoes the commit
    }
  };
}
