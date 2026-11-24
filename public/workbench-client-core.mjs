// workbench-client-core.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
// LiveChannel — WebSocket transport layer for workbench live sync.
//
// Slice A of the client SDK. ONE WebSocket per channel, multiplexed across
// entity/id subscriptions. Auto-reconnects with exponential backoff. Zero
// external dependencies — uses Node's global WebSocket (Node 22+).
//
// Protocol (matches src/live-delivery.mjs verbatim):
//   client → server: {type:'subscribe', requestId, entity, id, fields?, pace?} / {type:'subscribe', requestId, scope, interest?} / {type:'unsubscribe', entity, id} / {type:'unsubscribe', scope}
//   server → client: {type:'subscribed', requestId, scope, entity, id, currentSeq}
//                    {type:'unsubscribed', scope, entity, id}
//                    {type:'event', entity, id, seq, seqSpan, event, delta?}
//                    {type:'resync', entity, id, seq, reason}
//                    {type:'error', requestId?, failure}
// Framework-agnostic reactive bindings (Wave 3). Zero framework deps; the
// store stays the single reconciliation authority.
// --- BEGIN GENERATED from src/replay-decision.ts (keep in sync; zero-import) ---
export function normalizeSeqSpan(seqOrSpan) {
  if (Array.isArray(seqOrSpan) && seqOrSpan.length >= 2) {
    const lo = Number(seqOrSpan[0]);
    const hi = Number(seqOrSpan[1]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error('seqSpan must be finite numbers');
    }
    return [lo, hi];
  }
  const seq = Number(seqOrSpan);
  if (!Number.isFinite(seq)) {
    throw new Error('seq must be a finite number');
  }
  return [seq, seq];
}
export function decideReplay(cursor, seqOrSpan) {
  const [lo, hi] = normalizeSeqSpan(seqOrSpan);
  const expected = (Number(cursor) || 0) + 1;
  if (hi < expected) return { kind: 'duplicate' };
  if (lo > expected) return { kind: 'gap' };
  return { kind: 'next', cursor: hi };
}
// --- END GENERATED from src/replay-decision.ts ---
// The one confirmation-fence rule for authoritative settlement: an authoritative
// cursor at or past the disclosed confirmation covers the operation; an absent
// disclosure is always covered. Both fold-echo engines and every authoritative
// path (event echo, live state replacement, snapshot patch, snapshot recovery)
// use this predicate, so the fence cannot drift between them.
export function coversConfirmation(cursor, confirmedCursor) {
  return confirmedCursor == null || cursor >= confirmedCursor;
}
// One Replay-decision-backed verdict for composite snapshot patches. A patch
// carries composites (head..tail); encoding the recipient as head-1 makes
// decideReplay's `expected = cursor+1` land exactly on the patch's `from`, so
// duplicate / next / gap keep the same grammar as live event replay. Anchor
// continuity and the stale-regression guard stay patch-specific.
export function snapshotPatchVerdict(cursor, head, tail) {
  const decision = decideReplay(cursor.composite - 1, [head.composite, tail.composite]);
  // A patch ending behind the held composite is stale state, never an idempotent
  // replay: it may carry changes the recipient already folded differently.
  if (tail.composite < cursor.composite) return { status: 'resync' };
  if (decision.kind === 'gap') return { status: 'resync' };
  if (cursor.anchor === head.anchor && cursor.composite === head.composite) {
    return { status: 'next', cursor: { anchor: tail.anchor, composite: decision.cursor } };
  }
  if (cursor.anchor === tail.anchor && cursor.composite === tail.composite) return { status: 'duplicate' };
  return { status: 'resync' };
}
// Shared capped-exponential-backoff delay. Pure: timers and attempt counters
// stay at the call sites, which differ in reset/clear semantics.
export function backoffDelay(attempt, base, max) {
  return Math.min(base * 2 ** attempt, max);
}
export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
// ---------------------------------------------------------------------------
// createOpLifecycle — the one operation-record lifecycle both fold-echo
// engines (createLiveDeliverySession, createScopeLiveStore) reimplemented.
// The REST-overlay model (createLiveStore) keeps its own overlay bookkeeping.
// ---------------------------------------------------------------------------
export function shouldReconcile(_operation, { confirmedCursor, echoCursor }) {
  return echoCursor != null && coversConfirmation(echoCursor, confirmedCursor);
}
// The one authoritative echo-settlement contract shared by createLiveDeliverySession
// and createScopeLiveStore: record the committed cursor on the operation,
// require the engine's eligibility rule, and require that cursor to cover the
// confirmation fence. `fenceCursor` is the normalized cursor for composite
// streams; `finalize` is the engine's retirement (settle+delete or plain delete).
export function reconcileAuthoritative(operation, cursor, fenceCursor, eligible, finalize) {
  operation.echoCursor = cursor;
  if (!eligible(operation)) return false;
  if (!shouldReconcile(operation, { confirmedCursor: operation.confirmedCursor, echoCursor: fenceCursor })) return false;
  finalize(operation);
  return true;
}
export function makeOperation({ actionId, ...extra }) {
  return {
    opId: actionId,
    actionId,
    status: 'pending',
    error: null,
    delivered: false,
    confirmedCursor: null,
    echoCursor: null,
    ...extra,
  };
}
export function createOpLifecycle() {
  const operations = new Map();
  return {
    operations,
    makeOperation,
    shouldReconcile,
    count(status) {
      let count = 0;
      for (const operation of operations.values()) {
        if (operation.status === status) count += 1;
      }
      return count;
    },
  };
}
export function normalizeSubscribeArgs(optionsOrOnEvent, maybeOnEvent) {
  if (typeof optionsOrOnEvent === 'function' || optionsOrOnEvent === undefined || optionsOrOnEvent === null) {
    return { options: {}, onEvent: optionsOrOnEvent };
  }
  return { options: optionsOrOnEvent, onEvent: maybeOnEvent };
}
export function subscribeEnvelope(entity, id, { fields, pace, carets } = {}) {
  const envelope = { type: 'subscribe', entity, id };
  if (fields !== undefined) envelope.fields = fields;
  if (pace !== undefined) envelope.pace = pace;
  if (carets !== undefined) envelope.carets = carets;
  return envelope;
}
export function isPlainJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
export class ClientClosedError extends Error {
  constructor(message = 'Live channel is closed') {
    super(message);
    this.name = 'ClientClosedError';
  }
}
// The one foldability vocabulary for LiveList. `_applyEvent` dispatches CRUD
// verbs and field operations through these exact cases; a type outside them
// cannot be folded and must never silently advance the replay cursor. Keeping
// the sets beside the reducer makes the predicate derive from what is actually
// handled instead of from a hand-maintained guess about type shapes.
export const HANDLED_CRUD_VERBS = new Set(['created', 'updated', 'removed']);
export const HANDLED_FIELD_OPS = new Set([
  'applied', 'inserted', 'moved', 'reordered', 'appended', 'added', 'changed', 'removed',
]);
// Bounded resync escalation: at most one forced snapshot per unresolved gap,
// then capped backoff instead of an unbounded microtask/fetch loop.
export const MAX_RESYNC_ATTEMPTS = 8;
// ---------------------------------------------------------------------------
// createLiveDeliverySession — recipient-envelope delivery and recovery.
// ---------------------------------------------------------------------------
/**
 * Package-owned client ingest for a recipient-safe delivery stream. Transport
 * adapters provide atomic snapshots/catch-up and recipient envelopes only;
 * they never provide raw log rows or choose cursor recovery.
 */
// Unadvertised-capability rollout step 1 (#122 §12): the client offers this
// capability on every bootstrap/catchup/subscribe; delta ingestion engages
// only when a bootstrap RESULT echoes the protocol back (response-gated).
export const SNAPSHOT_PATCH_CAPABILITY = 'snapshot-patch/v1';
export function annotatedDocumentView(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  return Object.freeze({
    kind: snapshot.kind,
    version: snapshot.version,
    text: snapshot.text,
    ranges: snapshot.ranges,
    annotations: snapshot.annotations,
    ...(snapshot.orphans !== undefined ? { orphans: snapshot.orphans } : {}),
    ...(snapshot.measurements !== undefined ? { measurements: snapshot.measurements } : {}),
    capabilities: snapshot.capabilities,
    ...(snapshot.restricted ? { restricted: true } : {}),
    ...(snapshot.redactions?.length ? { redactions: snapshot.redactions } : {}),
  });
}
