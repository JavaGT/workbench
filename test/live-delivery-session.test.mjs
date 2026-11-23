import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveDeliverySession } from '../public/workbench-client.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setup({ bootstrap, fold: foldImpl, optimistic: optimisticImpl, subscribe: subscribeImpl, validateSnapshot: validateSnapshotImpl, sendAction } = {}) {
  let delivery;
  let revoke;
  let subscribedAfter;
  let closed = false;
  const session = createLiveDeliverySession({
    bootstrap: bootstrap ?? (async () => ({ kind: 'snapshot', snapshot: { values: [] }, cursor: 1 })),
    subscribe: subscribeImpl ?? (async ({ after, deliver, revoke: revokeDelivery }) => {
      subscribedAfter = after;
      delivery = deliver;
      revoke = revokeDelivery;
      return { close() { closed = true; } };
    }),
    validateSnapshot: validateSnapshotImpl ?? function validateSnapshot(snapshot) { return snapshot; },
    fold: foldImpl ?? function fold(snapshot, envelope) {
      return { values: [...snapshot.values, envelope.event.data.value] };
    },
    optimistic: optimisticImpl ?? function optimistic(snapshot, action) {
      return { values: [...snapshot.values, `pending:${action.payload.value}`] };
    },
    sendAction: sendAction ?? (async () => ({ ok: true })),
    createActionId: () => 'own-action',
  });
  return {
    session,
    deliver: async (envelopes) => delivery(envelopes),
    revoke: (reason) => revoke(reason),
    subscribedAfter: () => subscribedAfter,
    closed: () => closed,
  };
}

function event(seq, value, actionId = `a${seq}`) {
  return {
    type: 'event', seq, seqSpan: [seq, seq],
    event: { type: 'Value.updated', data: { value }, actionId },
  };
}

describe('LiveDeliverySession', () => {
  it('pairs the validated snapshot with its cursor before subscribing', async () => {
    const { session, subscribedAfter } = setup();
    await session.ready;

    assert.equal(session.cursor, 1);
    assert.deepEqual(session.snapshot, { values: [] });
    assert.equal(subscribedAfter(), 1);
    session.close();
  });

  it('validates a live state replacement with its delivery envelope before publishing', async () => {
    const published = [];
    const deliveries = [];
    const { session, deliver } = setup({
      bootstrap: async () => ({ kind: 'snapshot', snapshot: { values: ['seed'] }, cursor: 1, authoring: { family: 'family-1' } }),
      validateSnapshot(snapshot, delivery) {
        deliveries.push(delivery);
        assert.ok(delivery?.authoring, 'document and authoring family arrive in one validation turn');
        return { ...snapshot, family: delivery.authoring.family };
      },
    });
    session.subscribe((snapshot) => published.push(snapshot));
    await session.ready;

    await deliver([{
      type: 'state', entity: 'Doc', id: 'd1', seq: 2, cursor: 2,
      state: { values: ['annotation'] }, authoring: { family: 'family-2' },
    }]);

    assert.equal(deliveries.length, 2);
    assert.deepEqual(published.at(-1), { values: ['annotation'], family: 'family-2' });
    assert.equal(published.some((snapshot) => snapshot && snapshot.family == null), false);
    session.close();
  });

  it('fails closed to snapshot recovery when a live state replacement is malformed', async () => {
    let recoveries = 0;
    let receive;
    const recoverySession = createLiveDeliverySession({
      bootstrap: async () => ({ kind: 'snapshot', snapshot: { values: [`snap-${++recoveries}`] }, cursor: recoveries }),
      subscribe: async ({ deliver }) => { receive = deliver; return { close() {} }; },
      validateSnapshot(snapshot, delivery) {
        if (delivery?.type === 'state' && !delivery.authoring) throw new Error('missing authoring family');
        return snapshot;
      },
      sendAction: async () => ({ ok: true }),
    });
    await recoverySession.ready;
    await receive([{ type: 'state', seq: 2, cursor: 2, state: { values: ['invalid'] } }]);
    assert.equal(recoveries, 2);
    assert.deepEqual(recoverySession.snapshot, { values: ['snap-2'] });
    recoverySession.close();
  });

  it('emits one non-terminal delayed-recovery warning across managed retries', async () => {
    const warnings = [];
    let bootstraps = 0;
    const session = createLiveDeliverySession({
      bootstrap: async ({ mode }) => {
        bootstraps += 1;
        return bootstraps === 1 && mode === 'snapshot'
          ? { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 }
          : { kind: 'retry' };
      },
      subscribe: async () => ({ close() {} }),
      validateSnapshot: (snapshot) => snapshot,
      sendAction: async () => ({ ok: true }),
      recoveryWarningDelayMs: 10,
      onRecoveryDelayed: (delayed) => warnings.push(delayed),
    });
    await session.ready;
    const reconnect = session.reconnect();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(warnings, [true]);
    session.close();
    assert.deepEqual(warnings, [true, false]);
    await reconnect;
  });

  it('does not install live when the delayed-warning completion callback closes the session', async () => {
    const pendingSnapshot = deferred();
    const warnings = [];
    let signalWarning;
    const warningShown = new Promise((resolve) => { signalWarning = resolve; });
    let session;
    session = createLiveDeliverySession({
      bootstrap: () => pendingSnapshot.promise,
      subscribe: async () => ({ close() {} }),
      validateSnapshot: (snapshot) => snapshot,
      sendAction: async () => ({ ok: true }),
      recoveryWarningDelayMs: 5,
      onRecoveryDelayed: (delayed) => {
        warnings.push(delayed);
        if (delayed) signalWarning();
        else session.close();
      },
    });

    // Recovery outlives the warning delay, so `true` fires; resolving the
    // snapshot then completes the warning, and its callback closes the session
    // synchronously before recovery installs `live`.
    await warningShown;
    pendingSnapshot.resolve({ kind: 'snapshot', snapshot: { values: [] }, cursor: 1 });
    await session.ready;

    assert.deepEqual(warnings, [true, false]);
    assert.notEqual(session.status, 'live', 'a session closed by the warning completion must not report live');
    assert.equal(session.snapshot, null, 'a closed session must not publish the recovered snapshot');
  });

  it('does not install live when the delayed-warning completion callback revokes during catch-up recovery', async () => {
    const pendingCatchup = deferred();
    const warnings = [];
    let signalWarning;
    const warningShown = new Promise((resolve) => { signalWarning = resolve; });
    let signalCatchup;
    const catchupRequested = new Promise((resolve) => { signalCatchup = resolve; });
    let revokeDelivery;
    const session = createLiveDeliverySession({
      bootstrap: async ({ mode }) => {
        if (mode === 'catchup') {
          signalCatchup();
          return pendingCatchup.promise;
        }
        return { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 };
      },
      subscribe: async ({ revoke }) => {
        revokeDelivery = revoke;
        return { close() {} };
      },
      validateSnapshot: (snapshot) => snapshot,
      sendAction: async () => ({ ok: true }),
      recoveryWarningDelayMs: 5,
      onRecoveryDelayed: (delayed) => {
        warnings.push(delayed);
        if (delayed) signalWarning();
        else revokeDelivery({ code: 'access-revoked' });
      },
    });
    await session.ready;

    const reconnect = session.reconnect();
    await catchupRequested;
    await warningShown;
    pendingCatchup.resolve({ kind: 'catchup', envelopes: [], cursor: 1 });
    await reconnect;

    assert.deepEqual(warnings, [true, false]);
    assert.equal(session.status, 'revoked', 'the callback revocation must survive the settled catch-up');
    assert.equal(session.snapshot, null);
  });

  it('publishes exactly once per settled recovery with the final live status installed', async () => {
    let bootstraps = 0;
    const session = createLiveDeliverySession({
      bootstrap: async ({ mode }) => {
        bootstraps += 1;
        if (mode === 'catchup') return { kind: 'catchup', envelopes: [], cursor: 1 };
        return { kind: 'snapshot', snapshot: { values: [`snap-${bootstraps}`] }, cursor: bootstraps };
      },
      subscribe: async () => ({ close() {} }),
      validateSnapshot: (snapshot) => snapshot,
      sendAction: async () => ({ ok: true }),
    });
    await session.ready;

    // Snapshot recovery (reconnect catch-up) settles live in one publish.
    const reconnectStatuses = [];
    const unsubscribe = session.subscribe(() => reconnectStatuses.push(session.status));
    reconnectStatuses.length = 0; // drop the immediate replay subscribe() delivers
    await session.reconnect();
    assert.deepEqual(reconnectStatuses, ['live'], 'one publish per settled recovery, status live');
    unsubscribe();
    session.close();

    // A resync control drives a full snapshot recovery: exactly one publish,
    // with the final `live` status already installed (no interim publish under
    // the recovering status).
    let deliver = null;
    let snapshotBootstraps = 0;
    const resyncSession = createLiveDeliverySession({
      bootstrap: async () => {
        snapshotBootstraps += 1;
        return { kind: 'snapshot', snapshot: { values: [`snap-${snapshotBootstraps}`] }, cursor: snapshotBootstraps };
      },
      subscribe: async ({ deliver: deliverFn }) => { deliver = deliverFn; return { close() {} }; },
      validateSnapshot: (snapshot) => snapshot,
      sendAction: async () => ({ ok: true }),
    });
    await resyncSession.ready;
    const publications = [];
    resyncSession.subscribe(() => publications.push(resyncSession.status));
    publications.length = 0; // drop the immediate replay subscribe() delivers
    await deliver([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);
    assert.deepEqual(publications, ['live'], 'one publish for a settled snapshot recovery');
    resyncSession.close();
  });

  it('silently drops duplicate delivery and confirms pending work only through its echo', async () => {
    const { session, deliver } = setup();
    await session.ready;

    const dispatched = await session.dispatch('Value.add', { value: 'own' });
    assert.equal(session.pendingCount(), 1);
    await deliver([event(1, 'old')]);
    assert.deepEqual(session.snapshot, { values: ['pending:own'] });

    await deliver([event(2, 'own', dispatched.opId)]);
    assert.deepEqual(session.snapshot, { values: ['own'] });
    assert.equal(session.pendingCount(), 0);
    session.close();
  });

  it('settles a committed receipt only after its authoritative echo is folded', async () => {
    const { session, deliver } = setup();
    await session.ready;

    const dispatched = await session.dispatch('Value.add', { value: 'own' });
    let settled = false;
    void dispatched.settlement.wait().then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);

    await deliver([event(2, 'unrelated', 'other-action')]);
    await Promise.resolve();
    assert.equal(settled, false);
    await deliver([event(3, 'own', dispatched.opId)]);
    assert.deepEqual(await dispatched.settlement.wait(), { opId: dispatched.opId, status: 'reconciled' });
    assert.deepEqual(session.snapshot, { values: ['unrelated', 'own'] });
    session.close();
  });

  it('settles immediately when delivery arrives before its sender receipt', async () => {
    const receipt = deferred();
    const { session, deliver } = setup({ sendAction: () => receipt.promise });
    await session.ready;

    const dispatch = session.dispatch('Value.add', { value: 'own' });
    await deliver([event(2, 'own', 'own-action')]);
    receipt.resolve({ ok: true, cursor: 2 });
    const dispatched = await dispatch;
    assert.deepEqual(await dispatched.settlement.wait(), { opId: 'own-action', status: 'reconciled' });
    session.close();
  });

  it('cancels only one settlement waiter without changing the committed operation', async () => {
    const { session, deliver } = setup();
    await session.ready;
    const dispatched = await session.dispatch('Value.add', { value: 'own' });
    const controller = new AbortController();
    const cancelled = dispatched.settlement.wait({ signal: controller.signal });
    controller.abort();
    assert.deepEqual(await cancelled, { opId: dispatched.opId, status: 'cancelled' });
    assert.equal(session.pendingCount(), 1);

    await deliver([event(2, 'own', dispatched.opId)]);
    assert.deepEqual(await dispatched.settlement.wait(), { opId: dispatched.opId, status: 'reconciled' });
    session.close();
  });

  it('releases unsettled receipt waiters when access is revoked or the session closes', async () => {
    const revokedReceipt = deferred();
    const revoked = setup({ sendAction: () => revokedReceipt.promise });
    await revoked.session.ready;
    const pendingRevocation = revoked.session.dispatch('Value.add', { value: 'own' });
    await Promise.resolve();
    const revocationSettlement = revoked.session.operations()[0];
    revoked.revoke({ code: 'access-revoked' });
    revokedReceipt.resolve({ ok: true });
    const revokedResult = await pendingRevocation;
    assert.equal(revokedResult.settlement.opId, revocationSettlement.opId);
    assert.deepEqual(await revokedResult.settlement.wait(), { opId: revocationSettlement.opId, status: 'revoked' });

    const closeReceipt = deferred();
    const closed = setup({ sendAction: () => closeReceipt.promise });
    await closed.session.ready;
    const pendingClose = closed.session.dispatch('Value.add', { value: 'own' });
    await Promise.resolve();
    closed.session.close();
    closeReceipt.resolve({ ok: true });
    const closedResult = await pendingClose;
    assert.deepEqual(await closedResult.settlement.wait(), { opId: closedResult.opId, status: 'closed' });
  });

  it('reuses one package-owned batch action ID after an uncertain transport result', async () => {
    const sent = [];
    let attempts = 0;
    let delivery;
    const batchSession = createLiveDeliverySession({
      bootstrap: async () => ({ kind: 'snapshot', snapshot: { values: [] }, cursor: 1 }),
      subscribe: async ({ deliver }) => { delivery = deliver; return { close() {} }; },
      validateSnapshot: (snapshot) => snapshot,
      fold: (snapshot, envelope) => ({ values: [...snapshot.values, envelope.event.data.value] }),
      optimistic: (snapshot, action) => ({ values: [...snapshot.values, `pending:${action.payload.value}`] }),
      sendAction: async () => ({ ok: true }),
      sendBatch: async (batch) => {
        sent.push(batch);
        attempts += 1;
        if (attempts === 1) throw new TypeError('network response lost');
        return { ok: true, actionId: batch.actionId, cursor: 2 };
      },
      createActionId: () => 'batch-action-1',
    });
    await batchSession.ready;

    const actions = [
      { type: 'Value.add', payload: { value: 'one' } },
      { type: 'Value.add', payload: { value: 'two' } },
    ];
    const first = await batchSession.batch(actions);
    assert.equal(first.ok, false);
    assert.equal(first.status, 'outcome-unknown');
    assert.equal(first.opId, 'batch-action-1');
    assert.deepEqual(first.deliveryError, { message: 'network response lost' });
    assert.equal(batchSession.pendingCount(), 1);
    assert.deepEqual(batchSession.snapshot, { values: ['pending:one', 'pending:two'] });
    actions[0].payload.value = 'changed-after-send';
    const publicOperation = batchSession.operations()[0];
    assert.equal('batch' in publicOperation, false);
    assert.equal('actions' in publicOperation, false);

    const retry = await batchSession.retry('batch-action-1');
    assert.equal(retry.ok, true);
    assert.equal(retry.settlement, first.settlement);
    assert.equal(sent.length, 2);
    assert.equal(sent[0], sent[1], 'the package retains and resends the same frozen batch envelope');
    assert.equal(sent[1].actionId, 'batch-action-1');
    assert.equal(sent[1].actions[0].payload.value, 'one');
    assert.equal(Object.isFrozen(sent[1].actions[0].payload), true);

    await delivery([event(2, 'committed', 'batch-action-1')]);
    assert.equal(batchSession.pendingCount(), 0);
    assert.deepEqual(batchSession.snapshot, { values: ['committed'] });
    assert.deepEqual(await first.settlement.wait(), { opId: 'batch-action-1', status: 'reconciled' });
    batchSession.close();
  });

  it('retains a frozen single action envelope after an uncertain transport exception and retries it', async () => {
    const sent = [];
    let attempts = 0;
    let delivery;
    const session = createLiveDeliverySession({
      bootstrap: async () => ({ kind: 'snapshot', snapshot: { values: [] }, cursor: 1 }),
      subscribe: async ({ deliver }) => { delivery = deliver; return { close() {} }; },
      validateSnapshot: (snapshot) => snapshot,
      fold: (snapshot, envelope) => ({ values: [...snapshot.values, envelope.event.data.value] }),
      optimistic: (snapshot, action) => ({ values: [...snapshot.values, `pending:${action.payload.value}`] }),
      sendAction: async (action) => {
        sent.push(action);
        attempts += 1;
        if (attempts === 1) throw new TypeError('network response lost');
        return { ok: true, actionId: action.actionId, cursor: 2 };
      },
      createActionId: () => 'single-action-1',
    });
    await session.ready;

    const payload = { value: 'one' };
    const first = await session.dispatch('Value.add', payload);
    assert.equal(first.ok, false);
    assert.equal(first.status, 'outcome-unknown');
    assert.equal(first.opId, 'single-action-1');
    assert.deepEqual(first.deliveryError, { message: 'network response lost' });
    assert.equal(session.pendingCount(), 1);
    assert.deepEqual(session.snapshot, { values: ['pending:one'] });
    payload.value = 'changed-after-send';
    const publicOperation = session.operations()[0];
    assert.equal(publicOperation.actionId, 'single-action-1');
    assert.equal('batch' in publicOperation, false);
    assert.equal('actions' in publicOperation, false);

    const retry = await session.retry('single-action-1');
    assert.equal(retry.ok, true);
    assert.equal(retry.settlement, first.settlement);
    assert.equal(sent.length, 2);
    assert.equal(sent[0], sent[1], 'the package retains and resends the same frozen single action');
    assert.equal(sent[1].actionId, 'single-action-1');
    assert.equal(sent[1].payload.value, 'one');
    assert.equal(Object.isFrozen(sent[1].payload), true);

    await delivery([event(2, 'committed', 'single-action-1')]);
    assert.equal(session.pendingCount(), 0);
    assert.deepEqual(session.snapshot, { values: ['committed'] });
    assert.deepEqual(await first.settlement.wait(), { opId: 'single-action-1', status: 'reconciled' });
    session.close();
  });

  it('rejects retry for states other than a retained uncertain transport envelope', async () => {
    const { session } = setup({ sendAction: async () => ({ ok: true }) });
    await session.ready;

    const rejected = await session.retry('no-such-op');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 'failed-rolled-back');
    assert.equal(rejected.opId, 'no-such-op');
    assert.equal(rejected.settlement.opId, 'no-such-op');
    assert.equal(rejected.failure.message, 'operation is not awaiting transport retry');
    session.close();
  });

  it('keeps a known receipt rejection failed and rolled back without a retained retry', async () => {
    const { session, deliver } = setup({
      sendAction: async () => ({ ok: false, failure: { message: 'denied' } }),
    });
    await session.ready;

    const dispatched = await session.dispatch('Value.add', { value: 'own' });
    assert.equal(dispatched.ok, false);
    assert.equal(dispatched.status, 'failed-rolled-back');
    assert.equal(dispatched.opId, 'own-action');
    assert.equal(session.pendingCount(), 0);
    assert.deepEqual(session.snapshot, { values: [] });

    await deliver([event(2, 'own', 'own-action')]);
    assert.equal(session.pendingCount(), 0);
    assert.deepEqual(session.snapshot, { values: ['own'] });
    session.close();
  });

  it('rejects non-JSON batch payloads before retaining an envelope', async () => {
    const session = createLiveDeliverySession({
      bootstrap: async () => ({ kind: 'snapshot', snapshot: {}, cursor: 1 }),
      subscribe: async () => ({ close() {} }), validateSnapshot: (snapshot) => snapshot,
      sendAction: async () => ({ ok: true }), sendBatch: async () => ({ ok: true }),
    });
    await session.ready;
    const result = await session.batch([{ type: 'Value.add', payload: new Map() }]);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed-rolled-back');
    assert.equal(session.pendingCount(), 0);
    session.close();
  });

  it('does not transmit a batch after its optimistic projection revokes delivery', async () => {
    let revoke;
    let sent = 0;
    const session = createLiveDeliverySession({
      bootstrap: async () => ({ kind: 'snapshot', snapshot: {}, cursor: 1 }),
      subscribe: async ({ revoke: revokeDelivery }) => { revoke = revokeDelivery; return { close() {} }; },
      validateSnapshot: (snapshot) => snapshot,
      optimistic: (snapshot) => { revoke({ code: 'access-revoked' }); return snapshot; },
      sendAction: async () => ({ ok: true }), sendBatch: async () => { sent += 1; return { ok: true }; },
    });
    await session.ready;
    const result = await session.batch([{ type: 'Value.add', payload: {} }]);
    assert.equal(result.ok, false);
    assert.equal(sent, 0);
  });

  it('requires a replacement snapshot after a delayed snapshot-only receipt', async () => {
    const receipt = deferred();
    let delivery;
    let snapshots = 0;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async () => ({ kind: 'snapshot', snapshot: { version: ++snapshots }, cursor: snapshots === 1 ? 1 : 3 }),
      subscribe: async ({ deliver }) => { delivery = deliver; return { close() {} }; },
      optimistic: (snapshot) => ({ ...snapshot, pending: true }),
      sendAction: () => receipt.promise,
      createActionId: () => 'own-composite-action',
    });
    await session.ready;
    const dispatched = session.dispatch('Project.rename', {});
    await delivery([{ type: 'resync', seq: 3, reason: 'recipient-snapshot-required' }]);
    assert.deepEqual(session.snapshot, { version: 1, pending: true });
    assert.equal(snapshots, 1);
    assert.equal(session.pendingCount(), 1);

    receipt.resolve({ ok: true, actionId: 'own-composite-action', confirmedThrough: 3 });
    assert.equal((await dispatched).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(snapshots, 2);
    assert.equal(session.pendingCount(), 0);
    assert.deepEqual(session.snapshot, { version: 2 });
    session.close();
  });

  it('coalesces action and batch recovery behind every unknown snapshot-only sender', async () => {
    const actionReceipt = deferred();
    const batchReceipt = deferred();
    const actionIds = ['action-1', 'batch-1'];
    let delivery;
    let snapshots = 0;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async () => ({
        kind: 'snapshot',
        snapshot: { version: ++snapshots },
        cursor: snapshots === 1 ? 1 : 5,
      }),
      subscribe: async ({ deliver }) => { delivery = deliver; return { close() {} }; },
      optimistic: (snapshot) => ({ ...snapshot, pending: (snapshot.pending ?? 0) + 1 }),
      sendAction: () => actionReceipt.promise,
      sendBatch: () => batchReceipt.promise,
      createActionId: () => actionIds.shift(),
    });
    await session.ready;
    const dispatched = session.dispatch('Project.rename', {});
    const batched = session.batch([{ type: 'Project.describe', payload: {} }]);
    await delivery([{ type: 'resync', seq: 5, reason: 'recipient-snapshot-required' }]);
    assert.equal(snapshots, 1);
    assert.deepEqual(session.snapshot, { version: 1, pending: 2 });

    actionReceipt.resolve({ ok: true, actionId: 'action-1', confirmedThrough: 3 });
    assert.equal((await dispatched).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(snapshots, 1, 'the unresolved batch still gates the action receipt and opaque resync');

    batchReceipt.resolve({ ok: true, actionId: 'batch-1', confirmedThrough: 5 });
    const batchResult = await batched;
    assert.equal(batchResult.ok, true);
    assert.deepEqual(await batchResult.settlement.wait(), { opId: 'batch-1', status: 'reconciled' });
    assert.equal(snapshots, 2, 'all recovery requests coalesce behind the maximum receipt floor');
    assert.equal(session.pendingCount(), 0);
    assert.deepEqual(session.snapshot, { version: 2 });
    session.close();
  });

  it('recovers a snapshot-only receipt whose fence is ahead of the local cursor', async () => {
    let snapshots = 0;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async () => ({ kind: 'snapshot', snapshot: { version: ++snapshots }, cursor: snapshots === 1 ? 1 : 3 }),
      subscribe: async () => ({ close() {} }),
      optimistic: (snapshot) => ({ ...snapshot, pending: true }),
      sendAction: async () => ({ ok: true, actionId: 'own-composite-action', confirmedThrough: 3 }),
      createActionId: () => 'own-composite-action',
    });
    await session.ready;

    assert.equal((await session.dispatch('Project.rename', {})).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(snapshots, 2);
    assert.equal(session.cursor, 3);
    assert.equal(session.pendingCount(), 0);
    assert.deepEqual(session.snapshot, { version: 2 });
    session.close();
  });

  it('serializes receipt snapshot recovery before later live delivery', async () => {
    const receiptSnapshot = deferred();
    let delivery;
    let snapshots = 0;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async () => {
        snapshots += 1;
        if (snapshots === 1) return { kind: 'snapshot', snapshot: { version: 1 }, cursor: 1 };
        if (snapshots === 2) return receiptSnapshot.promise;
        return { kind: 'snapshot', snapshot: { version: 4 }, cursor: 4 };
      },
      subscribe: async ({ deliver }) => { delivery = deliver; return { close() {} }; },
      optimistic: (snapshot) => ({ ...snapshot, pending: true }),
      sendAction: async () => ({ ok: true, actionId: 'own-composite-action', confirmedThrough: 3 }),
      createActionId: () => 'own-composite-action',
    });
    await session.ready;
    await session.dispatch('Project.rename', {});
    const laterDelivery = delivery([{ type: 'resync', seq: 4, reason: 'recipient-snapshot-required' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(session.cursor, 1);

    receiptSnapshot.resolve({ kind: 'snapshot', snapshot: { version: 3 }, cursor: 3 });
    await laterDelivery;
    assert.equal(session.cursor, 4);
    assert.deepEqual(session.snapshot, { version: 4 });
    session.close();
  });

  it('retries receipt recovery after reconnect supersedes its snapshot', async () => {
    const receiptSnapshot = deferred();
    const calls = [];
    let snapshots = 0;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async ({ mode }) => {
        calls.push(mode);
        if (mode === 'catchup') return { kind: 'catchup', envelopes: [], cursor: 1 };
        snapshots += 1;
        if (snapshots === 1) return { kind: 'snapshot', snapshot: { version: 1 }, cursor: 1 };
        if (snapshots === 2) return receiptSnapshot.promise;
        return { kind: 'snapshot', snapshot: { version: 3 }, cursor: 3 };
      },
      subscribe: async () => ({ close() {} }),
      optimistic: (snapshot) => ({ ...snapshot, pending: true }),
      sendAction: async () => ({ ok: true, actionId: 'own-composite-action', confirmedThrough: 3 }),
      createActionId: () => 'own-composite-action',
    });
    await session.ready;
    const dispatched = await session.dispatch('Project.rename', {});
    const reconnect = session.reconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    receiptSnapshot.resolve({ kind: 'snapshot', snapshot: { version: 3 }, cursor: 3 });
    await reconnect;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, ['snapshot', 'snapshot', 'catchup', 'snapshot']);
    assert.equal(session.pendingCount(), 0);
    assert.deepEqual(session.snapshot, { version: 3 });
    assert.deepEqual(await dispatched.settlement.wait(), { opId: dispatched.opId, status: 'reconciled' });
    session.close();
  });

  it('does not revive a failed composite session for a queued lower receipt fence', async () => {
    let action = 0;
    let snapshots = 0;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async () => {
        snapshots += 1;
        if (snapshots === 1) return { kind: 'snapshot', snapshot: { version: 1 }, cursor: 1 };
        throw new Error('offline');
      },
      subscribe: async () => ({ close() {} }),
      optimistic: (snapshot) => ({ ...snapshot, pending: true }),
      sendAction: async () => ({ ok: true, actionId: `own-composite-action-${++action}`, confirmedThrough: action === 1 ? 10 : 2 }),
      createActionId: () => `own-composite-action-${action + 1}`,
    });
    await session.ready;
    await Promise.all([session.dispatch('Project.rename', {}), session.dispatch('Project.rename', {})]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(snapshots, 2);
    assert.equal(session.status, 'unavailable');
    assert.equal(session.pendingCount(), 0);
    session.close();
  });

  it('does not settle a later receipt from an earlier in-flight snapshot', async () => {
    const firstSnapshot = deferred();
    let action = 0;
    let snapshots = 0;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async () => {
        snapshots += 1;
        if (snapshots === 1) return { kind: 'snapshot', snapshot: { version: 1 }, cursor: 1 };
        if (snapshots === 2) return firstSnapshot.promise;
        return { kind: 'snapshot', snapshot: { version: 3 }, cursor: 3 };
      },
      subscribe: async () => ({ close() {} }),
      optimistic: (snapshot) => ({ ...snapshot, pending: true }),
      sendAction: async () => ({ ok: true, actionId: `own-composite-action-${++action}`, confirmedThrough: 3 }),
      createActionId: () => `own-composite-action-${action + 1}`,
    });
    await session.ready;
    await session.dispatch('Project.rename', {});
    const laterDispatch = session.dispatch('Project.rename', {});
    firstSnapshot.resolve({ kind: 'snapshot', snapshot: { version: 2 }, cursor: 3 });
    await laterDispatch;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(snapshots, 3);
    assert.equal(session.pendingCount(), 0);
    assert.deepEqual(session.snapshot, { version: 3 });
    session.close();
  });

  it('rejects a receipt snapshot that would regress the authoritative cursor', async () => {
    let snapshots = 0;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async () => ({ kind: 'snapshot', snapshot: { version: ++snapshots }, cursor: snapshots === 1 ? 10 : 3 }),
      subscribe: async () => ({ close() {} }),
      optimistic: (snapshot) => ({ ...snapshot, pending: true }),
      sendAction: async () => ({ ok: true, actionId: 'own-composite-action', confirmedThrough: 3 }),
      createActionId: () => 'own-composite-action',
    });
    await session.ready;
    const dispatched = await session.dispatch('Project.rename', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(session.status, 'unavailable');
    assert.equal(session.cursor, 10);
    assert.equal(session.pendingCount(), 0);
    assert.deepEqual(session.snapshot, { version: 1 });
    assert.deepEqual(await dispatched.settlement.wait(), { opId: dispatched.opId, status: 'unavailable' });
    session.close();
  });

  it('keeps opaque recovery blocked when a receipt cannot identify its submitted action', async () => {
    let delivery;
    let snapshots = 0;
    let attempts = 0;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async () => ({ kind: 'snapshot', snapshot: { version: ++snapshots }, cursor: snapshots }),
      subscribe: async ({ deliver }) => { delivery = deliver; return { close() {} }; },
      optimistic: (snapshot) => ({ ...snapshot, pending: true }),
      sendAction: async () => (++attempts === 1
        ? { ok: true, actionId: 'another-action', confirmedThrough: 2 }
        : { ok: true, actionId: 'own-composite-action', confirmedThrough: 2 }),
      createActionId: () => 'own-composite-action',
    });
    await session.ready;
    const result = await session.dispatch('Project.rename', {});
    assert.equal(result.ok, false);
    assert.equal(result.status, 'outcome-unknown');
    await delivery([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);
    assert.equal(snapshots, 1);
    assert.equal(session.pendingCount(), 1);
    assert.deepEqual(session.snapshot, { version: 1, pending: true });

    const retried = await session.retry(result.opId);
    assert.equal(retried.ok, true);
    assert.deepEqual(await retried.settlement.wait(), { opId: result.opId, status: 'reconciled' });
    assert.equal(snapshots, 2);
    assert.deepEqual(session.snapshot, { version: 2 });
    session.close();
  });

  it('fails closed when a snapshot-only receipt has no confirmation fence', async () => {
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async () => ({ kind: 'snapshot', snapshot: {}, cursor: 1 }),
      subscribe: async () => ({ close() {} }),
      optimistic: (snapshot) => ({ ...snapshot, pending: true }),
      sendAction: async () => ({ ok: true }),
      createActionId: () => 'own-composite-action',
    });
    await session.ready;
    const result = await session.dispatch('Project.rename', {});
    assert.equal(result.ok, false);
    assert.equal(result.status, 'outcome-unknown');
    assert.equal(session.pendingCount(), 1);
    assert.deepEqual(session.snapshot, { pending: true });
    session.close();
  });

  it('drops a delivered snapshot-only overlay when its required replacement snapshot fails', async () => {
    let snapshots = 0;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async () => {
        snapshots += 1;
        if (snapshots === 1) return { kind: 'snapshot', snapshot: {}, cursor: 2 };
        throw new Error('offline');
      },
      subscribe: async () => ({ close() {} }),
      optimistic: (snapshot) => ({ ...snapshot, pending: true }),
      sendAction: async () => ({ ok: true, actionId: 'own-composite-action', confirmedThrough: 2 }),
      createActionId: () => 'own-composite-action',
    });
    await session.ready;
    assert.equal((await session.dispatch('Project.rename', {})).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(session.status, 'unavailable');
    assert.equal(session.pendingCount(), 0);
    assert.deepEqual(session.snapshot, {});
    session.close();
  });

  it('does not dispatch an optimistic action before the snapshot cursor is confirmed', async () => {
    const boot = deferred();
    const { session } = setup({ bootstrap: () => boot.promise });
    const result = await session.dispatch('Value.add', { value: 'early' });
    assert.equal(result.ok, false);
    assert.equal(session.pendingCount(), 0);
    boot.resolve({ kind: 'snapshot', snapshot: { values: [] }, cursor: 1 });
    await session.ready;
    session.close();
  });

  it('waits for transport recovery before transmitting an admitted action', async () => {
    let closeTransport;
    const catchup = deferred();
    const replacement = deferred();
    const replacementStarted = deferred();
    let attempts = 0;
    let subscriptions = 0;
    const session = createLiveDeliverySession({
      bootstrap: async ({ mode }) => mode === 'catchup' ? catchup.promise : { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 },
      subscribe: async ({ closed }) => {
        subscriptions += 1;
        closeTransport = closed;
        if (subscriptions > 1) {
          replacementStarted.resolve();
          await replacement.promise;
        }
        return { close() {} };
      },
      validateSnapshot: (snapshot) => snapshot,
      fold: (snapshot, envelope) => ({ values: [...snapshot.values, envelope.event.data.value] }),
      optimistic: (snapshot, action) => ({ values: [...snapshot.values, `pending:${action.payload.value}`] }),
      sendAction: async () => { attempts += 1; return { ok: true }; },
      createActionId: () => 'recovering-action',
    });
    await session.ready;
    closeTransport();
    const dispatch = session.dispatch('Value.add', { value: 'queued' });
    await Promise.resolve();
    assert.equal(attempts, 0);
    catchup.resolve({ kind: 'catchup', envelopes: [], cursor: 1 });
    await replacementStarted.promise;
    assert.equal(session.status, 'recovering');
    assert.equal(attempts, 0);
    replacement.resolve();
    assert.equal((await dispatch).ok, true);
    assert.equal(attempts, 1);
    assert.equal(session.status, 'live');
    session.close();
  });

  it('restarts recovery when the replacement transport closes during connection', async () => {
    let closeTransport;
    let replacementClose;
    let subscriptions = 0;
    let recoveries = 0;
    const session = createLiveDeliverySession({
      bootstrap: async ({ mode }) => {
        if (mode === 'catchup') recoveries += 1;
        return mode === 'catchup'
          ? { kind: 'catchup', envelopes: [], cursor: 1 }
          : { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 };
      },
      subscribe: async ({ closed }) => {
        subscriptions += 1;
        closeTransport = closed;
        if (subscriptions === 2) {
          replacementClose = closed;
          closed();
        }
        return { close() {} };
      },
      validateSnapshot: (snapshot) => snapshot,
      fold: (snapshot) => snapshot,
      sendAction: async () => ({ ok: true }),
    });
    await session.ready;
    closeTransport();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(subscriptions, 3);
    assert.equal(recoveries, 2);
    assert.equal(session.status, 'live');
    assert.equal(typeof replacementClose, 'function');
    session.close();
  });

  it('settles an admitted action without sending when recovery is closed or revoked', async () => {
    for (const terminal of ['close', 'revoke']) {
      let closeTransport;
      let revoke;
      let sends = 0;
      const session = createLiveDeliverySession({
        bootstrap: async ({ mode }) => mode === 'catchup' ? new Promise(() => {}) : { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 },
        subscribe: async ({ closed, revoke: nextRevoke }) => {
          closeTransport = closed;
          revoke = nextRevoke;
          return { close() {} };
        },
        validateSnapshot: (snapshot) => snapshot,
        fold: (snapshot) => snapshot,
        optimistic: (snapshot) => snapshot,
        sendAction: async () => { sends += 1; return { ok: true }; },
        createActionId: () => `waiting-${terminal}`,
      });
      await session.ready;
      closeTransport();
      const dispatch = session.dispatch('Value.add', {});
      await Promise.resolve();
      if (terminal === 'close') session.close();
      else revoke({ code: 'access-revoked' });
      const result = await dispatch;
      assert.equal(sends, 0);
      assert.equal((await result.settlement.wait()).status, terminal === 'close' ? 'closed' : 'revoked');
    }
  });

  it('does not publish or dispatch when optimistic projection revokes access', async () => {
    let revoke;
    let sendCount = 0;
    const { session } = setup({
      subscribe: async ({ revoke: revokeDelivery }) => {
        revoke = revokeDelivery;
        return { close() {} };
      },
      optimistic(snapshot) {
        revoke({ code: 'access-revoked' });
        return snapshot;
      },
      sendAction: async () => { sendCount += 1; return { ok: true }; },
    });
    await session.ready;
    const seen = [];
    session.subscribe((snapshot) => seen.push(snapshot));
    const result = await session.dispatch('Value.add', { value: 'blocked' });

    assert.equal(result.ok, false);
    assert.equal(session.status, 'revoked');
    assert.equal(session.snapshot, null);
    assert.equal(sendCount, 0);
    assert.deepEqual(seen, [{ values: [] }, null]);
  });

  it('uses a package-owned contiguous catch-up after a live gap', async () => {
    const calls = [];
    const { session, deliver } = setup({
      bootstrap: async ({ after, mode }) => {
        calls.push({ after, mode });
        if (mode === 'catchup') {
          return { kind: 'catchup', envelopes: [event(2, 'two'), event(3, 'three')], cursor: 3 };
        }
        return { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 };
      },
    });
    await session.ready;
    await deliver([event(3, 'three')]);

    assert.deepEqual(calls, [{ after: undefined, mode: 'snapshot' }, { after: 1, mode: 'catchup' }]);
    assert.equal(session.cursor, 3);
    assert.deepEqual(session.snapshot, { values: ['two', 'three'] });
    session.close();
  });

  it('continues accepting delivery after a rejected malformed batch', async () => {
    const { session, deliver } = setup();
    await session.ready;
    await assert.rejects(deliver([{ type: 'invalid' }]));
    await deliver([event(2, 'two')]);
    assert.deepEqual(session.snapshot, { values: ['two'] });
    session.close();
  });

  it('freshly bootstraps on opaque resync rather than exposing its reason to the fold', async () => {
    const calls = [];
    const { session, deliver } = setup({
      bootstrap: async ({ after, mode }) => {
        calls.push({ after, mode });
        return mode === 'snapshot' && calls.length > 1
          ? { kind: 'snapshot', snapshot: { values: ['fresh'] }, cursor: 4 }
          : { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 };
      },
    });
    await session.ready;
    await deliver([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);

    assert.deepEqual(calls, [{ after: undefined, mode: 'snapshot' }, { after: undefined, mode: 'snapshot' }]);
    assert.equal(session.cursor, 4);
    assert.deepEqual(session.snapshot, { values: ['fresh'] });
    session.close();
  });

  it('supports a snapshot-only aggregate session without an application event reducer', async () => {
    const calls = [];
    let delivery;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async ({ mode }) => {
        calls.push(mode);
        return calls.length === 1
          ? { kind: 'snapshot', snapshot: { projects: ['old'] }, cursor: 1 }
          : { kind: 'snapshot', snapshot: { projects: ['fresh'] }, cursor: 2 };
      },
      subscribe: async ({ deliver }) => { delivery = deliver; return { close() {} }; },
      sendAction: async () => ({ ok: true }),
    });
    await session.ready;
    await delivery([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);
    assert.deepEqual(session.snapshot, { projects: ['fresh'] });
    assert.deepEqual(calls, ['snapshot', 'snapshot']);
    session.close();
  });

  it('settles a snapshot-only action only when its positive receipt fence is covered by an authorized snapshot', async () => {
    const receipt = deferred();
    let delivery;
    let snapshots = 0;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async () => {
        snapshots += 1;
        return snapshots === 1
          ? { kind: 'snapshot', snapshot: { projects: ['old'] }, cursor: 1 }
          : { kind: 'snapshot', snapshot: { projects: ['fresh'] }, cursor: 3 };
      },
      subscribe: async ({ deliver }) => { delivery = deliver; return { close() {} }; },
      optimistic: (snapshot, action) => ({ projects: [...snapshot.projects, `pending:${action.payload.name}`] }),
      sendAction: () => receipt.promise,
      createActionId: () => 'own-composite-action',
    });
    await session.ready;
    const dispatched = session.dispatch('Project.rename', { name: 'fresh' });
    assert.deepEqual(session.snapshot, { projects: ['old', 'pending:fresh'] });

    // Opaque controls do not identify or settle actions before a receipt.
    await delivery([{ type: 'resync', seq: 3, reason: 'recipient-snapshot-required' }]);
    assert.deepEqual(session.snapshot, { projects: ['old', 'pending:fresh'] });
    assert.equal(snapshots, 1);
    assert.equal(session.pendingCount(), 1);

    receipt.resolve({ ok: true, actionId: 'own-composite-action', confirmedThrough: 3 });
    assert.equal((await dispatched).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(session.snapshot, { projects: ['fresh'] });
    assert.equal(session.pendingCount(), 0);
    session.close();
  });

  it('fails closed when its post-receipt snapshot does not cover the receipt fence', async () => {
    let delivery;
    let snapshots = 0;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async () => ({ kind: 'snapshot', snapshot: { version: ++snapshots }, cursor: Math.min(snapshots, 2) }),
      subscribe: async ({ deliver }) => { delivery = deliver; return { close() {} }; },
      optimistic: (snapshot) => ({ ...snapshot, pending: true }),
      sendAction: async () => ({ ok: true, actionId: 'own-composite-action', confirmedThrough: 3 }),
      createActionId: () => 'own-composite-action',
    });
    await session.ready;
    await session.dispatch('Project.rename', {});
    await delivery([{ type: 'resync', seq: 99, reason: 'recipient-snapshot-required' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(session.cursor, 1);
    assert.equal(session.status, 'unavailable');
    assert.equal(session.pendingCount(), 0);
    assert.deepEqual(session.snapshot, { version: 1 });
    session.close();
  });

  it('releases an opaque recovery blocker when its sender rejects', async () => {
    const receipt = deferred();
    let delivery;
    let snapshots = 0;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async () => ({ kind: 'snapshot', snapshot: { version: ++snapshots }, cursor: snapshots === 1 ? 1 : 4 }),
      subscribe: async ({ deliver }) => { delivery = deliver; return { close() {} }; },
      optimistic: (snapshot) => ({ ...snapshot, pending: true }),
      sendAction: () => receipt.promise,
      createActionId: () => 'own-composite-action',
    });
    await session.ready;
    const dispatched = session.dispatch('Project.rename', {});
    await delivery([{ type: 'resync', seq: 4, reason: 'recipient-snapshot-required' }]);
    assert.deepEqual(session.snapshot, { version: 1, pending: true });
    receipt.resolve({ ok: false, failure: new Error('denied') });

    assert.equal((await dispatched).ok, false);
    assert.equal(session.pendingCount(), 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(session.snapshot, { version: 2 });
    session.close();
  });

  it('recovers instead of acknowledging an unexpected event in a snapshot-only aggregate session', async () => {
    let delivery;
    let snapshots = 0;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async () => ({ kind: 'snapshot', snapshot: { version: ++snapshots }, cursor: snapshots }),
      subscribe: async ({ deliver }) => { delivery = deliver; return { close() {} }; },
      sendAction: async () => ({ ok: true }),
    });
    await session.ready;
    await delivery([event(2, 'must-not-fold')]);
    assert.deepEqual(session.snapshot, { version: 2 });
    assert.equal(session.cursor, 2);
    session.close();
  });

  it('discards a stale resync snapshot when reconnect catch-up finishes first', async () => {
    const resyncRecovery = deferred();
    const resyncStarted = deferred();
    let snapshotCalls = 0;
    const { session, deliver } = setup({
      bootstrap: async ({ mode }) => {
        if (mode === 'catchup') return { kind: 'catchup', envelopes: [event(2, 'new')], cursor: 2 };
        snapshotCalls += 1;
        if (snapshotCalls > 1) {
          resyncStarted.resolve();
          return resyncRecovery.promise;
        }
        return { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 };
      },
    });
    await session.ready;
    const resync = deliver([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);
    await resyncStarted.promise;
    await session.reconnect();
    resyncRecovery.resolve({ kind: 'snapshot', snapshot: { values: ['old'] }, cursor: 1 });
    await resync;

    assert.equal(session.cursor, 2);
    assert.deepEqual(session.snapshot, { values: ['new'] });
    session.close();
  });

  it('reconnects from its confirmed cursor and drops replay overlap', async () => {
    const calls = [];
    const { session, deliver, subscribedAfter } = setup({
      bootstrap: async ({ after, mode }) => {
        calls.push({ after, mode });
        if (mode === 'catchup') return { kind: 'catchup', envelopes: [event(2, 'two')], cursor: 2 };
        return { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 };
      },
    });
    await session.ready;
    await deliver([event(2, 'two')]);
    await session.reconnect();

    assert.deepEqual(calls, [{ after: undefined, mode: 'snapshot' }, { after: 2, mode: 'catchup' }]);
    assert.equal(subscribedAfter(), 2);
    assert.deepEqual(session.snapshot, { values: ['two'] });
    session.close();
  });

  it('fails closed on revoked delivery and clears confirmed and pending state', async () => {
    const held = deferred();
    const { session, closed, revoke } = setup({ sendAction: () => held.promise });
    await session.ready;
    const dispatch = session.dispatch('Value.add', { value: 'own' });
    assert.equal(session.pendingCount(), 1);

    revoke({ code: 'access-revoked' });
    assert.equal(session.status, 'revoked');
    assert.equal(session.snapshot, null);
    assert.equal(session.pendingCount(), 0);
    assert.equal(closed(), true);
    held.resolve({ ok: true });
    assert.equal((await dispatch).ok, false);
  });

  it('returns rolled back when a deferred batch succeeds after access is revoked', async () => {
    const held = deferred();
    let revoke;
    const session = createLiveDeliverySession({
      bootstrap: async () => ({ kind: 'snapshot', snapshot: { values: [] }, cursor: 1 }),
      subscribe: async ({ revoke: revokeDelivery }) => { revoke = revokeDelivery; return { close() {} }; },
      validateSnapshot: (snapshot) => snapshot,
      optimistic: (snapshot, action) => ({ values: [...snapshot.values, `pending:${action.payload.value}`] }),
      sendAction: async () => ({ ok: true }),
      sendBatch: () => held.promise,
      createActionId: () => 'deferred-batch-action',
    });
    await session.ready;
    const batch = session.batch([{ type: 'Value.add', payload: { value: 'own' } }]);
    assert.equal(session.pendingCount(), 1);

    revoke({ code: 'access-revoked' });
    assert.equal(session.status, 'revoked');
    assert.equal(session.pendingCount(), 0);
    held.resolve({ ok: true, actionId: 'deferred-batch-action', cursor: 2 });

    const result = await batch;
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed-rolled-back');
  });

  it('does not report a delivered echo as rolled back when its request fails late', async () => {
    const held = deferred();
    const { session, deliver } = setup({ sendAction: () => held.promise });
    await session.ready;
    const dispatch = session.dispatch('Value.add', { value: 'own' });
    await deliver([event(2, 'own', 'own-action')]);
    held.resolve({ ok: false, failure: { message: 'timeout' } });

    assert.equal((await dispatch).ok, true);
    assert.deepEqual(session.snapshot, { values: ['own'] });
    assert.equal(session.pendingCount(), 0);
    session.close();
  });

  it('does not report a delivered echo as rolled back when its request rejects late', async () => {
    const held = deferred();
    const { session, deliver } = setup({ sendAction: () => held.promise });
    await session.ready;
    const dispatch = session.dispatch('Value.add', { value: 'own' });
    await deliver([event(2, 'own', 'own-action')]);
    held.resolve(Promise.reject(new Error('network reset')));

    assert.equal((await dispatch).ok, true);
    assert.deepEqual(session.snapshot, { values: ['own'] });
    assert.equal(session.pendingCount(), 0);
    session.close();
  });

  it('becomes unavailable when its initial subscription fails', async () => {
    const { session } = setup({ subscribe: async () => { throw new Error('offline'); } });
    await assert.rejects(session.ready, /offline/);
    assert.equal(session.status, 'unavailable');
    assert.equal((await session.dispatch('Value.add', { value: 'blocked' })).ok, false);
    session.close();
  });

  it('closes a subscription that resolves after delivery access is revoked', async () => {
    const subscribed = deferred();
    let closeCount = 0;
    let revoke;
    const { session } = setup({
      subscribe: ({ revoke: revokeDelivery }) => {
        revoke = revokeDelivery;
        return subscribed.promise;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    revoke({ code: 'access-revoked' });
    subscribed.resolve({ close() { closeCount += 1; } });
    await session.ready;
    assert.equal(session.status, 'revoked');
    assert.equal(closeCount, 1);
  });

  it('becomes unavailable when an opaque resync snapshot recovery fails', async () => {
    let calls = 0;
    const { session, deliver } = setup({
      bootstrap: async () => {
        calls += 1;
        if (calls > 1) throw new Error('offline');
        return { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 };
      },
    });
    await session.ready;
    await assert.rejects(deliver([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]), /offline/);
    assert.equal(session.status, 'unavailable');
    session.close();
  });

  it('keeps an opaque recovery blocked while sender outcome is unknown', async () => {
    let rejectFirstAttempt;
    const firstAttempt = new Promise((_, reject) => { rejectFirstAttempt = reject; });
    let delivery;
    let calls = 0;
    let attempts = 0;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async () => {
        calls += 1;
        if (calls === 1) return { kind: 'snapshot', snapshot: { version: 1 }, cursor: 1 };
        return { kind: 'snapshot', snapshot: { version: 2 }, cursor: 2 };
      },
      subscribe: async ({ deliver }) => { delivery = deliver; return { close() {} }; },
      optimistic: (snapshot) => ({ ...snapshot, pending: true }),
      sendAction: () => (++attempts === 1
        ? firstAttempt
        : Promise.resolve({ ok: true, actionId: 'own-composite-action', confirmedThrough: 2 })),
      createActionId: () => 'own-composite-action',
    });
    await session.ready;
    const dispatched = session.dispatch('Project.rename', {});
    assert.deepEqual(session.snapshot, { version: 1, pending: true });
    await delivery([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);
    assert.equal(session.status, 'live');
    assert.equal(session.pendingCount(), 1);
    assert.deepEqual(session.snapshot, { version: 1, pending: true });
    rejectFirstAttempt(new Error('offline'));
    const unknown = await dispatched;
    assert.equal(unknown.status, 'outcome-unknown');
    assert.equal(calls, 1);

    const retried = await session.retry(unknown.opId);
    assert.equal(retried.ok, true);
    assert.equal((await retried.settlement.wait()).status, 'reconciled');
    assert.deepEqual(session.snapshot, { version: 2 });
    session.close();
  });

  it('does not rematerialize state when access is revoked during resync recovery', async () => {
    const recovery = deferred();
    let calls = 0;
    const { session, deliver, revoke } = setup({
      bootstrap: async () => {
        calls += 1;
        return calls === 1
          ? { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 }
          : recovery.promise;
      },
    });
    await session.ready;
    const resync = deliver([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);
    revoke({ code: 'access-revoked' });
    recovery.resolve({ kind: 'snapshot', snapshot: { values: ['leak'] }, cursor: 2 });
    await resync;

    assert.equal(session.status, 'revoked');
    assert.equal(session.snapshot, null);
  });

  it('does not retry a fenced receipt recovery after access is revoked', async () => {
    const recovery = deferred();
    let calls = 0;
    let revoke;
    const session = createLiveDeliverySession({
      validateSnapshot: (snapshot) => snapshot,
      bootstrap: async () => {
        calls += 1;
        return calls === 1
          ? { kind: 'snapshot', snapshot: { version: 1 }, cursor: 1 }
          : recovery.promise;
      },
      subscribe: async ({ revoke: revokeDelivery }) => { revoke = revokeDelivery; return { close() {} }; },
      optimistic: (snapshot) => ({ ...snapshot, pending: true }),
      sendAction: async () => ({ ok: true, actionId: 'own-composite-action', confirmedThrough: 2 }),
      createActionId: () => 'own-composite-action',
    });
    await session.ready;
    const dispatched = await session.dispatch('Project.rename', {});
    while (calls < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    revoke({ code: 'access-revoked' });
    recovery.resolve({ kind: 'snapshot', snapshot: { version: 2 }, cursor: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(calls, 2);
    assert.equal(session.status, 'revoked');
    assert.deepEqual(await dispatched.settlement.wait(), { opId: dispatched.opId, status: 'revoked' });
  });

  it('does not rematerialize state when snapshot validation revokes access', async () => {
    let calls = 0;
    let revoke;
    let delivery;
    const { session } = setup({
      bootstrap: async () => {
        calls += 1;
        return calls === 1
          ? { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 }
          : { kind: 'snapshot', snapshot: { values: ['late'] }, cursor: 2 };
      },
      validateSnapshot(snapshot) {
        if (calls > 1) revoke({ code: 'access-revoked' });
        return snapshot;
      },
      subscribe: async ({ deliver, revoke: revokeDelivery }) => {
        delivery = deliver;
        revoke = revokeDelivery;
        return { close() {} };
      },
    });
    await session.ready;
    await delivery([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);

    assert.equal(session.status, 'revoked');
    assert.equal(session.snapshot, null);
    assert.equal(session.cursor, 1);
  });

  it('does not restore live state when a snapshot listener revokes access', async () => {
    let calls = 0;
    let revoke;
    let delivery;
    const { session } = setup({
      bootstrap: async () => {
        calls += 1;
        return calls === 1
          ? { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 }
          : { kind: 'snapshot', snapshot: { values: ['late'] }, cursor: 2 };
      },
      subscribe: async ({ deliver, revoke: revokeDelivery }) => {
        delivery = deliver;
        revoke = revokeDelivery;
        return { close() {} };
      },
    });
    await session.ready;
    let published = 0;
    session.subscribe(() => {
      published += 1;
      if (published === 2) revoke({ code: 'access-revoked' });
    });
    await delivery([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);

    assert.equal(session.status, 'revoked');
    assert.equal(session.snapshot, null);
    assert.equal(session.cursor, 2);
  });

  it('becomes unavailable when catch-up does not cover the delivered gap', async () => {
    const { session, deliver } = setup({
      bootstrap: async ({ mode }) => mode === 'catchup'
        ? { kind: 'catchup', envelopes: [event(2, 'two')], cursor: 2 }
        : { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 },
    });
    await session.ready;
    await assert.rejects(deliver([event(5, 'five')]), /remains gapped/);
    assert.equal(session.status, 'unavailable');
    assert.equal((await session.dispatch('Value.add', { value: 'blocked' })).ok, false);
    session.close();
  });

  it('does not restore live state when access is revoked while catch-up folds', async () => {
    let revoke;
    let delivery;
    const { session } = setup({
      bootstrap: async ({ mode }) => mode === 'catchup'
        ? { kind: 'catchup', envelopes: [event(2, 'two')], cursor: 2 }
        : { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 },
      fold(snapshot, envelope) {
        revoke({ code: 'access-revoked' });
        return { values: [...snapshot.values, envelope.event.data.value] };
      },
      subscribe: async ({ deliver, revoke: revokeDelivery }) => {
        delivery = deliver;
        revoke = revokeDelivery;
        return { close() {} };
      },
    });
    await session.ready;
    await delivery([event(3, 'three')]);

    assert.equal(session.status, 'revoked');
    assert.equal(session.snapshot, null);
    assert.equal((await session.dispatch('Value.add', { value: 'blocked' })).ok, false);
  });

  it('ignores a delayed close notification from a replaced subscription', async () => {
    const subscriptions = [];
    const bootstrapCalls = [];
    const { session } = setup({
      bootstrap: async (input) => {
        bootstrapCalls.push(input);
        return input.mode === 'catchup'
          ? { kind: 'catchup', envelopes: [], cursor: 1 }
          : { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 };
      },
      subscribe: async ({ closed }) => {
        const entry = { closeCount: 0, closed };
        subscriptions.push(entry);
        return { close() { entry.closeCount += 1; } };
      },
    });
    await session.ready;
    await session.reconnect();
    subscriptions[0].closed();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(subscriptions.length, 2);
    assert.equal(subscriptions[1].closeCount, 0);
    assert.equal(bootstrapCalls.length, 2);
    session.close();
  });

  it('ignores an old transport envelope while reconnect authorization is pending', async () => {
    const recovery = deferred();
    const subscriptions = [];
    const { session } = setup({
      bootstrap: async ({ mode }) => mode === 'catchup'
        ? recovery.promise
        : { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 },
      subscribe: async ({ deliver }) => {
        subscriptions.push({ deliver });
        return { close() {} };
      },
    });
    await session.ready;
    const reconnect = session.reconnect();
    await subscriptions[0].deliver([event(2, 'stale')]);
    recovery.resolve({ kind: 'revoked', reason: { code: 'access-revoked' } });
    await reconnect;

    assert.equal(session.status, 'revoked');
    assert.equal(session.snapshot, null);
  });

  it('ignores an old queued resync after reconnect invalidates its transport', async () => {
    const resyncRecovery = deferred();
    const catchupRecovery = deferred();
    const subscriptions = [];
    let snapshotCalls = 0;
    const { session } = setup({
      bootstrap: async ({ mode }) => {
        if (mode === 'catchup') return catchupRecovery.promise;
        snapshotCalls += 1;
        return snapshotCalls === 1
          ? { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 }
          : resyncRecovery.promise;
      },
      subscribe: async ({ deliver }) => {
        subscriptions.push({ deliver });
        return { close() {} };
      },
    });
    await session.ready;
    const staleResync = subscriptions[0].deliver([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);
    const reconnect = session.reconnect();
    catchupRecovery.resolve({ kind: 'catchup', envelopes: [event(2, 'new')], cursor: 2 });
    await reconnect;
    await subscriptions[1].deliver([event(3, 'newer')]);
    resyncRecovery.resolve({ kind: 'snapshot', snapshot: { values: ['old'] }, cursor: 1 });
    await staleResync;

    assert.equal(session.cursor, 3);
    assert.deepEqual(session.snapshot, { values: ['new', 'newer'] });
    session.close();
  });

  it('does not replay an old gapped envelope after reconnect replaces its transport', async () => {
    const oldCatchup = deferred();
    const reconnectCatchup = deferred();
    const subscriptions = [];
    let catchupCalls = 0;
    const { session } = setup({
      bootstrap: async ({ mode }) => {
        if (mode !== 'catchup') return { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 };
        catchupCalls += 1;
        return catchupCalls === 1 ? oldCatchup.promise : reconnectCatchup.promise;
      },
      subscribe: async ({ deliver }) => {
        subscriptions.push({ deliver });
        return { close() {} };
      },
    });
    await session.ready;
    const oldGap = subscriptions[0].deliver([event(3, 'stale')]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reconnect = session.reconnect();
    reconnectCatchup.resolve({ kind: 'catchup', envelopes: [event(2, 'new')], cursor: 2 });
    await reconnect;
    oldCatchup.resolve({ kind: 'catchup', envelopes: [event(2, 'old')], cursor: 2 });
    await oldGap;

    assert.deepEqual(session.snapshot, { values: ['new'] });
    assert.equal(session.cursor, 2);
    session.close();
  });

  it('returns revoked when a post-echo request rejects after access is revoked', async () => {
    const held = deferred();
    const { session, deliver, revoke } = setup({ sendAction: () => held.promise });
    await session.ready;
    const dispatch = session.dispatch('Value.add', { value: 'own' });
    await deliver([event(2, 'own', 'own-action')]);
    revoke({ code: 'access-revoked' });
    held.resolve(Promise.reject(new Error('network reset')));

    assert.equal((await dispatch).ok, false);
  });

  it('accepts a revoked catch-up as terminal rather than failing delivery', async () => {
    const { session, deliver } = setup({
      bootstrap: async ({ mode }) => mode === 'catchup'
        ? { kind: 'revoked', reason: { code: 'access-revoked' } }
        : { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 },
    });
    await session.ready;
    await deliver([event(3, 'late')]);
    assert.equal(session.status, 'revoked');
  });

  it('resyncs when fold baseCursor mismatches the accepted cursor', async () => {
    let snapshots = 0;
    let delivery;
    const session = createLiveDeliverySession({
      bootstrap: async ({ mode }) => {
        if (mode === 'snapshot') {
          snapshots += 1;
          return { kind: 'snapshot', snapshot: { values: [] }, cursor: snapshots === 1 ? 1 : 2 };
        }
        return { kind: 'catchup', envelopes: [], cursor: 1 };
      },
      subscribe: async ({ deliver }) => { delivery = deliver; return { close() {} }; },
      validateSnapshot: (snapshot) => snapshot,
      fold: (snapshot, envelope) => ({ values: [...snapshot.values, envelope.event.data.value] }),
      sendAction: async () => ({ ok: true }),
      createActionId: () => 'own-action',
    });
    await session.ready;
    assert.equal(snapshots, 1);
    // Contiguous seq but fold.baseCursor names the wrong predecessor.
    await delivery([{
      type: 'event', seq: 2, seqSpan: [2, 2],
      event: { type: 'Value.updated', data: { value: 'skip' }, actionId: 'a2' },
      fold: { baseCursor: 0 },
    }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(snapshots >= 2, 'baseCursor mismatch recovers via snapshot');
    assert.deepEqual(session.snapshot, { values: [] });
    session.close();
  });

  it('does not apply state when fold throws and recovers via snapshot', async () => {
    let delivery;
    let snapshots = 0;
    const session = createLiveDeliverySession({
      bootstrap: async ({ mode }) => {
        if (mode === 'snapshot') {
          snapshots += 1;
          return { kind: 'snapshot', snapshot: { values: [] }, cursor: snapshots === 1 ? 1 : 2 };
        }
        return { kind: 'catchup', envelopes: [], cursor: 1 };
      },
      subscribe: async ({ deliver }) => { delivery = deliver; return { close() {} }; },
      validateSnapshot: (snapshot) => snapshot,
      fold: () => { throw new Error('fold failed'); },
      sendAction: async () => ({ ok: true }),
      createActionId: () => 'own-action',
    });
    await session.ready;
    await delivery([event(2, 'x')]).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(session.snapshot?.values ?? [], []);
    assert.ok(snapshots >= 2, 'failed fold recovers via snapshot without applying');
    session.close();
  });
});
