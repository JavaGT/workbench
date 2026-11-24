// Live authorization — subscribe-time AND fan-out, one engine.
//
// This file began as the C1 fan-out test (the missing `await` on `mayVerb(
// 'subscribe')` in `live.emit` made every Promise truthy → every subscriber
// received the event). C1 fixed fan-out. H2 adds the missing second half: a
// client must be AUTHORIZED to subscribe in the first place. Before H2 the
// handshake admitted ANY {entity,id} string pair, returned the per-scope
// currentSeq (an existence/activity oracle), and allowed unbounded subscriptions
// per connection (memory DoS).
//
// Post-H2 the subscribe handshake runs the SAME engine as fan-out —
// bindReadScope + mayVerb('subscribe') — before storing the subscription or
// revealing currentSeq. A denied subscribe returns a uniform `{type:'error'}`
// (no 403/404 split → no existence leak) and NEVER the cursor. This also
// RETIRES the old C1 scenario ("bob subscribes successfully, then blocked at
// fan-out"): subscribe-time + fan-out share one mayVerb, so bob (read-only,
// no subscribe cap) can't enter the registry at all. The staleness test below
// — a legitimately-subscribed viewer who is then REVOKED — is the one
// remaining guard that the fan-out `await` still does its work.

import { text, ref, grant, read, write, subscribe, scope, everyone, User, Inbox } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

import workbench, { entity, generateDDL, executeDDL } from '../build/internal.mjs';
import { Doc } from '../projects/doc.mjs';

// A Note anyone may READ but only the owner may SUBSCRIBE to. Widening the
// read-scope to `everyone` keeps bob/anonymous IN read-scope (so a read
// succeeds) while the `.can` grants them only `read` — the subscribe denial is
// then a CAPABILITY denial, not a scope denial, which is what H2 must catch.
function makeNote() {
  return entity('Note', {
        body: text(), owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(everyone()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

// Raw WS harness: identifies the principal via an `x-test-user` header the
// test principalOf reads (two connections → two principals through one app).
// `nextMessage` returns any parsed frame; `nextEvent` filters to type==='event'.
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

    async function nextEvent(timeoutMs = 400) {
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

    function close() { try { sock.destroy(); } catch { /* ignore */ } }
  });
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const principalOf = (req) => {
  const u = req.headers?.['x-test-user'];
  return u ? { type: 'user', id: u } : { type: 'anonymous', id: null };
};

function bootNote() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  db.exec("INSERT INTO User (id, username, password) VALUES ('1', 'alice', 'hash')");
  db.exec("INSERT INTO User (id, username, password) VALUES ('2', 'bob', 'hash')");
  const Note = makeNote();
  for (const sql of generateDDL(Note)) db.exec(sql);
  db.prepare("INSERT INTO Note (id, body, owner) VALUES ('n1', 'hello', '1')").run();
  const app = workbench({ db }).mount('/notes', Note);
  app.listen(0, { principalOf });
  return { app, origin: '' };
}

test('H2: an ANONYMOUS subscribe is DENIED (no currentSeq leak)', async () => {
  const { app } = bootNote();
  await app.ready;
  const { port } = app.httpServer.address();
  let anon;
  try {
    anon = await openRawWS(port, null);
    anon.send(JSON.stringify({ type: 'subscribe', requestId: 41, entity: 'Note', id: 'n1' }));
    const msg = await anon.nextMessage();
    // Denied: an error, never a 'subscribed' ack, and never the cursor.
    assert.ok(msg, 'server must respond to the subscribe');
    assert.notEqual(msg.type, 'subscribed', 'anonymous must not be admitted');
    assert.equal(msg.requestId, 41, 'denial identifies only its subscribe request');
    assert.equal(msg.currentSeq, undefined, 'denied subscribe must not leak currentSeq');
    // And nothing arrives later.
    assert.equal(await anon.nextEvent(150), null);
  } finally {
    anon?.close();
    app.live?.close();
    app.httpServer.close();
  }
});

test('H2: an authenticated-but-read-only principal is DENIED a subscribe', async () => {
  const { app } = bootNote();
  await app.ready;
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;
  let bob;
  try {
    bob = await openRawWS(port, '2'); // bob is authenticated but not the owner
    bob.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
    const msg = await bob.nextMessage();
    assert.ok(msg, 'server must respond');
    assert.notEqual(msg.type, 'subscribed', 'read-only principal must not be admitted');
    assert.equal(msg.currentSeq, undefined, 'denied subscribe must not leak currentSeq');

    // Sanity: alice (owner) CAN read the note over HTTP — the denial is about
    // `subscribe`, not `read`.
    const r = await fetch(`${origin}/notes/n1`, { headers: { 'x-test-user': '2' } });
    assert.equal(r.status, 200, 'bob may still READ the note');
  } finally {
    bob?.close();
    app.live?.close();
    app.httpServer.close();
  }
});

test('H2: the OWNER subscribes and receives the live event (positive fan-out)', async () => {
  const { app } = bootNote();
  await app.ready;
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;
  let alice;
  try {
    alice = await openRawWS(port, '1');
    alice.send(JSON.stringify({ type: 'subscribe', requestId: 42, entity: 'Note', id: 'n1' }));
    const ack = await alice.nextMessage();
    assert.equal(ack.type, 'subscribed', 'owner is admitted');
    assert.equal(ack.requestId, 42, 'ack identifies its subscribe request');
    assert.ok(typeof ack.currentSeq === 'number', 'admitted subscribe returns the cursor');

    const r = await fetch(`${origin}/notes/n1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': '1' },
      body: JSON.stringify({ body: 'updated' }),
    });
    assert.equal(r.status, 200, 'alice (owner) may mutate');

    const ev = await alice.nextEvent();
    assert.ok(ev, 'owner receives the live event');
    assert.equal(ev.event.type, 'Note.updated');
  } finally {
    alice?.close();
    app.live?.close();
    app.httpServer.close();
  }
});

test('H2: a REVOKED subscriber is denied at fan-out (the await guard)', async () => {
  // The one post-H2 guard that the fan-out `await mayVerb('subscribe')` still
  // fires: bob subscribes while he IS a viewer (admitted), then alice removes
  // him and mutates the doc. Bob is still in the subscriber registry, but the
  // per-event re-authorization must now deny him. If the `await` were removed,
  // bob would receive the event despite the revocation.
  const db = new DatabaseSync(':memory:');
  executeDDL(User, db);
  executeDDL(Doc, db);
  executeDDL(Inbox, db);
  db.prepare("INSERT INTO User (id, username, password) VALUES (1, 'alice', 'salt:a')").run();
  db.prepare("INSERT INTO User (id, username, password) VALUES (2, 'bob', 'salt:b')").run();

  const app = workbench({ db }).mount('/docs', Doc);
  app.listen(0, { principalOf });
  await app.ready;
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  let bob;
  try {
    // alice creates a doc and adds bob as a viewer.
    const created = await fetch(`${origin}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': '1' },
      body: JSON.stringify({ title: 'shared-doc' }),
    });
    assert.equal(created.status, 201, 'alice creates the doc');
    const doc = await created.json();
    const docId = doc.id;
    // Instead of using the HTTP share API (which needs bound User), insert directly via SQL
    db.prepare(`INSERT INTO Doc_collaborators (Doc_id, member_id, role) VALUES (?, ?, ?)`).run(docId, '2', 'viewer');

    // bob (now a viewer) subscribes to the doc — admitted (viewer grants
    // subscribe).
    bob = await openRawWS(port, '2');
    bob.send(JSON.stringify({ type: 'subscribe', entity: 'Doc', id: docId }));
    const ack = await bob.nextMessage();
    assert.equal(ack.type, 'subscribed', 'viewer is admitted to subscribe');

    // Revoke via direct SQL instead of HTTP share API
    db.prepare(`DELETE FROM Doc_collaborators WHERE Doc_id = ? AND member_id = ?`).run(docId, '2');

    const patched = await fetch(`${origin}/docs/${docId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': '1' },
      body: JSON.stringify({ title: 'updated-title' }),
    });
    assert.equal(patched.status, 200, 'alice mutates the doc');

    // bob is still subscribed but no longer authorized — the awaited fan-out
    // re-authorization must deny him both the revoke event and the title event.
    assert.equal(await bob.nextEvent(300), null, 'revoked subscriber receives nothing');
  } finally {
    bob?.close();
    app.live?.close();
    app.httpServer.close();
  }
});
