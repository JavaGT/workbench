// workbench-client-delivery-ops-1.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { ClientClosedError, backoffDelay } from './workbench-client-core.mjs';

export function install0(S) {
S.beginConnectionGeneration = function beginConnectionGeneration()  {
    S.connectionAbort.abort();
    S.connectionAbort = new AbortController();
    S.connectionGeneration += 1;
    return S.connectionGeneration;
  };
S.finishRecoveryWarning = function finishRecoveryWarning()  {
    if (S.recoveryWarningTimer !== null) {
      clearTimeout(S.recoveryWarningTimer);
      S.recoveryWarningTimer = null;
    }
    if (S.recoveryWarningActive) {
      S.recoveryWarningActive = false;
      try { S.onRecoveryDelayed?.(false); } catch { /* isolate consumers */ }
    }
  };
S.startRecoveryWarning = function startRecoveryWarning()  {
    if (S.recoveryWarningTimer !== null || S.recoveryWarningActive) return;
    S.recoveryWarningTimer = setTimeout(() => {
      S.recoveryWarningTimer = null;
      if (S.closed || S.status === 'revoked' || S.status === 'unavailable') return;
      S.recoveryWarningActive = true;
      try { S.onRecoveryDelayed?.(true); } catch { /* isolate consumers */ }
    }, S.recoveryWarningDelayMs);
  };
S.admit = function admit(operation)  {
    if (S.closed || S.status === 'revoked' || S.status === 'unavailable') return Promise.resolve(false);
    if (S.initialized && S.status === 'live' && !S.reconnecting) return Promise.resolve(true);
    return new Promise((resolve) => {
      S.admissionWaiters.push({ operation, resolve });
    });
  };
S.settleAdmissions = function settleAdmissions(available)  {
    if (!available) {
      for (const waiter of S.admissionWaiters.splice(0)) waiter.resolve(false);
      return;
    }
    for (const waiter of S.admissionWaiters.splice(0)) waiter.resolve(true);
  };
S.terminalStatus = function terminalStatus()  {
    return S.closed ? 'closed' : S.status === 'revoked' ? 'revoked' : 'unavailable';
  };
S.canTransmit = function canTransmit(operation)  {
    return S.initialized
      && !S.closed
      && S.status === 'live'
      && !S.reconnecting
      && S.operations.get(operation.actionId) === operation;
  };
S.waitForRecoveryRetry = function waitForRecoveryRetry(attempt)  {
    const delay = backoffDelay(attempt, 50, 1000);
    return new Promise((resolve) => {
      const waiter = { timeout: null, resolve };
      waiter.timeout = setTimeout(() => {
        S.recoveryRetryWaiters.delete(waiter);
        resolve(true);
      }, delay);
      S.recoveryRetryWaiters.add(waiter);
    });
  };
S.cancelRecoveryRetries = function cancelRecoveryRetries()  {
    for (const waiter of S.recoveryRetryWaiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(false);
    }
    S.recoveryRetryWaiters.clear();
  };
S.createSettlement = function createSettlement(operation)  {
    const waiters = new Set();
    operation.settlement = Object.freeze({
      opId: operation.opId,
      wait({ signal } = {}) {
        if (operation.settlementOutcome) return Promise.resolve(operation.settlementOutcome);
        if (signal?.aborted) return Promise.resolve({ opId: operation.opId, status: 'cancelled' });
        return new Promise((resolve) => {
          const waiter = { resolve, signal, cancel: null };
          const cancel = () => {
            waiters.delete(waiter);
            signal.removeEventListener('abort', cancel);
            resolve({ opId: operation.opId, status: 'cancelled' });
          };
          waiter.cancel = cancel;
          if (signal) signal.addEventListener('abort', cancel, { once: true });
          waiters.add(waiter);
        });
      },
    });
    operation.resolveSettlement = (outcome) => {
      if (operation.settlementOutcome) return;
      operation.settlementOutcome = Object.freeze({ opId: operation.opId, ...outcome });
      for (const waiter of waiters) {
        if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.cancel);
        waiter.resolve(operation.settlementOutcome);
      }
      waiters.clear();
    };
    return operation.settlement;
  };
S.settleOperation = function settleOperation(operation, outcome)  {
    operation.resolveSettlement?.(outcome);
  };
S.nextActionId = function nextActionId()  {
    if (S.createActionId) return S.createActionId();
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `delivery_op_${++S.actionCounter}`;
  };
S.freezeClone = function freezeClone(value)  {
    if (!value || typeof value !== 'object') return value;
    for (const child of Object.values(value)) freezeClone(child);
    return Object.freeze(value);
  };
S.publish = function publish()  {
    if (S.closed || S.baseSnapshot === null) return;
    let projected = S.baseSnapshot;
    for (const operation of S.operations.values()) {
      // A fold echo already splices the op into the base. Re-applying the
      // pending optimistic reducer on top of that echo doubles the edit until
      // the sender receipt deletes the operation, and any queued successor
      // captured against the single application then fail-closes as stale.
      if (operation.status === 'pending' && operation.echoCursor == null) {
        for (const action of operation.actions ?? [operation.action]) projected = S.optimistic(projected, action);
      }
      // Application callbacks may synchronously trigger terminal revocation.
      // Never publish a projection that was computed before that transition.
      if (S.closed || S.status === 'revoked' || S.baseSnapshot === null) return;
    }
    S.visibleSnapshot = projected;
    for (const listener of S.listeners) {
      try { listener(S.visibleSnapshot); } catch { /* isolate consumers */ }
    }
  };
S.hasUnknownTransmission = function hasUnknownTransmission()  {
    if (!S.snapshotOnly) return false;
    for (const operation of S.operations.values()) {
      if (operation.transmitted && operation.outcome === 'unknown') return true;
    }
    return false;
  };
S.cancelSnapshotRecovery = function cancelSnapshotRecovery(error = new ClientClosedError('Live delivery is unavailable'))  {
    S.snapshotRecoveryRequested = false;
    S.snapshotRecoveryFloor = null;
    S.snapshotRecoveryCycle = null;
    for (const waiter of S.snapshotRecoveryWaiters.splice(0)) waiter.reject(error);
  };
S.beginSnapshotRecoveryCycle = function beginSnapshotRecoveryCycle(floor, fromReceipt = false)  {
    S.snapshotRecoveryCycle = {
      id: ++S.snapshotRecoveryCycleSeq,
      attempts: 0,
      floor: floor ?? null,
      receiptFloor: floor ?? null,
      fromReceipt,
      followupRequested: false,
      unsequencedFollowup: false,
      receiptFollowup: false,
      connectionGeneration: S.connectionGeneration,
    };
    return S.snapshotRecoveryCycle;
  };
S.raiseSnapshotCycleFloor = function raiseSnapshotCycleFloor(floor)  {
    if (floor == null || !S.snapshotRecoveryCycle) return;
    S.snapshotRecoveryCycle.floor = S.snapshotRecoveryCycle.floor == null
      ? floor
      : Math.max(S.snapshotRecoveryCycle.floor, floor);
  };
S.requestSnapshotRecovery = function requestSnapshotRecovery(floor, wait = !S.hasUnknownTransmission(), inline = false, { fromReceipt = false } = {})  {
    if (S.closed || S.status === 'revoked' || S.status === 'unavailable') {
      const error = new ClientClosedError('Live delivery is unavailable');
      return wait ? Promise.reject(error) : Promise.resolve();
    }
    if (!S.snapshotRecoveryCycle || S.snapshotRecoveryCycle.connectionGeneration !== S.connectionGeneration) {
      S.beginSnapshotRecoveryCycle(floor, fromReceipt);
    } else {
      S.raiseSnapshotCycleFloor(floor);
      if (floor != null) {
        S.snapshotRecoveryCycle.receiptFloor = S.snapshotRecoveryCycle.receiptFloor == null
          ? floor
          : Math.max(S.snapshotRecoveryCycle.receiptFloor, floor);
      }
      if (fromReceipt) S.snapshotRecoveryCycle.fromReceipt = true;
      if (S.snapshotRecoveryRunning) {
        S.snapshotRecoveryCycle.followupRequested = true;
        if (fromReceipt) S.snapshotRecoveryCycle.receiptFollowup = true;
        if (floor == null || floor <= 0) S.snapshotRecoveryCycle.unsequencedFollowup = true;
      }
    }
    S.snapshotRecoveryRequested = true;
    if (floor != null) {
      S.snapshotRecoveryFloor = S.snapshotRecoveryFloor == null
        ? floor
        : Math.max(S.snapshotRecoveryFloor, floor);
    }
    const promise = wait
      ? new Promise((resolve, reject) => S.snapshotRecoveryWaiters.push({ resolve, reject }))
      : Promise.resolve();
    S.kickSnapshotRecovery(inline);
    return promise;
  };
S.kickSnapshotRecovery = function kickSnapshotRecovery(inline = false)  {
    if (!S.snapshotRecoveryRequested || S.snapshotRecoveryRunning || S.closed || S.status === 'revoked' || S.status === 'unavailable') return;
    if (S.hasUnknownTransmission()) return;
    if (S.snapshotRecoveryCycle && S.snapshotRecoveryCycle.attempts >= S.MAX_SNAPSHOT_BOOTSTRAPS_PER_CYCLE) {
      S.snapshotRecoveryRequested = false;
      const error = new Error('snapshot recovery attempt budget exhausted');
      S.becomeUnavailable(error);
      return;
    }
    S.snapshotRecoveryRunning = true;
    const cycle = S.snapshotRecoveryCycle;
    const receiptFloor = cycle?.receiptFloor ?? S.snapshotRecoveryFloor;
    S.snapshotRecoveryFloor = null;
    S.snapshotRecoveryRequested = false;
    if (cycle) {
      cycle.followupRequested = false;
      cycle.unsequencedFollowup = false;
      cycle.receiptFollowup = false;
    }
    const waiters = S.snapshotRecoveryWaiters.splice(0);
    const snapshotGenerationAtStart = S.snapshotGeneration;
    const receiptGenerationAtStart = S.receiptGeneration;
    const cycleId = cycle?.id;
    const run = async () => {
      try {
        await S.recover('snapshot', receiptFloor);
        const liveCycle = S.snapshotRecoveryCycle?.id === cycleId ? S.snapshotRecoveryCycle : null;
        const latestCoverage = liveCycle?.floor ?? null;
        const latestReceipt = liveCycle?.receiptFloor ?? receiptFloor;
        if (latestReceipt != null && !S.closed && S.status !== 'revoked' && S.status !== 'unavailable'
          && S.snapshotGeneration === snapshotGenerationAtStart
          && liveCycle) {
          // A reconnect may supersede this request without installing its
          // result. Give the coalesced recovery one fresh attempt before
          // treating an uncovered receipt fence as a terminal failure.
          await S.recover('snapshot', latestReceipt);
          if (S.snapshotGeneration === snapshotGenerationAtStart) {
            throw new Error('replacement snapshot did not supersede the receipt');
          }
        }
        if (latestReceipt != null && !S.closed && S.status !== 'revoked' && S.status !== 'unavailable'
          && S.cursorAnchor(S.cursor) < latestReceipt
          && S.snapshotRecoveryCycle?.id === cycleId) {
          await S.recover('snapshot', latestReceipt);
          if (S.cursorAnchor(S.cursor) < latestReceipt) {
            throw new Error('replacement snapshot does not cover the receipt fence');
          }
        }
        const coverageSatisfied = latestCoverage == null || S.cursorAnchor(S.cursor) >= latestCoverage;
        const receiptSatisfied = latestReceipt == null || S.cursorAnchor(S.cursor) >= latestReceipt;
        const newerReceiptPending = S.receiptGeneration > receiptGenerationAtStart || Boolean(liveCycle?.receiptFollowup);
        const needsUnsequencedFollowup = Boolean(liveCycle?.unsequencedFollowup);
        if (liveCycle && (!coverageSatisfied || !receiptSatisfied)) {
          liveCycle.followupRequested = true;
          S.snapshotRecoveryRequested = true;
        } else if (liveCycle
          && S.snapshotGeneration > snapshotGenerationAtStart
          && coverageSatisfied
          && receiptSatisfied
          && !newerReceiptPending
          && !needsUnsequencedFollowup) {
          // Attempt #1 already installed a fresh snapshot whose anchor cursor
          // covers every sequenced control that arrived while it was in flight
          // (and no newer receipt or unsequenced invalidation remains): close
          // the cycle and resolve any in-flight waiters instead of kicking a
          // redundant second full snapshot (#282).
          liveCycle.followupRequested = false;
          S.snapshotRecoveryRequested = false;
          S.snapshotRecoveryFloor = null;
          S.snapshotRecoveryCycle = null;
          for (const waiter of S.snapshotRecoveryWaiters.splice(0)) waiter.resolve();
        } else if (S.snapshotRecoveryCycle?.id === cycleId
          && coverageSatisfied
          && !S.snapshotRecoveryCycle.followupRequested) {
          S.snapshotRecoveryCycle = null;
        }
        for (const waiter of waiters) waiter.resolve();
      } catch (error) {
        if (!S.closed && S.status !== 'revoked') S.becomeUnavailable(error);
        for (const waiter of waiters) waiter.reject(error);
        throw error;
      } finally {
        S.snapshotRecoveryRunning = false;
        kickSnapshotRecovery();
      }
    };
    // A delivery callback runs on deliveryChain.  Run its recovery inline so
    // it cannot wait on the chain which is waiting on the callback.  Sender
    // receipts, by contrast, join the chain and serialize with later delivery.
    if (inline) {
      void run().catch(() => {});
    } else {
      const attempt = S.deliveryChain.catch(() => {}).then(run);
      S.deliveryChain = attempt.catch(() => {});
    }
  };
S.cancelCatchupRecovery = function cancelCatchupRecovery(error = new ClientClosedError('Live delivery is unavailable'))  {
    S.catchupRecoveryRequested = false;
    S.catchupRecoveryCycle = null;
    for (const waiter of S.catchupRecoveryWaiters.splice(0)) waiter.reject(error);
  };
S.requestCatchupRecovery = function requestCatchupRecovery(wait = !S.hasUnknownTransmission(), inline = false)  {
    if (S.closed || S.status === 'revoked' || S.status === 'unavailable') {
      const error = new ClientClosedError('Live delivery is unavailable');
      return wait ? Promise.reject(error) : Promise.resolve();
    }
    if (!S.catchupRecoveryCycle || S.catchupRecoveryCycle.connectionGeneration !== S.connectionGeneration) {
      S.catchupRecoveryCycle = { id: ++S.catchupRecoveryCycleSeq, connectionGeneration: S.connectionGeneration };
    }
    S.catchupRecoveryRequested = true;
    if (S.catchupRecoveryRunning) S.catchupRecoveryCycle.followupRequested = true;
    const promise = wait
      ? new Promise((resolve, reject) => S.catchupRecoveryWaiters.push({ resolve, reject }))
      : Promise.resolve();
    S.kickCatchupRecovery(inline);
    return promise;
  };
S.kickCatchupRecovery = function kickCatchupRecovery(inline = false)  {
    if (!S.catchupRecoveryRequested || S.catchupRecoveryRunning || S.closed || S.status === 'revoked' || S.status === 'unavailable') return;
    if (S.hasUnknownTransmission()) return;
    S.catchupRecoveryRunning = true;
    S.catchupRecoveryRequested = false;
    const cycle = S.catchupRecoveryCycle;
    if (cycle) cycle.followupRequested = false;
    const waiters = S.catchupRecoveryWaiters.splice(0);
    const run = async () => {
      try {
        // recover('catchup') pulls journal patches from the held cursor and
        // presents the held token; a patch-apply failure inside it falls back
        // to a full snapshot (the base is untrusted), which this await covers.
        await S.recover('catchup');
        for (const waiter of waiters) waiter.resolve();
      } catch (error) {
        if (!S.closed && S.status !== 'revoked') S.becomeUnavailable(error);
        for (const waiter of waiters) waiter.reject(error);
        throw error;
      } finally {
        S.catchupRecoveryRunning = false;
        kickCatchupRecovery();
      }
    };
    if (inline) {
      void run().catch(() => {});
    } else {
      const attempt = S.deliveryChain.catch(() => {}).then(run);
      S.deliveryChain = attempt.catch(() => {});
    }
  };
S.assertCursor = function assertCursor(value, label)  {
    if (Number.isSafeInteger(value) && value >= 0) return;
    if (value && typeof value === 'object'
      && Number.isSafeInteger(value.anchor) && value.anchor >= 0
      && Number.isSafeInteger(value.aggregate) && value.aggregate >= 0
      && Object.keys(value).length === 2) return;
    // snapshot-patch composite cursors (#122): {anchor, composite}.
    if (value && typeof value === 'object'
      && Number.isSafeInteger(value.anchor) && value.anchor >= 0
      && Number.isSafeInteger(value.composite) && value.composite >= 0
      && Object.keys(value).length === 2) return;
    throw new Error(`${label} must be a nonnegative cursor`);
  };
}
