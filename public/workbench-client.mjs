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

import { applyTextOp, createTextState, materializeText, restoreTextCheckpoint } from './workbench-annotated-text.mjs';
import { deleteText, insertText } from './workbench-text-edit.mjs';
import { createAnnotatedTextSnapshotSessionBinding, revokeAnnotatedTextSnapshotSessionBinding } from './workbench-annotated-text-snapshot-internal.mjs';
import { isOffsetRange, materializeAnnotatedTextSnapshot, projectPendingAnnotatedTextDocument, resolveRangeOffsets, shiftOffsetRangesOverText, tryResolveRangesOffsets } from './workbench-annotated-text-snapshot.mjs';
import { applyOffsetTextEdit, applyTextOperation, materializeText as materializeFamilyText, resolveOffsetToEndpoint, restoreTextFamily } from './workbench-annotated-text-continuous.mjs';
import { annotatedTextAction } from './workbench-annotated-text-action.mjs';
export { bindAnnotatedTextEditor } from './workbench-annotated-text-editor.mjs';
export { materializeAnnotatedTextSnapshot };
export { projectEndpointToOffset } from './workbench-annotated-text-continuous.mjs';

// --- BEGIN GENERATED from src/replay-decision.ts (keep in sync; zero-import) ---
function normalizeSeqSpan(seqOrSpan) {
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

function decideReplay(cursor, seqOrSpan) {
  const [lo, hi] = normalizeSeqSpan(seqOrSpan);
  const expected = (Number(cursor) || 0) + 1;
  if (hi < expected) return { kind: 'duplicate' };
  if (lo > expected) return { kind: 'gap' };
  return { kind: 'next', cursor: hi };
}
// --- END GENERATED from src/replay-decision.ts ---

// Shared capped-exponential-backoff delay. Pure: timers and attempt counters
// stay at the call sites, which differ in reset/clear semantics.
function backoffDelay(attempt, base, max) {
  return Math.min(base * 2 ** attempt, max);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

// ---------------------------------------------------------------------------
// createOpLifecycle — the one operation-record lifecycle both fold-echo
// engines (createLiveDeliverySession, createScopeLiveStore) reimplemented.
// The REST-overlay model (createLiveStore) keeps its own overlay bookkeeping.
// ---------------------------------------------------------------------------

function shouldReconcile(_operation, { confirmedCursor, echoCursor }) {
  return echoCursor != null && (confirmedCursor == null || echoCursor >= confirmedCursor);
}

function makeOperation({ actionId, ...extra }) {
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

function createOpLifecycle() {
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

function normalizeSubscribeArgs(optionsOrOnEvent, maybeOnEvent) {
  if (typeof optionsOrOnEvent === 'function' || optionsOrOnEvent === undefined || optionsOrOnEvent === null) {
    return { options: {}, onEvent: optionsOrOnEvent };
  }
  return { options: optionsOrOnEvent, onEvent: maybeOnEvent };
}

function subscribeEnvelope(entity, id, { fields, pace, carets } = {}) {
  const envelope = { type: 'subscribe', entity, id };
  if (fields !== undefined) envelope.fields = fields;
  if (pace !== undefined) envelope.pace = pace;
  if (carets !== undefined) envelope.carets = carets;
  return envelope;
}

function isPlainJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

class ClientClosedError extends Error {
  constructor(message = 'Live channel is closed') {
    super(message);
    this.name = 'ClientClosedError';
  }
}

export class WorkbenchFailureError extends Error {
  constructor(workbenchFailure) {
    if (!isWorkbenchFailure(workbenchFailure)) {
      throw new TypeError('WorkbenchFailureError requires a canonical WorkbenchFailure');
    }
    super(workbenchFailure.message);
    this.name = 'WorkbenchFailureError';
    this.failure = workbenchFailure;
  }
}

class LiveSyncSession {
  // `baseUrl` is e.g. 'http://127.0.0.1:5432'. Derives ws:// URL by swapping
  // scheme and appending '/events'. If already ws:// or wss://, uses as-is.
  constructor(baseUrl, options = {}) {
    let wsUrl;
    if (baseUrl.startsWith('ws://') || baseUrl.startsWith('wss://')) {
      wsUrl = baseUrl.replace(/\/$/, '') + '/events';
    } else {
      wsUrl = baseUrl
        .replace(/^http:/, 'ws:')
        .replace(/^https:/, 'wss:')
        .replace(/\/$/, '') + '/events';
    }
    this._wsUrl = wsUrl;
    this._socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));

    // Desired subscriptions are the source of truth. Wire messages are derived
    // from this registry for each socket generation; there is deliberately no
    // raw-message outbox to become stale or contradictory while offline.
    this._subs = new Map();
    // Pending subscribe promises: key → { resolve, reject }
    this._pendingSubs = new Map();
    // In-flight subscribe wire requests: requestId → desired-subscription key.
    // A reconnect allocates a fresh request so an old denial cannot retire the
    // current generation's desired subscription.
    this._subRequests = new Map();
    this._nextRequestId = 1;
    // Pending unsubscribe: key → { resolve, timeout }
    this._pendingUnsubs = new Map();

    this._socket = null;
    this._state = 'idle';
    this._generation = 0;
    this._connecting = null;
    this._closed = false;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._maxBackoff = options.maxBackoff ?? 5000;
    this._backoffBase = options.backoffBase ?? 200;
    this._watchdog = null;
    this._connCallbacks = new Set();
    // The latest volatile caret position (if any) while the socket is offline.
    // Replays after a reconnect so a caret move during a reconnect window is
    // not silently dropped; a clear supersedes it.
    this._pendingCaret = null;
  }

  // Subscribe to an (entity, id). Opens the WebSocket lazily on first call.
  // Returns a handle `{ currentSeq }` from the server's `subscribed` ack.
  // Rejects with WorkbenchFailureError when the server sends a canonical
  // `error` envelope before the `subscribed` ack; inspect its stable `.failure`.
  subscribe(entity, id, optionsOrOnEvent, maybeOnEvent) {
    const { options, onEvent } = normalizeSubscribeArgs(optionsOrOnEvent, maybeOnEvent);
    const key = `${entity}:${String(id)}`;
    if (this._closed) throw new ClientClosedError();
    if (this._subs.has(key)) {
      throw new Error(`already subscribed to ${entity}:${id}`);
    }
    if (this._pendingUnsubs.has(key)) {
      throw new Error(`unsubscribe is still pending for ${entity}:${id}`);
    }

    const carets = Array.isArray(options.carets) ? options.carets : undefined;
    const onCaret = typeof options.onCaret === 'function' ? options.onCaret : undefined;
    const ready = new Promise((resolve, reject) => {
      this._subs.set(key, {
        onEvent,
        onCaret,
        onCheckpoint: options.onCheckpoint,
        onResync: options.onResync,
        fields: options.fields,
        pace: options.pace,
        carets,
        envelope: subscribeEnvelope(entity, id, { ...options, carets }),
        sentGeneration: 0,
      });
      this._pendingSubs.set(key, { resolve, reject });
    });
    this._openSocket().then(() => {
      this._sendSubscription(key);
    }).catch((err) => {
      const pending = this._pendingSubs.get(key);
      if (pending) {
        this._pendingSubs.delete(key);
        this._subs.delete(key);
        pending.reject(err);
      }
    });
    return ready;
  }

  // Subscribe to a scope string. The scope is the ordered stream key (e.g. "Entity:id"
  // for per-entity, "project:<id>" for room/project streams). interest narrows delivery
  // to a specific entity + id within the scope. Opens the WebSocket lazily on first call.
  subscribeScope(scope, optionsOrOnEvent, maybeOnEvent) {
    const { options, onEvent } = normalizeSubscribeArgs(optionsOrOnEvent, maybeOnEvent);
    const key = scope;
    if (this._closed) throw new ClientClosedError();
    if (this._subs.has(key)) {
      throw new Error(`already subscribed to scope ${scope}`);
    }
    if (this._pendingUnsubs.has(key)) {
      throw new Error(`unsubscribe is still pending for scope ${scope}`);
    }

    const interest = { ...options.interest };
    if (options.fields !== undefined) interest.fields = options.fields;
    if (options.pace !== undefined) interest.pace = options.pace;
    const carets = Array.isArray(options.carets) ? options.carets : interest.carets;
    if (carets !== undefined) interest.carets = carets;
    const envelope = { type: 'subscribe', scope };
    if (Object.keys(interest).length > 0) envelope.interest = interest;
    const ready = new Promise((resolve, reject) => {
      this._subs.set(key, {
        onEvent,
        onCaret: typeof options.onCaret === 'function' ? options.onCaret : undefined,
        onCheckpoint: options.onCheckpoint,
        onResync: options.onResync,
        fields: options.fields,
        pace: options.pace,
        carets,
        scope,
        entity: interest.entity,
        id: interest.id,
        envelope,
        sentGeneration: 0,
      });
      this._pendingSubs.set(key, { resolve, reject });
    });
    this._openSocket().then(() => {
      this._sendSubscription(key);
    }).catch((err) => {
      const pending = this._pendingSubs.get(key);
      if (pending) {
        this._pendingSubs.delete(key);
        this._subs.delete(key);
        pending.reject(err);
      }
    });
    return ready;
  }

  // Unsubscribe from an (entity, id). Resolves after the `unsubscribed` ack
  // or a short timeout (2s) if the ack never arrives.
  async unsubscribe(entity, id) {
    const key = `${entity}:${String(id)}`;
    return this._unsubscribe(key, { type: 'unsubscribe', entity, id });
  }

  async _unsubscribe(key, envelope) {
    if (!this._subs.has(key)) return;
    const requestId = this._subs.get(key)?.requestId;
    if (requestId !== undefined) this._subRequests.delete(requestId);
    this._subs.delete(key);
    const pendingSub = this._pendingSubs.get(key);
    if (pendingSub) {
      this._pendingSubs.delete(key);
      pendingSub.reject(new ClientClosedError('Live subscription was cancelled'));
    }
    if (!this._socket || this._socket.readyState !== 1) return;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this._pendingUnsubs.delete(key);
        resolve();
      }, 2000);
      if (typeof timeout.unref === 'function') timeout.unref();

      this._pendingUnsubs.set(key, { resolve, timeout });
      if (!this._send(envelope)) {
        clearTimeout(timeout);
        this._pendingUnsubs.delete(key);
        resolve();
      }
    });
  }

  // Unsubscribe from a scope string.
  async unsubscribeScope(scope) {
    return this._unsubscribe(scope, { type: 'unsubscribe', scope });
  }

  // Tear down: close socket, clear all subscriptions, cancel reconnect timer.
  // After close(), no further reconnects or deliveries happen.
  close() {
    if (this._closed) return;
    this._closed = true;
    this._state = 'closing';
    this._generation++;
    this._clearReconnect();
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
    }
    if (this._socket) {
      try { this._socket.close(); } catch { /* ignore */ }
      this._socket = null;
    }
    this._subs.clear();
    this._subRequests.clear();
    this._pendingCaret = null;
    for (const [, pending] of this._pendingSubs) {
      pending.reject(new ClientClosedError());
    }
    this._pendingSubs.clear();
    for (const [, p] of this._pendingUnsubs) {
      if (p.timeout) clearTimeout(p.timeout);
      p.resolve();
    }
    this._pendingUnsubs.clear();
    this._connecting = null;
    this._state = 'closed';
    this._emitConnectionStatus('disconnected');
    this._connCallbacks.clear();
  }

  // Send a volatile caret update (optionally carrying a text selection).
  // Returns false when offline (no queue/replay).
  updateCaret({ entity, id, field, offset, selection }) {
    if (this._closed) throw new ClientClosedError();
    const arg = arguments[0];
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
      throw new TypeError('updateCaret requires type/entity/id/field/offset');
    }
    const argKeys = Object.keys(arg);
    if (argKeys.length < 4 || argKeys.length > 5 || argKeys.some((k) => !['entity','id','field','offset','selection'].includes(k))) {
      throw new TypeError('updateCaret requires type/entity/id/field/offset');
    }
    if (typeof entity !== 'string' || entity.length === 0 ||
        typeof id !== 'string' || id.length === 0 ||
        typeof field !== 'string' || field.length === 0) {
      throw new TypeError('updateCaret requires non-empty strings for entity, id, field');
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError('updateCaret requires a non-negative safe integer offset');
    }
    if (selection !== undefined) {
      if (!selection || typeof selection !== 'object' || Array.isArray(selection)
        || Object.keys(selection).length !== 2
        || !Number.isSafeInteger(selection.from) || !Number.isSafeInteger(selection.to)
        || selection.from < 0 || selection.to < 0) {
        throw new TypeError('updateCaret selection must be a { from, to } range of non-negative offsets');
      }
    }
    const msg = selection === undefined
      ? { type: 'caret.update', entity, id, field, offset }
      : { type: 'caret.update', entity, id, field, offset, selection };
    // Remember the latest caret unconditionally: if the socket drops after a
    // successful send, the server retracts this presence and the reconnect
    // must restore it (replayed after the next `subscribed` ack). A clear
    // supersedes it.
    this._pendingCaret = msg;
    return this._send(msg);
  }

  // Send a volatile caret clear. Returns false when offline (no queue/replay).
  clearCaret({ entity, id, field }) {
    if (this._closed) throw new ClientClosedError();
    const arg = arguments[0];
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
      throw new TypeError('clearCaret requires exactly type/entity/id/field');
    }
    const argKeys = Object.keys(arg);
    if (argKeys.length !== 3 || argKeys.some((k) => !['entity','id','field'].includes(k))) {
      throw new TypeError('clearCaret requires exactly type/entity/id/field');
    }
    if (typeof entity !== 'string' || entity.length === 0 ||
        typeof id !== 'string' || id.length === 0 ||
        typeof field !== 'string' || field.length === 0) {
      throw new TypeError('clearCaret requires non-empty strings for entity, id, field');
    }
    const msg = { type: 'caret.clear', entity, id, field };
    this._pendingCaret = null;
    return this._send(msg);
  }

  // --- internal ---

  // Open a new WebSocket connection. Returns a promise that resolves when the
  // socket is open (readyState === 1), or rejects on error / timeout.
  // Uses polling on readyState because Node's global WebSocket does not reliably
  // emit the 'open' event across versions.
  _openSocket() {
    if (this._closed) return Promise.reject(new ClientClosedError());
    if (this._socket?.readyState === 1 && this._state === 'online') {
      return Promise.resolve();
    }
    if (this._connecting) return this._connecting;

    this._state = 'connecting';
    const generation = ++this._generation;
    const connecting = new Promise((resolve, reject) => {
      let ws;
      try {
        ws = this._socketFactory(this._wsUrl);
      } catch (err) {
        if (generation === this._generation) {
          this._socket = null;
          this._state = 'idle';
        }
        reject(err);
        return;
      }
      let settled = false;
      let pollTimer = null;
      let connectTimeout = null;

      const stopTimers = () => {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
        if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
      };

      const resolveOpen = () => {
        if (settled) return;
        settled = true;
        stopTimers();
        if (this._closed || generation !== this._generation) {
          try { ws.close(); } catch { /* ignore */ }
          reject(new ClientClosedError());
          return;
        }
        this._reconnectAttempt = 0;
        this._socket = ws;
        this._state = 'online';
        this._emitConnectionStatus('connected');
        this._reconcileDesired();
        // Watchdog: some servers (incl. this framework's hand-rolled WS) do
        // not complete the close handshake — they ack the close frame but
        // never destroy the socket, so the client's 'close' event never fires
        // and readyState sticks at 2 (CLOSING). Poll readyState and fire the
        // same drop path the 'close' listener would when the socket is no
        // longer OPEN. unref'd so it never pins the event loop on its own.
        this._watchdog = setInterval(() => {
          if (this._closed || generation !== this._generation || ws !== this._socket) {
            clearInterval(this._watchdog); this._watchdog = null;
            return;
          }
          if (ws.readyState !== 1) {
            clearInterval(this._watchdog); this._watchdog = null;
            this._retireSocket(ws, generation);
          }
        }, 100);
        if (typeof this._watchdog.unref === 'function') this._watchdog.unref();
        resolve();
      };

      const onError = () => {
        if (settled) return;
        settled = true;
        stopTimers();
        if (generation === this._generation) {
          this._socket = null;
          this._state = 'idle';
        }
        reject(new Error('WebSocket connection failed'));
      };

      ws.addEventListener('open', resolveOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', () => {
        if (generation !== this._generation) return;
        if (!settled) {
          settled = true;
          stopTimers();
          reject(new Error('WebSocket connection closed before opening'));
        }
        this._retireSocket(ws, generation);
      });
      ws.addEventListener('message', (ev) => {
        if (this._closed || generation !== this._generation || ws !== this._socket) return;
        try {
          this._handleEnvelope(JSON.parse(ev.data));
        } catch { /* malformed frame — ignore */ }
      });

      // Poll readyState until OPEN (1) — fallback when 'open' doesn't fire.
      pollTimer = setInterval(() => {
        if (settled) { clearInterval(pollTimer); pollTimer = null; return; }
        if (ws.readyState === 1) resolveOpen();
      }, 20);
      if (typeof pollTimer.unref === 'function') pollTimer.unref();

      // Connection timeout — reject but leave the socket up (it may connect
      // eventually; if it does, the close handler will trigger reconnect).
      connectTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          stopTimers();
          if (generation === this._generation) {
            this._socket = null;
            this._state = 'idle';
          }
          try { ws.close(); } catch { /* ignore */ }
          reject(new Error('WebSocket connection timeout'));
        }
      }, 5000);
      if (typeof connectTimeout.unref === 'function') connectTimeout.unref();
    });
    this._connecting = connecting;
    connecting.finally(() => {
      if (this._connecting === connecting) this._connecting = null;
    }).catch(() => {});
    return connecting;
  }

  _retireSocket(ws, generation) {
    if (this._closed || generation !== this._generation) return;
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
    if (this._socket === ws) this._socket = null;
    this._generation++;
    this._subRequests.clear();
    for (const sub of this._subs.values()) {
      sub.sentGeneration = 0;
      sub.requestId = undefined;
    }
    this._state = 'backoff';
    this._emitConnectionStatus('disconnected');
    try {
      if (ws.readyState < 2) ws.close();
    } catch { /* ignore */ }
    this._scheduleReconnect();
  }

  _subscriptionEnvelope(key, sub) {
    if (sub.envelope) return sub.envelope;
    const nullSep = key.indexOf('\0');
    if (nullSep > 0) {
      return subscribeEnvelope(key.slice(0, nullSep), key.slice(nullSep + 1), sub);
    }
    const colon = key.indexOf(':');
    if (colon > 0) {
      return subscribeEnvelope(key.slice(0, colon), key.slice(colon + 1), sub);
    }
    const envelope = { type: 'subscribe', scope: key };
    const interest = {};
    if (sub.entity !== undefined) interest.entity = sub.entity;
    if (sub.id !== undefined) interest.id = sub.id;
    if (sub.fields !== undefined) interest.fields = sub.fields;
    if (sub.pace !== undefined) interest.pace = sub.pace;
    if (sub.carets !== undefined) interest.carets = sub.carets;
    if (Object.keys(interest).length > 0) envelope.interest = interest;
    return envelope;
  }

  _sendSubscription(key) {
    const sub = this._subs.get(key);
    if (!sub || sub.sentGeneration === this._generation) return;
    const requestId = this._nextRequestId++;
    const envelope = { ...this._subscriptionEnvelope(key, sub), requestId };
    if (this._send(envelope)) {
      if (sub.requestId !== undefined) this._subRequests.delete(sub.requestId);
      sub.requestId = requestId;
      this._subRequests.set(requestId, key);
      sub.sentGeneration = this._generation;
    }
  }

  _reconcileDesired() {
    for (const key of this._subs.keys()) this._sendSubscription(key);
  }

  // Route one server envelope to the right handler.
  _handleEnvelope(envelope) {
    const scopeKey = envelope.scope ?? (envelope.entity ? `${envelope.entity}:${String(envelope.id)}` : null);

    if (envelope.type === 'subscribed') {
      const sub = scopeKey ? this._subs.get(scopeKey) : null;
      if (sub && envelope.requestId !== undefined && sub.requestId !== envelope.requestId) return;
      if (sub && typeof sub.onCheckpoint === 'function') {
        try { sub.onCheckpoint({ currentSeq: envelope.currentSeq }); } catch { /* isolate consumer */ }
      }
      const pending = scopeKey ? this._pendingSubs.get(scopeKey) : null;
      if (pending) {
        this._pendingSubs.delete(scopeKey);
        pending.resolve({ currentSeq: envelope.currentSeq });
      }
      // The caret subscription is installed server-side once `subscribed` is
      // acknowledged. Replay the latest caret only then — sending it earlier
      // races subscription installation and gets rejected. Keep it until a
      // clear supersedes it (a clear also clears `_pendingCaret`).
      if (this._pendingCaret && this._send(this._pendingCaret)) this._pendingCaret = null;
    } else if (envelope.type === 'unsubscribed') {
      if (scopeKey) {
        const pending = this._pendingUnsubs.get(scopeKey);
        if (pending) {
          if (pending.timeout) clearTimeout(pending.timeout);
          this._pendingUnsubs.delete(scopeKey);
          pending.resolve();
        }
      }
    } else if (envelope.type === 'error') {
      if (!isWorkbenchFailure(envelope.failure)) return;
      if (envelope.requestId !== undefined) {
        const key = this._subRequests.get(envelope.requestId);
        if (!key) return;
        this._subRequests.delete(envelope.requestId);
        const sub = this._subs.get(key);
        if (!sub || sub.requestId !== envelope.requestId) return;
        this._subs.delete(key);
        const pending = this._pendingSubs.get(key);
        if (pending) {
          this._pendingSubs.delete(key);
          pending.reject(new WorkbenchFailureError(envelope.failure));
        }
        return;
      }
      // A connection-level error cannot truthfully identify one pending
      // subscription, so it must not reject any of them as a known denial.
    } else if (envelope.type === 'event') {
      const key = scopeKey ?? `${envelope.entity}:${String(envelope.id)}`;
      const sub = this._subs.get(key);
      if (sub && typeof sub.onEvent === 'function') {
        sub.onEvent(envelope);
      }
    } else if (envelope.type === 'resync') {
      const key = scopeKey ?? `${envelope.entity}:${String(envelope.id)}`;
      const sub = this._subs.get(key);
      if (sub && typeof sub.onResync === 'function') {
        sub.onResync(envelope);
      }
    } else if (envelope.type === 'annotated-text-caret') {
      this._handleCaretFrame(envelope);
    }
  }

  // --- annotated-text-caret exact version 1 grammar ---

  // Route an inbound annotated-text-caret frame to matching subscriptions.
  // Drops malformed, unmatched, unsupported frames silently.
  _handleCaretFrame(envelope) {
    if (!isPlainJsonObject(envelope)) return;
    if (envelope.version !== 1 || envelope.type !== 'annotated-text-caret') return;
    if (typeof envelope.entity !== 'string' || envelope.entity.length === 0 ||
        typeof envelope.id !== 'string' || envelope.id.length === 0 ||
        typeof envelope.field !== 'string' || envelope.field.length === 0) return;
    const expectedTop = ['type', 'version', 'entity', 'id', 'field', 'change'];
    if (Object.keys(envelope).length !== expectedTop.length) return;
    const topKeys = Object.keys(envelope).sort();
    for (const k of topKeys) {
      if (!expectedTop.includes(k)) return;
    }
    if (!isPlainJsonObject(envelope.change)) return;
    if (envelope.change.op === 'remove') {
      const changeKeys = Object.keys(envelope.change).sort();
      if (changeKeys.length !== 2 || changeKeys[0] !== 'op' || changeKeys[1] !== 'presence') return;
      if (typeof envelope.change.presence !== 'string' || envelope.change.presence.length === 0) return;
    } else if (envelope.change.op === 'own') {
      const changeKeys = Object.keys(envelope.change).sort();
      if (changeKeys.length !== 2 || changeKeys[0] !== 'op' || changeKeys[1] !== 'presence') return;
      if (typeof envelope.change.presence !== 'string' || envelope.change.presence.length === 0) return;
    } else if (envelope.change.op === 'upsert') {
      const changeKeys = Object.keys(envelope.change).sort();
      if (changeKeys.length !== 2 || changeKeys[0] !== 'op' || changeKeys[1] !== 'value') return;
      const value = envelope.change.value;
      if (!isPlainJsonObject(value)) return;
      const valueKeys = Object.keys(value).sort();
      if (value.kind === 'caret') {
        if (valueKeys.length !== 5 || valueKeys[0] !== 'kind' || valueKeys[1] !== 'name' || valueKeys[2] !== 'offset' || valueKeys[3] !== 'presence' || valueKeys[4] !== 'sourceId') return;
        if (typeof value.name !== 'string' ||
            typeof value.presence !== 'string' || value.presence.length === 0 ||
            typeof value.sourceId !== 'string' ||
            !Number.isSafeInteger(value.offset) || value.offset < 0) return;
      } else if (value.kind === 'edge') {
        if (valueKeys.length !== 5 || valueKeys[0] !== 'edge' || valueKeys[1] !== 'kind' || valueKeys[2] !== 'name' || valueKeys[3] !== 'presence' || valueKeys[4] !== 'sourceId') return;
        if (typeof value.name !== 'string' ||
            typeof value.presence !== 'string' || value.presence.length === 0 ||
            typeof value.sourceId !== 'string' ||
            value.edge !== 'start') return;
      } else if (value.kind === 'selection') {
        if (valueKeys.length !== 6 || valueKeys[0] !== 'from' || valueKeys[1] !== 'kind' || valueKeys[2] !== 'name' || valueKeys[3] !== 'presence' || valueKeys[4] !== 'sourceId' || valueKeys[5] !== 'to') return;
        if (typeof value.name !== 'string' ||
            typeof value.presence !== 'string' || value.presence.length === 0 ||
            typeof value.sourceId !== 'string' ||
            !Number.isSafeInteger(value.from) || !Number.isSafeInteger(value.to) ||
            value.from < 0 || value.to < 0) return;
      } else {
        return;
      }
    } else {
      return;
    }

    const directKey = `${envelope.entity}:${String(envelope.id)}`;
    for (const [key, sub] of this._subs) {
      const directMatch = key === directKey;
      const scopedMatch = sub.scope !== undefined && sub.entity === envelope.entity && String(sub.id) === envelope.id;
      if (!directMatch && !scopedMatch) continue;
      if (typeof sub.onCaret !== 'function' || !sub.carets?.includes(envelope.field)) continue;
      try {
        sub.onCaret(envelope);
      } catch { /* isolate consumer errors */ }
    }
  }

  // Send only on the current online generation. Desired subscriptions, rather
  // than raw messages, are replayed after a drop.
  _send(data) {
    const ws = this._socket;
    const generation = this._generation;
    if (!ws || ws.readyState !== 1 || this._state !== 'online') return false;
    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch {
      this._retireSocket(ws, generation);
      return false;
    }
  }

  // Schedule a reconnection attempt with exponential backoff.
  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    this._emitConnectionStatus('reconnecting');
    const delay = backoffDelay(this._reconnectAttempt, this._backoffBase, this._maxBackoff);
    this._reconnectAttempt++;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._closed) return;
      try {
        await this._openSocket();
        this._reconcileDesired();
      } catch {
        if (!this._closed) this._scheduleReconnect();
      }
    }, delay);
    if (typeof this._reconnectTimer.unref === 'function') this._reconnectTimer.unref();
  }

  // Cancel any pending reconnect timer.
  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectAttempt = 0;
  }

  // Public connection-state emitter. Registers a callback that receives the
  // connection status ('connected' | 'disconnected' | 'reconnecting') on every
  // transition. Returns an unsubscribe function.
  onConnectionChange(cb) {
    this._connCallbacks.add(cb);
    return () => { this._connCallbacks.delete(cb); };
  }

  _emitConnectionStatus(status) {
    for (const cb of this._connCallbacks) {
      try { cb(status); } catch { /* swallow */ }
    }
  }
}

// Public façade. The state machine stays private so transport lifecycle details
// do not become package API, while existing LiveChannel consumers retain the
// small subscribe/unsubscribe/close surface.
export class LiveChannel extends LiveSyncSession {}

// LiveList — tracks ONE document's live state: a single (entity, id) row,
// including its sub-collection fields. Bootstraps from a REST snapshot, then
// folds live events through ONE reducer path (_ingest → _applyEvent),
// maintaining a sequence cursor. Re-renders on every state change via
// registered onRender callbacks.
//
// Zero external deps — uses injected fetch and channel (no real server needed
// for tests).
export class LiveList {
  constructor({
    entity,
    id,
    channel,
    fetchImpl,
    snapshotUrl,
    eventsSinceUrl,
    fields,
    pace,
    maxBufferedEvents = 1000,
    resyncBackoffBase = 200,
    maxResyncBackoff = 5000,
    onTextReducer,
  }) {
    this._entity = entity;
    this._id = id;
    this._channel = channel;
    this._fetchImpl = fetchImpl ?? globalThis.fetch;
    this._snapshotUrl = snapshotUrl;
    this._eventsSinceUrl = eventsSinceUrl;
    this._fields = fields;
    this._pace = pace;
    this._onTextReducer = onTextReducer;

    this._state = null;
    this._cursor = 0;
    this._ready = false;
    this._closed = false;
    this._epoch = 0;
    this._abortController = new AbortController();
    this._subscribeCalled = false;
    this._resyncing = false;
    this._queue = [];               // Buffered live envelopes (before ready / during resync)
    this._maxBufferedEvents = maxBufferedEvents;
    this._bufferOverflow = false;
    this._resyncBackoffBase = resyncBackoffBase;
    this._maxResyncBackoff = maxResyncBackoff;
    this._resyncAttempt = 0;
    this._resyncRetryTimer = null;
    this._snapshotRequiredSeq = 0;
    this._snapshotRecovery = false;
    this._forceSnapshotRequested = false;
    this._renderCallbacks = new Set();
    this._ordered = {};             // { [field]: [{id, key, item}] } — internal ordered tracking
    this._textStates = {};          // durable annotated-text reducer state by field
    // Fields folded since the last render tick whose materialized text is
    // stale. Rematerialized once per render (see _flushDirtyTextFields) so a
    // resync replay of N ops costs one tree rebuild, not N.
    this._dirtyTextFields = new Set();
    this._textReducerReady = Promise.resolve();
    this._removed = false;

    // Promise that resolves when bootstrap completes — accessible via .ready
    this._readyResolve = null;
    this._readyReject = null;
    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // Consumers may await either subscribe() or .ready. Keep an ignored branch
    // so rejecting readiness during teardown never becomes an unhandled promise.
    this._readyPromise.catch(() => {});
  }

  // --- Public API ---

  /** Current document state (plain object), or null if removed. */
  get state() { return this._state; }

  /** Current sequence cursor. */
  get cursor() { return this._cursor; }

  /** Promise that resolves when bootstrap completes (same as subscribe()). */
  get ready() { return this._readyPromise; }

  textState(field) { return this._textStates[field] ?? null; }

  get textReducerReady() { return this._textReducerReady; }

  /**
   * Bootstrap: snapshot → subscribe → (resync if gap) → drain queue → render.
   * Resolves only after the full bootstrap sequence completes. Throws if called twice.
   */
  async subscribe() {
    if (this._subscribeCalled) throw new Error('subscribe already called');
    this._subscribeCalled = true;
    const epoch = this._epoch;

    try {
      // 1. GET snapshot → initial state + cursor
      const snapRes = await this._fetchImpl(
        this._snapshotUrl(this._entity, this._id),
        { signal: this._abortController.signal },
      );
      const { snapshot, seq, reducers } = await this._decode(snapRes);
      this._assertActive(epoch);
      this._state = snapshot;
      await this._installTextReducers(reducers);
      this._cursor = seq;
      this._removed = false;

      // 2. Subscribe to live channel.
      //    During the subscribe await, any live envelopes arrive via _onLiveEnvelope,
      //    which queues them because _ready is still false.
      const ack = await this._channel.subscribe(this._entity, this._id, {
        fields: this._fields,
        pace: this._pace,
        onCheckpoint: ({ currentSeq }) => this._onCheckpoint(currentSeq),
        onResync: (control) => this._onLiveResync(control),
      }, (envelope) => {
        this._onLiveEnvelope(envelope);
      });
      this._assertActive(epoch);

      // 3. If the server has progressed past our snapshot cursor, there is a
      //    race-gap — resync via events-since BEFORE releasing the queue.
      if (this._bufferOverflow) {
        await this._resync(true);
        this._assertActive(epoch);
      } else if (ack.currentSeq > this._cursor) {
        await this._resync();
        this._assertActive(epoch);
      }

      // 4. Drain the queue (envelopes that arrived during subscribe + resync).
      this._ready = true;
      const queue = this._queue;
      this._queue = [];
      for (const envelope of queue) {
        this._ingest(this._normalizeLive(envelope));
      }
      await this._textReducerReady;
      this._assertActive(epoch);

      // 5. Render initial state, then resolve.
      this._flushDirtyTextFields();
      this._render();
      this._readyResolve();
    } catch (err) {
      this._readyReject(err);
      throw err;
    }
  }

  /**
   * Register a render callback. Called with the current state on every state
   * change. Returns an unsubscribe function.
   */
  onRender(cb) {
    this._renderCallbacks.add(cb);
    return () => this._renderCallbacks.delete(cb);
  }

  /** Tear down: unsubscribe from channel, clear callbacks, stop folding. Idempotent. */
  async close() {
    if (this._closed) return;
    this._closed = true;
    this._epoch++;
    this._abortController.abort();
    if (this._resyncRetryTimer) {
      clearTimeout(this._resyncRetryTimer);
      this._resyncRetryTimer = null;
    }
    this._renderCallbacks.clear();
    this._queue = [];
    if (!this._ready) this._readyReject(new ClientClosedError('Live list closed before it became ready'));
    try { await this._channel.unsubscribe(this._entity, this._id); } catch { /* ignore */ }
  }

  // --- Internal ---

  /** Minimal fetch response decoder. */
  _decode(res) {
    if (!res.ok) throw new Error('http ' + res.status);
    return res.json();
  }

  _assertActive(epoch) {
    if (this._closed || epoch !== this._epoch) {
      throw new ClientClosedError('Live list is closed');
    }
  }

  _onCheckpoint(currentSeq) {
    if (this._closed || !this._ready || currentSeq <= this._cursor) return;
    this._resync().catch(() => {});
  }

  _onLiveResync(control) {
    if (this._closed
      || (control?.reason !== 'annotated-text-snapshot-required'
        && control?.reason !== 'recipient-snapshot-required')
      || control.entity !== this._entity
      || String(control.id) !== String(this._id)
      || !Number.isSafeInteger(control.seq)
      || control.seq < 0) return;
    this._snapshotRequiredSeq = Math.max(this._snapshotRequiredSeq, control.seq);
    this._forceSnapshotRequested = true;
    // A control can arrive while an ordinary replay is in flight. From that
    // point every queued live envelope contributes to the snapshot high-water.
    this._snapshotRecovery = true;
    this._resync(true).catch(() => {});
  }

  /**
   * Called by the channel for every live envelope. Queues if not yet ready
   * or currently resyncing; otherwise ingests directly.
   */
  _onLiveEnvelope(envelope) {
    if (this._closed) return;
    if (this._isAnnotatedOperation(envelope?.event)) {
      this._onLiveResync({
        entity: this._entity,
        id: this._id,
        seq: Array.isArray(envelope?.seqSpan) ? envelope.seqSpan[1] : envelope?.seq,
        reason: 'annotated-text-snapshot-required',
      });
      return;
    }
    if (!this._ready || this._resyncing) {
      this._bufferEnvelope(envelope);
      return;
    }
    this._ingest(this._normalizeLive(envelope));
  }

  _bufferEnvelope(envelope) {
    if (this._snapshotRecovery && !this._isEntityRemoval(envelope?.event)) {
      const seq = Array.isArray(envelope?.seqSpan) ? envelope.seqSpan[1] : envelope?.seq;
      if (Number.isSafeInteger(seq) && seq >= 0) {
        this._snapshotRequiredSeq = Math.max(this._snapshotRequiredSeq, seq);
      }
    }
    if (this._queue.length >= this._maxBufferedEvents) {
      this._queue = [];
      this._bufferOverflow = true;
      return;
    }
    if (!this._bufferOverflow) this._queue.push(envelope);
  }

  /** Normalize a live WS envelope to internal shape {seq, seqSpan, event, delta}. */
  _normalizeLive(envelope) {
    return {
      seq: envelope.seq,
      seqSpan: envelope.seqSpan,
      event: envelope.event,
      delta: envelope.delta,
      reducers: envelope.reducers,
    };
  }

  _isAnnotatedOperation(event) {
    if (typeof event?.type !== 'string') return false;
    const prefix = `${this._entity}.`;
    if (!event.type.startsWith(prefix) || !event.type.endsWith('.operated')) return false;
    const field = event.type.slice(prefix.length, -'.operated'.length);
    return this._state?.[field]?.kind === 'workbench.annotatedText.recipient';
  }

  _isEntityRemoval(event) {
    return event?.type === `${this._entity}.removed`;
  }

  _consumeTerminalRemoval() {
    const removal = this._queue.find((envelope) => this._isEntityRemoval(envelope?.event));
    if (!removal) return false;
    let span;
    try {
      span = normalizeSeqSpan(removal.seqSpan ?? removal.seq);
    } catch {
      return false;
    }
    if (span[1] < this._cursor) return false;
    this._state = null;
    this._cursor = span[1];
    this._removed = true;
    this._ordered = {};
    this._textStates = {};
    this._dirtyTextFields.clear();
    this._textReducerReady = Promise.resolve();
    this._bufferOverflow = false;
    this._snapshotRequiredSeq = 0;
    this._queue = [];
    return true;
  }

  /**
   * THE ONE fold path. Both live envelopes and events-since rows converge here
   * (after normalization). Span-aware cursor logic:
   *
   *   expected = cursor + 1
   *
   *   seqSpan[1] < expected → duplicate (skip)
   *   seqSpan[0] > expected → gap (trigger resync, return without applying)
   *   else                  → apply, advance cursor to seqSpan[1], render
   */
  _ingest(normalized) {
    if (this._closed) return;
    const { seqSpan, event, delta, reducers } = normalized;
    const decision = decideReplay(this._cursor, seqSpan);

    if (decision.kind === 'duplicate') {
      return;
    }
    if (decision.kind === 'gap') {
      // Gap — missing events. Queue this envelope then trigger a resync;
      // after the resync fills the gap, the queue drain will re-process it
      // through _ingest when the cursor is caught up.
      this._bufferEnvelope({ seq: normalized.seq, seqSpan, event, delta, reducers });
      this._resync().catch(() => {});
      return;
    }
    // next — apply and advance cursor to span hi (shared Replay decision)
    this._installTextReducers(reducers);
    this._applyEvent(event, delta);
    this._cursor = decision.cursor;
    this._flushDirtyTextFields();
    this._render();
  }

  /**
   * Resync: fetch events-since from the server to fill a gap or stale state.
   * Handles two response shapes:
   *   {resync:'stale', reason}  → forced re-bootstrap from fresh snapshot
   *   {resync:'deleted', seq}   → terminal removal without a deleted snapshot
   *   {events:[...]}           → fold each row in order (bypass span dup/gap logic)
   *
   * During resync, any arriving live envelopes are queued; they are drained and
   * ingested after the resync completes.
   */
  async _resync(forceSnapshot = false) {
    if (this._resyncing) return; // prevent re-entrancy
    this._resyncing = true;
    const snapshotRequested = forceSnapshot || this._forceSnapshotRequested;
    this._forceSnapshotRequested = false;
    this._snapshotRecovery = snapshotRequested;
    const epoch = this._epoch;
    let failed = false;

    try {
      let body = null;
      if (!snapshotRequested) {
        const res = await this._fetchImpl(
          this._eventsSinceUrl(this._entity, this._id, this._cursor),
          { signal: this._abortController.signal },
        );
        body = await this._decode(res);
        this._assertActive(epoch);
      }

      if (body?.resync === 'deleted') {
        if (!Number.isFinite(body.seq) || body.seq < this._cursor) throw new Error('deleted resync has invalid cursor');
        this._state = null;
        this._cursor = body.seq;
        this._removed = true;
        this._ordered = {};
        this._textStates = {};
        this._dirtyTextFields.clear();
        this._textReducerReady = Promise.resolve();
        this._bufferOverflow = false;
        this._queue = [];
      } else if (snapshotRequested || this._bufferOverflow || body?.resync === 'stale') {
        // Forced re-bootstrap: fresh snapshot replaces state entirely.
        const snapRes = await this._fetchImpl(
          this._snapshotUrl(this._entity, this._id),
          { signal: this._abortController.signal },
        );
        const { snapshot, seq, reducers } = await this._decode(snapRes);
        this._assertActive(epoch);
        this._state = snapshot;
        await this._installTextReducers(reducers);
        this._cursor = seq;
        this._removed = false;
        this._ordered = {};
        this._dirtyTextFields.clear();
        this._bufferOverflow = false;
        if (this._cursor < this._snapshotRequiredSeq) {
          failed = true;
        } else if (this._consumeTerminalRemoval()) {
          // A removal may arrive after the snapshot's sequence. It has no
          // snapshot representation, so preserve its terminal live meaning.
        } else {
          this._snapshotRequiredSeq = 0;
          this._queue = [];
        }
      } else if (body?.events) {
        // Fold events-since rows in order. Events-since is authoritative
        // ordered fill — apply seq>cursor rows directly without span checks.
        // All-or-nothing (Wave 3.7 Contracts 2+3): validate the WHOLE batch —
        // contiguous from cursor+1 with no internal hole, every type known —
        // before applying any of it. A historical batch is server/network
        // data reaching the client outside the live span/dup-gap machinery;
        // a single bad row must not leave state and cursor split between
        // "partially applied" and "not applied" for the rest of the batch.
        const rows = body.events.filter((row) => row.seq > this._cursor);
        if (!this._isValidHistoricalBatch(rows)) {
          failed = true;
        } else {
          for (const row of rows) {
            const normalized = {
              seq: row.seq,
              seqSpan: [row.seq, row.seq],
              event: { type: row.type, data: row.data, actionId: row.actionId },
              delta: undefined,
              reducers: row.reducers,
            };
            await this._installTextReducers(normalized.reducers);
            this._applyEvent(normalized.event, normalized.delta);
            this._cursor = row.seq;
          }
        }
      }
    } catch {
      // The fold loop advances the cursor past every row it applied, so a
      // mid-batch failure leaves earlier ops folded-but-unmaterialized while
      // the retry resumes AFTER them. Materialize what succeeded BEFORE the
      // cleanup discards the marks — exactly what per-op materialization did
      // at this point before batching (#126).
      try { this._flushDirtyTextFields(); } catch { /* retry recovers */ }
      failed = !this._consumeTerminalRemoval();
    }

    this._resyncing = false;
    this._snapshotRecovery = false;
    if (this._closed || epoch !== this._epoch) return;
    if (failed) {
      // Successful folds were already materialized in the catch above; drop
      // any leftovers that could not be flushed safely so a later render
      // cannot apply them out of context.
      this._dirtyTextFields.clear();
      this._forceSnapshotRequested = this._forceSnapshotRequested || snapshotRequested;
      this._scheduleResync();
      return;
    }
    if (this._forceSnapshotRequested) {
      await this._resync(true);
      return;
    }
    this._resyncAttempt = 0;

    // Drain any envelopes that arrived during the resync.
    const queue = this._queue;
    this._queue = [];
    for (const envelope of queue) {
      this._ingest(this._normalizeLive(envelope));
    }
    await this._textReducerReady;

    this._flushDirtyTextFields();
    this._render();
  }

  _scheduleResync() {
    if (this._closed || this._resyncRetryTimer) return;
    const delay = backoffDelay(this._resyncAttempt, this._resyncBackoffBase, this._maxResyncBackoff);
    this._resyncAttempt++;
    this._resyncRetryTimer = setTimeout(() => {
      this._resyncRetryTimer = null;
      if (!this._closed) this._resync(this._bufferOverflow).catch(() => {});
    }, delay);
    if (typeof this._resyncRetryTimer.unref === 'function') this._resyncRetryTimer.unref();
  }

  /**
   * All-or-nothing pre-check for an events-since batch (Wave 3.7 Contracts
   * 2+3): every row's seq must form a contiguous run starting at cursor+1
   * (no internal hole, no gap at the front), and every row's type must be one
   * _applyEvent actually knows how to fold. An empty batch is trivially valid.
   */
  _isValidHistoricalBatch(rows) {
    let expected = this._cursor + 1;
    for (const row of rows) {
      if (row.seq !== expected) return false;
      if (!this._isKnownEventType(row.type)) return false;
      expected += 1;
    }
    return true;
  }

  _isKnownEventType(type) {
    if (typeof type !== 'string' || type.length === 0) return false;
    const parts = type.split('.');
    if (parts.length === 2) return parts[1] === 'created' || parts[1] === 'updated' || parts[1] === 'removed';
    return parts.length === 3 && parts.every((part) => part.length > 0);
  }

  /**
   * Kind-aware reducer. Parse event.type by splitting on '.':
   *   2-part = entity.verb  (CRUD: created / updated / removed)
   *   3-part = entity.field.op  (field-specific: ordered, map, log ops)
   */
  _applyEvent(event, delta) {
    if (!event || !event.type) return;
    const parts = event.type.split('.');
    if (parts.length < 2) return;

    if (parts.length === 2) {
      this._applyCrud(parts[1], event, delta);
    } else if (parts.length === 3) {
      this._applyFieldOp(parts[1], parts[2], event);
    }
  }

  /** CRUD operations (2-part types: ticket.created / .updated / .removed). */
  _applyCrud(verb, event, delta) {
    switch (verb) {
      case 'created':
        this._state = { ...event.data };
        this._removed = false;
        this._ordered = {};
        // Whole-state replacement: pending rematerializations refer to the
        // discarded state object and must not overwrite the new one.
        this._dirtyTextFields.clear();
        break;

      case 'updated': {
        if (this._state == null) {
          this._state = {};
          this._removed = false;
        }
        // Value-XOR-delta: the server sends BOTH the whole new value (event.data)
        // and a per-field delta for diff-eligible/native kinds. A field present
        // in `delta` is applied ONLY via the delta below — assigning its whole
        // value here too would double-apply (e.g. a crdt insert on top of the
        // already-whole string). So skip any field the delta owns; event.data
        // remains authoritative for scalar fields the delta does NOT carry
        // (preserving the createClient app-reducer whole-value contract).
        // Exclude 'id' — it's an identity field.
        if (event.data) {
          for (const key of Object.keys(event.data)) {
            if (key === 'id') continue;
            if (delta && Object.prototype.hasOwnProperty.call(delta, key)) continue;
            this._state[key] = event.data[key];
          }
        }
        // Apply per-kind delta for the fields the delta owns.
        if (delta) {
          this._applyDelta(delta);
        }
        break;
      }

      case 'removed':
        this._state = null;
        this._removed = true;
        // Nothing may resurrect a field onto a removed row's null state.
        this._dirtyTextFields.clear();
        break;
    }
  }

  /** Apply value, state, struct, or map deltas. Text CRDTs fold native ops. */
  _applyDelta(delta) {
    for (const [field, d] of Object.entries(delta)) {
      if (d == null) continue;
      try {
        if ('set' in d) {
          // Value delta: {set: v}
          this._state[field] = d.set;
        } else if ('from' in d && 'to' in d) {
          // State delta: {from, to}
          this._state[field] = d.to;
        } else if ('cells' in d) {
          // Struct delta: {cells: {[name]: {set: v}}}
          this._state[field] = { ...(this._state[field] ?? {}) };
          for (const [name, cell] of Object.entries(d.cells)) {
            this._state[field][name] = cell.set;
          }
        } else if ('added' in d || 'removed' in d || 'changed' in d) {
          // Map delta (native storeMapDiff): {added:[], removed:[], changed:[]}
          const m = { ...(this._state[field] ?? {}) };
          if (d.added) {
            for (const entry of d.added) {
              m[entry.member] = entry.role;
            }
          }
          if (d.changed) {
            for (const entry of d.changed) {
              m[entry.member] = entry.role;
            }
          }
          if (d.removed) {
            for (const member of d.removed) {
              delete m[member];
            }
          }
          this._state[field] = m;
        }
      } catch {
        // Malformed delta for this field — skip.
      }
    }
  }

  /**
   * Field-specific operations (3-part types: ticket.field.op).
   * Dispatches by operation name AND data shape:
   *   inserted/moved/reordered  → ordered
   *   appended                  → log
   *   added/changed             → map
   *   removed                   → map if data.member, ordered if data.id
   */
  _applyFieldOp(field, op, event) {
    const data = event.data;
    if (!data) return;

    switch (op) {
      case 'applied': {
        const operation = data.operation;
        if (!operation) return;
        const state = this._textStates[field] ?? createTextState();
        const next = applyTextOp(state, operation);
        this._textStates[field] = next;
        // Defer materialization to the render tick — folding N ops before one
        // render rebuilds the text tree once, not once per op.
        this._dirtyTextFields.add(field);
        this._observeTextReducer({
          entity: this._entity, id: this._id, field,
          state: next, operation,
        }).catch(() => {});
        break;
      }
      case 'inserted':
      case 'moved':
      case 'reordered':
        this._applyOrderedOp(field, op, data);
        break;

      case 'appended':
        // Log append — push the full data as an entry.
        this._state[field] = [...(this._state[field] ?? []), data];
        break;

      case 'added':
      case 'changed': {
        // Map add/change — {member, role}
        const m = { ...(this._state[field] ?? {}) };
        m[data.member] = data.role;
        this._state[field] = m;
        break;
      }

      case 'removed': {
        // Disambiguate: 3-part .removed could be map or ordered.
        // data.member → map remove; data.id → ordered remove.
        if ('member' in data) {
          const m = { ...(this._state[field] ?? {}) };
          delete m[data.member];
          this._state[field] = m;
        } else if ('id' in data) {
          this._applyOrderedOp(field, 'removed', data);
        }
        break;
      }
    }
  }

  /**
   * Ordered sub-collection operations. Maintains internal _ordered[field] as
   * an array of {id, key, item}. After every op, sorts by key (lexicographic
   * String compare) and exposes state[field] as the sorted item values array.
   */
  _applyOrderedOp(field, op, data) {
    // Seed lazily — start from empty if this is the first ordered op.
    if (!this._ordered[field]) {
      this._ordered[field] = [];
    }
    const entries = this._ordered[field];

    switch (op) {
      case 'inserted':
        entries.push({ id: data.id, key: data.key, item: data.value });
        break;

      case 'moved':
        for (const entry of entries) {
          if (entry.id === data.id) {
            entry.key = data.key;
            break;
          }
        }
        break;

      case 'reordered': {
        const keyMap = new Map();
        if (data.entries) {
          for (const e of data.entries) {
            keyMap.set(e.id, e.key);
          }
        }
        for (const entry of entries) {
          if (keyMap.has(entry.id)) {
            entry.key = keyMap.get(entry.id);
          }
        }
        break;
      }

      case 'removed':
        this._ordered[field] = entries.filter(e => e.id !== data.id);
        break;
    }

    // Sort by key ascending. The server's ordered side-table stores `key` as a
    // REAL (numeric) column (ddl.mjs:108 `key REAL NOT NULL`) and orders rows via
    // SQLite `ORDER BY key` (entity.mjs:581) — a NUMERIC sort. The fractional key
    // is produced by numeric midpoint math (entity.mjs:588 keyBetween: (low+high)/2,
    // low+1, high-1, 0). So the client MUST sort numerically to match the server;
    // a string/locale compare would mis-order (e.g. 2 before 10) and diverge.
    this._ordered[field].sort((a, b) => a.key - b.key);

    // Expose as the sorted array of item values.
    this._state[field] = this._ordered[field].map(e => e.item);
  }

  /**
   * Rebuild materialized text for fields folded since the last render tick.
   * Called at every point where state becomes observable (before _render), so
   * observers never see a stale string; between ticks the fold path only marks
   * fields dirty, which is what makes N-op replays cost one rebuild.
   */
  _flushDirtyTextFields() {
    if (this._state == null || this._dirtyTextFields.size === 0) return;
    for (const field of this._dirtyTextFields) {
      this._rematerializeTextField(field);
    }
    this._dirtyTextFields.clear();
  }

  /** Materialize one field's folded text state into public view. */
  _rematerializeTextField(field) {
    this._state[field] = materializeText(this._textStates[field]);
  }

  _installTextReducers(reducers) {
    for (const reducer of reducers ?? []) {
      if (reducer?.entity !== this._entity || String(reducer.id) !== String(this._id)
        || reducer.reducer !== 'workbench.text' || reducer.version !== 1) continue;
      // A reinstalled checkpoint replaces the fold state wholesale; drop any
      // pending rematerialization so the stale mark can't overwrite the
      // snapshot's authoritative value for this field.
      this._dirtyTextFields.delete(reducer.field);
      this._textStates[reducer.field] = restoreTextCheckpoint(reducer.checkpoint);
      this._observeTextReducer({
        entity: this._entity, id: this._id, field: reducer.field,
        epoch: JSON.stringify(reducer.checkpoint), state: this._textStates[reducer.field],
      });
    }
    return this._textReducerReady;
  }

  _observeTextReducer(observation) {
    if (!this._onTextReducer) return this._textReducerReady;
    // Persistence determines safe next counters, so observations must run in
    // delivery order and hold readiness until their durable transaction commits.
    this._textReducerReady = this._textReducerReady.then(() => this._onTextReducer(observation));
    return this._textReducerReady;
  }

  /** Call every registered onRender callback with the current state. */
  _render() {
    for (const cb of this._renderCallbacks) {
      try { cb(this.state); } catch { /* swallow render errors */ }
    }
  }
}

// ---------------------------------------------------------------------------
// createLiveStore — client SDK store: LiveList cache + optimistic dispatch + overlays.
// ---------------------------------------------------------------------------

/**
 * Shared HTTP response decoder.
 * The HTTP status is authoritative. Bodies are values on success, even when an
 * entity happens to contain an `ok` field of its own.
 */
const FAILURE_CATEGORIES = new Set([
  'invalid-input',
  'denied',
  'unknown-action',
  'not-found',
  'conflict',
  'internal',
]);

function isJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  const valid = (isArray ? value : Object.values(value))
    .every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function isJsonRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && isJsonValue(value);
}

function isWorkbenchFailure(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && FAILURE_CATEGORIES.has(value.category)
    && typeof value.message === 'string'
    && value.message.length > 0
    && (value.details === undefined || isJsonRecord(value.details)),
  );
}

function clientFailure(category, message, details) {
  return { category, message, ...(details === undefined ? {} : { details }) };
}

function normalizeFailure(value) {
  if (isWorkbenchFailure(value)) return value;
  const raw = value?.message ?? value?.error ?? value;
  const message = typeof raw === 'string'
    ? raw
    : raw && typeof raw === 'object' && typeof raw.message === 'string'
      ? raw.message
      : String(raw);
  return clientFailure('internal', message);
}

export async function decodeResult(res) {
  if (res.status === 204) {
    return { ok: true, httpStatus: 204, value: undefined };
  }
  if (!res.ok) {
    let body;
    try {
      body = typeof res.json === 'function' ? await res.json() : null;
    } catch {
      body = null;
    }
    if (body?.ok === false && isWorkbenchFailure(body.failure)) {
      return { ok: false, httpStatus: res.status, failure: body.failure };
    }
    return { ok: false, httpStatus: res.status, error: 'http ' + res.status };
  }
  return { ok: true, httpStatus: res.status, value: await res.json() };
}

function replicaUnavailable() {
  return {
    reserve: async () => { throw new Error('durable replica storage is unavailable'); },
    reconcile: async () => { throw new Error('durable replica storage is unavailable'); },
  };
}

function randomReplicaActor() {
  const bytes = new Uint8Array(16);
  if (!globalThis.crypto?.getRandomValues) throw new Error('secure random replica identity is unavailable');
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function replicaActionId(document, actor, counter) {
  // Server receipts are scoped to a row, while counters are scoped to a field.
  // Encode the document identity so first edits to sibling text fields cannot dedupe.
  return `text:${encodeURIComponent(document)}:${actor}:${counter}`;
}

// Browser default. A reservation atomically writes both its clock high-water
// and the exact request that owns that counter, so a retry cannot invent a
// causally different operation after an interrupted delivery.
export function createIndexedDbReplicaState({ indexedDB = globalThis.indexedDB, database = 'workbench-text-replicas' } = {}) {
  if (!indexedDB) return replicaUnavailable();
  let opened;
  const open = () => {
    if (opened) return opened;
    opened = new Promise((resolve, reject) => {
      const request = indexedDB.open(database, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('unable to open durable replica storage'));
    });
    return opened;
  };
  const transaction = async (mode, keys, change) => new Promise(async (resolve, reject) => {
    let tx;
    try { tx = (await open()).transaction('state', mode); } catch (error) { reject(error); return; }
    const store = tx.objectStore('state');
    const requests = (Array.isArray(keys) ? keys : [keys]).map((key) => store.get(key));
    for (const read of requests) read.onerror = () => reject(read.error);
    let remaining = requests.length;
    const results = [];
    for (const [index, read] of requests.entries()) read.onsuccess = () => {
      results[index] = read.result;
      if (--remaining !== 0) return;
      try { change(results, store); } catch (error) { tx.abort(); reject(error); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('durable replica transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('durable replica transaction aborted'));
  });
  return {
    async reserve(document, generate) {
      let record;
      await transaction('readwrite', [document, '@identity'], ([stored, identity], store) => {
        const actor = identity?.actor ?? randomReplicaActor();
        const state = stored ?? { actor, counter: 0, lamport: 0, frontier: [], epoch: null, outbox: [] };
        const counter = state.counter + 1;
        const lamport = Math.max(state.lamport, ...state.frontier.map(([, value]) => value), 0) + 1;
        // Generate before any durable mutation so known-invalid edits consume no counter.
        const operation = generate({ actor: state.actor, counter, lamport, frontier: state.frontier, epoch: state.epoch });
        record = { operation, actionId: replicaActionId(document, state.actor, counter), counter, replica: state.actor,
          body: JSON.stringify({ operation }), status: 'pending', failure: null };
        store.put({ actor }, '@identity');
        store.put({ ...state, counter, lamport, outbox: [...(state.outbox ?? []), record] }, document);
      });
      return { ...record };
    },
    async head(document) {
      let head = null;
      await transaction('readonly', document, ([state]) => { head = state?.outbox?.[0] ?? null; });
      return head;
    },
    async commit(document, counter) {
      await transaction('readwrite', document, ([state], store) => {
        if (!state?.outbox?.length || state.outbox[0].counter !== counter) throw new Error('text outbox head changed');
        store.put({ ...state, outbox: state.outbox.slice(1) }, document);
      });
    },
    async block(document, counter, failure) {
      await transaction('readwrite', document, ([state], store) => {
        if (!state?.outbox?.length || state.outbox[0].counter !== counter) throw new Error('text outbox head changed');
        const [head, ...tail] = state.outbox;
        store.put({ ...state, outbox: [{ ...head, status: 'blocked', failure }, ...tail] }, document);
      });
    },
    async reconcile(document, observation) {
      let outbox = [];
      await transaction('readwrite', [document, '@identity'], ([stored, identity], store) => {
        const actor = identity?.actor ?? randomReplicaActor();
        const state = stored ?? { actor, counter: 0, lamport: 0, frontier: [], epoch: null, outbox: [] };
        // A changed checkpoint is a conservative document epoch boundary.
        const epochChanged = observation.epoch !== undefined && state.epoch !== null && state.epoch !== observation.epoch;
        const frontier = epochChanged ? observation.frontier : mergeReplicaFrontiers(state.frontier, observation.frontier);
        const ownObservedCounter = frontier.find(([actor]) => actor === state.actor)?.[1] ?? 0;
        store.put({ actor }, '@identity');
        store.put({ ...state, counter: Math.max(state.counter, ownObservedCounter), frontier,
          epoch: observation.epoch === undefined ? state.epoch : observation.epoch,
          lamport: Math.max(state.lamport, observation.lamport ?? 0) }, document);
        outbox = [...(state.outbox ?? [])];
      });
      return outbox;
    },
  };
}

function mergeReplicaFrontiers(left, right) {
  const values = new Map(left);
  for (const [actor, counter] of right ?? []) values.set(actor, Math.max(values.get(actor) ?? 0, counter));
  return [...values].sort(([leftActor], [rightActor]) => leftActor.localeCompare(rightActor));
}

/**
 * Create a live store for one entity type.
 *
 * Options:
 *   baseUrl     – server origin (e.g. 'http://127.0.0.1:5432')
 *   name        – entity name (e.g. 'Doc')
 *   path        – CRUD mount path (e.g. '/docs')
 *   channel     – LiveChannel instance (optional, defaults to new LiveChannel(baseUrl))
 *   fetchImpl   – fetch function (optional, defaults to globalThis.fetch)
 *
 * Returns a store object with: subscribe, dispatch, create, update, remove,
 * action, close, overlayFor, overlayStatusFor, pendingCreates, onRender.
 */
export function createLiveStore({ baseUrl, name, path, channel, fetchImpl, replicaState, sendMutation }) {
  const resolvedChannel = channel ?? new LiveChannel(baseUrl);
  const resolvedFetch = fetchImpl ?? globalThis.fetch;
  const resolvedReplicaState = replicaState ?? createIndexedDbReplicaState();

  let _opIdCounter = 0;
  const _listCache = new Map();     // id → LiveList
  const _listOptions = new Map();   // id → serialized subscribe options
  const _overlay = new Map();       // opId → overlay entry
  const _renderCallbacks = new Set();
  const _listUnsubs = new Map();    // id → LiveList.onRender unsub
  const _actionRoutes = new Map();  // actionType → { method, path }
  const _textSendChains = new Map(); // document → serialized head delivery
  const _textAllocationChains = new Map(); // document → serialized durable reservation and draft update
  const _textDraftStates = new Map(); // document → checkpoint plus locally reserved operations
  let _closed = false;

  async function _reserveTextOperation(id, field, generate) {
    const document = `${name}\0${id}\0${field}`;
    const reservation = await resolvedReplicaState.reserve(document, generate);
    if (!reservation?.operation || !reservation.actionId || !Number.isSafeInteger(reservation.counter)) {
      throw new Error('durable replica state must persist text operation outbox records');
    }
    return { document, record: reservation };
  }

  function _serializeTextAllocation(document, work) {
    const previous = _textAllocationChains.get(document) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    _textAllocationChains.set(document, current);
    current.finally(() => {
      if (_textAllocationChains.get(document) === current) _textAllocationChains.delete(document);
    }).catch(() => {});
    return current;
  }

  function _textResult(status, record, extra = {}) {
    return { ok: status === 'committed', status, opId: record.actionId, actionId: record.actionId, ...extra };
  }

  async function _sendTextHead(document, id, field, expectedCounter) {
    const record = await resolvedReplicaState.head(document);
    if (!record) return { ok: false, status: 'failed-rolled-back', opId: null, failure: clientFailure('not-found', 'text outbox is empty') };
    if (record.status === 'blocked') return _textResult('blocked', record, { failure: record.failure });
    if (record.counter !== expectedCounter) return _textResult('queued', record, { waitingFor: record.actionId });
    try {
      const res = await resolvedFetch(`${baseUrl}${path}/${id}/${field}/apply`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-workbench-action-id': record.actionId },
        // `body` is persisted alongside the operation; retries send these exact bytes.
        body: record.body,
      });
      const decoded = await decodeResult(res);
      if (!decoded.ok) {
        if (decoded.failure) {
          await resolvedReplicaState.block(document, record.counter, decoded.failure);
          return _textResult('blocked', record, { failure: decoded.failure });
        }
        return _textResult('outcome-unknown', record, { deliveryError: { message: decoded.error } });
      }
      await resolvedReplicaState.commit(document, record.counter);
      return _textResult('committed', record, { row: decoded.value });
    } catch (error) {
      return _textResult('outcome-unknown', record, { deliveryError: { message: error?.message ?? String(error) } });
    }
  }

  function _serializeTextSend(document, send) {
    const prior = _textSendChains.get(document) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(send);
    _textSendChains.set(document, next);
    return next.finally(() => { if (_textSendChains.get(document) === next) _textSendChains.delete(document); });
  }

  function _nextOpId() {
    return 'op_' + (++_opIdCounter);
  }

  function _snapshotUrl(entity, id) {
    return `${baseUrl}/snapshot/${entity}/${id}`;
  }

  function _eventsSinceUrl(entity, id, cursor) {
    return `${baseUrl}/events-since/${entity}/${id}?cursor=${cursor}`;
  }

  // --- Overlay helpers ---

  function _clearConfirmedOverlays(id) {
    const list = _listCache.get(id);
    if (!list) return;

    for (const [opId, entry] of _overlay) {
      if (entry.id !== id || entry.status !== 'confirmed') continue;
      if (entry.confirmedSeq != null && list.cursor >= entry.confirmedSeq) {
        _overlay.delete(opId);
      }
    }
  }

  function _responseHeader(res, name) {
    return res?.headers?.get?.(name) ?? null;
  }

  function _confirmedSeq(res) {
    const value = _responseHeader(res, 'x-workbench-seq');
    if (value == null || value === '') return null;
    const seq = Number(value);
    return Number.isFinite(seq) ? seq : null;
  }

  function _storeRender() {
    for (const cb of _renderCallbacks) {
      try { cb(); } catch { /* swallow */ }
    }
  }

  /**
   * Direct transport for a serialized CRUD mutation: one fetch, the response
   * (or its absence) is the whole outcome. Settlement and completion are the
   * same promise — there is nothing durable to complete later.
   *
   * Outcome shapes:
   *   { status:'committed', row, seq }        — commit seq evidence included
   *   { status:'rejected', failure }          — the server answered No
   *   { status:'outcome-unknown', deliveryError } — transmitted, result lost
   */
  function directMutationSend({ method, url, body }) {
    const run = async () => {
      const fetchOpts = { method, credentials: 'include' };
      if (body !== undefined) {
        fetchOpts.headers = { 'Content-Type': 'application/json' };
        fetchOpts.body = body;
      }
      try {
        const res = await resolvedFetch(url, fetchOpts);
        const decoded = await decodeResult(res);
        if (decoded.ok) {
          const row = res.status === 204 ? undefined : decoded.value;
          return { status: 'committed', row, seq: _confirmedSeq(res) };
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
  }

  // --- Subscribe ---

  function _subscribeLiveList(id, options = {}) {
    if (_closed) throw new Error('store is closed');
    if (_listCache.has(id)) {
      const prev = _listOptions.get(id);
      const cur = JSON.stringify({ fields: options.fields ?? null, pace: options.pace ?? null });
      if (prev !== cur) {
        throw new Error(`conflicting subscribe options for ${id}: already subscribed with different interest`);
      }
      return _listCache.get(id);
    }

    const list = new LiveList({
      entity: name,
      id,
      channel: resolvedChannel,
      fetchImpl: resolvedFetch,
      snapshotUrl: _snapshotUrl,
      eventsSinceUrl: _eventsSinceUrl,
      fields: options.fields,
      pace: options.pace,
      onTextReducer: ({ entity, id: reducerId, field, epoch, state }) => {
        const document = `${entity}\0${reducerId}\0${field}`;
        const lamport = Math.max(0, ...Object.values(state.elements).map((element) => element.lamport));
        return _serializeTextAllocation(document, async () => {
          const outbox = await resolvedReplicaState.reconcile(document, { epoch, frontier: state.frontier, lamport });
          let draft = state;
          for (const record of outbox.sort((left, right) => left.counter - right.counter)) {
            draft = applyTextOp(draft, record.operation);
          }
          _textDraftStates.set(document, draft);
        });
      },
    });

    _listCache.set(id, list);
    _listOptions.set(id, JSON.stringify({ fields: options.fields ?? null, pace: options.pace ?? null }));

    // Subscribe to LiveList onRender for overlay clearing + store render propagation
    const unsub = list.onRender(() => {
      _clearConfirmedOverlays(id);
      _storeRender();
    });
    _listUnsubs.set(id, unsub);

    // Boot strap (do not await — caller may await list.ready)
    list.subscribe().catch(() => {});

    return list;
  }

  // --- Overlay queries ---

  function overlayFor(id) {
    // Find the most recent (insertion-order) non-failed overlay for this id
    let entry = null;
    for (const e of _overlay.values()) {
      if (e.status === 'failed') continue;
      if (e.id === id) entry = e;
    }

    if (!entry) {
      const list = _listCache.get(id);
      return list ? list.state : null;
    }

    if (entry.kind === 'remove') return null;
    // Return authoritative row if confirmed, else optimistic guess
    return entry.row ?? entry.optimistic;
  }

  function overlayStatusFor(id) {
    let entry = null;
    for (const e of _overlay.values()) {
      if (e.status === 'failed') continue;
      if (e.id === id) entry = e;
    }
    if (!entry) return null;
    return { status: entry.status, kind: entry.kind, error: entry.error ?? null, opId: entry.opId };
  }

  function pendingCreates() {
    const result = [];
    for (const entry of _overlay.values()) {
      if (entry.kind === 'create' && entry.status === 'pending') {
        result.push(entry);
      }
    }
    return result;
  }

  // --- Dispatch (optimistic CRUD) ---

  async function dispatch(type, payload) {
    const opId = _nextOpId();

    // dispatch NEVER throws. Failures before transmission are known rollbacks;
    // a lost response after fetch starts has an unknown server outcome.
    if (_closed) {
      return {
        ok: false,
        status: 'failed-rolled-back',
        opId,
        failure: clientFailure('conflict', 'Store is closed.'),
      };
    }

    let kind, id;
    if (type.endsWith('.apply') && type.startsWith(`${name}.`)) {
      const fieldName = type.slice(name.length + 1, -'.apply'.length);
      if (!fieldName || typeof payload?.id !== 'string' || !Object.hasOwn(payload, 'operation')) {
        return { ok: false, status: 'failed-rolled-back', opId, failure: clientFailure('invalid-input', 'text operation requires { id, operation }') };
      }
      let requestAttempted = false;
      let body;
      try {
        body = JSON.stringify({ operation: payload.operation });
        requestAttempted = true;
        const res = await resolvedFetch(`${baseUrl}${path}/${payload.id}/${fieldName}/apply`, {
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
    } else if (type === `${name}.create`) {
      kind = 'create';
    } else if (type === `${name}.update`) {
      kind = 'update';
      id = payload.id;
    } else if (type === `${name}.remove`) {
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
    const preimage = id ? overlayFor(id) : null;

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
    _overlay.set(opId, entry);
    _storeRender();

    // Serialize the exact request bytes once. A durable outbox resends these
    // same bytes with the same actionId, so a lost response can never fork
    // the outcome into two server-side mutations.
    let method, url, body;
    if (kind === 'create') {
      method = 'POST';
      url = `${baseUrl}${path}`;
    } else if (kind === 'update') {
      method = 'PATCH';
      url = `${baseUrl}${path}/${id}`;
    } else {
      method = 'DELETE';
      url = `${baseUrl}${path}/${id}`;
    }
    if (kind !== 'remove') {
      try {
        body = JSON.stringify(payload);
      } catch (err) {
        // Never transmitted — a known rollback, not an uncertain server write.
        _overlay.delete(opId);
        _storeRender();
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
      sender = sendMutation
        ? sendMutation({ entity: name, opId, kind, id, payload, method, url, body })
        : directMutationSend({ method, url, body });
    } catch (err) {
      // The transport refused before any transmission — a known rollback.
      _overlay.delete(opId);
      _storeRender();
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
      _overlay.delete(opId);
      _storeRender();
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
      if (kind === 'create') {
        _overlay.delete(opId);
      } else {
        // The fold may already have caught up (the delta can beat the
        // response) — resolve the confirmed overlay now, not on the next
        // list render.
        _clearConfirmedOverlays(entry.id);
      }
      _storeRender();
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
      _overlay.delete(opId);
      _storeRender();
      return {
        ok: false,
        status: 'failed-rolled-back',
        opId,
        failure: first.failure,
      };
    }

    if (first.status === 'outcome-unknown') {
      _overlay.delete(opId);
      _storeRender();
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
      if (_closed) return;
      if (final.status === 'committed' && entry.status === 'pending') {
        entry.status = 'confirmed';
        entry.id = final.row?.id ?? entry.id;
        entry.row = final.row ?? null;
        entry.confirmedSeq = final.seq ?? null;
        if (kind === 'create') {
          _overlay.delete(opId);
        } else {
          _clearConfirmedOverlays(entry.id);
        }
        _storeRender();
      } else if (final.status === 'rejected') {
        _overlay.delete(opId);
        _storeRender();
      }
    }).catch(() => {});

    return {
      ok: false,
      status: 'queued',
      opId,
      actionId: first.actionId,
    };
  }

  function text(id, field) {
    const generate = async (build) => {
      if (_closed) throw new Error('store is closed');
      const list = _listCache.get(id);
      if (!list) throw new Error('text field is not ready; subscribe and await list.ready first');
      await list.textReducerReady;
      const checkpoint = list.textState(field);
      if (!checkpoint) throw new Error('text field is not ready; subscribe and await list.ready first');
      const document = `${name}\0${id}\0${field}`;
      const { record } = await _serializeTextAllocation(document, async () => {
        const state = _textDraftStates.get(document) ?? checkpoint;
        const reservation = await _reserveTextOperation(id, field, (identity) => build({ state, ...identity }));
        // Preserve causal generation while an earlier durable operation awaits delivery.
        _textDraftStates.set(document, applyTextOp(state, reservation.record.operation));
        return reservation;
      });
      return _serializeTextSend(document, () => _sendTextHead(document, id, field, record.counter));
    };
    return {
      insert: ({ at, text: inserted }) => generate(({ state, ...identity }) => insertText(state, identity, at, inserted)),
      delete: ({ start, end }) => generate(({ state, ...identity }) => deleteText(state, identity, start, end)),
    };
  }

  async function retryText(id, field) {
    const document = `${name}\0${id}\0${field}`;
    return _serializeTextSend(document, async () => {
      const head = await resolvedReplicaState.head(document);
      if (!head) return { ok: false, status: 'failed-rolled-back', opId: null, failure: clientFailure('not-found', 'text outbox is empty') };
      if (head.status === 'blocked') return _textResult('blocked', head, { failure: head.failure });
      return _sendTextHead(document, id, field, head.counter);
    });
  }

  // --- Action route registry ---

  function action(actionType, { method, path: actionPath }) {
    _actionRoutes.set(actionType, { method, path: actionPath });

    // Return a helper function the caller can invoke
    const fn = async (body) => {
      const opId = _nextOpId();
      const route = _actionRoutes.get(actionType);
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
        const res = await resolvedFetch(`${baseUrl}${route.path}`, opts);
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
    store[actionType] = fn;
    return fn;
  }

  // --- Close ---

  function close() {
    if (_closed) return;
    _closed = true;

    for (const unsub of _listUnsubs.values()) {
      unsub();
    }
    for (const list of _listCache.values()) {
      list.close().catch(() => {});
    }
    resolvedChannel.close();

    _listCache.clear();
    _listOptions.clear();
    _listUnsubs.clear();
    _overlay.clear();
    _renderCallbacks.clear();
  }

  // --- Store object ---

  const store = {
    subscribe: _subscribeLiveList,
    dispatch,
    create(payload) { return dispatch(`${name}.create`, payload); },
    update(id, payload) { return dispatch(`${name}.update`, { id, ...payload }); },
    remove(id) { return dispatch(`${name}.remove`, { id }); },
    apply(id, field, operation) { return dispatch(`${name}.${field}.apply`, { id, operation }); },
    text,
    retryText,
    action,
    close,
    overlayFor,
    overlayStatusFor,
    pendingCreates,
    onRender(cb) {
      _renderCallbacks.add(cb);
      return () => _renderCallbacks.delete(cb);
    },
  };

  return store;
}

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
const SNAPSHOT_PATCH_CAPABILITY = 'snapshot-patch/v1';

export function createLiveDeliverySession({
  bootstrap,
  subscribe,
  validateSnapshot,
  fold: configuredFold,
  optimistic = (snapshot) => snapshot,
  sendAction,
  sendBatch,
  createActionId,
  onRecoveryStart,
  onRecoveryDelayed,
  recoveryWarningDelayMs = 5000,
  isFoldableEcho = () => false,
}) {
  if (typeof bootstrap !== 'function') throw new TypeError('bootstrap is required');
  if (typeof subscribe !== 'function') throw new TypeError('subscribe is required');
  if (typeof validateSnapshot !== 'function') throw new TypeError('validateSnapshot is required');
  if (configuredFold !== undefined && typeof configuredFold !== 'function') throw new TypeError('fold must be a function');
  if (typeof sendAction !== 'function') throw new TypeError('sendAction is required');
  if (sendBatch !== undefined && typeof sendBatch !== 'function') throw new TypeError('sendBatch must be a function');

  let baseSnapshot = null;
  let visibleSnapshot = null;
  let cursor = 0;
  // Opaque projection-token ledger handle (#122): minted by a patch-capable
  // bootstrap, rotated by every accepted snapshot-patch; presented on
  // catch-up so removals stay provable.
  let projectionToken = null;
  // Response-gated capability (#122 §12): false until a bootstrap result
  // advertises snapshot-patch back. Legacy servers (no echo) keep the exact
  // legacy path — advertised capabilities are additive and ignorable.
  let deltaCapable = false;
  let status = 'bootstrapping';
  let closed = false;
  let initialized = false;
  let reconnecting = false;
  let reconnectRequested = false;
  let connectionGeneration = 0;
  let recoveryGeneration = 0;
  let snapshotGeneration = 0;
  let receiptGeneration = 0;
  let subscription = null;
  let actionCounter = 0;
  const snapshotOnly = configuredFold === undefined;
  const fold = configuredFold ?? ((snapshot) => snapshot);
  // How long a foldable operation waits for its SSE fold echo before falling
  // back to receipt-driven snapshot recovery. The echo lands just after the
  // sender receipt, so without this grace the receipt wins and every keystroke
  // forces a full document bootstrap. See recoverFoldableAfterGrace.
  const FOLD_ECHO_GRACE_MS = 200;
  let deliveryChain = Promise.resolve();
  // Snapshot recovery is one coalesced package-owned operation.  In
  // particular, an opaque resync must wait for every transmitted operation
  // whose outcome is still unknown; otherwise its replacement snapshot can
  // be projected over an action which may still commit.
  // Rev 3: one shared finite budget per logical recovery cycle. Every
  // bootstrap({mode:'snapshot'}) inside that cycle consumes one attempt,
  // including server retry, receipt-fence, floor-coverage, and follow-up
  // kicks. A control that lands while a cycle is already running raises its
  // floor instead of minting a new budget; a control with no cycle running
  // starts one (round 4: every control's recovery is captured and awaited —
  // see receive()).
  const MAX_SNAPSHOT_BOOTSTRAPS_PER_CYCLE = 4;
  let snapshotRecoveryFloor = null;
  let snapshotRecoveryRequested = false;
  let snapshotRecoveryRunning = false;
  let snapshotRecoveryWaiters = [];
  let snapshotRecoveryCycle = null;
  let snapshotRecoveryCycleSeq = 0;
  // Delta-mode control recovery (#159): in delta mode an ordinary transport
  // `resync` control re-establishes state by CATCH-UP (pulling journal
  // patches from the held cursor+token) rather than a full snapshot bootstrap.
  // `state-invalidate` is NOT catch-up-able (it is the bounded-overflow
  // boundary whose replacement is inherently a full snapshot) and stays on
  // the snapshot path. Catch-up carries no receipt fences or attempt budget —
  // it is cheap and idempotent from the held cursor — so the machinery is a
  // minimal coalescer, not a copy of the snapshot cycle.
  let catchupRecoveryRequested = false;
  let catchupRecoveryRunning = false;
  let catchupRecoveryWaiters = [];
  let catchupRecoveryCycle = null;
  let catchupRecoveryCycleSeq = 0;
  const listeners = new Set();
  const { operations, makeOperation, shouldReconcile, count } = createOpLifecycle();
  const recoveryRetryWaiters = new Set();
  const admissionWaiters = [];
  let recoveryWarningTimer = null;
  let recoveryWarningActive = false;

  function finishRecoveryWarning() {
    if (recoveryWarningTimer !== null) {
      clearTimeout(recoveryWarningTimer);
      recoveryWarningTimer = null;
    }
    if (recoveryWarningActive) {
      recoveryWarningActive = false;
      try { onRecoveryDelayed?.(false); } catch { /* isolate consumers */ }
    }
  }

  function startRecoveryWarning() {
    if (recoveryWarningTimer !== null || recoveryWarningActive) return;
    recoveryWarningTimer = setTimeout(() => {
      recoveryWarningTimer = null;
      if (closed || status === 'revoked' || status === 'unavailable') return;
      recoveryWarningActive = true;
      try { onRecoveryDelayed?.(true); } catch { /* isolate consumers */ }
    }, recoveryWarningDelayMs);
  }

  function admit(operation) {
    if (closed || status === 'revoked' || status === 'unavailable') return Promise.resolve(false);
    if (initialized && status === 'live' && !reconnecting) return Promise.resolve(true);
    return new Promise((resolve) => {
      admissionWaiters.push({ operation, resolve });
    });
  }

  function settleAdmissions(available) {
    if (!available) {
      for (const waiter of admissionWaiters.splice(0)) waiter.resolve(false);
      return;
    }
    for (const waiter of admissionWaiters.splice(0)) waiter.resolve(true);
  }

  function terminalStatus() {
    return closed ? 'closed' : status === 'revoked' ? 'revoked' : 'unavailable';
  }

  function canTransmit(operation) {
    return initialized
      && !closed
      && status === 'live'
      && !reconnecting
      && operations.get(operation.actionId) === operation;
  }

  function waitForRecoveryRetry(attempt) {
    const delay = backoffDelay(attempt, 50, 1000);
    return new Promise((resolve) => {
      const waiter = { timeout: null, resolve };
      waiter.timeout = setTimeout(() => {
        recoveryRetryWaiters.delete(waiter);
        resolve(true);
      }, delay);
      recoveryRetryWaiters.add(waiter);
    });
  }

  function cancelRecoveryRetries() {
    for (const waiter of recoveryRetryWaiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(false);
    }
    recoveryRetryWaiters.clear();
  }

  function createSettlement(operation) {
    const waiters = new Set();
    operation.settlement = Object.freeze({
      opId: operation.opId,
      wait({ signal } = {}) {
        if (operation.settlementOutcome) return Promise.resolve(operation.settlementOutcome);
        if (signal?.aborted) return Promise.resolve({ opId: operation.opId, status: 'cancelled' });
        return new Promise((resolve) => {
          const waiter = { resolve, signal, cancel: null };
          const cancel = () => {
            waiters.delete(waiter);
            signal.removeEventListener('abort', cancel);
            resolve({ opId: operation.opId, status: 'cancelled' });
          };
          waiter.cancel = cancel;
          if (signal) signal.addEventListener('abort', cancel, { once: true });
          waiters.add(waiter);
        });
      },
    });
    operation.resolveSettlement = (outcome) => {
      if (operation.settlementOutcome) return;
      operation.settlementOutcome = Object.freeze({ opId: operation.opId, ...outcome });
      for (const waiter of waiters) {
        if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.cancel);
        waiter.resolve(operation.settlementOutcome);
      }
      waiters.clear();
    };
    return operation.settlement;
  }

  function settleOperation(operation, outcome) {
    operation.resolveSettlement?.(outcome);
  }

  function nextActionId() {
    if (createActionId) return createActionId();
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `delivery_op_${++actionCounter}`;
  }

  function freezeClone(value) {
    if (!value || typeof value !== 'object') return value;
    for (const child of Object.values(value)) freezeClone(child);
    return Object.freeze(value);
  }

  function publish() {
    if (closed || baseSnapshot === null) return;
    let projected = baseSnapshot;
    for (const operation of operations.values()) {
      // A fold echo already splices the op into the base. Re-applying the
      // pending optimistic reducer on top of that echo doubles the edit until
      // the sender receipt deletes the operation, and any queued successor
      // captured against the single application then fail-closes as stale.
      if (operation.status === 'pending' && operation.echoCursor == null) {
        for (const action of operation.actions ?? [operation.action]) projected = optimistic(projected, action);
      }
      // Application callbacks may synchronously trigger terminal revocation.
      // Never publish a projection that was computed before that transition.
      if (closed || status === 'revoked' || baseSnapshot === null) return;
    }
    visibleSnapshot = projected;
    for (const listener of listeners) {
      try { listener(visibleSnapshot); } catch { /* isolate consumers */ }
    }
  }

  function hasUnknownTransmission() {
    if (!snapshotOnly) return false;
    for (const operation of operations.values()) {
      if (operation.transmitted && operation.outcome === 'unknown') return true;
    }
    return false;
  }

  function cancelSnapshotRecovery(error = new ClientClosedError('Live delivery is unavailable')) {
    snapshotRecoveryRequested = false;
    snapshotRecoveryFloor = null;
    snapshotRecoveryCycle = null;
    for (const waiter of snapshotRecoveryWaiters.splice(0)) waiter.reject(error);
  }

  function beginSnapshotRecoveryCycle(floor) {
    snapshotRecoveryCycle = {
      id: ++snapshotRecoveryCycleSeq,
      attempts: 0,
      floor: floor ?? null,
      receiptFloor: floor ?? null,
      followupRequested: false,
      connectionGeneration,
    };
    return snapshotRecoveryCycle;
  }

  function raiseSnapshotCycleFloor(floor) {
    if (floor == null || !snapshotRecoveryCycle) return;
    snapshotRecoveryCycle.floor = snapshotRecoveryCycle.floor == null
      ? floor
      : Math.max(snapshotRecoveryCycle.floor, floor);
  }

  function requestSnapshotRecovery(floor, wait = !hasUnknownTransmission(), inline = false) {
    if (closed || status === 'revoked' || status === 'unavailable') {
      const error = new ClientClosedError('Live delivery is unavailable');
      return wait ? Promise.reject(error) : Promise.resolve();
    }
    if (!snapshotRecoveryCycle || snapshotRecoveryCycle.connectionGeneration !== connectionGeneration) {
      beginSnapshotRecoveryCycle(floor);
    } else {
      raiseSnapshotCycleFloor(floor);
      if (floor != null) {
        snapshotRecoveryCycle.receiptFloor = snapshotRecoveryCycle.receiptFloor == null
          ? floor
          : Math.max(snapshotRecoveryCycle.receiptFloor, floor);
      }
      if (snapshotRecoveryRunning) snapshotRecoveryCycle.followupRequested = true;
    }
    snapshotRecoveryRequested = true;
    if (floor != null) {
      snapshotRecoveryFloor = snapshotRecoveryFloor == null
        ? floor
        : Math.max(snapshotRecoveryFloor, floor);
    }
    const promise = wait
      ? new Promise((resolve, reject) => snapshotRecoveryWaiters.push({ resolve, reject }))
      : Promise.resolve();
    kickSnapshotRecovery(inline);
    return promise;
  }

  function kickSnapshotRecovery(inline = false) {
    if (!snapshotRecoveryRequested || snapshotRecoveryRunning || closed || status === 'revoked' || status === 'unavailable') return;
    if (hasUnknownTransmission()) return;
    if (snapshotRecoveryCycle && snapshotRecoveryCycle.attempts >= MAX_SNAPSHOT_BOOTSTRAPS_PER_CYCLE) {
      snapshotRecoveryRequested = false;
      const error = new Error('snapshot recovery attempt budget exhausted');
      becomeUnavailable(error);
      return;
    }
    snapshotRecoveryRunning = true;
    const cycle = snapshotRecoveryCycle;
    const receiptFloor = cycle?.receiptFloor ?? snapshotRecoveryFloor;
    snapshotRecoveryFloor = null;
    snapshotRecoveryRequested = false;
    if (cycle) cycle.followupRequested = false;
    const waiters = snapshotRecoveryWaiters.splice(0);
    const snapshotGenerationAtStart = snapshotGeneration;
    const cycleId = cycle?.id;
    const run = async () => {
      try {
        await recover('snapshot', receiptFloor);
        const liveCycle = snapshotRecoveryCycle?.id === cycleId ? snapshotRecoveryCycle : null;
        const latestCoverage = liveCycle?.floor ?? null;
        const latestReceipt = liveCycle?.receiptFloor ?? receiptFloor;
        if (latestReceipt != null && !closed && status !== 'revoked' && status !== 'unavailable'
          && snapshotGeneration === snapshotGenerationAtStart
          && liveCycle) {
          // A reconnect may supersede this request without installing its
          // result. Give the coalesced recovery one fresh attempt before
          // treating an uncovered receipt fence as a terminal failure.
          await recover('snapshot', latestReceipt);
          if (snapshotGeneration === snapshotGenerationAtStart) {
            throw new Error('replacement snapshot did not supersede the receipt');
          }
        }
        if (latestReceipt != null && !closed && status !== 'revoked' && status !== 'unavailable'
          && cursorAnchor(cursor) < latestReceipt
          && snapshotRecoveryCycle?.id === cycleId) {
          await recover('snapshot', latestReceipt);
          if (cursorAnchor(cursor) < latestReceipt) {
            throw new Error('replacement snapshot does not cover the receipt fence');
          }
        }
        if (liveCycle && latestCoverage != null && cursorAnchor(cursor) < latestCoverage) {
          liveCycle.followupRequested = true;
          snapshotRecoveryRequested = true;
        }
        if (snapshotRecoveryCycle?.id === cycleId
          && (latestCoverage == null || cursorAnchor(cursor) >= latestCoverage)
          && !snapshotRecoveryCycle.followupRequested) {
          snapshotRecoveryCycle = null;
        }
        for (const waiter of waiters) waiter.resolve();
      } catch (error) {
        if (!closed && status !== 'revoked') becomeUnavailable(error);
        for (const waiter of waiters) waiter.reject(error);
        throw error;
      } finally {
        snapshotRecoveryRunning = false;
        kickSnapshotRecovery();
      }
    };
    // A delivery callback runs on deliveryChain.  Run its recovery inline so
    // it cannot wait on the chain which is waiting on the callback.  Sender
    // receipts, by contrast, join the chain and serialize with later delivery.
    if (inline) {
      void run().catch(() => {});
    } else {
      const attempt = deliveryChain.catch(() => {}).then(run);
      deliveryChain = attempt.catch(() => {});
    }
  }

  function cancelCatchupRecovery(error = new ClientClosedError('Live delivery is unavailable')) {
    catchupRecoveryRequested = false;
    catchupRecoveryCycle = null;
    for (const waiter of catchupRecoveryWaiters.splice(0)) waiter.reject(error);
  }

  function requestCatchupRecovery(wait = !hasUnknownTransmission(), inline = false) {
    if (closed || status === 'revoked' || status === 'unavailable') {
      const error = new ClientClosedError('Live delivery is unavailable');
      return wait ? Promise.reject(error) : Promise.resolve();
    }
    if (!catchupRecoveryCycle || catchupRecoveryCycle.connectionGeneration !== connectionGeneration) {
      catchupRecoveryCycle = { id: ++catchupRecoveryCycleSeq, connectionGeneration };
    }
    catchupRecoveryRequested = true;
    if (catchupRecoveryRunning) catchupRecoveryCycle.followupRequested = true;
    const promise = wait
      ? new Promise((resolve, reject) => catchupRecoveryWaiters.push({ resolve, reject }))
      : Promise.resolve();
    kickCatchupRecovery(inline);
    return promise;
  }

  function kickCatchupRecovery(inline = false) {
    if (!catchupRecoveryRequested || catchupRecoveryRunning || closed || status === 'revoked' || status === 'unavailable') return;
    if (hasUnknownTransmission()) return;
    catchupRecoveryRunning = true;
    catchupRecoveryRequested = false;
    const cycle = catchupRecoveryCycle;
    if (cycle) cycle.followupRequested = false;
    const waiters = catchupRecoveryWaiters.splice(0);
    const run = async () => {
      try {
        // recover('catchup') pulls journal patches from the held cursor and
        // presents the held token; a patch-apply failure inside it falls back
        // to a full snapshot (the base is untrusted), which this await covers.
        await recover('catchup');
        for (const waiter of waiters) waiter.resolve();
      } catch (error) {
        if (!closed && status !== 'revoked') becomeUnavailable(error);
        for (const waiter of waiters) waiter.reject(error);
        throw error;
      } finally {
        catchupRecoveryRunning = false;
        kickCatchupRecovery();
      }
    };
    if (inline) {
      void run().catch(() => {});
    } else {
      const attempt = deliveryChain.catch(() => {}).then(run);
      deliveryChain = attempt.catch(() => {});
    }
  }

  function assertCursor(value, label) {
    if (Number.isSafeInteger(value) && value >= 0) return;
    if (value && typeof value === 'object'
      && Number.isSafeInteger(value.anchor) && value.anchor >= 0
      && Number.isSafeInteger(value.aggregate) && value.aggregate >= 0
      && Object.keys(value).length === 2) return;
    // snapshot-patch composite cursors (#122): {anchor, composite}.
    if (value && typeof value === 'object'
      && Number.isSafeInteger(value.anchor) && value.anchor >= 0
      && Number.isSafeInteger(value.composite) && value.composite >= 0
      && Object.keys(value).length === 2) return;
    throw new Error(`${label} must be a nonnegative cursor`);
  }

  function cursorAnchor(value) {
    return typeof value === 'object' ? value.anchor : value;
  }

  function sameCursor(left, right) {
    if (typeof left === 'object' && typeof right === 'object'
      && left.composite !== undefined && right.composite !== undefined) {
      return left.anchor === right.anchor && left.composite === right.composite;
    }
    return cursorAnchor(left) === cursorAnchor(right)
      && (typeof left === 'object') === (typeof right === 'object')
      && (typeof left !== 'object' || left.aggregate === right.aggregate);
  }

  // S3/A7 client-ingest contract: only `event` (full-log) and `state` (live
  // replacement) envelopes are authoritative domain mutations. Recovery
  // controls (`resync`, `state-invalidate`) and derived/operational
  // notifications are never authoritative; the client ignores the latter
  // rather than failing the delivery batch (consideration #23). Any other
  // kind is a protocol violation and still rejects the batch.
  const DELIVERY_ENVELOPE_KINDS = new Set(['event', 'state', 'resync', 'state-invalidate', 'notification', 'snapshot-patch']);
  function isKnownEnvelopeKind(envelope) {
    return envelope != null && typeof envelope === 'object'
      && typeof envelope.type === 'string' && DELIVERY_ENVELOPE_KINDS.has(envelope.type);
  }

  function isAuthoritativeEnvelope(envelope) {
    return envelope != null && typeof envelope === 'object'
      && (envelope.type === 'event' || envelope.type === 'state');
  }

  function normalizeAuthoritative(envelope) {
    if (!isAuthoritativeEnvelope(envelope)) throw new Error('delivery batch contains an invalid recipient envelope');
    const span = envelope.seqSpan ?? envelope.seq;
    const [lo, hi] = normalizeSeqSpan(span);
    assertCursor(lo, 'delivery sequence');
    assertCursor(hi, 'delivery sequence');
    if (lo > hi) throw new Error('delivery sequence span is inverted');
    return { envelope, seqSpan: [lo, hi] };
  }

  function applyEvent(envelope) {
    const { seqSpan } = normalizeAuthoritative(envelope);
    // A declared aggregate has no event reducer. Treat an unexpected event as
    // an opaque recovery boundary rather than acknowledging stale state.
    if (snapshotOnly) return { status: 'resync' };
    const decision = decideReplay(cursor, seqSpan);
    if (decision.kind === 'duplicate') return { status: 'duplicate' };
    if (decision.kind === 'gap') return { status: 'gap' };
    // Fold envelopes name the predecessor cursor explicitly. A mismatch means
    // the payload cannot be applied against the client's accepted base.
    if (envelope.fold
      && Number.isSafeInteger(envelope.fold.baseCursor)
      && envelope.fold.baseCursor !== cursorAnchor(cursor)) {
      return { status: 'resync' };
    }

    let nextSnapshot;
    try {
      nextSnapshot = fold(baseSnapshot, envelope);
    } catch {
      // A failed fold must not advance the cursor or acknowledgement fence.
      return { status: 'resync' };
    }
    // A fold callback may synchronously trigger terminal revocation through a
    // host lifecycle reaction. Do not restore state after that fail-closed turn.
    if (closed || status === 'revoked') return { status: 'revoked' };
    baseSnapshot = nextSnapshot;
    cursor = decision.cursor;
    const actionId = envelope.event?.actionId;
    const operation = actionId ? operations.get(actionId) : null;
    if (operation) {
      operation.echoCursor = cursor;
      if (operation.delivered
        && (operation.confirmedCursor == null || cursorAnchor(cursor) >= operation.confirmedCursor)) {
        settleOperation(operation, { status: 'reconciled' });
        operations.delete(actionId);
      }
    }
    publish();
    return { status: operation ? 'confirmed' : 'applied' };
  }

  // An authoritative live `state` replacement is a wholesale snapshot: it is
  // never folded, it replaces the client's cached state, and it reconciles
  // delivered pending operations exactly as a logged event echo does (S3/A7
  // client.d.ts contract). The live revision advances the cursor; the carried
  // `state` (a recipient-projected live row) is validated like any snapshot.
  function applyState(envelope) {
    const { seqSpan } = normalizeAuthoritative(envelope);
    const decision = decideReplay(cursor, seqSpan);
    if (decision.kind === 'duplicate') return { status: 'duplicate' };
    if (decision.kind === 'gap') return { status: 'gap' };
    let nextSnapshot;
    try {
      nextSnapshot = validateSnapshot(envelope.state ?? null, envelope);
    } catch {
      // An unvalidatable replacement must not advance the cursor or fence.
      return { status: 'resync' };
    }
    // A fold callback may synchronously trigger terminal revocation through a
    // host lifecycle reaction. Do not restore state after that fail-closed turn.
    if (closed || status === 'revoked') return { status: 'revoked' };
    baseSnapshot = nextSnapshot;
    cursor = decision.cursor;
    // A whole-state replacement names no per-action echo, so every delivered
    // operation whose confirmed receipt fence the replacement cursor covers is
    // reconciled — the same settlement rule applyEvent uses for an echo.
    for (const [actionId, operation] of operations) {
      if (operation.delivered
        && (operation.confirmedCursor == null || cursorAnchor(cursor) >= operation.confirmedCursor)) {
        settleOperation(operation, { status: 'reconciled' });
        operations.delete(actionId);
      }
    }
    publish();
    return { status: 'applied' };
  }

  // ---- capability negotiation + projectionToken lifecycle (#156 client) ----
  //
  // The session ALWAYS advertises `snapshot-patch/v1` on every
  // bootstrap/catchup/subscribe call — the arguments are additive, so a host
  // that predates #122 simply ignores them (byte-identical legacy behavior).
  // Delta ingestion arms ONLY on a bootstrap RESULT that advertises the
  // protocol back and mints a projectionToken. From then on:
  //   - catch-up carries the token so the server can journal-replay patches;
  //   - any patch envelope whose token does not advance the held one is a
  //     forgery/replay → resync (fail closed);
  //   - a fresh full snapshot re-arms or downgrades cleanly.

  function armDeltaMode(result) {
    const advertised = result?.protocol === SNAPSHOT_PATCH_CAPABILITY
      && typeof result?.projectionToken === 'string' && result.projectionToken.length > 0;
    if (!advertised) {
      deltaCapable = false;
      return;
    }
    deltaCapable = true;
    projectionToken = result.projectionToken;
  }

  function disarmDeltaMode() {
    deltaCapable = false;
    projectionToken = null;
  }

  function applyAuthoritative(envelope) {
    if (envelope?.type === 'snapshot-patch') return applySnapshotPatch(envelope);
    return envelope?.type === 'state' ? applyState(envelope) : applyEvent(envelope);
  }

  // ---- snapshot-patch ingestion (#122, cross-exam step 2) ------------------
  //
  // Strict grammar validation, atomic application to a fresh graph, and
  // cursor decisions per design §9. Any validation or application failure
  // advances NOTHING and reports `resync` so recovery installs a full
  // authorized snapshot — fail closed, never partially patched.

  const SNAPSHOT_PATCH_OPERATIONS = new Set(['replace-fields', 'put-keyed', 'remove-keyed', 'replace-many', 'replace-one', 'replace-value']);

  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      && (value.constructor === undefined || value.constructor === Object);
  }

  function isValidActionIdList(value) {
    return Array.isArray(value) && value.every((id) => typeof id === 'string' && id.length > 0);
  }

  // Full envelope validation (cross-exam FIX 5): every field is checked before
  // anything mutates — projectionToken, actionIds, routedInvisibleActionIds,
  // nonnegative from/to cursors, seqSpan agreement, and exact cursor key sets.
  function validateSnapshotPatchEnvelope(envelope, previous = null) {
    if (!isPlainObject(envelope)) return null;
    if (envelope.type !== 'snapshot-patch' || envelope.protocol !== 'snapshot-patch/v1') return null;
    if (typeof envelope.declaration !== 'string' || envelope.declaration.length === 0) return null;
    if (typeof envelope.projectionToken !== 'string' || envelope.projectionToken.length === 0) return null;
    if (envelope.actionIds !== undefined && !isValidActionIdList(envelope.actionIds)) return null;
    if (envelope.routedInvisibleActionIds !== undefined && !isValidActionIdList(envelope.routedInvisibleActionIds)) return null;
    for (const key of ['from', 'to']) {
      const c = envelope[key];
      // Exact two-key composite cursor: anchor + composite, both nonnegative.
      if (!isPlainObject(c)
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
    if (!isPlainObject(span[0]) || !isPlainObject(span[1])) return null;
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
      if (!isPlainObject(operation) || !SNAPSHOT_PATCH_OPERATIONS.has(operation.op)) return null;
      if (!Array.isArray(operation.path)
        || !operation.path.every((segment) => typeof segment === 'string' && segment.length > 0)) return null;
      switch (operation.op) {
        case 'put-keyed':
          if (typeof operation.id !== 'string' || operation.id.length === 0 || !isPlainObject(operation.value)) return null;
          break;
        case 'remove-keyed':
          if (typeof operation.id !== 'string' || operation.id.length === 0) return null;
          break;
        case 'replace-many':
          if (!Array.isArray(operation.value) || !operation.value.every(isPlainObject)) return null;
          break;
        case 'replace-one':
          if (operation.value !== null && !isPlainObject(operation.value)) return null;
          break;
        case 'replace-fields':
          if (!isPlainObject(operation.value)) return null;
          break;
      }
    }
    return envelope;
  }

  function navigatePatchPath(root, path) {
    let current = root;
    for (const segment of path) {
      current = current?.[segment];
    }
    return current;
  }

  function applyPatchOperation(state, operation) {
    const parent = navigatePatchPath(state, operation.path);
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
        const holder = navigatePatchPath(state, segments);
        holder[last] = operation.value;
        return;
      }
      case 'replace-one':
      case 'replace-value': {
        const segments = [...operation.path];
        const last = segments.pop();
        const holder = navigatePatchPath(state, segments);
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
  }

  function shallowCloneNode(value) {
    return Array.isArray(value) ? value.slice() : { ...value };
  }

  // Copy-on-write spine (#156 round 2): clone ONLY the nodes along each
  // operation's path chain; every other subtree stays shared by reference.
  // Runs for ALL operations BEFORE the first mutation, so the spine is fully
  // private where writers land — keyed/remove/replace-fields parents and
  // replace-many/one/value holders are always spine endpoints or prefixes —
  // and a mid-apply throw simply discards the whole spine, leaving the
  // shared base byte-identical. Walking stops at a missing/primitive segment:
  // nothing below it can be cloned, and apply time throws exactly where the
  // old O(graph) deep clone's navigation did (→ resync, same outcome).
  function buildPatchSpine(base, envelopes) {
    const root = base !== null && typeof base === 'object' ? shallowCloneNode(base) : base;
    for (const checked of envelopes) {
      for (const operation of checked.operations) {
        let current = root;
        for (const segment of operation.path) {
          if (current === null || typeof current !== 'object') break;
          const child = current[segment];
          if (child === null || typeof child !== 'object') break;
          current[segment] = shallowCloneNode(child);
          current = current[segment];
        }
      }
    }
    return root;
  }

  function applySnapshotPatch(envelopeOrBatch, previous = null) {
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
      const checked = validateSnapshotPatchEnvelope(candidate, previousEnvelope);
      if (!checked) return { status: 'resync' };
      if (chainTokens.has(checked.projectionToken)) return { status: 'resync' };
      chainTokens.add(checked.projectionToken);
      valid.push(checked);
      previousEnvelope = checked;
    }
    // Delta ingestion is response-gated (#122 §12): a patch arriving before a
    // bootstrap advertised the capability back is out-of-grammar for this
    // session — recover through a snapshot, never apply.
    if (!deltaCapable) return { status: 'resync' };
    if (!cursor || typeof cursor !== 'object' || cursor.composite === undefined) return { status: 'resync' };
    // Token lifecycle (#156): an accepted patch ROTATES the ledger handle. An
    // envelope presenting (or repeating) the currently held token is a replay
    // or forgery — fail closed through snapshot recovery.
    if (valid.some((checked) => checked.projectionToken === projectionToken)) return { status: 'resync' };
    // 2. Cursor decisions (design §9), evaluated against the CHAIN: the first
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
    if (tail.composite < cursor.composite) {
      return { status: 'resync' };
    }
    if (cursor.anchor !== head.anchor || cursor.composite !== head.composite) {
      // duplicate / stale / gap / incomparable all recover through a snapshot.
      if (cursor.anchor === tail.anchor && cursor.composite === tail.composite) return { status: 'duplicate' };
      return { status: 'resync' };
    }
    // 3-4. Apply EVERY envelope's operations in order to ONE fresh immutable
    // copy; any throw discards it — the base never lands half-patched.
    // Copy-on-write spine (#156 round 2): instead of an O(graph) deep clone,
    // clone only along each operation's path chain and share every other
    // subtree by reference. The spine is built FULLY before the first target
    // mutates, so a mid-way applyPatchOperation throw leaves the shared base
    // untouched and the whole patch resyncs.
    let nextSnapshot;
    try {
      nextSnapshot = buildPatchSpine(baseSnapshot, valid);
      for (const checked of valid) {
        for (const operation of checked.operations) applyPatchOperation(nextSnapshot, operation);
      }
      nextSnapshot = validateSnapshot(nextSnapshot);
    } catch {
      return { status: 'resync' };
    }
    if (closed || status === 'revoked') return { status: 'revoked' };
    // 6. Commit snapshot + cursor + token together (token takes the CHAIN's
    // LAST rotation — the ledger's newest handle). Settlement (7 in §11):
    // only actions the patches ECHO (actionIds), or explicitly mark as
    // routed-invisible, may reconcile optimistic state — never an empty patch
    // alone (cross-exam 6).
    baseSnapshot = nextSnapshot;
    cursor = { anchor: tail.anchor, composite: tail.composite };
    projectionToken = valid[valid.length - 1].projectionToken;
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
    for (const [actionId, operation] of operations) {
      const settleable = echoed.has(actionId) || routedInvisible.has(actionId);
      if (settleable
        && (operation.confirmedCursor == null || cursorAnchor(cursor) >= operation.confirmedCursor)) {
        // Mark the commit proof for the late receipt path: it must take the
        // committed escape (never report a spurious failure) and skip the
        // now-pointless recovery bootstrap. resolveSettlement is idempotent,
        // so a receipt that raced ahead cannot double-settle.
        operation.patchAttributed = true;
        settleOperation(operation, { status: 'reconciled' });
        operations.delete(actionId);
      }
    }
    publish();
    return { status: 'applied' };
  }

  function settleSnapshotConfirmations(receiptGenerationAtStart) {
    // Composite streams and non-foldable annotated-text ops intentionally do
    // not disclose a foldable echo. A positive sender receipt plus an
    // authorized replacement snapshot is the package-owned equivalent of a
    // direct-stream action echo. Fold-mode sessions still use this path when
    // recovery installs a snapshot (split/merge/redacted/gap).
    for (const [actionId, operation] of operations) {
      if (operation.delivered
        && operation.confirmedThrough != null
        && snapshotGeneration > operation.receiptSnapshotGeneration
        && receiptGenerationAtStart >= operation.receiptGeneration
        && cursorAnchor(cursor) >= operation.confirmedThrough) {
        settleOperation(operation, { status: 'reconciled' });
        operations.delete(actionId);
      }
    }
  }

  function becomeUnavailable(error) {
    if (closed || status === 'revoked') return;
    cancelSnapshotRecovery(error instanceof Error ? error : new ClientClosedError('Live delivery is unavailable'));
    cancelCatchupRecovery(error instanceof Error ? error : new ClientClosedError('Live delivery is unavailable'));
    finishRecoveryWarning();
    status = 'unavailable';
    settleAdmissions(false);
    // An opaque aggregate can only be reconciled by its replacement snapshot.
    // Once that recovery fails, no optimistic projection is safe to retain.
    for (const operation of operations.values()) settleOperation(operation, { status: 'unavailable' });
    operations.clear();
    publish();
  }

  async function applyCatchup(result) {
    if (!Array.isArray(result.envelopes)) throw new Error('catch-up is missing recipient envelopes');
    assertCursor(result.cursor, 'catch-up cursor');
    const initialCursor = cursor;
    // Coalesced snapshot-patch CHAINS (#156): when a catch-up batch carries
    // multiple patch envelopes, they are applied as ONE atomic unit with
    // from==prev.to chain validation. Mixed batches (patches interleaved with
    // other kinds) cannot be proven contiguous, so they recover via resync.
    if (result.envelopes.length > 1 && result.envelopes.some((envelope) => envelope?.type === 'snapshot-patch')) {
      const patchesOnly = result.envelopes.every((envelope) => envelope?.type === 'snapshot-patch');
      const applied = patchesOnly
        ? applySnapshotPatch(result.envelopes)
        : { status: 'resync' };
      if (applied.status === 'resync') return false;
      if (!sameCursor(cursor, result.cursor)) throw new Error('catch-up final cursor does not match its recipient envelopes');
      return true;
    }
    let previousPatch = null;
    for (const envelope of result.envelopes) {
      if (!isKnownEnvelopeKind(envelope)) throw new Error('catch-up recipient envelopes are not valid');
      if (envelope.type === 'resync' || envelope.type === 'state-invalidate') return false;
      if (envelope.type === 'notification') continue;
      const applied = envelope.type === 'snapshot-patch'
        ? applySnapshotPatch(envelope, previousPatch)
        : applyAuthoritative(envelope);
      if (envelope.type === 'snapshot-patch') previousPatch = envelope;
      if (applied.status === 'resync') return false;
      if (closed || status === 'revoked') return true;
      if (applied.status === 'gap') throw new Error('catch-up recipient envelopes are not contiguous');
    }
    if (result.envelopes.length === 0 && !sameCursor(result.cursor, initialCursor)) {
      throw new Error('empty catch-up cannot advance its cursor');
    }
    if (!sameCursor(cursor, result.cursor)) throw new Error('catch-up final cursor does not match its recipient envelopes');
    return true;
  }

  async function recover(mode, snapshotCursorFloor, retryAttempt = 0) {
    if (closed) return;
    onRecoveryStart?.();
    startRecoveryWarning();
    const generation = ++recoveryGeneration;
    const receiptGenerationAtStart = receiptGeneration;
    const snapshotCursorAtStart = cursor;
    status = mode === 'snapshot' ? 'recovering' : 'catching-up';
    if (mode === 'snapshot') {
      if (!snapshotRecoveryCycle || snapshotRecoveryCycle.connectionGeneration !== connectionGeneration) {
        beginSnapshotRecoveryCycle(snapshotCursorFloor ?? null);
      }
      if (snapshotRecoveryCycle.attempts >= MAX_SNAPSHOT_BOOTSTRAPS_PER_CYCLE) {
        throw new Error('snapshot recovery attempt budget exhausted');
      }
      snapshotRecoveryCycle.attempts += 1;
    }
    const cycleGenerationAtStart = snapshotRecoveryCycle?.connectionGeneration;
    const result = await bootstrap({
      after: mode === 'catchup' ? cursor : undefined,
      mode,
      // Capability advertisement (#156 client): every recovery attempt offers
      // snapshot-patch support; a patch-capable host answers with its protocol
      // echo + fresh projectionToken, a legacy host ignores the extra field.
      // Catch-up additionally presents the held token so the server can serve
      // journal patches instead of a full snapshot.
      capabilities: [SNAPSHOT_PATCH_CAPABILITY],
      ...(mode === 'catchup' && deltaCapable && typeof projectionToken === 'string' ? { projectionToken } : {}),
    });
    // A transport can revoke access while an authorized recovery request is
    // pending. Its late result must never rematerialize project state.
    if (closed || status === 'revoked' || generation !== recoveryGeneration) return;
    if (mode === 'snapshot' && (cycleGenerationAtStart !== connectionGeneration
      || snapshotRecoveryCycle?.connectionGeneration !== connectionGeneration)) return;
    if (!result || typeof result !== 'object') throw new Error('bootstrap returned an invalid result');
    if (result.kind === 'revoked') {
      revoke(result.reason);
      return;
    }
    if (result.kind === 'retry') {
      if (!(await waitForRecoveryRetry(retryAttempt)) || closed || status === 'revoked' || generation !== recoveryGeneration) return;
      if (mode === 'snapshot' && snapshotRecoveryCycle?.connectionGeneration !== connectionGeneration) return;
      return recover('snapshot', snapshotCursorFloor, retryAttempt + 1);
    }
    if (result.kind === 'snapshot') {
      assertCursor(result.cursor, 'snapshot cursor');
      const nextSnapshot = validateSnapshot(result.snapshot, result);
      if (closed || status === 'revoked' || generation !== recoveryGeneration) return;
      if (mode === 'snapshot' && snapshotRecoveryCycle?.connectionGeneration !== connectionGeneration) return;
      // A receipt confirmation must never install a replacement snapshot that
      // predates its committed fence, even when reconnect superseded its first
      // request while it was in flight.
      if (snapshotCursorFloor != null && cursorAnchor(result.cursor) < Math.max(snapshotCursorFloor, cursorAnchor(snapshotCursorAtStart))) return;
      // Capability negotiation (#156 client): the INSTALLED bootstrap result
      // is the ONLY thing that arms delta mode. A legacy result (no protocol
      // echo) downgrades cleanly; a patch-capable result re-arms and stores
      // its freshly minted projectionToken. Arming coincides exactly with
      // installing this result so the token can never lead its cursor.
      armDeltaMode(result);
      baseSnapshot = nextSnapshot;
      cursor = result.cursor;
      snapshotGeneration += 1;
      settleSnapshotConfirmations(receiptGenerationAtStart);
      publish();
      if (closed || status === 'revoked' || generation !== recoveryGeneration) return;
      finishRecoveryWarning();
      status = 'live';
      publish();
      if (initialized && !reconnecting) settleAdmissions(true);
      if (mode === 'snapshot' && snapshotRecoveryCycle
        && (snapshotRecoveryCycle.floor == null || cursorAnchor(cursor) >= snapshotRecoveryCycle.floor)
        && !snapshotRecoveryCycle.followupRequested) {
        snapshotRecoveryCycle = null;
      }
      return;
    }
    if (result.kind === 'catchup' && mode === 'catchup') {
      if (!(await applyCatchup(result))) return recover('snapshot');
      if (closed || status === 'revoked' || generation !== recoveryGeneration) return;
      finishRecoveryWarning();
      status = 'live';
      publish();
      if (initialized && !reconnecting) settleAdmissions(true);
      return;
    }
    throw new Error('bootstrap returned an unsupported result');
  }

  async function receive(envelopes, generation) {
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
      if (applySnapshotPatch(run).status !== 'resync') return;
      const recovery = requestSnapshotRecovery(undefined, !hasUnknownTransmission(), true);
      if (!hasUnknownTransmission()) await recovery;
    };
    for (const envelope of envelopes) {
      if (closed || status === 'revoked' || status === 'unavailable' || generation !== connectionGeneration) return;
      if (!isKnownEnvelopeKind(envelope)) throw new Error('delivery batch contains an invalid recipient envelope');
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
        const coverage = Number.isSafeInteger(envelope.seq) ? envelope.seq : undefined;
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
        recoveryWait = deltaCapable && typeof projectionToken === 'string' && envelope.type === 'resync'
          ? requestCatchupRecovery(!hasUnknownTransmission(), true)
          : requestSnapshotRecovery(coverage, !hasUnknownTransmission(), true);
        // A control declares the CURRENT base untrusted (#156 round 3): later
        // envelopes in the same batch must not derive state from it. Await the
        // replacement before continuing — subsequent patch runs are then
        // evaluated against the recovered cursor (continuing links apply;
        // stale links fail closed as duplicate/resync instead of mutating an
        // untrusted base and publishing garbage ahead of the replacement).
        if (!hasUnknownTransmission()) await recoveryWait;
        continue;
      }
      // Derived/operational notifications are never authoritative domain
      // mutations; they are ignored, not thrown.
      if (envelope.type === 'notification') continue;
      const applied = applyAuthoritative(envelope);
      if (applied.status === 'resync') {
        const recovery = requestSnapshotRecovery(undefined, !hasUnknownTransmission(), true);
        if (!hasUnknownTransmission()) await recovery;
        continue;
      }
      if (applied.status === 'gap') {
        try {
          await recover('catchup');
        } catch (error) {
          if (!closed && status !== 'revoked') becomeUnavailable();
          throw error;
        }
        if (closed || status === 'revoked' || generation !== connectionGeneration) return;
        const replayed = applyAuthoritative(envelope);
        if (replayed.status === 'gap') {
          if (!closed && status !== 'revoked') becomeUnavailable();
          throw new Error('delivery remains gapped after catch-up');
        }
      }
    }
    await flushPatchRun();
    if (recoveryWait && !hasUnknownTransmission()) await recoveryWait;
  }

  function deliver(envelopes, generation) {
    // A later, transport-triggered recovery can proceed after a failed batch.
    const attempt = deliveryChain.catch(() => {}).then(() => receive(envelopes, generation));
    deliveryChain = attempt.catch(() => {});
    return attempt;
  }

  function recoverReceiptSnapshot(operation) {
    requestSnapshotRecovery(operation.confirmedThrough, false);
  }

  // True when the delta patch stream has already advanced to (or past) an
  // operation's receipt fence (#156 round 2): a full snapshot recovery would
  // re-install state at least as stale as what is already installed, so the
  // per-edit bootstrap tax buys nothing. Only ever true in delta-capable
  // composite mode — legacy numeric cursors and snapshot-only sessions keep
  // the unconditional recovery behavior.
  function receiptFenceAlreadyCovered(operation) {
    return deltaCapable && !snapshotOnly
      && cursor !== null && typeof cursor === 'object'
      && Number.isSafeInteger(operation.confirmedThrough)
      && cursorAnchor(cursor) >= operation.confirmedThrough;
  }

  // A foldable operation's echo is emitted on the SSE immediately after its
  // action commits, but the sender receipt is answered first. Without a grace
  // window the receipt path always wins the race, forcing a full document
  // snapshot per keystroke and discarding the fold as a "duplicate". Give the
  // echo time to land; only then fall back to snapshot recovery (the delayed-SSE
  // path). A settled operation (fold echo applied) skips the fallback.
  function recoverFoldableAfterGrace(operation) {
    setTimeout(() => {
      if (operations.get(operation.actionId) !== operation) return;
      if (operation.echoCursor != null) return;
      if (operation.confirmedThrough == null) return;
      recoverReceiptSnapshot(operation);
    }, FOLD_ECHO_GRACE_MS);
  }

  async function connect() {
    const generation = ++connectionGeneration;
    const nextSubscription = await subscribe({
      after: cursor,
      deliver: (envelopes) => {
        if (closed || status === 'revoked' || generation !== connectionGeneration) return;
        return deliver(envelopes, generation);
      },
      revoke,
      closed: () => {
        if (generation !== connectionGeneration) return;
        connectionGeneration += 1;
        if (reconnecting) reconnectRequested = true;
        else reconnect().catch(() => {});
      },
      // Capability advertisement (#156): the live subscription offers the
      // capability too, so a patch-capable host can push snapshot-patch
      // envelopes on the stream. Additive — legacy hosts ignore it. The held
      // projection token rides along (#159 round-3): a host emitting patches
      // over the stream needs the recipient's ledger handle; the token is
      // re-established on every reconnect, so it never goes stale within a
      // connection.
      capabilities: [SNAPSHOT_PATCH_CAPABILITY],
      ...(typeof projectionToken === 'string' && projectionToken.length > 0 ? { projectionToken } : {}),
    });
    // Delivery can revoke access while transport establishment is pending.
    // Never retain a subscription that became unauthorized before its handle.
    if (closed || status === 'revoked' || generation !== connectionGeneration) {
      nextSubscription?.close?.();
      return false;
    }
    subscription = nextSubscription;
    return true;
  }

  let reconnectLoop = null;
  async function reconnect() {
    if (closed || status === 'revoked') return;
    if (reconnecting) {
      reconnectRequested = true;
      // A reconnect loop is already running. Await its completion (which
      // includes the extra iteration this request triggers) so the caller
      // observes the loop's final snapshot, not an intermediate one.
      return reconnectLoop;
    }
    // Some adapters report their own close synchronously. Mark reconnecting
    // before closing the old subscription so that callback cannot recurse.
    reconnecting = true;
    onRecoveryStart?.();
    reconnectLoop = (async () => {
      try {
        do {
          reconnectRequested = false;
          // Invalidate the old transport before recovery reauthorizes the stream.
          // The old cycle is cancelled so its late bootstrap cannot install
          // state; an uncovered receipt fence is re-queued as a new cycle.
          const pendingReceiptFloor = snapshotRecoveryCycle?.receiptFloor ?? snapshotRecoveryFloor;
          connectionGeneration += 1;
          if (snapshotRecoveryCycle) snapshotRecoveryCycle = null;
          subscription?.close?.();
          subscription = null;
          await recover('catchup');
          if (closed || status === 'revoked') break;
          if (pendingReceiptFloor != null && cursorAnchor(cursor) < pendingReceiptFloor) {
            requestSnapshotRecovery(pendingReceiptFloor, false);
          }
          status = 'recovering';
          if (!(await connect())) {
            reconnectRequested = true;
            continue;
          }
          status = 'live';
        } while (reconnectRequested && !closed && status !== 'revoked');
        if (!reconnectRequested && !closed && status === 'live') settleAdmissions(true);
      } catch (error) {
        if (!closed && status !== 'revoked') becomeUnavailable();
        throw error;
      } finally {
        reconnecting = false;
        reconnectLoop = null;
      }
    })();
    return reconnectLoop;
  }

  function revoke(_reason) {
    if (closed || status === 'revoked') return;
    status = 'revoked';
    cancelSnapshotRecovery();
    cancelCatchupRecovery();
    disarmDeltaMode();
    finishRecoveryWarning();
    settleAdmissions(false);
    cancelRecoveryRetries();
    baseSnapshot = null;
    visibleSnapshot = null;
    for (const operation of operations.values()) settleOperation(operation, { status: 'revoked' });
    operations.clear();
    subscription?.close?.();
    subscription = null;
    for (const listener of listeners) {
      try { listener(null); } catch { /* isolate consumers */ }
    }
  }

  async function start() {
    try {
      await recover('snapshot');
      if (!closed && status !== 'revoked') {
        if (await connect()) initialized = true;
      }
    } catch (error) {
      if (!closed && status !== 'revoked') becomeUnavailable();
      throw error;
    }
  }

  async function dispatch(type, payload, options) {
    // A caller may pre-mint the actionId synchronously so an optimistic layer
    // can tag the pending state it will reconcile before its fold echo arrives.
    const actionId = options?.actionId ?? nextActionId();
    const action = freezeClone(structuredClone({ actionId, type, payload }));
    const operation = makeOperation({
      actionId,
      action,
      outcome: 'unknown',
      confirmedThrough: null,
      receiptGeneration: null,
      receiptSnapshotGeneration: null,
      foldableEcho: isFoldableEcho(action) === true,
    });
    const settlement = createSettlement(operation);
    if (!initialized || closed || status === 'unavailable' || status === 'revoked') {
      settleOperation(operation, { status: terminalStatus() });
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement, failure: new ClientClosedError('Live delivery is unavailable') };
    }
    operations.set(actionId, operation);
    publish();
    if (!((status === 'live' && !reconnecting) || await admit(operation)) || !canTransmit(operation)) {
      settleOperation(operation, { status: terminalStatus() });
      operations.delete(actionId);
      publish();
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement, failure: new ClientClosedError('Live delivery is unavailable') };
    }
    return submitAction(operation);
  }

  async function submitAction(operation) {
    try {
      operation.transmitted = true;
      const receipt = await sendAction(operation.action);
      if (status === 'revoked') {
        operation.outcome = 'rejected';
        settleOperation(operation, { status: 'revoked' });
        operations.delete(operation.actionId);
        publish();
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure: new ClientClosedError('Live delivery access was revoked') };
      }
      if (receipt?.ok === false) {
        operation.outcome = 'rejected';
        kickSnapshotRecovery();
        // The matching committed envelope is authoritative when a request
        // failure races its delivery; never tell callers to retry that action.
        // A patch attribution (#156 round 3) is the same commit proof: the
        // accepted patch already settled and removed the op.
        if (operation.echoCursor != null || operation.patchAttributed) {
          operations.delete(operation.actionId);
          publish();
          settleOperation(operation, { status: 'reconciled' });
          return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement };
        }
        const failure = receipt.failure ?? receipt.error ?? receipt;
        operations.delete(operation.actionId);
        operation.status = 'failed';
        operation.error = failure;
        settleOperation(operation, { status: 'failed', error: failure });
        publish();
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure };
      }
      const confirmedThrough = receipt?.confirmedThrough;
      if (snapshotOnly && (!Number.isSafeInteger(confirmedThrough) || confirmedThrough < 0 || receipt?.actionId !== operation.actionId)) {
        throw new Error('snapshot-only action receipt must confirm its actionId through a nonnegative cursor');
      }
      operation.outcome = 'positive';
      operation.delivered = true;
      const confirmedCursor = receipt?.cursor ?? receipt?.seq;
      if (Number.isSafeInteger(confirmedCursor) && confirmedCursor >= 0) operation.confirmedCursor = confirmedCursor;
      if (Number.isSafeInteger(confirmedThrough) && confirmedThrough >= 0) operation.confirmedThrough = confirmedThrough;
      operation.receiptGeneration = ++receiptGeneration;
      operation.receiptSnapshotGeneration = snapshotGeneration;
      settleSnapshotConfirmations(receiptGeneration);
      // Prefer fold echo settlement. Snapshot recovery covers (a) snapshot-only
      // composites and (b) fold-mode actions whose receipt names a fence but
      // whose fold echo has not arrived (non-foldable ops, delayed SSE).
      // Ordinary fold sessions without a confirmation fence keep echo-only settle.
      // Delta-capable sessions (#156 round 2) skip the recovery entirely when
      // the patch stream has ALREADY advanced past the receipt fence — the
      // authoritative base is at least as fresh as the receipt, so a full
      // snapshot bootstrap would be a pointless per-edit tax. The op stays
      // pending until its patch attribution (actionIds / routedInvisible)
      // settles it, exactly like any other unechoed delta-stream action.
      // An op the patch ALREADY attributed and removed (#156 round 3) skips
      // recovery too — it is settled; there is nothing left to recover for.
      if (operation.echoCursor == null && !operation.patchAttributed
        && !receiptFenceAlreadyCovered(operation)
        && (snapshotOnly || Number.isSafeInteger(operation.confirmedThrough))) {
        if (operation.foldableEcho) recoverFoldableAfterGrace(operation);
        else recoverReceiptSnapshot(operation);
      }
      if (shouldReconcile(operation, { confirmedCursor: operation.confirmedCursor, echoCursor: operation.echoCursor })) {
        settleOperation(operation, { status: 'reconciled' });
        operations.delete(operation.actionId);
      }
      publish();
      return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement, value: receipt?.value };
    } catch (error) {
      if (status === 'revoked') {
        settleOperation(operation, { status: 'revoked' });
        operations.delete(operation.actionId);
        publish();
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure: new ClientClosedError('Live delivery access was revoked') };
      }
      // A delivery echo proves the action reached the committed recipient
      // stream even when its request promise fails after that point. An
      // accepted-patch attribution (#156 round 3) is the same commit proof.
      if (operation.echoCursor != null || operation.patchAttributed) {
        settleOperation(operation, { status: 'reconciled' });
        operations.delete(operation.actionId);
        publish();
        return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement };
      }
      operation.deliveryError = error;
      return { ok: false, status: 'outcome-unknown', opId: operation.actionId, settlement: operation.settlement, deliveryError: { message: String(error?.message ?? error) } };
    }
  }

  async function submitBatch(operation) {
    try {
      operation.transmitted = true;
      const receipt = await sendBatch(operation.batch);
      if (status === 'revoked') {
        operation.outcome = 'rejected';
        settleOperation(operation, { status: 'revoked' });
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure: new ClientClosedError('Live delivery access was revoked') };
      }
      if (receipt?.ok === false) {
        operation.outcome = 'rejected';
        kickSnapshotRecovery();
        // Same commit-proof escapes as submitAction: a fold echo or an
        // accepted-patch attribution (#156 round 3) means the batch committed
        // even when its request failed.
        if (operation.echoCursor != null || operation.patchAttributed) {
          settleOperation(operation, { status: 'reconciled' });
          operations.delete(operation.actionId);
          publish();
          return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement };
        }
        operations.delete(operation.actionId);
        operation.status = 'failed';
        operation.error = receipt.failure ?? receipt.error ?? receipt;
        settleOperation(operation, { status: 'failed', error: operation.error });
        publish();
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure: operation.error };
      }
      if (!receipt || receipt.ok !== true || receipt.actionId !== operation.actionId) {
        throw new Error('batch dispatch returned an invalid receipt');
      }
      const confirmedThrough = receipt.confirmedThrough;
      if (snapshotOnly && (!Number.isSafeInteger(confirmedThrough) || confirmedThrough < 0)) {
        throw new Error('snapshot-only batch receipt must confirm through a nonnegative cursor');
      }
      operation.outcome = 'positive';
      operation.delivered = true;
      const confirmedCursor = receipt?.cursor ?? receipt?.seq;
      if (Number.isSafeInteger(confirmedCursor) && confirmedCursor >= 0) operation.confirmedCursor = confirmedCursor;
      if (Number.isSafeInteger(confirmedThrough) && confirmedThrough >= 0) operation.confirmedThrough = confirmedThrough;
      operation.receiptGeneration = ++receiptGeneration;
      operation.receiptSnapshotGeneration = snapshotGeneration;
      settleSnapshotConfirmations(receiptGeneration);
      // Same delta-capable fence-coverage skip as submitAction (#156 round 2);
      // patch-attributed ops skip recovery too (#156 round 3).
      if (operation.echoCursor == null && !operation.patchAttributed
        && !receiptFenceAlreadyCovered(operation)
        && (snapshotOnly || Number.isSafeInteger(operation.confirmedThrough))) {
        if (operation.foldableEcho) recoverFoldableAfterGrace(operation);
        else recoverReceiptSnapshot(operation);
      }
      if (shouldReconcile(operation, { confirmedCursor: operation.confirmedCursor, echoCursor: operation.echoCursor })) {
        settleOperation(operation, { status: 'reconciled' });
        operations.delete(operation.actionId);
      }
      publish();
      return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement, value: receipt?.value };
    } catch (error) {
      if (status === 'revoked') {
        settleOperation(operation, { status: 'revoked' });
        operations.delete(operation.actionId);
        publish();
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure: new ClientClosedError('Live delivery access was revoked') };
      }
      // Same commit-proof escapes as submitAction: a delivery echo or an
      // accepted-patch attribution (#156 round 3) proves the batch committed
      // even when its request promise fails after that point.
      if (operation.echoCursor != null || operation.patchAttributed) {
        settleOperation(operation, { status: 'reconciled' });
        operations.delete(operation.actionId);
        publish();
        return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement };
      }
      // A transport exception cannot prove rollback. Retain the one package-owned
      // envelope and optimistic placeholder so retry can resend its action ID.
      operation.deliveryError = error;
      return { ok: false, status: 'outcome-unknown', opId: operation.actionId, settlement: operation.settlement, deliveryError: { message: String(error?.message ?? error) } };
    }
  }

  async function batch(actions) {
    const actionId = nextActionId();
    const rejectedOperation = { opId: actionId };
    const rejectedSettlement = createSettlement(rejectedOperation);
    if (!Array.isArray(actions) || actions.length === 0 || actions.some((action) => !action
      || typeof action.type !== 'string'
      || Object.keys(action).length !== 2
      || !isJsonValue(action.payload))) {
      settleOperation(rejectedOperation, { status: 'failed', error: new TypeError('batch requires a non-empty action array') });
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement: rejectedSettlement, failure: new TypeError('batch requires a non-empty action array') };
    }
    if (typeof sendBatch !== 'function') {
      const failure = new TypeError('sendBatch is required');
      settleOperation(rejectedOperation, { status: 'failed', error: failure });
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement: rejectedSettlement, failure };
    }
    if (!initialized || closed || status === 'unavailable' || status === 'revoked') {
      settleOperation(rejectedOperation, { status: terminalStatus() });
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement: rejectedSettlement, failure: new ClientClosedError('Live delivery is unavailable') };
    }
    const retainedActions = freezeClone(structuredClone(actions));
    const batchEnvelope = Object.freeze({ actionId, actions: retainedActions });
    const operation = makeOperation({
      actionId,
      batch: batchEnvelope,
      actions: retainedActions,
      outcome: 'unknown',
      confirmedThrough: null,
      receiptGeneration: null,
      receiptSnapshotGeneration: null,
      foldableEcho: isFoldableEcho(retainedActions[0]) === true,
    });
    createSettlement(operation);
    operations.set(actionId, operation);
    publish();
    if (!((status === 'live' && !reconnecting) || await admit(operation)) || !canTransmit(operation)) {
      settleOperation(operation, { status: terminalStatus() });
      operations.delete(actionId);
      publish();
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement: operation.settlement, failure: new ClientClosedError('Live delivery is unavailable') };
    }
    return submitBatch(operation);
  }

  async function retry(opId) {
    const operation = operations.get(opId);
    if (!operation?.deliveryError || (!operation.batch && !operation.action)) {
      const rejectedOperation = { opId };
      const settlement = createSettlement(rejectedOperation);
      const failure = new TypeError('operation is not awaiting transport retry');
      settleOperation(rejectedOperation, { status: 'failed', error: failure });
      return { ok: false, status: 'failed-rolled-back', opId, settlement, failure };
    }
    if (!((status === 'live' && !reconnecting) || await admit(operation)) || !canTransmit(operation)) {
      settleOperation(operation, { status: terminalStatus() });
      operations.delete(opId);
      publish();
      return { ok: false, status: 'failed-rolled-back', opId, settlement: operation.settlement, failure: new ClientClosedError('Live delivery is unavailable') };
    }
    operation.deliveryError = null;
    return operation.batch ? submitBatch(operation) : submitAction(operation);
  }

  const ready = start();
  ready.catch(() => {});

  return {
    get snapshot() { return visibleSnapshot; },
    // The pre-projection view: the last server-installed snapshot, with NO
    // pending operation's optimistic reducer applied. `snapshot` above is the
    // merged view (base + pending projections) and is what a UI renders from.
    // A consumer that must know whether a row is CONFIRMED rather than merely
    // projected reads this one; both views are already in memory, so this
    // getter is free. Null exactly when `snapshot` is null.
    get confirmedSnapshot() { return baseSnapshot; },
    get cursor() { return cursor; },
    get status() { return status; },
    // Capability negotiation state (#156): true only while a patch-capable
    // bootstrap result is installed; hosting code and tests read this to
    // verify the response-gated handshake.
    get deltaCapable() { return deltaCapable; },
    get projectionToken() { return projectionToken; },
    get ready() { return ready; },
    dispatch,
    batch,
    retry,
    reconnect,
    operations() {
      return [...operations.values()].map((operation) => Object.freeze({
        opId: operation.opId,
        actionId: operation.actionId,
        status: operation.status,
        error: operation.error,
      }));
    },
    pendingCount() { return count('pending'); },
    subscribe(listener) {
      listeners.add(listener);
      if (visibleSnapshot !== null || status === 'revoked') listener(visibleSnapshot);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      cancelSnapshotRecovery();
      cancelCatchupRecovery();
      finishRecoveryWarning();
      settleAdmissions(false);
      cancelRecoveryRetries();
      subscription?.close?.();
      subscription = null;
      for (const operation of operations.values()) settleOperation(operation, { status: 'closed' });
      operations.clear();
      listeners.clear();
    },
  };
}

/**
 * Connect the package-owned recovery session to its HTTP/SSE delivery skin.
 * Applications supply their recipient snapshot validator/fold and action
 * sender, never event replay, cursor, or transport recovery callbacks.
 */
export function createLiveDeliveryHttpSession({
  baseUrl,
  scope,
  validateSnapshot,
  fold,
  optimistic,
  sendAction,
  serializeAction,
  sendBatch,
  actionUrl,
  historySession,
  fetchImpl = globalThis.fetch,
  eventSourceFactory = (url, options) => new EventSource(url, options),
  createActionId,
  onRecoveryStart,
  onRecoveryDelayed,
  requestIdentity = null,
}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) throw new TypeError('baseUrl is required');
  if (typeof scope !== 'string' || scope.length === 0) throw new TypeError('scope is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  if (typeof eventSourceFactory !== 'function') throw new TypeError('eventSourceFactory is required');
  if (typeof historySession !== 'string' || historySession.length === 0) throw new TypeError('historySession is required');
  const endpoint = `${baseUrl.replace(/\/$/, '')}/bootstrap`;
  const eventsEndpoint = `${baseUrl.replace(/\/$/, '')}/events`;
  // The action endpoint belongs to the configured Workbench origin, not the
  // browser document origin which may host a separate frontend application.
  const actionEndpoint = actionUrl ?? new URL('/workbench/actions', new URL(baseUrl, globalThis.location?.href ?? 'http://workbench.local')).toString();
  const batchActionEndpoint = new URL('/workbench/actions/batch', new URL(baseUrl, globalThis.location?.href ?? 'http://workbench.local')).toString();
  const historyEndpoint = new URL('/workbench/history', new URL(baseUrl, globalThis.location?.href ?? 'http://workbench.local')).toString();

  async function bootstrap({ after, mode, projectionToken }) {
    const url = new URL(endpoint, globalThis.location?.href ?? 'http://workbench.local');
    if (!requestIdentity) url.searchParams.set('scope', scope);
    for (const [key, value] of Object.entries(requestIdentity ?? {})) url.searchParams.set(key, value);
    url.searchParams.set('mode', mode);
    // Capability advertisement (#156): every bootstrap offers snapshot-patch
    // support. Catch-up presents the held projectionToken so a patch-capable
    // server can serve journal patches; both fields are additive and ignored
    // by legacy servers (byte-identical legacy requests otherwise).
    url.searchParams.set('capabilities', SNAPSHOT_PATCH_CAPABILITY);
    if (mode === 'catchup') {
      url.searchParams.set('after', typeof after === 'object' ? JSON.stringify(after) : String(after));
      if (typeof projectionToken === 'string') url.searchParams.set('projectionToken', projectionToken);
    }
    let response;
    try {
      response = await fetchImpl(url.toString(), { credentials: 'include' });
    } catch {
      return { kind: 'retry' };
    }
    if (response.status === 401 || response.status === 403) return { kind: 'revoked' };
    if (response.status >= 500) return { kind: 'retry' };
    if (!response.ok) throw new Error(`live delivery bootstrap failed with HTTP ${response.status}: ${await response.text()}`);
    const result = await response.json();
    if (!result || typeof result !== 'object' || !['snapshot', 'catchup', 'retry', 'revoked'].includes(result.kind)) {
      throw new Error('live delivery bootstrap returned an invalid response');
    }
    return result;
  }

  function subscribe({ after, deliver, closed, projectionToken: heldToken }) {
    const url = new URL(eventsEndpoint, globalThis.location?.href ?? 'http://workbench.local');
    if (!requestIdentity) url.searchParams.set('scope', scope);
    for (const [key, value] of Object.entries(requestIdentity ?? {})) url.searchParams.set(key, value);
    url.searchParams.set('after', typeof after === 'object' ? JSON.stringify(after) : String(after));
    // Capability advertisement (#156): the stream may carry snapshot-patch
    // envelopes for a patch-capable server. Additive query parameter. The
    // held projection token rides along (#159 round-3) so a host emitting
    // patches over the stream has the recipient's ledger handle.
    url.searchParams.set('capabilities', SNAPSHOT_PATCH_CAPABILITY);
    if (typeof heldToken === 'string' && heldToken.length > 0) url.searchParams.set('projectionToken', heldToken);
    const source = eventSourceFactory(url.toString(), { withCredentials: true });
    let open = true;
    source.onmessage = (message) => {
      if (!open) return;
      let envelopes;
      try { envelopes = JSON.parse(message.data); } catch { source.close(); closed(); return; }
      Promise.resolve(deliver(envelopes)).catch(() => { source.close(); closed(); });
    };
    source.onerror = () => {
      if (!open) return;
      open = false;
      source.close();
      closed();
    };
    return Promise.resolve({ close() { open = false; source.close(); } });
  }

  async function sendHttpAction(action) {
    const historyCommand = action.type === '$history.undo' ? 'undo'
      : action.type === '$history.redo' ? 'redo' : null;
    const historyPayload = action.payload;
    const historyRequest = historyCommand && historyPayload && typeof historyPayload === 'object'
      ? { actionId: action.actionId, command: historyCommand, ...historyPayload,
          ...(requestIdentity ? { document: requestIdentity } : { scope }) }
      : null;
    const response = await fetchImpl(historyRequest ? historyEndpoint : actionEndpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(historyRequest ?? { ...action, ...(requestIdentity ? { document: requestIdentity } : { scope }), clientId: historySession }),
    });
    let receipt;
    try { receipt = await response.json(); } catch {
      if (!response.ok) return { ok: false, failure: new Error(`action dispatch failed with HTTP ${response.status}`) };
      throw new Error(`action dispatch failed with HTTP ${response.status}`);
    }
    if (!response.ok) return receipt?.ok === false ? receipt : { ok: false, failure: receipt };
    if (!receipt || receipt.ok !== true) throw new Error('action dispatch returned an invalid receipt');
    return receipt;
  }

  async function sendHttpBatch(batch) {
    const response = await fetchImpl(batchActionEndpoint, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...batch, ...(requestIdentity ? { document: requestIdentity } : { scope }), clientId: historySession }),
    });
    let receipt;
    try { receipt = await response.json(); } catch {
      if (!response.ok) return { ok: false, failure: new Error(`batch dispatch failed with HTTP ${response.status}`) };
      throw new Error(`batch dispatch failed with HTTP ${response.status}`);
    }
    if (!response.ok) return receipt?.ok === false ? receipt : { ok: false, failure: receipt };
    if (!receipt || receipt.ok !== true || receipt.actionId !== batch.actionId) throw new Error('batch dispatch returned an invalid receipt');
    return receipt;
  }

  let actionTail = Promise.resolve();
  const transportAction = (action) => action.type.startsWith('$history.')
    ? sendHttpAction(action)
    : (sendAction ?? sendHttpAction)(action);
  const session = createLiveDeliverySession({
    bootstrap,
    subscribe,
    validateSnapshot,
    fold,
    optimistic,
    sendAction: (action) => {
      if (!serializeAction?.(action)) return transportAction(action);
      const pending = actionTail.then(() => transportAction(action));
      actionTail = pending.catch(() => {});
      return pending;
    },
    sendBatch: sendBatch ?? sendHttpBatch,
    createActionId,
    onRecoveryStart,
    onRecoveryDelayed,
    isFoldableEcho: (action) => serializeAction?.(action) === true,
  });
  // History commands use the same receipt/snapshot reconciliation path as an
  // application action. The server resolves this authenticated session's
  // current cursor within its write queue; raw revisions never leave it.
  Object.defineProperty(session, 'history', { value: Object.freeze({
    undo: () => session.dispatch('$history.undo', { session: historySession }),
    redo: () => session.dispatch('$history.redo', { session: historySession }),
  }) });
  return session;
}

/**
 * Snapshot-only client for a principal-anchored projection. The package owns
 * its cursor, reconnect, and opaque-resync replacement; hosts receive no event
 * reducer, mutation, optimistic-state, or cursor configuration seam.
 */
export function createPrincipalSnapshotHttpSession({
  baseUrl,
  declaration,
  principal,
  validateSnapshot,
  fetchImpl,
  eventSourceFactory,
}) {
  if (typeof declaration !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(declaration)) {
    throw new TypeError('principal snapshot declaration is invalid');
  }
  if (!principal || !['user', 'link', 'system', 'apiKey'].includes(principal.type)
    || typeof principal.id !== 'string' || principal.id.length === 0) {
    throw new TypeError('principal snapshot principal is invalid');
  }
  if (typeof validateSnapshot !== 'function') throw new TypeError('validateSnapshot is required');
  const scope = `PrincipalSnapshot:${declaration}/${principal.type}/${encodeURIComponent(principal.id)}`;
  const session = createLiveDeliveryHttpSession({
    baseUrl,
    scope,
    validateSnapshot,
    fetchImpl,
    eventSourceFactory,
    historySession: 'principal-snapshot',
    sendAction: async () => { throw new Error('principal snapshot sessions do not dispatch actions'); },
  });
  return Object.freeze({
    get snapshot() { return session.snapshot; },
    get status() { return session.status; },
    get ready() { return session.ready; },
    subscribe(listener) { return session.subscribe(listener); },
    reconnect() { return session.reconnect(); },
    close() { session.close(); },
  });
}

/**
 * A document-bound annotated-text session. The document context owns scope,
 * action grammar, and private authoring bindings; callers only name positions.
 */
export function createAnnotatedTextHttpSession({ baseUrl, context, historySession, fetchImpl, eventSourceFactory, createActionId, onRecoveryDelayed, onFoldApplied, carets, typingBurstIdleMs = 75, typingBurstMaxMs = 150 }) {
  if (!context || typeof context !== 'object' || typeof context.documentId !== 'string' || context.documentId.length === 0) {
    throw new TypeError('annotated text context requires a documentId');
  }
  const { entity, field, documentId } = context;
  if (typeof entity?.name !== 'string' || typeof field?.fieldName !== 'string' || entity.fields?.[field.fieldName]?.kind !== 'annotatedText') {
    throw new TypeError('annotated text context requires declared entity and field handles');
  }
  const scope = `annotated-text:${documentId}`;
  const randomToken = () => {
    if (!globalThis.crypto?.getRandomValues) throw new Error('secure random authoring tokens are unavailable');
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  };
  const authoringClientStorageKey = `workbench:annotated-text-authoring-client:${JSON.stringify([
    baseUrl.replace(/\/+$/, ''), entity.name, field.fieldName, documentId,
  ])}`;
  let authoringClient;
  try {
    const stored = globalThis.sessionStorage?.getItem(authoringClientStorageKey);
    authoringClient = typeof stored === 'string' && /^[A-Za-z0-9_-]{43}$/.test(stored) ? stored : randomToken();
    if (stored !== authoringClient) {
      try { globalThis.sessionStorage?.setItem(authoringClientStorageKey, authoringClient); } catch {}
    }
  } catch {
    authoringClient = randomToken();
  }
  const deferredAuthoringAcknowledgements = new Map();
  let authoringMutationTail = null;
  let sessionClosed = false;
  let wakeAuthoringMutation = null;
  let translatedActions = 0;
  // Annotated-text family checkpoint is session-private. Snapshots replace it;
  // fold envelopes advance it. It is not a text.crdt reducer seed.
  // Keep the validated reducer replica live across folds. Re-restoring the
  // complete family checkpoint for every character replayed the whole document
  // history before applying one operation.
  let familyReplica = null;
  let displayFamily = null;
  const pendingDisplayEdits = [];
  // Authoring-basis anchored endpoints for pending annotation applies, keyed by
  // the operation's action identity (not annotation id, which is not unique
  // across re-applies). Resolved ONCE at apply time against the family whose
  // text the authoring offsets are expressed against, so a foreign fold that
  // re-projects the still-pending apply places the SAME anchored endpoints
  // instead of re-anchoring the offsets against a shifted basis. Retired when
  // the operation settles (echo/settlement consumed) or on remove/close.
  const pendingAnnotationRanges = new Map();
  // Related-entity annotation actions retain their envelope identity by
  // mutation id so an uncertain retry reuses the same durable receipt.
  const pendingAnnotationActionIds = new Map();
  let queuedDocumentText = null;
  let queuedAuthoringMutations = 0;
  let resolutionFailedOnce = false;
  let resolutionTerminal = false;
  let resolutionRecoveryInFlight = false;
  const snapshotBinding = createAnnotatedTextSnapshotSessionBinding();
  const requestIdentity = { entity: entity.name, field: field.fieldName, documentId, authoringClient };
  if (typeof context.viewAs === 'string' && context.viewAs.length > 0) requestIdentity.viewAs = context.viewAs;

  // Mint an actionId synchronously at queue time so every pending display edit
  // is tagged with the action that will fold it BEFORE its fold echo arrives
  // (the echo is delivered ahead of the dispatch promise resolving). Mirrors the
  // live-delivery session's own fallback so ids stay unique when no caller
  // supplied createActionId.
  let localActionCounter = 0;
  const mintActionId = () => {
    if (typeof createActionId === 'function') return createActionId();
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `annotated_op_${++localActionCounter}`;
  };

  // Optional recipient-projected carets: ephemeral presence ONLY. When the host
  // supplies a `carets` option the session owns ONE caret LiveChannel — the
  // document subscription carries caret interest, validated `annotated-text-caret`
  // frames feed registered listeners, and publish/clear are volatile (never
  // queued, never durable, never optimistic text). Without the option the
  // session exposes no caret surface and never constructs a channel.
  const caretsOption = carets ?? null;
  const caretListeners = new Set();
  let caretChannel = null;
  if (caretsOption != null) {
    if (typeof caretsOption !== 'object' || Array.isArray(caretsOption)
      || typeof caretsOption.wsBaseUrl !== 'string' || caretsOption.wsBaseUrl.length === 0) {
      throw new TypeError('annotated text carets option requires a wsBaseUrl');
    }
    if (caretsOption.socketFactory !== undefined && typeof caretsOption.socketFactory !== 'function') {
      throw new TypeError('annotated text carets socketFactory must be a function');
    }
    try {
      caretChannel = new LiveChannel(caretsOption.wsBaseUrl, {
        ...(typeof caretsOption.socketFactory === 'function' ? { socketFactory: caretsOption.socketFactory } : {}),
      });
      // Eager subscribe so presence is ready when the editor first focuses.
      // A host without WebSocket support rejects the subscription; degrade to a
      // no-op channel instead of failing session construction.
      caretChannel.subscribe(entity.name, documentId, {
        carets: [field.fieldName],
        onCaret: (frame) => {
          for (const listener of caretListeners) {
            try { listener(frame); } catch { /* isolate consumers */ }
          }
        },
      }).catch(() => {});
    } catch {
      caretChannel = null;
    }
  }

  function installAuthoringFromFold(foldAuthoring, fence) {
    if (!foldAuthoring || foldAuthoring.acknowledgementFence !== fence) {
      throw new Error('annotated text fold authoring fence mismatch');
    }
    const positionFrames = foldAuthoring.positionFrames;
    if (!Array.isArray(positionFrames) || positionFrames.length === 0
      || !positionFrames[0] || typeof positionFrames[0].positionToken !== 'string') {
      throw new Error('annotated text fold position frame is invalid');
    }
    snapshotBinding.authoring = Object.freeze({
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
  }

  /**
   * Consume the server-authoritative emptied-annotation disposition a v4 fold
   * ships. The fold is the ONE reconciliation path: the client never infers
   * delete-vs-orphan itself. A `deleted` disposition drops the annotation; an
   * `orphaned` disposition keeps its durable identity with the server's saved
   * quote (fields and owner come from the annotation the recipient already
   * disclosed). A disposition naming an annotation the recipient never had, a
   * family mismatch, or a collapsed range without a matching disposition fail
   * closed so the session recovers with an authorized snapshot instead of
   * diverging.
   */
  function applyAnnotatedTextFoldDispositions(currentDocument, ranges, dispositions) {
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
      const offsets = resolveRangeOffsets(range, familyReplica);
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
  }

  function foldAnnotatedTextDocument(currentDocument, envelope) {
    const startedAt = onFoldApplied ? performance.now() : 0;
    const fold = envelope?.fold;
    if (!fold || fold.kind !== 'annotatedText' || fold.version !== 5 || fold.field !== field.fieldName) {
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
    if (!familyReplica) {
      throw new Error('annotated text fold requires a family checkpoint seeded by the snapshot');
    }
    const beforeFamily = familyReplica;
    let family = familyReplica;
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
    familyReplica = family;
    consumeFoldedDisplayEdits(beforeFamily, envelope.event?.actionId);
    // The family advanced (possibly by a foreign edit); re-derive the queued
    // text so the optimistic overlay stays equal to the replayed display family.
    rebuildQueuedDocumentText(fold.projection.text);
    installAuthoringFromFold(fold.authoring, fence);
    if (onFoldApplied) onFoldApplied(fold, performance.now() - startedAt);
    const foldedDocument = applyAnnotatedTextFoldDispositions(currentDocument, foldedRanges, fold.dispositions);
    return Object.freeze({ ...foldedDocument, text: fold.projection.text });
  }

  const session = createLiveDeliveryHttpSession({
    baseUrl,
    scope,
    historySession,
    fetchImpl,
    eventSourceFactory,
    createActionId,
    requestIdentity,
    onRecoveryStart: () => {
      familyReplica = null;
      resetOptimisticProjection();
      revokeAnnotatedTextSnapshotSessionBinding(snapshotBinding);
    },
    onRecoveryDelayed,
    fold: foldAnnotatedTextDocument,
    optimistic(document, action) {
      // Blockless: the document is ONE text and the action carries absolute
      // offsets; the text-splice projection needs no block mapping. Pending
      // annotation applies anchor their authoring offsets against the basis
      // captured at apply time (see pendingAnnotationRanges) so the placeholder
      // stays positional across a concurrent foreign edit.
      const edit = action?.payload?.version === 9 ? action.payload.edit : null;
      const relatedAction = pendingAnnotationRanges.get(action?.actionId);
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
        const entry = pendingAnnotationRanges.get(action?.actionId);
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
      snapshotBinding.authoring = Object.freeze({
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
      familyReplica = authoring.family ? restoreTextFamily(authoring.family) : null;
      replayPendingDisplayEdits([...pendingDisplayEdits]);
      rebuildQueuedDocumentText(snapshot[field?.fieldName]?.text);
      const result = materializeAnnotatedTextSnapshot({ ...snapshot[field?.fieldName], authoring }, field, { binding: snapshotBinding, family: familyReplica });
      return result;
    },
  });
  function acknowledgeAuthoring(authoring) {
    void Promise.resolve().then(() => fetchImpl(`${baseUrl.replace(/\/$/, '')}/authoring/ack`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, entity: entity.name, field: field.fieldName, documentId,
        stream: authoring.stream, lease: authoring.lease, snapshot: authoring.snapshot,
        ...(context.viewAs ? { viewAs: context.viewAs } : {}) }),
    })).catch(() => {});
  }
  function flushAuthoringAcknowledgements() {
    if (translatedActions !== 0) return;
    for (const authoring of deferredAuthoringAcknowledgements.values()) acknowledgeAuthoring(authoring);
    deferredAuthoringAcknowledgements.clear();
  }
  const documentListeners = new Set();
  function rebuildQueuedDocumentText(baseText) {
    if (!pendingDisplayEdits.length) {
      queuedDocumentText = null;
      return;
    }
    let text = baseText ?? '';
    for (const edit of pendingDisplayEdits) {
      if (!Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to) || edit.from < 0 || edit.to < edit.from || edit.to > text.length) {
        queuedDocumentText = null;
        return;
      }
      text = `${text.slice(0, edit.from)}${edit.text}${text.slice(edit.to)}`;
    }
    queuedDocumentText = text === baseText ? null : text;
  }
  function resetOptimisticProjection() {
    queuedDocumentText = null;
    displayFamily = familyReplica;
    // A snapshot recovery reboots the family; captured authoring-basis anchors
    // from before the reset are stale and must not be reused.
    pendingAnnotationRanges.clear();
  }
  function displayEditFromCommand(command) {
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
  }
  function replayPendingDisplayEdits(edits) {
    pendingDisplayEdits.splice(0, pendingDisplayEdits.length, ...edits);
    if (!familyReplica) {
      displayFamily = null;
      return;
    }
    let family = familyReplica;
    try {
      for (const edit of pendingDisplayEdits) {
        family = applyOffsetTextEdit(family, edit.from, edit.to, edit.text);
      }
      displayFamily = family;
    } catch {
      pendingDisplayEdits.length = 0;
      displayFamily = familyReplica;
    }
  }
  function applyPendingDisplayEdit(command, actionId) {
    const edit = displayEditFromCommand(command);
    if (!edit || !displayFamily) return;
    try {
      displayFamily = applyOffsetTextEdit(displayFamily, edit.from, edit.to, edit.text);
      pendingDisplayEdits.push(actionId === undefined ? edit : { ...edit, actionId });
    } catch {
      displayFamily = familyReplica;
    }
  }
  function consumeFoldedDisplayEdits(beforeFamily, actionId) {
    if (!beforeFamily || pendingDisplayEdits.length === 0) {
      replayPendingDisplayEdits([]);
      return;
    }
    // Consume ONLY the pending edits dispatched under this actionId. A foreign
    // fold (an actionId not among the client's pending edits) consumes nothing;
    // the remaining edits are replayed against the newly-advanced family.
    const remaining = actionId === undefined
      ? [...pendingDisplayEdits]
      : pendingDisplayEdits.filter((edit) => edit.actionId !== actionId);
    replayPendingDisplayEdits(remaining);
  }
  function documentRangesUnresolvable(view, family) {
    if (!view || !Array.isArray(view.ranges) || view.ranges.every((range) => isOffsetRange(range))) return false;
    if (!family) return true;
    return tryResolveRangesOffsets(view.ranges, family) === null;
  }
  function closeAnnotatedSession() {
    sessionClosed = true;
    cancelOpenInsertBurst();
    wakeAuthoringMutation?.();
    wakeAuthoringMutation = null;
    revokeAnnotatedTextSnapshotSessionBinding(snapshotBinding);
    if (caretChannel) {
      try { caretChannel.clearCaret({ entity: entity.name, id: documentId, field: field.fieldName }); } catch { /* best effort */ }
      try { caretChannel.close(); } catch { /* best effort */ }
      caretChannel = null;
    }
    caretListeners.clear();
    documentListeners.clear();
    session.close();
  }
  function recoverFromUnresolvableRange() {
    if (resolutionTerminal || resolutionRecoveryInFlight) return;
    if (resolutionFailedOnce) {
      resolutionTerminal = true;
      closeAnnotatedSession();
      return;
    }
    resolutionFailedOnce = true;
    resolutionRecoveryInFlight = true;
    Promise.resolve(session.reconnect()).finally(() => {
      resolutionRecoveryInFlight = false;
      if (resolutionTerminal) return;
      const view = currentAnnotatedDocument();
      if (documentRangesUnresolvable(view, displayFamily ?? familyReplica)) {
        resolutionTerminal = true;
        closeAnnotatedSession();
      } else {
        // A replacement snapshot resolved the ranges; rearm the one-shot latch
        // so a later independent failure gets its own recovery attempt.
        resolutionFailedOnce = false;
      }
    });
  }
  function currentAnnotatedDocument() {
    const view = annotatedDocumentView(session.snapshot);
    if (!view || queuedDocumentText === null) return view;
    const ranges = Array.isArray(view.ranges) && view.ranges.some((range) => isOffsetRange(range))
      ? shiftOffsetRangesOverText(view.ranges, view.text, queuedDocumentText)
      : view.ranges;
    return Object.freeze({
      ...view,
      text: queuedDocumentText,
      ranges,
    });
  }
  // Resolve a pending annotation apply's authoring offsets to recipient-v2
  // anchored endpoints against the family whose text those offsets are
  // expressed against. Returns a frozen { annotationId, start, end } range or
  // null when the selection is inapplicable (non-forward/empty/out-of-bounds)
  // so the caller fails closed instead of guessing a projection.
  function resolvePendingAnnotationRange(family, annotation, from, to) {
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
  }
  function publishAnnotatedDocument() {
    const view = currentAnnotatedDocument();
    for (const listener of documentListeners) {
      try { listener(view); } catch { /* isolate consumers */ }
    }
  }
  session.subscribe((document) => {
    if (document === null) revokeAnnotatedTextSnapshotSessionBinding(snapshotBinding);
    if (document && snapshotBinding.authoring) {
      const authoring = snapshotBinding.authoring;
      if (translatedActions === 0) acknowledgeAuthoring(authoring);
      else deferredAuthoringAcknowledgements.set(authoring.snapshot, authoring);
    }
    publishAnnotatedDocument();
  });
  function sameCapturedBlocks(blocks) {
    return blocks.get('document') === session.snapshot?.text;
  }
  function localAuthoringConflict() {
    return { ok: false, failure: new Error('annotated text changed before queued operation could be submitted') };
  }
  function splitsSurrogate(text, offset) {
    return offset > 0 && offset < text.length
      && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
      && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff;
  }
  function projectQueuedDocumentText(text, command) {
    if (command.kind === 'text.insert' || command.kind === 'annotation.paste') {
      const offset = command.at?.offset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || splitsSurrogate(text, offset)) return null;
      return text.slice(0, offset) + command.text + text.slice(offset);
    }
    if (command.kind === 'text.delete' || command.kind === 'text.replace') {
      const from = command.from?.offset;
      const to = command.to?.offset;
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > text.length
        || splitsSurrogate(text, from) || splitsSurrogate(text, to)) return null;
      return text.slice(0, from) + (command.kind === 'text.replace' ? command.text : '') + text.slice(to);
    }
    return text;
  }
  function applyQueuedTextCommand(basis, command, actionId) {
    const next = projectQueuedDocumentText(basis, command);
    if (next == null) return null;
    queuedDocumentText = next;
    applyPendingDisplayEdit(command, actionId);
    return next;
  }
  function queueAuthoringMutation(command, send, { capturedBasis = null, alreadyProjected = false, reserved = false, actionId = null } = {}) {
    // Capture dependent local edits against the projection already queued
    // ahead of them, not against the last rendered snapshot. Rapid browser
    // input can enqueue several semantic edits before the first optimistic
    // placeholder is visible; treating each as a sibling of that old snapshot
    // makes every character after the first reject itself as stale.
    const queuedBasis = capturedBasis ?? queuedDocumentText ?? session.snapshot?.text ?? '';
    // Mint synchronously so the pending edit this mutation covers is tagged
    // with its actionId before the dispatch (and thus its fold echo) runs.
    const resolvedActionId = actionId ?? mintActionId();
    const blocks = new Map([['document', queuedBasis]]);
    if (!alreadyProjected && applyQueuedTextCommand(queuedBasis, command, resolvedActionId) == null) {
      return Promise.resolve({ ok: false, failure: new TypeError('annotated text position splits a surrogate pair') });
    }
    if (!reserved) queuedAuthoringMutations += 1;
    // Queued text is an explicit optimistic placeholder. Publish it immediately
    // instead of waiting for the preceding snapshot-fenced operation to settle.
    publishAnnotatedDocument();
    const predecessor = authoringMutationTail;
    let release;
    authoringMutationTail = new Promise((resolve) => { release = resolve; });
    return (async () => {
      try {
        if (predecessor) await predecessor;
        if (sessionClosed) throw new ClientClosedError('Annotated text document is unavailable');
        // Tokens are snapshot-fenced capabilities. Never translate against a
        // revoked binding or an optimistic/foreign basis that has since moved.
        if (session.status !== 'live' || !session.snapshot || !snapshotBinding.authoring) {
          await new Promise((resolve) => {
            wakeAuthoringMutation = resolve;
            const unsubscribe = session.subscribe(() => {
              if (sessionClosed || ['revoked', 'unavailable'].includes(session.status)
                || (session.status === 'live' && session.snapshot && snapshotBinding.authoring)) {
                unsubscribe();
                wakeAuthoringMutation = null;
                resolve();
              }
            });
          });
        }
        if (sessionClosed) throw new ClientClosedError('Annotated text document is unavailable');
        if (['revoked', 'unavailable'].includes(session.status)) return localAuthoringConflict();
        // Fail closed on any foreign change after capture: the queued offset is
        // absolute against the captured view, and a naive length-delta rebase
        // moves it to the wrong place when the foreign edit sits after the
        // target. The position basis would be stale server-side anyway; surface
        // the conflict instead of guessing.
        if (!sameCapturedBlocks(blocks)) return localAuthoringConflict();
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
        pendingAnnotationRanges.delete(resolvedActionId);
        queuedAuthoringMutations -= 1;
        if (queuedAuthoringMutations <= 0) {
          queuedAuthoringMutations = 0;
          queuedDocumentText = null;
          if (!pendingDisplayEdits.length || (familyReplica && session.snapshot?.text === materializeFamilyText(familyReplica))) {
            replayPendingDisplayEdits([]);
          }
        }
        publishAnnotatedDocument();
      }
    })();
  }

  // One semantic insert represents a short contiguous typing burst. Every
  // character is projected immediately above, while the durable commit is
  // coalesced after a brief idle window (bounded so continuous typing cannot
  // postpone persistence indefinitely).
  const TEXT_BURST_IDLE_MS = Math.max(0, Number(typingBurstIdleMs) || 0);
  const TEXT_BURST_MAX_MS = Math.max(TEXT_BURST_IDLE_MS, Number(typingBurstMaxMs) || 0);
  let openInsertBurst = null;
  function armInsertBurst(burst) {
    if (burst.timer) clearTimeout(burst.timer);
    const remaining = Math.max(0, TEXT_BURST_MAX_MS - (Date.now() - burst.startedAt));
    burst.timer = setTimeout(flushOpenInsertBurst, Math.min(TEXT_BURST_IDLE_MS, remaining));
  }
  function flushOpenInsertBurst() {
    const burst = openInsertBurst;
    if (!burst) return;
    openInsertBurst = null;
    if (burst.timer) clearTimeout(burst.timer);
    queueAuthoringMutation(burst.command, burst.send, {
      capturedBasis: burst.capturedBasis,
      alreadyProjected: true,
      reserved: true,
      actionId: burst.actionId,
    }).then(
      (result) => { for (const waiter of burst.waiters) waiter.resolve(result); },
      (error) => { for (const waiter of burst.waiters) waiter.reject(error); },
    );
  }
  function queueTextInsert(command, send) {
    if (TEXT_BURST_IDLE_MS === 0) return queueAuthoringMutation(command, send);
    // A caller-supplied mutation ID names exactly that command for durable
    // idempotency. Combining it with another command would make retries either
    // conflict with the changed payload or duplicate the later characters.
    // Only calls whose identity will be minted internally at dispatch time may
    // share one typing-burst command.
    if (command.mutationId !== undefined && command.mutationId !== null) {
      flushOpenInsertBurst();
      return queueAuthoringMutation(command, send);
    }
    const burst = openInsertBurst;
    const contiguous = burst
      && burst.command.at?.affinity === command.at?.affinity
      && command.at?.offset === burst.command.at?.offset + burst.command.text.length;
    if (!contiguous) flushOpenInsertBurst();
    const promise = new Promise((resolve, reject) => {
      if (contiguous) {
        if (applyQueuedTextCommand(queuedDocumentText ?? session.snapshot?.text ?? '', command, burst.actionId) == null) {
          reject(new TypeError('annotated text position splits a surrogate pair'));
          return;
        }
        burst.command = { ...burst.command, text: burst.command.text + command.text };
        burst.waiters.push({ resolve, reject });
        publishAnnotatedDocument();
        armInsertBurst(burst);
        return;
      }
      const capturedBasis = queuedDocumentText ?? session.snapshot?.text ?? '';
      const burstActionId = mintActionId();
      if (applyQueuedTextCommand(capturedBasis, command, burstActionId) == null) {
        reject(new TypeError('annotated text position splits a surrogate pair'));
        return;
      }
      queuedAuthoringMutations += 1;
      publishAnnotatedDocument();
      openInsertBurst = {
        command: { ...command }, send, capturedBasis, actionId: burstActionId,
        waiters: [{ resolve, reject }],
        startedAt: Date.now(), timer: null,
      };
      armInsertBurst(openInsertBurst);
    });
    return promise;
  }
  function cancelOpenInsertBurst() {
    const burst = openInsertBurst;
    if (!burst) return;
    openInsertBurst = null;
    if (burst.timer) clearTimeout(burst.timer);
    queuedAuthoringMutations -= 1;
    if (queuedAuthoringMutations === 0) {
      queuedDocumentText = null;
      replayPendingDisplayEdits([]);
    }
    const result = { ok: false, failure: new ClientClosedError('Annotated text document is unavailable') };
    for (const waiter of burst.waiters) waiter.resolve(result);
    publishAnnotatedDocument();
  }
  async function dispatchNow(command, actionId) {
    if (!session.snapshot || !snapshotBinding.authoring) throw new ClientClosedError('Annotated text document is unavailable');
    const tokenAt = (value) => {
      if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new TypeError('annotated text position is invalid');
      if (value.affinity !== 'left' && value.affinity !== 'right') throw new TypeError('annotated text position requires an affinity');
      return { positionToken: snapshotBinding.authoring.documentPositionToken, offset: value.offset, affinity: value.affinity };
    };
    const translated = { ...command, id: documentId, authoring: { version: 1, stream: snapshotBinding.authoring.stream, lease: snapshotBinding.authoring.lease, mutationId: command.mutationId ?? randomToken() } };
    if (command.at) translated.at = tokenAt(command.at);
    if (command.from) translated.from = tokenAt(command.from);
    if (command.to) translated.to = tokenAt(command.to);
    const action = annotatedTextAction(entity, field, translated);
    translatedActions += 1;
    try {
      return await session.dispatch(action.type, action.payload, actionId === undefined ? undefined : { actionId });
    } finally {
      translatedActions -= 1;
      flushAuthoringAcknowledgements();
    }
  }
  const annotatedSurface = {
    get document() { return currentAnnotatedDocument(); },
    get family() { return displayFamily ?? familyReplica; },
    recoverFromUnresolvableRange,
    get history() { return session.history; },
    get status() { return session.status; },
    get ready() { return session.ready; },
    insert({ mutationId, at, text }) {
      const command = { kind: 'text.insert', mutationId, at, text };
      return queueTextInsert(command, (current, actionId) => dispatchNow(current, actionId));
    },
    delete({ mutationId, from, to }) {
      flushOpenInsertBurst();
      const command = { kind: 'text.delete', mutationId, from, to };
      return queueAuthoringMutation(command, (current, actionId) => dispatchNow(current, actionId));
    },
    paste({ mutationId, at, text, annotation }) {
      // An annotation-bearing paste is its own semantic operation: it must
      // never coalesce into a typing burst (the burst combiner only carries
      // { at, text } and would drop the annotation sidecar). The server mints
      // the fresh annotation id; the client projects the text immediately and
      // the annotation arrives on the confirmed echo.
      flushOpenInsertBurst();
      if (!at || typeof at !== 'object' || !Number.isSafeInteger(at.offset) || at.offset < 0
        || (at.affinity !== 'left' && at.affinity !== 'right')) {
        return Promise.resolve({ ok: false, failure: new TypeError('annotated text paste requires a valid at position') });
      }
      if (typeof text !== 'string' || text.length === 0) {
        return Promise.resolve({ ok: false, failure: new TypeError('annotated text pasted text must be non-empty') });
      }
      if (!annotation || typeof annotation !== 'object'
        || typeof annotation.family !== 'string' || annotation.family.length === 0
        || (annotation.fields !== undefined && (typeof annotation.fields !== 'object' || annotation.fields === null || Array.isArray(annotation.fields)))) {
        return Promise.resolve({ ok: false, failure: new TypeError('annotated text paste requires an annotation family') });
      }
      const command = { kind: 'annotation.paste', mutationId, at, text, annotation: { family: annotation.family, ...(annotation.fields ? { fields: { ...annotation.fields } } : {}) } };
      return queueAuthoringMutation(command, (current, actionId) => dispatchNow(current, actionId));
    },
    replace(input) {
      flushOpenInsertBurst();
      if (!input || typeof input !== 'object') return { ok: false, failure: new TypeError('annotated text replace requires from, to, and text') };
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
        ? queueTextInsert(command, (current, actionId) => dispatchNow(current, actionId))
        : queueAuthoringMutation(command, (current, actionId) => dispatchNow(current, actionId));
    },
    applyAnnotation({ mutationId, annotation, from, to }) {
      flushOpenInsertBurst();
      const command = { kind: 'annotation.apply', mutationId, annotation, from, to };
      // The apply is ALWAYS dispatched as a token-based v9 authoring action;
      // the server anchors the authoring offsets authoritatively. A locally
      // resolvable family is a best-effort enhancement that lets the optimistic
      // placeholder anchor to recipient-v2 endpoints once and keep them
      // positional across a concurrent foreign fold. Without one (family-less /
      // v1 offset recipients) no anchored basis is captured and the offset-form
      // optimistic projection / confirmed echo reconciles the view instead.
      const resolved = resolvePendingAnnotationRange(displayFamily ?? familyReplica, annotation, from, to);
      // Mint the action identity up front and key the captured range by it, so
      // the optimistic projector looks it up and settlement retires it by the
      // SAME operation identity (not annotation id, which is not unique).
      const actionId = mintActionId();
      if (resolved !== null) {
        pendingAnnotationRanges.set(actionId, Object.freeze({ annotationId: annotation.id, range: resolved }));
      }
      return queueAuthoringMutation(command, (current, actionId) => dispatchNow(current, actionId), { actionId });
    },
    applyAnnotationAction(actionHandle, { mutationId, from, to, values }) {
        if (!actionHandle || (actionHandle.kind !== 'annotationEntityAction' && actionHandle.kind !== 'annotationAction') || typeof actionHandle.actionName !== 'string') {
          throw new TypeError('annotated text action handle is invalid');
        }
        const annotationHandle = field.annotations?.[actionHandle.family];
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
      const actionId = pendingAnnotationActionIds.get(mutationId) ?? mintActionId();
      const annotation = Object.freeze({ id: actionId, family: actionHandle.family, fields: { [actionHandle.relation]: actionId } });
      pendingAnnotationActionIds.set(mutationId, actionId);
      const command = { kind: 'annotation.apply', mutationId, annotation, from, to, values };
      const resolvedRange = resolvePendingAnnotationRange(displayFamily ?? familyReplica, annotation, from, to);
      if (resolvedRange !== null) pendingAnnotationRanges.set(actionId, { kind: 'annotationEntityAction', annotation, range: resolvedRange });
      return queueAuthoringMutation(command, async (current) => {
         if (!session.snapshot || !snapshotBinding.authoring) throw new ClientClosedError('Annotated text document is unavailable');
         const action = {
            type: `${entity.name}.${field.fieldName}.${actionHandle.family}.${actionHandle.actionName}`,
           payload: Object.freeze({ version: 1, id: documentId, basis: snapshotBinding.authoring.documentPositionToken, mutationId: current.mutationId, from: current.from?.offset, to: current.to?.offset, values: Object.freeze({ ...(current.values ?? {}) }) }),
         };
         translatedActions += 1;
          try { return await session.dispatch(action.type, action.payload, { actionId }); }
         finally { translatedActions -= 1; flushAuthoringAcknowledgements(); }
       });
     },
    removeAnnotationEntity(actionHandle, { mutationId, annotationId, relatedId, expected }) {
      if (!actionHandle || actionHandle.kind !== 'annotationEntityRemoveAction' || typeof actionHandle.actionName !== 'string') {
        throw new TypeError('annotated text action handle is invalid');
      }
      const annotationHandle = field.annotations?.[actionHandle.family];
      const expectedHandle = annotationHandle?.actions?.[actionHandle.actionName];
      if (!annotationHandle || expectedHandle !== actionHandle) throw new TypeError('annotated text action handle is not declared by this document');
      if (typeof mutationId !== 'string' || mutationId.length === 0
        || typeof annotationId !== 'string' || annotationId.length === 0
        || typeof relatedId !== 'string' || relatedId.length === 0
        || typeof expected !== 'string' || expected.length === 0) throw new TypeError('annotated text removal input is invalid');
      flushOpenInsertBurst();
      // The annotation disappears optimistically; retire any captured range
      // anchored to it (the map is keyed by action identity, so scan entries).
      for (const [pendingActionId, entry] of pendingAnnotationRanges) {
        if (entry.annotationId === annotationId) pendingAnnotationRanges.delete(pendingActionId);
      }
      // Retain the envelope identity by mutation id so an uncertain retry
      // reuses the same durable receipt (mirrors the compose action).
      const actionId = pendingAnnotationActionIds.get(mutationId) ?? mintActionId();
      pendingAnnotationActionIds.set(mutationId, actionId);
      pendingAnnotationRanges.set(actionId, { kind: 'annotationEntityRemoveAction', annotationId });
      return queueAuthoringMutation({ kind: 'annotation.remove', mutationId, annotationId }, async () => {
        if (!session.snapshot || !snapshotBinding.authoring) throw new ClientClosedError('Annotated text document is unavailable');
        const action = {
          type: `${entity.name}.${field.fieldName}.${actionHandle.family}.${actionHandle.actionName}`,
          payload: Object.freeze({ version: 1, id: documentId, mutationId, annotationId, relatedId, expected }),
        };
        translatedActions += 1;
        try { return await session.dispatch(action.type, action.payload, { actionId }); }
        finally { translatedActions -= 1; flushAuthoringAcknowledgements(); }
      }, { actionId });
    },
    removeAnnotation({ mutationId, annotationId }) {
      flushOpenInsertBurst();
      // Retire any captured range for removed annotations by annotation id (the
      // map is keyed by action identity, so scan for matching entries).
      for (const [actionId, entry] of pendingAnnotationRanges) {
        if (entry.annotationId === annotationId) pendingAnnotationRanges.delete(actionId);
      }
      const command = { kind: 'annotation.remove', mutationId, annotationId };
      return queueAuthoringMutation(command, (current, actionId) => dispatchNow(current, actionId));
    },
    reconnect: () => session.reconnect(),
    // Subscribe delivers the same document view the session.document getter
    // exposes. The underlying delivery publishes the raw blockless recipient
    // snapshot; listeners also receive locally queued text projections.
    subscribe(listener) {
      documentListeners.add(listener);
      listener(currentAnnotatedDocument());
      return () => documentListeners.delete(listener);
    },
    close: () => closeAnnotatedSession(),
  };
  if (caretsOption != null) {
    annotatedSurface.publishCaret = function publishCaret({ offset, selection } = {}) {
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new TypeError('annotated text caret offset must be a non-negative safe integer');
      }
      if (selection !== undefined && (typeof selection !== 'object' || selection === null || Array.isArray(selection))) {
        throw new TypeError('annotated text caret selection must be a { from, to } range');
      }
      if (!caretChannel) return false;
      return caretChannel.updateCaret({
        entity: entity.name, id: documentId, field: field.fieldName, offset,
        ...(selection === undefined ? {} : { selection }),
      });
    };
    annotatedSurface.clearCaret = function clearCaret() {
      if (!caretChannel) return false;
      return caretChannel.clearCaret({ entity: entity.name, id: documentId, field: field.fieldName });
    };
    annotatedSurface.onCaret = function onCaret(listener) {
      if (typeof listener !== 'function') throw new TypeError('annotated text caret listener must be a function');
      caretListeners.add(listener);
      return () => caretListeners.delete(listener);
    };
  }
  return Object.freeze(annotatedSurface);
}

function annotatedDocumentView(snapshot) {
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
      resync().catch(() => {});
      return { status: 'gap', expectedSeq: cursor + 1, receivedSeq: event.seqSpan?.[0] ?? event.seq };
    }

    baseSnapshot = fold(baseSnapshot, event);
    cursor = decision.cursor;
    const ownOperation = event.actionId ? operations.get(event.actionId) : null;
    if (ownOperation) {
      ownOperation.echoCursor = cursor;
      // A committed echo for this actionId proves the action committed, so it
      // reconciles the operation even when it was retained as an
      // outcome-unknown placeholder (delivered is false) after a transport throw.
      const reconcile = ownOperation.delivered || ownOperation.status === 'failed';
      if (reconcile && shouldReconcile(ownOperation, { confirmedCursor: ownOperation.confirmedCursor, echoCursor: cursor })) {
        operations.delete(event.actionId);
      }
    }
    publish();
    return { status: ownOperation ? 'confirmed' : 'applied', cursor };
  }

  function queueOrIngest(event) {
    if (!ready || resyncPromise) queued.push(event);
    else ingest(event);
  }

  async function resync() {
    if (closed) return;
    if (resyncPromise) return resyncPromise;
    resyncPromise = (async () => {
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
    })();
    let succeeded = false;
    try {
      await resyncPromise;
      succeeded = true;
      resyncAttempt = 0;
    } catch {
      scheduleResync();
    } finally {
      resyncPromise = null;
    }
    if (!succeeded) return;
    const held = queued.splice(0);
    for (const event of held) ingest(event);
  }

  function scheduleResync() {
    if (closed || resyncRetryTimer) return;
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
    const held = queued.splice(0);
    for (const event of held) ingest(event);
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
      if (resyncRetryTimer) clearTimeout(resyncRetryTimer);
      void resolvedChannel.unsubscribeScope(scope);
      resolvedChannel.close();
      listeners.clear();
      queued.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// createAuthClient — register/login/logout against the framework's `/auth` battery.
// ---------------------------------------------------------------------------
//
// Thin fetch wrappers over `/auth/register`, `/auth/login`, and `/auth/logout` with
// `credentials: 'include'` so the browser sends and stores the fail-closed
// `sid` cookie the server sets on registration or login. The token lives in the cookie, never
// client JS (HttpOnly), so the client never holds a credential it can leak.
// Independent of the live-store machinery — a page may auth before subscribing.
// `login` returns the parsed JSON body (`{ user: { id, username } }`); both
// throw on a non-2xx response with the server's error message.

export function createAuthClient({ baseUrl, fetchImpl } = {}) {
  const fetchFn = fetchImpl ?? globalThis.fetch;

  async function authenticate(intent, username, password) {
    const res = await fetchFn(`${baseUrl}/auth/${intent}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const decoded = await decodeResult(res);
    if (!decoded.ok) throw new Error(decoded.failure?.message ?? decoded.error);
    return decoded.value;
  }

  function register(username, password) {
    return authenticate('register', username, password);
  }

  function login(username, password) {
    return authenticate('login', username, password);
  }

  async function logout() {
    const res = await fetchFn(`${baseUrl}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
    const decoded = await decodeResult(res);
    if (!decoded.ok) throw new Error(decoded.failure?.message ?? decoded.error);
    // logout responds 204 with no body; return a plain ok marker for callers.
    return { ok: true };
  }

  return { register, login, logout };
}
