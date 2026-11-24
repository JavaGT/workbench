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
// An owner may instead pass `{ signal }` (from Solid's `onCleanup`) to any
// binding; aborting the signal destroys the handle.

const DEFAULT_CONNECTION_STATUS = 'disconnected';

/**
 * Per-store index of ids that bindings have observed. `bindList(store)` with no
 * id projects every row a UI actually subscribed to; without this registry it
 * would have to reach into the store's private list cache. Ids are ref-counted
 * so destroying one binding cannot evict an id another binding still uses.
 *
 * `lists` holds the LiveList used for an id, and `owned` records which of those
 * lists a binding created. A binding never tears down a subscription the app
 * made itself (e.g. with custom `{ fields }` / `{ pace }`).
 */
const storeIndex = new WeakMap();

function indexFor(store) {
  let index = storeIndex.get(store);
  if (!index) {
    index = { ids: [], counts: new Map(), lists: new Map(), owned: new Set(), watchers: new Set() };
    storeIndex.set(store, index);
  }
  return index;
}

/** Stop the channel subscription and timers a binding created for this id. */
function releaseList(store, id, list) {
  if (typeof store?.release === 'function') {
    store.release(id);
  } else if (typeof store?.unsubscribe === 'function') {
    void store.unsubscribe(id);
  } else if (typeof list?.close === 'function') {
    // A store without a release seam still gets its subscription stopped; the
    // binding never leaves a LiveList polling on its own after the last owner.
    void list.close();
  }
}

function rememberId(store, id) {
  if (id === undefined || id === null) return () => {};
  const index = indexFor(store);
  const key = String(id);
  const prior = index.counts.get(key) ?? 0;
  index.counts.set(key, prior + 1);
  if (prior === 0) {
    index.ids.push(id);
    for (const watcher of index.watchers) watcher();
  }
  return () => {
    const count = index.counts.get(key) ?? 0;
    if (count > 1) {
      index.counts.set(key, count - 1);
      return;
    }
    // Release before notifying watchers: a throwing watcher must not strand a
    // subscription or its retry timer.
    index.counts.delete(key);
    index.ids = index.ids.filter((known) => String(known) !== key);
    const list = index.lists.get(key);
    const owned = index.owned.has(key);
    index.lists.delete(key);
    index.owned.delete(key);
    if (owned && list) releaseList(store, id, list);
    for (const watcher of index.watchers) watcher();
  };
}

/**
 * The LiveList for `id`, reusing an existing one. Calling `subscribe(id)` with
 * empty options on a row the app already subscribed with custom interest
 * throws a conflicting-options error; peeking first avoids that. A list the
 * binding creates is recorded as owned so the last release can tear it down.
 */
function listFor(store, id) {
  if (id === undefined || id === null || typeof store?.subscribe !== 'function') return null;
  const key = String(id);
  const index = indexFor(store);
  if (index.lists.has(key)) return index.lists.get(key);
  const existing = typeof store.listFor === 'function' ? store.listFor(id) : null;
  if (existing) {
    index.lists.set(key, existing);
    return existing;
  }
  let list;
  try {
    list = store.subscribe(id);
  } catch (error) {
    // The store may have gained a list with custom interest between the peek
    // and the subscribe; reuse it rather than failing the binding.
    const raced = typeof store.listFor === 'function' ? store.listFor(id) : null;
    if (raced) {
      index.lists.set(key, raced);
      return raced;
    }
    throw error;
  }
  if (list) {
    index.lists.set(key, list);
    index.owned.add(key);
  }
  return list;
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

/**
 * Canonical key for any JS value, including values `JSON.stringify` rejects
 * (cycles, bigints, symbols, maps, sets, class instances). A failed serialize
 * must not be used as "always different": that would notify subscribers on
 * every store tick for an unchanged non-JSON projection.
 */
function stableKey(value, seen = new Map(), refs = { next: 0 }) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  if (type === 'number') return `number:${Object.is(value, -0) ? '-0' : String(value)}`;
  if (type === 'string' || type === 'boolean') return `${type}:${JSON.stringify(value)}`;
  if (type === 'bigint') return `bigint:${value.toString()}`;
  if (type === 'symbol') return `symbol:${String(value.description)}`;
  if (type === 'function') return `function:${value.name || ''}`;
  if (seen.has(value)) return `@${seen.get(value)}`;
  const ref = ++refs.next;
  seen.set(value, ref);
  try {
    if (value instanceof Date) return `date:${value.getTime()}`;
    if (Array.isArray(value)) {
      return `array(${ref}):[${value.map((child) => stableKey(child, seen, refs)).join(',')}]`;
    }
    if (value instanceof Map) {
      const entries = [...value.entries()].map(
        ([key, child]) => `${stableKey(key, seen, refs)}:${stableKey(child, seen, refs)}`,
      ).sort();
      return `map(${ref}):{${entries.join(',')}}`;
    }
    if (value instanceof Set) {
      const members = [...value.values()].map((child) => stableKey(child, seen, refs)).sort();
      return `set(${ref}):{${members.join(',')}}`;
    }
    const keys = Reflect.ownKeys(value).map((key) => String(key)).sort();
    return `object(${ref}):{${keys.map((key) => `${JSON.stringify(key)}:${stableKey(value[key], seen, refs)}`).join(',')}}`;
  } catch {
    // An exotic proxy or throwing getter cannot be compared structurally; a
    // type-tag marker is still stable across otherwise identical reads.
    return `opaque(${ref}):${Object.prototype.toString.call(value)}`;
  }
}

function signatureOf(projection) {
  return `${projection.status}\u0000${projection.provenance}\u0000${stableKey(projection.value)}`;
}

/**
 * Build a cached reactive handle. `attach(refresh)` wires the store/channel
 * sources and returns a detach function. Duplicate synchronous notifications
 * (a fold fires onChange, onStatusChange and the store render in one turn)
 * collapse to one subscriber call via the value signature.
 *
 * `release` frees per-handle bookkeeping (remembered ids) on destroy, and a
 * supplied `signal` destroys the handle on abort for owner-aware teardown.
 *
 * @param {{ release?: () => void, signal?: AbortSignal }} [options]
 */
function createHandle(compute, attach, options = {}) {
  const { release, signal } = options;
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
      // A throwing watcher inside `release` must never skip the caller's
      // AbortSignal or store listener teardown. Every step still runs.
      try {
        if (release) release();
      } finally {
        try {
          if (onAbort) signal?.removeEventListener('abort', onAbort);
        } finally {
          detach();
        }
      }
    },
  };

  const onAbort = signal ? () => handle.destroy() : null;
  if (signal?.aborted) handle.destroy();
  else if (onAbort && signal) signal.addEventListener('abort', onAbort, { once: true });
  return { handle, refresh };
}

function attachStore(handleRefresh, store, field, source) {
  const unsubs = [];
  // A single fold notifies render, change and status surfaces in one turn.
  // Run the first notification synchronously (so a read right after emit is
  // fresh) and coalesce the rest into one microtask refresh.
  let flushing = false;
  let pending = false;
  const notify = () => {
    if (!flushing) {
      flushing = true;
      try {
        handleRefresh();
      } finally {
        queueMicrotask(() => {
          flushing = false;
          if (pending) {
            pending = false;
            handleRefresh();
          }
        });
      }
      return;
    }
    pending = true;
  };

  if (typeof store?.onRender === 'function') {
    unsubs.push(store.onRender(notify));
  }
  if (typeof store?.onChange === 'function') {
    unsubs.push(store.onChange((change) => {
      if (field === undefined || !change?.fields || change.fields.includes(field)) notify();
    }));
  }
  if (typeof store?.onStatusChange === 'function') {
    unsubs.push(store.onStatusChange(notify));
  }
  if (source && typeof source.onChange === 'function') {
    unsubs.push(source.onChange((change) => {
      if (field === undefined || !change?.fields || change.fields.includes(field)) notify();
    }));
  }
  if (source && typeof source.onStatusChange === 'function') {
    unsubs.push(source.onStatusChange(notify));
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
 * The ONE evidence rule shared by bindField and bindList. Only a pending
 * overlay wins over authoritative state; a confirmed overlay is evidence that
 * the store already has an authoritative answer, so it never outranks that
 * answer on provenance. When the answer has not folded yet the overlay is a
 * projected placeholder, identically for field and row bindings.
 */
function projectValue(store, id, state, field) {
  const overlay = overlayFor(store, id);
  const status = overlayStatusFor(store, id);
  const overlayHasValue = overlay != null && (field === undefined || hasField(overlay, field));
  if (status?.status === 'pending' && overlayHasValue) {
    return { value: field === undefined ? overlay : overlay[field], provenance: 'projected', pending: true };
  }
  if (field === undefined ? state != null : hasField(state, field)) {
    return { value: field === undefined ? state : state[field], provenance: 'confirmed', pending: false };
  }
  if (overlayHasValue) {
    return { value: field === undefined ? overlay : overlay[field], provenance: 'projected', pending: false };
  }
  return { value: undefined, provenance: 'unknown', pending: false };
}

/**
 * Bind one field of one row. The projected value is the optimistic overlay
 * value while that overlay is pending, then the authoritative LiveList value;
 * provenance tells a component which one it is rendering.
 */
export function bindField(store, options = {}) {
  const { id, field, signal } = options;
  if (id === undefined || id === null) throw new TypeError('bindField requires an id');
  if (typeof field !== 'string' || field.length === 0) throw new TypeError('bindField requires a field');
  const release = rememberId(store, id);
  const list = listFor(store, id);

  const compute = () => {
    const projection = projectValue(store, id, list ? list.state : null, field);
    return {
      value: projection.value,
      provenance: projection.provenance,
      status: projection.pending ? 'pending' : (list?.status ?? 'idle'),
    };
  };

  return createHandle(compute, (refresh) => attachStore(refresh, store, field, list), { release, signal }).handle;
}

/**
 * Bind a row (optionally just one of its sub-collection fields) when `id` is
 * given, or the collection of every row observed by this store's bindings when
 * it is omitted.
 */
export function bindList(store, options = {}) {
  const { id, field, signal } = options;
  const release = rememberId(store, id);
  const single = id !== undefined && id !== null;
  const list = single ? listFor(store, id) : null;

  const compute = () => {
    if (single) {
      const projection = projectValue(store, id, list ? list.state : null, field);
      return { value: projection.value, provenance: projection.provenance, status: list?.status ?? 'idle' };
    }

    const rows = [];
    const statuses = new Set();
    let projected = false;
    let any = false;
    for (const key of observedIds(store)) {
      const rowList = listFor(store, key);
      if (rowList) statuses.add(rowList.status);
      const projection = projectValue(store, key, rowList ? rowList.state : null, field);
      if (projection.provenance === 'unknown') continue;
      any = true;
      if (projection.provenance === 'projected') projected = true;
      if (field === undefined || projection.value !== undefined) rows.push(projection.value);
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
  }, { release, signal }).handle;
}

/**
 * Bind an action declaration. `dispatch()` funnels through the store's one
 * mutation path; the projection exposes the last outcome and whether an
 * optimistic overlay is still outstanding.
 */
export function bindAction(store, options = {}) {
  const { id, action, payload, signal } = options;
  if (typeof action !== 'string' || action.length === 0) throw new TypeError('bindAction requires an action type');
  const release = rememberId(store, id);
  const list = listFor(store, id);
  /** @type {any} */
  let result = null;

  const compute = () => {
    const overlayStatus = overlayStatusFor(store, id);
    // A queued receipt is not terminal. Re-read the overlay on every refresh:
    // once the durable completion confirms it, promote the receipt so it stays
    // confirmed even after the authoritative fold releases the overlay.
    if (result?.status === 'queued' && overlayStatus?.status === 'confirmed') {
      result = { ...result, ok: true, status: 'confirmed' };
    }
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

  const { handle, refresh } = createHandle(
    compute,
    (notify) => attachStore(notify, store, undefined, list),
    { release, signal },
  );
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
export function bindConnection(channel, options = {}) {
  if (!channel || typeof channel.onConnectionChange !== 'function') {
    throw new TypeError('bindConnection requires a channel with onConnectionChange');
  }
  const { signal } = options;
  let value = typeof channel.status === 'string' ? channel.status : DEFAULT_CONNECTION_STATUS;
  const compute = () => ({ value, provenance: 'confirmed', status: value });
  return createHandle(compute, (refresh) => {
    const unsub = channel.onConnectionChange((status) => {
      value = status;
      refresh();
    });
    return () => { unsub(); };
  }, { signal }).handle;
}
