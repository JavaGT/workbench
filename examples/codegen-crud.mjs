// Codegen CRUD exemplar (#182) — the declarative create/update/remove surface
// derived from an entity's field declarations, dispatched over the one
// action/event pipeline. Run from the repo root:
//
//   node examples/codegen-crud.mjs
//
// It shows the three things the codegen owns (and the one it refuses):
//   1. the coverage report — which fields the generated CRUD expresses
//      (M1 whole-value replace kinds) and which stay hand-written;
//   2. the derived action surface — the shaped `${name}.create` / `update` /
//      `remove` dispatch payloads, events with reducers, and §7.3 inverses;
//   3. the derived handlers over the one pipeline (byte-identical parity with
//      the hand-written action is pinned by test/entity-codegen-crud-parity.test.mjs);
//   4. the refusal — a payload touching a merge/stub kind (the map field here)
//      is rejected and points at the hand-written verb.
//
// The codegen module is imported from build/ directly; exposing it as a
// package export is the packaging follow-up.

import { DatabaseSync } from 'node:sqlite';
import workbench, { entity, text, number, ref, map, grant, read, write, subscribe, scope } from 'workbench';
import { codegenCrud } from '../build/entity/codegen-crud.mjs';

// One declaration surface: the entity declaration IS the codegen input.
const Task = entity('Task', {
  title: text({ required: true }),
  points: number({ default: 3 }),
  // merge kind: the outcome (member merge) is not assignment-shaped, so the
  // generated CRUD never touches it — the row handle stays the way in.
  collaborators: map(ref('User'), { default: {} }),
  owner: ref('User', { role: 'owner', readonly: true }),
  grant: () => [
    scope(({ is }) => is.owner()).can(async ({ is }) =>
      (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
  ],
});

const db = new DatabaseSync(':memory:');

// The codegen surface: coverage + actions + events + handlers, all derived.
const crud = codegenCrud(Task);
console.log('coverage:', JSON.stringify(crud.coverage));
console.log('derived actions:', crud.actions.create.type, crud.actions.update.type, crud.actions.remove.type);

// Mount the app and dispatch the derived action payloads through it — no
// hand-written action anywhere. The app settles schema (framework + entity
// tables) at startup, like examples/minimal-note.mjs.
const app = workbench({ db });
app.mount('/tasks', Task);
await app.ready;
await app.start();

const made = await app.dispatch({
  actionId: 'demo-1',
  type: crud.actions.create.type,
  payload: { id: 'task-1', title: 'write the spec', points: 5 },
  principal: { type: 'user', id: 'alice' },
});
console.log('created:', made.ok, JSON.stringify(made.events?.[0]?.data));

const moved = await app.dispatch({
  actionId: 'demo-2',
  type: crud.actions.update.type,
  payload: { id: 'task-1', points: 8 },
  principal: { type: 'user', id: 'alice' },
});
console.log('updated:', moved.ok, JSON.stringify(moved.events?.map((event) => ({ type: event.type, seq: event.seq, data: event.data }))));

// The refusal: a merge/stub kind cannot ride a CRUD payload — the app's
// registered handler rejects it before any event, and the DERIVED handler
// rejects it at its own seam (the parity suite pins both).
const rejected = await app.dispatch({
  actionId: 'demo-3',
  type: crud.actions.update.type,
  payload: { id: 'task-1', collaborators: { bob: { role: 'editor' } } },
  principal: { type: 'user', id: 'alice' },
});
console.log('merge-kind payload:', rejected.ok, rejected.failure?.message);
const derivedRefusal = await crud.handlers['Task.update']({ payload: { id: 'task-1', collaborators: { bob: { role: 'editor' } } }, principal: { type: 'user', id: 'alice' } })
  .then(() => null, (error) => error);
console.log('derived handler refuses:', derivedRefusal?.message);
console.log('(mutate the map through the row handle instead: app.entity(Task).findById("task-1").collaborators.set(...))');

// A non-owner's edit is a hard reject (SPEC §5.4 row floor; byte-identical on
// the derived and hand-written paths per the parity suite).
const denied = await app.dispatch({
  actionId: 'demo-4',
  type: crud.actions.update.type,
  payload: { id: 'task-1', title: 'bob was here' },
  principal: { type: 'user', id: 'bob' },
});
console.log('denied edit:', denied.ok, denied.failure?.category);
