// Non-lifecycle durable operations are recipient-opaque. The committed log
// triggers snapshot recovery; canonical map/list operation data never crosses
// the live-delivery boundary.
//
// All tests use raw WebSocket against a direct createLiveServer + compiled entity
// (mirrors live-delta.test.mjs and live-pace.test.mjs).

import { text, map, list, ref, scope, everyone, grant, read, write, subscribe } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

import {
  entity, generateDDL, executeFrameworkDDL, createLiveServer } from '../build/internal.mjs';

// --- test entity ---

const User = entity('User', {
    name: text(),

  grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
});

const Doc = entity('Doc', {
    title: text(),
  collaborators: map(ref('User'), { role: ['viewer', 'editor'] }),
  items: list(text()),

  grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
});

// --- raw WebSocket harness (mirrors live-delta.test.mjs) ---

function openRawWS(port, userId = 'test') {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    const handshake =
      'GET /events HTTP/1.1\r\n' +
      'Host: localhost\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n' +
      (userId != null ? `x-test-user: ${userId}\r\n` : '') +
      '\r\n';

    let buf = Buffer.alloc(0);
    let upgraded = false;
    const inbox = [];

    sock.on('connect', () => sock.write(handshake));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString();
        buf = buf.slice(idx + 4);
        if (!head.startsWith('HTTP/1.1 101')) {
          reject(new Error('upgrade failed: ' + head.split('\r\n')[0]));
          return;
        }
        upgraded = true;
        resolve({ sock, send, nextMessage, nextResync, close });
      }
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1] & 0x7f;
        let payloadLen = b1;
        let headerLen = 2;
        if (b1 === 126) { if (buf.length < 4) return; payloadLen = buf.readUInt16BE(2); headerLen = 4; }
        else if (b1 === 127) { if (buf.length < 10) return; payloadLen = Number(buf.readBigUInt64BE(2)); headerLen = 10; }
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
      if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[1] = 0x80 | payload.length;
      } else if (payload.length <= 0xffff) {
        header = Buffer.alloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      }
      header[0] = 0x81;
      sock.write(Buffer.concat([header, mask, masked]));
    }

    async function nextMessage(timeoutMs = 400) {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        if (inbox.length > 0) return JSON.parse(inbox.shift());
        await new Promise((r) => setTimeout(r, 20));
      }
      return null;
    }

    async function nextResync(timeoutMs = 400) {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        while (inbox.length > 0) {
          const msg = JSON.parse(inbox.shift());
          if (msg.type === 'resync') return msg;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      return null;
    }

    function close() { try { sock.destroy(); } catch { /* ignore */ } }
  });
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- bootstrap: direct createLiveServer (mirrors live-delta.test.mjs) ---

function bootServer() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  for (const sql of generateDDL(User)) db.exec(sql);
  for (const sql of generateDDL(Doc)) db.exec(sql);

  const httpServer = http.createServer();
  const boundDoc = Doc.bind({ db, entityOf: (decl) => decl });
  const live = createLiveServer(httpServer, {
    path: '/events',
    mayVerb: async () => true,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: () => boundDoc,
  });

  httpServer.listen(0);
  return { db, httpServer, live, boundDoc };
}

function appendNativeAndWake(db, live, id, seq, type, data) {
  const scope = `Doc:${id}`;
  db.prepare(
    `INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(scope, seq, type, JSON.stringify(data), `action-${id}-${seq}`, new Date().toISOString());
  db.prepare(
    `INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?)
     ON CONFLICT(scope) DO UPDATE SET lastSeq = excluded.lastSeq`,
  ).run(scope, seq);
  live.wake(scope);
}

function assertOpaqueRecovery(resync, id, seq, secret) {
  assert.deepEqual(resync, {
    type: 'resync', entity: 'Doc', id, seq, reason: 'recipient-snapshot-required',
  });
  assert.equal(JSON.stringify(resync).includes(secret), false);
}

// Helper: subscribe and wait for ack (named wsSubscribe to avoid collision with
// the imported `subscribe` grant-capability used in the entity declaration).
async function wsSubscribe(ws, entity, id) {
  ws.send(JSON.stringify({ type: 'subscribe', entity, id }));
  return ws.nextMessage();
}

// ============================================================
// Test 1: map `.added` recovery
// ============================================================

test('native map additions require recipient snapshot recovery', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const id = 'doc-test1';

  try {
    db.prepare('INSERT INTO Doc (id, title) VALUES (?, ?)').run(id, 'D1');
    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Doc', id))?.type, 'subscribed');

    appendNativeAndWake(db, live, id, 1, 'Doc.collaborators.added', { owner: id, member: 'u2', role: 'viewer' });
    assertOpaqueRecovery(await ws.nextResync(), id, 1, 'viewer');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 2: map `.roleChanged` recovery
// ============================================================

test('native map role changes require recipient snapshot recovery', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const id = 'doc-test2';

  try {
    db.prepare('INSERT INTO Doc (id, title) VALUES (?, ?)').run(id, 'D2');
    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Doc', id))?.type, 'subscribed');

    appendNativeAndWake(db, live, id, 1, 'Doc.collaborators.roleChanged', { owner: id, member: 'u2', role: 'editor' });
    assertOpaqueRecovery(await ws.nextResync(), id, 1, 'editor');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 3: map `.removed` recovery
// ============================================================

test('native map removals require recipient snapshot recovery', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const id = 'doc-test3';

  try {
    db.prepare('INSERT INTO Doc (id, title) VALUES (?, ?)').run(id, 'D3');
    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Doc', id))?.type, 'subscribed');

    appendNativeAndWake(db, live, id, 1, 'Doc.collaborators.removed', { owner: id, member: 'u2' });
    assertOpaqueRecovery(await ws.nextResync(), id, 1, 'u2');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 4: ordered `.inserted` recovery
// ============================================================

test('native ordered inserts require recipient snapshot recovery', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const id = 'doc-test4';

  try {
    db.prepare('INSERT INTO Doc (id, title) VALUES (?, ?)').run(id, 'D4');
    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Doc', id))?.type, 'subscribed');

    appendNativeAndWake(db, live, id, 1, 'Doc.items.inserted', { owner: id, id: 'item-secret', key: 'a', value: 'first' });
    assertOpaqueRecovery(await ws.nextResync(), id, 1, 'item-secret');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 5: ordered `.moved` recovery
// ============================================================

test('native ordered moves require recipient snapshot recovery', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const id = 'doc-test5';

  try {
    db.prepare('INSERT INTO Doc (id, title) VALUES (?, ?)').run(id, 'D5');
    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Doc', id))?.type, 'subscribed');

    appendNativeAndWake(db, live, id, 1, 'Doc.items.moved', { owner: id, id: 'i1', key: 'b' });
    assertOpaqueRecovery(await ws.nextResync(), id, 1, 'i1');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 6: paced subscriptions also receive opaque recovery
// ============================================================

test('paced subscriptions receive opaque native recovery immediately', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const id = 'doc-test6';

  try {
    db.prepare('INSERT INTO Doc (id, title) VALUES (?, ?)').run(id, 'D6');
    ws = await openRawWS(port, 'alice');
    // Subscribe with pace (profile '15fps' is accepted by pace validator).
    // Doc has no ephemeral field, so durable recovery is not paced.
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Doc', id, pace: { profile: '15fps' } }));
    assert.equal((await ws.nextMessage())?.type, 'subscribed');

    appendNativeAndWake(db, live, id, 1, 'Doc.collaborators.added', { owner: id, member: 'u2', role: 'viewer' });
    assertOpaqueRecovery(await ws.nextResync(), id, 1, 'viewer');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 7: recovery contains no event envelope
// ============================================================

test('native recovery has no raw event envelope', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const id = 'doc-test7';

  try {
    db.prepare('INSERT INTO Doc (id, title) VALUES (?, ?)').run(id, 'D7');
    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Doc', id))?.type, 'subscribed');

    appendNativeAndWake(db, live, id, 1, 'Doc.collaborators.added', { owner: id, member: 'u2', role: 'editor' });
    const resync = await ws.nextResync();
    assertOpaqueRecovery(resync, id, 1, 'editor');
    assert.equal(Object.hasOwn(resync, 'event'), false);
    assert.equal(Object.hasOwn(resync, 'delta'), false);
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});
