// First-class Web Fetch / Bun.serve adapter.
//
// This module does NOT implement a second HTTP or admission path. It adapts a
// standard Web `Request` to the Node-shaped request/response pair that
// `makeRequestHandler` already consumes, runs the ONE spine, and adapts the
// result back into a standard Web `Response`. Route matching, CORS/CSRF, the
// route gate, REST CRUD dispatch, framework routes, session/Bearer principals,
// and every baked-in default are therefore identical to `app.listen()`.
//
// The bridge is deliberately dumb: it carries method, URL, headers, body bytes,
// status, and multi-value Set-Cookie headers across the boundary. No policy
// decision is made here.

import { makeRequestHandler } from './serve.ts';
import type { Principal } from './principal.ts';
import { renderError } from './middleware.ts';

// The Node-shaped request the ONE spine sees. It is also the value handed to a
// custom `principalOf`, so a Bearer/session resolver can read `headers` exactly
// as it does under node:http.
export interface FetchNodeRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
  aborted: boolean;
  destroyed: boolean;
  readableEnded: boolean;
  raw: FetchNodeRequest;
  on(event: string, listener: (...args: any[]) => void): FetchNodeRequest;
  off(event: string, listener: (...args: any[]) => void): FetchNodeRequest;
  once(event: string, listener: (...args: any[]) => void): FetchNodeRequest;
  emit(event: string, ...args: any[]): boolean;
  pause(): FetchNodeRequest;
  resume(): FetchNodeRequest;
  destroy(error?: Error): FetchNodeRequest;
}

export interface FetchHandlerOptions {
  /** Derives the request principal. Receives the bridged Node-shaped request. */
  principalOf?: (request: FetchNodeRequest) => Principal;
  db?: any;
  env?: string;
  rateLimiter?: any;
  csp?: string;
  hsts?: boolean;
  cors?: any;
  requestLog?: boolean;
  authorization?: any;
  trustedProxies?: any;
}

export type FetchHandler = (request: Request) => Promise<Response>;

type Listener = (...args: any[]) => void;

function createEmitter() {
  const listeners = new Map<string, Set<Listener>>();
  const on = (event: string, listener: Listener) => {
    let set = listeners.get(event);
    if (!set) { set = new Set(); listeners.set(event, set); }
    set.add(listener);
    return true;
  };
  const off = (event: string, listener: Listener) => {
    listeners.get(event)?.delete(listener);
    return true;
  };
  const emit = (event: string, ...args: any[]) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    return listeners.has(event);
  };
  return { on, off, emit };
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === 'string') return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

// Build a Node-shaped IncomingMessage facade over a Web Request. The Web body
// is buffered once, then replayed through the event interface `http-body.ts`
// and the blob streaming adapter already use. `pause`/`resume` gate that replay
// so backpressure and oversize-body drains behave like a real socket.
function createNodeRequest(webRequest: Request, bytes: Uint8Array): FetchNodeRequest {
  const parsed = new URL(webRequest.url, 'http://localhost');
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of webRequest.headers.entries()) {
    headers[name.toLowerCase()] = value;
  }
  if (headers.host === undefined) headers.host = parsed.host;
  if (headers['content-length'] === undefined && bytes.length > 0) {
    headers['content-length'] = String(bytes.length);
  }

  const { on, off, emit } = createEmitter();
  let paused = false;
  let scheduled = false;
  let offset = 0;
  let ended = false;
  const chunks = [Buffer.from(bytes)];

  const pump = () => {
    scheduled = false;
    while (!paused && offset < chunks.length) {
      const chunk = chunks[offset++]!;
      emit('data', chunk);
    }
    if (!paused && !ended && offset >= chunks.length) {
      ended = true;
      emit('end');
    }
  };
  const schedulePump = () => {
    if (scheduled || ended) return;
    scheduled = true;
    queueMicrotask(pump);
  };

  const self: FetchNodeRequest = {
    method: webRequest.method,
    url: parsed.pathname + parsed.search,
    headers,
    socket: { remoteAddress: undefined },
    aborted: false,
    destroyed: false,
    readableEnded: false,
    raw: undefined as unknown as FetchNodeRequest,
    on(event, listener) { on(event, listener); if (event === 'data') schedulePump(); return self; },
    off(event, listener) { off(event, listener); return self; },
    once(event, listener) {
      const wrapped: Listener = (...args) => { off(event, wrapped); listener(...args); };
      on(event, wrapped);
      if (event === 'data') schedulePump();
      return self;
    },
    emit(event, ...args) { return emit(event, ...args); },
    pause() { paused = true; return self; },
    resume() { paused = false; schedulePump(); return self; },
    destroy(error?: Error) {
      self.destroyed = true;
      if (error) emit('error', error);
      return self;
    },
  };
  self.raw = self;
  return self;
}

// Set-Cookie is the one response header Node keeps as a list and Web Headers
// keeps as multiple field lines. Preserve every value instead of folding them
// into one comma-separated string (which browsers would parse as one cookie).
function storeHeader(store: Map<string, string | string[]>, name: string, value: string | string[]): void {
  const key = name.toLowerCase();
  if (key === 'set-cookie') {
    const previous = store.get(key);
    const values = previous === undefined ? [] : Array.isArray(previous) ? previous : [previous];
    store.set(key, [...values, ...(Array.isArray(value) ? value : [value])]);
    return;
  }
  store.set(key, Array.isArray(value) ? value.join(', ') : value);
}

function createNodeResponse(nodeReq: FetchNodeRequest) {
  const { on, off, emit } = createEmitter();
  const store = new Map<string, string | string[]>();
  const chunks: Buffer[] = [];
  let statusCode = 200;
  let headersSent = false;
  let writableEnded = false;
  let destroyed = false;

  const res: any = {
    req: nodeReq,
    get statusCode() { return statusCode; },
    get headersSent() { return headersSent; },
    get writableEnded() { return writableEnded; },
    get destroyed() { return destroyed; },
    setHeader(name: string, value: string | string[]) { storeHeader(store, name, value); return res; },
    getHeader(name: string) { return store.get(name.toLowerCase()); },
    removeHeader(name: string) { store.delete(name.toLowerCase()); },
    hasHeader(name: string) { return store.has(name.toLowerCase()); },
    getHeaderNames() { return [...store.keys()]; },
    flushHeaders() { headersSent = true; },
    writeHead(code: number, statusMessageOrHeaders?: string | Record<string, unknown>, maybeHeaders?: Record<string, unknown>) {
      statusCode = code;
      const rawHeaders = typeof statusMessageOrHeaders === 'string' ? maybeHeaders : statusMessageOrHeaders;
      if (rawHeaders && typeof rawHeaders === 'object') {
        for (const [name, value] of Object.entries(rawHeaders)) {
          if (value !== undefined && value !== null) storeHeader(store, name, value as string | string[]);
        }
      }
      headersSent = true;
      return res;
    },
    write(chunk: unknown) {
      if (writableEnded || destroyed) return false;
      chunks.push(toBuffer(chunk));
      return true;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined && chunk !== null) chunks.push(toBuffer(chunk));
      writableEnded = true;
      emit('finish');
      return res;
    },
    destroy(error?: Error) {
      destroyed = true;
      if (error) emit('error', error);
      return res;
    },
    on(event: string, listener: Listener) { on(event, listener); return res; },
    off(event: string, listener: Listener) { off(event, listener); return res; },
    once(event: string, listener: Listener) {
      const wrapped: Listener = (...args) => { off(event, wrapped); listener(...args); };
      on(event, wrapped);
      return res;
    },
    emit(event: string, ...args: any[]) { return emit(event, ...args); },
  };
  return { res, store, chunks, status: () => statusCode, ended: () => writableEnded || destroyed };
}

function buildWebResponse(
  statusCode: number,
  store: Map<string, string | string[]>,
  chunks: Buffer[],
  method: string,
): Response {
  const pairs: Array<[string, string]> = [];
  for (const [name, value] of store) {
    if (name === 'set-cookie') {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) pairs.push(['set-cookie', String(item)]);
    } else {
      pairs.push([name, Array.isArray(value) ? value.join(', ') : String(value)]);
    }
  }
  // node:http suppresses a body on HEAD, and the Web Response contract forbids
  // a body on 204/205/304. Mirror both so a Node-style 204 DELETE maps cleanly.
  const bodyless = method === 'HEAD' || statusCode === 204 || statusCode === 205 || statusCode === 304;
  const body = bodyless ? null : Buffer.concat(chunks);
  return new Response(body, { status: statusCode, headers: pairs });
}

/**
 * Adapt a Workbench application to a `(request: Request) => Promise<Response>`
 * handler suitable for `Bun.serve({ fetch })`, `Deno.serve`, Cloudflare Workers,
 * or `node:http` users who already hold a Web Request. Every request runs
 * through the same `makeRequestHandler` spine used by `app.listen()`.
 */
export function createFetchHandler(app: any, opts: FetchHandlerOptions = {}): FetchHandler {
  const handler = makeRequestHandler(app, opts);
  return async (webRequest: Request): Promise<Response> => {
    const bytes = new Uint8Array(await webRequest.arrayBuffer());
    const nodeReq = createNodeRequest(webRequest, bytes);
    const bridge = createNodeResponse(nodeReq);
    try {
      await handler(nodeReq, bridge.res);
    } catch (err) {
      if (!bridge.ended()) renderError(bridge.res, err);
    }
    if (!bridge.ended()) bridge.res.end();
    return buildWebResponse(bridge.status(), bridge.store, bridge.chunks, webRequest.method);
  };
}
