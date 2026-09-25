// The HTTP transport — Phase 2, slice 1 (SPEC §3, §4).
//
// Phase 1 resolved a declared app into an inspectable routing table (a list of
// { method, path, verb, entity, gate }). This module turns that table into a
// running node:http server. It is a DISTINCT seam from the resolution layer
// (app.mjs): the table is built at mount time and is the single source of routes;
// this module only serves it. There is no second routing path.
//
// The request flow, fail-closed at each step:
//   1. derive the principal (default: anonymous, until session hydration lands)
//   2. two-valued admission collapse (S5/A1): a non-'active' principal is
//      treated as anonymous BEFORE anything below sees it — a revoked and an
//      unauthenticated caller are indistinguishable, and the real status rides
//      only on the pre-collapse principal for statusOf() (the audit reader)
//   3. match { method, url } to a route in the table — no match → 404
//   4. run the route's gate(principal) — the first default-on auth layer — and
//      deny with 401 when it returns false
//   5. dispatch the admitted request (slice 1: a stub echoing the matched verb;
//      DB-backed CRUD is the next slice)
//
// The row grant (the SQL scope + .can) still runs downstream in dispatch on every
// admitted verb — this layer decides route admission, never row visibility. No
// second auth path.

import { createServer as createHttpServer } from 'node:http';

import { anonymous, collapseForAdmission,                } from './principal.mjs';
import { mayVerb } from './row-grant.mjs';
import { createAuthorizationAdapter,                           } from './authorization-adapter.mjs';
import { config } from './config.mjs';
import { applySecurityHeaders, renderError, isSameOriginRequest } from './middleware.mjs';
import { sessionPrincipalOf, sessionTokenOf, apiKeyPrincipalOf } from './auth/session.mjs';
import { createWebSocketLiveDelivery } from './live-delivery.mjs';
import { getLog, withLog } from './log.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { BodyError, readRequestBody } from './http-body.mjs';
import { runChain } from './http-handler-chain.mjs';
import { matchRoute } from './http-route-match.mjs';
import { committedEventHeaders, responseHasStarted, warnLateResponse, sendJson } from './http-response.mjs';
import { createResponseFacade } from './http-response-factory.mjs';
import { dispatchCrud } from './http-crud-dispatch.mjs';
import { failure } from './outcome.mjs';
import { sendFailure,               } from './http-failure.mjs';
import { handleResyncRoute, handleBlobUploadRoute, handleJobRoute, handleClientSdkRoute } from './http-framework-routes.mjs';
import { handleApplicationActionHttp } from './application-action-http.mjs';

// sendJson's strict Http response param is wider than the transport's loose
// `SendJson` contract (res: unknown); this alias carries it across seams.
const sendJsonCompat           = sendJson       ;

// Framework-owned snapshot + resync endpoints (spec #1, D6/D7). NOT mounted
// `makeHandlerRes(nodeRes, onEnd)` wraps a node response in the Express-style
// facade the `app.use(prefix, fn)` intercept hands to a mounted handler (shared
// methods from http-response-factory.mjs + a serve-specific `.stream()`).
// `onEnd` flips the intercept's handled flag so a handler that ended the
// response short-circuits the dispatch and one that did not write falls through
// to the next handler.
function makeHandlerRes(nodeRes     , onEnd     ) {
  const res      = createResponseFacade(nodeRes, { onEnd });

  // serve-specific: stream pipes a Web Response (or a bare ReadableStream) to
  // the Node response and calls onEnd() so the intercept short-circuits.
  res.stream = async function (webResponse     , options      = {}) {
    const source = webResponse instanceof ReadableStream
      ? new Response(webResponse)
      : webResponse;
    const headers = Object.fromEntries(source.headers);
    if (options.buffering === false) {
      headers['X-Accel-Buffering'] = 'no';
    }
    nodeRes.writeHead(source.status, headers);
    if (source.body) {
      const reader = source.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        nodeRes.write(value);
      }
    }
    nodeRes.end();
    onEnd();
    return this;
  };

  return res;
}

// Framework-owned routes — handleResyncRoute, handleBlobUploadRoute, handleJobRoute
// — live in http-framework-routes.mjs and are imported above.
// The standard stateless CSRF guard (eng-review §8 Tier-2 ops bundle, #13). A
// state-MUTATING request (anything but a safe method) carrying a FOREIGN Origin
// or Referer is rejected; the browser always sends a foreign Origin on a
// cross-site POST (the real forgery vector). A mutation with NO Origin/Referer
// is allowed — Node fetch and curl omit these by default, so a fail-closed
// "missing → reject" would block every non-browser API client. Same-origin
// (the header's host:port equals the request Host) passes. This is a COMPUTED
// decision (AGENTS.md → Authorization: always functions), not a magic-word
// check; it runs before the route gate so a forged mutation never reaches it.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Returns true when the mutation is allowed, false when it is foreign (→ 403).
// Safe methods carry no state change; the same-origin verdict (shared with the
// WS upgrade handshake, middleware.mjs) gates every other method.
const csrfGuard = (req     ) => SAFE_METHODS.has(req.method) || isSameOriginRequest(req);

// Build the node:http request handler that serves a routing table. `principalOf`
// derives the request's principal; it defaults to a function returning anonymous
// so an unconfigured server is fail-closed (the default-on route gate denies
// every anonymous request). When an app has a db, `listen` supplies session
// hydration as the principal source (sessionPrincipalOf) — the SAME admission
// path, not a second one. `db` is the app-level node:sqlite handle the
// dispatcher runs against.
//
// This default is the ONE `principalOf` injection point for a custom principal
// resolver; the request handler is deliberately not re-architected here.
const anonymousPrincipalOf                  = () => anonymous;

export function makeRequestHandler(source     , { principalOf = anonymousPrincipalOf, db, env = config.env, rateLimiter = null, csp, hsts, cors, requestLog = false, authorization }









  = {}) {
  // `source` is either a plain resolved routing table (an array) or an app whose
  // table resolves asynchronously (two-phase boot). When it is an app, every
  // request first awaits `app.ready` so the socket may accept connections before
  // resolution completes without ever dispatching against a partial table.
  const isApp = source && typeof source.resolveRoutes === 'function';
  // Two-valued admission (S5/A1): the principal that enters admission is
  // collapsed to anonymous unless 'active' — ONE seam at the boundary, so the
  // gate AND every downstream layer (the row grant in dispatch, the handler
  // chain, the resync/blob/action routes) see a non-active status principal
  // exactly as anonymous. A revoked and an unauthenticated caller are
  // indistinguishable to admission; the real status stays on the pre-collapse
  // principal for statusOf() — the audit reader.
  const principalOfAdmitted = (req     ) => collapseForAdmission(principalOf(req));
  // The registered-action transport resolves the principal with a demo-only
  // `viewAs` hint; the same collapse applies to whatever resolver it derives.
  const actionPrincipalOf = (req     , hint         ) =>
    collapseForAdmission((principalOf                                           )(req, hint));
  // Request log (opt-in via `listen(port, {requestLog:true})`). The structured
  // logger also captures every request at info-level on the 'http' channel.
  const shouldLogRequest = requestLog;
  const log = (isApp && source.log) ? source.log : getLog();
  const requestCount = { count: 0 };

  // The authorization adapter (S5/A2) — THE admission path for this transport.
  // An injected adapter (listen({ authorization })) swaps the policy engine;
  // the framework default wraps the row-grant so behavior is unchanged. The
  // route gate AND the REST CRUD dispatch below both consult this one adapter.
  const authorizationAdapter                       = authorization ?? createAuthorizationAdapter();

  // The operation category label a route-gate admission carries (informational
  // metadata on the decision; the per-verb gate function is the authority).
  // fieldApply is an update under the hood; an imperative route has no verb,
  // so its HTTP method names the closest category.
  function routeOperationLabel(route     )         {
    if (route.verb && route.verb !== 'fieldApply') return route.verb;
    if (route.verb === 'fieldApply') return 'update';
    switch (route.method) {
      case 'GET': return 'read';
      case 'POST': return 'create';
      case 'PATCH': return 'update';
      case 'DELETE': return 'remove';
      default: return 'read';
    }
  }

  // Handles the default route matching + dispatch after the handler chain.
  async function handleRouteMatch(req     , res     , routes     , url     ) {
    const { route, params, pathMatched } = matchRoute(routes, req.method, url.pathname)       ;

    // no path match → 404; path matched but method did not → 405.
    if (!route) {
      if (pathMatched) {
        sendFailure(sendJsonCompat, res, failure('invalid-input', 'method not allowed'), { status: 405 });
      } else {
        sendFailure(sendJsonCompat, res, failure('not-found', 'not found'));
      }
      return;
    }

    // the first default-on auth layer: the route gate decides admission. The
    // two-valued admission collapse already happened at the boundary
    // (principalOfAdmitted), so a non-active status principal arrives here as
    // anonymous — denied by the gate exactly like an unauthenticated caller,
    // and never passed to dispatch with its real status. The gate runs through
    // the authorization adapter (the injected one when provided, else the
    // framework default), so an app policy adapter can override route admission.
    const principal = principalOfAdmitted(req);
    const gateDecision = await authorizationAdapter.admit({
      category: 'principal',
      operation: routeOperationLabel(route),
      principal,
      gate: route.gate,
    });
    if (!gateDecision.admitted) {
      sendFailure(sendJsonCompat, res, failure('denied', 'unauthorized'), { status: 401 });
      return;
    }

    // read a body for mutating entity verbs and every imperative route. Entity
    // CRUD stays JSON-only; handlers may accept browser form posts.
    let body      = {};
    if (route.handlers || route.verb === 'create' || route.verb === 'update' || route.verb === 'fieldApply') {
      try {
        body = await readRequestBody(req, { jsonOnly: !route.handlers });
      } catch (err) {
        // a refused body carries its own status (413 oversized, 400 malformed).
        if (err instanceof BodyError) {
          return void sendFailure(
            sendJsonCompat,
            res,
            failure('invalid-input', err.message),
            { status: err.status },
          );
        }
        throw err;
      }
    }

    // admitted. One spine, one legitimate fork at the tail: a route carrying a
    // handler chain runs the chain; an entity route runs DB-backed CRUD (where
    // the second default-on auth layer, the row grant, applies). This is NOT a
    // second auth path — the chain inherits the already-admitted principal and
    // never re-gates.
    if (route.handlers) {
      await runChain(route.handlers, req, res, { principal, params, body, query: url.searchParams, autoLoad: route.autoLoad, app: source, authorization: authorizationAdapter }, { env });
    } else {
      await dispatchCrud({ entity: route.entity, verb: route.verb, fieldName: route.fieldName, db, principal, params, body, actionId: req.headers['x-workbench-action-id'], app: isApp ? source : null, res, sendJson: sendJsonCompat, committedEventHeaders, authorization: authorizationAdapter }       );
    }
  }

  // The ordered chain is stable for the lifetime of this server. Keep its
  // match/handle functions out of the request path; request-local values are
  // passed explicitly when the chain runs below.
  const handlers = [
    // /health — PUBLIC, anonymous, no auth (piece 1)
    {
      match: (req     , url     ) => isApp && req.method === 'GET' && url.pathname === '/health',
      handle: (_req     , res     ) => { sendJson(res, 200, { status: 'ok', env }); return true; },
    },
    // /health/stats — includes uptime, RSS, request count
    {
      match: (req     , url     ) => isApp && req.method === 'GET' && url.pathname === '/health/stats',
      handle: (_req     , res     ) => {
        sendJson(res, 200, {
          status: 'ok',
          env,
          uptimeMs: Math.round(process.uptime() * 1000),
          rssBytes: process.memoryUsage().rss,
          requestCount: requestCount.count,
        });
        return true;
      },
    },
    // CORS preflight (piece 4 — opt-in): OPTIONS with allowed origin → 204
    {
      match: (req     , _url     ) => isApp && req.method === 'OPTIONS' && cors && cors.origins && Array.isArray(cors.origins),
      handle: (req     , res     ) => {
        const origin = req.headers.origin;
        if (origin && cors.origins.includes(origin)) {
          res.setHeader('access-control-allow-origin', origin);
          res.setHeader('vary', 'Origin');
          res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
          res.setHeader('access-control-allow-headers', 'content-type');
          res.writeHead(204);
          res.end();
          return true;
        }
        return false;
      },
    },
    // Browser SDK: GET /workbench.mjs (intercepts before matchRoute)
    {
      match: (req     , _url     ) => isApp && req.method === 'GET',
      handle: async (req     , res     ) => {
        const handled = await handleClientSdkRoute(source, req, res);
        return handled || responseHasStarted(res);
      },
    },
    // Snapshot + resync: /snapshot/:entity/:id, /events-since/:entity/:id (spec #1, D6/D7)
    {
      match: (req     , _url     ) => isApp && req.method === 'GET',
      handle: async (req     , res     ) => {
        const handled = await handleResyncRoute(source, req, res, principalOfAdmitted(req));
        return handled || responseHasStarted(res);
      },
    },
    // Blob upload: POST /blobs (spec #2)
    {
      match: (req     , _url     ) => isApp && req.method === 'POST',
      handle: async (req     , res     ) => {
        const handled = await handleBlobUploadRoute(source, req, res, principalOfAdmitted(req));
        return handled || responseHasStarted(res);
      },
    },
    // Job-queue endpoints: /workers/register, /jobs/* (spec #5)
    {
      match: (req     , _url     ) => isApp && req.method === 'POST' && source.jobs,
      handle: async (req     , res     ) => {
        const handled = await handleJobRoute(source, req, res);
        return handled || responseHasStarted(res);
      },
    },
    // Generic registered-action transport. This is intentionally before
    // application handlers so entity mutation authority stays in the
    // package-owned registered-action kernel.
    {
      match: (_req     , _url     ) => isApp,
      handle: async (req     , res     ) => handleApplicationActionHttp(source, req, res, actionPrincipalOf, sendJsonCompat),
    },
    // Application-integrated SSE delivery is package-owned: this mounted
    // handler has no access to raw log rows or action callbacks.
    {
      match: (_req     , _url     ) => isApp && Boolean(source._applicationLiveDelivery),
      handle: async (req     , res     ) => {
        const handled = await source._applicationLiveDelivery.handler(req, res);
        return handled || responseHasStarted(res);
      },
    },
    // App-declared prefix-intercept handlers — app.use(prefix, fn)
    {
      match: (_req     , _url     ) => isApp && source._handlers?.length,
      handle: async (req     , res     , url     ) => {
        for (const { prefix, fn } of source._handlers) {
          if (prefix !== '/' && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) continue;
          const rest = url.pathname.slice(prefix.length) || '/';
          const ctxReq = {
            body: undefined,
            params: { path: rest.replace(/^\//, '') },
            query: Object.fromEntries(url.searchParams),
            principal: principalOfAdmitted(req),
            raw: req,
            headers: req.headers,
            method: req.method,
            url: req.url,
          };
          let handled = false;
          const ctxRes = makeHandlerRes(res, () => { handled = true; });
          try {
            await fn(ctxReq, ctxRes, () => {});
          } catch (err) {
            renderError(res, err, { env });
            return true;
          }
          if (handled || responseHasStarted(res)) return true;
        }
        return false;
      },
    },
  ];

  async function handle(req     , res     ) {
    const startTime = Date.now();
    if (isApp) requestCount.count += 1;
    if (shouldLogRequest) {
      let statusCode = 200;
      const origWriteHead = res.writeHead;
      res.writeHead = function patchedWriteHead(code     , ...args       ) {
        statusCode = code;
        return origWriteHead.apply(this, [code, ...args]);
      };
      res.on('finish', () => {
        const path = new URL(req.url, 'http://localhost').pathname;
        const durationMs = Date.now() - startTime;
        if (shouldLogRequest) {
          process.stderr.write(`${req.method} ${path} ${statusCode} ${durationMs}ms\n`);
        }
        log.info('http', `${req.method} ${path} ${statusCode}`, { method: req.method, path, status: statusCode, durationMs });
      });
    }
    // Security headers are a baked-in default on EVERY response, set before any
    // exit path writes its head (SPEC §3). They are retained through writeHead.
    applySecurityHeaders(res);
    // CSP / HSTS / CORS policy headers (piece 4 — opt-in, default off)
    if (csp) res.setHeader('content-security-policy', csp);
    if (hsts) res.setHeader('strict-transport-security', 'max-age=31536000');
    // CORS: check Origin and set headers if configured (allowlist over denylist)
    const origin = req.headers.origin;
    if (cors && cors.origins && Array.isArray(cors.origins) && origin) {
      if (cors.origins.includes(origin)) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('access-control-expose-headers', 'x-workbench-seq, x-workbench-action-id');
        res.setHeader('vary', 'Origin');
      }
    }
    try {
      if (isApp) await source.ready;
      const routes = isApp ? source.routes : source;

      // Rate-limit (opt-in via `listen(port, {rateLimit:{...}})`) runs first in
      // the ops stack (eng-review line 213: rateLimit → csrfOrigin). A flood is
      // rejected cheaply here — before CSRF, the route gate, or any write lock —
      // so a denial-of-service attempt never reaches the kernel (the writeQueue
      // is never held by a request that will be refused). Per-IP fixed window; a
      // session window, when configured, additionally caps a logged-in browser
      // (stricter wins). The session key is the opaque `sid` cookie token — read
      // cheaply with no DB lookup, before principal hydration; the IP gate is the
      // non-spoofable base that holds when no cookie is present.
      if (rateLimiter) {
        const r = rateLimiter.check({ ip: req.socket?.remoteAddress, sessionId: sessionTokenOf(req) });
        if (!r.allowed) {
          res.setHeader('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
          sendFailure(
            sendJsonCompat,
            res,
            failure('conflict', 'rate limit exceeded', { retryAfterMs: r.retryAfterMs }),
            { status: 429 },
          );
          return;
        }
      }

      // CSRF origin guard (eng-review #13) — a foreign-origin mutation is
      // rejected before it reaches the route gate or any state change. Bare
      // non-browser requests (no Origin/Referer — Node fetch, curl) pass.
      if (isApp && !csrfGuard(req)) {
        sendFailure(sendJsonCompat, res, failure('denied', 'forbidden'));
        return;
      }

      const url = new URL(req.url, 'http://localhost');

      // Run the stable handler chain. Request-local values are passed
      // explicitly; the table itself is created once per server.
      for (const h of handlers) {
        if (h.match(req, url)) {
          const handled = await h.handle(req, res, url);
          if (handled || responseHasStarted(res)) return;
        }
      }

      // Default: route matching + dispatch
      await handleRouteMatch(req, res, routes, url);
    } catch (err) {
      if (responseHasStarted(res)) {
        warnLateResponse(res, 'makeRequestHandler.catch', err);
        if (!res.writableEnded && !res.destroyed) {
          try { res.end(); } catch { /* stream already gone */ }
        }
        return;
      }
      renderError(res, err, { env });
    }
  }
  return (req     , res     ) => withLog(log, () => handle(req, res));
}

// Open a real node:http server for a resolved app and start listening. The
// server is stored on `app.httpServer` and the app is returned (chainable). The
// app's db handle is passed to the dispatcher (read here, owned by the app). The
// routing table was built at mount time; this only serves it.
//
// The second argument is overloaded the Express way: a FUNCTION is a listening
// callback (`app.listen(port, () => ...)`, the exemplar shape); an OBJECT is
// server-owned listen options (`principalOf`, `env`). Both are server-owned —
// neither is client-controlled.
//
// Graceful shutdown (SPEC §3) is framework-owned: SIGTERM/SIGINT close the live
// server, and an unhandledRejection/uncaughtException is trapped. The app mounts
// none of this — `app.shutdown()` is the close the traps call (and tests use).
export function listen(app     , port     , optionsOrCallback      = {}) {
  if (app.httpServer) {
    throw new Error('application is already listening');
  }
  // Portless `app.listen()` — `port` was already optional to `app.listen`, but
  // here it is the value actually bound. An absent port falls back to
  // `app.config.port` (the env-or-option value resolved at construction) and
  // finally the process-wide singleton. One listen path, three sources, most-
  // specific-wins.
  port = port ?? app.config?.port ?? config.port;
  const isCallback = typeof optionsOrCallback === 'function';
  const options = isCallback ? {} : optionsOrCallback;
  const onListening = isCallback ? optionsOrCallback : options.onListening;
  // The default principal source is session hydration when the app has a db: the
  // principal is built server-side from the request's session cookie (SPEC §572).
  // An explicit `principalOf` option overrides (tests inject a fixed principal).
  // With no db there is nothing to look a session up in, so the source stays the
  // fail-closed `() => anonymous` default in makeRequestHandler.
  //
  // When the session resolver returns anonymous (no cookie / invalid session),
  // the API key resolver is tried next: it reads `Authorization: Bearer <token>`,
  // hashes the token, looks up the ApiKey row, and returns an apiKey principal.
  // This is the SAME authorization engine as session principals — no second auth
  // path. The session takes priority: a request with BOTH a valid cookie and a
  // Bearer header resolves to the user principal.
  const sessionResolver = app.db
    ? sessionPrincipalOf(app.db, { durationMs: app.config.sessionDurationMs })
    : null;
  const apiKeyResolver = app.db ? apiKeyPrincipalOf(app.db) : null;
  const defaultPrincipalOf = sessionResolver
    ? (req     ) => {
        const p = sessionResolver(req);
        if (p.type !== 'anonymous') return p;
        return apiKeyResolver ? apiKeyResolver(req) : p;
      }
    : undefined;
  const principalOf = options.principalOf ?? defaultPrincipalOf;

  // Two-phase boot. The routing table resolves asynchronously (an entity's
  // `routes` thunk may be async — e.g. a parent lazily dynamic-imports a child at
  // wiring time), but the SOCKET opens synchronously so `app.httpServer` is
  // available the instant `listen` returns (the chainable, fluent contract). The
  // handler bridges the two: every request first awaits `app.ready`, so no
  // request is ever served against a partial table even though the socket is
  // already accepting connections. A resolution failure rejects `app.ready`; the
  // handler surfaces it as a 500 and the request is never dispatched — fail closed.
  // CSP / HSTS / CORS / requestLog are opt-in policy headers (piece 4, 5).
  // `env` follows the app's config when set (per-app env), else the explicit
  // option, else the singleton default inside makeRequestHandler.
  const resolved = makeRequestHandler(
    // Read the table through a thunk: it is empty until resolution completes, and
    // the handler below gates every request on `app.ready` before reading it.
    app,
    { ...options, principalOf, db: app.db, env: options.env ?? app.config?.env ?? config.env,
      rateLimiter: options.rateLimit ? createRateLimiter(options.rateLimit) : null,
      csp: options.csp, hsts: options.hsts, cors: options.cors, requestLog: options.requestLog },
  );

  const httpServer = createHttpServer(resolved);
  app.httpServer = httpServer;
  // The injected authorization adapter is THE admission engine for this whole
  // application (S5/A2): the HTTP request handler already consults it, and this
  // stash lets the durable kernel (registered actions) and the live-delivery
  // seam resolve the SAME instance — single path, no second engine. Only the
  // injected adapter is stashed; with none, each seam keeps its framework
  // default (behavior unchanged).
  app._authorization = options.authorization;
  // Start the tick engine if any entity declares a tick trigger. DEFERRED into
  // `app.ready` below — `app.kernel` (and thus `dispatch`) is not built until
  // `buildKernel(app)` runs; starting earlier would hand the engine an undefined
  // dispatch handle. Scans entities for tick triggers (tick.hz / tick.every);
  // only starts if at least one exists (avoids a no-op timer). ONE reconciliation
  // path — the engine dispatches under a system principal through `kernel.dispatch`,
  // admitted in-txn by the durable variant's `admission.beforeProjection` seam.
  let failTransport                                  ;
  app._transportReady = new Promise      ((resolve, reject) => {
    const cleanup = () => {
      httpServer.off('listening', onReady);
      httpServer.off('error', onError);
      httpServer.off('close', onClose);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (err     ) => {
      cleanup();
      reject(err);
    };
    failTransport = onError;
    const onClose = () => {
      cleanup();
      if (app._shutdownStarted) {
        resolve();
      } else {
        // `httpServer.close()` is a long-standing public escape hatch used by
        // callers that only own the transport. If it wins the race with the
        // listening event, treat that as cancellation and release the rest of
        // the application rather than creating an unobserved rejected `ready`.
        app._shutdownFromStartFailure().then(resolve, reject);
      }
    };
    httpServer.once('listening', onReady);
    httpServer.once('error', onError);
    httpServer.once('close', onClose);
  });
  if (typeof onListening === 'function') httpServer.once('listening', onListening);

  // Live Delivery is a durable _Log consumer, so a headless HTTP application
  // has no delivery seam to attach. DB-backed apps retain the single seam.
  // One authority per app: an application-integrated delivery owns BOTH
  // transports (the SSE handler is routed above, the WebSocket transport is
  // mounted here) over its shared core; an app without its own delivery gets
  // the framework seam. The old `!app._applicationLiveDelivery` skip left
  // app-integrated apps without any WebSocket upgrade path — a browser
  // WebSocket handshake degraded into an ordinary GET and 400'd against the
  // SSE handler.
  if (app.db && !app._applicationLiveDelivery) {
    app.live = createWebSocketLiveDelivery(httpServer, {
      path: '/events',
      mayVerb: (entity     , verb     , row     , principal     ) => mayVerb(entity, verb, row, principal),
      // The same two-valued admission collapse as the HTTP seam: a non-active
      // principal connects as anonymous, so live re-authorization (mayVerb) and
      // subscription presence never see a real revoked/expired status.
      principalOf: (req     ) => collapseForAdmission(principalOf(req)),
      // The injected adapter owns live subscription admission + re-authorization
      // too (single path); with none injected the framework mayVerb engine runs,
      // unchanged.
      authorization: options.authorization,
      db: app.db,
      resolveEntity: (name     ) => app.entities?.get(name),
      ready: () => app.ready,
      log: app.log,
    }       );
  } else if (app.db && app._applicationLiveDelivery) {
    app._applicationLiveDelivery.mountWebSocket(httpServer);
  }
  app._transportAttached = true;

  // Job lifecycle events (W3 slice 2): the queue appends its _Job.* events to
  // _Log itself, not through the durable pipeline, so the post-commit consumer
  // never sees them. Bridge the queue's listener hook into the committed-event
  // delivery core — the core re-reads the _Log, re-authorises, projects, and
  // delivers to WebSocket subscribers. The event stays durable in _Log for
  // cursor catch-up either way. The fan-out is only for non-_Log ephemerals.
  if (app.jobs) {
    app._detachJobLive = app.jobs.onEvent((ev     ) => {
      if (!ev.scope) return;
      if (app._applicationLiveDelivery) app._applicationLiveDelivery.wake(ev.scope);
      else app.live?.wake(ev.scope);
    });
  }

  // Live and every other transport-owned consumer are selected before Kernel
  // assembly. Establish readiness before asking Node to bind, so even a request
  // accepted at the first possible instant observes the boot barrier.
  app.start();
  try {
    httpServer.listen(port);
  } catch (err) {
    failTransport?.(err);
    // `listen()` retains Node's synchronous argument-error contract. Attach an
    // observer to the same rejected readiness promise so callers that catch the
    // synchronous error are not also handed an unhandled rejection.
    app.ready.catch(() => {});
    throw err;
  }

  return app;
}
