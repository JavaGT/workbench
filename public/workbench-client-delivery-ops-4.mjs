// workbench-client-delivery-ops-4.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { ClientClosedError } from './workbench-client-core.mjs';
import { isJsonValue, normalizeFailure } from './workbench-client-errors.mjs';

export function install3(S) {
S.reconnect = async function reconnect()  {
    if (S.closed || S.status === 'revoked') return;
    if (S.reconnecting) {
      S.reconnectRequested = true;
      // A reconnect loop is already running. Await its completion (which
      // includes the extra iteration this request triggers) so the caller
      // observes the loop's final snapshot, not an intermediate one.
      return S.reconnectLoop;
    }
    // Some adapters report their own close synchronously. Mark reconnecting
    // before closing the old subscription so that callback cannot recurse.
    S.reconnecting = true;
    S.onRecoveryStart?.();
    S.reconnectLoop = (async () => {
      try {
        do {
          S.reconnectRequested = false;
          // Invalidate the old transport before recovery reauthorizes the stream.
          // The old cycle is cancelled so its late bootstrap cannot install
          // state; an uncovered receipt fence is re-queued as a new cycle.
          // This also aborts the previous generation's in-flight request, so the
          // superseded bootstrap cannot stay open beside its successor.
          const pendingReceiptFloor = S.snapshotRecoveryCycle?.receiptFloor ?? S.snapshotRecoveryFloor;
          S.beginConnectionGeneration();
          if (S.snapshotRecoveryCycle) S.snapshotRecoveryCycle = null;
          S.subscription?.close?.();
          S.subscription = null;
          await S.recover('catchup');
          if (S.closed || S.status === 'revoked') break;
          if (pendingReceiptFloor != null && S.cursorAnchor(S.cursor) < pendingReceiptFloor) {
            S.requestSnapshotRecovery(pendingReceiptFloor, false, false, { fromReceipt: true });
          }
          S.status = 'recovering';
          if (!(await S.connect())) {
            S.reconnectRequested = true;
            continue;
          }
          S.status = 'live';
        } while (S.reconnectRequested && !S.closed && S.status !== 'revoked');
        if (!S.reconnectRequested && !S.closed && S.status === 'live') S.settleAdmissions(true);
      } catch (error) {
        if (!S.closed && S.status !== 'revoked') S.becomeUnavailable();
        throw error;
      } finally {
        S.reconnecting = false;
        S.reconnectLoop = null;
      }
    })();
    return S.reconnectLoop;
  };
S.revoke = function revoke(_reason)  {
    if (S.closed || S.status === 'revoked') return;
    S.status = 'revoked';
    S.cancelSnapshotRecovery();
    S.cancelCatchupRecovery();
    S.disarmDeltaMode();
    S.finishRecoveryWarning();
    S.settleAdmissions(false);
    S.cancelRecoveryRetries();
    S.baseSnapshot = null;
    S.visibleSnapshot = null;
    for (const operation of S.operations.values()) S.settleOperation(operation, { status: 'revoked' });
    S.operations.clear();
    S.subscription?.close?.();
    S.subscription = null;
    for (const listener of S.listeners) {
      try { listener(null); } catch { /* isolate consumers */ }
    }
  };
S.start = async function start()  {
    try {
      await S.recover('snapshot');
      if (!S.closed && S.status !== 'revoked') {
        if (await S.connect()) S.initialized = true;
      }
    } catch (error) {
      if (!S.closed && S.status !== 'revoked') S.becomeUnavailable();
      throw error;
    }
  };
S.dispatch = async function dispatch(type, payload, options)  {
    // A caller may pre-mint the actionId synchronously so an optimistic layer
    // can tag the pending state it will reconcile before its fold echo arrives.
    const actionId = options?.actionId ?? S.nextActionId();
    const action = S.freezeClone(structuredClone({ actionId, type, payload }));
    const operation = S.makeOperation({
      actionId,
      action,
      outcome: 'unknown',
      confirmedThrough: null,
      receiptGeneration: null,
      receiptSnapshotGeneration: null,
      foldableEcho: S.isFoldableEcho(action) === true,
    });
    const settlement = S.createSettlement(operation);
    if (!S.initialized || S.closed || S.status === 'unavailable' || S.status === 'revoked') {
      S.settleOperation(operation, { status: S.terminalStatus() });
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement, failure: normalizeFailure(new ClientClosedError('Live delivery is unavailable')) };
    }
    S.operations.set(actionId, operation);
    S.publish();
    if (!((S.status === 'live' && !S.reconnecting) || await S.admit(operation)) || !S.canTransmit(operation)) {
      S.settleOperation(operation, { status: S.terminalStatus() });
      S.operations.delete(actionId);
      S.publish();
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement, failure: normalizeFailure(new ClientClosedError('Live delivery is unavailable')) };
    }
    return S.submitAction(operation);
  };
S.submitAction = async function submitAction(operation)  {
    try {
      operation.transmitted = true;
      const receipt = await S.sendAction(operation.action);
      if (S.status === 'revoked') {
        operation.outcome = 'rejected';
        S.settleOperation(operation, { status: 'revoked' });
        S.operations.delete(operation.actionId);
        S.publish();
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure: normalizeFailure(new ClientClosedError('Live delivery access was revoked')) };
      }
      if (receipt?.ok === false) {
        operation.outcome = 'rejected';
        S.kickSnapshotRecovery();
        // The matching committed envelope is authoritative when a request
        // failure races its delivery; never tell callers to retry that action.
        // A patch attribution (#156 round 3) is the same commit proof: the
        // accepted patch already settled and removed the op.
        if (operation.echoCursor != null || operation.patchAttributed) {
          S.operations.delete(operation.actionId);
          S.publish();
          S.settleOperation(operation, { status: 'reconciled' });
          return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement };
        }
        const failure = receipt.failure ?? receipt.error ?? receipt;
        S.operations.delete(operation.actionId);
        operation.status = 'failed';
        operation.error = failure;
        S.settleOperation(operation, { status: 'failed', error: failure });
        S.publish();
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure: normalizeFailure(failure) };
      }
      const confirmedThrough = receipt?.confirmedThrough;
      if (S.snapshotOnly && (!Number.isSafeInteger(confirmedThrough) || confirmedThrough < 0 || receipt?.actionId !== operation.actionId)) {
        throw new Error('snapshot-only action receipt must confirm its actionId through a nonnegative cursor');
      }
      operation.outcome = 'positive';
      operation.delivered = true;
      const confirmedCursor = receipt?.cursor ?? receipt?.seq;
      if (Number.isSafeInteger(confirmedCursor) && confirmedCursor >= 0) operation.confirmedCursor = confirmedCursor;
      if (Number.isSafeInteger(confirmedThrough) && confirmedThrough >= 0) operation.confirmedThrough = confirmedThrough;
      operation.receiptGeneration = ++S.receiptGeneration;
      operation.receiptSnapshotGeneration = S.snapshotGeneration;
      S.settleSnapshotConfirmations(S.receiptGeneration);
      // Prefer fold echo settlement. Snapshot recovery covers (a) snapshot-only
      // composites and (b) fold-mode actions whose receipt names a fence but
      // whose fold echo has not arrived (non-foldable ops, delayed SSE).
      // Ordinary fold sessions without a confirmation fence keep echo-only settle.
      // Delta-capable sessions (#156 round 2) skip the recovery entirely when
      // the patch stream has ALREADY advanced past the receipt fence — the
      // authoritative base is at least as fresh as the receipt, so a full
      // snapshot bootstrap would be a pointless per-edit tax. The op stays
      // pending until its patch attribution (actionIds / routedInvisible)
      // settles it, exactly like any other unechoed delta-stream action.
      // An op the patch ALREADY attributed and removed (#156 round 3) skips
      // recovery too — it is settled; there is nothing left to recover for.
      if (operation.echoCursor == null && !operation.patchAttributed
        && !S.receiptFenceAlreadyCovered(operation)
        && (S.snapshotOnly || Number.isSafeInteger(operation.confirmedThrough))) {
        if (operation.foldableEcho) S.recoverFoldableAfterGrace(operation);
        else S.recoverReceiptSnapshot(operation);
      }
      if (S.shouldReconcile(operation, { confirmedCursor: operation.confirmedCursor, echoCursor: operation.echoCursor })) {
        S.settleOperation(operation, { status: 'reconciled' });
        S.operations.delete(operation.actionId);
      }
      S.publish();
      return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement, value: receipt?.value };
    } catch (error) {
      if (S.status === 'revoked') {
        S.settleOperation(operation, { status: 'revoked' });
        S.operations.delete(operation.actionId);
        S.publish();
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure: normalizeFailure(new ClientClosedError('Live delivery access was revoked')) };
      }
      // A delivery echo proves the action reached the committed recipient
      // stream even when its request promise fails after that point. An
      // accepted-patch attribution (#156 round 3) is the same commit proof.
      if (operation.echoCursor != null || operation.patchAttributed) {
        S.settleOperation(operation, { status: 'reconciled' });
        S.operations.delete(operation.actionId);
        S.publish();
        return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement };
      }
      operation.deliveryError = error;
      return { ok: false, status: 'outcome-unknown', opId: operation.actionId, settlement: operation.settlement, deliveryError: { message: String(error?.message ?? error) } };
    }
  };
S.submitBatch = async function submitBatch(operation)  {
    try {
      operation.transmitted = true;
      const receipt = await S.sendBatch(operation.batch);
      if (S.status === 'revoked') {
        operation.outcome = 'rejected';
        S.settleOperation(operation, { status: 'revoked' });
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure: normalizeFailure(new ClientClosedError('Live delivery access was revoked')) };
      }
      if (receipt?.ok === false) {
        operation.outcome = 'rejected';
        S.kickSnapshotRecovery();
        // Same commit-proof escapes as submitAction: a fold echo or an
        // accepted-patch attribution (#156 round 3) means the batch committed
        // even when its request failed.
        if (operation.echoCursor != null || operation.patchAttributed) {
          S.settleOperation(operation, { status: 'reconciled' });
          S.operations.delete(operation.actionId);
          S.publish();
          return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement };
        }
        S.operations.delete(operation.actionId);
        operation.status = 'failed';
        operation.error = receipt.failure ?? receipt.error ?? receipt;
        S.settleOperation(operation, { status: 'failed', error: operation.error });
        S.publish();
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure: normalizeFailure(operation.error) };
      }
      if (!receipt || receipt.ok !== true || receipt.actionId !== operation.actionId) {
        throw new Error('batch dispatch returned an invalid receipt');
      }
      const confirmedThrough = receipt.confirmedThrough;
      if (S.snapshotOnly && (!Number.isSafeInteger(confirmedThrough) || confirmedThrough < 0)) {
        throw new Error('snapshot-only batch receipt must confirm through a nonnegative cursor');
      }
      operation.outcome = 'positive';
      operation.delivered = true;
      const confirmedCursor = receipt?.cursor ?? receipt?.seq;
      if (Number.isSafeInteger(confirmedCursor) && confirmedCursor >= 0) operation.confirmedCursor = confirmedCursor;
      if (Number.isSafeInteger(confirmedThrough) && confirmedThrough >= 0) operation.confirmedThrough = confirmedThrough;
      operation.receiptGeneration = ++S.receiptGeneration;
      operation.receiptSnapshotGeneration = S.snapshotGeneration;
      S.settleSnapshotConfirmations(S.receiptGeneration);
      // Same delta-capable fence-coverage skip as submitAction (#156 round 2);
      // patch-attributed ops skip recovery too (#156 round 3).
      if (operation.echoCursor == null && !operation.patchAttributed
        && !S.receiptFenceAlreadyCovered(operation)
        && (S.snapshotOnly || Number.isSafeInteger(operation.confirmedThrough))) {
        if (operation.foldableEcho) S.recoverFoldableAfterGrace(operation);
        else S.recoverReceiptSnapshot(operation);
      }
      if (S.shouldReconcile(operation, { confirmedCursor: operation.confirmedCursor, echoCursor: operation.echoCursor })) {
        S.settleOperation(operation, { status: 'reconciled' });
        S.operations.delete(operation.actionId);
      }
      S.publish();
      return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement, value: receipt?.value };
    } catch (error) {
      if (S.status === 'revoked') {
        S.settleOperation(operation, { status: 'revoked' });
        S.operations.delete(operation.actionId);
        S.publish();
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure: normalizeFailure(new ClientClosedError('Live delivery access was revoked')) };
      }
      // Same commit-proof escapes as submitAction: a delivery echo or an
      // accepted-patch attribution (#156 round 3) proves the batch committed
      // even when its request promise fails after that point.
      if (operation.echoCursor != null || operation.patchAttributed) {
        S.settleOperation(operation, { status: 'reconciled' });
        S.operations.delete(operation.actionId);
        S.publish();
        return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement };
      }
      // A transport exception cannot prove rollback. Retain the one package-owned
      // envelope and optimistic placeholder so retry can resend its action ID.
      operation.deliveryError = error;
      return { ok: false, status: 'outcome-unknown', opId: operation.actionId, settlement: operation.settlement, deliveryError: { message: String(error?.message ?? error) } };
    }
  };
S.batch = async function batch(actions)  {
    const actionId = S.nextActionId();
    const rejectedOperation = { opId: actionId };
    const rejectedSettlement = S.createSettlement(rejectedOperation);
    if (!Array.isArray(actions) || actions.length === 0 || actions.some((action) => !action
      || typeof action.type !== 'string'
      || Object.keys(action).length !== 2
      || !isJsonValue(action.payload))) {
      S.settleOperation(rejectedOperation, { status: 'failed', error: new TypeError('batch requires a non-empty action array') });
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement: rejectedSettlement, failure: normalizeFailure(new TypeError('batch requires a non-empty action array')) };
    }
    if (typeof S.sendBatch !== 'function') {
      const failure = new TypeError('sendBatch is required');
      S.settleOperation(rejectedOperation, { status: 'failed', error: failure });
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement: rejectedSettlement, failure: normalizeFailure(failure) };
    }
    if (!S.initialized || S.closed || S.status === 'unavailable' || S.status === 'revoked') {
      S.settleOperation(rejectedOperation, { status: S.terminalStatus() });
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement: rejectedSettlement, failure: normalizeFailure(new ClientClosedError('Live delivery is unavailable')) };
    }
    const retainedActions = S.freezeClone(structuredClone(actions));
    const batchEnvelope = Object.freeze({ actionId, actions: retainedActions });
    const operation = S.makeOperation({
      actionId,
      batch: batchEnvelope,
      actions: retainedActions,
      outcome: 'unknown',
      confirmedThrough: null,
      receiptGeneration: null,
      receiptSnapshotGeneration: null,
      foldableEcho: S.isFoldableEcho(retainedActions[0]) === true,
    });
    S.createSettlement(operation);
    S.operations.set(actionId, operation);
    S.publish();
    if (!((S.status === 'live' && !S.reconnecting) || await S.admit(operation)) || !S.canTransmit(operation)) {
      S.settleOperation(operation, { status: S.terminalStatus() });
      S.operations.delete(actionId);
      S.publish();
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement: operation.settlement, failure: normalizeFailure(new ClientClosedError('Live delivery is unavailable')) };
    }
    return S.submitBatch(operation);
  };
S.retry = async function retry(opId)  {
    const operation = S.operations.get(opId);
    if (!operation?.deliveryError || (!operation.batch && !operation.action)) {
      const rejectedOperation = { opId };
      const settlement = S.createSettlement(rejectedOperation);
      const failure = new TypeError('operation is not awaiting transport retry');
      S.settleOperation(rejectedOperation, { status: 'failed', error: failure });
      return { ok: false, status: 'failed-rolled-back', opId, settlement, failure: normalizeFailure(failure) };
    }
    if (!((S.status === 'live' && !S.reconnecting) || await S.admit(operation)) || !S.canTransmit(operation)) {
      S.settleOperation(operation, { status: S.terminalStatus() });
      S.operations.delete(opId);
      S.publish();
      return { ok: false, status: 'failed-rolled-back', opId, settlement: operation.settlement, failure: normalizeFailure(new ClientClosedError('Live delivery is unavailable')) };
    }
    operation.deliveryError = null;
    return operation.batch ? S.submitBatch(operation) : S.submitAction(operation);
  };
if (typeof S.bootstrap !== 'function') throw new TypeError('bootstrap is required');
if (typeof S.subscribe !== 'function') throw new TypeError('subscribe is required');
if (typeof S.validateSnapshot !== 'function') throw new TypeError('validateSnapshot is required');
if (S.configuredFold !== undefined && typeof S.configuredFold !== 'function') throw new TypeError('fold must be a function');
if (typeof S.sendAction !== 'function') throw new TypeError('sendAction is required');
if (S.sendBatch !== undefined && typeof S.sendBatch !== 'function') throw new TypeError('sendBatch must be a function');
S.baseSnapshot = null;
S.visibleSnapshot = null;
S.cursor = 0;
S.projectionToken = null;
S.deltaCapable = false;
S.status = 'bootstrapping';
S.recoveryReason = null;
S.closed = false;
S.initialized = false;
S.reconnecting = false;
S.reconnectRequested = false;
S.connectionGeneration = 0;
S.connectionAbort = new AbortController();
S.recoveryGeneration = 0;
S.snapshotGeneration = 0;
S.receiptGeneration = 0;
S.subscription = null;
}
