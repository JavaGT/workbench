import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  DEFAULT_WS_DEFLATE_THRESHOLD,
  DEFAULT_WS_MAX_PAYLOAD,
  createWebSocketServer,
} from '../build/websocket.mjs';

test('createWebSocketServer uses noServer mode with default payload cap and deflate threshold', (t) => {
  const wss = createWebSocketServer();
  t.after(() => wss.close());

  assert.equal(wss.options.noServer, true);
  assert.equal(wss.options.maxPayload, DEFAULT_WS_MAX_PAYLOAD);
  assert.deepEqual(wss.options.perMessageDeflate, {
    threshold: DEFAULT_WS_DEFLATE_THRESHOLD,
  });
});

test('createWebSocketServer disables perMessageDeflate when false', (t) => {
  const wss = createWebSocketServer({ perMessageDeflate: false });
  t.after(() => wss.close());

  assert.equal(wss.options.perMessageDeflate, false);
});

test('createWebSocketServer merges custom maxPayload and perMessageDeflate options', (t) => {
  const wss = createWebSocketServer({
    maxPayload: 1024 * 1024,
    perMessageDeflate: { zlibDeflateOptions: { level: 3 } },
  });
  t.after(() => wss.close());

  assert.equal(wss.options.maxPayload, 1024 * 1024);
  assert.deepEqual(wss.options.perMessageDeflate, {
    threshold: DEFAULT_WS_DEFLATE_THRESHOLD,
    zlibDeflateOptions: { level: 3 },
  });
});

test('createWebSocketServer upgrades HTTP requests and completes graceful close cleanly', async (t) => {
  const wss = createWebSocketServer();
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => {
        ws.send(`echo:${data.toString()}`);
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    for (const client of wss.clients) client.terminate();
    wss.close(() => server.close(resolve));
  }));

  const { port } = server.address();
  const client = new WebSocket(`ws://127.0.0.1:${port}/events`);

  const received = await new Promise((resolve, reject) => {
    client.addEventListener('open', () => client.send('hello'));
    client.addEventListener('message', (event) => resolve(event.data));
    client.addEventListener('error', (err) => reject(err));
  });
  assert.equal(received, 'echo:hello');

  const closed = await new Promise((resolve) => {
    client.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }));
    client.close(1000, 'done');
  });
  assert.equal(closed.code, 1000);
});
