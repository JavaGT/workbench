import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { executeFrameworkDDL } from '../build/ddl.mjs';
import { createServer, durableMutationVariant, liveMutationVariant } from '../build/pipeline.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { createLiveFanout } from '../build/live-fanout.mjs';

test('createServer reuses caller writeQueue without nesting a second mutex when already owned (#283)', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const queue = createWriteQueue();
  let runCalls = 0;
  const wrappedQueue = {
    run(fn) {
      runCalls += 1;
      return queue.run(fn);
    },
    close: () => queue.close(),
    get depth() { return queue.depth; },
    get running() { return queue.running; },
    get closed() { return queue.closed; },
    get owned() { return queue.owned; },
  };
  const server = createServer({
    db,
    writeQueue: wrappedQueue,
    handlers: {
      'Note.create': ({ payload }) => [{ type: 'Note.created', scope: `Note:${payload.id}`, data: payload }],
    },
    authorize: async () => true,
  });

  // Outer writeQueue turn owns the mutex; commitEvents must join directly without re-entering queue.run.
  const outcome = await wrappedQueue.run(() => server.dispatch({
    actionId: 'owned-1',
    type: 'Note.create',
    scope: 'Note:n1',
    payload: { id: 'n1', body: 'hello' },
    principal: { type: 'user', id: 'u1' },
  }));
  assert.equal(outcome.ok, true);
  assert.equal(runCalls, 1, 'outer writeQueue.run was the sole mutex acquisition');

  // Direct dispatch without outer wrapper acquires the same writeQueue once.
  const direct = await server.dispatch({
    actionId: 'direct-2',
    type: 'Note.create',
    scope: 'Note:n2',
    payload: { id: 'n2', body: 'world' },
    principal: { type: 'user', id: 'u1' },
  });
  assert.equal(direct.ok, true);
  assert.equal(runCalls, 2, 'direct dispatch serialized through the shared writeQueue');
  db.close();
});

test('standalone createServer serializes concurrent durable dispatches via one WriteQueue (#283)', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Counter (id TEXT PRIMARY KEY, value INTEGER NOT NULL)');
  db.prepare('INSERT INTO Counter (id, value) VALUES (?, ?)').run('c1', 0);

  const server = createServer({
    db,
    handlers: {
      'Counter.inc': ({ payload }) => [{ type: 'Counter.updated', scope: `Counter:${payload.id}`, data: { id: payload.id } }],
    },
    pipeline: durableMutationVariant({
      projectionConsumers: [{
        eventTypes: ['Counter.updated'],
        applyAsync: async (event, txnDb) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          txnDb.prepare('UPDATE Counter SET value = value + 1 WHERE id = ?').run(event.data.id);
        },
      }],
    }),
    authorize: async () => true,
  });

  const [r1, r2, r3] = await Promise.all([
    server.dispatch({ actionId: 'a1', type: 'Counter.inc', scope: 'Counter:c1', payload: { id: 'c1' }, principal: { id: 'u1' } }),
    server.dispatch({ actionId: 'a2', type: 'Counter.inc', scope: 'Counter:c1', payload: { id: 'c1' }, principal: { id: 'u1' } }),
    server.dispatch({ actionId: 'a3', type: 'Counter.inc', scope: 'Counter:c1', payload: { id: 'c1' }, principal: { id: 'u1' } }),
  ]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, true);
  assert.equal(db.prepare('SELECT value FROM Counter WHERE id = ?').get('c1').value, 3);
  db.close();
});

test('durableMutationVariant and liveMutationVariant share admission, projection, blob, effect-depth, and afterCommit semantics (#283)', async () => {
  assert.throws(() => durableMutationVariant({ maxEffectDepth: -1 }), /durableMutationVariant: maxEffectDepth/);
  assert.throws(() => liveMutationVariant({ maxEffectDepth: -1 }), /liveMutationVariant: maxEffectDepth/);

  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);

  for (const [label, createVariant] of [
    ['durable', durableMutationVariant],
    ['live', liveMutationVariant],
  ]) {
    const order = [];
    const variant = createVariant({
      admission: {
        beforeProjection: async ({ verb }) => { order.push(`before:${verb}`); return true; },
        afterProjection: async ({ verb }) => { order.push(`after:${verb}`); return true; },
        annotatedMutation: {
          before: () => { order.push('annotated:before'); return 'snap'; },
          after: async ({ state }) => { order.push(`annotated:after:${state}`); },
        },
      },
      projectionConsumers: [{
        eventTypes: ['Item.created'],
        actionType: 'Item.create',
        privateFact: true,
        applyAsync: async (_ev, _db, ctx) => {
          order.push(`project:${ctx.privateFact.tag}:${ctx.claimedBlobs?.file}`);
        },
      }],
      blobAdapter: {
        adoptInTxn: async () => { order.push('blob:adopt'); },
      },
      postCommitConsumers: [
        async () => { throw new Error('fanout error must be isolated'); },
        async (events) => { order.push(`postCommit:${events.length}`); },
      ],
    });

    assert.equal(variant.requiresPrivateFact([{ type: 'Item.created' }], 'Item.create'), true, `${label} requiresPrivateFact true`);
    assert.equal(variant.requiresPrivateFact([{ type: 'Item.created' }], 'Item.other'), false, `${label} requiresPrivateFact false`);

    const finalized = await variant.applyInTxn(db, [{ type: 'Item.created', scope: `Item:${label}`, data: { id: label } }], {
      now: '2026-01-01T00:00:00.000Z',
      actionId: `act-${label}`,
      nextSeq: () => 1,
      principal: { type: 'user', id: 'u1' },
      payload: [{ type: 'Item.create' }],
      type: '$batch',
      scope: `Item:${label}`,
      privateFact: { tag: label },
      claimedBlobs: { file: 'blob-1' },
    });
    assert.equal(finalized.length, 1);
    await variant.afterCommit(finalized, { db });

    assert.deepEqual(order, [
      'before:create',
      'annotated:before',
      `project:${label}:blob-1`,
      'blob:adopt',
      'annotated:after:snap',
      'after:create',
      'postCommit:1',
    ], `${label} variant preserves exact stage order`);
  }
  db.close();
});

test('live-fanout exposes only wired surfaces and still validates/evicts on revoke (#283)', () => {
  const fanout = createLiveFanout({});
  assert.equal('onRevocation' in fanout, false, 'unused fanout.onRevocation listener registry removed');

  const conn = { id: 'c1', closed: false, principal: { type: 'user', id: 'u1' }, send() {} };
  fanout.addSubscription('Doc:d1', conn, null, null, { carets: ['body'] });
  const [[, spec]] = fanout.recipients('Doc:d1', 'body');
  assert.equal('latch' in spec, false, 'unused latch field removed from subscription spec');

  fanout.revoke({ type: 'user', id: 'u1' }, { category: 'entity', key: 'Doc:d1' });
  assert.equal(fanout.hasSubscription(conn, 'Doc:d1'), false);

  fanout.addSubscription('Doc:d2', conn);
  fanout.revoke({ type: 'user', id: 'u1' }, { category: 'principal', key: 'user:u1' });
  assert.equal(fanout.subscriptionCount(conn), 0);
  fanout.close();
});
