// workbench-client-live-store-ops-1.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { applyTextOp } from './workbench-annotated-text.mjs';
import { clientFailure, decodeResult } from './workbench-client-errors.mjs';
import { LiveList } from './workbench-client-live-list.mjs';

export function install0(S) {
S._reserveTextOperation = async function _reserveTextOperation(id, field, generate)  {
    const document = `${S.name}\0${id}\0${field}`;
    const reservation = await S.resolvedReplicaState.reserve(document, generate);
    if (!reservation?.operation || !reservation.actionId || !Number.isSafeInteger(reservation.counter)) {
      throw new Error('durable replica state must persist text operation outbox records');
    }
    return { document, record: reservation };
  };
S._serializeTextAllocation = function _serializeTextAllocation(document, work)  {
    const previous = S._textAllocationChains.get(document) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    S._textAllocationChains.set(document, current);
    current.finally(() => {
      if (S._textAllocationChains.get(document) === current) S._textAllocationChains.delete(document);
    }).catch(() => {});
    return current;
  };
S._textResult = function _textResult(status, record, extra = {})  {
    return { ok: status === 'committed', status, opId: record.actionId, actionId: record.actionId, ...extra };
  };
S._sendTextHead = async function _sendTextHead(document, id, field, expectedCounter)  {
    const record = await S.resolvedReplicaState.head(document);
    if (!record) return { ok: false, status: 'failed-rolled-back', opId: null, failure: clientFailure('not-found', 'text outbox is empty') };
    if (record.status === 'blocked') return S._textResult('blocked', record, { failure: record.failure });
    if (record.counter !== expectedCounter) return S._textResult('queued', record, { waitingFor: record.actionId });
    try {
      const res = await S.resolvedFetch(`${S.baseUrl}${S.path}/${id}/${field}/apply`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-workbench-action-id': record.actionId },
        // `body` is persisted alongside the operation; retries send these exact bytes.
        body: record.body,
      });
      const decoded = await decodeResult(res);
      if (!decoded.ok) {
        if (decoded.failure) {
          await S.resolvedReplicaState.block(document, record.counter, decoded.failure);
          return S._textResult('blocked', record, { failure: decoded.failure });
        }
        return S._textResult('outcome-unknown', record, { deliveryError: { message: decoded.error } });
      }
      await S.resolvedReplicaState.commit(document, record.counter);
      return S._textResult('committed', record, { row: decoded.value });
    } catch (error) {
      return S._textResult('outcome-unknown', record, { deliveryError: { message: error?.message ?? String(error) } });
    }
  };
S._serializeTextSend = function _serializeTextSend(document, send)  {
    const prior = S._textSendChains.get(document) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(send);
    S._textSendChains.set(document, next);
    return next.finally(() => { if (S._textSendChains.get(document) === next) S._textSendChains.delete(document); });
  };
S._nextOpId = function _nextOpId()  {
    return 'op_' + (++S._opIdCounter);
  };
S._snapshotUrl = function _snapshotUrl(entity, id)  {
    return `${S.baseUrl}/snapshot/${entity}/${id}`;
  };
S._eventsSinceUrl = function _eventsSinceUrl(entity, id, cursor)  {
    return `${S.baseUrl}/events-since/${entity}/${id}?cursor=${cursor}`;
  };
S._sameRow = function _sameRow(left, right)  {
    if (left === right) return true;
    if (left == null || right == null) return false;
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  };
S._clearConfirmedOverlays = function _clearConfirmedOverlays(id)  {
    const list = S._listCache.get(id);
    if (!list) return;

    for (const [opId, entry] of S._overlay) {
      if (entry.id !== id || entry.status !== 'confirmed') continue;
      if (entry.confirmedSeq != null) {
        // Commit disclosed its seq: the authoritative fold has caught up.
        if (list.cursor >= entry.confirmedSeq) S._overlay.delete(opId);
      } else if (list.cursor > (entry.confirmedAtCursor ?? 0) || S._sameRow(list.state, entry.row)) {
        // No x-workbench-seq header. Use authoritative fold evidence instead:
        // a later seq landed, or the row already matches the committed value.
        // Without this branch the overlay would never be released and
        // bindField/bindList would disagree about provenance forever.
        S._overlay.delete(opId);
      }
    }
  };
S._responseHeader = function _responseHeader(res, name)  {
    return res?.headers?.get?.(name) ?? null;
  };
S._confirmedSeq = function _confirmedSeq(res)  {
    const value = S._responseHeader(res, 'x-workbench-seq');
    if (value == null || value === '') return null;
    const seq = Number(value);
    return Number.isFinite(seq) ? seq : null;
  };
S._storeRender = function _storeRender()  {
    for (const cb of S._renderCallbacks) {
      try { cb(); } catch { /* swallow */ }
    }
  };
S.directMutationSend = function directMutationSend({ method, url, body })  {
    const run = async () => {
      const fetchOpts = { method, credentials: 'include' };
      if (body !== undefined) {
        fetchOpts.headers = { 'Content-Type': 'application/json' };
        fetchOpts.body = body;
      }
      try {
        const res = await S.resolvedFetch(url, fetchOpts);
        const decoded = await decodeResult(res);
        if (decoded.ok) {
          const row = res.status === 204 ? undefined : decoded.value;
          return { status: 'committed', row, seq: S._confirmedSeq(res) };
        }
        if (decoded.failure) {
          return { status: 'rejected', failure: decoded.failure };
        }
        return { status: 'outcome-unknown', deliveryError: { message: decoded.error } };
      } catch (err) {
        return { status: 'outcome-unknown', deliveryError: { message: err?.message ?? String(err) } };
      }
    };
    const outcome = run();
    return { settlement: outcome, completion: outcome };
  };
S._subscribeLiveList = function _subscribeLiveList(id, options = {})  {
    if (S._closed) throw new Error('store is closed');
    if (S._listCache.has(id)) {
      const prev = S._listOptions.get(id);
      const cur = JSON.stringify({ fields: options.fields ?? null, pace: options.pace ?? null });
      if (prev !== cur) {
        throw new Error(`conflicting subscribe options for ${id}: already subscribed with different interest`);
      }
      return S._listCache.get(id);
    }

    const list = new LiveList({
      entity: S.name,
      id,
      channel: S.resolvedChannel,
      fetchImpl: S.resolvedFetch,
      snapshotUrl: S._snapshotUrl,
      eventsSinceUrl: S._eventsSinceUrl,
      fields: options.fields,
      pace: options.pace,
      onTextReducer: ({ entity, id: reducerId, field, epoch, state }) => {
        const document = `${entity}\0${reducerId}\0${field}`;
        const lamport = Math.max(0, ...Object.values(state.elements).map((element) => element.lamport));
        return S._serializeTextAllocation(document, async () => {
          const outbox = await S.resolvedReplicaState.reconcile(document, { epoch, frontier: state.frontier, lamport });
          let draft = state;
          for (const record of outbox.sort((left, right) => left.counter - right.counter)) {
            draft = applyTextOp(draft, record.operation);
          }
          S._textDraftStates.set(document, draft);
        });
      },
    });

    S._listCache.set(id, list);
    S._listOptions.set(id, JSON.stringify({ fields: options.fields ?? null, pace: options.pace ?? null }));

    // Subscribe to LiveList onRender for overlay clearing + store render propagation
    const unsub = list.onRender(() => {
      S._clearConfirmedOverlays(id);
      S._storeRender();
    });
    S._listUnsubs.set(id, unsub);

    // Forward the fine-grained fold and lifecycle surfaces so store-level
    // consumers never need to reach into the cached LiveList themselves.
    S._listChangeUnsubs.set(id, list.onChange((change) => {
      for (const cb of S._changeCallbacks) {
        try { cb(change); } catch { /* isolate consumers */ }
      }
    }));
    S._listStatusUnsubs.set(id, list.onStatusChange((status) => {
      for (const cb of S._statusCallbacks) {
        try { cb(status, id); } catch { /* isolate consumers */ }
      }
    }));

    // Boot strap (do not await — caller may await list.ready)
    list.subscribe().catch(() => {});

    return list;
  };
S.releaseLiveList = function releaseLiveList(id)  {
    const list = S._listCache.get(id);
    if (!list) return;
    S._listCache.delete(id);
    S._listOptions.delete(id);
    S._listUnsubs.get(id)?.();
    S._listUnsubs.delete(id);
    S._listChangeUnsubs.get(id)?.();
    S._listChangeUnsubs.delete(id);
    S._listStatusUnsubs.get(id)?.();
    S._listStatusUnsubs.delete(id);
    void list.close();
  };
S.overlayFor = function overlayFor(id)  {
    // Find the most recent (insertion-order) non-failed overlay for this id
    let entry = null;
    for (const e of S._overlay.values()) {
      if (e.status === 'failed') continue;
      if (e.id === id) entry = e;
    }

    if (!entry) {
      const list = S._listCache.get(id);
      return list ? list.state : null;
    }

    if (entry.kind === 'remove') return null;
    // Return authoritative row if confirmed, else optimistic guess
    return entry.row ?? entry.optimistic;
  };
S.overlayStatusFor = function overlayStatusFor(id)  {
    let entry = null;
    for (const e of S._overlay.values()) {
      if (e.status === 'failed') continue;
      if (e.id === id) entry = e;
    }
    if (!entry) return null;
    return { status: entry.status, kind: entry.kind, error: entry.error ?? null, opId: entry.opId };
  };
S.pendingCreates = function pendingCreates()  {
    const result = [];
    for (const entry of S._overlay.values()) {
      if (entry.kind === 'create' && entry.status === 'pending') {
        result.push(entry);
      }
    }
    return result;
  };
}
