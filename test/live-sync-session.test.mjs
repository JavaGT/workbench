import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveChannel } from '../public/workbench-client.mjs';
import * as clientModule from '../public/workbench-client.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    this.sendError = null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, data = undefined) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(type === 'message' ? { data: JSON.stringify(data) } : {});
    }
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  send(message) {
    if (this.sendError) throw this.sendError;
    this.sent.push(JSON.parse(message));
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

function harness(options = {}) {
  const sockets = [];
  const channel = new LiveChannel('ws://example.test', {
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    backoffBase: 1,
    maxBackoff: 1,
    ...options,
  });
  return { channel, sockets };
}

test('two concurrent subscriptions share one connection and send desired state once', async () => {
  const { channel, sockets } = harness();
  const first = channel.subscribe('Doc', 'a', () => {});
  const second = channel.subscribe('Doc', 'b', () => {});

  await tick();
  assert.equal(sockets.length, 1);
  sockets[0].open();
  await tick();
  assert.deepEqual(sockets[0].sent, [
    { type: 'subscribe', entity: 'Doc', id: 'a', requestId: 1 },
    { type: 'subscribe', entity: 'Doc', id: 'b', requestId: 2 },
  ]);

  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'b', currentSeq: 2 });
  assert.deepEqual(await first, { currentSeq: 1 });
  assert.deepEqual(await second, { currentSeq: 2 });
  channel.close();
});

test('post-ack activation failure removes the acknowledged subscription', async () => {
  const { channel, sockets } = harness();
  const ready = channel.subscribe('Doc', 'd1', () => {});
  await tick();
  sockets[0].open();
  await tick();
  const request = sockets[0].sent[0];
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'd1', requestId: request.requestId, currentSeq: 0 });
  await ready;
  sockets[0].emit('message', {
    type: 'error', requestId: request.requestId,
    failure: { category: 'denied', message: 'Subscription failed.' },
  });
  const replacement = channel.subscribe('Doc', 'd1', () => {});
  await tick();
  const replacementRequest = sockets[0].sent[1];
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'd1', requestId: replacementRequest.requestId, currentSeq: 0 });
  await replacement;
  channel.close();
});

test('a denied subscription rejects only its matching request and remains reusable', async () => {
  const { channel, sockets } = harness();
  const allowedEvents = [];
  const allowed = channel.subscribe('Doc', 'allowed', (event) => allowedEvents.push(event));
  const denied = channel.subscribe('Doc', 'denied', () => {});
  const deniedResult = assert.rejects(denied, /forbidden/i);

  await tick();
  sockets[0].open();
  await tick();

  const [allowedRequest, deniedRequest] = sockets[0].sent;
  assert.equal(typeof allowedRequest.requestId, 'number');
  assert.equal(typeof deniedRequest.requestId, 'number');
  assert.notEqual(allowedRequest.requestId, deniedRequest.requestId);

  sockets[0].emit('message', {
    type: 'error',
    requestId: deniedRequest.requestId,
    failure: { category: 'denied', message: 'Forbidden.' },
  });
  sockets[0].emit('message', {
    type: 'subscribed',
    requestId: allowedRequest.requestId,
    entity: 'Doc',
    id: 'allowed',
    currentSeq: 3,
  });

  await deniedResult;
  assert.deepEqual(await allowed, { currentSeq: 3 });

  sockets[0].emit('message', {
    type: 'event',
    entity: 'Doc',
    id: 'allowed',
    seq: 4,
    event: { type: 'Doc.updated', data: { title: 'still live' } },
  });
  assert.equal(allowedEvents.length, 1);

  const retry = channel.subscribe('Doc', 'denied', () => {});
  await tick();
  const retryRequest = sockets[0].sent.at(-1);
  assert.equal(retryRequest.entity, 'Doc');
  assert.equal(retryRequest.id, 'denied');
  assert.notEqual(retryRequest.requestId, deniedRequest.requestId);
  sockets[0].emit('message', {
    type: 'subscribed',
    requestId: retryRequest.requestId,
    entity: 'Doc',
    id: 'denied',
    currentSeq: 4,
  });
  assert.deepEqual(await retry, { currentSeq: 4 });
  channel.close();
});

test('a correlated failure rejects only its request with WorkbenchFailureError', async () => {
  const { channel, sockets } = harness();
  const allowed = channel.subscribe('Doc', 'allowed', () => {});
  const denied = channel.subscribe('Doc', 'denied', () => {});
  await tick();
  sockets[0].open();
  await tick();
  const [allowedRequest, deniedRequest] = sockets[0].sent;

  sockets[0].emit('message', {
    type: 'error',
    requestId: deniedRequest.requestId,
    failure: { category: 'denied', message: 'Forbidden.' },
  });
  await assert.rejects(denied, (error) => {
    assert.equal(error instanceof clientModule.WorkbenchFailureError, true);
    assert.deepEqual(error.failure, { category: 'denied', message: 'Forbidden.' });
    return true;
  });

  sockets[0].emit('message', {
    type: 'subscribed',
    requestId: allowedRequest.requestId,
    entity: 'Doc',
    id: 'allowed',
    currentSeq: 4,
  });
  assert.deepEqual(await allowed, { currentSeq: 4 });
  channel.close();
});

test('WorkbenchFailureError rejects a non-canonical failure', () => {
  assert.throws(
    () => new clientModule.WorkbenchFailureError({ message: 'not categorized' }),
    /WorkbenchFailure/,
  );
});

test('an uncorrelated error cannot reject unrelated pending subscriptions', async () => {
  const { channel, sockets } = harness();
  const first = channel.subscribe('Doc', 'a', () => {});
  const second = channel.subscribe('Doc', 'b', () => {});
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', {
    type: 'error',
    failure: { category: 'invalid-input', message: 'Malformed frame.' },
  });

  const [firstRequest, secondRequest] = sockets[0].sent;
  sockets[0].emit('message', {
    type: 'subscribed', requestId: firstRequest.requestId,
    entity: 'Doc', id: 'a', currentSeq: 1,
  });
  sockets[0].emit('message', {
    type: 'subscribed', requestId: secondRequest.requestId,
    entity: 'Doc', id: 'b', currentSeq: 2,
  });
  assert.deepEqual(await first, { currentSeq: 1 });
  assert.deepEqual(await second, { currentSeq: 2 });
  channel.close();
});

test('a malformed correlated error is ignored without leaking its text', async () => {
  const { channel, sockets } = harness();
  const pending = channel.subscribe('Doc', 'a', () => {});
  await tick();
  sockets[0].open();
  await tick();
  const request = sockets[0].sent[0];
  sockets[0].emit('message', {
    type: 'error', requestId: request.requestId, message: 'database password leaked',
  });
  sockets[0].emit('message', {
    type: 'subscribed', requestId: request.requestId,
    entity: 'Doc', id: 'a', currentSeq: 3,
  });
  assert.deepEqual(await pending, { currentSeq: 3 });
  channel.close();
});

test('a synchronously throwing socket factory rejects cleanly and leaves the subscription reusable', async () => {
  const sockets = [];
  let attempts = 0;
  const channel = new LiveChannel('ws://example.test', {
    socketFactory: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('socket factory failed');
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    backoffBase: 1,
    maxBackoff: 1,
  });

  const first = channel.subscribe('Doc', 'a', () => {});
  await assert.rejects(first, /socket factory failed/);

  const retry = channel.subscribe('Doc', 'a', () => {});
  await tick();
  sockets[0].open();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  assert.deepEqual(await retry, { currentSeq: 1 });
  channel.close();
});

test('late messages and closes from a retired socket generation are ignored', async () => {
  const { channel, sockets } = harness();
  const events = [];
  const checkpoints = [];
  const ready = channel.subscribe('Doc', 'a', {
    onCheckpoint: ({ currentSeq }) => checkpoints.push(currentSeq),
  }, (event) => events.push(event));

  await tick();
  sockets[0].open();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await ready;
  sockets[0].close();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sockets.length, 2);
  sockets[1].open();
  await tick();
  sockets[1].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 4 });

  sockets[0].emit('message', {
    type: 'event', entity: 'Doc', id: 'a', seq: 99, seqSpan: [99, 99],
    event: { type: 'Doc.updated', data: { title: 'stale' } },
  });
  sockets[0].emit('close');
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(checkpoints, [1, 4]);
  assert.deepEqual(events, []);
  assert.equal(sockets.length, 2);
  channel.close();
});

test('close while connecting rejects pending subscription and prevents reconnect', async () => {
  const { channel, sockets } = harness();
  const pending = channel.subscribe('Doc', 'a', () => {});
  await tick();
  assert.equal(sockets.length, 1);

  const rejected = assert.rejects(pending, /closed/i);
  channel.close();
  await rejected;
  sockets[0].open();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sockets.length, 1);
});

test('unsubscribe while offline is absent from reconnect reconciliation', async () => {
  const { channel, sockets } = harness();
  const pending = channel.subscribe('Doc', 'a', () => {});
  await tick();
  sockets[0].open();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  sockets[0].close();
  await channel.unsubscribe('Doc', 'a');
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (sockets[1]) {
    sockets[1].open();
    await tick();
    assert.deepEqual(sockets[1].sent, []);
  }
  channel.close();
});

test('send failure retires the generation and replays desired state exactly once', async () => {
  const { channel, sockets } = harness();
  const pending = channel.subscribe('Doc', 'a', () => {});
  await tick();
  sockets[0].sendError = new Error('write failed');
  sockets[0].open();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(sockets.length, 2);
  sockets[1].open();
  await tick();
  assert.deepEqual(sockets[1].sent, [{ type: 'subscribe', entity: 'Doc', id: 'a', requestId: 3 }]);
  sockets[1].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 2 });
  assert.deepEqual(await pending, { currentSeq: 2 });
  channel.close();
});

test('the same subscription cannot be recreated until unsubscribe is acknowledged', async () => {
  const { channel, sockets } = harness();
  const initial = channel.subscribe('Doc', 'a', () => {});
  await tick();
  sockets[0].open();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await initial;

  const removing = channel.unsubscribe('Doc', 'a');
  assert.throws(
    () => channel.subscribe('Doc', 'a', () => {}),
    /unsubscribe.*pending/i,
  );

  sockets[0].emit('message', { type: 'unsubscribed', entity: 'Doc', id: 'a' });
  await removing;

  const replacement = channel.subscribe('Doc', 'a', () => {});
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 2 });
  assert.deepEqual(await replacement, { currentSeq: 2 });
  channel.close();
});

test('closed lifecycle stays permanently disconnected and ignores stale socket open/close/error events', async () => {
  const statuses = [];
  const { channel, sockets } = harness();
  channel.onConnectionChange((status) => statuses.push(status));

  const pending = channel.subscribe('Doc', 'a', () => {});
  const rejected = assert.rejects(pending, /closed/i);
  await tick();
  assert.equal(sockets.length, 1);

  channel.close();
  await rejected;
  assert.equal(channel.status, 'disconnected');

  // Stale socket events arriving after terminal close must be ignored cleanly
  sockets[0].emit('open');
  sockets[0].emit('error');
  sockets[0].emit('close');
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(channel.status, 'disconnected');
  assert.equal(sockets.length, 1);
  assert.deepEqual(statuses, ['connecting', 'disconnected']);
});
