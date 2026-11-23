// Regression suite for #282 live recovery hardening:
//   1. Permanent composite-patch fallback after a declaration-wide invalidation.
//   2. Cross-project composite resync blast radius (targeted resyncScope vs entity-wide fallback).
//   3. Client double-snapshot fallback loop + stale resync short-circuit in receive().

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, inherit, ref, text, grant, read, subscribe, scope, everyone, snapshot } from '../build/index.mjs';
const { object, select, keyed, many, orderBy } = snapshot;
import { executeDDL, executeFrameworkDDL } from '../build/internal.mjs';
import { createLiveDeliveryCore } from '../build/live-delivery-core.mjs';
import { createLiveDeliverySession } from '../public/workbench-client.mjs';

const alice = { type: 'user', id: 'alice', attributes: {} };
const CAP = 'snapshot-patch/v1';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function rowProjections(table) {
  return [
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
}

function crudAction(table, scopeOf) {
  return {
    type: `${table.toLowerCase()}.write`,
    authorize: () => true,
    handler: ({ payload }) => {
      const events = [];
      if (!payload.exists) events.push({ type: `${table}.created`, scope: scopeOf(payload), data: payload.row });
      else if (payload.removed) events.push({ type: `${table}.removed`, scope: scopeOf(payload), data: { id: payload.row.id } });
      else events.push({ type: `${table}.updated`, scope: scopeOf(payload), data: payload.row });
      return { events };
    },
    projections: rowProjections(table),
  };
}

async function setupCompositeApp(t, { mutableCodeProject = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT, owner TEXT);
    CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE Code (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), label TEXT, position INTEGER);
    CREATE TABLE Note (id TEXT PRIMARY KEY, codeId TEXT REFERENCES Code(id), projectId TEXT REFERENCES Project(id), title TEXT);
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
    projectId: ref(Project, mutableCodeProject ? {} : { immutable: true }),
    label: text(),
    position: text({ optional: true }),
    grant: inherit(Project, { via: 'projectId' }),
  });
  const Note = entity('Note', {
    projectId: ref(Project, { immutable: true }),
    codeId: ref(Code),
    title: text(),
    grant: inherit(Project, { via: 'projectId' }),
  });
  executeDDL(Code, db);
  executeDDL(Note, db);

  const app = workbench({
    db,
    entities: [Project, Code, Note, User],
    actions: [
      crudAction('Project', (payload) => `Project:${payload.row.id}`),
      crudAction('Code', (payload) => payload.scope ?? `Project:${payload.projectId}`),
      crudAction('Note', (payload) => payload.scope ?? `Project:${payload.projectId}`),
      {
        type: 'user.write',
        authorize: () => true,
        handler: ({ payload }) => ({
          events: [{ type: payload.exists ? 'User.updated' : 'User.created', scope: `User:${payload.row.id}`, data: payload.row }],
        }),
        projections: rowProjections('User'),
      },
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
          include: object({
            codeFields: select(Code.field.label),
            notes: many(Note, {
              via: Note.field.codeId,
              orderBy: orderBy(Note.field.id, 'asc'),
              select: select(Note.field.title),
            }),
          }),
        }),
      }),
    })],
  });
  await app.ddl();
  app.listen(0);
  await app.ready;
  t.after(async () => {
    app.httpServer.closeAllConnections?.();
    await app.shutdown();
    db.close();
  });
  return {
    app,
    db,
    delivery: app._applicationLiveDelivery.delivery,
    consumer: app._applicationLiveDelivery.consumer,
    core: app._applicationLiveDelivery.core,
  };
}

async function dispatchOk(app, request) {
  const result = await app.dispatch({ principal: alice, ...request });
  assert.equal(result.ok, true, `dispatch failed for ${request.type}: ${JSON.stringify(result)}`);
  return result;
}

// =============================================================================
// 1. Composite patch wide-change watermark recovery (#282 bug 1)
// =============================================================================

test('#282-1: incremental snapshot-patch/v1 resumes after one fallback bootstrap absorbs a declaration-wide invalidation', async (t) => {
  const { app, delivery } = await setupCompositeApp(t);
  await dispatchOk(app, { actionId: 'p1', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'Alpha' } } });
  await dispatchOk(app, { actionId: 'c1', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'One', position: '1' } } });

  const boot1 = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: [CAP] });
  assert.equal(boot1.kind, 'snapshot');
  assert.equal(boot1.protocol, CAP);

  // Trigger a declaration-wide invalidation (authorization-dependency User write).
  await dispatchOk(app, { actionId: 'u-wide-1', type: 'user.write', scope: 'User:u1', payload: { exists: false, row: { id: 'u1', name: 'Member' } } });

  // Catch-up #1 MUST fall back to a full snapshot to absorb the wide invalidation.
  const fallback1 = await delivery.catchup({
    principal: alice,
    scope: 'Project:p1',
    after: boot1.cursor,
    capabilities: [CAP],
    projectionToken: boot1.projectionToken,
  });
  assert.equal(fallback1.kind, 'snapshot', 'first catch-up after wide invalidation falls back once');
  assert.equal(fallback1.protocol, CAP);
  assert.equal(typeof fallback1.projectionToken, 'string');

  // Subsequent scoped change MUST resume incremental snapshot-patch/v1 delivery
  // (previously stuck permanently on snapshot fallback until pruning).
  await dispatchOk(app, { actionId: 'c1-upd', type: 'code.write', scope: 'Project:p1', payload: { exists: true, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'Two', position: '1' } } });
  const patch1 = await delivery.catchup({
    principal: alice,
    scope: 'Project:p1',
    after: fallback1.cursor,
    capabilities: [CAP],
    projectionToken: fallback1.projectionToken,
  });
  assert.equal(patch1.kind, 'catchup', 'subsequent catch-up resumes incremental patch delivery');
  assert.equal(patch1.envelopes.length, 1);
  assert.equal(patch1.envelopes[0].type, 'snapshot-patch');
  assert.equal(patch1.envelopes[0].protocol, CAP);
  assert.ok(
    patch1.envelopes[0].operations.some((op) => op.op === 'put-keyed' && op.id === 'code1' && op.value.label === 'Two'),
    'patch carries the incremental code update',
  );

  // A second scoped change continues chaining cleanly over the rotated token.
  await dispatchOk(app, { actionId: 'c2-add', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code2', projectId: 'p1', label: 'Three', position: '2' } } });
  const patch2 = await delivery.catchup({
    principal: alice,
    scope: 'Project:p1',
    after: patch1.cursor,
    capabilities: [CAP],
    projectionToken: patch1.envelopes[0].projectionToken,
  });
  assert.equal(patch2.kind, 'catchup', 'second incremental catch-up chains cleanly');
  assert.ok(patch2.envelopes[0].operations.some((op) => op.op === 'put-keyed' && op.id === 'code2'));

  // A SECOND wide invalidation forces exactly ONE fallback again, then resumes patches.
  await dispatchOk(app, { actionId: 'u-wide-2', type: 'user.write', scope: 'User:u2', payload: { exists: false, row: { id: 'u2', name: 'Member 2' } } });
  const fallback2 = await delivery.catchup({
    principal: alice,
    scope: 'Project:p1',
    after: patch2.cursor,
    capabilities: [CAP],
    projectionToken: patch2.envelopes[0].projectionToken,
  });
  assert.equal(fallback2.kind, 'snapshot', 'second wide invalidation triggers one fallback snapshot');

  // Presenting the stale pre-invalidation token must still fall back (never reuse newer watermark).
  const staleTokenOutcome = await delivery.catchup({
    principal: alice,
    scope: 'Project:p1',
    after: patch2.cursor,
    capabilities: [CAP],
    projectionToken: patch2.envelopes[0].projectionToken,
  });
  assert.equal(staleTokenOutcome.kind, 'snapshot', 'pre-invalidation predecessor token still falls back');

  // Fresh token from fallback2 resumes incremental patches immediately.
  await dispatchOk(app, { actionId: 'p1-ren', type: 'project.write', scope: 'Project:p1', payload: { exists: true, row: { id: 'p1', name: 'Alpha-2' } } });
  const patch3 = await delivery.catchup({
    principal: alice,
    scope: 'Project:p1',
    after: fallback2.cursor,
    capabilities: [CAP],
    projectionToken: fallback2.projectionToken,
  });
  assert.equal(patch3.kind, 'catchup', 'incremental patches resume after second wide invalidation');
  assert.equal(patch3.envelopes[0].type, 'snapshot-patch');
});

test('#282-1: wide invalidation for an unrelated declaration does not force fallback on Project catch-up', async (t) => {
  const { app, db, delivery } = await setupCompositeApp(t);
  const { recordCompositeChanges } = await import('../build/composite-journal.mjs');
  await dispatchOk(app, { actionId: 'p1', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'Alpha' } } });
  const boot = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: [CAP] });
  assert.equal(boot.kind, 'snapshot');

  // Record a wide invalidation targeting a different declaration ('Other').
  recordCompositeChanges(db, [{
    scope: '',
    declaration: 'Other',
    actionId: 'other-wide-1',
    eventRefs: [],
    affected: [],
    invalidating: true,
  }], new Date().toISOString());

  await dispatchOk(app, { actionId: 'c1', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'A', position: '1' } } });
  const outcome = await delivery.catchup({
    principal: alice,
    scope: 'Project:p1',
    after: boot.cursor,
    capabilities: [CAP],
    projectionToken: boot.projectionToken,
  });
  assert.equal(outcome.kind, 'catchup', 'unrelated declaration wide change must not force Project fallback');
  assert.equal(outcome.envelopes[0].type, 'snapshot-patch');
});

// =============================================================================
// 2. Cross-project composite resync blast radius (#282 bug 2)
// =============================================================================

async function subscribeComposite(delivery, scopeKey, after) {
  const received = [];
  const controller = new AbortController();
  const activation = await delivery.subscribe({
    principal: alice,
    scope: scopeKey,
    after,
    signal: controller.signal,
    deliver: async (batch) => { received.push(...batch); },
  });
  await activation.activate();
  return { received, close: () => controller.abort() };
}

test('#282-2: core.resyncScope targets only the matching scope and never disturbs sibling scopes', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  db.exec("INSERT INTO Project (id, name) VALUES ('p1', 'One'), ('p2', 'Two')");
  const Project = entity('Project', { name: text(), grant: () => grant(read, subscribe) });
  const entities = new Map([['Project', Project]]);
  const core = createLiveDeliveryCore({
    db,
    entities,
    mayVerb: async () => true,
    projectRecipient: () => [],
  });
  const p1 = [];
  const p2 = [];
  const c1 = new AbortController();
  const c2 = new AbortController();
  await core.subscribe({ principal: alice, scope: 'Project:p1', after: 0, signal: c1.signal, deliver: (b) => { p1.push(...b); } });
  await core.subscribe({ principal: alice, scope: 'Project:p2', after: 0, signal: c2.signal, deliver: (b) => { p2.push(...b); } });

  core.resyncScope('Project:p1', { type: 'resync', entity: 'Project', id: 'p1', seq: 0, reason: 'recipient-snapshot-required' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(p1.length, 1, 'target scope receives resync');
  assert.equal(p1[0].id, 'p1');
  assert.equal(p2.length, 0, 'sibling scope receives zero resyncs');
  c1.abort();
  c2.abort();
  core.close();
  db.close();
});

test('#282-2: anchor and member mutations on Project:p1 resync ONLY Project:p1, never Project:p2', async (t) => {
  const { app, delivery, consumer } = await setupCompositeApp(t);
  await dispatchOk(app, { actionId: 'p1', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'P1' } } });
  await dispatchOk(app, { actionId: 'p2', type: 'project.write', scope: 'Project:p2', payload: { exists: false, row: { id: 'p2', name: 'P2' } } });

  const b1 = await delivery.bootstrap({ principal: alice, scope: 'Project:p1' });
  const b2 = await delivery.bootstrap({ principal: alice, scope: 'Project:p2' });
  const sub1 = await subscribeComposite(delivery, 'Project:p1', b1.cursor);
  const sub2 = await subscribeComposite(delivery, 'Project:p2', b2.cursor);
  t.after(() => { sub1.close(); sub2.close(); });

  // 1. Project:p1 anchor update + member create on inherited scope Project:p1.
  await dispatchOk(app, { actionId: 'p1-upd', type: 'project.write', scope: 'Project:p1', payload: { exists: true, row: { id: 'p1', name: 'P1-renamed' } } });
  await dispatchOk(app, { actionId: 'c1-add', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'Theme', position: '1' } } });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.ok(sub1.received.some((env) => env.type === 'resync' && env.id === 'p1'), 'Project:p1 received resync');
  assert.equal(sub2.received.length, 0, 'Project:p2 must receive ZERO resyncs for Project:p1 mutations');

  // 2. Member-scoped event (Code:code1) with projectId in payload / DB row.
  sub1.received.length = 0;
  await consumer([{ type: 'Code.updated', scope: 'Code:code1', data: { id: 'code1', projectId: 'p1', label: 'Theme2' } }]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(sub1.received.some((env) => env.type === 'resync' && env.id === 'p1'), 'member-scoped Code event resynced Project:p1');
  assert.equal(sub2.received.length, 0, 'member-scoped Code event did NOT resync Project:p2');

  // 3. Nested member-scoped event (Note:n1 -> Code:code1 -> Project:p1) without projectId in event data.
  await dispatchOk(app, { actionId: 'n1-add', type: 'note.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'n1', codeId: 'code1', projectId: 'p1', title: 'Quote' } } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  sub1.received.length = 0;
  sub2.received.length = 0;
  await consumer([{ type: 'Note.updated', scope: 'Note:n1', data: { id: 'n1', title: 'Quote 2' } }]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(sub1.received.some((env) => env.type === 'resync' && env.id === 'p1'), 'nested Note event resynced Project:p1');
  assert.equal(sub2.received.length, 0, 'nested Note event did NOT resync Project:p2');
});

test('#282-2: cross-project reparent resyncs both old and new project scopes while sparing unrelated Project:p3', async (t) => {
  const { app, delivery } = await setupCompositeApp(t, { mutableCodeProject: true });
  await dispatchOk(app, { actionId: 'p1', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'P1' } } });
  await dispatchOk(app, { actionId: 'p2', type: 'project.write', scope: 'Project:p2', payload: { exists: false, row: { id: 'p2', name: 'P2' } } });
  await dispatchOk(app, { actionId: 'p3', type: 'project.write', scope: 'Project:p3', payload: { exists: false, row: { id: 'p3', name: 'P3' } } });
  await dispatchOk(app, { actionId: 'c1', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'Movable', position: '1' } } });

  const b1 = await delivery.bootstrap({ principal: alice, scope: 'Project:p1' });
  const b2 = await delivery.bootstrap({ principal: alice, scope: 'Project:p2' });
  const b3 = await delivery.bootstrap({ principal: alice, scope: 'Project:p3' });
  const sub1 = await subscribeComposite(delivery, 'Project:p1', b1.cursor);
  const sub2 = await subscribeComposite(delivery, 'Project:p2', b2.cursor);
  const sub3 = await subscribeComposite(delivery, 'Project:p3', b3.cursor);
  t.after(() => { sub1.close(); sub2.close(); sub3.close(); });

  // Reparent code1 from p1 -> p2 via its member scope Code:code1.
  await dispatchOk(app, {
    actionId: 'c1-move',
    type: 'code.write',
    scope: 'Code:code1',
    payload: { exists: true, scope: 'Code:code1', projectId: 'p2', row: { id: 'code1', projectId: 'p2', label: 'Movable', position: '1' } },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.ok(sub1.received.some((env) => env.type === 'resync' && env.id === 'p1'), 'old parent Project:p1 received resync');
  assert.ok(sub2.received.some((env) => env.type === 'resync' && env.id === 'p2'), 'new parent Project:p2 received resync');
  assert.equal(sub3.received.length, 0, 'unrelated Project:p3 received ZERO resyncs');
});

test('#282-2: falls back to entity-wide resync ONLY when anchor ID genuinely cannot be determined', async (t) => {
  const { app, db, delivery, consumer } = await setupCompositeApp(t);
  await dispatchOk(app, { actionId: 'p1', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'P1' } } });
  await dispatchOk(app, { actionId: 'p2', type: 'project.write', scope: 'Project:p2', payload: { exists: false, row: { id: 'p2', name: 'P2' } } });

  const b1 = await delivery.bootstrap({ principal: alice, scope: 'Project:p1' });
  const b2 = await delivery.bootstrap({ principal: alice, scope: 'Project:p2' });
  const sub1 = await subscribeComposite(delivery, 'Project:p1', b1.cursor);
  const sub2 = await subscribeComposite(delivery, 'Project:p2', b2.cursor);
  t.after(() => { sub1.close(); sub2.close(); });

  // Direct removal event on member scope with no DB row, no projectId in data, and no _CompositeChange entry.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM Code WHERE id = 'ghost'").get().n, 0);
  await consumer([{ type: 'Code.removed', scope: 'Code:ghost', data: { id: 'ghost' } }]);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.ok(sub1.received.some((env) => env.type === 'resync' && env.id === 'p1'), 'entity-wide fallback resyncs Project:p1');
  assert.ok(sub2.received.some((env) => env.type === 'resync' && env.id === 'p2'), 'entity-wide fallback resyncs Project:p2');
});

// =============================================================================
// 3. Client double-snapshot fallback loop & stale resync short-circuit (#282 bug 3)
// =============================================================================

test('#282-3: in-flight resync covered by attempt #1 closes the cycle without kicking a redundant second full snapshot', async () => {
  const attempt1 = deferred();
  const attempt1Started = deferred();
  let bootstraps = 0;
  let deliver;

  const session = createLiveDeliverySession({
    bootstrap: async ({ mode }) => {
      assert.equal(mode, 'snapshot');
      bootstraps += 1;
      if (bootstraps === 1) return { kind: 'snapshot', snapshot: { v: 1 }, cursor: 1 };
      if (bootstraps === 2) {
        attempt1Started.resolve();
        return attempt1.promise;
      }
      return { kind: 'snapshot', snapshot: { v: bootstraps }, cursor: 10 };
    },
    subscribe: async ({ deliver: d }) => { deliver = d; return { close() {} }; },
    validateSnapshot: (v) => v,
    optimistic: (s) => s,
    sendAction: async () => ({ ok: true, actionId: 'act-1', confirmedThrough: 3 }),
    createActionId: () => 'act-1',
  });
  await session.ready;
  assert.equal(bootstraps, 1);

  // Trigger recovery attempt #1 (e.g. from a resync at seq 3).
  const firstResync = deliver([{ type: 'resync', seq: 3, reason: 'recipient-snapshot-required' }]);
  await attempt1Started.promise;
  assert.equal(bootstraps, 2);

  // While attempt #1 is in flight, a second resync arrives at seq 5 (via a
  // second concurrent batch / queued delivery that enters after or during attempt #1).
  const secondResync = deliver([{ type: 'resync', seq: 5, reason: 'recipient-snapshot-required' }]);

  // Attempt #1 resolves with a snapshot whose cursor (5) already covers BOTH seq 3 and seq 5.
  attempt1.resolve({ kind: 'snapshot', snapshot: { v: 2 }, cursor: 5 });
  await Promise.all([firstResync, secondResync]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(bootstraps, 2, 'attempt #1 already covered seq 5 — no redundant second full snapshot');
  assert.equal(session.cursor, 5);
  assert.deepEqual(session.snapshot, { v: 2 });
  session.close();
});

test('#282-3: in-flight resync hitting snapshotRecoveryRunning directly does NOT kick a second snapshot when attempt #1 covers latestCoverage', async () => {
  // Drive requestSnapshotRecovery while snapshotRecoveryRunning === true by
  // having attempt #1 triggered via a receipt (snapshotOnly) while a resync
  // control arrives inline via a concurrent deliver() on a non-blocked path,
  // AND by having two resyncs trigger during an active attempt.
  const attempt1 = deferred();
  const attempt1Started = deferred();
  let bootstraps = 0;
  let deliver;
  const session = createLiveDeliverySession({
    bootstrap: async () => {
      bootstraps += 1;
      if (bootstraps === 1) return { kind: 'snapshot', snapshot: { v: 1 }, cursor: 1 };
      if (bootstraps === 2) {
        attempt1Started.resolve();
        return attempt1.promise;
      }
      return { kind: 'snapshot', snapshot: { v: bootstraps }, cursor: 6 };
    },
    subscribe: async ({ deliver: d }) => { deliver = d; return { close() {} }; },
    validateSnapshot: (v) => v,
    fold: (s) => s,
    optimistic: (s) => s,
    sendAction: async () => ({ ok: true }),
  });
  await session.ready;

  // Start attempt #1 via resync(seq: 4).
  const p1 = deliver([{ type: 'resync', seq: 4, reason: 'recipient-snapshot-required' }]);
  await attempt1Started.promise;
  // Queue a second resync(seq: 4) and a third resync(seq: 6) while attempt #1 is in flight.
  const p2 = deliver([{ type: 'resync', seq: 4, reason: 'recipient-snapshot-required' }]);
  const p3 = deliver([{ type: 'resync', seq: 6, reason: 'recipient-snapshot-required' }]);

  // Attempt #1 installs cursor 6 (covers 4 and 6).
  attempt1.resolve({ kind: 'snapshot', snapshot: { v: 2 }, cursor: 6 });
  await Promise.all([p1, p2, p3]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(bootstraps, 2, 'single snapshot covered seq 4 and seq 6 with zero extra bootstraps');
  assert.equal(session.cursor, 6);
  assert.deepEqual(session.snapshot, { v: 2 });
  session.close();
});

test('#282-3: when attempt #1 does NOT cover latestCoverage, a follow-up snapshot STILL runs to reach it', async () => {
  const attempt1 = deferred();
  const attempt1Started = deferred();
  let bootstraps = 0;
  let deliver;

  const session = createLiveDeliverySession({
    bootstrap: async () => {
      bootstraps += 1;
      if (bootstraps === 1) return { kind: 'snapshot', snapshot: { v: 1 }, cursor: 1 };
      if (bootstraps === 2) {
        attempt1Started.resolve();
        return attempt1.promise;
      }
      return { kind: 'snapshot', snapshot: { v: 3 }, cursor: 10 };
    },
    subscribe: async ({ deliver: d }) => { deliver = d; return { close() {} }; },
    validateSnapshot: (v) => v,
    fold: (s) => s,
    optimistic: (s) => s,
    sendAction: async () => ({ ok: true }),
  });
  await session.ready;

  const p1 = deliver([{ type: 'resync', seq: 4, reason: 'recipient-snapshot-required' }]);
  await attempt1Started.promise;
  const p2 = deliver([{ type: 'resync', seq: 10, reason: 'recipient-snapshot-required' }]);

  // Attempt #1 only reaches cursor 5 (< 10).
  attempt1.resolve({ kind: 'snapshot', snapshot: { v: 2 }, cursor: 5 });
  await Promise.all([p1, p2]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(bootstraps, 3, 'uncovered seq 10 must still trigger follow-up snapshot');
  assert.equal(session.cursor, 10);
  assert.deepEqual(session.snapshot, { v: 3 });
  session.close();
});

test('#282-3: receive() short-circuits stale resync (coverage <= cursor) while preserving state-invalidate and seq:0 member resyncs', async () => {
  let bootstraps = 0;
  let deliver;
  const session = createLiveDeliverySession({
    bootstrap: async () => {
      bootstraps += 1;
      return { kind: 'snapshot', snapshot: { v: bootstraps }, cursor: 10 };
    },
    subscribe: async ({ deliver: d }) => { deliver = d; return { close() {} }; },
    validateSnapshot: (v) => v,
    fold: (s) => s,
    optimistic: (s) => s,
    sendAction: async () => ({ ok: true }),
  });
  await session.ready;
  assert.equal(bootstraps, 1);
  assert.equal(session.cursor, 10);

  // Stale resyncs strictly below and equal to cursor 10 are short-circuited.
  await deliver([{ type: 'resync', seq: 5, reason: 'recipient-snapshot-required' }]);
  await deliver([{ type: 'resync', seq: 10, reason: 'recipient-snapshot-required' }]);
  assert.equal(bootstraps, 1, 'stale resync controls at seq <= 10 trigger zero snapshots');

  // Synthetic member-invalidation resync (seq: 0) MUST NOT be short-circuited.
  await deliver([{ type: 'resync', seq: 0, reason: 'recipient-snapshot-required' }]);
  assert.equal(bootstraps, 2, 'seq: 0 composite member invalidation still recovers');

  // state-invalidate (bounded-overflow / topology boundary) MUST NOT be short-circuited even with seq <= cursor.
  await deliver([{ type: 'state-invalidate', seq: 10, reason: 'bounded-overflow' }]);
  assert.equal(bootstraps, 3, 'state-invalidate still recovers via full snapshot');

  session.close();
});

test('#282-3: composite cursor short-circuits strictly older resync (coverage < anchor) while still recovering seq === anchor and seq === 0', async () => {
  let bootstraps = 0;
  let deliver;
  const session = createLiveDeliverySession({
    bootstrap: async () => {
      bootstraps += 1;
      return { kind: 'snapshot', snapshot: { v: bootstraps }, cursor: { anchor: 10, aggregate: bootstraps } };
    },
    subscribe: async ({ deliver: d }) => { deliver = d; return { close() {} }; },
    validateSnapshot: (v) => v,
    optimistic: (s) => s,
    sendAction: async () => ({ ok: true }),
  });
  await session.ready;
  assert.equal(bootstraps, 1);

  // Strictly older anchor seq (5 < 10) short-circuits.
  await deliver([{ type: 'resync', seq: 5, reason: 'recipient-snapshot-required' }]);
  assert.equal(bootstraps, 1, 'strictly older resync seq < anchor short-circuits');

  // Equal anchor seq (10 === 10) on composite cursor may represent a subscribe-time
  // aggregate bump without anchor movement — must still recover.
  await deliver([{ type: 'resync', seq: 10, reason: 'recipient-snapshot-required' }]);
  assert.equal(bootstraps, 2, 'composite resync at seq === anchor still recovers');

  // seq: 0 member invalidation must still recover.
  await deliver([{ type: 'resync', seq: 0, reason: 'recipient-snapshot-required' }]);
  assert.equal(bootstraps, 3, 'composite resync at seq === 0 still recovers');

  session.close();
});

test('#282-3: non-consecutive [resync(3), notification, resync(5)] recovers once when first snapshot reaches cursor 5', async () => {
  let bootstraps = 0;
  let deliver;
  const session = createLiveDeliverySession({
    bootstrap: async () => {
      bootstraps += 1;
      if (bootstraps === 1) return { kind: 'snapshot', snapshot: { v: 1 }, cursor: 1 };
      return { kind: 'snapshot', snapshot: { v: 2 }, cursor: 5 };
    },
    subscribe: async ({ deliver: d }) => { deliver = d; return { close() {} }; },
    validateSnapshot: (v) => v,
    fold: (s) => s,
    optimistic: (s) => s,
    sendAction: async () => ({ ok: true }),
  });
  await session.ready;
  assert.equal(bootstraps, 1);

  await deliver([
    { type: 'resync', seq: 3, reason: 'recipient-snapshot-required' },
    { type: 'notification', kind: 'ping' },
    { type: 'resync', seq: 5, reason: 'recipient-snapshot-required' },
  ]);
  assert.equal(bootstraps, 2, 'second control already covered by cursor 5 triggers no extra bootstrap');
  assert.equal(session.cursor, 5);
  session.close();
});

