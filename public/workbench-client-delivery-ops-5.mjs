// workbench-client-delivery-ops-5.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { createOpLifecycle } from './workbench-client-core.mjs';

export function install4(S) {
S.actionCounter = 0;
S.snapshotOnly = S.configuredFold === undefined;
S.fold = S.configuredFold ?? ((snapshot) => snapshot);
S.FOLD_ECHO_GRACE_MS = 200;
S.deliveryChain = Promise.resolve();
S.MAX_SNAPSHOT_BOOTSTRAPS_PER_CYCLE = 4;
S.LIVE_RETRY_REASONS = new Set(['cursor-moved', 'fence-mismatch', 'lease-budget-exhausted', 'snapshot-contention']);
S.snapshotRecoveryFloor = null;
S.snapshotRecoveryRequested = false;
S.snapshotRecoveryRunning = false;
S.snapshotRecoveryWaiters = [];
S.snapshotRecoveryCycle = null;
S.snapshotRecoveryCycleSeq = 0;
S.lastSnapshotInstalledFromReceipt = false;
S.catchupRecoveryRequested = false;
S.catchupRecoveryRunning = false;
S.catchupRecoveryWaiters = [];
S.catchupRecoveryCycle = null;
S.catchupRecoveryCycleSeq = 0;
S.listeners = new Set();
({ operations: S.operations, makeOperation: S.makeOperation, shouldReconcile: S.shouldReconcile, count: S.count } = createOpLifecycle());
S.recoveryRetryWaiters = new Set();
S.admissionWaiters = [];
S.recoveryWarningTimer = null;
S.recoveryWarningActive = false;
S.DELIVERY_ENVELOPE_KINDS = new Set(['event', 'state', 'resync', 'state-invalidate', 'notification', 'snapshot-patch']);
S.SNAPSHOT_PATCH_OPERATIONS = new Set(['replace-fields', 'put-keyed', 'remove-keyed', 'replace-many', 'replace-one', 'replace-value']);
S.reconnectLoop = null;
S.ready = S.start();
S.ready.catch(() => {});
}
