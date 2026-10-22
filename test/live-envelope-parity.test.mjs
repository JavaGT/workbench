// S3/A7 (JavaGT/workbench#105) — client ingest contract + transport parity +
// diagnostics. One test owns the three-envelope-kind grammar (`event` / `state`
// / `state-invalidate`) round-tripped identically over SSE and WebSocket (both
// present the same owned core), the optimistic-UI reconciliation contract
// (`state` replaces a pending placeholder exactly as a logged `event` does,
// `state-invalidate` forces a resnapshot, derived/operational notifications are
// never authoritative), and the no-row-content diagnostics rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

import { createOwnedLiveDelivery } from '../build/live-delivery-public.mjs';
import { createLiveDeliveryHttpHandler } from '../build/live-delivery-http.mjs';
import { createLiveDeliveryWebSocket } from '../build/live-delivery-websocket.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { envelopeDiagnostics, isAuthoritativeEnvelope } from '../build/event-delivery.mjs';
import { createLiveDeliverySession } from '../public/workbench-client.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- raw WebSocket harness (same pattern as live-delivery-seam.test.mjs) ---

function openRawWS(port) {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    sock.write(
      'GET /live-delivery/events HTTP/1.1\r\n' +
      'Host: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nx-test-user: u1\r\n\r\n`,
    );
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const inbox = [];
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString();
        buf = buf.slice(idx + 4);
        if (!head.startsWith('HTTP/1.1 101')) { reject(new Error('upgrade failed')); return; }
        upgraded = true;
        resolve({ sock, send, nextMessage, close });
      }
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1] & 0x7f;
        let payloadLen = b1;
        let headerLen = 2;
        if (b1 === 126) { if (buf.length < 4) return; payloadLen = buf.readUInt16BE(2); headerLen = 4; }
        if (buf.length < headerLen + payloadLen) return;
        const payload = buf.slice(headerLen, headerLen + payloadLen);
        const opcode = b0 & 0x0f;
        buf = buf.slice(headerLen + payloadLen);
        if (opcode === 0x1) inbox.push(payload.toString('utf-8'));
      }
    });
    sock.on('error', reject);
    function send(text) {
      const payload = Buffer.from(text, 'utf-8');
      const mask = randomBytes(4);
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      let header;
      if (payload.length < 126) { header = Buffer.alloc(2); header[1] = 0x80 | payload.length; }
      else { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
      header[0] = 0x81;
      sock.write(Buffer.concat([header, mask, masked]));
    }
    async function nextMessage(timeoutMs = 1500) {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        if (inbox.length > 0) return JSON.parse(inbox.shift());
        await sleep(20);
      }
      return null;
    }
    function close() { try { sock.destroy(); } catch { /* ignore */ } }
  });
}

// --- SSE frame reader over a fetch ReadableStream ---

const sseBuffers = new WeakMap();

async function nextSseFrame(reader, timeoutMs = 1500) {
  const decoder = new TextDecoder();
  let text = sseBuffers.get(reader) ?? '';
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    let separator;
    while ((separator = text.indexOf('\n\n')) !== -1) {
      const frame = text.slice(0, separator);
      text = text.slice(separator + 2);
      sseBuffers.set(reader, text);
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (data) return JSON.parse(data.slice('data: '.length));
    }
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) break;
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), remaining)),
    ]);
    if (chunk.timedOut || chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    sseBuffers.set(reader, text);
  }
  return null;
}

// --- shared fixtures ---

function makeEntities() {
  const note = {
    name: 'Note',
    tier: 'live',
    fields: { title: { kind: 'value', type: 'text' } },
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
    grant: [],
  };
  const project = {
    name: 'Project',
    fields: { name: { kind: 'value', type: 'text' } },
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
    grant: [],
  };
  return new Map([['Note', note], ['Project', project]]);
}

function makeDb() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  return db;
}

const collectionRule = {
  resourceKind: 'Note',
  select: ['title'],
  sort: [{ field: 'title' }],
  boundedResultPolicy: { limit: 2 },
};

function appendLogEvent(db, scope, seq, type, data = {}) {
  db.prepare(
    `INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(scope, seq, type, JSON.stringify(data), `action-${seq}`, new Date().toISOString());
  db.prepare(
    `INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?)
     ON CONFLICT(scope) DO UPDATE SET lastSeq = excluded.lastSeq`,
  ).run(scope, seq);
}

function bumpRevision(db, key, revision) {
  db.prepare(`INSERT INTO _LiveRevision (resourceKey, revision) VALUES (?, ?)
    ON CONFLICT(resourceKey) DO UPDATE SET revision = excluded.revision`).run(key, revision);
}

async function startServer() {
  const db = makeDb();
  const entities = makeEntities();
  const owned = createOwnedLiveDelivery({
    db,
    entities,
    mayVerb: async () => true,
    includeActionId: false,
  });
  const server = http.createServer();
  const handler = createLiveDeliveryHttpHandler({
    delivery: owned.delivery,
    principalOf: async () => ({ type: 'user', id: 'u1' }),
    path: '/live-delivery',
  });
  server.on('request', (req, res) => {
    handler(req, res).then((handled) => {
      if (!handled && !res.writableEnded) res.writeHead(404).end();
    });
  });
  createLiveDeliveryWebSocket(server, {
    path: '/live-delivery/events',
    core: owned.core,
    principalOf: async () => ({ type: 'user', id: 'u1' }),
    resolveEntity: (name) => entities.get(name),
    mayVerb: async () => true,
    db,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { db, owned, server, origin, port: server.address().port };
}

async function teardown({ owned, server, db, ws, sseController, sseReader }) {
  ws?.close();
  try { await sseReader?.cancel(); } catch { /* ignore */ }
  sseController?.abort();
  await owned.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  db.close();
}

// --- 1. Three envelope kinds round-trip identically over SSE and WebSocket ---

test('SSE and WebSocket deliver identical live `state` replacement envelopes (shared core)', async () => {
  const { db, owned, server, origin } = await startServer();
  db.prepare("INSERT INTO Note (id, title) VALUES (?, ?)").run('n1', 'seed');
  let sseController, sseReader, ws;
  try {
    sseController = new AbortController();
    const sseResponse = await fetch(`${origin}/live-delivery/events?scope=Note%3An1&after=0`, { signal: sseController.signal });
    assert.equal(sseResponse.status, 200);
    sseReader = sseResponse.body.getReader();
    // Preserve any baseline batched with the connection comment.

    ws = await openRawWS(server.address().port);
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
    assert.equal((await ws.nextMessage()).type, 'subscribed');

    db.prepare("UPDATE Note SET title = ? WHERE id = ?").run('first', 'n1');
    bumpRevision(db, 'Note:n1', 1);
    owned.delivery.wake('Note:n1');

    const sseState = (await nextSseFrame(sseReader))[0];
    const wsState = await ws.nextMessage();
    assert.equal(sseState.type, 'state');
    assert.equal(wsState.type, 'state');
    assert.deepEqual(wsState, sseState, 'SSE and WebSocket deliver the identical state envelope');
    assert.deepEqual(wsState, { type: 'state', entity: 'Note', id: 'n1', seq: 1, state: { id: 'n1', title: 'first' } });

    db.prepare("UPDATE Note SET title = ? WHERE id = ?").run('second', 'n1');
    bumpRevision(db, 'Note:n1', 2);
    owned.delivery.wake('Note:n1');

    const sseState2 = (await nextSseFrame(sseReader))[0];
    const wsState2 = await ws.nextMessage();
    assert.equal(sseState2.seq, 2);
    assert.deepEqual(wsState2, sseState2);
    assert.deepEqual(wsState2.state, { id: 'n1', title: 'second' });
  } finally {
    await teardown({ owned, server, db, ws, sseController, sseReader });
  }
});

test('SSE and WebSocket deliver identical collection `state` and `state-invalidate` envelopes (shared core)', async () => {
  const { db, owned, server, origin } = await startServer();
  let sseController, sseReader, ws;
  try {
    sseController = new AbortController();
    const ruleParam = encodeURIComponent(JSON.stringify(collectionRule));
    const sseResponse = await fetch(`${origin}/live-delivery/events?scope=Note&after=0&rule=${ruleParam}`, { signal: sseController.signal });
    assert.equal(sseResponse.status, 200);
    sseReader = sseResponse.body.getReader();
    // Preserve any baseline batched with the connection comment.

    ws = await openRawWS(server.address().port);
    ws.send(JSON.stringify({ type: 'subscribe', scope: 'Note', rule: collectionRule }));
    assert.equal((await ws.nextMessage()).type, 'subscribed');

    await sleep(50);

    // #163: the initial-empty subscription first delivers its authoritative
    // empty baseline (identical on both transports), then the write follows.
    const sseBaseline = (await nextSseFrame(sseReader))[0];
    const wsBaseline = await ws.nextMessage();
    assert.equal(sseBaseline.type, 'state');
    assert.deepEqual(wsBaseline, sseBaseline, 'SSE and WebSocket deliver the identical empty baseline');
    assert.deepEqual(sseBaseline.rows, []);

    db.exec("INSERT INTO Note (id, title) VALUES ('b', 'B'), ('a', 'A')");
    bumpRevision(db, 'Note', 1);
    owned.delivery.wake('Note');

    const sseState = (await nextSseFrame(sseReader))[0];
    const wsState = await ws.nextMessage();
    assert.equal(sseState.type, 'state');
    assert.deepEqual(wsState, sseState, 'SSE and WebSocket deliver the identical collection state envelope');
    assert.equal(sseState.entity, 'Note');
    assert.deepEqual(sseState.rows.map((row) => row.id), ['a', 'b']);

    // Bounded overflow (limit 2, third member) demotes the delivery to
    // `state-invalidate` — identical on both transports.
    db.prepare("INSERT INTO Note (id, title) VALUES (?, ?)").run('c', 'C');
    bumpRevision(db, 'Note', 2);
    owned.delivery.wake('Note');

    const sseInvalidate = (await nextSseFrame(sseReader))[0];
    const wsInvalidate = await ws.nextMessage();
    assert.equal(sseInvalidate.type, 'state-invalidate');
    assert.equal(wsInvalidate.type, 'state-invalidate');
    assert.deepEqual(wsInvalidate, sseInvalidate);
    assert.equal(sseInvalidate.reason, 'bounded-overflow');
    assert.equal(sseInvalidate.seq, 2);
  } finally {
    await teardown({ owned, server, db, ws, sseController, sseReader });
  }
});

test('SSE and WebSocket deliver identical full-log `event` envelopes (shared core)', async () => {
  const { db, owned, server, origin } = await startServer();
  db.prepare("INSERT INTO Project (id, name) VALUES (?, ?)").run('p1', 'seed');
  appendLogEvent(db, 'Project:p1', 1, 'Project.created', { id: 'p1', name: 'seed' });
  let sseController, sseReader, ws;
  try {
    sseController = new AbortController();
    const sseResponse = await fetch(`${origin}/live-delivery/events?scope=Project%3Ap1&after=1`, { signal: sseController.signal });
    assert.equal(sseResponse.status, 200);
    sseReader = sseResponse.body.getReader();
    // Preserve any baseline batched with the connection comment.

    ws = await openRawWS(server.address().port);
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Project', id: 'p1' }));
    assert.equal((await ws.nextMessage()).type, 'subscribed');

    db.prepare("UPDATE Project SET name = ? WHERE id = ?").run('updated', 'p1');
    appendLogEvent(db, 'Project:p1', 2, 'Project.updated', { id: 'p1', name: 'updated' });
    owned.delivery.wake('Project:p1');

    const sseEvent = (await nextSseFrame(sseReader))[0];
    const wsEvent = await ws.nextMessage();
    assert.equal(sseEvent.type, 'event');
    assert.deepEqual(wsEvent, sseEvent, 'SSE and WebSocket deliver the identical event envelope');
    assert.equal(sseEvent.event.type, 'Project.updated');
    assert.deepEqual(sseEvent.event.data, { id: 'p1', name: 'updated' });
  } finally {
    await teardown({ owned, server, db, ws, sseController, sseReader });
  }
});

test('the HTTP SSE seam rejects a malformed rule parameter and round-trips a collection rule', async () => {
  const { db, owned, server, origin } = await startServer();
  let sseController;
  try {
    const bad = await fetch(`${origin}/live-delivery/events?scope=Note&after=0&rule=%7Bnot-json`);
    assert.equal(bad.status, 400);

    sseController = new AbortController();
    const ruleParam = encodeURIComponent(JSON.stringify(collectionRule));
    const ok = await fetch(`${origin}/live-delivery/events?scope=Note&after=0&rule=${ruleParam}`, { signal: sseController.signal });
    assert.equal(ok.status, 200);
    await ok.body.cancel();
    sseController.abort();
    sseController = undefined;
  } finally {
    await teardown({ owned, server, db, sseController });
  }
});

// --- 2. Client ingest contract: authoritative kinds reconcile, invalidation resnapshots, notifications are rejected ---

test('a `state` replacement reconciles a pending placeholder exactly as a logged `event` does', () => {
  const client = createClientModel();
  client.optimistic('op-1', { title: 'pending' });
  assert.equal(client.pendingCount, 1);

  const applied = client.ingest({ type: 'state', entity: 'Note', id: 'n1', seq: 1, state: { id: 'n1', title: 'authoritative' } });
  assert.equal(applied.status, 'applied');
  assert.equal(client.pendingCount, 0, 'an authoritative state replacement reconciles the pending placeholder');
  assert.deepEqual(client.snapshot, { id: 'n1', title: 'authoritative' });

  client.optimistic('op-2', { title: 'pending-2' });
  const appliedEvent = client.ingest({ type: 'event', seq: 2, seqSpan: [2, 2], event: { type: 'Note.updated', data: { title: 'via-event' } } });
  assert.equal(appliedEvent.status, 'applied');
  assert.equal(client.pendingCount, 0, 'a logged event reconciles the placeholder the same way');
});

test('a `state-invalidate` forces a resnapshot and never reconciles a pending placeholder', () => {
  const client = createClientModel({ id: 'n1', title: 'cached' });
  client.optimistic('op-1', { title: 'pending' });

  const result = client.ingest({ type: 'state-invalidate', entity: 'Note', id: 'n1', seq: 5, reason: 'bounded-overflow', rows: [{ id: 'n1', title: 'truncated' }] });
  assert.equal(result.status, 'resnapshot');
  assert.equal(client.resnapshotRequests, 1);
  assert.equal(client.pendingCount, 1, 'invalidation never reconciles the placeholder from invalidated content');
  assert.deepEqual(client.snapshot, { id: 'n1', title: 'cached' }, 'the invalidated content is not adopted');

  // retry: the client refetches a fresh snapshot and reconciliation completes.
  client.ingest({ type: 'state', entity: 'Note', id: 'n1', seq: 6, state: { id: 'n1', title: 'fresh' } });
  assert.equal(client.pendingCount, 0);
  assert.deepEqual(client.snapshot, { id: 'n1', title: 'fresh' });
});

test('derived/operational notifications are rejected as authoritative mutations', () => {
  const client = createClientModel({ id: 'n1', title: 'cached' });
  client.optimistic('op-1', { title: 'pending' });

  const rejected = client.ingest({ type: 'notification', kind: 'job-progress', seq: 9 });
  assert.equal(rejected.status, 'rejected', 'a derived/operational envelope is never authoritative');
  assert.equal(client.pendingCount, 1, 'a notification never reconciles optimistic state');
  assert.equal(client.resnapshotRequests, 0);
  assert.deepEqual(client.snapshot, { id: 'n1', title: 'cached' });

  // A rejection (failed settlement) stays visible and attributable; no
  // notification or invalidation clears it — only authoritative ingest does.
  const failed = client.rejectAction('op-1');
  assert.equal(failed.status, 'rejected-visible');
  assert.equal(client.pendingCount, 1, 'a rejected mutation remains visible and attributable');
  assert.equal(client.ingest({ type: 'state', entity: 'Note', id: 'n1', seq: 4, state: { id: 'n1', title: 'after-rejection' } }).status, 'applied');
  assert.equal(client.pendingCount, 0, 'authoritative ingest still reconciles after a visible rejection');
});

test('duplicate-delivery of a replacement is tolerated without double-apply', () => {
  const client = createClientModel();
  assert.equal(client.ingest({ type: 'state', entity: 'Note', id: 'n1', seq: 3, state: { id: 'n1', title: 'once' } }).status, 'applied');
  assert.equal(client.ingest({ type: 'state', entity: 'Note', id: 'n1', seq: 3, state: { id: 'n1', title: 'once' } }).status, 'duplicate');
  assert.deepEqual(client.snapshot, { id: 'n1', title: 'once' });
  assert.equal(client.appliedCount, 1);
});

// --- 3. Diagnostics: resource kind + revision only, never row content ---

test('envelope diagnostics name kind + revision only and exclude all row content', () => {
  const secret = 'super-sensitive-row-value';
  const envelope = {
    type: 'state',
    entity: 'Note',
    id: 'n1',
    seq: 7,
    state: { id: 'n1', title: secret },
    rows: [{ id: 'n1', title: secret }],
    delta: { title: secret },
  };
  const diagnostics = envelopeDiagnostics(envelope);
  assert.deepEqual(diagnostics, { kind: 'state', entity: 'Note', id: 'n1', seq: 7 });
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes(secret), false, 'protected row content never reaches diagnostics');
  assert.equal(serialized.includes('title'), false, 'diagnostics carry no field names');
  assert.deepEqual(Object.keys(diagnostics).sort(), ['entity', 'id', 'kind', 'seq'], 'the diagnostic context is a closed key set');
});

test('authoritative-kinds classifier distinguishes authoritative ingest from recovery and notifications', () => {
  assert.equal(isAuthoritativeEnvelope({ type: 'event' }), true);
  assert.equal(isAuthoritativeEnvelope({ type: 'state' }), true);
  assert.equal(isAuthoritativeEnvelope({ type: 'resync' }), false);
  assert.equal(isAuthoritativeEnvelope({ type: 'state-invalidate' }), false);
  assert.equal(isAuthoritativeEnvelope({ type: 'notification' }), false);
  assert.equal(isAuthoritativeEnvelope({ type: 'annotated-text-caret' }), false);
  assert.equal(isAuthoritativeEnvelope(null), false);
});

test('an oversized SSE state frame demotes to state-invalidate and logs kind + revision only', async () => {
  const logs = [];
  const subscriptions = [];
  const delivery = {
    bootstrap: async () => ({ kind: 'revoked' }),
    catchup: async () => ({ kind: 'revoked' }),
    subscribe(input) { subscriptions.push(input); return { activate: async () => input.after }; },
  };
  const handler = createLiveDeliveryHttpHandler({
    delivery,
    principalOf: async () => ({ type: 'user', id: 'u1' }),
    path: '/live-delivery',
    log: { error() {}, warn(channel, message, context) { logs.push({ channel, message, context }); } },
  });
  const server = http.createServer((req, res) => handler(req, res).then((handled) => { if (!handled) res.writeHead(404).end(); }));
  server.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  let controller;
  try {
    controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/live-delivery/events?scope=Note%3An1&after=0`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await reader.read(); // `: connected` comment

    const secret = 'x'.repeat(2 * 1024 * 1024);
    await subscriptions[0].deliver([{
      type: 'state', entity: 'Note', id: 'n1', seq: 3,
      state: { id: 'n1', title: secret },
    }]);

    const frame = await nextSseFrame(reader, 1500);
    assert.equal(frame[0].type, 'state-invalidate', 'an oversized state frame demotes to the kind-consistent recovery control');
    assert.equal(frame[0].seq, 3);
    assert.equal(frame[0].reason, 'recipient-snapshot-required');

    assert.equal(logs.length, 1);
    const context = logs[0].context;
    assert.equal(context.scope, 'Note:n1');
    assert.deepEqual(context.envelope, { kind: 'state', entity: 'Note', id: 'n1', seq: 3 });
    assert.equal(JSON.stringify(logs).includes(secret), false, 'the oversized-frame diagnostic leaks no row content');
    await reader.cancel();
  } finally {
    controller?.abort();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- client ingest model: authoritative reconcile / invalidate resnapshot / reject non-authoritative ---

function createClientModel(initialSnapshot = null) {
  const pending = new Map(); // actionId -> placeholder
  let snapshot = initialSnapshot;
  let cursor = 0;
  let resnapshotRequests = 0;
  let appliedCount = 0;
  return {
    get snapshot() { return snapshot; },
    get pendingCount() { return pending.size; },
    get resnapshotRequests() { return resnapshotRequests; },
    get appliedCount() { return appliedCount; },
    optimistic(actionId, placeholder) { pending.set(actionId, placeholder); },
    rejectAction(actionId) {
      if (!pending.has(actionId)) return { status: 'unknown' };
      // The rejected mutation stays visible and attributable until only an
      // authoritative ingest reconciles it.
      return { status: 'rejected-visible', actionId };
    },
    ingest(envelope) {
      if (envelope?.type === 'state') {
        if (envelope.seq <= cursor) return { status: 'duplicate' };
        cursor = envelope.seq;
        snapshot = envelope.state ?? null;
        for (const actionId of [...pending.keys()]) pending.delete(actionId);
        appliedCount += 1;
        return { status: 'applied' };
      }
      if (envelope?.type === 'event') {
        if (envelope.seq <= cursor) return { status: 'duplicate' };
        cursor = envelope.seq;
        snapshot = envelope.event?.data ?? null;
        for (const actionId of [...pending.keys()]) pending.delete(actionId);
        appliedCount += 1;
        return { status: 'applied' };
      }
      if (envelope?.type === 'state-invalidate' || envelope?.type === 'resync') {
        resnapshotRequests += 1;
        return { status: 'resnapshot' };
      }
      // Derived/operational and unknown kinds are explicitly NOT authoritative
      // (consideration #23): they never reconcile, invalidate, or advance.
      return { status: 'rejected' };
    },
  };
}

// --- real-client ingest: the shipped createLiveDeliverySession runtime ---
// The model above proves the intended contract; these tests prove the same
// contract through the real client receive()/applyState() path.

function createRealClient() {
  let deliverBatch;
  let bootstraps = 0;
  const session = createLiveDeliverySession({
    bootstrap: async () => {
      bootstraps += 1;
      return { kind: 'snapshot', snapshot: { id: 'n1', title: `snap-${bootstraps}` }, cursor: bootstraps === 1 ? 0 : 5 };
    },
    subscribe: async ({ deliver }) => { deliverBatch = deliver; return { close() {} }; },
    validateSnapshot: (snapshot) => snapshot,
    fold: (snapshot) => snapshot,
    optimistic: (snapshot) => snapshot,
    sendAction: async () => ({ ok: true }),
    createActionId: (() => { let n = 0; return () => `op-real-${++n}`; })(),
  });
  return {
    session,
    bootstraps: () => bootstraps,
    deliver: async (envelopes) => deliverBatch(envelopes),
  };
}

test('the shipped client reconciles a pending placeholder from an authoritative `state` replacement', async () => {
  const { session, deliver } = createRealClient();
  await session.ready;
  assert.deepEqual(session.snapshot, { id: 'n1', title: 'snap-1' });

  const dispatched = await session.dispatch('Note.update', { title: 'pending' });
  assert.equal(session.pendingCount(), 1);

  await deliver([{ type: 'state', entity: 'Note', id: 'n1', seq: 1, state: { id: 'n1', title: 'authoritative' } }]);
  assert.deepEqual(session.snapshot, { id: 'n1', title: 'authoritative' }, 'a state envelope replaces the model exactly as a logged event does');
  assert.equal(session.pendingCount(), 0, 'the authoritative replacement reconciles the pending placeholder');
  assert.deepEqual(await dispatched.settlement.wait(), { opId: dispatched.opId, status: 'reconciled' });
  session.close();
});

test('a `state-invalidate` triggers a resnapshot through the shipped client', async () => {
  const { session, deliver, bootstraps } = createRealClient();
  await session.ready;
  assert.equal(bootstraps(), 1);

  await deliver([{ type: 'state-invalidate', entity: 'Note', id: 'n1', seq: 5, reason: 'bounded-overflow', rows: [{ id: 'n1', title: 'truncated' }] }]);
  assert.equal(bootstraps(), 2, 'a state-invalidate boundary forces a fresh replacement snapshot');
  assert.deepEqual(session.snapshot, { id: 'n1', title: 'snap-2' }, 'the resnapshot replaces the cached state');
  assert.equal(session.cursor, 5, 'the cursor comes from the authoritative replacement snapshot');
  session.close();
});

test('a notification is safely ignored as non-authoritative through the shipped client', async () => {
  const { session, deliver, bootstraps } = createRealClient();
  await session.ready;

  const dispatched = await session.dispatch('Note.update', { title: 'pending' });
  assert.equal(session.pendingCount(), 1);
  void dispatched;

  await deliver([{ type: 'notification', kind: 'job-progress', seq: 9 }]);
  assert.equal(session.pendingCount(), 1, 'a notification never reconciles optimistic state');
  assert.deepEqual(session.snapshot, { id: 'n1', title: 'snap-1' }, 'a notification never mutates the model');
  assert.equal(bootstraps(), 1, 'a notification never triggers a resnapshot');

  // The delivery batch resolves rather than throwing a transport/session failure.
  const rejected = session.dispatch('Note.update', { title: 'still-pending' });
  await deliver([{ type: 'notification', kind: 'job-progress', seq: 10 }]);
  assert.equal(session.pendingCount(), 2);
  await rejected;
  session.close();
});
