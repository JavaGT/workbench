// Framework-owned query / query-family / query-invalidation routes. Both
// default-on auth layers run through the SAME adapter every other transport
// consults: the route gate and the post-filter over returned rows.

import { collapseForAdmission, anonymous,                } from './principal.mjs';
import { requireUser,           } from './route-gate.mjs';

import {
  compileQueryContract,
  createQueryInvalidationHub,
  executeQueryPage,
  queryCursorForRow,
  readCommittedRevision,
  QueryScopedReadError,




} from './query-scoped-read.mjs';
import {
  queryFamilyChangedSince,
  registerQueryFamilyInvalidation,

} from './query-family.mjs';
import { sendJson,                       } from './http-response.mjs';
import {


  reject,
  readJsonObjectBody,
  queryAuthorization,
  admitQueryGate,
  admitQueryRows,
  entityReadGate,
} from './http-routes-shared.mjs';

// ---------------------------------------------------------------------------
// Query / query-family / search HTTP routes (#312)
// ---------------------------------------------------------------------------
//
// Three framework-owned POST endpoints (intercepted before matchRoute, like
// /snapshot and /blobs) that expose the library query and search surfaces over
// HTTP:
//
//   POST /query/:entity           — an authorized query-scoped read page
//   POST /query-families/:name    — a registered query family page
//   POST /search                  — FTS / vector / hybrid search
//
// Authorization is the SAME engine as every other transport. Both default-on
// layers run through the injected authorization adapter (app._authorization,
// stashed by serve.ts), exactly as REST does:
//   1. the route gate via `admit({ category: 'principal', ... })`, and
//   2. row admission via `admit({ category: 'entity', ... })` on every returned
//      row / search hit — the SQL scope inside query/search execution decides
//      VISIBILITY, the adapter decides the read CAPABILITY, like REST list.
// With no adapter injected, the framework default (the row-grant wrapper REST
// uses) keeps behavior unchanged. There is no second auth path, and the request
// principal is already collapsed for admission by the transport.

// A page's SQL LIMIT is applied BEFORE the adapter post-filter above. Without
// compensation, an adapter that denies rows mid-page returns a short page with
// a cursor/hasMore computed from rows the caller never sees. Walk subsequent
// underlying pages until `pageSize + 1` rows survive admission (or the query is
// exhausted), then recompute the page boundary and the hasMore/nextCursor pair
// from the admitted stream. The loop is bounded: an adversarial policy cannot
// make one HTTP request scan an unbounded query. Stopping at a page boundary
// after the (n+1)th admitted row is safe: every row before that boundary was
// examined and the denied ones stay denied, so no admitted row is skipped.
const MAX_ADMISSION_PAGES = 100;

async function executeAdmittedQueryPage                     (
  execute                                      ,
  body                         ,
  admitRows                                                                                  ,
)             {
  const pageSize = body.pageSize          ;
  const admitted                                                                  = [];
  let cursor                     = (body.cursor ?? null)                      ;
  let offset = body.offset                      ;
  let lastPage           = null;
  let firstPage           = null;
  for (let scanned = 0; scanned < MAX_ADMISSION_PAGES; scanned += 1) {
    const pageBody                          = {
      ...body,
      cursor,
      ...(offset !== undefined ? { offset } : {}),
      // Only the first physical page computes the optional counts; later pages
      // are pagination fill and would recompute the same numbers.
      ...(firstPage ? { includeCount: false, includeTotal: false } : {}),
    };
    const page = execute(pageBody);
    firstPage ??= page;
    lastPage = page;
    const allowed = await admitRows(page.rows);
    const allowedIds = new Set(allowed.map((row) => row));
    for (let index = 0; index < page.rows.length; index += 1) {
      if (!allowedIds.has(page.rows[index] )) continue;
      admitted.push({ row: page.rows[index] , page, index });
      if (admitted.length > pageSize) break;
    }
    if (admitted.length > pageSize || !page.hasMore || !page.nextCursor) break;
    // Advance exactly ONE pagination coordinate. query-scoped-read rejects a
    // positive offset combined with a cursor, so an offset-based fill must not
    // also carry the physical page's keyset token forward — doing so turned a
    // legitimate denied-row refill into a 400 on the next fetch.
    if (offset !== undefined) {
      cursor = null;
      offset += page.rows.length;
    } else {
      cursor = page.nextCursor;
    }
  }
  const page = lastPage ?? firstPage ;
  const rows = admitted.slice(0, pageSize).map((entry) => entry.row);
  const hasMore = admitted.length > pageSize;
  const lastReturned = hasMore ? admitted[pageSize - 1] : undefined;
  return {
    ...page,
    rows,
    hasMore,
    // Anchor on the last row we actually return, not on the last row the SQL
    // page happened to fetch — that is the cursor the client's next page needs.
    nextCursor: hasMore && lastReturned ? queryCursorForRow(lastReturned.page, lastReturned.index) : null,
    revision: page.revision,
    ...(firstPage?.count !== undefined ? { count: firstPage.count, filteredTotal: firstPage.filteredTotal } : {}),
    ...(firstPage?.total !== undefined ? { total: firstPage.total } : {}),
    ...(offset !== undefined ? { offset } : {}),
  }     ;
}

// The standard page JSON. `queryIdentity` is the stable handle the client uses
// to bind a follow-up page token to this query; it is part of QueryPage and must
// be disclosed. `count`/`filteredTotal` are omitted unless the request asked for
// `includeCount`; `total` unless it asked for `includeTotal`.
function queryPageBody(page           )                          {
  return {
    rows: page.rows,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    revision: page.revision,
    queryIdentity: page.queryIdentity,
    ...(page.count !== undefined ? { count: page.count, filteredTotal: page.filteredTotal } : {}),
    ...(page.total !== undefined ? { total: page.total } : {}),
  };
}

// Compile the request contract against the mounted entity and execute it in one
// read snapshot. The body's pagination/count options are lifted out of the
// contract (compileQueryContract accepts only contract keys); an unknown
// property therefore surfaces as a 400 validation error, not a silent ignore.
function executeQueryScopedRead(
  db         ,
  entity            ,
  principal         ,
  body                         ,
)            {
  const queryEntity = entity                          ;
  const compiled = compileQueryContract({
    entity: entity.name,
    filters: body.filters         ,
    where: body.where         ,
    expression: body.expression         ,
    sort: body.sort         ,
    pageSize: body.pageSize         ,
  }, queryEntity);
  return executeQueryPage(db         , queryEntity, principal, compiled, {
    cursor: (body.cursor ?? null)         ,
    offset: body.offset                      ,
    maxOffset: body.maxOffset                      ,
    includeCount: body.includeCount === true,
    includeTotal: body.includeTotal === true,
    hydrate: body.hydrate                       ,
  });
}

// POST /query/:entity — an authorized query-scoped read page.
export async function handleQueryRoute(
  app                                 ,
  req                  ,
  res                  ,
  principal                              ,
)                   {
  if (req.method !== 'POST') return false;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const seg = url.pathname.split('/').filter(Boolean);
  if (seg[0] !== 'query' || seg.length !== 2) return false;
  if (!app || !app.entities || !app.db) { reject(res, 404, 'not found'); return true; }

  let entityName        ;
  try {
    entityName = decodeURIComponent(seg[1] );
  } catch {
    reject(res, 404, 'not found');
    return true;
  }
  // Case-sensitive lookup against the app's compiled entities.
  const entity = app.entities.get(entityName);
  if (!entity) { reject(res, 404, 'not found'); return true; }

  const admitted = collapseForAdmission(principal ?? anonymous);
  const authorization = queryAuthorization(app);
  if (!await admitQueryGate(authorization, entityReadGate(entity), admitted)) {
    reject(res, 401, 'unauthorized');
    return true;
  }

  const body = await readJsonObjectBody(req, res);
  if (body === null) return true;

  try {
    const page = await executeAdmittedQueryPage(
      (pageBody) => executeQueryScopedRead(app.db, entity, admitted, pageBody),
      body,
      (rows) => admitQueryRows(authorization, entity, rows, admitted),
    );
    sendJson(res, 200, queryPageBody(page));
  } catch (err) {
    if (err instanceof QueryScopedReadError) {
      reject(res, 400, err.message);
      return true;
    }
    throw err;
  }
  return true;
}

// POST /query-families/:name — a registered query family page. The host
// entity's read gate (falling back to requireUser) decides admission; the
// family's compiled host/catalog/element grants decide row visibility.
export async function handleQueryFamilyRoute(
  app                                 ,
  req                  ,
  res                  ,
  principal                              ,
)                   {
  if (req.method !== 'POST') return false;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const seg = url.pathname.split('/').filter(Boolean);
  if (seg[0] !== 'query-families' || seg.length !== 2) return false;
  if (!app || !app.db) { reject(res, 404, 'not found'); return true; }

  let familyName        ;
  try {
    familyName = decodeURIComponent(seg[1] );
  } catch {
    reject(res, 404, 'not found');
    return true;
  }
  const registry = (app                                           ).queryFamilies;
  const family = registry?.get(familyName);
  if (!registry || !family) { reject(res, 404, 'not found'); return true; }

  const admitted = collapseForAdmission(principal ?? anonymous);
  const authorization = queryAuthorization(app);
  const hostGate = (family.host                                                 ).gate?.read;
  const gate = (typeof hostGate === 'function' ? hostGate : requireUser())        ;
  if (!await admitQueryGate(authorization, gate, admitted)) {
    reject(res, 401, 'unauthorized');
    return true;
  }

  const body = await readJsonObjectBody(req, res);
  if (body === null) return true;

  try {
    const page = await executeAdmittedQueryPage(
      (pageBody) => registry.execute(familyName, app.db         , admitted, pageBody)             ,
      body,
      (rows) => admitQueryRows(authorization, family.host                         , rows, admitted),
    );
    sendJson(res, 200, queryPageBody(page));
  } catch (err) {
    if (err instanceof QueryScopedReadError) {
      reject(res, 400, err.message);
      return true;
    }
    throw err;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Query invalidation registration / polling (#289) — the HTTP face of the
// query dependency hub. The hub is created lazily on the app (the one instance
// the post-commit consumer and every route share); serve.ts attaches that
// consumer to the kernel at listen time. Authorization is the SAME two-layer
// shape as /query: the subject entity's (or family host's) read gate through
// the adapter, then the compiled grant inside hub.register/changedSince.
// ---------------------------------------------------------------------------

export function ensureQueryInvalidationHub(app              )                       {
  const existing = (app                                                   ).queryInvalidationHub;
  if (existing) return existing;
  const hub = createQueryInvalidationHub(
    typeof app.queryInvalidationMaxRegistrations === 'number'
      ? { maxRegistrations: app.queryInvalidationMaxRegistrations           }
      : {},
  );
  (app                                                   ).queryInvalidationHub = hub;
  return hub;
}

function invalidationSubject(
  app              ,
  body                         ,
)                                                                {
  if (typeof body.family === 'string' && body.family.length > 0) {
    const family = (app                                           ).queryFamilies?.get(body.family);
    if (!family) return null;
    return { gateEntity: family.host                         , familyName: body.family };
  }
  if (typeof body.entity === 'string' && body.entity.length > 0) {
    return { gateEntity: app.entities?.get(body.entity) ?? null };
  }
  return null;
}

export async function handleQueryInvalidationRoute(
  app                                 ,
  req                  ,
  res                  ,
  principal                              ,
)                   {
  if (req.method !== 'POST') return false;
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path !== '/queries/register' && path !== '/queries/changed-since' && path !== '/queries/unregister') return false;
  if (!app || !app.db) { reject(res, 404, 'not found'); return true; }

  const admitted = collapseForAdmission(principal ?? anonymous);
  const authorization = queryAuthorization(app);
  const body = await readJsonObjectBody(req, res);
  if (body === null) return true;
  const subject = invalidationSubject(app, body);
  if (!subject || !subject.gateEntity) { reject(res, 404, 'not found'); return true; }
  const gate = entityReadGate(subject.gateEntity);
  if (!await admitQueryGate(authorization, gate, admitted)) {
    reject(res, 401, 'unauthorized');
    return true;
  }

  try {
    const hub = ensureQueryInvalidationHub(app);
    const revision = readCommittedRevision(app.db         );
    if (path === '/queries/register') {
      if (typeof body.id !== 'string' || body.id.length === 0 || typeof body.scope !== 'string' || body.scope.length === 0) {
        reject(res, 400, 'id and scope are required');
        return true;
      }
      if (subject.familyName) {
        const family = (app                                           ).queryFamilies .get(subject.familyName) ;
        registerQueryFamilyInvalidation(hub, {
          id: body.id,
          family,
          principal: admitted,
          db: app.db         ,
          revision,
          scope: body.scope,
          ...(typeof body.scopeField === 'string' ? { scopeField: body.scopeField } : {}),
          ...(Array.isArray(body.fields) ? { hostFields: body.fields             } : {}),
        });
      } else {
        const entity = subject.gateEntity;
        if (!entity.readScope) { reject(res, 400, 'entity is not queryable'); return true; }
        hub.register({
          id: body.id,
          dependency: {
            entity: entity.name,
            fields: Array.isArray(body.fields) ? body.fields             : [],
            scope: body.scope,
            ...(typeof body.scopeField === 'string' ? { scopeField: body.scopeField } : {}),
          },
          principal: admitted,
          entity: entity                          ,
          db: app.db         ,
          revision,
        });
      }
      sendJson(res, 200, { ok: true, revision });
      return true;
    }
    if (path === '/queries/unregister') {
      if (typeof body.id !== 'string' || body.id.length === 0) { reject(res, 400, 'id is required'); return true; }
      hub.unregister(body.id, admitted);
      sendJson(res, 200, { ok: true, revision });
      return true;
    }
    if (typeof body.id !== 'string' || body.id.length === 0) { reject(res, 400, 'id is required'); return true; }
    const signal = subject.familyName
      ? queryFamilyChangedSince(hub, {
        id: body.id,
        family: (app                                           ).queryFamilies .get(subject.familyName) ,
        principal: admitted,
        sinceRevision: body.sinceRevision          ,
        revision,
      })
      : hub.changedSince({
        id: body.id,
        principal: admitted,
        sinceRevision: body.sinceRevision          ,
        revision,
      });
    sendJson(res, 200, signal);
  } catch (err) {
    if (err instanceof QueryScopedReadError) {
      reject(res, 400, err.message);
      return true;
    }
    throw err;
  }
  return true;
}
