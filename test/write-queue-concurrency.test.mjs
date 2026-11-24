// Priority 4 — the writeQueue serializes concurrent in-flight mutations (D9,
// eng-review spec #6). A durable dispatch holds BEGIN→…→COMMIT open across an
// async afterProjection admission step (the in-txn create row-grant); without a
// single-writer mutex, a second concurrent mutation would BEGIN on the open
// connection → "cannot start a transaction within a transaction" → 500. With the
// writeQueue, the second waits for the first to COMMIT, then proceeds. This is
// the integration guard over the already-unit-tested write-queue module.

import { text, ref, scope, grant, read, write, subscribe } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity } from '../build/internal.mjs';
import { createServer } from '../build/pipeline.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';

function ownedNote() {
  return entity('Note', {
        body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

test('writeQueue: concurrent in-flight creates all commit (no BEGIN-on-open-txn 500)', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  const N = 8;
  const responses = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      fetch(`${base}/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: `concurrent-${i}` }),
      }),
    ),
  );
  const statuses = responses.map((r) => r.status);
  assert.deepEqual(statuses, Array(N).fill(201), `all ${N} concurrent creates commit; got ${JSON.stringify(statuses)}`);

  const ids = await Promise.all(responses.map((r) => r.json().then((b) => b.id)));
  assert.equal(new Set(ids).size, N, 'each create minted a distinct id');

  const rows = db.prepare("SELECT * FROM _Log WHERE eventType = 'Note.created'").all();
  assert.equal(rows.length, N, 'every concurrent create appended a committed event');
});

// The pre-handler dedupe is outside the writeQueue, so two simultaneous retries
// can both see "no receipt" before either commits. The loser must settle inside
// the serialized transaction to the winner's stored outcome — never re-run the
// inTransaction handler or collide on the (scope, actionId) receipt PK (500).

function countedQueue() {
  const queue = createWriteQueue();
  let runs = 0;
  return {
    queue,
    runCount: () => runs,
    handle: {
      run(fn) { runs += 1; return queue.run(fn); },
      close: () => queue.close(),
      get depth() { return queue.depth; },
      get running() { return queue.running; },
      get closed() { return queue.closed; },
      get owned() { return queue.owned; },
    },
  };
}

// Gate only the outer Fork C authorize calls: the same function also runs inside
// each transaction, where `owned` is true and must not block on the barrier.
function synchronizedAuthorize(writeQueue, expectedOuters = 2) {
  let outers = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return async () => {
    if (!writeQueue.owned) {
      outers += 1;
      if (outers >= expectedOuters) release();
      await gate;
    }
    return true;
  };
}

function racingServer(writeQueue, expectedOuters = 2) {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  let handlerCalls = 0;
  const handler = ({ payload }) => {
    handlerCalls += 1;
    return [{ type: 'Note.created', scope: `Note:${payload.id}`, data: { id: payload.id } }];
  };
  handler.inTransaction = true; // runs inside the write-queue turn + txn, at most once
  const server = createServer({
    db,
    writeQueue,
    handlers: { 'Note.create': handler },
    authorize: synchronizedAuthorize(writeQueue, expectedOuters),
  });
  return { db, server, handlerCalls: () => handlerCalls };
}

test('concurrent dispatch retries with the same (scope, actionId) settle once through the provided writeQueue', async () => {
  const counted = countedQueue();
  const { db, server, handlerCalls } = racingServer(counted.handle);
  const request = {
    actionId: 'race-single', type: 'Note.create', scope: 'Note:n1',
    payload: { id: 'n1' }, principal: { id: 'u1' },
  };
  try {
    const [first, second] = await Promise.all([
      server.dispatch(request),
      server.dispatch({ ...request }),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(second.events, first.events, 'both retries report identical committed events');
    assert.equal([first.deduped, second.deduped].filter(Boolean).length, 1, 'exactly one caller commits');
    assert.equal(handlerCalls(), 1, 'inTransaction handler ran at most once (no receipt PK collision)');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _Log WHERE actionId = ?').get('race-single').n, 1);
    assert.equal(counted.runCount(), 2, 'both dispatches used the caller-provided writeQueue');
  } finally {
    db.close();
  }
});

test('concurrent dispatchBatch retries with the same (scope, actionId) recheck dedupe inside the txn', async () => {
  const counted = countedQueue();
  const { db, server, handlerCalls } = racingServer(counted.handle);
  const request = {
    actionId: 'race-batch', scope: 'Note:n2',
    actions: [{ type: 'Note.create', payload: { id: 'n2' } }],
    principal: { id: 'u1' },
  };
  try {
    const [first, second] = await Promise.all([
      server.dispatchBatch(request),
      server.dispatchBatch({ ...request, actions: [...request.actions] }),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(second.events, first.events);
    assert.equal([first.deduped, second.deduped].filter(Boolean).length, 1);
    assert.equal(handlerCalls(), 1, 'batch inTransaction handler ran at most once');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _Log WHERE actionId = ?').get('race-batch').n, 1);
    assert.equal(counted.runCount(), 2);
  } finally {
    db.close();
  }
});

test('createServer joins an already-owned writeQueue turn instead of acquiring it twice', async () => {
  const counted = countedQueue();
  const { db, server } = racingServer(counted.handle, 1);
  try {
    const outcome = await counted.handle.run(() => server.dispatch({
      actionId: 'owned-race', type: 'Note.create', scope: 'Note:n3',
      payload: { id: 'n3' }, principal: { id: 'u1' },
    }));
    assert.equal(outcome.ok, true);
    assert.equal(counted.runCount(), 1, 'the outer provided writeQueue turn was the sole mutex acquisition');
  } finally {
    db.close();
  }
});
