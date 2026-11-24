// workbench-client-live-list-methods-1.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { HANDLED_CRUD_VERBS, HANDLED_FIELD_OPS, MAX_RESYNC_ATTEMPTS, backoffDelay, decideReplay, isPlainJsonObject, normalizeSeqSpan } from './workbench-client-core.mjs';
import { LiveList } from './workbench-client-live-list.mjs';

const LiveListMethods = {
_onCheckpoint(currentSeq) {
    if (this._closed || !this._ready || currentSeq <= this._cursor) return;
    this._resync().catch(() => {});
  },
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
  },
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
  },
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
      // Never silently drop: the overflow is observable and forces a resnapshot.
      this._setStatus('buffer-overflow');
      return;
    }
    if (!this._bufferOverflow) this._queue.push(envelope);
  },
_normalizeLive(envelope) {
    const event = envelope?.event;
    return {
      seq: envelope.seq,
      seqSpan: envelope.seqSpan,
      // Carry the frame's identity onto the event so canFold can reject a
      // malformed or foreign-entity frame before any cursor advance.
      event: event && typeof event === 'object' && !Array.isArray(event)
        ? {
          ...event,
          entity: envelope.entity ?? event.entity,
          id: envelope.id ?? event.id,
          scope: envelope.scope ?? event.scope,
        }
        : event,
      delta: envelope.delta,
      reducers: envelope.reducers,
    };
  },
_isAnnotatedOperation(event) {
    if (typeof event?.type !== 'string') return false;
    const prefix = `${this._entity}.`;
    if (!event.type.startsWith(prefix) || !event.type.endsWith('.operated')) return false;
    const field = event.type.slice(prefix.length, -'.operated'.length);
    return this._state?.[field]?.kind === 'workbench.annotatedText.recipient';
  },
_isEntityRemoval(event) {
    return event?.type === `${this._entity}.removed`;
  },
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
    this._emitChange('remove', { id: this._id });
    this._setStatus('removed');
    return true;
  },
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
      try { this._noteGapFloor(normalizeSeqSpan(seqSpan ?? normalized.seq)[1]); } catch { /* scalar */ }
      this._resync().catch(() => {});
      return;
    }
    if (!this.canFold(event)) {
      // Fail closed: an unhandled or malformed event has no reducer projection. Advancing
      // the cursor here would record a fold that never happened. Keep the
      // envelope buffered and force an authoritative snapshot instead.
      this._bufferEnvelope({ seq: normalized.seq, seqSpan, event, delta, reducers });
      try { this._noteGapFloor(normalizeSeqSpan(seqSpan ?? normalized.seq)[1]); } catch { /* scalar */ }
      this._forceSnapshotRequested = true;
      this._resync(true).catch(() => {});
      return;
    }
    // next — apply and advance cursor to span hi (shared Replay decision)
    this._installTextReducers(reducers);
    this._applyingSeq = decision.cursor;
    try {
      this._applyEvent(event, delta);
    } finally {
      this._applyingSeq = null;
    }
    this._cursor = decision.cursor;
    this._flushDirtyTextFields();
    this._render();
  },
async _resync(forceSnapshot = false) {
    if (this._resyncing) return; // prevent re-entrancy
    this._resyncing = true;
    this._setStatus('resyncing');
    const startCursor = this._cursor;
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
        this._emitChange('remove', { id: this._id });
        this._setStatus('removed');
        this._ordered = {};
        this._textStates = {};
        this._dirtyTextFields.clear();
        this._textReducerReady = Promise.resolve();
        this._bufferOverflow = false;
        this._queue = [];
      } else if (snapshotRequested || this._bufferOverflow || body?.resync === 'stale') {
        // Forced re-bootstrap: fresh snapshot replaces state entirely.
        if (body?.resync === 'stale') this._setStatus('stale');
        const snapRes = await this._fetchImpl(
          this._snapshotUrl(this._entity, this._id),
          { signal: this._abortController.signal },
        );
        const { snapshot, seq, reducers } = await this._decode(snapRes);
        this._assertActive(epoch);
        this._installSnapshot(snapshot, 'resync', seq);
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
            this._applyingSeq = row.seq;
            try {
              this._applyEvent(normalized.event, normalized.delta);
            } finally {
              this._applyingSeq = null;
            }
            // Advance through the shared Replay decision, not a hand-assigned
            // seq. The whole-batch pre-check guarantees this is `next`; a
            // different verdict is a contract violation and fails the batch.
            const decision = decideReplay(this._cursor, normalized.seqSpan);
            if (decision.kind !== 'next') throw new Error('replay batch cursor verdict is not next');
            this._cursor = decision.cursor;
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

    if (this._hasUnresolvedGap()) {
      // An events-since answer with no rows (or a snapshot that still sits
      // below the gap) is NOT progress. Escalate to ONE forced snapshot, then
      // fail closed with capped backoff instead of re-issuing resync from the
      // queue drain forever.
      const progressed = this._cursor > startCursor;
      if (progressed && !snapshotRequested && this._snapshotEscalated) this._snapshotEscalated = false;
      if (!this._snapshotEscalated) {
        this._snapshotEscalated = true;
        await this._resync(true);
        return;
      }
      this._setStatus('stale');
      this._scheduleResync();
      return;
    }

    this._snapshotEscalated = false;
    if (this._forceSnapshotRequested) {
      await this._resync(true);
      return;
    }
    this._resyncAttempt = 0;

    // Drain any envelopes that arrived during the resync. Unfoldable types
    // stay buffered: they are fail-closed blockers, never silent cursor jumps.
    const queue = this._queue;
    this._queue = [];
    for (const envelope of queue) {
      const normalized = this._normalizeLive(envelope);
      if (!this.canFold(normalized.event)) {
        let hi = normalized.seq;
        try { hi = normalizeSeqSpan(normalized.seqSpan ?? normalized.seq)[1]; } catch { /* keep scalar */ }
        if (this._cursor >= hi) continue; // the authoritative snapshot superseded it
        this._queue.push(envelope);
        this._noteGapFloor(hi);
        continue;
      }
      this._ingest(normalized);
    }
    await this._textReducerReady;

    this._flushDirtyTextFields();
    this._render();
    this._setStatus(this._removed ? 'removed' : 'idle');
  },
_noteGapFloor(seq) {
    if (!Number.isFinite(seq)) return;
    this._gapFloor = this._gapFloor == null ? seq : Math.min(this._gapFloor, seq);
  },
_hasUnresolvedGap() {
    let floor = null;
    for (const envelope of this._queue) {
      let span;
      try { span = normalizeSeqSpan(envelope.seqSpan ?? envelope.seq); } catch { continue; }
      const decision = decideReplay(this._cursor, span);
      if (decision.kind === 'gap' || !this.canFold(envelope?.event)) {
        floor = floor == null ? span[1] : Math.min(floor, span[1]);
      }
    }
    // A forced snapshot clears the queue; the remembered floor still tells us
    // whether that snapshot actually covered the gap we escalated for. A
    // non-empty queue with no blocker means the gap was filled by replay, so
    // the floor is obsolete and must not force a needless snapshot.
    if (floor === null && this._queue.length === 0) floor = this._gapFloor;
    if (floor === null || this._cursor >= floor) {
      this._gapFloor = null;
      return false;
    }
    this._gapFloor = floor;
    return true;
  },
_scheduleResync() {
    if (this._closed || this._resyncRetryTimer) return;
    if (this._resyncAttempt >= MAX_RESYNC_ATTEMPTS) {
      this._setStatus('stale');
      return;
    }
    const delay = backoffDelay(this._resyncAttempt, this._resyncBackoffBase, this._maxResyncBackoff);
    this._resyncAttempt++;
    this._resyncRetryTimer = setTimeout(() => {
      this._resyncRetryTimer = null;
      if (!this._closed) this._resync(this._bufferOverflow).catch(() => {});
    }, delay);
    if (typeof this._resyncRetryTimer.unref === 'function') this._resyncRetryTimer.unref();
  },
_isValidHistoricalBatch(rows) {
    let expected = this._cursor + 1;
    for (const row of rows) {
      if (row.seq !== expected) return false;
      if (!this.canFold({ type: row.type, data: row.data })) return false;
      expected += 1;
    }
    return true;
  },
canFold(eventOrType) {
    const type = typeof eventOrType === 'string' ? eventOrType : eventOrType?.type;
    if (typeof type !== 'string') return false;
    const parts = type.split('.');
    if (parts.some((part) => part.length === 0)) return false;
    const crud = parts.length === 2 && HANDLED_CRUD_VERBS.has(parts[1]);
    const fieldOp = parts.length === 3 && HANDLED_FIELD_OPS.has(parts[2]);
    if (!crud && !fieldOp) return false;
    if (typeof eventOrType === 'string') return true;

    const event = eventOrType;
    if (event.entity !== undefined && String(event.entity) !== String(this._entity)) return false;
    if (event.id !== undefined && String(event.id) !== String(this._id)) return false;
    if (event.scope !== undefined && event.scope !== `${this._entity}:${String(this._id)}`) return false;
    if (crud && parts[1] === 'removed') return true;
    return isPlainJsonObject(event.data);
  },
_isKnownEventType(type) { return this.canFold(type); },
_applyEvent(event, delta) {
    if (!this.canFold(event)) return;
    const parts = event.type.split('.');

    if (parts.length === 2) {
      this._applyCrud(parts[1], event, delta);
    } else if (parts.length === 3) {
      this._applyFieldOp(parts[1], parts[2], event);
    }
  },
_installSnapshot(snapshot, kind = 'snapshot', seq = this._cursor) {
    this._state = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? { ...snapshot }
      : snapshot;
    this._emitChange(kind, { seq });
  }
};
for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(LiveListMethods))) {
  descriptor.enumerable = false;
  Object.defineProperty(LiveList.prototype, key, descriptor);
}
