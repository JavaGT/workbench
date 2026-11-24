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

import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  createWebSocketServer,
  DEFAULT_WS_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WS_MAX_PAYLOAD,
  type PerMessageDeflateOptions,
  type ServerWebSocket,
} from './websocket.ts';
import { isSameOriginRequest, type TrustedProxies } from './middleware.ts';
import { createLiveFanout } from './live-fanout.ts';
import type { LiveEntityRecord, LiveFanoutHandle, MayVerb } from './live-fanout.ts';
import type { LiveDeliveryCore } from './live-delivery-core.ts';
import { LiveConnection } from './live-connection.ts';
import { classifyLiveScope } from './live-delivery-core.ts';
import { createAnnotatedTextCaretLive } from './annotated-text-caret-live.ts';
import { readSeq } from './cursor.ts';
import { readRevision } from './live-revision.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import { anonymous, type Principal } from './principal.ts';
import type { FrameworkLog } from './log.ts';
import type { LiveDatabase } from './live-fanout.ts';

export interface LiveDeliveryWebSocketOptions {
  path?: string;
  core?: LiveDeliveryCore | null;
  principalOf?: (req: IncomingMessage) => Principal | Promise<Principal>;
  resolveEntity?: ((name: string) => LiveEntityRecord | undefined | null) | null;
  mayVerb?: MayVerb | null;
  authorization?: AuthorizationAdapter | null;
  db?: LiveDatabase | null;
  ready?: () => Promise<unknown>;
  log?: FrameworkLog | null;
  maxPayload?: number;
  perMessageDeflate?: boolean | PerMessageDeflateOptions;
  heartbeatIntervalMs?: number | false;
  trustedProxies?: TrustedProxies;
}

export interface LiveDeliveryWebSocket {
  count(): number;
  close(): Promise<void>;
}

// The shared live-transport resources. Both the node:http upgrade skin and the
// Bun.serve skin call this factory: one fan-out, one caret presence, one cursor
// reader, one connection registry, and one connection constructor over the SAME
// injected LiveDeliveryCore. Neither skin owns a second authority.
export interface LiveTransportResourcesOptions {
  core?: LiveDeliveryCore | null;
  resolveEntity?: ((name: string) => LiveEntityRecord | undefined | null) | null;
  mayVerb?: MayVerb | null;
  authorization?: AuthorizationAdapter | null;
  db?: LiveDatabase | null;
  log?: FrameworkLog | null;
  maxPayload?: number;
}

export interface LiveTransportResources {
  fanout: LiveFanoutHandle;
  connections: Set<LiveConnection>;
  currentSeq(scope: string): number;
  createConnection(ws: ServerWebSocket, id: string, principal: Principal): LiveConnection;
  closeConnections(): Promise<void>;
}

export function createLiveTransportResources({
  core = null,
  resolveEntity = null,
  mayVerb = null,
  authorization = null,
  db = null,
  log = null,
  maxPayload = DEFAULT_WS_MAX_PAYLOAD,
}: LiveTransportResourcesOptions = {}): LiveTransportResources {
  const fanout: LiveFanoutHandle = createLiveFanout({ mayVerb, authorization });
  const carets = createAnnotatedTextCaretLive({ db: db as never, resolveEntity: resolveEntity as never, mayVerb: mayVerb as never, fanout });
  const connections = new Set<LiveConnection>();

  const currentSeq = (scope: string) => {
    const liveScope = resolveEntity && classifyLiveScope(scope, resolveEntity);
    return liveScope ? readRevision(db as never, scope) : readSeq(db, scope);
  };

  function createConnection(ws: ServerWebSocket, id: string, principal: Principal): LiveConnection {
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
    return conn;
  }

  async function closeConnections(): Promise<void> {
    await Promise.all([...connections].map((conn) => conn.close?.().catch(() => {})));
    connections.clear();
    fanout.close();
  }

  return { fanout, connections, currentSeq, createConnection, closeConnections };
}

export function createLiveDeliveryWebSocket(httpServer: Server, {
  path = '/events',
  core = null,
  principalOf = (() => anonymous) as () => Principal,
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
}: LiveDeliveryWebSocketOptions = {}): LiveDeliveryWebSocket {
  const wss = createWebSocketServer({ maxPayload, perMessageDeflate });
  const { connections, createConnection, closeConnections } = createLiveTransportResources({
    core, resolveEntity, mayVerb, authorization, db, log, maxPayload,
  });
  const pendingUpgrades = new Set<Duplex>();
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function stopHeartbeat(): void {
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

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = closeImpl();
    return closePromise;
  }

  async function closeImpl(): Promise<void> {
    closed = true;
    stopHeartbeat();
    httpServer.off('upgrade', onUpgrade);
    httpServer.off('close', onServerClose);
    for (const socket of pendingUpgrades) socket.destroy();
    pendingUpgrades.clear();
    await closeConnections();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
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
          createConnection(ws, id, principal);
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
