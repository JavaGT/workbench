// First-class Web Fetch / Bun.serve adapter.
//
// This module does NOT implement a second HTTP or admission path. It adapts a
// standard Web `Request` to the Node-shaped request/response pair that
// `makeRequestHandler` already consumes, runs the ONE spine, and adapts the
// result back into a standard Web `Response`. Route matching, CORS/CSRF, the
// route gate, REST CRUD dispatch, framework routes, session/Bearer principals,
// and every baked-in default are therefore identical to `app.listen()`.
//
// The bridge carries method, URL, headers, body bytes, status, and multi-value
// Set-Cookie headers across the boundary. Request and response bodies are
// streamed (never accumulated behind the handler), so large uploads, SSE, and
// Range/206 media are served under backpressure. No policy decision is made
// here.

import { makeRequestHandler } from './serve.ts';
import type { Principal } from './principal.ts';
import { sessionPrincipalOf, apiKeyPrincipalOf } from './auth/session.ts';
import { renderError } from './middleware.ts';

// The Node-shaped request the ONE spine sees. It is also the value handed to a
// custom `principalOf`, so a Bearer/session resolver can read `headers` exactly
// as it does under node:http.
export interface FetchNodeRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
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
  /** Fallback client IP for rate limiting when `server.requestIP` is unavailable. */
  remoteAddress?: string;
  /** Bun/Node host server; `requestIP(req)` supplies the client IP when present. */
  server?: { requestIP?(request: Request): { address?: string } | null | undefined } | null;
}

// The Web host may hand the server to `fetch(req, server)` (Bun.serve does).
// Keeping that second parameter is source-compatible with a plain `(req)` host.
export type FetchHandler = (request: Request, server?: any) => Promise<Response>;

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
  const once = (event: string, listener: Listener) => {
    const wrapped: Listener = (...args) => { off(event, wrapped); listener(...args); };
    on(event, wrapped);
    return true;
  };
  return { on, off, emit, once };
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === 'string') return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

/**
 * The principal source `listen()` wires by default when the app has a db:
 * hydrate the session cookie, then fall back to a Bearer API key. Both live in
 * the one authorization engine — `createFetchHandler`, `listen()`, and the Bun
 * WebSocket adapter all share this resolver, so adding a transport never adds
 * a second auth path. No db → no resolver → `makeRequestHandler`'s fail-closed
 * `anonymous` default stands.
 */
export function defaultPrincipalOfForApp(app: any): ((request: any) => Principal) | undefined {
  if (!app?.db) return undefined;
  const durationMs = app.config?.sessionDurationMs;
  const sessionResolver = sessionPrincipalOf(app.db, durationMs === undefined ? {} : { durationMs });
  const apiKeyResolver = apiKeyPrincipalOf(app.db);
  return (req: any) => {
    const sessionPrincipal = sessionResolver(req);
    if (sessionPrincipal.type !== 'anonymous') return sessionPrincipal;
    return apiKeyResolver(req);
  };
}

// Build a Node-shaped IncomingMessage facade over a Web Request. The Web body
// is consumed chunk-by-chunk as the spine attaches its `data`/`end` listeners;
// `pause`/`resume` gate that pump so backpressure and oversize-body drains
// behave like a real socket. `http-body.ts` still owns the byte cap.
function createNodeRequest(
  webRequest: Request,
  { remoteAddress }: { remoteAddress?: string } = {},
): FetchNodeRequest {
  const parsed = new URL(webRequest.url, 'http://localhost');
  const headers: Record<string, string | string[] | undefined> = {};
  const rawHeaders: string[] = [];
  for (const [name, value] of webRequest.headers.entries()) {
    const key = name.toLowerCase();
    // Cookie stays a single string: the session resolver rejects duplicate sid
    // pairs from that one canonical field. `rawHeaders` keeps the verbatim
    // name/value pairs for adapters that need multi-value request headers.
    headers[key] = value;
    rawHeaders.push(name, value);
  }
  if (headers.host === undefined) headers.host = parsed.host;

  const { on, off, emit, once } = createEmitter();
  let paused = false;
  let pumping = false;
  let started = false;
  let ended = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const finish = () => {
    if (ended) return;
    ended = true;
    self.readableEnded = true;
    emit('end');
    emit('close');
  };

  const pump = async () => {
    if (pumping || ended || paused || self.destroyed) return;
    pumping = true;
    try {
      if (!started) {
        started = true;
        if (!webRequest.body) { finish(); return; }
        reader = webRequest.body.getReader();
      }
      while (!paused && !ended && !self.destroyed) {
        const { done, value } = await reader!.read();
        if (done) { finish(); return; }
        if (value && value.byteLength > 0) emit('data', toBuffer(value));
      }
    } catch (err) {
      if (!self.destroyed) {
        self.destroyed = true;
        emit('error', err);
      }
    } finally {
      pumping = false;
    }
  };
  const schedulePump = () => {
    if (pumping || ended || paused || self.destroyed) return;
    queueMicrotask(() => { void pump(); });
  };
  // Only a body consumer ('data'/'end') may start the pump. Lifecycle listeners
  // ('aborted'/'close') are attached by the response bridge BEFORE the body
  // reader subscribes; pumping on those would drain the stream into no listeners
  // and leave readRequestBody waiting forever.
  const scheduleFor = (event: string) => {
    if (event === 'data' || event === 'end' || event === 'readable') schedulePump();
  };

  const self: FetchNodeRequest = {
    method: webRequest.method,
    url: parsed.pathname + parsed.search,
    headers,
    rawHeaders,
    socket: { remoteAddress },
    aborted: false,
    destroyed: false,
    readableEnded: false,
    raw: undefined as unknown as FetchNodeRequest,
    on(event, listener) { on(event, listener); scheduleFor(event); return self; },
    off(event, listener) { off(event, listener); return self; },
    once(event, listener) { once(event, listener); scheduleFor(event); return self; },
    emit(event, ...args) { return emit(event, ...args); },
    pause() { paused = true; return self; },
    resume() { paused = false; schedulePump(); return self; },
    destroy(error?: Error) {
      if (self.destroyed) return self;
      self.destroyed = true;
      self.aborted = true;
      void reader?.cancel().catch(() => {});
      if (error) emit('error', error);
      emit('aborted');
      emit('close');
      return self;
    },
  };
  self.raw = self;

  const signal = webRequest.signal;
  if (signal) {
    if (signal.aborted) queueMicrotask(() => self.destroy());
    else signal.addEventListener('abort', () => self.destroy(), { once: true });
  }
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

// Backpressure budget for the Node→Web response bridge. `write` returns false
// past this budget and a `drain` event fires when the Web consumer pulls.
const RESPONSE_HIGH_WATER_BYTES = 64 * 1024;
const RESPONSE_HIGH_WATER_CHUNKS = 16;

function createNodeResponse(nodeReq: FetchNodeRequest) {
  const { on, off, emit, once } = createEmitter();
  const store = new Map<string, string | string[]>();
  const pending: Buffer[] = [];
  let queuedBytes = 0;
  let statusCode = 200;
  let headersSent = false;
  let writableEnded = false;
  let destroyed = false;
  let cancelled = false;
  let wakePull: (() => void) | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  let resolveHead!: () => void;
  const head = new Promise<void>((resolve) => { resolveHead = resolve; });
  const sendHead = () => { headersSent = true; resolveHead(); };
  const notifyPull = () => { const wake = wakePull; wakePull = null; wake?.(); };
  const notifyDrain = () => { emit('drain'); };

  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    async pull(c) {
      while (pending.length === 0 && !writableEnded && !destroyed && !cancelled) {
        await new Promise<void>((resolve) => { wakePull = resolve; });
      }
      if (cancelled) return;
      while (pending.length > 0) c.enqueue(pending.shift()!);
      queuedBytes = 0;
      notifyDrain();
      if ((writableEnded || destroyed) && pending.length === 0) {
        try { c.close(); } catch { /* already closed/cancelled */ }
      }
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      emit('close');
      notifyPull();
    },
  });

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
    flushHeaders() { sendHead(); },
    writeHead(code: number, statusMessageOrHeaders?: string | Record<string, unknown>, maybeHeaders?: Record<string, unknown>) {
      statusCode = code;
      const rawHeaders = typeof statusMessageOrHeaders === 'string' ? maybeHeaders : statusMessageOrHeaders;
      if (rawHeaders && typeof rawHeaders === 'object') {
        for (const [name, value] of Object.entries(rawHeaders)) {
          if (value !== undefined && value !== null) storeHeader(store, name, value as string | string[]);
        }
      }
      sendHead();
      return res;
    },
    write(chunk: unknown) {
      if (writableEnded || destroyed || cancelled) return false;
      const buffer = toBuffer(chunk);
      pending.push(buffer);
      queuedBytes += buffer.length;
      sendHead();
      notifyPull();
      return pending.length < RESPONSE_HIGH_WATER_CHUNKS && queuedBytes < RESPONSE_HIGH_WATER_BYTES;
    },
    end(chunk?: unknown) {
      if (writableEnded || destroyed || cancelled) return res;
      if (chunk !== undefined && chunk !== null) {
        const buffer = toBuffer(chunk);
        pending.push(buffer);
        queuedBytes += buffer.length;
      }
      writableEnded = true;
      sendHead();
      notifyPull();
      emit('finish');
      return res;
    },
    destroy(error?: Error) {
      if (destroyed) return res;
      destroyed = true;
      sendHead();
      emit('close');
      if (error) emit('error', error);
      try { controller?.error(error ?? new Error('response destroyed')); } catch { /* already closed */ }
      notifyPull();
      return res;
    },
    on(event: string, listener: Listener) { on(event, listener); return res; },
    off(event: string, listener: Listener) { off(event, listener); return res; },
    once(event: string, listener: Listener) { once(event, listener); return res; },
    emit(event: string, ...args: any[]) { return emit(event, ...args); },
  };
  return { res, store, stream, head, status: () => statusCode, ended: () => writableEnded || destroyed || cancelled };
}

function buildWebHeaders(store: Map<string, string | string[]>): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [name, value] of store) {
    if (name === 'set-cookie') {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) pairs.push(['set-cookie', String(item)]);
    } else {
      pairs.push([name, Array.isArray(value) ? value.join(', ') : String(value)]);
    }
  }
  return pairs;
}

/**
 * Adapt a Workbench application to a `(request: Request[, server]) => Promise<Response>`
 * handler suitable for `Bun.serve({ fetch })`, `Deno.serve`, Cloudflare Workers,
 * or `node:http` users who already hold a Web Request. Every request runs
 * through the same `makeRequestHandler` spine used by `app.listen()`.
 */
export function createFetchHandler(app: any, opts: FetchHandlerOptions = {}): FetchHandler {
  const handler = makeRequestHandler(app, {
    ...opts,
    db: opts.db ?? app?.db,
    principalOf: opts.principalOf ?? defaultPrincipalOfForApp(app),
    env: opts.env ?? app?.config?.env,
  });
  const env = opts.env ?? app?.config?.env;

  return async (webRequest: Request, server?: any): Promise<Response> => {
    const remoteAddress = opts.remoteAddress
      ?? server?.requestIP?.(webRequest)?.address
      ?? opts.server?.requestIP?.(webRequest)?.address;
    const nodeReq = createNodeRequest(webRequest, { remoteAddress });
    const bridge = createNodeResponse(nodeReq);
    nodeReq.once('close', () => { if (!bridge.ended()) bridge.res.emit('close'); });

    // Run the spine concurrently with the Web response: handlers that write
    // headers early (SSE, Range/206 media) let us return the streaming Response
    // immediately while later chunks are produced under backpressure.
    void (async () => {
      try {
        await handler(nodeReq, bridge.res);
      } catch (err) {
        if (!bridge.ended() && !bridge.res.headersSent) {
          try { renderError(bridge.res, err, { env }); } catch { /* fail closed */ }
        } else if (!bridge.ended()) {
          bridge.res.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        // A handler that already started a response (SSE, paced media) may keep
        // writing after it returns — its `res.stream()` pump owns the tail. Only
        // synthesize an end when nothing was ever written, matching node:http's
        // behavior for a handler that never responds.
        if (!bridge.ended() && !bridge.res.headersSent) bridge.res.end();
      }
    })();

    await bridge.head;
    // node:http suppresses a body on HEAD, and the Web Response contract forbids
    // a body on 204/205/304. Mirror both so a Node-style 204 DELETE maps cleanly.
    const bodyless = webRequest.method === 'HEAD'
      || bridge.status() === 204 || bridge.status() === 205 || bridge.status() === 304;
    return new Response(bodyless ? null : bridge.stream, {
      status: bridge.status(),
      headers: buildWebHeaders(bridge.store),
    });
  };
}
