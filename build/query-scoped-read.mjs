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

export const QUERY_OPERATORS = Object.freeze(['eq', 'in', 'gt', 'gte', 'lt', 'lte']         );


export const QUERY_PAGE_SIZE_MIN = 1;
export const QUERY_PAGE_SIZE_MAX = 100;
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
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
  fail(`${label} must be a SQLite scalar value.`);
}

function detached(raw                         )                          {
  return Object.freeze({ ...raw });
}

function principalKeyOf(principal         )         {
  if (!principal || typeof principal !== 'object') fail('principal is required.');
  const record = principal                                    ;
  if (typeof record.type !== 'string') fail('principal type is required.');
  if (record.type === 'anonymous') return 'anonymous';
  if (typeof record.id !== 'string' || record.id.length === 0) fail('principal id is required.');
  return `${record.type}:${record.id}`;
}

function compileFilter(
  filter         ,
  declared             ,
  entity             ,
  params                         ,
  index        ,
)                                 {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) fail('filters must be objects.');
  assertKeys(filter, FILTER_KEYS, 'filter');
  const { field, op = 'eq', value } = filter               ;
  if (typeof field !== 'string' || !declared.has(field)) fail('a filter references an unknown field.');
  assertScalarField(entity, field, 'filter field');
  if (!(QUERY_OPERATORS                     ).includes(op)) fail('a filter uses an unsupported operator.');
  const column = `t0.${identifier(field, 'filter field')}`;
  if (op === 'in') {
    if (!Array.isArray(value) || value.length === 0 || value.length > IN_VALUES_MAX) {
      fail('in requires 1 through 100 values.');
    }
    const names = value.map((item, itemIndex) => {
      assertSqlValue(item, 'in value');
      const name = `query_f${index}_${itemIndex}`;
      params[name] = item;
      return `:${name}`;
    });
    return { sql: `${column} IN (${names.join(', ')})`, field };
  }
  assertSqlValue(value, 'filter value');
  const name = `query_f${index}`;
  params[name] = value;
  const operator = ({ eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' }         )[op];
  return { sql: `${column} ${operator} :${name}`, field };
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
    return Object.freeze({ field: compiled.field, op: (filter.op ?? 'eq')                 , value: filter.value });
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
    filters: filters.map((filter) => ({ field: filter.field, op: filter.op, value: filter.value })),
    sort: { field: sortField, direction },
  });
  const dependencyFields = Object.freeze([...new Set([...filters.map((filter) => filter.field), sortField])]);
  return Object.freeze({
    entity: entity.name,
    identity,
    filters: Object.freeze(filters),
    sort: Object.freeze({ field: sortField, direction }),
    pageSize,
    dependencyFields,
  });
}

export function readCommittedRevision(db         )         {
  let row                                     ;
  try {
    row = db.prepare("SELECT revision FROM _CommittedRevision WHERE name = 'actions'").get();
  } catch (err) {
    throw new QueryScopedReadError(`committed revision is unavailable (${err instanceof Error ? err.message : String(err)}).`);
  }
  const revision = row?.revision;
  if (typeof revision === 'number' && Number.isSafeInteger(revision)) return revision;
  if (typeof revision === 'bigint') return Number(revision);
  fail('committed revision token is missing.');
}

function grantFilter(entity             , principal         )                                                   {
  if (typeof entity.scopeFilter !== 'function') fail('entity has no compiled grant filter.');
  const filter = entity.scopeFilter(principal);
  if (!filter || typeof filter.sql !== 'string') fail('compiled grant filter is malformed.');
  return { sql: filter.sql, params: { ...filter.params } };
}

function filterSql(compiled               , entity             , params                         )         {
  const declared = fieldsOf(entity);
  return compiled.filters.map((filter, index) => compileFilter(filter, declared, entity, params, index).sql).join(' AND ');
}

function keysetSql(sortColumn        , direction                , cursor             , params                         )         {
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

function whereSql(
  compiled               ,
  entity             ,
  principal         ,
  cursor                                ,
  params                         ,
)         {
  const grant = grantFilter(entity, principal);
  Object.assign(params, grant.params);
  const parts = [grant.sql];
  const extra = filterSql(compiled, entity, params);
  if (extra) parts.push(extra);
  if (cursor) {
    if (cursor.queryIdentity !== compiled.identity) fail('page token does not match this query.');
    if (typeof cursor.id !== 'string' || cursor.id.length === 0) fail('page token id is required.');
    const sortColumn = `t0.${identifier(compiled.sort.field, 'sort field')}`;
    parts.push(keysetSql(sortColumn, compiled.sort.direction, cursor, params));
  }
  return parts.map((part) => `(${part})`).join(' AND ');
}

function runPage(
  db         ,
  entity             ,
  principal         ,
  compiled               ,
  cursor                                ,
  includeCount         ,
)                              {
  identifier(entity.name, 'entity name');
  const params                          = {};
  const where = whereSql(compiled, entity, principal, cursor, params);
  const sortColumn = `t0.${identifier(compiled.sort.field, 'sort field')}`;
  const direction = compiled.sort.direction === 'desc' ? 'DESC' : 'ASC';
  const limit = compiled.pageSize + 1;
  params.query_limit = limit;
  const sql = `SELECT * FROM ${identifier(entity.name, 'entity name')} AS t0 WHERE ${where} ORDER BY ${sortColumn} ${direction}, t0.id ASC LIMIT :query_limit`;
  const fetched = db.prepare(sql).all(params).map(detached);
  const hasMore = fetched.length > compiled.pageSize;
  const rows = hasMore ? fetched.slice(0, compiled.pageSize) : fetched;
  const last = rows.at(-1);
  const nextCursor = hasMore && last
    ? Object.freeze({
      queryIdentity: compiled.identity,
      sortValue: last[compiled.sort.field],
      id: String(last.id),
    })
    : null;
  let count                    ;
  if (includeCount) {
    const countParams                          = {};
    const countWhere = whereSql(compiled, entity, principal, null, countParams);
    const countRow = db.prepare(`SELECT COUNT(*) AS n FROM ${identifier(entity.name, 'entity name')} AS t0 WHERE ${countWhere}`).get(countParams);
    const n = countRow?.n;
    count = typeof n === 'bigint' ? Number(n) : Number(n ?? 0);
  }
  return {
    rows: Object.freeze(rows),
    nextCursor,
    queryIdentity: compiled.identity,
    ...(includeCount ? { count } : {}),
  };
}

export function executeQueryPage(
  db         ,
  entity             ,
  principal         ,
  compiled               ,
  options                                                          = {},
)            {
  if (compiled.entity !== entity.name) fail('compiled query does not match the entity.');
  const includeCount = options.includeCount === true;
  let lastContention                              = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = readCommittedRevision(db);
    const page = runPage(db, entity, principal, compiled, options.cursor, includeCount);
    const after = readCommittedRevision(db);
    if (before === after) {
      return Object.freeze({ ...page, revision: after });
    }
    lastContention = new QueryContentionError();
  }
  throw lastContention ?? new QueryContentionError();
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

export function createQueryInvalidationHub() {
  const registrations = new Map                           ();

  function register(input                                                                 )       {
    if (typeof input.id !== 'string' || input.id.length === 0) fail('registration id is required.');
    identifier(input.dependency.entity, 'dependency entity');
    if (!Array.isArray(input.dependency.fields)) fail('dependency fields must be an array.');
    registrations.set(input.id, {
      id: input.id,
      entity: input.dependency.entity,
      fields: new Set(input.dependency.fields),
      principalKey: principalKeyOf(input.principal),
      lastInvalidatedRevision: null,
    });
  }

  function unregister(id        )       {
    registrations.delete(id);
  }

  function notice(events                    , revision        )       {
    if (!Number.isSafeInteger(revision)) fail('invalidation revision must be a safe integer.');
    for (const event of events) {
      const handle = eventHandleOf(event);
      const entity = eventEntityOf(event, handle);
      if (!entity) continue;
      for (const registration of registrations.values()) {
        if (registration.entity !== entity) continue;
        if (!eventTouches(event, handle, registration.fields)) continue;
        registration.lastInvalidatedRevision = revision;
      }
    }
  }

  function changedSince(input




   )                          {
    const registration = registrations.get(input.id);
    if (!registration) {
      return Object.freeze({ kind: 'resync', revision: input.revision });
    }
    if (registration.principalKey !== principalKeyOf(input.principal)) {
      return Object.freeze({ kind: 'denied', revision: input.revision });
    }
    if (!Number.isSafeInteger(input.sinceRevision) || !Number.isSafeInteger(input.revision)) {
      fail('revision tokens must be safe integers.');
    }
    if (input.sinceRevision > input.revision) fail('sinceRevision is ahead of the commit lifecycle.');
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
