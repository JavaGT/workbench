import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { computed, entity, grant, map, principal, read, ref, text, write } from '../build/index.mjs';
import { defineSqliteSchema } from '../build/server.mjs';

const user = principal({ type: 'user', id: 'ref-user' });
const grants = () => grant(read, write);

test('generated refs enforce deterministic indexes and fresh-database integrity', async (t) => {
  const Parent = entity('RefParent', { name: text(), grant: grants });
  const Child = entity('RefChild', {
    parentId: ref(Parent, { physical: true }),
    optionalParentId: ref(Parent, { optional: true, physical: true }),
    selfId: ref('RefChild', { nullable: true, physical: true }),
    grant: grants,
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [Child, Parent] });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();

  const ddl = Child.generateDDL().join('\n');
  assert.match(ddl, /FOREIGN KEY \("parentId"\) REFERENCES "RefParent" \("id"\) ON DELETE RESTRICT ON UPDATE NO ACTION/);
  assert.match(ddl, /CREATE INDEX IF NOT EXISTS "idx_RefChild_parentId" ON "RefChild" \("parentId"\);/);
  assert.doesNotMatch(ddl, /CREATE UNIQUE INDEX/);
  assert.match(ddl, /"parentId" TEXT NOT NULL/);
  assert.match(ddl, /"optionalParentId" TEXT/);
  assert.match(ddl, /"selfId" TEXT/);
  assert.deepEqual(
    db.prepare("SELECT name FROM pragma_index_list('RefChild') WHERE origin = 'c' ORDER BY name").all().map(({ name }) => name),
    ['idx_RefChild_optionalParentId', 'idx_RefChild_parentId', 'idx_RefChild_selfId'],
  );
  db.prepare('INSERT INTO RefParent (id, name) VALUES (?, ?)').run('parent', 'Parent');
  db.prepare('INSERT INTO RefChild (id, parentId, optionalParentId, selfId) VALUES (?, ?, ?, ?)').run('child', 'parent', null, null);
  assert.throws(
    () => db.prepare('INSERT INTO RefChild (id, parentId) VALUES (?, ?)').run('orphan', 'missing'),
    /FOREIGN KEY constraint failed/,
  );
  assert.throws(() => db.prepare('DELETE FROM RefParent WHERE id = ?').run('parent'), /FOREIGN KEY constraint failed/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('entity composite unique indexes preserve field order and SQLite NULL semantics', async (t) => {
  const Parent = entity('UniqueIndexParent', { name: text(), grant: grants });
  const Child = entity('UniqueIndexChild', {
    leftId: ref(Parent, { physical: true }),
    rightId: ref(Parent, { physical: true }),
    label: text(),
    indexes: [{ fields: ['leftId', 'rightId'], unique: true }],
    grant: grants,
  });
  const Nullable = entity('NullableUniqueIndex', {
    left: text({ optional: true }),
    right: text({ optional: true }),
    indexes: [{ fields: ['left', 'right'], unique: true }],
    grant: grants,
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [Parent, Child, Nullable] });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();

  assert.match(Child.generateDDL().join('\n'), /CREATE UNIQUE INDEX IF NOT EXISTS "idx_UniqueIndexChild_unique_leftId_rightId" ON "UniqueIndexChild" \("leftId", "rightId"\);/);
  assert.deepEqual(
    db.prepare("SELECT name, \"unique\" FROM pragma_index_list('UniqueIndexChild') WHERE origin = 'c' ORDER BY name").all().map(({ name, unique }) => ({ name, unique })),
    [
      { name: 'idx_UniqueIndexChild_leftId', unique: 0 },
      { name: 'idx_UniqueIndexChild_rightId', unique: 0 },
      { name: 'idx_UniqueIndexChild_unique_leftId_rightId', unique: 1 },
    ],
  );
  assert.deepEqual(
    db.prepare("SELECT name FROM pragma_index_info('idx_UniqueIndexChild_unique_leftId_rightId') ORDER BY seqno").all().map(({ name }) => ({ name })),
    [{ name: 'leftId' }, { name: 'rightId' }],
  );
  db.prepare('INSERT INTO UniqueIndexParent (id, name) VALUES (?, ?), (?, ?)').run('a', 'A', 'b', 'B');
  db.prepare('INSERT INTO UniqueIndexChild (id, leftId, rightId, label) VALUES (?, ?, ?, ?)').run('one', 'a', 'b', 'one');
  db.prepare('INSERT INTO UniqueIndexChild (id, leftId, rightId, label) VALUES (?, ?, ?, ?)').run('distinct', 'b', 'a', 'distinct');
  assert.throws(
    () => db.prepare('INSERT INTO UniqueIndexChild (id, leftId, rightId, label) VALUES (?, ?, ?, ?)').run('two', 'a', 'b', 'two'),
    /UNIQUE constraint failed/,
  );
  db.prepare('INSERT INTO NullableUniqueIndex (id, left, right) VALUES (?, ?, ?)').run('null-one', null, null);
  db.prepare('INSERT INTO NullableUniqueIndex (id, left, right) VALUES (?, ?, ?)').run('null-two', null, null);
  // SQLite unique indexes deliberately allow multiple rows containing NULL.
});

test('composite unique indexes reject invalid and duplicate declarations before schema write', async () => {
  assert.throws(() => entity('BadUniqueIndex', { a: text(), indexes: [{ fields: ['a'], unique: true }], grant: grants }), /at least two/);
  assert.throws(() => entity('BadUniqueField', { a: text(), indexes: [{ fields: ['a', 'missing'], unique: true }], grant: grants }), /stored main-table/);
  assert.throws(() => entity('ComputedUniqueField', { a: text(), b: computed({ compute: () => 'b' }), indexes: [{ fields: ['a', 'b'], unique: true }], grant: grants }), /stored main-table/);
  assert.throws(() => entity('SideTableUniqueField', { a: text(), b: map(text()), indexes: [{ fields: ['a', 'b'], unique: true }], grant: grants }), /stored main-table/);
  assert.throws(() => entity('DuplicateUniqueField', { a: text(), b: text(), indexes: [{ fields: ['a', 'a'], unique: true }], grant: grants }), /must not contain duplicates/);
  assert.throws(() => entity('DuplicateUniqueIndex', { a: text(), b: text(), indexes: [{ fields: ['a', 'b'], unique: true }, { fields: ['b', 'a'], unique: true }], grant: grants }), /duplicate index/);

  const A = entity('CompositeCollision', { a: text(), b: text(), indexes: [{ fields: ['a', 'b'], unique: true }], grant: grants });
  const B = entity('CompositeCollision_unique', { a_b: ref(A, { physical: true }), grant: grants });
  const db = new DatabaseSync(':memory:');
  await assert.rejects(workbench({ db, entities: [A, B] }).start(), /duplicate generated index/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'CompositeCollision'").get().count, 0);
  db.close();
});

test('composite non-unique indexes preserve duplicate rows and compile as ordinary indexes', async (t) => {
  const Entity = entity('NonUniqueIndex', {
    transcriptId: text(),
    createdAt: text(),
    indexes: [{ fields: ['transcriptId', 'createdAt'], unique: false }],
    grant: grants,
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [Entity] });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();

  const ddl = Entity.generateDDL().join('\n');
  assert.match(ddl, /CREATE INDEX IF NOT EXISTS "idx_NonUniqueIndex_transcriptId_createdAt" ON "NonUniqueIndex" \("transcriptId", "createdAt"\);/);
  assert.doesNotMatch(ddl, /CREATE UNIQUE INDEX/);
  assert.deepEqual(
    db.prepare("SELECT name, \"unique\" FROM pragma_index_list('NonUniqueIndex') WHERE origin = 'c'").all()
      .map(({ name, unique }) => ({ name, unique })),
    [{ name: 'idx_NonUniqueIndex_transcriptId_createdAt', unique: 0 }],
  );
  db.prepare('INSERT INTO NonUniqueIndex (id, transcriptId, createdAt) VALUES (?, ?, ?), (?, ?, ?)').run('one', 't', 'same', 'two', 't', 'same');
});

test('eventful removal refs are deferred NO ACTION and cannot be deleted outside Workbench', async (t) => {
  const Parent = entity('RefCascadeParent', { name: text(), grant: grants });
  const Child = entity('RefCascadeChild', { parentId: ref(Parent, { onRemove: 'cascade', physical: true }), grant: grants });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [Parent, Child] });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();
  const fk = db.prepare("SELECT on_delete, on_update FROM pragma_foreign_key_list('RefCascadeChild')").get();
  assert.equal(fk.on_delete, 'NO ACTION');
  assert.equal(fk.on_update, 'NO ACTION');
  db.prepare('INSERT INTO RefCascadeParent (id, name) VALUES (?, ?)').run('parent', 'Parent');
  db.prepare('INSERT INTO RefCascadeChild (id, parentId) VALUES (?, ?)').run('child', 'parent');
  assert.throws(() => db.prepare('DELETE FROM RefCascadeParent WHERE id = ?').run('parent'), /FOREIGN KEY constraint failed/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 0);
  const result = await app.dispatch({ actionId: 'eventful-remove', type: 'RefCascadeParent.remove', payload: { id: 'parent' }, principal: user });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.events.map((event) => event.type), ['RefCascadeChild.removed', 'RefCascadeParent.removed']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _DeletedRowAnchor').get().count, 2);
});

test('generated refs support schema-owned entity targets, preserve unresolved logical refs, and reject colliding indexes', async (t) => {
  const Parent = entity('SchemaRefParent', { grant: grants });
  const Child = entity('SchemaRefChild', { parentId: ref(Parent, { physical: true }), grant: grants });
  const schema = defineSqliteSchema({
    name: 'schema-parent',
    tables: [{ name: 'SchemaRefParent', columns: [{ name: 'id', type: 'text', primaryKey: true }] }],
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, schema, entities: [Child, Parent] });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();
  db.prepare('INSERT INTO SchemaRefParent (id) VALUES (?)').run('parent');
  db.prepare('INSERT INTO SchemaRefChild (id, parentId) VALUES (?, ?)').run('child', 'parent');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  const Missing = entity('MissingRefChild', { parentId: ref('ExternalParent'), grant: grants });
  assert.doesNotMatch(Missing.generateDDL().join('\n'), /FOREIGN KEY|idx_MissingRefChild_parentId/);

  const One = entity('Index_A', { b: ref(Parent, { physical: true }), grant: grants });
  const Two = entity('Index', { A_b: ref(Parent, { physical: true }), grant: grants });
  await assert.rejects(workbench({ db: new DatabaseSync(':memory:'), entities: [Parent, One, Two] }).start(), /duplicate generated index/i);
});
