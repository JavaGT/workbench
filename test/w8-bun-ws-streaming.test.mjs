// w8-bun-ws-streaming.test.mjs — Wave 8 lane w8-bun-ws-streaming.
//
// Three independent promises are verified here:
//   1. createFetchHandler(app) is a production HTTP skin: it derives the same
//      db/session principal source as listen(), streams request and response
//      bodies under backpressure, propagates AbortSignal, keeps header values,
//      and serves Range/206 media.
//   2. A direct `build/strategy/map.mjs` import no longer trips the side-table
//      strategy temporal dead zone.
//   3. createBunServerHandlers upgrades /events through Bun's server.upgrade and
//      delivers committed events over the SAME LiveDeliveryCore (fake-socket
//      parity under Node, real Bun.serve + WebSocket smoke test under Bun).
//
// Everything uses `node:test` so the file runs unchanged under both runtimes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity,
  everyone,
  grant,
  principal,
  read,
  ref,
  scope,
  subscribe,
  text,
  write,
} from '../build/index.mjs';
import { createFetchHandler as fetchFromIndex, createBunServerHandlers as bunFromIndex } from '../build/index.mjs';
import { createFetchHandler as fetchFromServer, createBunServerHandlers as bunFromServer } from '../build/server.mjs';
import { createFetchHandler as fetchFromServe, createBunServerHandlers as bunFromServe } from '../build/serve.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 3000, message = 'condition was not met' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(message);
}

function postEntity() {
  return entity('Post', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [scope(() => everyone()).can(async ({ is }) =>
      (await is.owner()) ? grant(read, write, subscribe) : grant(read),
    )],
  });
}

function seedSession(db, token, principalId) {
  db.prepare('INSERT INTO Session (id, token, principalType, principalId, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run(`s-${principalId}`, createHash('sha256').update(token).digest('hex'), 'user', principalId, Date.now());
}

async function bootApp(t, { entities = [postEntity()], actions = [], middleware } = {}) {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities, actions });
  for (const compiled of entities) app.mount(`/${compiled.name.toLowerCase()}s`, compiled);
  middleware?.(app);
  app.start();
  await app.ready;
  t.after(async () => {
    try { await app.shutdown(); } catch { /* best effort */ }
    try { db.close(); } catch { /* already closed */ }
  });
  return { app, db };
}

// ---------------------------------------------------------------------------
// 1. createFetchHandler(app) — derived defaults, streaming, signals, headers,
//    and Range/206 through the same makeRequestHandler spine.
// ---------------------------------------------------------------------------

test('default session cookie is hydrated without manual principalOf wiring', async (t) => {
  const db = new DatabaseSync(':memory:');
  const post = postEntity();
  const app = workbench({ db, entities: [post] });
  app.mount('/posts', post);
  app.start();
  await app.ready;
  t.after(async () => {
    try { await app.shutdown(); } catch { /* best effort */ }
    try { db.close(); } catch { /* already closed */ }
  });
  const token = 'w8-cookie-session';
  seedSession(db, token, 'alice');

  // Deliberately zero options — this is the contract under test.
  const wired = fetchFromServe(app);
  const anonymous = await wired(new Request('http://localhost/posts'));
  assert.equal(anonymous.status, 401, 'no cookie fails closed');

  const withCookie = await wired(new Request('http://localhost/posts', {
    headers: { cookie: `sid=${token}; theme=dark` },
  }));
  assert.equal(withCookie.status, 200);
  assert.deepEqual(await withCookie.json(), []);

  const created = await wired(new Request('http://localhost/posts', {
    method: 'POST',
    headers: { cookie: `sid=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'from cookie' }),
  }));
  assert.equal(created.status, 201);
  const row = await created.json();
  assert.equal(row.owner, 'alice', 'identity came from the Session row, not the client');
});

test('createFetchHandler is exported from every public entrypoint', () => {
  for (const factory of [fetchFromServe, fetchFromIndex, fetchFromServer]) {
    assert.equal(typeof factory, 'function');
    assert.equal(typeof factory({}), 'function');
  }
  for (const factory of [bunFromServe, bunFromIndex, bunFromServer]) {
    assert.equal(typeof factory, 'function', 'Bun server handler factory is public');
  }
});

test('response bodies stream incrementally instead of buffering until end', async (t) => {
  const { app } = await bootApp(t, {
    entities: [],
    middleware(runtime) {
      runtime.use('/chunks', (_req, res) => {
        const encoder = new TextEncoder();
        let step = 0;
        res.stream(new ReadableStream({
          async pull(controller) {
            if (step === 0) {
              step += 1;
              controller.enqueue(encoder.encode('chunk-1'));
              await delay(250);
              controller.enqueue(encoder.encode('chunk-2'));
              return;
            }
            controller.close();
          },
        }));
      });
    },
  });
  const handler = fetchFromServe(app);
  const startedAt = Date.now();
  const response = await handler(new Request('http://localhost/chunks'));
  assert.equal(response.status, 200);
  assert.ok(response.body, 'a streaming Response body is returned');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  assert.equal(decoder.decode(first.value), 'chunk-1');
  assert.ok(Date.now() - startedAt < 200, 'the first chunk arrived before the delayed second one');
  const second = await reader.read();
  assert.equal(decoder.decode(second.value), 'chunk-2');
  assert.equal((await reader.read()).done, true);
});

test('AbortSignal propagates to the bridged request and response', async (t) => {
  const observed = { aborted: false, closed: false };
  const { app } = await bootApp(t, {
    entities: [],
    middleware(runtime) {
      runtime.use('/abort', (ctxReq, res) => {
        ctxReq.raw.on('aborted', () => { observed.aborted = true; });
        res.raw.on('close', () => { observed.closed = true; });
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.raw.write('started');
      });
    },
  });
  const controller = new AbortController();
  const response = await fetchFromServe(app)(new Request('http://localhost/abort', {
    signal: controller.signal,
  }));
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'started');
  controller.abort();
  await nextTurn();
  assert.equal(observed.aborted, true, "req emitted 'aborted'");
  assert.equal(observed.closed, true, "res emitted 'close'");
  await reader.cancel();
});

test('duplicate request headers and multi-value Set-Cookie survive the bridge', async (t) => {
  const { app } = await bootApp(t, {
    entities: [],
    middleware(runtime) {
      runtime.use('/echo', (ctxReq, res) => {
        res.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2; Path=/']);
        res.json({ rawHeaders: ctxReq.raw.rawHeaders, cookie: ctxReq.raw.headers.cookie });
      });
    },
  });
  const headers = new Headers();
  headers.append('x-tag', 'first');
  headers.append('x-tag', 'second');
  headers.append('cookie', 'theme=dark');
  const response = await fetchFromServe(app)(new Request('http://localhost/echo', { headers }));
  assert.deepEqual(response.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
  const body = await response.json();
  assert.ok(body.rawHeaders.includes('x-tag'));
  assert.equal(body.rawHeaders[body.rawHeaders.indexOf('x-tag') + 1], 'first, second');
  assert.equal(body.cookie, 'theme=dark');
});

test('Range requests are served as streaming 206 partial content', async (t) => {
  const media = Buffer.from('0123456789abcdef');
  const { app } = await bootApp(t, {
    entities: [],
    middleware(runtime) {
      runtime.use('/media', (ctxReq, res) => {
        const match = /^bytes=(\d+)-(\d*)$/.exec(String(ctxReq.raw.headers.range ?? ''));
        if (match) {
          const start = Number(match[1]);
          const end = match[2] ? Math.min(Number(match[2]), media.length - 1) : media.length - 1;
          res.writeHead(206, {
            'content-type': 'application/octet-stream',
            'content-range': `bytes ${start}-${end}/${media.length}`,
            'accept-ranges': 'bytes',
            'content-length': String(end - start + 1),
          });
          res.end(media.subarray(start, end + 1));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(media);
      });
    },
  });
  const response = await fetchFromServe(app)(new Request('http://localhost/media', {
    headers: { range: 'bytes=2-5' },
  }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 2-5/${media.length}`);
  assert.equal(await response.text(), '2345');
});

// ---------------------------------------------------------------------------
// 2. Direct submodule import must not hit the strategy TDZ.
// ---------------------------------------------------------------------------

test('direct import of build/strategy/map.mjs does not throw a TDZ ReferenceError', () => {
  const probe = [
    "import('./build/strategy/map.mjs')",
    "  .then(() => console.log('ok'))",
    "  .catch((err) => { console.error(err); process.exit(1); });",
  ].join('\n');
  const output = execFileSync(process.execPath, ['-e', probe], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(output, /ok/);
});

// ---------------------------------------------------------------------------
// 3. Bun.serve WebSocket seam over the shared LiveDeliveryCore.
// ---------------------------------------------------------------------------

const W8_USER = principal({ type: 'user', id: 'u1' });

function projectEntity() {
  return entity('Project', {
    name: text(),
    grant: () => grant(read, subscribe),
  });
}

function projectAction() {
  return {
    type: 'project.write',
    authorize: ({ principal: caller, payload }) => caller.id === 'u1' && payload.authorized === true,
    handler: ({ payload }) => ({
      events: [{
        type: payload.exists ? 'Project.updated' : 'Project.created',
        scope: `Project:${payload.id}`,
        data: { id: payload.id, name: payload.name },
      }],
    }),
    projections: [{
      eventTypes: ['Project.created', 'Project.updated'],
      apply(event, tx) {
        tx.prepare(`INSERT INTO Project (id, name) VALUES (?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name`).run(event.data.id, event.data.name);
      },
    }],
  };
}

function fakeBunServer() {
  return {
    upgraded: false,
    data: null,
    upgrade(_request, { data }) {
      this.upgraded = true;
      this.data = data;
      return true;
    },
    requestIP: () => ({ address: '127.0.0.1' }),
  };
}

function fakeBunSocket(server) {
  const sent = [];
  return {
    sent,
    data: server.data,
    readyState: 1,
    bufferedAmount: 0,
    send(text) { sent.push(JSON.parse(text)); return text.length; },
    ping() {},
    pong() {},
    close() {},
    terminate() {},
  };
}

function upgradeRequest(origin = 'http://localhost') {
  return new Request('http://localhost/events', {
    headers: {
      upgrade: 'websocket',
      'sec-websocket-key': 'w8-test-key',
      origin,
      host: 'localhost',
    },
  });
}

test('createBunServerHandlers upgrades /events with shared admission and delivers committed events', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [projectEntity()], actions: [projectAction()] });
  const handlers = bunFromServe(app, { principalOf: () => W8_USER });
  assert.equal(handlers.core, app.live.core, 'the published seam owns the one core');
  app.start();
  await app.ready;
  t.after(async () => {
    await handlers.close();
    try { await app.shutdown(); } catch { /* best effort */ }
    try { db.close(); } catch { /* already closed */ }
  });

  const foreignOrigin = await handlers.fetch(upgradeRequest('http://evil.example'), fakeBunServer());
  assert.equal(foreignOrigin.status, 403, 'CSWSH admission matches the node:http skin');

  const server = fakeBunServer();
  const result = await handlers.fetch(upgradeRequest(), server);
  assert.equal(result, undefined, 'a successful Bun upgrade returns no Response');
  assert.equal(server.upgraded, true);

  // Admission needs a row to exist, exactly as on the node:http skin.
  await app.dispatch({
    actionId: 'w8-bun-seed', type: 'project.write', scope: 'Project:p1',
    payload: { id: 'p1', name: 'before', authorized: true }, principal: W8_USER,
  });
  const socket = fakeBunSocket(server);
  handlers.websocket.open(socket);
  handlers.websocket.message(socket, JSON.stringify({ type: 'subscribe', entity: 'Project', id: 'p1' }));
  await waitFor(() => socket.sent.some((frame) => frame.type === 'subscribed'), {
    message: `subscribed acknowledgement was not delivered: ${JSON.stringify(socket.sent)}`,
  });

  await app.dispatch({
    actionId: 'w8-bun-1', type: 'project.write', scope: 'Project:p1',
    payload: { id: 'p1', name: 'after', exists: true, authorized: true }, principal: W8_USER,
  });
  await waitFor(() => socket.sent.some((frame) => frame.type === 'event' && frame.event?.data?.name === 'after'), {
    message: `committed event was not delivered over the Bun socket: ${JSON.stringify(socket.sent)}`,
  });
  const event = socket.sent.find((frame) => frame.type === 'event' && frame.event?.data?.name === 'after');
  assert.equal(event.entity, 'Project');
  assert.equal(event.event.type, 'Project.updated');
  assert.deepEqual(event.event.data, { id: 'p1', name: 'after' });
  handlers.websocket.close(socket, 1000, '');
});

test('real Bun.serve + WebSocket smoke test', async (t) => {
  if (typeof globalThis.Bun === 'undefined') {
    t.skip('Bun runtime is not available');
    return;
  }
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [projectEntity()], actions: [projectAction()] });
  const handlers = bunFromIndex(app, { principalOf: () => W8_USER });
  app.start();
  await app.ready;

  await app.dispatch({
    actionId: 'w8-bun-real-seed', type: 'project.write', scope: 'Project:p2',
    payload: { id: 'p2', name: 'before', authorized: true }, principal: W8_USER,
  });
  const server = globalThis.Bun.serve({ port: 0, ...handlers });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/events`);
  const frames = [];
  ws.addEventListener('message', (event) => frames.push(JSON.parse(event.data)));
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Project', id: 'p2' }));
    await waitFor(() => frames.some((frame) => frame.type === 'subscribed'), {
      message: `Bun WebSocket did not acknowledge the subscription: ${JSON.stringify(frames)}`,
    });

    await app.dispatch({
      actionId: 'w8-bun-real-1', type: 'project.write', scope: 'Project:p2',
      payload: { id: 'p2', name: 'over the wire', exists: true, authorized: true }, principal: W8_USER,
    });
    await waitFor(() => frames.some((frame) => frame.type === 'event' && frame.event?.data?.name === 'over the wire'), {
      message: `Bun WebSocket did not receive the committed event: ${JSON.stringify(frames)}`,
    });
    const event = frames.find((frame) => frame.type === 'event' && frame.event?.data?.name === 'over the wire');
    assert.equal(event.event.type, 'Project.updated');
    assert.deepEqual(event.event.data, { id: 'p2', name: 'over the wire' });
  } finally {
    ws.close();
    server.stop(true);
    await handlers.close();
    try { await app.shutdown(); } catch { /* best effort */ }
    try { db.close(); } catch { /* already closed */ }
  }
});

// ---------------------------------------------------------------------------
// 4. Wave 9 regressions: Bun backpressure, bufferedAmount, close handshake,
//    single live authority, and recovery probe ordering at boot.
// ---------------------------------------------------------------------------

function fakeBunSocketWith(server, {
  sendResult = (text) => text.length,
  bufferedAmount,
  getBufferedAmount,
} = {}) {
  const sent = [];
  let amountCalls = 0;
  let closeCalls = 0;
  let terminateCalls = 0;
  const socket = {
    sent,
    data: server.data,
    readyState: 1,
    send(text) { sent.push(JSON.parse(text)); return sendResult(text); },
    ping() {},
    pong() {},
    close() { closeCalls += 1; },
    terminate() { terminateCalls += 1; },
  };
  if (bufferedAmount !== undefined) socket.bufferedAmount = bufferedAmount;
  if (typeof getBufferedAmount === 'function') {
    socket.getBufferedAmount = () => { amountCalls += 1; return getBufferedAmount(); };
  }
  return {
    socket,
    sent,
    get amountCalls() { return amountCalls; },
    get closeCalls() { return closeCalls; },
    get terminateCalls() { return terminateCalls; },
  };
}

async function bootBunHandlers(t) {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [projectEntity()], actions: [projectAction()] });
  const handlers = bunFromServe(app, { principalOf: () => W8_USER });
  app.start();
  await app.ready;
  t.after(async () => {
    try { await handlers.close(); } catch { /* best effort */ }
    try { await app.shutdown(); } catch { /* best effort */ }
    try { db.close(); } catch { /* already closed */ }
  });
  return { app, db, handlers };
}

async function seedProject(app, id) {
  await app.dispatch({
    actionId: `w9-seed-${id}`, type: 'project.write', scope: `Project:${id}`,
    payload: { id, name: 'before', authorized: true }, principal: W8_USER,
  });
}

test('Bun send() -1 means backpressure: the socket stays open and keeps delivering after drain()', async (t) => {
  const { app, handlers } = await bootBunHandlers(t);
  await seedProject(app, 'bp1');
  const server = fakeBunServer();
  assert.equal(await handlers.fetch(upgradeRequest(), server), undefined);
  const probe = fakeBunSocketWith(server, { sendResult: () => -1 });
  handlers.websocket.open(probe.socket);
  handlers.websocket.message(probe.socket, JSON.stringify({ type: 'subscribe', entity: 'Project', id: 'bp1' }));
  await waitFor(() => probe.sent.some((frame) => frame.type === 'subscribed'), {
    message: `backpressured socket never acknowledged the subscription: ${JSON.stringify(probe.sent)}`,
  });

  await app.dispatch({
    actionId: 'w9-bp-1', type: 'project.write', scope: 'Project:bp1',
    payload: { id: 'bp1', name: 'first', exists: true, authorized: true }, principal: W8_USER,
  });
  await waitFor(() => probe.sent.some((frame) => frame.type === 'event' && frame.event?.data?.name === 'first'), {
    message: `backpressure was treated as fatal: ${JSON.stringify(probe.sent)}`,
  });

  handlers.websocket.drain(probe.socket);
  await app.dispatch({
    actionId: 'w9-bp-2', type: 'project.write', scope: 'Project:bp1',
    payload: { id: 'bp1', name: 'second', exists: true, authorized: true }, principal: W8_USER,
  });
  await waitFor(() => probe.sent.some((frame) => frame.type === 'event' && frame.event?.data?.name === 'second'), {
    message: `socket stopped delivering after drain(): ${JSON.stringify(probe.sent)}`,
  });
  assert.equal(probe.sent.filter((frame) => frame.type === 'event').length, 2);
  handlers.websocket.close(probe.socket, 1000, '');
});

test('Bun getBufferedAmount() is consulted ahead of a stale bufferedAmount property', async (t) => {
  const { app, handlers } = await bootBunHandlers(t);
  await seedProject(app, 'amount1');
  const server = fakeBunServer();
  assert.equal(await handlers.fetch(upgradeRequest(), server), undefined);
  // A property that says "50 MB buffered" would close the connection on the
  // first send if the method were ignored. The method's 0 must win.
  const probe = fakeBunSocketWith(server, {
    bufferedAmount: 50_000_000,
    getBufferedAmount: () => 0,
  });
  handlers.websocket.open(probe.socket);
  handlers.websocket.message(probe.socket, JSON.stringify({ type: 'subscribe', entity: 'Project', id: 'amount1' }));
  await waitFor(() => probe.sent.some((frame) => frame.type === 'subscribed'), {
    message: `socket closed despite a healthy getBufferedAmount(): ${JSON.stringify(probe.sent)}`,
  });
  await app.dispatch({
    actionId: 'w9-amount-1', type: 'project.write', scope: 'Project:amount1',
    payload: { id: 'amount1', name: 'after', exists: true, authorized: true }, principal: W8_USER,
  });
  await waitFor(() => probe.sent.some((frame) => frame.type === 'event' && frame.event?.data?.name === 'after'), {
    message: `committed event was not delivered: ${JSON.stringify(probe.sent)}`,
  });
  assert.ok(probe.amountCalls > 0, 'socket.getBufferedAmount() was consulted');
  handlers.websocket.close(probe.socket, 1000, '');
});

test('fallback bufferedAmount resets on drain so >5 MB of traffic stays connected', { timeout: 30_000 }, async (t) => {
  const { app, handlers } = await bootBunHandlers(t);
  await seedProject(app, 'heavy');
  const server = fakeBunServer();
  assert.equal(await handlers.fetch(upgradeRequest(), server), undefined);
  // Neither getBufferedAmount() nor a bufferedAmount property: the facade's
  // own counter is the authority. Every send reports backpressure, and drain()
  // must clear the counter instead of letting it grow forever.
  const probe = fakeBunSocketWith(server, { sendResult: () => -1 });
  handlers.websocket.open(probe.socket);
  handlers.websocket.message(probe.socket, JSON.stringify({ type: 'subscribe', entity: 'Project', id: 'heavy' }));
  await waitFor(() => probe.sent.some((frame) => frame.type === 'subscribed'));

  const chunk = 'x'.repeat(600_000);
  for (let i = 0; i < 10; i += 1) {
    const name = `${i}:${chunk}`;
    await app.dispatch({
      actionId: `w9-heavy-${i}`, type: 'project.write', scope: 'Project:heavy',
      payload: { id: 'heavy', name, exists: true, authorized: true }, principal: W8_USER,
    });
    await waitFor(() => probe.sent.some((frame) => frame.type === 'event' && frame.event?.data?.name === name), {
      message: `frame ${i} was not delivered — cumulative buffered bytes were not reset on drain()`,
    });
    handlers.websocket.drain(probe.socket);
  }
  assert.equal(probe.sent.filter((frame) => frame.type === 'event').length, 10, 'all 6 MB of traffic was delivered');
  handlers.websocket.close(probe.socket, 1000, '');
});

test('graceful handlers.close() sends a close frame immediately without a 250 ms stall', async (t) => {
  const { handlers } = await bootBunHandlers(t);
  const server = fakeBunServer();
  assert.equal(await handlers.fetch(upgradeRequest(), server), undefined);
  const probe = fakeBunSocketWith(server);
  handlers.websocket.open(probe.socket);
  assert.equal(probe.closeCalls, 0);

  const startedAt = Date.now();
  await handlers.close();
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 250, `graceful close stalled for ${elapsed}ms (250 ms grace timer)`);
  assert.equal(probe.closeCalls, 1, 'one RFC 6455 close frame was sent');
  assert.equal(probe.terminateCalls, 0, 'the open connection was not terminated abruptly');
  handlers.websocket.close(probe.socket, 1000, '');
  assert.equal(probe.closeCalls, 1, 'a repeated close event does not send a second frame');
});

test('an existing app.live core is reused without overwriting the live handle', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const app = workbench({ db, entities: [] });
  const sentinelCore = { wake() {}, close() {} };
  const live = {
    core: sentinelCore,
    createConsumer: () => async () => {},
    wake() {},
    close() {},
  };
  app.live = live;
  const handlers = bunFromServe(app, { principalOf: () => W8_USER });
  assert.equal(handlers.core, sentinelCore, 'the app-owned core is the one authority');
  assert.equal(app.live, live, 'the existing app.live handle is not replaced');
  assert.equal('liveDelivery' in app, false, 'no write-only split liveDelivery field is published');
  await handlers.close();
});

test('an injected core is published on app.live so the kernel registers its consumer', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const app = workbench({ db, entities: [] });
  const injectedCore = { wake() {}, close() {} };
  const handlers = bunFromServe(app, { core: injectedCore, principalOf: () => W8_USER });
  assert.equal(handlers.core, injectedCore);
  assert.equal(app.live.core, injectedCore);
  assert.equal(typeof app.live.createConsumer, 'function', 'kernel.ts can register the live consumer');
  await handlers.close();
});

test('probeRecovery runs before prepareSchema writes DDL/migrations', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [] });
  const order = [];
  const prepareSchema = app.prepareSchema.bind(app);
  app.prepareSchema = async () => { order.push('schema'); return prepareSchema(); };
  app.probeRecovery = () => { order.push('probe'); return { ok: true, checkedAt: new Date().toISOString() }; };
  t.after(async () => {
    try { await app.shutdown(); } catch { /* best effort */ }
    try { db.close(); } catch { /* already closed */ }
  });

  await app.start();
  assert.deepEqual(order.slice(0, 2), ['probe', 'schema'], 'the integrity check precedes schema DDL');
});

test('a failing recovery probe prevents prepareSchema from writing anything', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [] });
  let schemaCalls = 0;
  const prepareSchema = app.prepareSchema.bind(app);
  app.prepareSchema = async () => { schemaCalls += 1; return prepareSchema(); };
  app.probeRecovery = () => ({ ok: false, reason: 'corrupt file', findings: ['page 1 is damaged'] });
  t.after(async () => {
    try { await app.shutdown(); } catch { /* best effort */ }
    try { db.close(); } catch { /* already closed */ }
  });

  await assert.rejects(app.start(), /recovery probe failed: corrupt file \(page 1 is damaged\)/);
  assert.equal(schemaCalls, 0, 'no DDL or migration ran against the unhealthy database');
});
