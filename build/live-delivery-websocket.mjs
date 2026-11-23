// Live Delivery WebSocket transport — a thin upgrade seam for the Deliver loop.
//
// Transport-neutral: it accepts an INJECTED committed-event subscription
// authority (a live-delivery-core-shaped `core`) plus the same admission
// dependencies the HTTP skin uses (resolveEntity / mayVerb / db). The seam owns
// only socket I/O, connection lifecycle, the ephemeral fan-out, and caret
// presence — never the committed authority itself, which the caller
// (createWebSocketLiveDelivery or an application-integrated delivery) owns and closes.
//
// One authority rule: SSE (live-delivery-http) and WebSocket both present the
// SAME injected core, so a subscribed client receives committed events through
// exactly one re-read / re-authorise / project / deliver path regardless of
// transport — and the same envelope kinds (`event`/`state`/`state-invalidate`/
// `resync`), so the S3/A7 kind grammar round-trips identically over both.
// Mounting this seam is the only way an application-integrated delivery gets a
// WebSocket upgrade; without an 'upgrade' listener a WS handshake request is
// handled as an ordinary GET and 400s against the SSE handler ('invalid live
// delivery request').




import {
  createWebSocketServer,
  DEFAULT_WS_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WS_MAX_PAYLOAD,

} from './websocket.mjs';
import { isSameOriginRequest,                     } from './middleware.mjs';
import { createLiveFanout } from './live-fanout.mjs';


import { LiveConnection } from './live-connection.mjs';
import { classifyLiveScope } from './live-delivery-core.mjs';
import { createAnnotatedTextCaretLive } from './annotated-text-caret-live.mjs';
import { readSeq } from './cursor.mjs';
import { readRevision } from './live-revision.mjs';

import { anonymous,                } from './principal.mjs';
























export function createLiveDeliveryWebSocket(httpServer        , {
  path = '/events',
  core = null,
  principalOf = (() => anonymous)                   ,
  resolveEntity = null,
  mayVerb = null,
  authorization = null,
  db = null,
  ready = () => Promise.resolve(),
  log = null,
  maxPayload = DEFAULT_WS_MAX_PAYLOAD,
  perMessageDeflate = true,
  heartbeatIntervalMs = DEFAULT_WS_HEARTBEAT_INTERVAL_MS,
  trustedProxies = false,
}                               = {})                        {
  const wss = createWebSocketServer({ maxPayload, perMessageDeflate });
  const fanout                   = createLiveFanout({ mayVerb, authorization });
  const carets = createAnnotatedTextCaretLive({ db: db         , resolveEntity: resolveEntity         , mayVerb: mayVerb         , fanout });
  const connections = new Set                ();
  const pendingUpgrades = new Set        ();
  let closed = false;
  let closePromise                       = null;
  let heartbeatTimer                                        = null;

  const currentSeq = (scope        ) => {
    const liveScope = resolveEntity && classifyLiveScope(scope, resolveEntity);
    return liveScope ? readRevision(db         , scope) : readSeq(db, scope);
  };

  function stopHeartbeat()       {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // Server-initiated Ping/Pong heartbeat & idle reaper: ping every open socket
  // on each interval; any socket that missed the previous pong is terminated so
  // half-open TCP peers do not leak subscriptions or descriptors.
  if (typeof heartbeatIntervalMs === 'number' && Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      if (closed) {
        stopHeartbeat();
        return;
      }
      for (const conn of [...connections]) {
        if (!conn.isAlive) {
          void conn.terminate();
        } else {
          conn.ping();
        }
      }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  const onServerClose = () => {
    stopHeartbeat();
  };
  httpServer.once('close', onServerClose);

  async function close()                {
    if (closePromise) return closePromise;
    closePromise = closeImpl();
    return closePromise;
  }

  async function closeImpl()                {
    closed = true;
    stopHeartbeat();
    httpServer.off('upgrade', onUpgrade);
    httpServer.off('close', onServerClose);
    for (const socket of pendingUpgrades) socket.destroy();
    pendingUpgrades.clear();
    await Promise.all([...connections].map((conn) => conn.close?.().catch(() => {})));
    connections.clear();
    await new Promise      ((resolve) => wss.close(() => resolve()));
    fanout.close();
  }

  const onUpgrade = (req                 , socket        , head        ) => {
    const url = req.url ? new URL(req.url, 'http://localhost') : { pathname: '' };
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }

    // CSWSH defense — same same-origin verdict as REST CSRF (middleware.mjs).
    if (!isSameOriginRequest(req, { trustedProxies })) {
      socket.destroy();
      return;
    }

    if (closed) {
      socket.destroy();
      return;
    }

    // HTTP requests and WebSocket subscriptions share one application-start
    // barrier. Keep the raw socket outside the connection registry until the
    // schema, Kernel, recovery, and admission engine are ready. A failed start
    // fails closed; shutdown destroys sockets waiting at this barrier.
    const onPendingError = () => {
      pendingUpgrades.delete(socket);
    };
    socket.on('error', onPendingError);
    pendingUpgrades.add(socket);

    Promise.resolve()
      .then(() => ready())
      .then(async () => {
        if (closed || socket.destroyed) {
          pendingUpgrades.delete(socket);
          socket.off('error', onPendingError);
          socket.destroy();
          return;
        }

        // principalOf may be asynchronous (a session lookup). Resolve it BEFORE
        // completing the 101 handshake so admission never observes a pending
        // promise standing in for a principal AND so LiveConnection attaches
        // its `message` listener synchronously inside `wss.handleUpgrade` before
        // any frames (including bytes in `head`) are emitted.
        const principal = await principalOf(req);
        pendingUpgrades.delete(socket);
        socket.off('error', onPendingError);
        if (closed || socket.destroyed) {
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          if (closed) {
            try { ws.close(1001, 'Server shutting down'); } catch { /* ignore */ }
            try { ws.terminate(); } catch { /* ignore */ }
            return;
          }

          const id = `ws:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
          const conn = new LiveConnection(ws, id, {
            fanout,
            core,
            resolveEntity,
            mayVerb,
            authorization,
            db,
            currentSeq,
            log,
            carets,
            maxPayload,
            onClose: () => connections.delete(conn),
          });
          conn.setPrincipal(principal);
          connections.add(conn);
        });
      })
      .catch(() => {
        pendingUpgrades.delete(socket);
        socket.off('error', onPendingError);
        socket.destroy();
      });
  };

  httpServer.on('upgrade', onUpgrade);

  return { count: () => connections.size, close };
}
