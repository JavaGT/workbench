// workbench-client-scope-store.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { ClientClosedError, MAX_RESYNC_ATTEMPTS, backoffDelay, createOpLifecycle, decideReplay, normalizeSeqSpan, reconcileAuthoritative } from './workbench-client-core.mjs';
import { clientFailure, normalizeFailure } from './workbench-client-errors.mjs';
import { LiveChannel } from './workbench-client-live-channel.mjs';

// ---------------------------------------------------------------------------
// createScopeLiveStore — one validated composite snapshot + one scope cursor.
// ---------------------------------------------------------------------------
/**
 * Create a live store for an application-defined scope projection. The
 * framework owns bootstrap, replay, optimistic operation status, and transport;
 * the application supplies the snapshot validator and its one pure event fold.
 */
export function createScopeLiveStore({
  baseUrl,
  scope,
  validateSnapshot,
  fold,
  optimistic = (snapshot) => snapshot,
  sendAction,
  channel,
  fetchImpl,
  snapshotUrl,
  eventsSinceUrl,
  createActionId,
  resyncBackoffBase = 200,
  maxResyncBackoff = 5000,
}) {
  if (typeof scope !== 'string' || scope.length === 0) throw new TypeError('scope is required');
  if (typeof validateSnapshot !== 'function') throw new TypeError('validateSnapshot is required');
  if (typeof fold !== 'function') throw new TypeError('fold is required');
  if (typeof sendAction !== 'function') throw new TypeError('sendAction is required');

  const resolvedChannel = channel ?? new LiveChannel(baseUrl);
  const resolvedFetch = fetchImpl ?? globalThis.fetch;
  const snapshotEndpoint = snapshotUrl ?? `${baseUrl}/snapshot?scope=${encodeURIComponent(scope)}`;
  const replayEndpoint = (cursor) => eventsSinceUrl
    ? eventsSinceUrl(cursor)
    : `${baseUrl}/events-since?scope=${encodeURIComponent(scope)}&cursor=${cursor}`;

  let baseSnapshot = null;
  let visibleSnapshot = null;
  let cursor = 0;
  let ready = false;
  let closed = false;
  let actionCounter = 0;
  let resyncPromise = null;
  let resyncAttempt = 0;
  let resyncRetryTimer = null;
  // Gap escalation mirrors LiveList: one forced snapshot per unresolved gap,
  // then a capped backoff. `stalled` stops the queue drain from re-issuing
  // replay requests in a tight loop when the server cannot close the gap.
  let snapshotEscalated = false;
  let gapFloor = null;
  let stalled = false;
  let draining = false;
  let storeStatus = 'idle';
  const queued = [];
  const listeners = new Set();
  const { operations, makeOperation, shouldReconcile, count } = createOpLifecycle();

  function nextActionId() {
    if (createActionId) return createActionId();
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `scope_op_${++actionCounter}`;
  }

  function publish() {
    if (closed || baseSnapshot === null) return;
    let projected = baseSnapshot;
    for (const operation of operations.values()) {
      if (operation.status === 'pending' && operation.echoCursor == null) projected = optimistic(projected, operation.action);
    }
    visibleSnapshot = projected;
    for (const listener of listeners) {
      try { listener(visibleSnapshot); } catch { /* isolate consumers */ }
    }
  }

  function setStoreStatus(next) {
    if (closed || storeStatus === next) return;
    storeStatus = next;
  }

  function noteGapFloor(seq) {
    if (!Number.isFinite(seq)) return;
    gapFloor = gapFloor == null ? seq : Math.min(gapFloor, seq);
  }

  /** True when buffered events still sit behind an unresolved replay gap. */
  function hasUnresolvedGap() {
    let floor = null;
    for (const event of queued) {
      let span;
      try { span = normalizeSeqSpan(event.seqSpan ?? event.seq); } catch { continue; }
      const decision = decideReplay(cursor, span);
      if (decision.kind === 'gap') floor = floor == null ? span[1] : Math.min(floor, span[1]);
    }
    if (floor === null && queued.length === 0) floor = gapFloor;
    if (floor === null || cursor >= floor) {
      gapFloor = null;
      return false;
    }
    gapFloor = floor;
    return true;
  }

  async function decodeJson(response) {
    if (!response?.ok) throw new Error(`http ${response?.status ?? 'unknown'}`);
    return response.json();
  }

  async function loadSnapshot() {
    const response = await resolvedFetch(snapshotEndpoint, { credentials: 'include' });
    const body = await decodeJson(response);
    const nextSnapshot = validateSnapshot(body.snapshot);
    const nextCursor = body.cursors?.[scope] ?? body.seq;
    if (!Number.isFinite(nextCursor)) throw new Error(`snapshot is missing cursor for ${scope}`);
    baseSnapshot = nextSnapshot;
    cursor = nextCursor;
    publish();
  }

  function normalizeLive(envelope) {
    return {
      scope,
      seq: envelope.seq,
      seqSpan: envelope.seqSpan ?? [envelope.seq, envelope.seq],
      type: envelope.event?.type,
      data: envelope.event?.data,
      actionId: envelope.event?.actionId,
      delta: envelope.delta,
    };
  }

  function normalizeReplay(row) {
    return {
      scope,
      seq: row.seq,
      seqSpan: [row.seq, row.seq],
      type: row.type,
      data: row.data,
      actionId: row.actionId,
      committedAt: row.committedAt,
    };
  }

  // The only committed-event path. Live frames, own echoes, foreign events,
  // and historical replay all enter here after transport normalization.
  function ingest(event) {
    if (closed) return { status: 'closed' };
    const decision = decideReplay(cursor, event.seqSpan ?? event.seq);
    if (decision.kind === 'duplicate') return { status: 'duplicate' };
    if (decision.kind === 'gap') {
      queued.push(event);
      try { noteGapFloor(normalizeSeqSpan(event.seqSpan ?? event.seq)[1]); } catch { /* scalar */ }
      if (!stalled && !draining) resync().catch(() => {});
      return { status: 'gap', expectedSeq: cursor + 1, receivedSeq: event.seqSpan?.[0] ?? event.seq };
    }

    baseSnapshot = fold(baseSnapshot, event);
    cursor = decision.cursor;
    const ownOperation = event.actionId ? operations.get(event.actionId) : null;
    if (ownOperation) {
      // A committed echo for this actionId proves the action committed, so it
      // reconciles the operation even when it was retained as an
      // outcome-unknown placeholder (delivered is false) after a transport throw.
      // The decision is the shared one from createLiveDeliverySession; only the
      // retirement differs (this engine has no settlement object to resolve).
      reconcileAuthoritative(
        ownOperation, cursor, cursor,
        (op) => op.delivered || op.status === 'failed',
        () => operations.delete(event.actionId),
      );
    }
    publish();
    return { status: ownOperation ? 'confirmed' : 'applied', cursor };
  }

  function queueOrIngest(event) {
    if (!ready || resyncPromise) queued.push(event);
    else ingest(event);
  }

  /** Drain buffered events without re-entering replay for a still-open gap. */
  function drainQueued() {
    const held = queued.splice(0);
    draining = true;
    let gapped = false;
    try {
      for (let index = 0; index < held.length; index += 1) {
        if (stalled) {
          queued.push(held[index]);
          continue;
        }
        const result = ingest(held[index]);
        if (result.status === 'gap') {
          // `ingest` already re-queued this event; retain the untouched tail.
          for (let rest = index + 1; rest < held.length; rest += 1) queued.push(held[rest]);
          gapped = true;
          break;
        }
      }
    } finally {
      draining = false;
    }
    if (gapped && !stalled) resync().catch(() => {});
  }

  async function resync(forceSnapshot = false) {
    if (closed) return;
    if (resyncPromise) return resyncPromise;
    setStoreStatus('resyncing');
    resyncPromise = (async () => {
      const startCursor = cursor;
      // The floor we are trying to close, captured before replay moves the
      // cursor. A partial advance that still sits below this floor is not
      // progress against the gap we escalated for.
      const targetFloor = gapFloor;
      if (forceSnapshot) {
        await loadSnapshot();
      } else {
        const response = await resolvedFetch(replayEndpoint(cursor), { credentials: 'include' });
        const body = await decodeJson(response);
        if (body.resync === 'stale') {
          await loadSnapshot();
        } else {
          const rows = (body.events ?? []).filter((row) => row.seq > cursor);
          let expected = cursor + 1;
          for (const row of rows) {
            if (row.scope !== undefined && row.scope !== scope) throw new Error('replay event belongs to another scope');
            if (row.seq !== expected) throw new Error('replay batch is not contiguous');
            expected += 1;
          }
          for (const row of rows) ingest(normalizeReplay(row));
        }
      }

      if (hasUnresolvedGap()) {
        const progressed = cursor > startCursor;
        const reachedFloor = targetFloor == null || cursor >= targetFloor;
        // Only clear the escalation when replay actually reached the floor.
        // Otherwise every bounded retry re-forces a fresh snapshot, the
        // attempt counter is reset below, and the gap loop never terminates.
        if (progressed && reachedFloor && !forceSnapshot && snapshotEscalated) snapshotEscalated = false;
        if (!snapshotEscalated) {
          // One escalation to an authoritative snapshot for this gap.
          snapshotEscalated = true;
          await loadSnapshot();
          if (hasUnresolvedGap()) {
            // The forced snapshot did not cover the gap either: fail closed
            // with bounded backoff instead of re-entering the replay loop.
            stalled = true;
            setStoreStatus('stale');
            scheduleResync();
          }
        } else {
          // Snapshot also failed to pass the gap: fail closed and back off.
          stalled = true;
          setStoreStatus('stale');
          scheduleResync();
        }
      } else {
        snapshotEscalated = false;
        stalled = false;
      }
    })();
    let succeeded = false;
    try {
      await resyncPromise;
      succeeded = true;
      // A stall keeps its attempt counter: backoff must keep growing while the
      // gap is unresolved, and only a real recovery resets it.
      if (!stalled && !hasUnresolvedGap()) resyncAttempt = 0;
    } catch {
      scheduleResync();
    } finally {
      resyncPromise = null;
    }
    if (!succeeded || stalled) return;
    if (!closed && !hasUnresolvedGap()) setStoreStatus('idle');
    drainQueued();
  }

  function scheduleResync() {
    if (closed || resyncRetryTimer) return;
    if (resyncAttempt >= MAX_RESYNC_ATTEMPTS) {
      stalled = true;
      setStoreStatus('stale');
      return;
    }
    const delay = backoffDelay(resyncAttempt, resyncBackoffBase, maxResyncBackoff);
    resyncAttempt += 1;
    resyncRetryTimer = setTimeout(() => {
      resyncRetryTimer = null;
      if (!closed) resync().catch(() => {});
    }, delay);
    if (typeof resyncRetryTimer.unref === 'function') resyncRetryTimer.unref();
  }

  function onLive(envelope) {
    if (closed || envelope?.type !== 'event') return;
    queueOrIngest(normalizeLive(envelope));
  }

  async function start() {
    await loadSnapshot();
    if (closed) throw new ClientClosedError('Scope live store is closed');
    const ack = await resolvedChannel.subscribeScope(scope, {
      onCheckpoint({ currentSeq }) {
        if (ready && currentSeq > cursor) resync().catch(() => {});
      },
    }, onLive);
    if (ack.currentSeq > cursor) await resync();
    ready = true;
    drainQueued();
    if (!closed && !stalled) setStoreStatus('idle');
    publish();
  }

  async function dispatch(type, payload) {
    const actionId = nextActionId();
    const action = { actionId, scope, type, payload };
    const operation = makeOperation({ actionId, action });
    operations.set(actionId, operation);
    publish();
    try {
      const receipt = await sendAction(action);
      if (receipt?.ok === false) {
        operation.status = 'failed';
        operation.error = normalizeFailure(receipt.failure ?? receipt.error ?? receipt);
        publish();
        return { ok: false, status: 'failed-rolled-back', opId: actionId, failure: operation.error };
      }
      const confirmedCursor = receipt?.cursor ?? receipt?.seq;
      operation.delivered = true;
      if (Number.isFinite(confirmedCursor)) operation.confirmedCursor = confirmedCursor;
      if (shouldReconcile(operation, { confirmedCursor: operation.confirmedCursor, echoCursor: operation.echoCursor })) {
        operations.delete(actionId);
      }
      publish();
      return { ok: true, status: 'committed', opId: actionId, value: receipt?.value };
    } catch (error) {
      operation.status = 'failed';
      operation.error = clientFailure('internal', String(error?.message ?? error));
      publish();
      return { ok: false, status: 'outcome-unknown', opId: actionId, failure: operation.error };
    }
  }

  const readyPromise = start();
  readyPromise.catch(() => {});

  return {
    get snapshot() { return visibleSnapshot; },
    get cursor() { return cursor; },
    get ready() { return readyPromise; },
    get status() { return storeStatus; },
    dispatch,
    operations() { return [...operations.values()]; },
    pendingCount() { return count('pending'); },
    failedCount() { return count('failed'); },
    discardFailed(opId) {
      if (operations.get(opId)?.status === 'failed') {
        operations.delete(opId);
        publish();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      if (visibleSnapshot !== null) listener(visibleSnapshot);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      storeStatus = 'closed';
      if (resyncRetryTimer) clearTimeout(resyncRetryTimer);
      void resolvedChannel.unsubscribeScope(scope);
      resolvedChannel.close();
      listeners.clear();
      queued.length = 0;
    },
  };
}
