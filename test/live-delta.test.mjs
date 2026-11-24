// P6e-2 (Slice B1): delivery-layer prev-shadow + per-field delta for `.updated`
// events ONLY. Delta is computed from committed-state vs prior committed shadow,
// attached alongside event.data (one-path backward-compat, #71 F5).
//
// Reworked: no public `live.emit`. All durable events use canonical _Log insert
// → _Cursor update → live.wake(scope). Lifecycle envelope payload derives from
// CURRENT Canvas DB row, so test helpers persist relevant values before appending.
//
// All tests use raw WebSocket against a direct createLiveServer + compiled entity
// (mirrors live-pace.test.mjs).

import { text, state, link, scope, everyone, grant, read, write, subscribe } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

import {
  entity, generateDDL, executeFrameworkDDL, createLiveServer } from '../build/internal.mjs';
import { createTextState, textCheckpoint } from '../build/annotated-text.mjs';
import { readSeq } from '../build/committed-log.mjs';

// --- test entity ---

const Canvas = entity('Canvas', {
  title: text(),
  status: state({ values: ['draft', 'published'] }),
  body: text.crdt(),
  share: link(),

  grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
});

// --- raw WebSocket harness (mirrors live-pace.test.mjs) ---

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
        resolve({ sock, send, nextMessage, nextEvent, close });
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

    async function nextEvent(timeoutMs = 400) {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        while (inbox.length > 0) {
          const msg = JSON.parse(inbox.shift());
          if (msg.type === 'event' || msg.type === 'resync') return msg;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      return null;
    }

    function close() { try { sock.destroy(); } catch { /* ignore */ } }
  });
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- bootstrap: direct createLiveServer (mirrors live-pace.test.mjs direct pattern) ---

function bootServer() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  for (const sql of generateDDL(Canvas)) db.exec(sql);

  const httpServer = http.createServer();
  const boundCanvas = Canvas.bind({ db, entityOf: (decl) => decl });
  const live = createLiveServer(httpServer, {
    path: '/events',
    mayVerb: async () => true,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: () => boundCanvas,
  });

  httpServer.listen(0);
  return { db, httpServer, live, boundCanvas };
}

// Helper: insert a Canvas row into db
function insertRow(db, id, overrides = {}) {
  const title = overrides.title ?? 'Original';
  const status = overrides.status ?? 'draft';
  const body = overrides.body ?? JSON.stringify(textCheckpoint(createTextState()));
  db.prepare('INSERT INTO Canvas (id, title, status, body) VALUES (?, ?, ?, ?)').run(id, title, status, body);
}

// Helper: append a durable event to _Log, update _Cursor, and wake live.
// The caller is responsible for updating the Canvas DB row to the desired
// state BEFORE calling this — the envelope payload derives from the CURRENT row.
function emitEvent({ db, live, scope, type, data = {} }) {
  const seq = readSeq(db, scope) + 1;
  db.prepare(
    'INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET lastSeq = ?',
  ).run(scope, seq, seq);
  db.prepare(
    'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(scope, seq, type, JSON.stringify(data), 'test-action', new Date().toISOString());
  live.wake(scope);
  return seq;
}

// Helper: subscribe and wait for ack
async function wsSubscribe(ws, entity, id) {
  ws.send(JSON.stringify({ type: 'subscribe', entity, id }));
  return ws.nextMessage();
}

// ============================================================
// Test 1: value field `.updated` delta — cold shadow → set-from-empty
// ============================================================

test('P6e-2 B1: value field .updated delta (cold shadow → set-from-empty)', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const cid = 'c-test1';
  const scope = 'Canvas:' + cid;

  try {
    insertRow(db, cid, { title: 'v1' });

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Canvas', cid))?.type, 'subscribed');

    // 1st update: cold shadow → set-from-empty delta
    db.prepare('UPDATE Canvas SET title = ? WHERE id = ?').run('v1', cid);
    await emitEvent({ db, live, scope, type: 'Canvas.updated', data: { title: null } });
    const ev1 = await ws.nextEvent(400);
    assert.ok(ev1, 'first event received');
    assert.equal(ev1.event.type, 'Canvas.updated');
    assert.ok(ev1.delta, 'delta present on first update');
    assert.deepEqual(ev1.delta, { title: { set: 'v1' }, status: { to: 'draft' } }, 'cold shadow captures the authorized lifecycle state');
    assert.equal(ev1.event.data.title, 'v1', 'whole state preserved');

    // 2nd update: diff against v1 → delta shows change
    db.prepare('UPDATE Canvas SET title = ? WHERE id = ?').run('v2', cid);
    await emitEvent({ db, live, scope, type: 'Canvas.updated', data: { title: null } });
    const ev2 = await ws.nextEvent(400);
    assert.ok(ev2, 'second event received');
    assert.ok(ev2.delta, 'delta present on second update');
    assert.deepEqual(ev2.delta, { title: { set: 'v2' } }, 'second delta shows {set:v2}');
    assert.equal(ev2.event.data.title, 'v2', 'whole state preserved on second update');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 2: non-lifecycle durable events → recipient-snapshot-required
// ============================================================

test('non-lifecycle durable events produce recipient-snapshot-required resync', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const cid = 'c-test2';
  const scope = 'Canvas:' + cid;

  try {
    insertRow(db, cid);

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Canvas', cid))?.type, 'subscribed');

    // A non-lifecycle event (3-part type) — no canonical event type/data/op leak
    await emitEvent({
      db, live, scope,
      type: 'Canvas.body.applied',
      data: { id: cid, operation: ['workbench.text', 1, ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1], 1, [], ['insert', ['root'], 'hello']] },
    });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'resync received');
    assert.equal(ev.type, 'resync');
    assert.equal(ev.entity, 'Canvas');
    assert.equal(ev.id, cid);
    assert.equal(ev.reason, 'recipient-snapshot-required');
    assert.ok(Number.isSafeInteger(ev.seq) && ev.seq > 0, 'seq present');
    // No canonical event type/data/op leak
    assert.equal(ev.event, undefined, 'no event envelope leaked');
    assert.equal(ev.delta, undefined, 'no delta leaked');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 3: state field `.updated` delta — {from, to}
// ============================================================

test('P6e-2 B1: state field .updated delta ({from, to})', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const cid = 'c-test3';
  const scope = 'Canvas:' + cid;

  try {
    insertRow(db, cid, { status: 'draft' });

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Canvas', cid))?.type, 'subscribed');

    // Emit .created to seed the prev-shadow with status='draft' (mirrors production).
    await emitEvent({ db, live, scope, type: 'Canvas.created', data: { id: cid } });
    const evSeed = await ws.nextEvent(400);
    assert.ok(evSeed, 'created event received');

    // Update status from draft to published
    db.prepare('UPDATE Canvas SET status = ? WHERE id = ?').run('published', cid);
    await emitEvent({ db, live, scope, type: 'Canvas.updated', data: { status: null } });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'event received');
    assert.equal(ev.event.type, 'Canvas.updated');
    assert.ok(ev.delta, 'delta present');
    assert.deepEqual(ev.delta, { status: { from: 'draft', to: 'published' } },
      'state delta shows {from,to}');
    assert.equal(ev.event.data.status, 'published', 'whole state preserved');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 4: removed evicts shadow — post-recreate update is set-from-empty
// ============================================================

test('P6e-2 B1: removed evicts shadow → post-recreate delta is set-from-empty', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const cid = 'c-test4';
  const scope = 'Canvas:' + cid;

  try {
    insertRow(db, cid, { title: 'v1' });

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Canvas', cid))?.type, 'subscribed');

    // Update to seed shadow
    db.prepare('UPDATE Canvas SET title = ? WHERE id = ?').run('v1', cid);
    await emitEvent({ db, live, scope, type: 'Canvas.updated', data: { title: null } });
    const ev1 = await ws.nextEvent(400);
    assert.ok(ev1, 'first update received');
    assert.deepEqual(ev1.delta, { title: { set: 'v1' }, status: { to: 'draft' } }, 'first delta captures the authorized lifecycle state');

    // Remove — delete row, then append event, then wake.
    // Note: after removal, the subscription is terminated by the core (no auth
    // row for subsequent events), so we must resubscribe for the recreate cycle.
    db.prepare('DELETE FROM Canvas WHERE id = ?').run(cid);
    await emitEvent({ db, live, scope, type: 'Canvas.removed', data: { id: cid } });
    const evRemove = await ws.nextEvent(400);
    assert.ok(evRemove, 'removed event received');
    assert.equal(evRemove.event.type, 'Canvas.removed');

    // Re-create through the normal fixture so CRDT hydration stays valid.
    insertRow(db, cid, { title: 'reborn' });

    // Resubscribe — fresh cursor, fresh shadow
    ws.close();
    ws = await openRawWS(port, 'alice');
    const subAck = await wsSubscribe(ws, 'Canvas', cid);
    assert.equal(subAck?.type, 'subscribed', `expected 'subscribed', got ${JSON.stringify(subAck)}`);

    // Emit created (seeds the shadow)
    await emitEvent({ db, live, scope, type: 'Canvas.created', data: { id: cid } });
    const evCreated = await ws.nextEvent(400);
    assert.ok(evCreated, 'created event received');
    assert.equal(evCreated.event.type, 'Canvas.created');
    assert.equal(evCreated.delta, undefined, 'created has no delta');

    // Now update the re-created row — should be set-from-empty (NOT diffed against stale v1)
    db.prepare('UPDATE Canvas SET title = ? WHERE id = ?').run('reborn-v2', cid);
    await emitEvent({ db, live, scope, type: 'Canvas.updated', data: { title: null } });
    const evPost = await ws.nextEvent(400);
    assert.ok(evPost, 'post-recreate update received');
    assert.ok(evPost.delta, 'delta present on post-recreate update');
    assert.deepEqual(evPost.delta, { title: { set: 'reborn-v2' } },
      'post-recreate delta is set-from-empty (NOT diffed against stale pre-remove shadow)');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 5: created has no delta
// ============================================================

test('P6e-2 B1: created event has no delta', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const cid = 'c-test5';
  const scope = 'Canvas:' + cid;

  try {
    insertRow(db, cid, { title: 'Fresh' });

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Canvas', cid))?.type, 'subscribed');

    // Emit created (already subscribed — receives the event)
    await emitEvent({ db, live, scope, type: 'Canvas.created', data: { id: cid } });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'created event received');
    assert.equal(ev.event.type, 'Canvas.created');
    assert.equal(ev.delta, undefined, 'created event has no delta key');
    assert.equal(ev.event.data.title, 'Fresh', 'whole state carried in event.data');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 6: multi-field `.updated` → ONE envelope with multi-key delta map
// ============================================================

test('P6e-2 B1: multi-field .updated is ONE envelope with multi-key delta map', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const cid = 'c-test6';
  const scope = 'Canvas:' + cid;

  try {
    insertRow(db, cid, { title: 'Old', status: 'draft' });

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Canvas', cid))?.type, 'subscribed');

    // Emit .created to seed the prev-shadow with title='Old', status='draft'.
    await emitEvent({ db, live, scope, type: 'Canvas.created', data: { id: cid } });
    const evSeed = await ws.nextEvent(400);
    assert.ok(evSeed, 'created event received');

    // Update both title AND status
    db.prepare('UPDATE Canvas SET title = ?, status = ? WHERE id = ?').run('New Title', 'published', cid);
    await emitEvent({ db, live, scope, type: 'Canvas.updated', data: { title: null, status: null } });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'event received');
    assert.equal(ev.event.type, 'Canvas.updated');
    assert.equal(ev.seq, 2, 'single seq');
    assert.ok(ev.delta, 'delta present');
    // Both fields in one delta map
    assert.ok(ev.delta.title, 'delta has title');
    assert.ok(ev.delta.status, 'delta has status');
    assert.deepEqual(ev.delta.title, { set: 'New Title' });
    assert.deepEqual(ev.delta.status, { from: 'draft', to: 'published' });
    assert.equal(ev.event.data.title, 'New Title', 'whole state title');
    assert.equal(ev.event.data.status, 'published', 'whole state status');

    // NO second envelope for the same event
    const evExtra = await ws.nextEvent(100);
    assert.equal(evExtra, null, 'no extra envelope for multi-field update');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 7: unchanged `.updated` → delta is {} (empty, present)
// ============================================================

test('P6e-2 B1: unchanged .updated yields {} delta (present but empty)', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const cid = 'c-test7';
  const scope = 'Canvas:' + cid;

  try {
    insertRow(db, cid, { title: 'Same', status: 'draft' });

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Canvas', cid))?.type, 'subscribed');

    // First update to seed shadow
    db.prepare('UPDATE Canvas SET title = ? WHERE id = ?').run('Same', cid);
    await emitEvent({ db, live, scope, type: 'Canvas.updated', data: { title: null } });
    const ev1 = await ws.nextEvent(400);
    assert.ok(ev1, 'first update received');
    assert.deepEqual(ev1.delta, { title: { set: 'Same' }, status: { to: 'draft' } }, 'first delta captures the authorized lifecycle state');

    // Second update with the SAME values — delta should be {} (empty object)
    await emitEvent({ db, live, scope, type: 'Canvas.updated', data: { title: null } });
    const ev2 = await ws.nextEvent(400);
    assert.ok(ev2, 'second update received');
    assert.ok(ev2.delta, 'delta present');
    assert.deepEqual(ev2.delta, {}, 'delta is empty object (no changes)');
    assert.equal(ev2.event.data.title, 'Same', 'whole state preserved');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 8: delta-unaware backward-compat — both delta AND event.data present
// ============================================================

test('P6e-2 B1: backward-compat — subscriber receives both delta and event.data', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const cid = 'c-test8';
  const scope = 'Canvas:' + cid;

  try {
    insertRow(db, cid, { title: 'b1' });

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Canvas', cid))?.type, 'subscribed');

    // UPDATE the DB to 'b2' so the post-commit re-read (authzRow) matches the
    // mutation payload — mirrors production, where the .update handler applies the
    // mutation BEFORE the post-commit consumer re-reads.
    db.prepare('UPDATE Canvas SET title = ? WHERE id = ?').run('b2', cid);
    await emitEvent({ db, live, scope, type: 'Canvas.updated', data: { title: null } });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'event received');
    assert.equal(ev.event.type, 'Canvas.updated');
    // Both delta AND event.data are present
    assert.ok('delta' in ev, 'delta key is present on envelope');
    assert.ok('event' in ev, 'event key is present on envelope');
    assert.ok(ev.event.data, 'event.data is present (whole state)');
    assert.equal(ev.event.data.title, 'b2', 'whole state title in event.data');
    assert.deepEqual(ev.delta, { title: { set: 'b2' }, status: { to: 'draft' } }, 'delta is derived from the authorized lifecycle state');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});
