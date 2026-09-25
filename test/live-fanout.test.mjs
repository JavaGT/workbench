import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLiveFanout } from '../build/live-fanout.mjs';
import { scope } from '../build/internal.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function makeConn(id, principalId = id) {
  const messages = [];
  return {
    id,
    closed: false,
    principal: { type: 'user', id: principalId },
    send(message) { messages.push(message); },
    drain() { const out = [...messages]; messages.length = 0; return out; },
  };
}

function makeEntity({ fields = {}, row = { id: 'd1', title: 'v1' } } = {}) {
  return {
    name: 'Doc',
    fields,
    grant: () => [scope().can(() => true)],
    findById() { return row; },
  };
}

test('live fanout exits before hydration when the event scope has no subscribers', async () => {
  let hydrations = 0;
  const entity = makeEntity();
  entity.findById = () => {
    hydrations += 1;
    return entity.fields;
  };
  const fanout = createLiveFanout({ mayVerb: async () => true });

  await fanout.emit(entity, 'd1', undefined, { type: 'Doc.updated', seq: 1, data: { id: 'd1' } });

  assert.equal(hydrations, 0);
});

test('live fanout stores subscriptions and removes them per connection', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const entity = makeEntity();

  fanout.addSubscription('Doc', 'd1', conn);
  fanout.addSubscription('Doc', 'd2', conn);

  assert.equal(fanout.subscriptionCount(conn), 2);
  assert.equal(fanout.hasSubscription(conn, 'Doc', 'd1'), true);

  fanout.removeSubscription('Doc', 'd1', conn);
  assert.equal(fanout.subscriptionCount(conn), 1);
  assert.equal(fanout.hasSubscription(conn, 'Doc', 'd1'), false);

  await fanout.emit(entity, 'd1', { id: 'd1', title: 'ignored' }, { type: 'Doc.created', seq: 1, data: { id: 'd1' } });
  assert.deepEqual(conn.drain(), []);

  fanout.removeAll(conn);
  assert.equal(fanout.subscriptionCount(conn), 0);
  assert.equal(fanout.hasSubscription(conn, 'Doc', 'd2'), false);
});

test('live fanout re-authorizes delivery through the injected mayVerb engine', async () => {
  const calls = [];
  const fanout = createLiveFanout({
    mayVerb: async (entity, verb, row, principal) => {
      calls.push({ entity: entity.name, verb, row, principal });
      return principal.id === 'alice';
    },
  });
  const alice = makeConn('c1', 'alice');
  const bob = makeConn('c2', 'bob');
  const entity = makeEntity({ row: { id: 'd1', title: 'new' } });

  fanout.addSubscription('Doc', 'd1', alice);
  fanout.addSubscription('Doc', 'd1', bob);

  await fanout.emit(entity, 'd1', { id: 'd1', title: 'new' }, {
    type: 'Doc.created', seq: 7, data: { id: 'd1', title: 'new' },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.verb), ['subscribe', 'subscribe']);
  assert.deepEqual(alice.drain(), [{
    type: 'event', entity: 'Doc', id: 'd1', seq: 7,
    seqSpan: [7, 7], event: { type: 'Doc.created', seq: 7, data: { id: 'd1' } },
  }]);
  assert.deepEqual(bob.drain(), []);
  assert.equal(fanout.hasSubscription(bob, 'Doc', 'd1'), true, 'denied subscriber remains registered');
});

test('live fanout strips framework-only event metadata', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  fanout.addSubscription('Doc', 'd1', conn);
  await fanout.emit(makeEntity(), 'd1', { id: 'd1' }, {
    type: 'Doc.created', seq: 1,
    data: { id: 'd1', __workbench: { annotatedText: { body: { initialBlockId: 'secret' } } } },
  });
  assert.deepEqual(conn.drain()[0].event.data, { id: 'd1' });
});

test('live fanout invalidates annotated-text operations without serializing their facts', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const entity = makeEntity({ fields: { body: { kind: 'annotatedText' } } });
  fanout.addSubscription('Doc', 'd1', conn);

  await fanout.emit(entity, 'd1', { id: 'd1' }, {
    type: 'Doc.body.operated', seq: 7,
    data: {
      operation: ['secret operation'], family: { text: 'secret body' },
      memberships: ['secret-membership'], protectedTargetIds: ['secret-target'],
    },
  });
  await nextTurn();

  const messages = conn.drain();
  assert.deepEqual(messages, [{
    type: 'resync', entity: 'Doc', id: 'd1', seq: 7,
    reason: 'annotated-text-snapshot-required',
  }]);
  assert.equal(JSON.stringify(messages).includes('secret'), false);
});

test('live fanout drops annotated-text operations with invalid sequence metadata', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const entity = makeEntity({ fields: { body: { kind: 'annotatedText' } } });
  fanout.addSubscription('Doc', 'd1', conn);

  await fanout.emit(entity, 'd1', { id: 'd1' }, {
    type: 'Doc.body.operated', seq: Number.MAX_SAFE_INTEGER + 1,
    data: { operation: ['secret operation'], family: { text: 'secret body' } },
  });

  assert.deepEqual(conn.drain(), []);
});

test('live fanout invalidates generic ephemeral cells on annotated-text entities without buffering them', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const entity = makeEntity({
    fields: { body: { kind: 'annotatedText' }, cursor: { kind: 'ephemeral' } },
  });
  fanout.addSubscription('Doc', 'd1', conn, { cursor: true }, { window: 20, by: 'latest-wins' });

  await fanout.emit(entity, 'd1', { id: 'd1' }, {
    type: 'Doc.cursor.set', seq: 8,
    data: { owner: 'd1', client: 'secret-client', cells: { offset: 42, selectedText: 'secret body' } },
  });
  await nextTurn();

  const messages = conn.drain();
  assert.deepEqual(messages, [{
    type: 'resync', entity: 'Doc', id: 'd1', seq: 8,
    reason: 'annotated-text-snapshot-required',
  }]);
  assert.equal(JSON.stringify(messages).includes('secret'), false);
  await sleep(40);
  assert.deepEqual(conn.drain(), [], 'forbidden cells never enter a paced buffer');
});

test('live fanout drops annotated ephemeral cells with invalid sequence metadata', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const entity = makeEntity({
    fields: { body: { kind: 'annotatedText' }, cursor: { kind: 'ephemeral' } },
  });
  fanout.addSubscription('Doc', 'd1', conn, { cursor: true });

  await fanout.emit(entity, 'd1', { id: 'd1' }, {
    type: 'Doc.cursor.set', seq: Number.MAX_SAFE_INTEGER + 1,
    data: { cells: { offset: 42 } },
  });

  assert.deepEqual(conn.drain(), []);
});

test('live fanout delivers removed events without re-authorization', async () => {
  let calls = 0;
  const fanout = createLiveFanout({
    mayVerb: async () => { calls += 1; return false; },
  });
  const conn = makeConn('c1', 'revoked');
  const entity = makeEntity();

  fanout.addSubscription('Doc', 'd1', conn);
  await fanout.emit(entity, 'd1', undefined, { type: 'Doc.removed', seq: 3 });

  assert.equal(calls, 0, 'remove is the revocation signal, so delivery skips mayVerb');
  assert.deepEqual(conn.drain(), [{
    type: 'event', entity: 'Doc', id: 'd1', seq: 3,
    seqSpan: [3, 3], event: { type: 'Doc.removed', seq: 3 },
  }]);
});

test('live fanout re-authorizes paced flush and clears the buffer on denial', async () => {
  let allowed = true;
  const fanout = createLiveFanout({ mayVerb: async () => allowed });
  const conn = makeConn('c1', 'alice');
  const entity = makeEntity({
    fields: { cursor: { kind: 'ephemeral' } },
    row: { id: 'd1', title: 'drawing' },
  });

  fanout.addSubscription('Doc', 'd1', conn, { cursor: true }, { window: 20, by: 'latest-wins' });
  await fanout.emit(entity, 'd1', { id: 'd1', title: 'drawing' }, {
    type: 'Doc.cursor.set', seq: 1, data: { x: 1 },
  });
  await fanout.emit(entity, 'd1', { id: 'd1', title: 'drawing' }, {
    type: 'Doc.cursor.set', seq: 2, data: { x: 2 },
  });

  allowed = false;
  await sleep(60);

  assert.deepEqual(conn.drain(), [], 'revoked subscriber receives nothing at flush time');

  allowed = true;
  await sleep(30);
  assert.deepEqual(conn.drain(), [], 'denied flush clears the buffer instead of retrying stale events');
});

test('live fanout close clears paced timers before they emit', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1', 'alice');
  const entity = makeEntity({
    fields: { cursor: { kind: 'ephemeral' } },
    row: { id: 'd1', title: 'drawing' },
  });

  fanout.addSubscription('Doc', 'd1', conn, { cursor: true }, { window: 20, by: 'latest-wins' });
  await fanout.emit(entity, 'd1', { id: 'd1', title: 'drawing' }, {
    type: 'Doc.cursor.set', seq: 1, data: { x: 1 },
  });

  fanout.close();
  await sleep(60);

  assert.deepEqual(conn.drain(), []);
  assert.equal(fanout.subscriptionCount(conn), 0);
});

test('live fanout coalesces a burst of annotated-text controls to one high-water resync', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const entity = makeEntity({ fields: { body: { kind: 'annotatedText' } } });
  fanout.addSubscription('Doc', 'd1', conn);

  // Start the burst in one turn. Sequential `await emit()` would yield after
  // each authorization and flush the previous control before the next queues.
  await Promise.all(Array.from({ length: 50 }, (_, index) => fanout.emit(entity, 'd1', { id: 'd1' }, {
    type: 'Doc.body.operated', seq: index + 1,
    data: { operation: ['secret'], family: { text: 'secret' } },
  })));
  await nextTurn();
  assert.deepEqual(conn.drain(), [{
    type: 'resync', entity: 'Doc', id: 'd1', seq: 50,
    reason: 'annotated-text-snapshot-required',
  }], 'a 50-control burst collapses to one high-water resync');
});
