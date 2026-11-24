// workbench-client-annotated-http-ops-1.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { applyOffsetTextEdit, applyTextOperation, materializeText as materializeFamilyText, resolveOffsetToEndpoint } from './workbench-annotated-text-continuous.mjs';
import { revokeAnnotatedTextSnapshotSessionBinding } from './workbench-annotated-text-snapshot-internal.mjs';
import { isOffsetRange, resolveRangeOffsets, shiftOffsetRangesOverText, tryResolveRangesOffsets } from './workbench-annotated-text-snapshot.mjs';
import { annotatedDocumentView, deepFreeze } from './workbench-client-core.mjs';
import { normalizeFailure } from './workbench-client-errors.mjs';

export function install0(S) {
S.installAuthoringFromFold = function installAuthoringFromFold(foldAuthoring, fence)  {
    if (!foldAuthoring || foldAuthoring.acknowledgementFence !== fence) {
      throw new Error('annotated text fold authoring fence mismatch');
    }
    const positionFrames = foldAuthoring.positionFrames;
    if (!Array.isArray(positionFrames) || positionFrames.length === 0
      || !positionFrames[0] || typeof positionFrames[0].positionToken !== 'string') {
      throw new Error('annotated text fold position frame is invalid');
    }
    S.snapshotBinding.authoring = Object.freeze({
      stream: foldAuthoring.stream,
      lease: foldAuthoring.lease,
      snapshot: foldAuthoring.snapshot,
      acknowledgementFence: fence,
      // A fold refreshes the one document-scoped position token; the binding is
      // rebuilt fresh so stale block-era group/split state never survives.
      documentPositionToken: positionFrames[0].positionToken,
      groupTokens: new Map(),
      splitResolutions: Object.freeze([]),
    });
  };
S.applyAnnotatedTextFoldDispositions = function applyAnnotatedTextFoldDispositions(currentDocument, ranges, dispositions)  {
    if (!Array.isArray(dispositions)) throw new Error('annotated text fold dispositions are invalid');
    const annotationById = new Map(currentDocument.annotations.map((annotation) => [annotation.id, annotation]));
    const dispositionById = new Map();
    for (const disposition of dispositions) {
      if (!disposition || typeof disposition !== 'object' || Array.isArray(disposition)
        || typeof disposition.annotationId !== 'string'
        || (disposition.kind !== 'deleted' && disposition.kind !== 'orphaned')
        || typeof disposition.family !== 'string'
        || (disposition.kind === 'orphaned' && typeof disposition.savedQuote !== 'string')) {
        throw new Error('annotated text fold disposition is invalid');
      }
      const annotation = annotationById.get(disposition.annotationId);
      if (!annotation) throw new Error('annotated text fold disposition names an unknown annotation');
      if (annotation.family !== disposition.family) throw new Error('annotated text fold disposition family disagrees');
      if (dispositionById.has(disposition.annotationId)) throw new Error('annotated text fold disposition is duplicated');
      dispositionById.set(disposition.annotationId, disposition);
    }
    const retainedRanges = [];
    const orphans = [...(currentDocument.orphans ?? [])];
    for (const range of ranges) {
      const disposition = dispositionById.get(range.annotationId);
      if (disposition) {
        // The server is authoritative: the annotation is gone from the active
        // ranges regardless of the local projection's width approximation.
        if (disposition.kind === 'orphaned') {
          const annotation = annotationById.get(range.annotationId);
          orphans.push(deepFreeze({
            id: annotation.id,
            family: annotation.family,
            fields: { ...annotation.fields },
            savedQuote: disposition.savedQuote,
            ...(annotation.owner ? { owner: annotation.owner } : {}),
          }));
        }
        continue;
      }
      // A range the server emptied always carries a disposition. A collapsed
      // range without one is a projection divergence; recover with a snapshot.
      const offsets = resolveRangeOffsets(range, S.familyReplica);
      if (offsets.start >= offsets.end) throw new Error('annotated text fold collapsed a range without a disposition');
      retainedRanges.push(range);
    }
    const retainedAnnotations = currentDocument.annotations.filter((annotation) => !dispositionById.has(annotation.id));
    // The server's snapshot canonicalizes orphans by `ORDER BY a.id` (see
    // annotated-text-snapshot.mjs). A fold must reproduce that EXACT order so
    // a folded document is byte-for-byte the fresh authorized snapshot: new
    // orphans are appended in range order above, so sort the combined list
    // canonically before installing it. Fields are preserved by the stable id
    // sort.
    const canonicalOrphans = [...orphans].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    return Object.freeze({
      ...currentDocument,
      ranges: Object.freeze(retainedRanges),
      annotations: Object.freeze(retainedAnnotations),
      orphans: Object.freeze(canonicalOrphans),
    });
  };
S.foldAnnotatedTextDocument = function foldAnnotatedTextDocument(currentDocument, envelope)  {
    const startedAt = S.onFoldApplied ? performance.now() : 0;
    const fold = envelope?.fold;
    if (!fold || fold.kind !== 'annotatedText' || fold.version !== 5 || fold.field !== S.field.fieldName) {
      throw new Error('annotated text fold envelope is missing or unsupported');
    }
    const fence = envelope.seq ?? envelope.seqSpan?.[1];
    if (fold.fence !== fence || fold.authoring?.acknowledgementFence !== fence) {
      throw new Error('annotated text fold fence mismatch');
    }
    if (fold.text?.reducer !== 'workbench.text' || !Array.isArray(fold.text.operations) || fold.text.operations.length === 0) {
      throw new Error('annotated text fold text operations are invalid');
    }
    if (!fold.projection || typeof fold.projection.text !== 'string') {
      throw new Error('annotated text fold projection is invalid');
    }
    if (!Array.isArray(fold.dispositions)) {
      throw new Error('annotated text fold dispositions are invalid');
    }
    // The family seed comes from the snapshot's authoring envelope (fully
    // unredacted recipients). A fold against no seeded checkpoint cannot verify
    // the transition; fail closed so the session recovers with a fresh snapshot.
    if (!S.familyReplica) {
      throw new Error('annotated text fold requires a family checkpoint seeded by the snapshot');
    }
    const beforeFamily = S.familyReplica;
    let family = S.familyReplica;
    // A fold ships text operations only. Anchored ranges stay put — they
    // resolve against the advanced family at point of use. Offset-form
    // (redacted) ranges never reach this fold. Dispositions still decide
    // each emptied annotation's delete-vs-orphan fate.
    for (const operation of fold.text.operations) {
      family = applyTextOperation(family, operation);
    }
    const foldedRanges = currentDocument.ranges;
    if (materializeFamilyText(family) !== fold.projection.text) {
      throw new Error('annotated text fold projection disagrees with family');
    }
    // A causally-reducible fold must leave NO pending operations behind: a
    // syntactically valid op whose dependency is absent would materialize the
    // same text now and then silently drain into the document on a later fold,
    // desynchronizing the session. The element count is required and exact.
    if (!Number.isSafeInteger(fold.familyElementCount)
      || Object.keys(family.checkpoint.elements).length !== fold.familyElementCount) {
      throw new Error('annotated text fold family element count disagrees');
    }
    if (Object.keys(family.checkpoint.pending).length !== 0 || family.checkpoint.rebootstrapRequired) {
      throw new Error('annotated text fold left pending operations behind; snapshot recovery required');
    }
    S.familyReplica = family;
    S.consumeFoldedDisplayEdits(beforeFamily, envelope.event?.actionId);
    // The family advanced (possibly by a foreign edit); re-derive the queued
    // text so the optimistic overlay stays equal to the replayed display family.
    S.rebuildQueuedDocumentText(fold.projection.text);
    S.installAuthoringFromFold(fold.authoring, fence);
    if (S.onFoldApplied) S.onFoldApplied(fold, performance.now() - startedAt);
    const foldedDocument = S.applyAnnotatedTextFoldDispositions(currentDocument, foldedRanges, fold.dispositions);
    return Object.freeze({ ...foldedDocument, text: fold.projection.text });
  };
S.acknowledgeAuthoring = function acknowledgeAuthoring(authoring)  {
    void Promise.resolve().then(() => S.fetchImpl(`${S.baseUrl.replace(/\/$/, '')}/authoring/ack`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, entity: S.entity.name, field: S.field.fieldName, documentId: S.documentId,
        stream: authoring.stream, lease: authoring.lease, snapshot: authoring.snapshot,
        ...(S.context.viewAs ? { viewAs: S.context.viewAs } : {}) }),
    })).catch(() => {});
  };
S.flushAuthoringAcknowledgements = function flushAuthoringAcknowledgements()  {
    if (S.translatedActions !== 0) return;
    for (const authoring of S.deferredAuthoringAcknowledgements.values()) S.acknowledgeAuthoring(authoring);
    S.deferredAuthoringAcknowledgements.clear();
  };
S.rebuildQueuedDocumentText = function rebuildQueuedDocumentText(baseText)  {
    if (!S.pendingDisplayEdits.length) {
      S.queuedDocumentText = null;
      return;
    }
    let text = baseText ?? '';
    for (const edit of S.pendingDisplayEdits) {
      if (!Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to) || edit.from < 0 || edit.to < edit.from || edit.to > text.length) {
        S.queuedDocumentText = null;
        return;
      }
      text = `${text.slice(0, edit.from)}${edit.text}${text.slice(edit.to)}`;
    }
    S.queuedDocumentText = text === baseText ? null : text;
  };
S.resetOptimisticProjection = function resetOptimisticProjection()  {
    S.queuedDocumentText = null;
    S.displayFamily = S.familyReplica;
    // A snapshot recovery reboots the family; captured authoring-basis anchors
    // from before the reset are stale and must not be reused.
    S.pendingAnnotationRanges.clear();
  };
S.displayEditFromCommand = function displayEditFromCommand(command)  {
    if (command?.kind === 'text.insert') {
      const offset = command.at?.offset;
      if (!Number.isSafeInteger(offset)) return null;
      return { from: offset, to: offset, text: command.text ?? '' };
    }
    if (command?.kind === 'text.delete' || command?.kind === 'text.replace') {
      const from = command.from?.offset;
      const to = command.to?.offset;
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
      return { from, to, text: command.kind === 'text.replace' ? (command.text ?? '') : '' };
    }
    return null;
  };
S.replayPendingDisplayEdits = function replayPendingDisplayEdits(edits)  {
    S.pendingDisplayEdits.splice(0, S.pendingDisplayEdits.length, ...edits);
    if (!S.familyReplica) {
      S.displayFamily = null;
      return;
    }
    let family = S.familyReplica;
    try {
      for (const edit of S.pendingDisplayEdits) {
        family = applyOffsetTextEdit(family, edit.from, edit.to, edit.text);
      }
      S.displayFamily = family;
    } catch {
      S.pendingDisplayEdits.length = 0;
      S.displayFamily = S.familyReplica;
    }
  };
S.applyPendingDisplayEdit = function applyPendingDisplayEdit(command, actionId)  {
    const edit = S.displayEditFromCommand(command);
    if (!edit || !S.displayFamily) return;
    try {
      S.displayFamily = applyOffsetTextEdit(S.displayFamily, edit.from, edit.to, edit.text);
      S.pendingDisplayEdits.push(actionId === undefined ? edit : { ...edit, actionId });
    } catch {
      S.displayFamily = S.familyReplica;
    }
  };
S.consumeFoldedDisplayEdits = function consumeFoldedDisplayEdits(beforeFamily, actionId)  {
    if (!beforeFamily || S.pendingDisplayEdits.length === 0) {
      S.replayPendingDisplayEdits([]);
      return;
    }
    // Consume ONLY the pending edits dispatched under this actionId. A foreign
    // fold (an actionId not among the client's pending edits) consumes nothing;
    // the remaining edits are replayed against the newly-advanced family.
    const remaining = actionId === undefined
      ? [...S.pendingDisplayEdits]
      : S.pendingDisplayEdits.filter((edit) => edit.actionId !== actionId);
    S.replayPendingDisplayEdits(remaining);
  };
S.documentRangesUnresolvable = function documentRangesUnresolvable(view, family)  {
    if (!view || !Array.isArray(view.ranges) || view.ranges.every((range) => isOffsetRange(range))) return false;
    if (!family) return true;
    return tryResolveRangesOffsets(view.ranges, family) === null;
  };
S.closeAnnotatedSession = function closeAnnotatedSession()  {
    S.sessionClosed = true;
    S.cancelOpenInsertBurst();
    S.wakeAuthoringMutation?.();
    S.wakeAuthoringMutation = null;
    revokeAnnotatedTextSnapshotSessionBinding(S.snapshotBinding);
    if (S.caretChannel) {
      try { S.caretChannel.clearCaret({ entity: S.entity.name, id: S.documentId, field: S.field.fieldName }); } catch { /* best effort */ }
      try { S.caretChannel.close(); } catch { /* best effort */ }
      S.caretChannel = null;
    }
    S.caretListeners.clear();
    S.documentListeners.clear();
    S.session.close();
  };
S.recoverFromUnresolvableRange = function recoverFromUnresolvableRange()  {
    if (S.resolutionTerminal || S.resolutionRecoveryInFlight) return;
    if (S.resolutionFailedOnce) {
      S.resolutionTerminal = true;
      S.closeAnnotatedSession();
      return;
    }
    S.resolutionFailedOnce = true;
    S.resolutionRecoveryInFlight = true;
    Promise.resolve(S.session.reconnect()).finally(() => {
      S.resolutionRecoveryInFlight = false;
      if (S.resolutionTerminal) return;
      const view = S.currentAnnotatedDocument();
      if (S.documentRangesUnresolvable(view, S.displayFamily ?? S.familyReplica)) {
        S.resolutionTerminal = true;
        S.closeAnnotatedSession();
      } else {
        // A replacement snapshot resolved the ranges; rearm the one-shot latch
        // so a later independent failure gets its own recovery attempt.
        S.resolutionFailedOnce = false;
      }
    });
  };
S.currentAnnotatedDocument = function currentAnnotatedDocument()  {
    const view = annotatedDocumentView(S.session.snapshot);
    if (!view || S.queuedDocumentText === null) return view;
    const ranges = Array.isArray(view.ranges) && view.ranges.some((range) => isOffsetRange(range))
      ? shiftOffsetRangesOverText(view.ranges, view.text, S.queuedDocumentText)
      : view.ranges;
    return Object.freeze({
      ...view,
      text: S.queuedDocumentText,
      ranges,
    });
  };
S.resolvePendingAnnotationRange = function resolvePendingAnnotationRange(family, annotation, from, to)  {
    if (!family) return null;
    if (!annotation?.id || typeof annotation.id !== 'string' || annotation.id.length === 0) return null;
    const start = from?.offset;
    const end = to?.offset;
    // Affinities fail closed: require an explicit 'left' or 'right'. A
    // missing/invalid affinity yields no captured range so the optimistic
    // projection is left unchanged and the authoritative dispatch/validation
    // decides — never a silent default that could show a guessed range.
    const fromAffinity = from?.affinity;
    const toAffinity = to?.affinity;
    if ((fromAffinity !== 'left' && fromAffinity !== 'right')
      || (toAffinity !== 'left' && toAffinity !== 'right')) {
      return null;
    }
    const text = materializeFamilyText(family);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || end > text.length || start === end) {
      return null;
    }
    try {
      return Object.freeze({
        annotationId: annotation.id,
        start: resolveOffsetToEndpoint(family, start, family.checkpoint.frontier, fromAffinity),
        end: resolveOffsetToEndpoint(family, end, family.checkpoint.frontier, toAffinity),
      });
    } catch {
      return null;
    }
  };
S.publishAnnotatedDocument = function publishAnnotatedDocument()  {
    const view = S.currentAnnotatedDocument();
    for (const listener of S.documentListeners) {
      try { listener(view); } catch { /* isolate consumers */ }
    }
  };
S.sameCapturedBlocks = function sameCapturedBlocks(blocks)  {
    return blocks.get('document') === S.session.snapshot?.text;
  };
S.localAuthoringConflict = function localAuthoringConflict()  {
    return { ok: false, failure: normalizeFailure(new Error('annotated text changed before queued operation could be submitted')) };
  };
S.splitsSurrogate = function splitsSurrogate(text, offset)  {
    return offset > 0 && offset < text.length
      && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
      && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff;
  };
S.projectQueuedDocumentText = function projectQueuedDocumentText(text, command)  {
    if (command.kind === 'text.insert' || command.kind === 'annotation.paste') {
      const offset = command.at?.offset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || S.splitsSurrogate(text, offset)) return null;
      return text.slice(0, offset) + command.text + text.slice(offset);
    }
    if (command.kind === 'text.delete' || command.kind === 'text.replace') {
      const from = command.from?.offset;
      const to = command.to?.offset;
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > text.length
        || S.splitsSurrogate(text, from) || S.splitsSurrogate(text, to)) return null;
      return text.slice(0, from) + (command.kind === 'text.replace' ? command.text : '') + text.slice(to);
    }
    return text;
  };
S.applyQueuedTextCommand = function applyQueuedTextCommand(basis, command, actionId)  {
    const next = S.projectQueuedDocumentText(basis, command);
    if (next == null) return null;
    S.queuedDocumentText = next;
    S.applyPendingDisplayEdit(command, actionId);
    return next;
  };
}
