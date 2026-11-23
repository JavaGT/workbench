import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

test('executeFrameworkDDL + workbench@7 migrates a pre-historyOrder _ActionReceipt and creates its read index (#124, #283)', async () => {
  const { executeFrameworkDDL } = await import('../build/ddl.mjs');
  const { runWorkbenchMigrations, appliedWorkbenchVersion } = await import('../build/workbench-migrations.mjs');
  const { insertReceipt } = await import('../build/committed-log.mjs');
  const db = new DatabaseSync(':memory:');
  try {
    // The receipt shape BEFORE the historyOrder column existed — creating the
    // (scope, historyOrder) index against this used to fail outright.
    db.exec(`CREATE TABLE _ActionReceipt (
      scope TEXT NOT NULL,
      actionId TEXT NOT NULL,
      committedAt TEXT NOT NULL,
      eventRefs TEXT NOT NULL,
      PRIMARY KEY (scope, actionId)
    );`);
    db.prepare(
      "INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs) VALUES ('Doc:1', 'old-1', '2026-01-01T00:00:00.000Z', '[]')",
    ).run();

    executeFrameworkDDL(db); // must not throw on the legacy shape (defers index to workbench@7)
    runWorkbenchMigrations(db);
    assert.equal(appliedWorkbenchVersion(db), 7);

    const columns = new Set(db.prepare('PRAGMA table_info(_ActionReceipt)').all().map((column) => column.name));
    assert.ok(columns.has('historyOrder'), 'historyOrder column migrated');
    const hasScopeHistoryIndex = db.prepare('PRAGMA index_list(_ActionReceipt)').all().some((index) => {
      const indexed = db.prepare(`PRAGMA index_info("${String(index.name).replaceAll('"', '""')}")`).all().map((column) => column.name);
      return indexed.length === 2 && indexed[0] === 'scope' && indexed[1] === 'historyOrder';
    });
    assert.equal(hasScopeHistoryIndex, true, '(scope, historyOrder) index created after migration');

    // The backfill orders the legacy row; the counter seeds from it.
    assert.equal(db.prepare("SELECT historyOrder FROM _ActionReceipt WHERE actionId = 'old-1'").get().historyOrder, 1);
    assert.equal(insertReceipt(db, 'Doc:1', 'next-2', '2026-02-01T00:00:00.000Z', []), 2);
  } finally {
    db.close();
  }
});

test('frameworkCursorSchema declares _ProjectedCursor and _ConsumerCursor via defineSqliteSchema', async () => {
  const { frameworkCursorSchema } = await import('../build/ddl.mjs');
  const schema = frameworkCursorSchema();

  assert.equal(typeof schema, 'object');
  assert.equal(schema.name, 'framework-cursors');
  assert.ok(Array.isArray(schema.ddl));
  assert.ok(schema.ddl.length >= 2);

  const allSql = schema.ddl.join('\n');
  assert.ok(allSql.includes('_ProjectedCursor'), 'includes ProjectedCursor table');
  assert.ok(allSql.includes('_ConsumerCursor'), 'includes ConsumerCursor table');

  // DDL is valid SQLite — can execute against an in-memory db
  const db = new DatabaseSync(':memory:');
  try {
    schema.prepare(db);

    // Both tables exist and accept rows
    db.prepare(
      'INSERT INTO _ProjectedCursor (entity, field, lastSeq) VALUES (?, ?, ?)',
    ).run('Post', 'hotRank', 0);

    db.prepare(
      'INSERT INTO _ConsumerCursor (consumer, scope, lastSeq) VALUES (?, ?, ?)',
    ).run('projected.async', 'Post:p1', 0);

    const pcRow = db.prepare(
      "SELECT entity, field, lastSeq FROM _ProjectedCursor WHERE entity = 'Post'",
    ).get();
    assert.equal(pcRow.entity, 'Post');
    assert.equal(pcRow.field, 'hotRank');
    assert.equal(pcRow.lastSeq, 0);

    const ccRow = db.prepare(
      "SELECT consumer, scope, lastSeq FROM _ConsumerCursor WHERE consumer = 'projected.async'",
    ).get();
    assert.equal(ccRow.consumer, 'projected.async');
    assert.equal(ccRow.scope, 'Post:p1');
    assert.equal(ccRow.lastSeq, 0);
  } finally {
    db.close();
  }
});

test('generateFrameworkDDL still includes cursor tables (backwards compatible)', async () => {
  const { generateFrameworkDDL } = await import('../build/ddl.mjs');
  const frameworkDdl = generateFrameworkDDL();
  const joined = frameworkDdl.join('\n');

  assert.ok(joined.includes('_ProjectedCursor'), 'generateFrameworkDDL includes ProjectedCursor');
  assert.ok(joined.includes('_ConsumerCursor'), 'generateFrameworkDDL includes ConsumerCursor');

  // Cursor tables appear EXACTLY ONCE (no dupes from both hand-written and schema)
  const pcCount = joined.split('_ProjectedCursor').length - 1;
  assert.equal(pcCount, 1, '_ProjectedCursor must appear exactly once in generateFrameworkDDL');
});

test('the package migrations run under the reserved workbench namespace on a fresh DB (S2/A4 re-home)', async () => {
  const { runWorkbenchMigrations, appliedWorkbenchVersion, WORKBENCH_SUPPLIED_BY } = await import('../build/workbench-migrations.mjs');
  const { ledgerRows, MIGRATION_LEDGER_TABLE } = await import('../build/migrations.mjs');
  const db = new DatabaseSync(':memory:');
  try {
    runWorkbenchMigrations(db);
    assert.equal(appliedWorkbenchVersion(db), 7);

    const rows = ledgerRows(db);
    assert.equal(rows.length, 7, 'all package migrations recorded');
    assert.ok(rows.every((row) => row.namespace === 'workbench'), 'every package migration lives in the workbench namespace');
    assert.deepEqual(
      rows.map((row) => row.version).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.ok(rows.every((row) => row.name.length > 0), 'every package migration records a name');
    assert.ok(rows.every((row) => /^[0-9a-f]{64}$/.test(row.checksum)), 'every package migration records a checksum');
    assert.ok(rows.every((row) => row.suppliedBy === WORKBENCH_SUPPLIED_BY), 'the package lane records its suppliedBy');

    // Re-running is a no-op (idempotent) and the reserved namespace is the only
    // lane the package owns — no other namespace was touched.
    runWorkbenchMigrations(db);
    assert.equal(appliedWorkbenchVersion(db), 7);
    assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${MIGRATION_LEDGER_TABLE}`).get().c, 7);

    // The framework census derives the single namespaced ledger table.
    const { frameworkTableNames } = await import('../build/schema-table-census.mjs');
    assert.ok(
      frameworkTableNames.includes('_SchemaMigration'),
      'the namespaced ledger table is a framework-owned table',
    );
    assert.ok(!frameworkTableNames.includes('_Migration'), 'the legacy app ledger table is gone from the census');
    assert.ok(!frameworkTableNames.includes('_WorkbenchMigration'), 'the legacy workbench ledger table is gone from the census');
  } finally {
    db.close();
  }
});

test('v6 repairs a v4 intermediate annotated-text membership family', async () => {
  const { runWorkbenchMigrations } = await import('../build/workbench-migrations.mjs');
  const { annotationRangeRows, attachAnnotationRange } = await import('../build/annotated-text-storage.mjs');
  const db = new DatabaseSync(':memory:');
  try {
    // Simulate a legacy database whose foreign-key enforcement allowed a
    // dangling membership row; v6 must drop it rather than aborting boot.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`CREATE TABLE Document (id TEXT PRIMARY KEY);
      CREATE TABLE doc_field_annotation (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL,
        FOREIGN KEY (document_id) REFERENCES Document(id)
      );
      CREATE TABLE doc_field_membership (
        annotation_id TEXT NOT NULL,
        start_point TEXT NOT NULL CHECK (json_valid(start_point)),
        end_point TEXT NOT NULL CHECK (json_valid(end_point)),
        PRIMARY KEY (annotation_id, start_point),
        FOREIGN KEY (annotation_id) REFERENCES doc_field_annotation(id) ON DELETE CASCADE
      );
      INSERT INTO Document VALUES ('d1');
      INSERT INTO doc_field_annotation VALUES ('a1', 'd1');
      INSERT INTO doc_field_membership VALUES ('a1', '{"point":1}', '{"point":2}');
      INSERT INTO doc_field_membership VALUES ('orphan', '{"point":8}', '{"point":9}');`);

    runWorkbenchMigrations(db);
    const columns = db.prepare('PRAGMA table_info(doc_field_membership)').all().map((row) => row.name);
    assert.deepEqual(columns, ['annotation_id', 'range_id', 'document_id', 'ordinal']);
    assert.deepEqual([...annotationRangeRows(db, 'doc_field', 'd1')].map((row) => ({ ...row })), [{
      annotation_id: 'a1', ordinal: 0, range_id: 1,
      start_point: '{"point":1}', end_point: '{"point":2}',
    }]);
    attachAnnotationRange(db, 'doc_field', 'd1', 'a1', { point: 2 }, { point: 3 }, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM doc_field_membership').get().count, 2);
    // Membership rows without an annotation are deliberately dropped: the
    // repair preserves only relationships that can satisfy the canonical FK.
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM doc_field_membership WHERE annotation_id = 'orphan'").get().count, 0);
    runWorkbenchMigrations(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM doc_field_membership').get().count, 2, 're-run is a ledger skip');
  } finally {
    db.close();
  }
});

test('v6 converts an empty intermediate family without rows', async () => {
  const { runWorkbenchMigrations } = await import('../build/workbench-migrations.mjs');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE Document (id TEXT PRIMARY KEY);
      CREATE TABLE empty_field_annotation (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, FOREIGN KEY (document_id) REFERENCES Document(id));
      CREATE TABLE empty_field_membership (annotation_id TEXT NOT NULL, start_point TEXT NOT NULL, end_point TEXT NOT NULL, PRIMARY KEY (annotation_id, start_point));`);
    runWorkbenchMigrations(db);
    assert.deepEqual(db.prepare('PRAGMA table_info(empty_field_membership)').all().map((row) => row.name), ['annotation_id', 'range_id', 'document_id', 'ordinal']);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM empty_field_membership').get().count, 0);
  } finally {
    db.close();
  }
});

test('v6 repairs a mixed partial membership schema without aborting boot', async () => {
  const { runWorkbenchMigrations } = await import('../build/workbench-migrations.mjs');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE Document (id TEXT PRIMARY KEY);
      CREATE TABLE partial_field_annotation (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, FOREIGN KEY (document_id) REFERENCES Document(id));
      CREATE TABLE partial_field_membership (
        annotation_id TEXT NOT NULL, start_point TEXT NOT NULL, end_point TEXT NOT NULL,
        range_id INTEGER, PRIMARY KEY (annotation_id, start_point));
      INSERT INTO Document VALUES ('d1');
      INSERT INTO partial_field_annotation VALUES ('a1', 'd1');
      INSERT INTO partial_field_membership VALUES ('a1', '{"point":1}', '{"point":2}', 999);`);
    runWorkbenchMigrations(db);
    assert.deepEqual(db.prepare('PRAGMA table_info(partial_field_membership)').all().map((row) => row.name), ['annotation_id', 'range_id', 'document_id', 'ordinal']);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM partial_field_membership').get().count, 1);
  } finally {
    db.close();
  }
});

test('v7 upgrades legacy _Job, _ActionReceipt, User, TwoFactor, _PendingBlob, and BlobStore columns atomically (#283)', async () => {
  const { runWorkbenchMigrations, appliedWorkbenchVersion } = await import('../build/workbench-migrations.mjs');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE BlobStore (id TEXT PRIMARY KEY, status TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE _PendingBlob (
        pendingKey TEXT PRIMARY KEY,
        blobId TEXT NOT NULL UNIQUE,
        claimTokenHash TEXT NOT NULL,
        principalKey TEXT NOT NULL,
        contentDigest TEXT NOT NULL,
        byteLength INTEGER NOT NULL,
        status TEXT NOT NULL,
        scopeId TEXT,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE _Job (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', enqueuedAt INTEGER NOT NULL);
      CREATE TABLE _ActionReceipt (
        scope TEXT NOT NULL,
        actionId TEXT NOT NULL,
        committedAt TEXT NOT NULL,
        eventRefs TEXT NOT NULL,
        PRIMARY KEY (scope, actionId)
      );
      CREATE TABLE User (id TEXT PRIMARY KEY, username TEXT);
      CREATE TABLE TwoFactor (id TEXT PRIMARY KEY, userId TEXT);
    `);
    const digest = 'a'.repeat(64);
    db.prepare(`INSERT INTO _PendingBlob (pendingKey, blobId, claimTokenHash, principalKey, contentDigest, byteLength, status, scopeId, createdAt)
      VALUES (?, 'b1', 'hash', 'user:u1', ?, 10, 'pending', 'Project:p1', '2026-01-01T00:00:00.000Z')`)
      .run(`Project:p1/res-42/${digest}.pending`, digest);
    db.prepare("INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs) VALUES ('S:1', 'a1', '2026-01-01T00:00:00.000Z', '[]')").run();
    db.prepare("INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs) VALUES ('S:1', 'a2', '2026-01-02T00:00:00.000Z', '[]')").run();

    runWorkbenchMigrations(db);
    assert.equal(appliedWorkbenchVersion(db), 7);

    const colsOf = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    for (const col of ['replacedBy', 'replacedAt', 'cleanupError', 'cleanupAttempts']) {
      assert.ok(colsOf('BlobStore').has(col), `BlobStore.${col} added`);
    }
    for (const col of ['resourceId', 'claimedAt', 'finalizedAt', 'deletedAt', 'deleteActionId', 'recoveryFailure']) {
      assert.ok(colsOf('_PendingBlob').has(col), `_PendingBlob.${col} added`);
    }
    assert.equal(db.prepare("SELECT resourceId FROM _PendingBlob WHERE blobId = 'b1'").get().resourceId, 'res-42');
    for (const col of ['attempts', 'availableAt', 'progress', 'stage', 'scope', 'principalKey', 'operations']) {
      assert.ok(colsOf('_Job').has(col), `_Job.${col} added`);
    }
    for (const col of ['historyOrder', 'actionType', 'actionData', 'principalKey', 'sessionId', 'operation', 'resultData', 'historyRootActionId', 'historyTargetActionId', 'historyOutcome']) {
      assert.ok(colsOf('_ActionReceipt').has(col), `_ActionReceipt.${col} added`);
    }
    assert.equal(db.prepare("SELECT historyOrder FROM _ActionReceipt WHERE actionId = 'a1'").get().historyOrder, 1);
    assert.equal(db.prepare("SELECT historyOrder FROM _ActionReceipt WHERE actionId = 'a2'").get().historyOrder, 2);
    assert.ok(colsOf('User').has('failedLoginAttempts') && colsOf('User').has('lockedUntil'));
    assert.ok(colsOf('TwoFactor').has('totpFailedAttempts') && colsOf('TwoFactor').has('totpLockedUntil'));

    // Re-running is idempotent
    runWorkbenchMigrations(db);
    assert.equal(appliedWorkbenchVersion(db), 7);
  } finally {
    db.close();
  }
});

test('v7 rolls back atomically when a legacy _PendingBlob key cannot recover resourceId (#283)', async () => {
  const { runWorkbenchMigrations, appliedWorkbenchVersion } = await import('../build/workbench-migrations.mjs');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE _Job (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', enqueuedAt INTEGER NOT NULL);
      CREATE TABLE _PendingBlob (
        pendingKey TEXT PRIMARY KEY,
        blobId TEXT NOT NULL UNIQUE,
        claimTokenHash TEXT NOT NULL,
        principalKey TEXT NOT NULL,
        contentDigest TEXT NOT NULL,
        byteLength INTEGER NOT NULL,
        status TEXT NOT NULL,
        scopeId TEXT,
        createdAt TEXT NOT NULL
      );
    `);
    db.prepare(`INSERT INTO _PendingBlob (pendingKey, blobId, claimTokenHash, principalKey, contentDigest, byteLength, status, scopeId, createdAt)
      VALUES ('corrupt-key', 'b1', 'hash', 'user:u1', 'd', 1, 'pending', 'Project:p1', '2026-01-01T00:00:00.000Z')`).run();

    assert.throws(() => runWorkbenchMigrations(db), /cannot recover pending blob resource identity/);
    assert.equal(appliedWorkbenchVersion(db), 0, 'failed v7 rolled back the whole workbench lane');
    const jobCols = new Set(db.prepare('PRAGMA table_info(_Job)').all().map((r) => r.name));
    assert.equal(jobCols.has('attempts'), false, 'earlier ALTER in v7 rolled back with the failed backfill');
  } finally {
    db.close();
  }
});
