// Framework-owned FTS / vector / hybrid search routes. Hit admission runs
// through the SAME entity adapter REST uses; unresolvable hits fail closed.


import { collapseForAdmission, anonymous } from './principal.mjs';
import { requireUser } from './route-gate.mjs';
import { rawRow } from './entity/query.mjs';



import { hybridSearch,                           } from './search-plugin.mjs';
import { searchStalenessOf } from './search-response.mjs';

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
  if (body.limit !== undefined) scope.limit = body.limit;
  if (body.scopeId !== undefined) scope.scopeId = body.scopeId;
  if (body.scope !== undefined) scope.scope = body.scope;
  return scope;
}

// Resolve the source entity a search hit came from. Framework plugins disclose
// it through their registered source interests; a hit may also carry an explicit
// `entity`. A custom registry disclosing neither has no entity row to re-check —
// its plugin-owned search admission already ran, so nothing is added here.
function searchHitSourceEntity(app              , hit         , indices                   )                         {
  if (!app.entities) return undefined;
  const explicit = (hit                               )?.entity;
  const candidates           = [];
  if (typeof explicit === 'string') candidates.push(explicit);
  const plugins = (app                                            ).searchPlugins;
  for (const index of indices) {
    const plugin = typeof plugins?.get === 'function' ? plugins.get(index) : undefined;
    const interest = plugin?.sourceInterests?.[0];
    if (interest && typeof interest.entity === 'string') candidates.push(interest.entity);
  }
  for (const name of candidates) {
    const entity = app.entities.get(name);
    if (entity) return entity;
  }
  return undefined;
}

// A hit's source row id. Plugin hits carry `id`; fused (hybrid) hits carry `key`
// and wrap the plugin hit under `hit`. Either identifies the current source row.
function searchHitId(hit         )                {
  if (!hit || typeof hit !== 'object') return null;
  const record = hit                           ;
  const nested = record.hit && typeof record.hit === 'object' ? record.hit                            : null;
  for (const candidate of [record.id, record.key, nested?.id, nested?.key]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return String(candidate);
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
    const entity = searchHitSourceEntity(app, hit, indices);
    const id = searchHitId(hit);
    const stored = entity && id !== null ? rawRow(app.db, entity.name, id) : undefined;
    // Fail closed: no source entity, no id, or a row that vanished since the
    // index snapshot means this hit cannot be re-authorized. Drop it rather
    // than disclose a stale or plugin-forged row body.
    if (!entity || id === null || !stored) continue;
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
      const result = typeof (registry                  ).hybridSearch === 'function'
        ? await (registry                  ).hybridSearch (shared)
        : await hybridSearch({ registry: registry                        , ...shared }         );
      const hits = await admitSearchHitsByEntity(app, authorization, result.hits ?? [], admitted, [ftsIndex, vectorIndex]);
      sendJson(res, 200, {
        ok: result.ok,
        mode: 'hybrid',
        staleness: result.staleness,
        hits,
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
    const outcome = await (registry                  ).search(index, request);
    if (!outcome.ok && !outcome.cancelled && !outcome.timedOut && outcome.lastError) {
      reject(res, 400, outcome.lastError.message ?? 'invalid search request');
      return true;
    }
    const hits = await admitSearchHitsByEntity(app, authorization, outcome.result?.hits ?? [], admitted, [index]);
    sendJson(res, 200, {
      ok: outcome.ok,
      mode,
      index,
      generation: outcome.generation,
      staleness: searchStalenessOf(outcome.state),
      hits,
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
