import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

import { createWebSocketLiveDelivery, createLiveServer } from '../build/live-delivery.mjs';
import { createAuthorizationAdapter } from '../build/authorization-adapter.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { scope } from '../build/scope.mjs';
import { grant, read, write, subscribe } from '../build/grant.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- raw WebSocket harness (same pattern as live-delta.test.mjs) ---

function openRawWS(port) {
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
      'x-test-user: u1\r\n' +
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
        resolve({ sock, send, nextMessage, nextEvent, nextResync, close });
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

    async function nextMessage(timeoutMs = 1000) {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        if (inbox.length > 0) return JSON.parse(inbox.shift());
        await new Promise((r) => setTimeout(r, 20));
      }
      return null;
    }

    async function nextEvent(timeoutMs = 1000) {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        while (inbox.length > 0) {
          const msg = JSON.parse(inbox.shift());
          if (msg.type === 'event') return msg;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      return null;
    }

    async function nextResync(timeoutMs = 1000) {
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

    function close() {
      try { sock.destroy(); } catch { /* ignore */ }
    }
  });
}

// --- helpers ---

function makeNoteEntity() {
  return {
    name: 'Note',
    hydrate: (row) => ({ ...row }),
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    fields: { title: { kind: 'value' } },
    grant: [scope(() => true).can(() => grant(read, write, subscribe))],
  };
}

function makeLiveNoteEntity() {
  return { ...makeNoteEntity(), tier: 'live' };
}

function makeAnnotatedTextEntity() {
  return {
    name: 'Doc',
    hydrate: (row) => ({ ...row }),
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    fields: { body: { kind: 'annotatedText' } },
    grant: [scope(() => true).can(() => grant(read, write, subscribe))],
  };
}

function appendEvent(db, scope, seq, type, data = {}) {
  db.prepare(
    `INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(scope, seq, type, JSON.stringify(data), `action-${seq}`, new Date().toISOString());
  db.prepare(
    `INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?)
     ON CONFLICT(scope) DO UPDATE SET lastSeq = excluded.lastSeq`,
  ).run(scope, seq);
}

// A mayVerb that passes everything except the Nth call, which blocks until
// release() — a deterministic seam to hold one subscribe at a chosen await.
function gateMayVerbCall(gateCall) {
  let calls = 0;
  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const mayVerb = async () => {
    calls += 1;
    if (calls === gateCall) {
      entered();
      await releasePromise;
    }
    return true;
  };
  return { mayVerb, enteredPromise, release };
}

// --- tests ---

test('createWebSocketLiveDelivery is the framework WebSocket seam (createLiveServer is the same function)', () => {
  assert.equal(createLiveServer, createWebSocketLiveDelivery);
});

test('createWebSocketLiveDelivery exposes no public durable fanout', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)`);
  db.prepare(`INSERT INTO Note (id, title) VALUES (?, ?)`).run('n1', 'hello');

  const httpServer = http.createServer();
  const live = createWebSocketLiveDelivery(httpServer, {
    path: '/events',
    mayVerb: async () => true,
    principalOf: () => ({ type: 'user', id: 'u1' }),
    db,
    resolveEntity: () => makeNoteEntity(),
  });

  assert.equal(live.emit, undefined);
  assert.equal(typeof live.count, 'function');
  assert.equal(typeof live.close, 'function');
  assert.equal(typeof live.createConsumer, 'function');
  assert.equal(live.count(), 0);

  const consumer = live.createConsumer({
    entities: new Map([
      ['Note', {
        name: 'Note',
        hydrate: (row) => ({ ...row, hydrated: true }),
        scopeFilter: () => ({ sql: '1=1', params: {} }),
      }],
    ]),
  });
  assert.equal(typeof consumer, 'function');

  // Consumer should not throw on empty or malformed events.
  await consumer([], { db });
  await consumer(
    [{ scope: 'Note:n1', type: 'Note.updated', seq: 1, data: { id: 'n1', title: 'x' } }],
    { db },
  );

  live.close();
  httpServer.close();
});

test('WebSocket subscribe receives ack, consumer delivers core-projected event via WS, not fanout', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n1', 'hello', 'u1', 'public');

  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const httpServer = http.createServer();
  const live = createWebSocketLiveDelivery(httpServer, {
    mayVerb: async () => true,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Note' ? makeNoteEntity() : null,
    log: null,
  });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    // Subscribe
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));

    // Verify subscribed ack
    const ack = await ws.nextMessage();
    assert.ok(ack, 'subscribed ack received');
    if (ack.type === 'error') {
      console.error('subscribe error:', JSON.stringify(ack));
    }
    assert.equal(ack.type, 'subscribed', `expected subscribed but got ${JSON.stringify(ack)}`);
    assert.equal(ack.scope, 'Note:n1');
    assert.equal(ack.entity, 'Note');
    assert.equal(ack.id, 'n1');
    assert.ok(Number.isSafeInteger(ack.currentSeq), 'currentSeq is present');

    // Append a committed event to _Log AFTER subscription
    db.prepare(`UPDATE Note SET title = ? WHERE id = ?`).run('world', 'n1');
    appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'world' });

    // Call the post-commit consumer — this is what the kernel calls.
    const consumer = live.createConsumer({
      entities: new Map([['Note', makeNoteEntity()]]),
    });
    await consumer([{ scope: 'Note:n1', type: 'Note.updated', seq: 2, data: { title: 'world' } }], { db });

    await sleep(100);

    // Verify event arrives via WS (core-projected delivery).
    const ev = await ws.nextEvent(200);
    assert.ok(ev, 'event received via WS');
    assert.equal(ev.type, 'event');
    assert.equal(ev.entity, 'Note');
    assert.equal(ev.id, 'n1');
    assert.equal(ev.seq, 2);
    assert.equal(ev.event.type, 'Note.updated');
    assert.equal(ev.event.data.title, 'world');
    assert.deepEqual(ev.seqSpan, [2, 2]);

    // Verify no extra events (only one event delivered).
    const extra = await ws.nextEvent(100);
    assert.equal(extra, null, 'no extra event delivered');
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

test('WebSocket acknowledges the live revision rather than the historical log cursor', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)`);
  db.prepare(`INSERT INTO Note (id, title) VALUES (?, ?)`).run('n1', 'hello');
  db.prepare(`INSERT INTO _LiveRevision (resourceKey, revision) VALUES (?, ?)`).run('Note:n1', 4);
  const httpServer = http.createServer();
  const live = createWebSocketLiveDelivery(httpServer, {
    mayVerb: async () => true,
    principalOf: () => ({ type: 'user', id: 'u1' }),
    db,
    resolveEntity: (name) => name === 'Note' ? makeLiveNoteEntity() : null,
  });
  httpServer.listen(0);

  try {
    const ws = await openRawWS(httpServer.address().port);
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
    const ack = await ws.nextMessage();
    assert.equal(ack?.type, 'subscribed');
    assert.equal(ack?.currentSeq, 4);
    ws.close();
  } finally {
    live.close();
    httpServer.close();
  }
});

test('live subscription admission + re-authorization run through the injected adapter (S5/A2 single path)', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n1', 'hello', 'u1', 'public');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const inner = createAuthorizationAdapter();
  const calls = [];
  const spy = {
    admit: async (input) => {
      calls.push(input);
      return inner.admit(input);
    },
    registerResource: (input) => inner.registerResource(input),
  };

  const httpServer = http.createServer();
  const live = createWebSocketLiveDelivery(httpServer, {
    mayVerb: async () => true,
    authorization: spy,
    principalOf: () => ({ type: 'user', id: 'u1' }),
    db,
    resolveEntity: (name) => name === 'Note' ? makeNoteEntity() : null,
    log: null,
  });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
    const ack = await ws.nextMessage();
    assert.ok(ack, 'subscribed ack received');
    assert.equal(ack.type, 'subscribed', `expected subscribed but got ${JSON.stringify(ack)}`);
    const subscribeAdmits = calls.filter((c) => c.category === 'entity' && c.verb === 'subscribe');
    assert.ok(subscribeAdmits.length >= 1, 'subscribe-time admission ran through the injected adapter');
    assert.equal(subscribeAdmits[0].operation, 'subscribe');

    // A committed event triggers core re-authorization — through the SAME adapter.
    const beforeCommit = calls.length;
    db.prepare(`UPDATE Note SET title = ? WHERE id = ?`).run('world', 'n1');
    appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'world' });
    const consumer = live.createConsumer({ entities: new Map([['Note', makeNoteEntity()]]) });
    await consumer([{ scope: 'Note:n1', type: 'Note.updated', seq: 2, data: { title: 'world' } }], { db });
    await sleep(100);
    assert.ok(calls.length > beforeCommit, 're-authorization after a commit also ran through the injected adapter');
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

test('an injected adapter denial blocks the live subscription (no subscribed ack)', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n1', 'hello', 'u1', 'public');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const denying = {
    admit: async (input) => ({
      admitted: false,
      operation: { operation: 'subscribe' },
      resourceCategory: input.category,
      resourceId: input.resourceId ?? null,
      reasonCode: 'no-capability',
      capabilities: [],
      trace: null,
    }),
    registerResource: () => {},
  };

  const httpServer = http.createServer();
  const live = createWebSocketLiveDelivery(httpServer, {
    mayVerb: async () => true,
    authorization: denying,
    principalOf: () => ({ type: 'user', id: 'u1' }),
    db,
    resolveEntity: (name) => name === 'Note' ? makeNoteEntity() : null,
    log: null,
  });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
    const msg = await ws.nextMessage();
    assert.equal(msg?.type, 'error', 'a denied subscription surfaces as an error, never a subscribed ack');
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

test('annotated-text/native operated event produces resync, not raw event data', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Doc (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('d1', 'doc', 'u1', 'public');

  appendEvent(db, 'Doc:d1', 1, 'Doc.created', { title: 'doc' });

  const httpServer = http.createServer();
  const live = createWebSocketLiveDelivery(httpServer, {
    mayVerb: async () => true,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Doc' ? makeAnnotatedTextEntity() : null,
    log: null,
  });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    // Subscribe
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Doc', id: 'd1' }));

    // Verify subscribed ack
    const ack = await ws.nextMessage();
    assert.ok(ack, 'subscribed ack received');
    assert.equal(ack.type, 'subscribed');
    assert.equal(ack.scope, 'Doc:d1');

    // Append an annotated-text native operated event to _Log AFTER subscription
    // The event type follows the convention: Entity.field.operated
    appendEvent(db, 'Doc:d1', 2, 'Doc.body.operated', { id: 'd1', ops: [{ type: 'insert', pos: 0, text: 'raw' }] });

    // Call the post-commit consumer
    const consumer = live.createConsumer({
      entities: new Map([['Doc', makeAnnotatedTextEntity()]]),
    });
    await consumer([{ scope: 'Doc:d1', type: 'Doc.body.operated', seq: 2, data: { ops: [{ type: 'insert', pos: 0, text: 'raw' }] } }], { db });

    await sleep(100);

    // Verify resync message arrives, NOT an event with raw data.
    const resync = await ws.nextResync(200);
    assert.ok(resync, 'resync message received');
    assert.equal(resync.type, 'resync');
    assert.equal(resync.entity, 'Doc');
    assert.equal(resync.id, 'd1');
    assert.equal(resync.seq, 2);
    assert.equal(resync.reason, 'annotated-text-snapshot-required');

    // Verify NO raw event message was delivered
    const raw = await ws.nextEvent(100);
    assert.equal(raw, null, 'no raw event delivered for annotated-text operated');

    // Verify no other unexpected messages
    const other = await ws.nextMessage(50);
    assert.equal(other, null, 'no other messages delivered');
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

function makeDocWithEphemeralEntity() {
  return {
    name: 'Doc',
    hydrate: (row) => ({ ...row }),
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    fields: { body: { kind: 'annotatedText' }, cursor: { kind: 'ephemeral' } },
    grant: [scope(() => true).can(() => grant(read, write, subscribe))],
  };
}

test('(R1) one connection with two entity scopes, unsubscribe one, subsequent commit for the other is delivered', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n1', 'a', 'u1', 'public');
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n2', 'b', 'u1', 'public');

  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'a' });
  appendEvent(db, 'Note:n2', 1, 'Note.created', { title: 'b' });

  const httpServer = http.createServer();
  const live = createWebSocketLiveDelivery(httpServer, {
    mayVerb: async () => true,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Note' ? makeNoteEntity() : null,
    log: null,
  });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    // Subscribe to both scopes
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
    const ack1 = await ws.nextMessage();
    assert.equal(ack1.type, 'subscribed');
    assert.equal(ack1.scope, 'Note:n1');

    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n2' }));
    const ack2 = await ws.nextMessage();
    assert.equal(ack2.type, 'subscribed');
    assert.equal(ack2.scope, 'Note:n2');

    // Unsubscribe from n1
    ws.send(JSON.stringify({ type: 'unsubscribe', entity: 'Note', id: 'n1' }));
    const unsub = await ws.nextMessage();
    assert.equal(unsub.type, 'unsubscribed');
    assert.equal(unsub.scope, 'Note:n1');

    // Append a committed event to Note:n1 AFTER unsubscribing
    appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'a-ignored' });
    const consumer = live.createConsumer({
      entities: new Map([['Note', makeNoteEntity()]]),
    });
    await consumer([{ scope: 'Note:n1', type: 'Note.updated', seq: 2, data: { title: 'a-ignored' } }], { db });
    await sleep(100);

    // Verify no event for n1 (unsubscribed)
    const ev1 = await ws.nextEvent(150);
    assert.equal(ev1, null, 'no event for unsubscribed scope n1');

    // Append a committed event to Note:n2 — should still be delivered
    db.prepare(`UPDATE Note SET title = ? WHERE id = ?`).run('b-delivered', 'n2');
    appendEvent(db, 'Note:n2', 2, 'Note.updated', { title: 'b-delivered' });
    await consumer([{ scope: 'Note:n2', type: 'Note.updated', seq: 2, data: { title: 'b-delivered' } }], { db });
    await sleep(100);

    const ev2 = await ws.nextEvent(200);
    assert.ok(ev2, 'event for n2 delivered after n1 unsubscribe');
    assert.equal(ev2.entity, 'Note');
    assert.equal(ev2.id, 'n2');
    assert.equal(ev2.seq, 2);
    assert.equal(ev2.event.data.title, 'b-delivered');

    // Verify no extra events
    const extra = await ws.nextEvent(100);
    assert.equal(extra, null, 'no extra events');
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

test('(R1b) terminal reauthorization denial revokes with an error frame; connection and other scope stay alive', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n1', 'ok', 'u1', 'public');
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n2', 'ok', 'u1', 'public');

  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'ok' });
  appendEvent(db, 'Note:n2', 1, 'Note.created', { title: 'ok' });

  const httpServer = http.createServer();
  const live = createWebSocketLiveDelivery(httpServer, {
    mayVerb: async () => true,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Note' ? makeNoteEntity() : null,
    log: null,
  });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
    const ack1 = await ws.nextMessage();
    assert.equal(ack1.type, 'subscribed');
    assert.equal(ack1.scope, 'Note:n1');

    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n2' }));
    const ack2 = await ws.nextMessage();
    assert.equal(ack2.type, 'subscribed');
    assert.equal(ack2.scope, 'Note:n2');

    const consumer = live.createConsumer({
      entities: new Map([['Note', makeNoteEntity()]]),
    });

    // Delete n1's authorization row and commit an ordinary update. The core
    // reauthorises on the next wake; with no row the update cannot be
    // re-authorized (it is not a terminal removal), so the one terminal removal
    // path revokes the subscription — the connection receives an error frame
    // but stays alive.
    db.prepare(`DELETE FROM Note WHERE id = ?`).run('n1');
    appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'ghost' });
    await consumer([{ scope: 'Note:n1', type: 'Note.updated', seq: 2, data: { title: 'ghost' } }], { db });
    await sleep(100);

    const revoked = await ws.nextMessage(500);
    assert.ok(revoked, 'terminal revocation reaches the connection');
    assert.equal(revoked.type, 'error');
    assert.ok(revoked.failure, 'the revocation error carries a failure');

    // The other scope still delivers on the same connection.
    db.prepare(`UPDATE Note SET title = ? WHERE id = ?`).run('still', 'n2');
    appendEvent(db, 'Note:n2', 2, 'Note.updated', { title: 'still' });
    await consumer([{ scope: 'Note:n2', type: 'Note.updated', seq: 2, data: { title: 'still' } }], { db });
    await sleep(100);

    const ev = await ws.nextEvent(500);
    assert.ok(ev, 'other scope still delivered after terminal revoke of the first');
    assert.equal(ev.entity, 'Note');
    assert.equal(ev.id, 'n2');
    assert.equal(ev.seq, 2);

    // No further frames.
    assert.equal(await ws.nextMessage(100), null, 'no further messages after the revocation and the other scope event');
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

test('(R1c) unsubscribe all scopes leaves the connection alive; shutdown drops it exactly once', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n1', 'a', 'u1', 'public');
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n2', 'b', 'u1', 'public');
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n3', 'c', 'u1', 'public');

  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'a' });
  appendEvent(db, 'Note:n2', 1, 'Note.created', { title: 'b' });
  appendEvent(db, 'Note:n3', 1, 'Note.created', { title: 'c' });

  const httpServer = http.createServer();
  const live = createWebSocketLiveDelivery(httpServer, {
    mayVerb: async () => true,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Note' ? makeNoteEntity() : null,
    log: null,
  });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    for (const id of ['n1', 'n2']) {
      ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id }));
      const ack = await ws.nextMessage();
      assert.equal(ack.type, 'subscribed');
      assert.equal(ack.scope, `Note:${id}`);
    }

    for (const id of ['n1', 'n2']) {
      ws.send(JSON.stringify({ type: 'unsubscribe', entity: 'Note', id }));
      const unsub = await ws.nextMessage();
      assert.equal(unsub.type, 'unsubscribed');
      assert.equal(unsub.scope, `Note:${id}`);
    }

    assert.equal(live.count(), 1, 'the connection survives unsubscribing every scope');

    const consumer = live.createConsumer({
      entities: new Map([['Note', makeNoteEntity()]]),
    });

    // No registry residue: commits to the unsubscribed scopes deliver nothing.
    appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'ghost' });
    appendEvent(db, 'Note:n2', 2, 'Note.updated', { title: 'ghost' });
    await consumer([
      { scope: 'Note:n1', type: 'Note.updated', seq: 2, data: { title: 'ghost' } },
      { scope: 'Note:n2', type: 'Note.updated', seq: 2, data: { title: 'ghost' } },
    ], { db });
    await sleep(100);
    assert.equal(await ws.nextEvent(150), null, 'no delivery to unsubscribed scopes');

    // The connection can still subscribe a fresh scope and receive events.
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n3' }));
    const ack3 = await ws.nextMessage();
    assert.equal(ack3.type, 'subscribed');
    assert.equal(ack3.scope, 'Note:n3');

    db.prepare(`UPDATE Note SET title = ? WHERE id = ?`).run('c-live', 'n3');
    appendEvent(db, 'Note:n3', 2, 'Note.updated', { title: 'c-live' });
    await consumer([{ scope: 'Note:n3', type: 'Note.updated', seq: 2, data: { title: 'c-live' } }], { db });
    await sleep(100);
    const ev = await ws.nextEvent(500);
    assert.ok(ev, 'a fresh subscription after unsubscribing everything still delivers');
    assert.equal(ev.entity, 'Note');
    assert.equal(ev.id, 'n3');
    assert.equal(ev.seq, 2);

    // Shutdown drops the connection; a second close is a no-op.
    live.close();
    assert.equal(live.count(), 0, 'close removes the connection');
    assert.doesNotThrow(() => live.close());
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

test('(R4) public live delivery cannot emit an annotated-text ephemeral payload', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Doc (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('d1', 'doc', 'u1', 'public');

  appendEvent(db, 'Doc:d1', 1, 'Doc.created', { title: 'doc' });

  const httpServer = http.createServer();
  const live = createWebSocketLiveDelivery(httpServer, {
    mayVerb: async () => true,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Doc' ? makeDocWithEphemeralEntity() : null,
    log: null,
  });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Doc', id: 'd1' }));
    const ack = await ws.nextMessage();
    assert.equal(ack.type, 'subscribed');
    assert.equal(ack.scope, 'Doc:d1');

    assert.equal(live.emit, undefined, 'generic ephemeral fanout is not publicly callable');
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

function makeNoteEntityWithGrant() {
  return {
    name: 'Note',
    hydrate: (row) => ({ ...row }),
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    fields: { title: { kind: 'value' } },
    grant: () => [scope(() => true).can(() => grant(read, write, subscribe))],
  };
}

test('(R6) activation failure occurs only after the subscribed acknowledgement', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n1', 'hello', 'u1', 'public');

  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  let mayVerbCallCount = 0;
  // Stateful mayVerb: admission succeeds, core.subscribe inline check passes,
  // but core.catchUp reauth fails on the third call (the checkMayRow inside catchUp).
  const failCoreMayVerb = async () => {
    mayVerbCallCount++;
    return mayVerbCallCount <= 2;
  };

  const httpServer = http.createServer();
  const live = createWebSocketLiveDelivery(httpServer, {
    mayVerb: failCoreMayVerb,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Note' ? makeNoteEntityWithGrant() : null,
    log: null,
  });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));

    const ack = await ws.nextMessage(500);
    assert.ok(ack, 'subscribed acknowledgement received');
    assert.equal(ack.type, 'subscribed');
    const error = await ws.nextMessage(500);
    assert.ok(error, 'activation failure is reported after acknowledgement');
    assert.equal(error.type, 'error');
    assert.ok(error.failure);
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

// --- (P1/P2) per-scope ownership fence: concurrent same-scope subscribes ---

test('(P1a) concurrent same-scope subscribes: newest wins, stale request acks nothing and leaks nothing', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n1', 'hello', 'u1', 'public');

  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const gate = gateMayVerbCall(1);
  const httpServer = http.createServer();
  const live = createWebSocketLiveDelivery(httpServer, {
    mayVerb: gate.mayVerb,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Note' ? makeNoteEntityWithGrant() : null,
    log: null,
  });
  const consumer = live.createConsumer({ entities: new Map([['Note', makeNoteEntity()]]) });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    // Older subscribe #1 stalls in admission (gated mayVerb).
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1', requestId: 'first' }));
    await gate.enteredPromise;

    // Newer subscribe #2 for the same scope completes fully while #1 waits.
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1', requestId: 'second' }));
    const ack = await ws.nextMessage(500);
    assert.ok(ack, 'newest subscribe acknowledges');
    assert.equal(ack.type, 'subscribed');
    assert.equal(ack.requestId, 'second', 'only the newest subscribe wins the ack');
    assert.equal(ack.scope, 'Note:n1');

    // Release the stale #1: it must complete silently — no ack, no error.
    gate.release();
    await sleep(150);
    assert.equal(await ws.nextMessage(150), null, 'stale request sends no ack and no error');

    // The winner's subscription is live: one delivery, never revoked.
    db.prepare(`UPDATE Note SET title = ? WHERE id = ?`).run('world', 'n1');
    appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'world' });
    await consumer([{ scope: 'Note:n1', type: 'Note.updated', seq: 2, data: { title: 'world' } }], { db });
    const ev = await ws.nextEvent(500);
    assert.ok(ev, 'winner delivers the committed event');
    assert.equal(ev.seq, 2);
    assert.equal(await ws.nextEvent(150), null, 'exactly one delivery — the stale request leaked no subscription');

    // No residue: unsubscribe cleanly, then commits deliver nothing.
    ws.send(JSON.stringify({ type: 'unsubscribe', entity: 'Note', id: 'n1' }));
    const unsub = await ws.nextMessage();
    assert.equal(unsub.type, 'unsubscribed');
    appendEvent(db, 'Note:n1', 3, 'Note.updated', { title: 'ghost' });
    await consumer([{ scope: 'Note:n1', type: 'Note.updated', seq: 3, data: { title: 'ghost' } }], { db });
    assert.equal(await ws.nextEvent(150), null, 'no delivery after unsubscribe — no leaked core subscription');

    // The connection's scope state is clean: a fresh subscribe still works.
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1', requestId: 'third' }));
    const ack2 = await ws.nextMessage();
    assert.equal(ack2.type, 'subscribed');
    assert.equal(ack2.requestId, 'third');
    assert.equal(await ws.nextMessage(150), null, 'no stray frames after the fresh subscribe');
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

test('(P1b) unsubscribe during an in-flight subscribe invalidates it; nothing leaks', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n1', 'hello', 'u1', 'public');

  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const gate = gateMayVerbCall(1);
  const httpServer = http.createServer();
  const live = createWebSocketLiveDelivery(httpServer, {
    mayVerb: gate.mayVerb,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Note' ? makeNoteEntityWithGrant() : null,
    log: null,
  });
  const consumer = live.createConsumer({ entities: new Map([['Note', makeNoteEntity()]]) });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    // Subscribe #1 stalls in admission.
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
    await gate.enteredPromise;

    // An explicit unsubscribe supersedes the in-flight subscribe.
    ws.send(JSON.stringify({ type: 'unsubscribe', entity: 'Note', id: 'n1' }));
    const unsub = await ws.nextMessage();
    assert.equal(unsub.type, 'unsubscribed');
    assert.equal(unsub.scope, 'Note:n1');

    // Release #1: it must complete silently — no ack, no error.
    gate.release();
    await sleep(150);
    assert.equal(await ws.nextMessage(150), null, 'the invalidated subscribe sends no ack and no error');

    // No leaked subscription: commits deliver nothing.
    db.prepare(`UPDATE Note SET title = ? WHERE id = ?`).run('ghost', 'n1');
    appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'ghost' });
    await consumer([{ scope: 'Note:n1', type: 'Note.updated', seq: 2, data: { title: 'ghost' } }], { db });
    assert.equal(await ws.nextEvent(150), null, 'no delivery to an unsubscribed-then-dropped scope');

    // The connection stays healthy: a fresh subscribe still delivers.
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
    const ack = await ws.nextMessage();
    assert.equal(ack.type, 'subscribed');
    db.prepare(`UPDATE Note SET title = ? WHERE id = ?`).run('alive', 'n1');
    appendEvent(db, 'Note:n1', 3, 'Note.updated', { title: 'alive' });
    await consumer([{ scope: 'Note:n1', type: 'Note.updated', seq: 3, data: { title: 'alive' } }], { db });
    const ev = await ws.nextEvent(500);
    assert.ok(ev, 'a fresh subscribe after the invalidated one still delivers');
    assert.equal(ev.seq, 3);
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

test('(P1c) a subscribe superseded and unsubscribed while pending inside core.subscribe is cancelled, silent, and leak-free', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n1', 'hello', 'u1', 'public');

  // Gate the SECOND mayVerb call: the connection admission (call 1) passes, so
  // the request stalls INSIDE core.subscribe at its inline reauthorization
  // (call 2) — after its own AbortController is already registered in the scope
  // map. This races after admission, not merely at the admission mayVerb.
  const gate = gateMayVerbCall(2);
  const httpServer = http.createServer();
  const live = createWebSocketLiveDelivery(httpServer, {
    mayVerb: gate.mayVerb,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Note' ? makeNoteEntityWithGrant() : null,
    log: null,
  });
  const consumer = live.createConsumer({ entities: new Map([['Note', makeNoteEntity()]]) });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    // Subscribe #1 passes admission and stalls inside core.subscribe.
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1', requestId: 'first' }));
    await gate.enteredPromise;

    // Subscribe #2 for the same scope supersedes #1 (overwriting the scope
    // map) and completes fully while #1 is still pending.
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1', requestId: 'second' }));
    const ack = await ws.nextMessage(500);
    assert.ok(ack, 'the superseding subscribe acknowledges');
    assert.equal(ack.type, 'subscribed');
    assert.equal(ack.requestId, 'second', 'only the superseding request wins the ack');
    assert.equal(ack.scope, 'Note:n1');

    // The winner is live while #1 is still pending inside core.subscribe: a
    // committed event delivers exactly once — the stale request leaks nothing
    // and cannot affect the winner.
    db.prepare(`UPDATE Note SET title = ? WHERE id = ?`).run('world', 'n1');
    appendEvent(db, 'Note:n1', 1, 'Note.updated', { title: 'world' });
    await consumer([{ scope: 'Note:n1', type: 'Note.updated', seq: 1, data: { title: 'world' } }], { db });
    const ev = await ws.nextEvent(500);
    assert.ok(ev, 'the winner delivers while the stale request is still pending inside core.subscribe');
    assert.equal(ev.seq, 1);
    assert.equal(await ws.nextEvent(150), null, 'exactly one delivery — the pending stale request leaked nothing');

    // An explicit unsubscribe invalidates the still-pending #1 and drops the
    // winner's subscription non-terminally.
    ws.send(JSON.stringify({ type: 'unsubscribe', entity: 'Note', id: 'n1' }));
    const unsub = await ws.nextMessage();
    assert.equal(unsub.type, 'unsubscribed');
    assert.equal(unsub.scope, 'Note:n1');

    // Release the stale #1: its core.subscribe resumes, installs nothing that
    // survives, and its own stale branch detaches and aborts exactly its own
    // controller — silently, with no ack and no error.
    gate.release();
    await sleep(200);
    assert.equal(await ws.nextMessage(200), null, 'the stale request sends no ack and no error');

    // No residue: a commit after the dust settles delivers nothing.
    appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'ghost' });
    await consumer([{ scope: 'Note:n1', type: 'Note.updated', seq: 2, data: { title: 'ghost' } }], { db });
    assert.equal(await ws.nextEvent(200), null, 'no delivery after the stale request settled — no leaked core subscription');

    // The connection's scope state is clean: a fresh subscribe still works and
    // no stray cancellation handle blocks it.
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1', requestId: 'third' }));
    const ack2 = await ws.nextMessage();
    assert.equal(ack2.type, 'subscribed');
    assert.equal(ack2.requestId, 'third');
    db.prepare(`UPDATE Note SET title = ? WHERE id = ?`).run('alive', 'n1');
    appendEvent(db, 'Note:n1', 3, 'Note.updated', { title: 'alive' });
    await consumer([{ scope: 'Note:n1', type: 'Note.updated', seq: 3, data: { title: 'alive' } }], { db });
    const ev2 = await ws.nextEvent(500);
    assert.ok(ev2, 'a fresh subscribe after the superseded stale request still delivers');
    assert.equal(ev2.seq, 3);
    assert.equal(await ws.nextMessage(150), null, 'no stray frames after the fresh subscribe');
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

test('(P1d) a subscribe superseded while its activation is in flight settles silently without touching the winner', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n1', 'hello', 'u1', 'public');

  // Gate the THIRD mayVerb call: admission (1) and the core.subscribe inline
  // check (2) pass, the subscribed ack is sent, then the activation's catch-up
  // reauthorization (3) stalls — a supersede must settle the activation without
  // emitting a second terminal frame and without reaching the winner's state.
  const gate = gateMayVerbCall(3);
  const httpServer = http.createServer();
  const live = createWebSocketLiveDelivery(httpServer, {
    mayVerb: gate.mayVerb,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Note' ? makeNoteEntityWithGrant() : null,
    log: null,
  });
  const consumer = live.createConsumer({ entities: new Map([['Note', makeNoteEntity()]]) });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    // Subscribe #1 acknowledges, then its activation stalls in catch-up.
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1', requestId: 'first' }));
    await gate.enteredPromise;
    const ack1 = await ws.nextMessage(500);
    assert.equal(ack1?.type, 'subscribed');
    assert.equal(ack1.requestId, 'first');

    // Subscribe #2 supersedes #1, detaching its in-flight activation, and wins.
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1', requestId: 'second' }));
    const ack2 = await ws.nextMessage(500);
    assert.equal(ack2?.type, 'subscribed');
    assert.equal(ack2.requestId, 'second', 'the superseding subscribe wins the ack');

    // The winner is live: a committed event delivers exactly once.
    db.prepare(`UPDATE Note SET title = ? WHERE id = ?`).run('world', 'n1');
    appendEvent(db, 'Note:n1', 1, 'Note.updated', { title: 'world' });
    await consumer([{ scope: 'Note:n1', type: 'Note.updated', seq: 1, data: { title: 'world' } }], { db });
    const ev = await ws.nextEvent(500);
    assert.ok(ev, 'the winner delivers after superseding the in-flight activation');
    assert.equal(ev.seq, 1);
    assert.equal(await ws.nextEvent(150), null, 'exactly one delivery — the superseded activation leaked nothing');

    // Release the superseded activation: it abandons its catch-up, detaches and
    // aborts only its own controller, and reports nothing — no second terminal
    // frame, no event from the dead catch-up.
    gate.release();
    await sleep(200);
    assert.equal(await ws.nextMessage(200), null, 'the superseded activation settles silently');

    // No residue: a fresh subscribe still works.
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1', requestId: 'third' }));
    const ack3 = await ws.nextMessage();
    assert.equal(ack3.type, 'subscribed');
    assert.equal(ack3.requestId, 'third');
    db.prepare(`UPDATE Note SET title = ? WHERE id = ?`).run('alive', 'n1');
    appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'alive' });
    await consumer([{ scope: 'Note:n1', type: 'Note.updated', seq: 2, data: { title: 'alive' } }], { db });
    const ev2 = await ws.nextEvent(500);
    assert.ok(ev2, 'a fresh subscribe after the superseded activation still delivers');
    assert.equal(ev2.seq, 2);
    assert.equal(await ws.nextMessage(150), null, 'no stray frames after the fresh subscribe');
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

test('(P2) core activation terminal failure emits exactly one terminal frame', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n1', 'hello', 'u1', 'public');

  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  // Hold the initial activation at its catch-up reauthorization (call 3: after
  // admission call 1 and the core.subscribe inline check call 2). While it
  // waits, commit an event whose type the envelope grammar cannot parse, so the
  // resumed catch-up throws after the core has already terminally revoked.
  const gate = gateMayVerbCall(3);
  const httpServer = http.createServer();
  const live = createWebSocketLiveDelivery(httpServer, {
    mayVerb: gate.mayVerb,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Note' ? makeNoteEntityWithGrant() : null,
    log: null,
  });
  const consumer = live.createConsumer({ entities: new Map([['Note', makeNoteEntity()]]) });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
    await gate.enteredPromise;

    // The invalid committed event wakes the pending catch-up while it is gated.
    appendEvent(db, 'Note:n1', 2, 'Note.bogus', { title: 'boom' });
    await consumer([{ scope: 'Note:n1', type: 'Note.bogus', seq: 2, data: { title: 'boom' } }], { db });
    gate.release();

    const ack = await ws.nextMessage(500);
    assert.ok(ack, 'subscribed acknowledgement received');
    assert.equal(ack.type, 'subscribed');

    // The activation failure surfaces as exactly ONE terminal error frame (the
    // revoke's) — never a second 'Subscription failed.' on top of it.
    const terminal = await ws.nextMessage(500);
    assert.ok(terminal, 'the terminal failure reaches the connection');
    assert.equal(terminal.type, 'error');
    assert.equal(terminal.failure?.category, 'denied');
    assert.equal(terminal.failure?.message, 'Subscription revoked.');
    assert.equal(await ws.nextMessage(250), null, 'exactly one terminal frame — no duplicate error');
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});
