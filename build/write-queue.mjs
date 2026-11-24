// write-queue.ts — THE platform write coordinator (epic scope#23, S1/A5).
//
// Single-writer async mutex with bounded wait and depth. Every platform write
// category must enter through `run` (the one mutex — there is NO second
// mutex); `owned` tells a caller whether it is inside the coordinated turn, so
// a category's entry point can route through the coordinator and a nested call
// joins the current turn instead of interleaving.
//
// The six write categories and their entry points:
//   1. entity writes        — kernel dispatch (http-crud-dispatch / application
//                             runtime) → writeCoordinator.run
//   2. live-state writes    — annotated-text authoring + committed-log
//                             projections inside kernel dispatch → .run
//   3. operational queue    — job-queue.ts mutations (enqueue/claim/heartbeat/
//                             submitResult/updateProgress/cancelJob/reap) →
//                             .run, because they are multi-statement sequences
//                             (read-then-write + live-visibility events); only
//                             registerWorker's genuinely single-statement INSERT
//                             stays outside; operational-consumer sweeps → .run
//   4. plugin index writes  — side-table strategy projections (FTS/ordered)
//                             inside kernel dispatch → .run
//   5. migration writes     — migrations.ts / workbench-migrations.ts boot lane
//                             (DOCUMENTED EXCEPTION, below)
//   6. blob metadata writes — blob-store.ts; upload/discard/reap run inside the
//                             caller's coordinated turn (the /blobs route wraps
//                             upload in .run; pending-blob lifecycle and the
//                             blob reaper sweep inside .run; adopt runs in the
//                             dispatch txn), so they are coordinated by
//                             construction — never their own transaction
//
// One documented single-writer exception (explicitly NOT a second mutex):
//   (i) migrations.ts / workbench-migrations.ts run a stop-the-world boot
//       transaction (begin/commit/rollback via the driver dispatchers) before
//       the app serves, when no concurrent writer can exist.
// The shared-state PRAGMA maintenance seam (src/maintenance.ts) also enters
// through this coordinator so its toggles cannot interleave with writes.

import { AsyncLocalStorage } from 'node:async_hooks';


















export function createWriteQueue({
  maxDepth = 64,
  maxWaitMs = 5000,
  closeTimeoutMs = 5000,
  now = Date.now,
}                    = {})             {
  const ownership = new AsyncLocalStorage                     ();

  // The ONE deadline primitive for bounded waits. `now()` is the clock — wall
  // setTimeout is only the wake-up, so an injected clock that jumps makes the
  // deadline observable without waiting real time. Every exit path cancels the
  // timer, so a close/run that settles early leaves no pending timer behind.
  function onDeadline(ms        , expire            )             {
    const due = now() + ms;
    let timer                            ;
    let done = false;
    const clear = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const check = () => {
      if (done) return;
      clear();
      if (now() >= due) {
        done = true;
        expire();
        return;
      }
      timer = setTimeout(check, Math.max(1, due - now()));
    };
    timer = setTimeout(check, Math.max(1, ms));
    // A fake clock advanced by the test right after scheduling is honoured now
    // rather than at the (longer) wall-clock wake-up.
    queueMicrotask(check);
    return () => { done = true; clear(); };
  }
  let waiters = 0;
  let running = false;
  let closed = false;
  let lock                   = Promise.resolve();

  function invoke(fn               ) {
    const owner = { active: true };
    return Promise.resolve()
      .then(() => ownership.run(owner, fn))
      .finally(() => {
        owner.active = false;
      });
  }

  function run   (fn         )             {
    // Ownership is resolved first: the turn already in flight holds the mutex,
    // so its nested calls join it even after close. Refusing them would fail a
    // write mid-transaction during shutdown instead of letting it finish.
    if (ownership.getStore()?.active) {
      return Promise.resolve().then(fn);
    }
    if (closed) {
      const err = new Error('write queue is closed')                              ;
      err.status = 503;
      return Promise.reject(err);
    }
    if (waiters + 1 >= maxDepth) {
      const err = new Error('write queue: depth limit exceeded')                              ;
      err.status = 503;
      return Promise.reject(err);
    }

    if (!running && waiters === 0) {
      running = true;
      let releaseNext            ;
      const completion = new Promise      ((r) => {
        releaseNext = r;
      });

      const result = invoke(fn);
      const wrapped = result.finally(() => {
        running = false;
        releaseNext();
      });
      lock = completion;
      return wrapped              ;
    }

    waiters++;

    let cancelled = false;
    let acquired = false;
    let releaseNext            ;
    const completion = new Promise      ((r) => {
      releaseNext = r;
    });

    const waitForLock = new Promise      ((resolve) => {
      lock = lock.then(() => {
        if (cancelled) {
          waiters--;
          releaseNext();
          return;
        }
        acquired = true;
        waiters--;
        running = true;
        resolve();
        return completion;
      });
    });

    let cancelTimeout             = () => {};
    const timeout = new Promise      ((_, reject) => {
      cancelTimeout = onDeadline(maxWaitMs, () => {
        if (!acquired) {
          // Set cancelled and reject fast (client gets 503 immediately). Do NOT
          // decrement `waiters` or releaseNext here — the lock-chain's
          // `if (cancelled)` branch does both, exactly once, when the held lock
          // releases. The waiters counter over-reports a dead waiter until then
          // (fail-closed: maxDepth guard trips earlier under starvation, never
          // later), avoiding the double-decrement drift that weakened it.
          cancelled = true;
          const err = new Error('write queue: wait timeout')                              ;
          err.status = 503;
          reject(err);
        }
      });
    });

    return Promise.race([waitForLock, timeout])
      .finally(() => {
        cancelTimeout();
      })
      .then(
        () => {
          return (invoke(fn)              ).finally(() => {
            running = false;
            releaseNext();
          });
        },
        (err         ) => {
          throw err;
        },
      );
  }

  // Stop admitting new writes and resolve once every already-admitted write has
  // released the mutex. Shutdown uses this to avoid closing durable resources
  // under an in-flight transaction. A finite deadline (configurable at queue
  // creation, overridable per call) means a wedged writer can never pin graceful
  // shutdown forever: the deadline rejects with a 503 instead.
  function close(options                                  )                   {
    closed = true;
    const timeoutMs = typeof options === 'number' ? options : options?.timeoutMs ?? closeTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(new TypeError('write queue close: timeoutMs must be a finite non-negative number'));
    }
    const drained = Promise.resolve(lock).then(() => undefined);
    let cancelTimeout             = () => {};
    const timeout = new Promise         ((_, reject) => {
      cancelTimeout = onDeadline(timeoutMs, () => {
        const err = new Error('write queue: close timed out')                              ;
        err.status = 503;
        reject(err);
      });
    });
    return Promise.race([drained, timeout]).finally(() => cancelTimeout());
  }

  return {
    run,
    close,
    get depth()         {
      return waiters;
    },
    get running()          {
      return running;
    },
    get closed()          {
      return closed;
    },
    get owned()          {
      // True only inside a run() turn (or a nested run joining the current
      // turn). The coordinator-routing red-line and the maintenance seam use
      // this to prove a write category entered through the one coordinator.
      return ownership.getStore()?.active === true;
    },
  };
}

// ---- post-commit lane (the coordinator's nested serialization) --------------
// Post-commit consumers run INSIDE the dispatch turn that holds this mutex.
// Calling `run` from them would join that turn (owned re-entrancy) and let two
// consumers open `BEGIN IMMEDIATE` on the same connection concurrently. This
// lane is therefore part of the ONE coordinator, not a second write mutex: it
// does not acquire the mutex at all, it gives each post-commit DB turn an
// exclusive FIFO slot inside the turn that already holds it. Keyed by the db
// handle, so every consumer of one connection shares the same ordering.
const postCommitTails = new WeakMap                          ();

export function runPostCommitTurn   (db                           , fn                      )             {
  if (!db || typeof db !== 'object') return Promise.resolve().then(fn);
  const previous = postCommitTails.get(db) ?? Promise.resolve();
  const turn = previous.then(fn, fn);
  // The tail never rejects: one consumer's failure must not block the next
  // consumer's transaction or make the fan-out's drain throw.
  postCommitTails.set(db, turn.then(() => undefined, () => undefined));
  return turn;
}

/** Wait until every post-commit DB turn queued on `db` so far has finished. */
export function postCommitTurnsDrained(db                           )                {
  const tail = db && typeof db === 'object' ? postCommitTails.get(db) : undefined;
  return tail ? tail.then(() => undefined) : Promise.resolve();
}
