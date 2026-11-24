// workbench-client-live-list-methods-2.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
import { applyTextOp, createTextState, materializeText, restoreTextCheckpoint } from './workbench-annotated-text.mjs';
import { LiveList } from './workbench-client-live-list.mjs';

const LiveListMethods = {
_applyCrud(verb, event, delta) {
    switch (verb) {
      case 'created':
        this._state = { ...event.data };
        this._removed = false;
        if (this._status === 'removed' || this._status === 'buffer-overflow') this._setStatus('idle');
        this._emitChange('patch', { id: event.data?.id ?? this._id, fields: Object.keys(event.data ?? {}) });
        this._ordered = {};
        // Whole-state replacement: pending rematerializations refer to the
        // discarded state object and must not overwrite the new one.
        this._dirtyTextFields.clear();
        break;

      case 'updated': {
        // Copy-on-write: publish a NEW top-level object every applied change so
        // identity-comparing reactive frameworks see the update. Unchanged
        // fields keep their references (structural sharing).
        const next = { ...(this._state ?? {}) };
        if (this._state == null) this._removed = false;
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
            next[key] = event.data[key];
          }
        }
        // Apply per-kind delta for the fields the delta owns (it publishes its
        // own field-level change record), then report the whole-value fields.
        if (delta) {
          this._applyDelta(delta, next);
        }
        this._state = next;
        if (this._status === 'removed') this._setStatus('idle');
        const changedFields = Object.keys(event.data ?? {}).filter(
          (key) => key !== 'id' && !(delta && Object.prototype.hasOwnProperty.call(delta, key)),
        );
        if (changedFields.length > 0) {
          this._emitChange('patch', { id: event.data?.id ?? this._id, fields: changedFields });
        }
        break;
      }

      case 'removed':
        this._state = null;
        this._removed = true;
        this._emitChange('remove', { id: event.data?.id ?? this._id });
        this._setStatus('removed');
        // Nothing may resurrect a field onto a removed row's null state.
        this._dirtyTextFields.clear();
        break;
    }
  },
_applyDelta(delta, state = this._state) {
    const next = state ?? {};
    for (const [field, d] of Object.entries(delta)) {
      if (d == null) continue;
      try {
        if ('set' in d) {
          // Value delta: {set: v}
          next[field] = d.set;
        } else if ('from' in d && 'to' in d) {
          // State delta: {from, to}
          next[field] = d.to;
        } else if ('cells' in d) {
          // Struct delta: {cells: {[name]: {set: v}}}
          const clone = { ...(next[field] ?? {}) };
          for (const [name, cell] of Object.entries(d.cells)) {
            clone[name] = cell.set;
          }
          next[field] = clone;
        } else if ('added' in d || 'removed' in d || 'changed' in d) {
          // Map delta (native storeMapDiff): {added:[], removed:[], changed:[]}
          const m = { ...(next[field] ?? {}) };
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
          next[field] = m;
        }
      } catch {
        // Malformed delta for this field — skip.
      }
    }
    const fields = Object.keys(delta);
    if (fields.length > 0) this._emitChange('patch', { fields, state: next });
  },
_writableState() {
    if (this._state == null || typeof this._state !== 'object') this._state = {};
    else this._state = { ...this._state };
    return this._state;
  },
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
        this._writableState();
        this._state[field] = [...(this._state[field] ?? []), data];
        this._emitChange('patch', { fields: [field] });
        break;

      case 'added':
      case 'changed': {
        // Map add/change — {member, role}
        const m = { ...(this._state?.[field] ?? {}) };
        m[data.member] = data.role;
        this._writableState();
        this._state[field] = m;
        this._emitChange('patch', { fields: [field] });
        break;
      }

      case 'removed': {
        // Disambiguate: 3-part .removed could be map or ordered.
        // data.member → map remove; data.id → ordered remove.
        if ('member' in data) {
          const m = { ...(this._state?.[field] ?? {}) };
          delete m[data.member];
          this._writableState();
          this._state[field] = m;
          this._emitChange('patch', { fields: [field] });
        } else if ('id' in data) {
          this._applyOrderedOp(field, 'removed', data);
        }
        break;
      }
    }
  },
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

    // Expose as the sorted array of item values (new state identity each op).
    this._writableState();
    this._state[field] = this._ordered[field].map(e => e.item);
    this._emitChange('patch', { fields: [field], id: data.id ?? this._id });
  },
_flushDirtyTextFields() {
    if (this._state == null || this._dirtyTextFields.size === 0) return;
    const fields = [...this._dirtyTextFields];
    for (const field of fields) {
      this._rematerializeTextField(field);
    }
    this._dirtyTextFields.clear();
    this._emitChange('patch', { fields });
  },
_rematerializeTextField(field) {
    this._writableState();
    this._state[field] = materializeText(this._textStates[field]);
  },
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
  },
_observeTextReducer(observation) {
    if (!this._onTextReducer) return this._textReducerReady;
    // Persistence determines safe next counters, so observations must run in
    // delivery order and hold readiness until their durable transaction commits.
    this._textReducerReady = this._textReducerReady.then(() => this._onTextReducer(observation));
    return this._textReducerReady;
  },
_render() {
    for (const cb of this._renderCallbacks) {
      try { cb(this.state); } catch { /* swallow render errors */ }
    }
  }
};
for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(LiveListMethods))) {
  descriptor.enumerable = false;
  Object.defineProperty(LiveList.prototype, key, descriptor);
}
