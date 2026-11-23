import assert from 'node:assert/strict';
import test from 'node:test';

import { annotatedText, annotation, entity, measurement, ref, registerAnnotatedTextContract } from '../build/index.mjs';
import { registerAnnotatedTextStructuralExtension } from '../build/internal.mjs';
import { createAnnotatedTextHttpSession, materializeAnnotatedTextSnapshot } from '../public/workbench-client.mjs';

registerAnnotatedTextContract('liveSessionMeasurement', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('liveSessionMeasurement', Object.freeze({
  version: 1, validate() {}, edit() {}, partition() {}, combine() {},
}));
const Document = entity('LiveDocument', {
  project: ref('Project'), owner: ref('User'), body: annotatedText({
    project: 'project', owner: 'owner', annotations: [annotation('note', { fields: {} })],
    measurements: [measurement('words', { extension: 'liveSessionMeasurement' })],
  }),
});

const BLOCK_ERA_METHODS = [
  'split', 'merge', 'detachAnnotation', 'continueBlock',
  'setBlockGroupAssignment', 'clearBlockGroupAssignment', 'splitAndAssign',
];

function snapshot(text = 'Hello') {
  return {
    body: {
      kind: 'workbench.annotatedText.recipient', version: 1,
      text,
      ranges: [],
      annotations: [],
      orphans: [],
      measurements: [],
    },
  };
}

function token(label) {
  return `${label}${'x'.repeat(43)}`.slice(0, 43);
}

function authoringEnvelope(cursor, family = null) {
  return {
    version: 1, stream: token('stream'), lease: token('lease'), snapshot: token(`snapshot${cursor}`), acknowledgementFence: cursor,
    positionFrames: [{ positionToken: token(`position${cursor}`) }],
    ...(family ? { family } : {}),
  };
}

function authoringClientFrom(url) {
  return new URL(url).searchParams.get('authoringClient');
}

function setup({ revoked = false } = {}) {
  const requests = [];
  const sources = [];
  let number = 0;
  let accessRevoked = revoked;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: 1 }) };
        requests.push(JSON.parse(options.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-1', confirmedThrough: 2 }) };
      }
      if (accessRevoked) return { ok: false, status: 403, json: async () => ({}) };
      const cursor = ++number;
      const body = snapshot();
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body: body.body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  return { session, requests, sources, revokeAccess: () => { accessRevoked = true; } };
}

test('document session bootstraps recipient snapshot and derives typed insert from its opaque token', async () => {
  const { session, requests } = setup();
  await session.ready;
  assert.equal(session.document.version, 1);
  assert.equal(session.document.text, 'Hello');
  assert.equal((await session.insert({ mutationId: 'm1', at: { offset: 1, affinity: 'right' }, text: 'x' })).ok, true);
  const actionBody = requests[0];
  assert.equal(actionBody.type, 'LiveDocument.body.operation');
  assert.deepEqual(actionBody.payload, {
    version: 9, id: 'd1',
    authoring: { version: 1, stream: token('stream'), lease: token('lease'), mutationId: 'm1' },
    edit: { kind: 'text.insert', at: { positionToken: token('position1'), offset: 1, affinity: 'right' }, text: 'x' },
  });
  session.close();
});

test('document session forwards its optimistic pending count to the host surface (#228)', async () => {
  const pendingResponses = [];
  let cursor = 0;
  const session = createAnnotatedTextHttpSession({
    typingBurstIdleMs: 0,
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'pending-count' },
    historySession: 'tab-a', createActionId: () => 'action-pending',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: cursor }) };
        return new Promise((resolve) => pendingResponses.push(resolve));
      }
      cursor += 1;
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: snapshot(), cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  // Declared on AnnotatedTextHttpSession in client.d.ts; hosts fence document
  // history on it (Scope #3126). It must exist at runtime, not only in types.
  assert.equal(typeof session.pendingCount, 'function');
  assert.equal(session.pendingCount(), 0);
  const insert = session.insert({ mutationId: 'm1', at: { offset: 5, affinity: 'right' }, text: '!' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.pendingCount(), 1, 'the in-flight optimistic insert is visible to the host');
  pendingResponses.shift()({ ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-pending', confirmedThrough: 1 }) });
  await insert;
  // The receipt without an echo still snapshot-recovers; wait for the covering
  // snapshot before asserting the counter drained.
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.pendingCount(), 0);
  session.close();
});

test('an applied sensitive annotation settles into document.ranges from its authoritative state echo (#234)', async () => {
  const SensitiveDocument = entity('SensitiveLiveDocument', {
    project: ref('Project'), owner: ref('User'),
    body: annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('note', { fields: {} }), annotation('sensitive', { fields: {} })],
    }),
  });
  const sensitiveId = 'sensitive-1';
  const sources = [];
  let number = 0;
  let actionNumber = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: SensitiveDocument, field: SensitiveDocument.body, documentId: 'd-sensitive' },
    historySession: 'tab-a', createActionId: () => `sensitive-${++actionNumber}`,
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        const body = JSON.parse(options.body);
        const confirmedThrough = number;
        return { ok: true, status: 200, json: async () => ({ ok: true, actionId: body.actionId, confirmedThrough }) };
      }
      const cursor = ++number;
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: snapshot(), cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  const pending = session.applyAnnotation({
    mutationId: 'sensitive-m',
    annotation: { id: sensitiveId, family: 'sensitive', fields: {} },
    from: { offset: 0, affinity: 'left' },
    to: { offset: 5, affinity: 'right' },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The optimistic placeholder is visible before the authoritative echo.
  assert.deepEqual(session.document.ranges, [{ annotationId: sensitiveId, start: 0, end: 5 }]);
  // `annotation.apply-range` does not fold (no text change): the live `state`
  // replacement is its one reconciliation path. Deliver the owner's authorized
  // snapshot carrying the sensitive span.
  sources[0].onmessage({ data: JSON.stringify([{
    type: 'state', entity: 'LiveDocument', id: 'd-sensitive', seq: 2,
    state: {
      body: {
        ...snapshot().body,
        ranges: [{ annotationId: sensitiveId, start: 0, end: 5 }],
        annotations: [{ id: sensitiveId, family: 'sensitive', fields: {} }],
      },
    },
    authoring: authoringEnvelope(2),
  }]) });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(await result.settlement.wait(), { opId: result.opId, status: 'reconciled' });
  // Exactly the assertion the confidential-span browser journey makes after
  // settlement: the span must have settled into a visible range.
  const settled = (session.document?.ranges ?? []).find((range) => range.annotationId === sensitiveId);
  assert.ok(settled, 'applied sensitive span must settle into session.document.ranges');
  assert.deepEqual(settled, { annotationId: sensitiveId, start: 0, end: 5 });
  session.close();
});

test('document session reuses its tab-scoped authoring client across reloads', async (t) => {
  const previous = globalThis.sessionStorage;
  const values = new Map();
  globalThis.sessionStorage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previous;
  });
  const clients = [];
  for (let reload = 0; reload < 17; reload += 1) {
    const session = createAnnotatedTextHttpSession({
      baseUrl: reload % 2 === 0 ? 'https://example.test/live-delivery' : 'https://example.test/live-delivery/',
      context: { entity: Document, field: Document.body, documentId: 'reloaded' },
      historySession: 'tab-a', createActionId: () => `reload-${reload}`,
      fetchImpl: async (url, options) => {
        if (options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
        clients.push(authoringClientFrom(url));
        return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: snapshot(), cursor: 1, authoring: authoringEnvelope(1) }) };
      },
      eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
    });
    await session.ready;
    session.close();
  }
  assert.equal(new Set(clients).size, 1);
  assert.match(clients[0], /^[A-Za-z0-9_-]{43}$/);
});

test('document session replaces a malformed stored authoring client', async (t) => {
  const previous = globalThis.sessionStorage;
  let stored = 'not-a-valid-authoring-client';
  globalThis.sessionStorage = {
    getItem() { return stored; },
    setItem(_key, value) { stored = value; },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previous;
  });
  let requested;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'malformed-storage' },
    historySession: 'tab-a', createActionId: () => 'malformed-storage',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
      requested = authoringClientFrom(url);
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: snapshot(), cursor: 1, authoring: authoringEnvelope(1) }) };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  assert.match(requested, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(stored, requested);
  session.close();
});

test('document session bootstraps when authoring client storage is unavailable', async (t) => {
  const previous = globalThis.sessionStorage;
  globalThis.sessionStorage = {
    getItem() { throw new Error('storage denied'); },
    setItem() { throw new Error('storage denied'); },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previous;
  });
  let requested;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'storage-denied' },
    historySession: 'tab-a', createActionId: () => 'storage-denied',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
      requested = authoringClientFrom(url);
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: snapshot(), cursor: 1, authoring: authoringEnvelope(1) }) };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  assert.match(requested, /^[A-Za-z0-9_-]{43}$/);
  session.close();
});

test('document session owns mutation identity and sends selection replacement as one action', async () => {
  const { session, requests } = setup();
  await session.ready;
  await session.insert({ at: { offset: 1, affinity: 'right' }, text: 'x' });
  assert.match(requests[0].payload.authoring.mutationId, /^[A-Za-z0-9_-]{43}$/);
  session.close();

  const batchRequests = [];
  let cursor = 0;
  const replacement = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'replace-action',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: cursor }) };
        const body = JSON.parse(options.body);
        batchRequests.push(body);
        return { ok: true, status: 200, json: async () => ({ ok: true, actionId: body.actionId, confirmedThrough: cursor }) };
      }
      cursor += 1;
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: snapshot(), cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await replacement.ready;
  await replacement.replace({
    mutationId: 'replace-1', from: { offset: 1, affinity: 'right' },
    to: { offset: 4, affinity: 'right' }, text: 'i',
  });
  assert.equal(batchRequests.length, 1);
  const replacementRequest = batchRequests[0];
  assert.equal(replacementRequest.payload.edit.kind, 'text.replace');
  replacement.close();
});

test('document session confirms through authorized replacement and refreshes its token after opaque recovery', async () => {
  const { session, requests, sources } = setup();
  await session.ready;
  await session.insert({ mutationId: 'm1', at: { offset: 0, affinity: 'right' }, text: 'x' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.document.version, 1);
  await session.delete({ mutationId: 'm2', from: { offset: 0, affinity: 'right' }, to: { offset: 1, affinity: 'right' } });
  assert.equal(requests[1].payload.version, 9);
  sources[0].onmessage({ data: JSON.stringify([{ type: 'resync', seq: 3, reason: 'opaque' }]) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.document.version, 1);
  session.close();
});

test('document session fails closed on revoked bootstrap and exposes no raw dispatch method', async () => {
  const { session } = setup({ revoked: true });
  await session.ready;
  assert.equal(session.status, 'revoked');
  assert.equal(session.document, null);
  assert.equal('dispatch' in session, false);
  session.close();
});

test('document session fails closed on block-era commands and still sends v9 annotation without basis or frontier', async () => {
  const { session, requests } = setup();
  await session.ready;
  for (const name of BLOCK_ERA_METHODS) {
    assert.equal(typeof session[name], 'undefined', `block-era ${name} must not exist on the session`);
  }
  const applied = session.applyAnnotation({
    mutationId: 'ann-1',
    annotation: { id: 'a1', family: 'note', fields: {} },
    from: { offset: 0, affinity: 'right' },
    to: { offset: 2, affinity: 'right' },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(requests.length, 1);
  for (const request of requests) {
    assert.equal(request.payload.version, 9);
    assert.equal('basis' in request.payload, false);
    assert.equal('expected' in request.payload, false);
    assert.equal(JSON.stringify(request).includes('frontier'), false);
  }
  const appliedResult = await applied;
  assert.equal(appliedResult.ok, true);
  assert.equal(appliedResult.settlement.opId, appliedResult.opId, 'the annotation result must expose its settlement under the result opId');
  assert.deepEqual(await appliedResult.settlement.wait(), { opId: 'action-1', status: 'reconciled' });
  session.close();
});

test('document session exposes no block-group or structural block-era methods', async () => {
  const { session } = setup();
  await session.ready;
  for (const name of ['continueBlock', 'setBlockGroupAssignment', 'clearBlockGroupAssignment', 'splitAndAssign']) {
    assert.equal(typeof session[name], 'undefined', `block-era ${name} must not exist on the session`);
  }
  session.close();
});

function v9Setup() {
  const actionRequests = [];
  const ackRequests = [];
  const snapshotRequests = [];
  const sources = [];
  let number = 0;
  let actionNumber = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => `action-${++actionNumber}`,
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) {
          ackRequests.push(JSON.parse(options.body));
          return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        }
        const body = JSON.parse(options.body);
        if (body.payload) actionRequests.push(body);
        return { ok: true, status: 200, json: async () => ({ ok: true, actionId: body.actionId, confirmedThrough: number }) };
      }
      const cursor = ++number;
      const body = snapshot().body;
      snapshotRequests.push({ cursor });
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  return { session, actionRequests, ackRequests, snapshotRequests, sources };
}

test('session sends token-only v9 actions without basis or block identifiers', async () => {
  const { session, actionRequests } = v9Setup();
  await session.ready;
  await session.insert({ mutationId: 'm1', at: { offset: 2, affinity: 'right' }, text: 'XY' });
  const payload = actionRequests[0].payload;
  assert.equal(payload.version, 9);
  assert.equal('basis' in payload, false);
  assert.equal('expected' in payload, false);
  assert.equal(JSON.stringify(payload).includes('frontier'), false);
  assert.equal(JSON.stringify(payload).includes('blockId'), false);
  assert.deepEqual(payload.edit.at, { positionToken: token('position1'), offset: 2, affinity: 'right' });
  session.close();
});

test('session exposes no public merge or detach block-era methods', async () => {
  const merge = v9Setup();
  await merge.session.ready;
  assert.equal(typeof merge.session.merge, 'undefined', 'block-era merge must not exist on the session');
  assert.equal(merge.actionRequests.length, 0);
  merge.session.close();

  const detach = v9Setup();
  await detach.session.ready;
  assert.equal(typeof detach.session.detachAnnotation, 'undefined', 'block-era detachAnnotation must not exist on the session');
  assert.equal(detach.actionRequests.length, 0);
  detach.session.close();
});

test('positive receipt without fold echo falls back to covering snapshot and authoring ack', async () => {
  const { session, actionRequests, ackRequests, snapshotRequests } = v9Setup();
  await session.ready;
  const result = await session.insert({ mutationId: 'm1', at: { offset: 0, affinity: 'right' }, text: 'x' });
  assert.equal(result.ok, true);
  assert.equal(actionRequests.length, 1);
  // Mock SSE never delivers a fold envelope, so receipt recovery still covers.
  assert.equal(snapshotRequests.length, 2, 'should fetch covering snapshot after receipt without echo');
  assert.ok(ackRequests.length >= 2, `expected at least 2 acks, got ${ackRequests.length}`);
  assert.equal(ackRequests[0].version, 1);
  assert.equal(ackRequests[0].stream, token('stream'));
  assert.equal(ackRequests[0].lease, token('lease'));
  assert.ok(ackRequests[0].snapshot);
  session.close();
});

test('annotation receipt settles from an in-grace state echo without snapshot recovery', async () => {
  const { session, snapshotRequests, sources } = v9Setup();
  await session.ready;
  const pending = session.applyAnnotation({
    mutationId: 'annotation-echo',
    annotation: { id: 'a1', family: 'note', fields: {} },
    from: { offset: 0, affinity: 'left' },
    to: { offset: 5, affinity: 'right' },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  sources[0].onmessage({ data: JSON.stringify([{
    type: 'state', entity: 'LiveDocument', id: 'd1', seq: 2,
    state: {
      body: {
        ...snapshot().body,
        ranges: [{ annotationId: 'a1', start: 0, end: 5 }],
        annotations: [{ id: 'a1', family: 'note', fields: {} }],
      },
    },
    authoring: authoringEnvelope(2),
  }]) });

  const result = await pending;
  assert.deepEqual(await result.settlement.wait(), { opId: result.opId, status: 'reconciled' });
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(snapshotRequests.length, 1, 'the authoritative state echo cancels receipt recovery');
  assert.equal(session.document.annotations[0].id, 'a1');
  session.close();
});

test('annotation receipt without an echo still snapshot-recovers after the grace window', async () => {
  const { session, snapshotRequests } = v9Setup();
  await session.ready;
  const result = await session.applyAnnotation({
    mutationId: 'annotation-stall',
    annotation: { id: 'a1', family: 'note', fields: {} },
    from: { offset: 0, affinity: 'left' },
    to: { offset: 5, affinity: 'right' },
  });
  assert.deepEqual(await result.settlement.wait(), { opId: result.opId, status: 'reconciled' });
  assert.equal(snapshotRequests.length, 2, 'the stalled echo fails closed through a covering snapshot');
  session.close();
});

test('annotation removal is visible before its receipt and authoritative snapshot settle', async () => {
  const actionRequests = [];
  const snapshotRequests = [];
  const sources = [];
  let cursor = 0;
  let removed = false;
  let releaseReceipt;
  const receiptGate = new Promise((resolve) => { releaseReceipt = resolve; });
  const session = createAnnotatedTextHttpSession({
    typingBurstIdleMs: 0,
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'remove-action',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: cursor }) };
        actionRequests.push(JSON.parse(options.body));
        await receiptGate;
        removed = true;
        return { ok: true, status: 200, json: async () => ({ ok: true, actionId: 'remove-action', confirmedThrough: cursor + 1 }) };
      }
      cursor += 1;
      snapshotRequests.push(cursor);
      const body = {
        ...snapshot().body,
        ...(removed ? { ranges: [], annotations: [] } : {
          ranges: [{ annotationId: 'a1', start: 0, end: 5 }],
          annotations: [{ id: 'a1', family: 'note', fields: {} }],
        }),
      };
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  assert.deepEqual(session.document.ranges, [{ annotationId: 'a1', start: 0, end: 5 }]);

  const pending = session.removeAnnotation({ mutationId: 'remove-1', annotationId: 'a1' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(actionRequests.length, 1);
  assert.deepEqual(session.document.ranges, [], 'the pending removal must clear its visible range immediately');
  assert.deepEqual(session.document.annotations, [], 'the pending removal must clear its visible chip immediately');

  releaseReceipt();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.settlement.opId, result.opId, 'the removal result must expose its settlement under the result opId');
  assert.deepEqual(await result.settlement.wait(), { opId: result.opId, status: 'reconciled' });
  assert.deepEqual(session.document.ranges, []);
  assert.deepEqual(session.document.annotations, []);
  assert.equal(snapshotRequests.length, 2, 'the non-foldable annotation action still settles through an authoritative snapshot');
  session.close();
});

test('dependent text waits for settlement and reports a local conflict when its captured basis is not recovered', async () => {
  const actionRequests = [];
  const pendingResponses = [];
  let cursor = 0;
  let actionNumber = 0;
  const session = createAnnotatedTextHttpSession({
    typingBurstIdleMs: 0,
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => `action-${++actionNumber}`,
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: cursor }) };
        const request = JSON.parse(options.body); actionRequests.push(request);
        return new Promise((resolve) => pendingResponses.push(resolve));
      }
      cursor += 1;
      const body = snapshot().body;
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  const a = session.insert({ mutationId: 'a', at: { offset: 5, affinity: 'right' }, text: 'A' });
  const b = session.insert({ mutationId: 'b', at: { offset: 6, affinity: 'right' }, text: 'B' });
  assert.equal(session.document.text, 'HelloAB', 'all queued text is visible immediately');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(actionRequests.length, 1, 'second text action waits for first transport');
  pendingResponses.shift()({ ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-1', confirmedThrough: 1 }) });
  await a;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(actionRequests.length, 1, 'a mismatched recovery must not send B against the old token');
  assert.equal((await b).ok, false);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(session.document.text, 'Hello', 'authoritative replacement removes confirmed placeholders');
  const failed = session.insert({ mutationId: 'bad', at: { offset: 5, affinity: 'right' }, text: 'X' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.document.text, 'HelloX');
  pendingResponses.shift()({ ok: false, status: 400, json: async () => ({ ok: false, failure: { message: 'rejected' } }) });
  assert.equal((await failed).ok, false);
  assert.equal(session.document.text, 'Hello');
  session.close();
});

test('queued action waits for settlement and translates through the replacement token', async () => {
  const actionRequests = [];
  const ackRequests = [];
  const pendingResponses = [];
  let cursor = 0;
  let actionNumber = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => `action-${++actionNumber}`,
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) {
          ackRequests.push(JSON.parse(options.body));
          return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: cursor }) };
        }
        const request = JSON.parse(options.body); actionRequests.push(request);
        return new Promise((resolve) => pendingResponses.push(resolve));
      }
      cursor += 1;
      const text = cursor === 1 ? 'Hello' : cursor === 2 ? 'HelloA' : 'HelloAB';
      const body = { ...snapshot().body, text };
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  const a = session.insert({ mutationId: 'a', at: { offset: 5, affinity: 'right' }, text: 'A' });
  const b = session.insert({ mutationId: 'b', at: { offset: 6, affinity: 'right' }, text: 'B' });
  assert.equal(session.document.text, 'HelloAB', 'the queued dependent edit is already projected');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(actionRequests.length, 1, 'second text action waits for first transport');
  const aAction = actionRequests[0];
  pendingResponses.shift()({ ok: true, status: 200, json: async () => ({ ok: true, actionId: aAction.actionId, confirmedThrough: 1 }) });
  await a;
  await new Promise((resolve) => setTimeout(resolve, 0));
  // A's settlement installs a replacement snapshot and re-issues its token.
  // B is translated only after that binding is live.
  assert.equal(actionRequests.length, 2, 'B dispatches after A settles');
  assert.equal(actionRequests[0].payload.authoring.mutationId, 'a');
  assert.equal(actionRequests[1].payload.authoring.mutationId, 'b', 'caller mutation identities are never coalesced');
  assert.equal(actionRequests[1].payload.edit.at.positionToken, token('position2'), 'B uses the replacement token');
  assert.equal(session.document.text, 'HelloAB', 'B stays projected though its position token was replaced');
  assert.equal(ackRequests.some((request) => request.snapshot === token('snapshot2')), true,
    'the recovered authoring fence may be acknowledged before B is translated');
  pendingResponses.shift()({ ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-2', confirmedThrough: 1 }) });
  await b;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(session.document.text, 'HelloAB', 'authoritative replacement clears B without duplicating A');
  assert.equal(ackRequests.some((request) => request.snapshot === token('snapshot2')), true,
    'covering snapshot is acknowledged after every predecessor-token action is terminal');
  assert.ok(ackRequests.length >= 2);
  session.close();
});

test('rapid dependent inserts project immediately and commit as one bounded typing burst', async () => {
  const actionRequests = [];
  const pendingResponses = [];
  let cursor = 0;
  let actionNumber = 0;
  const texts = ['Hello', 'HelloXAB'];
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => `rapid-${++actionNumber}`,
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: cursor }) };
        const request = JSON.parse(options.body);
        actionRequests.push(request);
        return new Promise((resolve) => pendingResponses.push(resolve));
      }
      cursor += 1;
      const body = { ...snapshot().body, text: texts[Math.min(cursor - 1, texts.length - 1)] };
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;

  const x = session.insert({ at: { offset: 5, affinity: 'right' }, text: 'X' });
  const a = session.insert({ at: { offset: 6, affinity: 'right' }, text: 'A' });
  const b = session.insert({ at: { offset: 7, affinity: 'right' }, text: 'B' });
  assert.equal(session.document.text, 'HelloXAB', 'rapid queued input is visible before transport settlement');

  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(actionRequests.length, 1, 'the contiguous typing burst uses one authoring action');
  assert.equal(actionRequests[0].payload.edit.text, 'XAB');
  pendingResponses.shift()({ ok: true, status: 200, json: async () => ({ ok: true, actionId: actionRequests[0].actionId, confirmedThrough: cursor }) });
  for (const result of await Promise.all([x, a, b])) assert.equal(result.ok, true, result.failure?.message);
  assert.equal(session.document.text, 'HelloXAB');
  session.close();
});

test('rapid queued text projects annotation ranges over the same optimistic document', async () => {
  const pendingResponses = [];
  let cursor = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'range-burst',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: cursor }) };
        return new Promise((resolve) => pendingResponses.push(resolve));
      }
      cursor += 1;
      const body = {
        ...snapshot().body,
        ranges: [
          { annotationId: 'speaker-1', start: 0, end: 2 },
          { annotationId: 'speaker-2', start: 2, end: 5 },
        ],
        annotations: [
          { id: 'speaker-1', family: 'note', fields: {} },
          { id: 'speaker-2', family: 'note', fields: {} },
        ],
      };
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;

  const x = session.insert({ at: { offset: 1, affinity: 'right' }, text: 'X' });
  const a = session.insert({ at: { offset: 2, affinity: 'right' }, text: 'A' });
  const b = session.insert({ at: { offset: 3, affinity: 'right' }, text: 'B' });
  assert.equal(session.document.text, 'HXABello');
  assert.deepEqual(session.document.ranges, [
    { annotationId: 'speaker-1', start: 0, end: 5 },
    { annotationId: 'speaker-2', start: 5, end: 8 },
  ]);

  session.close();
  for (const result of await Promise.all([x, a, b])) assert.equal(result.ok, false);
});

test('close settles and cancels an unsent typing burst', async () => {
  const { session, requests } = setup();
  await session.ready;
  const pending = session.insert({ at: { offset: 5, affinity: 'right' }, text: 'X' });
  assert.equal(session.document.text, 'HelloX');
  session.close();

  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.failure.message, /unavailable/);
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(requests.length, 0, 'closing during the idle window never dispatches the cancelled burst');
});

test('known rejection releases deferred authoring acknowledgement', async () => {
  const actionResponses = [];
  const ackRequests = [];
  let cursor = 0;
  const session = createAnnotatedTextHttpSession({
    typingBurstIdleMs: 0,
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) {
          ackRequests.push(JSON.parse(options.body));
          return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: cursor }) };
        }
        return new Promise((resolve) => actionResponses.push(resolve));
      }
      cursor += 1;
      return { ok: true, status: 200, json: async () => ({
        kind: 'snapshot', snapshot: snapshot(), cursor, authoring: authoringEnvelope(cursor),
      }) };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  const pending = session.insert({ mutationId: 'bad', at: { offset: 1, affinity: 'right' }, text: 'X' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Model a replacement arriving while the translated action is still in flight.
  const sourceSnapshot = authoringEnvelope(2);
  // Receipt recovery normally installs this snapshot; invoking reconnect gives
  // the same public ingest/ack path without accepting the action.
  void session.reconnect();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ackRequests.some((request) => request.snapshot === sourceSnapshot.snapshot), false);
  actionResponses.shift()({ ok: false, status: 400, json: async () => ({ ok: false, failure: { message: 'rejected' } }) });
  assert.equal((await pending).ok, false);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ackRequests.some((request) => request.snapshot === sourceSnapshot.snapshot), true);
  session.close();
});

test('stale position-token-unavailable surfaces without basis retry', async () => {
  const actionRequests = [];
  const sources = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: 1 }) };
        const body = JSON.parse(options.body);
        if (body.payload) actionRequests.push(body);
        return { ok: false, status: 400, json: async () => ({
          ok: false, failure: { category: 'invalid-input', message: 'token is unavailable', details: { code: 'position-token-unavailable' } },
        }) };
      }
      const cursor = ++number;
      const body = snapshot().body;
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  const result = await session.insert({ mutationId: 'm1', at: { offset: 1, affinity: 'right' }, text: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.failure?.details?.code, 'position-token-unavailable');
  assert.equal(actionRequests.length, 1, 'no retry on stale token');
  session.close();
});

test('receipt covering snapshot acknowledgement fence is validated on ingest', async () => {
  const sources = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return { ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-1', confirmedThrough: 2 }) };
      }
      const cursor = ++number;
      const body = snapshot().body;
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: { ...authoringEnvelope(cursor), acknowledgementFence: cursor === 1 ? 999 : cursor } }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  try {
    await session.ready;
    assert.fail('should have rejected on bootstrap');
  } catch {
    assert.equal(session.status, 'unavailable', 'bootstrap fails when authoring fence mismatches cursor');
  }
  session.close();
});

test('recovery clears snapshot binding and re-ingests from fresh snapshot', async () => {
  const { session, sources, ackRequests } = v9Setup();
  await session.ready;
  const pre = session.document;
  assert.ok(pre);
  sources[0].onmessage({ data: JSON.stringify([{ type: 'resync', seq: 3, reason: 'opaque' }]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const post = session.document;
  assert.equal(post.version, 1);
  // ack should fire again after recovery installs the new snapshot
  assert.ok(ackRequests.length >= 2);
  session.close();
});

test('dispatch fails closed after revoke and close', async () => {
  const { session } = v9Setup();
  await session.ready;
  session.close();
  try {
    await session.insert({ mutationId: 'm1', at: { offset: 0, affinity: 'right' }, text: 'x' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err);
  }
  assert.equal('dispatch' in session, false);
});

test('own-echo fold installs text without a second bootstrap snapshot', async () => {
  const { createTextState, applyTextOp, textCheckpoint } = await import('../build/annotated-text.mjs');
  const { createTextFamily, applyTextOperation, textFamilyCheckpoint, materializeText } = await import('../build/annotated-text-continuous.mjs');
  const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const insertOp = ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'Hello']];
  const baseFamily = createTextFamily('d1', textCheckpoint(applyTextOp(createTextState(), insertOp)));
  const nextOp = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ['element', [[A, 1], 4]], 'x']];
  const nextFamily = applyTextOperation(baseFamily, nextOp);
  const nextText = materializeText(nextFamily);

  const snapshotRequests = [];
  const ackRequests = [];
  const foldTimings = [];
  let number = 0;
  let actionNumber = 0;
  const sources = [];
  let releaseReceipt;
  const receiptGate = new Promise((resolve) => { releaseReceipt = resolve; });
  const session = createAnnotatedTextHttpSession({
    typingBurstIdleMs: 0,
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => `action-${++actionNumber}`,
    onFoldApplied: (fold, elapsedMs) => foldTimings.push({ kind: fold.kind, elapsedMs }),
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) {
          ackRequests.push(JSON.parse(options.body));
          return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        }
        const body = JSON.parse(options.body);
        await receiptGate;
        return { ok: true, status: 200, json: async () => ({ ok: true, actionId: body.actionId, confirmedThrough: 2 }) };
      }
      const cursor = ++number;
      snapshotRequests.push({ cursor });
      const body = {
        ...snapshot().body,
        text: cursor === 1 ? 'Hello' : nextText,
      };
      const seed = cursor === 1 ? textFamilyCheckpoint(baseFamily) : textFamilyCheckpoint(nextFamily);
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor, seed) }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  assert.equal(snapshotRequests.length, 1);
  assert.equal(session.document.text, 'Hello');

  const inserted = session.insert({ mutationId: 'm1', at: { offset: 5, affinity: 'right' }, text: 'x' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const actionId = 'action-1';
  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 2, seqSpan: [2, 2],
    event: { type: 'LiveDocument.body.operated', scope: 'Project:p1', seq: 2, actionId },
    fold: {
      kind: 'annotatedText', version: 5, field: 'body', baseCursor: 1, fence: 2,
      text: { reducer: 'workbench.text', operations: [nextOp] },
      projection: { text: nextText },
      dispositions: [],
      familyElementCount: Object.keys(textFamilyCheckpoint(nextFamily).checkpoint.elements).length,
      authoring: {
        acknowledgementFence: 2,
        stream: token('stream'), lease: token('lease'), snapshot: token('snapshot2'),
        positionFrames: [{ positionToken: token('position2') }],
      },
    },
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseReceipt();
  const result = await inserted;
  assert.equal(result.ok, true);
  assert.equal((await result.settlement.wait()).status, 'reconciled');
  assert.equal(session.document.text, nextText);
  assert.equal(snapshotRequests.length, 1, 'fold must not force a covering snapshot');
  assert.ok(ackRequests.some((request) => request.snapshot === token('snapshot2')), 'fold authoring is acknowledged');
  assert.equal(foldTimings.length, 1, 'onFoldApplied must fire once for the folded edit');
  assert.equal(foldTimings[0].kind, 'annotatedText');
  assert.ok(Number.isFinite(foldTimings[0].elapsedMs) && foldTimings[0].elapsedMs >= 0);
  session.close();
});

test('own-echo fold does not double-apply a pending insert or reject a queued successor', async () => {
  const { createTextState, applyTextOp, textCheckpoint } = await import('../build/annotated-text.mjs');
  const { createTextFamily, applyTextOperation, textFamilyCheckpoint, materializeText, textOperationForOffsetEdit } = await import('../build/annotated-text-continuous.mjs');
  const A = 'a'.repeat(32);
  const actorA = 'b'.repeat(32);
  const actorB = 'c'.repeat(32);
  const insertOp = ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'Hello']];
  const baseFamily = createTextFamily('d1', textCheckpoint(applyTextOp(createTextState(), insertOp)));
  const insertA = textOperationForOffsetEdit(baseFamily, { kind: 'text.insert', at: { offset: 5 }, text: 'A' }, actorA, 2);
  const familyA = applyTextOperation(baseFamily, insertA);
  const textA = materializeText(familyA);
  assert.equal(textA, 'HelloA');
  const insertB = textOperationForOffsetEdit(familyA, { kind: 'text.insert', at: { offset: 6 }, text: 'B' }, actorB, 3);
  const familyAB = applyTextOperation(familyA, insertB);
  const textAB = materializeText(familyAB);
  assert.equal(textAB, 'HelloAB');

  const actionRequests = [];
  const pendingResponses = [];
  const sources = [];
  let number = 0;
  let actionNumber = 0;
  const session = createAnnotatedTextHttpSession({
    typingBurstIdleMs: 0,
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => `action-${++actionNumber}`,
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        const request = JSON.parse(options.body);
        actionRequests.push(request);
        return new Promise((resolve) => pendingResponses.push(resolve));
      }
      const cursor = ++number;
      const body = { ...snapshot().body, text: cursor === 1 ? 'Hello' : textAB };
      const seed = cursor === 1 ? textFamilyCheckpoint(baseFamily) : textFamilyCheckpoint(familyAB);
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor, seed) }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;

  const first = session.insert({ mutationId: 'a', at: { offset: 5, affinity: 'right' }, text: 'A' });
  const second = session.insert({ mutationId: 'b', at: { offset: 6, affinity: 'right' }, text: 'B' });
  assert.equal(session.document.text, 'HelloAB');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(actionRequests.length, 1, 'B waits for A to submit');

  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 2, seqSpan: [2, 2],
    event: { type: 'LiveDocument.body.operated', scope: 'Project:p1', seq: 2, actionId: 'action-1' },
    fold: {
      kind: 'annotatedText', version: 5, field: 'body', baseCursor: 1, fence: 2,
      text: { reducer: 'workbench.text', operations: [insertA] },
      projection: { text: textA },
      dispositions: [],
      familyElementCount: Object.keys(textFamilyCheckpoint(familyA).checkpoint.elements).length,
      authoring: {
        acknowledgementFence: 2,
        stream: token('stream'), lease: token('lease'), snapshot: token('snapshot2'),
        positionFrames: [{ positionToken: token('position2') }],
      },
    },
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.document.text, 'HelloAB', 'own-echo fold must not splice A twice on top of the queued B');

  pendingResponses.shift()({ ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-1', confirmedThrough: 2 }) });
  const firstResult = await first;
  assert.equal(firstResult.ok, true, firstResult.failure?.message);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(actionRequests.length, 2, 'B must still submit after A settles through its fold');
  assert.equal(actionRequests[1].payload.authoring.mutationId, 'b');

  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 3, seqSpan: [3, 3],
    event: { type: 'LiveDocument.body.operated', scope: 'Project:p1', seq: 3, actionId: 'action-2' },
    fold: {
      kind: 'annotatedText', version: 5, field: 'body', baseCursor: 2, fence: 3,
      text: { reducer: 'workbench.text', operations: [insertB] },
      projection: { text: textAB },
      dispositions: [],
      familyElementCount: Object.keys(textFamilyCheckpoint(familyAB).checkpoint.elements).length,
      authoring: {
        acknowledgementFence: 3,
        stream: token('stream'), lease: token('lease'), snapshot: token('snapshot3'),
        positionFrames: [{ positionToken: token('position3') }],
      },
    },
  }]) });
  pendingResponses.shift()({ ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-2', confirmedThrough: 3 }) });
  const secondResult = await second;
  assert.equal(secondResult.ok, true, secondResult.failure?.message);
  assert.notEqual(secondResult.failure?.message, 'annotated text changed before queued operation could be submitted');
  assert.equal(session.document.text, 'HelloAB');
  session.close();
});

test('a v4 client receiving a v3 fold recovers by snapshot instead of applying or pruning', async () => {
  const snapshotRequests = [];
  const sources = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const cursor = ++number;
      snapshotRequests.push({ cursor });
      const body = number === 1 ? snapshot() : snapshot('recovered');
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body: body.body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  assert.equal(snapshotRequests.length, 1);
  // A genuine v3 fold (the pre-disposition shape: no `dispositions` key at
  // all) delivered against the current cursor. The v4 client's version guard
  // must fail closed to a covering snapshot — never apply or silently prune.
  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 2, seqSpan: [2, 2],
    event: { type: 'LiveDocument.body.operated', scope: 'Project:p1', seq: 2, actionId: 'v3-fold' },
    fold: {
      kind: 'annotatedText', version: 3, field: 'body', baseCursor: 1, fence: 2,
      text: { reducer: 'workbench.text', operations: [['workbench.text', 1, ['a'.repeat(32), 1], 1, [], ['insert', ['root'], 'x']]] },
      projection: { text: 'x' },
      familyElementCount: 1,
      authoring: {
        acknowledgementFence: 2,
        stream: token('stream'), lease: token('lease'), snapshot: token('snapshot2'),
        positionFrames: [{ positionToken: token('position2') }],
      },
    },
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(snapshotRequests.length >= 2, 'a v3 fold must recover via snapshot');
  assert.equal(session.document.text, 'recovered', 'the fold was not applied; the covering snapshot refreshed state');
  assert.equal(session.status, 'live');
  session.close();
});

test('a v4 fold missing or malformed dispositions recovers by snapshot instead of applying or pruning', async () => {
  const snapshotRequests = [];
  const sources = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const cursor = ++number;
      snapshotRequests.push({ cursor });
      const body = number === 1 ? snapshot() : snapshot('recovered');
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body: body.body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  assert.equal(snapshotRequests.length, 1);

  // A v4 fold that omits `dispositions` entirely.
  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 2, seqSpan: [2, 2],
    event: { type: 'LiveDocument.body.operated', scope: 'Project:p1', seq: 2, actionId: 'missing-dispositions' },
    fold: {
      kind: 'annotatedText', version: 5, field: 'body', baseCursor: 1, fence: 2,
      text: { reducer: 'workbench.text', operations: [['workbench.text', 1, ['a'.repeat(32), 1], 1, [], ['insert', ['root'], 'x']]] },
      projection: { text: 'x' },
      familyElementCount: 1,
      authoring: {
        acknowledgementFence: 2,
        stream: token('stream'), lease: token('lease'), snapshot: token('snapshot2'),
        positionFrames: [{ positionToken: token('position2') }],
      },
    },
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(snapshotRequests.length >= 2, 'a fold without dispositions must recover via snapshot');
  assert.equal(session.document.text, 'recovered', 'the missing-dispositions fold was not applied');
  assert.equal(session.status, 'live');

  // A v4 fold whose dispositions is malformed (not an array). Cursor is now 2.
  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 3, seqSpan: [3, 3],
    event: { type: 'LiveDocument.body.operated', scope: 'Project:p1', seq: 3, actionId: 'malformed-dispositions' },
    fold: {
      kind: 'annotatedText', version: 5, field: 'body', baseCursor: 2, fence: 3,
      text: { reducer: 'workbench.text', operations: [['workbench.text', 1, ['a'.repeat(32), 1], 1, [], ['insert', ['root'], 'y']]] },
      projection: { text: 'y' },
      dispositions: { annotationId: 'c1' },
      familyElementCount: 1,
      authoring: {
        acknowledgementFence: 3,
        stream: token('stream'), lease: token('lease'), snapshot: token('snapshot3'),
        positionFrames: [{ positionToken: token('position3') }],
      },
    },
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(snapshotRequests.length >= 3, 'a fold with malformed dispositions must recover via snapshot');
  assert.equal(session.document.text, 'recovered', 'the malformed-dispositions fold was not applied');
  assert.equal(session.status, 'live');
  session.close();
});

test('a collapsed range without a matching disposition recovers by snapshot instead of silently pruning', async () => {
  const { createTextState, applyTextOp, textCheckpoint } = await import('../build/annotated-text.mjs');
  const { createTextFamily, applyTextOperation, textFamilyCheckpoint, materializeText, textOperationForOffsetEdit, resolveOffsetToEndpoint } = await import('../build/annotated-text-continuous.mjs');
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const insertOp = ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'hello world']];
  const baseFamily = createTextFamily('d1', textCheckpoint(applyTextOp(createTextState(), insertOp)));
  const start = resolveOffsetToEndpoint(baseFamily, 6, baseFamily.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(baseFamily, 11, baseFamily.checkpoint.frontier, 'right');
  const deleteOp = textOperationForOffsetEdit(baseFamily, { kind: 'text.delete', from: { offset: 6 }, to: { offset: 11 } }, B, 2);
  const nextFamily = applyTextOperation(baseFamily, deleteOp);
  const nextText = materializeText(nextFamily);
  assert.equal(nextText, 'hello ');

  const snapshotRequests = [];
  const sources = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const cursor = ++number;
      snapshotRequests.push({ cursor });
      const body = number === 1
        ? {
          ...snapshot().body,
          version: 2,
          text: 'hello world',
          ranges: [{ annotationId: 'c1', start, end }],
          annotations: [{ id: 'c1', family: 'note', fields: {}, owner: 'u1' }],
          orphans: [],
        }
        : {
          ...snapshot().body,
          text: nextText,
          ranges: [],
          annotations: [],
          orphans: [{ id: 'c1', family: 'note', fields: {}, owner: 'u1', savedQuote: 'world' }],
        };
      return { ok: true, status: 200, json: async () => ({
        kind: 'snapshot', snapshot: { body }, cursor,
        authoring: authoringEnvelope(cursor, textFamilyCheckpoint(number === 1 ? baseFamily : nextFamily)),
      }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  assert.equal(session.document.text, 'hello world');
  assert.equal(session.document.ranges.length, 1);

  // The edit collapses c1 to zero width, but the fold ships NO disposition for
  // it. The one reconciliation path must fail closed to a covering snapshot:
  // the collapsed range is never silently pruned and never crashes the session.
  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 2, seqSpan: [2, 2],
    event: { type: 'LiveDocument.body.operated', scope: 'Project:p1', seq: 2, actionId: 'no-disposition' },
    fold: {
      kind: 'annotatedText', version: 5, field: 'body', baseCursor: 1, fence: 2,
      text: { reducer: 'workbench.text', operations: [deleteOp] },
      projection: { text: nextText },
      dispositions: [],
      familyElementCount: Object.keys(textFamilyCheckpoint(nextFamily).checkpoint.elements).length,
      authoring: {
        acknowledgementFence: 2,
        stream: token('stream'), lease: token('lease'), snapshot: token('snapshot2'),
        positionFrames: [{ positionToken: token('position2') }],
      },
    },
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(snapshotRequests.length >= 2, 'a collapsed range without a disposition must recover via snapshot');
  const fresh = materializeAnnotatedTextSnapshot({
    kind: 'workbench.annotatedText.recipient', version: 1,
    text: nextText,
    ranges: [],
    annotations: [],
    orphans: [{ id: 'c1', family: 'note', fields: {}, owner: 'u1', savedQuote: 'world' }],
    measurements: [],
  }, Document.body);
  assert.equal(session.document.text, fresh.text);
  assert.deepEqual(session.document.ranges, fresh.ranges);
  assert.deepEqual(session.document.annotations, fresh.annotations);
  assert.deepEqual(session.document.orphans, fresh.orphans);
  assert.deepEqual(session.document.measurements, fresh.measurements);
  assert.equal(session.status, 'live');
  session.close();
});

test('a v4 fold disposition reproduces the fresh authorized snapshot for emptied annotations', async () => {
  const { createTextState, applyTextOp, textCheckpoint } = await import('../build/annotated-text.mjs');
  const { createTextFamily, applyTextOperation, textFamilyCheckpoint, materializeText, textOperationForOffsetEdit } = await import('../build/annotated-text-continuous.mjs');
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const insertOp = ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'hello world']];
  const baseFamily = createTextFamily('d1', textCheckpoint(applyTextOp(createTextState(), insertOp)));
  // Delete 'world' (6..11). Both annotations cover exactly that range, so the
  // server's edit empties them: one orphan policy, one delete policy. The fold
  // ships both dispositions; the client never infers the policy.
  // textOperationForOffsetEdit mints a UNIQUE actor per offset edit ([actor, 1])
  // against the current frontier, so the delete actor must be distinct from the
  // insert's A.
  const deleteOp = textOperationForOffsetEdit(baseFamily, { kind: 'text.delete', from: { offset: 6 }, to: { offset: 11 } }, B, 2);
  const nextFamily = applyTextOperation(baseFamily, deleteOp);
  const nextText = materializeText(nextFamily);

  const snapshotRequests = [];
  const sources = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
      const cursor = ++number;
      snapshotRequests.push(cursor);
      const body = {
        ...snapshot().body,
        text: 'hello world',
        ranges: [
          { annotationId: 'c1', start: 6, end: 11 },
          { annotationId: 'm1', start: 6, end: 11 },
        ],
        annotations: [
          { id: 'c1', family: 'note', fields: {}, owner: 'u1' },
          { id: 'm1', family: 'note', fields: {}, owner: 'u1' },
        ],
        orphans: [],
      };
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor, textFamilyCheckpoint(baseFamily)) }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  assert.equal(session.document.text, 'hello world');
  assert.equal(session.document.ranges.length, 2);

  // A FOREIGN live edit (no pending own operation): the fold is the one
  // reconciliation path, identical to the own-echo path (ingest folds
  // baseSnapshot before own/foreign reconciliation is decided).
  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 2, seqSpan: [2, 2],
    event: { type: 'LiveDocument.body.operated', scope: 'Project:p1', seq: 2, actionId: 'foreign' },
    fold: {
      kind: 'annotatedText', version: 5, field: 'body', baseCursor: 1, fence: 2,
      text: { reducer: 'workbench.text', operations: [deleteOp] },
      projection: { text: nextText },
      dispositions: [
        { annotationId: 'm1', kind: 'deleted', family: 'note' },
        { annotationId: 'c1', kind: 'orphaned', family: 'note', savedQuote: 'world' },
      ],
      familyElementCount: Object.keys(textFamilyCheckpoint(nextFamily).checkpoint.elements).length,
      authoring: {
        acknowledgementFence: 2,
        stream: token('stream'), lease: token('lease'), snapshot: token('snapshot2'),
        positionFrames: [{ positionToken: token('position2') }],
      },
    },
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 10));

  // The folded document is exactly a fresh authorized snapshot of the same
  // committed state (the server's recipient projection for the post-edit row).
  const fresh = materializeAnnotatedTextSnapshot({
    kind: 'workbench.annotatedText.recipient', version: 1,
    text: nextText,
    ranges: [],
    annotations: [],
    orphans: [{ id: 'c1', family: 'note', fields: {}, owner: 'u1', savedQuote: 'world' }],
    measurements: [],
  }, Document.body);
  assert.equal(session.document.text, fresh.text);
  assert.deepEqual(session.document.ranges, fresh.ranges);
  assert.deepEqual(session.document.annotations, fresh.annotations);
  assert.deepEqual(session.document.orphans, fresh.orphans);
  assert.deepEqual(session.document.measurements, fresh.measurements);
  assert.deepEqual(session.document.orphans, [{
    id: 'c1', family: 'note', fields: {}, owner: 'u1', savedQuote: 'world',
  }]);
  session.close();
});

test('baseCursor mismatch forces snapshot recovery rather than applying fold', async () => {
  const snapshotRequests = [];
  let number = 0;
  const sources = [];
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const cursor = ++number;
      snapshotRequests.push({ cursor });
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: snapshot(), cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  assert.equal(snapshotRequests.length, 1);
  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 2, seqSpan: [2, 2],
    event: { type: 'LiveDocument.body.operated', scope: 'Project:p1', seq: 2, actionId: 'foreign' },
    fold: {
      kind: 'annotatedText', version: 5, field: 'body', baseCursor: 0, fence: 2,
      text: { reducer: 'workbench.text', operations: [['workbench.text', 1, ['a'.repeat(32), 1], 1, [], ['insert', ['root'], 'x']]] },
      projection: { text: 'x' },
      dispositions: [],
      familyElementCount: 1,
      authoring: {
        acknowledgementFence: 2,
        stream: token('stream'), lease: token('lease'), snapshot: token('snapshot2'),
        positionFrames: [{ positionToken: token('position2') }],
      },
    },
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(snapshotRequests.length >= 2, 'baseCursor mismatch recovers via snapshot');
  assert.equal(session.document.text, 'Hello');
  session.close();
});

test('materializes write-granted capability hints into document capabilities and replaces them on recovery', async () => {
  const CapaDocument = entity('CapaLiveDoc', {
    project: ref('Project'), owner: ref('User'), body: annotatedText({
      project: 'project', owner: 'owner', annotations: [annotation('note', { fields: {} })],
      capabilities: { edit: Object.freeze({}) },
    }),
  });
  const sources = [];
  const hints = ['edit'];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: CapaDocument, field: CapaDocument.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-1', confirmedThrough: number }) };
      const cursor = ++number;
      const body = {
        kind: 'workbench.annotatedText.recipient', version: 1,
        text: 'Hello', ranges: [], annotations: [], orphans: [], measurements: [],
        capabilityHints: hints,
      };
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  assert.deepEqual(session.document.capabilities, ['edit']);
  // A recovery that re-authorizes without write replaces the granted array;
  // a stale ['edit'] must never survive ingest (sol: revoked-write check).
  hints.length = 0;
  sources[0].onmessage({ data: JSON.stringify([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(session.document.capabilities, []);
  session.close();
});
