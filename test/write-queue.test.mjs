// write-queue.test.mjs — tests for single-writer async mutex with bounded wait/depth

import test from 'node:test';
import assert from 'node:assert';
import { createWriteQueue } from '../build/write-queue.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('createWriteQueue returns expected API', () => {
  const q = createWriteQueue();
  assert.strictEqual(typeof q.run, 'function');
  assert.strictEqual(q.depth, 0);
  assert.strictEqual(q.running, false);
  assert.strictEqual(q.owned, false);
});

test('nested runs join the current ownership context exactly once', async () => {
  const q = createWriteQueue();
  const events = [];
  let detached;

  const result = await q.run(async () => {
    events.push(['outer', q.owned]);
    detached = new Promise((resolve) => setImmediate(() => resolve(q.owned)));
    const nested = await q.run(async () => {
      events.push(['nested', q.owned]);
      await delay(1);
      return 2;
    });
    events.push(['outer-after-nested', q.owned]);
    return nested + 1;
  });

  assert.strictEqual(result, 3);
  assert.deepStrictEqual(events, [
    ['outer', true],
    ['nested', true],
    ['outer-after-nested', true],
  ]);
  assert.strictEqual(q.owned, false);
  assert.strictEqual(await detached, false);
  assert.strictEqual(await q.run(() => q.owned), true);
  assert.strictEqual(q.owned, false);
});

test('an external writer waits while a nested writer joins', async () => {
  const q = createWriteQueue();
  let releaseOuter;
  const outerGate = new Promise((resolve) => { releaseOuter = resolve; });
  const events = [];

  const outer = q.run(async () => {
    events.push('outer-start');
    const nested = q.run(() => {
      events.push('nested');
      return 'nested-result';
    });
    assert.strictEqual(await nested, 'nested-result');
    await outerGate;
    events.push('outer-end');
  });
  await delay(1);
  const external = q.run(() => {
    events.push('external');
    return 'external-result';
  });

  await delay(1);
  assert.deepStrictEqual(events, ['outer-start', 'nested']);
  releaseOuter();
  assert.strictEqual(await outer, undefined);
  assert.strictEqual(await external, 'external-result');
  assert.deepStrictEqual(events, ['outer-start', 'nested', 'outer-end', 'external']);
});

test('close refuses new outer runs while the active owner may still re-enter and finish', async () => {
  // close() stops admitting writers, but a turn already in flight owns the mutex:
  // rejecting its nested re-entry would fail a write mid-transaction during
  // shutdown, so the owner stays admitted until its turn releases.
  const q = createWriteQueue();
  const events = [];
  let signalClosed;
  const closedNow = new Promise((resolve) => { signalClosed = resolve; });
  let releaseOuter;
  const outerGate = new Promise((resolve) => { releaseOuter = resolve; });

  const outer = q.run(async () => {
    events.push('outer-start');
    await closedNow;
    const nested = await q.run(async () => {
      events.push('nested');
      return 'nested-result';
    });
    assert.strictEqual(nested, 'nested-result');
    assert.strictEqual(q.owned, true, 'owner keeps the turn across close');
    await outerGate;
    events.push('outer-end');
    return 'outer-result';
  });

  await delay(1);
  assert.strictEqual(q.running, true, 'outer run should hold the turn');

  const closed = q.close();
  assert.strictEqual(q.closed, true);
  signalClosed();

  await delay(1);
  assert.deepStrictEqual(events, ['outer-start', 'nested'], 'owner must re-enter after close');

  let closeSettled = false;
  void closed.then(() => { closeSettled = true; });
  await delay(5);
  assert.strictEqual(closeSettled, false, 'close must wait for the in-flight turn');

  releaseOuter();
  assert.strictEqual(await outer, 'outer-result');
  await closed;
  assert.strictEqual(closeSettled, true, 'close resolves once the turn releases');

  await assert.rejects(
    q.run(async () => { events.push('external'); return 'external-result'; }),
    (err) => {
      assert.strictEqual(err.status, 503);
      assert.match(err.message, /closed/);
      return true;
    },
  );
  assert.deepStrictEqual(events, ['outer-start', 'nested', 'outer-end']);
});

test('immediate runs always return promises', async () => {
  const q = createWriteQueue();

  const value = q.run(() => 7);
  const failure = q.run(() => { throw new Error('failed synchronously'); });

  assert.ok(value instanceof Promise);
  assert.equal(await value, 7);
  await assert.rejects(failure, /failed synchronously/);
});

test('serialized runs return their own value in order', async () => {
  const q = createWriteQueue();
  const results = [];
  
  const p1 = q.run(async () => {
    await delay(10);
    return 1;
  });
  const p2 = q.run(async () => {
    await delay(10);
    return 2;
  });
  
  const [r1, r2] = await Promise.all([p1, p2]);
  results.push(r1, r2);
  
  assert.deepStrictEqual(results, [1, 2]);
});

test('two dispatches do not interleave — serial execution', async () => {
  const q = createWriteQueue();
  const events = [];
  
  const p1 = q.run(async () => {
    events.push('fn1-start');
    await delay(20);
    events.push('fn1-mid');
    await delay(10);
    events.push('fn1-end');
    return 'fn1-done';
  });
  
  const p2 = q.run(async () => {
    events.push('fn2-start');
    await delay(10);
    events.push('fn2-mid');
    await delay(10);
    events.push('fn2-end');
    return 'fn2-done';
  });
  
  await Promise.all([p1, p2]);
  
  // fn2 must not start until fn1 completes
  const fn1EndIdx = events.indexOf('fn1-end');
  const fn2StartIdx = events.indexOf('fn2-start');
  assert.ok(fn2StartIdx > fn1EndIdx, `fn2 started before fn1 ended: ${events.join('→')}`);
});

test('bounded wait → 503 when starved', async () => {
  const maxWaitMs = 30;
  let fn2Called = false;
  let resolveFn1;
  const fn1Promise = new Promise((r) => {
    resolveFn1 = r;
  });
  
  const q = createWriteQueue({ maxWaitMs, now: Date.now });
  
  // fn1 holds the lock indefinitely
  const p1 = q.run(async () => {
    await fn1Promise;
    return 'fn1';
  });
  
  // fn2 should timeout and reject with 503
  const start = Date.now();
  await assert.rejects(
    async () => {
      await q.run(async () => {
        fn2Called = true;
        return 'fn2';
      });
    },
    (err) => {
      assert.strictEqual(err.status, 503);
      assert.ok(err.message.includes('wait') || err.message.includes('timeout'));
      return true;
    },
  );
  const elapsed = Date.now() - start;
  
  assert.ok(elapsed >= maxWaitMs - 5, `timeout fired too early: ${elapsed}ms`);
  assert.ok(elapsed < maxWaitMs + 50, `timeout fired too late: ${elapsed}ms`);
  assert.strictEqual(fn2Called, false, 'fn2 must not be called on timeout');
  
  // Release fn1 so the queue doesn't hang
  resolveFn1();
  await p1;
});

test('bounded depth → 503 when maxDepth reached', async () => {
  const maxDepth = 2;
  const q = createWriteQueue({ maxDepth });
  
  let fn1Resolve, fn2Resolve;
  const fn1Done = new Promise((r) => {
    fn1Resolve = r;
  });
  const fn2Done = new Promise((r) => {
    fn2Resolve = r;
  });
  
  // fn1 is running
  q.run(async () => {
    await fn1Done;
    return 'fn1';
  });
  
  // fn2 is waiting (depth = 1)
  const p2 = q.run(async () => {
    await fn2Done;
    return 'fn2';
  });
  
  // Wait for p2 to actually queue up
  await delay(10);
  
  // fn3 should be rejected immediately (depth would be 2, which is >= maxDepth)
  let fn3Called = false;
  await assert.rejects(
    async () => {
      await q.run(async () => {
        fn3Called = true;
        return 'fn3';
      });
    },
    (err) => {
      assert.strictEqual(err.status, 503);
      return true;
    },
  );
  
  assert.strictEqual(fn3Called, false, 'fn3 must not be called when depth exceeded');
  
  // Release fn1 and fn2
  fn1Resolve();
  await delay(10);
  fn2Resolve();
  await p2;
});

test('a fn that throws still releases the lock', async () => {
  const q = createWriteQueue();
  let fn2Called = false;
  
  await assert.rejects(
    async () => {
      await q.run(async () => {
        throw new Error('intentional');
      });
    },
    (err) => {
      assert.strictEqual(err.message, 'intentional');
      return true;
    },
  );
  
  // fn2 should still run after fn1 threw
  const r2 = await q.run(async () => {
    fn2Called = true;
    return 'fn2';
  });
  
  assert.strictEqual(fn2Called, true);
  assert.strictEqual(r2, 'fn2');
});

test('depth and running reflect current state', async () => {
  const q = createWriteQueue();
  let resolveFn1;
  const fn1Done = new Promise((r) => {
    resolveFn1 = r;
  });
  
  assert.strictEqual(q.depth, 0);
  assert.strictEqual(q.running, false);
  
  // Start fn1
  const p1 = q.run(async () => {
    await fn1Done;
    return 'fn1';
  });
  
  // Give it a moment to start
  await delay(10);
  assert.strictEqual(q.running, true);
  assert.strictEqual(q.depth, 0);
  
  // Queue fn2 and fn3 with delays so they stay running
  let resolveFn2;
  const fn2Done = new Promise(r => resolveFn2 = r);
  const p2 = q.run(async () => {
    await fn2Done;
    return 'fn2';
  });
  await delay(10);
  assert.strictEqual(q.depth, 1);
  
  const p3 = q.run(async () => 'fn3');
  await delay(10);
  assert.strictEqual(q.depth, 2);
  
  // Release fn1
  resolveFn1();
  await p1;
  
  // fn2 should be running now, fn3 waiting
  await delay(10);
  assert.strictEqual(q.running, true);
  assert.strictEqual(q.depth, 1);
  
  resolveFn2();
  await p2;
  await p3;
  
  assert.strictEqual(q.running, false);
  assert.strictEqual(q.depth, 0);
});

test('custom now() is used for timeout measurement', async () => {
  let fakeNow = 0;
  const now = () => fakeNow;
  const maxWaitMs = 100;
  const q = createWriteQueue({ maxWaitMs, now });
  
  let resolveFn1;
  const fn1Done = new Promise((r) => {
    resolveFn1 = r;
  });
  
  // fn1 holds the lock
  q.run(async () => {
    await fn1Done;
    return 'fn1';
  });
  
  let fn2Called = false;
  const p2 = q.run(async () => {
    fn2Called = true;
    return 'fn2';
  });
  
  // Advance time past maxWaitMs
  fakeNow = maxWaitMs + 10;
  
  // fn2 should now reject with 503
  await assert.rejects(
    async () => {
      await p2;
    },
    (err) => {
      assert.strictEqual(err.status, 503);
      return true;
    },
  );
  
  assert.strictEqual(fn2Called, false);
  resolveFn1();
});

test('sync fn works correctly', async () => {
  const q = createWriteQueue();
  const results = [];

  const r1 = q.run(() => {
    results.push('sync1');
    return 10;
  });

  const r2 = q.run(() => {
    results.push('sync2');
    return 20;
  });

  assert.strictEqual(await r1, 10);
  const r2Val = await r2;
  assert.strictEqual(r2Val, 20);
  assert.deepStrictEqual(results, ['sync1', 'sync2']);
});

test('timeouts do not drift depth negative (one decrement per waiter)', async () => {
  // Regression: a timed-out waiter used to decrement `waiters` twice — once in
  // the timeout callback and again in the lock-chain's `if (cancelled)` branch
  // (which runs when the held lock releases). N timeouts → depth drifts to -N,
  // so the bounded-depth → 503 guard (`waiters + 1 >= maxDepth`) weakens over
  // time and never trips — a starvation DoS vector.
  const maxWaitMs = 20;
  const q = createWriteQueue({ maxWaitMs });
  let resolveFn1;
  const fn1Done = new Promise((r) => { resolveFn1 = r; });

  const p1 = q.run(async () => { await fn1Done; return 'fn1'; });

  // 4 waiters; each should time out while fn1 holds the lock.
  const rejected = [];
  for (let i = 0; i < 4; i++) {
    rejected.push(
      q.run(async () => `fn${i + 2}`).then(
        () => { throw new Error(`waiter ${i} should have timed out`); },
        (err) => { assert.strictEqual(err.status, 503); return true; },
      ),
    );
  }
  await Promise.all(rejected);

  // Release fn1 so the lock chain drains the (already-cancelled) waiters — the
  // branch where the second (buggy) decrement fired.
  resolveFn1();
  await p1;
  await delay(5);

  assert.strictEqual(q.depth, 0, `depth should settle to 0, got ${q.depth}`);
  assert.ok(q.depth >= 0, `depth went negative (drift): ${q.depth}`);

  // The guard must still trip after timeouts: a fresh set of waiters, all
  // exceeding maxDepth, must reject with 503 (no under-counting).
  const q2 = createWriteQueue({ maxWaitMs: 20, maxDepth: 3 });
  let resolveHeld;
  const held = new Promise((r) => { resolveHeld = r; });
  q2.run(async () => { await held; return 'held'; });
  let timedOut = 0;
  const wave = [];
  for (let i = 0; i < 6; i++) {
    wave.push(
      q2.run(async () => `w${i}`).then(
        () => { throw new Error(`w${i} should 503`); },
        (err) => { if (err.status === 503) timedOut++; return true; },
      ),
    );
  }
  await Promise.all(wave);
  assert.ok(timedOut > 0, 'maxDepth guard should reject after timeout drift');
  resolveHeld();
});
