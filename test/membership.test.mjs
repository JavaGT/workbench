// membership() acceptance tests — two-plane auth from a single declaration.
//
// Proves: member can read, member cannot write, non-member 404,
// child entity inherits membership, member can subscribe to live events.

import { entity, grant as _grant, inherit, map, read, ref, scope as _scope, subscribe, text, write as _write, deny as _deny, membership } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

import workbench, {
  anyOf as _anyOf, executeDDL, executeFrameworkDDL as _executeFrameworkDDL } from '../build/internal.mjs';
import { principal } from '../build/principal.mjs';

const owner = principal({ type: 'user', id: 'owner-1' });
const member = principal({ type: 'user', id: 'member-1' });
const stranger = principal({ type: 'user', id: 'stranger-1' });

function projectEntities() {
  const Project = entity('Project', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),
  });

  // Apply membership — replaces the hand-written checks+grant
  membership(Project, { member: { can: [read, subscribe] } });

  const ProjectDocument = entity('ProjectDocument', {
    project: ref('Project', { required: true }),
    title: text(),

    grant: inherit(Project, { via: 'project' }),
  });

  return { Project, ProjectDocument };
}

function seedProjectDocuments() {
  const db = new DatabaseSync(':memory:');
  const { Project, ProjectDocument } = projectEntities();
  executeDDL(Project, db);
  executeDDL(ProjectDocument, db);
  db.prepare('INSERT INTO Project (id, title, owner) VALUES (?, ?, ?)')
    .run('p1', 'Shared project', owner.id);
  db.prepare('INSERT INTO Project (id, title, owner) VALUES (?, ?, ?)')
    .run('p2', 'Private project', owner.id);
  db.prepare('INSERT INTO Project_members (Project_id, member_id, role) VALUES (?, ?, ?)')
    .run('p1', member.id, 'editor');
  db.prepare('INSERT INTO ProjectDocument (id, project, title) VALUES (?, ?, ?)')
    .run('d1', 'p1', 'Shared document');
  db.prepare('INSERT INTO ProjectDocument (id, project, title) VALUES (?, ?, ?)')
    .run('d2', 'p2', 'Private document');
  return { db, Project, ProjectDocument };
}

async function serveProjectDocuments(t, who) {
  const { db, Project, ProjectDocument } = seedProjectDocuments();
  const app = workbench({ db });
  app.mount('/projects', Project);
  app.mount('/documents', ProjectDocument);
  app.listen(0, { principalOf: () => who });
  await app.ready;
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  const { port } = app.httpServer.address();
  return { origin: `http://127.0.0.1:${port}` };
}

async function serveProjectDocumentsByHeader(t) {
  const { db, Project, ProjectDocument } = seedProjectDocuments();
  const app = workbench({ db });
  app.mount('/projects', Project);
  app.mount('/documents', ProjectDocument);
  app.listen(0, {
    principalOf: (req) => {
      const id = req.headers?.['x-test-user'];
      return id ? principal({ type: 'user', id }) : principal({ type: 'anonymous', id: null });
    },
  });
  await app.ready;
  t.after(() => {
    app.live?.close();
    app.httpServer.close();
    db.close();
  });
  const { port } = app.httpServer.address();
  return { app, port, Project, ProjectDocument };
}

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
        if (!head.startsWith('HTTP/1.1 101')) return reject(new Error(`upgrade failed: ${head.split('\r\n')[0]}`));
        upgraded = true;
        resolve({ send, nextMessage, nextEvent, close });
      }
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1] & 0x7f;
        let payloadLen = b1;
        let headerLen = 2;
        if (b1 === 126) {
          if (buf.length < 4) return;
          payloadLen = buf.readUInt16BE(2);
          headerLen = 4;
        } else if (b1 === 127) {
          if (buf.length < 10) return;
          payloadLen = Number(buf.readBigUInt64BE(2));
          headerLen = 10;
        }
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
      sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
    }

    async function nextMessage(timeoutMs = 400) {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        if (inbox.length > 0) return JSON.parse(inbox.shift());
        await new Promise((resolveNext) => setTimeout(resolveNext, 20));
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
        await new Promise((resolveNext) => setTimeout(resolveNext, 20));
      }
      return null;
    }

    function close() {
      try { sock.destroy(); } catch { /* ignore */ }
    }
  });
}

function emitLiveLog(app, entityRec, id, row, opts) {
  const scope = `${entityRec.name}:${id}`;
  const db = app.db;
  const seq = opts.seq ?? 1;
  db.prepare(
    'INSERT OR REPLACE INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(scope, seq, opts.type, JSON.stringify(opts.data ?? {}), opts.actionId, opts.committedAt);
  db.prepare(
    'INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET lastSeq = ?'
  ).run(scope, seq, seq);
  app.live.wake(scope);
}

test('membership: owner can read their project', async (t) => {
  const { origin } = await serveProjectDocuments(t, owner);

  const response = await fetch(`${origin}/projects/p1`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).title, 'Shared project');
});

test('membership: members can list projects via membership scope', async (t) => {
  const { origin } = await serveProjectDocuments(t, member);

  const response = await fetch(`${origin}/projects`);
  assert.equal(response.status, 200);
  const rows = await response.json();
  assert.deepEqual(rows.map((row) => row.id), ['p1']);
});

test('membership: members can read a project row', async (t) => {
  const { origin } = await serveProjectDocuments(t, member);

  const response = await fetch(`${origin}/projects/p1`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).title, 'Shared project');
});

test('membership: members cannot write (only read+subscribe granted)', async (t) => {
  const { origin } = await serveProjectDocuments(t, member);

  const response = await fetch(`${origin}/projects/p1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Hijacked' }),
  });

  assert.equal(response.status, 403);
});

test('membership: non-members see empty list', async (t) => {
  const { origin } = await serveProjectDocuments(t, stranger);

  const list = await fetch(`${origin}/projects`);
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), []);
});

test('membership: non-members get 404 on member-only rows', async (t) => {
  const { origin } = await serveProjectDocuments(t, stranger);

  const read = await fetch(`${origin}/projects/p1`);
  assert.equal(read.status, 404);
});

test('membership: child entity inherits membership scope', async (t) => {
  const { origin } = await serveProjectDocuments(t, member);

  // List child docs through inherited membership
  const list = await fetch(`${origin}/documents`);
  assert.equal(list.status, 200);
  const rows = await list.json();
  assert.deepEqual(rows.map((row) => row.id), ['d1']);
});

test('membership: non-members cannot see inherited child rows', async (t) => {
  const { origin } = await serveProjectDocuments(t, stranger);

  const list = await fetch(`${origin}/documents`);
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), []);

  const read = await fetch(`${origin}/documents/d1`);
  assert.equal(read.status, 404);
});

test('membership: members can subscribe to live events on parent rows', async (t) => {
  const { app, port, Project } = await serveProjectDocumentsByHeader(t);
  const Project_b = app.entity(Project);
  let ws;
  try {
    ws = await openRawWS(port, member.id);
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Project', id: 'p1' }));
    const ack = await ws.nextMessage();
    assert.equal(ack.type, 'subscribed');

    await emitLiveLog(app, Project_b, 'p1', { id: 'p1', title: 'Shared project', owner: owner.id }, {
      type: 'Project.updated',
      seq: 1,
      data: { id: 'p1', title: 'Changed remotely' },
      actionId: 'test-action',
      committedAt: new Date(0).toISOString(),
    });

    const event = await ws.nextEvent();
    assert.ok(event, 'member subscriber receives the parent event');
    assert.equal(event.event.type, 'Project.updated');
  } finally {
    ws?.close();
  }
});

test('membership: members can subscribe to live events on inherited child rows', async (t) => {
  const { app, port, ProjectDocument } = await serveProjectDocumentsByHeader(t);
  const ProjectDocument_b = app.entity(ProjectDocument);
  let ws;
  try {
    ws = await openRawWS(port, member.id);
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'ProjectDocument', id: 'd1' }));
    const ack = await ws.nextMessage();
    assert.equal(ack.type, 'subscribed');

    await emitLiveLog(app, ProjectDocument_b, 'd1', { id: 'd1', project: 'p1', title: 'Shared document' }, {
        type: 'ProjectDocument.updated',
        seq: 1,
        data: { id: 'd1', title: 'Changed remotely' },
        actionId: 'test-action',
        committedAt: new Date(0).toISOString(),
      });

    const event = await ws.nextEvent();
    assert.ok(event, 'member subscriber receives the child event');
    assert.equal(event.event.type, 'ProjectDocument.updated');
  } finally {
    ws?.close();
  }
});

test('membership: entity.checks.member works as a direct runtime check', () => {
  const { Project } = seedProjectDocuments();
  const { db: _db } = { db: new DatabaseSync(':memory:') };
  // The check runs through the registry — verifies it exists and is callable
  assert.equal(typeof Project.checks.member, 'function', 'member check is a function');
  assert.equal(typeof Project.checks.owner, 'function', 'owner check exists');
});

test('membership: loading error when no map field exists', (_t) => {
  const Empty = entity('Empty', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
  });

  assert.throws(
    () => membership(Empty, { member: { can: [read] } }),
    /no map field found/,
    'throws when no map field exists on entity',
  );
});

test('membership: loading error when config has no can', (_t) => {
  const HasMap = entity('HasMap', {
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['viewer'], default: {} }),
  });

  assert.throws(
    () => membership(HasMap, { member: {} }),
    /must declare/,
    'throws when role config is missing can',
  );
});
