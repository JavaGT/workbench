import { scope, everyone, grant, read, write, tick, date, schedule, text } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import workbench, { createClock, entity, executeFrameworkDDL } from '../build/internal.mjs';
import { generateDDL } from '../build/ddl.mjs';
import { createServer, durableMutationVariant } from '../build/pipeline.mjs';
import { principal as makePrincipal } from '../build/principal.mjs';
import { admitSystemMutation, machinePrincipal, startClockTriggers, tickSource } from '../build/schedule.mjs';

// ============================================================
// Tick fire-path via startClockTriggers + admission tests.
//
// Clock trigger, not an authority. Immediate scan + interval:
// discover matching while → dispatch under tick principal →
// durable beforeProjection admission. ONE reconciliation path.

// ---- Shared helpers ----

function seededDb() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  return db;
}

function _makeAppWithTick(entityDef, entityName) {
  const db = seededDb();
  for (const sql of generateDDL(entityDef)) db.exec(sql);

  const app = workbench({ db, entities: [entityDef] });
  const boundEntity = app.entity(entityDef);

  const entities = new Map();
  entities.set(boundEntity.name, boundEntity);

  const server = createServer({
    handlers: boundEntity.crudHandlers,
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [boundEntity.projection],
      admission: {
        beforeProjection: async ({ entityName: en, verb, principal: p, event, payload, db: hookDb, now }) => {
      if (p?.type !== 'system' || !p.attributes?.source) return true;
      const ent = entities.get(en) ?? boundEntity;
      return admitSystemMutation({
        entity: ent, verb, rowId: event?.data?.id,
        payload, principal: p, db: hookDb ?? db, now: now ?? Date.now(),
      });
    },
        afterProjection: async () => true,
      },
    }),
  });

  return { db, entity: boundEntity, entities, server, entityName };
}

// Poll helper: wait for a condition, retrying at ~10ms intervals.
function poll(fn, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      try {
        const result = fn();
        return resolve(result);
      } catch (err) {
        if (Date.now() - start < timeoutMs) {
          setTimeout(check, intervalMs);
        } else {
          reject(err);
        }
      }
    }
    check();
  });
}

// ============================================================
// unit: tick fire-path
// ============================================================
test('startClockTriggers tick fires rows matching while, skips non-matching', () => {
  const db = new DatabaseSync(':memory:');
  const status = { kind: 'value', type: 'text' };
  const Blog = entity('TestDisc', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status,

    schedule: {
      update: tick.hz(100, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  db.prepare('INSERT INTO TestDisc (id, status) VALUES (?, ?)').run('r1', 'alive');
  db.prepare('INSERT INTO TestDisc (id, status) VALUES (?, ?)').run('r2', 'dead');
  const now = Date.now();

  const calls = [];
  const clock = startClockTriggers({
    db, entities: [Blog], dispatch: (a) => calls.push(a), now: () => now,
  });
  clock.stop();
  assert.equal(calls.length, 1, 'only the alive row fires');
  assert.equal(calls[0].type, 'TestDisc.update');
  assert.equal(calls[0].payload.id, 'r1');
  assert.equal(calls[0].payload.status, 'moving');
  assert.equal(calls[0].principal.attributes.source, tickSource('TestDisc', 'update'));
});

test('startClockTriggers tick applies when after indexed while discovery', () => {
  const db = new DatabaseSync(':memory:');
  const status = { kind: 'value', type: 'text' };
  const enabled = { kind: 'value', type: 'text' };
  const Enemy = entity('TickWhenGuard', {
    grant: scope(() => everyone()).can(() => grant(read)),
    status,
    enabled,
    schedule: {
      update: tick.hz(100, {
        while: ({ fields }) => fields.status.is('alive'),
        when: ({ row }) => row.enabled === 'yes',
        with: { status: 'moving' },
      }),
    },
  });
  for (const sql of generateDDL(Enemy)) db.exec(sql);
  db.prepare('INSERT INTO TickWhenGuard (id, status, enabled) VALUES (?, ?, ?)').run('on', 'alive', 'yes');
  db.prepare('INSERT INTO TickWhenGuard (id, status, enabled) VALUES (?, ?, ?)').run('off', 'alive', 'no');

  const calls = [];
  const preparedSql = [];
  const tracedDb = {
    prepare(sql) {
      preparedSql.push(sql);
      return db.prepare(sql);
    },
  };
  const clock = startClockTriggers({ db: tracedDb, entities: [Enemy], dispatch: (args) => calls.push(args) });
  clock.stop();
  assert.deepEqual(calls.map((call) => call.payload.id), ['on']);
  assert.match(preparedSql[0], /WHERE \(t0\.status =/);
  assert.equal(preparedSql.some((sql) => sql.startsWith('SELECT 1 FROM')), false);
  db.close();
});

test('mixed tick rates fire only the triggers due at each interval', () => {
  const fastStatus = text();
  const slowStatus = text();
  const Fast = entity('FastTickRate', {
    grant: scope(() => everyone()).can(() => grant(read)),
    status: fastStatus,
    schedule: {
      update: tick.every(100, {
        while: ({ fields }) => fields.status.is('ready'),
        with: { status: 'fast' },
      }),
    },
  });
  const Slow = entity('SlowTickRate', {
    grant: scope(() => everyone()).can(() => grant(read)),
    status: slowStatus,
    schedule: {
      update: tick.every(1000, {
        while: ({ fields }) => fields.status.is('ready'),
        with: { status: 'slow' },
      }),
    },
  });
  const db = seededDb();
  for (const sql of [...generateDDL(Fast), ...generateDDL(Slow)]) db.exec(sql);
  db.prepare('INSERT INTO FastTickRate (id, status) VALUES (?, ?)').run('fast-1', 'ready');
  db.prepare('INSERT INTO SlowTickRate (id, status) VALUES (?, ?)').run('slow-1', 'ready');
  const calls = [];
  const clock = createClock({ now: () => 0 });
  const runner = startClockTriggers({ db, entities: [Fast, Slow], dispatch: (args) => calls.push(args), clock, now: () => 0 });

  assert.deepEqual(calls.map((call) => call.type).sort(), ['FastTickRate.update', 'SlowTickRate.update']);
  calls.length = 0;
  clock._tick(100);
  assert.deepEqual(calls.map((call) => call.type), ['FastTickRate.update']);
  clock._tick(1000);
  assert.equal(calls.filter((call) => call.type === 'FastTickRate.update').length, 10);
  assert.equal(calls.filter((call) => call.type === 'SlowTickRate.update').length, 1);
  runner.stop();
  clock.stop();
  db.close();
});

test('admitSystemMutation rechecks when and rejects Promise-returning guards', () => {
  const db = new DatabaseSync(':memory:');
  const status = { kind: 'value', type: 'text' };
  const enabled = { kind: 'value', type: 'text' };
  const Enemy = entity('TickWhenAdmission', {
    grant: scope(() => everyone()).can(() => grant(read)),
    status,
    enabled,
    schedule: {
      update: tick.hz(100, {
        while: ({ fields }) => fields.status.is('alive'),
        when: () => Promise.resolve(true),
        with: { status: 'moving' },
      }),
    },
  });
  for (const sql of generateDDL(Enemy)) db.exec(sql);
  db.prepare('INSERT INTO TickWhenAdmission (id, status, enabled) VALUES (?, ?, ?)').run('r1', 'alive', 'yes');
  const principal = machinePrincipal({ id: tickSource('TickWhenAdmission', 'update'), operations: ['update'] });

  assert.throws(
    () => admitSystemMutation({
      entity: Enemy,
      verb: 'update',
      rowId: 'r1',
      payload: { id: 'r1', status: 'moving' },
      principal,
      db,
      now: Date.now(),
    }),
    /when must return a boolean synchronously/,
  );
  db.close();
});

test('admitSystemMutation rejects a payload function that returns a Promise', () => {
  const status = text();
  const AsyncPayload = entity('AsyncTickPayload', {
    grant: scope(() => everyone()).can(() => grant(read)),
    status,
    schedule: {
      update: {
        ...tick.every('1m', {
          while: ({ fields }) => fields.status.is('ready'),
          with: () => ({ status: 'done' }),
        }),
        with: () => Promise.resolve({ status: 'done' }),
      },
    },
  });
  const db = seededDb();
  for (const sql of generateDDL(AsyncPayload)) db.exec(sql);
  db.prepare('INSERT INTO AsyncTickPayload (id, status) VALUES (?, ?)').run('row1', 'ready');

  assert.throws(
    () => admitSystemMutation({
      entity: AsyncPayload,
      verb: 'update',
      rowId: 'row1',
      payload: { status: 'done' },
      principal: machinePrincipal({ id: tickSource('AsyncTickPayload', 'update'), operations: ['update'] }),
      db,
      now: Date.now(),
    }),
    /with must return an object synchronously/,
  );
  db.close();
});

test('admitSystemMutation denies when the current row no longer passes when', () => {
  const db = new DatabaseSync(':memory:');
  const status = { kind: 'value', type: 'text' };
  const enabled = { kind: 'value', type: 'text' };
  const Enemy = entity('TickWhenChanged', {
    grant: scope(() => everyone()).can(() => grant(read)),
    status,
    enabled,
    schedule: {
      update: tick.hz(100, {
        while: ({ fields }) => fields.status.is('alive'),
        when: ({ row }) => row.enabled === 'yes',
        with: { status: 'moving' },
      }),
    },
  });
  for (const sql of generateDDL(Enemy)) db.exec(sql);
  db.prepare('INSERT INTO TickWhenChanged (id, status, enabled) VALUES (?, ?, ?)').run('r1', 'alive', 'no');
  const principal = machinePrincipal({ id: tickSource('TickWhenChanged', 'update'), operations: ['update'] });

  const admitted = admitSystemMutation({
    entity: Enemy,
    verb: 'update',
    rowId: 'r1',
    payload: { id: 'r1', status: 'moving' },
    principal,
    db,
    now: Date.now(),
  });
  assert.equal(admitted, false);
  db.close();
});

// ============================================================
// unit: admitSystemMutation direct
// ============================================================
test('admitSystemMutation admits an exact-match dispatch', () => {
  const db = new DatabaseSync(':memory:');
  const status = { kind: 'value', type: 'text' };
  const Blog = entity('AdmitDirect', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status,

    schedule: {
      update: tick.hz(100, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  db.prepare('INSERT INTO AdmitDirect (id, status) VALUES (?, ?)').run('x1', 'alive');

  const principal = machinePrincipal({ id: tickSource('AdmitDirect', 'update'), operations: ['update'] });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'x1',
    payload: { id: 'x1', status: 'moving' }, principal, db, now: Date.now(),
  });
  assert.equal(granted, true, 'exact source + while-holds + exact with → admitted');
});

test('admitSystemMutation DENIES wrong payload', () => {
  const db = new DatabaseSync(':memory:');
  const status = { kind: 'value', type: 'text' };
  const Blog = entity('AdmitWrongPayload', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status,

    schedule: {
      update: tick.hz(100, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  db.prepare('INSERT INTO AdmitWrongPayload (id, status) VALUES (?, ?)').run('x2', 'alive');

  const principal = machinePrincipal({ id: tickSource('AdmitWrongPayload', 'update'), operations: ['update'] });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'x2',
    payload: { id: 'x2', status: 'hijacked' }, principal, db, now: Date.now(),
  });
  assert.equal(granted, false, 'undeclared payload → deny (no write-anything)');
});

test('admitSystemMutation DENIES row deleted between discover + dispatch', () => {
  const db = new DatabaseSync(':memory:');
  const status = { kind: 'value', type: 'text' };
  const Blog = entity('AdmitTOCTOU', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status,

    schedule: {
      update: tick.hz(100, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  // No row inserted — row was "deleted" after discovery.

  const principal = machinePrincipal({ id: tickSource('AdmitTOCTOU', 'update'), operations: ['update'] });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'gone',
    payload: { id: 'gone', status: 'moving' }, principal, db, now: Date.now(),
  });
  assert.equal(granted, false, 'TOCTOU: row vanished → deny');
});

test('admitSystemMutation DENIES non-system principal', () => {
  const db = new DatabaseSync(':memory:');
  const status = { kind: 'value', type: 'text' };
  const Blog = entity('AdmitNonSystem', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status,

    schedule: {
      update: tick.hz(100, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const principal = makePrincipal({ type: 'user', id: 'someone' });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'x1',
    payload: { id: 'x1', status: 'moving' }, principal, db, now: Date.now(),
  });
  assert.equal(granted, false, 'non-system principal → fail closed');
});

test('admitSystemMutation admits and denies the 3-part scheduler source through the same seam', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const publishedAt = date();
  const status = { kind: 'value', type: 'text' };
  const Blog = entity('AdmitSystemSchedule', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt, status,

    schedule: {
      update: schedule.at(publishedAt, {
        with: { status: 'published' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  const now = Date.now();
  db.prepare('INSERT INTO AdmitSystemSchedule (id, publishedAt, status) VALUES (?, ?, ?)').run('s1', now - 1000, 'draft');

  const principal = machinePrincipal({ id: 'AdmitSystemSchedule.update.publishedAt', operations: ['update'] });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 's1',
    payload: { id: 's1', status: 'published' }, principal, db, now,
  });
  assert.equal(granted, true, '3-part scheduler source + due row + exact payload → admitted');

  db.prepare('UPDATE AdmitSystemSchedule SET publishedAt = ? WHERE id = ?').run(now + 100_000, 's1');
  const notDue = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 's1',
    payload: { id: 's1', status: 'published' }, principal, db, now,
  });
  assert.equal(notDue, false, '3-part scheduler source still re-checks due through the same seam');
});

// ============================================================
// e2e: tick source wired through beforeProjection admission
// ============================================================
test('e2e: tick dispatch updates row through projection', async (t) => {
  const statusDesc = { kind: 'value', type: 'text' };
  const Blog = entity('BlogTick', {
    // The tick dispatch projects a real update: declare the scope AND write
    // capability as a compiled grant clause array, not a bare clause object.
    grant: () => [scope(() => everyone()).can(() => grant(read, write))],
        status: statusDesc,

    schedule: {
      update: tick.hz(20, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  const db = seededDb();
  for (const sql of generateDDL(Blog)) db.exec(sql);
  const app = workbench({ db, entities: [Blog] });
  const boundBlog = app.entity(Blog);

  // Seed a row matching while ('alive')
  db.prepare('INSERT INTO BlogTick (id, status) VALUES (?, ?)').run('b1', 'alive');

  const entities = new Map();
  entities.set(boundBlog.name, boundBlog);

  // Mirror production beforeProjection admission: tick branch + pass-through
  const server = createServer({
    handlers: boundBlog.crudHandlers,
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [boundBlog.projection],
      admission: {
        beforeProjection: async ({ entityName: en, verb, principal: p, event, payload, db: hookDb, now }) => {
      if (p?.type !== 'system' || !p.attributes?.source) return true;
      const ent = entities.get(en) ?? boundBlog;
      return admitSystemMutation({
        entity: ent, verb, rowId: event?.data?.id,
        payload, principal: p, db: hookDb ?? db, now: now ?? Date.now(),
      });
    },
        afterProjection: async () => true,
      },
    }),
  });

  const clock = startClockTriggers({ db, entities, dispatch: server.dispatch });
  t.after(() => clock.stop()); // cleanup to avoid timer leaks

  // The engine fires at 50ms intervals (1000/20 hz). Poll for the mutation.
  await poll(() => {
    const row = db.prepare('SELECT status FROM BlogTick WHERE id = ?').get('b1');
    assert.equal(row?.status, 'moving', 'projection applied the declared with payload');
  }, { timeoutMs: 3000 });
});

test('listen tick dispatch waits behind the app write queue', async (t) => {
  const statusDesc = { kind: 'value', type: 'text' };
  const Blog = entity('BlogTickQueue', {
    // The tick dispatch projects a real update: declare the scope AND write
    // capability as a compiled grant clause array, not a bare clause object.
    grant: () => [scope(() => everyone()).can(() => grant(read, write))],
        status: statusDesc,

    schedule: {
      update: tick.hz(20, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  const db = seededDb();
  for (const sql of generateDDL(Blog)) db.exec(sql);
  db.prepare('INSERT INTO BlogTickQueue (id, status) VALUES (?, ?)').run('bq1', 'alive');

  const app = workbench({ db }).mount('/ticks', Blog).listen(0, {
    principalOf: () => makePrincipal({ type: 'user', id: 'u1' }),
  });
  t.after(async () => {
    await app.shutdown();
    db.close();
  });
  await app.ready;

  // Boot catch-up (immediate scan) may already have fired; reset so we can
  // observe a later interval dispatch behind a held write queue.
  db.prepare('UPDATE BlogTickQueue SET status = ? WHERE id = ?').run('alive', 'bq1');

  let releaseHold;
  const hold = app.writeQueue.run(() => new Promise((resolve) => { releaseHold = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 150));

  const heldRow = db.prepare('SELECT status FROM BlogTickQueue WHERE id = ?').get('bq1');
  assert.equal(heldRow?.status, 'alive', 'timer dispatch must not bypass the held write queue');

  releaseHold();
  await hold;

  await poll(() => {
    const row = db.prepare('SELECT status FROM BlogTickQueue WHERE id = ?').get('bq1');
    assert.equal(row?.status, 'moving', 'queued tick dispatch runs after the write queue releases');
  }, { timeoutMs: 3000 });
});

test('e2e: while-fails — row not matching while is never mutated', async (t) => {
  const statusDesc = { kind: 'value', type: 'text' };
  const Blog = entity('BlogWhileFail', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status: statusDesc,

    schedule: {
      update: tick.hz(20, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  const db = seededDb();
  for (const sql of generateDDL(Blog)) db.exec(sql);
  const app = workbench({ db, entities: [Blog] });
  const boundBlog = app.entity(Blog);

  // Seed a row NOT matching while ('dead' ≠ 'alive')
  db.prepare('INSERT INTO BlogWhileFail (id, status) VALUES (?, ?)').run('b2', 'dead');

  const entities = new Map();
  entities.set(boundBlog.name, boundBlog);

  const server = createServer({
    handlers: boundBlog.crudHandlers,
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [boundBlog.projection],
      admission: {
        beforeProjection: async ({ entityName: en, verb, principal: p, event, payload, db: hookDb, now }) => {
      if (p?.type !== 'system' || !p.attributes?.source) return true;
      const ent = entities.get(en) ?? boundBlog;
      return admitSystemMutation({
        entity: ent, verb, rowId: event?.data?.id,
        payload, principal: p, db: hookDb ?? db, now: now ?? Date.now(),
      });
    },
        afterProjection: async () => true,
      },
    }),
  });

  const clock = createClock({ now: () => 0 });
  const triggers = startClockTriggers({ db, entities, dispatch: server.dispatch, clock });
  t.after(() => triggers.stop());

  clock._tick(250);
  assert.doesNotThrow(() => triggers.stop()); // verify engine didn't throw

  const row = db.prepare('SELECT status FROM BlogWhileFail WHERE id = ?').get('b2');
  assert.equal(row.status, 'dead', 'while-failed row stays unmutated');
});

test('e2e: TOCTOU — row deleted between discover and dispatch does not escape', async (t) => {
  const statusDesc = { kind: 'value', type: 'text' };
  const Blog = entity('BlogTOCTOU', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status: statusDesc,

    schedule: {
      update: tick.hz(20, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  const db = seededDb();
  for (const sql of generateDDL(Blog)) db.exec(sql);
  const app = workbench({ db, entities: [Blog] });
  const boundBlog = app.entity(Blog);

  // Seed a matching row — it will be discovered.
  db.prepare('INSERT INTO BlogTOCTOU (id, status) VALUES (?, ?)').run('b3', 'alive');

  const entities = new Map();
  entities.set(boundBlog.name, boundBlog);

  const server = createServer({
    handlers: boundBlog.crudHandlers,
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [boundBlog.projection],
      admission: {
        beforeProjection: async ({ entityName: en, verb, principal: p, event, payload, db: hookDb, now }) => {
      if (p?.type !== 'system' || !p.attributes?.source) return true;
      const ent = entities.get(en) ?? boundBlog;
      return admitSystemMutation({
        entity: ent, verb, rowId: event?.data?.id,
        payload, principal: p, db: hookDb ?? db, now: now ?? Date.now(),
      });
    },
        afterProjection: async () => true,
      },
    }),
  });

  const clock = startClockTriggers({ db, entities, dispatch: server.dispatch });
  t.after(() => clock.stop());

  // Delete the row on the first interval — the engine should discover it,
  // fail to dispatch (row gone), log stderr, and CONTINUE (no exception escapes).
  setTimeout(() => {
    db.prepare('DELETE FROM BlogTOCTOU WHERE id = ?').run('b3');
  }, 30);

  // After multiple intervals, the engine must still be alive (didn't crash).
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.doesNotThrow(() => clock.stop()); // engine survived the TOCTOU
});

test('e2e: engine with no tick triggers returns no-op', () => {
  const statusDesc = { kind: 'value', type: 'text' };
  const Blog = entity('BlogNoTick', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status: statusDesc,

    schedule: {
      // No tick triggers — only a regular field, no schedule at all.
    },
  });
  const db = seededDb();
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const entities = new Map();
  entities.set(Blog.name, Blog);

  const clock = startClockTriggers({ db, entities, dispatch: () => {} });
  assert.doesNotThrow(() => clock.stop()); // no-op stop is safe
});

test('e2e: engine dispatch error continues sweep (stderr, no throw)', async (t) => {
  const statusDesc = { kind: 'value', type: 'text' };
  const Blog = entity('BlogSweepContinue', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status: statusDesc,

    schedule: {
      update: tick.hz(20, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  const db = seededDb();
  for (const sql of generateDDL(Blog)) db.exec(sql);
  // Seed one matching row.
  db.prepare('INSERT INTO BlogSweepContinue (id, status) VALUES (?, ?)').run('b4', 'alive');

  const entities = new Map();
  entities.set(Blog.name, Blog);

  // A dispatch that throws — simulates beforeProjection admission rejecting a row.
  // Uses the REAL compiled Blog (whose `while` discovers the seeded row) so the
  // engine actually reaches dispatch each interval; the throw exercises the
  // per-row try/catch (one row's failure must NOT abort the sweep).
  let dispatchCount = 0;
  const throwingDispatch = () => {
    dispatchCount++;
    throw new Error('simulated auth deny');
  };

  const goodEntities = new Map([[Blog.name, Blog]]);

  const clock = createClock({ now: () => 0 });
  const triggers = startClockTriggers({ db, entities: goodEntities, dispatch: throwingDispatch, clock });
  t.after(() => triggers.stop());

  clock._tick(350);
  assert.ok(dispatchCount > 0, 'engine kept dispatching despite errors');
  assert.doesNotThrow(() => triggers.stop());
});
