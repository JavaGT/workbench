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
export const QUERY_REGISTRATION_MAX = 32;
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
  fields: Record<string, { kind?: string; type?: string; role?: unknown }>;
  scopeFilter?(principal: unknown): { sql: string; params: Record<string, unknown> };
  scopeAst?: unknown;
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

function authorizationFields(entity: QueryEntity): string[] {
  const out = new Set<string>();
  if (entity.scopeAst) collectAstFields(entity.scopeAst, out);
  for (const [name, descriptor] of Object.entries(entity.fields ?? {})) {
    if (descriptor?.role === 'owner' || name === 'owner' || name === 'projectId') out.add(name);
  }
  const declared = fieldsOf(entity);
  return [...out].filter((field) => declared.has(field));
}

function compileFilter(
  filter: unknown,
  declared: Set<string>,
  entity: QueryEntity,
  params: Record<string, unknown>,
  index: number,
): { sql: string; field: string; op: QueryOperator; value: unknown } {
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
    return { sql: `${column} IN (${names.join(', ')})`, field, op, value: freezeJsonValue(value) };
  }
  assertSqlValue(value, 'filter value');
  const name = `query_f${index}`;
  params[name] = value;
  const operator = ({ eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const)[op];
  return { sql: `${column} ${operator} :${name}`, field, op, value };
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
    filters: filters.map((filter) => ({ field: filter.field, op: filter.op, value: filter.value })),
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

function asSafeRevision(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') {
    const converted = Number(value);
    if (!Number.isSafeInteger(converted)) fail(`${label} exceeds a safe integer.`);
    return converted;
  }
  fail(`${label} is missing.`);
}

export function readCommittedRevision(db: QueryDb): number {
  let row: Record<string, unknown> | undefined;
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

function grantFilter(entity: QueryEntity, principal: unknown): { sql: string; params: Record<string, unknown> } {
  if (typeof entity.scopeFilter !== 'function') fail('entity has no compiled grant filter.');
  const filter = entity.scopeFilter(principal);
  if (!filter || typeof filter.sql !== 'string') fail('compiled grant filter is malformed.');
  return { sql: filter.sql, params: { ...filter.params } };
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

function defaultScopeField(scope: string): string | null {
  const parsed = tryParseScopeKey(scope);
  if (!parsed) return null;
  return `${parsed.entity.charAt(0).toLowerCase()}${parsed.entity.slice(1)}Id`;
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
    count = asSafeRevision(countRow?.n ?? 0, 'count');
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
  entityName: string;
  fields: ReadonlySet<string>;
  scope: string;
  scopeField: string | null;
  principalKey: string;
  compiledEntity: QueryEntity;
  lastInvalidatedRevision: number | null;
  registeredAtRevision: number;
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
  scopeField: string | null,
): void {
  const grant = assertAdmitted(entity, principal);
  const params: Record<string, unknown> = { ...grant.params };
  let sql = `SELECT 1 AS ok FROM ${identifier(entity.name, 'entity name')} AS t0 WHERE (${grant.sql})`;
  const parsed = tryParseScopeKey(scope);
  if (parsed && scopeField && (scopeField === 'id' || entity.fields[scopeField])) {
    sql += ` AND t0.${identifier(scopeField, 'scope field')} = :query_scope_id`;
    params.query_scope_id = parsed.id;
  }
  sql += ' LIMIT 1';
  const row = db.prepare(sql).get(params);
  if (!row) fail('principal cannot see this query scope.');
}

export function createQueryInvalidationHub(options: { maxRegistrations?: number } = {}) {
  const maxRegistrations = options.maxRegistrations ?? QUERY_REGISTRATION_MAX;
  if (!Number.isSafeInteger(maxRegistrations) || maxRegistrations < 1) fail('maxRegistrations must be a positive integer.');
  const registrations = new Map<string, QueryRegistration>();

  function slot(principalKey: string, id: string): string {
    return `${principalKey}\n${id}`;
  }

  function register(input: {
    id: string;
    dependency: QueryDependency;
    principal: unknown;
    entity: QueryEntity;
    db: QueryDb;
    revision: number;
  }): void {
    if (typeof input.id !== 'string' || input.id.length === 0) fail('registration id is required.');
    if (!Number.isSafeInteger(input.revision)) fail('registration revision must be a safe integer.');
    const principalKey = queryPrincipalKey(input.principal);
    if (!input.dependency || typeof input.dependency !== 'object') fail('dependency is required.');
    identifier(input.dependency.entity, 'dependency entity');
    if (input.dependency.entity !== input.entity.name) fail('dependency entity does not match the compiled entity.');
    if (!Array.isArray(input.dependency.fields)) fail('dependency fields must be an array.');
    if (typeof input.dependency.scope !== 'string' || input.dependency.scope.length === 0) fail('dependency scope is required.');
    if (!tryParseScopeKey(input.dependency.scope)) fail('dependency scope must be a Scope handle.');
    const scopeField = input.dependency.scopeField ?? defaultScopeField(input.dependency.scope);
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

  function unregister(id: string, principal: unknown): void {
    registrations.delete(slot(queryPrincipalKey(principal), id));
  }

  function notice(events: readonly unknown[], revision: number): void {
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
