// S5/A3 field-read admission on the ephemeral fan-out path (workbench#78
// review): the fan-out emit bypassed projectRowForRecipient/readableFields,
// delivering raw committed payloads, deltas, and reducer seeds for fields the
// recipient cannot read. These tests pin the per-subscriber projection that now
// matches the committed-delivery envelope's readableFields gating.
//
// Owner subscribers may read every field; a non-owner may read everything EXCEPT
// the `secret` value field and the `secretBody` CRDT-text field.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLiveFanout } from '../build/live-fanout.mjs';
import { entity, text, ref, scope, everyone, grant, read, write, subscribe } from '../build/index.mjs';

function makeConn(id, principalId) {
  const messages = [];
  return {
    id,
    closed: false,
    principal: { type: 'user', id: principalId },
    send(message) { messages.push(message); },
    drain() { const out = [...messages]; messages.length = 0; return out; },
  };
}

function ownedNote() {
  return entity('Note', {
    title: text(),
    body: text.crdt(),
    secret: text().can(async ({ is }) => (await is.owner() ? grant(read, write) : grant())),
    secretBody: text.crdt().can(async ({ is }) => (await is.owner() ? grant(read, write) : grant())),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [scope(() => everyone()).can(async ({ is }) => (
      await is.owner() ? grant(read, write, subscribe) : grant(read, subscribe)
    ))],
  });
}

function rowFor(owner = 'alice') {
  return { id: 'n1', title: 'v1', secret: 's1', owner };
}

test('live fanout withholds unreadable fields from lifecycle event payloads per subscriber', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const owner = makeConn('c1', 'alice');
  const viewer = makeConn('c2', 'bob');
  const Note = ownedNote();

  fanout.addSubscription('Note', 'n1', owner);
  fanout.addSubscription('Note', 'n1', viewer);

  await fanout.emit(Note, 'n1', rowFor(), {
    type: 'Note.updated', seq: 1, data: { id: 'n1', title: 'v2', secret: 's2' },
  });

  assert.deepEqual(owner.drain()[0].event.data, { id: 'n1', title: 'v2', secret: 's2' });
  const viewerData = viewer.drain()[0].event.data;
  assert.deepEqual(viewerData, { id: 'n1', title: 'v2' });
  assert.equal(JSON.stringify(viewerData).includes('s2'), false, 'unreadable field never reaches the viewer');
  fanout.close();
});

test('live fanout withholds unreadable fields from updated deltas per subscriber', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const owner = makeConn('c1', 'alice');
  const viewer = makeConn('c2', 'bob');
  const Note = ownedNote();

  fanout.addSubscription('Note', 'n1', owner);
  fanout.addSubscription('Note', 'n1', viewer);

  // First update seeds the shared prev-shadow.
  await fanout.emit(Note, 'n1', rowFor(), {
    type: 'Note.updated', seq: 1, data: { id: 'n1', title: 'v1', secret: 's1' },
  });
  owner.drain();
  viewer.drain();

  await fanout.emit(Note, 'n1', { ...rowFor(), title: 'v2', secret: 's2' }, {
    type: 'Note.updated', seq: 2, data: { id: 'n1', title: 'v2', secret: 's2' },
  });

  const ownerDelta = owner.drain()[0].delta;
  const viewerDelta = viewer.drain()[0].delta;
  assert.deepEqual(ownerDelta, { title: { set: 'v2' }, secret: { set: 's2' } });
  assert.deepEqual(viewerDelta, { title: { set: 'v2' } });
  assert.equal(JSON.stringify(viewerDelta).includes('s2'), false, 'unreadable delta never reaches the viewer');
  fanout.close();
});

test('live fanout withholds reducer seeds for unreadable CRDT-text fields', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const owner = makeConn('c1', 'alice');
  const viewer = makeConn('c2', 'bob');
  const Note = ownedNote();

  fanout.addSubscription('Note', 'n1', owner);
  fanout.addSubscription('Note', 'n1', viewer);

  await fanout.emit(Note, 'n1', rowFor(), {
    type: 'Note.created', seq: 1, data: { id: 'n1', title: 'v1', secret: 's1' },
  });

  const ownerReducers = owner.drain()[0].reducers.map((seed) => seed.field).sort();
  const viewerReducers = viewer.drain()[0].reducers.map((seed) => seed.field).sort();
  assert.deepEqual(ownerReducers, ['body', 'secretBody']);
  assert.deepEqual(viewerReducers, ['body']);
  assert.equal(JSON.stringify(viewer.drain()[0] ?? []).includes('secretBody'), false);
  fanout.close();
});

test('live fanout resyncs a native event on an unreadable field instead of delivering the payload', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const owner = makeConn('c1', 'alice');
  const viewer = makeConn('c2', 'bob');
  const Note = ownedNote();

  fanout.addSubscription('Note', 'n1', owner);
  fanout.addSubscription('Note', 'n1', viewer);

  await fanout.emit(Note, 'n1', rowFor(), {
    type: 'Note.secretBody.applied', seq: 4,
    data: { id: 'n1', operation: ['workbench.text', 1, ['actor:1'], 1, [], ['insert', ['root'], 'private text']] },
  });

  const ownerEvent = owner.drain()[0];
  assert.equal(ownerEvent.type, 'event');
  assert.equal(ownerEvent.event.type, 'Note.secretBody.applied');

  await new Promise((resolve) => setImmediate(resolve));
  const viewerEnvelope = viewer.drain()[0];
  assert.deepEqual(viewerEnvelope, {
    type: 'resync', entity: 'Note', id: 'n1', seq: 4,
    reason: 'recipient-snapshot-required',
  });
  assert.equal(JSON.stringify(viewer.drain()).includes('private text'), false);
  fanout.close();
});

test('live fanout runs field-read admission through the injected authorization adapter', async () => {
  const adapter = {
    admit: async (input) => ({
      admitted: input.fieldName !== 'secret',
      operation: input.operation ?? null,
      resourceCategory: input.category,
      resourceId: input.resourceId ?? null,
      reasonCode: input.fieldName === 'secret' ? 'no-field-access' : null,
      capabilities: [],
      trace: null,
    }),
    registerResource() {},
  };
  const fanout = createLiveFanout({ mayVerb: async () => true, authorization: adapter });
  const conn = makeConn('c1', 'alice');
  const Note = ownedNote();

  fanout.addSubscription('Note', 'n1', conn);

  await fanout.emit(Note, 'n1', rowFor(), {
    type: 'Note.updated', seq: 1, data: { id: 'n1', title: 'v2', secret: 's2' },
  });

  // The adapter denies `secret` even for the owner: the payload is confined to
  // what the adapter lets the principal read.
  assert.deepEqual(conn.drain()[0].event.data, { id: 'n1', title: 'v2' });
  fanout.close();
});

test('live fanout scopes the field-read admission per subscriber, not once for the fan-out', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const owner = makeConn('c1', 'alice');
  const viewer = makeConn('c2', 'bob');
  const Note = ownedNote();

  fanout.addSubscription('Note', 'n1', owner);
  fanout.addSubscription('Note', 'n1', viewer);

  await fanout.emit(Note, 'n1', rowFor(), {
    type: 'Note.updated', seq: 1, data: { id: 'n1', title: 'v2', secret: 's2' },
  });

  // Same fan-out, same committed event — two subscribers, two readable sets.
  assert.equal(owner.drain()[0].event.data.secret, 's2');
  assert.equal('secret' in viewer.drain()[0].event.data, false);
  fanout.close();
});
