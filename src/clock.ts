// Unified clock — a single setTimeout-based scheduler that wakes only at the
// nearest deadline. All framework reapers migrate onto one timer (the Four
// Clocks in ideation: schedule reaper, tick engine, job-queue reaper, blob
// reaper, log-retention reaper, plus any future watchers).
//
// `add({name,intervalMs,fn,delayMs?})` registers a watcher; auto-schedules
// real timers once `_schedule()` has been called. `stop()` permanently stops
// the clock.
//
// delayMs: first fire at `now + Math.max(delayMs, intervalMs)`. For delayMs=0
// (the default), first fire is one interval from now.
//
// `_tick(ms)` is for tests: deterministic drive without real timers.
// Do NOT call `_schedule()` in test mode.

export interface WatcherOptions {
  name: string;
  intervalMs: number;
  fn: () => void;
  delayMs?: number;
}

interface Watcher {
  name: string;
  intervalMs: number;
  fn: () => void;
  lastFiredAt: number;
}

interface WatcherHandle {
  remove(): void;
}

interface ClockStarter {
  now?: () => number;
}

export interface Clock {
  add(options: WatcherOptions): WatcherHandle;
  _schedule(): void;
  stop(): void;
  _tick(ms: number): void;
}

type TimerLike = ReturnType<typeof setTimeout> & { unref?: () => void };

export function createClock({ now = Date.now }: ClockStarter = {}): Clock {
  let watchers = new Map<string, Watcher>();
  let timer: TimerLike | null = null;
  let stopped = false;
  let started = false;

  function add({ name, intervalMs, fn, delayMs = 0 }: WatcherOptions): WatcherHandle {
    const t = now();
    const firstFire = Math.max(delayMs, intervalMs);
    watchers.set(name, {
      name, intervalMs, fn,
      lastFiredAt: t + firstFire - intervalMs,
    });
    if (started) _scheduleNext(t);
    return {
      remove() {
        watchers.delete(name);
        if (watchers.size === 0) _clearTimer();
      },
    };
  }

  function _nextDeadline(nowVal: number): number {
    let min = Infinity;
    for (const w of watchers.values()) {
      const dueAt = w.lastFiredAt + w.intervalMs;
      if (dueAt <= nowVal) return nowVal;
      if (dueAt < min) min = dueAt;
    }
    return min;
  }

  function _fireDue(nowVal: number): void {
    for (const w of watchers.values()) {
      while (w.lastFiredAt + w.intervalMs <= nowVal) {
        try { w.fn(); } catch { /* noop */ }
        w.lastFiredAt += w.intervalMs;
        if (w.intervalMs <= 0) break;
      }
    }
  }

  function _scheduleNext(nowVal: number): void {
    _clearTimer();
    if (stopped || watchers.size === 0) return;
    const deadline = _nextDeadline(nowVal);
    if (deadline === Infinity) return;
    const delay = Math.max(0, deadline - nowVal);
    timer = setTimeout(() => {
      _fireDue(now());
      _scheduleNext(now());
    }, delay) as unknown as TimerLike;
    if (typeof timer.unref === 'function') timer.unref();
  }

  function _clearTimer(): void {
    if (timer) { clearTimeout(timer as ReturnType<typeof setTimeout>); timer = null; }
  }

  function _schedule(): void { started = true; _scheduleNext(now()); }

  function stop(): void { stopped = true; _clearTimer(); watchers.clear(); }

  function _tick(ms: number): void { if (!stopped) _fireDue(ms); }

  return { add, _schedule, stop, _tick };
}
