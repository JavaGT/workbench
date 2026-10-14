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
  now = Date.now,
}                    = {})             {
  void now; // accepted option; timeout still uses wall-clock setTimeout (pre-existing)
  const ownership = new AsyncLocalStorage                     ();
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

    let timeoutId                ;
    const timeout = new Promise      ((_, reject) => {
      timeoutId = setTimeout(() => {
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
      }, maxWaitMs);
    });

    return Promise.race([waitForLock, timeout])
      .finally(() => {
        clearTimeout(timeoutId);
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
  // under an in-flight transaction.
  function close()                   {
    closed = true;
    return Promise.resolve(lock);
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
