// Registered query families (#225, ADR-0009 phase 2): Scope-style dynamic
// typed values (catalog + element rows) queried through a registered family.

import { text, ref, number, boolean, grant, read, subscribe, scope } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { entity, generateDDL, generateFrameworkDDL } from '../build/internal.mjs';
import { principal } from '../build/principal.mjs';
import {
  createQueryInvalidationHub,
  readCommittedRevision,
} from '../build/query-scoped-read.mjs';
import {
  compileQueryFamily,
  createQueryFamilyRegistry,
  registerQueryFamilyInvalidation,
  queryFamilyChangedSince,
} from '../build/query-family.mjs';
import { fieldSet } from '../build/event-handle.mjs';

const alice = principal({ type: 'user', id: 'alice' });
const bob = principal({ type: 'user', id: 'bob' });
const ownerGrant = () => [scope(({ is }) => is.owner()).can(() => grant(read, subscribe))];

function makeSlice() {
  const Artefact = entity('Artefact', {
    title: text(),
    rank: number(),
    projectId: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: ownerGrant,
  });
  const ValueSet = entity('ValueSet', {
    name: text(),
    valueType: text(),
    projectId: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: ownerGrant,
  });
  const ValueElement = entity('ValueElement', {
    hostId: text(),
    fieldId: text(),
    textValue: text(),
    numberValue: number(),
    epochValue: number(),
    booleanValue: boolean(),
    optionValue: text(),
    projectId: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: ownerGrant,
  });
  return { Artefact, ValueSet, ValueElement };
}

function seed(db, { Artefact, ValueSet, ValueElement }) {
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  for (const sql of generateDDL(Artefact)) db.exec(sql);
  for (const sql of generateDDL(ValueSet)) db.exec(sql);
  for (const sql of generateDDL(ValueElement)) db.exec(sql);
  db.prepare('INSERT INTO Artefact (id, title, rank, projectId, owner) VALUES (?, ?, ?, ?, ?)').run('a1', 'Alpha', 1, 'p1', 'alice');
  db.prepare('INSERT INTO Artefact (id, title, rank, projectId, owner) VALUES (?, ?, ?, ?, ?)').run('a2', 'Beta', 2, 'p1', 'alice');
  db.prepare('INSERT INTO Artefact (id, title, rank, projectId, owner) VALUES (?, ?, ?, ?, ?)').run('a3', 'Gamma', 3, 'p1', 'alice');
  db.prepare('INSERT INTO Artefact (id, title, rank, projectId, owner) VALUES (?, ?, ?, ?, ?)').run('a4', 'Delta', 1, 'p2', 'bob');
  const vs = db.prepare('INSERT INTO ValueSet (id, name, valueType, projectId, owner) VALUES (?, ?, ?, ?, ?)');
  vs.run('f-text', 'label', 'text', 'p1', 'alice');
  vs.run('f-num', 'count', 'number', 'p1', 'alice');
  vs.run('f-epoch', 'captured', 'epoch', 'p1', 'alice');
  vs.run('f-bool', 'published', 'boolean', 'p1', 'alice');
  vs.run('f-opt', 'kind', 'option', 'p1', 'alice');
  vs.run('f-bob', 'secret', 'text', 'p2', 'bob');
  const el = db.prepare('INSERT INTO ValueElement (id, hostId, fieldId, textValue, numberValue, epochValue, booleanValue, optionValue, projectId, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  el.run('e1', 'a1', 'f-text', 'red apple', null, null, null, null, 'p1', 'alice');
  el.run('e2', 'a2', 'f-text', 'green pear', null, null, null, null, 'p1', 'alice');
  el.run('e3', 'a3', 'f-text', '', null, null, null, null, 'p1', 'alice');
  el.run('e4', 'a1', 'f-num', null, 10, null, null, null, 'p1', 'alice');
  el.run('e5', 'a2', 'f-num', null, 50, null, null, null, 'p1', 'alice');
  el.run('e6', 'a1', 'f-epoch', null, null, 100, null, null, 'p1', 'alice');
  el.run('e7', 'a2', 'f-epoch', null, null, 200, null, null, 'p1', 'alice');
  el.run('e8', 'a1', 'f-bool', null, null, null, 1, null, 'p1', 'alice');
  el.run('e9', 'a2', 'f-bool', null, null, null, 0, null, 'p1', 'alice');
  el.run('e10', 'a1', 'f-opt', null, null, null, null, 'photo', 'p1', 'alice');
  el.run('e11', 'a2', 'f-opt', null, null, null, null, 'clip', 'p1', 'alice');
  el.run('e12', 'a4', 'f-bob', 'hidden', null, null, null, null, 'p2', 'bob');
  el.run('e-leak', 'a1', 'f-text', 'banana', null, null, null, null, 'p1', 'bob');
}

function familyOf(slice) {
  return compileQueryFamily({
    name: 'artefactsByProperty',
    host: slice.Artefact,
    catalog: slice.ValueSet,
    elements: slice.ValueElement,
    hostKey: 'hostId',
    fieldKey: 'fieldId',
    typeField: 'valueType',
    valueColumns: {
      text: 'textValue',
      number: 'numberValue',
      epoch: 'epochValue',
      boolean: 'booleanValue',
      option: 'optionValue',
    },
  });
}

function setup() {
  const db = new DatabaseSync(':memory:');
  const slice = makeSlice();
  seed(db, slice);
  const registry = createQueryFamilyRegistry();
  registry.register(familyOf(slice));
  return { db, ...slice, registry };
}

function run(registry, db, principal, request) {
  return registry.execute('artefactsByProperty', db, principal, {
    sort: { field: 'rank', direction: 'asc' },
    pageSize: 10,
    ...request,
  });
}

test('dynamic text contains, empty, and unknown field', () => {
  const { db, registry } = setup();
  try {
    const page = run(registry, db, alice, { fieldId: 'f-text', op: 'contains', value: 'apple', includeCount: true });
    assert.deepEqual(page.rows.map((row) => row.id), ['a1']);
    assert.equal(page.count, 1);
    const empty = run(registry, db, alice, { fieldId: 'f-text', op: 'isEmpty' });
    assert.deepEqual(empty.rows.map((row) => row.id), ['a3']);
    assert.throws(
      () => run(registry, db, alice, { fieldId: 'no-such', op: 'eq', value: 'x' }),
      /unknown field/,
    );
    assert.throws(
      () => run(registry, db, alice, { fieldId: 'f-bob', op: 'contains', value: 'hidden' }),
      /unknown field/,
    );
  } finally {
    db.close();
  }
});

test('dynamic number, epoch, boolean, and option filters', () => {
  const { db, registry } = setup();
  try {
    const ranged = run(registry, db, alice, { fieldId: 'f-num', op: 'gte', value: 40, includeCount: true });
    assert.deepEqual(ranged.rows.map((row) => row.id), ['a2']);
    assert.equal(ranged.count, 1);
    const epoch = run(registry, db, alice, { fieldId: 'f-epoch', op: 'lt', value: 150 });
    assert.deepEqual(epoch.rows.map((row) => row.id), ['a1']);
    const published = run(registry, db, alice, { fieldId: 'f-bool', op: 'eq', value: true });
    assert.deepEqual(published.rows.map((row) => row.id), ['a1']);
    const kinds = run(registry, db, alice, { fieldId: 'f-opt', op: 'in', value: ['photo', 'clip'] });
    assert.deepEqual(kinds.rows.map((row) => row.id), ['a1', 'a2']);
  } finally {
    db.close();
  }
});

test('unsupported operator and type-mismatched value fail closed', () => {
  const { db, registry } = setup();
  try {
    assert.throws(
      () => run(registry, db, alice, { fieldId: 'f-num', op: 'contains', value: '1' }),
      /not supported on number/,
    );
    assert.throws(
      () => run(registry, db, alice, { fieldId: 'f-text', op: 'gt', value: 'a' }),
      /not supported on text/,
    );
    assert.throws(
      () => run(registry, db, alice, { fieldId: 'f-bool', op: 'eq', value: 'yes' }),
      /must be a boolean/,
    );
    assert.throws(
      () => run(registry, db, alice, { fieldId: 'f-text', op: 'eq', value: null }),
      /must not be null/,
    );
  } finally {
    db.close();
  }
});

test('an unregistered family cannot be invoked', () => {
  const { db, registry } = setup();
  try {
    assert.throws(
      () => registry.execute('nope', db, alice, { fieldId: 'f-text', op: 'eq', value: 'x', sort: { field: 'id', direction: 'asc' }, pageSize: 10 }),
      /not registered/,
    );
  } finally {
    db.close();
  }
});

test('pagination boundaries and count on a dynamic filter', () => {
  const { db, registry } = setup();
  try {
    const first = run(registry, db, alice, {
      fieldId: 'f-opt',
      op: 'in',
      value: ['photo', 'clip'],
      pageSize: 1,
      includeCount: true,
    });
    assert.deepEqual(first.rows.map((row) => row.id), ['a1']);
    assert.equal(first.count, 2);
    const second = run(registry, db, alice, {
      fieldId: 'f-opt',
      op: 'in',
      value: ['photo', 'clip'],
      pageSize: 1,
      cursor: first.nextCursor,
    });
    assert.deepEqual(second.rows.map((row) => row.id), ['a2']);
    assert.equal(second.nextCursor, null);
  } finally {
    db.close();
  }
});

test('a membership-changing element edit invalidates and refetches', () => {
  const { db, registry, Artefact, ValueSet, ValueElement } = setup();
  try {
    const before = run(registry, db, alice, { fieldId: 'f-text', op: 'contains', value: 'apple', includeCount: true });
    assert.equal(before.count, 1);
    const hub = createQueryInvalidationHub();
    const family = familyOf({ Artefact, ValueSet, ValueElement });
    registerQueryFamilyInvalidation(hub, {
      id: 'by-label',
      family,
      principal: alice,
      db,
      revision: before.revision,
      scope: 'Project:p1',
    });
    db.prepare("UPDATE ValueElement SET textValue = 'red plum' WHERE id = 'e1'").run();
    db.prepare("UPDATE _CommittedRevision SET revision = revision + 1 WHERE name = 'actions'").run();
    const revision = readCommittedRevision(db);
    hub.notice([{
      type: fieldSet('ValueElement', 'textValue').type,
      handle: fieldSet('ValueElement', 'textValue'),
      scope: 'ValueElement:e1',
      data: { id: 'e1', textValue: 'red plum', projectId: 'p1' },
      committedAt: 't',
    }], revision);
    assert.equal(queryFamilyChangedSince(hub, {
      id: 'by-label',
      family,
      principal: alice,
      sinceRevision: before.revision,
      revision,
    }).kind, 'changed');
    const after = run(registry, db, alice, { fieldId: 'f-text', op: 'contains', value: 'apple', includeCount: true });
    assert.equal(after.count, 0);
    assert.deepEqual(after.rows, []);
  } finally {
    db.close();
  }
});

test('a foreign-owned element on an owned host does not match', () => {
  const { db, registry } = setup();
  try {
    const page = run(registry, db, alice, { fieldId: 'f-text', op: 'contains', value: 'banana' });
    assert.deepEqual(page.rows, [], 'element grant filters bob-owned values off alice hosts');
  } finally {
    db.close();
  }
});

test('a foreign principal cannot read another principal\'s family field', () => {
  const { db, registry } = setup();
  try {
    assert.throws(
      () => run(registry, db, bob, { fieldId: 'f-text', op: 'contains', value: 'apple' }),
      /unknown field/,
    );
    const own = run(registry, db, bob, { fieldId: 'f-bob', op: 'contains', value: 'hidden' });
    assert.deepEqual(own.rows.map((row) => row.id), ['a4']);
  } finally {
    db.close();
  }
});

test('family registration rejects a value column with the wrong declared type', () => {
  const slice = makeSlice();
  assert.throws(
    () => compileQueryFamily({
      name: 'badTypes',
      host: slice.Artefact,
      catalog: slice.ValueSet,
      elements: slice.ValueElement,
      hostKey: 'hostId',
      fieldKey: 'fieldId',
      typeField: 'valueType',
      valueColumns: {
        text: 'numberValue',
        number: 'numberValue',
        epoch: 'epochValue',
        boolean: 'booleanValue',
        option: 'optionValue',
      },
    }),
    /valueColumns.text 'numberValue' must be a text field/,
  );
});
