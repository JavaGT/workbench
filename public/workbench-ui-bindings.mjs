// Framework-agnostic reactive bindings for the Workbench client SDK.
//
// Zero external dependencies. Each binding projects the SDK's confirmed state
// plus its optimistic overlay into one immutable value:
//
//   { value, provenance: 'confirmed' | 'projected' | 'unknown', status }
//
// A Solid 2 component wraps a handle in three lines —
//   const [projection, setProjection] = createSignal(handle.get());
//   onMount(() => onCleanup(handle.subscribe(setProjection)));
//   onCleanup(() => handle.destroy());
// — without keeping a second copy of optimistic state. The store remains the
// single write and reconciliation authority; these are read-only projections.

const DEFAULT_CONNECTION_STATUS = 'disconnected';

/**
 * Per-store index of ids that bindings have observed. `bindList(store)` with no
 * id projects every row a UI actually subscribed to; without this registry it
 * would have to reach into the store's private list cache.
 */
const storeIndex = new WeakMap();

function indexFor(store) {
  let index = storeIndex.get(store);
  if (!index) {
    index = { ids: [], watchers: new Set() };
    storeIndex.set(store, index);
  }
  return index;
}

function rememberId(store, id) {
  if (id === undefined || id === null) return;
  const index = indexFor(store);
  if (index.ids.some((known) => String(known) === String(id))) return;
  index.ids.push(id);
  for (const watcher of index.watchers) watcher();
}

function listFor(store, id) {
  if (id === undefined || id === null || typeof store?.subscribe !== 'function') return null;
  return store.subscribe(id);
}

/** Every id a store currently has a LiveList for, plus ids observed by bindings. */
function observedIds(store) {
  const ids = [];
  const seen = new Set();
  const add = (id) => {
    const key = String(id);
    if (seen.has(key)) return;
    seen.add(key);
    ids.push(id);
  };
  if (typeof store?.listIds === 'function') {
    for (const id of store.listIds()) add(id);
  }
  for (const id of indexFor(store).ids) add(id);
  return ids;
}

function overlayFor(store, id) {
  if (id === undefined || id === null || typeof store?.overlayFor !== 'function') return null;
  return store.overlayFor(id);
}

function overlayStatusFor(store, id) {
  if (id === undefined || id === null || typeof store?.overlayStatusFor !== 'function') return null;
  return store.overlayStatusFor(id);
}

function hasField(row, field) {
  return row != null && typeof row === 'object' && Object.prototype.hasOwnProperty.call(row, field);
}

function signatureOf(projection) {
  try {
    return `${projection.status}\u0000${projection.provenance}\u0000${JSON.stringify(projection.value)}`;
  } catch {
    // Non-JSON values cannot be compared structurally; always notify for them.
    return {};
  }
}

/**
 * Build a cached reactive handle. `attach(refresh)` wires the store/channel
 * sources and returns a detach function. Duplicate synchronous notifications
 * (a fold fires onChange, onStatusChange and the store render in one turn)
 * collapse to one subscriber call via the value signature.
 */
function createHandle(compute, attach) {
  const listeners = new Set();
  let destroyed = false;
  let current = compute();
  let signature = signatureOf(current);

  const refresh = () => {
    if (destroyed) return;
    const next = compute();
    const nextSignature = signatureOf(next);
    if (nextSignature === signature) return;
    current = next;
    signature = nextSignature;
    for (const listener of [...listeners]) {
      try { listener(current); } catch { /* isolate consumers */ }
    }
  };

  const detach = attach(refresh);

  const handle = {
    get() { return current; },
    subscribe(fn) {
      if (typeof fn !== 'function') throw new TypeError('subscriber must be a function');
      if (destroyed) return () => {};
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      detach();
    },
  };
  return { handle, refresh };
}

function attachStore(handleRefresh, store, field, source) {
  const unsubs = [];
  if (typeof store?.onRender === 'function') {
    unsubs.push(store.onRender(handleRefresh));
  }
  if (typeof store?.onChange === 'function') {
    unsubs.push(store.onChange((change) => {
      if (field === undefined || !change?.fields || change.fields.includes(field)) handleRefresh();
    }));
  }
  if (typeof store?.onStatusChange === 'function') {
    unsubs.push(store.onStatusChange(handleRefresh));
  }
  if (source && typeof source.onChange === 'function') {
    unsubs.push(source.onChange((change) => {
      if (field === undefined || !change?.fields || change.fields.includes(field)) handleRefresh();
    }));
  }
  if (source && typeof source.onStatusChange === 'function') {
    unsubs.push(source.onStatusChange(handleRefresh));
  }
  return () => { for (const unsub of unsubs) unsub(); };
}

function aggregateStatus(statuses) {
  if (statuses.has('buffer-overflow')) return 'buffer-overflow';
  if (statuses.has('stale')) return 'stale';
  if (statuses.has('resyncing')) return 'resyncing';
  if (statuses.has('bootstrapping')) return 'bootstrapping';
  if (statuses.size === 0 || statuses.has('idle')) return 'idle';
  return 'removed';
}

/**
 * Bind one field of one row. The projected value is the optimistic overlay
 * value while that overlay is pending, then the authoritative LiveList value;
 * provenance tells a component which one it is rendering.
 */
export function bindField(store, options = {}) {
  const { id, field } = options;
  if (id === undefined || id === null) throw new TypeError('bindField requires an id');
  if (typeof field !== 'string' || field.length === 0) throw new TypeError('bindField requires a field');
  rememberId(store, id);
  const list = listFor(store, id);

  const compute = () => {
    const overlay = overlayFor(store, id);
    const status = overlayStatusFor(store, id);
    const state = list ? list.state : null;
    if (status?.status === 'pending' && hasField(overlay, field)) {
      return { value: overlay[field], provenance: 'projected', status: 'pending' };
    }
    if (hasField(state, field)) {
      return { value: state[field], provenance: 'confirmed', status: list?.status ?? 'idle' };
    }
    if (hasField(overlay, field)) {
      // Confirmed overlay awaiting the list fold is still optimistic evidence.
      return { value: overlay[field], provenance: 'projected', status: list?.status ?? 'idle' };
    }
    return { value: undefined, provenance: 'unknown', status: list?.status ?? 'idle' };
  };

  return createHandle(compute, (refresh) => attachStore(refresh, store, field, list)).handle;
}

/**
 * Bind a row (optionally just one of its sub-collection fields) when `id` is
 * given, or the collection of every row observed by this store's bindings when
 * it is omitted.
 */
export function bindList(store, options = {}) {
  const { id, field } = options;
  rememberId(store, id);
  const single = id !== undefined && id !== null;
  const list = single ? listFor(store, id) : null;

  const compute = () => {
    if (single) {
      const overlay = overlayFor(store, id);
      const status = overlayStatusFor(store, id);
      const state = list ? list.state : null;
      let value = state;
      let provenance = state == null ? 'unknown' : 'confirmed';
      if (status != null && overlay != null) {
        // An overlay exists only while the store still treats it as evidence;
        // it is not authoritative until the live fold lands and clears it.
        value = field === undefined ? overlay : (hasField(overlay, field) ? overlay[field] : state?.[field]);
        provenance = 'projected';
      } else if (field !== undefined) {
        value = hasField(state, field) ? state[field] : undefined;
        provenance = value === undefined ? 'unknown' : 'confirmed';
      }
      return { value, provenance, status: list?.status ?? 'idle' };
    }

    const rows = [];
    const statuses = new Set();
    let projected = false;
    let any = false;
    for (const key of observedIds(store)) {
      const rowList = listFor(store, key);
      const overlay = overlayFor(store, key);
      const status = overlayStatusFor(store, key);
      const state = rowList ? rowList.state : null;
      if (rowList) statuses.add(rowList.status);
      if (state != null || overlay != null) any = true;
      let row = state;
      if (status != null && overlay != null) {
        row = overlay;
        projected = true;
      }
      if (row == null) continue;
      if (field === undefined) rows.push(row);
      else if (hasField(row, field)) rows.push(row[field]);
    }
    return {
      value: rows,
      provenance: projected ? 'projected' : (any ? 'confirmed' : 'unknown'),
      status: aggregateStatus(statuses),
    };
  };

  return createHandle(compute, (refresh) => {
    const unsubs = attachStore(refresh, store, field, list);
    if (!single) indexFor(store).watchers.add(refresh);
    return () => {
      unsubs();
      if (!single) indexFor(store).watchers.delete(refresh);
    };
  }).handle;
}

/**
 * Bind an action declaration. `dispatch()` funnels through the store's one
 * mutation path; the projection exposes the last outcome and whether an
 * optimistic overlay is still outstanding.
 */
export function bindAction(store, options = {}) {
  const { id, action, payload } = options;
  if (typeof action !== 'string' || action.length === 0) throw new TypeError('bindAction requires an action type');
  rememberId(store, id);
  const list = listFor(store, id);
  let result = null;

  const compute = () => {
    const overlayStatus = overlayStatusFor(store, id);
    let status = result ? (result.ok ? 'confirmed' : 'failed') : 'idle';
    let provenance = result ? (result.ok ? 'confirmed' : 'unknown') : 'unknown';
    if (overlayStatus?.status === 'pending') {
      status = 'pending';
      provenance = 'projected';
    } else if (overlayStatus?.status === 'confirmed') {
      status = 'confirmed';
      provenance = 'confirmed';
    }
    return { value: result, provenance, status };
  };

  const { handle, refresh } = createHandle(compute, (notify) => attachStore(notify, store, undefined, list));
  handle.dispatch = async (overridePayload) => {
    const body = { ...(payload ?? {}) };
    if (id !== undefined && id !== null) body.id = id;
    if (overridePayload !== undefined) Object.assign(body, overridePayload);
    result = await store.dispatch(action, body);
    refresh();
    return result;
  };
  return handle;
}

/** Bind a LiveChannel's connection lifecycle into the same handle shape. */
export function bindConnection(channel) {
  if (!channel || typeof channel.onConnectionChange !== 'function') {
    throw new TypeError('bindConnection requires a channel with onConnectionChange');
  }
  let value = typeof channel.status === 'string' ? channel.status : DEFAULT_CONNECTION_STATUS;
  const compute = () => ({ value, provenance: 'confirmed', status: value });
  return createHandle(compute, (refresh) => {
    const unsub = channel.onConnectionChange((status) => {
      value = status;
      refresh();
    });
    return () => { unsub(); };
  }).handle;
}
