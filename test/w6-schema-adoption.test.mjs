// w6-schema-adoption.test.mjs — Wave 2 lane w6-boot-schema-adoption.
//
// First-class adoption of pre-existing app-owned tables: one framework call
// replaces the raw pragma_table_info / sqlite_schema introspection an app used
// to hand-write. Adopted tables and their indexes become declaration-only
// census knowledge; this schema never creates, alters, or drops them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench from '../build/app.mjs';
import { entity, grant, read, subscribe, text, write } from '../build/index.mjs';
import { defineSqliteSchema as defineFromServer } from '../build/server.mjs';
import { adoptExternalTables, defineSqliteSchema } from '../build/sqlite-schema.mjs';
import { buildOwnershipCensus, censusKey } from '../build/schema-census.mjs';
import { validateExactSchema } from '../build/schema-exact-validation.mjs';

function scope2Database() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE code_application (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT);');
  db.exec('CREATE INDEX idx_code_application_owner ON code_application(owner);');
  db.exec('CREATE TABLE citation (id TEXT PRIMARY KEY, code_id TEXT NOT NULL, target TEXT);');
  db.exec('CREATE INDEX idx_citation_code ON citation(code_id);');
  return db;
}

test('adoptExternalTables adopts existing app tables + their indexes without touching them', () => {
  const db = scope2Database();
  try {
    const adopted = adoptExternalTables(db, ['code_application', 'citation']);
    assert.deepEqual(adopted, {
      externalTables: [
        { name: 'code_application', columns: ['id', 'title', 'owner'] },
        { name: 'citation', columns: ['id', 'code_id', 'target'] },
      ],
      externalIndexes: [
        { name: 'idx_code_application_owner', table: 'code_application' },
        { name: 'idx_citation_code', table: 'citation' },
      ],
    });
    assert.ok(Object.isFrozen(adopted));
    assert.ok(Object.isFrozen(adopted.externalTables));
    assert.ok(adopted.externalTables.every((table) => Object.isFrozen(table)));
    assert.ok(adopted.externalIndexes.every((index) => Object.isFrozen(index)));

    // Adoption is declaration-only: no DDL is emitted for adopted objects.
    const schema = defineSqliteSchema({ name: 'scope2', tables: [], ...adopted });
    assert.deepEqual(schema.ddl, []);
    assert.deepEqual(schema.tableNames, []);
    assert.deepEqual(schema.externalTables, adopted.externalTables);
    assert.deepEqual(schema.externalIndexes, adopted.externalIndexes);
    schema.prepare(db);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name IN ('code_application', 'citation', 'idx_code_application_owner', 'idx_citation_code')").get().n,
      4,
    );
  } finally {
    db.close();
  }
});

test('adopted tables + indexes pass the exact-schema census at app.start()', async (t) => {
  const db = scope2Database();
  const note = entity('Note', {
    title: text(),
    grant: () => grant(read, write, subscribe),
  });
  const schema = defineFromServer({
    name: 'scope2',
    tables: [],
    adoptTables: { db, tables: ['code_application', 'citation'] },
  });
  const app = workbench({ db, schema }).mount('/notes', note);
  t.after(async () => {
    await app.shutdown();
    db.close();
  });

  await app.start();

  assert.deepEqual(schema.externalTables.map((table) => table.name), ['code_application', 'citation']);
  assert.deepEqual(schema.externalIndexes.map((index) => index.name), [
    'idx_code_application_owner',
    'idx_citation_code',
  ]);
  const report = app.schemaReport();
  assert.ok(report, 'the exact-schema census report is published on boot');
  for (const name of ['code_application', 'citation', 'idx_code_application_owner', 'idx_citation_code']) {
    assert.ok(
      report.objects.some((object) => object.name === name),
      `${name} is attributed by the settled census`,
    );
  }
  // Adopted rows remain readable through the same handle; adoption never hijacks the table.
  db.prepare('INSERT INTO code_application (id, title) VALUES (?, ?)').run('app-1', 'first');
  assert.equal(db.prepare('SELECT title FROM code_application WHERE id = ?').get('app-1').title, 'first');
});

test('adoption plugs into defineSqliteSchema in one line and merges with explicit declarations', () => {
  const db = scope2Database();
  try {
    const schema = defineSqliteSchema({
      name: 'scope2',
      tables: [{ name: 'Local', columns: [{ name: 'id', type: 'text', primaryKey: true }] }],
      externalTables: [{ name: 'Other', columns: ['id'] }],
      externalIndexes: ['other_idx'],
      adoptTables: { db, tables: ['code_application', 'citation'] },
    });
    assert.deepEqual(schema.tableNames, ['Local']);
    assert.deepEqual(schema.externalTables.map((table) => table.name), [
      'Other', 'code_application', 'citation',
    ]);
    assert.deepEqual(schema.externalIndexes.map((index) => index.name), [
      'other_idx', 'idx_code_application_owner', 'idx_citation_code',
    ]);

    // Explicit declarations of the same object win; there is no duplicate claim.
    const merged = defineSqliteSchema({
      name: 'scope2',
      tables: [],
      externalTables: [{ name: 'code_application', columns: ['id'] }],
      adoptTables: { db, tables: ['code_application'] },
    });
    assert.deepEqual(merged.externalTables, [{ name: 'code_application', columns: ['id'] }]);

    schema.prepare(db);
    const census = buildOwnershipCensus({
      framework: { tables: [], indexes: [], triggers: [], virtualTables: [] },
      schemaDeclarations: [schema],
    });
    assert.deepEqual(census.errors, []);
    assert.deepEqual(validateExactSchema(db, census.census, [schema]), []);
  } finally {
    db.close();
  }
});

test('adoptExternalTables with a schema name compiles a full schema description', () => {
  const db = scope2Database();
  try {
    const full = adoptExternalTables(db, ['citation'], {
      name: 'scope2-full',
      tables: [{ name: 'Local', columns: [{ name: 'id', type: 'text', primaryKey: true }] }],
    });
    assert.equal(full.name, 'scope2-full');
    assert.deepEqual(full.tableNames, ['Local']);
    assert.deepEqual(full.externalTables, [{ name: 'citation', columns: ['id', 'code_id', 'target'] }]);
    assert.deepEqual(full.externalIndexes, [{ name: 'idx_citation_code', table: 'citation' }]);
  } finally {
    db.close();
  }
});

test('a missing table fails closed before any schema is compiled', () => {
  const db = scope2Database();
  try {
    assert.throws(() => adoptExternalTables(db, ['code_application', 'does_not_exist']), /does not exist/);
    assert.throws(
      () => defineSqliteSchema({ name: 'scope2', tables: [], adoptTables: { db, tables: ['does_not_exist'] } }),
      /does not exist/,
    );
  } finally {
    db.close();
  }
});

test('an invalid SQL identifier fails closed (table names and index names)', () => {
  const db = scope2Database();
  try {
    for (const bad of ['bad name', 't;DROP TABLE t', 't"x', '', '1table', null, 'sqlite_schema']) {
      assert.throws(() => adoptExternalTables(db, [bad]), /identifier|prefix|non-empty|NUL/i, String(bad));
    }
    db.exec('CREATE INDEX "idx with space" ON citation(target)');
    assert.throws(() => adoptExternalTables(db, ['citation']), /index on adopted table "citation" must be an identifier/);
  } finally {
    db.close();
  }
});

test('adoption keeps exact-schema validation active: an undeclared table still fails boot', async (t) => {
  const db = scope2Database();
  db.exec('CREATE TABLE stray_table (id TEXT PRIMARY KEY);');
  const schema = defineSqliteSchema({ name: 'scope2', tables: [], adoptTables: { db, tables: ['code_application', 'citation'] } });
  const app = workbench({ db, schema });
  t.after(async () => {
    await app.shutdown();
    db.close();
  });
  await assert.rejects(() => app.start(), /observed table "stray_table" is not declared by any lifecycle participant/);
  // The census still owns exactly what adoption declared.
  const { census } = buildOwnershipCensus({ framework: { tables: [], indexes: [], triggers: [], virtualTables: [] }, schemaDeclarations: [schema] });
  assert.deepEqual(census.get(censusKey('table', 'code_application')), {
    kind: 'schema', owner: 'scope2', objectKind: 'table', name: 'code_application',
  });
  assert.deepEqual(census.get(censusKey('index', 'idx_citation_code')), {
    kind: 'schema', owner: 'scope2', objectKind: 'index', name: 'idx_citation_code',
  });
});
