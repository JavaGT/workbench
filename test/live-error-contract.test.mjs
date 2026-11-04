// RED tests: every server WebSocket error envelope must be exactly
// {type:'error', requestId?, failure: WorkbenchFailure}.
//
// The six-category stable failure grammar (invalid-input, denied,
// unknown-action, not-found, conflict, internal) must cover all error
// paths. Unexpected errors are sanitized to {category:'internal'} with
// message 'Internal error.' — stack traces and original messages never
// appear in the envelope.
//
// These tests expect the NEW contract shape and WILL FAIL until the
// server's error() and #handleMessage error paths are updated.

import { text, ref, grant, read, write, subscribe, scope, everyone } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

import workbench, { entity, generateDDL } from '../build/internal.mjs';
import { isWorkbenchFailure, FAILURE_CATEGORIES } from '../build/outcome.mjs';

// --- test entity ---

function makeNote() {
  return entity('Note', {
    body: text(), owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [scope(everyone()).can(async ({ is }) =>
      (await is.owner()) ? grant(read, write, subscribe) : grant(read))],
  });
}

// --- raw WS harness (same shape as live-authz.test.mjs) ---

function openRawWS(port, userId) {
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
    const closeFrames = [];

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
        resolve({ sock, send, nextMessage, nextClose, close });
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
        if (opcode === 0x8) closeFrames.push({ code: payload.readUInt16BE(0), reason: payload.subarray(2).toString() });
      }
    });
    sock.on('error', reject);

    function send(text) {
      const payload = Buffer.from(text, 'utf-8');
      const mask = randomBytes(4);
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      const header = Buffer.alloc(2);
      header[1] = 0x80 | payload.length;
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

    async function nextClose(timeoutMs = 1000) {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        if (closeFrames.length) return closeFrames.shift();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return null;
    }

    function close() { try { sock.destroy(); } catch { /* ignore */ } }
  });
}

const principalOf = (req) => {
  const u = req.headers?.['x-test-user'];
  return u ? { type: 'user', id: u } : { type: 'anonymous', id: null };
};

function bootNote(options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  db.exec("INSERT INTO User (id, username, password) VALUES ('1', 'alice', 'hash')");
  db.exec("INSERT INTO User (id, username, password) VALUES ('2', 'bob', 'hash')");
  const Note = makeNote();
  for (const sql of generateDDL(Note)) db.exec(sql);
  db.prepare("INSERT INTO Note (id, body, owner) VALUES ('n1', 'hello', '1')").run();
  const app = workbench({ db, ...options }).mount('/notes', Note);
  app.listen(0, { principalOf });
  return { app, db };
}

function shutdown(app, db) {
  try { app.live?.close(); } catch { /* ignore */ }
  try { app.httpServer.close(); } catch { /* ignore */ }
  try { db?.close(); } catch { /* ignore */ }
}

// === Helper: validate the contract shape ===

function assertErrorContract(msg, { expectedCategory, expectedRequestId } = {}) {
  assert.ok(msg, 'server must respond');
  // The envelope MUST have type:'error'
  assert.equal(msg.type, 'error', 'envelope type must be "error"');
  // The envelope MUST have a failure object (new contract, not flat message)
  assert.ok(msg.failure, 'envelope must have a failure object, not a flat message');
  assert.ok(msg.message === undefined, 'envelope must not have a top-level message (it belongs inside failure)');
  // failure must be a valid WorkbenchFailure
  assert.ok(isWorkbenchFailure(msg.failure), 'failure must pass isWorkbenchFailure');
  assert.ok(FAILURE_CATEGORIES.includes(msg.failure.category), `category "${msg.failure.category}" must be one of the six stable categories`);
  assert.equal(typeof msg.failure.message, 'string', 'failure.message must be a string');
  assert.ok(msg.failure.message.length > 0, 'failure.message must be non-empty');
  // requestId is optional but must match when specified
  if (expectedRequestId !== undefined) {
    assert.equal(msg.requestId, expectedRequestId, 'error envelope should preserve requestId');
  }
  // Never leak currentSeq on an error
  assert.equal(msg.currentSeq, undefined, 'error envelope must never leak currentSeq');
}

// =========================================================================
// TESTS — each will FAIL until the server adopts WorkbenchFailure envelopes
// =========================================================================

// --- 1. Invalid frame content ---

test('invalid JSON produces error with invalid-input category', async (t) => {
  const { app, db } = bootNote();
  await app.ready;
  const { port } = app.httpServer.address();
  let ws;
  try {
    ws = await openRawWS(port, '1');
    // Send raw bytes that are not valid JSON
    ws.send('not valid json at all');
    const msg = await ws.nextMessage();
    assertErrorContract(msg, { expectedCategory: 'invalid-input' });
    assert.equal(msg.failure.category, 'invalid-input');
  } finally {
    ws?.close();
    shutdown(app, db);
  }
});

// --- 2. Unmasked frame (protocol-level frame error) ---

test('an unmasked frame closes the WebSocket with protocol-error code 1002', async (t) => {
  const { app, db } = bootNote();
  await app.ready;
  const { port } = app.httpServer.address();
  let ws;
  try {
    ws = await openRawWS(port, '1');
    // Send an unmasked frame (server requires mask, RFC 6455 §5.1)
    // Build a raw unmasked text frame:
    const text = Buffer.from('hello', 'utf-8');
    let frame;
    if (text.length < 126) {
      frame = Buffer.alloc(2);
      frame[0] = 0x81;       // FIN=1, text opcode
      frame[1] = text.length; // MASK=0 (deliberately wrong)
    }
    ws.sock.write(Buffer.concat([frame, text]));
    const closeFrame = await ws.nextClose();
    assert.deepEqual(closeFrame, { code: 1002, reason: 'Protocol error' });
    assert.equal(await ws.nextMessage(40), null, 'invalid frames do not enter the application message protocol');
  } finally {
    ws?.close();
    shutdown(app, db);
  }
});

// --- 3. Unknown message type ---

test('unknown message type produces error with unknown-action category', async (t) => {
  const { app, db } = bootNote();
  await app.ready;
  const { port } = app.httpServer.address();
  let ws;
  try {
    ws = await openRawWS(port, '1');
    ws.send(JSON.stringify({ type: 'nonsense', requestId: 7 }));
    const msg = await ws.nextMessage();
    assertErrorContract(msg, { expectedRequestId: 7 });
    assert.equal(msg.failure.category, 'unknown-action');
    assert.ok(msg.failure.message.includes('nonsense'), 'error message should echo the unknown type');
  } finally {
    ws?.close();
    shutdown(app, db);
  }
});

test('valid JSON primitives produce an invalid-input failure', async () => {
  const { app, db } = bootNote();
  await app.ready;
  const { port } = app.httpServer.address();
  let ws;
  try {
    ws = await openRawWS(port, '1');
    ws.send(JSON.stringify(null));
    const msg = await ws.nextMessage();
    assertErrorContract(msg, { expectedCategory: 'invalid-input' });
    assert.equal(msg.failure.category, 'invalid-input');
  } finally {
    ws?.close();
    shutdown(app, db);
  }
});

// --- 4. Denied subscribe (anonymous) ---

test('anonymous subscribe denied produces error with denied category', async (t) => {
  const { app, db } = bootNote();
  await app.ready;
  const { port } = app.httpServer.address();
  let anon;
  try {
    anon = await openRawWS(port, null);
    anon.send(JSON.stringify({ type: 'subscribe', requestId: 41, entity: 'Note', id: 'n1' }));
    const msg = await anon.nextMessage();
    assertErrorContract(msg, { expectedRequestId: 41 });
    assert.equal(msg.failure.category, 'denied');
  } finally {
    anon?.close();
    shutdown(app, db);
  }
});

// --- 5. Read-only principal denied subscribe ---

test('read-only principal denied subscribe produces error with denied category', async (t) => {
  const { app, db } = bootNote();
  await app.ready;
  const { port } = app.httpServer.address();
  let bob;
  try {
    bob = await openRawWS(port, '2');
    bob.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
    const msg = await bob.nextMessage();
    assertErrorContract(msg);
    assert.equal(msg.failure.category, 'denied');
  } finally {
    bob?.close();
    shutdown(app, db);
  }
});

// --- 6. Missing entity fields (invalid input) ---

test('subscribe without entity/id produces error with invalid-input category', async (t) => {
  const { app, db } = bootNote();
  await app.ready;
  const { port } = app.httpServer.address();
  let ws;
  try {
    ws = await openRawWS(port, '1');
    ws.send(JSON.stringify({ type: 'subscribe', requestId: 1 }));
    const msg = await ws.nextMessage();
    assertErrorContract(msg, { expectedRequestId: 1 });
    assert.equal(msg.failure.category, 'invalid-input');
    assert.ok(msg.failure.message.includes('entity') || msg.failure.message.includes('scope'), 'should describe the missing field');
  } finally {
    ws?.close();
    shutdown(app, db);
  }
});

// --- 7. Unknown entity name ---

test('subscribe to unknown entity produces error with denied category (no existence oracle)', async (t) => {
  const { app, db } = bootNote();
  await app.ready;
  const { port } = app.httpServer.address();
  let ws;
  try {
    ws = await openRawWS(port, '1');
    ws.send(JSON.stringify({ type: 'subscribe', requestId: 1, entity: 'NonExistent', id: 'x' }));
    const msg = await ws.nextMessage();
    assertErrorContract(msg, { expectedRequestId: 1 });
    assert.equal(msg.failure.category, 'denied');
  } finally {
    ws?.close();
    shutdown(app, db);
  }
});

test('anonymous invalid-field probes cannot reveal whether an entity exists', async () => {
  const { app, db } = bootNote();
  await app.ready;
  const { port } = app.httpServer.address();
  let ws;
  try {
    ws = await openRawWS(port, null);
    ws.send(JSON.stringify({
      type: 'subscribe', requestId: 11, entity: 'Note', id: 'n1',
      fields: { secretProbe: true },
    }));
    const knownEntity = await ws.nextMessage();
    ws.send(JSON.stringify({
      type: 'subscribe', requestId: 12, entity: 'DoesNotExist', id: 'n1',
      fields: { secretProbe: true },
    }));
    const unknownEntity = await ws.nextMessage();

    assert.deepEqual(knownEntity.failure, { category: 'denied', message: 'Forbidden.' });
    assert.deepEqual(unknownEntity.failure, knownEntity.failure);
  } finally {
    ws?.close();
    shutdown(app, db);
  }
});

// --- 8. Subscribe to a valid entity but non-existent id ---

test('subscribe to non-existent row produces error with denied category (no existence oracle)', async (t) => {
  const { app, db } = bootNote();
  await app.ready;
  const { port } = app.httpServer.address();
  let ws;
  try {
    ws = await openRawWS(port, '1');
    ws.send(JSON.stringify({ type: 'subscribe', requestId: 2, entity: 'Note', id: 'no-such-id' }));
    const msg = await ws.nextMessage();
    assertErrorContract(msg, { expectedRequestId: 2 });
    assert.equal(msg.failure.category, 'denied');
  } finally {
    ws?.close();
    shutdown(app, db);
  }
});

// --- 9. requestId is a string in addition to number ---

test('error envelope preserves string requestId', async (t) => {
  const { app, db } = bootNote();
  await app.ready;
  const { port } = app.httpServer.address();
  let ws;
  try {
    ws = await openRawWS(port, '1');
    ws.send(JSON.stringify({ type: 'subscribe', requestId: 'sub-1', entity: 'Note', id: 'no-such-id' }));
    const msg = await ws.nextMessage();
    assertErrorContract(msg, { expectedRequestId: 'sub-1' });
  } finally {
    ws?.close();
    shutdown(app, db);
  }
});

// --- 10. No requestId on error when subscribe had none ---

test('error without requestId omits the field', async (t) => {
  const { app, db } = bootNote();
  await app.ready;
  const { port } = app.httpServer.address();
  let ws;
  try {
    ws = await openRawWS(port, '1');
    ws.send(JSON.stringify({ type: 'nonsense' }));
    const msg = await ws.nextMessage();
    assertErrorContract(msg);
    assert.equal(msg.requestId, undefined, 'error should not have requestId when original message had none');
  } finally {
    ws?.close();
    shutdown(app, db);
  }
});

// --- 11. Every FAILURE_CATEGORIES value is a valid WS error category ---

test('all six failure categories are valid in WebSocket error envelopes', () => {
  // Structural test — the contract requires the six-category grammar.
  // Each category must produce a valid envelope when used as failure.
  for (const cat of FAILURE_CATEGORIES) {
    const envelope = { type: 'error', failure: { category: cat, message: 'test' } };
    assert.ok(isWorkbenchFailure(envelope.failure), `category "${cat}" must produce a valid WorkbenchFailure`);
    assert.equal(envelope.type, 'error');
    assert.equal(envelope.failure.category, cat);
  }
});

// --- 12. Unexpected internal errors are sanitized ---

test('unexpected internal error sanitized to {category:"internal", message:"Internal error."}', async (t) => {
  const lines = [];
  const secret = 'database password leaked';
  const { app, db } = bootNote({
    log: { output: (level, channel, message, context) => lines.push({ level, channel, message, context }) },
  });
  await app.ready;
  const { port } = app.httpServer.address();
  let ws;
  try {
    ws = await openRawWS(port, '1');
    const getEntity = app.entities.get.bind(app.entities);
    app.entities.get = (name) => {
      if (name === 'Note') throw new Error(secret);
      return getEntity(name);
    };
    ws.send(JSON.stringify({ type: 'subscribe', requestId: 41, entity: 'Note', id: 'n1' }));
    const msg = await ws.nextMessage();
    assertErrorContract(msg, { expectedCategory: 'internal', expectedRequestId: 41 });
    assert.deepEqual(msg.failure, { category: 'internal', message: 'Internal error.' });
    assert.equal(JSON.stringify(msg).includes(secret), false, 'wire response must not expose the original error');
    assert.ok(
      lines.some((line) => line.context?.err?.message === secret),
      'operator log retains the original error',
    );
  } finally {
    ws?.close();
    shutdown(app, db);
  }
});

// --- 13. Error envelope must not contain fields from other message types ---

test('error envelope has no event-like fields', async (t) => {
  const { app, db } = bootNote();
  await app.ready;
  const { port } = app.httpServer.address();
  let ws;
  try {
    ws = await openRawWS(port, '1');
    ws.send(JSON.stringify({ type: 'subscribe', requestId: 1 }));
    const msg = await ws.nextMessage();
    assertErrorContract(msg, { expectedRequestId: 1 });
    // Must not have fields that belong to 'subscribed' or 'event' types
    assert.equal(msg.entity, undefined, 'error must not have entity field');
    assert.equal(msg.currentSeq, undefined, 'error must not have currentSeq field (cursor leak)');
    assert.equal(msg.seq, undefined, 'error must not have seq field');
    assert.equal(msg.event, undefined, 'error must not have event field');
  } finally {
    ws?.close();
    shutdown(app, db);
  }
});
