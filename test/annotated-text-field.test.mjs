import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { annotatedText, annotatedTextClientHandle, text, number, ref, annotation, protectingAnnotation, measurement, annotationAction, grant, read } from '../build/index.mjs';
import { entity, generateDDL } from '../build/internal.mjs';
import { validateAnnotatedTextDeclaration, annotatedTextDDL, getAnnotatedTextCompiledMetadata, registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension, resolveDeclarationMeasurementExtension } from '../build/annotated-text-field.mjs';

// Register test contracts and structural adapters for T8 measurement adapter validation
registerAnnotatedTextContract('testFieldExt', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('testFieldExt', Object.freeze({
  version: 1,
  validate: function validate() {},
  edit: function edit() {},
  partition: function partition() {},
  combine: function combine() {},
}));

function makeFields() {
  return {
    title: text(),
    project: ref('Project'),
    owner: ref('User'),
  };
}

function fd(_blockAnnotations, annotations, measurements) {
  const annList = [];
  for (const [family, fields] of Object.entries(annotations || {})) {
    const ff = {};
    for (const [k, v] of Object.entries(fields)) ff[k] = Object.freeze({ ...v });
    annList.push(annotation(family, { fields: ff }));
  }

  const measList = [];
  for (const [name, config] of Object.entries(measurements || { audio: { formatVersion: 1, extension: 'testFieldExt' } })) {
    measList.push(measurement(name, { extension: config.extension || 'testFieldExt', formatVersion: config.formatVersion }));
  }

  return {
    project: 'project',
    owner: 'owner',
    annotations: annList,
    measurements: measList,
  };
}

test('annotatedText() returns a frozen descriptor with kind annotatedText', () => {
  const d = annotatedText({ project: 'p', owner: 'o', annotations: [annotation('note')], measurements: [measurement('m', { extension: 'testFieldExt', formatVersion: 1 })] });
  assert.equal(d.kind, 'annotatedText');
  assert.equal(d.type, 'annotatedText');
  assert.ok(Object.isFrozen(d));
});

test('annotatedText() defaults to a text-only declaration', () => {
  const descriptor = annotatedText({ project: 'project', owner: 'owner' });
  const result = validateAnnotatedTextDeclaration('Doc', 'body', descriptor, makeFields());

  assert.deepEqual(descriptor.annotations, []);
  assert.deepEqual(descriptor.measurements, []);
  assert.ok(Object.isFrozen(descriptor.annotations));
  assert.ok(Object.isFrozen(descriptor.measurements));
  assert.deepEqual(result.families, []);
  assert.deepEqual(result.measurements, []);
});

test('annotatedTextClientHandle derives browser metadata from the compiled entity', () => {
  const Document = entity('ClientHandleDoc', {
    project: ref('Project'), owner: ref('User'), title: text(),
    body: annotatedText({ project: 'project', owner: 'owner' }),
  });
  const handle = annotatedTextClientHandle(Document, Document.body);

  assert.deepEqual(handle.fields, {
    project: { kind: 'value' }, owner: { kind: 'value' }, title: { kind: 'value' }, body: { kind: 'annotatedText' },
  });
  assert.deepEqual(handle.body, {
    fieldName: 'body', annotations: Document.body.annotations,
    measurements: Document.body.measurements, capabilities: Document.body.capabilities,
  });
  assert.ok(Object.isFrozen(handle));
  assert.ok(Object.isFrozen(handle.fields));
});

test('valid entity declaration with annotatedText, owner/project refs', () => {
  const descriptor = fd(null, { highlight: { col1: Object.freeze({ kind: 'value', type: 'text' }) }, tag: { col2: Object.freeze({ kind: 'value', type: 'text' }) } }, { audio: { formatVersion: 1 }, sentiment: { formatVersion: 2 } });
  const fields = makeFields();
  const result = validateAnnotatedTextDeclaration('Doc', 'body', descriptor, fields);
  assert.deepEqual(result.blockFields, []);
  assert.deepEqual(result.families, ['highlight', 'tag']);
  assert.deepEqual(result.measurements, ['audio', 'sentiment']);
});

test('DDL generates correct table count and names', () => {
  const descriptor = fd(
    null,
    { highlight: { col1: { kind: 'value', type: 'text' } }, tag: { col2: { kind: 'value', type: 'text' } } },
  );
  const fields = makeFields();
  const ddl = annotatedTextDDL('Doc', 'body', descriptor, fields);
  const tables = ddl.filter(s => s.startsWith('CREATE TABLE'));
  const indexes = ddl.filter(s => s.startsWith('CREATE INDEX') || s.startsWith('CREATE UNIQUE INDEX'));

  assert.equal(tables.length, 10);
  assert.ok(tables.some(s => s.includes('Doc_body_retired')));
  assert.ok(tables.some(s => s.includes('Doc_body_state')));
  assert.ok(tables.some(s => s.includes('Doc_body_annotation')));
  assert.ok(tables.some(s => s.includes('Doc_body_annotation_highlight')));
  assert.ok(tables.some(s => s.includes('Doc_body_annotation_tag')));
  assert.ok(tables.some(s => s.includes('Doc_body_annotation_orphan_state')));
  assert.ok(tables.some(s => s.includes('Doc_body_annotation_protected_target')));
  assert.ok(tables.some(s => s.includes('Doc_body_membership')));
  assert.ok(tables.some(s => s.includes('Doc_body_range')));
  assert.ok(tables.some(s => s.includes('Doc_body_measurement')));
  assert.ok(!tables.some(s => s.includes('Doc_body_block')));
  assert.ok(!tables.some(s => s.includes('Doc_body_block_group')));
  assert.ok(!tables.some(s => s.includes('Doc_body_group_membership')));
  assert.equal(indexes.length, 2);
  assert.ok(indexes.some(s => s.includes('idx_Doc_body_annotation_protected_target_target')));
  assert.ok(indexes.some(s => s.includes('idx_Doc_body_measurement_once')));
});

test('membership table links annotations to immutable reusable ranges', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd(
    null, { highlight: { col1: { kind: 'value', type: 'text' } } },
  ), makeFields());
  const mem = ddl.find(s => s.includes('Doc_body_membership'));
  assert.ok(mem.includes('annotation_id TEXT NOT NULL'));
  assert.ok(mem.includes('range_id INTEGER NOT NULL'));
  assert.ok(mem.includes('document_id TEXT NOT NULL'));
  assert.ok(mem.includes('ordinal INTEGER NOT NULL'));
  assert.ok(mem.includes('PRIMARY KEY (annotation_id, range_id)'));
  assert.ok(mem.includes('UNIQUE (annotation_id, ordinal)'));
  assert.ok(mem.includes('FOREIGN KEY (annotation_id, document_id) REFERENCES Doc_body_annotation(id, document_id) ON DELETE CASCADE'));
  assert.ok(mem.includes('FOREIGN KEY (range_id, document_id) REFERENCES Doc_body_range(id, document_id) ON DELETE CASCADE'));
  assert.ok(!mem.includes('block_id'));
});

test('range storage is document-scoped and canonically interned', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd(
    null, { highlight: { col1: { kind: 'value', type: 'text' } } },
  ), makeFields());
  const range = ddl.find(s => s.includes('Doc_body_range'));
  assert.ok(range.includes('id INTEGER PRIMARY KEY'));
  assert.ok(range.includes('document_id TEXT NOT NULL'));
  assert.ok(range.includes('UNIQUE (document_id, start_point, end_point)'));
  assert.ok(range.includes('UNIQUE (id, document_id)'));
  assert.ok(range.includes('FOREIGN KEY (document_id) REFERENCES Doc(id) ON DELETE CASCADE'));
  assert.ok(ddl.some(s => s.includes('Doc_body_range_immutable_update')));
});

test('membership table has no block-era indexes', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd(
    null, { highlight: { col1: { kind: 'value', type: 'text' } } },
  ), makeFields());
  assert.ok(!ddl.some(s => s.includes('idx_Doc_body_membership')));
});

test('measurement table has correct columns, constraints, and FK', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd(
    null, { highlight: { col1: { kind: 'value', type: 'text' } } },
    { audio: { formatVersion: 1 }, sentiment: { formatVersion: 2 } },
  ), makeFields());
  const meas = ddl.find(s => s.includes('Doc_body_measurement'));
  assert.ok(meas.includes('id TEXT PRIMARY KEY'));
  assert.ok(meas.includes('document_id TEXT NOT NULL'));
  assert.ok(!meas.includes('block_id'));
  assert.ok(meas.includes('family TEXT NOT NULL CHECK (family IN'));
  assert.ok(meas.includes("'audio'"));
  assert.ok(meas.includes("'sentiment'"));
  assert.ok(meas.includes('format_version INTEGER NOT NULL CHECK (format_version > 0)'));
  assert.ok(meas.includes('payload TEXT NOT NULL CHECK (json_valid(payload))'));
  assert.ok(meas.includes('FOREIGN KEY (document_id) REFERENCES Doc(id) ON DELETE CASCADE'));
});

test('measurement unique index on (document_id, family) rejects duplicates in SQLite', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  for (const sql of annotatedTextDDL('Doc', 'body', fd(null, { highlight: {} }, { audio: { formatVersion: 1 } }), makeFields())) db.exec(sql);
  db.exec("INSERT INTO Project VALUES ('p')");
  db.exec("INSERT INTO User VALUES ('u')");
  db.exec("INSERT INTO Doc VALUES ('d')");
  db.exec("INSERT INTO Doc_body_measurement (id, document_id, family, format_version, payload) VALUES ('m1', 'd', 'audio', 1, '{}')");
  assert.throws(() => db.exec("INSERT INTO Doc_body_measurement (id, document_id, family, format_version, payload) VALUES ('m2', 'd', 'audio', 1, '{}')"));
  db.exec("INSERT INTO Doc VALUES ('d2')");
  db.exec("INSERT INTO Doc_body_measurement (id, document_id, family, format_version, payload) VALUES ('m3', 'd2', 'audio', 1, '{}')");
});

test('measurement document FK rejects nonexistent documents in SQLite', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  for (const sql of annotatedTextDDL('Doc', 'body', fd(null, { highlight: {} }, { audio: { formatVersion: 1 } }), makeFields())) db.exec(sql);
  assert.throws(() => db.exec("INSERT INTO Doc_body_measurement (id, document_id, family, format_version, payload) VALUES ('m', 'missing', 'audio', 1, '{}')"));
});

test('measurement index exists', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd(
    null, { highlight: { col1: { kind: 'value', type: 'text' } } },
  ), makeFields());
  const once = ddl.find(s => s.includes('idx_Doc_body_measurement_once'));
  assert.ok(once.includes('UNIQUE INDEX'));
  assert.ok(once.includes('(document_id, family)'));
});

test('family state is the sole canonical checkpoint relation', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  for (const sql of annotatedTextDDL('Doc', 'body', fd(
    {}, { highlight: { col1: { kind: 'value', type: 'text' } } },
  ), makeFields())) db.exec(sql);
  db.exec("INSERT INTO Doc (id) VALUES ('d1')");
  db.exec("INSERT INTO Doc_body_state (document_id, structure_version, family_checkpoint) VALUES ('d1', 0, '{}')");

  assert.throws(() => db.exec("INSERT INTO Doc_body_state (document_id, structure_version, family_checkpoint) VALUES ('d1', 0, '{}')"));
  assert.throws(() => db.exec("INSERT INTO Doc_body_state (document_id, structure_version, family_checkpoint) VALUES ('d2', -1, '{}')"));
  assert.throws(() => db.exec("INSERT INTO Doc_body_state (document_id, structure_version, family_checkpoint) VALUES ('d2', 0, 'not-json')"));
  db.exec("DELETE FROM Doc WHERE id = 'd1'");
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_state').get().c, 0);
});

test('annotation table has correct columns, family CHECK, and FKs', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd(
    {},
    { highlight: { col1: { kind: 'value', type: 'text' } }, tag: { col2: { kind: 'value', type: 'text' } } },
  ), makeFields());
  const ann = ddl.find(s => s.includes('Doc_body_annotation'));
  assert.ok(ann.includes('id TEXT PRIMARY KEY'));
  assert.ok(ann.includes('family TEXT NOT NULL CHECK (family IN'));
  assert.ok(ann.includes("'highlight'"));
  assert.ok(ann.includes("'tag'"));
  assert.ok(ann.includes('FOREIGN KEY (document_id) REFERENCES Doc(id) ON DELETE CASCADE'));
  assert.ok(ann.includes('FOREIGN KEY (project_id) REFERENCES Project(id) ON DELETE CASCADE'));
  assert.ok(ann.includes('FOREIGN KEY (owner_id) REFERENCES User(id) ON DELETE CASCADE'));
});

test('annotation family CHECK rejects undeclared families in SQLite', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  for (const sql of annotatedTextDDL('Doc', 'body', fd({}, { highlight: {} }), makeFields())) db.exec(sql);
  db.exec("INSERT INTO Project VALUES ('p')");
  db.exec("INSERT INTO User VALUES ('u')");
  db.exec("INSERT INTO Doc VALUES ('d')");
  assert.throws(() => db.exec("INSERT INTO Doc_body_annotation VALUES ('a', 'd', 'p', 'u', 'undeclared')"));
});

test('annotation family tables have correct columns and FK cascade', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd(
    {},
    { highlight: { col1: { kind: 'value', type: 'text' } }, tag: { col2: { kind: 'value', type: 'text' } } },
  ), makeFields());
  const hl = ddl.find(s => s.includes('Doc_body_annotation_highlight'));
  assert.ok(hl.includes('annotation_id TEXT PRIMARY KEY'));
  assert.ok(hl.includes('FOREIGN KEY (annotation_id) REFERENCES Doc_body_annotation(id) ON DELETE CASCADE'));

  const tag = ddl.find(s => s.includes('Doc_body_annotation_tag'));
  assert.ok(tag.includes('annotation_id TEXT PRIMARY KEY'));
});

test('annotation family table with no extension fields has annotation_id PK and FK', () => {
  const descriptor = fd({}, { bare: {} });
  const ddl = annotatedTextDDL('Doc', 'body', descriptor, makeFields());
  const bare = ddl.find(s => s.includes('Doc_body_annotation_bare'));
  assert.ok(bare.includes('annotation_id TEXT PRIMARY KEY'));
  assert.ok(bare.includes('FOREIGN KEY (annotation_id) REFERENCES Doc_body_annotation(id) ON DELETE CASCADE'));
});

test('orphan rows are one-to-one annotation state and cascade on annotation deletion', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  for (const sql of annotatedTextDDL('Doc', 'body', fd({}, { note: {} }), makeFields())) db.exec(sql);
  db.exec("INSERT INTO Project VALUES ('p')");
  db.exec("INSERT INTO User VALUES ('u')");
  db.exec("INSERT INTO Doc VALUES ('d')");
  db.exec("INSERT INTO Doc_body_annotation VALUES ('a', 'd', 'p', 'u', 'note')");
  db.exec("INSERT INTO Doc_body_annotation_orphan_state VALUES ('a', 'saved', '[]')");
  assert.throws(() => db.exec("INSERT INTO Doc_body_annotation_orphan_state VALUES ('a', 'again', '[]')"));
  db.exec("DELETE FROM Doc_body_annotation WHERE id = 'a'");
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Doc_body_annotation_orphan_state').get().count, 0);
});

test('target annotation deletion is restricted while a protecting edge exists', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  for (const sql of annotatedTextDDL('Doc', 'body', fd({}, { note: {}, protector: {} }), makeFields())) db.exec(sql);
  db.exec("INSERT INTO Project VALUES ('p')");
  db.exec("INSERT INTO User VALUES ('u')");
  db.exec("INSERT INTO Doc VALUES ('d')");
  db.exec("INSERT INTO Doc_body_annotation VALUES ('target', 'd', 'p', 'u', 'note')");
  db.exec("INSERT INTO Doc_body_annotation VALUES ('protector', 'd', 'p', 'u', 'protector')");
  db.exec("INSERT INTO Doc_body_annotation_protected_target VALUES ('protector', 'target')");
  assert.throws(() => db.exec("DELETE FROM Doc_body_annotation WHERE id = 'target'"));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM Doc_body_annotation_protected_target WHERE annotation_id = 'protector'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM Doc_body_annotation WHERE id = 'protector'").get().count, 1);
});

test('forged annotation descriptors cannot bypass the closed empty policy', () => {
  const forged = Object.freeze({
    kind: 'annotation', annotationName: 'note', fields: Object.freeze({}), actions: Object.freeze([]), empty: 'retain',
  });
  assert.throws(() => validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
    project: 'project', owner: 'owner', annotations: [forged], measurements: [measurement('m', { extension: 'testFieldExt' })],
  }), makeFields()), /must be 'delete' or 'orphan'/);
});

test('generic orphan table does not collide with an orphan annotation family', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd({}, { orphan: {} }), makeFields());
  assert.ok(ddl.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS Doc_body_annotation_orphan (')));
  assert.ok(ddl.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS Doc_body_annotation_orphan_state (')));
});

test('reserved orphan state family cannot collide with the generic orphan table', () => {
  assert.throws(() => annotatedTextDDL('Doc', 'body', fd({}, { orphan_state: {} }), makeFields()), /reserved internal annotation family name/);
});

test('main entity table has no annotatedText column', () => {
  const Doc = entity('Doc', {
    title: text(),
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: 'testFieldExt', formatVersion: 1 })],
    }),
  });
  const ddl = generateDDL(Doc);
  const mainDDL = ddl.find(s => s.startsWith('CREATE TABLE IF NOT EXISTS "Doc" ('));
  assert.ok(mainDDL, 'main Doc table DDL should exist');
  assert.ok(mainDDL.includes('id TEXT PRIMARY KEY'));
  assert.ok(!mainDDL.includes('body'), 'annotatedText field should not appear in main table');
});

test('generated tables execute against real SQLite and accept inserts', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');

  const descriptor = fd(
    null,
    { highlight: { col1: { kind: 'value', type: 'text' } }, tag: { col2: { kind: 'value', type: 'text' } } },
  );
  const fields = makeFields();
  const ddl = annotatedTextDDL('Doc', 'body', descriptor, fields);
  for (const sql of ddl) db.exec(sql);

  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  db.exec("INSERT INTO Doc (id, title) VALUES ('d1', 'test')");

  db.exec("INSERT INTO Doc_body_annotation (id, document_id, project_id, owner_id, family) VALUES ('a1', 'd1', 'p1', 'u1', 'highlight')");
  db.exec("INSERT INTO Doc_body_annotation_highlight (annotation_id, col1) VALUES ('a1', 'v1')");
  db.exec("INSERT INTO Doc_body_range (id, document_id, start_point, end_point) VALUES (1, 'd1', '[1,2]', '[1,3]')");
  db.exec("INSERT INTO Doc_body_membership (annotation_id, range_id, document_id, ordinal) VALUES ('a1', 1, 'd1', 0)");
  db.exec("INSERT INTO Doc_body_measurement (id, document_id, family, format_version, payload) VALUES ('m1', 'd1', 'audio', 1, '{}')");

  const rows = db.prepare('SELECT id, document_id, project_id, owner_id FROM Doc_body_annotation').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'a1');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_membership').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_measurement').get().c, 1);
});

test('ON DELETE CASCADE removes child rows when parent document is deleted', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');

  const descriptor = fd(
    null,
    { highlight: { col1: { kind: 'value', type: 'text' } } },
  );
  for (const sql of annotatedTextDDL('Doc', 'body', descriptor, makeFields())) db.exec(sql);

  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  db.exec("INSERT INTO Doc (id, title) VALUES ('d1', 'test')");
  db.exec("INSERT INTO Doc_body_annotation (id, document_id, project_id, owner_id, family) VALUES ('a1', 'd1', 'p1', 'u1', 'highlight')");
  db.exec("INSERT INTO Doc_body_annotation_highlight (annotation_id, col1) VALUES ('a1', 'v1')");
  db.exec("INSERT INTO Doc_body_range (id, document_id, start_point, end_point) VALUES (1, 'd1', '[1,2]', '[1,3]')");
  db.exec("INSERT INTO Doc_body_membership (annotation_id, range_id, document_id, ordinal) VALUES ('a1', 1, 'd1', 0)");
  db.exec("INSERT INTO Doc_body_measurement (id, document_id, family, format_version, payload) VALUES ('m1', 'd1', 'audio', 1, '{}')");

  db.exec("DELETE FROM Doc WHERE id = 'd1'");

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_state').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_annotation').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_annotation_highlight').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_membership').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_measurement').get().c, 0);
});

test('ON DELETE CASCADE removes annotation family and membership when annotation is deleted', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');

  for (const sql of annotatedTextDDL('Doc', 'body', fd(
    null,
    { highlight: { col1: { kind: 'value', type: 'text' } } },
  ), makeFields())) db.exec(sql);

  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  db.exec("INSERT INTO Doc (id, title) VALUES ('d1', 'test')");
  db.exec("INSERT INTO Doc_body_annotation (id, document_id, project_id, owner_id, family) VALUES ('a1', 'd1', 'p1', 'u1', 'highlight')");
  db.exec("INSERT INTO Doc_body_annotation_highlight (annotation_id, col1) VALUES ('a1', 'v1')");
  db.exec("INSERT INTO Doc_body_range (id, document_id, start_point, end_point) VALUES (1, 'd1', '[1,2]', '[1,3]')");
  db.exec("INSERT INTO Doc_body_membership (annotation_id, range_id, document_id, ordinal) VALUES ('a1', 1, 'd1', 0)");

  db.exec("DELETE FROM Doc_body_annotation WHERE id = 'a1'");

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_annotation_highlight').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_membership').get().c, 0);
});

test('rejects: project field does not name an existing ref field', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'nonexistent', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: 'testFieldExt', formatVersion: 1 })],
    }), makeFields());
  }, /must name an enclosing ref field/);
});

test('rejects: owner field does not name an existing ref field', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'nonexistent',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: 'testFieldExt', formatVersion: 1 })],
    }), makeFields());
  }, /must name an enclosing ref field/);
});

test('rejects: project field is a non-ref value field', () => {
  const fields = { title: text(), project: text(), owner: ref('User') };
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: 'testFieldExt', formatVersion: 1 })],
    }), fields);
  }, /must name an enclosing ref field with a target/);
});

test('rejects: project field is a ref without a target', () => {
  const fields = { title: text(), project: ref(), owner: ref('User') };
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: 'testFieldExt', formatVersion: 1 })],
    }), fields);
  }, /must name an enclosing ref field with a target/);
});

test('rejects: annotation family with reserved column name annotation_id', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl', { fields: { annotation_id: Object.freeze({ kind: 'value', type: 'text' }) } })],
      measurements: [measurement('m', { extension: 'testFieldExt', formatVersion: 1 })],
    }), makeFields());
  }, /invalid or reserved identifier/);
});

test('rejects: annotation family with reserved column name family', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl', { fields: { family: Object.freeze({ kind: 'value', type: 'text' }) } })],
      measurements: [measurement('m', { extension: 'testFieldExt', formatVersion: 1 })],
    }), makeFields());
  }, /invalid or reserved identifier/);
});

test('rejects: annotations is not an array', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: 'not-an-array',
      measurements: [measurement('m', { extension: 'testFieldExt', formatVersion: 1 })],
    }), makeFields());
  }, /must be an array/);
});

test('rejects: measurements is not an array', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: 'bad',
    }), makeFields());
  }, /must be an array/);
});

test('rejects: measurement formatVersion is not a positive integer', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('audio', { extension: 'testFieldExt', formatVersion: 0 })],
    }), makeFields());
  }, /must be a positive integer/);
});

test('rejects: annotation family name with invalid identifier', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('123invalid')],
      measurements: [measurement('m', { extension: 'testFieldExt', formatVersion: 1 })],
    }), makeFields());
  }, /valid identifier/);
});

test('valid: annotation family fields produce extension columns', () => {
  const descriptor = fd(
    {},
    { seg: { severity: Object.freeze({ kind: 'value', type: 'number' }), source: Object.freeze({ kind: 'value', type: 'text' }) } },
  );
  const ddl = annotatedTextDDL('Doc', 'body', descriptor, makeFields());
  const seg = ddl.find(s => s.includes('Doc_body_annotation_seg'));
  assert.ok(seg, 'annotation family table DDL should exist');
  assert.ok(seg.includes('severity REAL NOT NULL'));
  assert.ok(seg.includes('source TEXT NOT NULL'));
});

test('valid: entity() compiles with annotatedText field', () => {
  const Doc = entity('Doc', {
    title: text(),
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl', { fields: { severity: number() } })],
      measurements: [measurement('audio', { extension: 'testFieldExt', formatVersion: 1 })],
    }),
  });
  assert.ok(Doc.fields.body);
  assert.equal(Doc.fields.body.kind, 'annotatedText');
  const ddl = generateDDL(Doc);
  assert.ok(ddl.some(s => s.includes('Doc_body_membership')));
  assert.ok(ddl.some(s => s.includes('Doc_body_annotation_hl')));
  assert.ok(ddl.some(s => s.includes('Doc_body_measurement')));
});

// ---- New declarative API tests ----

test('annotation() returns a frozen descriptor with correct shape', () => {
  const a = annotation('highlight', { fields: { col1: text() } });
  assert.equal(a.kind, 'annotation');
  assert.equal(a.annotationName, 'highlight');
  assert.ok(Object.isFrozen(a));
  assert.ok(Object.isFrozen(a.fields));
  assert.deepEqual(Object.keys(a.fields), ['col1']);
  assert.deepEqual(a.actions, {});
  assert.equal(a.empty, 'delete');
  assert.equal(a.appliesTo, 'text-range');
  assert.equal(a.cardinality, 'many');
});

test('annotation() compiles text-range one cardinality declarations', () => {
  const d = annotatedText({
    project: 'project', owner: 'owner',
    annotations: [annotation('groupCode', { cardinality: 'one', fields: { value: text() } })],
    measurements: [measurement('m', { extension: 'testFieldExt' })],
  });
  validateAnnotatedTextDeclaration('Doc', 'body', d, makeFields());
  const handle = getAnnotatedTextCompiledMetadata(d).annotationHandles.groupCode;
  assert.equal(handle.appliesTo, 'text-range');
  assert.equal(handle.cardinality, 'one');
});

test('annotation() accepts and compiles text-range declarations', () => {
  const d = annotatedText({
    project: 'project', owner: 'owner',
    annotations: [annotation('code', { appliesTo: 'text-range', cardinality: 'many', fields: { value: text() } })],
    measurements: [measurement('m', { extension: 'testFieldExt' })],
  });
  validateAnnotatedTextDeclaration('Doc', 'body', d, makeFields());
  const handle = getAnnotatedTextCompiledMetadata(d).annotationHandles.code;
  assert.equal(handle.appliesTo, 'text-range');
  assert.equal(handle.cardinality, 'many');
});

test('annotation() rejects invalid appliesTo and cardinality declarations', () => {
  assert.throws(() => annotation('bad', { appliesTo: 'document' }), /appliesTo must be 'text-range'/);
  assert.throws(() => annotation('bad', { appliesTo: 'block' }), /appliesTo must be 'text-range'/);
  assert.throws(() => annotation('bad', { cardinality: 'some' }), /cardinality must be 'many' or 'one'/);

  for (const [key, value, message] of [
    ['appliesTo', 'document', /must be 'text-range'/],
    ['appliesTo', 'block-group', /must be 'text-range'/],
    ['cardinality', 'some', /must be 'many' or 'one'/],
  ]) {
    const bad = Object.freeze({ ...annotation('bad'), [key]: value });
    assert.throws(() => validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner', annotations: [bad],
      measurements: [measurement('m', { extension: 'testFieldExt' })],
    }), makeFields()), message);
  }
});

test('declaration validation rejects block-era appliesTo descriptors', () => {
  const bad = Object.freeze({
    ...annotation('bad'),
    appliesTo: 'block-group',
  });
  assert.throws(() => validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
    project: 'project', owner: 'owner', annotations: [bad],
    measurements: [measurement('m', { extension: 'testFieldExt' })],
  }), makeFields()), /must be 'text-range'/);
});

test('annotation empty policy is closed and compiled into its static handle', () => {
  assert.throws(() => annotation('bad', { empty: null }), /must be 'delete' or 'orphan'/);
  assert.throws(() => protectingAnnotation('bad', { empty: 'retain' }), /must be 'delete' or 'orphan'/);
  const descriptor = annotatedText({
    project: 'project', owner: 'owner',
    annotations: [annotation('comment', { empty: 'orphan' })],
    measurements: [measurement('m', { extension: 'testFieldExt' })],
  });
  validateAnnotatedTextDeclaration('Doc', 'body', descriptor, makeFields());
  assert.equal(getAnnotatedTextCompiledMetadata(descriptor).annotationHandles.comment.empty, 'orphan');
});

test('protectingAnnotation() returns a frozen descriptor with protects', () => {
  const a = protectingAnnotation('full', { fields: {}, protects: 'base' });
  assert.equal(a.kind, 'protectingAnnotation');
  assert.equal(a.annotationName, 'full');
  assert.equal(a.protects, 'base');
  assert.ok(Object.isFrozen(a));
});

test('protectingAnnotation() rejects malformed protects', () => {
  assert.throws(() => protectingAnnotation('bad', { protects: 'invalid name!' }), /must name a valid annotation family/);
});

test('protectingAnnotation with null protects is valid', () => {
  const a = protectingAnnotation('standalone', { protects: null });
  assert.equal(a.protects, null);
});

test('validation rejects protecting annotation that references undeclared family', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [
        annotation('base'),
        protectingAnnotation('child', { protects: 'nonexistent', access: () => grant(read) }),
      ],
      measurements: [measurement('m', { extension: 'testFieldExt', formatVersion: 1 })],
    }), makeFields());
  }, /does not name a declared annotation family/);
});

test('validation accepts protecting annotation that references a declared family', () => {
  const result = validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
    project: 'project', owner: 'owner',
    annotations: [
      annotation('base'),
      protectingAnnotation('child', { protects: 'base', access: () => grant(read) }),
    ],
    measurements: [measurement('m', { extension: 'testFieldExt', formatVersion: 1 })],
  }), makeFields());
  assert.deepEqual(result.families, ['base', 'child']);
});

test('measurement() returns a frozen descriptor with correct shape', () => {
  const m = measurement('audio', { extension: 'ext', formatVersion: 2, queries: ['q1'] });
  assert.equal(m.kind, 'measurement');
  assert.equal(m.measurementName, 'audio');
  assert.equal(m.extension, 'ext');
  assert.equal(m.formatVersion, 2);
  assert.deepEqual(m.queries, ['q1']);
  assert.ok(Object.isFrozen(m));
  assert.ok(Object.isFrozen(m.queries));
});

test('measurement() default formatVersion is 1', () => {
  const m = measurement('audio');
  assert.equal(m.formatVersion, 1);
});

test('measurement() rejects invalid formatVersion', () => {
  assert.throws(() => measurement('x', { formatVersion: 0 }), /positive integer/);
  assert.throws(() => measurement('x', { formatVersion: 1.5 }), /positive integer/);
  assert.throws(() => measurement('x', { formatVersion: -1 }), /positive integer/);
});

test('measurement() rejects invalid extension', () => {
  assert.throws(() => measurement('x', { extension: 'bad name' }), /valid identifier/);
});

test('measurement() rejects invalid query identifiers', () => {
  assert.throws(() => measurement('x', { queries: ['bad name'] }), /valid identifier/);
});

test('annotationAction() returns a frozen descriptor', () => {
  const change = () => ({ fields: {} });
  const a = annotationAction({ input: { reason: text() }, change });
  assert.equal(a.kind, 'annotationAction');
  assert.deepEqual(Object.keys(a.input), ['reason']);
  assert.equal(a.change, change);
  assert.ok(Object.isFrozen(a));
  assert.ok(Object.isFrozen(a.input));
});

test('annotationAction() requires a change function', () => {
  assert.throws(() => annotationAction({}), /requires a change function/);
});

test('validation rejects duplicate annotation names', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('dup'), annotation('dup')],
      measurements: [measurement('m', { extension: 'testFieldExt', formatVersion: 1 })],
    }), makeFields());
  }, /duplicate annotation name/);
});

test('validation rejects duplicate measurement names', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('dup', { extension: 'testFieldExt' }), measurement('dup', { extension: 'testFieldExt' })],
    }), makeFields());
  }, /duplicate measurement name/);
});

test('validation rejects unknown keys on descriptor', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', {
      project: 'project', owner: 'owner',
      block: {},
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: 'testFieldExt' })],
      kind: 'annotatedText',
      type: 'annotatedText',
      unknownKey: true,
    }, makeFields());
  }, /unknown key/);
});

test('validation rejects unknown keys on annotation descriptors', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [Object.freeze({ ...annotation('hl'), unknownKey: true })],
      measurements: [measurement('m', { extension: 'testFieldExt' })],
    }), makeFields());
  }, /unknown key/);
});

test('validation rejects unknown keys on measurement descriptors', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [Object.freeze({ ...measurement('m', { extension: 'testFieldExt' }), unknownKey: true })],
    }), makeFields());
  }, /unknown key/);
});

test('validation rejects imperative handlers on annotation actions', () => {
  assert.throws(() => {
    const badAction = Object.freeze({ kind: 'annotationAction', input: Object.freeze({}), change: () => ({}), authorize: null, handler: () => {} });
    const badAnn = annotation('hl', { actions: { resolve: badAction } });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m', { extension: 'testFieldExt' })],
    }), makeFields());
  }, /does not accept action handlers/);
});

test('validation rejects queries referencing unregistered contracts', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: 'testFieldExt', queries: ['unregisteredQuery'] })],
    }), makeFields());
  }, /not a registered contract/);
});

test('validation rejects measurement extension referencing unregistered contract', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: 'unregisteredExt' })],
    }), makeFields());
  }, /not a registered contract/);
});

test('registerAnnotatedTextContract validates and stores contract', () => {
  registerAnnotatedTextContract('testContract', Object.freeze({ kind: 'measurement', schema: {} }));
  registerAnnotatedTextContract('testQuery', Object.freeze({ kind: 'measurement-query' }));
  assert.throws(() => registerAnnotatedTextContract('testContract', Object.freeze({ kind: 'measurement' })), /already registered/);
  assert.throws(() => registerAnnotatedTextContract('bad name', Object.freeze({ kind: 'measurement' })), /valid identifier/);
});

test('registered contract allows validation to pass', () => {
  registerAnnotatedTextContract('myExt', Object.freeze({ kind: 'measurement', version: '1' }));
  registerAnnotatedTextStructuralExtension('myExt', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  }));
  registerAnnotatedTextContract('myQuery', Object.freeze({ kind: 'measurement-query' }));
  const result = validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
    project: 'project', owner: 'owner',
    annotations: [annotation('hl', { actions: { resolve: annotationAction({ change: () => ({ fields: {} }) }) } })],
    measurements: [measurement('m', { extension: 'myExt', queries: ['myQuery'] })],
  }), makeFields());
  assert.deepEqual(result.families, ['hl']);
  assert.deepEqual(result.measurements, ['m']);
});

test('registerAnnotatedTextStructuralExtension stores and resolves', () => {
  registerAnnotatedTextStructuralExtension('speech', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  }));
  const resolved = resolveDeclarationMeasurementExtension(measurement('audio', { extension: 'speech' }));
  assert.ok(resolved);
  assert.equal(resolved.version, 1);
});

test('registerAnnotatedTextStructuralExtension rejects invalid name', () => {
  assert.throws(() => registerAnnotatedTextStructuralExtension('bad name', () => {}), /valid identifier/);
});

test('registerAnnotatedTextStructuralExtension rejects duplicate', () => {
  registerAnnotatedTextStructuralExtension('uniqueExt101', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  }));
  assert.throws(() => registerAnnotatedTextStructuralExtension('uniqueExt101', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  })), /already registered/);
});

test('registerAnnotatedTextStructuralExtension rejects non-function', () => {
  assert.throws(() => registerAnnotatedTextStructuralExtension('ext2', 'not-a-fn'), /requires a frozen spec object/);
});

test('resolveDeclarationMeasurementExtension returns null for non-measurement', () => {
  assert.equal(resolveDeclarationMeasurementExtension(null), null);
  assert.equal(resolveDeclarationMeasurementExtension({ kind: 'annotation' }), null);
});

test('resolveDeclarationMeasurementExtension returns null for unregistered extension', () => {
  assert.equal(resolveDeclarationMeasurementExtension(measurement('x', { extension: 'nonexistent' })), null);
});

test('getAnnotatedTextCompiledMetadata returns compiled metadata', () => {
  const d = annotatedText({
    project: 'project', owner: 'owner',
    annotations: [annotation('hl')],
    measurements: [measurement('m', { extension: 'testFieldExt' })],
  });
  validateAnnotatedTextDeclaration('Doc', 'body', d, makeFields());
  const meta = getAnnotatedTextCompiledMetadata(d);
  assert.ok(meta);
  assert.ok(meta.annotationHandles);
  assert.ok(meta.measurementHandles);
  assert.ok(meta.annotationHandles.hl);
  assert.equal(meta.annotationHandles.hl.family, 'hl');
  assert.ok(meta.measurementHandles.m);
  assert.equal(meta.measurementHandles.m.family, 'm');
  assert.deepEqual(meta.blockFields, []);
  assert.deepEqual(meta.families, ['hl']);
  assert.deepEqual(meta.measurementFamilyList, ['m']);
});

test('capabilities are validated and stored in compiled metadata', () => {
  const cap = Object.freeze({ name: 'read' });
  const d = annotatedText({
    project: 'project', owner: 'owner',
    annotations: [annotation('hl')],
    measurements: [measurement('m', { extension: 'testFieldExt' })],
    capabilities: { readTranscript: cap },
  });
  validateAnnotatedTextDeclaration('Doc', 'body', d, makeFields());
  const meta = getAnnotatedTextCompiledMetadata(d);
  assert.ok(meta.capabilities);
  assert.ok(meta.capabilityHandles);
  assert.equal(meta.capabilityHandles.readTranscript.name, 'readTranscript');
});

test('rejects: capabilities must be an object', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: 'testFieldExt' })],
      capabilities: 'not-an-object',
    }), makeFields());
  }, /must be a non-empty object/);
});

test('rejects: capabilities must be frozen', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: 'testFieldExt' })],
      capabilities: { x: 'not-frozen' },
    }), makeFields());
  }, /must be a frozen descriptor/);
});

// ---- T3 action validation regression tests (P1) ----

test('T3 rejects action with wrong kind (not annotationAction)', () => {
  assert.throws(() => {
    const badAction = Object.freeze({ kind: 'measurement', actionName: 'myAction' });
    const badAnn = annotation('hl', { actions: { myAction: badAction } });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m', { extension: 'testFieldExt' })],
    }), makeFields());
  }, /expected annotationAction descriptor/);
});

test('T3 rejects action with no kind field', () => {
  assert.throws(() => {
    const badAction = Object.freeze({ actionName: 'myAction' });
    const badAnn = annotation('hl', { actions: { myAction: badAction } });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m', { extension: 'testFieldExt' })],
    }), makeFields());
  }, /expected annotationAction descriptor/);
});

test('T3 rejects action with extra unknown key', () => {
  assert.throws(() => {
    const badAction = Object.freeze({ kind: 'annotationAction', actionName: 'myAction', payload: 'extra' });
    const badAnn = annotation('hl', { actions: { myAction: badAction } });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m', { extension: 'testFieldExt' })],
    }), makeFields());
  }, /unknown key/);
});

test('T3 rejects action with SQL callback', () => {
  assert.throws(() => {
    const badAction = Object.freeze({ kind: 'annotationAction', actionName: 'myAction', sql: 'DELETE FROM x' });
    const badAnn = annotation('hl', { actions: { myAction: badAction } });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m', { extension: 'testFieldExt' })],
    }), makeFields());
  }, /T3 does not accept action handlers, reducers, or SQL callbacks/);
});

test('T3 rejects action with SQL uppercase callback', () => {
  assert.throws(() => {
    const badAction = Object.freeze({ kind: 'annotationAction', actionName: 'myAction', SQL: 'DELETE FROM x' });
    const badAnn = annotation('hl', { actions: { myAction: badAction } });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m', { extension: 'testFieldExt' })],
    }), makeFields());
  }, /T3 does not accept action handlers, reducers, or SQL callbacks/);
});

test('T3 rejects action with reducer callback', () => {
  assert.throws(() => {
    const badAction = Object.freeze({ kind: 'annotationAction', actionName: 'myAction', reducer: () => ({}) });
    const badAnn = annotation('hl', { actions: { myAction: badAction } });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m', { extension: 'testFieldExt' })],
    }), makeFields());
  }, /T3 does not accept action handlers, reducers, or SQL callbacks/);
});

test('T3 rejects unfrozen action descriptor', () => {
  assert.throws(() => {
    const badAction = { kind: 'annotationAction', actionName: 'myAction' };
    const badAnn = annotation('hl', { actions: { myAction: badAction } });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m', { extension: 'testFieldExt' })],
    }), makeFields());
  }, /each action must be a frozen object/);
});

test('T3 rejects action with invalid keyed identifier', () => {
  assert.throws(() => {
    const badAction = annotationAction({ change: () => ({ fields: {} }) });
    const badAnn = annotation('hl', { actions: { 'bad name!': badAction } });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m', { extension: 'testFieldExt' })],
    }), makeFields());
  }, /invalid or reserved identifier/);
});

// ---- T8 measurement structural adapter registration tests ----

test('T8 rejects structural extension with unknown key', () => {
  assert.throws(() => registerAnnotatedTextStructuralExtension('t8unknown', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
    unknownKey: 42,
  })), /must have exactly/);
});

test('T8 rejects structural extension with wrong version', () => {
  assert.throws(() => registerAnnotatedTextStructuralExtension('t8wrongVer', Object.freeze({
    version: 2,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  })), /version exactly 1/);
});

test('T8 rejects structural extension with missing required function', () => {
  assert.throws(() => registerAnnotatedTextStructuralExtension('t8missingFn', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
  })), /must have exactly/);
});

test('T8 rejects structural extension with unnamed function', () => {
  const unnamed = function() {};
  Object.defineProperty(unnamed, 'name', { value: '' });
  assert.throws(() => registerAnnotatedTextStructuralExtension('t8unnamed', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: unnamed,
  })), /must be a named function/);
});

test('T8 rejects structural extension with async function', () => {
  assert.throws(() => registerAnnotatedTextStructuralExtension('t8async', Object.freeze({
    version: 1,
    validate: async function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  })), /direct synchronous function/);
});

test('T8 rejects an async function with a shadowed constructor', () => {
  const validate = async function validate() {};
  Object.defineProperty(validate, 'constructor', { value: { name: 'Function' } });
  assert.throws(() => registerAnnotatedTextStructuralExtension('t8asyncShadowed', Object.freeze({
    version: 1,
    validate,
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  })), /direct synchronous function/);
});

test('T8 rejects bound and proxied async callbacks', () => {
  const asyncValidate = async function validate() {};
  for (const [name, validate] of [
    ['t8asyncBound', asyncValidate.bind(null)],
    ['t8asyncProxy', new Proxy(asyncValidate, {})],
  ]) {
    assert.throws(() => registerAnnotatedTextStructuralExtension(name, Object.freeze({
      version: 1,
      validate,
      edit: function edit() {},
      partition: function partition() {},
      combine: function combine() {},
    })), /direct synchronous function/);
  }
});

test('T8 rejects structural extension with non-function value', () => {
  assert.throws(() => registerAnnotatedTextStructuralExtension('t8nonfn', Object.freeze({
    version: 1,
    validate: 'not-a-fn',
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  })), /requires a named 'validate' function/);
});

test('T8 rejects structural extension with unfrozen spec', () => {
  assert.throws(() => registerAnnotatedTextStructuralExtension('t8unfrozen', {
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  }), /requires a frozen spec object/);
});

test('T8 rejects hidden, symbolic, and accessor structural spec properties', () => {
  const hidden = {
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  };
  Object.defineProperty(hidden, 'hidden', { value: true });
  assert.throws(() => registerAnnotatedTextStructuralExtension('t8hidden', Object.freeze(hidden)), /must have exactly/);

  const symbolic = {
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  };
  Object.defineProperty(symbolic, Symbol('hidden'), { value: true });
  assert.throws(() => registerAnnotatedTextStructuralExtension('t8symbolic', Object.freeze(symbolic)), /must have exactly/);

  const accessor = {
    version: 1,
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  };
  Object.defineProperty(accessor, 'validate', { enumerable: true, get() { return function validate() {}; } });
  assert.throws(() => registerAnnotatedTextStructuralExtension('t8accessor', Object.freeze(accessor)), /own data property/);
});

test('T8 freezes registered callbacks before exposing the adapter', () => {
  const validate = function validate() {};
  const spec = Object.freeze({
    version: 1,
    validate,
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  });
  registerAnnotatedTextStructuralExtension('t8frozenCallbacks', spec);
  assert.ok(Object.isFrozen(validate));
  assert.throws(() => { validate.changed = true; }, /Cannot add property/);
  assert.equal(resolveDeclarationMeasurementExtension(measurement('m', { extension: 't8frozenCallbacks' })).validate, validate);
});

test('T8 rejects structural extension with duplicate name', () => {
  registerAnnotatedTextStructuralExtension('t8dupe', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  }));
  assert.throws(() => registerAnnotatedTextStructuralExtension('t8dupe', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  })), /already registered/);
});

test('T8 rejects structural extension with invalid identifier name', () => {
  assert.throws(() => registerAnnotatedTextStructuralExtension('bad name!', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  })), /valid identifier/);
});

// ---- T8 measurement declaration validation tests ----

test('T8 rejects measurement with null extension', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: null })],
    }), makeFields());
  }, /must declare an extension/);
});

test('T8 rejects measurement with unregistered extension (no semantic contract)', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: 'notRegistered' })],
    }), makeFields());
  }, /not a registered contract/);
});

test('T8 rejects measurement with registered semantic contract but no structural adapter', () => {
  registerAnnotatedTextContract('t8semOnly', Object.freeze({ kind: 'measurement' }));
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: 't8semOnly' })],
    }), makeFields());
  }, /has no registered structural adapter/);
});

test('T8 rejects measurement with wrong contract kind (not measurement)', () => {
  registerAnnotatedTextContract('t8wrongKind', Object.freeze({ kind: 'event' }));
  registerAnnotatedTextStructuralExtension('t8wrongKind', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  }));
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: 't8wrongKind' })],
    }), makeFields());
  }, /is a 'event' contract, not a 'measurement' contract/);
});

test('T8 accepts measurement with both semantic contract and structural adapter', () => {
  registerAnnotatedTextContract('t8dualValid', Object.freeze({ kind: 'measurement' }));
  registerAnnotatedTextStructuralExtension('t8dualValid', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  }));
  const result = validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
    project: 'project', owner: 'owner',
    annotations: [annotation('hl')],
    measurements: [measurement('m', { extension: 't8dualValid' })],
  }), makeFields());
  assert.deepEqual(result.measurements, ['m']);
});

test('T8 rejects measurement extension with wrong contract kind (event)', () => {
  registerAnnotatedTextContract('t8eventKind', Object.freeze({ kind: 'event' }));
  registerAnnotatedTextStructuralExtension('t8eventKind', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  }));
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: 't8eventKind' })],
    }), makeFields());
  }, /not a 'measurement' contract/);
});

test('T8 rejects measurement extension with measurement-query kind contract', () => {
  registerAnnotatedTextContract('t8queryKind', Object.freeze({ kind: 'measurement-query' }));
  registerAnnotatedTextStructuralExtension('t8queryKind', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {},
    combine: function combine() {},
  }));
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: 't8queryKind' })],
    }), makeFields());
  }, /not a 'measurement' contract/);
});

// ---- ON DELETE CASCADE tests for project/owner deletion ----

test('ON DELETE CASCADE removes annotation and measurement rows when project is deleted', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');

  const descriptor = fd(
    { source: { kind: 'value', type: 'text' } },
    { highlight: { col1: { kind: 'value', type: 'text' } } },
  );
  for (const sql of annotatedTextDDL('Doc', 'body', descriptor, makeFields())) db.exec(sql);

  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  db.exec("INSERT INTO Doc (id, title) VALUES ('d1', 'test')");
  db.exec("INSERT INTO Doc_body_annotation (id, document_id, project_id, owner_id, family) VALUES ('a1', 'd1', 'p1', 'u1', 'highlight')");
  db.exec("INSERT INTO Doc_body_annotation_highlight (annotation_id, col1) VALUES ('a1', 'v1')");
  db.exec("INSERT INTO Doc_body_range (id, document_id, start_point, end_point) VALUES (1, 'd1', '[1,2]', '[1,3]')");
  db.exec("INSERT INTO Doc_body_membership (annotation_id, range_id, document_id, ordinal) VALUES ('a1', 1, 'd1', 0)");
  db.exec("INSERT INTO Doc_body_measurement (id, document_id, family, format_version, payload) VALUES ('m1', 'd1', 'audio', 1, '{}')");

  db.exec("DELETE FROM Project WHERE id = 'p1'");

  // Annotation/membership cascade via project_id; the DOCUMENT-scoped
  // measurement references Doc (not Project) and survives the project delete.
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_annotation').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_annotation_highlight').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_membership').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_measurement').get().c, 1);
});

test('ON DELETE CASCADE removes annotation and measurement rows when owner is deleted', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');

  const descriptor = fd(
    { source: { kind: 'value', type: 'text' } },
    { highlight: { col1: { kind: 'value', type: 'text' } } },
  );
  for (const sql of annotatedTextDDL('Doc', 'body', descriptor, makeFields())) db.exec(sql);

  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  db.exec("INSERT INTO Doc (id, title) VALUES ('d1', 'test')");
  db.exec("INSERT INTO Doc_body_annotation (id, document_id, project_id, owner_id, family) VALUES ('a1', 'd1', 'p1', 'u1', 'highlight')");
  db.exec("INSERT INTO Doc_body_annotation_highlight (annotation_id, col1) VALUES ('a1', 'v1')");
  db.exec("INSERT INTO Doc_body_range (id, document_id, start_point, end_point) VALUES (1, 'd1', '[1,2]', '[1,3]')");
  db.exec("INSERT INTO Doc_body_membership (annotation_id, range_id, document_id, ordinal) VALUES ('a1', 1, 'd1', 0)");
  db.exec("INSERT INTO Doc_body_measurement (id, document_id, family, format_version, payload) VALUES ('m1', 'd1', 'audio', 1, '{}')");

  db.exec("DELETE FROM User WHERE id = 'u1'");

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_annotation').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_annotation_highlight').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_membership').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_measurement').get().c, 1);
});
