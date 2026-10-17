import { state, text, date, schedule, scope, everyone, grant, read } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import workbench, { entity } from '../build/internal.mjs';

// `state({ values, transitions, effects, auto })` — a finite-state-machine field.
// It is its own KIND (`state`): a closed value domain plus a declared legal-
// transition graph. The values/transitions are config (the legal moves), never
// a free-form column the app may set to anything (fail closed: a move not in the
// graph is rejected). `state.transition(from, to)` is a STATIC method returning a
// typed, stringifiable transition handle usable as a COMPUTED OBJECT KEY in the
// `effects` map (never a magic string — a typed handle, AGENTS no-magic-strings).
// Import-surface scope: deliver the descriptor the entity compiler accepts; the
// transition enforcement, effect wiring, and `auto` scheduler are deferred behavior.

test('state() returns a frozen state-kind descriptor', () => {
  const field = state({ values: ['draft', 'shared', 'archived'] });
  assert.equal(field.kind, 'state');
  assert.equal(field.type, 'state');
  assert.ok(Object.isFrozen(field));
});

test('state carries its declared values, transitions, effects, and auto', () => {
  const field = state({
    values: ['draft', 'shared', 'archived'], transitions: { draft: ['shared'], shared: ['archived', 'draft'], archived: ['draft'] }, auto: { when: 'shared', after: '90d', to: 'archived' }, });
  assert.deepEqual(field.values, ['draft', 'shared', 'archived']);
  assert.deepEqual(field.transitions, {
    draft: ['shared'], shared: ['archived', 'draft'], archived: ['draft'], });
  assert.deepEqual(field.auto, { when: 'shared', after: '90d', to: 'archived' });
  assert.ok(Object.isFrozen(field.values));
  assert.ok(Object.isFrozen(field.transitions));
});

test('state.transition(from, to) is a static method returning a stable, stringifiable handle', () => {
  const handle = state.transition('shared', 'archived');
  // it must be usable as a computed object key — i.e. stringify stably, and two
  // calls for the same pair must produce the SAME key (not a fresh identity).
  const a = state.transition('shared', 'archived');
  const b = state.transition('shared', 'archived');
  assert.equal(String(a), String(b));
  // it must encode the from/to pair (not a magic string the app authored)
  assert.notEqual(String(handle), 'shared');
  assert.match(String(handle), /shared/);
  assert.match(String(handle), /archived/);
  // a different pair must produce a different key
  assert.notEqual(String(state.transition('draft', 'shared')), String(handle));
});

test('a transition handle works as a computed key in an effects map', () => {
  const effects = {
    [state.transition('shared', 'archived')]: { with: { archivedAt: 'now' } }, };
  const key = String(state.transition('shared', 'archived'));
  assert.deepEqual(effects[key], { with: { archivedAt: 'now' } });
});

test('.can(fn) returns a new frozen state descriptor carrying the access fn', () => {
  const fn = async () => true;
  const field = state({ values: ['draft', 'shared'] }).can(fn);
  assert.equal(field.access, fn);
  assert.equal(field.kind, 'state');
  assert.equal(field.type, 'state');
  assert.ok(Object.isFrozen(field));
});

test('a state field compiles into an entity at import', () => {
  const updatedAt = date({ touch: true });
  const Doc = entity('DocWithState', {
    grant: scope(() => everyone()).can(() => grant(read)),     grant: scope(() => everyone()).can(() => grant(read)), status: state({
    grant: scope(() => everyone()).can(() => grant(read)),   values: ['draft', 'shared', 'archived'], transitions: { draft: ['shared'], shared: ['archived', 'draft'], archived: ['draft'] }, effects: { [state.transition('shared', 'archived')]: { with: { archivedAt: date() } } }, auto: { when: 'shared', after: '90d', to: 'archived', from: updatedAt }, }), updatedAt,
    grant: scope(() => everyone()).can(() => grant(read)),  });
  assert.ok(Doc);
});

test('state.effects rejects a transition that is not declared legal', () => {
  assert.throws(
    () => entity('DocStateEffectIllegalTransition', {
      status: state({
        values: ['draft', 'shared', 'archived'],
        transitions: { draft: ['shared'] },
        effects: {
          [state.transition('draft', 'archived')]: { with: { status: 'archived' } },
        },
      }),
      grant: scope(() => everyone()).can(() => grant(read)),
    }),
    /must name a declared legal transition/,
  );
});

test('state.effects rejects durable delivery because transition preimages are transaction-local', () => {
  assert.throws(
    () => entity('DocStateEffectDurable', {
      status: state({
        values: ['draft', 'shared'],
        transitions: { draft: ['shared'] },
        effects: {
          [state.transition('draft', 'shared')]: {
            durable: 'publish-state-change',
            with: { status: 'shared' },
          },
        },
      }),
      grant: scope(() => everyone()).can(() => grant(read)),
    }),
    /cannot be durable because transition preimages are transaction-local/,
  );
});

test('state.auto lowers to a schedule.after update trigger', () => {
  const updatedAt = date({ touch: true });
  const Doc = entity('DocStateAutoSchedule', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status: state({
      values: ['draft', 'shared', 'archived'],
      transitions: { draft: ['shared'], shared: ['archived', 'draft'] },
      auto: { when: 'shared', after: '90d', to: 'archived', from: updatedAt },
    }),
    updatedAt,

  });
  assert.equal(Doc.schedule.update.kind, 'schedule.after');
  assert.equal(Doc.schedule.update.fieldName, 'updatedAt');
  assert.equal(Doc.schedule.update.sourceName, 'updatedAt.status.auto');
  assert.deepEqual(Doc.schedule.update.with, { status: 'archived' });
  assert.match(Doc.schedule.update.whileSql, /status/);
  assert.deepEqual(Doc.schedule.update.whileParams, { __auto_status: 'shared' });
});

test('state.auto coexists with an explicit update schedule', () => {
  const dueAt = date();
  const updatedAt = date({ touch: true });
  const Doc = entity('DocStateAutoAndSchedule', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status: state({
      values: ['draft', 'shared', 'archived'],
      transitions: { draft: ['shared'], shared: ['archived', 'draft'] },
      auto: { when: 'shared', after: '90d', to: 'archived', from: updatedAt },
    }),
    dueAt,
    updatedAt,

    schedule: { update: schedule.at(dueAt, { with: { status: 'shared' } }) },
  });
  assert.ok(Array.isArray(Doc.schedule.update));
  assert.equal(Doc.schedule.update.length, 2);
  assert.deepEqual(Doc.schedule.update.map((trigger) => trigger.sourceName), ['dueAt', 'updatedAt.status.auto']);
});

test('a state handle cannot be compared in scope (fail closed)', () => {
  const Doc = entity('DocStateScopeGuard', {
    grant: scope(() => everyone()).can(() => grant(read)),     grant: scope(() => everyone()).can(() => grant(read)), status: state({ values: ['draft', 'shared'] }),
    grant: scope(() => everyone()).can(() => grant(read)),  });
  assert.throws(
    () => Doc.status.is('draft'), /state field and cannot be compared/, );
});

// ---- RUNTIME tests (Spine C8: strategy + DDL + transition guard) ----

import { resolveStrategy, ValidationError } from '../build/field-strategy.mjs';
import { generateDDL } from '../build/ddl.mjs';
import { executeFrameworkDDL, createServer, durableMutationVariant, buildEffectsRegistry } from '../build/internal.mjs';

function setupDoc() {
  const Doc = entity('DocState', {
    grant: scope(() => everyone()).can(() => grant(read)),
        title: text(),
    status: state({
      values: ['draft', 'shared', 'archived'],
      transitions: { draft: ['shared'], shared: ['archived', 'draft'] },
    }),

  });
  return Doc;
}

test('resolveStrategy("state") resolves and validates correctly', () => {
  const strategy = resolveStrategy('state');
  assert.ok(strategy, 'resolveStrategy should return the state strategy');
  assert.equal(typeof strategy.validate, 'function');
  assert.equal(typeof strategy.apply, 'function');
  assert.equal(typeof strategy.diff, 'function');

  const descriptor = state({ values: ['draft', 'shared', 'archived'] });
  assert.equal(strategy.validate('draft', descriptor), true);
  assert.equal(strategy.validate('shared', descriptor), true);
  assert.equal(strategy.validate('archived', descriptor), true);

  const reason = strategy.validate('nonsense', descriptor);
  assert.ok(typeof reason === 'string', 'invalid value returns a reason string');
  assert.match(reason, /expected one of/);
  assert.match(reason, /draft/);

  const nullReason = strategy.validate(null, descriptor);
  assert.ok(nullReason, 'null is rejected');
});

test('DDL includes a TEXT column for state fields', () => {
  const Doc = setupDoc();
  const sql = generateDDL(Doc);
  assert.ok(Array.isArray(sql));
  const mainDDL = sql[0];
  assert.match(mainDDL, /"status" TEXT/, 'state field should produce a TEXT column');
});

test('create with valid state value persists the row', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const Doc = setupDoc();
  for (const s of generateDDL(Doc)) db.exec(s);

  const app = workbench({ db, entities: [Doc] });
  const Doc_b = app.entity(Doc);

  const server = createServer({
    db,
    handlers: Doc_b.crudHandlers,
    pipeline: durableMutationVariant({
      projectionConsumers: [Doc_b.projection],
    }),
    authorize: () => true,
  });
  t.after(() => db.close());

  const result = await server.dispatch({
    actionId: 'c-valid-1',
    type: 'DocState.create',
    payload: { title: 'test doc', status: 'draft' },
    principal: { id: 'u1' },
  });
  assert.equal(result.ok, true);
  const row = Doc_b.findById(result.events[0].data.id);
  assert.ok(row);
  assert.equal(row.status, 'draft');
});

test('create with invalid state value returns an invalid-input failure', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const Doc = setupDoc();
  for (const s of generateDDL(Doc)) db.exec(s);

  const app = workbench({ db, entities: [Doc] });
  const Doc_b = app.entity(Doc);

  const server = createServer({
    db,
    handlers: Doc_b.crudHandlers,
    pipeline: durableMutationVariant({
      projectionConsumers: [Doc_b.projection],
    }),
    authorize: () => true,
  });
  t.after(() => db.close());

  const result = await server.dispatch({
    actionId: 'c-invalid-1',
    type: 'DocState.create',
    payload: { title: 'test doc', status: 'nonsense' },
    principal: { id: 'u1' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
});

test('update legal transition (draft -> shared) persists', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const Doc = setupDoc();
  for (const s of generateDDL(Doc)) db.exec(s);

  const app = workbench({ db, entities: [Doc] });
  const Doc_b = app.entity(Doc);

  const server = createServer({
    db,
    handlers: Doc_b.crudHandlers,
    pipeline: durableMutationVariant({
      projectionConsumers: [Doc_b.projection],
    }),
    authorize: () => true,
  });
  t.after(() => db.close());

  // Create with 'draft'
  const createResult = await server.dispatch({
    actionId: 'c-legal-1',
    type: 'DocState.create',
    payload: { title: 'legal doc', status: 'draft' },
    principal: { id: 'u1' },
  });
  const docId = createResult.events[0].data.id;

  // Update draft -> shared
  const result = await server.dispatch({
    actionId: 'u-legal-1',
    type: 'DocState.update',
    payload: { id: docId, status: 'shared' },
    principal: { id: 'u1' },
  });
  assert.equal(result.ok, true);
  const row = Doc_b.findById(docId);
  assert.equal(row.status, 'shared');
});

test('state.effects runs only for its declared transition and defaults to the same row', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const Doc = entity('DocStateEffectsRuntime', {
    title: text(),
    status: state({
      values: ['draft', 'shared', 'archived'],
      transitions: { draft: ['shared'], shared: ['archived'] },
      effects: {
        [state.transition('draft', 'shared')]: { with: { title: 'shared by effect' } },
      },
    }),
    reviewStatus: state({
      values: ['draft', 'shared'],
      transitions: { draft: ['shared'] },
    }),
    grant: scope(() => everyone()).can(() => grant(read)),
  });
  for (const sql of generateDDL(Doc)) db.exec(sql);
  const app = workbench({ db, entities: [Doc] });
  const boundDoc = app.entity(Doc);
  const server = createServer({
    db,
    handlers: boundDoc.crudHandlers,
    pipeline: durableMutationVariant({
      projectionConsumers: [boundDoc.projection],
      effectsRegistry: buildEffectsRegistry([boundDoc]),
    }),
    authorize: () => true,
  });
  t.after(() => db.close());

  const created = await server.dispatch({
    actionId: 'state-effect-create',
    type: 'DocStateEffectsRuntime.create',
    payload: { title: 'draft title', status: 'draft', reviewStatus: 'draft' },
    principal: { id: 'u1' },
  });
  const id = created.events[0].data.id;
  await server.dispatch({
    actionId: 'state-effect-unrelated-field',
    type: 'DocStateEffectsRuntime.update',
    payload: { id, reviewStatus: 'shared' },
    principal: { id: 'u1' },
  });
  const unrelatedRow = db.prepare('SELECT title, reviewStatus FROM DocStateEffectsRuntime WHERE id = ?').get(id);
  assert.equal(unrelatedRow.title, 'draft title');
  assert.equal(unrelatedRow.reviewStatus, 'shared');

  await server.dispatch({
    actionId: 'state-effect-share',
    type: 'DocStateEffectsRuntime.update',
    payload: { id, status: 'shared' },
    principal: { id: 'u1' },
  });
  const sharedRow = db.prepare('SELECT title, status FROM DocStateEffectsRuntime WHERE id = ?').get(id);
  assert.equal(sharedRow.title, 'shared by effect');
  assert.equal(sharedRow.status, 'shared');

  await server.dispatch({
    actionId: 'state-effect-archive',
    type: 'DocStateEffectsRuntime.update',
    payload: { id, title: 'archive title', status: 'archived' },
    principal: { id: 'u1' },
  });
  const archivedRow = db.prepare('SELECT title, status FROM DocStateEffectsRuntime WHERE id = ?').get(id);
  assert.equal(archivedRow.title, 'archive title');
  assert.equal(archivedRow.status, 'archived');
});

test('update illegal transition returns invalid-input with zero footprint', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const Doc = setupDoc();
  for (const s of generateDDL(Doc)) db.exec(s);

  const app = workbench({ db, entities: [Doc] });
  const Doc_b = app.entity(Doc);

  const server = createServer({
    db,
    handlers: Doc_b.crudHandlers,
    pipeline: durableMutationVariant({
      projectionConsumers: [Doc_b.projection],
    }),
    authorize: () => true,
  });
  t.after(() => db.close());

  // Create with 'draft'
  const createResult = await server.dispatch({
    actionId: 'c-zero-1',
    type: 'DocState.create',
    payload: { title: 'zero-footprint doc', status: 'draft' },
    principal: { id: 'u1' },
  });
  const docId = createResult.events[0].data.id;

  // Record the log count before illegal update
  const logBefore = db.prepare('SELECT COUNT(*) AS cnt FROM _Log').get();

  // Attempt illegal transition: draft -> archived
  const result = await server.dispatch({
    actionId: 'u-illegal-1',
    type: 'DocState.update',
    payload: { id: docId, status: 'archived' },
    principal: { id: 'u1' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  assert.match(result.failure.message, /illegal transition/);

  // Zero footprint: no _Log rows added
  const logAfter = db.prepare('SELECT COUNT(*) AS cnt FROM _Log').get();
  assert.equal(logAfter.cnt, logBefore.cnt, 'illegal transition must not append _Log rows');

  // Row unchanged
  const row = Doc_b.findById(docId);
  assert.equal(row.status, 'draft');
});

test('update state to current value is a no-op (skips transition check)', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const Doc = setupDoc();
  for (const s of generateDDL(Doc)) db.exec(s);

  const app = workbench({ db, entities: [Doc] });
  const Doc_b = app.entity(Doc);

  const server = createServer({
    db,
    handlers: Doc_b.crudHandlers,
    pipeline: durableMutationVariant({
      projectionConsumers: [Doc_b.projection],
    }),
    authorize: () => true,
  });
  t.after(() => db.close());

  const createResult = await server.dispatch({
    actionId: 'c-noop-1',
    type: 'DocState.create',
    payload: { title: 'noop doc', status: 'draft' },
    principal: { id: 'u1' },
  });
  const docId = createResult.events[0].data.id;

  // Update with same state
  const result = await server.dispatch({
    actionId: 'u-noop-1',
    type: 'DocState.update',
    payload: { id: docId, status: 'draft' },
    principal: { id: 'u1' },
  });
  assert.equal(result.ok, true);
  const row = Doc_b.findById(docId);
  assert.equal(row.status, 'draft');
});

test('update nonexistent row with state change returns invalid-input', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const Doc = setupDoc();
  for (const s of generateDDL(Doc)) db.exec(s);

  const app = workbench({ db, entities: [Doc] });
  const Doc_b = app.entity(Doc);

  const server = createServer({
    db,
    handlers: Doc_b.crudHandlers,
    pipeline: durableMutationVariant({
      projectionConsumers: [Doc_b.projection],
    }),
    authorize: () => true,
  });
  t.after(() => db.close());

  const result = await server.dispatch({
    actionId: 'u-missing-1',
    type: 'DocState.update',
    payload: { id: 'nonexistent-id', status: 'shared' },
    principal: { id: 'u1' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  assert.match(result.failure.message, /no current state/);
});
