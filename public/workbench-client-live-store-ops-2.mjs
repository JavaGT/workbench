// workbench-client-live-store-ops-2.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { applyTextOp } from './workbench-annotated-text.mjs';
import { deleteText, insertText } from './workbench-text-edit.mjs';
import { clientFailure, decodeResult } from './workbench-client-errors.mjs';
import { LiveChannel } from './workbench-client-live-channel.mjs';
import { createIndexedDbReplicaState } from './workbench-client-replica.mjs';

export function install1(S) {
S.dispatch = async function dispatch(type, payload)  {
    const opId = S._nextOpId();

    // dispatch NEVER throws. Failures before transmission are known rollbacks;
    // a lost response after fetch starts has an unknown server outcome.
    if (S._closed) {
      return {
        ok: false,
        status: 'failed-rolled-back',
        opId,
        failure: clientFailure('conflict', 'Store is closed.'),
      };
    }

    let kind, id;
    if (type.endsWith('.apply') && type.startsWith(`${S.name}.`)) {
      const fieldName = type.slice(S.name.length + 1, -'.apply'.length);
      if (!fieldName || typeof payload?.id !== 'string' || !Object.hasOwn(payload, 'operation')) {
        return { ok: false, status: 'failed-rolled-back', opId, failure: clientFailure('invalid-input', 'text operation requires { id, operation }') };
      }
      let requestAttempted = false;
      let body;
      try {
        body = JSON.stringify({ operation: payload.operation });
        requestAttempted = true;
        const res = await S.resolvedFetch(`${S.baseUrl}${S.path}/${payload.id}/${fieldName}/apply`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body,
        });
        const decoded = await decodeResult(res);
        if (!decoded.ok) return decoded.failure
          ? { ok: false, status: 'failed-rolled-back', opId, failure: decoded.failure }
          : { ok: false, status: 'outcome-unknown', opId, deliveryError: { message: decoded.error } };
        return { ok: true, status: 'committed', opId, row: decoded.value };
      } catch (err) {
        return requestAttempted
          ? { ok: false, status: 'outcome-unknown', opId, deliveryError: { message: err.message ?? String(err) } }
          : { ok: false, status: 'failed-rolled-back', opId, failure: clientFailure('invalid-input', err.message ?? String(err)) };
      }
    } else if (type === `${S.name}.create`) {
      kind = 'create';
    } else if (type === `${S.name}.update`) {
      kind = 'update';
      id = payload.id;
    } else if (type === `${S.name}.remove`) {
      kind = 'remove';
      id = payload.id;
    } else {
      return {
        ok: false,
        status: 'failed-rolled-back',
        opId,
        failure: clientFailure('unknown-action', 'Unknown action type: ' + type),
      };
    }

    // Capture preimage for rollback (the effective state before this op)
    const preimage = id ? S.overlayFor(id) : null;

    // Build optimistic overlay row
    let optimistic = null;
    if (kind === 'create') {
      optimistic = { ...payload };
    } else if (kind === 'update') {
      optimistic = { ...(preimage ?? {}), ...payload };
      delete optimistic.id;
      optimistic = { id, ...optimistic };
    }
    // remove: optimistic stays null

    // Create overlay entry (status: pending)
    const entry = { opId, id: id ?? null, kind, optimistic, status: 'pending', row: null, confirmedSeq: null };
    S._overlay.set(opId, entry);
    S._storeRender();

    // Serialize the exact request bytes once. A durable outbox resends these
    // same bytes with the same actionId, so a lost response can never fork
    // the outcome into two server-side mutations.
    let method, url, body;
    if (kind === 'create') {
      method = 'POST';
      url = `${S.baseUrl}${S.path}`;
    } else if (kind === 'update') {
      method = 'PATCH';
      url = `${S.baseUrl}${S.path}/${id}`;
    } else {
      method = 'DELETE';
      url = `${S.baseUrl}${S.path}/${id}`;
    }
    if (kind !== 'remove') {
      try {
        body = JSON.stringify(payload);
      } catch (err) {
        // Never transmitted — a known rollback, not an uncertain server write.
        S._overlay.delete(opId);
        S._storeRender();
        return {
          ok: false,
          status: 'failed-rolled-back',
          opId,
          failure: clientFailure('invalid-input', err.message ?? String(err)),
        };
      }
    }

    // Every durable mutation goes through ONE transport seam. The direct
    // transport fetches and returns the committed outcome; a durable transport
    // (the local store's outbox) enqueues and settles on authoritative
    // per-scope seq evidence instead of a bare transport ack.
    let sender;
    try {
      sender = S.sendMutation
        ? S.sendMutation({ entity: S.name, opId, kind, id, payload, method, url, body })
        : S.directMutationSend({ method, url, body });
    } catch (err) {
      // The transport refused before any transmission — a known rollback.
      S._overlay.delete(opId);
      S._storeRender();
      return {
        ok: false,
        status: 'failed-rolled-back',
        opId,
        failure: clientFailure('invalid-input', err?.message ?? String(err)),
      };
    }

    let first;
    try {
      first = await sender.settlement;
    } catch (err) {
      // Settlement itself failed before transmission (e.g. the durable queue
      // could not persist the entry) — a known rollback.
      S._overlay.delete(opId);
      S._storeRender();
      return {
        ok: false,
        status: 'failed-rolled-back',
        opId,
        failure: clientFailure('invalid-input', err?.message ?? String(err)),
      };
    }

    if (first.status === 'committed') {
      entry.status = 'confirmed';
      entry.id = first.row?.id ?? entry.id;
      entry.row = first.row ?? null;
      entry.confirmedSeq = first.seq ?? null;
      entry.confirmedAtCursor = S._listCache.get(entry.id)?.cursor ?? null;
      if (kind === 'create') {
        S._overlay.delete(opId);
      } else {
        // The fold may already have caught up (the delta can beat the
        // response) — resolve the confirmed overlay now, not on the next
        // list render.
        S._clearConfirmedOverlays(entry.id);
      }
      S._storeRender();
      return {
        ok: true,
        status: 'committed',
        opId,
        id: kind === 'create' ? (first.row && first.row.id) : id,
        row: kind === 'remove' ? undefined : first.row,
      };
    }

    if (first.status === 'rejected') {
      // The server answered No — roll the placeholder back and surface the
      // failure. Never silently dropped.
      S._overlay.delete(opId);
      S._storeRender();
      return {
        ok: false,
        status: 'failed-rolled-back',
        opId,
        failure: first.failure,
      };
    }

    if (first.status === 'outcome-unknown') {
      S._overlay.delete(opId);
      S._storeRender();
      return {
        ok: false,
        status: 'outcome-unknown',
        opId,
        deliveryError: first.deliveryError,
      };
    }

    // 'queued' — the placeholder stays visible while the durable entry waits
    // for completion. The terminal outcome still confirms or rolls the
    // placeholder back through this one overlay entry (one apply path).
    void sender.completion.then((final) => {
      if (S._closed) return;
      if (final.status === 'committed' && entry.status === 'pending') {
        entry.status = 'confirmed';
        entry.id = final.row?.id ?? entry.id;
        entry.row = final.row ?? null;
        entry.confirmedSeq = final.seq ?? null;
        entry.confirmedAtCursor = S._listCache.get(entry.id)?.cursor ?? null;
        if (kind === 'create') {
          S._overlay.delete(opId);
        } else {
          S._clearConfirmedOverlays(entry.id);
        }
        S._storeRender();
      } else if (final.status === 'rejected') {
        S._overlay.delete(opId);
        S._storeRender();
      }
    }).catch(() => {});

    return {
      ok: false,
      status: 'queued',
      opId,
      actionId: first.actionId,
    };
  };
S.text = function text(id, field)  {
    const generate = async (build) => {
      if (S._closed) throw new Error('store is closed');
      const list = S._listCache.get(id);
      if (!list) throw new Error('text field is not ready; subscribe and await list.ready first');
      await list.textReducerReady;
      const checkpoint = list.textState(field);
      if (!checkpoint) throw new Error('text field is not ready; subscribe and await list.ready first');
      const document = `${S.name}\0${id}\0${field}`;
      const { record } = await S._serializeTextAllocation(document, async () => {
        const state = S._textDraftStates.get(document) ?? checkpoint;
        const reservation = await S._reserveTextOperation(id, field, (identity) => build({ state, ...identity }));
        // Preserve causal generation while an earlier durable operation awaits delivery.
        S._textDraftStates.set(document, applyTextOp(state, reservation.record.operation));
        return reservation;
      });
      return S._serializeTextSend(document, () => S._sendTextHead(document, id, field, record.counter));
    };
    return {
      insert: ({ at, text: inserted }) => generate(({ state, ...identity }) => insertText(state, identity, at, inserted)),
      delete: ({ start, end }) => generate(({ state, ...identity }) => deleteText(state, identity, start, end)),
    };
  };
S.retryText = async function retryText(id, field)  {
    const document = `${S.name}\0${id}\0${field}`;
    return S._serializeTextSend(document, async () => {
      const head = await S.resolvedReplicaState.head(document);
      if (!head) return { ok: false, status: 'failed-rolled-back', opId: null, failure: clientFailure('not-found', 'text outbox is empty') };
      if (head.status === 'blocked') return S._textResult('blocked', head, { failure: head.failure });
      return S._sendTextHead(document, id, field, head.counter);
    });
  };
S.action = function action(actionType, { method, path: actionPath })  {
    S._actionRoutes.set(actionType, { method, path: actionPath });

    // Return a helper function the caller can invoke
    const fn = async (body) => {
      const opId = S._nextOpId();
      const route = S._actionRoutes.get(actionType);
      if (!route) {
        return {
          ok: false,
          status: 'failed-rolled-back',
          opId,
          failure: clientFailure('unknown-action', `Unknown action: ${actionType}`),
        };
      }

      let requestAttempted = false;
      try {
        const opts = { method: route.method, credentials: 'include' };
        if (body !== undefined) {
          opts.headers = { 'Content-Type': 'application/json' };
          opts.body = JSON.stringify(body);
        }

        requestAttempted = true;
        const res = await S.resolvedFetch(`${S.baseUrl}${route.path}`, opts);
        const decoded = await decodeResult(res);
        if (decoded.ok) {
          return {
            ok: true,
            status: 'committed',
            opId,
            value: decoded.value,
          };
        }
        return decoded.failure
          ? {
            ok: false,
            status: 'failed-rolled-back',
            opId,
            failure: decoded.failure,
          }
          : {
            ok: false,
            status: 'outcome-unknown',
            opId,
            deliveryError: { message: decoded.error },
          };
      } catch (err) {
        const message = err.message ?? String(err);
        return requestAttempted
          ? {
            ok: false,
            status: 'outcome-unknown',
            opId,
            deliveryError: { message },
          }
          : {
            ok: false,
            status: 'failed-rolled-back',
            opId,
            failure: clientFailure('invalid-input', message),
          };
      }
    };

    // Also attach to the store object so store.<actionType>() works
    S.store[actionType] = fn;
    return fn;
  };
S.close = function close()  {
    if (S._closed) return;
    S._closed = true;

    for (const unsub of S._listUnsubs.values()) {
      unsub();
    }
    for (const unsub of S._listChangeUnsubs.values()) {
      unsub();
    }
    for (const unsub of S._listStatusUnsubs.values()) {
      unsub();
    }
    for (const list of S._listCache.values()) {
      list.close().catch(() => {});
    }
    S.resolvedChannel.close();

    S._listCache.clear();
    S._listOptions.clear();
    S._listUnsubs.clear();
    S._listChangeUnsubs.clear();
    S._listStatusUnsubs.clear();
    S._overlay.clear();
    S._renderCallbacks.clear();
    S._changeCallbacks.clear();
    S._statusCallbacks.clear();
  };
S.resolvedChannel = S.channel ?? new LiveChannel(S.baseUrl);
S.resolvedFetch = S.fetchImpl ?? globalThis.fetch;
S.resolvedReplicaState = S.replicaState ?? createIndexedDbReplicaState();
S._opIdCounter = 0;
S._listCache = new Map();
S._listOptions = new Map();
S._overlay = new Map();
S._renderCallbacks = new Set();
S._changeCallbacks = new Set();
S._statusCallbacks = new Set();
}
