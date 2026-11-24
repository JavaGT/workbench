// workbench-client-live-list.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { ClientClosedError } from './workbench-client-core.mjs';

export class LiveList {constructor({
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
    // Gap escalation state. A snapshot is forced at most once per unresolved
    // gap; if it cannot move the cursor past the buffered gap the list goes
    // stale and retries with capped backoff rather than looping synchronously.
    this._snapshotEscalated = false;
    this._gapFloor = null;
    this._snapshotRequiredSeq = 0;
    this._snapshotRecovery = false;
    this._forceSnapshotRequested = false;
    this._renderCallbacks = new Set();
    // Fine-grained reactive surface (Wave 3). `onChange` publishes path-level
    // fold records so a Solid 2 createStore/reconcile can touch only the fields
    // that actually moved; `onStatusChange` exposes the delivery lifecycle that
    // `_resyncing` and `_bufferOverflow` previously kept private.
    this._changeCallbacks = new Set();
    this._statusCallbacks = new Set();
    this._status = 'idle';
    // Sequence being applied by the current fold. Change records should name
    // the sequence they produce, not the cursor we are about to advance from.
    this._applyingSeq = null;
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

  /**
   * Delivery lifecycle: 'idle' (ready, no active recovery), 'bootstrapping',
   * 'resyncing', 'stale' (server asked for a fresh snapshot), 'removed'
   * (terminal entity removal), or 'buffer-overflow' (the bounded live queue
   * dropped events and a resnapshot is in flight).
   */
  get status() { return this._status; }

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
    this._setStatus('bootstrapping');
    const epoch = this._epoch;

    try {
      // 1. GET snapshot → initial state + cursor
      const snapRes = await this._fetchImpl(
        this._snapshotUrl(this._entity, this._id),
        { signal: this._abortController.signal },
      );
      const { snapshot, seq, reducers } = await this._decode(snapRes);
      this._assertActive(epoch);
      this._installSnapshot(snapshot, 'snapshot', seq);
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
      this._setStatus(this._removed ? 'removed' : 'idle');
      this._readyResolve();
    } catch (err) {
      this._setStatus('stale');
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

  /**
   * Fine-grained fold notifications. Each record is
   * `{ kind, id?, fields?, seq, state }` where `kind` is 'snapshot', 'patch',
   * 'remove' or 'resync' and `fields` names the top-level fields the fold
   * touched. A UI can reconcile only those fields instead of replacing the
   * whole row. Returns an unsubscribe function.
   */
  onChange(cb) {
    this._changeCallbacks.add(cb);
    return () => this._changeCallbacks.delete(cb);
  }

  /** Delivery-status transitions. Returns an unsubscribe function. */
  onStatusChange(cb) {
    this._statusCallbacks.add(cb);
    return () => this._statusCallbacks.delete(cb);
  }

  _setStatus(status) {
    if (this._closed || this._status === status) return;
    this._status = status;
    for (const cb of this._statusCallbacks) {
      try { cb(status); } catch { /* isolate consumers */ }
    }
  }

  /** Publish one path-level change record; `state` is always the live object. */
  _emitChange(kind, { id, fields, seq = this._applyingSeq ?? this._cursor, state = this._state } = {}) {
    if (this._changeCallbacks.size === 0) return;
    const change = { kind, seq, state };
    if (id !== undefined) change.id = id;
    if (fields !== undefined) change.fields = fields;
    for (const cb of this._changeCallbacks) {
      try { cb(change); } catch { /* isolate consumers */ }
    }
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
    this._changeCallbacks.clear();
    this._statusCallbacks.clear();
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
}
