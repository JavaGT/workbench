import { openDB } from './workbench-client-vendor-idb.mjs';

const STORE_NAME = 'entries';
const DB_VERSION = 2;

// Outbox rows (#183) live in this SAME entries store — no second IndexedDB
// store. They carry `log: OUTBOX_LOG`, no `seq` (they are not committed
// events, so the byScope event index excludes them), and are ordered by the
// auto-increment primary key: insertion order is the durable queue order.
export const OUTBOX_LOG = 'outbox';

export async function openLocalLog(name) {
  const db = await openDB(`workbench:local:${name}`, DB_VERSION, {
    upgrade(database, _oldVersion, _newVersion, transaction) {
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? transaction.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      if (!store.indexNames.contains('byScope')) {
        store.createIndex('byScope', ['scope', 'seq']);
      }
      if (!store.indexNames.contains('byTimestamp')) {
        store.createIndex('byTimestamp', 'timestamp');
      }
      if (!store.indexNames.contains('byOutboxId')) {
        store.createIndex('byOutboxId', ['log', 'id']);
      }
    },
  });

  async function append(entry) {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const id = await tx.store.add(entry);
    await tx.done;
    return { id, ...entry };
  }

  async function entriesSince(scope, cursor) {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const index = tx.store.index('byScope');
    const range = IDBKeyRange.lowerBound([scope, cursor + 1]);
    const entries = [];
    for (let c = await index.openCursor(range); c; c = await c.continue()) {
      if (c.value.scope !== scope) break;
      entries.push(c.value);
    }
    return entries;
  }

  async function head(scope) {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const index = tx.store.index('byScope');
    const range = IDBKeyRange.bound([scope, 0], [scope, Number.MAX_SAFE_INTEGER]);
    const c = await index.openCursor(range, 'prev');
    return c ? c.value.seq : 0;
  }

  async function prune(beforeTimestamp) {
    let count = 0;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const index = tx.store.index('byTimestamp');
    const range = IDBKeyRange.upperBound(beforeTimestamp - 1, true);
    for (let c = await index.openCursor(range); c; c = await c.continue()) {
      // Pending outbox rows are live client mutations, not history — a
      // timestamp prune must never drop a mutation that has not committed.
      if (c.value.log === OUTBOX_LOG) continue;
      await c.delete();
      count++;
    }
    await tx.done;
    return count;
  }

  // --- Outbox rows (durable client-mutation queue; same entries store) ---

  async function outboxAppend(entry) {
    const row = { ...entry, log: OUTBOX_LOG };
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const id = await tx.store.add(row);
    await tx.done;
    return { id, ...row };
  }

  // All outbox rows in enqueue order (primary key), optionally after a row id.
  async function outboxEntries(afterId = 0) {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const index = tx.store.index('byOutboxId');
    const range = afterId > 0
      ? IDBKeyRange.lowerBound([OUTBOX_LOG, afterId], true)
      : IDBKeyRange.lowerBound([OUTBOX_LOG, 0]);
    const rows = [];
    for (let c = await index.openCursor(range); c; c = await c.continue()) {
      rows.push(c.value);
    }
    return rows;
  }

  async function outboxGet(id) {
    return (await db.get(STORE_NAME, id)) ?? null;
  }

  async function outboxPut(row) {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await tx.store.put({ ...row, log: OUTBOX_LOG });
    await tx.done;
    return true;
  }

  async function outboxDelete(id) {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await tx.store.delete(id);
    await tx.done;
    return true;
  }

  function close() {
    db.close();
  }

  return { append, entriesSince, head, prune, outboxAppend, outboxEntries, outboxGet, outboxPut, outboxDelete, close };
}
