import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import workbench, { principal, defineOperationalEvent, operationalConsumer } from '../build/index.mjs';
import { entity } from '../build/internal.mjs';
import { text, grant, read, write, subscribe } from '../build/index.mjs';
import { operationalConsumerAdmin } from '../build/server.mjs';

function consumer(results, terminal = false) {
  return operationalConsumer({
    name: 'search.index', declarationVersion: 'v1', projectionId: 'search.v1', effectId: 'index.v1',
    event: defineOperationalEvent({ eventType: 'Note.created', fields: ['id', 'title'], project: (fields, metadata) => ({ id: fields.id, title: fields.title, event: metadata.committedEventId }) }),
    idempotencyKey: ({ metadata }) => `search:${metadata.committedEventId}`,
    handle: async (delivery) => {
      results.push(delivery);
      return terminal ? { kind: 'terminal', code: 'POISON', detail: 'bad document' } : { kind: 'ack' };
    },
  });
}

function appendLog(db, scope, seq, eventData = {}) {
  db.prepare(`INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt)
    VALUES (?, ?, 'Note.created', ?, ?, '2026-07-26T00:00:00.000Z')`)
    .run(scope, seq, JSON.stringify(eventData), `${scope}-${seq}`);
}

async function appOn(db, operationalConsumers) {
  const Note = entity('Note', { title: text(), secret: text(), grant: () => grant(read, write, subscribe) });
  const app = workbench({ db, entities: [Note], operationalConsumers });
  app.mount('/notes', app.entity('Note'));
  app.listen(0);
  await app.ready;
  return app;
}

async function appWith(t, operationalConsumers) {
  const db = new DatabaseSync(':memory:');
  const app = await appOn(db, operationalConsumers);
  t.after(async () => { await app.shutdown(); db.close(); });
  return app;
}

test('operational consumers receive only declared projected payload and trusted metadata', async (t) => {
  const delivered = [];
  const app = await appWith(t, [consumer(delivered)]);
  const outcome = await app.dispatch({ actionId: 'action-1', type: 'Note.create', payload: { id: 'n1', title: 'visible', secret: 'never exposed' }, principal: principal({ type: 'user', id: 'u1' }) });
  assert.equal(outcome.ok, true);
  assert.equal(delivered.length, 1);
  assert.deepEqual(Object.keys(delivered[0]).sort(), ['idempotencyKey', 'metadata', 'payload']);
  assert.deepEqual(delivered[0].payload, { id: 'n1', title: 'visible', event: `${outcome.events[0].scope}:1` });
  assert.equal('secret' in delivered[0].payload, false);
  assert.equal(delivered[0].metadata.actionId, 'action-1');
});

test('nested dispatch does not replay the current operational delivery before its cursor advances', async (t) => {
  const delivered = [];
  let app;
  const nested = operationalConsumer({
    name: 'nested.dispatch',
    declarationVersion: 'v1',
    projectionId: 'nested.v1',
    effectId: 'nested.index.v1',
    event: defineOperationalEvent({
      eventType: 'Note.created',
      fields: ['id', 'title'],
      project: (fields, metadata) => ({ id: fields.id, title: fields.title, event: metadata.committedEventId })
    }),
    idempotencyKey: ({ metadata }) => `nested:${metadata.committedEventId}`,
    handle: async (delivery) => {
      delivered.push(delivery);
      if (delivered.length === 1) {
        const result = await app.dispatch({
          actionId: 'nested-action',
          type: 'Note.create',
          payload: { id: 'nested-note', title: 'nested', secret: 'hidden' },
          principal: principal({ type: 'user', id: 'u1' })
        });
        assert.equal(result.ok, true);
      }
      return { kind: 'ack' };
    }
  });
  app = await appWith(t, [nested]);

  const outcome = await app.dispatch({
    actionId: 'outer-action',
    type: 'Note.create',
    payload: { id: 'outer-note', title: 'outer', secret: 'hidden' },
    principal: principal({ type: 'user', id: 'u1' })
  });

  assert.equal(outcome.ok, true);
  assert.deepEqual(delivered.map(({ payload }) => payload.id), ['outer-note', 'nested-note']);
});

test('terminal failures block progress until the sole retryFailure transition', async (t) => {
  const delivered = [];
  const app = await appWith(t, [consumer(delivered, true)]);
  await app.dispatch({ actionId: 'action-2', type: 'Note.create', payload: { id: 'n2', title: 'poison', secret: 'x' }, principal: principal({ type: 'user', id: 'u1' }) });
  const admin = operationalConsumerAdmin(app);
  const failures = await admin.listFailures('search.index');
  assert.equal(failures.length, 1);
  await admin.retryFailure(failures[0]);
  assert.equal(delivered.length, 2, 'retry replays the same durable record');
});

test('a failed scope blocks only its later records', async (t) => {
  const delivered = [];
  let failed = true;
  const scoped = operationalConsumer({
    ...consumer(delivered),
    handle: async (delivery) => {
      delivered.push(delivery);
      if (delivery.metadata.scopeId === 'a' && failed) {
        failed = false;
        return { kind: 'terminal', code: 'POISON', detail: 'bad document' };
      }
      return { kind: 'ack' };
    },
  });
  const app = await appWith(t, [scoped]);
  appendLog(app.db, 'a', 1, { id: 'a1', title: 'blocked' });
  appendLog(app.db, 'a', 2, { id: 'a2', title: 'later' });
  appendLog(app.db, 'b', 1, { id: 'b1', title: 'independent' });
  await app.writeQueue.run(() => app.reconcileOperationalConsumers());
  assert.deepEqual(delivered.map(({ metadata }) => metadata.committedEventId), ['a:1', 'b:1']);
});

test('idle retry is delivered after its durable deadline', async (t) => {
  const delivered = [];
  let attempts = 0;
  const scoped = operationalConsumer({
    ...consumer(delivered),
    handle: async (delivery) => {
      delivered.push(delivery);
      attempts++;
      return attempts === 1 ? { kind: 'retry', afterMs: 20, detail: 'try again' } : { kind: 'ack' };
    },
  });
  const app = await appWith(t, [scoped]);
  appendLog(app.db, 'a', 1, { id: 'a1', title: 'retry' });
  await app.writeQueue.run(() => app.reconcileOperationalConsumers());
  assert.equal(delivered.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(delivered.length, 2);
  assert.equal(app.db.prepare('SELECT status FROM _OperationalConsumerFailure').get(), undefined);
});

test('admin lists durable retry state with the persisted deadline and no failure detail', async (t) => {
  const delivered = [];
  const scoped = operationalConsumer({
    ...consumer(delivered),
    handle: async (delivery) => {
      delivered.push(delivery);
      return { kind: 'retry', code: 'canonical-unavailable', afterMs: 60_000, detail: 'private exception text' };
    },
  });
  const app = await appWith(t, [scoped]);
  appendLog(app.db, 'a', 1, { id: 'a1', title: 'retry' });
  await app.writeQueue.run(() => app.reconcileOperationalConsumers());

  const retries = await operationalConsumerAdmin(app).listRetries('search.index');
  assert.equal(retries.length, 1);
  assert.deepEqual(Object.keys(retries[0]).sort(), ['code', 'committedEventId', 'consumer', 'nextAttemptAt', 'scopeId', 'status']);
  assert.deepEqual({ ...retries[0] }, {
    consumer: 'search.index', scopeId: 'a', committedEventId: 'a:1', code: 'canonical-unavailable',
    status: 'retry', nextAttemptAt: retries[0].nextAttemptAt,
  });
  assert.equal(retries[0].nextAttemptAt >= Date.now() + 59_000, true);
  assert.equal(JSON.stringify(retries).includes('private exception text'), false);
  const stored = app.db.prepare('SELECT detail FROM _OperationalConsumerFailure').get();
  assert.equal(stored.detail, 'The consumer could not read its canonical evidence.');
});

test('retry reason codes are allowlisted and fractional delays round up', async (t) => {
  const reasons = ['invalid-event', 'invariant-violation', 'consumer-error'];
  for (const reason of reasons) {
    const delivered = [];
    const scoped = operationalConsumer({
      ...consumer(delivered),
      handle: async () => ({ kind: 'retry', code: reason, afterMs: 10.7 }),
    });
    const app = await appWith(t, [scoped]);
    appendLog(app.db, 'reason', 1, { id: 'reason-note', title: 'reason' });
    await app.writeQueue.run(() => app.reconcileOperationalConsumers());
    const [retry] = await operationalConsumerAdmin(app).listRetries('search.index');
    assert.equal(retry.code, reason);
    assert.equal(Number.isInteger(retry.nextAttemptAt), true);
    assert.equal(retry.nextAttemptAt >= Date.now() + 10, true);
  }
});

test('terminal detail is a fixed description, never the consumer payload', async (t) => {
  const app = await appWith(t, [consumer([], true)]);
  appendLog(app.db, 'terminal', 1, { id: 'terminal-note', title: 'poison' });
  await app.writeQueue.run(() => app.reconcileOperationalConsumers());
  const [failure] = await operationalConsumerAdmin(app).listFailures('search.index');
  assert.equal(failure.code, 'POISON');
  assert.equal(failure.detail, 'The consumer reported a terminal failure.');
  assert.equal(failure.detail.includes('bad document'), false);
});

test('retry inventory survives app restart and clears after automatic redelivery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-operational-retry-'));
  const db = new DatabaseSync(join(directory, 'data.sqlite'));
  const delivered = [];
  let attempts = 0;
  const scoped = operationalConsumer({
    ...consumer(delivered),
    handle: async (delivery) => {
      delivered.push(delivery);
      attempts++;
      return attempts === 1
        ? { kind: 'retry', code: 'canonical-unavailable', afterMs: 40, detail: 'private diagnostic' }
        : { kind: 'ack' };
    },
  });
  let app;
  try {
    app = await appOn(db, [scoped]);
    appendLog(app.db, 'restart-scope', 1, { id: 'restart-note', title: 'retry' });
    await app.writeQueue.run(() => app.reconcileOperationalConsumers());
    const beforeRestart = await operationalConsumerAdmin(app).listRetries('search.index');
    assert.equal(beforeRestart.length, 1);
    assert.equal(beforeRestart[0].code, 'canonical-unavailable');
    const eligibility = beforeRestart[0].nextAttemptAt;
    await app.shutdown();
    app = undefined;

    await new Promise((resolve) => setTimeout(resolve, Math.max(0, eligibility - Date.now()) + 10));
    app = await appOn(db, [scoped]);
    assert.equal(delivered.length, 2, 'startup recovery redelivers the same event after its stored deadline');
    assert.deepEqual(await operationalConsumerAdmin(app).listRetries('search.index'), []);
  } finally {
    if (app) await app.shutdown();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('shutdown cancels a scheduled idle retry', async (t) => {
  const delivered = [];
  const scoped = operationalConsumer({
    ...consumer(delivered),
    handle: async (delivery) => {
      delivered.push(delivery);
      return { kind: 'retry', afterMs: 30, detail: 'wait' };
    },
  });
  const app = await appWith(t, [scoped]);
  appendLog(app.db, 'a', 1, { id: 'a1', title: 'retry' });
  await app.writeQueue.run(() => app.reconcileOperationalConsumers());
  assert.equal(delivered.length, 1);
  await app.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(delivered.length, 1);
});

test('changed declarations under the same operational name fail closed', async () => {
  const db = new DatabaseSync(':memory:');
  const Note = entity('Note', { title: text(), grant: () => grant(read, write, subscribe) });
  const first = workbench({ db, entities: [Note], operationalConsumers: [consumer([])] });
  first.mount('/notes', first.entity('Note'));
  await first.start();
  await first.shutdown();
  const changed = operationalConsumer({ ...consumer([]), effectId: 'index.v2' });
  const second = workbench({ db, entities: [Note], operationalConsumers: [changed] });
  second.mount('/notes', second.entity('Note'));
  await assert.rejects(second.start(), /declaration changed/);
  db.close();
});
