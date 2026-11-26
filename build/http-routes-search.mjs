// Framework-owned FTS / vector / hybrid search routes. Hit admission runs
// through the SAME entity adapter REST uses; unresolvable hits fail closed.


import { collapseForAdmission, anonymous } from './principal.mjs';
import { requireUser } from './route-gate.mjs';
import { rawRow } from './entity/query.mjs';



import { hybridSearch,                           } from './search-plugin.mjs';
import {
  searchStalenessOf,
  searchPageWindow,
  SEARCH_MAX_RESULTS_CAP,
  SEARCH_MAX_WINDOW,
} from './search-response.mjs';

import { sendJson,                       } from './http-response.mjs';
import {


  reject,
  readJsonObjectBody,
  queryAuthorization,
  admitQueryGate,
} from './http-routes-shared.mjs';



function resolveSearchMode(body                         )                    {
  if (body.mode !== undefined) {
    return body.mode === 'fts' || body.mode === 'vector' || body.mode === 'hybrid' ? body.mode : null;
  }
  if (body.sources !== undefined && body.sources !== null && typeof body.sources === 'object') return 'hybrid';
  if (body.vector !== undefined) return 'vector';
  return 'fts';
}

// A vector query object. A `query` object wins verbatim (it may carry model,
// vector, scope, or scopeId); otherwise the flat `vector`/`model` fields form
// the plugin's `{ model, vector }` query shape.
function vectorQueryOf(body                         )                          {
  if (body.query !== undefined && body.query !== null && typeof body.query === 'object' && !Array.isArray(body.query)) {
    return body.query                           ;
  }
  const query                          = {};
  if (body.vector !== undefined) query.vector = body.vector;
  if (body.model !== undefined) query.model = body.model;
  return query;
}

function searchScope(body                         )                          {
  const scope                          = {};
  if (body.scopeId !== undefined) scope.scopeId = body.scopeId;
  if (body.scope !== undefined) scope.scope = body.scope;
  return scope;
}

// The caller's requested page window. The route — not the registry call that
// happens to fetch a batch — owns the final window, because hits are admitted
// here before any slice is disclosed. The registry still owns its own window
// for each batch fetch.
function searchWindow(body                         )                                                      {
  return searchPageWindow({
    ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
    ...(typeof body.offset === 'number' ? { offset: body.offset } : {}),
  });
}

// Resolve the source row a search hit must be re-authorized against. A derived
// plugin hit carries explicit provenance for the CURRENT parent row it was
// admitted against; otherwise the hit came from its source entity directly.
// A fused (hybrid) hit wraps the plugin hit under `hit`, so provenance is read
// from either level.
function searchHitAuthorization(
  app              ,
  hit         ,
  indices                   ,
)                                                                   {
  if (!app.entities) return undefined;
  const outer = hit !== null && typeof hit === 'object' ? hit                            : null;
  if (!outer) return undefined;
  const nested = outer.hit !== null && typeof outer.hit === 'object' ? outer.hit                            : null;

  // Explicit provenance wins and is fail-closed: if it names an entity this
  // app does not know, the hit is not re-labeled with a guessed source.
  for (const record of [outer, nested]) {
    if (!record) continue;
    const entityName = record.authorizationEntity;
    const rowId = searchRowId(record.authorizationRowId);
    if (typeof entityName === 'string' && entityName.length > 0 && rowId !== null) {
      const entity = app.entities.get(entityName);
      return entity ? { entity, id: rowId } : undefined;
    }
  }

  const id = searchHitId(hit);
  if (id === null) return undefined;
  const candidates           = [];
  const explicit = outer.entity;
  if (typeof explicit === 'string') candidates.push(explicit);
  const plugins = (app                                            ).searchPlugins;
  for (const index of indices) {
    const plugin = typeof plugins?.get === 'function' ? plugins.get(index) : undefined;
    const interest = plugin?.sourceInterests?.[0];
    if (interest && typeof interest.entity === 'string') candidates.push(interest.entity);
  }
  for (const name of candidates) {
    const entity = app.entities.get(name);
    if (entity) return { entity, id };
  }
  return undefined;
}

// A hit's source row id. Plugin hits carry `id`; fused (hybrid) hits carry `key`
// and wrap the plugin hit under `hit`.
function searchRowId(value         )                {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

function searchHitId(hit         )                {
  if (!hit || typeof hit !== 'object') return null;
  const record = hit                           ;
  const nested = record.hit && typeof record.hit === 'object' ? record.hit                            : null;
  for (const candidate of [record.id, record.key, nested?.id, nested?.key]) {
    const id = searchRowId(candidate);
    if (id !== null) return id;
  }
  return null;
}

// Per-hit row admission through the SAME entity adapter REST uses. A hit whose
// source entity cannot be resolved, whose row is already gone, or whose id is
// missing is DROPPED — an unverifiable hit is never disclosed. A resolvable row
// goes through the adapter, so an injected denying adapter filters hits like a
// REST list. There is no pass-through branch for an unresolvable hit.
async function admitSearchHitsByEntity(
  app              ,
  authorization                      ,
  hits                    ,
  principal           ,
  indices                   ,
)                     {
  const admitted            = [];
  for (const hit of hits) {
    const source = searchHitAuthorization(app, hit, indices);
    const stored = source !== undefined ? rawRow(app.db, source.entity.name, source.id) : undefined;
    // Fail closed: no source row, no id, or a row that vanished since the
    // index snapshot means this hit cannot be re-authorized. Drop it rather
    // than disclose a stale or plugin-forged row body.
    if (source === undefined || !stored) continue;
    const { entity, id } = source;
    const row = typeof entity.deserializeRow === 'function'
      ? entity.deserializeRow({ ...stored })
      : stored;
    const decision = await authorization.admit({
      category: 'entity',
      verb: 'read',
      principal,
      entity: entity                           ,
      row,
      resourceId: id,
    });
    if (decision.admitted) admitted.push(hit);
  }
  return admitted;
}

// Admit before slicing. Fetch raw-ranked batches from the SAME search
// lifecycle, keep only rows the entity adapter admits, and only then apply the
// caller's offset/limit. A denied top hit therefore cannot shorten the page:
// scanning continues until the authorized page is full or the ranked results
// are exhausted. Each batch is a bounded registry request, so the plugin still
// owns retrieval and the route owns neither a second index nor a second auth
// engine.
async function admittedSearchPage      (
  app              ,
  authorization                      ,
  principal           ,
  indices                   ,
  fetchPage                                                                                                        ,
  window                                                     ,
)                                                                    {
  const target = window.offset + window.limit;
  let batchSize = Math.min(SEARCH_MAX_RESULTS_CAP, Math.max(window.limit, window.limit * 4));
  const admitted            = [];
  let meta              = null;
  let rawOffset = 0;
  while (admitted.length < target && rawOffset < SEARCH_MAX_WINDOW) {
    const batch = Math.min(batchSize, SEARCH_MAX_WINDOW - rawOffset);
    if (batch <= 0) break;
    const page = await fetchPage(rawOffset, batch);
    if (meta === null) meta = page.meta;
    if (page.hits.length === 0) break;
    const admittedBatch = await admitSearchHitsByEntity(app, authorization, page.hits, principal, indices);
    admitted.push(...admittedBatch);
    rawOffset += page.hits.length;
    if (page.hits.length < batch) break;
    // Denials consumed a full batch without filling the page: widen the next
    // batch so a heavily filtered index does not degrade into many tiny scans.
    if (admitted.length < target) batchSize = Math.min(SEARCH_MAX_RESULTS_CAP, batchSize * 2);
  }
  return {
    hits: admitted.slice(window.offset, window.offset + window.limit),
    meta,
  };
}

// POST /search — FTS5, Float32 vector, or hybrid RRF retrieval over the app's
// registered search registry. Fail closed: requireUser admission, unknown index
// → 404, malformed payload → 400. Results carry the registry-derived staleness
// stamp, never a plugin-supplied one.
export async function handleSearchRoute(
  app                                 ,
  req                  ,
  res                  ,
  principal                              ,
)                   {
  if (req.method !== 'POST') return false;
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/search') return false;
  if (!app) { reject(res, 404, 'not found'); return true; }

  const registry = (app                                                                             ).searchRegistry
    ?? (app                                            ).searchPlugins;
  if (!registry || (typeof (registry                  ).search !== 'function' && typeof (registry                  ).hybridSearch !== 'function')) {
    reject(res, 404, 'search is not engaged');
    return true;
  }

  const admitted = collapseForAdmission(principal ?? anonymous);
  const authorization = queryAuthorization(app);
  if (!await admitQueryGate(authorization, requireUser(), admitted)) {
    reject(res, 401, 'unauthorized');
    return true;
  }

  const body = await readJsonObjectBody(req, res);
  if (body === null) return true;

  const mode = resolveSearchMode(body);
  if (mode === null) { reject(res, 400, 'unknown search mode'); return true; }
  const registryHasIndex = (index         )          => {
    if (typeof index !== 'string' || index.length === 0) return false;
    const has = (registry                  ).has;
    return typeof has === 'function' ? has.call(registry, index) : true;
  };

  let window                                                     ;
  try {
    window = searchWindow(body);
  } catch (err) {
    reject(res, 400, err instanceof Error ? err.message : 'invalid search window');
    return true;
  }

  if (mode === 'hybrid') {
    const sources = (body.sources ?? {})                           ;
    const sourceId = (value         )                     => {
      if (typeof value === 'string' && value.length > 0) return value;
      if (value && typeof value === 'object') {
        const record = value                           ;
        if (typeof record.index === 'string') return record.index;
        if (typeof record.pluginId === 'string') return record.pluginId;
      }
      return undefined;
    };
    const ftsIndex = sourceId(sources.fts);
    const vectorIndex = sourceId(sources.vector);
    if (!ftsIndex || !vectorIndex) {
      reject(res, 400, 'hybrid search requires sources.fts and sources.vector');
      return true;
    }
    if (!registryHasIndex(ftsIndex) || !registryHasIndex(vectorIndex)) {
      reject(res, 404, 'unknown search index');
      return true;
    }
    const weights = (body.weights ?? {})                           ;
    const ftsSource = sources.fts                                       ;
    const vectorSource = sources.vector                                       ;
    const ftsQuery = ftsSource?.query ?? body.query;
    const vectorQuery = vectorSource?.query ?? vectorQueryOf(body);
    const shared = {
      principal: admitted,
      fts: {
        pluginId: ftsIndex,
        index: ftsIndex,
        query: ftsQuery,
        ...(weights.fts !== undefined ? { weight: weights.fts } : {}),
      },
      vector: {
        pluginId: vectorIndex,
        index: vectorIndex,
        query: vectorQuery,
        ...(weights.vector !== undefined ? { weight: weights.vector } : {}),
      },
      ...(body.k !== undefined ? { k: body.k } : {}),
      ...searchScope(body),
    };
    try {
      const page = await admittedSearchPage(
        app,
        authorization,
        admitted,
        [ftsIndex, vectorIndex],
        async (offset, limit) => {
          const request = { ...shared, offset, limit };
          const next = typeof (registry                  ).hybridSearch === 'function'
            ? await (registry                  ).hybridSearch (request)
            : await hybridSearch({ registry: registry                        , ...request }         );
          return { hits: next.hits ?? [], meta: next };
        },
        window,
      );
      const result = page.meta;
      if (result === null) {
        reject(res, 400, 'hybrid search did not return a result');
        return true;
      }
      sendJson(res, 200, {
        ok: result.ok,
        mode: 'hybrid',
        staleness: result.staleness,
        hits: page.hits,
        totalCandidates: result.totalCandidates,
        k: result.k,
        cancelled: result.cancelled === true,
        timedOut: result.timedOut === true,
      });
    } catch (err) {
      reject(res, 400, err instanceof Error ? err.message : 'invalid hybrid search request');
      return true;
    }
    return true;
  }

  const index = body.index;
  if (typeof index !== 'string' || index.length === 0) {
    reject(res, 400, 'index is required');
    return true;
  }
  if (!registryHasIndex(index)) { reject(res, 404, 'unknown search index'); return true; }

  const request = {
    query: mode === 'vector' ? vectorQueryOf(body) : body.query,
    principal: admitted,
    ...searchScope(body),
  };
  try {
    const page = await admittedSearchPage(
      app,
      authorization,
      admitted,
      [index],
      async (offset, limit) => {
        const outcome = await (registry                  ).search(index, { ...request, offset, limit });
        return { hits: outcome.result?.hits ?? [], meta: outcome };
      },
      window,
    );
    const outcome = page.meta;
    if (outcome === null) {
      reject(res, 400, 'search did not return a result');
      return true;
    }
    if (!outcome.ok && !outcome.cancelled && !outcome.timedOut && outcome.lastError) {
      reject(res, 400, outcome.lastError.message ?? 'invalid search request');
      return true;
    }
    sendJson(res, 200, {
      ok: outcome.ok,
      mode,
      index,
      generation: outcome.generation,
      staleness: searchStalenessOf(outcome.state),
      hits: page.hits,
      cancelled: outcome.cancelled === true,
      timedOut: outcome.timedOut === true,
      ...(outcome.lastError ? { error: outcome.lastError.message } : {}),
    });
  } catch (err) {
    reject(res, 400, err instanceof Error ? err.message : 'invalid search request');
    return true;
  }
  return true;
}
