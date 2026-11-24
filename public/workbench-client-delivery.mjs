// workbench-client-delivery.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { install0 } from './workbench-client-delivery-ops-1.mjs';
import { install1 } from './workbench-client-delivery-ops-2.mjs';
import { install2 } from './workbench-client-delivery-ops-3.mjs';
import { install3 } from './workbench-client-delivery-ops-4.mjs';
import { install4 } from './workbench-client-delivery-ops-5.mjs';

export function createLiveDeliverySession({
  bootstrap,
  subscribe,
  validateSnapshot,
  fold: configuredFold,
  optimistic = (snapshot) => snapshot,
  sendAction,
  sendBatch,
  createActionId,
  onRecoveryStart,
  onRecoveryDelayed,
  recoveryWarningDelayMs = 5000,
  isFoldableEcho = () => false,
}) {
  const S = {
  bootstrap,
  subscribe,
  validateSnapshot,
  configuredFold,
  optimistic,
  sendAction,
  sendBatch,
  createActionId,
  onRecoveryStart,
  onRecoveryDelayed,
  recoveryWarningDelayMs,
  isFoldableEcho,
  };
  install0(S);
  install1(S);
  install2(S);
  install3(S);
  install4(S);
return {
    get snapshot() { return S.visibleSnapshot; },
    // The pre-projection view: the last server-installed snapshot, with NO
    // pending operation's optimistic reducer applied. `snapshot` above is the
    // merged view (base + pending projections) and is what a UI renders from.
    // A consumer that must know whether a row is CONFIRMED rather than merely
    // projected reads this one; both views are already in memory, so this
    // getter is free. Null exactly when `snapshot` is null.
    get confirmedSnapshot() { return S.baseSnapshot; },
    get cursor() { return S.cursor; },
    get status() { return S.status; },
    // #252: the last machine-readable bootstrap retry reason. Non-null while a
    // recovery is held back by capacity/lease exhaustion, including the
    // terminal `unavailable` state, and null once a snapshot is installed.
    get recoveryReason() { return S.recoveryReason; },
    // Capability negotiation state (#156): true only while a patch-capable
    // bootstrap result is installed; hosting code and tests read this to
    // verify the response-gated handshake.
    get deltaCapable() { return S.deltaCapable; },
    get projectionToken() { return S.projectionToken; },
    get ready() { return S.ready; },
    dispatch: S.dispatch,
    batch: S.batch,
    retry: S.retry,
    reconnect: S.reconnect,
    operations() {
      return [...S.operations.values()].map((operation) => Object.freeze({
        opId: operation.opId,
        actionId: operation.actionId,
        status: operation.status,
        error: operation.error,
      }));
    },
    pendingCount() { return S.count('pending'); },
    subscribe(listener) {
      S.listeners.add(listener);
      if (S.visibleSnapshot !== null || S.status === 'revoked') listener(S.visibleSnapshot);
      return () => S.listeners.delete(listener);
    },
    close() {
      if (S.closed) return;
      S.closed = true;
      // Settle the transport: the current generation's request is cancelled,
      // not merely ignored when it eventually answers. `cancelRecoveryRetries`
      // below then stops any retry the failure would otherwise schedule.
      S.connectionAbort.abort();
      S.cancelSnapshotRecovery();
      S.cancelCatchupRecovery();
      S.finishRecoveryWarning();
      S.settleAdmissions(false);
      S.cancelRecoveryRetries();
      S.subscription?.close?.();
      S.subscription = null;
      for (const operation of S.operations.values()) S.settleOperation(operation, { status: 'closed' });
      S.operations.clear();
      S.listeners.clear();
    },
  };
}
