// Direction C: the application-integrated WebSocket transport.
//
// attachApplicationLiveDelivery mounts the WebSocket upgrade seam at
// <path>/events over the SAME owned core as the SSE handler — one committed
// authority, two transport skins. These tests prove the seam is NOT a silent
// durable-omitting toy (a committed event reaches a WS subscriber), that an
// async principalOf resolves before admission, and that shutdown retracts
// caret presence instead of leaking sockets.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

import workbench, {
  annotatedText as _annotatedText, annotation as _annotation, anonymous, deny, entity, ephemeral as _ephemeral, everyone, grant, read, ref as _ref, scope, subscribe, text, write as _write, admin as _admin,
} from '../build/index.mjs';
import { createAnnotatedDocApp } from '../projects/annotated-doc/server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const user = { type: 'user', id: 'u1', attributes: {} };

// Raw WebSocket harness — same pattern as live-delivery-seam.test.mjs, with a
// configurable upgrade path + query string (the app-integrated seam lives at
// /live-delivery/events and the demo principal is per-request viewAs).
function openRawWS(port, { path = '/live-delivery/events', query = '' } = {}) {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    const handshake =
      `GET ${path}${query} HTTP/1.1\r\n` +
      'Host: localhost\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n' +
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
        resolve({ sock, send, nextMessage, close });
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

    async function nextMessage(timeoutMs = 2000) {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        if (inbox.length > 0) return JSON.parse(inbox.shift());
        await sleep(20);
      }
      return null;
    }

    function close() {
      try { sock.destroy(); } catch { /* ignore */ }
    }
  });
}

function project() {
  return entity('Project', {
    name: text(),
    grant: () => grant(read, subscribe),
  });
}

function projectAction() {
  return {
    type: 'project.write',
    authorize: ({ principal, payload }) => principal.id === 'u1' && payload.authorized === true,
    handler: ({ payload }) => ({
      events: [{
        type: payload.exists ? 'Project.updated' : 'Project.created',
        scope: `Project:${payload.id}`,
        data: { id: payload.id, name: payload.name },
      }],
      privateFact: { before: payload.before ?? payload, after: payload },
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

test('app-integrated WebSocket subscription receives a post-commit event over the shared core', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [project()], actions: [projectAction()] });
  app.attachLiveDelivery({ principalOf: () => user });
  app.listen(0);
  await app.ready;
  t.after(async () => { app.httpServer.closeAllConnections?.(); await app.shutdown(); db.close(); });

  await app.dispatch({
    actionId: 'ws-seed', type: 'project.write', scope: 'Project:p1',
    payload: { id: 'p1', name: 'before', authorized: true }, principal: user,
  });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const port = app.httpServer.address().port;

  const ws = await openRawWS(port);
  try {
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Project', id: 'p1' }));
    const ack = await ws.nextMessage();
    assert.ok(ack, 'subscribed ack received');
    assert.equal(ack.type, 'subscribed');
    assert.equal(ack.scope, 'Project:p1');

    const updated = await app.dispatch({
      actionId: 'ws-update', type: 'project.write', scope: 'Project:p1',
      payload: { id: 'p1', name: 'after', exists: true, authorized: true }, principal: user,
    });
    assert.equal(updated.ok, true);

    const frame = await ws.nextMessage();
    assert.ok(frame, 'post-commit event received over WebSocket');
    assert.equal(frame.type, 'event');
    assert.equal(frame.entity, 'Project');
    assert.equal(frame.id, 'p1');
    assert.equal(frame.event.type, 'Project.updated');
    assert.deepEqual(frame.event.data, { id: 'p1', name: 'after' });
    // includeActionId is false for ordinary lifecycle envelopes: no action id leaks.
    assert.equal(JSON.stringify(frame).includes('ws-update'), false);
  } finally {
    ws.close();
  }
  void origin;
});

test('async principalOf is awaited before WebSocket admission', async (t) => {
  const Owned = entity('OwnedProject', {
    name: text(),
    ownerId: text(),
    checks: { owner: ({ entity: row, principal }) => row.ownerId === principal.id },
    grant: () => [scope(() => everyone()).can(async ({ is }) => (
      await is.owner() ? grant(read, subscribe) : deny('not owner')
    ))],
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [Owned] });
  let resolved = 0;
  app.attachLiveDelivery({ principalOf: async () => { resolved += 1; return user; } });
  app.listen(0);
  await app.ready;
  t.after(async () => { app.httpServer.closeAllConnections?.(); await app.shutdown(); db.close(); });
  app.entity(Owned).insert({ id: 'p1', name: 'Visible', ownerId: 'u1' });

  const port = app.httpServer.address().port;
  const ws = await openRawWS(port);
  try {
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'OwnedProject', id: 'p1' }));
    const ack = await ws.nextMessage();
    assert.ok(ack, 'subscribed ack received');
    assert.equal(ack.type, 'subscribed', `expected admission as the awaited principal, got ${JSON.stringify(ack)}`);
    assert.ok(resolved >= 1, 'principalOf was called');
  } finally {
    ws.close();
  }
});

test('app-integrated WebSocket collapses a revoked principal to canonical anonymous before admission', async (t) => {
  const db = new DatabaseSync(':memory:');
  const seen = [];
  const Owned = entity('CollapseWSOwned', {
    name: text(),
    ownerId: text(),
    checks: { owner: ({ entity: row, principal }) => { seen.push(principal); return row.ownerId === principal.id; } },
    grant: () => [scope(() => everyone()).can(async ({ is }) => (
      await is.owner() ? grant(read, subscribe) : deny('not owner')
    ))],
  });
  const app = workbench({ db, entities: [Owned] });
  // The connection principal is the revoked owner of the row — if it reached
  // admission as itself it would be subscribed. The two-valued collapse must
  // admit it as canonical anonymous, so the ownership grant denies.
  app.attachLiveDelivery({ principalOf: () => ({ type: 'user', id: 'u1', attributes: {}, status: 'revoked' }) });
  app.listen(0);
  await app.ready;
  t.after(async () => { app.httpServer.closeAllConnections?.(); await app.shutdown(); db.close(); });
  app.entity(Owned).insert({ id: 'p1', name: 'Visible', ownerId: 'u1' });

  const port = app.httpServer.address().port;
  const ws = await openRawWS(port);
  try {
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'CollapseWSOwned', id: 'p1' }));
    const ack = await ws.nextMessage();
    assert.ok(seen.length >= 1, 'the grant ran for the WebSocket subscription');
    assert.equal(seen[seen.length - 1], anonymous, 'a revoked principal reaches the WebSocket seam as the canonical anonymous value');
    assert.notEqual(ack?.type, 'subscribed', 'admission sees anonymous, so the revoked owner is not subscribed');
  } finally {
    ws.close();
  }
});

test('shutdown retracts caret presence over the app-integrated WebSocket', async (_t) => {
  const { app, principalOf } = createAnnotatedDocApp({ db: ':memory:' });
  app.listen(0, { principalOf });
  await app.ready;
  app.db.prepare(`INSERT OR IGNORE INTO User (id, username) VALUES ('demo', 'demo')`).run();
  app.db.prepare(`INSERT OR IGNORE INTO Project (id, owner) VALUES ('p1', 'demo')`).run();

  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const created = await fetch(`${origin}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'caret-shutdown' }),
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();

  const port = app.httpServer.address().port;
  const ws = await openRawWS(port, { query: '?viewAs=demo' });
  let presence = null;
  try {
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Doc', id, carets: ['body'] }));
    const ack = await ws.nextMessage();
    assert.ok(ack, 'subscribed ack received');
    assert.equal(ack.type, 'subscribed');
    // The ack does not echo carets; the subscription's caret interest is
    // proven by the caret.update round-trip below.

    // The create route intentionally creates an empty document. Offset 2 is
    // outside its canonical text and is correctly rejected by caret projection;
    // use the only valid offset to prove the app-integrated fan-out path.
    ws.send(JSON.stringify({ type: 'caret.update', entity: 'Doc', id, field: 'body', offset: 0 }));
    // Slot creation reveals the source connection its OWN presence token first;
    // the upsert fanout (including this connection) follows.
    const own = await ws.nextMessage();
    assert.ok(own, 'caret own frame received');
    assert.equal(own.type, 'annotated-text-caret');
    assert.equal(own.change.op, 'own');
    assert.equal(typeof own.change.presence, 'string');
    assert.notEqual(own.change.presence, '');
    const upsert = await ws.nextMessage();
    assert.ok(upsert, 'caret upsert received');
    assert.equal(upsert.type, 'annotated-text-caret');
    assert.equal(upsert.change.op, 'upsert');
    assert.equal(upsert.change.value.kind, 'caret');
    assert.equal(upsert.change.value.offset, 0);
    presence = upsert.change.value.presence;
    assert.equal(typeof presence, 'string');
    assert.equal(presence, own.change.presence, 'own and upsert share the slot presence');

    // Deliberately no client abort: shutdown alone must close the WS and
    // retract presence with a remove frame for the same token.
    await Promise.race([
      app.shutdown(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('app.shutdown() did not complete while a caret WebSocket was open')), 3000)),
    ]);

    const remove = await ws.nextMessage();
    assert.ok(remove, 'caret remove frame received on shutdown');
    assert.equal(remove.type, 'annotated-text-caret');
    assert.equal(remove.change.op, 'remove');
    assert.equal(remove.change.presence, presence);
  } finally {
    ws.close();
  }
});
