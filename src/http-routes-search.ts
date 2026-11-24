// Framework-owned FTS / vector / hybrid search routes. Hit admission runs
// through the SAME entity adapter REST uses; unresolvable hits fail closed.

import type { Principal } from './principal.ts';
import { collapseForAdmission, anonymous } from './principal.ts';
import { requireUser } from './route-gate.ts';
import { rawRow } from './entity/query.ts';
import type { CrudEntity } from './http-crud-dispatch.ts';
import type { EntityRecord } from './row-grant.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import { hybridSearch, type SearchPluginRegistry } from './search-plugin.ts';
import { searchStalenessOf } from './search-response.ts';
import type { SearchRegistry } from './app.ts';
import { sendJson, type HttpResponseLike } from './http-response.ts';
import {
  type FrameworkApp,
  type FrameworkRequest,
  reject,
  readJsonObjectBody,
  queryAuthorization,
  admitQueryGate,
} from './http-routes-shared.ts';

type SearchMode = 'fts' | 'vector' | 'hybrid';

function resolveSearchMode(body: Record<string, unknown>): SearchMode | null {
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
function vectorQueryOf(body: Record<string, unknown>): Record<string, unknown> {
  if (body.query !== undefined && body.query !== null && typeof body.query === 'object' && !Array.isArray(body.query)) {
    return body.query as Record<string, unknown>;
  }
  const query: Record<string, unknown> = {};
  if (body.vector !== undefined) query.vector = body.vector;
  if (body.model !== undefined) query.model = body.model;
  return query;
}

function searchScope(body: Record<string, unknown>): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  if (body.limit !== undefined) scope.limit = body.limit;
  if (body.scopeId !== undefined) scope.scopeId = body.scopeId;
  if (body.scope !== undefined) scope.scope = body.scope;
  return scope;
}

// Resolve the source entity a search hit came from. Framework plugins disclose
// it through their registered source interests; a hit may also carry an explicit
// `entity`. A custom registry disclosing neither has no entity row to re-check —
// its plugin-owned search admission already ran, so nothing is added here.
function searchHitSourceEntity(app: FrameworkApp, hit: unknown, indices: readonly string[]): CrudEntity | undefined {
  if (!app.entities) return undefined;
  const explicit = (hit as { entity?: unknown } | null)?.entity;
  const candidates: string[] = [];
  if (typeof explicit === 'string') candidates.push(explicit);
  const plugins = (app as { searchPlugins?: SearchPluginRegistry }).searchPlugins;
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
function searchHitId(hit: unknown): string | null {
  if (!hit || typeof hit !== 'object') return null;
  const record = hit as Record<string, unknown>;
  const nested = record.hit && typeof record.hit === 'object' ? record.hit as Record<string, unknown> : null;
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
  app: FrameworkApp,
  authorization: AuthorizationAdapter,
  hits: readonly unknown[],
  principal: Principal,
  indices: readonly string[],
): Promise<unknown[]> {
  const admitted: unknown[] = [];
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
      entity: entity as unknown as EntityRecord,
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
  app: FrameworkApp | null | undefined,
  req: FrameworkRequest,
  res: HttpResponseLike,
  principal: Principal | null | undefined,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/search') return false;
  if (!app) { reject(res, 404, 'not found'); return true; }

  const registry = (app as { searchRegistry?: SearchRegistry; searchPlugins?: SearchPluginRegistry }).searchRegistry
    ?? (app as { searchPlugins?: SearchPluginRegistry }).searchPlugins;
  if (!registry || (typeof (registry as SearchRegistry).search !== 'function' && typeof (registry as SearchRegistry).hybridSearch !== 'function')) {
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
  const registryHasIndex = (index: unknown): boolean => {
    if (typeof index !== 'string' || index.length === 0) return false;
    const has = (registry as SearchRegistry).has;
    return typeof has === 'function' ? has.call(registry, index) : true;
  };

  if (mode === 'hybrid') {
    const sources = (body.sources ?? {}) as Record<string, unknown>;
    const sourceId = (value: unknown): string | undefined => {
      if (typeof value === 'string' && value.length > 0) return value;
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
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
    const weights = (body.weights ?? {}) as Record<string, unknown>;
    const ftsSource = sources.fts as Record<string, unknown> | undefined;
    const vectorSource = sources.vector as Record<string, unknown> | undefined;
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
      const result = typeof (registry as SearchRegistry).hybridSearch === 'function'
        ? await (registry as SearchRegistry).hybridSearch!(shared)
        : await hybridSearch({ registry: registry as SearchPluginRegistry, ...shared } as never);
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
    const outcome = await (registry as SearchRegistry).search(index, request);
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
