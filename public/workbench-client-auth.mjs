// workbench-client-auth.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { WorkbenchFailureError, clientFailure, decodeResult } from './workbench-client-errors.mjs';

// ---------------------------------------------------------------------------
// createAuthClient — register/login/logout against the framework's `/auth` battery.
// ---------------------------------------------------------------------------
//
// Thin fetch wrappers over `/auth/register`, `/auth/login`, and `/auth/logout` with
// `credentials: 'include'` so the browser sends and stores the fail-closed
// `sid` cookie the server sets on registration or login. The token lives in the cookie, never
// client JS (HttpOnly), so the client never holds a credential it can leak.
// Independent of the live-store machinery — a page may auth before subscribing.
// `login` returns the parsed JSON body (`{ user: { id, username } }`); both
// throw on a non-2xx response with the server's error message.
export function createAuthClient({ baseUrl, fetchImpl } = {}) {
  const fetchFn = fetchImpl ?? globalThis.fetch;

  async function authenticate(intent, username, password) {
    const res = await fetchFn(`${baseUrl}/auth/${intent}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const decoded = await decodeResult(res);
    if (!decoded.ok) throw new Error(decoded.failure?.message ?? decoded.error);
    return decoded.value;
  }

  function register(username, password) {
    return authenticate('register', username, password);
  }

  function login(username, password) {
    return authenticate('login', username, password);
  }

  async function logout() {
    const res = await fetchFn(`${baseUrl}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
    const decoded = await decodeResult(res);
    if (!decoded.ok) throw new Error(decoded.failure?.message ?? decoded.error);
    // logout responds 204 with no body; return a plain ok marker for callers.
    return { ok: true };
  }

  return { register, login, logout };
}
// ---------------------------------------------------------------------------
// createQueryClient — authorized query-family and search HTTP calls (#312).
// ---------------------------------------------------------------------------
//
// Thin fetch wrappers over the framework's three query/search endpoints:
//
//   POST /query/:entity         → queryEntity(entity, request, opts?)
//   POST /query-families/:name  → queryFamily(name, request, opts?)
//   POST /search                → search(request, opts?)
//
// Every response is decoded with the shared `decodeResult` (HTTP status is
// authoritative). A non-2xx canonical envelope throws a `WorkbenchFailureError`
// carrying the stable failure; a non-canonical error throws a plain Error. The
// success value is the server body: a query page for the family/entity calls,
// a hits + staleness response for search. `credentials: 'include'` sends the
// fail-closed session cookie, exactly like the CRUD store.
export function createQueryClient({ baseUrl, fetchImpl, cacheSize, maxHeldRevisions } = {}) {
  const fetchFn = fetchImpl ?? globalThis.fetch;
  const maxCachedPages = Number.isSafeInteger(cacheSize) && cacheSize > 0 ? cacheSize : 32;
  // Revision fences are kept per queryIdentity. Without a bound a long-lived
  // session accumulates one entry per distinct request forever; the LRU below
  // gives each entry a recent-use signal and caps the map.
  const maxHeldRevisionCount = Number.isSafeInteger(maxHeldRevisions) && maxHeldRevisions > 0
    ? maxHeldRevisions
    : (Number.isSafeInteger(cacheSize) && cacheSize > 0 ? cacheSize : 256);
  // Bounded LRU of executed pages. Query calls still FETCH (the existing
  // contract); the cache is an explicit read surface for consumers that want a
  // last-known page, plus the target of an invalidation-triggered refetch.
  const pageCache = new Map();
  const inFlight = new Map();
  const heldRevisions = new Map();
  const invalidationTargets = new Map();

  async function post(path, request, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) };
    const res = await fetchFn(`${baseUrl}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(request ?? {}),
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    });
    const decoded = await decodeResult(res);
    if (!decoded.ok) {
      if (decoded.failure) throw new WorkbenchFailureError(decoded.failure);
      throw new Error(decoded.error);
    }
    return decoded.value;
  }

  function pageKey(kind, name, request) {
    return JSON.stringify([kind, name, request ?? {}]);
  }

  /** Read a held revision and mark it recently used without changing its value. */
  function touchHeldRevision(identity) {
    const held = heldRevisions.get(identity);
    if (held !== undefined) {
      heldRevisions.delete(identity);
      heldRevisions.set(identity, held);
    }
    return held;
  }

  /** Write the high-water revision, evicting the least-recently-used identity. */
  function rememberHeldRevision(identity, revision) {
    heldRevisions.delete(identity);
    heldRevisions.set(identity, revision);
    while (heldRevisions.size > maxHeldRevisionCount) {
      heldRevisions.delete(heldRevisions.keys().next().value);
    }
  }

  function acceptQueryPage(page) {
    if (!page || !Number.isSafeInteger(page.revision) || typeof page.queryIdentity !== 'string') {
      throw new WorkbenchFailureError(clientFailure('invalid-input', 'query page is missing a revision token or identity'));
    }
    const held = touchHeldRevision(page.queryIdentity);
    return held !== undefined && page.revision < held ? 'reject-stale' : 'accept';
  }

  function rememberPage(key, kind, name, request, page, invalidationId) {
    pageCache.delete(key);
    pageCache.set(key, { kind, name, request, page, invalidationId });
    while (pageCache.size > maxCachedPages) pageCache.delete(pageCache.keys().next().value);
    if (typeof invalidationId === 'string' && invalidationId.length > 0) {
      let keys = invalidationTargets.get(invalidationId);
      if (!keys) { keys = new Set(); invalidationTargets.set(invalidationId, keys); }
      keys.add(key);
    }
  }

  function fetchPage(kind, name, request, opts) {
    const key = pageKey(kind, name, request);
    const pending = inFlight.get(key);
    // In-flight dedup: two consumers asking for the same page (including a
    // polling refetch racing a caller) share ONE HTTP request.
    if (pending) return pending;
    const path = kind === 'entity'
      ? `/query/${encodeURIComponent(name)}`
      : `/query-families/${encodeURIComponent(name)}`;
    const promise = (async () => {
      const page = await post(path, request, opts);
      if (!page || !Array.isArray(page.rows) || typeof page.queryIdentity !== 'string') {
        throw new WorkbenchFailureError(clientFailure('internal', 'query endpoint returned an invalid page'));
      }
      if (acceptQueryPage(page) === 'reject-stale') {
        throw new WorkbenchFailureError(clientFailure('conflict', 'stale query page'));
      }
      const held = touchHeldRevision(page.queryIdentity);
      if (held === undefined || page.revision > held) rememberHeldRevision(page.queryIdentity, page.revision);
      rememberPage(key, kind, name, request, page, opts?.invalidationId);
      return page;
    })();
    inFlight.set(key, promise);
    promise.then(
      () => { if (inFlight.get(key) === promise) inFlight.delete(key); },
      () => { if (inFlight.get(key) === promise) inFlight.delete(key); },
    );
    return promise;
  }

  function invalidationBody(input = {}) {
    return {
      id: input.id,
      ...(input.entity !== undefined ? { entity: input.entity } : {}),
      ...(input.family !== undefined ? { family: input.family } : {}),
      ...(input.sinceRevision !== undefined ? { sinceRevision: input.sinceRevision } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.fields !== undefined ? { fields: input.fields } : {}),
      ...(input.scopeField !== undefined ? { scopeField: input.scopeField } : {}),
    };
  }

  async function refreshCachedQueryPages(invalidationId) {
    const keys = invalidationId === undefined
      ? [...pageCache.keys()]
      : [...(invalidationTargets.get(invalidationId) ?? [])];
    const refreshed = [];
    for (const key of keys) {
      const entry = pageCache.get(key);
      if (!entry) continue;
      refreshed.push(await fetchPage(entry.kind, entry.name, entry.request, { invalidationId: entry.invalidationId }));
    }
    return refreshed;
  }

  return {
    queryEntity(entity, request, opts) {
      return fetchPage('entity', entity, request, opts);
    },
    queryFamily(name, request, opts) {
      return fetchPage('family', name, request, opts);
    },
    search(request, opts) {
      return post('/search', request, opts);
    },
    acceptQueryPage,
    getCachedQueryPage(kind, name, request) {
      return pageCache.get(pageKey(kind, name, request))?.page;
    },
    clearQueryCache() {
      pageCache.clear();
      invalidationTargets.clear();
    },
    refreshCachedQueryPages,
    registerQueryInvalidation(input, opts) {
      return post('/queries/register', invalidationBody(input), opts);
    },
    changedSince(input, opts) {
      return post('/queries/changed-since', invalidationBody(input), opts);
    },
    unregisterQueryInvalidation(input, opts) {
      return post('/queries/unregister', { id: input?.id }, opts);
    },
    // Polling is opt-in and bounded by one timer. A changed/resync signal
    // refetches the affected cached pages through the SAME deduped fetch path;
    // existing queryEntity/queryFamily callers are untouched.
    watchQueryInvalidation(options = {}) {
      const { id, entity, family, intervalMs = 2000, onChanged, onError, signal } = options;
      let sinceRevision = options.sinceRevision;
      let stopped = false;
      let timer = null;
      const tick = async () => {
        if (stopped || signal?.aborted) return;
        try {
          const result = await post('/queries/changed-since', invalidationBody({ id, entity, family, sinceRevision }));
          if (Number.isSafeInteger(result?.revision)) sinceRevision = result.revision;
          if (result?.kind === 'changed' || result?.kind === 'resync') {
            const pages = await refreshCachedQueryPages(id);
            if (typeof onChanged === 'function') await onChanged(result, pages);
          }
        } catch (error) {
          if (typeof onError === 'function') onError(error);
        } finally {
          if (!stopped && !signal?.aborted) timer = setTimeout(tick, intervalMs);
        }
      };
      timer = setTimeout(tick, 0);
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (timer !== null) clearTimeout(timer);
      };
      if (signal) signal.addEventListener('abort', stop, { once: true });
      return stop;
    },
  };
}
