// workbench-client-live-sync.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { ClientClosedError, normalizeSubscribeArgs, subscribeEnvelope } from './workbench-client-core.mjs';
import { createActor, createMachine } from './workbench-client-vendor-xstate.mjs';

const compatStateEvents = {
  FORCE_STATE: ({ event }) => (
    ['idle', 'connecting', 'online', 'backoff'].includes(event.state)
      ? { target: event.state }
      : undefined
  ),
  SET_GENERATION: ({ context, event }) => ({
    context: { ...context, generation: event.generation },
  }),
  SET_RECONNECT_ATTEMPT: ({ context, event }) => ({
    context: { ...context, reconnectAttempt: event.reconnectAttempt },
  }),
};

const liveSyncLifecycleMachine = createMachine({
  id: 'liveSyncLifecycle',
  initial: 'idle',
  context: {
    generation: 0,
    reconnectAttempt: 0,
  },
  states: {
    idle: {
      on: {
        ...compatStateEvents,
        CONNECT: ({ context }) => ({
          target: 'connecting',
          context: { ...context, generation: context.generation + 1 },
        }),
        SCHEDULE_RECONNECT: ({ context }) => ({
          context: { ...context, reconnectAttempt: context.reconnectAttempt + 1 },
        }),
        CLEAR_RECONNECT: ({ context }) => ({
          context: { ...context, reconnectAttempt: 0 },
        }),
        BEGIN_CLOSE: ({ context }) => ({
          target: 'closing',
          context: { ...context, generation: context.generation + 1, reconnectAttempt: 0 },
        }),
      },
    },
    connecting: {
      on: {
        ...compatStateEvents,
        OPENED: ({ context, event }) => (
          event.generation === context.generation
            ? { target: 'online', context: { ...context, reconnectAttempt: 0 } }
            : undefined
        ),
        CONNECT_FAILED: ({ context, event }) => (
          event.generation === context.generation
            ? { target: 'idle' }
            : undefined
        ),
        SOCKET_RETIRED: ({ context, event }) => (
          event.generation === context.generation
            ? { target: 'backoff', context: { ...context, generation: context.generation + 1 } }
            : undefined
        ),
        CLEAR_RECONNECT: ({ context }) => ({
          context: { ...context, reconnectAttempt: 0 },
        }),
        BEGIN_CLOSE: ({ context }) => ({
          target: 'closing',
          context: { ...context, generation: context.generation + 1, reconnectAttempt: 0 },
        }),
      },
    },
    online: {
      on: {
        ...compatStateEvents,
        SOCKET_RETIRED: ({ context, event }) => (
          event.generation === context.generation
            ? { target: 'backoff', context: { ...context, generation: context.generation + 1 } }
            : undefined
        ),
        CLEAR_RECONNECT: ({ context }) => ({
          context: { ...context, reconnectAttempt: 0 },
        }),
        BEGIN_CLOSE: ({ context }) => ({
          target: 'closing',
          context: { ...context, generation: context.generation + 1, reconnectAttempt: 0 },
        }),
      },
    },
    backoff: {
      on: {
        ...compatStateEvents,
        CONNECT: ({ context }) => ({
          target: 'connecting',
          context: { ...context, generation: context.generation + 1 },
        }),
        SCHEDULE_RECONNECT: ({ context }) => ({
          context: { ...context, reconnectAttempt: context.reconnectAttempt + 1 },
        }),
        CLEAR_RECONNECT: ({ context }) => ({
          context: { ...context, reconnectAttempt: 0 },
        }),
        BEGIN_CLOSE: ({ context }) => ({
          target: 'closing',
          context: { ...context, generation: context.generation + 1, reconnectAttempt: 0 },
        }),
      },
    },
    closing: {
      on: {
        CLEAR_RECONNECT: ({ context }) => ({
          context: { ...context, reconnectAttempt: 0 },
        }),
        FINISH_CLOSE: () => ({
          target: 'closed',
        }),
      },
    },
    closed: {},
  },
});

export class LiveSyncSession {constructor(baseUrl, options = {}) {
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
    this._lifecycle = createActor(liveSyncLifecycleMachine).start();
    this._connecting = null;
    this._reconnectTimer = null;
    this._maxBackoff = options.maxBackoff ?? 5000;
    this._backoffBase = options.backoffBase ?? 200;
    this._connCallbacks = new Set();
    // The latest volatile caret position (if any) while the socket is offline.
    // Replays after a reconnect so a caret move during a reconnect window is
    // not silently dropped; a clear supersedes it.
    this._pendingCaret = null;
  }

  get _state() {
    return this._lifecycle.getSnapshot().value;
  }

  set _state(value) {
    this._lifecycle.send({ type: 'FORCE_STATE', state: value });
  }

  get _closed() {
    const state = this._lifecycle.getSnapshot().value;
    return state === 'closing' || state === 'closed';
  }

  get _generation() {
    return this._lifecycle.getSnapshot().context.generation;
  }

  set _generation(value) {
    this._lifecycle.send({ type: 'SET_GENERATION', generation: value });
  }

  get _reconnectAttempt() {
    return this._lifecycle.getSnapshot().context.reconnectAttempt;
  }

  set _reconnectAttempt(value) {
    this._lifecycle.send({ type: 'SET_RECONNECT_ATTEMPT', reconnectAttempt: value });
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
    this._lifecycle.send({ type: 'BEGIN_CLOSE' });
    this._clearReconnect();
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
    this._lifecycle.send({ type: 'FINISH_CLOSE' });
    this._lifecycle.stop();
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
}
