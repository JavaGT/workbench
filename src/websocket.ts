// WebSocket server — ws-backed server factory and transport defaults.
//
// Node's `http.WebSocket` is client-only. The server side uses `ws` in
// `noServer` mode, wired to the HTTP server's `upgrade` event by
// `live-delivery-websocket.ts`.

import {
  WebSocketServer,
  type WebSocket as WsWebSocket,
  type PerMessageDeflateOptions,
  type RawData,
} from 'ws';

// Default transport limits & tuning for the ws-backed WebSocket server.
export const DEFAULT_WS_MAX_PAYLOAD = 4 * 1024 * 1024; // 4 MiB
export const DEFAULT_WS_DEFLATE_THRESHOLD = 1024; // 1 KiB
export const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 30_000;

export type ServerWebSocket = WsWebSocket;
export type { PerMessageDeflateOptions, RawData };
export { WebSocketServer };

export interface CreateWebSocketServerOptions {
  maxPayload?: number;
  perMessageDeflate?: boolean | PerMessageDeflateOptions;
}

/**
 * Create a `noServer` `ws.WebSocketServer` configured with `permessage-deflate`
 * compression (enabled by default with a 1 KiB threshold) and a configurable
 * `maxPayload` cap (default 4 MiB).
 */
export function createWebSocketServer(options: CreateWebSocketServerOptions = {}): WebSocketServer {
  const maxPayload = options.maxPayload ?? DEFAULT_WS_MAX_PAYLOAD;
  let perMessageDeflate: boolean | PerMessageDeflateOptions;
  if (options.perMessageDeflate === false) {
    perMessageDeflate = false;
  } else if (options.perMessageDeflate === undefined || options.perMessageDeflate === true) {
    perMessageDeflate = { threshold: DEFAULT_WS_DEFLATE_THRESHOLD };
  } else {
    perMessageDeflate = { threshold: DEFAULT_WS_DEFLATE_THRESHOLD, ...options.perMessageDeflate };
  }
  return new WebSocketServer({
    noServer: true,
    maxPayload,
    perMessageDeflate,
  });
}
