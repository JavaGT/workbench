// W3 slice 2: scope-anchored foreign event delivery through the live fan-out.
//
// A subscriber of scope "Project:p1" receives a _Job.updated event emitted
// with the Project entity record as anchor. Authz is re-checked against the
// anchor row; delta projection and ephemeral-field pacing are skipped. The
// foreign payload is field-gated like any other payload: a field the recipient
// cannot prove to read (undeclared or unreadable on the anchor) never crosses
// live delivery — the recipient resyncs instead, matching the committed
// envelope path's foreign-entity behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveFanout } from '../build/live-fanout.mjs';
import { scope, grant, read, subscribe } from '../build/internal.mjs';

function makeConn(id, principalId = id) {
  const messages = [];
  return {
    id, closed: false,
    principal: { type: 'user', id: principalId },
    send(m) { messages.push(m); },
    drain() { const out = [...messages]; messages.length = 0; return out; },
  };
}

function projectRecord() {
  return {
    name: 'Project',
    fields: { status: { kind: 'text' } },
    grant: () => [scope(() => true).can(() => grant(read, subscribe))],
    findById(id) { return { id, title: 'test-project', status: 'completed' }; },
  };
}

test('scope-anchored foreign event is delivered to scope subscriber', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const project = projectRecord();

  fanout.addSubscription('Project:p1', conn);

  await fanout.emit(
    project, 'p1', { id: 'p1' },
    { type: '_Job.updated', scope: 'Project:p1', seq: 1, data: { id: 'job1', status: 'completed' } },
  );

  await new Promise((resolve) => setImmediate(resolve));
  const msgs = conn.drain();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].entity, 'Project');
  assert.equal(msgs[0].id, 'p1');
  assert.equal(msgs[0].seq, 1);
  assert.equal(msgs[0].event.type, '_Job.updated');
  // The foreign payload rides through only while every field is readable.
  assert.deepEqual(msgs[0].event.data, { id: 'job1', status: 'completed' });
  fanout.close();
});

test('scope-anchored foreign event with an unreadable field resyncs instead of leaking the payload', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  // The anchor declares no foreign payload field: `status` cannot be proven
  // readable, so the payload must never cross live delivery.
  const project = {
    name: 'Project',
    fields: {},
    grant: () => [scope(() => true).can(() => grant(subscribe))],
    findById(id) { return { id, title: 'test-project' }; },
  };

  fanout.addSubscription('Project:p1', conn);

  await fanout.emit(
    project, 'p1', { id: 'p1' },
    { type: '_Job.updated', scope: 'Project:p1', seq: 1, data: { id: 'job1', status: 'completed' } },
  );

  await new Promise((resolve) => setImmediate(resolve));
  const msgs = conn.drain();
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0], {
    type: 'resync', entity: 'Project', id: 'p1', seq: 1,
    reason: 'recipient-snapshot-required',
  });
  assert.equal(JSON.stringify(msgs).includes('completed'), false, 'unreadable payload field never reaches the subscriber');
  fanout.close();
});

test('scope-anchored foreign event envelope carries no delta', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const project = projectRecord();

  fanout.addSubscription('Project:p1', conn);

  await fanout.emit(
    project, 'p1', { id: 'p1' },
    { type: '_Job.created', scope: 'Project:p1', seq: 1, data: { id: 'job1' } },
  );

  await new Promise((resolve) => setImmediate(resolve));
  const msgs = conn.drain();
  assert.equal(msgs.length, 1);
  assert.equal('delta' in msgs[0], false);
});

test('mismatched scope key drops foreign event', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const project = projectRecord();

  fanout.addSubscription('Project:p1', conn);

  await fanout.emit(
    project, 'p1', { id: 'p1' },
    { type: '_Job.updated', scope: 'Project:WRONG', seq: 1, data: { id: 'job1' } },
  );

  assert.equal(conn.drain().length, 0);
});

test('unauthorized subscriber receives nothing for scope-anchored event', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => false });
  const conn = makeConn('c1');
  const project = projectRecord();

  fanout.addSubscription('Project:p1', conn);

  await fanout.emit(
    project, 'p1', { id: 'p1' },
    { type: '_Job.updated', scope: 'Project:p1', seq: 1, data: { id: 'job1' } },
  );

  assert.equal(conn.drain().length, 0);
});

test('normal same-entity event still gets delta projection and delivery', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const entity = {
    name: 'Doc',
    fields: {},
    grant: () => [{ can: () => true }],
    findById(id) { return { id, title: 'v1' }; },
  };

  fanout.addSubscription('Doc:d1', conn);

  await fanout.emit(
    entity, 'd1', { id: 'd1', title: 'v1' },
    { type: 'Doc.created', scope: 'Doc:d1', seq: 1, data: { id: 'd1' } },
  );
  conn.drain();

  await fanout.emit(
    entity, 'd1', { id: 'd1', title: 'v2' },
    { type: 'Doc.updated', scope: 'Doc:d1', seq: 2, data: { id: 'd1', title: 'v2' } },
  );

  await new Promise((resolve) => setImmediate(resolve));
  const msgs = conn.drain();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].event.type, 'Doc.updated');
  assert.deepEqual(msgs[0].delta, {});
});

test('same-entity and scope-anchored foreign events both deliver to same subscriber', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const project = projectRecord();

  fanout.addSubscription('Project:p1', conn);

  await fanout.emit(
    project, 'p1', { id: 'p1' },
    { type: '_Job.created', scope: 'Project:p1', seq: 1, data: { id: 'job1' } },
  );

  await fanout.emit(
    project, 'p1', { id: 'p1', title: 'updated' },
    { type: 'Project.updated', scope: 'Project:p1', seq: 2, data: { id: 'p1', title: 'updated' } },
  );

  await new Promise((resolve) => setImmediate(resolve));
  const msgs = conn.drain();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].event.type, '_Job.created');
  assert.equal(msgs[1].event.type, 'Project.updated');
});
