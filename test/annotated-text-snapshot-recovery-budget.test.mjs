import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLiveDeliverySession } from '../public/workbench-client.mjs';

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await wait(0);
}

function createBudgetClient({ bootstrapImpl, subscribeImpl } = {}) {
  let deliverBatch;
  let bootstraps = 0;
  let latestSeq = 0;
  const snapshotCalls = [];
  let closeTransport;
  const session = createLiveDeliverySession({
    bootstrap: async (request) => {
      bootstraps += 1;
      snapshotCalls.push(request);
      if (bootstrapImpl) return bootstrapImpl(request, bootstraps);
      return {
        kind: 'snapshot',
        snapshot: { id: 'n1', title: `snap-${bootstraps}` },
        cursor: latestSeq,
      };
    },
    subscribe: async ({ deliver, closed }) => {
      deliverBatch = deliver;
      closeTransport = closed;
      if (subscribeImpl) return subscribeImpl({ deliver, closed });
      return { close() {} };
    },
    validateSnapshot: (snapshot) => snapshot,
    fold: (snapshot) => snapshot,
    optimistic: (snapshot) => snapshot,
    sendAction: async () => ({ ok: true, actionId: 'a1', confirmedThrough: 1 }),
    createActionId: (() => { let n = 0; return () => `op-${++n}`; })(),
  });
  return {
    session,
    bootstraps: () => bootstraps,
    snapshotCalls: () => snapshotCalls,
    deliver: async (envelopes) => {
      latestSeq = Math.max(latestSeq, ...envelopes.map((envelope) => envelope.seq ?? 0));
      return deliverBatch(envelopes);
    },
    closeTransport: () => closeTransport?.(),
  };
}

function control(seq) {
  return { type: 'resync', entity: 'Note', id: 'n1', seq, reason: 'annotated-text-snapshot-required' };
}

test('no-reconnect burst of 50 controls performs at most four bootstraps', async () => {
  const { session, bootstraps, deliver } = createBudgetClient();
  await session.ready;
  const initial = bootstraps();
  await deliver(Array.from({ length: 50 }, (_, index) => control(index + 1)));
  await flush();
  if (bootstraps() - initial > 4) throw new Error('snapshot recovery exceeded four attempts in one cycle');
  session.close();
});

test('one reconnect during a burst performs at most eight total bootstraps', async () => {
  const { session, bootstraps, deliver, closeTransport } = createBudgetClient();
  await session.ready;
  const initial = bootstraps();
  const first = deliver(Array.from({ length: 25 }, (_, index) => control(index + 1)));
  closeTransport();
  await first.catch(() => {});
  await flush();
  await deliver(Array.from({ length: 25 }, (_, index) => control(index + 26)));
  await flush();
  if (bootstraps() - initial > 8) throw new Error('snapshot recovery exceeded four attempts in one cycle');
  session.close();
});

test('the fourth failed attempt becomes unavailable with budget exhausted', async () => {
  let attempts = 0;
  const { session, bootstraps } = createBudgetClient({
    bootstrapImpl: async (request) => {
      if (request.mode === 'snapshot' && attempts++ > 0) return { kind: 'retry' };
      return { kind: 'snapshot', snapshot: { id: 'n1', title: 'ok' }, cursor: 0 };
    },
  });
  await session.ready;
  session.dispatch('Note.update', { title: 'x' }).catch(() => {});
  await flush();
  // Force recovery after the successful start snapshot.
  const client = createBudgetClient({
    bootstrapImpl: async (_request, count) => {
      if (count > 4) throw new Error('snapshot recovery exceeded four attempts in one cycle');
      return { kind: 'retry' };
    },
  });
  await client.session.ready.catch((error) => {
    if (error?.message === 'snapshot recovery exceeded four attempts in one cycle') throw error;
  });
  await flush();
  if (client.bootstraps() > 4) throw new Error('snapshot recovery exceeded four attempts in one cycle');
  assert.equal(client.session.status, 'unavailable');
  const exhausted = [];
  const failing = createBudgetClient({
    bootstrapImpl: async (_request, count) => {
      exhausted.push(count);
      if (count > 4) throw new Error('snapshot recovery exceeded four attempts in one cycle');
      return { kind: 'retry' };
    },
  });
  await failing.session.ready.catch((error) => {
    if (error?.message === 'snapshot recovery exceeded four attempts in one cycle') throw error;
  });
  await flush();
  if (failing.bootstraps() > 4) throw new Error('snapshot recovery exceeded four attempts in one cycle');
  assert.equal(failing.session.status, 'unavailable');
  assert.equal(failing.bootstraps(), 4);
  session.close();
  client.session.close();
  failing.session.close();
  void bootstraps;
});

test('a successful snapshot covering the latest raised floor ends the cycle', async () => {
  let cursor = 0;
  const { session, bootstraps, deliver } = createBudgetClient({
    bootstrapImpl: async (request) => {
      if (request.mode !== 'snapshot') return { kind: 'snapshot', snapshot: { id: 'n1' }, cursor };
      cursor = 50;
      return { kind: 'snapshot', snapshot: { id: 'n1', title: 'covered' }, cursor };
    },
  });
  await session.ready;
  const afterStart = bootstraps();
  await deliver([{ type: 'resync', entity: 'Note', id: 'n1', seq: 10, reason: 'annotated-text-snapshot-required' }]);
  await deliver([{ type: 'resync', entity: 'Note', id: 'n1', seq: 50, reason: 'annotated-text-snapshot-required' }]);
  await flush();
  assert.equal(session.cursor, 50);
  assert.ok(bootstraps() - afterStart <= 2);
  session.close();
});

test('the first recovery control fences its bootstrap at the control sequence', async () => {
  let initialized = false;
  const { session, bootstraps, deliver } = createBudgetClient({
    bootstrapImpl: async (request) => {
      if (!initialized) {
        initialized = true;
        return { kind: 'snapshot', snapshot: { id: 'n1', title: 'initial' }, cursor: 0 };
      }
      assert.equal(request.mode, 'snapshot');
      return { kind: 'snapshot', snapshot: { id: 'n1', title: 'below-floor' }, cursor: 9 };
    },
  });
  await session.ready;
  await deliver([control(10)]).catch(() => {});
  await flush();
  assert.equal(session.snapshot.title, 'initial');
  assert.equal(session.cursor, 0);
  assert.ok(bootstraps() <= 5, 'initial bootstrap plus one bounded recovery cycle');
  session.close();
});

test('late results from a cancelled reconnect generation do not install state', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let first = true;
  const { session, closeTransport } = createBudgetClient({
    bootstrapImpl: async (request, count) => {
      if (first && request.mode === 'snapshot') {
        first = false;
        return { kind: 'snapshot', snapshot: { id: 'n1', title: 'initial' }, cursor: 0 };
      }
      if (count === 2) {
        await blocked;
        return { kind: 'snapshot', snapshot: { id: 'n1', title: 'stale-generation' }, cursor: 99 };
      }
      return { kind: 'snapshot', snapshot: { id: 'n1', title: `snap-${count}` }, cursor: 1 };
    },
  });
  await session.ready;
  assert.equal(session.snapshot.title, 'initial');
  const delivered = session.dispatch('Note.update', { title: 'pending' });
  void delivered;
  await flush();
  closeTransport();
  release();
  await flush();
  assert.notEqual(session.snapshot?.title, 'stale-generation');
  session.close();
});

test('close cancels an in-flight recovery cycle', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { session } = createBudgetClient({
    bootstrapImpl: async (request) => {
      if (request.mode === 'snapshot') await blocked;
      return { kind: 'snapshot', snapshot: { id: 'n1' }, cursor: 0 };
    },
  });
  const ready = session.ready.catch(() => {});
  session.close();
  release();
  await ready;
  assert.notEqual(session.status, 'unavailable');
});
