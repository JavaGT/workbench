// Wave 3 reactive client tests: fine-grained LiveList/LiveStore notifications,
// framework-agnostic UI bindings, bounded query revision fences, and the
// single-attempt coalesced snapshot fallback. Pure JS — fake channel + fake
// fetch only, no real server.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LiveList,
  createLiveStore,
  createQueryClient,
  createLiveDeliverySession,
  bindAction,
  bindField,
  bindList,
  bindConnection,
} from '../public/workbench-client.mjs';
import { makeFakeChannel, makeFakeFetch } from './fixtures/fake-transport.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeList(channel, fetch, extra = {}) {
  return new LiveList({
    entity: 'Doc',
    id: '1',
    channel,
    fetchImpl: fetch,
    snapshotUrl: (entity, id) => `/snapshot/${entity}/${id}`,
    eventsSinceUrl: (entity, id, cursor) => `/events-since/${entity}/${id}?cursor=${cursor}`,
    ...extra,
  });
}

function makeStore({ channel = makeFakeChannel(), fetch, sendMutation } = {}) {
  const resolvedFetch = fetch ?? makeFakeFetch([
    { match: '/snapshot/Doc/', responseFn: (url) => ({
      snapshot: { id: url.endsWith('/1') ? '1' : '2', title: 'a', tags: [] }, seq: 1,
    }) },
    { match: '/events-since/', response: { events: [] } },
  ]);
  const replicaState = {
    reserve: async () => ({ operation: {}, actionId: 'op', counter: 1 }),
    head: async () => null,
    commit: async () => {},
    block: async () => {},
    reconcile: async () => [],
  };
  const store = createLiveStore({
    baseUrl: 'https://example.test', name: 'Doc', path: '/docs',
    channel, fetchImpl: resolvedFetch, replicaState, sendMutation,
  });
  return { store, channel };
}

function envelope(seq, type, data, delta) {
  return { entity: 'Doc', id: '1', seq, seqSpan: [seq, seq], event: { type, data }, delta };
}

describe('LiveList fine-grained reactive surface', () => {
  it('onChange emits path-level snapshot, patch and remove records with touched fields', async () => {
    const channel = makeFakeChannel();
    const fetch = makeFakeFetch([
      { match: '/snapshot/Doc/1', response: { snapshot: { id: '1', title: 'a', tags: [] }, seq: 1 } },
      { match: '/events-since/', response: { events: [] } },
    ]);
    const list = makeList(channel, fetch);
    const changes = [];
    const unsubscribe = list.onChange((change) => changes.push(change));

    await list.subscribe();
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, 'snapshot');
    assert.equal(changes[0].seq, 1);
    assert.deepEqual(changes[0].state, { id: '1', title: 'a', tags: [] });
    assert.equal(changes[0].fields, undefined);

    channel.emit(envelope(2, 'Doc.updated', { id: '1', title: 'b' }));
    const patch = changes.at(-1);
    assert.equal(patch.kind, 'patch');
    assert.equal(patch.seq, 2);
    assert.deepEqual(patch.fields, ['title']);
    assert.equal(patch.state.title, 'b');

    channel.emit(envelope(3, 'Doc.tags.inserted', { id: 't1', key: 1, value: { id: 't1' } }));
    const ordered = changes.at(-1);
    assert.equal(ordered.kind, 'patch');
    assert.deepEqual(ordered.fields, ['tags']);
    assert.equal(ordered.seq, 3);

    channel.emit(envelope(4, 'Doc.removed', { id: '1' }));
    const removal = changes.at(-1);
    assert.equal(removal.kind, 'remove');
    assert.equal(removal.seq, 4);
    assert.equal(removal.state, null);
    assert.equal(list.status, 'removed');

    unsubscribe();
    channel.emit(envelope(5, 'Doc.created', { id: '1', title: 'c' }));
    assert.equal(changes.length, 4, 'unsubscribe stops change delivery');
    await list.close();
  });

  it('onChange emits delta field names separately from whole-value fields', async () => {
    const channel = makeFakeChannel();
    const fetch = makeFakeFetch([
      { match: '/snapshot/Doc/1', response: { snapshot: { id: '1', title: 'a' }, seq: 1 } },
      { match: '/events-since/', response: { events: [] } },
    ]);
    const list = makeList(channel, fetch);
    await list.subscribe();
    const changes = [];
    list.onChange((change) => changes.push(change));

    channel.emit(envelope(2, 'Doc.updated', { id: '1', title: 'b', count: 2 }, { count: { set: 2 } }));
    const deltas = changes.filter((change) => change.kind === 'patch');
    assert.ok(deltas.some((change) => change.fields.includes('count')), 'delta field reported');
    assert.ok(deltas.some((change) => change.fields.includes('title')), 'whole-value field reported');
    assert.deepEqual(list.state, { id: '1', title: 'b', count: 2 });
    await list.close();
  });

  it('onStatusChange tracks bootstrapping, resyncing, stale, buffer-overflow and removed', async () => {
    const channel = makeFakeChannel();
    let snapshotSeq = 1;
    const fetch = makeFakeFetch([
      { match: '/snapshot/Doc/1', responseFn: () => ({ snapshot: { id: '1', title: 'a' }, seq: snapshotSeq }) },
      {
        match: '/events-since/',
        responseFn: () => {
          snapshotSeq = 9;
          return { resync: 'stale', reason: 'test' };
        },
      },
    ]);
    const list = makeList(channel, fetch);
    const statuses = [];
    list.onStatusChange((status) => statuses.push(status));

    assert.equal(list.status, 'idle');
    const bootstrapping = list.subscribe();
    assert.equal(list.status, 'bootstrapping');
    await bootstrapping;
    assert.equal(list.status, 'idle');

    // A stale events-since answer surfaces 'stale' before the fresh snapshot.
    channel.checkpoint('Doc', '1', 9);
    await tick();
    await tick();
    assert.ok(statuses.includes('stale'), `expected stale in ${JSON.stringify(statuses)}`);
    assert.ok(statuses.includes('resyncing'));
    assert.equal(list.status, 'idle');

    channel.emit(envelope(10, 'Doc.removed', { id: '1' }));
    assert.equal(list.status, 'removed');
    assert.ok(statuses.includes('removed'));
    await list.close();
  });

  it('surfaces buffer-overflow instead of silently dropping queued events', async () => {
    let releaseSubscribe;
    let onEvent;
    const channel = {
      subscribe(entity, id, options, handler) {
        onEvent = handler;
        return new Promise((resolve) => { releaseSubscribe = () => resolve({ currentSeq: 1 }); });
      },
      unsubscribe: async () => {},
      close() {},
    };
    const fetch = makeFakeFetch([
      { match: '/snapshot/Doc/1', response: { snapshot: { id: '1', title: 'a' }, seq: 1 } },
      { match: '/events-since/', response: { events: [] } },
    ]);
    const list = makeList(channel, fetch, { maxBufferedEvents: 2 });
    const statuses = [];
    list.onStatusChange((status) => statuses.push(status));

    const booting = list.subscribe();
    await tick();
    assert.ok(onEvent, 'channel subscribe was entered');
    for (let seq = 2; seq <= 4; seq += 1) onEvent(envelope(seq, 'Doc.updated', { id: '1', title: `x${seq}` }));
    assert.ok(statuses.includes('buffer-overflow'), `expected buffer-overflow in ${JSON.stringify(statuses)}`);
    assert.equal(list.status, 'buffer-overflow');

    releaseSubscribe();
    await booting;
    assert.equal(list.status, 'idle', 'a fresh snapshot clears the overflow status');
    await list.close();
  });
});

describe('createLiveStore reactive forwarding', () => {
  it('forwards onChange and onStatusChange from cached LiveLists', async () => {
    const { store, channel } = makeStore();
    const list = store.subscribe('1');
    await list.ready;

    const changes = [];
    const statuses = [];
    const unsubChange = store.onChange((change) => changes.push(change));
    const unsubStatus = store.onStatusChange((status, id) => statuses.push([status, id]));

    channel.emit(envelope(2, 'Doc.updated', { id: '1', title: 'b' }));
    assert.ok(changes.some((change) => change.kind === 'patch' && change.fields.includes('title')));
    assert.equal(unsubChange instanceof Function, true);

    channel.checkpoint('Doc', '1', 5);
    await tick();
    await tick();
    assert.ok(statuses.some(([status, id]) => status === 'resyncing' && id === '1'));
    assert.ok(statuses.some(([status, id]) => status === 'idle' && id === '1'));

    unsubChange();
    unsubStatus();
    store.close();
  });
});

describe('framework-agnostic reactive bindings', () => {
  it('bindField projects confirmed state, optimistic overlay and cleanup', async () => {
    let settle;
    const sendMutation = () => ({
      settlement: new Promise((resolve) => { settle = resolve; }),
      completion: Promise.resolve({ status: 'committed' }),
    });
    const { store, channel } = makeStore({ sendMutation });
    const list = store.subscribe('1');
    await list.ready;

    const handle = bindField(store, { id: '1', field: 'title' });
    assert.deepEqual(handle.get(), { value: 'a', provenance: 'confirmed', status: 'idle' });
    const seen = [];
    const unsub = handle.subscribe((projection) => seen.push(projection));

    const pending = store.update('1', { title: 'optimistic' });
    await tick();
    assert.equal(handle.get().value, 'optimistic');
    assert.equal(handle.get().provenance, 'projected');
    assert.equal(handle.get().status, 'pending');

    settle({ status: 'committed', row: { id: '1', title: 'optimistic' }, seq: 2 });
    await pending;
    assert.equal(handle.get().provenance, 'confirmed');
    assert.equal(handle.get().value, 'a', 'the authoritative list has not folded seq 2 yet');

    channel.emit(envelope(2, 'Doc.updated', { id: '1', title: 'optimistic' }));
    assert.equal(handle.get().value, 'optimistic');
    assert.equal(handle.get().provenance, 'confirmed');
    assert.ok(seen.length >= 2, 'subscribers saw projection transitions');

    unsub();
    handle.destroy();
    const before = seen.length;
    channel.emit(envelope(3, 'Doc.updated', { id: '1', title: 'after-destroy' }));
    assert.equal(seen.length, before, 'destroy detaches all store and list sources');
    assert.equal(handle.get().value, 'optimistic', 'a destroyed handle is a stable snapshot');
    store.close();
  });

  it('bindList binds a row, a sub-collection field, and the collection of observed rows', async () => {
    const { store, channel } = makeStore();
    const list1 = store.subscribe('1');
    const list2 = store.subscribe('2');
    await Promise.all([list1.ready, list2.ready]);

    const row = bindList(store, { id: '1' });
    assert.equal(row.get().provenance, 'confirmed');
    assert.equal(row.get().value.title, 'a');

    const tags = bindList(store, { id: '1', field: 'tags' });
    channel.emit(envelope(2, 'Doc.tags.inserted', { id: 't1', key: 1, value: { id: 't1' } }));
    assert.deepEqual(tags.get().value, [{ id: 't1' }]);
    assert.deepEqual(tags.get().fields, undefined);

    const all = bindList(store);
    assert.equal(all.get().value.length, 2, 'collection mode projects every observed row');
    assert.equal(all.get().provenance, 'confirmed');
    const seen = [];
    all.subscribe((projection) => seen.push(projection));
    channel.emit({ ...envelope(2, 'Doc.updated', { id: '2', title: 'b' }), id: '2' });
    assert.ok(seen.length > 0);
    assert.equal(all.get().value.find((value) => value.id === '2').title, 'b');

    row.destroy();
    tags.destroy();
    all.destroy();
    store.close();
  });

  it('bindAction dispatches through the store and projects the overlay lifecycle', async () => {
    let settle;
    const sent = [];
    const sendMutation = (input) => {
      sent.push(input);
      return {
        settlement: new Promise((resolve) => { settle = resolve; }),
        completion: Promise.resolve({ status: 'committed' }),
      };
    };
    const { store } = makeStore({ sendMutation });
    const list = store.subscribe('1');
    await list.ready;

    const handle = bindAction(store, { id: '1', action: 'Doc.update', payload: { title: 'first' } });
    assert.deepEqual(handle.get(), { value: null, provenance: 'unknown', status: 'idle' });

    const dispatched = handle.dispatch({ title: 'second' });
    await tick();
    assert.equal(handle.get().status, 'pending');
    assert.equal(handle.get().provenance, 'projected');
    assert.equal(sent[0].kind, 'update');
    assert.equal(sent[0].id, '1');
    assert.equal(JSON.parse(sent[0].body).title, 'second', 'override payload wins');

    settle({ status: 'committed', row: { id: '1', title: 'second' }, seq: 2 });
    const result = await dispatched;
    assert.equal(result.ok, true);
    assert.equal(handle.get().status, 'confirmed');
    assert.equal(handle.get().value.ok, true);
    handle.destroy();
    store.close();
  });

  it('bindConnection reflects channel status transitions and detaches on destroy', () => {
    let listener;
    const channel = {
      onConnectionChange(cb) { listener = cb; return () => { listener = null; }; },
    };
    const handle = bindConnection(channel);
    assert.deepEqual(handle.get(), { value: 'disconnected', provenance: 'confirmed', status: 'disconnected' });
    const seen = [];
    handle.subscribe((projection) => seen.push(projection.value));
    listener('connected');
    assert.equal(handle.get().value, 'connected');
    listener('reconnecting');
    assert.equal(handle.get().status, 'reconnecting');
    const registered = listener;
    handle.destroy();
    registered('connected');
    assert.equal(handle.get().value, 'reconnecting', 'destroy unsubscribed from the channel');
    assert.deepEqual(seen, ['connected', 'reconnecting']);
  });
});

describe('bounded query revision fences', () => {
  it('createQueryClient evicts heldRevisions least-recently-used', async () => {
    let counter = 0;
    const fetchImpl = async (_url, options) => {
      const body = JSON.parse(options.body);
      counter += 1;
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ rows: [], revision: counter, queryIdentity: `identity-${body.marker}` }),
      };
    };
    const client = createQueryClient({ baseUrl: 'https://example.test', fetchImpl, maxHeldRevisions: 2 });

    await client.queryEntity('Doc', { marker: 'a' });
    await client.queryEntity('Doc', { marker: 'b' });
    // Touch 'a' so the next write evicts 'b', not 'a'.
    assert.equal(client.acceptQueryPage({ queryIdentity: 'identity-a', revision: 2 }), 'accept');
    await client.queryEntity('Doc', { marker: 'c' });

    assert.equal(client.acceptQueryPage({ queryIdentity: 'identity-a', revision: 0 }), 'reject-stale');
    assert.equal(client.acceptQueryPage({ queryIdentity: 'identity-b', revision: 0 }), 'accept',
      'least-recently-used identity was evicted');
    assert.equal(client.acceptQueryPage({ queryIdentity: 'identity-c', revision: 0 }), 'reject-stale');
  });

  it('defaults the held-revision bound so a long-lived session cannot leak identities', async () => {
    let counter = 0;
    const fetchImpl = async (_url, options) => {
      const body = JSON.parse(options.body);
      counter += 1;
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ rows: [], revision: counter, queryIdentity: `identity-${body.marker}` }),
      };
    };
    const client = createQueryClient({ baseUrl: 'https://example.test', fetchImpl });
    for (let index = 0; index < 258; index += 1) {
      await client.queryEntity('Doc', { marker: index });
    }
    assert.equal(client.acceptQueryPage({ queryIdentity: 'identity-0', revision: 0 }), 'accept',
      'identity beyond the 256-entry default bound was evicted');
    assert.equal(client.acceptQueryPage({ queryIdentity: 'identity-257', revision: 0 }), 'reject-stale');
  });
});

describe('single-attempt coalesced snapshot fallback', () => {
  it('does not fetch a second snapshot when the first recovery already covers the receipt fence', async () => {
    let bootstraps = 0;
    const bootstrap = async () => {
      bootstraps += 1;
      return { kind: 'snapshot', snapshot: { version: bootstraps }, cursor: bootstraps === 1 ? 1 : 10 };
    };
    const session = createLiveDeliverySession({
      bootstrap,
      subscribe: async () => ({ close() {} }),
      validateSnapshot: (value) => value,
      fold: (snapshot) => snapshot,
      optimistic: (snapshot) => snapshot,
      sendAction: async () => ({ ok: true, actionId: 'a1', confirmedThrough: 8 }),
    });
    await session.ready;
    assert.equal(bootstraps, 1);

    // Fence 8 is uncovered at cursor 1, so ONE recovery runs. Its snapshot
    // lands at cursor 10, covering both the receipt fence and the control
    // anchor — no redundant second full snapshot may be scheduled.
    const result = await session.dispatch('Doc.rename', {});
    assert.equal(result.ok, true);
    await tick();
    await tick();
    assert.equal(bootstraps, 2, 'exactly one recovery snapshot was fetched');
    assert.equal(session.cursor, 10);
    assert.deepEqual(session.snapshot, { version: 2 });
    session.close();
  });

  it('still falls back once when the first recovery lands below the fence and anchor', async () => {
    let bootstraps = 0;
    const bootstrap = async () => {
      bootstraps += 1;
      if (bootstraps === 1) return { kind: 'snapshot', snapshot: { version: 1 }, cursor: 1 };
      if (bootstraps === 2) return { kind: 'snapshot', snapshot: { version: 2 }, cursor: 3 };
      return { kind: 'snapshot', snapshot: { version: 3 }, cursor: 10 };
    };
    const session = createLiveDeliverySession({
      bootstrap,
      subscribe: async () => ({ close() {} }),
      validateSnapshot: (value) => value,
      fold: (snapshot) => snapshot,
      optimistic: (snapshot) => snapshot,
      sendAction: async () => ({ ok: true, actionId: 'a1', confirmedThrough: 8 }),
    });
    await session.ready;
    const result = await session.dispatch('Doc.rename', {});
    assert.equal(result.ok, true);
    await tick();
    await tick();
    assert.equal(bootstraps, 3, 'an uncovered fence/anchor still gets exactly one fallback');
    assert.equal(session.cursor, 10);
    session.close();
  });
});
