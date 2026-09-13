// Query-scoped reads (#225, ADR-0009).
//
// A typed, authorized page over one compiled Entity: allowlisted operators,
// single-key sort with an `id ASC` tie-break (the readRows convention), keyset
// pagination, optional count, and a revision token from `_CommittedRevision`.
// Invalidation is a "changed since R" signal; the client refetches. This is
// not a second write path, not a second auth engine, and not a row-patch fold.

import { canonicalStringify } from './canonical-json.ts';
import { parseEventType, EventKind, type EventIdentityHandle } from './event-handle.ts';
import { tryParseScopeKey } from './scope-handle.ts';

export const QUERY_OPERATORS = Object.freeze(['eq', 'in', 'gt', 'gte', 'lt', 'lte'] as const);
export type QueryOperator = (typeof QUERY_OPERATORS)[number];

export const QUERY_PAGE_SIZE_MIN = 1;
export const QUERY_PAGE_SIZE_MAX = 100;
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
  get(...args: unknown[]): Record<string, unknown> | undefined;
  all(...args: unknown[]): Record<string, unknown>[];
};

export type QueryDb = {
  prepare(sql: string): Statement;
};

export interface QueryEntity {
  name: string;
  fields: Record<string, { kind?: string; type?: string }>;
  scopeFilter?(principal: unknown): { sql: string; params: Record<string, unknown> };
}

export interface QueryFilter {
  readonly field: string;
  readonly op: QueryOperator;
  readonly value: unknown;
}

export interface QuerySort {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

export interface QueryContract {
  readonly entity: string;
  readonly filters?: readonly QueryFilter[];
  readonly sort: QuerySort;
  readonly pageSize: number;
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
  readonly sort: QuerySort;
  readonly pageSize: number;
  readonly dependencyFields: readonly string[];
}

export interface QueryPage {
  readonly rows: readonly Record<string, unknown>[];
  readonly revision: number;
  readonly nextCursor: QueryCursor | null;
  readonly queryIdentity: string;
  readonly count?: number;
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

const CONTRACT_KEYS = Object.freeze(['entity', 'filters', 'sort', 'pageSize']);
const FILTER_KEYS = Object.freeze(['field', 'op', 'value']);
const SORT_KEYS = Object.freeze(['field', 'direction']);

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
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
  fail(`${label} must be a SQLite scalar value.`);
}

function detached(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.freeze({ ...raw });
}

function principalKeyOf(principal: unknown): string {
  if (!principal || typeof principal !== 'object') fail('principal is required.');
  const record = principal as { type?: unknown; id?: unknown };
  if (typeof record.type !== 'string') fail('principal type is required.');
  if (record.type === 'anonymous') return 'anonymous';
  if (typeof record.id !== 'string' || record.id.length === 0) fail('principal id is required.');
  return `${record.type}:${record.id}`;
}

function compileFilter(
  filter: unknown,
  declared: Set<string>,
  entity: QueryEntity,
  params: Record<string, unknown>,
  index: number,
): { sql: string; field: string } {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) fail('filters must be objects.');
  assertKeys(filter, FILTER_KEYS, 'filter');
  const { field, op = 'eq', value } = filter as QueryFilter;
  if (typeof field !== 'string' || !declared.has(field)) fail('a filter references an unknown field.');
  assertScalarField(entity, field, 'filter field');
  if (!(QUERY_OPERATORS as readonly string[]).includes(op)) fail('a filter uses an unsupported operator.');
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
  const operator = ({ eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const)[op];
  return { sql: `${column} ${operator} :${name}`, field };
}

export function compileQueryContract(input: unknown, entity: QueryEntity): CompiledQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('contract must be an object.');
  assertKeys(input, CONTRACT_KEYS, 'contract');
  const contract = input as QueryContract;
  if (contract.entity !== entity.name) fail('contract entity does not match the compiled entity.');
  identifier(entity.name, 'entity name');
  const declared = fieldsOf(entity);
  if (contract.filters !== undefined && !Array.isArray(contract.filters)) fail('filters must be an array.');
  if ((contract.filters?.length ?? 0) > FILTERS_MAX) fail('filters must contain at most 16 entries.');
  const params: Record<string, unknown> = {};
  const filters = (contract.filters ?? []).map((filter, index) => {
    const compiled = compileFilter(filter, declared, entity, params, index);
    return Object.freeze({ field: compiled.field, op: (filter.op ?? 'eq') as QueryOperator, value: filter.value });
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

export function readCommittedRevision(db: QueryDb): number {
  let row: Record<string, unknown> | undefined;
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

function grantFilter(entity: QueryEntity, principal: unknown): { sql: string; params: Record<string, unknown> } {
  if (typeof entity.scopeFilter !== 'function') fail('entity has no compiled grant filter.');
  const filter = entity.scopeFilter(principal);
  if (!filter || typeof filter.sql !== 'string') fail('compiled grant filter is malformed.');
  return { sql: filter.sql, params: { ...filter.params } };
}

function filterSql(compiled: CompiledQuery, entity: QueryEntity, params: Record<string, unknown>): string {
  const declared = fieldsOf(entity);
  return compiled.filters.map((filter, index) => compileFilter(filter, declared, entity, params, index).sql).join(' AND ');
}

function keysetSql(sortColumn: string, direction: 'asc' | 'desc', cursor: QueryCursor, params: Record<string, unknown>): string {
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
  compiled: CompiledQuery,
  entity: QueryEntity,
  principal: unknown,
  cursor: QueryCursor | null | undefined,
  params: Record<string, unknown>,
): string {
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
  db: QueryDb,
  entity: QueryEntity,
  principal: unknown,
  compiled: CompiledQuery,
  cursor: QueryCursor | null | undefined,
  includeCount: boolean,
): Omit<QueryPage, 'revision'> {
  identifier(entity.name, 'entity name');
  const params: Record<string, unknown> = {};
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
  let count: number | undefined;
  if (includeCount) {
    const countParams: Record<string, unknown> = {};
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
  db: QueryDb,
  entity: QueryEntity,
  principal: unknown,
  compiled: CompiledQuery,
  options: { cursor?: QueryCursor | null; includeCount?: boolean } = {},
): QueryPage {
  if (compiled.entity !== entity.name) fail('compiled query does not match the entity.');
  const includeCount = options.includeCount === true;
  let lastContention: QueryContentionError | null = null;
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
  entity: string;
  fields: ReadonlySet<string>;
  principalKey: string;
  lastInvalidatedRevision: number | null;
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

export function createQueryInvalidationHub() {
  const registrations = new Map<string, QueryRegistration>();

  function register(input: { id: string; dependency: QueryDependency; principal: unknown }): void {
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

  function unregister(id: string): void {
    registrations.delete(id);
  }

  function notice(events: readonly unknown[], revision: number): void {
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

  function changedSince(input: {
    id: string;
    principal: unknown;
    sinceRevision: number;
    revision: number;
  }): QueryInvalidationSignal {
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

export type QueryInvalidationHub = ReturnType<typeof createQueryInvalidationHub>;

export function createQueryInvalidationConsumer(hub: QueryInvalidationHub, db: QueryDb) {
  return async (events: readonly unknown[]): Promise<void> => {
    try {
      hub.notice(events, readCommittedRevision(db));
    } catch {
      // post-commit isolation: an invalidation failure never undoes the commit
    }
  };
}
