// workbench-client-delivery-ops-3.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { ClientClosedError, SNAPSHOT_PATCH_CAPABILITY, coversConfirmation } from './workbench-client-core.mjs';

export function install2(S) {
S.settleSnapshotConfirmations = function settleSnapshotConfirmations(receiptGenerationAtStart)  {
    // Composite streams and non-foldable annotated-text ops intentionally do
    // not disclose a foldable echo. A positive sender receipt plus an
    // authorized replacement snapshot is the package-owned equivalent of a
    // direct-stream action echo. Fold-mode sessions still use this path when
    // recovery installs a snapshot (split/merge/redacted/gap).
    for (const [actionId, operation] of S.operations) {
      if (operation.delivered
        && operation.confirmedThrough != null
        && S.snapshotGeneration > operation.receiptSnapshotGeneration
        && receiptGenerationAtStart >= operation.receiptGeneration
        && coversConfirmation(S.cursorAnchor(S.cursor), operation.confirmedThrough)) {
        S.settleOperation(operation, { status: 'reconciled' });
        S.operations.delete(actionId);
      }
    }
  };
S.becomeUnavailable = function becomeUnavailable(error)  {
    if (S.closed || S.status === 'revoked') return;
    S.cancelSnapshotRecovery(error instanceof Error ? error : new ClientClosedError('Live delivery is unavailable'));
    S.cancelCatchupRecovery(error instanceof Error ? error : new ClientClosedError('Live delivery is unavailable'));
    S.finishRecoveryWarning();
    S.status = 'unavailable';
    S.settleAdmissions(false);
    // An opaque aggregate can only be reconciled by its replacement snapshot.
    // Once that recovery fails, no optimistic projection is safe to retain.
    for (const operation of S.operations.values()) S.settleOperation(operation, { status: 'unavailable' });
    S.operations.clear();
    S.publish();
  };
S.applyCatchup = async function applyCatchup(result)  {
    if (!Array.isArray(result.envelopes)) throw new Error('catch-up is missing recipient envelopes');
    S.assertCursor(result.cursor, 'catch-up cursor');
    const initialCursor = S.cursor;
    // Coalesced snapshot-patch CHAINS (#156): when a catch-up batch carries
    // multiple patch envelopes, they are applied as ONE atomic unit with
    // from==prev.to chain validation. Mixed batches (patches interleaved with
    // other kinds) cannot be proven contiguous, so they recover via resync.
    if (result.envelopes.length > 1 && result.envelopes.some((envelope) => envelope?.type === 'snapshot-patch')) {
      const patchesOnly = result.envelopes.every((envelope) => envelope?.type === 'snapshot-patch');
      const applied = patchesOnly
        ? S.applySnapshotPatch(result.envelopes)
        : { status: 'resync' };
      if (applied.status === 'resync') return false;
      if (!S.sameCursor(S.cursor, result.cursor)) throw new Error('catch-up final cursor does not match its recipient envelopes');
      return true;
    }
    let previousPatch = null;
    for (const envelope of result.envelopes) {
      if (!S.isKnownEnvelopeKind(envelope)) throw new Error('catch-up recipient envelopes are not valid');
      if (envelope.type === 'resync' || envelope.type === 'state-invalidate') return false;
      if (envelope.type === 'notification') continue;
      const applied = envelope.type === 'snapshot-patch'
        ? S.applySnapshotPatch(envelope, previousPatch)
        : S.applyAuthoritative(envelope);
      if (envelope.type === 'snapshot-patch') previousPatch = envelope;
      if (applied.status === 'resync') return false;
      if (S.closed || S.status === 'revoked') return true;
      if (applied.status === 'gap') throw new Error('catch-up recipient envelopes are not contiguous');
    }
    if (result.envelopes.length === 0 && !S.sameCursor(result.cursor, initialCursor)) {
      throw new Error('empty catch-up cannot advance its cursor');
    }
    if (!S.sameCursor(S.cursor, result.cursor)) throw new Error('catch-up final cursor does not match its recipient envelopes');
    return true;
  };
S.recover = async function recover(mode, snapshotCursorFloor, retryAttempt = 0)  {
    if (S.closed) return;
    S.onRecoveryStart?.();
    S.startRecoveryWarning();
    const generation = ++S.recoveryGeneration;
    const receiptGenerationAtStart = S.receiptGeneration;
    const snapshotCursorAtStart = S.cursor;
    S.status = mode === 'snapshot' ? 'recovering' : 'catching-up';
    if (mode === 'snapshot') {
      if (!S.snapshotRecoveryCycle || S.snapshotRecoveryCycle.connectionGeneration !== S.connectionGeneration) {
        S.beginSnapshotRecoveryCycle(snapshotCursorFloor ?? null);
      }
      if (S.snapshotRecoveryCycle.attempts >= S.MAX_SNAPSHOT_BOOTSTRAPS_PER_CYCLE) {
        throw new Error('snapshot recovery attempt budget exhausted');
      }
      S.snapshotRecoveryCycle.attempts += 1;
    }
    const cycleGenerationAtStart = S.snapshotRecoveryCycle?.connectionGeneration;
    const result = await S.bootstrap({
      after: mode === 'catchup' ? S.cursor : undefined,
      mode,
      // This generation's cancellation handle. `beginConnectionGeneration`
      // aborts it on replacement, and `close()` aborts it for good, so a hung
      // bootstrap request cannot outlive the session that asked for it.
      signal: S.connectionAbort.signal,
      // Capability advertisement (#156 client): every recovery attempt offers
      // snapshot-patch support; a patch-capable host answers with its protocol
      // echo + fresh projectionToken, a legacy host ignores the extra field.
      // Catch-up additionally presents the held token so the server can serve
      // journal patches instead of a full snapshot.
      capabilities: [SNAPSHOT_PATCH_CAPABILITY],
      ...(mode === 'catchup' && S.deltaCapable && typeof S.projectionToken === 'string' ? { projectionToken: S.projectionToken } : {}),
    });
    // A transport can revoke access while an authorized recovery request is
    // pending. Its late result must never rematerialize project state.
    if (S.closed || S.status === 'revoked' || generation !== S.recoveryGeneration) return;
    if (mode === 'snapshot' && (cycleGenerationAtStart !== S.connectionGeneration
      || S.snapshotRecoveryCycle?.connectionGeneration !== S.connectionGeneration)) return;
    if (!result || typeof result !== 'object') throw new Error('bootstrap returned an invalid result');
    if (result.kind === 'revoked') {
      S.revoke(result.reason);
      return;
    }
    if (result.kind === 'retry') {
      // #252: preserve the lease-capacity (or other) retry reason through
      // recovery. It is additive diagnostics — retry timing is unchanged — but
      // a host reading `session.recoveryReason` can now name the cause. A bare
      // retry must not erase a more specific reason already observed.
      if (S.LIVE_RETRY_REASONS.has(result.reason)) S.recoveryReason = result.reason;
      if (!(await S.waitForRecoveryRetry(retryAttempt)) || S.closed || S.status === 'revoked' || generation !== S.recoveryGeneration) return;
      if (mode === 'snapshot' && S.snapshotRecoveryCycle?.connectionGeneration !== S.connectionGeneration) return;
      return recover('snapshot', snapshotCursorFloor, retryAttempt + 1);
    }
    if (result.kind === 'snapshot') {
      S.assertCursor(result.cursor, 'snapshot cursor');
      const nextSnapshot = S.validateSnapshot(result.snapshot, result);
      if (S.closed || S.status === 'revoked' || generation !== S.recoveryGeneration) return;
      if (mode === 'snapshot' && S.snapshotRecoveryCycle?.connectionGeneration !== S.connectionGeneration) return;
      // A receipt confirmation must never install a replacement snapshot that
      // predates its committed fence, even when reconnect superseded its first
      // request while it was in flight.
      if (snapshotCursorFloor != null && S.cursorAnchor(result.cursor) < Math.max(snapshotCursorFloor, S.cursorAnchor(snapshotCursorAtStart))) return;
      // Capability negotiation (#156 client): the INSTALLED bootstrap result
      // is the ONLY thing that arms delta mode. A legacy result (no protocol
      // echo) downgrades cleanly; a patch-capable result re-arms and stores
      // its freshly minted projectionToken. Arming coincides exactly with
      // installing this result so the token can never lead its cursor.
      S.armDeltaMode(result);
      S.baseSnapshot = nextSnapshot;
      S.cursor = result.cursor;
      S.snapshotGeneration += 1;
      S.lastSnapshotInstalledFromReceipt = Boolean(mode === 'snapshot' && S.snapshotRecoveryCycle?.fromReceipt);
      S.settleSnapshotConfirmations(receiptGenerationAtStart);
      // Exactly ONE publish per settled recovery, with the final status already
      // installed. The snapshot and the `live` transition reach listeners in the
      // same turn, so no observer sees a settled snapshot under a stale
      // recovering/catching-up status.
      S.finishRecoveryWarning();
      // The delayed-warning completion callback runs synchronously and may
      // close or revoke this session, or start a superseding recovery. Never
      // install `live` over the transition it just made.
      if (S.closed || S.status === 'revoked' || S.status === 'unavailable' || generation !== S.recoveryGeneration) return;
      S.recoveryReason = null;
      S.status = 'live';
      S.publish();
      if (S.closed || S.status === 'revoked' || generation !== S.recoveryGeneration) return;
      if (S.initialized && !S.reconnecting) S.settleAdmissions(true);
      if (mode === 'snapshot' && S.snapshotRecoveryCycle
        && (S.snapshotRecoveryCycle.floor == null || S.cursorAnchor(S.cursor) >= S.snapshotRecoveryCycle.floor)
        && !S.snapshotRecoveryCycle.followupRequested) {
        S.snapshotRecoveryCycle = null;
      }
      return;
    }
    if (result.kind === 'catchup' && mode === 'catchup') {
      if (!(await S.applyCatchup(result))) return recover('snapshot');
      if (S.closed || S.status === 'revoked' || generation !== S.recoveryGeneration) return;
      S.lastSnapshotInstalledFromReceipt = false;
      S.finishRecoveryWarning();
      // The delayed-warning completion callback runs synchronously and may
      // close or revoke this session, or start a superseding recovery. Never
      // install `live` over the transition it just made.
      if (S.closed || S.status === 'revoked' || S.status === 'unavailable' || generation !== S.recoveryGeneration) return;
      S.recoveryReason = null;
      S.status = 'live';
      S.publish();
      if (S.initialized && !S.reconnecting) S.settleAdmissions(true);
      return;
    }
    throw new Error('bootstrap returned an unsupported result');
  };
S.receive = async function receive(envelopes, generation)  {
    if (!Array.isArray(envelopes)) throw new Error('delivery callback requires an envelope array');
    let recoveryWait = null;
    // Consecutive snapshot-patch envelopes within ONE delivery batch coalesce
    // into a single atomic application (#156 round 2): one validation pass
    // (including from==prev.to chain discipline), one spine build, one
    // publish. The buffer never crosses receive()/deliver() calls — a batch is
    // one unit — and any non-patch envelope flushes the run first, so mixed
    // batches keep their strict processing order. A resync from the batched
    // apply flows through the same recovery handling as a single patch.
    let patchRun = null;
    const flushPatchRun = async () => {
      if (!patchRun) return;
      const run = patchRun;
      patchRun = null;
      if (S.applySnapshotPatch(run).status !== 'resync') return;
      const recovery = S.requestSnapshotRecovery(undefined, !S.hasUnknownTransmission(), true);
      if (!S.hasUnknownTransmission()) await recovery;
    };
    for (let envelopeIndex = 0; envelopeIndex < envelopes.length; envelopeIndex += 1) {
      const envelope = envelopes[envelopeIndex];
      if (S.closed || S.status === 'revoked' || S.status === 'unavailable' || generation !== S.connectionGeneration) return;
      if (!S.isKnownEnvelopeKind(envelope)) throw new Error('delivery batch contains an invalid recipient envelope');
      if (envelope.type === 'snapshot-patch') {
        (patchRun ??= []).push(envelope);
        continue;
      }
      await flushPatchRun();
      // Recovery controls are intentionally opaque to applications: a transport
      // `resync` and a bounded-overflow `state-invalidate` boundary both demand
      // a fresh replacement snapshot rather than in-place reconciliation.
      // EVERY control's recovery is captured AND awaited (#156 round 4): the
      // first control awaits its replacement inline; a later control chains
      // onto its own freshly requested one. Each control invalidates the base
      // until ITS replacement lands — later envelopes are never evaluated
      // against a base any control in this batch declared untrusted.
      if (envelope.type === 'resync' || envelope.type === 'state-invalidate') {
        let isStateInvalidate = envelope.type === 'state-invalidate';
        let coverage = Number.isSafeInteger(envelope.seq) ? envelope.seq : undefined;
        // A consecutive run of sequenced legacy controls invalidates one base.
        // Recover once at its highest fence before reading any following data.
        if (!S.deltaCapable && coverage !== undefined) {
          while (envelopeIndex + 1 < envelopes.length) {
            const next = envelopes[envelopeIndex + 1];
            if ((next?.type !== 'resync' && next?.type !== 'state-invalidate')
              || !Number.isSafeInteger(next.seq)
              || next.entity !== envelope.entity || next.id !== envelope.id) break;
            if (next.type === 'state-invalidate') isStateInvalidate = true;
            coverage = Math.max(coverage, next.seq);
            envelopeIndex += 1;
          }
        }
        // Short-circuit an already-covered sequenced `resync` (#282):
        // - Never skip `state-invalidate` (bounded-overflow / topology boundary).
        // - Never skip unsequenced (`coverage === undefined`) or synthetic
        //   member-invalidation (`coverage <= 0`) controls.
        // - Never skip `coverage === cursorAnchor(cursor)` for composite cursors
        //   (subscribe emits `seq: after.anchor` when member/composite state
        //   moved without the anchor advancing) or immediately after a receipt
        //   snapshot (preserves receipt-floor recovery invariants).
        const currentAnchor = S.cursor != null ? S.cursorAnchor(S.cursor) : null;
        const isCompositeCursor = S.cursor !== null && typeof S.cursor === 'object';
        if (!isStateInvalidate
          && coverage !== undefined && coverage > 0
          && currentAnchor !== null
          && (coverage < currentAnchor
            || (!S.deltaCapable && !isCompositeCursor && !S.lastSnapshotInstalledFromReceipt && coverage <= currentAnchor))) {
          continue;
        }
        // Delta mode (#159): an ordinary `resync` control re-establishes state
        // by CATCH-UP — journal patches pulled from the held cursor+token —
        // instead of a full snapshot bootstrap. That is the entire point of
        // delta delivery and the fix for the #159 acceptance (a rename must
        // not re-bootstrap). `state-invalidate` is NOT catch-up-able: it is
        // the bounded-overflow boundary (an SSE frame too large to carry),
        // whose replacement is inherently a full snapshot. Full snapshot
        // recovery is also preserved for legacy (non-delta) sessions and for
        // patch-validation failures, where the installed base is untrusted and
        // only an authorized snapshot restores it.
        recoveryWait = S.deltaCapable && typeof S.projectionToken === 'string' && !isStateInvalidate
          ? S.requestCatchupRecovery(!S.hasUnknownTransmission(), true)
          : S.requestSnapshotRecovery(coverage, !S.hasUnknownTransmission(), true);
        // A control declares the CURRENT base untrusted (#156 round 3): later
        // envelopes in the same batch must not derive state from it. Await the
        // replacement before continuing — subsequent patch runs are then
        // evaluated against the recovered cursor (continuing links apply;
        // stale links fail closed as duplicate/resync instead of mutating an
        // untrusted base and publishing garbage ahead of the replacement).
        if (!S.hasUnknownTransmission()) await recoveryWait;
        continue;
      }
      // Derived/operational notifications are never authoritative domain
      // mutations; they are ignored, not thrown.
      if (envelope.type === 'notification') continue;
      const applied = S.applyAuthoritative(envelope);
      if (applied.status === 'resync') {
        const recovery = S.requestSnapshotRecovery(undefined, !S.hasUnknownTransmission(), true);
        if (!S.hasUnknownTransmission()) await recovery;
        continue;
      }
      if (applied.status === 'gap') {
        try {
          await S.recover('catchup');
        } catch (error) {
          if (!S.closed && S.status !== 'revoked') S.becomeUnavailable();
          throw error;
        }
        if (S.closed || S.status === 'revoked' || generation !== S.connectionGeneration) return;
        const replayed = S.applyAuthoritative(envelope);
        if (replayed.status === 'gap') {
          if (!S.closed && S.status !== 'revoked') S.becomeUnavailable();
          throw new Error('delivery remains gapped after catch-up');
        }
      }
    }
    await flushPatchRun();
    if (recoveryWait && !S.hasUnknownTransmission()) await recoveryWait;
  };
S.deliver = function deliver(envelopes, generation)  {
    // A later, transport-triggered recovery can proceed after a failed batch.
    const attempt = S.deliveryChain.catch(() => {}).then(() => S.receive(envelopes, generation));
    S.deliveryChain = attempt.catch(() => {});
    return attempt;
  };
S.recoverReceiptSnapshot = function recoverReceiptSnapshot(operation)  {
    S.requestSnapshotRecovery(operation.confirmedThrough, false, false, { fromReceipt: true });
  };
S.receiptFenceAlreadyCovered = function receiptFenceAlreadyCovered(operation)  {
    return S.deltaCapable && !S.snapshotOnly
      && S.cursor !== null && typeof S.cursor === 'object'
      && Number.isSafeInteger(operation.confirmedThrough)
      && S.cursorAnchor(S.cursor) >= operation.confirmedThrough;
  };
S.recoverFoldableAfterGrace = function recoverFoldableAfterGrace(operation)  {
    setTimeout(() => {
      if (S.operations.get(operation.actionId) !== operation) return;
      if (operation.echoCursor != null) return;
      if (operation.confirmedThrough == null) return;
      S.recoverReceiptSnapshot(operation);
    }, S.FOLD_ECHO_GRACE_MS);
  };
S.connect = async function connect()  {
    const generation = S.beginConnectionGeneration();
    const nextSubscription = await S.subscribe({
      after: S.cursor,
      deliver: (envelopes) => {
        if (S.closed || S.status === 'revoked' || generation !== S.connectionGeneration) return;
        return S.deliver(envelopes, generation);
      },
      revoke: S.revoke,
      closed: () => {
        if (generation !== S.connectionGeneration) return;
        S.beginConnectionGeneration();
        if (S.reconnecting) S.reconnectRequested = true;
        else S.reconnect().catch(() => {});
      },
      // Capability advertisement (#156): the live subscription offers the
      // capability too, so a patch-capable host can push snapshot-patch
      // envelopes on the stream. Additive — legacy hosts ignore it. The held
      // projection token rides along (#159 round-3): a host emitting patches
      // over the stream needs the recipient's ledger handle; the token is
      // re-established on every reconnect, so it never goes stale within a
      // connection.
      capabilities: [SNAPSHOT_PATCH_CAPABILITY],
      ...(typeof S.projectionToken === 'string' && S.projectionToken.length > 0 ? { projectionToken: S.projectionToken } : {}),
    });
    // Delivery can revoke access while transport establishment is pending.
    // Never retain a subscription that became unauthorized before its handle.
    if (S.closed || S.status === 'revoked' || generation !== S.connectionGeneration) {
      nextSubscription?.close?.();
      return false;
    }
    S.subscription = nextSubscription;
    return true;
  };
}
