// Phase 2 — WebSocket server (handshake + framing, zero-deps).
//
// Node's `http.WebSocket` is client-only. The server side uses the HTTP server's
// `upgrade` event, which delivers the raw socket after the HTTP request-line and
// headers have been parsed. This test builds and verifies a minimal RFC 6455
// implementation:
//
//   - Handshake: validate headers, compute Sec-WebSocket-Accept, send 101
//   - Frame parsing: masked text frames from client, plus close/ping/pong
//   - Frame writing: send text/close/pong frames (unmasked, per RFC)
//   - Connection lifecycle: ready, send, close

import { test } from 'node:test';
import assert from 'node:assert/strict';
import _http from 'node:http';
import { createHash } from 'node:crypto';

import { upgradeWebSocket, FrameSender, FrameParser } from '../build/websocket.mjs';

// --- helpers: frame-level tests (no live socket needed) ---

test('FrameSender builds a text frame', () => {
  const sender = new FrameSender();
  const buf = sender.text('hello');
  // First byte: FIN=1, RSV=0, opcode=0x1 → 0x81
  assert.equal(buf[0], 0x81);
  // Second byte: MASK=0 (server→client never masks), payloadLen=5 → 0x05
  assert.equal(buf[1], 0x05);
  // Payload: 'hello' as UTF-8
  assert.deepEqual(buf.slice(2), Buffer.from('hello'));
});

test('FrameSender builds a close frame with code and reason', () => {
  const sender = new FrameSender();
  const buf = sender.close(1000, 'bye');
  // FIN=1, opcode=0x8 → 0x88
  assert.equal(buf[0], 0x88);
  // Close body: 2 byte status code (big-endian) + UTF-8 reason
  const body = buf.slice(2);
  assert.equal(body.length, 2 + 3); // 1000=0x03E8 + 'bye'
  assert.equal(body.readUInt16BE(0), 1000);
  assert.equal(body.slice(2).toString(), 'bye');
});

test('FrameSender builds a close frame with no code (empty body)', () => {
  const sender = new FrameSender();
  const buf = sender.close();
  assert.equal(buf[0], 0x88);
  assert.equal(buf.length, 2); // header only, no body
});

test('FrameSender builds a pong frame echoing the ping payload', () => {
  const sender = new FrameSender();
  const pingPayload = Buffer.from([0x61, 0x70, 0x70]); // 'app'
  const buf = sender.pong(pingPayload);
  assert.equal(buf[0], 0x8a); // FIN=1, opcode=0xA (pong)
  assert.deepEqual(buf.slice(2), pingPayload);
});

test('FrameSender rejects oversized payloads (per-safety cap, not protocol limit)', () => {
  const sender = new FrameSender();
  const big = Buffer.alloc(64 * 1024 + 1, 'a');
  assert.throws(() => sender.text(big.toString()), /too large/);
});

test('FrameSender text with extended 2-byte payload length (length >= 126)', () => {
  const sender = new FrameSender();
  const payload = 'a'.repeat(126);
  const buf = sender.text(payload);
  assert.equal(buf[0], 0x81);
  assert.equal(buf[1], 0x7e); // 126 indicates 2-byte extended length
  assert.equal(buf.readUInt16BE(2), 126); // extended length = 126
  assert.equal(buf.slice(4).toString(), payload);
});

test('FrameSender text with extended 8-byte payload length (length >= 65536)', () => {
  const sender = new FrameSender();
  const payload = 'a'.repeat(65536); // 64 KiB
  const buf = sender.text(payload);
  assert.equal(buf[0], 0x81);
  assert.equal(buf[1], 0x7f); // 127 indicates 8-byte extended length
  // JS BigInt for the 8 bytes, first 4 bytes are 0 (65536 fits in 32 bits)
  assert.equal(buf.readUInt32BE(6), 65536);
  assert.equal(buf.slice(10).toString(), payload);
});

// --- FrameParser: parse incoming (masked) client frames ---

test('FrameParser parses a small masked text frame', () => {
  const parser = new FrameParser();
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const payload = Buffer.from('hello');
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];

  // Build the raw frame
  const frame = Buffer.alloc(2 + 4 + payload.length);
  frame[0] = 0x81;          // FIN=1, opcode=0x1
  frame[1] = 0x80 | payload.length; // MASK=1, len=5
  frame.set(mask, 2);
  frame.set(masked, 6);

  parser.feed(frame);
  const messages = parser.drainMessages();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].opcode, 0x1);
  assert.equal(messages[0].payload.toString(), 'hello');
});

test('FrameParser parses a close frame', () => {
  const parser = new FrameParser();
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  // close code 1000 = 0x03E8
  const code = Buffer.alloc(2);
  code.writeUInt16BE(1000, 0);
  const body = Buffer.concat([code, Buffer.from('bye')]);
  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i++) masked[i] = body[i] ^ mask[i % 4];

  const frame = Buffer.alloc(2 + 4 + body.length);
  frame[0] = 0x88;                     // FIN=1, opcode=0x8
  frame[1] = 0x80 | body.length;       // MASK=1
  frame.set(mask, 2);
  frame.set(masked, 6);

  parser.feed(frame);
  const msgs = parser.drainMessages();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].opcode, 0x8);
  assert.equal(msgs[0].closeCode, 1000);
  assert.equal(msgs[0].closeReason, 'bye');
});

// REGRESSION: a graceful WS client (undici's global WebSocket) closes by
// sending a MASKED, ZERO-LENGTH close frame — 6 bytes: `88 80 <4-byte mask>`.
// The parser's #processBuffer loop previously ran `while (buffer.length > 0)`,
// which exited after the MASK state consumed the final 4 mask bytes (buffer
// now empty) BEFORE the PAYLOAD state could finalize the zero-length frame. The
// close frame was therefore never emitted, the server never acked the close,
// and the client socket stuck in CLOSING forever (event-loop leak). The loop
// now also runs when PAYLOAD is fully read, so a zero-length frame finalizes.
test('FrameParser parses a masked ZERO-LENGTH close frame (graceful-client leak regression)', () => {
  const parser = new FrameParser();
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);

  // No body at all: FIN=1 opcode=0x8, MASK=1 len=0, then the 4 mask bytes.
  const frame = Buffer.alloc(2 + 4);
  frame[0] = 0x88;   // FIN=1, opcode=0x8 (close)
  frame[1] = 0x80;   // MASK=1, len=0
  frame.set(mask, 2);

  parser.feed(frame);
  const msgs = parser.drainMessages();
  assert.equal(msgs.length, 1, 'zero-length close frame must be emitted');
  assert.equal(msgs[0].opcode, 0x8);
  assert.equal(msgs[0].closeCode, 1005, 'empty payload → 1005 (no status received)');
  assert.equal(msgs[0].closeReason, '');
});

test('FrameParser parses a ping frame (automatic pong response)', () => {
  const parser = new FrameParser();
  const mask = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
  const payload = Buffer.from([0x70, 0x69, 0x6e, 0x67]); // 'ping'
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];

  const frame = Buffer.alloc(2 + 4 + payload.length);
  frame[0] = 0x89;                     // FIN=1, opcode=0x9 (ping)
  frame[1] = 0x80 | payload.length;
  frame.set(mask, 2);
  frame.set(masked, 6);

  parser.feed(frame);
  // Ping generates a pong via the onPong callback (no message emitted)
  const msgs = parser.drainMessages();
  assert.equal(msgs.length, 0);
});

test('FrameParser feeds data in chunks and assembles a complete frame', () => {
  const parser = new FrameParser();
  const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const payload = Buffer.from('chunked');
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];

  const full = Buffer.alloc(2 + 4 + payload.length);
  full[0] = 0x81;
  full[1] = 0x80 | payload.length;
  full.set(mask, 2);
  full.set(masked, 6);

  // Feed one byte at a time
  for (let i = 0; i < full.length; i++) {
    parser.feed(full.slice(i, i + 1));
  }
  const msgs = parser.drainMessages();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].payload.toString(), 'chunked');
});

test('FrameParser fed empty buffer is a no-op', () => {
  const parser = new FrameParser();
  parser.feed(Buffer.alloc(0));
  assert.deepEqual(parser.drainMessages(), []);
});

test('FrameParser reports an error for an unmasked client frame', () => {
  const parser = new FrameParser();
  parser.feed(Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f])); // unmasked 'hello'
  const msgs = parser.drainMessages();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].opcode, -1); // error
  assert.ok(msgs[0].error.includes('mask'));
});

// --- WebSocket upgrade handshake ---

test('upgradeWebSocket performs the handshake, upgrading the connection', () => {
  const key = Buffer.from('test-key-12345678901234').toString('base64');
  
  // Simulate the socket
  const writes = [];
  const socket = {
    destroyed: false,
    write(data) { writes.push(data); },
    destroy() { this.destroyed = true; },
    on() {},
    removeAllListeners() {},
  };

  const req = {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': key,
      'sec-websocket-version': '13',
    },
    socket,
    url: '/events',
    method: 'GET',
    httpVersion: '1.1',
  };

  const result = upgradeWebSocket(req, socket);
  assert.ok(result, 'upgrade succeeded');

  // The response should be a 101 with the accept key
  const response = writes.join('');
  assert.ok(response.startsWith('HTTP/1.1 101'), '101 Switching Protocols');
  assert.ok(response.includes('Upgrade: websocket'));
  assert.ok(response.includes('Connection: Upgrade'));

  // Verify the accept key
  const expectedAccept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  assert.ok(response.includes(`Sec-WebSocket-Accept: ${expectedAccept}`));
});

test('upgradeWebSocket rejects a non-WebSocket upgrade request', () => {
  const socket = { write() {}, destroy() {}, on() {}, removeAllListeners() {} };
  const req = {
    headers: { connection: 'keep-alive' },
    socket,
    url: '/events',
    method: 'GET',
    httpVersion: '1.1',
  };
  const result = upgradeWebSocket(req, socket);
  assert.equal(result, null);
});

test('upgradeWebSocket rejects WebSocket version other than 13', () => {
  const key = Buffer.from('test-key-test-key-test').toString('base64');
  const socket = { write() {}, destroy() {}, on() {}, removeAllListeners() {} };
  const req = {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': key,
      'sec-websocket-version': '8',
    },
    socket,
    url: '/events',
    method: 'GET',
    httpVersion: '1.1',
  };
  // Should send 400, not 101
  const writes = [];
  socket.write = (data) => writes.push(data);
  const result = upgradeWebSocket(req, socket);
  assert.equal(result, null);
  assert.ok(writes.join('').includes('400'), 'rejected with 400');
});
