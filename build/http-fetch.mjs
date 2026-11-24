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

import { makeRequestHandler } from './serve.mjs';

import { renderError } from './middleware.mjs';

// The Node-shaped request the ONE spine sees. It is also the value handed to a
// custom `principalOf`, so a Bearer/session resolver can read `headers` exactly
// as it does under node:http.




































function createEmitter() {
  const listeners = new Map                       ();
  const on = (event        , listener          ) => {
    let set = listeners.get(event);
    if (!set) { set = new Set(); listeners.set(event, set); }
    set.add(listener);
    return true;
  };
  const off = (event        , listener          ) => {
    listeners.get(event)?.delete(listener);
    return true;
  };
  const emit = (event        , ...args       ) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    return listeners.has(event);
  };
  return { on, off, emit };
}

function toBuffer(chunk         )         {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === 'string') return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

// Build a Node-shaped IncomingMessage facade over a Web Request. The Web body
// is buffered once, then replayed through the event interface `http-body.ts`
// and the blob streaming adapter already use. `pause`/`resume` gate that replay
// so backpressure and oversize-body drains behave like a real socket.
function createNodeRequest(webRequest         , bytes            )                   {
  const parsed = new URL(webRequest.url, 'http://localhost');
  const headers                                                = {};
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
      const chunk = chunks[offset++] ;
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

  const self                   = {
    method: webRequest.method,
    url: parsed.pathname + parsed.search,
    headers,
    socket: { remoteAddress: undefined },
    aborted: false,
    destroyed: false,
    readableEnded: false,
    raw: undefined                               ,
    on(event, listener) { on(event, listener); if (event === 'data') schedulePump(); return self; },
    off(event, listener) { off(event, listener); return self; },
    once(event, listener) {
      const wrapped           = (...args) => { off(event, wrapped); listener(...args); };
      on(event, wrapped);
      if (event === 'data') schedulePump();
      return self;
    },
    emit(event, ...args) { return emit(event, ...args); },
    pause() { paused = true; return self; },
    resume() { paused = false; schedulePump(); return self; },
    destroy(error        ) {
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
function storeHeader(store                                , name        , value                   )       {
  const key = name.toLowerCase();
  if (key === 'set-cookie') {
    const previous = store.get(key);
    const values = previous === undefined ? [] : Array.isArray(previous) ? previous : [previous];
    store.set(key, [...values, ...(Array.isArray(value) ? value : [value])]);
    return;
  }
  store.set(key, Array.isArray(value) ? value.join(', ') : value);
}

function createNodeResponse(nodeReq                  ) {
  const { on, off, emit } = createEmitter();
  const store = new Map                           ();
  const chunks           = [];
  let statusCode = 200;
  let headersSent = false;
  let writableEnded = false;
  let destroyed = false;

  const res      = {
    req: nodeReq,
    get statusCode() { return statusCode; },
    get headersSent() { return headersSent; },
    get writableEnded() { return writableEnded; },
    get destroyed() { return destroyed; },
    setHeader(name        , value                   ) { storeHeader(store, name, value); return res; },
    getHeader(name        ) { return store.get(name.toLowerCase()); },
    removeHeader(name        ) { store.delete(name.toLowerCase()); },
    hasHeader(name        ) { return store.has(name.toLowerCase()); },
    getHeaderNames() { return [...store.keys()]; },
    flushHeaders() { headersSent = true; },
    writeHead(code        , statusMessageOrHeaders                                   , maybeHeaders                          ) {
      statusCode = code;
      const rawHeaders = typeof statusMessageOrHeaders === 'string' ? maybeHeaders : statusMessageOrHeaders;
      if (rawHeaders && typeof rawHeaders === 'object') {
        for (const [name, value] of Object.entries(rawHeaders)) {
          if (value !== undefined && value !== null) storeHeader(store, name, value                     );
        }
      }
      headersSent = true;
      return res;
    },
    write(chunk         ) {
      if (writableEnded || destroyed) return false;
      chunks.push(toBuffer(chunk));
      return true;
    },
    end(chunk          ) {
      if (chunk !== undefined && chunk !== null) chunks.push(toBuffer(chunk));
      writableEnded = true;
      emit('finish');
      return res;
    },
    destroy(error        ) {
      destroyed = true;
      if (error) emit('error', error);
      return res;
    },
    on(event        , listener          ) { on(event, listener); return res; },
    off(event        , listener          ) { off(event, listener); return res; },
    once(event        , listener          ) {
      const wrapped           = (...args) => { off(event, wrapped); listener(...args); };
      on(event, wrapped);
      return res;
    },
    emit(event        , ...args       ) { return emit(event, ...args); },
  };
  return { res, store, chunks, status: () => statusCode, ended: () => writableEnded || destroyed };
}

function buildWebResponse(
  statusCode        ,
  store                                ,
  chunks          ,
  method        ,
)           {
  const pairs                          = [];
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
export function createFetchHandler(app     , opts                      = {})               {
  const handler = makeRequestHandler(app, opts);
  return async (webRequest         )                    => {
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
