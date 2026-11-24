// Wave 1: typed admission refusal, raw-Bun isTransaction normalization, and
// workbench/server declaration parity. Focused executable evidence for the
// package/admission cut; the broader contracts stay in their own test files.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  annotatedText, annotation, annotatedTextCreateAction, durableHistory, entity,
  everyone, failure, grant, read, ref, scope, text, write,
} from '../build/index.mjs';
import workbench, { executeDDL, executeFrameworkDDL } from '../build/internal.mjs';
import * as server from '../build/server.mjs';
import { EMPTY_BLOB_CENSUS } from '../build/blob-census.mjs';
import { createSchemaReport } from '../build/schema-report.mjs';
import { wrapDriver } from '../build/driver.mjs';
import { withReadSnapshot } from '../build/query-scoped-read.mjs';

const ALICE = { type: 'user', id: 'alice', attributes: {} };
const PREFIX = 'AdmissionDoc_body';

const schema = server.defineSqliteSchema({
  name: 'admission-bun-packaging',
  tables: [],
  externalTables: [{ name: 'Project', columns: ['id'] }],
});

function declaration() {
  const Project = entity('Project', {
    owner: ref('User'),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  const Document = entity('AdmissionDoc', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('speakers', { appliesTo: 'text-range', cardinality: 'one', fields: { speaker: text() }, empty: 'delete' }),
      ],
    }).can(() => grant(read, write)),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  return { Project, Document };
}

async function appFor(admit) {
  const db = new DatabaseSync(':memory:');
  const { Project, Document } = declaration();
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('alice')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'alice')");
  executeDDL(Document, db);
  const app = workbench({
    db,
    schema,
    entities: [Project, Document],
    history: durableHistory({ authorize: () => true, actions: {} }),
    annotatedTextAdmission: { families: ['speakers'], admit },
  });
  await app.start();
  return { app, db, Document };
}

// The create import seeds one annotation, so `admit` runs in the create commit
// without needing an authoring binding or a separate edit dispatch.
function createWithAnnotation(app, Document) {
  return app.dispatch({
    ...annotatedTextCreateAction(Document, Document.body, {
      id: 'd1',
      projectId: 'p1',
      ownerId: 'alice',
      source: {
        text: 'hello world',
        ranges: [{ annotationId: 's1', family: 'speakers', start: 0, end: 5, fields: { speaker: 'sp1' } }],
      },
    }),
    actionId: 'create-with-annotation',
    principal: ALICE,
  });
}

async function withApp(admit, run) {
  const ctx = await appFor(admit);
  try {
    return await run(ctx);
  } finally {
    await ctx.app.shutdown();
    ctx.db.close();
  }
}

function assertRolledBack(db) {
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _Log').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _ActionReceipt').get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${PREFIX}_annotation`).get().n, 0);
}

test('a returned WorkbenchFailure propagates its category and message', async () => {
  let seen = null;
  await withApp((change) => {
    seen = change;
    return failure('conflict', 'speaker already archived');
  }, async (ctx) => {
    const result = await createWithAnnotation(ctx.app, ctx.Document);
    assert.equal(result.ok, false);
    assert.equal(result.failure.category, 'conflict');
    assert.equal(result.failure.message, 'speaker already archived');
    assertRolledBack(ctx.db);
  });
  assert.equal(seen.family, 'speakers');
  assert.equal(seen.annotationId, 's1');
  assert.equal(seen.before, null);
  assert.equal(seen.after.fields.speaker, 'sp1');
});

test('a returned { ok: false, failure } outcome refuses with its category', async () => {
  await withApp(() => ({ ok: false, failure: failure('denied', 'not your speaker') }), async (ctx) => {
    const result = await createWithAnnotation(ctx.app, ctx.Document);
    assert.equal(result.ok, false);
    assert.equal(result.failure.category, 'denied');
    assert.equal(result.failure.message, 'not your speaker');
    assertRolledBack(ctx.db);
  });
});

test('a thrown WorkbenchFailure is recognized, not sanitized into internal', async () => {
  await withApp(() => { throw failure('invalid-input', 'speaker label is malformed'); }, async (ctx) => {
    const result = await createWithAnnotation(ctx.app, ctx.Document);
    assert.equal(result.ok, false);
    assert.equal(result.failure.category, 'invalid-input');
    assert.equal(result.failure.message, 'speaker label is malformed');
    assertRolledBack(ctx.db);
  });
});

test('legacy false and plain Error returns keep their old behavior', async () => {
  await withApp(() => false, async (ctx) => {
    const result = await createWithAnnotation(ctx.app, ctx.Document);
    assert.equal(result.ok, false);
    assert.equal(result.failure.category, 'invalid-input');
    assertRolledBack(ctx.db);
  });
  await withApp(() => { throw new Error('secret internal detail'); }, async (ctx) => {
    const result = await createWithAnnotation(ctx.app, ctx.Document);
    assert.equal(result.ok, false);
    assert.equal(result.failure.category, 'internal');
    assert.equal(result.failure.message, 'Internal error.');
    assertRolledBack(ctx.db);
  });
});

test('wrapDriver gives a raw bun-style handle a live isTransaction getter', () => {
  const executed = [];
  let inTransaction = false;
  const raw = {
    prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }),
    exec(sql) { executed.push(sql); },
    get inTransaction() { return inTransaction; },
  };
  const wrapped = wrapDriver(raw);
  assert.strictEqual(wrapped, raw, 'the raw handle is augmented, not proxied');
  assert.equal(wrapped.isTransaction, false);
  inTransaction = true;
  assert.equal(wrapped.isTransaction, true, 'the getter reads the live inTransaction flag');
  inTransaction = false;
  assert.equal(wrapped.isTransaction, false);
  assert.equal(typeof wrapped.txn, 'function');
  assert.equal(typeof wrapped.upsert, 'function');

  // The consumers this seam exists for: withReadSnapshot must not open its own
  // SAVEPOINT while the caller already holds a transaction.
  executed.length = 0;
  inTransaction = true;
  assert.equal(withReadSnapshot(wrapped, () => 'inside'), 'inside');
  assert.equal(executed.some((sql) => sql.startsWith('SAVEPOINT')), false);
  inTransaction = false;
  assert.equal(withReadSnapshot(wrapped, () => 'outside'), 'outside');
  assert.equal(executed.filter((sql) => sql.startsWith('SAVEPOINT')).length, 1);
  assert.equal(executed.filter((sql) => sql.startsWith('RELEASE SAVEPOINT')).length, 1);
});

test('wrapDriver leaves a node-style live isTransaction untouched', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const wrapped = wrapDriver(db);
    assert.equal(wrapped.isTransaction, false);
    db.exec('BEGIN');
    assert.equal(wrapped.isTransaction, true);
    db.exec('COMMIT');
    assert.equal(wrapped.isTransaction, false);
  } finally {
    db.close();
  }
});

test('workbench/server exposes the canonical blob census and schema report', () => {
  assert.strictEqual(server.EMPTY_BLOB_CENSUS, EMPTY_BLOB_CENSUS);
  assert.deepEqual(EMPTY_BLOB_CENSUS.references, []);
  assert.equal(EMPTY_BLOB_CENSUS.byResource.size, 0);
  assert.equal(EMPTY_BLOB_CENSUS.byTableColumn.size, 0);
  assert.strictEqual(server.createSchemaReport, createSchemaReport);

  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE ReportProbe (id TEXT PRIMARY KEY)');
    const report = server.createSchemaReport(db, new Map());
    assert.equal(report.objects.some((entry) => entry.name === 'ReportProbe' && entry.state === 'present'), true);
    assert.deepEqual(report.ledger, createSchemaReport(db, new Map()).ledger);
    assert.equal(typeof server.executeDDL, 'function');
    assert.equal(typeof server.executeFrameworkDDL, 'function');
  } finally {
    db.close();
  }
});
