// One write coordinator per SQLite handle. Shared low-level seam: external
// modules resolve the attached coordinator without importing the barrel.

import { createWriteQueue,                 } from './write-queue.mjs';

// ---- one write coordinator per SQLite handle -------------------------------
// A db handle has exactly ONE platform mutex. Two `createServer` calls over the
// same handle must never each mint a private mutex: SQLite is single-writer, so
// a second mutex only creates the illusion of coordination while the two queues
// interleave transactions. Key by the handle itself (a WeakMap keeps a closed db
// and its queue collectible together) — the handle identity is more truthful
// than a file location, which two different connections may share.
const attachedWriteQueues = new WeakMap                    ();

/** The write coordinator already attached to a db handle, if any. Testable seam. */
export function writeQueueForDatabase(db                           )                         {
  return db && typeof db === 'object' ? attachedWriteQueues.get(db) : undefined;
}

export function resolveServerWriteQueue(db         , supplied                   )             {
  const key = db && typeof db === 'object' ? db           : null;
  const attached = key ? attachedWriteQueues.get(key) : undefined;
  if (supplied) {
    if (attached && attached !== supplied && !attached.closed) {
      throw new Error(
        'createServer refuses a second write queue on a database handle that already has an attached write coordinator; '
        + 'reuse the attached coordinator (writeQueueForDatabase(db)) instead of creating an uncoordinated mutex',
      );
    }
    if (key) attachedWriteQueues.set(key, supplied);
    return supplied;
  }
  if (attached && !attached.closed) return attached;
  const created = createWriteQueue();
  if (key) attachedWriteQueues.set(key, created);
  return created;
}
