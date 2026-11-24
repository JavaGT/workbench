// P6d Spine A step 4: tick constructor surface + entity-mission gate.
// Tests for: tick.hz / tick.every frozen shape, while/with validation,
// entity-mission compile for tick triggers, empty-while guard, 'when' rejection.

import { date as _date, text, scope, everyone, grant, read } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entity, generateDDL } from '../build/internal.mjs';
import { tick, tickSource } from '../build/schedule.mjs';

// ============================================================
// tick.hz: FROZEN SHAPE + INPUT VALIDATION
// ============================================================

test('tick.hz(30) produces a frozen trigger with kind, hertz, while, with', () => {
  const t = tick.hz(30);
  assert.equal(t.kind, 'tick.hz');
  assert.equal(t.hertz, 30);
  assert.strictEqual(t.while, undefined);
  assert.strictEqual(t.with, undefined);
  Object.freeze(t); // already frozen — no throw
});

test('tick.hz with while + with stores them', () => {
  const w = ({ fields }) => fields.status.is('alive');
  const t = tick.hz(30, { while: w, with: { hp: 0 } });
  assert.equal(t.kind, 'tick.hz');
  assert.equal(t.hertz, 30);
  assert.strictEqual(t.while, w);
  assert.deepEqual(t.with, { hp: 0 });
});

test('tick.hz(0) throws (n must be > 0)', () => {
  assert.throws(() => tick.hz(0), /tick\.hz: n must be a finite positive number/);
});

test('tick.hz(-1) throws', () => {
  assert.throws(() => tick.hz(-1), /tick\.hz: n must be a finite positive number/);
});

test('tick.hz("fast") throws (not a number)', () => {
  assert.throws(() => tick.hz('fast'), /tick\.hz: n must be a finite positive number/);
});

test('tick.hz(NaN) throws', () => {
  assert.throws(() => tick.hz(NaN), /tick\.hz: n must be a finite positive number/);
});

test('tick.hz(Infinity) throws', () => {
  assert.throws(() => tick.hz(Infinity), /tick\.hz: n must be a finite positive number/);
});

// ============================================================
// tick.every: FROZEN SHAPE + PARSE DELAY
// ============================================================

test("tick.every('10s') has intervalMs === 10000", () => {
  const t = tick.every('10s');
  assert.equal(t.kind, 'tick.every');
  assert.equal(t.intervalMs, 10000);
});

test("tick.every('7d') === 604800000", () => {
  const t = tick.every('7d');
  assert.equal(t.intervalMs, 604_800_000);
});

test("tick.every(500) === 500", () => {
  const t = tick.every(500);
  assert.equal(t.intervalMs, 500);
});

test("tick.every('bad') throws (parseDelay rejects)", () => {
  assert.throws(() => tick.every('bad'), /schedule\.after: invalid delay/);
});

// ============================================================
// while: must be a function
// ============================================================

test('tick.hz with while: "not a fn" throws at constructor', () => {
  assert.throws(
    () => tick.hz(30, { while: 'not a fn' }),
    /tick\.hz: while must be a function/,
  );
});

test('tick.hz with while: ({is, fields}) => fields.status.is("alive") passes at constructor', () => {
  const t = tick.hz(30, { while: ({ is: _is, fields }) => fields.status.is('alive') });
  assert.strictEqual(typeof t.while, 'function');
});

test('tick.every with while: "not a fn" throws at constructor', () => {
  assert.throws(
    () => tick.every('10s', { while: 'not a fn' }),
    /tick\.every: while must be a function/,
  );
});

// ============================================================
// ENTITY COMPILE: tick triggers
// ============================================================

test('entity with tick.hz schedule compiles → kind, whileSql populated, no fieldName', () => {
  const status = text();
  const Enemy = entity('Enemy', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status,

    schedule: {
      update: tick.hz(30, {
        while: ({ fields }) => fields.status.is('moving'),
        with: { speed: 100 },
      }),
    },
  });
  for (const _sql of generateDDL(Enemy)) {
    /* DDL executed — no-op in this test */
  }

  assert.equal(Enemy.schedule.update.kind, 'tick.hz');
  assert.equal(typeof Enemy.schedule.update.whileSql, 'string', 'whileSql is a compiled SQL string');
  assert.ok(Enemy.schedule.update.whileSql.includes('status'), 'whileSql references the status field');
  assert.ok(Enemy.schedule.update.whileParams != null, 'whileParams is populated');
  assert.strictEqual(Enemy.schedule.update.fieldName, undefined, 'ticks do NOT have fieldName');
  assert.strictEqual(Enemy.schedule.update.field, undefined, 'ticks do NOT have field');
  assert.strictEqual(Enemy.schedule.update.delay, undefined, 'ticks do NOT have delay');
  assert.strictEqual(Enemy.schedule.update.hertz, 30);
  assert.strictEqual(Enemy.schedule.update.intervalMs, undefined, 'ticks do NOT have intervalMs (only tick.every)');
});

test('entity with tick.every schedule compiles', () => {
  const status = text();
  const Enemy = entity('EnemyEvery', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status,

    schedule: {
      update: tick.every('1m', {
        while: ({ fields }) => fields.status.is('idle'),
        with: { ping: true },
      }),
    },
  });
  for (const _sql of generateDDL(Enemy)) {
    /* DDL executed */
  }

  assert.equal(Enemy.schedule.update.kind, 'tick.every');
  assert.strictEqual(Enemy.schedule.update.intervalMs, 60000);
  assert.strictEqual(Enemy.schedule.update.hertz, undefined);
  assert.strictEqual(Enemy.schedule.update.fieldName, undefined);
});

// ============================================================
// EMPTY-WHILE GUARD: foot-gun prevention
// ============================================================

test('entity with tick.hz no while throws at compile (empty while forbidden)', () => {
  const status = text();
  assert.throws(
    () => entity('EnemyNoWhile', {
      grant: scope(() => everyone()).can(() => grant(read)),
            status,

      schedule: {
        update: tick.hz(30), // no while → foot-gun
      },
    }),
    /a row-set tick requires a 'while' predicate/,
  );
});

test('entity with tick.every no while throws at compile', () => {
  const status = text();
  assert.throws(
    () => entity('EnemyEveryNoWhile', {
      grant: scope(() => everyone()).can(() => grant(read)),
            status,

      schedule: {
        update: tick.every('1m'),
      },
    }),
    /a row-set tick requires a 'while' predicate/,
  );
});

// ============================================================
// 'when' LIFECYCLE GUARD: runtime-only after indexed discovery
// ============================================================

test('tick.hz with when: compiles when the guard is a function', () => {
  const status = text();
  const when = ({ row }) => row.status === 'alive';
  const Enemy = entity('EnemyWhenTick', {
    grant: scope(() => everyone()).can(() => grant(read)),
    status,
    schedule: {
      update: tick.hz(30, {
        while: ({ fields }) => fields.status.is('alive'),
        when,
      }),
    },
  });
  assert.strictEqual(Enemy.schedule.update.when, when);
});

test('tick.hz rejects a non-function when guard', () => {
  assert.throws(() => tick.hz(30, { when: true }), /tick\.hz: when must be a function/);
});

test('tick declarations reject explicitly async lifecycle functions', () => {
  assert.throws(
    () => tick.hz(30, { while: async ({ fields }) => fields.status.is('alive') }),
    /tick\.hz: while must be synchronous/,
  );
  assert.throws(
    () => tick.every('1m', { when: async () => true }),
    /tick\.every: when must be synchronous/,
  );
  assert.throws(
    () => tick.hz(30, { with: async () => ({ status: 'moving' }) }),
    /tick\.hz: with must be synchronous/,
  );
});

// ============================================================
// with: INVALID at entity compile — tick.hz constructor guards
// ============================================================

// tick.hz validates while must be a function at constructor (same guard as schedule.at).
// An entity-level test is redundant — the constructor throws before entity compile runs.
test('tick.hz with while: "not a fn" throws at constructor', () => {
  assert.throws(
    () => tick.hz(30, { while: 'not a fn' }),
    /tick\.hz: while must be a function/,
  );
});

// ============================================================
// tickSource: derived identity
// ============================================================

test("tickSource includes the compiled trigger identity", () => {
  assert.equal(tickSource('Enemy', 'update', 'hz-30'), 'Enemy.update.hz-30');
});

test('tick key becomes the stable compiled trigger identity', () => {
  const status = text();
  const Enemy = entity('KeyedTick', {
    grant: scope(() => everyone()).can(() => grant(read)),
    status,
    schedule: {
      update: tick.hz(30, {
        key: 'physics-loop',
        while: ({ fields }) => fields.status.is('alive'),
      }),
    },
  });
  assert.equal(Enemy.schedule.update.triggerId, 'physics-loop');
  assert.equal(tickSource('KeyedTick', 'update', Enemy.schedule.update.triggerId), 'KeyedTick.update.physics-loop');
});

test('two ticks on one verb require distinct identities', () => {
  const status = text();
  assert.throws(
    () => entity('CollidingTicks', {
      grant: scope(() => everyone()).can(() => grant(read)),
      status,
      schedule: {
        update: [
          tick.hz(30, { while: ({ fields }) => fields.status.is('alive') }),
          tick.hz(30, { while: ({ fields }) => fields.status.is('alive') }),
        ],
      },
    }),
    /duplicate trigger identity/,
  );
});
