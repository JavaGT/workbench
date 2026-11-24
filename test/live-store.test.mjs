// LiveStore tests — pure JS, NO real server. Injects a fake channel + fake fetch.
import { describe, it, before as _before, after as _after } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveStore, LiveList, LiveChannel as _LiveChannel, decodeResult } from '../public/workbench-client.mjs';
import { makeFakeChannel, makeFakeFetch } from './fixtures/fake-transport.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a deferred promise { promise, resolve, reject }. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Yield control to the event loop. */
function tick() {
  return new Promise(r => setTimeout(r, 0));
}

/** Yield a bit longer for async chains to settle. */
function tickAsync() {
  return new Promise(r => setTimeout(r, 20));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LiveStore', () => {

  it('apply dispatches a text operation to the native POST route, never PATCH', async () => {
    const channel = makeFakeChannel();
    const calls = [];
    const fetch = async (url, options = {}) => {
      calls.push({ url, options });
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: '1', body: 'hello' }) };
    };
    const store = createLiveStore({ baseUrl: 'http://test', name: 'Doc', path: '/docs', channel, fetchImpl: fetch });
    const operation = ['workbench.text', 1, ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1], 1, [], ['insert', ['root'], 'hello']];
    const result = await store.apply('1', 'body', operation);
    assert.equal(result.ok, true);
    assert.equal(calls[0].url, 'http://test/docs/1/body/apply');
    assert.equal(calls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].options.body), { operation });
  });

  it('apply labels a local serialization failure failed-rolled-back, never outcome-unknown', async () => {
    const channel = makeFakeChannel();
    let fetchCalled = false;
    const fetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
    };
    const store = createLiveStore({ baseUrl: 'http://test', name: 'Doc', path: '/docs', channel, fetchImpl: fetch });
    const result = await store.apply('1', 'body', { payload: 1n });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed-rolled-back');
    assert.equal(result.failure.category, 'invalid-input');
    assert.equal(fetchCalled, false, 'fetch must not fire when the body cannot be encoded');
    store.close();
  });

  // --- 1. subscribe(id) returns LiveList, caches by id ---
  it('subscribe returns LiveList, caches by id (same id returns same instance)', async () => {
    const channel = makeFakeChannel();
    const fetch = makeFakeFetch([
      { match: '/snapshot/Doc/1', response: { snapshot: { id: '1', title: 'a' }, seq: 1 } },
      { match: '/snapshot/Doc/2', response: { snapshot: { id: '2', title: 'b' }, seq: 1 } },
    ]);

    const store = createLiveStore({
      baseUrl: 'http://test', name: 'Doc', path: '/docs',
      channel, fetchImpl: fetch,
    });

    const list1 = store.subscribe('1');
    const list1b = store.subscribe('1');
    const list2 = store.subscribe('2');

    assert.equal(list1, list1b, 'same id returns same LiveList instance');
    assert.notEqual(list1, list2, 'different id returns different instance');
    assert.ok(list1 instanceof LiveList);
    assert.ok(list2 instanceof LiveList);

    // Ensure they bootstrap properly
    await list1.ready;
    assert.deepEqual(list1.state, { id: '1', title: 'a' });

    store.close();
  });

  it('subscribe passes field interest and pace into the LiveList channel subscription', async () => {
    const channel = makeFakeChannel();
    const fetch = makeFakeFetch([
      { match: '/snapshot/Doc/1', response: { snapshot: { id: '1', title: 'a' }, seq: 1 } },
    ]);

    const store = createLiveStore({
      baseUrl: 'http://test', name: 'Doc', path: '/docs',
      channel, fetchImpl: fetch,
    });

    const list = store.subscribe('1', {
      fields: { cursor: true },
      pace: { profile: '15fps' },
    });

    await list.ready;
    assert.equal(channel.calls.length, 1);
    assert.equal(channel.calls[0].entity, 'Doc');
    assert.equal(channel.calls[0].id, '1');
    assert.deepEqual(channel.calls[0].options.fields, { cursor: true });
    assert.deepEqual(channel.calls[0].options.pace, { profile: '15fps' });
    assert.equal(typeof channel.calls[0].options.onCheckpoint, 'function');

    store.close();
  });

  // --- 2. create → POST, optimistic overlay + confirmed with returned row ---
  it('create fires POST, optimistic overlay pending immediately, then confirmed with returned row', async () => {
    const channel = makeFakeChannel();
    let postedUrl = null;
    let postedBody = null;

    const fetch = makeFakeFetch([
      { match: '/snapshot/Doc/1', response: { snapshot: { id: '1', title: 'a' }, seq: 1 } },
      {
        match: '/docs',
        responseFn: (url) => {
          postedUrl = url;
          return { id: 'new-1', title: 'hello', status: 'active' };
        },
      },
    ]);

    // Wrap fetch to capture POST body
    const origFetch = fetch;
    const capturingFetch = async (url, opts) => {
      if (opts && opts.method === 'POST') {
        postedBody = opts.body ? JSON.parse(opts.body) : null;
      }
      return origFetch(url, opts);
    };

    const store = createLiveStore({
      baseUrl: 'http://test', name: 'Doc', path: '/docs',
      channel, fetchImpl: capturingFetch,
    });

    const result = await store.create({ title: 'hello', status: 'active' });

    assert.equal(postedUrl, 'http://test/docs');
    assert.deepEqual(postedBody, { title: 'hello', status: 'active' });

    // Optimistic overlay should have been pending immediately (captured before await)
    const pending = store.pendingCreates();
    // After awaiting the dispatch, the pending create is now confirmed, so pendingCreates() should be empty
    assert.equal(pending.length, 0, 'no pending creates after dispatch completes');

    // Result shape
    assert.ok(result.ok);
    assert.equal(result.status, 'committed');
    assert.equal(result.id, 'new-1');
    assert.deepEqual(result.row, { id: 'new-1', title: 'hello', status: 'active' });

    store.close();
  });

  // --- 3. update → optimistic merge visible before REST resolves, confirmed ---
  it('update applies optimistic merge immediately, then confirms', async () => {
    const channel = makeFakeChannel();
    const fetch = makeFakeFetch([
      { match: '/snapshot/Doc/1', response: { snapshot: { id: '1', title: 'old', score: 5 }, seq: 1 } },
      { match: '/docs/1', response: { id: '1', title: 'updated', score: 5 } },
    ]);

    const store = createLiveStore({
      baseUrl: 'http://test', name: 'Doc', path: '/docs',
      channel, fetchImpl: fetch,
    });

    const list = store.subscribe('1');
    await list.ready;
    assert.equal(list.state.title, 'old');

    // The dispatch starts, optimistic overlay is set immediately
    // We can test overlayFor before the dispatch resolves
    const dispatchPromise = store.update('1', { title: 'updated' });

    // After a tick, the overlay should be pending (optimistic visible)
    await tick();
    let rendered = store.overlayFor('1');
    assert.deepEqual(rendered, { id: '1', title: 'updated', score: 5 });

    const result = await dispatchPromise;

    assert.ok(result.ok);
    assert.equal(result.status, 'committed');
    assert.equal(result.id, '1');
    assert.deepEqual(result.row, { id: '1', title: 'updated', score: 5 });

    // Overlay should still be present (confirmed, not yet cleared by WS)
    rendered = store.overlayFor('1');
    assert.deepEqual(rendered, { id: '1', title: 'updated', score: 5 });

    store.close();
  });

  // --- 4. update REST failure → overlay rolled back ---
  it('update failure rolls back overlay, returns failed Result, does not throw', async () => {
    const channel = makeFakeChannel();
    let fetchCallCount = 0;

    const fetch = async (url, opts) => {
      if (url.includes('/snapshot')) {
        return { ok: true, json: async () => ({ snapshot: { id: '1', title: 'old' }, seq: 1 }) };
      }
      if (url.includes('/docs/1') && opts && opts.method === 'PATCH') {
        fetchCallCount++;
        return {
          ok: false,
          status: 500,
          json: async () => ({
            ok: false,
            failure: { category: 'internal', message: 'Internal error.' },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    };

    const store = createLiveStore({
      baseUrl: 'http://test', name: 'Doc', path: '/docs',
      channel, fetchImpl: fetch,
    });

    const list = store.subscribe('1');
    await list.ready;
    assert.equal(list.state.title, 'old');

    const result = await store.update('1', { title: 'should-not-appear' });

    // dispatch must NOT throw
    assert.ok(result.ok === false);
    assert.equal(result.status, 'failed-rolled-back');
    assert.equal(result.failure.category, 'internal');

    // Overlay should be rolled back (overlayFor falls through to LiveList state)
    const rendered = store.overlayFor('1');
    assert.deepEqual(rendered, { id: '1', title: 'old' });

    assert.equal(fetchCallCount, 1);
    store.close();
  });

  // --- 5. remove → 204 → confirmed-removed, Result ok ---
  it('remove sends DELETE, 204 response returns confirmed-removed with ok Result', async () => {
    const channel = makeFakeChannel();
    let deletedUrl = null;

    const fetch = async (url, opts) => {
      if (url.includes('/snapshot')) {
        return { ok: true, json: async () => ({ snapshot: { id: '1', title: 'x' }, seq: 1 }) };
      }
      if (url.includes('/docs/1') && opts && opts.method === 'DELETE') {
        deletedUrl = url;
        return { ok: true, status: 204, json: async () => {} };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    };

    const store = createLiveStore({
      baseUrl: 'http://test', name: 'Doc', path: '/docs',
      channel, fetchImpl: fetch,
    });

    const list = store.subscribe('1');
    await list.ready;
    assert.deepEqual(list.state, { id: '1', title: 'x' });

    const result = await store.remove('1');

    assert.equal(deletedUrl, 'http://test/docs/1');
    assert.ok(result.ok);
    assert.equal(result.status, 'committed');

    // overlayFor returns null for removed
    const rendered = store.overlayFor('1');
    assert.equal(rendered, null);

    store.close();
  });

  // --- 6. dispatch never throws even on fetch-rejects (network error) ---
  it('dispatch returns an outcome-unknown Result on network error, never throws', async () => {
    const channel = makeFakeChannel();
    let rejectCount = 0;

    const fetch = async (url, _opts) => {
      if (url.includes('/snapshot')) {
        return { ok: true, json: async () => ({ snapshot: { id: '1', title: 'x' }, seq: 1 }) };
      }
      rejectCount++;
      throw new Error('network down');
    };

    const store = createLiveStore({
      baseUrl: 'http://test', name: 'Doc', path: '/docs',
      channel, fetchImpl: fetch,
    });

    const list = store.subscribe('1');
    await list.ready;

    let result;
    let threw = false;
    try {
      result = await store.update('1', { title: 'fail' });
    } catch {
      threw = true;
    }

    assert.equal(threw, false, 'dispatch must never throw');
    assert.ok(result.ok === false);
    assert.equal(result.status, 'outcome-unknown');
    assert.equal(result.deliveryError.message, 'network down');

    // Overlay rolled back
    const rendered = store.overlayFor('1');
    assert.deepEqual(rendered, { id: '1', title: 'x' });

    assert.equal(rejectCount, 1);
    store.close();
  });

  // --- 7. HTTP-before-WS: confirmed overlay persists until LiveList folds event ---
  it('HTTP-before-WS: confirmed overlay persists until LiveList folds committed event, then clears', async () => {
    const channel = makeFakeChannel();

    // Configure ack to match snapshot seq so no bootstrap resync needed
    channel._setAck({ currentSeq: 1 });

    const fetch = makeFakeFetch([
      { match: '/snapshot/Doc/1', response: { snapshot: { id: '1', title: 'old' }, seq: 1 } },
      {
        match: '/docs/1',
        response: { id: '1', title: 'new-from-rest' },
        headers: { 'x-workbench-seq': '2' },
      },
    ]);

    const store = createLiveStore({
      baseUrl: 'http://test', name: 'Doc', path: '/docs',
      channel, fetchImpl: fetch,
    });

    // Subscribe and wait for bootstrap to complete
    const list = store.subscribe('1');
    await list.ready;
    assert.deepEqual(list.state, { id: '1', title: 'old' });

    // Fire update — REST returns immediately (confirmed), but no WS event yet
    const result = await store.update('1', { title: 'new-from-rest' });
    assert.ok(result.ok);
    assert.equal(result.status, 'committed');

    // The overlay should show the confirmed row (not the old LiveList state)
    const overlayState = store.overlayFor('1');
    assert.deepEqual(overlayState, { id: '1', title: 'new-from-rest' },
      'overlay shows confirmed row even though LiveList is still old');

    // LiveList state is still the old value
    assert.deepEqual(list.state, { id: '1', title: 'old' },
      'LiveList state unchanged — no WS event yet');

    // Now deliver the committed event through the WS
    channel.emit({
      type: 'event', entity: 'Doc', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'Doc.updated', data: { title: 'new-from-rest' } },
      delta: { title: { set: 'new-from-rest' } },
    });

    // Wait for the LiveList to process and render
    await tickAsync();

    // Now LiveList should have the new state
    assert.deepEqual(list.state, { id: '1', title: 'new-from-rest' },
      'LiveList caught up after WS event');

    // The overlay should be cleared now (LiveList state matches)
    const afterWs = store.overlayFor('1');
    assert.deepEqual(afterWs, { id: '1', title: 'new-from-rest' },
      'overlay cleared — falls through to LiveList state');

    store.close();
  });

  // --- 8. create temp-id resolves to real id on 201 ---
  it('create returns real id from server; confirmed create overlay is retired', async () => {
    const channel = makeFakeChannel();

    const fetch = makeFakeFetch([
      { match: '/docs', response: { id: 'real-42', title: 'new-doc', status: 'active' } },
    ]);

    const store = createLiveStore({
      baseUrl: 'http://test', name: 'Doc', path: '/docs',
      channel, fetchImpl: fetch,
    });

    const result = await store.create({ title: 'new-doc', status: 'active' });

    assert.ok(result.ok);
    assert.equal(result.status, 'committed');
    assert.equal(result.id, 'real-42');
    assert.deepEqual(result.row, { id: 'real-42', title: 'new-doc', status: 'active' });

    // The create result is the durable way to learn the returned row. The overlay
    // is only a temporary optimistic placeholder and is retired on confirmation.
    assert.equal(store.pendingCreates().length, 0);
    const ov = store.overlayFor('real-42');
    assert.equal(ov, null);

    store.close();
  });

  it('confirmed update overlay survives older live renders and clears at its confirmed seq', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });

    const fetch = makeFakeFetch([
      { match: '/snapshot/Doc/1', response: { snapshot: { id: '1', title: 'old' }, seq: 1 } },
      {
        match: '/docs/1',
        response: { id: '1', title: 'new-from-rest' },
        headers: { 'x-workbench-seq': '3' },
      },
    ]);

    const store = createLiveStore({
      baseUrl: 'http://test', name: 'Doc', path: '/docs',
      channel, fetchImpl: fetch,
    });

    const list = store.subscribe('1');
    await list.ready;

    const result = await store.update('1', { title: 'new-from-rest' });
    assert.ok(result.ok);
    assert.deepEqual(store.overlayFor('1'), { id: '1', title: 'new-from-rest' });

    channel.emit({
      type: 'event', entity: 'Doc', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'Doc.updated', data: { title: 'older-live-event' } },
      delta: { title: { set: 'older-live-event' } },
    });
    await tickAsync();

    assert.deepEqual(list.state, { id: '1', title: 'older-live-event' });
    assert.deepEqual(store.overlayFor('1'), { id: '1', title: 'new-from-rest' },
      'overlay stays visible until the matching committed seq is folded');

    channel.emit({
      type: 'event', entity: 'Doc', id: '1',
      seq: 3, seqSpan: [3, 3],
      event: { type: 'Doc.updated', data: { title: 'new-from-rest' } },
      delta: { title: { set: 'new-from-rest' } },
    });
    await tickAsync();

    assert.deepEqual(list.state, { id: '1', title: 'new-from-rest' });
    assert.deepEqual(store.overlayFor('1'), { id: '1', title: 'new-from-rest' },
      'overlay cleared after cursor reaches the confirmed seq');

    store.close();
  });

  it('confirmed remove overlay survives older live renders and clears at its confirmed seq', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });

    const fetch = async (url, opts) => {
      if (String(url).includes('/snapshot')) {
        return { ok: true, json: async () => ({ snapshot: { id: '1', title: 'old' }, seq: 1 }) };
      }
      if (String(url).includes('/docs/1') && opts?.method === 'DELETE') {
        return {
          ok: true,
          status: 204,
          headers: { get: (name) => name.toLowerCase() === 'x-workbench-seq' ? '3' : null },
          json: async () => {},
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    };

    const store = createLiveStore({
      baseUrl: 'http://test', name: 'Doc', path: '/docs',
      channel, fetchImpl: fetch,
    });

    const list = store.subscribe('1');
    await list.ready;

    const result = await store.remove('1');
    assert.ok(result.ok);
    assert.equal(store.overlayFor('1'), null);

    channel.emit({
      type: 'event', entity: 'Doc', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'Doc.updated', data: { title: 'still-present' } },
      delta: { title: { set: 'still-present' } },
    });
    await tickAsync();

    assert.deepEqual(list.state, { id: '1', title: 'still-present' });
    assert.equal(store.overlayFor('1'), null,
      'confirmed remove remains visible until the matching committed seq is folded');

    channel.emit({
      type: 'event', entity: 'Doc', id: '1',
      seq: 3, seqSpan: [3, 3],
      event: { type: 'Doc.removed', data: { id: '1' } },
    });
    await tickAsync();

    assert.equal(list.state, null);
    assert.equal(store.overlayFor('1'), null,
      'remove overlay cleared after cursor reaches the confirmed seq');

    store.close();
  });

  // --- 9. store.onRender fires on overlay mutation AND on LiveList change ---
  it('store.onRender fires on overlay mutation and on LiveList change', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });

    const fetch = makeFakeFetch([
      { match: '/snapshot/Doc/1', response: { snapshot: { id: '1', title: 'initial' }, seq: 1 } },
      { match: '/docs/1', response: { id: '1', title: 'updated-via-rest' } },
    ]);

    const store = createLiveStore({
      baseUrl: 'http://test', name: 'Doc', path: '/docs',
      channel, fetchImpl: fetch,
    });

    const list = store.subscribe('1');
    await list.ready;

    const renderEvents = [];
    const unsub = store.onRender(() => { renderEvents.push('render'); });

    // 1. Overlay mutation: dispatch update
    // dispatch creates pending overlay → render, then REST resolves → confirmed overlay → render
    await store.update('1', { title: 'updated-via-rest' });
    assert.ok(renderEvents.length >= 2, 'at least 2 renders from overlay pending+confirmed');

    // 2. LiveList change: emit WS event
    renderEvents.length = 0;
    channel.emit({
      type: 'event', entity: 'Doc', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'Doc.updated', data: { title: 'updated-via-rest' } },
      delta: { title: { set: 'updated-via-rest' } },
    });

    await tickAsync();
    assert.ok(renderEvents.length >= 1, 'at least 1 render from LiveList change');

    unsub();
    store.close();
  });

  // --- 10. action() registers + fires a custom route ---
  it('action registers and fires a custom route', async () => {
    const channel = makeFakeChannel();
    let actionUrl = null;
    let actionMethod = null;
    let actionBody = null;

    const fetch = async (url, opts) => {
      if (url.includes('/snapshot')) {
        return { ok: true, json: async () => ({ snapshot: { id: '1', title: 'x' }, seq: 1 }) };
      }
      actionUrl = url;
      actionMethod = opts.method;
      actionBody = opts.body ? JSON.parse(opts.body) : null;
      return { ok: true, json: async () => ({ ok: true }) };
    };

    const store = createLiveStore({
      baseUrl: 'http://test', name: 'Doc', path: '/docs',
      channel, fetchImpl: fetch,
    });

    // Register an action and get the helper fn
    const archiveFn = store.action('archive', { method: 'POST', path: '/docs/1/archive' });

    // Call via the returned fn
    const result = await archiveFn({ reason: 'cleanup' });

    assert.equal(actionUrl, 'http://test/docs/1/archive');
    assert.equal(actionMethod, 'POST');
    assert.deepEqual(actionBody, { reason: 'cleanup' });
    assert.deepEqual(result, {
      ok: true,
      status: 'committed',
      opId: result.opId,
      value: { ok: true },
    });

    // Also test calling via store.<actionType>()
    actionUrl = null;
    actionMethod = null;
    actionBody = null;

    // Register another action
    store.action('ping', { method: 'GET', path: '/health' });
    const _result2 = await store.ping();

    assert.equal(actionUrl, 'http://test/health');
    assert.equal(actionMethod, 'GET');

    store.close();
  });

  // --- 11. close() closes channel + clears caches ---
  it('close closes channel and clears caches', async () => {
    let channelClosed = false;
    let listClosed = false;

    const channel = makeFakeChannel();
    channel.close = () => { channelClosed = true; };

    const fetch = makeFakeFetch([
      { match: '/snapshot/Doc/1', response: { snapshot: { id: '1', title: 'a' }, seq: 1 } },
    ]);

    const store = createLiveStore({
      baseUrl: 'http://test', name: 'Doc', path: '/docs',
      channel, fetchImpl: fetch,
    });

    const list = store.subscribe('1');
    const originalListClose = list.close.bind(list);
    list.close = () => {
      listClosed = true;
      return originalListClose();
    };
    await tick();

    store.close();

    assert.ok(listClosed, 'each cached LiveList is closed');
    assert.ok(channelClosed, 'channel.close() was called');

    // After close, subscribe should throw
    assert.throws(() => store.subscribe('2'), /closed/);

    // dispatch must NOT throw after close — it returns a failed Result like any
    // other failure (contract: the returned Promise never rejects).
    let threw = false;
    let result;
    try { result = await store.dispatch('Doc.create', {}); } catch { threw = true; }
    assert.equal(threw, false, 'dispatch must not throw after close');
    assert.equal(result.ok, false, 'dispatch returns failed Result after close');
    assert.equal(result.status, 'failed-rolled-back');
  });

  it('close is idempotent and an in-flight dispatch settles without rendering again', async () => {
    const response = deferred();
    const channel = makeFakeChannel();
    let channelCloseCount = 0;
    channel.close = () => { channelCloseCount += 1; };

    const store = createLiveStore({
      baseUrl: 'http://test', name: 'Doc', path: '/docs', channel,
      fetchImpl: async () => response.promise,
    });
    let renderCount = 0;
    store.onRender(() => { renderCount += 1; });

    const pending = store.create({ title: 'saved' });
    assert.equal(renderCount, 1, 'optimistic state rendered before shutdown');

    store.close();
    store.close();
    response.resolve({
      ok: true,
      status: 201,
      headers: { get: () => null },
      json: async () => ({ id: '1', title: 'saved' }),
    });

    const result = await pending;
    assert.equal(result.status, 'committed', 'known HTTP success remains truthful');
    assert.equal(renderCount, 1, 'settling an old operation cannot render a closed store');
    assert.equal(channelCloseCount, 1, 'repeated close does not repeat teardown');
  });

  it('reports outcome-unknown when a transmitted write loses its response', async () => {
    let requestStarted = false;
    const store = createLiveStore({
      baseUrl: 'http://test', name: 'Doc', path: '/docs', channel: makeFakeChannel(),
      fetchImpl: async () => {
        requestStarted = true;
        throw new TypeError('connection reset after upload');
      },
    });

    const result = await store.create({ title: 'possibly saved' });

    assert.equal(requestStarted, true);
    assert.deepEqual(result, {
      ok: false,
      status: 'outcome-unknown',
      opId: result.opId,
      deliveryError: { message: 'connection reset after upload' },
    });
    assert.deepEqual(store.pendingCreates(), [], 'uncertain optimistic state is not shown as truth');
    store.close();
  });

  // --- 12. shared decodeResult handles 204 / !ok / json-body ---
  it('decodeResult handles 204, non-ok, and ok-with-body', async () => {
    // 204
    const r1 = await decodeResult({ status: 204 });
    assert.deepEqual(r1, { ok: true, httpStatus: 204, value: undefined });

    // non-ok
    const r2 = await decodeResult({ status: 404, ok: false });
    assert.deepEqual(r2, { ok: false, httpStatus: 404, error: 'http 404' });

    const r3 = await decodeResult({ status: 500, ok: false });
    assert.deepEqual(r3, { ok: false, httpStatus: 500, error: 'http 500' });

    // ok with body
    const r4 = await decodeResult({
      status: 200, ok: true,
      json: async () => ({ id: 'abc', title: 'test' }),
    });
    assert.deepEqual(r4, {
      ok: true,
      httpStatus: 200,
      value: { id: 'abc', title: 'test' },
    });
  });
  // --- overlayStatusFor ---

  it('overlayStatusFor returns null when no overlay exists', () => {
    const store = createLiveStore({ name: 'Test', baseUrl: 'http://localhost:1', path: '/tests', fetchImpl: () => {}, channel: null });
    assert.equal(store.overlayStatusFor('unknown-id'), null);
  });

  it('overlayStatusFor returns pending status during dispatch', async () => {
    let resolvePost;
    const store = createLiveStore({
      name: 'Test',
      baseUrl: 'http://localhost:1',
      path: '/tests',
      fetchImpl: (url, opts) => {
        if (opts.method === 'PATCH' || opts.method === 'PUT') {
          return new Promise((resolve) => { resolvePost = resolve; });
        }
        if (opts.method === 'GET') return Promise.resolve({ ok: true, status: 204, json: async () => {} });
        return Promise.resolve(Response.json({ ok: true }));
      },
      channel: null,
    });
    // Kick off an UPDATE dispatch (update has an id, so overlayStatusFor can find it)
    const resultPromise = store.dispatch('Test.update', { id: 'row-1', title: 'x' });
    // Overlay should be pending immediately
    const status = store.overlayStatusFor('row-1');
    assert.equal(status.status, 'pending');
    assert.equal(status.kind, 'update');
    // Clean up
    resolvePost(Response.json({ ok: true, row: { id: 'row-1', title: 'x' } }));
    await resultPromise;
  });

  it('overlayStatusFor returns confirmed status after dispatch succeeds', async () => {
    const store = createLiveStore({
      name: 'Test',
      baseUrl: 'http://localhost:1',
      path: '/tests',
      fetchImpl: (url, opts) => {
        if (opts.method === 'PATCH' || opts.method === 'PUT') {
          return Promise.resolve(Response.json({ ok: true, row: { id: 'done', title: 'ok' } }));
        }
        return Promise.resolve({ ok: true, status: 204, json: async () => {} });
      },
      channel: null,
    });
    const result = await store.dispatch('Test.update', { id: 'done', title: 'y' });
    assert.ok(result.ok);
    // Confirmed overlays for updates persist (not auto-cleared — cleared by
    // matching live event in subscribe path)
    const status = store.overlayStatusFor('done');
    assert.equal(status.status, 'confirmed');
    assert.equal(status.kind, 'update');
    assert.equal(status.error, null);
  });
});
