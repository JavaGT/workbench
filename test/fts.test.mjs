// FTS (full-text search) tests.
//
// Verifies:
//  - text({ indexed: 'fts' }) descriptor has correct markers
//  - DDL generates FTS5 CREATE VIRTUAL TABLE
//  - .matches() compiles to valid SQL with EXISTS MATCH
//  - Insert/update/delete syncs rows to FTS table
//  - FTS MATCH query returns matching rows
//  - Integration: entity CRUD -> FTS table populated -> .matches() scope filters correctly
//  - No matches returns empty

import { text, ref, scope, grant, deny, read, write, subscribe, everyone, anyOf } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import workbench, {
  entity, NonCompilableError, bindReadScope,
  generateDDL, generateFrameworkDDL,
} from '../build/internal.mjs';
import { principal } from '../build/principal.mjs';
import { FTS_STRATEGY } from '../build/fts-strategy.mjs';
import { lowerToSql, makeNode } from '../build/scope-sql.mjs';

const ownerCan = async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : deny('no');

// Helper: create a simple entity with an owner field.
function entityWithOwner(name, extraFields, opts = {}) {
  return entity(name, {
    owner: ref('User', { role: 'owner', readonly: true }),
    ...extraFields,
    grant: opts.grant || (() => [scope(({ is }) => is.owner()).can(ownerCan)]),
  });
}

// ---- Layer 1: Field descriptor ----

test('text({ indexed: "fts" }) descriptor has indexed marker', () => {
  const d = text({ indexed: 'fts' });
  assert.equal(d.indexed, 'fts');
  assert.equal(d.kind, 'value');
  assert.equal(d.type, 'text');
});

test('text({ indexed: "fts" }) with oneOf', () => {
  const d = text({ indexed: 'fts', oneOf: ['draft', 'published'] });
  assert.equal(d.indexed, 'fts');
  assert.deepEqual(d.oneOf, ['draft', 'published']);
});

test('text() without indexed has no indexed marker', () => {
  const d = text();
  assert.equal(d.indexed, undefined);
});

test('text({ indexed: "bogus" }) throws', () => {
  assert.throws(() => text({ indexed: 'bogus' }), /indexed.*only supports 'fts'/);
});

// ---- Layer 2: FTS5 DDL ----

test('FTS strategy matches descriptors with indexed === "fts"', () => {
  assert.equal(FTS_STRATEGY.matches(text({ indexed: 'fts' })), true);
  assert.equal(FTS_STRATEGY.matches(text()), false);
  assert.equal(FTS_STRATEGY.matches(text.crdt()), false);
});

test('generateDDL includes FTS5 CREATE VIRTUAL TABLE for fts-indexed text fields', () => {
  const Note = entityWithOwner('Note', { body: text({ indexed: 'fts' }) });
  const ddl = generateDDL(Note);
  const ftsLine = ddl.find((s) => s.includes('VIRTUAL TABLE'));
  assert.ok(ftsLine, 'should have a virtual table statement');
  assert.match(ftsLine, /CREATE VIRTUAL TABLE IF NOT EXISTS Note_body_fts/);
  assert.match(ftsLine, /USING fts5\(body, Note_id UNINDEXED\)/);
});

test('generateDDL includes main table and side tables in order', () => {
  const Note = entityWithOwner('Note', { body: text({ indexed: 'fts' }), title: text() });
  const ddl = generateDDL(Note);
  assert.ok(ddl.length >= 2, 'should have at least main table + fts table');
  assert.match(ddl[0], /CREATE TABLE IF NOT EXISTS "Note"/);
  assert.match(ddl[1], /CREATE VIRTUAL TABLE.*Note_body_fts/);
});

test('entity without fts fields generates no fts ddl', () => {
  const Note = entityWithOwner('Note', { body: text() });
  const ddl = generateDDL(Note);
  const ftsLines = ddl.filter((s) => s.includes('VIRTUAL TABLE'));
  assert.equal(ftsLines.length, 0);
});

// ---- Layer 3: .matches() scope predicate ----

test('.matches(query) on entity handle returns match AST node', () => {
  const Note = entityWithOwner('Note', { body: text({ indexed: 'fts' }) });
  const matchNode = Note.body.matches('search term');
  assert.equal(matchNode.node, 'match');
  assert.equal(matchNode.entity, 'Note');
  assert.equal(matchNode.field, 'body');
  assert.equal(matchNode.value, 'search term');
});

test('.matches() on non-fts field throws NonCompilableError', () => {
  const Note = entityWithOwner('Note', { body: text() });
  assert.throws(() => Note.body.matches('test'), NonCompilableError);
});

test('.matches(empty) throws on fts field', () => {
  const Note = entityWithOwner('Note', { body: text({ indexed: 'fts' }) });
  assert.throws(() => Note.body.matches(''), NonCompilableError);
});

test('lowerToSql on match node produces correlated EXISTS MATCH', () => {
  const matchNode = makeNode({ node: 'match', entity: 'Doc', field: 'body', value: 'hello' });
  const result = lowerToSql(matchNode);
  assert.ok(result.sql.includes('EXISTS'), 'should be an EXISTS');
  assert.ok(result.sql.includes('Doc_body_fts'), 'should reference the FTS table');
  assert.ok(result.sql.includes('MATCH'), 'should contain MATCH');
  assert.ok(result.sql.includes('Doc_id'), 'should include entity_id column');
  assert.ok(result.sql.includes('= t0.id'), 'should correlate with main table id');
  // MATCH uses full table name, not alias (FTS5 limitation)
  const matchPart = result.sql.match(/Doc_body_fts\s+MATCH/);
  assert.ok(matchPart, 'MATCH should use full table name Doc_body_fts');
  const paramKeys = Object.keys(result.params);
  const ftsKey = paramKeys.find((k) => k.endsWith('_ftsQuery'));
  assert.ok(ftsKey, 'should have a ftsQuery param');
  assert.equal(result.params[ftsKey], 'hello');
});

test('.matches() used in scope via fields proxy compiles correctly', () => {
  const Doc = entity('Doc', {
    body: text({ indexed: 'fts' }),
    owner: text(),
    grant: () => [scope(({ fields }) => fields.body.matches('hello world')).can(ownerCan)],
  });
  const s = Doc.readScope.sql.replace(/\s+/g, ' ').trim();
  assert.ok(s.includes('Doc_body_fts'), 'should reference FTS table');
  assert.ok(s.includes('MATCH'), 'should contain MATCH');
  assert.ok(s.includes('= t0.id'), 'should correlate with t0.id');
  const paramKeys = Object.keys(Doc.readScope.params);
  const ftsKey = paramKeys.find((k) => k.endsWith('_ftsQuery'));
  assert.ok(ftsKey, 'should have a ftsQuery param');
  assert.equal(Doc.readScope.params[ftsKey], 'hello world');
});

// ---- Layer 4: Lifecycle sync ----

function setupFtsDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode=WAL');

  const Doc = entity('Doc', {
    title: text({ indexed: 'fts' }),
    body: text({ indexed: 'fts' }),
    status: text(),
    owner: text(),
    grant: () => [scope(() => everyone()).can(ownerCan)],
  });

  // Execute DDL
  for (const sql of generateDDL(Doc)) {
    db.exec(sql);
  }

  return { db, Doc };
}

test('FTS insert sync: created event populates FTS virtual table via projectionApply', () => {
  const { db } = setupFtsDb();

  // Simulate a created event flowing through the projection
  const event = {
    type: 'Doc.created',
    handle: { brand: 'event-handle', entity: 'Doc', kind: 'created' },
    data: { id: 'row-1', title: 'Hello World', body: 'This is the body', status: 'draft', owner: 'user-1' },
  };

  FTS_STRATEGY.projectionApply({
    entityName: 'Doc',
    fieldEntries: [['title', text({ indexed: 'fts' })], ['body', text({ indexed: 'fts' })]],
    handle: event.handle,
    event,
    db,
  });

  const ftsTitleRow = db.prepare(`SELECT * FROM Doc_title_fts WHERE Doc_id = :id`).get({ id: 'row-1' });
  assert.ok(ftsTitleRow, 'FTS title table should have the row');
  assert.equal(ftsTitleRow.title, 'Hello World');

  const ftsBodyRow = db.prepare(`SELECT * FROM Doc_body_fts WHERE Doc_id = :id`).get({ id: 'row-1' });
  assert.ok(ftsBodyRow, 'FTS body table should have the row');
  assert.equal(ftsBodyRow.body, 'This is the body');
});

test('FTS update sync: projectionApply re-indexes on update', () => {
  const { db } = setupFtsDb();

  // Seed FTS row
  db.prepare(`INSERT INTO Doc_title_fts (title, Doc_id) VALUES (:title, :id)`)
    .run({ title: 'Original', id: 'row-2' });

  // Simulate updated event
  const event = {
    type: 'Doc.updated',
    handle: { brand: 'event-handle', entity: 'Doc', kind: 'updated' },
    data: { id: 'row-2', title: 'Updated Title' },
  };

  FTS_STRATEGY.projectionApply({
    entityName: 'Doc',
    fieldEntries: [['title', text({ indexed: 'fts' })]],
    handle: event.handle,
    event,
    db,
  });

  const ftsRow = db.prepare(`SELECT * FROM Doc_title_fts WHERE Doc_id = :id`).get({ id: 'row-2' });
  assert.ok(ftsRow);
  assert.equal(ftsRow.title, 'Updated Title');
});

test('FTS delete sync: removed event deletes FTS rows via projectionApply', () => {
  const { db } = setupFtsDb();

  // Seed FTS rows
  db.prepare(`INSERT INTO Doc_title_fts (title, Doc_id) VALUES (:title, :id)`)
    .run({ title: 'Delete Me', id: 'row-3' });
  db.prepare(`INSERT INTO Doc_body_fts (body, Doc_id) VALUES (:body, :id)`)
    .run({ body: 'Body text', id: 'row-3' });

  // Simulate removed event
  const event = {
    type: 'Doc.removed',
    handle: { brand: 'event-handle', entity: 'Doc', kind: 'removed' },
    data: { id: 'row-3' },
  };

  FTS_STRATEGY.projectionApply({
    entityName: 'Doc',
    fieldEntries: [['title', text({ indexed: 'fts' })], ['body', text({ indexed: 'fts' })]],
    handle: event.handle,
    event,
    db,
  });

  const titleRow = db.prepare(`SELECT * FROM Doc_title_fts WHERE Doc_id = :id`).get({ id: 'row-3' });
  assert.equal(titleRow, undefined, 'FTS title row should be deleted');
  const bodyRow = db.prepare(`SELECT * FROM Doc_body_fts WHERE Doc_id = :id`).get({ id: 'row-3' });
  assert.equal(bodyRow, undefined, 'FTS body row should be deleted');
});

test('FTS MATCH query returns matching rows', () => {
  const db = new DatabaseSync(':memory:');
  const sql = `
    CREATE TABLE IF NOT EXISTS Doc (id TEXT PRIMARY KEY, title TEXT, body TEXT, status TEXT, owner TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS Doc_title_fts USING fts5(title, Doc_id UNINDEXED);
    CREATE VIRTUAL TABLE IF NOT EXISTS Doc_body_fts USING fts5(body, Doc_id UNINDEXED);
  `.split(';').filter(s => s.trim()).forEach(s => db.exec(s + ';'));

  db.prepare(`INSERT INTO Doc (id, title, body, status) VALUES (:id, :title, :body, :status)`)
    .run({ id: '1', title: 'Hello World', body: 'Introduction text', status: 'draft' });
  db.prepare(`INSERT INTO Doc_title_fts (title, Doc_id) VALUES (:title, :id)`)
    .run({ title: 'Hello World', id: '1' });

  db.prepare(`INSERT INTO Doc (id, title, body, status) VALUES (:id, :title, :body, :status)`)
    .run({ id: '2', title: 'Goodbye Moon', body: 'Another document', status: 'published' });
  db.prepare(`INSERT INTO Doc_title_fts (title, Doc_id) VALUES (:title, :id)`)
    .run({ title: 'Goodbye Moon', id: '2' });

  db.prepare(`INSERT INTO Doc (id, title, body, status) VALUES (:id, :title, :body, :status)`)
    .run({ id: '3', title: 'Hello Again', body: 'Third entry', status: 'draft' });
  db.prepare(`INSERT INTO Doc_title_fts (title, Doc_id) VALUES (:title, :id)`)
    .run({ title: 'Hello Again', id: '3' });

  // FTS5 MATCH must use full table name, not alias
  const titleResults = db.prepare(
    `SELECT t0.id, t0.title FROM Doc AS t0 WHERE EXISTS (SELECT 1 FROM Doc_title_fts WHERE Doc_title_fts MATCH :q AND Doc_title_fts.Doc_id = t0.id)`
  ).all({ q: 'hello' });
  assert.equal(titleResults.length, 2, 'should find 2 matching titles');
  const titles = titleResults.map((r) => r.title).sort();
  assert.deepEqual(titles, ['Hello Again', 'Hello World']);

  const moonResults = db.prepare(
    `SELECT t0.id, t0.title FROM Doc AS t0 WHERE EXISTS (SELECT 1 FROM Doc_title_fts WHERE Doc_title_fts MATCH :q AND Doc_title_fts.Doc_id = t0.id)`
  ).all({ q: 'moon' });
  assert.equal(moonResults.length, 1);
  assert.equal(moonResults[0].title, 'Goodbye Moon');
});

test('no matches returns empty', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS Doc (id TEXT PRIMARY KEY, title TEXT)`.replace(/\n/g, ' '));
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS Doc_title_fts USING fts5(title, Doc_id UNINDEXED)`.replace(/\n/g, ' '));
  db.prepare(`INSERT INTO Doc (id, title) VALUES (:id, :title)`).run({ id: '1', title: 'Hello World' });
  db.prepare(`INSERT INTO Doc_title_fts (title, Doc_id) VALUES (:title, :id)`).run({ title: 'Hello World', id: '1' });
  const results = db.prepare(
    `SELECT t0.id FROM Doc AS t0 WHERE EXISTS (SELECT 1 FROM Doc_title_fts WHERE Doc_title_fts MATCH :q AND Doc_title_fts.Doc_id = t0.id)`
  ).all({ q: 'nonexistent' });
  assert.equal(results.length, 0, 'no matches should return empty');
});

test('multiple FTS fields on one entity work independently', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS Doc (id TEXT PRIMARY KEY, title TEXT, body TEXT, status TEXT, owner TEXT)`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS Doc_title_fts USING fts5(title, Doc_id UNINDEXED)`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS Doc_body_fts USING fts5(body, Doc_id UNINDEXED)`);

  db.prepare(`INSERT INTO Doc (id, title, body) VALUES (:id, :title, :body)`).run({ id: '1', title: 'Apple Recipe', body: 'Contains banana' });
  db.prepare(`INSERT INTO Doc_title_fts (title, Doc_id) VALUES (:title, :id)`).run({ title: 'Apple Recipe', id: '1' });
  db.prepare(`INSERT INTO Doc_body_fts (body, Doc_id) VALUES (:body, :id)`).run({ body: 'Contains banana', id: '1' });

  db.prepare(`INSERT INTO Doc (id, title, body) VALUES (:id, :title, :body)`).run({ id: '2', title: 'Banana Smoothie', body: 'Tasty apple drink' });
  db.prepare(`INSERT INTO Doc_title_fts (title, Doc_id) VALUES (:title, :id)`).run({ title: 'Banana Smoothie', id: '2' });
  db.prepare(`INSERT INTO Doc_body_fts (body, Doc_id) VALUES (:body, :id)`).run({ body: 'Tasty apple drink', id: '2' });

  const titleApple = db.prepare(
    `SELECT t0.id FROM Doc AS t0 WHERE EXISTS (SELECT 1 FROM Doc_title_fts WHERE Doc_title_fts MATCH :q AND Doc_title_fts.Doc_id = t0.id)`
  ).all({ q: 'apple' });
  assert.equal(titleApple.length, 1);
  assert.equal(titleApple[0].id, '1');

  const bodyApple = db.prepare(
    `SELECT t0.id FROM Doc AS t0 WHERE EXISTS (SELECT 1 FROM Doc_body_fts WHERE Doc_body_fts MATCH :q AND Doc_body_fts.Doc_id = t0.id)`
  ).all({ q: 'apple' });
  assert.equal(bodyApple.length, 1);
  assert.equal(bodyApple[0].id, '2');
});

test('.matches() integrated in scope with anyOf and other predicates', () => {
  const Doc = entity('Doc', {
    title: text({ indexed: 'fts' }),
    status: text(),
    grant: () => [scope(({ fields }) => anyOf(
      fields.title.matches('urgent'),
      fields.status.is('published'),
    )).can(ownerCan)],
  });
  const s = Doc.readScope.sql.replace(/\s+/g, ' ').trim();
  assert.ok(s.includes('Doc_title_fts'), 'should reference FTS table');
  assert.ok(s.includes('MATCH'), 'should contain MATCH');
});

// ---- projectionApply unit tests ----

test('FTS projectionApply handles created event (syncs side table, does not claim)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS Doc_title_fts USING fts5(title, Doc_id UNINDEXED)`);

  const event = {
    type: 'Doc.created',
    handle: { brand: 'event-handle', entity: 'Doc', kind: 'created' },
    data: { id: 'abc', title: 'Synced Title', body: 'Body text', status: 'draft' },
  };

  const applied = FTS_STRATEGY.projectionApply({
    entityName: 'Doc',
    fieldEntries: [['title', text({ indexed: 'fts' })]],
    handle: event.handle,
    event,
    db,
  });
  assert.equal(applied, false, 'created must not claim the event so the main row materializes');

  const ftsRow = db.prepare('SELECT * FROM Doc_title_fts WHERE Doc_id = :id').get({ id: 'abc' });
  assert.ok(ftsRow);
  assert.equal(ftsRow.title, 'Synced Title');
});

test('FTS projectionApply handles updated event (syncs side table, does not claim)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS Doc_title_fts USING fts5(title, Doc_id UNINDEXED)`);
  db.prepare(`INSERT INTO Doc_title_fts (title, Doc_id) VALUES (:title, :id)`)
    .run({ title: 'Old Title', id: 'xyz' });

  const event = {
    type: 'Doc.updated',
    handle: { brand: 'event-handle', entity: 'Doc', kind: 'updated' },
    data: { id: 'xyz', title: 'New Title' },
  };

  const applied = FTS_STRATEGY.projectionApply({
    entityName: 'Doc',
    fieldEntries: [['title', text({ indexed: 'fts' })]],
    handle: event.handle,
    event,
    db,
  });
  assert.equal(applied, false, 'updated must not claim the event so the main row updates');

  const ftsRow = db.prepare('SELECT * FROM Doc_title_fts WHERE Doc_id = :id').get({ id: 'xyz' });
  assert.ok(ftsRow);
  assert.equal(ftsRow.title, 'New Title');
});

test('FTS projectionApply handles updated event with null value (clears FTS)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS Doc_title_fts USING fts5(title, Doc_id UNINDEXED)`);
  db.prepare(`INSERT INTO Doc_title_fts (title, Doc_id) VALUES (:title, :id)`)
    .run({ title: 'Old Title', id: 'null-test' });

  const event = {
    type: 'Doc.updated',
    handle: { brand: 'event-handle', entity: 'Doc', kind: 'updated' },
    data: { id: 'null-test', title: null },
  };

  FTS_STRATEGY.projectionApply({
    entityName: 'Doc',
    fieldEntries: [['title', text({ indexed: 'fts' })]],
    handle: event.handle,
    event,
    db,
  });

  const ftsRow = db.prepare('SELECT * FROM Doc_title_fts WHERE Doc_id = :id').get({ id: 'null-test' });
  assert.equal(ftsRow, undefined);
});

test('FTS projectionApply handles removed event (does not claim)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS Doc_title_fts USING fts5(title, Doc_id UNINDEXED)`);
  db.prepare(`INSERT INTO Doc_title_fts (title, Doc_id) VALUES (:title, :id)`)
    .run({ title: 'Will be deleted', id: 'del-me' });

  const event = {
    type: 'Doc.removed',
    handle: { brand: 'event-handle', entity: 'Doc', kind: 'removed' },
    data: { id: 'del-me' },
  };

  const applied = FTS_STRATEGY.projectionApply({
    entityName: 'Doc',
    fieldEntries: [['title', text({ indexed: 'fts' })]],
    handle: event.handle,
    event,
    db,
  });
  assert.equal(applied, false, 'removed should return false so CRUD handler runs');

  const ftsRow = db.prepare('SELECT * FROM Doc_title_fts WHERE Doc_id = :id').get({ id: 'del-me' });
  assert.equal(ftsRow, undefined);
});

test('FTS projectionApply ignores events without id', () => {
  const db = new DatabaseSync(':memory:');
  const event = {
    type: 'Doc.created',
    handle: { brand: 'event-handle', entity: 'Doc', kind: 'created' },
    data: { title: 'No ID' },
  };
  const applied = FTS_STRATEGY.projectionApply({
    entityName: 'Doc',
    fieldEntries: [['title', text({ indexed: 'fts' })]],
    handle: event.handle,
    event,
    db,
  });
  assert.equal(applied, false);
});

test('FTS DDL from strategy matches expected SQL', () => {
  const ddl = FTS_STRATEGY.ddl('Doc', 'title', text({ indexed: 'fts' }));
  assert.match(ddl, /CREATE VIRTUAL TABLE IF NOT EXISTS Doc_title_fts/);
  assert.match(ddl, /USING fts5\(title, Doc_id UNINDEXED\)/);
});

// ---- integration tests ----

test('entity with FTS field compiled scope parameters include ftsQuery', () => {
  const Doc = entity('Doc', {
    title: text({ indexed: 'fts' }),
    status: text(),
    grant: () => [scope(({ fields }) => fields.title.matches('test query')).can(ownerCan)],
  });
  const paramKeys = Object.keys(Doc.readScope.params);
  const ftsKey = paramKeys.find((k) => k.endsWith('_ftsQuery'));
  assert.ok(ftsKey);
  assert.equal(Doc.readScope.params[ftsKey], 'test query');
});

test('scope with fts match compiles to executable SQL', () => {
  const Doc = entity('Doc', {
    title: text({ indexed: 'fts' }),
    status: text(),
    grant: () => [scope(({ fields }) => fields.title.matches('hello')).can(ownerCan)],
  });

  const db = new DatabaseSync(':memory:');
  for (const sql of generateDDL(Doc)) {
    db.exec(sql);
  }
  db.prepare(`INSERT INTO Doc (id, title, status) VALUES (:id, :title, :status)`)
    .run({ id: '1', title: 'Hello World', status: 'draft' });
  db.prepare(`INSERT INTO Doc (id, title, status) VALUES (:id, :title, :status)`)
    .run({ id: '2', title: 'Goodbye', status: 'draft' });
  db.prepare(`INSERT INTO Doc_title_fts (title, Doc_id) VALUES (:title, :id)`)
    .run({ title: 'Hello World', id: '1' });
  db.prepare(`INSERT INTO Doc_title_fts (title, Doc_id) VALUES (:title, :id)`)
    .run({ title: 'Goodbye', id: '2' });

  const bound = bindReadScope(Doc.readScope, principal({ type: 'user', id: 'u1' }));
  const ftsKey = Object.keys(Doc.readScope.params).find((k) => k.endsWith('_ftsQuery'));
  bound.params[ftsKey] = 'hello';
  const rows = db.prepare(`SELECT title FROM Doc AS t0 WHERE ${bound.sql}`).all(bound.params);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Hello World');
});

test('FTS fields are ignored by scope SQL when .matches() not used', () => {
  const Doc = entity('Doc', {
    title: text({ indexed: 'fts' }),
    status: text(),
    grant: () => [scope(() => everyone()).can(ownerCan)],
  });
  const s = Doc.readScope.sql.replace(/\s+/g, ' ').trim();
  assert.equal(s, '1 = 1');
  assert.deepEqual(Doc.readScope.params, {});
});

// ---- main-row materialization through full dispatch (issue #86) ----
//
// FTS projectionApply must sync the side table AND return false so the CRUD
// projection still materializes the main entity row. Previously it returned
// true for created/updated, short-circuiting the main row and failing the
// post-projection admission, which denied/rolled back the dispatch.

function ftsDispatchDb() {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);

  const Note = entity('Note', {
    body: text({ indexed: 'fts' }),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write) : grant(read)),
    ],
  });

  for (const sql of Note.generateDDL()) db.exec(sql);
  const app = workbench({ db, entities: [Note] });
  const Note_b = app.entity(Note);
  return { db, Note_b };
}

test('dispatch: create FTS-indexed entity materializes main row and commits', async () => {
  const { db, Note_b } = ftsDispatchDb();

  const { createServer, durableMutationVariant } = await import('../build/pipeline.mjs');
  const server = createServer({
    handlers: {
      'Note.create': ({ payload, principal }) => {
        const data = { ...payload };
        data.id = randomUUID();
        data.owner = principal.id;
        return [{ type: 'Note.created', scope: 'Note:new', data }];
      },
    },
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      projectionConsumers: [Note_b.projection],
    }),
  });

  const result = await server.dispatch({
    actionId: 'fts-create-1',
    type: 'Note.create',
    payload: { body: 'searchable body' },
    principal: { id: 'u1' },
  });

  assert.equal(result.ok, true, 'dispatch must commit');
  const row = db.prepare('SELECT * FROM Note WHERE body = ?').get('searchable body');
  assert.ok(row, 'main entity row must be materialized by the projection');
  assert.equal(row.owner, 'u1');
  const ftsRow = db.prepare('SELECT * FROM Note_body_fts WHERE Note_id = ?').get(row.id);
  assert.ok(ftsRow, 'FTS side-table row must be synced');
  assert.equal(ftsRow.body, 'searchable body');
});

test('dispatch: update FTS-indexed entity materializes main row update and commits', async () => {
  const { db, Note_b } = ftsDispatchDb();
  const row = Note_b.create({ body: 'original' });

  const { createServer, durableMutationVariant } = await import('../build/pipeline.mjs');
  const server = createServer({
    handlers: {
      'Note.update': ({ payload }) => [
        { type: 'Note.updated', scope: `Note:${row.id}`, data: { id: row.id, ...payload } },
      ],
    },
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      projectionConsumers: [Note_b.projection],
    }),
  });

  const result = await server.dispatch({
    actionId: 'fts-update-1',
    type: 'Note.update',
    payload: { body: 'updated body' },
    principal: { id: 'u1' },
  });

  assert.equal(result.ok, true, 'dispatch must commit');
  const updated = Note_b.findById(row.id);
  assert.equal(updated.body, 'updated body', 'main row must be updated by the projection');
  const ftsRow = db.prepare('SELECT * FROM Note_body_fts WHERE Note_id = ?').get(row.id);
  assert.ok(ftsRow, 'FTS side-table row must be re-indexed');
  assert.equal(ftsRow.body, 'updated body');
});
