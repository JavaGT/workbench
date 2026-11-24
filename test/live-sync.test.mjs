import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLiveFanout } from '../build/live-fanout.mjs';
import { anonymous } from '../build/principal.mjs';
import { entity, text, ref, scope, grant, read, write, subscribe } from '../build/index.mjs';

function makeStubConn(id, principalId) {
  const messages = [];
  const conn = {
    id,
    principal: { id: principalId },
    closed: false,
    send(data) { messages.push(data); },
    drainMessages() { const m = [...messages]; messages.length = 0; return m; },
    close() { this.closed = true; },
  };
  return conn;
}

function ownedNote() {
  return entity('Note', {
    body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

function makeEvent(type, seq = 1) {
  return { type, seq };
}

test('a connection can subscribe to an entity row', () => {
  const fanout = createLiveFanout();
  const conn = makeStubConn('c1', 'u1');

  fanout.addSubscription('Doc', 'doc-1', conn);
  assert.equal(fanout.subscriptionCount(conn), 1);
  assert.ok(fanout.hasSubscription(conn, 'Doc', 'doc-1'));
  assert.ok(!fanout.hasSubscription(conn, 'Doc', 'doc-2'));
});

test('multiple connections can subscribe to the same row', () => {
  const fanout = createLiveFanout();
  const c1 = makeStubConn('c1', 'u1');
  const c2 = makeStubConn('c2', 'u2');

  fanout.addSubscription('Doc', 'doc-1', c1);
  fanout.addSubscription('Doc', 'doc-1', c2);

  assert.equal(fanout.subscriptionCount(c1), 1);
  assert.equal(fanout.subscriptionCount(c2), 1);
});

test('a connection can unsubscribe from a row', () => {
  const fanout = createLiveFanout();
  const c1 = makeStubConn('c1', 'u1');
  const c2 = makeStubConn('c2', 'u2');

  fanout.addSubscription('Doc', 'doc-1', c1);
  fanout.addSubscription('Doc', 'doc-1', c2);
  fanout.removeSubscription('Doc', 'doc-1', c1);

  assert.ok(!fanout.hasSubscription(c1, 'Doc', 'doc-1'));
  assert.ok(fanout.hasSubscription(c2, 'Doc', 'doc-1'));
});

test('removeAll cleans every subscription for that connection', () => {
  const fanout = createLiveFanout();
  const c1 = makeStubConn('c1', 'u1');
  const c2 = makeStubConn('c2', 'u2');

  fanout.addSubscription('Doc', 'doc-1', c1);
  fanout.addSubscription('Doc', 'doc-2', c1);
  fanout.addSubscription('Doc', 'doc-1', c2);
  fanout.removeAll(c1);

  assert.ok(!fanout.hasSubscription(c1, 'Doc', 'doc-1'));
  assert.ok(!fanout.hasSubscription(c1, 'Doc', 'doc-2'));
  assert.ok(fanout.hasSubscription(c2, 'Doc', 'doc-1'));
});

test('emit fans out an event to every authorized subscriber', async () => {
  const Note = ownedNote();
  const mayVerb = () => true;
  const fanout = createLiveFanout({ mayVerb });
  const c1 = makeStubConn('c1', 'u1');
  const c2 = makeStubConn('c2', 'u2');
  const c3 = makeStubConn('c3', 'u3');

  fanout.addSubscription('Note', 'note-1', c1);
  fanout.addSubscription('Note', 'note-1', c2);

  const row = { id: 'note-1', body: 'hello', owner: 'u1' };
  await fanout.emit(Note, 'note-1', row, makeEvent('Note.updated'));

  const msgs1 = c1.drainMessages();
  const msgs2 = c2.drainMessages();
  const msgs3 = c3.drainMessages();

  assert.equal(msgs1.length, 1);
  assert.equal(msgs1[0].entity, 'Note');
  assert.equal(msgs1[0].id, 'note-1');
  assert.equal(msgs2.length, 1);
  assert.equal(msgs3.length, 0);
});

test('a denied subscriber on a live event is not notified', async () => {
  const Note = ownedNote();
  const mayVerb = () => false;
  const fanout = createLiveFanout({ mayVerb });
  const c1 = makeStubConn('c1', 'u1');

  fanout.addSubscription('Note', 'note-1', c1);
  await fanout.emit(Note, 'note-1', { id: 'note-1', body: 'x', owner: 'u2' }, makeEvent('Note.updated'));

  assert.deepEqual(c1.drainMessages(), []);
  assert.ok(fanout.hasSubscription(c1, 'Note', 'note-1'));
});

test('removed row event notifies all subscribers (skips re-auth)', async () => {
  const Note = ownedNote();
  const mayVerb = () => false;
  const fanout = createLiveFanout({ mayVerb });
  const c1 = makeStubConn('c1', 'u1');

  fanout.addSubscription('Note', 'note-1', c1);
  await fanout.emit(Note, 'note-1', undefined, makeEvent('Note.removed'));

  const msgs = c1.drainMessages();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].id, 'note-1');
});

test('removeAll on close cleans the connection', () => {
  const fanout = createLiveFanout();
  const c1 = makeStubConn('c1', 'u1');
  fanout.addSubscription('Doc', 'doc-1', c1);
  fanout.addSubscription('Note', 'n-1', c1);

  fanout.removeAll(c1);
  assert.ok(!fanout.hasSubscription(c1, 'Doc', 'doc-1'));
  assert.ok(!fanout.hasSubscription(c1, 'Note', 'n-1'));
});

test('fanout.close() clears all state', () => {
  const fanout = createLiveFanout();
  const c1 = makeStubConn('c1', 'u1');
  fanout.addSubscription('Doc', 'doc-1', c1);

  fanout.close();
  assert.equal(fanout.subscriptionCount(c1), 0);
});

test('closed connection is not delivered to', async () => {
  const Note = ownedNote();
  const mayVerb = () => true;
  const fanout = createLiveFanout({ mayVerb });
  const c1 = makeStubConn('c1', 'u1');
  c1.close();

  fanout.addSubscription('Note', 'note-1', c1);
  await fanout.emit(Note, 'note-1', { id: 'note-1', body: 'x', owner: 'u1' }, makeEvent('Note.updated'));

  assert.deepEqual(c1.drainMessages(), []);
});

test('anonymous principal used when none set on connection', async () => {
  const Note = ownedNote();
  const calls = [];
  const fanout = createLiveFanout({
    mayVerb: (entity, verb, row, principal) => {
      calls.push(principal);
      return true;
    },
  });
  const conn = { id: 'anon', principal: null, closed: false, send() {} };

  fanout.addSubscription('Note', 'note-1', conn);
  await fanout.emit(Note, 'note-1', { id: 'note-1', body: 'x', owner: 'u1' }, makeEvent('Note.updated'));

  assert.equal(calls.length, 1);
  assert.strictEqual(calls[0], anonymous);
});

test('emit skips when entity record has no name', async () => {
  const _Note = ownedNote();
  const fanout = createLiveFanout();
  const c1 = makeStubConn('c1', 'u1');
  fanout.addSubscription('Note', 'note-1', c1);

  await fanout.emit({ name: '' }, 'note-1', { id: 'note-1' }, makeEvent('Note.updated'));
  assert.deepEqual(c1.drainMessages(), []);
});

test('emit skips when event entity does not match record name', async () => {
  const Note = ownedNote();
  const fanout = createLiveFanout({ mayVerb: () => true });
  const c1 = makeStubConn('c1', 'u1');
  fanout.addSubscription('Doc', 'doc-1', c1);

  await fanout.emit(Note, 'doc-1', { id: 'doc-1' }, makeEvent('Doc.updated'));
  assert.deepEqual(c1.drainMessages(), []);
});

test('emit skips when no subscribers for the entity', async () => {
  const Note = ownedNote();
  const fanout = createLiveFanout({ mayVerb: () => true });
  const c1 = makeStubConn('c1', 'u1');
  fanout.addSubscription('Other', 'n-1', c1);

  await fanout.emit(Note, 'note-1', { id: 'note-1' }, makeEvent('Note.updated'));
  assert.deepEqual(c1.drainMessages(), []);
});

test('emit skips when no subscribers for the id', async () => {
  const Note = ownedNote();
  const fanout = createLiveFanout({ mayVerb: () => true });
  const c1 = makeStubConn('c1', 'u1');
  fanout.addSubscription('Note', 'note-1', c1);

  await fanout.emit(Note, 'note-2', { id: 'note-2' }, makeEvent('Note.updated'));
  assert.deepEqual(c1.drainMessages(), []);
});
