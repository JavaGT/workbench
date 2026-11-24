// workbench-client-annotated-http-ops-3.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { revokeAnnotatedTextSnapshotSessionBinding } from './workbench-annotated-text-snapshot-internal.mjs';
import { ClientClosedError } from './workbench-client-core.mjs';
import { normalizeFailure } from './workbench-client-errors.mjs';

export function install2(S) {
S.session.subscribe((document) => {
    if (document === null) revokeAnnotatedTextSnapshotSessionBinding(S.snapshotBinding);
    if (document && S.snapshotBinding.authoring) {
      const authoring = S.snapshotBinding.authoring;
      if (S.translatedActions === 0) S.acknowledgeAuthoring(authoring);
      else S.deferredAuthoringAcknowledgements.set(authoring.snapshot, authoring);
    }
    S.publishAnnotatedDocument();
  });
S.TEXT_BURST_IDLE_MS = Math.max(0, Number(S.typingBurstIdleMs) || 0);
S.TEXT_BURST_MAX_MS = Math.max(S.TEXT_BURST_IDLE_MS, Number(S.typingBurstMaxMs) || 0);
S.openInsertBurst = null;
S.annotatedSurface = {
    get document() { return S.currentAnnotatedDocument(); },
    get family() { return S.displayFamily ?? S.familyReplica; },
    recoverFromUnresolvableRange: S.recoverFromUnresolvableRange,
    get history() { return S.session.history; },
    // Declared on AnnotatedTextHttpSession in client.d.ts; hosts fence document
    // history on the live-delivery session's optimistic operation count.
    pendingCount() { return S.session.pendingCount(); },
    get status() { return S.session.status; },
    // #252: forward the lease-capacity retry reason so a host can tell the user
    // why authoring is blocked instead of showing generic recovery.
    get recoveryReason() { return S.session.recoveryReason; },
    get ready() { return S.session.ready; },
    insert({ mutationId, at, text }) {
      const command = { kind: 'text.insert', mutationId, at, text };
      return S.queueTextInsert(command, (current, actionId) => S.dispatchNow(current, actionId));
    },
    delete({ mutationId, from, to }) {
      S.flushOpenInsertBurst();
      const command = { kind: 'text.delete', mutationId, from, to };
      return S.queueAuthoringMutation(command, (current, actionId) => S.dispatchNow(current, actionId));
    },
    paste({ mutationId, at, text, annotation }) {
      // An annotation-bearing paste is its own semantic operation: it must
      // never coalesce into a typing burst (the burst combiner only carries
      // { at, text } and would drop the annotation sidecar). The server mints
      // the fresh annotation id; the client projects the text immediately and
      // the annotation arrives on the confirmed echo.
      S.flushOpenInsertBurst();
      if (!at || typeof at !== 'object' || !Number.isSafeInteger(at.offset) || at.offset < 0
        || (at.affinity !== 'left' && at.affinity !== 'right')) {
        return Promise.resolve({ ok: false, failure: normalizeFailure(new TypeError('annotated text paste requires a valid at position')) });
      }
      if (typeof text !== 'string' || text.length === 0) {
        return Promise.resolve({ ok: false, failure: normalizeFailure(new TypeError('annotated text pasted text must be non-empty')) });
      }
      if (!annotation || typeof annotation !== 'object'
        || typeof annotation.family !== 'string' || annotation.family.length === 0
        || (annotation.fields !== undefined && (typeof annotation.fields !== 'object' || annotation.fields === null || Array.isArray(annotation.fields)))) {
        return Promise.resolve({ ok: false, failure: normalizeFailure(new TypeError('annotated text paste requires an annotation family')) });
      }
      const command = { kind: 'annotation.paste', mutationId, at, text, annotation: { family: annotation.family, ...(annotation.fields ? { fields: { ...annotation.fields } } : {}) } };
      return S.queueAuthoringMutation(command, (current, actionId) => S.dispatchNow(current, actionId));
    },
    replace(input) {
      S.flushOpenInsertBurst();
      if (!input || typeof input !== 'object') return { ok: false, failure: normalizeFailure(new TypeError('annotated text replace requires from, to, and text')) };
      // An insert (empty selection) must NOT be sent as text.replace: the
      // server rejects a replace with an empty delete range. Route it to
      // text.insert so editor keystrokes and IME inserts submit correctly.
      const isInsert = input?.from?.offset === input?.to?.offset && input?.text;
      const command = isInsert
        ? { kind: 'text.insert', mutationId: input?.mutationId, at: input.from, text: input.text }
        : {
            kind: input?.text ? 'text.replace' : 'text.delete',
            mutationId: input?.mutationId,
            from: input?.from,
            to: input?.to,
            ...(input?.text ? { text: input.text } : {}),
          };
      return command.kind === 'text.insert'
        ? S.queueTextInsert(command, (current, actionId) => S.dispatchNow(current, actionId))
        : S.queueAuthoringMutation(command, (current, actionId) => S.dispatchNow(current, actionId));
    },
    applyAnnotation({ mutationId, annotation, from, to }) {
      S.flushOpenInsertBurst();
      const command = { kind: 'annotation.apply', mutationId, annotation, from, to };
      // The apply is ALWAYS dispatched as a token-based v9 authoring action;
      // the server anchors the authoring offsets authoritatively. A locally
      // resolvable family is a best-effort enhancement that lets the optimistic
      // placeholder anchor to recipient-v2 endpoints once and keep them
      // positional across a concurrent foreign fold. Without one (family-less /
      // v1 offset recipients) no anchored basis is captured and the offset-form
      // optimistic projection / confirmed echo reconciles the view instead.
      const resolved = S.resolvePendingAnnotationRange(S.displayFamily ?? S.familyReplica, annotation, from, to);
      // Mint the action identity up front and key the captured range by it, so
      // the optimistic projector looks it up and settlement retires it by the
      // SAME operation identity (not annotation id, which is not unique).
      const actionId = S.mintActionId();
      if (resolved !== null) {
        S.pendingAnnotationRanges.set(actionId, Object.freeze({ annotationId: annotation.id, range: resolved }));
      }
      return S.queueAuthoringMutation(command, (current, actionId) => S.dispatchNow(current, actionId), { actionId });
    },
    applyAnnotationAction(actionHandle, { mutationId, from, to, values }) {
        if (!actionHandle || (actionHandle.kind !== 'annotationEntityAction' && actionHandle.kind !== 'annotationAction') || typeof actionHandle.actionName !== 'string') {
          throw new TypeError('annotated text action handle is invalid');
        }
        const annotationHandle = S.field.annotations?.[actionHandle.family];
        const expectedHandle = annotationHandle?.actions?.[actionHandle.actionName];
        if (!annotationHandle || expectedHandle !== actionHandle) throw new TypeError('annotated text action handle is not declared by this document');
        if (typeof mutationId !== 'string' || mutationId.length === 0
          || !from || typeof from !== 'object' || Array.isArray(from)
          || !to || typeof to !== 'object' || Array.isArray(to)
          || !Number.isSafeInteger(from.offset) || !Number.isSafeInteger(to.offset)
          || (from.affinity !== 'left' && from.affinity !== 'right')
          || (to.affinity !== 'left' && to.affinity !== 'right')
          || !values || typeof values !== 'object' || Array.isArray(values)
          || (Object.getPrototypeOf(values) !== Object.prototype && Object.getPrototypeOf(values) !== null)
          || Reflect.ownKeys(values).some((key) => typeof key !== 'string')) throw new TypeError('annotated text action input is invalid');
        const expectedNames = actionHandle.kind === 'annotationAction' ? actionHandle.inputNames : Object.keys(actionHandle.input ?? {});
        const valueNames = Object.keys(values);
        if (valueNames.length !== expectedNames.length || valueNames.some((key) => !expectedNames.includes(key))) throw new TypeError('annotated text action values contain unknown or missing fields');
      const actionId = S.pendingAnnotationActionIds.get(mutationId) ?? S.mintActionId();
      const annotation = Object.freeze({ id: actionId, family: actionHandle.family, fields: { [actionHandle.relation]: actionId } });
      S.pendingAnnotationActionIds.set(mutationId, actionId);
      const command = { kind: 'annotation.apply', mutationId, annotation, from, to, values };
      const resolvedRange = S.resolvePendingAnnotationRange(S.displayFamily ?? S.familyReplica, annotation, from, to);
      if (resolvedRange !== null) S.pendingAnnotationRanges.set(actionId, { kind: 'annotationEntityAction', annotation, range: resolvedRange });
      return S.queueAuthoringMutation(command, async (current) => {
         if (!S.session.snapshot || !S.snapshotBinding.authoring) throw new ClientClosedError('Annotated text document is unavailable');
         const action = {
            type: `${S.entity.name}.${S.field.fieldName}.${actionHandle.family}.${actionHandle.actionName}`,
           payload: Object.freeze({ version: 1, id: S.documentId, basis: S.snapshotBinding.authoring.documentPositionToken, mutationId: current.mutationId, from: current.from?.offset, to: current.to?.offset, values: Object.freeze({ ...(current.values ?? {}) }) }),
         };
         S.translatedActions += 1;
          try { return await S.session.dispatch(action.type, action.payload, { actionId }); }
         finally { S.translatedActions -= 1; S.flushAuthoringAcknowledgements(); }
       });
     },
    removeAnnotationEntity(actionHandle, { mutationId, annotationId, relatedId, expected }) {
      if (!actionHandle || actionHandle.kind !== 'annotationEntityRemoveAction' || typeof actionHandle.actionName !== 'string') {
        throw new TypeError('annotated text action handle is invalid');
      }
      const annotationHandle = S.field.annotations?.[actionHandle.family];
      const expectedHandle = annotationHandle?.actions?.[actionHandle.actionName];
      if (!annotationHandle || expectedHandle !== actionHandle) throw new TypeError('annotated text action handle is not declared by this document');
      if (typeof mutationId !== 'string' || mutationId.length === 0
        || typeof annotationId !== 'string' || annotationId.length === 0
        || typeof relatedId !== 'string' || relatedId.length === 0
        || typeof expected !== 'string' || expected.length === 0) throw new TypeError('annotated text removal input is invalid');
      S.flushOpenInsertBurst();
      // The annotation disappears optimistically; retire any captured range
      // anchored to it (the map is keyed by action identity, so scan entries).
      for (const [pendingActionId, entry] of S.pendingAnnotationRanges) {
        if (entry.annotationId === annotationId) S.pendingAnnotationRanges.delete(pendingActionId);
      }
      // Retain the envelope identity by mutation id so an uncertain retry
      // reuses the same durable receipt (mirrors the compose action).
      const actionId = S.pendingAnnotationActionIds.get(mutationId) ?? S.mintActionId();
      S.pendingAnnotationActionIds.set(mutationId, actionId);
      S.pendingAnnotationRanges.set(actionId, { kind: 'annotationEntityRemoveAction', annotationId });
      return S.queueAuthoringMutation({ kind: 'annotation.remove', mutationId, annotationId }, async () => {
        if (!S.session.snapshot || !S.snapshotBinding.authoring) throw new ClientClosedError('Annotated text document is unavailable');
        const action = {
          type: `${S.entity.name}.${S.field.fieldName}.${actionHandle.family}.${actionHandle.actionName}`,
          payload: Object.freeze({ version: 1, id: S.documentId, mutationId, annotationId, relatedId, expected }),
        };
        S.translatedActions += 1;
        try { return await S.session.dispatch(action.type, action.payload, { actionId }); }
        finally { S.translatedActions -= 1; S.flushAuthoringAcknowledgements(); }
      }, { actionId });
    },
    removeAnnotation({ mutationId, annotationId }) {
      S.flushOpenInsertBurst();
      // Retire any captured range for removed annotations by annotation id (the
      // map is keyed by action identity, so scan for matching entries).
      for (const [actionId, entry] of S.pendingAnnotationRanges) {
        if (entry.annotationId === annotationId) S.pendingAnnotationRanges.delete(actionId);
      }
      const command = { kind: 'annotation.remove', mutationId, annotationId };
      return S.queueAuthoringMutation(command, (current, actionId) => S.dispatchNow(current, actionId));
    },
    reconnect: () => S.session.reconnect(),
    // Subscribe delivers the same document view the session.document getter
    // exposes. The underlying delivery publishes the raw blockless recipient
    // snapshot; listeners also receive locally queued text projections.
    subscribe(listener) {
      S.documentListeners.add(listener);
      listener(S.currentAnnotatedDocument());
      return () => S.documentListeners.delete(listener);
    },
    close: () => S.closeAnnotatedSession(),
  };
if (S.caretsOption != null) {
    S.annotatedSurface.publishCaret = function publishCaret({ offset, selection } = {}) {
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new TypeError('annotated text caret offset must be a non-negative safe integer');
      }
      if (selection !== undefined && (typeof selection !== 'object' || selection === null || Array.isArray(selection))) {
        throw new TypeError('annotated text caret selection must be a { from, to } range');
      }
      if (!S.caretChannel) return false;
      return S.caretChannel.updateCaret({
        entity: S.entity.name, id: S.documentId, field: S.field.fieldName, offset,
        ...(selection === undefined ? {} : { selection }),
      });
    };
    S.annotatedSurface.clearCaret = function clearCaret() {
      if (!S.caretChannel) return false;
      return S.caretChannel.clearCaret({ entity: S.entity.name, id: S.documentId, field: S.field.fieldName });
    };
    S.annotatedSurface.onCaret = function onCaret(listener) {
      if (typeof listener !== 'function') throw new TypeError('annotated text caret listener must be a function');
      S.caretListeners.add(listener);
      return () => S.caretListeners.delete(listener);
    };
  }
}
