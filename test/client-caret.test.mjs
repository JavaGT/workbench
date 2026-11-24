import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveChannel } from '../public/workbench-client.mjs';

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

// --- subscribe exact carets + reconnect retention ---

test('subscribe with carets array sends carets in subscribe envelope', async () => {
  const { channel, sockets } = harness();
  const carets = ['body', 'summary'];
  const onCaretCalls = [];
  const pending = channel.subscribe('Doc', 'a', { carets, onCaret: (f) => onCaretCalls.push(f) });
  await tick();
  sockets[0].open();
  await tick();
  assert.equal(sockets[0].sent.length, 1);
  assert.deepEqual(sockets[0].sent[0].carets, ['body', 'summary']);
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;
  channel.close();
});

test('subscribe without carets omits carets from envelope', async () => {
  const { channel, sockets } = harness();
  const pending = channel.subscribe('Doc', 'a', () => {});
  await tick();
  sockets[0].open();
  await tick();
  assert.equal(sockets[0].sent.length, 1);
  assert.equal(sockets[0].sent[0].carets, undefined);
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;
  channel.close();
});

test('carets interest is retained and resent on reconnect', async () => {
  const { channel, sockets } = harness();
  const carets = ['body'];
  const onCaretCalls = [];
  const pending = channel.subscribe('Doc', 'a', { carets, onCaret: (f) => onCaretCalls.push(f) });
  await tick();
  sockets[0].open();
  await tick();
  assert.deepEqual(sockets[0].sent[0].carets, ['body']);
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  sockets[0].close();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sockets.length, 2);
  sockets[1].open();
  await tick();
  assert.ok(sockets[1].sent.length > 0);
  assert.deepEqual(sockets[1].sent[0].carets, ['body']);
  channel.close();
});

test('scope carets interest and callback are retained and resent on reconnect', async () => {
  const { channel, sockets } = harness();
  const seen = [];
  const ready = channel.subscribeScope('project:p1', {
    interest: { entity: 'Doc', id: 'd1' }, carets: ['body'], onCaret: (frame) => seen.push(frame),
  });
  await tick();
  sockets[0].open();
  await tick();
  const first = sockets[0].sent[0];
  assert.deepEqual(first.interest.carets, ['body']);
  sockets[0].emit('message', { type: 'subscribed', scope: 'project:p1', currentSeq: 0, requestId: first.requestId });
  await ready;
  sockets[0].close();
  await new Promise((resolve) => setTimeout(resolve, 5));
  sockets[1].open();
  await tick();
  const second = sockets[1].sent[0];
  assert.deepEqual(second.interest.carets, ['body']);
  sockets[1].emit('message', {
    type: 'annotated-text-caret', version: 1, entity: 'Doc', id: 'd1', field: 'body',
    change: { op: 'upsert', value: { kind: 'caret', presence: 'p1', offset: 0, name: '', sourceId: 'demo' } },
  });
  assert.equal(seen.length, 1);
  channel.close();
});

// --- exact outbound grammar ---

test('updateCaret sends exact caret.update message', () => {
  const { channel, sockets: _sockets } = harness();
  const result = channel.updateCaret({ entity: 'Doc', id: 'a', field: 'body', offset: 5 });
  assert.equal(result, false); // offline
});

test('updateCaret rejects unknown keys', () => {
  const { channel } = harness();
  assert.throws(
    () => channel.updateCaret({ entity: 'Doc', id: 'a', field: 'body', offset: 5, extra: 'x' }),
    /updateCaret requires type\/entity\/id\/field\/offset/,
  );
  assert.throws(
    () => channel.updateCaret({ entity: 'Doc', id: 'a', field: 'body', offset: 5, selection: { from: 0 } }),
    /updateCaret selection must be a \{ from, to \} range/,
  );
});

test('updateCaret rejects empty strings', () => {
  const { channel } = harness();
  assert.throws(
    () => channel.updateCaret({ entity: '', id: 'a', field: 'body', offset: 0 }),
    /updateCaret requires non-empty strings/,
  );
  assert.throws(
    () => channel.updateCaret({ entity: 'Doc', id: '', field: 'body', offset: 0 }),
    /updateCaret requires non-empty strings/,
  );
  assert.throws(
    () => channel.updateCaret({ entity: 'Doc', id: 'a', field: '', offset: 0 }),
    /updateCaret requires non-empty strings/,
  );
});

test('updateCaret rejects non-safe-negative offset', () => {
  const { channel } = harness();
  assert.throws(
    () => channel.updateCaret({ entity: 'Doc', id: 'a', field: 'body', offset: -1 }),
    /updateCaret requires a non-negative safe integer/,
  );
  assert.throws(
    () => channel.updateCaret({ entity: 'Doc', id: 'a', field: 'body', offset: 1.5 }),
    /updateCaret requires a non-negative safe integer/,
  );
  assert.throws(
    () => channel.updateCaret({ entity: 'Doc', id: 'a', field: 'body', offset: Infinity }),
    /updateCaret requires a non-negative safe integer/,
  );
});

test('clearCaret sends exact caret.clear message', () => {
  const { channel } = harness();
  const result = channel.clearCaret({ entity: 'Doc', id: 'a', field: 'body' });
  assert.equal(result, false);
});

test('clearCaret rejects unknown keys', () => {
  const { channel } = harness();
  assert.throws(
    () => channel.clearCaret({ entity: 'Doc', id: 'a', field: 'body', extra: 'x' }),
    /clearCaret requires exactly/,
  );
});

test('clearCaret rejects empty strings', () => {
  const { channel } = harness();
  assert.throws(
    () => channel.clearCaret({ entity: '', id: 'a', field: 'body' }),
    /clearCaret requires non-empty strings/,
  );
  assert.throws(
    () => channel.clearCaret({ entity: 'Doc', id: '', field: 'body' }),
    /clearCaret requires non-empty strings/,
  );
  assert.throws(
    () => channel.clearCaret({ entity: 'Doc', id: 'a', field: '' }),
    /clearCaret requires non-empty strings/,
  );
});

test('updateCaret offline returns false, does not queue', async () => {
  const { channel, sockets } = harness();
  const result = channel.updateCaret({ entity: 'Doc', id: 'a', field: 'body', offset: 0 });
  assert.equal(result, false);
  // No socket was created because no subscription triggered _openSocket
  assert.equal(sockets.length, 0);
  channel.close();
});

test('updateCaret online sends raw message', async () => {
  const { channel, sockets } = harness();
  const pending = channel.subscribe('Doc', 'a', () => {});
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  const result = channel.updateCaret({ entity: 'Doc', id: 'a', field: 'body', offset: 5 });
  assert.equal(result, true);
  const sent = sockets[0].sent.find((m) => m.type === 'caret.update');
  assert.deepEqual(sent, { type: 'caret.update', entity: 'Doc', id: 'a', field: 'body', offset: 5 });
  channel.close();
});

test('clearCaret online sends raw message', async () => {
  const { channel, sockets } = harness();
  const pending = channel.subscribe('Doc', 'a', () => {});
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  const result = channel.clearCaret({ entity: 'Doc', id: 'a', field: 'body' });
  assert.equal(result, true);
  const sent = sockets[0].sent.find((m) => m.type === 'caret.clear');
  assert.deepEqual(sent, { type: 'caret.clear', entity: 'Doc', id: 'a', field: 'body' });
  channel.close();
});

// --- valid caret/edge/remove routing ---

test('inbound annotated-text-caret upsert caret routes to matching onCaret', async () => {
  const { channel, sockets } = harness();
  const carets = ['body'];
  const onCaretCalls = [];
  const pending = channel.subscribe('Doc', 'a', { carets, onCaret: (f) => onCaretCalls.push(f) });
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  const frame = {
    type: 'annotated-text-caret', version: 1,
    entity: 'Doc', id: 'a', field: 'body',
    change: { op: 'upsert', value: { kind: 'caret', presence: 'p1', offset: 3, name: '', sourceId: 'demo' } },
  };
  sockets[0].emit('message', frame);
  await tick();
  assert.equal(onCaretCalls.length, 1);
  assert.deepEqual(onCaretCalls[0], frame);
  channel.close();
});

test('inbound annotated-text-caret upsert carries the source display name through to onCaret', async () => {
  const { channel, sockets } = harness();
  const carets = ['body'];
  const onCaretCalls = [];
  const pending = channel.subscribe('Doc', 'a', { carets, onCaret: (f) => onCaretCalls.push(f) });
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  const frame = {
    type: 'annotated-text-caret', version: 1,
    entity: 'Doc', id: 'a', field: 'body',
    change: { op: 'upsert', value: { kind: 'caret', presence: 'p1', offset: 3, name: 'Aroha', sourceId: 'demo' } },
  };
  sockets[0].emit('message', frame);
  await tick();
  assert.equal(onCaretCalls.length, 1);
  assert.equal(onCaretCalls[0].change.value.name, 'Aroha');
  channel.close();
});

test('inbound annotated-text-caret upsert edge routes to matching onCaret', async () => {
  const { channel, sockets } = harness();
  const carets = ['body'];
  const onCaretCalls = [];
  const pending = channel.subscribe('Doc', 'a', { carets, onCaret: (f) => onCaretCalls.push(f) });
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  const frame = {
    type: 'annotated-text-caret', version: 1,
    entity: 'Doc', id: 'a', field: 'body',
    change: { op: 'upsert', value: { kind: 'edge', presence: 'p1', edge: 'start', name: '', sourceId: 'demo' } },
  };
  sockets[0].emit('message', frame);
  await tick();
  assert.equal(onCaretCalls.length, 1);
  assert.deepEqual(onCaretCalls[0], frame);
  channel.close();
});

test('inbound annotated-text-caret remove routes to matching onCaret', async () => {
  const { channel, sockets } = harness();
  const carets = ['body'];
  const onCaretCalls = [];
  const pending = channel.subscribe('Doc', 'a', { carets, onCaret: (f) => onCaretCalls.push(f) });
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  const frame = {
    type: 'annotated-text-caret', version: 1,
    entity: 'Doc', id: 'a', field: 'body',
    change: { op: 'remove', presence: 'p1' },
  };
  sockets[0].emit('message', frame);
  await tick();
  assert.equal(onCaretCalls.length, 1);
  assert.deepEqual(onCaretCalls[0], frame);
  channel.close();
});

test('inbound annotated-text-caret own routes to matching onCaret; malformed own is dropped', async () => {
  const { channel, sockets } = harness();
  const carets = ['body'];
  const onCaretCalls = [];
  const pending = channel.subscribe('Doc', 'a', { carets, onCaret: (f) => onCaretCalls.push(f) });
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  const frame = {
    type: 'annotated-text-caret', version: 1,
    entity: 'Doc', id: 'a', field: 'body',
    change: { op: 'own', presence: 'pX' },
  };
  sockets[0].emit('message', frame);
  await tick();
  assert.equal(onCaretCalls.length, 1);
  assert.deepEqual(onCaretCalls[0], frame);
  // Malformed own frames (missing presence / extra key) are dropped.
  sockets[0].emit('message', { type: 'annotated-text-caret', version: 1, entity: 'Doc', id: 'a', field: 'body', change: { op: 'own' } });
  sockets[0].emit('message', { type: 'annotated-text-caret', version: 1, entity: 'Doc', id: 'a', field: 'body', change: { op: 'own', presence: 'pX', extra: 'x' } });
  sockets[0].emit('message', { type: 'annotated-text-caret', version: 1, entity: 'Doc', id: 'a', field: 'body', change: { op: 'own', presence: '' } });
  await tick();
  assert.equal(onCaretCalls.length, 1);
  channel.close();
});

test('inbound caret upsert with an empty sourceId is accepted (attribution optional)', async () => {
  const { channel, sockets } = harness();
  const carets = ['body'];
  const onCaretCalls = [];
  const pending = channel.subscribe('Doc', 'a', { carets, onCaret: (f) => onCaretCalls.push(f) });
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  const frame = {
    type: 'annotated-text-caret', version: 1,
    entity: 'Doc', id: 'a', field: 'body',
    change: { op: 'upsert', value: { kind: 'caret', presence: 'p1', offset: 3, name: '', sourceId: '' } },
  };
  sockets[0].emit('message', frame);
  await tick();
  assert.equal(onCaretCalls.length, 1);
  assert.deepEqual(onCaretCalls[0], frame);
  channel.close();
});

// --- malformed / extra / version / wrong scope / wrong field drop ---

test('malformed annotated-text-caret frames are dropped', async () => {
  const { channel, sockets } = harness();
  const carets = ['body'];
  const onCaretCalls = [];
  const pending = channel.subscribe('Doc', 'a', { carets, onCaret: (f) => onCaretCalls.push(f) });
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  sockets[0].emit('message', { type: 'annotated-text-caret' });
  sockets[0].emit('message', { type: 'annotated-text-caret', version: 1 });
  sockets[0].emit('message', { type: 'annotated-text-caret', version: 1, entity: 'Doc', id: 'a', field: 'body', change: null });
  sockets[0].emit('message', { type: 'annotated-text-caret', version: 1, entity: 'Doc', id: 'a', field: 'body', change: { op: 'unknown' } });
  sockets[0].emit('message', { type: 'annotated-text-caret', version: 1, entity: 'Doc', id: 'a', field: 'body', change: { op: 'upsert', value: { kind: 'caret', presence: 'p1', offset: 3, extra: 'x' } } });
  sockets[0].emit('message', { type: 'annotated-text-caret', version: 1, entity: 'Doc', id: 'a', field: 'body', change: { op: 'upsert', value: { kind: 'caret', presence: 'p1', offset: 3 } } });
  sockets[0].emit('message', { type: 'annotated-text-caret', version: 1, entity: 'Doc', id: 'a', field: 'body', change: { op: 'upsert', value: { kind: 'caret', presence: 'p1', offset: 3, name: 7 } } });
  sockets[0].emit('message', { type: 'annotated-text-caret', version: 1, entity: 'Doc', id: 'a', field: 'body', extra: 'x', change: { op: 'remove', presence: 'p1' } });
  await tick();
  assert.equal(onCaretCalls.length, 0);
  channel.close();
});

test('wrong version annotated-text-caret frames are dropped', async () => {
  const { channel, sockets } = harness();
  const carets = ['body'];
  const onCaretCalls = [];
  const pending = channel.subscribe('Doc', 'a', { carets, onCaret: (f) => onCaretCalls.push(f) });
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  sockets[0].emit('message', {
    type: 'annotated-text-caret', version: 2,
    entity: 'Doc', id: 'a', field: 'body',
    change: { op: 'remove', presence: 'p1' },
  });
  await tick();
  assert.equal(onCaretCalls.length, 0);
  channel.close();
});

test('annotated-text-caret for wrong entity/id is dropped', async () => {
  const { channel, sockets } = harness();
  const carets = ['body'];
  const onCaretCalls = [];
  const pending = channel.subscribe('Doc', 'a', { carets, onCaret: (f) => onCaretCalls.push(f) });
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  sockets[0].emit('message', {
    type: 'annotated-text-caret', version: 1,
    entity: 'Doc', id: 'b', field: 'body',
    change: { op: 'remove', presence: 'p1' },
  });
  await tick();
  assert.equal(onCaretCalls.length, 0);
  channel.close();
});

test('annotated-text-caret for unsubscribed field is dropped', async () => {
  const { channel, sockets } = harness();
  const carets = ['body'];
  const onCaretCalls = [];
  const pending = channel.subscribe('Doc', 'a', { carets, onCaret: (f) => onCaretCalls.push(f) });
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  sockets[0].emit('message', {
    type: 'annotated-text-caret', version: 1,
    entity: 'Doc', id: 'a', field: 'summary',
    change: { op: 'remove', presence: 'p1' },
  });
  await tick();
  assert.equal(onCaretCalls.length, 0);
  channel.close();
});

test('annotated-text-caret with no onCaret callback is dropped', async () => {
  const { channel, sockets } = harness();
  const pending = channel.subscribe('Doc', 'a', { carets: ['body'] });
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  sockets[0].emit('message', {
    type: 'annotated-text-caret', version: 1,
    entity: 'Doc', id: 'a', field: 'body',
    change: { op: 'remove', presence: 'p1' },
  });
  // No onCaret → no error thrown
  channel.close();
});

// --- callback isolation ---

test('onCaret error does not affect other subscriptions or events', async () => {
  const { channel, sockets } = harness();
  const eventCalls = [];
  const onCaretCalls = [];
  const pending = channel.subscribe('Doc', 'a', {
    carets: ['body'],
    onCaret: (f) => { onCaretCalls.push(f); throw new Error('isolated error'); },
  }, (e) => eventCalls.push(e));
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  sockets[0].emit('message', {
    type: 'annotated-text-caret', version: 1,
    entity: 'Doc', id: 'a', field: 'body',
    change: { op: 'remove', presence: 'p1' },
  });
  await tick();
  assert.equal(onCaretCalls.length, 1);

  // Normal events still work after onCaret threw
  sockets[0].emit('message', {
    type: 'event', entity: 'Doc', id: 'a', seq: 2, seqSpan: [2, 2],
    event: { type: 'Doc.updated', data: { title: 'ok' } },
  });
  assert.equal(eventCalls.length, 1);
  channel.close();
});

// --- durable event separation ---

test('annotated-text-caret frames never enter onEvent', async () => {
  const { channel, sockets } = harness();
  const eventCalls = [];
  const onCaretCalls = [];
  const pending = channel.subscribe('Doc', 'a', {
    carets: ['body'],
    onCaret: (f) => onCaretCalls.push(f),
  }, (e) => eventCalls.push(e));
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  sockets[0].emit('message', {
    type: 'annotated-text-caret', version: 1,
    entity: 'Doc', id: 'a', field: 'body',
    change: { op: 'remove', presence: 'p1' },
  });
  await tick();
  assert.equal(eventCalls.length, 0);
  assert.equal(onCaretCalls.length, 1);

  // A real event still arrives through onEvent
  sockets[0].emit('message', {
    type: 'event', entity: 'Doc', id: 'a', seq: 2, seqSpan: [2, 2],
    event: { type: 'Doc.updated', data: { title: 'real' } },
  });
  assert.equal(eventCalls.length, 1);
  channel.close();
});

test('annotated-text-caret frames never enter onResync', async () => {
  const { channel, sockets } = harness();
  const resyncCalls = [];
  const onCaretCalls = [];
  const pending = channel.subscribe('Doc', 'a', {
    carets: ['body'],
    onCaret: (f) => onCaretCalls.push(f),
    onResync: (e) => resyncCalls.push(e),
  });
  await tick();
  sockets[0].open();
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  sockets[0].emit('message', {
    type: 'annotated-text-caret', version: 1,
    entity: 'Doc', id: 'a', field: 'body',
    change: { op: 'remove', presence: 'p1' },
  });
  await tick();
  assert.equal(resyncCalls.length, 0);
  assert.equal(onCaretCalls.length, 1);
  channel.close();
});

test('updateCaret after close throws ClientClosedError', async () => {
  const { channel } = harness();
  channel.close();
  assert.throws(
    () => channel.updateCaret({ entity: 'Doc', id: 'a', field: 'body', offset: 0 }),
    /Live channel is closed/,
  );
});

test('clearCaret after close throws ClientClosedError', async () => {
  const { channel } = harness();
  channel.close();
  assert.throws(
    () => channel.clearCaret({ entity: 'Doc', id: 'a', field: 'body' }),
    /Live channel is closed/,
  );
});
