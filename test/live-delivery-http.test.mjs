import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createLiveDeliveryHttpHandler } from '../build/server.mjs';
import { createLiveDeliveryHttpSession } from '../public/workbench-client.mjs';

async function serve(handler) {
  const server = http.createServer((req, res) => handler(req, res).then((handled) => {
    if (!handled && !res.writableEnded) res.writeHead(404).end();
  }));
  server.listen(0);
  await once(server, 'listening');
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/live-delivery` };
}

test('HTTP delivery binds bootstrap, catch-up, recipient envelopes, and abort cleanup without application replay state', async () => {
  const subscriptions = [];
  const delivery = {
    async bootstrap({ principal, scope }) {
      assert.equal(principal.id, 'u1');
      assert.equal(scope, 'Project:p1');
      return { kind: 'snapshot', snapshot: { id: 'p1', name: 'one' }, cursor: 1 };
    },
    async catchup({ after }) {
      return { kind: 'catchup', envelopes: [{ type: 'event', seq: after + 1, event: { type: 'Project.updated', data: { name: 'two' } } }], cursor: after + 1 };
    },
    async subscribe(input) { subscriptions.push(input); return { activate: async () => input.after }; },
  };
  const handler = createLiveDeliveryHttpHandler({ delivery, principalOf: () => ({ type: 'user', id: 'u1' }), maxSubscriptions: 1 });
  const { server, baseUrl } = await serve(handler);
  try {
    const bootstrap = await fetch(`${baseUrl}/bootstrap?scope=Project%3Ap1&mode=snapshot`).then((response) => response.json());
    assert.deepEqual(bootstrap, { kind: 'snapshot', snapshot: { id: 'p1', name: 'one' }, cursor: 1 });
    const catchup = await fetch(`${baseUrl}/bootstrap?scope=Project%3Ap1&mode=catchup&after=1`).then((response) => response.json());
    assert.equal(catchup.envelopes[0].event.data.name, 'two');

    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/events?scope=Project%3Ap1&after=1`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    await subscriptions[0].deliver([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(subscriptions[0].signal.aborted, true);
  } finally {
    server.close();
  }
});

test('HTTP delivery rejects malformed requests and enforces a stream cap', async () => {
  const delivery = { bootstrap: async () => ({ kind: 'revoked' }), catchup: async () => ({ kind: 'revoked' }), subscribe: async () => ({ activate: async () => 0 }) };
  const { server, baseUrl } = await serve(createLiveDeliveryHttpHandler({ delivery, principalOf: () => ({ type: 'user', id: 'u1' }) }));
  try {
    assert.equal((await fetch(`${baseUrl}/bootstrap?scope=x&mode=bad`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/bootstrap?scope=x&mode=catchup&after=-1`)).status, 400);
  } finally { server.close(); }
});

test('HTTP delivery logs bootstrap exceptions before returning a sanitized failure', async () => {
  const logs = [];
  const delivery = {
    bootstrap: async () => { throw new Error('offset is outside text bounds'); },
    catchup: async () => ({ kind: 'revoked' }),
    subscribe: async () => ({ activate: async () => 0 }),
  };
  const handler = createLiveDeliveryHttpHandler({
    delivery,
    principalOf: () => ({ type: 'user', id: 'u1' }),
    log: { error: (channel, message, context) => logs.push({ channel, message, context }) },
  });
  const { server, baseUrl } = await serve(handler);
  try {
    const response = await fetch(`${baseUrl}/bootstrap?scope=Project%3Ap1&mode=snapshot`);
    assert.equal(response.status, 400);
    assert.deepEqual(logs, [{
      channel: 'live',
      message: 'HTTP live delivery request failed',
      context: {
        path: '/live-delivery/bootstrap',
        mode: 'snapshot',
        scope: 'Project:p1',
        entity: null,
        field: null,
        documentId: null,
        error: 'offset is outside text bounds',
      },
    }]);
    // The sanitized failure now carries the underlying framework error so a
    // client's bootstrap failure is diagnosable (message only, no stack).
    assert.deepEqual(await response.json(), { error: 'live delivery unavailable: offset is outside text bounds' });
  } finally { server.close(); }
});

test('HTTP delivery transports aggregate cursors without widening their shape', async () => {
  const cursor = { anchor: 3, aggregate: 7 };
  const delivery = {
    bootstrap: async () => ({ kind: 'snapshot', snapshot: {}, cursor }),
    catchup: async (input) => { assert.deepEqual(input.after, cursor); return { kind: 'catchup', envelopes: [], cursor }; },
    subscribe: async (input) => { assert.deepEqual(input.after, cursor); return { activate: async () => cursor }; },
  };
  const { server, baseUrl } = await serve(createLiveDeliveryHttpHandler({ delivery, principalOf: () => ({ type: 'user', id: 'u1' }) }));
  const encoded = encodeURIComponent(JSON.stringify(cursor));
  try {
    assert.equal((await fetch(`${baseUrl}/bootstrap?scope=Project%3Ap1&mode=catchup&after=${encoded}`)).status, 200);
    const controller = new AbortController();
    assert.equal((await fetch(`${baseUrl}/events?scope=Project%3Ap1&after=${encoded}`, { signal: controller.signal })).status, 200);
    controller.abort();
  } finally { server.close(); }
});

test('HTTP delivery reports an initial subscription revocation as forbidden', async () => {
  const delivery = {
    bootstrap: async () => ({ kind: 'revoked' }),
    catchup: async () => ({ kind: 'revoked' }),
    subscribe: async ({ revoke }) => { revoke(); return { activate: async () => undefined }; },
  };
  const { server, baseUrl } = await serve(createLiveDeliveryHttpHandler({ delivery, principalOf: () => ({ type: 'user', id: 'u1' }) }));
  try {
    assert.equal((await fetch(`${baseUrl}/events?scope=x&after=0`)).status, 403);
  } finally { server.close(); }
});

test('HTTP SSE terminal revoke ends the response and releases capacity for a second stream', async () => {
  let subscriptions = 0;
  const delivery = {
    bootstrap: async () => ({ kind: 'revoked' }),
    catchup: async () => ({ kind: 'revoked' }),
    subscribe(input) {
      subscriptions += 1;
      return {
        activate: async () => {
          // Terminal error removal: write the frame, then revoke so SSE ends.
          if (input.deliver) await input.deliver([{ type: 'event', seq: 1, event: { type: 'Project.updated', data: { name: 'one' } } }]);
          input.revoke();
          return undefined;
        },
      };
    },
  };
  const handler = createLiveDeliveryHttpHandler({ delivery, principalOf: () => ({ type: 'user', id: 'u1' }), maxSubscriptions: 1 });
  const { server, baseUrl } = await serve(handler);
  try {
    const first = await fetch(`${baseUrl}/events?scope=Project%3Ap1&after=0`);
    assert.equal(first.status, 200);
    const body = await first.text();
    assert.ok(body.includes('Project.updated'), 'the terminal frame was written before the revoke ended the stream');

    // Capacity released: the single reserved slot is reusable by a second stream.
    const second = await fetch(`${baseUrl}/events?scope=Project%3Ap1&after=0`);
    assert.equal(second.status, 200, 'capacity freed by the first revoke is reused, not a 503');
    await second.text();
    assert.equal(subscriptions, 2, 'both streams reached the delivery seam');
  } finally { server.close(); }
});

test('HTTP session delegates duplicate, gap and opaque resync recovery to the package session', async () => {
  const requests = [];
  const sources = [];
  const session = createLiveDeliveryHttpSession({
    baseUrl: 'https://example.test/live-delivery', scope: 'Project:p1',
    fetchImpl: async (url) => {
      requests.push(url);
      const parsed = new URL(url);
      const mode = parsed.searchParams.get('mode');
      return { ok: true, json: async () => mode === 'catchup'
        ? { kind: 'catchup', envelopes: [{ type: 'event', seq: 2, event: { type: 'update', data: 2 } }], cursor: 2 }
        : { kind: 'snapshot', snapshot: { values: mode === 'snapshot' && requests.length > 2 ? ['fresh'] : [] }, cursor: requests.length > 2 ? 4 : 1 } };
    },
    eventSourceFactory: (url) => {
      const source = { url, close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
    validateSnapshot: (value) => value,
    fold: (snapshot, envelope) => ({ values: [...snapshot.values, envelope.event.data] }),
    sendAction: async () => ({ ok: true }),
    historySession: 'tab-a',
  });
  await session.ready;
  sources[0].onmessage({ data: JSON.stringify([{ type: 'event', seq: 3, event: { type: 'update', data: 3 } }]) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(session.snapshot, { values: [2, 3] });
  sources[0].onmessage({ data: JSON.stringify([{ type: 'resync', seq: 4, reason: 'opaque' }]) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(session.snapshot, { values: ['fresh'] });
  assert.ok(requests.some((url) => new URL(url).searchParams.get('mode') === 'catchup'));
  session.close();
});

test('HTTP action classifies malformed rejection as rolled back and malformed success as outcome unknown', async () => {
  for (const [status, expected] of [[403, 'failed-rolled-back'], [200, 'outcome-unknown']]) {
    let requests = 0;
    const session = createLiveDeliveryHttpSession({
      baseUrl: 'https://example.test/live-delivery', scope: 'Project:p1',
      fetchImpl: async (_url, options) => {
        if (!options?.method) return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: {}, cursor: 1 }) };
        requests += 1;
        return { ok: status < 400, status, json: async () => { throw new SyntaxError('not json'); } };
      },
      eventSourceFactory: () => ({ close() {} }), validateSnapshot: (value) => value,
      optimistic: (snapshot) => ({ ...snapshot, pending: true }), historySession: 'tab-a',
      createActionId: () => `action-${status}`,
    });
    await session.ready;
    const result = await session.dispatch('Project.rename', {});
    assert.equal(result.status, expected);
    assert.equal(session.pendingCount(), status === 200 ? 1 : 0);
    assert.equal(requests, 1);
    session.close();
  }
});

test('HTTP session retries an unstable aggregate bootstrap until it receives a paired snapshot', async () => {
  let attempts = 0;
  const session = createLiveDeliveryHttpSession({
    baseUrl: 'https://example.test/live-delivery', scope: 'Project:p1',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ++attempts === 1
        ? { kind: 'retry' }
        : { kind: 'snapshot', snapshot: { id: 'p1' }, cursor: { anchor: 1, aggregate: 2 } },
    }),
    eventSourceFactory: () => ({ close() {} }),
    validateSnapshot: (value) => value,
    sendAction: async () => ({ ok: true }),
    historySession: 'tab-a',
  });

  await session.ready;
  assert.equal(attempts, 2);
  assert.equal(session.status, 'live');
  assert.deepEqual(session.snapshot, { id: 'p1' });
  session.close();
});

test('HTTP session retries transient initial bootstrap transport failures without becoming unavailable', async () => {
  for (const failure of [new TypeError('network reset'), { ok: false, status: 503 }]) {
    let attempts = 0;
    const session = createLiveDeliveryHttpSession({
      baseUrl: 'https://example.test/live-delivery', scope: 'Project:p1',
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          if (failure instanceof Error) throw failure;
          return failure;
        }
        return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { id: 'p1' }, cursor: 1 }) };
      },
      eventSourceFactory: () => ({ close() {} }),
      validateSnapshot: (value) => value,
      sendAction: async () => ({ ok: true }),
      historySession: 'tab-a',
    });

    await session.ready;
    assert.equal(attempts, 2);
    assert.equal(session.status, 'live');
    assert.deepEqual(session.snapshot, { id: 'p1' });
    session.close();
  }
});

test('HTTP session waits to send until transient reconnect recovery restores its stream', async () => {
  const sources = [];
  let bootstrapAttempts = 0;
  let sends = 0;
  const session = createLiveDeliveryHttpSession({
    baseUrl: 'https://example.test/live-delivery', scope: 'Project:p1',
    fetchImpl: async () => {
      bootstrapAttempts += 1;
      if (bootstrapAttempts === 1) {
        return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { id: 'p1' }, cursor: 1 }) };
      }
      if (bootstrapAttempts < 4) return { ok: false, status: 503 };
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { id: 'p1' }, cursor: 1 }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
    validateSnapshot: (value) => value,
    fold: (snapshot) => snapshot,
    optimistic: (snapshot) => ({ ...snapshot, pending: true }),
    sendAction: async () => { sends += 1; return { ok: true }; },
    createActionId: () => 'recovered-action',
    historySession: 'tab-a',
  });
  await session.ready;

  sources[0].onerror();
  const dispatch = session.dispatch('Project.rename', { name: 'Recovered' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sends, 0);
  assert.equal(sources.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await dispatch).ok, true);
  assert.equal(sends, 1);
  assert.equal(sources.length, 2);
  assert.equal(session.status, 'live');
  session.close();
});

test('HTTP snapshot-only batch settlement survives a transient replacement snapshot failure', async () => {
  let attempts = 0;
  const session = createLiveDeliveryHttpSession({
    baseUrl: 'https://example.test/live-delivery', scope: 'Project:p1',
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 2) throw new TypeError('connection reset');
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { version: attempts }, cursor: attempts === 1 ? 1 : 2 }) };
    },
    eventSourceFactory: () => ({ close() {} }),
    validateSnapshot: (value) => value,
    optimistic: (snapshot) => ({ ...snapshot, pending: true }),
    sendBatch: async (batch) => ({ ok: true, actionId: batch.actionId, confirmedThrough: 2 }),
    createActionId: () => 'import-operation',
    historySession: 'tab-a',
  });
  await session.ready;

  const dispatched = await session.batch([{ type: 'Artefact.create', payload: { id: 'art-1' } }]);
  assert.equal(dispatched.opId, 'import-operation');
  assert.deepEqual(await dispatched.settlement.wait(), { opId: 'import-operation', status: 'reconciled' });
  assert.equal(attempts, 3);
  assert.equal(session.status, 'live');
  assert.deepEqual(session.snapshot, { version: 3 });
  session.close();
});

test('closing an HTTP session cancels aggregate bootstrap retry backoff', async () => {
  let attempts = 0;
  const session = createLiveDeliveryHttpSession({
    baseUrl: 'https://example.test/live-delivery', scope: 'Project:p1',
    fetchImpl: async () => {
      attempts += 1;
      return { ok: true, status: 200, json: async () => ({ kind: 'retry' }) };
    },
    eventSourceFactory: () => ({ close() {} }),
    validateSnapshot: (value) => value,
    sendAction: async () => ({ ok: true }),
    historySession: 'tab-a',
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  session.close();
  await session.ready;
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(attempts, 1);
  assert.equal(session.status, 'recovering');
});

test('a superseded aggregate bootstrap retry cannot replace newer reconnect recovery', async () => {
  const sources = [];
  let attempts = 0;
  let releaseRetry;
  const retryReturned = new Promise((resolve) => { releaseRetry = resolve; });
  const session = createLiveDeliveryHttpSession({
    baseUrl: 'https://example.test/live-delivery', scope: 'Project:p1',
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { version: 1 }, cursor: { anchor: 1, aggregate: 1 } }) };
      if (attempts === 2) return { ok: true, status: 200, json: async () => { releaseRetry(); return { kind: 'retry' }; } };
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { version: 2 }, cursor: { anchor: 2, aggregate: 2 } }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
    validateSnapshot: (value) => value,
    sendAction: async () => ({ ok: true }),
    historySession: 'tab-a',
  });

  await session.ready;
  sources[0].onmessage({ data: JSON.stringify([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]) });
  await retryReturned;
  await session.reconnect();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(attempts, 3);
  assert.equal(session.status, 'live');
  assert.deepEqual(session.snapshot, { version: 2 });
  session.close();
});

test('HTTP snapshot-only session settles a sender receipt through opaque SSE recovery without exposing action identity', async () => {
  const sources = [];
  let snapshots = 0;
  const session = createLiveDeliveryHttpSession({
    baseUrl: 'https://example.test/live-delivery', scope: 'Project:p1',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      kind: 'snapshot', snapshot: { version: ++snapshots }, cursor: snapshots === 1 ? 1 : 2,
    }) }),
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
    validateSnapshot: (value) => value,
    optimistic: (snapshot) => ({ ...snapshot, pending: true }),
    sendAction: async () => ({ ok: true, actionId: 'private-action-id', confirmedThrough: 2 }),
    createActionId: () => 'private-action-id',
    historySession: 'tab-a',
  });
  await session.ready;
  await session.dispatch('Project.rename', {});
  assert.equal(session.pendingCount(), 1);
  sources[0].onmessage({ data: JSON.stringify([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The receipt itself always requires its own authorized replacement snapshot.
  assert.deepEqual(session.snapshot, { version: 3 });
  assert.equal(session.pendingCount(), 0);
  session.close();
});

test('HTTP session reserves revocation for authorization responses', async () => {
  for (const status of [401, 403]) {
    const session = createLiveDeliveryHttpSession({
      baseUrl: 'https://example.test/live-delivery', scope: 'Project:p1',
      fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }),
      eventSourceFactory: () => ({ close() {} }),
      validateSnapshot: (value) => value,
      fold: (snapshot) => snapshot,
      sendAction: async () => ({ ok: true }),
      historySession: 'tab-a',
    });
    await session.ready;
    assert.equal(session.status, 'revoked');
    session.close();
  }
});

test('HTTP session includes credentials for both bootstrap and SSE', async () => {
  let fetchOptions;
  let sourceOptions;
  const session = createLiveDeliveryHttpSession({
    baseUrl: 'https://live.example.test/live-delivery', scope: 'Project:p1',
    fetchImpl: async (_url, options) => { fetchOptions = options; return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: {}, cursor: 0 }) }; },
    eventSourceFactory: (_url, options) => { sourceOptions = options; return { close() {} }; },
    validateSnapshot: (value) => value,
    fold: (snapshot) => snapshot,
    sendAction: async () => ({ ok: true }),
    historySession: 'tab-a',
  });
  await session.ready;
  assert.equal(fetchOptions.credentials, 'include');
  assert.deepEqual(sourceOptions, { withCredentials: true });
  session.close();
});
