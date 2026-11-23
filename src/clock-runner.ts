// Shared clock/setInterval setup — schedule.mjs (startClockTriggers) and
// simulate.mjs share timer-driver boilerplate. This extracts the common
// branching (clock.add vs setInterval) + unref + stop pattern.

import { getLog } from './log.ts';

export interface ClockWatcherHandle {
  remove(): void;
}

export interface SharedClock {
  add(options: { name: string; intervalMs: number; fn: (now: number) => unknown }): ClockWatcherHandle;
}

export interface ClockRunnerOptions {
  clock?: SharedClock | null;
  intervalMs: number;
  fn: (now: number) => unknown;
  name: string;
  /** Error sink shared by both driver paths. Defaults to a named system warning. */
  onError?: ((err: unknown) => void) | null;
}

export interface RunnerHandle {
  stop(): void;
}

/**
 * Creates a clock-driven or setInterval-based periodic runner.
 *
 * When a shared clock is provided, registers `fn` as a watcher (single
 * setTimeout with nearest-deadline scheduling). Otherwise starts its own
 * setInterval with `timer.unref()` so the test process exits without leaks.
 *
 * `fn` may be sync or async — errors are caught and forwarded to `onError`
 * (or logged with the runner name) IDENTICALLY on both paths. The shared clock
 * is not trusted to report errors: the runner wraps the callback itself, so a
 * synchronous throw is never silently swallowed and an async rejection never
 * escapes as an unhandled promise (#240).
 */
export function createClockRunner({ clock, intervalMs, fn, name, onError }: ClockRunnerOptions): RunnerHandle {
  const report = (err: unknown): void => {
    if (typeof onError === 'function') onError(err);
    else getLog().warn('system', `${name} tick failed`, { err });
  };

  if (clock) {
    const watcher = clock.add({
      name,
      intervalMs,
      fn(now: number): void {
        let result: unknown;
        try {
          result = fn(now);
        } catch (err) {
          report(err);
          return;
        }
        if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
          // Absorb the rejection after forwarding it: an unhandled rejection
          // would escape the clock's own try/catch (which only covers sync
          // throws) and surface without the runner's identity.
          void Promise.resolve(result).then(undefined, report);
        }
      },
    });
    return { stop() { watcher?.remove(); } };
  }

  const timer = setInterval(() => {
    (async () => {
      try {
        await fn(Date.now());
      } catch (err) {
        report(err);
      }
    })();
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
