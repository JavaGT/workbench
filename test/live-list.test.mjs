// LiveList tests — pure JS, NO real server. Injects a fake channel + fake fetch.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LiveList } from '../public/workbench-client.mjs';
import { applyTextOp, createTextState, materializeText, textCheckpoint } from '../build/annotated-text.mjs';
import { insertText } from '../public/workbench-text-edit.mjs';
import { makeFakeChannel, makeFakeFetch } from './fixtures/fake-transport.mjs';

const TEXT_ACTOR = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const textInsert = ['workbench.text', 1, [TEXT_ACTOR, 1], 1, [], ['insert', ['root'], 'hello']];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a deferred promise { promise, resolve, reject }. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function snapshotUrl(e, id) { return `/api/${e}/${id}/snapshot`; }
function eventsSinceUrl(e, id, cursor) { return `/api/${e}/${id}/events?cursor=${cursor}`; }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LiveList', () => {

  // --- 1. Bootstrap ---
  it('bootstrap: snapshot sets initial state + cursor; ready resolves; onRender fired', async () => {
    const channel = makeFakeChannel();
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { title: 'hello', score: 10 }, seq: 42 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });

    const renders = [];
    list.onRender(s => renders.push(s));

    await list.subscribe();
    assert.equal(list.cursor, 42);
    assert.deepEqual(list.state, { title: 'hello', score: 10 });
    assert.equal(renders.length, 1);
    assert.deepEqual(renders[0], { title: 'hello', score: 10 });
    await list.close();
  });

  it('passes field interest and pace to the channel subscribe call', async () => {
    const calls = [];
    const channel = {
      subscribe(entity, id, options, onEvent) {
        calls.push({
          entity,
          id,
          options: { fields: options.fields, pace: options.pace },
          hasCheckpoint: typeof options.onCheckpoint === 'function',
          hasOnEvent: typeof onEvent === 'function',
        });
        return Promise.resolve({ currentSeq: 1 });
      },
      unsubscribe() { return Promise.resolve(); },
      close() {},
    };
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { title: 'hello' }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
      fields: { cursor: true },
      pace: { profile: '15fps' },
    });

    await list.subscribe();
    assert.deepEqual(calls, [{
      entity: 'ticket',
      id: '1',
      options: { fields: { cursor: true }, pace: { profile: '15fps' } },
      hasCheckpoint: true,
      hasOnEvent: true,
    }]);
    await list.close();
  });

  // --- 2. Live .updated value delta ---
  it('live .updated value delta applies + advances cursor + re-renders', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { title: 'hello' }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    const renders = [];
    list.onRender(s => renders.push(s));

    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.updated', data: {} },
      delta: { title: { set: 'world' } },
    });

    assert.equal(list.cursor, 2);
    assert.equal(list.state.title, 'world');
    assert.equal(renders.length, 1);
    assert.deepEqual(renders[0], { title: 'world' });
    await list.close();
  });

  // --- 3. Queued-before-ready (deferred ack) ---
  it('queued-before-ready: deferred ack, emit before resolve, queue applied after ready', async () => {
    const subs = new Map();
    const deferredAck = deferred();

    const channel = {
      subscribe(e, id, optionsOrOnEvent, maybeOnEvent) {
        const onEvent = typeof optionsOrOnEvent === 'function' ? optionsOrOnEvent : maybeOnEvent;
        subs.set(`${e}\0${id}`, onEvent);
        return deferredAck.promise;
      },
      unsubscribe(e, id) {
        subs.delete(`${e}\0${id}`);
        return Promise.resolve();
      },
      close() {},
      emit(envelope) {
        const onEvent = subs.get(`${envelope.entity}\0${envelope.id}`);
        if (onEvent) onEvent(envelope);
      },
      _resolveAck(ack) { deferredAck.resolve(ack); },
    };

    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { title: 'hello', count: 0 }, seq: 5 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });

    const renders = [];
    list.onRender(s => renders.push(s));

    // Start subscribe — pauses at channel.subscribe waiting on deferred ack.
    const subPromise = list.subscribe();

    // Yield to let the async subscribe() reach channel.subscribe() and
    // register the onEvent callback.
    await new Promise(r => setTimeout(r, 0));

    // Now the callback is registered; emit an envelope — it will be queued
    // because _ready is still false.
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 6, seqSpan: [6, 6],
      event: { type: 'ticket.updated', data: {} },
      delta: { title: { set: 'queued-update' } },
    });

    // Resolve the ack — this should trigger the queue drain.
    channel._resolveAck({ currentSeq: 5 });

    await subPromise;

    assert.equal(list.cursor, 6);
    assert.equal(list.state.title, 'queued-update');
    assert.equal(renders.length, 2); // bootstrap render + queued render
    await list.close();
  });

  // --- 4. Span-aware dup skip ---
  it('span-aware: envelope with seqSpan below cursor is skipped', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 5 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { val: 1 }, seq: 5 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 3, seqSpan: [3, 3],
      event: { type: 'ticket.updated', data: {} },
      delta: { val: { set: 99 } },
    });

    assert.equal(list.cursor, 5);
    assert.equal(list.state.val, 1);
    await list.close();
  });

  // --- 5. Span-aware gap → resync ---
  it('span-aware gap triggers resync via events-since, state catches up', async () => {
    const channel = makeFakeChannel();

    // Use a responseFn for /events so we can return different results for the
    // bootstrap resync (cursor=3, fill events 4-5) and the gap resync
    // (cursor=5, fill event 6).
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { val: 'a' }, seq: 3 } },
      {
        match: '/events',
        responseFn: (url) => {
          const m = url.match(/cursor=(\d+)/);
          const cursor = m ? parseInt(m[1], 10) : 0;
          if (cursor <= 3) {
            // Bootstrap resync: fill events 4-5
            return { events: [
              { type: 'ticket.updated', scope: 'ticket', seq: 4, data: { val: 'b' }, actionId: 'a1', committedAt: 1 },
              { type: 'ticket.updated', scope: 'ticket', seq: 5, data: { val: 'c' }, actionId: 'a2', committedAt: 2 },
            ] };
          }
          // Gap resync: fill event 6
          return { events: [
            { type: 'ticket.updated', scope: 'ticket', seq: 6, data: { val: 'd' }, actionId: 'a3', committedAt: 3 },
          ] };
        },
      },
    ]);

    // Bootstrap: snapshot gives seq 3, but ack reports currentSeq 5 →
    // subscribe() triggers a bootstrap resync that fills seq 4-5.
    channel._setAck({ currentSeq: 5 });

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();
    assert.equal(list.cursor, 5);
    assert.equal(list.state.val, 'c');

    // Emit a live event at seq 7 (gap at seq 6) — triggers resync.
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 7, seqSpan: [7, 7],
      event: { type: 'ticket.updated', data: {} },
      delta: { val: { set: 'e' } },
    });

    // Wait for the async resync to complete.
    await new Promise(r => setTimeout(r, 20));

    assert.equal(list.cursor, 7);
    assert.equal(list.state.val, 'e');
    await list.close();
  });

  // --- 6. Retired text delta protocol ---
  it('ignores retired text prefix/suffix deltas', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { text: 'Hello World' }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.updated', data: {} },
      delta: { text: { insert: { at: 5, text: ' beautiful' } } },
    });
    assert.equal(list.state.text, 'Hello World');

    await list.close();
  });

  it('text.crdt snapshot sidecar bootstraps and native operations fold through the shared reducer', async () => {
    const channel = makeFakeChannel();
    const checkpoint = textCheckpoint(applyTextOp(createTextState(), textInsert));
    const reducers = [{ entity: 'Doc', id: '1', field: 'body', reducer: 'workbench.text', version: 1, checkpoint }];
    const fetchImpl = async () => ({ ok: true, json: async () => ({ snapshot: { id: '1', body: 'hello' }, reducers, seq: 1 }) });
    const list = new LiveList({ entity: 'Doc', id: '1', channel, fetchImpl, snapshotUrl: () => '/snapshot', eventsSinceUrl: () => '/events' });
    await list.subscribe();
    assert.equal(list.state.body, 'hello');
    const second = ['workbench.text', 1, [TEXT_ACTOR, 2], 2, [[TEXT_ACTOR, 1]], ['insert', ['element', [[TEXT_ACTOR, 1], 4]], '!']];
    channel.emit({ type: 'event', entity: 'Doc', id: '1', seq: 2, seqSpan: [2, 2], event: { type: 'Doc.body.applied', data: { id: '1', operation: second } } });
    assert.equal(list.state.body, 'hello!');
    // Duplicate reducer operations are idempotent even when transport sequence differs.
    channel.emit({ type: 'event', entity: 'Doc', id: '1', seq: 3, seqSpan: [3, 3], event: { type: 'Doc.body.applied', data: { id: '1', operation: second } } });
    assert.equal(list.state.body, 'hello!');
  });

  it('readiness waits for queued native-operation replica observation', async () => {
    const channel = makeFakeChannel();
    const ack = deferred();
    channel.subscribe = (entity, id, options, onEvent) => {
      const _key = `${entity}\0${String(id)}`;
      channel._setAck({ currentSeq: 1 });
      // Register before holding the acknowledgement so the operation queues.
      const original = makeFakeChannel();
      void original;
      channel.emit = (envelope) => onEvent(envelope);
      return ack.promise;
    };
    const observed = deferred();
    const list = new LiveList({
      entity: 'Doc', id: '1', channel,
      fetchImpl: async () => ({ ok: true, json: async () => ({ snapshot: { id: '1', body: '' }, seq: 0 }) }),
      snapshotUrl: () => '/snapshot', eventsSinceUrl: () => '/events',
      onTextReducer: () => observed.promise,
    });
    const subscribing = list.subscribe();
    await new Promise((resolve) => setImmediate(resolve));
    channel.emit({ type: 'event', entity: 'Doc', id: '1', seq: 1, seqSpan: [1, 1], event: { type: 'Doc.body.applied', data: { id: '1', operation: textInsert } } });
    ack.resolve({ currentSeq: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    let ready = false;
    subscribing.then(() => { ready = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ready, false);
    observed.resolve();
    await subscribing;
    assert.equal(list.state.body, 'hello');
  });

  it('installs created text reducer seeds before a following applied event', async () => {
    const channel = makeFakeChannel();
    const fetchImpl = async () => ({ ok: true, json: async () => ({ snapshot: { id: '1', body: '' }, seq: 0 }) });
    const list = new LiveList({ entity: 'Doc', id: '1', channel, fetchImpl, snapshotUrl: () => '/snapshot', eventsSinceUrl: () => '/events' });
    await list.subscribe();
    const reducers = [{ entity: 'Doc', id: '1', field: 'body', reducer: 'workbench.text', version: 1, checkpoint: textCheckpoint(createTextState()) }];
    channel.emit({ type: 'event', entity: 'Doc', id: '1', seq: 1, seqSpan: [1, 1], event: { type: 'Doc.created', data: { id: '1', body: '' } }, reducers });
    channel.emit({ type: 'event', entity: 'Doc', id: '1', seq: 2, seqSpan: [2, 2], event: { type: 'Doc.body.applied', data: { id: '1', operation: textInsert } } });
    assert.equal(list.state.body, 'hello');
  });

  it('replays created reducer seeds before applied events from events-since', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 2 });
    const reducers = [{ entity: 'Doc', id: '1', field: 'body', reducer: 'workbench.text', version: 1, checkpoint: textCheckpoint(createTextState()) }];
    const fetchImpl = async (url) => ({
      ok: true,
      json: async () => String(url).includes('/events')
        ? { events: [
          { seq: 1, type: 'Doc.created', data: { id: '1', body: '' }, reducers },
          { seq: 2, type: 'Doc.body.applied', data: { id: '1', operation: textInsert } },
        ] }
        : { snapshot: { id: '1', body: '' }, seq: 0 },
    });
    const list = new LiveList({ entity: 'Doc', id: '1', channel, fetchImpl, snapshotUrl: () => '/snapshot', eventsSinceUrl: () => '/events' });
    await list.subscribe();
    assert.equal(list.cursor, 2);
    assert.equal(list.state.body, 'hello');
  });

  // --- 6a-batch (#126): resync catch-up folds every pending applied op before
  // the render tick, so the text tree is rebuilt once per batch — not once per
  // row — while publishes and final state stay exactly as before.
  /** Build N chained append operations ('1'..'N' appended in order) plus the reference fold. */
  function sequentialInsertOps(count) {
    let state = createTextState();
    const ops = [];
    for (let index = 1; index <= count; index += 1) {
      const operation = insertText(state, { actor: TEXT_ACTOR, counter: index, lamport: index }, index - 1, String(index));
      ops.push(operation);
      state = applyTextOp(state, operation);
    }
    return { ops, reference: materializeText(state) };
  }

  it('resync replay folds N applied ops with one rematerialization and one publish', async () => {
    const { ops, reference } = sequentialInsertOps(5);
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: ops.length });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { id: '1', body: '' }, seq: 0 } },
      { match: '/events', response: {
        events: ops.map((operation, index) => ({
          seq: index + 1, type: 'Doc.body.applied', data: { id: '1', operation },
        })),
      } },
    ]);

    // Spy on the rematerialization seam — batching must collapse N folds into
    // exactly one rebuild for the whole catch-up batch.
    let rematerializations = 0;
    const original = LiveList.prototype._rematerializeTextField;
    LiveList.prototype._rematerializeTextField = function (field) {
      rematerializations += 1;
      return original.call(this, field);
    };

    try {
      const list = new LiveList({ entity: 'Doc', id: '1', channel, fetchImpl: fetch, snapshotUrl: () => '/snapshot', eventsSinceUrl: () => '/events' });
      const renders = [];
      list.onRender((state) => renders.push(state));
      await list.subscribe();

      assert.equal(rematerializations, 1, `expected one rematerialization for the ${ops.length}-op replay`);
      assert.equal(renders.length, 2); // resync-completion render + bootstrap render
      assert.deepEqual(renders.at(-1), { id: '1', body: reference }, 'published state matches the reference fold');
      assert.equal(list.cursor, ops.length);
      await list.close();
    } finally {
      LiveList.prototype._rematerializeTextField = original;
    }
  });

  it('live applied envelopes keep per-event rematerialization and render semantics', async () => {
    const { ops } = sequentialInsertOps(3);
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 0 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { id: '1', body: '' }, seq: 0 } },
    ]);
    const list = new LiveList({ entity: 'Doc', id: '1', channel, fetchImpl: fetch, snapshotUrl: () => '/snapshot', eventsSinceUrl: () => '/events' });
    await list.subscribe();

    let rematerializations = 0;
    const renders = [];
    const original = LiveList.prototype._rematerializeTextField;
    LiveList.prototype._rematerializeTextField = function (field) {
      rematerializations += 1;
      return original.call(this, field);
    };
    list.onRender((state) => renders.push(state));

    try {
      ops.forEach((operation, index) => {
        channel.emit({ type: 'event', entity: 'Doc', id: '1', seq: index + 1, seqSpan: [index + 1, index + 1], event: { type: 'Doc.body.applied', data: { id: '1', operation } } });
      });
      assert.equal(rematerializations, 3, 'one rebuild per live envelope — publish semantics unchanged');
      assert.equal(renders.length, 3);
      assert.equal(list.state.body, '123');
      await list.close();
    } finally {
      LiveList.prototype._rematerializeTextField = original;
    }
  });

  it('a failed resync keeps earlier ops rendered and the retry completes the batch', async () => {
    // Ops 1-2 are valid; op 3 reuses op 2's operation ID with different
    // content, which applyTextOp fails closed on; op 3'/4 complete the batch.
    let state = createTextState();
    const build = (counter, text) => {
      const operation = insertText(state, { actor: TEXT_ACTOR, counter, lamport: counter }, counter - 1, text);
      state = applyTextOp(state, operation);
      return operation;
    };
    const op1 = build(1, '1');
    const op2 = build(2, '2');
    const op3 = build(3, '3');
    const op4 = build(4, '4');
    const poisoned = ['workbench.text', 1, [TEXT_ACTOR, 2], 9, [], ['insert', ['root'], 'X']];
    const row = (seq, operation) => ({ seq, type: 'Doc.body.applied', data: { id: '1', operation } });

    let eventsCalls = 0;
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 4 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { id: '1', body: '' }, seq: 0 } },
      { match: '/events', responseFn: () => {
        eventsCalls += 1;
        // First attempt carries the poisoned row; the repaired server data completes it.
        return { events: eventsCalls === 1 ? [row(1, op1), row(2, op2), row(3, poisoned)] : [row(1, op1), row(2, op2), row(3, op3), row(4, op4)] };
      } },
    ]);

    const list = new LiveList({
      entity: 'Doc', id: '1', channel, fetchImpl: fetch,
      snapshotUrl: () => '/snapshot', eventsSinceUrl: () => '/events',
      resyncBackoffBase: 1,
    });
    await list.subscribe();

    // Ops 1-2 applied before the throw must be visible even though the batch
    // failed — the retry resumes after their cursor and never refolds them.
    assert.equal(list.state.body, '12');
    assert.equal(list.cursor, 2);

    const deadline = Date.now() + 1000;
    while (list.state.body !== '1234' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(list.state.body, '1234', 'retry completed the remaining ops');
    assert.equal(list.cursor, 4);
    await list.close();
  });

  // --- 6b. Value-XOR-delta: a field present in delta must NOT ALSO be
  // whole-applied from event.data (the real server sends BOTH — event.data
  // carries the whole new value, delta carries the diff for the same field).
  // Applying both double-applies: 'hello' + whole 'hello world' + insert
  // ' world' → 'hello world world'. delta is authoritative for delta fields;
  // event.data whole-value assignment covers only fields NOT in delta.
  it('retired crdt delta does not apply a whole-string text update', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { body: 'hello' }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    // Real server envelope for 'hello' → 'hello world' on a crdt field:
    //   event.data.body = 'hello world' (whole new value)   ← createClient reads this
    //   delta.body      = {insert:{at:5,text:' world'}}      ← LiveList reads this
    // LiveList must apply the delta and IGNORE the whole event.data.body,
    // else it double-applies.
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.updated', data: { body: 'hello world' } },
      delta: { body: { insert: { at: 5, text: ' world' } } },
    });
    assert.equal(list.state.body, 'hello');

    await list.close();
  });

  // --- 6c. Value-XOR-delta: a scalar field NOT in delta still applies from
  // event.data (the createClient app-reducer contract — whole values remain
  // authoritative for non-delta fields). Mixed envelope: one delta field, one
  // plain event.data field.
  it('scalar fields remain whole-value updates when a retired crdt delta is present', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { body: 'hello', label: 'A' }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    // body changes via delta (crdt); label changes via whole value (no delta).
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.updated', data: { body: 'hello world', label: 'B' } },
      delta: { body: { insert: { at: 5, text: ' world' } } },
    });
    assert.equal(list.state.body, 'hello');
    assert.equal(list.state.label, 'B', 'non-delta scalar still applied from event.data');

    await list.close();
  });

  // --- 7. Ordered ops ---
  it('ordered: inserted items sorted by fractional key; moved re-sorts; removed drops', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { items: [] }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    // NOTE: keys are NUMERIC (server column is `key REAL`, entity.mjs keyBetween
    // produces numbers). The client must sort numerically to match SQLite
    // `ORDER BY key`. Keys 2 and 10 below are the divergence guard: a string sort
    // would order "10" before "2" — a numeric sort orders 2 before 10.
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.items.inserted', data: { owner: 'u1', id: 'a', key: 3, value: 'alpha' } },
    });
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 3, seqSpan: [3, 3],
      event: { type: 'ticket.items.inserted', data: { owner: 'u1', id: 'b', key: 2, value: 'beta' } },
    });
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 4, seqSpan: [4, 4],
      event: { type: 'ticket.items.inserted', data: { owner: 'u1', id: 'c', key: 10, value: 'gamma' } },
    });

    // Numeric sort by key: 2='beta', 3='alpha', 10='gamma'.
    // (A string sort would give beta, gamma[="10"], alpha — the divergence.)
    assert.deepEqual(list.state.items, ['beta', 'alpha', 'gamma']);

    // Move 'c' to key 2.5 → beta, gamma, alpha (2, 2.5, 3)
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 5, seqSpan: [5, 5],
      event: { type: 'ticket.items.moved', data: { owner: 'u1', id: 'c', key: 2.5 } },
    });
    assert.deepEqual(list.state.items, ['beta', 'gamma', 'alpha']);

    // Remove 'a' → beta, gamma
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 6, seqSpan: [6, 6],
      event: { type: 'ticket.items.removed', data: { owner: 'u1', id: 'a' } },
    });
    assert.deepEqual(list.state.items, ['beta', 'gamma']);

    await list.close();
  });

  // --- 8. Map delta ---
  it('map delta: added/changed/removed produce correct map object', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { members: { alice: 'owner' } }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.updated', data: {} },
      delta: { members: { added: [{ member: 'bob', role: 'editor' }] } },
    });
    assert.deepEqual(list.state.members, { alice: 'owner', bob: 'editor' });

    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 3, seqSpan: [3, 3],
      event: { type: 'ticket.updated', data: {} },
      delta: { members: { changed: [{ member: 'alice', role: 'viewer' }] } },
    });
    assert.deepEqual(list.state.members, { alice: 'viewer', bob: 'editor' });

    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 4, seqSpan: [4, 4],
      event: { type: 'ticket.updated', data: {} },
      delta: { members: { removed: ['bob'] } },
    });
    assert.deepEqual(list.state.members, { alice: 'viewer' });

    await list.close();
  });

  // --- 9. Struct delta ---
  it('struct delta: cells set updates nested struct object', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { config: { theme: 'dark' } }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.updated', data: {} },
      delta: { config: { cells: { theme: { set: 'light' }, fontSize: { set: 14 } } } },
    });

    assert.deepEqual(list.state.config, { theme: 'light', fontSize: 14 });
    await list.close();
  });

  // --- 10. .removed CRUD ---
  it('.removed CRUD → state becomes null', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { title: 'hello' }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.removed', data: {} },
    });

    assert.equal(list.state, null);
    assert.equal(list.cursor, 2);
    await list.close();
  });

  // --- 11. Resync stale → re-bootstrap ---
  it('events-since resync stale forces re-bootstrap from fresh snapshot', async () => {
    let snapshotCalls = 0;
    const channel = makeFakeChannel();

    // Bootstrap: ack.currentSeq matches snapshot seq so no bootstrap resync.
    channel._setAck({ currentSeq: 3 });

    const fetch = makeFakeFetch([
      {
        match: '/snapshot',
        responseFn: () => {
          snapshotCalls++;
          if (snapshotCalls === 1) return { snapshot: { title: 'old' }, seq: 3 };
          return { snapshot: { title: 'fresh' }, seq: 10 };
        },
      },
      {
        match: '/events',
        response: { resync: 'stale', reason: 'server restarted' },
      },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();
    assert.equal(snapshotCalls, 1);
    assert.equal(list.cursor, 3);
    assert.equal(list.state.title, 'old');

    // Emit a gap to trigger resync (expects seq 5, got seq 7).
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 7, seqSpan: [7, 7],
      event: { type: 'ticket.updated', data: {} },
      delta: { title: { set: 'ignored' } },
    });

    await new Promise(r => setTimeout(r, 20));

    assert.equal(snapshotCalls, 2);
    assert.equal(list.state.title, 'fresh');
    assert.equal(list.cursor, 10);
    await list.close();
  });

  it('events-since deleted terminates without fetching a deleted snapshot', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 3 });
    let snapshotCalls = 0;
    const fetch = makeFakeFetch([
      {
        match: '/snapshot',
        responseFn: () => {
          snapshotCalls++;
          return { snapshot: { title: 'old' }, seq: 3 };
        },
      },
      { match: '/events', response: { resync: 'deleted', seq: 7 } },
    ]);
    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();
    channel.emit({
      type: 'event', entity: 'ticket', id: '1', seq: 7, seqSpan: [7, 7],
      event: { type: 'ticket.updated', data: {} },
    });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(snapshotCalls, 1);
    assert.equal(list.state, null);
    assert.equal(list.cursor, 7);
    await list.close();
  });

  it('opaque live resync replaces annotated state only after a projected snapshot reaches its sequence', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 3 });
    let snapshotCalls = 0;
    const fetch = makeFakeFetch([
      {
        match: '/snapshot',
        responseFn: () => {
          snapshotCalls++;
          return snapshotCalls === 1
            ? { snapshot: { body: { kind: 'workbench.annotatedText.recipient', version: 1 } }, seq: 3 }
            : { snapshot: { body: { kind: 'workbench.annotatedText.recipient', version: 1, blocks: [{ kind: 'restricted', id: 'b1', placeholder: '[Restricted]' }] } }, seq: 7 };
        },
      },
    ]);
    const list = new LiveList({ entity: 'Doc', id: 'd1', channel, fetchImpl: fetch, snapshotUrl, eventsSinceUrl });
    await list.subscribe();
    channel.resync('Doc', 'd1', { type: 'resync', entity: 'Doc', id: 'd1', seq: 7, reason: 'annotated-text-snapshot-required' });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(snapshotCalls, 2);
    assert.equal(list.cursor, 7);
    assert.deepEqual(list.state.body.blocks, [{ kind: 'restricted', id: 'b1', placeholder: '[Restricted]' }]);
    await list.close();
  });

  it('opaque live resync retains a concurrent envelope high-water until its snapshot catches up', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 3 });
    const secondSnapshot = deferred();
    let snapshotCalls = 0;
    const fetch = makeFakeFetch([
      {
        match: '/snapshot',
        responseFn: () => {
          snapshotCalls++;
          if (snapshotCalls === 1) return { snapshot: { body: { kind: 'workbench.annotatedText.recipient', version: 1 } }, seq: 3 };
          if (snapshotCalls === 2) return secondSnapshot.promise;
          return { snapshot: { body: { kind: 'workbench.annotatedText.recipient', version: 1 }, title: 'latest' }, seq: 8 };
        },
      },
    ]);
    const list = new LiveList({ entity: 'Doc', id: 'd1', channel, fetchImpl: fetch, snapshotUrl, eventsSinceUrl, resyncBackoffBase: 1 });
    await list.subscribe();
    channel.resync('Doc', 'd1', { type: 'resync', entity: 'Doc', id: 'd1', seq: 7, reason: 'annotated-text-snapshot-required' });
    await new Promise(r => setTimeout(r, 0));
    channel.emit({
      type: 'event', entity: 'Doc', id: 'd1', seq: 8, seqSpan: [8, 8],
      event: { type: 'Doc.updated', data: {} }, delta: { title: { set: 'queued' } },
    });
    secondSnapshot.resolve({ snapshot: { body: { kind: 'workbench.annotatedText.recipient', version: 1 }, title: 'too-old' }, seq: 7 });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(snapshotCalls, 3);
    assert.equal(list.cursor, 8);
    assert.equal(list.state.title, 'latest');
    await list.close();
  });

  it('opaque live resync reaches terminal removal when a deleted snapshot cannot recover', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 6 });
    const deferredSnapshot = deferred();
    let snapshotCalls = 0;
    const fetch = makeFakeFetch([
      {
        match: '/snapshot',
        responseFn: () => {
          snapshotCalls++;
          if (snapshotCalls === 1) return { snapshot: { body: { kind: 'workbench.annotatedText.recipient', version: 1 } }, seq: 6 };
          return deferredSnapshot.promise;
        },
      },
    ]);
    const list = new LiveList({ entity: 'Doc', id: 'd1', channel, fetchImpl: fetch, snapshotUrl, eventsSinceUrl, resyncBackoffBase: 1 });
    await list.subscribe();
    channel.resync('Doc', 'd1', { type: 'resync', entity: 'Doc', id: 'd1', seq: 7, reason: 'annotated-text-snapshot-required' });
    await new Promise(r => setTimeout(r, 0));
    channel.emit({
      type: 'event', entity: 'Doc', id: 'd1', seq: 8, seqSpan: [8, 8],
      event: { type: 'Doc.removed' },
    });
    deferredSnapshot.reject(new Error('deleted snapshot is unavailable'));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(snapshotCalls, 2);
    assert.equal(list.state, null);
    assert.equal(list.cursor, 8);
    await list.close();
  });

  it('opaque live resync preserves a queued removal after a successful stale snapshot', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 6 });
    const deferredSnapshot = deferred();
    let snapshotCalls = 0;
    const fetch = makeFakeFetch([
      {
        match: '/snapshot',
        responseFn: () => {
          snapshotCalls++;
          if (snapshotCalls === 1) return { snapshot: { body: { kind: 'workbench.annotatedText.recipient', version: 1 } }, seq: 6 };
          return deferredSnapshot.promise;
        },
      },
    ]);
    const list = new LiveList({ entity: 'Doc', id: 'd1', channel, fetchImpl: fetch, snapshotUrl, eventsSinceUrl });
    await list.subscribe();
    channel.resync('Doc', 'd1', { type: 'resync', entity: 'Doc', id: 'd1', seq: 7, reason: 'annotated-text-snapshot-required' });
    await new Promise(r => setTimeout(r, 0));
    channel.emit({
      type: 'event', entity: 'Doc', id: 'd1', seq: 8, seqSpan: [8, 8],
      event: { type: 'Doc.removed' },
    });
    deferredSnapshot.resolve({ snapshot: { body: { kind: 'workbench.annotatedText.recipient', version: 1 } }, seq: 7 });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(snapshotCalls, 2);
    assert.equal(list.state, null);
    assert.equal(list.cursor, 8);
    await list.close();
  });

  // --- 11b. Immutable state identity (reactive frameworks) ---
  // A Solid createSignal (and React, and Vue) compares by reference: mutating
  // the same object in place drops every update. LiveList must emit a NEW state
  // object on each applied change and on snapshot install, while unchanged
  // fields keep their references (structural sharing).
  it('applied changes and snapshot installs publish new state identities with structural sharing', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const firstSnapshot = { title: 'hello', config: { theme: 'dark' } };
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: firstSnapshot, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    const renders = [];
    list.onRender(s => renders.push(s));
    await list.subscribe();

    const initial = list.state;
    assert.notEqual(initial, firstSnapshot, 'snapshot install copies the fetched object');

    // Delta-set one scalar: a new top-level object, other fields shared.
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.updated', data: {} },
      delta: { title: { set: 'world' } },
    });
    const afterUpdate = list.state;
    assert.notEqual(afterUpdate, initial, 'delta update publishes a new identity');
    assert.equal(afterUpdate.config, initial.config, 'unchanged nested field is shared by reference');
    assert.equal(afterUpdate.title, 'world');

    // Struct delta under a shared field: the nested object is cloned, the
    // top-level identity is new again.
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 3, seqSpan: [3, 3],
      event: { type: 'ticket.updated', data: {} },
      delta: { config: { cells: { theme: { set: 'light' } } } },
    });
    const afterStruct = list.state;
    assert.notEqual(afterStruct, afterUpdate, 'struct delta publishes a new identity');
    assert.deepEqual(afterStruct.config, { theme: 'light' });

    // Map + ordered + log mutations each emit their own new identity.
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 4, seqSpan: [4, 4],
      event: { type: 'ticket.members.added', data: { member: 'bob', role: 'editor' } },
    });
    const afterMap = list.state;
    assert.notEqual(afterMap, afterStruct, 'map add publishes a new identity');
    assert.deepEqual(afterMap.members, { bob: 'editor' });

    // Every render already observed a distinct object (the reactive contract).
    const renderedIdentities = new Set(renders);
    assert.equal(renderedIdentities.size, renders.length, 'each render receives a distinct state object');

    await list.close();
  });

  // --- 12. Close ---
  it('close(): after close, further emitted envelopes do not change state or render', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { val: 'initial' }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    const renders = [];
    list.onRender(s => renders.push(s));

    await list.close();

    // After close, emits should be ignored.
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.updated', data: {} },
      delta: { val: { set: 'should-not-apply' } },
    });

    assert.equal(list.state.val, 'initial');
    assert.equal(renders.length, 0);
    await list.close(); // idempotent — should not throw
  });

  it('reconnect checkpoint resyncs missed events without waiting for another live event', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { title: 'old' }, seq: 1 } },
      {
        match: '/events',
        response: {
          events: [{
            seq: 2,
            type: 'ticket.updated',
            data: { title: 'new' },
            actionId: 'a2',
          }],
        },
      },
    ]);
    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    channel.checkpoint('ticket', '1', 2);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(list.cursor, 2);
    assert.equal(list.state.title, 'new');
    await list.close();
  });

  it('close during a deferred snapshot prevents subscription and rejects readiness', async () => {
    const snapshot = deferred();
    let subscribeCalls = 0;
    const channel = {
      subscribe() { subscribeCalls++; return Promise.resolve({ currentSeq: 1 }); },
      unsubscribe() { return Promise.resolve(); },
    };
    const list = new LiveList({
      entity: 'ticket', id: '1', channel,
      fetchImpl: () => snapshot.promise,
      snapshotUrl, eventsSinceUrl,
    });
    const subscribing = list.subscribe();
    const rejected = assert.rejects(subscribing, /closed/i);

    await list.close();
    snapshot.resolve({ ok: true, json: async () => ({ snapshot: { title: 'late' }, seq: 1 }) });
    await rejected;
    assert.equal(subscribeCalls, 0);
    assert.equal(list.state, null);
  });

  it('close during deferred resync cannot mutate state, cursor, or renders', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const resync = deferred();
    const fetch = async (url) => {
      if (url.includes('/snapshot')) {
        return { ok: true, json: async () => ({ snapshot: { title: 'old' }, seq: 1 }) };
      }
      return resync.promise;
    };
    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();
    let renders = 0;
    list.onRender(() => { renders++; });
    channel.emit({
      type: 'event', entity: 'ticket', id: '1', seq: 3, seqSpan: [3, 3],
      event: { type: 'ticket.updated', data: { title: 'late' } },
    });
    await Promise.resolve();
    await list.close();
    resync.resolve({
      ok: true,
      json: async () => ({
        events: [{ seq: 2, type: 'ticket.updated', data: { title: 'new' }, actionId: 'a2' }],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(list.cursor, 1);
    assert.equal(list.state.title, 'old');
    assert.equal(renders, 0);
  });

  it('buffer overflow discards deltas and performs one authoritative snapshot recovery', async () => {
    const subs = new Map();
    const deferredAck = deferred();
    const channel = {
      subscribe(entity, id, _options, onEvent) {
        subs.set(`${entity}\0${id}`, onEvent);
        return deferredAck.promise;
      },
      unsubscribe() { return Promise.resolve(); },
      emit(envelope) { subs.get(`${envelope.entity}\0${envelope.id}`)?.(envelope); },
    };
    let snapshots = 0;
    const fetch = async (url) => {
      if (url.includes('/snapshot')) {
        snapshots++;
        const body = snapshots === 1
          ? { snapshot: { title: 'old' }, seq: 1 }
          : { snapshot: { title: 'server' }, seq: 4 };
        return { ok: true, json: async () => body };
      }
      return { ok: true, json: async () => ({ events: [] }) };
    };
    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl, maxBufferedEvents: 2,
    });
    const subscribing = list.subscribe();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let seq = 2; seq <= 4; seq++) {
      channel.emit({
        type: 'event', entity: 'ticket', id: '1', seq, seqSpan: [seq, seq],
        event: { type: 'ticket.updated', data: { title: `delta-${seq}` } },
      });
    }
    deferredAck.resolve({ currentSeq: 4 });
    await subscribing;

    assert.equal(snapshots, 2);
    assert.equal(list.cursor, 4);
    assert.equal(list.state.title, 'server');
    await list.close();
  });

  it('failed resync uses retry backoff instead of hot-looping', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    let resyncCalls = 0;
    const fetch = async (url) => {
      if (url.includes('/snapshot')) {
        return { ok: true, json: async () => ({ snapshot: { title: 'old' }, seq: 1 }) };
      }
      resyncCalls++;
      return { ok: false, status: 503, json: async () => ({}) };
    };
    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
      resyncBackoffBase: 30,
      maxResyncBackoff: 30,
    });
    await list.subscribe();
    channel.emit({
      type: 'event', entity: 'ticket', id: '1', seq: 3, seqSpan: [3, 3],
      event: { type: 'ticket.updated', data: { title: 'gap' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(resyncCalls, 1);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(resyncCalls, 2);
    await list.close();
  });

});
