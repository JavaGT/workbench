// E2-B + E2-C: the unified check registry — one source of truth for BOTH the
// compile (scope→SQL) and runtime (per-row) faces of every named check.
//
// The registry is built by `buildCheckRegistry({ fields, declaredChecks, entityName })`.
// Each entry has up to two faces: `harvest` (→ AST node, for scope compilation)
// and `run` (→ boolean, for per-row evaluation). Three sources populate it:
// ref-role fields (both faces), declared checks (both faces), and map-role
// names (runtime-only). Checks that cannot compile (e.g., `is.editor()` in a
// scope predicate) are a load-time error — fail closed, no silent fallback.
//
// Pair every dual-mode check with SQL-shape AND runtime-boolean tests that
// must agree. This file tests the registry directly (unit) and via entity()
// (integration for load-time guards).

import { ref, text, map, scope, grant, read, write, subscribe as _subscribe, deny, anyOf as _anyOf, never } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { buildCheckRegistry } from '../build/registry.mjs';
import workbench from '../build/app.mjs';
import {
  entity, mayVerb, NonCompilableError } from '../build/internal.mjs';
import { principal, anonymous as _anonymous } from '../build/principal.mjs';

const norm = (sql) => sql.replace(/\s+/g, ' ').trim();

// ---- Test 1: owner harvest (compile face) ----
// The registry must produce the SAME SQL as today's roleFieldMap for a ref-role
// field — the owner check lowers to `owner = :p<n>_principalId`.

test('owner check harvests to a typed-FK equality AST (same SQL as before)', () => {
  const TodoList = entity('TodoList', {
        title: text(),
    owner: ref('User', { role: 'owner' }),

    grant: () => [
      scope(({ is }) => is.owner()).can(() => grant(read)),
    ],
  });

  const s = norm(TodoList.readScope.sql);
  assert.match(s, /owner = :p\d+_principalId/);
});

// ---- Test 2: owner run (runtime face) ----
// The registry's ref-role source builds BOTH faces from the ONE field declaration.

test('owner check run face tests principal identity against the FK column', () => {
  const reg = buildCheckRegistry({
    fields: {
      owner: ref('User', { role: 'owner' }),
    },
    declaredChecks: {},
    entityName: 'Test',
  });

  // The owner entry must have BOTH faces.
  assert.equal(typeof reg.owner.harvest, 'function');
  assert.equal(typeof reg.owner.run, 'function');

  // Own row: principal id matches the FK value → true.
  assert.equal(reg.owner.run({ entity: { owner: 'u1' }, principal: { id: 'u1' } }), true);

  // Different principal → false.
  assert.equal(reg.owner.run({ entity: { owner: 'u1' }, principal: { id: 'u2' } }), false);

  // Null FK → false (fail closed — a null owner matches no one).
  assert.equal(reg.owner.run({ entity: { owner: null }, principal: { id: 'u1' } }), false);
});

// ---- Test 3: collaborator run (declared check with membership) ----
// A declared check `collaborator: ({E,principal}) => E.collaborators.has(principal.id)`
// builds BOTH faces: harvest compiles to an EXISTS, run queries the DB.

test('declared check with membership runs against the real DB', () => {
  const db = new DatabaseSync(':memory:');

  // Create the membership side-table that the runtime face will query.
  db.exec(`
    CREATE TABLE IF NOT EXISTS TestEntity_collaborators (
      TestEntity_id TEXT,
      member_id TEXT,
      role TEXT
    )
  `);
  // Insert a test row: principal 'u1' is a member of entity 'L1' (role doesn't
  // matter for the base check — the check just tests membership existence).
  db.exec(`
    INSERT INTO TestEntity_collaborators (TestEntity_id, member_id, role)
    VALUES ('L1', 'u1', 'viewer')
  `);

  const reg = buildCheckRegistry({
    fields: {
      owner: ref('User', { role: 'owner' }),
      // map field: generates membership table TestEntity_collaborators
      collaborators: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),
    },
    declaredChecks: {
      collaborator: ({ TestEntity, principal }) =>
        TestEntity.collaborators.has(principal.id),
    },
    entityName: 'TestEntity',
  });

  // Both faces must exist.
  assert.equal(typeof reg.collaborator.harvest, 'function');
  assert.equal(typeof reg.collaborator.run, 'function');

  // Principal 'u1' IS a member → true.
  assert.equal(
    reg.collaborator.run({ entity: { id: 'L1' }, principal: { id: 'u1' }, runtime: { db } }),
    true,
  );

  // Principal 'u2' is NOT a member → false.
  assert.equal(
    reg.collaborator.run({ entity: { id: 'L1' }, principal: { id: 'u2' }, runtime: { db } }),
    false,
  );

  // Wrong entity (different row id) → false.
  assert.equal(
    reg.collaborator.run({ entity: { id: 'L2' }, principal: { id: 'u1' }, runtime: { db } }),
    false,
  );
});

// ---- Test 4: editor/viewer run (map-role, runtime-only) ----
// Map-role names (from `map(of, { role: [...] })`) get a run face ONLY — no
// harvest face (they inspect a per-row payload the SQL filter never sees).

test('map-role names have a run face only; harvest is undefined', () => {
  const db = new DatabaseSync(':memory:');

  db.exec(`
    CREATE TABLE IF NOT EXISTS Doc_collaborators (
      Doc_id TEXT,
      member_id TEXT,
      role TEXT
    )
  `);
  // Insert a member with role='editor' (NOT 'viewer').
  db.exec(`
    INSERT INTO Doc_collaborators (Doc_id, member_id, role)
    VALUES ('D1', 'u1', 'editor')
  `);

  const reg = buildCheckRegistry({
    fields: {
      owner: ref('User', { role: 'owner' }),
      collaborators: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),
    },
    declaredChecks: {},
    entityName: 'Doc',
  });

  // editor entry: has run face, NO harvest face.
  assert.equal(typeof reg.editor.run, 'function');
  assert.equal(reg.editor.harvest, undefined);

  // viewer entry: has run face, NO harvest face.
  assert.equal(typeof reg.viewer.run, 'function');
  assert.equal(reg.viewer.harvest, undefined);

  // The principal 'u1' IS an editor → editor.run → true.
  assert.equal(
    reg.editor.run({ entity: { id: 'D1' }, principal: { id: 'u1' }, runtime: { db } }),
    true,
  );

  // The principal 'u1' is NOT a viewer → viewer.run → false.
  assert.equal(
    reg.viewer.run({ entity: { id: 'D1' }, principal: { id: 'u1' }, runtime: { db } }),
    false,
  );
});

// ---- Test 5: runtime-only check used in scope → load error ----
// A check with no harvest face (editor from map roles) used in a scope
// predicate must throw at load time with a clear message.

test('runtime-only check in scope throws at entity load', () => {
  assert.throws(
    () => {
      entity('Doc', {
                owner: ref('User', { role: 'owner' }),
        members: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),

        grant: () => [
          // is.editor() has NO harvest face — it's a runtime-only check.
          scope(({ is }) => is.editor()).can(() => grant(read)),
        ],
      });
    },
    (err) => {
      assert.ok(err instanceof NonCompilableError);
      assert.match(err.message, /runtime-only|cannot be used in scope|cannot compile/i);
      return true;
    },
  );
});

// ---- Test 6: unknown check name in scope → load error ----
// A check name not in any source (ref-role, declared, map-role) must throw
// at load time.

test('unknown check name in scope throws at entity load', () => {
  assert.throws(
    () => {
      entity('Bad', {
                body: text(),
        owner: ref('User', { role: 'owner' }),

        grant: () => [
          scope(({ is }) => is.nope()).can(() => grant(read)),
        ],
      });
    },
    (err) => {
      assert.ok(err instanceof NonCompilableError);
      assert.match(err.message, /no check 'nope'|no check.*nope/i);
      return true;
    },
  );
});

// ---- Test 7: ref handle thenable resolves to target scalar fields ----
// When a declared check awaits a non-role ref field, the resolved object
// exposes target scalar FK fields (e.g., canvas.owner) plus map handles
// (e.g., canvas.collaborators.get(...).role).

test('ref handle thenable resolves to target scalar fields and map handles', async () => {
  const db = new DatabaseSync(':memory:');

  db.exec(`
    CREATE TABLE IF NOT EXISTS Canvas (
      id TEXT PRIMARY KEY,
      owner TEXT,
      title TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS Canvas_collaborators (
      Canvas_id TEXT,
      member_id TEXT,
      role TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS RasterLayer (
      id TEXT PRIMARY KEY,
      canvas TEXT,
      name TEXT
    )
  `);

  db.prepare('INSERT INTO Canvas (id, owner, title) VALUES (:id, :owner, :title)').run({
    id: 'c1', owner: 'owner-1', title: 'My Canvas',
  });
  db.prepare('INSERT INTO Canvas_collaborators (Canvas_id, member_id, role) VALUES (:cid, :mid, :role)').run({
    cid: 'c1', mid: 'editor-1', role: 'editor',
  });
  db.prepare('INSERT INTO RasterLayer (id, canvas, name) VALUES (:id, :canvas, :name)').run({
    id: 'L1', canvas: 'c1', name: 'Layer 1',
  });

  const Canvas = entity('Canvas', {
        owner: ref('User', { role: 'owner' }),
    title: text(),
    collaborators: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),

    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read))],
  });

  const RasterLayer = entity('RasterLayer', {
        canvas: ref('Canvas'),
    name: text(),

    checks: {
      layerOwner: async ({ entity, principal }) => {
        const canvas = await entity.canvas;
        return canvas.owner === principal.id;
      },
      layerEditor: async ({ entity, principal }) => {
        const canvas = await entity.canvas;
        return canvas.collaborators.get(principal.id)?.role === 'editor';
      },
    },
    grant: () => [scope(() => never()).can(async ({ is }) => {
      if (await is.layerEditor()) return grant(read, write);
      if (await is.layerOwner()) return grant(read);
      return deny('no access');
    })],
  });

  const app = workbench({ db, entities: [Canvas, RasterLayer] });
  const _CanvasBound = app.entity(Canvas);
  const RasterLayerBound = app.entity(RasterLayer);

  const row = RasterLayerBound.getOrFail('L1');

  const ownerP = principal({ type: 'user', id: 'owner-1' });
  const editorP = principal({ type: 'user', id: 'editor-1' });
  const strangerP = principal({ type: 'user', id: 'stranger-1' });

  assert.equal(await mayVerb(RasterLayerBound, 'read', row, ownerP), true);
  assert.equal(await mayVerb(RasterLayerBound, 'update', row, editorP), true);
  assert.equal(await mayVerb(RasterLayerBound, 'read', row, editorP), true);
  assert.equal(await mayVerb(RasterLayerBound, 'read', row, strangerP), false);
});

// ---- Test 8: entity key is present in declared check context ----
// Photo-editor style checks destructure `{ entity, principal }` instead
// of `{ EntityName, principal }`. The registry passes both keys so either
// style works.

test('entity key is available alongside entity-name key in check context', () => {
  const db = new DatabaseSync(':memory:');

  db.exec(`CREATE TABLE IF NOT EXISTS Target (id TEXT PRIMARY KEY, label TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS Doc (id TEXT PRIMARY KEY, target TEXT)`);

  db.prepare('INSERT INTO Target (id, label) VALUES (:id, :label)').run({
    id: 't1', label: 'hello',
  });
  db.prepare('INSERT INTO Doc (id, target) VALUES (:id, :target)').run({
    id: 'd1', target: 't1',
  });

  const Target = entity('Target', {
        label: text(),

    grant: () => [scope(() => never()).can(() => grant(read))],
  });

  const Doc = entity('Doc', {
        target: ref('Target'),

    checks: {
      labelIsHello: ({ entity }) => entity.target.id === 't1',
    },
    grant: () => [scope(() => never()).can(async ({ is }) => {
      if (await is.labelIsHello()) return grant(read);
      return deny('nope');
    })],
  });

  const app = workbench({ db, entities: [Doc, Target] });
  const DocBound = app.entity(Doc);
  const _TargetBound = app.entity(Target);

  const row = DocBound.getOrFail('d1');
  assert.equal(DocBound.registry.labelIsHello.run({
    entity: row, principal: principal({ type: 'user', id: 'u1' }), runtime: DocBound.runtime,
  }), true);
});

// ---- Test 9: declared check returning a non-AST value in scope → load error ----
// A declared check body that returns a raw value (a runtime-shaped boolean)
// instead of composing framework field handles into an AST node cannot lower to
// SQL. Using it in a scope predicate must fail at load — fail closed, never
// silently dropped from the SQL filter (which would widen row visibility).

test('declared check that returns a non-AST value in scope throws at entity load', () => {
  assert.throws(
    () => {
      entity('Leaky', {
                body: text(),
        owner: ref('User', { role: 'owner' }),

        // A runtime-shaped body: returns a raw boolean, not an AST node.
        checks: {
          secret: ({ principal: p }) => p.id === 'admin',
        },
        grant: () => [
          scope(({ is }) => is.secret()).can(() => grant(read)),
        ],
      });
    },
    (err) => {
      assert.ok(err instanceof NonCompilableError);
      assert.match(err.message, /non-AST|returned a non-AST value/i);
      return true;
    },
  );
});
