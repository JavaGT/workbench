import { principalSnapshotScope, parsePrincipalSnapshotScope } from './principal-snapshot-scope.mjs';
import {
  isPrincipalSnapshotDeclaration,




} from './principal-snapshot-declaration.mjs';


const PRINCIPAL_PREFIX = 'PrincipalSnapshot:';

export function isPrincipalSnapshotScope(scope         )          {
  return typeof scope === 'string' && scope.startsWith(PRINCIPAL_PREFIX);
}

export function validatePrincipalSnapshotDeclarations(
  declarations                                            ,
  schema                                                                                ,
)       {
  if (declarations === undefined) return;
  if (!Array.isArray(declarations)) throw new TypeError('principalSnapshots must be an array');
  if (!schema || !Array.isArray(schema.tables)) throw new Error('principal snapshots require an application schema');
  const names = new Set        ();
  const tables = new Map                     (schema.tables.map((table) => [table.name, new Set(table.columns.map((column) => column.name))]));
  // Resolve a source's declared columns: a physical (host-declared) source
  // carries its own explicit column list, fail-closed; a schema source resolves
  // against the frozen application schema.
  const sourceColumns = (source                  )              => {
    if (source.physicalColumns !== undefined) return new Set(source.physicalColumns);
    const columnSet = tables.get(source.table);
    if (!columnSet) throw new Error(`principal snapshot source table '${source.table}' must be declared in the application schema`);
    return columnSet;
  };
  for (const declaration of declarations) {
    if (!isPrincipalSnapshotDeclaration(declaration)) throw new TypeError('principalSnapshots accepts only principalSnapshot(...) declarations');
    if (names.has(declaration.name)) throw new Error(`principal snapshot '${declaration.name}' is declared more than once`);
    names.add(declaration.name);
    for (const collection of Object.values(declaration.fields)) {
      const source = collection.source ;
      const physical = source.physicalColumns !== undefined;
      if (!physical && source.schema !== schema) {
        throw new Error(`principal snapshot source '${source.table}' must use the application schema`);
      }
      const columns = sourceColumns(source);
      for (const field of [collection.via, collection.key, ...(collection.select ?? []), ...(collection.orderBy ?? [])]) {
        if (!columns.has(field .column)) throw new Error(`principal snapshot source column '${field .column}' must be declared on '${source.table}'`);
      }
      if (collection.where !== undefined) validateSnapshotFilter(collection.where, source, schema, sourceColumns);
      const join = collection.join;
      if (join !== undefined) {
        // `on.from` is the anchor table's FK column; `on.to` and `join.select`
        // are on the joined table.
        if (!columns.has(join.on.from.column)) {
          throw new Error(`principal snapshot join on.from column '${join.on.from.column}' must be declared on '${source.table}'`);
        }
        const joinColumns = sourceColumns(join.source);
        if (!joinColumns.has(join.on.to.column)) {
          throw new Error(`principal snapshot join on.to column '${join.on.to.column}' must be declared on '${join.source.table}'`);
        }
        for (const field of join.select) {
          if (!joinColumns.has(field.column)) {
            throw new Error(`principal snapshot join select column '${field.column}' must be declared on '${join.source.table}'`);
          }
        }
      }
    }
  }
}

function validateSnapshotFilter(
  filter                         ,
  anchor                  ,
  schema         ,
  getSourceColumns                                           ,
)       {
  const anchorColumns = getSourceColumns(anchor);
  function visit(node                         , nestedSource                         , nestedColumns                    )       {
    switch (node.kind) {
      case 'and':
      case 'or':
        if (node.terms.length < 2) throw new Error(`principal snapshot filter '${node.kind}' requires two or more terms`);
        node.terms.forEach((term) => visit(term, nestedSource, nestedColumns));
        return;
      case 'in':
      case 'isNull':
        validateFilterField(node.field, anchor, anchorColumns, nestedSource, nestedColumns);
        if (node.kind === 'in' && (node.values.length === 0 || node.values.some((value) => typeof value !== 'string'))) {
          throw new Error('principal snapshot filter in requires one or more string values');
        }
        return;
      case 'equal':
        validateFilterField(node.left, anchor, anchorColumns, nestedSource, nestedColumns);
        if (node.right.kind !== 'principalId') validateFilterField(node.right, anchor, anchorColumns, nestedSource, nestedColumns);
        return;
      case 'exists': {
        if (nestedSource !== null) throw new Error('principal snapshot filters do not allow nested exists');
        if (node.source === anchor) throw new Error('principal snapshot filter exists source must differ from the anchor source');
        if (!node.principalField || node.principalField.source !== node.source || !getSourceColumns(node.source).has(node.principalField.column)) {
          throw new Error('principal snapshot filter exists principalField must belong to its declared source');
        }
        if (node.source.physicalColumns === undefined && node.source.schema !== schema) {
          throw new Error(`principal snapshot filter source '${node.source.table}' must use the application schema`);
        }
        visit(node.where, node.source, getSourceColumns(node.source));
        return;
      }
      default:
        throw new Error('principal snapshot filter contains an unsupported expression');
    }
  }
  visit(filter, null, null);
}

function validateFilterField(
  field                   ,
  anchor                  ,
  anchorColumns             ,
  nestedSource                         ,
  nestedColumns                    ,
)       {
  if (!field || typeof field !== 'object' || field.kind !== 'sourceField') {
    throw new Error('principal snapshot filter requires a source field handle');
  }
  const columns = field.source === anchor ? anchorColumns : field.source === nestedSource ? nestedColumns : null;
  if (!columns || !columns.has(field.column)) {
    throw new Error(`principal snapshot filter field '${field.column}' must belong to a declared filter source`);
  }
}

function quote(name        ) {
  return `"${name.replace(/"/g, '""')}"`;
}

function jsonValue(value         , path        )                                   {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(`${path} is not a JSON value`);
}






// The circumstances under which a principal snapshot may be projected. Each
// entry point names the trigger it is re-authorizing so an app implementation
// can distinguish one-shot reads from long-lived subscription maintenance.








/**
 * The package-owned reauthorization seam for principal snapshots. Admission on
 * declaration grammar alone (name + principal type + id) is a scope-level gate;
 * the host's own authorization/membership state lives HERE. The delivery
 * invokes the authorizer BEFORE every recipient projection: bootstrap,
 * catch-up, subscription admission, and each replacement/resync drain. A denial
 * fails closed — the request/subscription is revoked and no replacement
 * projection is ever delivered to the denied principal. An authorizer error or
 * a non-true result is a denial, never an admit. With NO authorizer supplied,
 * every access is denied (fail closed): a deployment that attaches principal
 * snapshots MUST declare one. Scope supplies a membership-aware
 * implementation.
 */


















































































function revisionFor(db          , declaration                              , principal                            )         {
  const row = db.prepare(
    'SELECT revision FROM _PrincipalSnapshotRevision WHERE declaration = ? AND principalType = ? AND principalId = ?',
  ).get(declaration.name, principal.type, principal.id)                                      ;
  return Number(row?.revision ?? 0);
}

function joinOutputKey(source                  , column        )         {
  // Namespace joined columns by their table so the anchor's own columns can
  // never collide with a denormalized related-display column.
  return `${source.table}__${column}`;
}

function compileSnapshotFilter(filter                         , anchor                  , principalId        )                                    {
  const params           = [];
  function fieldSql(field                   , nestedSource                         )         {
    const alias = field.source === anchor ? 'A' : field.source === nestedSource ? 'X' : null;
    if (alias === null) throw new Error('principal snapshot filter references a field outside its validated sources');
    return `${alias}.${quote(field.column)}`;
  }
  function compile(node                         , nestedSource                          = null)         {
    switch (node.kind) {
      case 'and': return `(${node.terms.map((term) => compile(term, nestedSource)).join(' AND ')})`;
      case 'or': return `(${node.terms.map((term) => compile(term, nestedSource)).join(' OR ')})`;
      case 'in':
        params.push(...node.values);
        return `(${fieldSql(node.field, nestedSource)} IN (${node.values.map(() => '?').join(', ')}))`;
      case 'isNull': return `(${fieldSql(node.field, nestedSource)} IS NULL)`;
      case 'equal':
        if (node.right.kind === 'principalId') {
          params.push(principalId);
          return `(${fieldSql(node.left, nestedSource)} = ?)`;
        }
        return `(${fieldSql(node.left, nestedSource)} = ${fieldSql(node.right, nestedSource)})`;
      case 'exists': {
        params.push(principalId);
        return `(EXISTS (SELECT 1 FROM ${quote(node.source.table)} X WHERE (X.${quote(node.principalField.column)} = ?) AND ${compile(node.where, node.source)}))`;
      }
      default:
        throw new Error('principal snapshot filter contains an unsupported expression');
    }
  }
  return { sql: compile(filter), params };
}

function project(db          , declaration                              , principal                            )                          {
  const output                                                               = {};
  for (const [name, collection] of Object.entries(declaration.fields)) {
    const join = collection.join;
    const nested = join !== undefined;
    const aliasedAnchor = nested || collection.where !== undefined;
    const anchorCols = (() => {
      const selected = collection.select .map((field) => field.column);
      return selected.includes(collection.key .column) ? selected : [...selected, collection.key .column];
    })();
    const joinCols = join?.select.map((field) => field.column) ?? [];
    // Every projected column is aliased to its deterministic output key so the
    // raw rows carry the final keys directly (no post-row rename).
    const anchorAliases = nested
      ? anchorCols.map((column) => `A.${quote(column)} AS ${quote(`${collection.source .table}__${column}`)}`)
      : aliasedAnchor ? anchorCols.map((column) => `A.${quote(column)} AS ${quote(column)}`) : anchorCols.map(quote);
    const joinAliases = nested ? joinCols.map((column) => `B.${quote(column)} AS ${quote(joinOutputKey(join .source, column))}`) : [];
    const joinClause = nested
      ? ` JOIN ${quote(join .source.table)} B ON B.${quote(join .on.to.column)} = A.${quote(join .on.from.column)}`
      : '';
    const orderByRaw = collection.orderBy?.length
      ? collection.orderBy.map((field) => `${aliasedAnchor ? 'A.' : ''}${quote(field.column)} ${field.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ')
      : `${aliasedAnchor ? 'A.' : ''}${quote(collection.key .column)} ASC`;
    const tableClause = aliasedAnchor ? `${quote(collection.source .table)} A` : quote(collection.source .table);
    const viaClause = `${aliasedAnchor ? 'A.' : ''}${quote(collection.via .column)} = ?`;
    const compiledFilter = collection.where === undefined ? null : compileSnapshotFilter(collection.where, collection.source , principal.id);
    const filterClause = compiledFilter === null ? '' : ` AND ${compiledFilter.sql}`;
    const sql = `SELECT ${[...anchorAliases, ...joinAliases].join(', ')} FROM ${tableClause}${joinClause} WHERE ${viaClause}${filterClause} ORDER BY ${orderByRaw}`;
    const rows = db.prepare(sql).all(principal.id, ...(compiledFilter?.params ?? [])).map((raw, rowIndex) => {
      const row                          = {};
      for (const column of anchorCols) {
        const key = nested ? joinOutputKey(collection.source , column) : column;
        row[key] = jsonValue(raw[key], `${name}[${rowIndex}].${key}`);
      }
      for (const column of joinCols) {
        const key = joinOutputKey(join .source, column);
        row[key] = jsonValue(raw[key], `${name}[${rowIndex}].${key}`);
      }
      return Object.freeze(row);
    });
    output[name] = Object.freeze(rows);
  }
  return Object.freeze(output);
}

function resolution(
  declarations                                           ,
  principal                                               ,
  scope        ,
)                                   {
  let parsed;
  try {
    parsed = parsePrincipalSnapshotScope(scope);
  } catch {
    return null;
  }
  const declaration = declarations.get(parsed.declaration);
  if (!declaration || principal?.type !== parsed.type || principal?.id !== parsed.id || declaration.principalType !== parsed.type) return null;
  return Object.freeze({ declaration, principal: Object.freeze({ type: parsed.type, id: parsed.id }) });
}

export function createPrincipalSnapshotDelivery({ db, declarations, authorize }



 )                            {
  if (!db) throw new TypeError('principal snapshot delivery requires a database');
  const database = db;
  // Fail closed when the host supplied no reauthorization seam: a
  // principal-snapshot deployment MUST declare one (see
  // PrincipalSnapshotAuthorize). Absent it, no principal is ever admitted.
  const authorizer = authorize ?? null;
  const byName = new Map                                      ();
  for (const declaration of declarations ?? []) {
    if (!isPrincipalSnapshotDeclaration(declaration) || byName.has(declaration.name)) {
      throw new TypeError('principal snapshot delivery requires unique valid declarations');
    }
    byName.set(declaration.name, declaration);
  }
  const subs = new Map                                            ();
  const byScope = new Map                     ();
  let nextId = 1;
  let closed = false;

  // Host reauthorization before any recipient projection. Strictly `true`
  // admits; a denial, an authorizer error, or a non-true result all fail
  // closed.
  async function authorized(input                              )                   {
    if (!authorizer) return false;
    try {
      return await authorizer(input) === true;
    } catch {
      return false;
    }
  }

  function pairedSnapshot(resolved                           )                                                                 {
    // Both reads are synchronous. The fence prevents returning source rows from a
    // different recipient revision if a host transaction interleaves between them.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = revisionFor(database, resolved.declaration, resolved.principal);
      const snapshot = project(database, resolved.declaration, resolved.principal);
      const after = revisionFor(database, resolved.declaration, resolved.principal);
      if (before === after) return Object.freeze({ kind: 'snapshot', snapshot, cursor: after });
    }
    return Object.freeze({ kind: 'retry' });
  }

  // Singular lifecycle: every removal path (abort signal, drain failure, close)
  // flows through here. It marks the subscription inactive, detaches its abort
  // listener, removes it from the registries, then invokes the transport revoke
  // exactly once so the SSE stream ends and its capacity is released. The
  // subs.get guard makes later removals, aborts, and close() calls no-ops, so
  // nothing double-releases.
  function remove(id        ) {
    const sub = subs.get(id);
    if (!sub) return;
    sub.active = false;
    if (sub.signal && sub.abort) sub.signal.removeEventListener('abort', sub.abort);
    subs.delete(id);
    const scopeSubs = byScope.get(sub.scope);
    scopeSubs?.delete(id);
    if (scopeSubs?.size === 0) byScope.delete(sub.scope);
    try {
      sub.revoke?.();
    } catch {
      // Transport lifecycle callbacks are isolated.
    }
  }

  async function drain(id        ) {
    const sub = subs.get(id);
    if (!sub || !sub.active || sub.pending) return;
    sub.pending = true;
    try {
      while (sub.active) {
        sub.dirty = false;
        const revision = revisionFor(database, sub.declaration, sub.principal);
        if (revision > sub.cursor) {
          // Reauthorize BEFORE the replacement projection. A denial revokes
          // the subscription here (remove -> revoke) so no resync envelope is
          // ever delivered to a principal the host no longer admits.
          if (!(await authorized({ declaration: sub.declaration, principal: sub.principal, trigger: 'resync' }))) {
            remove(id);
            return;
          }
          await sub.deliver([{ type: 'resync', seq: revision, reason: 'recipient-snapshot-required' }]);
          if (!sub.active) return;
          sub.cursor = revision;
        }
        if (!sub.dirty) return;
      }
    } catch (error) {
      remove(id);
      throw error;
    } finally {
      const current = subs.get(id);
      if (current) {
        current.pending = false;
        if (current.active && current.dirty) void drain(id).catch(() => {});
      }
    }
  }

  return Object.freeze({
    async bootstrap({ principal, scope }                                                                             )                                            {
      if (closed) throw new Error('principal snapshot delivery is closed');
      const resolved = resolution(byName, principal, scope);
      if (!resolved) return Object.freeze({ kind: 'revoked' });
      if (!(await authorized({ declaration: resolved.declaration, principal: resolved.principal, trigger: 'bootstrap' }))) {
        return Object.freeze({ kind: 'revoked' });
      }
      return pairedSnapshot(resolved);
    },
    async catchup({ principal, scope, after }                                                                                            )                                            {
      if (closed) throw new Error('principal snapshot delivery is closed');
      const resolved = resolution(byName, principal, scope);
      if (!resolved) return Object.freeze({ kind: 'revoked' });
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a nonnegative safe integer');
      if (!(await authorized({ declaration: resolved.declaration, principal: resolved.principal, trigger: 'catchup' }))) {
        return Object.freeze({ kind: 'revoked' });
      }
      const revision = revisionFor(database, resolved.declaration, resolved.principal);
      const hasRowFilters = Object.values(resolved.declaration.fields).some((collection) => collection.where !== undefined);
      return after === revision && !hasRowFilters
        ? Object.freeze({ kind: 'catchup', envelopes: Object.freeze([]), cursor: revision })
        : pairedSnapshot(resolved);
    },
    async subscribe({ principal, scope, after, signal, deliver, revoke }                                 )                                       {
      if (closed) throw new Error('principal snapshot delivery is closed');
      const resolved = resolution(byName, principal, scope);
      if (!resolved) {
        const error                            = new Error('principal snapshot subscription denied');
        error.code = 'live-delivery-revoked';
        throw error;
      }
      if (!Number.isSafeInteger(after) || after < 0 || typeof deliver !== 'function') throw new Error('invalid principal snapshot subscription');
      // Subscription admission consults the host authorizer BEFORE the
      // subscription is installed. A denial revokes (tearing the transport
      // down before any delivery) and rejects with the same terminal code the
      // scope-level denial uses.
      if (!(await authorized({ declaration: resolved.declaration, principal: resolved.principal, trigger: 'subscribe' }))) {
        revoke?.();
        const error                            = new Error('principal snapshot subscription denied');
        error.code = 'live-delivery-revoked';
        throw error;
      }
      if (signal?.aborted) return { activate: async () => undefined };
      const id = nextId++;
      const sub                                     = {
        ...resolved,
        scope,
        cursor: after,
        deliver,
        revoke,
        signal,
        active: true,
        pending: false,
        dirty: false,
        abort: () => remove(id),
      };
      subs.set(id, sub);
      const scopeSubs = byScope.get(scope) ?? new Set();
      scopeSubs.add(id);
      byScope.set(scope, scopeSubs);
      signal?.addEventListener('abort', sub.abort, { once: true });
      return Object.freeze({ activate: async () => { await drain(id); return subs.get(id)?.cursor; } });
    },
    wake(declaration                                       , principal                            ) {
      if (closed) return;
      const scope = typeof declaration === 'string' ? declaration : principalSnapshotScope({ declaration: declaration.name, principal });
      for (const id of [...(byScope.get(scope) ?? [])]) {
        const sub = subs.get(id);
        if (!sub || !sub.active) continue;
        sub.dirty = true;
        void drain(id).catch(() => {});
      }
    },
    close() {
      closed = true;
      for (const id of [...subs.keys()]) remove(id);
    },
  });
}
