// workbench-client-replica.mjs — browser SDK slice. The public surface is re-exported by
// ./workbench-client.mjs; this module is loaded by the browser over HTTP.
export function replicaUnavailable() {
  return {
    reserve: async () => { throw new Error('durable replica storage is unavailable'); },
    reconcile: async () => { throw new Error('durable replica storage is unavailable'); },
  };
}
export function randomReplicaActor() {
  const bytes = new Uint8Array(16);
  if (!globalThis.crypto?.getRandomValues) throw new Error('secure random replica identity is unavailable');
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function replicaActionId(document, actor, counter) {
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
export function mergeReplicaFrontiers(left, right) {
  const values = new Map(left);
  for (const [actor, counter] of right ?? []) values.set(actor, Math.max(values.get(actor) ?? 0, counter));
  return [...values].sort(([leftActor], [rightActor]) => leftActor.localeCompare(rightActor));
}
