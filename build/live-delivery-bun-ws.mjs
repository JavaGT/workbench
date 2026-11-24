// Bun.serve WebSocket skin for the Deliver loop.
//
// This module adds a TRANSPORT, not a second machine. The HTTP `fetch` side is
// `createFetchHandler` (the same makeRequestHandler spine as listen()); the
// WebSocket side upgrades on `/events` through Bun's `server.upgrade(req,
// { data })`, presents the ONE application LiveDeliveryCore to `LiveConnection`,
// and reuses the SAME fan-out/caret/cursor resources as the node:http skin.
//
// Principal hydration is the listen() default (session cookie, then Bearer API
// key), followed by the same two-valued admission collapse the node:http
// upgrade applies. The same-origin/CSWSH verdict comes from the one middleware
// predicate. No second auth engine, no second committed authority, no second
// reconciliation path.

import { createLiveDeliveryCore } from './live-delivery-core.mjs';

import { createLiveEnvelopeBuilder } from './live-delivery-envelope.mjs';
import { projectRowForRecipient } from './entity/projection.mjs';
import { readableFieldNames } from './field-admission.mjs';
import { mayVerb as frameworkMayVerb } from './row-grant.mjs';
import { anonymous, collapseForAdmission,                } from './principal.mjs';
import { isSameOriginRequest,                     } from './middleware.mjs';
import { createFetchHandler, defaultPrincipalOfForApp } from './http-fetch.mjs';

import { createLiveTransportResources } from './live-delivery-websocket.mjs';





const DEFAULT_PATH = '/events';

// The Bun API surface this adapter needs, declared structurally so the package
// keeps compiling without bun-types installed.






























































function createEmitter() {
  const listeners = new Map                       ();
  return {
    on(event        , listener          ) {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(listener);
    },
    off(event        , listener          ) { listeners.get(event)?.delete(listener); },
    emit(event        , ...args       ) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
    once(event        , listener          ) {
      const wrapped           = (...args) => { this.off(event, wrapped); listener(...args); };
      this.on(event, wrapped);
    },
  };
}

// The smallest node:http-like view the shared admission predicates read. It is
// used ONLY for hydration/origin verdicts, never as a second request spine.
function toNodeRequestLike(request                , remoteAddress         ) {
  const headers                         = {};
  for (const [name, value] of request.headers.entries()) headers[name.toLowerCase()] = value;
  const parsed = new URL(request.url, 'http://localhost');
  return {
    method: request.method ?? 'GET',
    url: parsed.pathname + parsed.search,
    headers,
    socket: { remoteAddress },
  };
}

function isWebSocketUpgrade(request                )          {
  return String(request.headers.get('upgrade') ?? '').toLowerCase().includes('websocket')
    && typeof request.headers.get('sec-websocket-key') === 'string';
}

// A `ws`-shaped facade over Bun's ServerWebSocket. LiveConnection, the fan-out,
// and caret presence are shared code written against `ws`; adapting at this one
// seam keeps transport-specific I/O out of the delivery authority.
function createSocketFacade(socket                  ) {
  const emitter = createEmitter();
  let readyState = 1;
  // Local fallback for sockets that expose neither getBufferedAmount() nor a
  // bufferedAmount property (e.g. test doubles). It counts ONLY bytes queued
  // under backpressure and is cleared on drain — accumulating every send would
  // grow monotonically and eventually trip LiveConnection's byte queue limit.
  let bufferedBytes = 0;
  let closeEmitted = false;

  const readBufferedAmount = ()         => {
    if (typeof socket.getBufferedAmount === 'function') return socket.getBufferedAmount();
    if (typeof socket.bufferedAmount === 'number') return socket.bufferedAmount;
    return bufferedBytes;
  };

  const facade      = {
    get readyState() { return readyState; },
    get bufferedAmount() { return readBufferedAmount(); },
    on(event        , listener          ) { emitter.on(event, listener); return facade; },
    off(event        , listener          ) { emitter.off(event, listener); return facade; },
    once(event        , listener          ) { emitter.once(event, listener); return facade; },
    emit(event        , ...args       ) { emitter.emit(event, ...args); return true; },
    send(payload         , callback                                 ) {
      if (readyState !== 1) {
        queueMicrotask(() => callback?.(new Error('Bun WebSocket is closed')));
        return;
      }
      try {
        const text = String(payload);
        const written = socket.send(text);
        // Bun's -1 means ENQUEUED WITH BACKPRESSURE — the peer is slow, not
        // gone. The transport stays open and resumes when Bun calls drain().
        if (written === 0) throw new Error('Bun WebSocket dropped the message (socket closed)');
        if (written === -1) bufferedBytes += Buffer.byteLength(text, 'utf8');
        queueMicrotask(() => callback?.(undefined));
      } catch (err) {
        emitter.emit('error', err);
        // Mark closed through the one idempotent seam so a fatal write also
        // presents 'close' exactly once (never set readyState before it).
        markClosed();
        queueMicrotask(() => callback?.(err instanceof Error ? err : new Error(String(err))));
      }
    },
    ping() {
      if (readyState !== 1) return;
      try { socket.ping?.(); } catch { /* peer vanished; close handler will fire */ }
    },
    close(code = 1000, reason = '') {
      if (readyState === 3) return;
      // Send the RFC 6455 close frame first, then present the ws-shaped 'close'
      // synchronously so shared LiveConnection cleanup never waits out its
      // 250 ms handshake grace timer (Bun owns the real handshake).
      try { socket.close(code, reason); } catch { /* ignore */ }
      markClosed(code, reason);
    },
    terminate() {
      if (readyState === 3) return;
      try { socket.terminate(); } catch { /* ignore */ }
      markClosed(1006, '');
    },
  };

  function markClosed(code         , reason         )       {
    if (closeEmitted) return;
    closeEmitted = true;
    readyState = 3;
    bufferedBytes = 0;
    emitter.emit('close', code, reason);
  }

  return {
    facade,
    markClosed,
    markError(error         ) { emitter.emit('error', error); },
    message(data         , isBinary         ) { emitter.emit('message', data, isBinary); },
    pong() { emitter.emit('pong'); },
    drain() {
      bufferedBytes = 0;
      emitter.emit('drain');
    },
  };
}












function createConnectionState(
  socket                  ,
  idOf              ,
)                     {
  const handle = createSocketFacade(socket);
  let connection                                                                = null;
  const queued                               = [];
  return {
    facade: handle.facade,
    socket,
    queued,
    attached: () => connection !== null,
    attach(principal, liveResources) {
      if (connection) return;
      connection = liveResources.createConnection(handle.facade, idOf(), principal);
      for (const item of queued.splice(0)) handle.message(item.data, item.isBinary);
    },
    message: handle.message,
    markClosed: handle.markClosed,
    drain: handle.drain,
  };
}

// Build the SAME committed core the node:http seam builds: re-read _Log,
// re-authorise, project for the recipient, then deliver envelopes verbatim.
function createSharedCore({
  db, resolveEntity, mayVerb, authorization, log,
}





 ) {
  const envelopeBuilder = createLiveEnvelopeBuilder();
  const projectRecipient = async (ctx     , builder                                              ) => {
    let readableFields                                 ;
    let row = ctx.row;
    if (row) {
      readableFields = await readableFieldNames(ctx.entity         , row, ctx.principal, authorization);
      row = await projectRowForRecipient(ctx.entity         , row, ctx.principal, { readable: readableFields, authorization });
    }
    return builder.buildEnvelope({ ...ctx, row, readableFields }         );
  };
  const core = createLiveDeliveryCore({
    db,
    entities: (name        ) => resolveEntity(name)                                ,
    mayVerb,
    authorization,
    projectRecipient: (ctx) => projectRecipient(ctx, envelopeBuilder),
    createProjectRecipient: () => {
      const builder = createLiveEnvelopeBuilder();
      return (ctx) => projectRecipient(ctx, builder);
    },
    log,
  });
  return { core, envelopeBuilder };
}

/**
 * Build `Bun.serve({ ...handlers })` handlers for a Workbench app.
 *
 * Call this BEFORE `app.start()` so the app's Kernel registers this delivery's
 * committed consumer. HTTP requests go through `createFetchHandler`; WebSocket
 * upgrades on `path` run the listen() principal/origin admission and attach a
 * LiveConnection over the app's one LiveDeliveryCore.
 */
export function createBunServerHandlers(app     , {
  path = DEFAULT_PATH,
  core: injectedCore = null,
  principalOf: injectedPrincipalOf,
  resolveEntity: injectedResolveEntity = null,
  mayVerb: injectedMayVerb = null,
  authorization: injectedAuthorization = null,
  db: injectedDb = null,
  log: injectedLog = null,
  ready,
  trustedProxies = false,
  heartbeatIntervalMs = false,
  maxPayload,
  fetchOptions = {},
}                           = {})                    {
  const db = (injectedDb ?? app?.db)                       ;
  const authorization = injectedAuthorization ?? app?._authorization ?? null;
  const resolveEntity = injectedResolveEntity
    ?? ((name        ) => app?.entities?.get(name)                                );
  const mayVerb          = injectedMayVerb
    ?? ((entity                  , verb        , row     , principal           ) =>
      frameworkMayVerb(entity         , verb, row, principal));
  const log = injectedLog ?? app?.log ?? null;
  const basePrincipalOf = injectedPrincipalOf ?? defaultPrincipalOfForApp(app) ?? (() => anonymous);
  const principalOf = async (request     )                     =>
    collapseForAdmission(await basePrincipalOf(request));
  // The HTTP spine's principal resolver is synchronous; an async custom
  // resolver cannot complete before the adapter returns a Response, so it fails
  // closed there (the WebSocket upgrade path awaits it before upgrading).
  const fetchPrincipalOf = (request     )            => {
    const resolved = basePrincipalOf(request);
    return resolved && typeof (resolved                      ).then === 'function'
      ? anonymous
      : collapseForAdmission(resolved             );
  };
  const isReady = ready ?? (() => Promise.resolve(app?.ready ?? undefined));

  // Reuse the ONE authority the app already owns. An application-integrated
  // delivery (_applicationLiveDelivery) and the framework WS seam (app.live)
  // both expose `.core`. An injected core never overrides an app-owned one:
  // building over an active listen() transport would create a second committed
  // authority, which is exactly the split this seam must prevent.
  const existing = app?._applicationLiveDelivery ?? app?.live ?? null;
  const existingCore = (existing?.core                                ) ?? null;
  const ownsCore = !existingCore && !injectedCore;
  const built = ownsCore ? createSharedCore({ db: db                , resolveEntity, mayVerb, authorization, log }) : null;
  const envelopeBuilder = built?.envelopeBuilder ?? null;
  const core                   = existingCore ?? injectedCore ?? built .core;

  // kernel.ts registers the live post-commit consumer from app.live. Whenever
  // a core exists — injected, app-owned, or just built here — make sure app.live
  // exposes that SAME core and a consumer. Without this, a core reachable only
  // through a transport-side field left the app with no live consumer at all.
  const liveIsWired = Boolean(
    app?.live && app.live.core === core && typeof app.live.createConsumer === 'function',
  );
  if (!liveIsWired) {
    const delivery = {
      core,
      createConsumer() {
        const woken = new Set        ();
        return async (events                            = []) => {
          woken.clear();
          for (const event of events) {
            if (!event?.scope || woken.has(event.scope)) continue;
            woken.add(event.scope);
            core.wake(event.scope);
          }
        };
      },
      wake(scope        ) { core.wake(scope); },
      close() { core.close(); envelopeBuilder?.clear(); },
    };
    app.live = delivery;
  }

  const resources = createLiveTransportResources({
    core, resolveEntity, mayVerb, authorization, db, log, maxPayload,
  });
  const connections = new Map                                      ();
  let closed = false;
  let closePromise                       = null;
  let heartbeatTimer                                        = null;

  if (typeof heartbeatIntervalMs === 'number' && Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      for (const state of connections.values()) state.facade.ping();
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  const fetchHandler = createFetchHandler(app, {
    ...fetchOptions,
    db: fetchOptions.db ?? db,
    principalOf: fetchOptions.principalOf ?? fetchPrincipalOf,
    authorization: fetchOptions.authorization ?? authorization,
    env: fetchOptions.env ?? app?.config?.env,
  });

  async function fetch(request         , server                )                                {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== path || !isWebSocketUpgrade(request                  )) {
      return fetchHandler(request, server);
    }
    const remoteAddress = server?.requestIP?.(request)?.address;
    const nodeRequest = toNodeRequestLike(request                  , remoteAddress);
    // The CSWSH verdict is the SAME predicate the REST CSRF guard and the
    // node:http WebSocket upgrade use — one policy, both skins.
    if (!isSameOriginRequest(nodeRequest, { trustedProxies })) {
      return new Response('Forbidden', { status: 403 });
    }
    if (closed || typeof server?.upgrade !== 'function') {
      return new Response('WebSocket upgrade unavailable', { status: 400 });
    }
    try {
      await isReady();
    } catch {
      return new Response('Application is not ready', { status: 500 });
    }
    const principal = await principalOf(nodeRequest);
    if (closed) return new Response('Server shutting down', { status: 503 });
    // Bun performs the 101 handshake here; `data` travels with the socket so
    // `open()` attaches a connection without re-resolving the principal.
    const upgraded = server.upgrade(request, { data: { principal } });
    return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
  }

  const websocket                                 = {
    open(socket) {
      const state = createConnectionState(socket, () => `bun:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`);
      connections.set(socket, state);
      if (closed) { socket.close(1001, 'Server shutting down'); return; }
      const data = socket.data                                         ;
      state.attach(collapseForAdmission(data?.principal ?? anonymous), resources);
    },
    message(socket, message) {
      const state = connections.get(socket);
      if (!state) return;
      const isBinary = typeof message !== 'string';
      const data = typeof message === 'string'
        ? message
        : Buffer.from(message               );
      if (state.queued.length > 0 || !state.attached()) {
        state.queued.push({ data, isBinary });
        return;
      }
      state.message(data, isBinary);
    },
    close(socket, code, reason) {
      const state = connections.get(socket);
      if (!state) return;
      connections.delete(socket);
      state.markClosed(code, reason);
    },
    drain(socket) {
      connections.get(socket)?.drain();
    },
  };

  // Reuse the app's framework-owned shutdown trap: the Bun skin must release
  // its sockets even when a host forgets to call `handlers.close()` directly.
  app?.onShutdown?.('bun-ws-transport', () => close());

  async function close()                {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closed = true;
      if (heartbeatTimer !== null) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      // Close the attached connections FIRST, while the registry is intact:
      // each shared connection issues a clean RFC 6455 close handshake through
      // its socket facade, which presents 'close' synchronously and therefore
      // resolves without the 250 ms grace timer. Terminating sockets before
      // this point suppressed that event and left the handshake unflushed.
      await resources.closeConnections();
      for (const [socket, state] of [...connections]) {
        if (!state.attached()) {
          try { socket.terminate(); } catch { /* ignore */ }
        }
        state.markClosed(1001, 'Server shutting down');
      }
      connections.clear();
      if (ownsCore) {
        core.close();
        envelopeBuilder?.clear();
      }
    })();
    return closePromise;
  }

  return { fetch, websocket, close, core };
}

/** Alias for hosts that only need the WebSocket side of the Bun.serve handlers. */
export const createBunWebSocketAdapter = createBunServerHandlers;
