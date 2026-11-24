// Local store tests — log + broadcast relay tests.
// Uses fake-indexeddb for IndexedDB, Node 26's built-in BroadcastChannel.
import 'fake-indexeddb/auto';
import { describe, it, after as _after } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStore, createLocalRelay, normalizeEnvelope } from '../public/workbench-local-store.mjs';
import { openLocalLog } from '../public/workbench-local-log.mjs';
import { makeFakeChannel, makeFakeFetch } from './fixtures/fake-transport.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Fresh DB name per test — avoids cross-test pollution since fake-indexeddb
// deleteDatabase can block when connections are still open.
let _dbSeq = 1;
function freshDbName() {
  return `test-ls-${_dbSeq++}`;
}

/** Yield control to the event loop. */
function _tick() {
  return new Promise(r => setTimeout(r, 0));
}

/** Yield a bit longer for async chains to settle. */
function tickAsync() {
  return new Promise(r => setTimeout(r, 50));
}

// Build a standard WS event envelope for a Todo entity.
function todoEnvelope(id, actionId, type, data, seq = 1) {
  return {
    type: 'event',
    entity: 'Todo',
    id,
    seq,
    seqSpan: [seq, seq],
    event: { type, data, actionId },
    delta: undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('normalizeEnvelope', () => {
  it('converts a created WS envelope to a log entry', () => {
    const env = todoEnvelope('a1', 'act-1', 'Todo.created', { id: 'a1', title: 'Hello' });
    const entry = normalizeEnvelope(env, 'Todo');

    assert.equal(entry.opId, 'act-1');
    assert.equal(entry.seq, 1);
    assert.equal(entry.scope, 'Todo:a1');
    assert.equal(entry.entity, 'Todo');
    assert.equal(entry.rowId, 'a1');
    assert.equal(entry.kind, 'create');
    assert.equal(entry.type, 'Todo.created');
    assert.deepEqual(entry.payload, { id: 'a1', title: 'Hello' });
    assert.equal(entry.preimage, null);
    assert.equal(entry.actionId, 'act-1');
    assert.equal(entry.status, 'committed');
    assert.equal(entry.source, 'remote');
    assert.equal(typeof entry.timestamp, 'number');
  });

  it('converts an updated WS envelope to a log entry', () => {
    const env = todoEnvelope('b1', 'act-2', 'Todo.updated', { id: 'b1', title: 'Updated' });
    const entry = normalizeEnvelope(env, 'Todo');

    assert.equal(entry.kind, 'update');
    assert.equal(entry.type, 'Todo.updated');
    assert.equal(entry.rowId, 'b1');
  });

  it('converts a removed WS envelope to a log entry', () => {
    const env = todoEnvelope('c1', 'act-3', 'Todo.removed', { id: 'c1' });
    const entry = normalizeEnvelope(env, 'Todo');

    assert.equal(entry.kind, 'remove');
    assert.equal(entry.type, 'Todo.removed');
  });

  it('defaults kind to "update" for unknown event types', () => {
    const env = todoEnvelope('d1', 'act-4', 'Todo.customOp', { id: 'd1' });
    const entry = normalizeEnvelope(env, 'Todo');

    assert.equal(entry.kind, 'update');
  });
});

describe('local relay delivery isolation', () => {
  it('a throwing subscriber does not leak an unhandled rejection', async () => {
    const channel = makeFakeChannel();
    const relay = await createLocalRelay({ name: freshDbName(), channel });
    const unhandled = [];
    const onUnhandled = (error) => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);

    try {
      await relay.subscribe('Todo', 'id1', {}, () => {
        throw new Error('consumer failed');
      });
      channel.emit(todoEnvelope('id1', 'act-1', 'Todo.updated', { title: 'next' }));
      await tickAsync();
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      relay.close();
    }
  });
});

describe('createLocalRelay', () => {
  it('subscribe + WS event writes to local log', async () => {
    const dbName = freshDbName();
    const channel = makeFakeChannel();
    const relay = await createLocalRelay({ name: dbName, channel });

    let receivedEnvelope = null;
    await relay.subscribe('Todo', 'id1', {}, (env) => {
      receivedEnvelope = env;
    });

    // Emit a WS event through the fake channel
    const env = todoEnvelope('id1', 'act-1', 'Todo.created', { id: 'id1', title: 'Hello' });
    channel.emit(env);

    // Allow async log write + broadcast to settle
    await tickAsync();

    const log = await openLocalLog(dbName);
    const entries = await log.entriesSince('Todo:id1', 0);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'create');
    assert.equal(entries[0].payload.title, 'Hello');
    assert.equal(entries[0].scope, 'Todo:id1');
    // The original envelope was forwarded to the callback
    assert.deepEqual(receivedEnvelope, env);

    log.close();
    relay.close();
  });

  it('WS event broadcast sends { type: "log-update" }', async () => {
    const dbName = freshDbName();
    const channel = makeFakeChannel();
    const relay = await createLocalRelay({ name: dbName, channel });

    // Listen on a BroadcastChannel with the same name BEFORE emitting
    const bc = new BroadcastChannel(`workbench:live:${dbName}`);
    const signals = [];
    bc.onmessage = (msg) => signals.push(msg.data);

    await relay.subscribe('Todo', 'id1', {}, () => {});

    const env = todoEnvelope('id1', 'act-1', 'Todo.created', { id: 'id1', title: 'Hello' });
    channel.emit(env);

    await tickAsync();

    assert.ok(signals.length >= 1, 'should receive at least one broadcast signal');
    assert.equal(signals[0]?.type, 'log-update');

    bc.close();
    relay.close();
  });

  it('two relays on same DB — event written by one is visible to the other', async () => {
    const dbName = freshDbName();
    const ch1 = makeFakeChannel();
    const ch2 = makeFakeChannel();

    const relay1 = await createLocalRelay({ name: dbName, channel: ch1 });
    const relay2 = await createLocalRelay({ name: dbName, channel: ch2 });

    let relay2Received = null;
    await relay1.subscribe('Todo', 'id1', {}, () => {});
    await relay2.subscribe('Todo', 'id1', {}, (env) => {
      relay2Received = env;
    });

    // Emit through relay1's channel
    const env = todoEnvelope('id1', 'act-1', 'Todo.created', { id: 'id1', title: 'FromRelay1' });
    ch1.emit(env);

    // Wait for broadcast propagation — fake-indexeddb may need extra time
    // for cross-connection transaction visibility.
    await tickAsync();
    await tickAsync();
    await tickAsync();
    await tickAsync();

    // Verify relay2 received the event from the broadcast
    assert.ok(relay2Received, 'relay2 should receive an envelope from the broadcast');
    assert.equal(relay2Received.type, 'event');
    assert.equal(relay2Received.seq, 1);
    assert.equal(relay2Received.event.type, 'Todo.created');
    assert.deepEqual(relay2Received.event.data, { id: 'id1', title: 'FromRelay1' });

    // Also verify the log contains the entry
    const log = await openLocalLog(dbName);
    const entries = await log.entriesSince('Todo:id1', 0);
    assert.equal(entries.length, 1);
    log.close();

    relay1.close();
    relay2.close();
  });

  it('close() tears down relay — underlying channel closed, log closed', async () => {
    const dbName = freshDbName();
    const channel = makeFakeChannel();
    let channelClosed = false;
    const origClose = channel.close;
    channel.close = () => { channelClosed = true; origClose(); };

    const relay = await createLocalRelay({ name: dbName, channel });
    await relay.subscribe('Todo', 'id1', {}, () => {});

    relay.close();

    assert.ok(channelClosed, 'underlying channel should be closed');
    // After close, the DB connection is released.
  });

  it('close during an in-flight log append suppresses late delivery', async () => {
    const dbName = freshDbName();
    const channel = makeFakeChannel();
    const relay = await createLocalRelay({ name: dbName, channel });
    let deliveries = 0;

    await relay.subscribe('Todo', 'id1', {}, () => { deliveries += 1; });
    channel.emit(todoEnvelope(
      'id1', 'act-close', 'Todo.updated', { id: 'id1', title: 'late' }, 1,
    ));
    relay.close();

    await tickAsync();
    assert.equal(deliveries, 0, 'an async callback cannot outlive relay.close()');
  });

  it('delivers multiple events in order', async () => {
    const dbName = freshDbName();
    const channel = makeFakeChannel();
    const relay = await createLocalRelay({ name: dbName, channel });

    const received = [];
    await relay.subscribe('Todo', 'id1', {}, (env) => {
      received.push(env.event.type);
    });

    // Emit three events with increasing seq
    let seq = 0;
    for (const [type, data] of [
      ['Todo.created', { id: 'id1', title: 'First' }],
      ['Todo.updated', { id: 'id1', title: 'Second' }],
      ['Todo.updated', { id: 'id1', title: 'Third' }],
    ]) {
      seq++;
      channel.emit(todoEnvelope('id1', `act-${seq}`, type, data, seq));
    }

    await tickAsync();

    const log = await openLocalLog(dbName);
    const entries = await log.entriesSince('Todo:id1', 0);
    assert.equal(entries.length, 3, 'should have 3 log entries');
    assert.equal(entries[0].seq, 1);
    assert.equal(entries[1].seq, 2);
    assert.equal(entries[2].seq, 3);
    log.close();

    // All three envelopes forwarded to LiveList in order
    assert.deepEqual(received, ['Todo.created', 'Todo.updated', 'Todo.updated']);

    relay.close();
  });
});

describe('createLocalStore', () => {
  it('dispatch via REST creates a log entry', async () => {
    const dbName = freshDbName();
    const channel = makeFakeChannel();

    let postedBody = null;
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { id: null }, seq: 0 } },
      {
        match: '/todos',
        responseFn: (_url) => {
          return { id: 'new-1', title: 'from-rest', status: 'active' };
        },
      },
    ]);

    // Wrap fetch to capture POST body
    const capturingFetch = async (url, opts) => {
      if (opts && opts.method === 'POST') {
        postedBody = opts.body ? JSON.parse(opts.body) : null;
      }
      return fetch(url, opts);
    };

    const store = await createLocalStore({
      baseUrl: 'http://test',
      name: 'Todo',
      path: '/todos',
      local: { name: dbName },
      channel,
      fetchImpl: capturingFetch,
    });

    const result = await store.create({ title: 'from-rest', status: 'active' });
    assert.ok(result.ok);
    assert.equal(result.status, 'committed');
    assert.equal(result.id, 'new-1');
    assert.deepEqual(postedBody, { title: 'from-rest', status: 'active' });

    store.close();
  });

  it('WS event received through a subscribed LiveList is forwarded', async () => {
    const dbName = freshDbName();
    const channel = makeFakeChannel();
    const fetch = makeFakeFetch([
      { match: '/snapshot/Todo/1', response: { snapshot: { id: '1', title: 'initial' }, seq: 0 } },
    ]);

    const store = await createLocalStore({
      baseUrl: 'http://test',
      name: 'Todo',
      path: '/todos',
      local: { name: dbName },
      channel,
      fetchImpl: fetch,
    });

    const list = store.subscribe('1', {});
    await list.ready;
    assert.deepEqual(list.state, { id: '1', title: 'initial' });

    // Now emit a live event through the fake channel
    channel.emit(todoEnvelope('1', 'act-ws', 'Todo.updated', { id: '1', title: 'updated-via-ws' }));

    await tickAsync();

    // LiveList should have applied the event
    assert.deepEqual(list.state, { id: '1', title: 'updated-via-ws' });
    assert.equal(list.cursor, 1);

    // And the relay log should contain the entry too
    const log = await openLocalLog(dbName);
    const entries = await log.entriesSince('Todo:1', 0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'update');
    assert.equal(entries[0].payload.title, 'updated-via-ws');
    log.close();

    store.close();
  });

  it('two stores on same DB name — event arrived at one propagates to the other', async () => {
    const dbName = freshDbName();
    const ch1 = makeFakeChannel();
    const ch2 = makeFakeChannel();

    const fetch1 = makeFakeFetch([
      { match: '/snapshot/Todo/1', response: { snapshot: { id: '1', title: 'start' }, seq: 0 } },
    ]);
    const fetch2 = makeFakeFetch([
      { match: '/snapshot/Todo/1', response: { snapshot: { id: '1', title: 'start' }, seq: 0 } },
    ]);

    const store1 = await createLocalStore({
      baseUrl: 'http://test', name: 'Todo', path: '/todos',
      local: { name: dbName },
      channel: ch1, fetchImpl: fetch1,
    });
    const store2 = await createLocalStore({
      baseUrl: 'http://test', name: 'Todo', path: '/todos',
      local: { name: dbName },
      channel: ch2, fetchImpl: fetch2,
    });

    const list1 = store1.subscribe('1', {});
    const list2 = store2.subscribe('1', {});
    await Promise.all([list1.ready, list2.ready]);

    assert.deepEqual(list1.state, { id: '1', title: 'start' });
    assert.deepEqual(list2.state, { id: '1', title: 'start' });

    // Emit event on store 1's channel
    ch1.emit(todoEnvelope('1', 'act-1', 'Todo.updated', { id: '1', title: 'from-ch1' }));

    // Wait for broadcast propagation to store2.
    // fake-indexeddb needs extra time for cross-connection visibility.
    await tickAsync();
    await tickAsync();
    await tickAsync();
    await tickAsync();

    // Store 1's LiveList got the event directly
    assert.deepEqual(list1.state, { id: '1', title: 'from-ch1' });
    assert.equal(list1.cursor, 1);

    // Store 2's LiveList should also get it via broadcast → log → relay
    assert.deepEqual(list2.state, { id: '1', title: 'from-ch1' }, 'store2 state should match store1');
    assert.equal(list2.cursor, 1, 'store2 cursor should advance');

    store1.close();
    store2.close();
  });

  it('close() on the store also closes the relay (no leaks)', async () => {
    const dbName = freshDbName();
    const channel = makeFakeChannel();
    let channelClosed = false;
    const origClose = channel.close;
    channel.close = () => { channelClosed = true; origClose(); };

    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { id: '1' }, seq: 0 } },
    ]);

    const store = await createLocalStore({
      baseUrl: 'http://test', name: 'Todo', path: '/todos',
      local: { name: dbName },
      channel, fetchImpl: fetch,
    });

    const list = store.subscribe('1', {});
    await list.ready;

    store.close();

    assert.ok(channelClosed, 'underlying fake channel should be closed');

    // Subsequent operations on closed store should be safe
    const result = await store.create({ title: 'x' });
    assert.equal(result.status, 'failed-rolled-back');
  });

  it('handles subscribe with options (fields, pace) passing through to channel', async () => {
    const dbName = freshDbName();
    const channel = makeFakeChannel();
    let subscribeOptions = null;
    const origSubscribe = channel.subscribe;
    channel.subscribe = (entity, id, optsOrFn, maybeFn) => {
      subscribeOptions = typeof optsOrFn === 'function' ? {} : optsOrFn;
      return origSubscribe(entity, id, optsOrFn, maybeFn);
    };

    const fetch = makeFakeFetch([
      { match: '/snapshot/Todo/1', response: { snapshot: { id: '1', title: 'x' }, seq: 0 } },
    ]);

    const store = await createLocalStore({
      baseUrl: 'http://test', name: 'Todo', path: '/todos',
      local: { name: dbName },
      channel, fetchImpl: fetch,
    });

    const list = store.subscribe('1', { fields: { cursor: true }, pace: { profile: '15fps' } });
    await list.ready;

    assert.deepEqual(subscribeOptions.fields, { cursor: true });
    assert.deepEqual(subscribeOptions.pace, { profile: '15fps' });
    assert.equal(typeof subscribeOptions.onCheckpoint, 'function');

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Leader election
// ---------------------------------------------------------------------------

/**
 * Build a fake locks object for testing leader election.
 * `acquired`: sync boolean. true = lock granted immediately (leader).
 * false = lock denied permanently (follower).
 */
function makeFakeLocks({ acquired }) {
  const lock = { mode: 'exclusive' };
  return {
    lock,
    request(name, cb) {
      if (!acquired) {
        // Follower: promise never settles (tab waits in queue)
        return new Promise(() => {});
      }
      // Leader: callback fires synchronously, returns a never-settling promise
      // to hold the lock.
      cb(lock);
      return Promise.resolve();
    },
  };
}

function makeLockCoordinator() {
  let held = false;
  const waiters = [];
  return {
    request(_name, callback) {
      return new Promise((resolve, reject) => {
        const acquire = () => {
          held = true;
          Promise.resolve(callback({ mode: 'exclusive' })).then(() => {
            held = false;
            resolve();
            waiters.shift()?.();
          }, reject);
        };
        if (held) waiters.push(acquire);
        else acquire();
      });
    },
  };
}

describe('leader election', () => {
  it('promotes a follower and reconciles its desired subscriptions when the leader closes', async () => {
    const dbName = freshDbName();
    const locks = makeLockCoordinator();
    const leaderChannel = makeFakeChannel();
    const followerChannel = makeFakeChannel();
    let followerSubscriptions = 0;
    const originalFollowerSubscribe = followerChannel.subscribe;
    followerChannel.subscribe = (...args) => {
      followerSubscriptions += 1;
      return originalFollowerSubscribe(...args);
    };

    const leader = await createLocalRelay({ name: dbName, channel: leaderChannel, locks });
    const follower = await createLocalRelay({ name: dbName, channel: followerChannel, locks });
    let received = null;
    await follower.subscribe('Todo', 'id1', {}, (envelope) => { received = envelope; });
    assert.equal(followerSubscriptions, 0, 'queued tab begins as a broadcast-only follower');

    leader.close();
    await tickAsync();
    assert.equal(followerSubscriptions, 1, 'new leader opens its desired upstream subscription');

    const envelope = todoEnvelope('id1', 'act-promote', 'Todo.updated', { id: 'id1', title: 'live' });
    followerChannel.emit(envelope);
    await tickAsync();
    assert.deepEqual(received, envelope);
    follower.close();
  });

  it('createLocalStore forwards locks so a follower never opens a real subscription', async () => {
    const dbName = freshDbName();
    const channel = makeFakeChannel();
    let realSubscriptions = 0;
    const originalSubscribe = channel.subscribe;
    channel.subscribe = (...args) => {
      realSubscriptions += 1;
      return originalSubscribe(...args);
    };

    const store = await createLocalStore({
      baseUrl: 'http://test', name: 'Todo', path: '/todos',
      local: { name: dbName }, channel,
      locks: makeFakeLocks({ acquired: false }),
      fetchImpl: makeFakeFetch([
        { match: '/snapshot/Todo/id1', response: { snapshot: { id: 'id1' }, seq: 0 } },
      ]),
    });

    const list = store.subscribe('id1');
    await list.ready;
    assert.equal(realSubscriptions, 0);
    store.close();
  });

  it('leader acquires lock and subscribes to real channel; follower skips', async () => {
    const dbName = freshDbName();
    const leaderCh = makeFakeChannel();
    const followerCh = makeFakeChannel();

    let leaderSubscribed = false;
    const origLeaderSub = leaderCh.subscribe;
    leaderCh.subscribe = (...args) => {
      leaderSubscribed = true;
      return origLeaderSub(...args);
    };

    let followerSubscribed = false;
    const origFollowerSub = followerCh.subscribe;
    followerCh.subscribe = (...args) => {
      followerSubscribed = true;
      return origFollowerSub(...args);
    };

    const leaderRelay = await createLocalRelay({
      name: dbName, channel: leaderCh,
      locks: makeFakeLocks({ acquired: true }),
    });
    const followerRelay = await createLocalRelay({
      name: dbName, channel: followerCh,
      locks: makeFakeLocks({ acquired: false }),
    });

    await leaderRelay.subscribe('Todo', 'id1', {}, () => {});
    await followerRelay.subscribe('Todo', 'id1', {}, () => {});

    await tickAsync();

    assert.equal(leaderSubscribed, true, 'leader should subscribe to real channel');
    assert.equal(followerSubscribed, false, 'follower should NOT subscribe to real channel');

    // Leader and follower both subscribe to id2 so the fake channel can
    // deliver to the leader's handler and the follower can receive via broadcast.
    let leaderReceived = null;
    let followerReceived = null;
    await leaderRelay.subscribe('Todo', 'id2', {}, (env) => { leaderReceived = env; });
    await followerRelay.subscribe('Todo', 'id2', {}, (env) => { followerReceived = env; });

    // Allow cursors to prime from log (both start at 0 since log is empty).
    await tickAsync();

    const env = todoEnvelope('id2', 'act-leader', 'Todo.created', { id: 'id2', title: 'from-leader' });
    leaderCh.emit(env);

    // Wait for: log write → broadcast postMessage → follower broadcast.onmessage → log read → onEnvelope
    await tickAsync();
    await tickAsync();
    await tickAsync();
    await tickAsync();

    assert.ok(leaderReceived, 'leader should receive the event directly');
    assert.ok(followerReceived, 'follower should receive the event via broadcast');
    assert.equal(followerReceived.event.type, 'Todo.created');
    assert.equal(followerReceived.event.data.title, 'from-leader');

    leaderRelay.close();
    followerRelay.close();
  });

  it('leader events are visible in log for both tabs', async () => {
    const dbName = freshDbName();
    const leaderCh = makeFakeChannel();
    const followerCh = makeFakeChannel();

    const leaderRelay = await createLocalRelay({
      name: dbName, channel: leaderCh,
      locks: makeFakeLocks({ acquired: true }),
    });
    const followerRelay = await createLocalRelay({
      name: dbName, channel: followerCh,
      locks: makeFakeLocks({ acquired: false }),
    });

    await leaderRelay.subscribe('Todo', 'id1', {}, () => {});
    // Follower subscribes with a broadcast-only callback
    await followerRelay.subscribe('Todo', 'id1', {}, () => {});

    await tickAsync();

    leaderCh.emit(todoEnvelope('id1', 'act-1', 'Todo.created', { id: 'id1', title: 'persisted' }));

    await tickAsync();
    await tickAsync();
    await tickAsync();

    const log = await openLocalLog(dbName);
    const entries = await log.entriesSince('Todo:id1', 0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].payload.title, 'persisted');
    log.close();

    leaderRelay.close();
    followerRelay.close();
  });

  it('without locks param, relay always acts as leader (default mode)', async () => {
    const dbName = freshDbName();
    const ch = makeFakeChannel();

    let subscribed = false;
    const origSub = ch.subscribe;
    ch.subscribe = (...args) => {
      subscribed = true;
      return origSub(...args);
    };

    const relay = await createLocalRelay({ name: dbName, channel: ch });

    await relay.subscribe('Todo', 'id1', {}, () => {});
    await tickAsync();

    assert.equal(subscribed, true, 'without locks, relay subscribes to real channel');

    relay.close();
  });
});

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

describe('undo', () => {
  it('undo(update) restores preimage via inverse dispatch', async () => {
    const dbName = freshDbName();
    const channel = makeFakeChannel();

    let dispatched = [];
    const fetch = makeFakeFetch([
      { match: '/snapshot/Todo/1', response: { snapshot: { id: '1', title: 'Old Title' }, seq: 0 } },
      { match: '/todos/1', status: 200, headers: { 'x-workbench-seq': '1' }, response: { id: '1', title: 'New Title' } },
    ]);
    const capturingFetch = async (url, opts) => {
      if (opts?.method === 'PATCH') {
        dispatched.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
      }
      return fetch(url, opts);
    };

    const store = await createLocalStore({
      baseUrl: 'http://test', name: 'Todo', path: '/todos',
      local: { name: dbName },
      channel, fetchImpl: capturingFetch,
    });

    const list = store.subscribe('1', {});
    await list.ready;
    assert.deepEqual(list.state, { id: '1', title: 'Old Title' });

    const result = await store.update('1', { title: 'New Title' });
    assert.ok(result.ok);

    const undoResult = await store.undo(result.opId);
    assert.ok(undoResult.ok);

    assert.equal(dispatched.length, 2);
    assert.deepEqual(dispatched[1], { url: 'http://test/todos/1', body: { id: '1', title: 'Old Title' } });

    store.close();
  });

  it('undo(create) dispatches remove', async () => {
    const dbName = freshDbName();
    const channel = makeFakeChannel();

    let dispatched = [];
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: null, seq: 0 } },
      { match: '/todos', status: 200, headers: { 'x-workbench-seq': '1' }, response: { id: 'new-1', title: 'Created Task' } },
      { match: '/todos/new-1', status: 204 },
    ]);
    const capturingFetch = async (url, opts) => {
      dispatched.push({ method: opts?.method, url });
      return fetch(url, opts);
    };

    const store = await createLocalStore({
      baseUrl: 'http://test', name: 'Todo', path: '/todos',
      local: { name: dbName },
      channel, fetchImpl: capturingFetch,
    });

    const result = await store.create({ title: 'Created Task' });
    assert.ok(result.ok);

    const undoResult = await store.undo(result.opId);
    assert.ok(undoResult.ok);

    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0].method, 'POST');
    assert.equal(dispatched[1].method, 'DELETE');

    store.close();
  });

  it('undo(remove) dispatches create with preimage', async () => {
    const dbName = freshDbName();
    const channel = makeFakeChannel();

    let dispatched = [];
    const fetch = makeFakeFetch([
      { match: '/snapshot/Todo/1', response: { snapshot: { id: '1', title: 'To Delete' }, seq: 0 } },
      { match: '/todos/1', status: 204 },
      { match: '/todos', status: 200, headers: { 'x-workbench-seq': '2' }, response: { id: '1', title: 'To Delete' } },
    ]);
    const capturingFetch = async (url, opts) => {
      if (opts?.method === 'POST' || opts?.method === 'DELETE') {
        dispatched.push({ method: opts.method, url, body: opts?.body ? JSON.parse(opts.body) : null });
      }
      return fetch(url, opts);
    };

    const store = await createLocalStore({
      baseUrl: 'http://test', name: 'Todo', path: '/todos',
      local: { name: dbName },
      channel, fetchImpl: capturingFetch,
    });

    const list = store.subscribe('1', {});
    await list.ready;
    assert.deepEqual(list.state, { id: '1', title: 'To Delete' });

    const result = await store.remove('1');
    assert.ok(result.ok);

    const undoResult = await store.undo(result.opId);
    assert.ok(undoResult.ok);

    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0].method, 'DELETE');
    assert.equal(dispatched[1].method, 'POST');
    assert.deepEqual(dispatched[1].body, { id: '1', title: 'To Delete' });

    store.close();
  });

  it('undo fails for unknown opId', async () => {
    const dbName = freshDbName();
    const channel = makeFakeChannel();
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: null, seq: 0 } },
    ]);

    const store = await createLocalStore({
      baseUrl: 'http://test', name: 'Todo', path: '/todos',
      local: { name: dbName },
      channel, fetchImpl: fetch,
    });

    const result = await store.undo('bogus-op');
    assert.equal(result.ok, false);
    assert.deepEqual(result.failure, {
      category: 'conflict',
      message: 'no history for undo: bogus-op',
    });

    store.close();
  });
});
