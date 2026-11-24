// workbench-client-annotated-http-ops-2.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { annotatedTextAction } from './workbench-annotated-text-action.mjs';
import { materializeText as materializeFamilyText, restoreTextFamily } from './workbench-annotated-text-continuous.mjs';
import { createAnnotatedTextSnapshotSessionBinding, revokeAnnotatedTextSnapshotSessionBinding } from './workbench-annotated-text-snapshot-internal.mjs';
import { materializeAnnotatedTextSnapshot, projectPendingAnnotatedTextDocument } from './workbench-annotated-text-snapshot.mjs';
import { ClientClosedError } from './workbench-client-core.mjs';
import { createLiveDeliveryHttpSession } from './workbench-client-delivery-http.mjs';
import { normalizeFailure } from './workbench-client-errors.mjs';
import { LiveChannel } from './workbench-client-live-channel.mjs';

export function install1(S) {
S.queueAuthoringMutation = function queueAuthoringMutation(command, send, { capturedBasis = null, alreadyProjected = false, reserved = false, actionId = null } = {})  {
    // Capture dependent local edits against the projection already queued
    // ahead of them, not against the last rendered snapshot. Rapid browser
    // input can enqueue several semantic edits before the first optimistic
    // placeholder is visible; treating each as a sibling of that old snapshot
    // makes every character after the first reject itself as stale.
    const queuedBasis = capturedBasis ?? S.queuedDocumentText ?? S.session.snapshot?.text ?? '';
    // Mint synchronously so the pending edit this mutation covers is tagged
    // with its actionId before the dispatch (and thus its fold echo) runs.
    const resolvedActionId = actionId ?? S.mintActionId();
    const blocks = new Map([['document', queuedBasis]]);
    if (!alreadyProjected && S.applyQueuedTextCommand(queuedBasis, command, resolvedActionId) == null) {
      return Promise.resolve({ ok: false, failure: normalizeFailure(new TypeError('annotated text position splits a surrogate pair')) });
    }
    if (!reserved) S.queuedAuthoringMutations += 1;
    // Queued text is an explicit optimistic placeholder. Publish it immediately
    // instead of waiting for the preceding snapshot-fenced operation to settle.
    S.publishAnnotatedDocument();
    const predecessor = S.authoringMutationTail;
    let release;
    S.authoringMutationTail = new Promise((resolve) => { release = resolve; });
    return (async () => {
      try {
        if (predecessor) await predecessor;
        if (S.sessionClosed) throw new ClientClosedError('Annotated text document is unavailable');
        // Tokens are snapshot-fenced capabilities. Never translate against a
        // revoked binding or an optimistic/foreign basis that has since moved.
        if (S.session.status !== 'live' || !S.session.snapshot || !S.snapshotBinding.authoring) {
          await new Promise((resolve) => {
            S.wakeAuthoringMutation = resolve;
            const unsubscribe = S.session.subscribe(() => {
              if (S.sessionClosed || ['revoked', 'unavailable'].includes(S.session.status)
                || (S.session.status === 'live' && S.session.snapshot && S.snapshotBinding.authoring)) {
                unsubscribe();
                S.wakeAuthoringMutation = null;
                resolve();
              }
            });
          });
        }
        if (S.sessionClosed) throw new ClientClosedError('Annotated text document is unavailable');
        if (['revoked', 'unavailable'].includes(S.session.status)) return S.localAuthoringConflict();
        // Fail closed on any foreign change after capture: the queued offset is
        // absolute against the captured view, and a naive length-delta rebase
        // moves it to the wrong place when the foreign edit sits after the
        // target. The position basis would be stale server-side anyway; surface
        // the conflict instead of guessing.
        if (!S.sameCapturedBlocks(blocks)) return S.localAuthoringConflict();
        const result = await send(command, resolvedActionId);
        if (result?.ok && result.settlement?.wait) await result.settlement.wait();
        return result;
      } finally {
        release();
        // The operation's settlement (echo/settlement consumed: reconciled,
        // failed, revoked, unavailable, or closed) is final — the op is no
        // longer re-projected, so drop its captured annotation range to avoid
        // leaking stale anchors. Keyed by the same action identity the
        // optimistic projector uses.
        S.pendingAnnotationRanges.delete(resolvedActionId);
        S.queuedAuthoringMutations -= 1;
        if (S.queuedAuthoringMutations <= 0) {
          S.queuedAuthoringMutations = 0;
          S.queuedDocumentText = null;
          if (!S.pendingDisplayEdits.length || (S.familyReplica && S.session.snapshot?.text === materializeFamilyText(S.familyReplica))) {
            S.replayPendingDisplayEdits([]);
          }
        }
        S.publishAnnotatedDocument();
      }
    })();
  };
S.armInsertBurst = function armInsertBurst(burst)  {
    if (burst.timer) clearTimeout(burst.timer);
    const remaining = Math.max(0, S.TEXT_BURST_MAX_MS - (Date.now() - burst.startedAt));
    burst.timer = setTimeout(S.flushOpenInsertBurst, Math.min(S.TEXT_BURST_IDLE_MS, remaining));
  };
S.flushOpenInsertBurst = function flushOpenInsertBurst()  {
    const burst = S.openInsertBurst;
    if (!burst) return;
    S.openInsertBurst = null;
    if (burst.timer) clearTimeout(burst.timer);
    S.queueAuthoringMutation(burst.command, burst.send, {
      capturedBasis: burst.capturedBasis,
      alreadyProjected: true,
      reserved: true,
      actionId: burst.actionId,
    }).then(
      (result) => { for (const waiter of burst.waiters) waiter.resolve(result); },
      (error) => { for (const waiter of burst.waiters) waiter.reject(error); },
    );
  };
S.queueTextInsert = function queueTextInsert(command, send)  {
    if (S.TEXT_BURST_IDLE_MS === 0) return S.queueAuthoringMutation(command, send);
    // A caller-supplied mutation ID names exactly that command for durable
    // idempotency. Combining it with another command would make retries either
    // conflict with the changed payload or duplicate the later characters.
    // Only calls whose identity will be minted internally at dispatch time may
    // share one typing-burst command.
    if (command.mutationId !== undefined && command.mutationId !== null) {
      S.flushOpenInsertBurst();
      return S.queueAuthoringMutation(command, send);
    }
    const burst = S.openInsertBurst;
    const contiguous = burst
      && burst.command.at?.affinity === command.at?.affinity
      && command.at?.offset === burst.command.at?.offset + burst.command.text.length;
    if (!contiguous) S.flushOpenInsertBurst();
    const promise = new Promise((resolve, reject) => {
      if (contiguous) {
        if (S.applyQueuedTextCommand(S.queuedDocumentText ?? S.session.snapshot?.text ?? '', command, burst.actionId) == null) {
          reject(new TypeError('annotated text position splits a surrogate pair'));
          return;
        }
        burst.command = { ...burst.command, text: burst.command.text + command.text };
        burst.waiters.push({ resolve, reject });
        S.publishAnnotatedDocument();
        S.armInsertBurst(burst);
        return;
      }
      const capturedBasis = S.queuedDocumentText ?? S.session.snapshot?.text ?? '';
      const burstActionId = S.mintActionId();
      if (S.applyQueuedTextCommand(capturedBasis, command, burstActionId) == null) {
        reject(new TypeError('annotated text position splits a surrogate pair'));
        return;
      }
      S.queuedAuthoringMutations += 1;
      S.publishAnnotatedDocument();
      S.openInsertBurst = {
        command: { ...command }, send, capturedBasis, actionId: burstActionId,
        waiters: [{ resolve, reject }],
        startedAt: Date.now(), timer: null,
      };
      S.armInsertBurst(S.openInsertBurst);
    });
    return promise;
  };
S.cancelOpenInsertBurst = function cancelOpenInsertBurst()  {
    const burst = S.openInsertBurst;
    if (!burst) return;
    S.openInsertBurst = null;
    if (burst.timer) clearTimeout(burst.timer);
    S.queuedAuthoringMutations -= 1;
    if (S.queuedAuthoringMutations === 0) {
      S.queuedDocumentText = null;
      S.replayPendingDisplayEdits([]);
    }
    const result = { ok: false, failure: normalizeFailure(new ClientClosedError('Annotated text document is unavailable')) };
    for (const waiter of burst.waiters) waiter.resolve(result);
    S.publishAnnotatedDocument();
  };
S.dispatchNow = async function dispatchNow(command, actionId)  {
    if (!S.session.snapshot || !S.snapshotBinding.authoring) throw new ClientClosedError('Annotated text document is unavailable');
    const tokenAt = (value) => {
      if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new TypeError('annotated text position is invalid');
      if (value.affinity !== 'left' && value.affinity !== 'right') throw new TypeError('annotated text position requires an affinity');
      return { positionToken: S.snapshotBinding.authoring.documentPositionToken, offset: value.offset, affinity: value.affinity };
    };
    const translated = { ...command, id: S.documentId, authoring: { version: 1, stream: S.snapshotBinding.authoring.stream, lease: S.snapshotBinding.authoring.lease, mutationId: command.mutationId ?? S.randomToken() } };
    if (command.at) translated.at = tokenAt(command.at);
    if (command.from) translated.from = tokenAt(command.from);
    if (command.to) translated.to = tokenAt(command.to);
    const action = annotatedTextAction(S.entity, S.field, translated);
    S.translatedActions += 1;
    try {
      return await S.session.dispatch(action.type, action.payload, actionId === undefined ? undefined : { actionId });
    } finally {
      S.translatedActions -= 1;
      S.flushAuthoringAcknowledgements();
    }
  };
if (!S.context || typeof S.context !== 'object' || typeof S.context.documentId !== 'string' || S.context.documentId.length === 0) {
    throw new TypeError('annotated text context requires a documentId');
  }
({ entity: S.entity, field: S.field, documentId: S.documentId } = S.context);
if (typeof S.entity?.name !== 'string' || typeof S.field?.fieldName !== 'string' || S.entity.fields?.[S.field.fieldName]?.kind !== 'annotatedText') {
    throw new TypeError('annotated text context requires declared entity and field handles');
  }
S.scope = `annotated-text:${S.documentId}`;
S.randomToken = () => {
    if (!globalThis.crypto?.getRandomValues) throw new Error('secure random authoring tokens are unavailable');
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  };
S.authoringClientStorageKey = `workbench:annotated-text-authoring-client:${JSON.stringify([
    S.baseUrl.replace(/\/+$/, ''), S.entity.name, S.field.fieldName, S.documentId,
  ])}`;
S.authoringClient = undefined;
try {
    const stored = globalThis.sessionStorage?.getItem(S.authoringClientStorageKey);
    S.authoringClient = typeof stored === 'string' && /^[A-Za-z0-9_-]{43}$/.test(stored) ? stored : S.randomToken();
    if (stored !== S.authoringClient) {
      try { globalThis.sessionStorage?.setItem(S.authoringClientStorageKey, S.authoringClient); } catch {}
    }
  } catch {
    S.authoringClient = S.randomToken();
  }
S.deferredAuthoringAcknowledgements = new Map();
S.authoringMutationTail = null;
S.sessionClosed = false;
S.wakeAuthoringMutation = null;
S.translatedActions = 0;
S.familyReplica = null;
S.displayFamily = null;
S.pendingDisplayEdits = [];
S.pendingAnnotationRanges = new Map();
S.pendingAnnotationActionIds = new Map();
S.queuedDocumentText = null;
S.queuedAuthoringMutations = 0;
S.resolutionFailedOnce = false;
S.resolutionTerminal = false;
S.resolutionRecoveryInFlight = false;
S.snapshotBinding = createAnnotatedTextSnapshotSessionBinding();
S.requestIdentity = { entity: S.entity.name, field: S.field.fieldName, documentId: S.documentId, authoringClient: S.authoringClient };
if (typeof S.context.viewAs === 'string' && S.context.viewAs.length > 0) S.requestIdentity.viewAs = S.context.viewAs;
S.localActionCounter = 0;
S.mintActionId = () => {
    if (typeof S.createActionId === 'function') return S.createActionId();
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `annotated_op_${++S.localActionCounter}`;
  };
S.caretsOption = S.carets ?? null;
S.caretListeners = new Set();
S.caretChannel = null;
if (S.caretsOption != null) {
    if (typeof S.caretsOption !== 'object' || Array.isArray(S.caretsOption)
      || typeof S.caretsOption.wsBaseUrl !== 'string' || S.caretsOption.wsBaseUrl.length === 0) {
      throw new TypeError('annotated text carets option requires a wsBaseUrl');
    }
    if (S.caretsOption.socketFactory !== undefined && typeof S.caretsOption.socketFactory !== 'function') {
      throw new TypeError('annotated text carets socketFactory must be a function');
    }
    try {
      S.caretChannel = new LiveChannel(S.caretsOption.wsBaseUrl, {
        ...(typeof S.caretsOption.socketFactory === 'function' ? { socketFactory: S.caretsOption.socketFactory } : {}),
      });
      // Eager subscribe so presence is ready when the editor first focuses.
      // A host without WebSocket support rejects the subscription; degrade to a
      // no-op channel instead of failing session construction.
      S.caretChannel.subscribe(S.entity.name, S.documentId, {
        carets: [S.field.fieldName],
        onCaret: (frame) => {
          for (const listener of S.caretListeners) {
            try { listener(frame); } catch { /* isolate consumers */ }
          }
        },
      }).catch(() => {});
    } catch {
      S.caretChannel = null;
    }
  }
S.session = createLiveDeliveryHttpSession({
    baseUrl: S.baseUrl,
    scope: S.scope,
    historySession: S.historySession,
    fetchImpl: S.fetchImpl,
    eventSourceFactory: S.eventSourceFactory,
    createActionId: S.createActionId,
    requestIdentity: S.requestIdentity,
    onRecoveryStart: () => {
      S.familyReplica = null;
      S.resetOptimisticProjection();
      revokeAnnotatedTextSnapshotSessionBinding(S.snapshotBinding);
    },
    onRecoveryDelayed: S.onRecoveryDelayed,
    fold: S.foldAnnotatedTextDocument,
    optimistic(document, action) {
      // Blockless: the document is ONE text and the action carries absolute
      // offsets; the text-splice projection needs no block mapping. Pending
      // annotation applies anchor their authoring offsets against the basis
      // captured at apply time (see pendingAnnotationRanges) so the placeholder
      // stays positional across a concurrent foreign edit.
      const edit = action?.payload?.version === 9 ? action.payload.edit : null;
      const relatedAction = S.pendingAnnotationRanges.get(action?.actionId);
      if (!edit && relatedAction?.kind === 'annotationEntityRemoveAction' && action?.payload?.version === 1) {
        // A pending generated removal optimistically hides its annotation (and
        // its ranges) exactly like a structural annotation.remove would.
        return projectPendingAnnotatedTextDocument(document, {
          payload: {
            version: 9,
            edit: {
              kind: 'annotation.remove',
              mutationId: action.payload.mutationId,
              annotationId: relatedAction.annotationId,
            },
          },
        }, null);
      }
      if (!edit && relatedAction?.kind === 'annotationEntityAction' && action?.payload?.version === 1) {
        return projectPendingAnnotatedTextDocument(document, {
          payload: {
            version: 9,
            edit: {
              kind: 'annotation.apply',
              mutationId: action.payload.mutationId,
              annotation: relatedAction.annotation,
              from: { offset: action.payload.from, affinity: 'left' },
              to: { offset: action.payload.to, affinity: 'right' },
            },
          },
        }, { range: relatedAction.range });
      }
      if (edit?.kind === 'annotation.apply') {
        // Keyed by the operation's action identity so a reconciled/re-applied op
        // drops its own captured range instead of leaking it.
        const entry = S.pendingAnnotationRanges.get(action?.actionId);
        const range = entry ? entry.range : undefined;
        // While the apply is still pending (publish() only re-projects pending,
        // non-echoed operations) the confirmed base never carries the
        // annotation yet, so we must always re-project it with the captured
        // authoring-basis range. projectAnnotationApply upserts by stable id,
        // so the projection is idempotent across folds.
        if (range != null) {
          return projectPendingAnnotatedTextDocument(document, action, { range });
        }
        return projectPendingAnnotatedTextDocument(document, action, null);
      }
      return projectPendingAnnotatedTextDocument(document, action, null);
    },
    serializeAction(action) {
      return action.payload?.edit?.kind === 'text.insert'
        || action.payload?.edit?.kind === 'text.delete'
        || action.payload?.edit?.kind === 'text.replace'
        || action.payload?.edit?.kind === 'annotation.apply'
        || action.payload?.edit?.kind === 'annotation.paste'
        || action.payload?.edit?.kind === 'annotation.remove';
    },
    validateSnapshot(snapshot, delivery) {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('annotated text delivery snapshot must be an object');
      const authoring = delivery?.authoring;
      const deliveryCursor = delivery?.cursor ?? delivery?.seq;
      if (!authoring || authoring.acknowledgementFence !== deliveryCursor) throw new Error('annotated text delivery authoring envelope is invalid');
      const documentPositionToken = authoring.positionFrames?.[0]?.positionToken;
      if (!documentPositionToken || typeof documentPositionToken !== 'string') throw new Error('annotated text delivery authoring position token is invalid');
      S.snapshotBinding.authoring = Object.freeze({
        stream: authoring.stream,
        lease: authoring.lease,
        snapshot: authoring.snapshot,
        acknowledgementFence: authoring.acknowledgementFence,
        documentPositionToken,
        groupTokens: new Map(),
        splitResolutions: Object.freeze([]),
      });
      // For fully-unredacted recipients the authoring envelope carries the
      // canonical family checkpoint; seed the fold reducer from it so
      // subsequent folds apply against the client's own copy instead of
      // re-shipping the whole family per keystroke.
      S.familyReplica = authoring.family ? restoreTextFamily(authoring.family) : null;
      S.replayPendingDisplayEdits([...S.pendingDisplayEdits]);
      S.rebuildQueuedDocumentText(snapshot[S.field?.fieldName]?.text);
      const result = materializeAnnotatedTextSnapshot({ ...snapshot[S.field?.fieldName], authoring }, S.field, { binding: S.snapshotBinding, family: S.familyReplica });
      return result;
    },
  });
S.documentListeners = new Set();
}
