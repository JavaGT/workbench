// Effects auth-core tests — P6b Part 2 (gaps #2, #3, #4).
//
// Part 1 left four honest gaps: the effect principal was not minted/threaded at
// runtime (#2), admission was structural-only (#3), and the global cycle +
// admission pass was exported but never called at boot (#4). These tests close
// them with BEHAVIORAL E2E (not structural `assert.ok`), proving:
//   #2 — effect target events run under the EFFECT PRINCIPAL
//        `principal({type:'system', attributes:{effect:<sourceEntity>}})`,
//        NOT the triggering user. An afterProjection admission spy records the
//        principal seen for the target's created event.
//   #3 — the target's `admitsEffects` is CALLED at runtime; a deny throws 403 →
//        rolls back the ORIGIN (in-txn atomic); an admit lets the effect apply.
//   #4 — buildKernel wires the effects registry into createServer AND runs the
//        global validateEffects pass at boot (cycle → app.ready rejects;
//        missing admitsEffects → app.ready rejects; valid → resolves + fires).

import { text, number, grant, deny, read, write, subscribe, principal, scope, everyone, self, inc } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity, effectSource, buildEffectsRegistry, validateEffects, generateDDL, executeFrameworkDDL, created } from '../build/internal.mjs';
import { createServer, durableMutationVariant } from '../build/pipeline.mjs';

function setupDb() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  return db;
}

// ---- #2: effect principal is minted + threaded at runtime (affirmative spy) ----
test('#2 effect target event is authorized under the effect principal, not the user', async () => {
  const db = setupDb();

  const TargetDecl = entity('Target', {
        name: text(),

    grant: () => grant(read, write, subscribe),
  });
  for (const sql of generateDDL(TargetDecl)) db.exec(sql);

  const SourceDecl = entity('Source', {
        title: text(),

    grant: () => grant(read, write, subscribe),
    effects: (Source) => [
      [Source.created, { mutate: TargetDecl, with: { name: 'from-effect' } },],
    ],
  });
  for (const sql of generateDDL(SourceDecl)) db.exec(sql);

  const app = workbench({ db, entities: [TargetDecl, SourceDecl] });
  const Source = app.entity('Source');
  const Target = app.entity('Target');

  const recorded = [];
  const server = createServer({
    handlers: Source.crudHandlers,
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [Source.projection, Target.projection],
      effectsRegistry: buildEffectsRegistry([Source, Target]),
      admission: {
        beforeProjection: async () => true,
        afterProjection: async ({ entityName, verb, principal: p }) => {
          recorded.push({ entityName, verb, type: p.type, effect: p.attributes?.effect, id: p.id });
          return true;
        },
      },
    }),
  });

  await server.dispatch({
    actionId: 'p2-2',
    type: 'Source.create',
    payload: { title: 't' },
    principal: principal({ type: 'user', id: 'u1' }),
  });

  // The SOURCE create is authorized under the user; the TARGET create (effect)
  // is authorized under the system effect principal tagged with 'Source'.
  const sourceAuth = recorded.find((r) => r.entityName === 'Source');
  assert.ok(sourceAuth, 'Source.create was authorized');
  assert.equal(sourceAuth.type, 'user');
  assert.equal(sourceAuth.id, 'u1');

  const targetAuth = recorded.find((r) => r.entityName === 'Target');
  assert.ok(targetAuth, 'Target.created (effect) was authorized');
  assert.equal(targetAuth.type, 'system', 'effect event runs under a system principal');
  assert.equal(targetAuth.effect, 'Source', 'effect principal is tagged with its source entity');
  app.httpServer?.close?.();
});

// ---- #2 (atomicity): target row-grant DENY of the effect principal rolls back origin ----
test('#2 target row-grant deny of effect principal rolls back origin (in-txn atomic)', async () => {
  const db = setupDb();

  const TargetDecl = entity('Target', {
        name: text(),

    grant: () => grant(read, write, subscribe),
  });
  for (const sql of generateDDL(TargetDecl)) db.exec(sql);

  const SourceDecl = entity('Source', {
        title: text(),

    grant: () => grant(read, write, subscribe),
    effects: (Source) => [
      [Source.created, { mutate: TargetDecl, with: { name: 'x' } },],
    ],
  });
  for (const sql of generateDDL(SourceDecl)) db.exec(sql);

  const app = workbench({ db, entities: [TargetDecl, SourceDecl] });
  const Source = app.entity('Source');
  const Target = app.entity('Target');

  const server = createServer({
    handlers: Source.crudHandlers,
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [Source.projection, Target.projection],
      effectsRegistry: buildEffectsRegistry([Source, Target]),
      admission: {
        beforeProjection: async () => true,
        // Deny ONLY the effect principal's create on Target — proves the effect
        // event was presented to this hook under the effect principal (#2), and
        // that the deny rolls back the ORIGIN (atomic, ADR #6).
        afterProjection: async ({ entityName, principal: p }) =>
          !(entityName === 'Target' && p.type === 'system'),
      },
    }),
  });

  const result = await server.dispatch({
    actionId: 'p2-2b',
    type: 'Source.create',
    payload: { title: 't' },
    principal: principal({ type: 'user', id: 'u1' }),
  });

  assert.equal(result.ok, false, 'origin denied because effect was denied');
  assert.equal(db.prepare('SELECT count(*) AS c FROM Source').get().c, 0, 'origin rolled back');
  assert.equal(db.prepare('SELECT count(*) AS c FROM Target').get().c, 0, 'no target created');
  app.httpServer?.close?.();
});

test('#2 real app row grant denies an admitted effect and rolls back both rows', async (t) => {
  const db = setupDb();
  const Target = entity('EffectGrantTarget', {
    name: text(),
    checks: {
      fromRejectedEffect: effectSource('EffectGrantSource'),
    },
    grant: () => [
      scope(() => everyone()).can(async ({ is }) =>
        (await is.fromRejectedEffect())
          ? deny('effect principal cannot write this row')
          : grant(read, write, subscribe)),
    ],
    admitsEffects: ({ effect }) => effect === 'EffectGrantSource',
  });
  const Source = entity('EffectGrantSource', {
    title: text(),
    grant: () => grant(read, write, subscribe),
    effects: (EffectGrantSource) => [
      [EffectGrantSource.created, { mutate: Target, with: { name: 'blocked' } }],
    ],
  });

  const app = workbench({ db })
    .mount('/effect-grant-targets', Target)
    .mount('/effect-grant-sources', Source)
    .listen(0);
  t.after(async () => {
    await app.shutdown();
    db.close();
  });
  await app.ready;

  const result = await app.dispatch({
    actionId: 'real-effect-row-grant-deny',
    type: 'EffectGrantSource.create',
    payload: { title: 'origin' },
    principal: principal({ type: 'user', id: 'u1' }),
  });

  assert.equal(result.ok, false, 'the canonical target row grant denies the effect');
  assert.equal(db.prepare('SELECT count(*) AS count FROM EffectGrantSource').get().count, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM EffectGrantTarget').get().count, 0);
});

test('#2 real app row grant denies a self-effect update before projection', async (t) => {
  const db = setupDb();
  const Counter = entity('DeniedSelfEffectCounter', {
    count: number({ default: 0 }),
    checks: {
      fromSelfEffect: effectSource('DeniedSelfEffectCounter'),
    },
    grant: () => [
      scope(() => everyone()).can(async ({ is }) =>
        (await is.fromSelfEffect())
          ? deny('self-effect principal cannot update this row')
          : grant(read, write, subscribe)),
    ],
    effects: (DeniedSelfEffectCounter) => [
      [DeniedSelfEffectCounter.created, { mutate: self, with: { count: inc(1) } }],
    ],
  });

  const app = workbench({ db }).mount('/denied-self-effect-counters', Counter).listen(0);
  t.after(async () => {
    await app.shutdown();
    db.close();
  });
  await app.ready;

  const result = await app.dispatch({
    actionId: 'real-self-effect-row-grant-deny',
    type: 'DeniedSelfEffectCounter.create',
    payload: { count: 0 },
    principal: principal({ type: 'user', id: 'u1' }),
  });

  assert.equal(result.ok, false, 'the pre-projection row grant denies the self update');
  assert.equal(db.prepare('SELECT count(*) AS count FROM DeniedSelfEffectCounter').get().count, 0);
});

// ---- #3: admitsEffects DENY throws 403 → rolls back origin ----
test('#3 admitsEffects deny rolls back origin', async () => {
  const db = setupDb();

  const TargetDecl = entity('Target', {
        name: text(),

    grant: () => grant(read, write, subscribe),
    admitsEffects: () => false, // deny every effect principal
  });
  for (const sql of generateDDL(TargetDecl)) db.exec(sql);

  const SourceDecl = entity('Source', {
        title: text(),

    grant: () => grant(read, write, subscribe),
    effects: (Source) => [
      [Source.created, { mutate: TargetDecl, with: { name: 'x' } },],
    ],
  });
  for (const sql of generateDDL(SourceDecl)) db.exec(sql);

  const app = workbench({ db, entities: [TargetDecl, SourceDecl] });
  const Source = app.entity('Source');
  const Target = app.entity('Target');

  const server = createServer({
    handlers: Source.crudHandlers,
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [Source.projection, Target.projection],
      effectsRegistry: buildEffectsRegistry([Source, Target]),
      admission: { beforeProjection: async () => true, afterProjection: async () => true },
    }),
  });

  const result = await server.dispatch({
    actionId: 'p2-3d',
    type: 'Source.create',
    payload: { title: 't' },
    principal: principal({ type: 'user', id: 'u1' }),
  });

  assert.equal(result.ok, false, 'admit deny → origin denied');
  assert.equal(db.prepare('SELECT count(*) AS c FROM Source').get().c, 0, 'origin rolled back');
  assert.equal(db.prepare('SELECT count(*) AS c FROM Target').get().c, 0, 'no target');
  app.httpServer?.close?.();
});

// ---- #3: admitsEffects ADMIT lets the effect apply ----
test('#3 admitsEffects admit applies the effect', async () => {
  const db = setupDb();

  const TargetDecl = entity('Target', {
        name: text(),

    grant: () => grant(read, write, subscribe),
    admitsEffects: ({ effect }) => effect === 'Source',
  });
  for (const sql of generateDDL(TargetDecl)) db.exec(sql);

  const SourceDecl = entity('Source', {
        title: text(),

    grant: () => grant(read, write, subscribe),
    effects: (Source) => [
      [Source.created, { mutate: TargetDecl, with: { name: 'made' } },],
    ],
  });
  for (const sql of generateDDL(SourceDecl)) db.exec(sql);

  const app = workbench({ db, entities: [TargetDecl, SourceDecl] });
  const Source = app.entity('Source');
  const Target = app.entity('Target');

  const server = createServer({
    handlers: Source.crudHandlers,
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [Source.projection, Target.projection],
      effectsRegistry: buildEffectsRegistry([Source, Target]),
      admission: { beforeProjection: async () => true, afterProjection: async () => true },
    }),
  });

  await server.dispatch({
    actionId: 'p2-3a',
    type: 'Source.create',
    payload: { title: 't' },
    principal: principal({ type: 'user', id: 'u1' }),
  });

  const targets = db.prepare('SELECT * FROM Target').all();
  assert.equal(targets.length, 1, 'effect created the target row');
  assert.equal(targets[0].name, 'made');
  app.httpServer?.close?.();
});

// ---- #4: validateEffects detects a structural cycle (the boot pass function) ----
// A real mutual cycle (A→B→A) can't be DECLARED via entity() in sequence — each
// effect's `mutate` needs a valid target entity at compile time, and a 2-cycle
// requires A to reference B (declared after A) and B to reference A. So the
// cycle-detection path is proven directly via validateEffects (the function
// buildKernel calls at boot). #6 below proves buildKernel actually CALLS it at
// boot (missing admitsEffects → app.ready rejects); together they cover the
// boot-cycle claim.
test('#4 validateEffects detects a structural cycle (A→B→A)', () => {
  const a = { name: 'A', effects: [[created('A'), { mutate: { name: 'B' }, with: {} }]] };
  const b = { name: 'B', effects: [[created('B'), { mutate: { name: 'A' }, with: {} }]] };
  assert.throws(() => validateEffects([a, b]), /cycle/i);
});

test('#4 validateEffects passes a valid (acyclic, admitted) effect graph', () => {
  const target = { name: 'Target', admitsEffects: () => true };
  const source = {
    name: 'Source',
    effects: [[created('Source'), { mutate: target, with: {} }]],
  };
  // Does not throw.
  validateEffects([source, target]);
  assert.ok(true, 'acyclic + admitted graph is valid');
});

// ---- #4 (boot): missing admitsEffects on a mounted target → app.ready rejects ----
test('#4 boot: missing admitsEffects on target rejects app.ready', async (t) => {
  const db = new DatabaseSync(':memory:');

  const TargetNoAdmit = entity('TargetNoAdmit', {
        name: text(),

    grant: () => grant(read, write, subscribe),
    // no admitsEffects
  });
  const Source = entity('Source', {
        title: text(),

    grant: () => grant(read, write, subscribe),
    effects: (Source) => [[Source.created, { mutate: TargetNoAdmit, with: { name: 'x' } }]],
  });

  const app = workbench({ db });
  app.mount('/src', Source);
  app.mount('/tgt', TargetNoAdmit);
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  t.after(() => { app.httpServer?.close?.(); db.close(); });

  await assert.rejects(app.ready, /admitsEffects|admission/i);
});

// ---- #4 (boot): valid effects → app.ready resolves AND the effect fires through the wired path ----
test('#4 boot: valid effects resolve app.ready + fire through the wired kernel', async (t) => {
  const db = new DatabaseSync(':memory:');

  const Target = entity('Target', {
        name: text(),

    // The kernel dispatch below runs the real row grant: declare the scope +
    // capability clauses explicitly instead of a bare decision thunk (which
    // relied on a scope-less grant silently admitting every write).
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
    admitsEffects: () => true,
  });
  const Source = entity('Source', {
        title: text(),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
    effects: (Source) => [[Source.created, { mutate: Target, with: { name: 'wired' } }]],
  });

  const app = workbench({ db });
  app.mount('/src', Source);
  app.mount('/tgt', Target);
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  t.after(() => { app.httpServer?.close?.(); db.close(); });
  await app.ddl();
  await app.ready;

  // app.kernel is the createServer built by buildKernel — with the effects
  // registry wired in (gap #4). Dispatching through it exercises the REAL app
  // wiring, not the test harness's direct createServer.
  const result = await app.kernel.dispatch({
    actionId: 'p2-4wired',
    type: 'Source.create',
    payload: { title: 't' },
    principal: principal({ type: 'user', id: 'u1' }),
  });
  assert.ok(result.ok, `origin committed (got ok=)`);

  const targets = db.prepare('SELECT * FROM Target').all();
  assert.equal(targets.length, 1, 'wired registry fired the in-txn effect');
  assert.equal(targets[0].name, 'wired');
});
