import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';

import workbench, { router, entity } from '../build/internal.mjs';
import { allowAnonymous, text, ref, scope, grant, read, write, subscribe } from '../build/index.mjs';
import { createLiveDeliveryWebSocket } from '../build/live-delivery-websocket.mjs';
import { createLiveDeliveryHttpHandler, DEFAULT_BOOTSTRAP_LIMIT } from '../build/live-delivery-http.mjs';
import { isSameOriginRequest, resolveClientIp, isTrustedProxy } from '../build/middleware.mjs';
import {
  negotiateEncoding,
  sendJson,
  pumpWebStreamToResponse,
} from '../build/http-response.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { createOwnedLiveDelivery } from '../build/live-delivery-public.mjs';

function makeMaskedFrame(textPayload) {
  const payload = Buffer.from(textPayload, 'utf-8');
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x81;
  return Buffer.concat([header, mask, masked]);
}

function rawHttpRequest(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function makeNoteDb() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'seed');
  const note = {
    name: 'Note',
    tier: 'live',
    fields: { title: { kind: 'value', type: 'text' } },
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
    grant: [],
  };
  return { db, entities: new Map([['Note', note]]) };
}

// =============================================================================
// 1. WebSocket (`ws`) transport hardening
// =============================================================================

test('WS: negotiates permessage-deflate by default and allows disabling it', async () => {
  for (const perMessageDeflate of [true, false]) {
    const server = http.createServer();
    const wsTransport = createLiveDeliveryWebSocket(server, {
      path: '/events',
      perMessageDeflate,
      heartbeatIntervalMs: false,
    });
    server.listen(0);
    await once(server, 'listening');
    const { port } = server.address();

    try {
      let upgradeResponseHeaders = null;
      const client = new WebSocket(`ws://127.0.0.1:${port}/events`, {
        perMessageDeflate: true,
      });
      client.on('upgrade', (res) => { upgradeResponseHeaders = res.headers; });
      await once(client, 'open');

      if (perMessageDeflate) {
        assert.ok(
          String(upgradeResponseHeaders['sec-websocket-extensions'] || '').includes('permessage-deflate'),
          'expected permessage-deflate extension to be negotiated',
        );
      } else {
        assert.equal(upgradeResponseHeaders['sec-websocket-extensions'], undefined);
      }

      // Send a message and confirm normal JSON error response over the upgraded socket.
      const msgPromise = once(client, 'message');
      client.send(JSON.stringify({ type: 'unknown-check', requestId: 'c1' }));
      const [raw] = await msgPromise;
      const parsed = JSON.parse(raw.toString('utf8'));
      assert.equal(parsed.type, 'error');
      assert.equal(parsed.requestId, 'c1');

      client.close(1000);
      await once(client, 'close');
    } finally {
      await wsTransport.close();
      await new Promise((r) => server.close(r));
    }
  }
});

test('WS: forwards head buffer bytes pipelined with the HTTP upgrade request', async () => {
  const { db, entities } = makeNoteDb();
  const owned = createOwnedLiveDelivery({ db, entities, mayVerb: async () => true, includeActionId: false });
  const server = http.createServer();
  const wsTransport = createLiveDeliveryWebSocket(server, {
    path: '/events',
    core: owned.core,
    principalOf: () => ({ type: 'user', id: 'u1' }),
    resolveEntity: (name) => entities.get(name),
    mayVerb: async () => true,
    db,
    heartbeatIntervalMs: false,
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const key = randomBytes(16).toString('base64');
    const upgradeReq = Buffer.from(
      'GET /events HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${port}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n' +
      '\r\n',
      'utf8',
    );
    // Pipeline the first masked WS frame right behind the HTTP upgrade headers
    // in the same TCP write so Node delivers it in the `head` buffer!
    const pipelinedFrame = makeMaskedFrame(JSON.stringify({ type: 'subscribe', requestId: 99, entity: 'Note', id: 'n1' }));

    const responseMsg = await new Promise((resolve, reject) => {
      const sock = tcpConnect(port, '127.0.0.1');
      let buf = Buffer.alloc(0);
      let upgraded = false;
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('timed out waiting for pipelined subscribe ack')); }, 3000);

      sock.on('connect', () => {
        sock.write(Buffer.concat([upgradeReq, pipelinedFrame]));
      });
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const status = buf.subarray(0, idx).toString('utf8');
          assert.ok(status.startsWith('HTTP/1.1 101'), `expected 101, got ${status}`);
          buf = buf.subarray(idx + 4);
          upgraded = true;
        }
        while (buf.length >= 2) {
          const opcode = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let headerLen = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); headerLen = 4; }
          if (buf.length < headerLen + len) return;
          const payload = buf.subarray(headerLen, headerLen + len);
          buf = buf.subarray(headerLen + len);
          if (opcode === 0x1) {
            clearTimeout(timer);
            sock.destroy();
            resolve(JSON.parse(payload.toString('utf8')));
            return;
          }
        }
      });
      sock.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    assert.equal(responseMsg.type, 'subscribed');
    assert.equal(responseMsg.requestId, 99);
    assert.equal(responseMsg.scope, 'Note:n1');
  } finally {
    await wsTransport.close();
    owned.close();
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test('WS: retires 64 KiB outgoing cap and enforces configurable maxPayload on incoming frames', async () => {
  const { db, entities } = makeNoteDb();
  const owned = createOwnedLiveDelivery({ db, entities, mayVerb: async () => true, includeActionId: false });
  const server = http.createServer();
  const wsTransport = createLiveDeliveryWebSocket(server, {
    path: '/events',
    core: owned.core,
    principalOf: () => ({ type: 'user', id: 'u1' }),
    resolveEntity: (name) => entities.get(name),
    mayVerb: async () => true,
    db,
    maxPayload: 4096,
    heartbeatIntervalMs: false,
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();

  try {
    // 1. Outgoing payload > 64 KiB (200 KiB) succeeds without disconnecting!
    const client = new WebSocket(`ws://127.0.0.1:${port}/events`);
    await once(client, 'open');

    const messages = [];
    client.on('message', (data) => messages.push(JSON.parse(data.toString('utf8'))));

    client.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
    while (messages.length < 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(messages[0].type, 'subscribed');

    const largeTitle = 'L'.repeat(200 * 1024);
    db.prepare('UPDATE Note SET title = ? WHERE id = ?').run(largeTitle, 'n1');
    db.prepare(`INSERT INTO _LiveRevision (resourceKey, revision) VALUES ('Note:n1', 1)
      ON CONFLICT(resourceKey) DO UPDATE SET revision = 1`).run();
    owned.delivery.wake('Note:n1');

    const deadline = Date.now() + 3000;
    while (messages.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(messages.length, 2, 'expected large >64KiB state envelope to arrive');
    assert.equal(messages[1].type, 'state');
    assert.equal(messages[1].state.title.length, 200 * 1024);
    assert.equal(client.readyState, WebSocket.OPEN, 'socket must remain open after >64KiB outgoing frame');

    client.close(1000);
    await once(client, 'close');

    // 2. Incoming frame exceeding configured maxPayload (4096) is rejected with 1009.
    const oversizedClient = new WebSocket(`ws://127.0.0.1:${port}/events`);
    await once(oversizedClient, 'open');
    const closePromise = once(oversizedClient, 'close');
    oversizedClient.send(JSON.stringify({ type: 'ping-test', pad: 'x'.repeat(8192) }));
    const [closeCode] = await closePromise;
    assert.equal(closeCode, 1009, 'oversized incoming payload must close with 1009');
  } finally {
    await wsTransport.close();
    owned.close();
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test('WS: Ping/Pong heartbeat keeps live clients open, reaps silent sockets, and closes cleanly with 1000', async () => {
  const server = http.createServer();
  const wsTransport = createLiveDeliveryWebSocket(server, {
    path: '/events',
    heartbeatIntervalMs: 50,
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();

  try {
    // Active ws client automatically answers server pings with pongs.
    let pingsReceived = 0;
    const healthy = new WebSocket(`ws://127.0.0.1:${port}/events`);
    healthy.on('ping', () => { pingsReceived += 1; });
    await once(healthy, 'open');

    // Silent raw TCP client completes upgrade but NEVER replies to pings.
    const silentSock = tcpConnect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      silentSock.on('connect', () => {
        silentSock.write(
          'GET /events HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      silentSock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.includes('\r\n\r\n')) resolve();
      });
      silentSock.on('error', reject);
    });

    assert.equal(wsTransport.count(), 2);

    // Wait for silent socket to be reaped (should happen within ~3 intervals).
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('silent socket was not reaped')), 2000);
      silentSock.once('close', () => { clearTimeout(timer); resolve(); });
    });

    assert.equal(wsTransport.count(), 1, 'dead socket removed from connection registry');
    assert.equal(healthy.readyState, WebSocket.OPEN, 'healthy client stayed open');
    assert.ok(pingsReceived >= 1, 'server initiated at least one ping');

    // Server-initiated close performs a clean RFC 6455 close handshake (code 1000).
    const healthyClose = once(healthy, 'close');
    await wsTransport.close();
    const [code] = await healthyClose;
    assert.equal(code, 1000, 'server close should complete RFC 6455 close handshake with code 1000');
  } finally {
    await wsTransport.close();
    await new Promise((r) => server.close(r));
  }
});

// =============================================================================
// 2. HTTP compression & bootstrap limit
// =============================================================================

test('HTTP compression: negotiates br > gzip, respects q=0, and compresses JSON/text >= 1 KiB with Vary', async (t) => {
  assert.equal(negotiateEncoding('gzip, deflate, br'), 'br');
  assert.equal(negotiateEncoding('gzip;q=1.0, br;q=0.5'), 'gzip');
  assert.equal(negotiateEncoding('br;q=0, gzip;q=0.8'), 'gzip');
  assert.equal(negotiateEncoding('br;q=0, gzip;q=0'), null);
  assert.equal(negotiateEncoding(undefined), null);

  const r = router();
  const largeJson = { items: Array.from({ length: 120 }, (_, i) => ({ id: i, text: 'hello-workbench-compression' })) };
  const smallJson = { ok: true };
  const largeText = 'compression-text-line\n'.repeat(100);

  r.get('/large-json', allowAnonymous(), (_req, res) => res.json(largeJson));
  r.get('/small-json', allowAnonymous(), (_req, res) => res.json(smallJson));
  r.get('/large-text', allowAnonymous(), (_req, res) => res.send(largeText));

  const app = workbench().mount('/api', r);
  app.listen(0, { cors: { origins: ['https://app.example.com'] } });
  await app.ready;
  t.after(() => app.shutdown());
  const { port } = app.httpServer.address();

  // Brotli preferred when both br & gzip advertised, and Vary merges Origin + Accept-Encoding.
  const brRes = await rawHttpRequest(port, {
    path: '/api/large-json',
    headers: { 'accept-encoding': 'gzip, br', origin: 'https://app.example.com' },
  });
  assert.equal(brRes.status, 200);
  assert.equal(brRes.headers['content-encoding'], 'br');
  assert.ok(brRes.headers['vary']?.includes('Origin'));
  assert.ok(brRes.headers['vary']?.includes('Accept-Encoding'));
  assert.deepEqual(JSON.parse(brotliDecompressSync(brRes.body).toString('utf8')), largeJson);
  assert.ok(brRes.body.length < Buffer.byteLength(JSON.stringify(largeJson)));

  // Gzip when only gzip advertised.
  const gzipRes = await rawHttpRequest(port, {
    path: '/api/large-json',
    headers: { 'accept-encoding': 'gzip' },
  });
  assert.equal(gzipRes.status, 200);
  assert.equal(gzipRes.headers['content-encoding'], 'gzip');
  assert.equal(gzipRes.headers['vary'], 'Accept-Encoding');
  assert.deepEqual(JSON.parse(gunzipSync(gzipRes.body).toString('utf8')), largeJson);

  // Small payload (< 1 KiB) is NOT compressed.
  const smallRes = await rawHttpRequest(port, {
    path: '/api/small-json',
    headers: { 'accept-encoding': 'br, gzip' },
  });
  assert.equal(smallRes.status, 200);
  assert.equal(smallRes.headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(smallRes.body.toString('utf8')), smallJson);

  // Large text response via res.send() compresses too.
  const textRes = await rawHttpRequest(port, {
    path: '/api/large-text',
    headers: { 'accept-encoding': 'gzip' },
  });
  assert.equal(textRes.status, 200);
  assert.equal(textRes.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(textRes.body).toString('utf8'), largeText);
});

test('sendJson honors compress: false option and leaves small payloads untouched', () => {
  let writtenHeaders = null;
  let writtenBody = null;
  const mockRes = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    req: { method: 'GET', url: '/big', headers: { 'accept-encoding': 'br, gzip' } },
    writeHead(_status, headers) { writtenHeaders = headers; this.headersSent = true; },
    end(body) { writtenBody = body; this.writableEnded = true; },
  };
  const payload = { data: 'a'.repeat(4096) };
  sendJson(mockRes, 200, payload, {}, { compress: false });
  assert.equal(writtenHeaders['content-encoding'], undefined);
  assert.equal(writtenBody, JSON.stringify(payload));
});

test('live-delivery-http: default bootstrap limit is 64 MiB, configurable, and supports compressed large transcripts', async () => {
  assert.equal(DEFAULT_BOOTSTRAP_LIMIT, 64 * 1024 * 1024);

  // 18 MiB repetitive JSON transcript — previously 400'd under hardcoded 16 MiB cap!
  const bigTranscript = 'Speaker A: Qualitative interview transcript line.\n'.repeat(380_000);
  assert.ok(Buffer.byteLength(bigTranscript) > 16 * 1024 * 1024);

  const delivery = {
    async bootstrap() {
      return { kind: 'snapshot', snapshot: { transcript: bigTranscript }, cursor: 42 };
    },
    async catchup() {
      return { kind: 'catchup', envelopes: [], cursor: 42 };
    },
    async subscribe() {
      return { activate: async () => 42 };
    },
  };

  // Use a tight configured bootstrapLimit (512 KiB) to prove compressed response
  // stays well under the limit while uncompressed rejects cleanly with 400.
  const handler = createLiveDeliveryHttpHandler({
    delivery,
    principalOf: () => ({ type: 'user', id: 'u1' }),
    bootstrapLimit: 512 * 1024,
  });
  const server = http.createServer((req, res) => handler(req, res).then((handled) => {
    if (!handled && !res.writableEnded) res.writeHead(404).end();
  }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();

  try {
    // Compressed bootstrap succeeds even for an >18 MiB transcript under a 512 KiB wire cap.
    const gz = await rawHttpRequest(port, {
      path: '/live-delivery/bootstrap?scope=Doc%3Ad1&mode=snapshot',
      headers: { 'accept-encoding': 'gzip' },
    });
    assert.equal(gz.status, 200);
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.headers['vary'], 'Accept-Encoding');
    const decoded = JSON.parse(gunzipSync(gz.body).toString('utf8'));
    assert.equal(decoded.cursor, 42);
    assert.equal(decoded.snapshot.transcript.length, bigTranscript.length);

    // Uncompressed bootstrap exceeding bootstrapLimit still fails closed with 400.
    const raw = await rawHttpRequest(port, {
      path: '/live-delivery/bootstrap?scope=Doc%3Ad1&mode=snapshot',
      headers: { 'accept-encoding': 'identity' },
    });
    assert.equal(raw.status, 400);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// =============================================================================
// 3. HTTP methods (HEAD/PUT), streaming backpressure, trustedProxies & CORS
// =============================================================================

test('router() supports head() and put(), with proper CSRF enforcement on PUT and safe HEAD', async (t) => {
  const r = router();
  r.head('/ping', allowAnonymous(), (_req, res) => {
    res.setHeader('x-pong', 'yes');
    res.sendStatus(200);
  });
  r.put('/items/:id', allowAnonymous(), (req, res) => {
    res.json({ id: req.params.id, body: req.body });
  });

  const app = workbench().mount('/api', r);
  app.listen(0);
  await app.ready;
  t.after(() => app.shutdown());
  const { port } = app.httpServer.address();
  const base = `http://127.0.0.1:${port}`;

  // HEAD works and is safe even with a foreign Origin.
  const headRes = await fetch(`${base}/api/ping`, {
    method: 'HEAD',
    headers: { origin: 'https://other.example' },
  });
  assert.equal(headRes.status, 200);
  assert.equal(headRes.headers.get('x-pong'), 'yes');
  assert.equal(await headRes.text(), '');

  // PUT works same-origin.
  const putOk = await fetch(`${base}/api/items/42`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ name: 'updated' }),
  });
  assert.equal(putOk.status, 200);
  assert.deepEqual(await putOk.json(), { id: '42', body: { name: 'updated' } });

  // PUT is mutating, so foreign Origin is rejected by CSRF (403).
  const putCsrf = await fetch(`${base}/api/items/42`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ name: 'forged' }),
  });
  assert.equal(putCsrf.status, 403);
});

test('res.stream() respects backpressure (awaits drain), aborts on close, and unifies X-Accel-Buffering', async (t) => {
  // 1. Direct backpressure unit test on pumpWebStreamToResponse:
  //    producer must pause when nodeRes.write() returns false until 'drain' fires.
  const events = [];
  const listeners = new Map();
  const mockRes = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(_status, headers) { this.headers = headers; this.headersSent = true; },
    write(chunk) {
      events.push(`write:${chunk.toString('utf8')}`);
      return false; // signal backpressure on every write
    },
    end() { this.writableEnded = true; events.push('end'); },
    once(ev, fn) {
      const list = listeners.get(ev) ?? [];
      list.push(fn);
      listeners.set(ev, list);
    },
    off(ev, fn) {
      const list = listeners.get(ev) ?? [];
      listeners.set(ev, list.filter((f) => f !== fn));
    },
    emit(ev, ...args) {
      const list = [...(listeners.get(ev) ?? [])];
      listeners.set(ev, []);
      for (const fn of list) fn(...args);
    },
  };

  let pullCount = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pullCount += 1;
      events.push(`pull:${pullCount}`);
      if (pullCount <= 2) {
        controller.enqueue(new TextEncoder().encode(`c${pullCount}`));
      } else {
        controller.close();
      }
    },
  }, { highWaterMark: 0 });

  const pumpPromise = pumpWebStreamToResponse(mockRes, stream, { buffering: false, defaultContentType: 'text/plain' });
  await new Promise((r) => setTimeout(r, 20));
  // First chunk written, waiting on drain — second chunk MUST NOT have been written yet!
  assert.equal(events.filter((e) => e.startsWith('write:')).length, 1);
  assert.equal(mockRes.headers['x-accel-buffering'], 'no');

  mockRes.emit('drain');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(events.filter((e) => e.startsWith('write:')).length, 2);

  mockRes.emit('drain');
  await pumpPromise;
  assert.equal(mockRes.writableEnded, true);
  assert.deepEqual(events.filter((e) => e.startsWith('write:') || e === 'end'), ['write:c1', 'write:c2', 'end']);

  // 2. Client disconnect ('close') while awaiting drain aborts pump and cancels reader.
  let cancelled = false;
  const slowListeners = new Map();
  const abortedRes = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead() { this.headersSent = true; },
    write() { return false; },
    end() { this.writableEnded = true; },
    destroy() { this.destroyed = true; },
    once(ev, fn) { slowListeners.set(ev, [...(slowListeners.get(ev) ?? []), fn]); },
    off(ev, fn) { slowListeners.set(ev, (slowListeners.get(ev) ?? []).filter((f) => f !== fn)); },
    emit(ev, ...args) {
      const list = [...(slowListeners.get(ev) ?? [])];
      slowListeners.set(ev, []);
      for (const fn of list) fn(...args);
    },
  };
  const infiniteStream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    cancel() { cancelled = true; },
  });
  const abortPump = pumpWebStreamToResponse(abortedRes, infiniteStream);
  await new Promise((r) => setTimeout(r, 15));
  abortedRes.destroyed = true;
  abortedRes.emit('close');
  await abortPump;
  assert.equal(cancelled, true, 'upstream reader must be cancelled on response close');

  // 3. Unified X-Accel-Buffering across BOTH router() and app.use():
  //    buffering: false → X-Accel-Buffering: no; buffering: true → omitted.
  const r = router();
  r.get('/no-buf', allowAnonymous(), (_req, res) => res.stream(new Response('a'), { buffering: false }));
  r.get('/yes-buf', allowAnonymous(), (_req, res) => res.stream(new Response('b'), { buffering: true }));

  const app = workbench()
    .use('/use-no-buf', (_req, res) => res.stream(new Response('c'), { buffering: false }))
    .use('/use-yes-buf', (_req, res) => res.stream(new Response('d'), { buffering: true }))
    .mount('/r', r);
  app.listen(0);
  await app.ready;
  t.after(() => app.shutdown());
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;

  const rNo = await fetch(`${base}/r/no-buf`);
  assert.equal(rNo.headers.get('x-accel-buffering'), 'no');
  assert.equal(await rNo.text(), 'a');

  const rYes = await fetch(`${base}/r/yes-buf`);
  assert.equal(rYes.headers.get('x-accel-buffering'), null);
  assert.equal(await rYes.text(), 'b');

  const uNo = await fetch(`${base}/use-no-buf`);
  assert.equal(uNo.headers.get('x-accel-buffering'), 'no');
  assert.equal(await uNo.text(), 'c');

  const uYes = await fetch(`${base}/use-yes-buf`);
  assert.equal(uYes.headers.get('x-accel-buffering'), null);
  assert.equal(await uYes.text(), 'd');
});

test('trustedProxies: fail-closed default, X-Forwarded-Host/Proto CSRF, and X-Forwarded-For rate-limiting', async (t) => {
  // Unit checks for isTrustedProxy / resolveClientIp / isSameOriginRequest
  assert.equal(isTrustedProxy('127.0.0.1'), false);
  assert.equal(isTrustedProxy('127.0.0.1', false), false);
  assert.equal(isTrustedProxy('127.0.0.1', true), true);
  assert.equal(isTrustedProxy('::ffff:127.0.0.1', ['127.0.0.1']), true);
  assert.equal(isTrustedProxy('10.20.30.40', ['10.0.0.0/8']), true);
  assert.equal(isTrustedProxy('192.168.1.5', ['10.0.0.0/8']), false);
  assert.equal(isTrustedProxy('10.0.0.5', (ip) => ip.startsWith('10.')), true);

  // Untrusted peer: X-Forwarded-For is ignored.
  assert.equal(
    resolveClientIp({ headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '198.51.100.1' } }, false),
    '198.51.100.1',
  );
  assert.equal(
    resolveClientIp({ headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '198.51.100.1' } }, ['10.0.0.1']),
    '198.51.100.1',
  );
  // Trusted proxy chain: skips trusted hops right-to-left, preventing client XFF spoofing.
  assert.equal(
    resolveClientIp(
      { headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9, 10.0.0.2' }, socket: { remoteAddress: '10.0.0.1' } },
      ['10.0.0.0/8'],
    ),
    '203.0.113.9',
  );
  // `trustedProxies: true` falls back to leftmost hop.
  assert.equal(
    resolveClientIp(
      { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' }, socket: { remoteAddress: '10.0.0.1' } },
      true,
    ),
    '203.0.113.9',
  );

  // Same-origin behind trusted proxy vs untrusted
  const proxiedReq = {
    headers: {
      host: '127.0.0.1:3000',
      'x-forwarded-host': 'app.example.com',
      'x-forwarded-proto': 'https',
      origin: 'https://app.example.com',
    },
    socket: { remoteAddress: '::ffff:127.0.0.1' },
  };
  assert.equal(isSameOriginRequest(proxiedReq), false, 'default fail-closed rejects forwarded host');
  assert.equal(isSameOriginRequest(proxiedReq, { trustedProxies: ['10.0.0.1'] }), false, 'untrusted peer rejects forwarded host');
  assert.equal(isSameOriginRequest(proxiedReq, { trustedProxies: ['127.0.0.1'] }), true, 'trusted proxy honors X-Forwarded-Host/Proto');
  assert.equal(
    isSameOriginRequest({
      ...proxiedReq,
      headers: { ...proxiedReq.headers, origin: 'http://app.example.com' },
    }, { trustedProxies: ['127.0.0.1'] }),
    false,
    'protocol mismatch against X-Forwarded-Proto fails closed',
  );

  // End-to-end HTTP test: CSRF + rate-limit with trustedProxies enabled vs disabled.
  function ownedNote() {
    return entity('Note', {
      body: text(),
      owner: ref('User', { role: 'owner', readonly: true }),
      grant: () => [scope(({ is }) => is.owner()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : grant(read))],
    });
  }

  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, {
    principalOf: () => ({ id: 'u1' }),
    trustedProxies: ['127.0.0.1'],
    rateLimit: { ip: { windowMs: 60_000, max: 2 } },
  });
  await app.ready;
  t.after(async () => { await app.shutdown(); db.close(); });
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;

  // Trusted proxy: X-Forwarded-Host + X-Forwarded-Proto passes CSRF for client A (2 requests allowed, 3rd → 429).
  for (let i = 0; i < 2; i += 1) {
    const ok = await fetch(`${base}/notes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://scope.example.com',
        'x-forwarded-host': 'scope.example.com',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '203.0.113.10',
      },
      body: JSON.stringify({ body: `msg-${i}` }),
    });
    assert.equal(ok.status, 201);
  }
  const limited = await fetch(`${base}/notes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://scope.example.com',
      'x-forwarded-host': 'scope.example.com',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.10',
    },
    body: JSON.stringify({ body: 'msg-3' }),
  });
  assert.equal(limited.status, 429);

  // Different client IP behind the same trusted proxy gets its own rate-limit bucket!
  const otherClient = await fetch(`${base}/notes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://scope.example.com',
      'x-forwarded-host': 'scope.example.com',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.11',
    },
    body: JSON.stringify({ body: 'other-client' }),
  });
  assert.equal(otherClient.status, 201);

  // Foreign origin still rejected even behind trusted proxy.
  const csrfDenied = await fetch(`${base}/notes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://evil.example.com',
      'x-forwarded-host': 'scope.example.com',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.12',
    },
    body: JSON.stringify({ body: 'forged' }),
  });
  assert.equal(csrfDenied.status, 403);
});

test('CORS: explicit origin sets credentials + expanded methods/headers/expose-headers; wildcard never sets credentials', async (t) => {
  // 1. Explicit allowlist
  const app1 = workbench();
  app1.listen(0, { cors: { origins: ['https://app.example.com'] } });
  await app1.ready;
  t.after(() => app1.shutdown());
  const base1 = `http://127.0.0.1:${app1.httpServer.address().port}`;

  const preflight = await fetch(`${base1}/health`, {
    method: 'OPTIONS',
    headers: { origin: 'https://app.example.com', 'access-control-request-method': 'PUT' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.example.com');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(preflight.headers.get('vary'), 'Origin');

  const methods = preflight.headers.get('access-control-allow-methods') ?? '';
  for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.ok(methods.includes(m), `expected ${m} in Access-Control-Allow-Methods: ${methods}`);
  }
  const allowHeaders = preflight.headers.get('access-control-allow-headers') ?? '';
  for (const h of ['content-type', 'Authorization', 'Range', 'X-Workbench-Action-Id']) {
    assert.ok(allowHeaders.includes(h), `expected ${h} in Access-Control-Allow-Headers: ${allowHeaders}`);
  }

  const getRes = await fetch(`${base1}/health`, {
    headers: { origin: 'https://app.example.com' },
  });
  assert.equal(getRes.status, 200);
  assert.equal(getRes.headers.get('access-control-allow-origin'), 'https://app.example.com');
  assert.equal(getRes.headers.get('access-control-allow-credentials'), 'true');
  const expose = getRes.headers.get('access-control-expose-headers') ?? '';
  for (const h of ['Content-Range', 'Accept-Ranges', 'Content-Length', 'ETag', 'x-workbench-seq', 'x-workbench-action-id']) {
    assert.ok(expose.includes(h), `expected ${h} in Access-Control-Expose-Headers: ${expose}`);
  }

  // 2. Wildcard origin must NEVER emit Access-Control-Allow-Credentials
  const app2 = workbench();
  app2.listen(0, { cors: { origins: ['*'] } });
  await app2.ready;
  t.after(() => app2.shutdown());
  const base2 = `http://127.0.0.1:${app2.httpServer.address().port}`;

  const wildPreflight = await fetch(`${base2}/health`, {
    method: 'OPTIONS',
    headers: { origin: 'https://any.example.com', 'access-control-request-method': 'GET' },
  });
  assert.equal(wildPreflight.status, 204);
  assert.equal(wildPreflight.headers.get('access-control-allow-origin'), '*');
  assert.equal(wildPreflight.headers.get('access-control-allow-credentials'), null);

  const wildGet = await fetch(`${base2}/health`, {
    headers: { origin: 'https://any.example.com' },
  });
  assert.equal(wildGet.status, 200);
  assert.equal(wildGet.headers.get('access-control-allow-origin'), '*');
  assert.equal(wildGet.headers.get('access-control-allow-credentials'), null);
});
