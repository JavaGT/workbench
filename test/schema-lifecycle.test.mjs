import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import workbench from '../build/internal.mjs';
import { defineSqliteSchema } from '../build/server.mjs';
import { SEARCH_STALENESS_LEDGER_DDL, DERIVED_RESOURCE_TABLE_DDL, SCHEMA_MAINTENANCE_TABLE_DDL, SEARCH_STALENESS_TABLE_NAME, DERIVED_RESOURCE_TABLE_NAME, SCHEMA_MAINTENANCE_TABLE_NAME } from '../build/operational-ledger-ddl.mjs';
import { SEARCH_STALENESS_LEDGER_TABLE } from '../build/search-plugin.mjs';
import { DERIVED_RESOURCE_TABLE } from '../build/derived-resource.mjs';
import { SCHEMA_MAINTENANCE_TABLE } from '../build/schema-maintenance.mjs';

function schema() {
  return defineSqliteSchema({
    name: 'lifecycle-test',
    tables: [{
      name: 'Task',
      columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'title', type: 'text', notNull: true }],
      indexes: [{ name: 'idx_task_title', columns: ['title'] }],
      triggers: [{ name: 'task_audit', timing: 'after', event: 'insert', body: 'SELECT 1;' }],
    }],
  });
}

test('schema lifecycle creates a complete machine-readable census and is idempotent on reboot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-schema-lifecycle-'));
  const databasePath = join(root, 'data.sqlite');
  let db = new DatabaseSync(databasePath);
  try {
    const firstApp = workbench({ db, schema: schema() });
    await firstApp.prepareSchema();
    const first = firstApp.schemaReport();
    assert.ok(first);
    assert.equal(first.objects.find((entry) => entry.name === 'Task')?.state, 'present');
    assert.equal(first.objects.find((entry) => entry.name === 'idx_task_title')?.lifecyclePhase, 'indexes-and-constraints');
    assert.equal(first.objects.find((entry) => entry.name === 'task_audit')?.state, 'present');

    const triggerSql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'task_audit'").get().sql;
    db.close();
    // A fresh connection and a fresh app exercise the real process-reboot path.
    db = new DatabaseSync(databasePath);
    const statements = [];
    const exec = db.exec.bind(db);
    db.exec = (sql) => { statements.push(sql); return exec(sql); };
    const rebootedApp = workbench({ db, schema: schema() });
    await rebootedApp.prepareSchema();
    assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'task_audit'").get().sql, triggerSql);
    assert.deepEqual(rebootedApp.schemaReport().ledger, first.ledger);
    assert.equal(statements.some((sql) => /^\s*(?:DROP|DELETE|ALTER)\b/i.test(sql)), false, 'reboot preparation did not run destructive DDL');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema lifecycle reports an undeclared physical object', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE Intruder (id TEXT PRIMARY KEY)');
    const app = workbench({ db, schema: schema() });
    await assert.rejects(app.prepareSchema(), /observed table "Intruder" is not declared by any lifecycle participant/);
    assert.deepEqual(
      app.schemaReport().objects.find((entry) => entry.name === 'Intruder'),
      { name: 'Intruder', kind: 'table', ownerKind: 'undeclared', owner: 'undeclared', lifecyclePhase: 'undeclared', state: 'present' },
    );
  } finally {
    db.close();
  }
});

test('schema lifecycle discriminates declared external fixtures from undeclared intruders', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    // A legitimate application table the app writes (declared ONLY via the
    // externalTables seam) sits beside a genuine intruder. The census must
    // admit exactly the declared fixture and name the intruder.
    db.exec('CREATE TABLE Artefact (id TEXT PRIMARY KEY, project TEXT); CREATE TABLE Intruder (id TEXT PRIMARY KEY)');
    const fixtureSchema = defineSqliteSchema({
      name: 'discrimination-fixtures',
      tables: [],
      externalTables: [{ name: 'Artefact', columns: ['id', 'project'] }],
    });
    const app = workbench({ db, schema: fixtureSchema });
    await assert.rejects(app.prepareSchema(), /observed table "Intruder" is not declared by any lifecycle participant/);
    const artefact = app.schemaReport().objects.find((entry) => entry.name === 'Artefact');
    assert.equal(artefact.ownerKind, 'schema', 'the declared fixture is schema-owned');
    assert.equal(artefact.owner, 'discrimination-fixtures');
    assert.equal(artefact.state, 'present');
    const intruder = app.schemaReport().objects.find((entry) => entry.name === 'Intruder');
    assert.equal(intruder.ownerKind, 'undeclared', 'the undeclared table stays undeclared');
  } finally {
    db.close();
  }
});

test('reboot: lazily materialized operational ledgers stay framework-owned and boot succeeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-op-ledgers-'));
  const databasePath = join(root, 'data.sqlite');
  let db = new DatabaseSync(databasePath);
  try {
    const firstApp = workbench({ db });
    await firstApp.prepareSchema();
    // A settled database may hold the operational ledgers from a previous boot
    // (or a previous lifecycle phase). Materialize all three explicitly.
    for (const ddl of [SEARCH_STALENESS_LEDGER_DDL, DERIVED_RESOURCE_TABLE_DDL, SCHEMA_MAINTENANCE_TABLE_DDL]) {
      db.exec(ddl);
    }
    db.close();
    // Reconstruct the app over the same database: the ledgers must stay
    // framework-owned (declared centrally, not re-admitted as lifecycle
    // strangers) and the boot must succeed.
    db = new DatabaseSync(databasePath);
    const rebootedApp = workbench({ db });
    await rebootedApp.prepareSchema();
    const report = rebootedApp.schemaReport();
    for (const name of [SEARCH_STALENESS_TABLE_NAME, DERIVED_RESOURCE_TABLE_NAME, SCHEMA_MAINTENANCE_TABLE_NAME]) {
      const entry = report.objects.find((object) => object.name === name);
      assert.ok(entry, `${name} appears in the settled schema report`);
      assert.equal(entry.ownerKind, 'framework', `${name} stays framework-owned on reboot`);
      assert.equal(entry.state, 'present', `${name} is present on reboot`);
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('operational-ledger rename drift: the runtime table name each lifecycle module queries equals the census-declared name', () => {
  // The census declares the ledgers framework-owned (operational-ledger-ddl.ts)
  // and the lifecycle modules create/query them by the same single source. An
  // independent literal on either side would let a rename silently separate the
  // runtime-created table from the census-declared name. These pairs must stay
  // equal — the runtime constants are aliases of the census names, not copies.
  const pairs = [
    [SEARCH_STALENESS_LEDGER_TABLE, SEARCH_STALENESS_TABLE_NAME, 'search staleness'],
    [DERIVED_RESOURCE_TABLE, DERIVED_RESOURCE_TABLE_NAME, 'derived resource'],
    [SCHEMA_MAINTENANCE_TABLE, SCHEMA_MAINTENANCE_TABLE_NAME, 'schema maintenance'],
  ];
  for (const [runtimeName, censusName, label] of pairs) {
    assert.equal(runtimeName, censusName, `${label} runtime ledger table must match the census-declared name`);
  }
  // And the census-declared names are what the framework-owned DDL creates.
  assert.match(SEARCH_STALENESS_LEDGER_DDL, new RegExp(`CREATE TABLE IF NOT EXISTS ${SEARCH_STALENESS_TABLE_NAME} `));
  assert.match(DERIVED_RESOURCE_TABLE_DDL, new RegExp(`CREATE TABLE IF NOT EXISTS ${DERIVED_RESOURCE_TABLE_NAME} `));
  assert.match(SCHEMA_MAINTENANCE_TABLE_DDL, new RegExp(`CREATE TABLE IF NOT EXISTS ${SCHEMA_MAINTENANCE_TABLE_NAME} `));
});

test('schema lifecycle rejects an undeclared object created after app construction', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const app = workbench({ db, schema: schema() });
    db.exec('CREATE TABLE Intruder (id TEXT PRIMARY KEY)');

    await assert.rejects(app.prepareSchema(), /observed table "Intruder" is not declared by any lifecycle participant/);
  } finally {
    db.close();
  }
});

test('schema lifecycle attributes foreign key violations to the owning object', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const violatingSchema = defineSqliteSchema({
      name: 'integrity-owner',
      tables: [
        { name: 'Parent', columns: [{ name: 'id', type: 'text', primaryKey: true }] },
        { name: 'Child', columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'parentId', type: 'text' }], foreignKeys: [{ columns: ['parentId'], references: { table: 'Parent', columns: ['id'] } }] },
      ],
    });
    violatingSchema.prepare(db);
    db.exec('PRAGMA foreign_keys = OFF; INSERT INTO Child (id, parentId) VALUES (\'child\', \'missing\'); PRAGMA foreign_keys = ON');
    const app = workbench({ db, schema: violatingSchema });
    await assert.rejects(app.prepareSchema(), /schema "integrity-owner" table "Child" has a foreign key violation/);
  } finally {
    db.close();
  }
});

test('no public API can execute DDL after schema startup', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const app = workbench({ db, schema: schema() });
    await app.prepareSchema();
    const statements = [];
    const exec = db.exec.bind(db);
    const prepare = db.prepare.bind(db);
    db.exec = (sql) => { statements.push(sql); return exec(sql); };
    db.prepare = (sql) => { statements.push(sql); return prepare(sql); };
    await app.prepareSchema();
    await app.ddl();
    app.schemaReport();
    assert.equal(statements.some((sql) => /^\s*(?:CREATE|ALTER|DROP|VACUUM|REINDEX)\b/i.test(sql)), false, 'public APIs cannot reach DDL after startup');
  } finally {
    db.close();
  }
});

test('a failed lifecycle migration leaves its table and ledger record absent', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const app = workbench({ db, migrations: [{
      namespace: 'lifecycle-test', name: 'fails', version: 1,
      up(inner) { inner.exec('CREATE TABLE migration_should_roll_back (id TEXT)'); throw new Error('stop'); },
    }] });
    await assert.rejects(app.prepareSchema(), /migration lifecycle-test@1 failed: stop/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'migration_should_roll_back'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM _SchemaMigration WHERE namespace = 'lifecycle-test' AND version = 1").get(), undefined);
  } finally {
    db.close();
  }
});
