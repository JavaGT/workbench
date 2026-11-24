// HTTP/SSE transport forwarding for delta delivery (#159, epic #155).
//
// The #159 round-2 review (CRITICAL) found the negotiation was dropped at the
// HTTP transport boundary: the client advertises `snapshot-patch/v1` +
// projectionToken on every bootstrap/catchup/subscribe call, but the HTTP
// handler never forwarded them, so delta delivery was unreachable over the
// transport Studio actually uses — every rename fell back to a full snapshot
// bootstrap. The fixes under test:
//
//   1. live-delivery-http.ts forwards `capabilities` + `projectionToken`
//      through bootstrap/catchup/subscribe into the delivery seam.
//   2. workbench-client.mjs, in delta mode, turns a transport `resync` /
//      `state-invalidate` control into a CATCH-UP (journal patches pulled from
//      the held cursor+token) instead of a full snapshot bootstrap.
//
// This test proves the acceptance end-to-end over REAL HTTP + REAL SSE: one
// snapshot bootstrap, then a real code rename is delivered as a server-
// produced patch via the delta-mode catch-up — never a second snapshot
// bootstrap. Everything is real except the dispatch transport (the kernel
// action POST, which is not part of the gap) and the EventSource (node has no
// global; the shim below reads the real SSE stream frame by frame).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, inherit, ref, text, grant, read, subscribe, write as _write, scope, everyone, snapshot } from '../build/index.mjs';
const { object, select, include: _include, keyed, orderBy } = snapshot;
import { executeDDL } from '../build/internal.mjs';
import { createLiveDeliveryHttpHandler } from '../build/server.mjs';
import { createLiveDeliveryHttpSession } from '../public/workbench-client.mjs';

const alice = { type: 'user', id: 'alice', attributes: {} };
const CAP = 'snapshot-patch/v1';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT, owner TEXT);
    CREATE TABLE User (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE Code (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), label TEXT, colour TEXT, position INTEGER);
  `);
  const User = entity('User', {
    name: text({ optional: true }),
    grant: () => grant(read),
  });
  const Project = entity('Project', {
    name: text(),
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, subscribe))],
  });
  const Code = entity('Code', {
    projectId: ref(Project, { immutable: true }),
    label: text(),
    colour: text({ optional: true }),
    position: text({ optional: true }),
    grant: inherit(Project, { via: 'projectId' }),
  });
  const crudAction = (table, scopeOf) => {
    const projections = [
      {
        eventTypes: [`${table}.created`, `${table}.updated`],
        apply(event, tx) {
          const columns = Object.keys(event.data).filter((key) => key !== 'id');
          const sets = columns.map((column) => `${column} = excluded.${column}`).join(', ');
          tx.prepare(`INSERT INTO ${table} (${['id', ...columns].join(', ')}) VALUES (${['id', ...columns].map(() => '?').join(', ')})
            ON CONFLICT(id) DO UPDATE SET ${sets}`).run(...['id', ...columns].map((key) => event.data[key] ?? null));
        },
      },
      {
        eventTypes: [`${table}.removed`],
        apply(event, tx) {
          tx.prepare(`DELETE FROM ${table} WHERE id = ?`).run(event.data.id);
        },
      },
    ];
    return {
      type: `${table.toLowerCase()}.write`,
      authorize: ({ principal: p }) => p.id === 'alice',
      handler: ({ payload }) => {
        const events = [];
        if (!payload.exists) events.push({ type: `${table}.created`, scope: scopeOf(payload), data: payload.row });
        else if (payload.removed) events.push({ type: `${table}.removed`, scope: scopeOf(payload), data: { id: payload.row.id } });
        else events.push({ type: `${table}.updated`, scope: scopeOf(payload), data: payload.row });
        return { events };
      },
      projections,
    };
  };
  executeDDL(User, db);
  executeDDL(Project, db);
  executeDDL(Code, db);
  const projectScope = (payload) => `Project:${payload.projectId}`;
  const app = workbench({
    db,
    entities: [Project, Code, User],
    actions: [
      crudAction('Project', (payload) => `Project:${payload.row.id}`),
      crudAction('Code', projectScope),
    ],
  });
  app.attachLiveDelivery({
    principalOf: () => alice,
    snapshots: [snapshot(Project, {
      output: object({
        name: select(Project.field.name),
        codes: keyed(Code, {
          via: Code.field.projectId,
          orderBy: orderBy(Code.field.position, 'asc'),
          include: object({ codeFields: select(Code.field.label, Code.field.colour) }),
        }),
      }),
    })],
  });
  return { app, db };
}

async function serve(handler) {
  const server = http.createServer((req, res) => handler(req, res).then((handled) => {
    if (!handled && !res.writableEnded) res.writeHead(404).end();
  }));
  server.listen(0);
  await once(server, 'listening');
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/live-delivery` };
}

// node has no global EventSource; read the real SSE stream via fetch streaming.
function sseSource(url, _options) {
  const controller = new AbortController();
  const source = {
    onmessage: null,
    onerror: null,
    close() { controller.abort(); },
  };
  void (async () => {
    let response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted) source.onerror?.(error);
      return;
    }
    if (!response.ok || !response.body) {
      source.onerror?.(new Error(`SSE stream ${response.status}`));
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
          if (dataLine && typeof source.onmessage === 'function') {
            source.onmessage({ data: dataLine.slice('data:'.length).trim() });
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) source.onerror?.(error);
    }
  })();
  return source;
}

async function waitFor(check, label, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('HTTP/SSE forwards the delta negotiation: one snapshot bootstrap, then a real rename arrives as a server-produced patch via delta-mode catch-up — never a second bootstrap', async () => {
  const { app, db } = fixture();
  const scope = 'Project:p1';
  await app.ddl();
  app.listen(0);
  await app.ready;
  const delivery = app._applicationLiveDelivery.delivery;
  try {
    const dispatchOk = async (mutation) => {
      const result = await app.dispatch({ principal: alice, ...mutation, through: 'journal-only' });
      assert.equal(result.ok, true, JSON.stringify(result));
    };
    await dispatchOk({ actionId: 'p0', type: 'project.write', scope, payload: { exists: false, row: { id: 'p1', name: 'Research' } } });
    await dispatchOk({ actionId: 'c0', type: 'code.write', scope, payload: { exists: false, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'Identity', position: '1' } } });

    const handler = createLiveDeliveryHttpHandler({ delivery, principalOf: () => alice, maxSubscriptions: 10 });
    const { server, baseUrl } = await serve(handler);
    try {
      // Count ONLY snapshot-mode bootstraps (delta-mode catch-ups legitimately
      // reuse the /bootstrap endpoint with mode=catchup).
      let snapshotBootstraps = 0;
      const countingFetch = async (input, init) => {
        const url = new URL(String(input), 'http://workbench.local');
        if (url.pathname.endsWith('/bootstrap') && url.searchParams.get('mode') === 'snapshot') snapshotBootstraps += 1;
        return fetch(input, init);
      };

      const session = createLiveDeliveryHttpSession({
        baseUrl,
        scope,
        validateSnapshot: (value) => value,
        historySession: 'transport-test-tab',
        fetchImpl: countingFetch,
        eventSourceFactory: sseSource,
        sendAction: async () => ({ ok: true }),
      });
      await session.ready;
      assert.equal(session.deltaCapable, true, 'HTTP bootstrap echoed protocol + token → delta armed');
      assert.equal(session.projectionToken.length > 0, true, 'bootstrap minted a projection token');
      assert.equal(session.snapshot.codes.code1.label, 'Identity');
      assert.equal(snapshotBootstraps, 1, 'exactly one snapshot bootstrap at ready');

      // REAL rename committed through the REAL kernel (journal → composite
      // journal → projector → delivery). The SSE stream pushes a resync
      // control; in delta mode the client catch-ups over HTTP and folds the
      // server-produced patch — no second snapshot bootstrap.
      await app.dispatch({ principal: alice, actionId: 'rename-1', type: 'code.write', scope, payload: { exists: true, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'Renamed', position: '1' } }, through: 'journal-only' });

      await waitFor(() => session.snapshot?.codes?.code1?.label === 'Renamed', 'the rename lands in the client snapshot');
      assert.equal(snapshotBootstraps, 1, 'rename must NOT trigger a second snapshot bootstrap (delta-mode catch-up instead)');
      assert.equal(session.status, 'live');
      session.close();
    } finally {
      server.close();
    }
  } finally {
    app.httpServer.closeAllConnections?.();
    await app.shutdown();
    db.close();
  }
});

test('HTTP transport accepts composite {anchor, composite} cursors in catch-up (delta delivery cursor shape)', async () => {
  // Regression for the #159 transport gap: afterFrom only recognized the
  // {anchor, aggregate} cursor shape, so a delta catch-up carrying the
  // composite cursor was rejected with 'invalid live delivery request'.
  const delivery = {
    bootstrap: async () => ({ kind: 'snapshot', snapshot: {}, cursor: { anchor: 2, composite: 2 } }),
    catchup: async (input) => {
      assert.deepEqual(input.after, { anchor: 2, composite: 2 });
      assert.deepEqual(input.capabilities, [CAP]);
      assert.equal(input.projectionToken, 'wbpt_x');
      return { kind: 'catchup', envelopes: [], cursor: input.after };
    },
    subscribe: async () => ({ activate: async () => 0 }),
  };
  const handler = createLiveDeliveryHttpHandler({ delivery, principalOf: () => alice, maxSubscriptions: 2 });
  const { server, baseUrl } = await serve(handler);
  try {
    const encoded = encodeURIComponent(JSON.stringify({ anchor: 2, composite: 2 }));
    const query = `?scope=Project%3Ap1&mode=catchup&after=${encoded}&capabilities=${encodeURIComponent(CAP)}&projectionToken=wbpt_x`;
    const response = await fetch(`${baseUrl}/bootstrap${query}`);
    assert.equal(response.status, 200, 'composite cursor catch-up must be accepted');
    const body = await response.json();
    assert.equal(body.kind, 'catchup');
  } finally {
    server.close();
  }
});
