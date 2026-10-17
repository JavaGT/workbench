import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entity } from '../build/entity/compile.mjs';
import { text, number, ref, map } from '../build/field.mjs';
import { defineSqliteSchema } from '../build/sqlite-schema.mjs';
import {
  frameworkTableNames,
  frameworkObjects,
  frameworkReservedNames,
} from '../build/schema-table-census.mjs';
import { frameworkReservedNamesWithoutAuthCompile } from '../build/framework-table-names.mjs';
import {
  buildOwnershipCensus,
  censusKey,
  classifyObservedObject,
  classifyObservedObjects,
} from '../build/schema-census.mjs';
import {
  User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor,
} from '../build/auth/entities.mjs';

const AUTH_ENTITIES = [User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor];

// A scope-shaped declaration set: framework (default derivation), the seven
// always-registered auth entities mounted as entities, two app entities (one
// with a map side table), a schema with ordinary tables + a plugin-owned FTS
// virtual table, and the plugin declaring the same virtual table in its
// ownedObjects (the cooperative same-owner case).
function scopeLikeSet() {
  const Note = entity('Note', { title: text(), score: number({ optional: true }) });
  const Comment = entity('Comment', { noteId: ref(Note, { physical: true }), body: text() });
  const Membership = entity('Membership', { role: text(), memberMap: map('Member') });
  const schema = defineSqliteSchema({
    name: 'scope',
    tables: [
      { name: 'Article', columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'title', type: 'text', notNull: true }] },
      { name: 'Audit', columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'note', type: 'text' }] },
    ],
    virtualTables: [{
      name: 'ft_article',
      module: 'fts5',
      options: ['title'],
      ownerPluginId: 'scope-search',
      shadowTables: ['ft_article_data', 'ft_article_idx', 'ft_article_content', 'ft_article_docsize', 'ft_article_config'],
    }],
  });
  return {
    entities: [Note, Comment, Membership],
    schema,
    plugins: [{ id: 'scope-search', ownedObjects: [{ kind: 'virtual-table', name: 'ft_article' }] }],
  };
}

function errorCodes(result) {
  return result.errors.map((error) => error.code);
}

// ---------------------------------------------------------------------------
// Census completeness + the full Scope-style declaration set
// ---------------------------------------------------------------------------

test('census covers the full declaration set with exactly one owner per object', () => {
  const { entities, schema, plugins } = scopeLikeSet();
  const result = buildOwnershipCensus({ schemaDeclarations: [schema], entities, plugins });

  assert.deepEqual(errorCodes(result), [], `unexpected errors: ${JSON.stringify(result.errors)}`);

  const byKey = (kind, name) => result.census.get(censusKey(kind, name));
  // framework (stable names — the migration-ledger table is mid-flight in the
  // shared tree, so it is deliberately not asserted here)
  assert.equal(byKey('table', '_Log').kind, 'framework');
  assert.equal(byKey('table', '_Job').kind, 'framework');
  assert.equal(byKey('table', 'BlobStore').kind, 'framework');
  assert.equal(byKey('index', 'idx__job_claim').kind, 'framework');
  // auth entities are framework-owned even when mounted as entities
  assert.equal(byKey('table', 'User').kind, 'framework');
  assert.equal(byKey('table', 'Session').kind, 'framework');
  assert.equal(byKey('index', 'idx_Session_schedule_createdAt').kind, 'framework');
  // entities: main table + generated side table + generated index
  assert.deepEqual(byKey('table', 'Note'), { kind: 'entity', owner: 'Note', objectKind: 'table', name: 'Note' });
  assert.equal(byKey('table', 'Comment').kind, 'entity');
  assert.equal(byKey('index', 'idx_Comment_noteId').kind, 'entity');
  assert.equal(byKey('table', 'Membership_memberMap').kind, 'entity');
  // schema
  assert.equal(byKey('table', 'Article').kind, 'schema');
  assert.equal(byKey('table', 'Audit').kind, 'schema');
  // plugin virtual table + its FTS shadow tables (sqlite-artifact)
  assert.deepEqual(byKey('virtual-table', 'ft_article'), { kind: 'plugin', owner: 'scope-search', objectKind: 'virtual-table', name: 'ft_article' });
  assert.equal(byKey('table', 'ft_article_data').kind, 'sqlite-artifact');
  assert.equal(byKey('table', 'ft_article_data').owner, 'scope-search');
  assert.equal(byKey('table', 'ft_article_config').kind, 'sqlite-artifact');

  // Every relation key resolves to exactly one owner.
  assert.equal(result.census.size, result.objectCount);
});

test('census with the seven auth entities mounted as entities produces no duplicate claims', () => {
  const { schema } = scopeLikeSet();
  const result = buildOwnershipCensus({
    schemaDeclarations: [schema],
    entities: [...AUTH_ENTITIES],
    plugins: [{ id: 'scope-search', ownedObjects: [] }],
  });
  assert.deepEqual(errorCodes(result), [], `unexpected errors: ${JSON.stringify(result.errors)}`);
  for (const entityDeclaration of AUTH_ENTITIES) {
    assert.equal(result.census.get(censusKey('table', entityDeclaration.name)).kind, 'framework');
  }
});

// ---------------------------------------------------------------------------
// Classification outcomes (consideration #8)
// ---------------------------------------------------------------------------

test('classifyObservedObject: every ownership kind plus the undeclared outcome', () => {
  const { entities, schema, plugins } = scopeLikeSet();
  const { census } = buildOwnershipCensus({ schemaDeclarations: [schema], entities, plugins });

  const owned = (observed) => {
    const outcome = classifyObservedObject(observed, census);
    assert.equal(outcome.kind, 'owned', `${observed.type} ${observed.name} should be owned`);
    return outcome.owner;
  };

  assert.equal(owned({ type: 'table', name: '_Log' }).kind, 'framework');
  assert.equal(owned({ type: 'table', name: 'Note' }).kind, 'entity');
  assert.equal(owned({ type: 'table', name: 'Article' }).kind, 'schema');
  assert.equal(owned({ type: 'index', name: 'idx_Comment_noteId' }).owner, 'Comment');
  // a virtual table observed as a plain table resolves to its virtual-table entry
  assert.equal(owned({ type: 'table', name: 'ft_article' }).objectKind, 'virtual-table');
  assert.equal(owned({ type: 'virtual-table', name: 'ft_article' }).kind, 'plugin');
  // FTS shadow attributed to its plugin (valid while the plugin owns it)
  assert.equal(owned({ type: 'table', name: 'ft_article_data' }).kind, 'sqlite-artifact');

  // undeclared observed object → error outcome
  assert.deepEqual(classifyObservedObject({ type: 'table', name: 'Mystery' }, census), {
    kind: 'undeclared',
    object: { type: 'table', name: 'Mystery' },
  });
  assert.equal(classifyObservedObjects([{ type: 'index', name: 'idx_ghost' }], census)[0].kind, 'undeclared');
});

test('an object declared by another lifecycle participant is valid (not undeclared)', () => {
  const { entities, schema } = scopeLikeSet();
  const { census } = buildOwnershipCensus({ schemaDeclarations: [schema], entities });
  // Physical tables created by the framework/entities are legal inhabitants of
  // the database even though this schema did not declare them.
  for (const name of ['_Log', 'BlobStore', 'Note']) {
    const outcome = classifyObservedObject({ type: 'table', name }, census);
    assert.equal(outcome.kind, 'owned', `${name} is declared by another participant`);
  }
});

// ---------------------------------------------------------------------------
// Duplicate-claim matrix (consideration #10)
// ---------------------------------------------------------------------------

test('duplicate claim: two schemas claiming the same table', () => {
  const schemaA = { name: 'a', tables: [{ name: 'Shared', columns: [{ name: 'id', type: 'text', primaryKey: true }] }] };
  const schemaB = { name: 'b', tables: [{ name: 'Shared', columns: [{ name: 'id', type: 'text', primaryKey: true }] }] };
  const result = buildOwnershipCensus({ schemaDeclarations: [schemaA, schemaB] });
  assert.deepEqual(errorCodes(result), ['duplicate-claim']);
  assert.match(result.errors[0].message, /Shared/);
  assert.deepEqual(result.errors[0].participants, ['schema:a', 'schema:b']);
});

test('duplicate claim: entity main table colliding with another entity generated side table', () => {
  const A = entity('A', { members: map('Member') });
  const B = entity('A_members', { note: text() });
  const result = buildOwnershipCensus({ entities: [A, B] });
  assert.ok(errorCodes(result).includes('duplicate-claim'), JSON.stringify(result.errors));
  assert.match(result.errors.find((error) => error.code === 'duplicate-claim').message, /A_members/);
});

test('duplicate claim: two plugins claiming the same owned object', () => {
  const plugins = [
    { id: 'p1', ownedObjects: [{ kind: 'table', name: 'PluginTable' }] },
    { id: 'p2', ownedObjects: [{ kind: 'table', name: 'PluginTable' }] },
  ];
  const result = buildOwnershipCensus({ plugins });
  assert.deepEqual(errorCodes(result), ['duplicate-claim']);
});

test('duplicate claim: a schema table colliding with a plugin virtual table', () => {
  const schema = {
    name: 'app',
    tables: [{ name: 'ft_article', columns: [{ name: 'id', type: 'text', primaryKey: true }] }],
    virtualTables: [{
      name: 'ft_article', module: 'fts5', options: ['title'], ownerPluginId: 'scope-search', shadowTables: ['ft_article_data'],
    }],
  };
  const plugins = [{ id: 'scope-search', ownedObjects: [] }];
  const result = buildOwnershipCensus({ schemaDeclarations: [schema], plugins });
  assert.ok(errorCodes(result).includes('duplicate-claim'), JSON.stringify(result.errors));
});

test('duplicate claim: index name colliding with a table name under the SQLite relation namespace', () => {
  const schema = {
    name: 'app',
    tables: [
      { name: 'Audit', columns: [{ name: 'id', type: 'text', primaryKey: true }] },
      { name: 'Other', columns: [{ name: 'id', type: 'text', primaryKey: true }], indexes: [{ name: 'Audit' }] },
    ],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema] });
  assert.ok(errorCodes(result).includes('duplicate-claim'), JSON.stringify(result.errors));
  assert.match(result.errors.find((error) => error.code === 'duplicate-claim').message, /relation namespace/);
});

test('duplicate claim: two schemas declaring the same index name', () => {
  const schema = (name, table) => ({
    name,
    tables: [{ name: table, columns: [{ name: 'id', type: 'text', primaryKey: true }], indexes: [{ name: 'idx_shared' }] }],
  });
  const result = buildOwnershipCensus({ schemaDeclarations: [schema('a', 'TA'), schema('b', 'TB')] });
  assert.deepEqual(errorCodes(result), ['duplicate-claim']);
  assert.match(result.errors[0].message, /idx_shared/);
});

test('duplicate claim: entity generated index colliding with a schema index', () => {
  const Note = entity('Note', { title: text() });
  const Comment = entity('Comment', { noteId: ref(Note, { physical: true }), body: text() });
  const schema = {
    name: 'app',
    tables: [{ name: 'T', columns: [{ name: 'id', type: 'text', primaryKey: true }], indexes: [{ name: 'idx_Comment_noteId' }] }],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema], entities: [Note, Comment] });
  assert.ok(errorCodes(result).includes('duplicate-claim'), JSON.stringify(result.errors));
});

test('duplicate claim: schema index colliding with a plugin owned index', () => {
  const schema = {
    name: 'app',
    tables: [{ name: 'T', columns: [{ name: 'id', type: 'text', primaryKey: true }], indexes: [{ name: 'idx_shared' }] }],
  };
  const plugins = [{ id: 'p1', ownedObjects: [{ kind: 'index', name: 'idx_shared' }] }];
  const result = buildOwnershipCensus({ schemaDeclarations: [schema], plugins });
  assert.ok(errorCodes(result).includes('duplicate-claim'), JSON.stringify(result.errors));
});

test('duplicate claim: two plugins declaring the same index name', () => {
  const plugins = [
    { id: 'p1', ownedObjects: [{ kind: 'index', name: 'idx_shared' }] },
    { id: 'p2', ownedObjects: [{ kind: 'index', name: 'idx_shared' }] },
  ];
  const result = buildOwnershipCensus({ plugins });
  assert.deepEqual(errorCodes(result), ['duplicate-claim']);
});

test('duplicate claim: two schemas declaring the same trigger name', () => {
  const schema = (name, table) => ({
    name,
    tables: [{ name: table, columns: [{ name: 'id', type: 'text', primaryKey: true }], triggers: [{ name: 'trg_shared' }] }],
  });
  const result = buildOwnershipCensus({ schemaDeclarations: [schema('a', 'TA'), schema('b', 'TB')] });
  assert.deepEqual(errorCodes(result), ['duplicate-claim']);
  assert.match(result.errors[0].message, /trg_shared/);
});

test('duplicate claim: schema trigger colliding with a plugin owned trigger', () => {
  const schema = {
    name: 'app',
    tables: [{ name: 'T', columns: [{ name: 'id', type: 'text', primaryKey: true }], triggers: [{ name: 'trg_shared' }] }],
  };
  const plugins = [{ id: 'p1', ownedObjects: [{ kind: 'trigger', name: 'trg_shared' }] }];
  const result = buildOwnershipCensus({ schemaDeclarations: [schema], plugins });
  assert.ok(errorCodes(result).includes('duplicate-claim'), JSON.stringify(result.errors));
});

test('duplicate claim: two plugins declaring the same trigger name', () => {
  const plugins = [
    { id: 'p1', ownedObjects: [{ kind: 'trigger', name: 'trg_shared' }] },
    { id: 'p2', ownedObjects: [{ kind: 'trigger', name: 'trg_shared' }] },
  ];
  const result = buildOwnershipCensus({ plugins });
  assert.deepEqual(errorCodes(result), ['duplicate-claim']);
});

test('duplicate claim: a schema table colliding with an FTS shadow table', () => {
  const schema = {
    name: 'app',
    tables: [{ name: 'ft_x_data', columns: [{ name: 'id', type: 'text', primaryKey: true }] }],
    virtualTables: [{ name: 'ft_x', module: 'fts5', options: ['title'], ownerPluginId: 'p1', shadowTables: ['ft_x_data'] }],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema], plugins: [{ id: 'p1', ownedObjects: [] }] });
  assert.ok(errorCodes(result).includes('duplicate-claim'), JSON.stringify(result.errors));
});

test('duplicate claim: an entity main table colliding with an FTS shadow table', () => {
  const Note = entity('Note', { title: text() });
  const schema = {
    name: 'app',
    tables: [],
    virtualTables: [{ name: 'ft_x', module: 'fts5', options: ['title'], ownerPluginId: 'p1', shadowTables: ['Note'] }],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema], entities: [Note], plugins: [{ id: 'p1', ownedObjects: [] }] });
  assert.ok(errorCodes(result).includes('duplicate-claim'), JSON.stringify(result.errors));
});

test('duplicate claim: shadow tables of two virtual tables colliding', () => {
  const schema = {
    name: 'app',
    tables: [],
    virtualTables: [
      { name: 'ft_x', module: 'fts5', options: ['title'], ownerPluginId: 'p1', shadowTables: ['ft_x_data'] },
      { name: 'ft_y', module: 'fts5', options: ['title'], ownerPluginId: 'p2', shadowTables: ['ft_x_data'] },
    ],
  };
  const plugins = [{ id: 'p1', ownedObjects: [] }, { id: 'p2', ownedObjects: [] }];
  const result = buildOwnershipCensus({ schemaDeclarations: [schema], plugins });
  assert.ok(errorCodes(result).includes('duplicate-claim'), JSON.stringify(result.errors));
});

test('duplicate claim: a second plugin claiming an FTS shadow table', () => {
  const schema = {
    name: 'app',
    tables: [],
    virtualTables: [{ name: 'ft_x', module: 'fts5', options: ['title'], ownerPluginId: 'p1', shadowTables: ['ft_x_data'] }],
  };
  const plugins = [
    { id: 'p1', ownedObjects: [] },
    { id: 'p2', ownedObjects: [{ kind: 'table', name: 'ft_x_data' }] },
  ];
  const result = buildOwnershipCensus({ schemaDeclarations: [schema], plugins });
  assert.ok(errorCodes(result).includes('duplicate-claim'), JSON.stringify(result.errors));
});

// ---------------------------------------------------------------------------
// Entity/plain conflict (the moved app.ts check)
// ---------------------------------------------------------------------------

test('entity/plain conflict: a schema table may not claim an entity generated side table', () => {
  const A = entity('A', { members: map('Member') });
  const schema = {
    name: 'app',
    tables: [{ name: 'A_members', columns: [{ name: 'id', type: 'text' }] }],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema], entities: [A] });
  assert.deepEqual(errorCodes(result), ['entity-plain-conflict']);
  assert.match(result.errors[0].message, /generated .*owned by entity "A"/);
});

test('a schema table MAY claim an entity main table (schema-owned entity table feature)', () => {
  const Note = entity('Note', { title: text() });
  const schema = defineSqliteSchema({
    name: 'schema-note',
    tables: [{ name: 'Note', columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'title', type: 'text', notNull: true }] }],
  });
  const result = buildOwnershipCensus({ schemaDeclarations: [schema], entities: [Note] });
  assert.deepEqual(errorCodes(result), [], `unexpected errors: ${JSON.stringify(result.errors)}`);
  // The schema owns the main table; the entity retains nothing but its (empty)
  // side-table/index surface.
  assert.equal(result.census.get(censusKey('table', 'Note')).kind, 'schema');
});

// ---------------------------------------------------------------------------
// Reserved-framework-namespace refusals (consideration #5)
// ---------------------------------------------------------------------------

test('reserved namespace: schema table claiming a framework table', () => {
  const schema = { name: 'app', tables: [{ name: '_Log', columns: [{ name: 'id', type: 'text' }] }] };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema] });
  assert.deepEqual(errorCodes(result), ['reserved-namespace']);
});

test('reserved namespace: schema table claiming an auth entity main table', () => {
  const schema = { name: 'app', tables: [{ name: 'User', columns: [{ name: 'id', type: 'text' }] }] };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema] });
  assert.deepEqual(errorCodes(result), ['reserved-namespace']);
});

test('reserved namespace: entity main table squatting on a framework name', () => {
  const hostile = entity('_Log', { note: text() });
  const result = buildOwnershipCensus({ entities: [hostile] });
  assert.deepEqual(errorCodes(result), ['reserved-namespace']);
});

test('reserved namespace: plugin owned object claiming a framework table', () => {
  const plugins = [{ id: 'p1', ownedObjects: [{ kind: 'table', name: '_PendingBlob' }] }];
  const result = buildOwnershipCensus({ plugins });
  assert.deepEqual(errorCodes(result), ['reserved-namespace']);
});

test('reserved namespace: a schema index claiming a framework index name', () => {
  const schema = {
    name: 'app',
    tables: [{ name: 'T', columns: [{ name: 'id', type: 'text', primaryKey: true }], indexes: [{ name: 'idx__job_claim' }] }],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema] });
  assert.ok(errorCodes(result).includes('reserved-namespace'), JSON.stringify(result.errors));
});

test('reserved namespace: external table declaration claiming a framework table', () => {
  const schema = { name: 'app', tables: [], externalTables: [{ name: '_Log', columns: ['id'] }] };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema] });
  assert.deepEqual(errorCodes(result), ['reserved-namespace']);
});

test('external triggers are schema-owned knowledge for the census', () => {
  const schema = {
    name: 'app',
    tables: [],
    externalTables: [{ name: 'Note', columns: ['id'] }],
    externalTriggers: [{ name: 'note_audit' }, { name: 'note_guard' }],
  };
  const result = buildOwnershipCensus({
    schemaDeclarations: [schema],
    observed: [
      { type: 'table', name: 'Note' },
      { type: 'trigger', name: 'note_audit' },
      { type: 'trigger', name: 'note_guard' },
    ],
  });
  assert.deepEqual(errorCodes(result), [], `unexpected errors: ${JSON.stringify(result.errors)}`);
  assert.equal(result.census.get(censusKey('trigger', 'note_audit')).kind, 'schema');
  assert.equal(result.census.get(censusKey('trigger', 'note_guard')).owner, 'app');
});

test('reserved namespace: an external trigger declaration claiming a framework trigger name', () => {
  const schema = { name: 'app', tables: [], externalTriggers: [{ name: 'idx__job_claim' }] };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema] });
  assert.deepEqual(errorCodes(result), ['reserved-namespace']);
});

test('reserved registry exports: without-auth-compile is a subset of the full registry', () => {
  for (const name of frameworkReservedNamesWithoutAuthCompile) {
    assert.ok(frameworkReservedNames.has(name), `full registry must include ${name}`);
  }
  // The full registry additionally knows auth-entity generated objects.
  assert.ok(frameworkReservedNames.has('idx_session_schedule_createdat'));
  assert.ok(frameworkObjects.some((object) => object.kind === 'index' && object.name === 'idx_Session_schedule_createdAt' && object.fromAuthEntity === 'Session'));
  // The lazily materialized operational ledgers are declared centrally and are
  // framework-owned from the first boot (declaring != creating).
  for (const ledger of ['_SearchStaleness', '_DerivedResource', '_SchemaMaintenance']) {
    assert.ok(frameworkReservedNames.has(ledger.toLowerCase()), `${ledger} is reserved`);
    assert.ok(frameworkTableNames.includes(ledger), `${ledger} is a framework table`);
    assert.ok(frameworkObjects.some((object) => object.kind === 'table' && object.name === ledger), `${ledger} is a framework object`);
  }
  // Existing framework table census is unchanged (A5 rewires without breaking boot).
  assert.ok(Array.isArray(frameworkTableNames) && Object.isFrozen(frameworkTableNames));
});

// ---------------------------------------------------------------------------
// Cross-graph FK validation
// ---------------------------------------------------------------------------

test('FK graph: reference to a missing table is an error', () => {
  const schema = {
    name: 'app',
    tables: [{
      name: 'Child',
      columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'parentId', type: 'text' }],
      foreignKeys: [{ columns: ['parentId'], references: { table: 'Missing', columns: ['id'] } }],
    }],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema] });
  assert.deepEqual(errorCodes(result), ['fk-target']);
});

test('FK graph: reference to a missing target column is an error', () => {
  const schema = {
    name: 'app',
    tables: [
      { name: 'Parent', columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'code', type: 'text' }] },
      {
        name: 'Child',
        columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'parentId', type: 'text' }],
        foreignKeys: [{ columns: ['parentId'], references: { table: 'Parent', columns: ['missing'] } }],
      },
    ],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema] });
  assert.deepEqual(errorCodes(result), ['fk-column']);
});

test('FK graph: incompatible column affinity is an error', () => {
  const schema = {
    name: 'app',
    tables: [
      { name: 'Parent', columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'code', type: 'integer' }] },
      {
        name: 'Child',
        columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'code', type: 'text' }],
        foreignKeys: [{ columns: ['code'], references: { table: 'Parent', columns: ['code'] } }],
      },
    ],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema] });
  assert.deepEqual(errorCodes(result), ['fk-affinity']);
});

test('FK graph: any affinity may reference an INTEGER PRIMARY KEY', () => {
  const schema = {
    name: 'app',
    tables: [
      { name: 'Parent', columns: [{ name: 'id', type: 'integer', primaryKey: true }] },
      {
        name: 'Child',
        columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'parentId', type: 'text' }],
        foreignKeys: [{ columns: ['parentId'], references: { table: 'Parent', columns: ['id'] } }],
      },
    ],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema] });
  assert.deepEqual(errorCodes(result), [], `unexpected errors: ${JSON.stringify(result.errors)}`);
});

test('FK graph: cross-participant targets resolve (external table, entity main table)', () => {
  const Note = entity('Note', { title: text() });
  const schema = {
    name: 'app',
    externalTables: [{ name: 'Legacy', columns: ['id', 'code'] }],
    tables: [
      {
        name: 'Child',
        columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'legacyId', type: 'text' }],
        foreignKeys: [{ columns: ['legacyId'], references: { table: 'Legacy', columns: ['id'] } }],
      },
      {
        name: 'NoteLink',
        columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'noteId', type: 'text' }],
        foreignKeys: [{ columns: ['noteId'], references: { table: 'Note', columns: ['id'] } }],
      },
    ],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema], entities: [Note] });
  assert.deepEqual(errorCodes(result), [], `unexpected errors: ${JSON.stringify(result.errors)}`);
});

test('entity ref target must be a registered entity (app.ts rule preserved)', () => {
  const Note = entity('Note', { title: text() });
  const Comment = entity('Comment', { noteId: ref({ name: 'Ghost' }, { physical: true }), body: text() });
  const result = buildOwnershipCensus({ entities: [Note, Comment] });
  assert.ok(errorCodes(result).includes('fk-target'), JSON.stringify(result.errors));
  assert.match(result.errors.find((error) => error.code === 'fk-target').message, /references unregistered Workbench entity "Ghost"/);
});

test('string ref targets remain logical (app.ts behavior preserved)', () => {
  const Comment = entity('Comment', { noteId: ref('Ghost', { physical: true }), body: text() });
  const result = buildOwnershipCensus({ entities: [Comment] });
  assert.deepEqual(errorCodes(result), [], `string refs are logical, not validated: ${JSON.stringify(result.errors)}`);
});

test('entity ref target schema-owned table must expose a TEXT id primary key', () => {
  const Note = entity('Note', { title: text() });
  const Comment = entity('Comment', { noteId: ref(Note, { physical: true }), body: text() });
  const schema = {
    name: 'app',
    tables: [{ name: 'Note', columns: [{ name: 'id', type: 'integer' }] }],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema], entities: [Note, Comment] });
  assert.ok(errorCodes(result).includes('fk-shape'), JSON.stringify(result.errors));
});

// ---------------------------------------------------------------------------
// Migration namespace rules (consideration #12)
// ---------------------------------------------------------------------------

test('workbench migration namespace impersonation is refused', () => {
  const schema = {
    name: 'app',
    tables: [],
    migrations: [{ namespace: 'workbench', name: 'base', version: 1 }],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema] });
  assert.deepEqual(errorCodes(result), ['migration-reserved']);
});

test('a migration namespace is claimed by exactly one schema', () => {
  const schemaA = { name: 'a', tables: [], migrations: [{ namespace: 'scope', name: 'm1', version: 1 }] };
  const schemaB = { name: 'b', tables: [], migrations: [{ namespace: 'scope', name: 'm2', version: 1 }] };
  const result = buildOwnershipCensus({ schemaDeclarations: [schemaA, schemaB] });
  assert.deepEqual(errorCodes(result), ['namespace-claim']);
  assert.deepEqual(result.errors[0].participants, ['a', 'b']);
});

test('a schema may claim one migration namespace across several ledger versions', () => {
  const schema = {
    name: 'app',
    tables: [],
    migrations: [
      { namespace: 'scope', name: 'a', version: 1 },
      { namespace: 'scope', name: 'b', version: 2 },
    ],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema] });
  assert.deepEqual(errorCodes(result), [], `unexpected errors: ${JSON.stringify(result.errors)}`);
});

test('a schema may not claim the same migration namespace version twice', () => {
  const schema = {
    name: 'app',
    tables: [],
    migrations: [
      { namespace: 'scope', name: 'a', version: 1 },
      { namespace: 'scope', name: 'b', version: 1 },
    ],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema] });
  assert.deepEqual(errorCodes(result), ['namespace-claim']);
  assert.match(result.errors[0].message, /more than once/);
});

test('a namespace stays owned by its first schema across ledger versions', () => {
  const schemaA = { name: 'a', tables: [], migrations: [{ namespace: 'scope', name: 'm1', version: 1 }] };
  const schemaB = { name: 'b', tables: [], migrations: [{ namespace: 'scope', name: 'm2', version: 2 }] };
  const result = buildOwnershipCensus({ schemaDeclarations: [schemaA, schemaB] });
  assert.deepEqual(errorCodes(result), ['namespace-claim']);
  assert.deepEqual(result.errors[0].participants, ['a', 'b']);
});

test('two distinct schema declarations sharing a name may not share a migration namespace', () => {
  const schemaA = { name: 'app', tables: [], migrations: [{ namespace: 'scope', name: 'm1', version: 1 }] };
  const schemaB = { name: 'app', tables: [], migrations: [{ namespace: 'scope', name: 'm2', version: 1 }] };
  const result = buildOwnershipCensus({ schemaDeclarations: [schemaA, schemaB] });
  assert.deepEqual(errorCodes(result), ['namespace-claim']);
});

test('two namespaces may share a version and one schema may use multiple namespaces', () => {
  const schema = {
    name: 'app',
    tables: [],
    migrations: [
      { namespace: 'scope', name: 'a', version: 5 },
      { namespace: 'search', name: 'b', version: 5 },
    ],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema] });
  assert.deepEqual(errorCodes(result), [], `unexpected errors: ${JSON.stringify(result.errors)}`);
});

// ---------------------------------------------------------------------------
// Plugin resource ownership
// ---------------------------------------------------------------------------

test('a virtual table must declare an owner plugin that is registered', () => {
  const schema = {
    name: 'app',
    tables: [],
    virtualTables: [{ name: 'ft_x', module: 'fts5', options: ['title'], ownerPluginId: 'ghost-plugin', shadowTables: ['ft_x_data'] }],
  };
  const result = buildOwnershipCensus({ schemaDeclarations: [schema], plugins: [] });
  assert.deepEqual(errorCodes(result), ['plugin-ownership']);
});

test('FTS shadow tables are attributed to their plugin and a plugin re-listing its own virtual table is not a duplicate', () => {
  const schema = {
    name: 'app',
    tables: [],
    virtualTables: [{
      name: 'ft_x', module: 'fts5', options: ['title'], ownerPluginId: 'p1', shadowTables: ['ft_x_data', 'ft_x_idx'],
    }],
  };
  const plugins = [
    { id: 'p1', ownedObjects: [{ kind: 'virtual-table', name: 'ft_x' }, { kind: 'table', name: 'ft_x_data' }] },
  ];
  const result = buildOwnershipCensus({ schemaDeclarations: [schema], plugins });
  assert.deepEqual(errorCodes(result), [], `unexpected errors: ${JSON.stringify(result.errors)}`);
  assert.equal(result.census.get(censusKey('table', 'ft_x_data')).kind, 'sqlite-artifact');
});

test('an undeclared FTS shadow table observed in the database is undeclared', () => {
  const schema = {
    name: 'app',
    tables: [],
    virtualTables: [{ name: 'ft_x', module: 'fts5', options: ['title'], ownerPluginId: 'p1', shadowTables: ['ft_x_data'] }],
  };
  const result = buildOwnershipCensus({
    schemaDeclarations: [schema],
    plugins: [{ id: 'p1', ownedObjects: [] }],
    observed: [{ type: 'table', name: 'ft_x_idx' }],
  });
  assert.ok(errorCodes(result).includes('undeclared'), JSON.stringify(result.errors));
  assert.equal(errorCodes(result).filter((code) => code === 'undeclared').length, 1);
});

// ---------------------------------------------------------------------------
// Zero DB access
// ---------------------------------------------------------------------------

test('buildOwnershipCensus never touches a database handle', () => {
  const calls = [];
  const throwingDb = {
    prepare() { calls.push('prepare'); throw new Error('the census must not prepare SQL'); },
    exec() { calls.push('exec'); throw new Error('the census must not execute SQL'); },
  };
  const { entities, schema, plugins } = scopeLikeSet();
  // Passing a DbHandle-shaped stub in the `db` slot is a compile-time type
  // error for TS callers (db?: never) and must be ignored at runtime.
  const result = buildOwnershipCensus({
    framework: { tables: ['_Log'], indexes: [], triggers: [], virtualTables: [] },
    schemaDeclarations: [schema],
    entities,
    plugins,
    db: throwingDb,
  });
  assert.deepEqual(errorCodes(result), [], `unexpected errors: ${JSON.stringify(result.errors)}`);
  assert.deepEqual(calls, [], 'the census performed zero database access');
});

test('census result is frozen and its errors are frozen', () => {
  const result = buildOwnershipCensus({});
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.errors));
  // The default framework derivation alone populates the census (no schema,
  // entity, or plugin needed).
  assert.ok(result.objectCount > 0, 'framework objects are claimed by default');
  assert.equal(result.census.size, result.objectCount);
});
