// Wave 2 lane w2-schema-storage-authority — focused regression coverage for:
//   1. one storage-shape authority (field-strategy.ts) shared by DDL, census,
//      entity-table validation and generated types; one quoteIdent helper.
//   2. one declaration-derived leaf authority for reserved framework names,
//      with no circular import through ddl.ts' top-level defineSqliteSchema.
//   3. explain() reports the same scope-only decision as mayRow (Wave 1 fix).
//   4. owner capabilities are authored once (OWNER_CAPABILITIES).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SUPPORTED_FIELD_TYPES,
  STRATEGIES,
  NON_STRATEGY_FIELD_KINDS,
  MODE_ONLY_FIELD_KINDS,
  STORED_FIELD_KINDS,
  isMainTableField,
  sqlTypeOf,
  storedColumnsOf,
  storedValueTsType,
  fieldShapeError,
  resolveStrategy,
} from '../build/field-strategy.mjs';
import { generateDDL, generateFrameworkDDL, frameworkCursorSchema } from '../build/ddl.mjs';
import {
  frameworkDdlDeclarations,
  frameworkReservedNamesWithoutAuthCompile,
  FRAMEWORK_CURSOR_TABLE_NAMES,
} from '../build/framework-table-names.mjs';
import { frameworkReservedNames, frameworkTableNames } from '../build/schema-table-census.mjs';
import { defineSqliteSchema, quoteIdent } from '../build/sqlite-schema.mjs';
import { generateTypes } from '../build/generate-types.mjs';
import {
  entity, text, ref, scope, explain, mayRow, owner,
} from '../build/internal.mjs';
import { rowCapabilities } from '../build/row-grant.mjs';
import { principal } from '../build/principal.mjs';
import { OWNER_CAPABILITIES } from '../build/auth/membership.mjs';

const src = (relative) => readFileSync(new URL(`../src/${relative}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// 1. Storage-shape authority
// ---------------------------------------------------------------------------

test('DDL acceptance and the strategy table cannot drift: every kind is accounted for', () => {
  const accepted = new Set(Object.keys(SUPPORTED_FIELD_TYPES));
  for (const kind of Object.keys(STRATEGIES)) {
    assert.ok(accepted.has(kind), `strategy kind '${kind}' must be accepted by DDL`);
    assert.doesNotThrow(() => resolveStrategy(kind), `strategy kind '${kind}' must resolve`);
  }
  for (const kind of accepted) {
    assert.ok(
      Object.hasOwn(STRATEGIES, kind) || NON_STRATEGY_FIELD_KINDS.has(kind),
      `DDL kind '${kind}' needs a strategy or a documented non-strategy seam`,
    );
  }
  // The two side-table/ephemeral-style seams are explicit in the ONE authority.
  assert.deepEqual([...NON_STRATEGY_FIELD_KINDS].sort(), ['annotatedText', 'ephemeral']);
  assert.deepEqual([...MODE_ONLY_FIELD_KINDS].sort(), ['computed', 'projected']);
  assert.throws(() => resolveStrategy('ephemeral'), /pace seam/);
  assert.throws(() => resolveStrategy('annotatedText'), /own their DDL/);
  assert.equal(fieldShapeError({ kind: 'value', type: 'text' }), null);
  assert.equal(fieldShapeError({ kind: 'computed', mode: 'stored' }), null);
  assert.equal(fieldShapeError({ kind: 'computed', type: 'text' }), "unknown computed field mode 'undefined'");
  assert.equal(fieldShapeError({ kind: 'value', type: 'bogus' }), "unknown value field type 'bogus'");
});

test('storedColumnsOf / isMainTableField / sqlTypeOf are the single column+type derivation', () => {
  assert.ok(isMainTableField({ kind: 'value', type: 'text' }));
  assert.ok(isMainTableField({ kind: 'computed', mode: 'stored' }));
  assert.equal(isMainTableField({ kind: 'computed', mode: 'pull' }), false);
  assert.equal(isMainTableField({ kind: 'struct', type: 'link' }), false);
  assert.equal(isMainTableField({ kind: 'store', type: 'map' }), false);
  assert.deepEqual([...STORED_FIELD_KINDS].sort(), ['computed', 'crdt', 'hash', 'projected', 'state', 'value']);

  assert.equal(sqlTypeOf({ type: 'boolean' }), 'INTEGER');
  assert.equal(sqlTypeOf({ type: 'date' }), 'INTEGER');
  assert.equal(sqlTypeOf({ type: 'number' }), 'REAL');
  assert.equal(sqlTypeOf({ type: 'text' }), 'TEXT');
  assert.equal(storedValueTsType({ type: 'number' }), 'number');
  assert.equal(storedValueTsType({ type: 'boolean' }), 'boolean');

  assert.deepEqual(storedColumnsOf('title', { kind: 'value', type: 'text' }), [{ name: 'title', type: 'TEXT' }]);
  assert.deepEqual(storedColumnsOf('link', {
    kind: 'struct', type: 'link',
    cells: { source: { kind: 'value', type: 'text' }, weight: { kind: 'value', type: 'number' } },
  }), [{ name: 'link__source', type: 'TEXT' }, { name: 'link__weight', type: 'TEXT' }]);
  assert.deepEqual(storedColumnsOf('members', { kind: 'store', type: 'map' }), []);
  assert.deepEqual(storedColumnsOf('pulled', { kind: 'computed', mode: 'pull' }), []);
});

test('DDL and generated types consume the shared storage shape, not local mirrors', () => {
  const fields = {
    title: { kind: 'value', type: 'text' },
    score: { kind: 'value', type: 'number' },
    active: { kind: 'value', type: 'boolean' },
    link: {
      kind: 'struct', type: 'link',
      cells: { source: { kind: 'value', type: 'text' }, weight: { kind: 'value', type: 'number' } },
    },
    members: { kind: 'store', type: 'map' },
    pulled: { kind: 'computed', mode: 'pull' },
    pushed: { kind: 'computed', mode: 'stored' },
  };
  const mainTable = generateDDL({ name: 'ShapeDoc', fields })[0];
  for (const [name, descriptor] of Object.entries(fields)) {
    for (const column of storedColumnsOf(name, descriptor)) {
      assert.match(mainTable, new RegExp(`"${column.name}" ${column.type}`), `DDL missing ${column.name}`);
    }
  }
  assert.doesNotMatch(mainTable, /"members"/);
  assert.doesNotMatch(mainTable, /"pulled"/);

  const types = generateTypes([{ name: 'ShapeDoc', fields }]);
  assert.match(types, /title: string;/);
  assert.match(types, /score: number;/);
  assert.match(types, /active: boolean;/);
  assert.match(types, /link__source: string;/);
  assert.match(types, /link__weight: string;/);
  const rowBlock = types.slice(
    types.indexOf('export interface ShapeDocRow'),
    types.indexOf('export interface ShapeDocChecks'),
  );
  assert.doesNotMatch(rowBlock, /members:/, 'side-table fields are not stored row columns');

  // The census and schema-owned table validator must ask the same helper, not
  // restate the stored-kind list or the SQL type switch locally.
  assert.match(src('schema-census.ts'), /storedColumnsOf/);
  assert.match(src('schema-entity-validation.ts'), /storedColumnsOf/);
  assert.doesNotMatch(src('schema-census.ts'), /\['value', 'crdt', 'hash', 'state', 'projected'\]/);
  assert.doesNotMatch(src('schema-entity-validation.ts'), /\['value', 'crdt', 'hash', 'state', 'projected'\]/);
});

test('SQL identifiers are quoted by one exported helper', () => {
  assert.equal(quoteIdent('plain'), '"plain"');
  assert.equal(quoteIdent('a"b'), '"a""b"');
  for (const file of ['ddl.ts', 'schema-exact-validation.ts', 'schema-entity-validation.ts']) {
    assert.doesNotMatch(src(file), /function quoteIdent\s*\(/, `${file} still declares its own quoteIdent`);
  }
  assert.match(src('sqlite-schema.ts'), /export function quoteIdent\s*\(/);
});

// ---------------------------------------------------------------------------
// 2. Reserved framework names: one declaration-derived leaf, no ddl.ts cycle
// ---------------------------------------------------------------------------

test('framework reserved names derive from one cycle-free leaf authority', () => {
  assert.doesNotMatch(src('framework-table-names.ts'), /from '\.\/ddl\.ts'/, 'leaf must not import ddl.ts');
  assert.match(src('sqlite-schema.ts'), /frameworkReservedNamesWithoutAuthCompile/);
  assert.doesNotMatch(src('sqlite-schema.ts'), /blobstore _operationalconsumerdeclaration/);
  assert.match(src('schema-table-census.ts'), /frameworkReservedNamesWithoutAuthCompile/);

  assert.deepEqual(generateFrameworkDDL(), frameworkDdlDeclarations(frameworkCursorSchema().ddl));
  for (const name of FRAMEWORK_CURSOR_TABLE_NAMES) {
    assert.ok(frameworkReservedNamesWithoutAuthCompile.has(name.toLowerCase()));
    assert.ok(frameworkTableNames.includes(name));
  }
  for (const name of frameworkReservedNamesWithoutAuthCompile) {
    assert.ok(frameworkReservedNames.has(name), `full registry must include ${name}`);
  }
  // A co-tenant may not squat a framework name before any DDL is executed.
  assert.throws(
    () => defineSqliteSchema({ name: 'co-tenant', tables: [], externalIndexes: [{ name: '_ProjectedCursor' }] }),
    /reserved/i,
  );
  assert.throws(
    () => defineSqliteSchema({ name: 'co-tenant', tables: [], externalIndexes: [{ name: 'idx_Session_schedule_createdAt' }] }),
    /reserved/i,
  );
});

// ---------------------------------------------------------------------------
// 3. explain() agrees with mayRow for scope-only grants
// ---------------------------------------------------------------------------

test('explain reports the exact scope-only decision mayRow makes for every verb', async () => {
  const ScopeOnly = entity('ScopeOnlyDoc', {
    body: text(),
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(({ is }) => is.owner())],
  });
  const row = { id: 's1', owner: 'alice', body: 'hello' };
  const alice = principal({ type: 'user', id: 'alice' });

  for (const verb of ['list', 'read', 'subscribe', 'create', 'update', 'remove', 'admin']) {
    const expected = await mayRow(ScopeOnly, verb, row, alice);
    const result = await explain({ entity: ScopeOnly, row, principal: alice, verb });
    assert.equal(result.grant.type, 'scope-only');
    assert.equal(result.admitted, expected, `admitted must match mayRow for ${verb}`);
    assert.equal(result.grant.verbAdmitted, expected, `verbAdmitted must match mayRow for ${verb}`);
    assert.equal(result.grant.verbRequired, verb);
    assert.deepEqual(result.grant.capabilities, ['read', 'subscribe']);
  }
});

// ---------------------------------------------------------------------------
// 4. Owner capabilities authored once
// ---------------------------------------------------------------------------

test('owner.only() confers the shared OWNER_CAPABILITIES, not a second list', async () => {
  assert.deepEqual(OWNER_CAPABILITIES.map((capability) => capability.capability), ['read', 'write', 'subscribe', 'admin']);
  assert.doesNotMatch(src('owner.ts'), /grant\(read, write, subscribe, admin/);
  assert.match(src('owner.ts'), /OWNER_CAPABILITIES/);
  assert.match(src('auth/membership.ts'), /export const OWNER_CAPABILITIES/);

  const OwnerDoc = entity('OwnerCapDoc', {
    body: text(),
    owner: owner(),
    grant: owner.only(),
  });
  const decision = await rowCapabilities(OwnerDoc, { id: 'o1', owner: 'u1' }, principal({ type: 'user', id: 'u1' }));
  assert.equal(decision.granted, true);
  assert.equal(decision.capabilities.length, OWNER_CAPABILITIES.length);
  OWNER_CAPABILITIES.forEach((capability, index) => {
    assert.equal(decision.capabilities[index], capability, 'capabilities are the SAME identity tokens');
  });
});
