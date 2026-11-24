// workbench-client-delivery-ops-2.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { SNAPSHOT_PATCH_CAPABILITY, coversConfirmation, decideReplay, normalizeSeqSpan, reconcileAuthoritative, snapshotPatchVerdict } from './workbench-client-core.mjs';

export function install1(S) {
S.cursorAnchor = function cursorAnchor(value)  {
    return typeof value === 'object' ? value.anchor : value;
  };
S.sameCursor = function sameCursor(left, right)  {
    if (typeof left === 'object' && typeof right === 'object'
      && left.composite !== undefined && right.composite !== undefined) {
      return left.anchor === right.anchor && left.composite === right.composite;
    }
    return S.cursorAnchor(left) === S.cursorAnchor(right)
      && (typeof left === 'object') === (typeof right === 'object')
      && (typeof left !== 'object' || left.aggregate === right.aggregate);
  };
S.isKnownEnvelopeKind = function isKnownEnvelopeKind(envelope)  {
    return envelope != null && typeof envelope === 'object'
      && typeof envelope.type === 'string' && S.DELIVERY_ENVELOPE_KINDS.has(envelope.type);
  };
S.isAuthoritativeEnvelope = function isAuthoritativeEnvelope(envelope)  {
    return envelope != null && typeof envelope === 'object'
      && (envelope.type === 'event' || envelope.type === 'state');
  };
S.normalizeAuthoritative = function normalizeAuthoritative(envelope)  {
    if (!S.isAuthoritativeEnvelope(envelope)) throw new Error('delivery batch contains an invalid recipient envelope');
    const span = envelope.seqSpan ?? envelope.seq;
    const [lo, hi] = normalizeSeqSpan(span);
    S.assertCursor(lo, 'delivery sequence');
    S.assertCursor(hi, 'delivery sequence');
    if (lo > hi) throw new Error('delivery sequence span is inverted');
    return { envelope, seqSpan: [lo, hi] };
  };
S.applyEvent = function applyEvent(envelope)  {
    const { seqSpan } = S.normalizeAuthoritative(envelope);
    // A declared aggregate has no event reducer. Treat an unexpected event as
    // an opaque recovery boundary rather than acknowledging stale state.
    if (S.snapshotOnly) return { status: 'resync' };
    const decision = decideReplay(S.cursor, seqSpan);
    if (decision.kind === 'duplicate') return { status: 'duplicate' };
    if (decision.kind === 'gap') return { status: 'gap' };
    // Fold envelopes name the predecessor cursor explicitly. A mismatch means
    // the payload cannot be applied against the client's accepted base.
    if (envelope.fold
      && Number.isSafeInteger(envelope.fold.baseCursor)
      && envelope.fold.baseCursor !== S.cursorAnchor(S.cursor)) {
      return { status: 'resync' };
    }

    let nextSnapshot;
    try {
      nextSnapshot = S.fold(S.baseSnapshot, envelope);
    } catch {
      // A failed fold must not advance the cursor or acknowledgement fence.
      return { status: 'resync' };
    }
    // A fold callback may synchronously trigger terminal revocation through a
    // host lifecycle reaction. Do not restore state after that fail-closed turn.
    if (S.closed || S.status === 'revoked') return { status: 'revoked' };
    S.baseSnapshot = nextSnapshot;
    S.cursor = decision.cursor;
    S.lastSnapshotInstalledFromReceipt = false;
    const actionId = envelope.event?.actionId;
    const operation = actionId ? S.operations.get(actionId) : null;
    if (operation) {
      reconcileAuthoritative(
        operation, S.cursor, S.cursorAnchor(S.cursor),
        (op) => op.delivered,
        () => { S.settleOperation(operation, { status: 'reconciled' }); S.operations.delete(actionId); },
      );
    }
    S.publish();
    return { status: operation ? 'confirmed' : 'applied' };
  };
S.applyState = function applyState(envelope)  {
    const { seqSpan } = S.normalizeAuthoritative(envelope);
    const decision = decideReplay(S.cursor, seqSpan);
    if (decision.kind === 'duplicate') return { status: 'duplicate' };
    if (decision.kind === 'gap') return { status: 'gap' };
    let nextSnapshot;
    try {
      nextSnapshot = S.validateSnapshot(envelope.state ?? null, envelope);
    } catch {
      // An unvalidatable replacement must not advance the cursor or fence.
      return { status: 'resync' };
    }
    // A fold callback may synchronously trigger terminal revocation through a
    // host lifecycle reaction. Do not restore state after that fail-closed turn.
    if (S.closed || S.status === 'revoked') return { status: 'revoked' };
    S.baseSnapshot = nextSnapshot;
    S.cursor = decision.cursor;
    S.lastSnapshotInstalledFromReceipt = false;
    // A whole-state replacement names no per-action echo, so every delivered
    // operation whose confirmed receipt fence the replacement cursor covers is
    // reconciled — the same fence rule applyEvent uses for an echo.
    for (const [actionId, operation] of S.operations) {
      if (operation.delivered && coversConfirmation(S.cursorAnchor(S.cursor), operation.confirmedCursor)) {
        S.settleOperation(operation, { status: 'reconciled' });
        S.operations.delete(actionId);
      }
    }
    S.publish();
    return { status: 'applied' };
  };
S.armDeltaMode = function armDeltaMode(result)  {
    const advertised = result?.protocol === SNAPSHOT_PATCH_CAPABILITY
      && typeof result?.projectionToken === 'string' && result.projectionToken.length > 0;
    if (!advertised) {
      S.deltaCapable = false;
      return;
    }
    S.deltaCapable = true;
    S.projectionToken = result.projectionToken;
  };
S.disarmDeltaMode = function disarmDeltaMode()  {
    S.deltaCapable = false;
    S.projectionToken = null;
  };
S.applyAuthoritative = function applyAuthoritative(envelope)  {
    if (envelope?.type === 'snapshot-patch') return S.applySnapshotPatch(envelope);
    return envelope?.type === 'state' ? S.applyState(envelope) : S.applyEvent(envelope);
  };
S.isPlainObject = function isPlainObject(value)  {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      && (value.constructor === undefined || value.constructor === Object);
  };
S.isValidActionIdList = function isValidActionIdList(value)  {
    return Array.isArray(value) && value.every((id) => typeof id === 'string' && id.length > 0);
  };
S.validateSnapshotPatchEnvelope = function validateSnapshotPatchEnvelope(envelope, previous = null)  {
    if (!S.isPlainObject(envelope)) return null;
    if (envelope.type !== 'snapshot-patch' || envelope.protocol !== 'snapshot-patch/v1') return null;
    if (typeof envelope.declaration !== 'string' || envelope.declaration.length === 0) return null;
    if (typeof envelope.projectionToken !== 'string' || envelope.projectionToken.length === 0) return null;
    if (envelope.actionIds !== undefined && !S.isValidActionIdList(envelope.actionIds)) return null;
    if (envelope.routedInvisibleActionIds !== undefined && !S.isValidActionIdList(envelope.routedInvisibleActionIds)) return null;
    for (const key of ['from', 'to']) {
      const c = envelope[key];
      // Exact two-key composite cursor: anchor + composite, both nonnegative.
      if (!S.isPlainObject(c)
        || !Number.isSafeInteger(c.anchor) || c.anchor < 0
        || !Number.isSafeInteger(c.composite) || c.composite < 0
        || Object.keys(c).length !== 2) return null;
    }
    // `to` must be NEWER than `from` on the composite axis and never move the
    // anchor backwards (an anchor regression is a revoke signal, not a patch).
    if (envelope.to.composite < envelope.from.composite) return null;
    if (envelope.to.anchor < envelope.from.anchor) return null;
    // seqSpan must be exactly [from, to] in this protocol revision.
    const span = envelope.seqSpan;
    if (!Array.isArray(span) || span.length !== 2) return null;
    if (!S.isPlainObject(span[0]) || !S.isPlainObject(span[1])) return null;
    if (span[0].anchor !== envelope.from.anchor || span[0].composite !== envelope.from.composite) return null;
    if (span[1].anchor !== envelope.to.anchor || span[1].composite !== envelope.to.composite) return null;
    // Chain discipline (#156 edge coverage): the server may coalesce a journal
    // slice into MULTIPLE envelopes. Every envelope after the first must
    // continue exactly where its predecessor ended — a broken chain cannot be
    // replayed atomically, so it fails validation into snapshot recovery.
    if (previous
      && (previous.to.anchor !== envelope.from.anchor || previous.to.composite !== envelope.from.composite)) return null;
    if (!Array.isArray(envelope.operations)) return null;
    for (const operation of envelope.operations) {
      if (!S.isPlainObject(operation) || !S.SNAPSHOT_PATCH_OPERATIONS.has(operation.op)) return null;
      if (!Array.isArray(operation.path)
        || !operation.path.every((segment) => typeof segment === 'string' && segment.length > 0)) return null;
      switch (operation.op) {
        case 'put-keyed':
          if (typeof operation.id !== 'string' || operation.id.length === 0 || !S.isPlainObject(operation.value)) return null;
          break;
        case 'remove-keyed':
          if (typeof operation.id !== 'string' || operation.id.length === 0) return null;
          break;
        case 'replace-many':
          if (!Array.isArray(operation.value) || !operation.value.every(S.isPlainObject)) return null;
          break;
        case 'replace-one':
          if (operation.value !== null && !S.isPlainObject(operation.value)) return null;
          break;
        case 'replace-fields':
          if (!S.isPlainObject(operation.value)) return null;
          break;
      }
    }
    return envelope;
  };
S.navigatePatchPath = function navigatePatchPath(root, path)  {
    let current = root;
    for (const segment of path) {
      current = current?.[segment];
    }
    return current;
  };
S.applyPatchOperation = function applyPatchOperation(state, operation)  {
    const parent = S.navigatePatchPath(state, operation.path);
    if (parent == null || typeof parent !== 'object') throw new Error(`patch path resolves to nothing: ${operation.path.join('.')}`);
    switch (operation.op) {
      case 'put-keyed':
        parent[operation.id] = operation.value;
        return;
      case 'remove-keyed':
        delete parent[operation.id];
        return;
      case 'replace-many': {
        const segments = [...operation.path];
        const last = segments.pop();
        const holder = S.navigatePatchPath(state, segments);
        holder[last] = operation.value;
        return;
      }
      case 'replace-one':
      case 'replace-value': {
        const segments = [...operation.path];
        const last = segments.pop();
        const holder = S.navigatePatchPath(state, segments);
        holder[last] = operation.value;
        return;
      }
      case 'replace-fields': {
        // Exact-set replacement (design §4): the server emits the node's
        // COMPLETE retained key set in `value` — selected fields AND current
        // relation-branch values. Any local key omitted from `value` (except
        // identity) is stale and deleted: redaction or projection changes may
        // have removed it server-side. Because the value carries relation
        // values too, untouched relation branches round-trip unchanged.
        for (const existingKey of Object.keys(parent)) {
          if (existingKey === 'id' || existingKey in operation.value) continue;
          delete parent[existingKey];
        }
        Object.assign(parent, JSON.parse(JSON.stringify(operation.value)));
        return;
      }
      default:
        throw new Error(`unknown patch op ${operation.op}`);
    }
  };
S.shallowCloneNode = function shallowCloneNode(value)  {
    return Array.isArray(value) ? value.slice() : { ...value };
  };
S.buildPatchSpine = function buildPatchSpine(base, envelopes)  {
    const root = base !== null && typeof base === 'object' ? S.shallowCloneNode(base) : base;
    for (const checked of envelopes) {
      for (const operation of checked.operations) {
        let current = root;
        for (const segment of operation.path) {
          if (current === null || typeof current !== 'object') break;
          const child = current[segment];
          if (child === null || typeof child !== 'object') break;
          current[segment] = S.shallowCloneNode(child);
          current = current[segment];
        }
      }
    }
    return root;
  };
S.applySnapshotPatch = function applySnapshotPatch(envelopeOrBatch, previous = null)  {
    // 1. Grammar + protocol validation before ANYTHING mutates (#156 edge
    // coverage): when a coalesced chain of envelopes arrives together, every
    // envelope is validated — including from==prev.to chain discipline —
    // BEFORE the first operation applies. One bad link rejects the WHOLE
    // chain into snapshot recovery; never partial application.
    const envelopes = Array.isArray(envelopeOrBatch) ? envelopeOrBatch : [envelopeOrBatch];
    if (envelopes.length === 0) return { status: 'resync' };
    const valid = [];
    // A ledger handle mints exactly once (#156 round 2): the same token twice
    // within one coalesced chain is a replay/forgery even when neither copy
    // matches the currently-held handle.
    const chainTokens = new Set();
    let previousEnvelope = previous;
    for (const candidate of envelopes) {
      const checked = S.validateSnapshotPatchEnvelope(candidate, previousEnvelope);
      if (!checked) return { status: 'resync' };
      if (chainTokens.has(checked.projectionToken)) return { status: 'resync' };
      chainTokens.add(checked.projectionToken);
      valid.push(checked);
      previousEnvelope = checked;
    }
    // Delta ingestion is response-gated (#122 §12): a patch arriving before a
    // bootstrap advertised the capability back is out-of-grammar for this
    // session — recover through a snapshot, never apply.
    if (!S.deltaCapable) return { status: 'resync' };
    if (!S.cursor || typeof S.cursor !== 'object' || S.cursor.composite === undefined) return { status: 'resync' };
    // Token lifecycle (#156): an accepted patch ROTATES the ledger handle. An
    // envelope presenting (or repeating) the currently held token is a replay
    // or forgery — fail closed through snapshot recovery.
    if (valid.some((checked) => checked.projectionToken === S.projectionToken)) return { status: 'resync' };
    // 2. Cursor verdict (design §9) comes from the shared Replay decision via
    // snapshotPatchVerdict — never an ad-hoc composite comparison. The first
    // envelope must continue the recipient's cursor exactly; later links are
    // already proven contiguous by validation. The ANCHOR may jump FORWARD in
    // `to`: the server projected this state AT its current _Cursor head
    // (dual-fence enforced server-side), so application lands the recipient
    // exactly on that anchor — never behind it, never past it. A composite
    // regression risks state divergence — the recipient may hold changes this
    // patch never saw — so it RECOVERS through a snapshot rather than
    // trusting idempotent replay.
    const head = valid[0].from;
    const tail = valid[valid.length - 1].to;
    const verdict = snapshotPatchVerdict(S.cursor, head, tail);
    if (verdict.status === 'resync') return { status: 'resync' };
    if (verdict.status === 'duplicate') return { status: 'duplicate' };
    // 3-4. Apply EVERY envelope's operations in order to ONE fresh immutable
    // copy; any throw discards it — the base never lands half-patched.
    // Copy-on-write spine (#156 round 2): instead of an O(graph) deep clone,
    // clone only along each operation's path chain and share every other
    // subtree by reference. The spine is built FULLY before the first target
    // mutates, so a mid-way applyPatchOperation throw leaves the shared base
    // untouched and the whole patch resyncs.
    let nextSnapshot;
    try {
      nextSnapshot = S.buildPatchSpine(S.baseSnapshot, valid);
      for (const checked of valid) {
        for (const operation of checked.operations) S.applyPatchOperation(nextSnapshot, operation);
      }
      nextSnapshot = S.validateSnapshot(nextSnapshot);
    } catch {
      return { status: 'resync' };
    }
    if (S.closed || S.status === 'revoked') return { status: 'revoked' };
    // 6. Commit snapshot + cursor + token together (token takes the CHAIN's
    // LAST rotation — the ledger's newest handle). Settlement (7 in §11):
    // only actions the patches ECHO (actionIds), or explicitly mark as
    // routed-invisible, may reconcile optimistic state — never an empty patch
    // alone (cross-exam 6).
    S.baseSnapshot = nextSnapshot;
    S.cursor = verdict.cursor;
    S.lastSnapshotInstalledFromReceipt = false;
    S.projectionToken = valid[valid.length - 1].projectionToken;
    const echoed = new Set();
    for (const checked of valid) for (const id of checked.actionIds ?? []) echoed.add(id);
    const routedInvisible = new Set();
    for (const checked of valid) for (const id of checked.routedInvisibleActionIds ?? []) routedInvisible.add(id);
    // Attribution by an ACCEPTED patch proves the server committed the action
    // (#156 round 3), so settlement must not care whether the sender's HTTP
    // receipt has resolved yet: requiring `delivered` here strands the op when
    // the patch wins the race (patch settles nothing → fence-covered receipt
    // suppresses recovery → the actionId is never echoed again). The
    // confirmedCursor guard still refuses to declare victory over state older
    // than the receipt's own confirmation.
    for (const [actionId, operation] of S.operations) {
      const settleable = echoed.has(actionId) || routedInvisible.has(actionId);
      if (settleable && coversConfirmation(S.cursorAnchor(S.cursor), operation.confirmedCursor)) {
        // Mark the commit proof for the late receipt path: it must take the
        // committed escape (never report a spurious failure) and skip the
        // now-pointless recovery bootstrap. resolveSettlement is idempotent,
        // so a receipt that raced ahead cannot double-settle.
        operation.patchAttributed = true;
        S.settleOperation(operation, { status: 'reconciled' });
        S.operations.delete(actionId);
      }
    }
    S.publish();
    return { status: 'applied' };
  };
}
