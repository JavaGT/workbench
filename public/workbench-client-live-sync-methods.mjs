// workbench-client-live-sync-methods.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { ClientClosedError, backoffDelay, isPlainJsonObject, subscribeEnvelope } from './workbench-client-core.mjs';
import { WorkbenchFailureError, isWorkbenchFailure } from './workbench-client-errors.mjs';
import { LiveSyncSession } from './workbench-client-live-sync.mjs';

const LiveSyncSessionMethods = {
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
  },
_openSocket() {
    if (this._closed) return Promise.reject(new ClientClosedError());
    if (this._socket?.readyState === 1 && this._state === 'online') {
      return Promise.resolve();
    }
    if (this._connecting) return this._connecting;

    this._lifecycle.send({ type: 'CONNECT' });
    // The state machine owns the transition; observers must see it too, or a
    // bindConnection handle misses the first hop of a lazy connection and
    // reports 'disconnected' until the socket finally opens.
    this._emitConnectionStatus('connecting');
    const generation = this._generation;
    const connecting = new Promise((resolve, reject) => {
      let ws;
      try {
        ws = this._socketFactory(this._wsUrl);
      } catch (err) {
        if (generation === this._generation) {
          this._socket = null;
        }
        this._lifecycle.send({ type: 'CONNECT_FAILED', generation });
        reject(err);
        return;
      }
      let settled = false;
      let pollTimer = null;
      let connectTimeout = null;

      const stopTimers = () => {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
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
        this._socket = ws;
        this._lifecycle.send({ type: 'OPENED', generation });
        this._emitConnectionStatus('connected');
        this._reconcileDesired();
        resolve();
      };

      const onError = () => {
        if (settled) return;
        settled = true;
        stopTimers();
        if (generation === this._generation) {
          this._socket = null;
        }
        this._lifecycle.send({ type: 'CONNECT_FAILED', generation });
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
          }
          this._lifecycle.send({ type: 'CONNECT_FAILED', generation });
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
  },
_retireSocket(ws, generation) {
    if (this._closed || generation !== this._generation) return;
    if (this._socket === ws) this._socket = null;
    this._lifecycle.send({ type: 'SOCKET_RETIRED', generation });
    this._subRequests.clear();
    for (const sub of this._subs.values()) {
      sub.sentGeneration = 0;
      sub.requestId = undefined;
    }
    this._emitConnectionStatus('disconnected');
    try {
      if (ws.readyState < 2) ws.close();
    } catch { /* ignore */ }
    this._scheduleReconnect();
  },
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
  },
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
  },
_reconcileDesired() {
    for (const key of this._subs.keys()) this._sendSubscription(key);
  },
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
  },
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
  },
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
  },
_scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    this._emitConnectionStatus('reconnecting');
    const delay = backoffDelay(this._reconnectAttempt, this._backoffBase, this._maxBackoff);
    this._lifecycle.send({ type: 'SCHEDULE_RECONNECT' });
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
  },
_clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._lifecycle.send({ type: 'CLEAR_RECONNECT' });
  },
get status() {
    if (this._state === 'online') return 'connected';
    if (this._state === 'connecting') return 'connecting';
    if (this._state === 'backoff' || this._reconnectTimer) return 'reconnecting';
    return 'disconnected';
  },
onConnectionChange(cb) {
    this._connCallbacks.add(cb);
    return () => { this._connCallbacks.delete(cb); };
  },
_emitConnectionStatus(status) {
    for (const cb of this._connCallbacks) {
      try { cb(status); } catch { /* swallow */ }
    }
  }
};
for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(LiveSyncSessionMethods))) {
  descriptor.enumerable = false;
  Object.defineProperty(LiveSyncSession.prototype, key, descriptor);
}
