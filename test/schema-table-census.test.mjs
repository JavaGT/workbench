import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertNoFrameworkTableSql,
  collectTableNamesFromDdl,
  frameworkTableNames,
} from '../build/schema-table-census.mjs';

test('frameworkTableNames is a frozen, sorted, duplicate-free array of persistent framework tables', () => {
  assert.ok(Array.isArray(frameworkTableNames), 'frameworkTableNames must be an array');

  const expected = [
    '_ActionReceipt',
    '_CommittedRevision',
    '_CompositeChange',
    '_CompositeChangeCursor',
    '_ConsumerCursor',
    '_Cursor',
    '_DeletedRowAnchor',
    '_DerivedResource',
    '_HistoryCursor',
    '_HistoryOrderCounter',
    '_InvalidationLedger',
    '_Job',
    '_LiveRevision',
    '_Log',
    '_NoHistoryReceipt',
    '_OperationalConsumerDeclaration',
    '_OperationalConsumerFailure',
    '_PendingBlob',
    '_PostCommitEffect',
    '_PrincipalSnapshotRevision',
    '_PrivateActionFact',
    '_PrivateActionFactDependency',
    '_ProjectedCursor',
    '_ScheduleReceipt',
    '_SchemaMaintenance',
    '_SchemaMigration',
    '_SearchStaleness',
    '_V16CapabilityClaim',
    '_Worker',
    'ApiKey',
    'BlobStore',
    'Credential',
    'Inbox',
    'Invitation',
    'Session',
    'TwoFactor',
    'User',
  ];

  assert.deepStrictEqual(frameworkTableNames, expected);
  assert.ok(Object.isFrozen(frameworkTableNames));
});

test('collectTableNamesFromDdl — extracts simple CREATE TABLE names', () => {
  const result = collectTableNamesFromDdl([
    { source: 'entity A', sql: 'CREATE TABLE Widget (id INTEGER PRIMARY KEY)' },
    { source: 'entity B', sql: 'CREATE TABLE Gizmo (name TEXT)' },
  ]);

  assert.deepStrictEqual(result, ['Gizmo', 'Widget']);
});

test('collectTableNamesFromDdl — ignores leading whitespace', () => {
  const result = collectTableNamesFromDdl([
    { source: 'ws', sql: '  CREATE TABLE Spaces (id INTEGER)' },
    { source: 'ws2', sql: '\tCREATE TABLE Tabs (id INTEGER)' },
  ]);

  assert.deepStrictEqual(result, ['Spaces', 'Tabs']);
});

test('collectTableNamesFromDdl — handles IF NOT EXISTS', () => {
  const result = collectTableNamesFromDdl([
    { source: 'safe', sql: 'CREATE TABLE IF NOT EXISTS MaybeThere (id INTEGER)' },
  ]);

  assert.deepStrictEqual(result, ['MaybeThere']);
});

test('collectTableNamesFromDdl — CREATE TABLE is case-insensitive', () => {
  const result = collectTableNamesFromDdl([
    { source: 'lower', sql: 'create table Lower (id INTEGER)' },
    { source: 'mixed', sql: 'Create Table Mixed (id INTEGER)' },
    { source: 'weird', sql: 'CREATE TABLE Weird (id INTEGER)' },
  ]);

  assert.deepStrictEqual(result, ['Lower', 'Mixed', 'Weird']);
});

test('collectTableNamesFromDdl — extracts CREATE VIRTUAL TABLE names', () => {
  const result = collectTableNamesFromDdl([
    { source: 'fts', sql: 'CREATE VIRTUAL TABLE Fts USING fts5(content=?, content_rowid=?)' },
  ]);

  assert.deepStrictEqual(result, ['Fts']);
});

test('collectTableNamesFromDdl — CREATE VIRTUAL TABLE is case-insensitive', () => {
  const result = collectTableNamesFromDdl([
    { source: 'v', sql: 'create virtual table Virt (id INTEGER)' },
  ]);

  assert.deepStrictEqual(result, ['Virt']);
});

test('collectTableNamesFromDdl — accepts quoted SQLite identifiers (backtick, double-quote, bracket)', () => {
  const result = collectTableNamesFromDdl([
    { source: 'bt', sql: 'CREATE TABLE `Backtick` (id INTEGER)' },
    { source: 'dq', sql: 'CREATE TABLE "DoubleQuote" (id INTEGER)' },
    { source: 'br', sql: 'CREATE TABLE [Bracket] (id INTEGER)' },
  ]);

  assert.deepStrictEqual(result, ['Backtick', 'Bracket', 'DoubleQuote']);
});

test('collectTableNamesFromDdl — ignores CREATE INDEX / CREATE VIEW / non-table statements', () => {
  const result = collectTableNamesFromDdl([
    { source: 'idx', sql: 'CREATE INDEX idx_widget ON Widget(name)' },
    { source: 'vw', sql: 'CREATE VIEW SomeView AS SELECT 1' },
    { source: 'tbl', sql: 'CREATE TABLE ActualTable (id INTEGER)' },
    { source: 'tri', sql: 'CREATE TRIGGER t AFTER INSERT ON Widget BEGIN SELECT 1; END' },
  ]);

  assert.deepStrictEqual(result, ['ActualTable']);
});

test('collectTableNamesFromDdl — ignores SQL line comments', () => {
  const result = collectTableNamesFromDdl([
    { source: 'com1', sql: '-- CREATE TABLE Commented (id INTEGER)' },
    { source: 'com2', sql: '  -- CREATE TABLE IndentedCommented (id INTEGER)' },
    { source: 'com3', sql: 'SELECT 1; -- CREATE TABLE InlineCommented (id INTEGER)' },
    { source: 'quoted', sql: "SELECT '-- not a comment'; CREATE TABLE QuotedMarker (id INTEGER)" },
    { source: 'real', sql: 'CREATE TABLE RealTable (id INTEGER)' },
  ]);

  assert.deepStrictEqual(result, ['QuotedMarker', 'RealTable']);
});

test('collectTableNamesFromDdl — ignores SQL block comments without joining tokens', () => {
  const result = collectTableNamesFromDdl([
    { source: 'single-line', sql: '/* CREATE TABLE Commented (id INTEGER) */ CREATE TABLE RealTable (id INTEGER)' },
    { source: 'multiline', sql: '/* heading\nCREATE TABLE MultilineCommented (id INTEGER)\n*/\nCREATE TABLE AfterComment (id INTEGER)' },
    { source: 'between-tokens', sql: 'CRE/* comment */ATE TABLE JoinedPhantom (id INTEGER)' },
  ]);

  assert.deepStrictEqual(result, ['AfterComment', 'RealTable']);
});

test('collectTableNamesFromDdl — block comments end at the first closing marker', () => {
  const result = collectTableNamesFromDdl([
    { source: 'nested-looking', sql: '/* outer /* CREATE TABLE Hidden (id INTEGER) */ CREATE TABLE Visible (id INTEGER)' },
  ]);

  assert.deepStrictEqual(result, ['Visible']);
});

test('collectTableNamesFromDdl — preserves comment markers inside SQL quotes', () => {
  const result = collectTableNamesFromDdl([
    { source: 'single', sql: "SELECT '/* value */ -- value'; CREATE TABLE SingleQuotedMarker (id INTEGER)" },
    { source: 'double', sql: 'SELECT "/* value */ -- value"; CREATE TABLE "Double/*Marker*/--Name" (id INTEGER)' },
    { source: 'backtick', sql: 'CREATE TABLE `Backtick/*Marker*/--Name` (id INTEGER)' },
    { source: 'bracket', sql: 'CREATE TABLE [Bracket/*Marker*/--Name] (id INTEGER)' },
    { source: 'escaped', sql: "SELECT 'it''s /* value */', \"a\"\"--b\"; CREATE TABLE EscapedMarkers (id INTEGER)" },
  ]);

  assert.deepStrictEqual(result, [
    'Backtick/*Marker*/--Name',
    'Bracket/*Marker*/--Name',
    'Double/*Marker*/--Name',
    'EscapedMarkers',
    'SingleQuotedMarker',
  ]);
});

test('collectTableNamesFromDdl — ignores CREATE TABLE text inside quoted SQL regions', () => {
  const result = collectTableNamesFromDdl([
    { source: 'single', sql: "SELECT 'CREATE TABLE SinglePhantom (id INTEGER)'; CREATE TABLE SingleReal (id INTEGER)" },
    { source: 'double', sql: 'SELECT "CREATE TABLE DoublePhantom (id INTEGER)"; CREATE TABLE DoubleReal (id INTEGER)' },
    { source: 'backtick', sql: 'SELECT `CREATE TABLE BacktickPhantom (id INTEGER)`; CREATE TABLE BacktickReal (id INTEGER)' },
    { source: 'bracket', sql: 'SELECT [CREATE TABLE BracketPhantom (id INTEGER)]; CREATE TABLE BracketReal (id INTEGER)' },
    { source: 'escaped', sql: "SELECT 'it''s CREATE TABLE EscapedPhantom (id INTEGER)', \"a\"\" CREATE TABLE AlsoPhantom (id INTEGER)\"; CREATE TABLE MixedReal (id INTEGER)" },
  ]);

  assert.deepStrictEqual(result, ['BacktickReal', 'BracketReal', 'DoubleReal', 'MixedReal', 'SingleReal']);
});

test('collectTableNamesFromDdl — extracts real quoted names beside quoted and commented phantoms', () => {
  const result = collectTableNamesFromDdl([{
    source: 'mixed',
    sql: `
      SELECT 'CREATE TABLE Fake (id INTEGER)';
      -- CREATE TABLE LineFake (id INTEGER)
      CREATE TABLE "Double""Name" (id INTEGER);
      /* CREATE TABLE BlockFake (id INTEGER) */
      CREATE TABLE \`Backtick\`\`Name\` (id INTEGER);
      CREATE TABLE [Bracket]]Name] (id INTEGER);
    `,
  }]);

  assert.deepStrictEqual(result, ['Backtick`Name', 'Bracket]Name', 'Double"Name']);
});

test('collectTableNamesFromDdl — rejects duplicate declarations case-insensitively', () => {
  assert.throws(
    () => collectTableNamesFromDdl([
      { source: 'first', sql: 'CREATE TABLE User (id INTEGER)' },
      { source: 'second', sql: 'create table user (name TEXT)' },
    ]),
    /duplicate.*(?:User|user)/i,
  );
});

test('collectTableNamesFromDdl — sorts underscore-prefixed first, then lexical', () => {
  const result = collectTableNamesFromDdl([
    { source: 'a', sql: 'CREATE TABLE _Zebra (id INTEGER)' },
    { source: 'b', sql: 'CREATE TABLE Alpha (id INTEGER)' },
    { source: 'c', sql: 'CREATE TABLE _Alpha (id INTEGER)' },
    { source: 'd', sql: 'CREATE TABLE Beta (id INTEGER)' },
  ]);

  assert.deepStrictEqual(result, ['_Alpha', '_Zebra', 'Alpha', 'Beta']);
});

test('assertNoFrameworkTableSql rejects framework table references', () => {
  assert.throws(() => assertNoFrameworkTableSql('SELECT * FROM _Log'), /framework table _Log/);
  assert.throws(() => assertNoFrameworkTableSql('SELECT * FROM "_Cursor"'), /framework table _Cursor/);
  assert.throws(() => assertNoFrameworkTableSql('UPDATE `_ActionReceipt` SET actionId = 1'), /framework table _ActionReceipt/);
  assert.throws(() => assertNoFrameworkTableSql('INSERT INTO User (id) VALUES (1)'), /framework table User/);
  assert.throws(() => assertNoFrameworkTableSql('SELECT * FROM Note JOIN _Log ON 1'), /framework table _Log/);
  assert.throws(
    () => assertNoFrameworkTableSql('SELECT * FROM Note /* keep */ , _PrivateActionFact'),
    /framework table _PrivateActionFact/,
  );
});

test('assertNoFrameworkTableSql allows app tables and ignores comments/strings', () => {
  assert.doesNotThrow(() => assertNoFrameworkTableSql('SELECT * FROM Note WHERE title = ?'));
  assert.doesNotThrow(() => assertNoFrameworkTableSql('SELECT * FROM Project p JOIN Artefact a ON a.projectId = p.id'));
  assert.doesNotThrow(() => assertNoFrameworkTableSql("-- SELECT * FROM _Log\nSELECT 1"));
  assert.doesNotThrow(() => assertNoFrameworkTableSql("SELECT '_Log' AS marker FROM Note"));
  assert.doesNotThrow(() => assertNoFrameworkTableSql('SELECT * FROM (SELECT 1 AS id) AS nested'));
});

test('assertNoFrameworkTableSql requires a string', () => {
  assert.throws(() => assertNoFrameworkTableSql(null), /sql must be a string/);
});
