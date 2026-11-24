// Wave 8 client-hardening regressions.
//
// Pure JS: fake channel, fake fetch and fake sockets only — no real server.
// Covers bounded recovery for persistent replay gaps, fail-closed folding of
// unhandled event types, and the Wave 3 UI-binding contract fixes.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LiveList,
  LiveChannel,
  createScopeLiveStore,
  createLiveStore,
  bindField,
  bindList,
  bindAction,
  bindConnection,
} from '../public/workbench-client.mjs';
import { makeFakeChannel } from './fixtures/fake-transport.mjs';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => body,
});

function envelope(seq, type = 'Doc.updated', data = { id: '1', title: `seq${seq}` }) {
  return { entity: 'Doc', id: '1', seq, seqSpan: [seq, seq], event: { type, data } };
}

function makeList(channel, fetchImpl, extra = {}) {
  return new LiveList({
    entity: 'Doc',
    id: '1',
    channel,
    fetchImpl,
    snapshotUrl: () => '/snapshot/Doc/1',
    eventsSinceUrl: (_entity, _id, cursor) => `/events-since/Doc/1?cursor=${cursor}`,
    resyncBackoffBase: 1,
    maxResyncBackoff: 2,
    ...extra,
  });
}

describe('bounded recovery from a persistent replay gap', () => {
  it('LiveList escalates once to a snapshot and then fails closed with capped backoff', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    let snapshotCalls = 0;
    let eventsCalls = 0;
    const fetchImpl = async (url) => {
      if (String(url).includes('/events-since/')) {
        eventsCalls += 1;
        return json({ events: [] });
      }
      snapshotCalls += 1;
      // The snapshot never moves past the gapped seq 5.
      return json({ snapshot: { id: '1', title: 'a' }, seq: 1 });
    };
    const list = makeList(channel, fetchImpl);
    const statuses = [];
    list.onStatusChange((status) => statuses.push(status));
    await list.subscribe();
    assert.equal(snapshotCalls, 1);

    channel.emit(envelope(5));
    await tick(40);
    const eventsAfterCap = eventsCalls;
    const snapshotsAfterCap = snapshotCalls;
    await tick(40);

    assert.equal(list.cursor, 1, 'no cursor advance without a fold');
    assert.equal(list.state.title, 'a', 'state was not replaced by an unverifiable live frame');
    assert.equal(snapshotCalls, 2, 'exactly one forced snapshot escalation (bootstrap + escalation)');
    assert.equal(snapshotsAfterCap, snapshotCalls, 'no further snapshot loop after the cap');
    assert.equal(eventsAfterCap, eventsCalls, 'no further events-since loop after the cap');
    assert.ok(eventsCalls > 1 && eventsCalls <= 9, `expected capped retries, saw ${eventsCalls}`);
    assert.equal(list.status, 'stale');
    assert.ok(statuses.includes('stale'));
    await list.close();
  });

  it('createScopeLiveStore terminates a gap whose replay keeps returning an empty batch', async () => {
    let onLive;
    const channel = {
      subscribeScope(_scope, _options, handler) {
        onLive = handler;
        return Promise.resolve({ currentSeq: 1 });
      },
      unsubscribeScope: async () => {},
      close() {},
    };
    let snapshotCalls = 0;
    let eventsCalls = 0;
    const fetchImpl = async (url) => {
      if (String(url).includes('/events-since')) {
        eventsCalls += 1;
        return json({ events: [] });
      }
      snapshotCalls += 1;
      return json({ snapshot: { id: 'n1', seq: 1 }, seq: 1 });
    };
    const store = createScopeLiveStore({
      baseUrl: 'https://example.test',
      scope: 'Project:p1',
      channel,
      fetchImpl,
      validateSnapshot: (snapshot) => snapshot,
      fold: (snapshot, event) => ({ ...snapshot, last: event.seq }),
      sendAction: async () => ({ ok: true }),
      resyncBackoffBase: 1,
      maxResyncBackoff: 2,
    });
    await store.ready;
    assert.equal(snapshotCalls, 1);

    onLive({
      type: 'event',
      seq: 5,
      seqSpan: [5, 5],
      event: { type: 'Note.updated', data: { seq: 5 } },
    });
    await tick(40);
    const eventsAfterCap = eventsCalls;
    await tick(40);

    assert.equal(store.cursor, 1, 'empty replay never advances the scope cursor');
    assert.equal(store.status, 'stale');
    assert.equal(snapshotCalls, 2, 'one forced snapshot escalation');
    assert.equal(eventsAfterCap, eventsCalls, 'backoff stops at the attempt cap');
    store.close();
    assert.equal(store.status, 'closed');
  });
});

describe('fail-closed foldability', () => {
  it('an unhandled live event type never advances the LiveList cursor', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const changes = [];
    const fetchImpl = async (url) => {
      if (String(url).includes('/events-since/')) return json({ events: [] });
      return json({ snapshot: { id: '1', title: 'a' }, seq: 1 });
    };
    const list = makeList(channel, fetchImpl);
    list.onChange((change) => changes.push(change));
    await list.subscribe();

    channel.emit(envelope(2, 'Doc.unhandled', { id: '1', title: 'never folded' }));
    await tick(20);

    assert.equal(list.cursor, 1);
    assert.deepEqual(list.state, { id: '1', title: 'a' });
    assert.equal(list.status, 'stale');
    assert.ok(!changes.some((change) => change.seq === 2 && change.kind !== 'snapshot'),
      'no fold record was emitted for an unhandled type');
    assert.equal(list.canFold('Doc.unhandled'), false);
    assert.equal(list.canFold('Doc.body.unhandled'), false);
    assert.equal(list.canFold('Doc.updated'), true);
    assert.equal(list.canFold('Doc.body.applied'), true);
    await list.close();
  });

  it('an unhandled type in an events-since batch still rejects the whole batch', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetchImpl = async (url) => {
      if (String(url).includes('/events-since/')) {
        // One attempt after the failed batch, then an empty answer: the gap
        // path above owns recovery. This batch itself must never fold.
        return json({ events: [
          { seq: 2, type: 'Doc.updated', data: { id: '1', title: 'first' } },
          { seq: 3, type: 'Doc.body.unhandled', data: { id: '1' } },
        ] });
      }
      return json({ snapshot: { id: '1', title: 'a' }, seq: 1 });
    };
    const list = makeList(channel, fetchImpl);
    channel._setAck({ currentSeq: 4 });
    await list.subscribe();
    // A checkpoint at 4 triggers resync; the invalid batch must be rejected.
    channel.checkpoint('Doc', '1', 4);
    await tick(30);

    assert.equal(list.cursor, 1, 'no row of an invalid batch was applied');
    assert.deepEqual(list.state, { id: '1', title: 'a' });
    await list.close();
  });
});

describe('LiveChannel status and bindConnection', () => {
  it('reports a connected channel immediately to bindConnection', async () => {
    const sockets = [];
    const makeSocket = () => {
      const listeners = new Map();
      const socket = {
        readyState: 1,
        sent: [],
        addEventListener(type, fn) {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type).add(fn);
        },
        removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
        message(frame) {
          for (const fn of listeners.get('message') ?? []) fn({ data: JSON.stringify(frame) });
        },
        send(raw) {
          const frame = JSON.parse(raw);
          socket.sent.push(frame);
          if (frame.type === 'subscribe') {
            // A real socket acknowledges after `send` returns, when the
            // requestId has been recorded on the subscription.
            queueMicrotask(() => socket.message({
              type: 'subscribed',
              scope: frame.scope,
              entity: frame.entity,
              id: frame.id,
              currentSeq: 0,
              requestId: frame.requestId,
            }));
          }
        },
        close() { socket.readyState = 3; },
      };
      return socket;
    };
    const channel = new LiveChannel('https://example.test', {
      socketFactory: () => {
        const socket = makeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    assert.equal(channel.status, 'disconnected', 'a fresh channel is disconnected');
    const before = bindConnection(channel);
    assert.equal(before.get().value, 'disconnected');
    before.destroy();

    await channel.subscribe('Doc', '1', {}, () => {});
    assert.equal(channel.status, 'connected');

    const bound = bindConnection(channel);
    assert.deepEqual(bound.get(), { value: 'connected', provenance: 'confirmed', status: 'connected' },
      'binding an already-connected channel must not wait for a future transition');
    const seen = [];
    bound.subscribe((projection) => seen.push(projection.value));
    channel.close();
    assert.equal(channel.status, 'disconnected');
    assert.deepEqual(seen, ['disconnected'], 'the emitter still drives later transitions');
    bound.destroy();
    assert.equal(sockets.length, 1);
  });
});

describe('binding provenance and lifecycle', () => {
  function makeBindingStore({ state = { id: '1', title: 'a' }, overlay = null, overlayStatus = null } = {}) {
    const sources = { render: new Set(), change: new Set(), status: new Set(), listChange: new Set() };
    const list = {
      get state() { return state; },
      status: 'idle',
      onChange(cb) { sources.listChange.add(cb); return () => sources.listChange.delete(cb); },
      onStatusChange(cb) { sources.status.add(cb); return () => sources.status.delete(cb); },
    };
    const store = {
      subscribe() { return list; },
      listIds: () => [],
      overlayFor() { return overlay; },
      overlayStatusFor() { return overlayStatus; },
      onRender(cb) { sources.render.add(cb); return () => sources.render.delete(cb); },
      onChange(cb) { sources.change.add(cb); return () => sources.change.delete(cb); },
      onStatusChange(cb) { sources.status.add(cb); return () => sources.status.delete(cb); },
      dispatch: async () => ({ ok: true }),
    };
    return { store, list, sources, setRow: (row) => { state = row; }, setOverlay: (row, statusValue) => {
      overlay = row;
      overlayStatus = statusValue;
    } };
  }

  it('bindField and bindList agree on provenance without an x-workbench-seq', async () => {
    let settle;
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetchImpl = async (url) => {
      if (String(url).includes('/events-since/')) return json({ events: [] });
      return json({ snapshot: { id: '1', title: 'a', tags: [] }, seq: 1 });
    };
    const store = createLiveStore({
      baseUrl: 'https://example.test',
      name: 'Doc',
      path: '/docs',
      channel,
      fetchImpl,
      sendMutation: () => ({
        settlement: new Promise((resolve) => { settle = resolve; }),
        completion: Promise.resolve({ status: 'committed' }),
      }),
    });
    const list = store.subscribe('1');
    await list.ready;

    const field = bindField(store, { id: '1', field: 'title' });
    const row = bindList(store, { id: '1' });
    const pending = store.update('1', { title: 'optimistic' });
    await tick();
    assert.equal(field.get().provenance, 'projected');
    assert.equal(row.get().provenance, 'projected', 'pending overlays agree');

    // No `seq` on the response: there is no x-workbench-seq to compare against.
    settle({ status: 'committed', row: { id: '1', title: 'server' } });
    await pending;
    assert.equal(field.get().provenance, 'confirmed');
    assert.equal(row.get().provenance, 'confirmed',
      'a confirmed overlay must not stay projected when the seq header is absent');

    channel.emit(envelope(2, 'Doc.updated', { id: '1', title: 'server' }));
    assert.equal(field.get().value, 'server');
    assert.equal(row.get().value.title, 'server');
    assert.equal(field.get().provenance, row.get().provenance);
    field.destroy();
    row.destroy();
    store.close();
  });

  it('destroy releases remembered ids and ref-counts shared ids', () => {
    const { store, setOverlay } = makeBindingStore();
    const indexed = { id: '1', title: 'x' };
    setOverlay(indexed, { status: 'confirmed' });
    const field = bindField(store, { id: '1', field: 'title' });
    const second = bindField(store, { id: '1', field: 'title' });
    const all = bindList(store);
    assert.equal(all.get().value.length, 1);

    field.destroy();
    assert.equal(all.get().value.length, 1, 'another binding still owns the id');
    second.destroy();
    assert.equal(all.get().value.length, 0, 'destroy releases the last reference to an id');
    assert.equal(all.get().provenance, 'unknown');
    all.destroy();
  });

  it('an AbortSignal tears down bindings and action handles', async () => {
    const { store, sources } = makeBindingStore();
    const controller = new AbortController();
    const field = bindField(store, { id: '1', field: 'title', signal: controller.signal });
    const seen = [];
    field.subscribe((projection) => seen.push(projection.value));
    assert.equal(field.get().value, 'a');

    controller.abort();
    assert.equal(sources.listChange.size, 0, 'abort detached every source listener');
    assert.equal(sources.render.size, 0);
    for (const cb of sources.listChange) cb({ fields: ['title'] });
    assert.equal(seen.length, 0, 'an aborted handle is a stable snapshot');

    const actionController = new AbortController();
    const action = bindAction(store, { id: '1', action: 'Doc.update', signal: actionController.signal });
    const actionSeen = [];
    action.subscribe((projection) => actionSeen.push(projection.value));
    await action.dispatch({ title: 'next' });
    assert.equal(actionSeen.length, 1);
    actionController.abort();
    await action.dispatch({ title: 'later' });
    assert.equal(actionSeen.length, 1, 'aborted action handle no longer notifies');
    field.destroy();
  });

  it('coalesces duplicate store notifications and compares non-JSON values structurally', async () => {
    const value = { n: 1n, tags: new Map([['a', 1]]) };
    const { store, sources, setRow } = makeBindingStore({ state: value });
    const handle = bindList(store, { id: '1' });
    const seen = [];
    handle.subscribe((projection) => seen.push(projection));

    setRow({ n: 2n, tags: new Map([['b', 2]]) });
    for (const cb of sources.render) cb();
    for (const cb of sources.change) cb({ fields: [] });
    for (const cb of sources.status) cb('resyncing');
    await tick();
    assert.equal(seen.length, 1, 'one fold produced one notification even from three sources');

    // A structurally equal non-JSON value is not a change. A JSON.stringify
    // fallback of `{}` would make every one of these look new.
    for (const cb of sources.listChange) cb({ fields: [] });
    for (const cb of sources.render) cb();
    await tick();
    assert.equal(seen.length, 1, 'stable structural comparison suppresses redundant refreshes');
    handle.destroy();
  });
});
