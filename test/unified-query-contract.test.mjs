// Unified public query contract (#289, related #225):
// - Composable boolean filter trees (AND/OR/NOT + flat filters) with depth/leaf caps
// - Dynamic/EAV multi-filter + dynamic property sort with element/catalog authz
// - filteredTotal + authorized total counts, keyset + bounded offset pagination, configurable maxPageSize
// - Single SQLite read snapshot isolation (zero spurious QueryContentionError on concurrent writes)
// - Row materialization / hydration matching entity reads
// - Public exports directly from build/index.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  entity,
  text,
  number,
  boolean,
  date,
  json,
  ref,
  grant,
  read,
  subscribe,
  scope,
  principal,
  compileQueryContract,
  executeQueryPage,
  acceptQueryPage,
  overlayOptimisticQueryPage,
  readCommittedRevision,
  createQueryInvalidationHub,
  createQueryInvalidationConsumer,
  queryAuthorizationFields,
  withReadSnapshot,
  QueryScopedReadError,
  QueryContentionError,
  QUERY_OPERATORS,
  OPERATORS_BY_FIELD_TYPE,
  QUERY_PAGE_SIZE_MIN,
  QUERY_PAGE_SIZE_MAX,
  QUERY_PAGE_SIZE_CEILING,
  QUERY_OFFSET_MAX,
  QUERY_EXPRESSION_MAX_DEPTH,
  QUERY_EXPRESSION_MAX_LEAVES,
  QUERY_REGISTRATION_MAX,
  compileQueryFamily,
  executeQueryFamily,
  createQueryFamilyRegistry,
  queryFamilyDependencies,
  registerQueryFamilyInvalidation,
  queryFamilyChangedSince,
  DYNAMIC_VALUE_TYPES,
} from '../build/index.mjs';
import { generateDDL, generateFrameworkDDL } from '../build/internal.mjs';

const alice = principal({ type: 'user', id: 'alice' });
const bob = principal({ type: 'user', id: 'bob' });
const charlie = principal({ type: 'user', id: 'charlie' });

const ownerGrant = () => [scope(({ is }) => is.owner()).can(() => grant(read, subscribe))];

function makeRecordEntity() {
  return entity('StudyItem', {
    title: text(),
    status: text(),
    priority: number(),
    archived: boolean(),
    createdAt: date(),
    meta: json(),
    projectId: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: ownerGrant,
  });
}

function seedStudyItems(db, StudyItem) {
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  for (const sql of generateDDL(StudyItem)) db.exec(sql);
  const baseMs = Date.parse('2026-10-01T00:00:00.000Z');
  const insert = db.prepare(
    'INSERT INTO StudyItem (id, title, status, priority, archived, createdAt, meta, projectId, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run('s1', 'Interview 1', 'open', 1, 0, baseMs, JSON.stringify({ tags: ['health'] }), 'p1', 'alice');
  insert.run('s2', 'Interview 2', 'review', 2, 0, baseMs + 1000, JSON.stringify({ tags: ['clinic'] }), 'p1', 'alice');
  insert.run('s3', 'Interview 3', 'closed', 2, 1, baseMs + 2000, JSON.stringify({ tags: ['archive'] }), 'p1', 'alice');
  insert.run('s4', 'Observation', null, 3, 0, baseMs + 3000, null, 'p1', 'alice');
  insert.run('s5', 'Field Note', 'open', 4, 1, baseMs + 4000, JSON.stringify({ tags: ['field'] }), 'p1', 'alice');
  insert.run('s6', 'Bob Secret', 'open', 1, 0, baseMs, JSON.stringify({ tags: ['private'] }), 'p2', 'bob');
  insert.run('s7', 'Bob Review', 'review', 2, 1, baseMs + 500, JSON.stringify({ tags: ['private'] }), 'p2', 'bob');
}

function setupStudyItems() {
  const db = new DatabaseSync(':memory:');
  const StudyItem = makeRecordEntity();
  seedStudyItems(db, StudyItem);
  return { db, StudyItem };
}

function makeFamilySlice() {
  const Artefact = entity('Artefact', {
    title: text(),
    status: text(),
    rank: number(),
    featured: boolean(),
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

function setupFamily(options = {}) {
  const db = options.db ?? new DatabaseSync(':memory:');
  const slice = makeFamilySlice();
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  for (const sql of generateDDL(slice.Artefact)) db.exec(sql);
  for (const sql of generateDDL(slice.ValueSet)) db.exec(sql);
  for (const sql of generateDDL(slice.ValueElement)) db.exec(sql);

  const a = db.prepare('INSERT INTO Artefact (id, title, status, rank, featured, projectId, owner) VALUES (?, ?, ?, ?, ?, ?, ?)');
  a.run('a1', 'Coastal Clinic', 'active', 1, 1, 'p1', 'alice');
  a.run('a2', 'Harbour Survey', 'active', 2, 0, 'p1', 'alice');
  a.run('a3', 'Rural Intake', 'draft', 3, 0, 'p1', 'alice');
  a.run('a4', 'Ward Notes', 'archived', 4, 1, 'p1', 'alice');
  a.run('a5', 'Bob Transcript', 'active', 1, 1, 'p2', 'bob');

  const vs = db.prepare('INSERT INTO ValueSet (id, name, valueType, projectId, owner) VALUES (?, ?, ?, ?, ?)');
  vs.run('f-region', 'Region', 'text', 'p1', 'alice');
  vs.run('f-score', 'Score', 'number', 'p1', 'alice');
  vs.run('f-verified', 'Verified', 'boolean', 'p1', 'alice');
  vs.run('f-stage', 'Stage', 'option', 'p1', 'alice');
  vs.run('f-bob-only', 'BobScore', 'number', 'p2', 'bob');

  const el = db.prepare(
    'INSERT INTO ValueElement (id, hostId, fieldId, textValue, numberValue, epochValue, booleanValue, optionValue, projectId, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  // Alice's elements:
  el.run('e1', 'a1', 'f-region', 'north coast', null, null, null, null, 'p1', 'alice');
  el.run('e2', 'a2', 'f-region', 'south harbour', null, null, null, null, 'p1', 'alice');
  el.run('e3', 'a3', 'f-region', 'north ridge', null, null, null, null, 'p1', 'alice');
  // a4 intentionally has no f-region element (tests isEmpty / NULL sort)
  el.run('e4', 'a1', 'f-score', null, 20, null, null, null, 'p1', 'alice');
  el.run('e5', 'a2', 'f-score', null, 10, null, null, null, 'p1', 'alice');
  el.run('e6', 'a3', 'f-score', null, 20, null, null, null, 'p1', 'alice'); // tie with a1!
  // Duplicate element row for a1 on f-score (higher id e6b) — must NOT duplicate host row in dynamic sort!
  el.run('e6b', 'a1', 'f-score', null, 999, null, null, null, 'p1', 'alice');
  el.run('e7', 'a1', 'f-verified', null, null, null, 1, null, 'p1', 'alice');
  el.run('e8', 'a2', 'f-verified', null, null, null, 0, null, 'p1', 'alice');
  el.run('e9', 'a3', 'f-verified', null, null, null, 1, null, 'p1', 'alice');
  el.run('e10', 'a1', 'f-stage', null, null, null, null, 'coded', 'p1', 'alice');
  el.run('e11', 'a2', 'f-stage', null, null, null, null, 'raw', 'p1', 'alice');
  el.run('e12', 'a3', 'f-stage', null, null, null, null, 'coded', 'p1', 'alice');
  // Foreign-owned element attached to Alice's host a4: MUST NEVER match or sort for Alice!
  el.run('e-leak-score', 'a4', 'f-score', null, 5, null, null, null, 'p1', 'bob');
  el.run('e-leak-region', 'a4', 'f-region', 'north leak', null, null, null, null, 'p1', 'bob');
  // Bob's legitimate element:
  el.run('e-bob', 'a5', 'f-bob-only', null, 42, null, null, null, 'p2', 'bob');

  const family = compileQueryFamily({
    name: 'studyArtefacts',
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
    ...(options.maxPageSize !== undefined ? { maxPageSize: options.maxPageSize } : {}),
  });
  const registry = createQueryFamilyRegistry();
  registry.register(family);
  return { db, ...slice, family, registry };
}

test('public query contract symbols are exported directly from build/index.mjs', () => {
  assert.equal(typeof compileQueryContract, 'function');
  assert.equal(typeof executeQueryPage, 'function');
  assert.equal(typeof acceptQueryPage, 'function');
  assert.equal(typeof overlayOptimisticQueryPage, 'function');
  assert.equal(typeof readCommittedRevision, 'function');
  assert.equal(typeof createQueryInvalidationHub, 'function');
  assert.equal(typeof createQueryInvalidationConsumer, 'function');
  assert.equal(typeof queryAuthorizationFields, 'function');
  assert.equal(typeof withReadSnapshot, 'function');
  assert.equal(typeof QueryScopedReadError, 'function');
  assert.equal(typeof QueryContentionError, 'function');
  assert.equal(typeof compileQueryFamily, 'function');
  assert.equal(typeof executeQueryFamily, 'function');
  assert.equal(typeof createQueryFamilyRegistry, 'function');
  assert.equal(typeof queryFamilyDependencies, 'function');
  assert.equal(typeof registerQueryFamilyInvalidation, 'function');
  assert.equal(typeof queryFamilyChangedSince, 'function');

  assert.ok(Array.isArray(QUERY_OPERATORS) && QUERY_OPERATORS.includes('contains'));
  assert.ok(Array.isArray(DYNAMIC_VALUE_TYPES) && DYNAMIC_VALUE_TYPES.includes('option'));
  assert.ok(OPERATORS_BY_FIELD_TYPE.text.includes('isEmpty'));
  assert.equal(QUERY_PAGE_SIZE_MIN, 1);
  assert.equal(QUERY_PAGE_SIZE_MAX, 100);
  assert.equal(QUERY_PAGE_SIZE_CEILING, 500);
  assert.equal(QUERY_OFFSET_MAX, 100_000);
  assert.equal(QUERY_EXPRESSION_MAX_DEPTH, 8);
  assert.equal(QUERY_EXPRESSION_MAX_LEAVES, 32);
  assert.equal(QUERY_REGISTRATION_MAX, 32);
});

test('nested AND / OR / NOT filter trees enforce scopeFilter on rows, filteredTotal, and total', () => {
  const { db, StudyItem } = setupStudyItems();
  try {
    // (status = 'open' OR status = 'review') AND NOT (archived = true)
    // Alice owns 5 total rows (s1..s5); s1 (open, not archived) and s2 (review, not archived) match.
    // s5 is open but archived=true (excluded by NOT). s6/s7 belong to Bob (excluded by scopeFilter).
    const where = {
      kind: 'and',
      children: [
        {
          kind: 'or',
          children: [
            { kind: 'term', field: 'status', op: 'eq', value: 'open' },
            { kind: 'term', field: 'status', op: 'eq', value: 'review' },
          ],
        },
        {
          kind: 'not',
          child: { kind: 'term', field: 'archived', op: 'eq', value: true },
        },
      ],
    };

    const compiled = compileQueryContract({
      entity: 'StudyItem',
      where,
      sort: { field: 'priority', direction: 'asc' },
      pageSize: 10,
    }, StudyItem);

    // `expression` alias produces the exact same canonical queryIdentity.
    const compiledViaAlias = compileQueryContract({
      entity: 'StudyItem',
      expression: where,
      sort: { field: 'priority', direction: 'asc' },
      pageSize: 10,
    }, StudyItem);
    assert.equal(compiledViaAlias.identity, compiled.identity);

    // Dependency fields harvest every referenced leaf field + sort + authz fields.
    assert.ok(compiled.dependencyFields.includes('status'));
    assert.ok(compiled.dependencyFields.includes('archived'));
    assert.ok(compiled.dependencyFields.includes('priority'));
    assert.ok(compiled.dependencyFields.includes('owner'));
    assert.ok(!compiled.dependencyFields.includes('title'));

    // Alice's view
    const alicePage = executeQueryPage(db, StudyItem, alice, compiled, {
      includeCount: true,
      includeTotal: true,
    });
    assert.deepEqual(alicePage.rows.map((r) => r.id), ['s1', 's2']);
    assert.equal(alicePage.count, 2);
    assert.equal(alicePage.filteredTotal, 2);
    assert.equal(alicePage.total, 5, 'total counts all authorized Alice rows (never Bob rows)');

    // Bob's view: owns s6 (open, not archived) and s7 (review, archived=true)
    const bobPage = executeQueryPage(db, StudyItem, bob, compiled, {
      includeCount: true,
      includeTotal: true,
    });
    assert.deepEqual(bobPage.rows.map((r) => r.id), ['s6']);
    assert.equal(bobPage.count, 1);
    assert.equal(bobPage.filteredTotal, 1);
    assert.equal(bobPage.total, 2, 'total enforces scopeFilter for Bob');

    // Charlie owns zero rows
    const charliePage = executeQueryPage(db, StudyItem, charlie, compiled, {
      includeCount: true,
      includeTotal: true,
    });
    assert.deepEqual(charliePage.rows, []);
    assert.equal(charliePage.count, 0);
    assert.equal(charliePage.filteredTotal, 0);
    assert.equal(charliePage.total, 0);

    // NOT over nullable column uses 2-valued complement: s4 (status = NULL) IS NOT 'closed'
    const notClosed = compileQueryContract({
      entity: 'StudyItem',
      where: {
        kind: 'not',
        child: { kind: 'term', field: 'status', op: 'eq', value: 'closed' },
      },
      sort: { field: 'id', direction: 'asc' },
      pageSize: 10,
    }, StudyItem);
    const notClosedPage = executeQueryPage(db, StudyItem, alice, notClosed, {
      includeCount: true,
      includeTotal: true,
    });
    assert.deepEqual(notClosedPage.rows.map((r) => r.id), ['s1', 's2', 's4', 's5']);
    assert.equal(notClosedPage.filteredTotal, 4);
    assert.equal(notClosedPage.total, 5);

    // Combining flat `filters` AND composable `where`
    const combined = compileQueryContract({
      entity: 'StudyItem',
      filters: [{ field: 'projectId', op: 'eq', value: 'p1' }],
      where: {
        kind: 'or',
        children: [
          { kind: 'term', field: 'status', op: 'isEmpty' },
          { kind: 'term', field: 'priority', op: 'gte', value: 4 },
        ],
      },
      sort: { field: 'id', direction: 'asc' },
      pageSize: 10,
    }, StudyItem);
    const combinedPage = executeQueryPage(db, StudyItem, alice, combined, { includeCount: true });
    assert.deepEqual(combinedPage.rows.map((r) => r.id), ['s4', 's5']);
    assert.equal(combinedPage.filteredTotal, 2);

    // Optimistic overlay flags membershipUncertain when a field in `where` is mutated
    const optimistic = overlayOptimisticQueryPage(
      alicePage,
      [{ id: 's1', verb: 'update', fields: { archived: true } }],
      compiled,
    );
    assert.equal(optimistic.membershipUncertain, true);
  } finally {
    db.close();
  }
});

test('filter tree depth (> 8), leaf count (> 32), and malformed ASTs fail closed', () => {
  const StudyItem = makeRecordEntity();

  // Helper to wrap `depth` levels of `not` around a `term` (total depth = levels + 1)
  const nestNot = (levels) => {
    let node = { kind: 'term', field: 'status', op: 'eq', value: 'open' };
    for (let i = 0; i < levels; i += 1) {
      node = { kind: 'not', child: node };
    }
    return node;
  };

  // Depth = 8 (7 nots + 1 term) is allowed
  const okDepth = compileQueryContract({
    entity: 'StudyItem',
    where: nestNot(7),
    sort: { field: 'id', direction: 'asc' },
    pageSize: 10,
  }, StudyItem);
  assert.equal(okDepth.entity, 'StudyItem');

  // Depth = 9 (8 nots + 1 term) fails closed
  assert.throws(
    () => compileQueryContract({
      entity: 'StudyItem',
      where: nestNot(8),
      sort: { field: 'id', direction: 'asc' },
      pageSize: 10,
    }, StudyItem),
    (err) => err instanceof QueryScopedReadError && /maximum nesting depth/.test(err.message),
  );

  // 32 leaves is allowed
  const makeLeaves = (n) => ({
    kind: 'or',
    children: Array.from({ length: n }, (_, i) => ({
      kind: 'term',
      field: 'priority',
      op: 'eq',
      value: i,
    })),
  });
  const okLeaves = compileQueryContract({
    entity: 'StudyItem',
    where: makeLeaves(32),
    sort: { field: 'id', direction: 'asc' },
    pageSize: 10,
  }, StudyItem);
  assert.equal(okLeaves.entity, 'StudyItem');

  // 33 leaves fails closed
  assert.throws(
    () => compileQueryContract({
      entity: 'StudyItem',
      where: makeLeaves(33),
      sort: { field: 'id', direction: 'asc' },
      pageSize: 10,
    }, StudyItem),
    (err) => err instanceof QueryScopedReadError && /maximum leaf count/.test(err.message),
  );

  // Combined flat filters + where exceeding 32 leaves fails closed
  assert.throws(
    () => compileQueryContract({
      entity: 'StudyItem',
      filters: [{ field: 'status', op: 'eq', value: 'open' }],
      where: makeLeaves(32),
      sort: { field: 'id', direction: 'asc' },
      pageSize: 10,
    }, StudyItem),
    (err) => err instanceof QueryScopedReadError && /maximum leaf count/.test(err.message),
  );

  // Specifying both `where` and `expression` fails closed
  assert.throws(
    () => compileQueryContract({
      entity: 'StudyItem',
      where: { kind: 'term', field: 'status', op: 'eq', value: 'open' },
      expression: { kind: 'term', field: 'status', op: 'eq', value: 'closed' },
      sort: { field: 'id', direction: 'asc' },
      pageSize: 10,
    }, StudyItem),
    QueryScopedReadError,
  );

  // Empty children array fails closed
  assert.throws(
    () => compileQueryContract({
      entity: 'StudyItem',
      where: { kind: 'and', children: [] },
      sort: { field: 'id', direction: 'asc' },
      pageSize: 10,
    }, StudyItem),
    QueryScopedReadError,
  );

  // Unknown node kind fails closed
  assert.throws(
    () => compileQueryContract({
      entity: 'StudyItem',
      where: { kind: 'rawSql', sql: '1=1' },
      sort: { field: 'id', direction: 'asc' },
      pageSize: 10,
    }, StudyItem),
    QueryScopedReadError,
  );
});

test('row hydration deserializes boolean and json fields while preserving keyset paging', () => {
  const { db, StudyItem } = setupStudyItems();
  try {
    const compiled = compileQueryContract({
      entity: 'StudyItem',
      sort: { field: 'archived', direction: 'asc' },
      pageSize: 2,
    }, StudyItem);

    const p1 = executeQueryPage(db, StudyItem, alice, compiled, { includeCount: true });
    assert.equal(p1.rows.length, 2);
    assert.strictEqual(p1.rows[0].archived, false, 'boolean field hydrated from SQLite 0 -> false');
    assert.deepEqual(p1.rows[0].meta, { tags: ['health'] }, 'json field hydrated from SQLite string -> object');
    assert.ok(Object.isFrozen(p1.rows[0]));
    // Cursor retains raw SQLite sortValue (0) so next keyset page matches cleanly!
    assert.equal(p1.nextCursor.sortValue, 0);

    const p2 = executeQueryPage(db, StudyItem, alice, compiled, { cursor: p1.nextCursor });
    assert.equal(p2.rows.length, 2);
    assert.strictEqual(p2.rows[0].archived, false);
    assert.strictEqual(p2.rows[1].archived, true, 'boolean field hydrated from SQLite 1 -> true');

    const p3 = executeQueryPage(db, StudyItem, alice, compiled, { cursor: p2.nextCursor });
    assert.equal(p3.rows.length, 1);
    assert.strictEqual(p3.rows[0].archived, true);
    assert.equal(p3.nextCursor, null);
    assert.deepEqual(
      [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id),
      ['s1', 's2', 's4', 's3', 's5'],
    );

    // Explicit `hydrate: false` returns raw stored cells
    const rawPage = executeQueryPage(db, StudyItem, alice, compiled, { hydrate: false });
    assert.strictEqual(rawPage.rows[0].archived, 0);
    assert.strictEqual(typeof rawPage.rows[0].meta, 'string');
  } finally {
    db.close();
  }
});

test('keyset pagination, bounded offset pagination, and configurable maxPageSize', () => {
  const { db, StudyItem } = setupStudyItems();
  try {
    const compiled = compileQueryContract({
      entity: 'StudyItem',
      sort: { field: 'priority', direction: 'asc' },
      pageSize: 2,
    }, StudyItem);

    // Offset page 0
    const off0 = executeQueryPage(db, StudyItem, alice, compiled, {
      offset: 0,
      includeCount: true,
      includeTotal: true,
    });
    assert.deepEqual(off0.rows.map((r) => r.id), ['s1', 's2']);
    assert.equal(off0.offset, 0);
    assert.equal(off0.hasMore, true);
    assert.equal(off0.filteredTotal, 5);
    assert.equal(off0.total, 5);

    // Offset page 2 (page jump)
    const off2 = executeQueryPage(db, StudyItem, alice, compiled, { offset: 2 });
    assert.deepEqual(off2.rows.map((r) => r.id), ['s3', 's4']);
    assert.equal(off2.offset, 2);
    assert.equal(off2.hasMore, true);

    // Offset page 4 (last partial page)
    const off4 = executeQueryPage(db, StudyItem, alice, compiled, { offset: 4 });
    assert.deepEqual(off4.rows.map((r) => r.id), ['s5']);
    assert.equal(off4.offset, 4);
    assert.equal(off4.hasMore, false);
    assert.equal(off4.nextCursor, null);

    // Offset past end returns empty page cleanly
    const offEnd = executeQueryPage(db, StudyItem, alice, compiled, { offset: 20 });
    assert.deepEqual(offEnd.rows, []);
    assert.equal(offEnd.hasMore, false);
    assert.equal(offEnd.nextCursor, null);

    // Keyset pagination produces identical full traversal order
    const k1 = executeQueryPage(db, StudyItem, alice, compiled);
    const k2 = executeQueryPage(db, StudyItem, alice, compiled, { cursor: k1.nextCursor });
    const k3 = executeQueryPage(db, StudyItem, alice, compiled, { cursor: k2.nextCursor });
    assert.deepEqual(
      [...k1.rows, ...k2.rows, ...k3.rows].map((r) => r.id),
      [...off0.rows, ...off2.rows, ...off4.rows].map((r) => r.id),
    );

    // Combining cursor and offset fails closed
    assert.throws(
      () => executeQueryPage(db, StudyItem, alice, compiled, { cursor: k1.nextCursor, offset: 2 }),
      /cursor and offset cannot be combined/,
    );

    // Negative or out-of-bounds offset fails closed
    assert.throws(
      () => executeQueryPage(db, StudyItem, alice, compiled, { offset: -1 }),
      QueryScopedReadError,
    );
    assert.throws(
      () => executeQueryPage(db, StudyItem, alice, compiled, { offset: 50, maxOffset: 25 }),
      QueryScopedReadError,
    );
    assert.throws(
      () => executeQueryPage(db, StudyItem, alice, compiled, { offset: QUERY_OFFSET_MAX + 1 }),
      QueryScopedReadError,
    );

    // Default maxPageSize is 100
    assert.throws(
      () => compileQueryContract({
        entity: 'StudyItem',
        sort: { field: 'id', direction: 'asc' },
        pageSize: 150,
      }, StudyItem),
      /pageSize must be an integer from 1 through 100/,
    );

    // Author-configurable maxPageSize up to 500 works
    const largePage = compileQueryContract({
      entity: 'StudyItem',
      sort: { field: 'id', direction: 'asc' },
      pageSize: 250,
    }, StudyItem, { maxPageSize: 500 });
    assert.equal(largePage.pageSize, 250);
    assert.equal(largePage.maxPageSize, 500);
    const bigResult = executeQueryPage(db, StudyItem, alice, largePage);
    assert.equal(bigResult.rows.length, 5);

    // Exceeding ceiling (500) fails closed
    assert.throws(
      () => compileQueryContract({
        entity: 'StudyItem',
        sort: { field: 'id', direction: 'asc' },
        pageSize: 250,
      }, StudyItem, { maxPageSize: 501 }),
      /maxPageSize must be an integer from 1 through 500/,
    );
  } finally {
    db.close();
  }
});

test('query family multi-filter (AND/OR/NOT mixing host + dynamic) enforces element-level authz', () => {
  const { db, registry } = setupFamily();
  try {
    // Multiple flat dynamic filters + host filter:
    // host status != archived (via where) AND f-region contains 'north' AND f-verified = true
    const multi = registry.execute('studyArtefacts', db, alice, {
      filters: [{ field: 'projectId', op: 'eq', value: 'p1' }],
      dynamicFilters: [
        { fieldId: 'f-region', op: 'contains', value: 'north' },
        { fieldId: 'f-verified', op: 'eq', value: true },
      ],
      sort: { field: 'rank', direction: 'asc' },
      pageSize: 10,
      includeCount: true,
      includeTotal: true,
    });
    // a1 ('north coast', verified=true) and a3 ('north ridge', verified=true) match.
    // a4 has Bob's leaked element ('north leak') — MUST NOT match!
    assert.deepEqual(multi.rows.map((r) => r.id), ['a1', 'a3']);
    assert.strictEqual(multi.rows[0].featured, true, 'host rows are hydrated');
    assert.equal(multi.filteredTotal, 2);
    assert.equal(multi.count, 2);
    assert.equal(multi.total, 4, 'total is Alice authorized host count (a1..a4, not Bob a5)');

    // Composable boolean tree mixing host `term` and `dynamic` predicates with OR + NOT:
    // (host.status = 'active' AND dynamic f-stage = 'raw') OR (dynamic f-region contains 'north' AND NOT host.featured = true)
    const exprPage = registry.execute('studyArtefacts', db, alice, {
      where: {
        kind: 'or',
        children: [
          {
            kind: 'and',
            children: [
              { kind: 'term', field: 'status', op: 'eq', value: 'active' },
              { kind: 'dynamic', fieldId: 'f-stage', op: 'eq', value: 'raw' },
            ],
          },
          {
            kind: 'and',
            children: [
              { kind: 'dynamic', fieldId: 'f-region', op: 'contains', value: 'north' },
              {
                kind: 'not',
                child: { kind: 'term', field: 'featured', op: 'eq', value: true },
              },
            ],
          },
        ],
      },
      sort: { field: 'id', direction: 'asc' },
      pageSize: 10,
      includeCount: true,
      includeTotal: true,
    });
    // Branch 1 matches a2 (active + stage='raw').
    // Branch 2 matches a3 ('north ridge' + featured=false). a1 has featured=true (excluded).
    // a4 has Bob's foreign 'north leak' (excluded by element grant!).
    assert.deepEqual(exprPage.rows.map((r) => r.id), ['a2', 'a3']);
    assert.equal(exprPage.filteredTotal, 2);
    assert.equal(exprPage.total, 4);

    // Foreign element on owned host a4 must STILL appear empty to Alice under isEmpty
    const emptyRegion = registry.execute('studyArtefacts', db, alice, {
      where: { kind: 'dynamic', fieldId: 'f-region', op: 'isEmpty' },
      sort: { field: 'id', direction: 'asc' },
      pageSize: 10,
    });
    assert.deepEqual(emptyRegion.rows.map((r) => r.id), ['a4'], 'Bob-owned element on a4 is invisible so a4 is empty for Alice');

    // Dynamic isEmpty with a value fails closed
    assert.throws(
      () => registry.execute('studyArtefacts', db, alice, {
        dynamicFilters: [{ fieldId: 'f-region', op: 'isEmpty', value: 'x' }],
        sort: { field: 'id', direction: 'asc' },
        pageSize: 10,
      }),
      /isEmpty does not accept a value/,
    );

    // Catalog authz: Alice cannot filter by Bob's catalog field
    assert.throws(
      () => registry.execute('studyArtefacts', db, alice, {
        dynamicFilters: [{ fieldId: 'f-bob-only', op: 'eq', value: 42 }],
        sort: { field: 'id', direction: 'asc' },
        pageSize: 10,
      }),
      /unknown field/,
    );
  } finally {
    db.close();
  }
});

test('dynamic property sort orders with element authz, deterministic id ASC tie-break, keyset + offset paging', () => {
  const { db, registry } = setupFamily({ maxPageSize: 250 });
  try {
    // Alice's authorized f-score values:
    //   a4: NULL (Bob's e-leak-score=5 is unauthorized -> invisible!)
    //   a2: 10
    //   a1: 20 (deduplicated from e4=20 and e6b=999 by e.id ASC -> 20, no duplicate host row!)
    //   a3: 20 (ties with a1 -> id ASC puts a1 before a3)
    // ASC order: a4 (NULL), a2 (10), a1 (20), a3 (20)
    const ascAll = registry.execute('studyArtefacts', db, alice, {
      sort: { dynamicFieldId: 'f-score', direction: 'asc' },
      pageSize: 10,
      includeCount: true,
      includeTotal: true,
    });
    assert.deepEqual(ascAll.rows.map((r) => r.id), ['a4', 'a2', 'a1', 'a3']);
    assert.equal(ascAll.filteredTotal, 4);
    assert.equal(ascAll.total, 4);
    assert.ok(!('__wb_sort_value' in ascAll.rows[0]), 'internal sort column must not leak onto returned rows');

    // DESC order via `sortByDynamicField`: a1 (20), a3 (20), a2 (10), a4 (NULL)
    const descAll = registry.execute('studyArtefacts', db, alice, {
      sortByDynamicField: { dynamicFieldId: 'f-score', direction: 'desc' },
      pageSize: 10,
      includeCount: true,
      includeTotal: true,
    });
    assert.deepEqual(descAll.rows.map((r) => r.id), ['a1', 'a3', 'a2', 'a4']);
    assert.equal(descAll.filteredTotal, 4);
    assert.equal(descAll.total, 4);

    // Keyset pagination over DESC dynamic sort across tied values (20, 20) and NULL:
    const dp1 = registry.execute('studyArtefacts', db, alice, {
      sort: { dynamicFieldId: 'f-score', direction: 'desc' },
      pageSize: 1,
    });
    assert.deepEqual(dp1.rows.map((r) => r.id), ['a1']);
    assert.equal(dp1.nextCursor.sortValue, 20);
    assert.equal(dp1.nextCursor.id, 'a1');

    const dp2 = registry.execute('studyArtefacts', db, alice, {
      sort: { dynamicFieldId: 'f-score', direction: 'desc' },
      pageSize: 1,
      cursor: dp1.nextCursor,
    });
    assert.deepEqual(dp2.rows.map((r) => r.id), ['a3']);

    const dp3 = registry.execute('studyArtefacts', db, alice, {
      sort: { dynamicFieldId: 'f-score', direction: 'desc' },
      pageSize: 1,
      cursor: dp2.nextCursor,
    });
    assert.deepEqual(dp3.rows.map((r) => r.id), ['a2']);

    const dp4 = registry.execute('studyArtefacts', db, alice, {
      sort: { dynamicFieldId: 'f-score', direction: 'desc' },
      pageSize: 1,
      cursor: dp3.nextCursor,
    });
    assert.deepEqual(dp4.rows.map((r) => r.id), ['a4']);
    assert.equal(dp4.nextCursor, null);

    // Offset pagination over dynamic sort + dynamic filter + host filter:
    const filteredSortedOffset = registry.execute('studyArtefacts', db, alice, {
      filters: [{ field: 'status', op: 'in', value: ['active', 'draft'] }],
      dynamicFilters: [{ fieldId: 'f-score', op: 'gte', value: 10 }],
      sortByDynamicField: { fieldId: 'f-score', direction: 'asc' },
      pageSize: 2,
      offset: 1,
      includeCount: true,
      includeTotal: true,
    });
    // Matching set sorted asc by f-score: [a2(10), a1(20), a3(20)]; offset 1 -> [a1, a3]
    assert.deepEqual(filteredSortedOffset.rows.map((r) => r.id), ['a1', 'a3']);
    assert.equal(filteredSortedOffset.offset, 1);
    assert.equal(filteredSortedOffset.hasMore, false);
    assert.equal(filteredSortedOffset.filteredTotal, 3);
    assert.equal(filteredSortedOffset.total, 4);

    // Catalog authz on dynamic sort: Alice cannot sort by Bob's catalog field
    assert.throws(
      () => registry.execute('studyArtefacts', db, alice, {
        sort: { dynamicFieldId: 'f-bob-only', direction: 'asc' },
        pageSize: 10,
      }),
      /unknown field/,
    );

    // Family maxPageSize allows 200 (configured to 250)
    const wide = registry.execute('studyArtefacts', db, alice, {
      sort: { field: 'id', direction: 'asc' },
      pageSize: 200,
    });
    assert.equal(wide.rows.length, 4);
  } finally {
    db.close();
  }
});

test('concurrent writes during query execution do not cause QueryContentionError and see one atomic WAL snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-unified-query-wal-'));
  const file = join(dir, 'wal.sqlite');
  let writerDb;
  let readerDb;
  try {
    writerDb = new DatabaseSync(file);
    writerDb.exec('PRAGMA journal_mode = WAL');
    const StudyItem = makeRecordEntity();
    seedStudyItems(writerDb, StudyItem);

    readerDb = new DatabaseSync(file);
    readerDb.exec('PRAGMA busy_timeout = 5000');

    const compiled = compileQueryContract({
      entity: 'StudyItem',
      where: { kind: 'term', field: 'status', op: 'eq', value: 'open' },
      sort: { field: 'id', direction: 'asc' },
      pageSize: 10,
    }, StudyItem);

    // Intercept readerDb.prepare so a concurrent writer commits a new matching row
    // AND bumps _CommittedRevision right between the page SELECT and COUNT(*) queries!
    const origPrepare = readerDb.prepare.bind(readerDb);
    let concurrentWrites = 0;
    readerDb.prepare = (sql) => {
      const stmt = origPrepare(sql);
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
        concurrentWrites += 1;
        writerDb.exec('BEGIN IMMEDIATE');
        writerDb
          .prepare('INSERT INTO StudyItem (id, title, status, priority, archived, createdAt, meta, projectId, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(`s_conc_${concurrentWrites}`, 'Concurrent', 'open', 9, 0, Date.now(), null, 'p1', 'alice');
        writerDb.prepare("UPDATE _CommittedRevision SET revision = revision + 1 WHERE name = 'actions'").run();
        writerDb.exec('COMMIT');
      }
      return stmt;
    };

    const initialRev = readCommittedRevision(writerDb);

    // Must NOT throw QueryContentionError, and MUST see one consistent pre-write snapshot!
    const snap = executeQueryPage(readerDb, StudyItem, alice, compiled, {
      includeCount: true,
      includeTotal: true,
    });
    assert.equal(concurrentWrites, 2, 'concurrent writer committed during BOTH filteredTotal and total counts');
    assert.equal(snap.revision, initialRev, 'revision belongs to the pinned snapshot');
    assert.deepEqual(snap.rows.map((r) => r.id), ['s1', 's5'], 'rows belong to the pinned snapshot');
    assert.equal(snap.filteredTotal, 2, 'filteredTotal matches the pinned snapshot (not post-write 3/4)');
    assert.equal(snap.total, 5, 'total matches the pinned snapshot (not post-write 7)');

    // Restore prepare and verify the subsequent read sees the committed concurrent writes cleanly
    readerDb.prepare = origPrepare;
    const after = executeQueryPage(readerDb, StudyItem, alice, compiled, {
      includeCount: true,
      includeTotal: true,
    });
    assert.equal(after.revision, initialRev + 2);
    assert.equal(after.filteredTotal, 4);
    assert.equal(after.total, 7);

    // Also verify executing inside an already-open caller transaction succeeds without error
    readerDb.exec('BEGIN');
    try {
      const nested = executeQueryPage(readerDb, StudyItem, alice, compiled, {
        includeCount: true,
        includeTotal: true,
      });
      assert.equal(nested.filteredTotal, 4);
      assert.equal(nested.total, 7);
    } finally {
      readerDb.exec('COMMIT');
    }
  } finally {
    readerDb?.close();
    writerDb?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent writes during executeQueryFamily do not cause QueryContentionError and see one atomic WAL snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-unified-family-wal-'));
  const file = join(dir, 'wal.sqlite');
  let writerDb;
  let readerDb;
  try {
    writerDb = new DatabaseSync(file);
    writerDb.exec('PRAGMA journal_mode = WAL');
    const { family } = setupFamily({ db: writerDb });

    readerDb = new DatabaseSync(file);
    readerDb.exec('PRAGMA busy_timeout = 5000');

    const origPrepare = readerDb.prepare.bind(readerDb);
    let wrote = false;
    readerDb.prepare = (sql) => {
      const stmt = origPrepare(sql);
      if (typeof sql === 'string' && sql.includes('COUNT(*)') && !wrote) {
        wrote = true;
        writerDb.exec('BEGIN IMMEDIATE');
        writerDb
          .prepare('INSERT INTO Artefact (id, title, status, rank, featured, projectId, owner) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run('a_new', 'New Host', 'active', 5, 1, 'p1', 'alice');
        writerDb
          .prepare('INSERT INTO ValueElement (id, hostId, fieldId, textValue, numberValue, epochValue, booleanValue, optionValue, projectId, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run('e_new', 'a_new', 'f-score', null, 100, null, null, null, 'p1', 'alice');
        writerDb.prepare("UPDATE _CommittedRevision SET revision = revision + 1 WHERE name = 'actions'").run();
        writerDb.exec('COMMIT');
      }
      return stmt;
    };

    const initialRev = readCommittedRevision(writerDb);
    const page = executeQueryFamily(readerDb, family, alice, {
      dynamicFilters: [{ fieldId: 'f-score', op: 'gte', value: 10 }],
      sort: { dynamicFieldId: 'f-score', direction: 'desc' },
      pageSize: 10,
      includeCount: true,
      includeTotal: true,
    });
    assert.ok(wrote);
    assert.equal(page.revision, initialRev);
    assert.deepEqual(page.rows.map((r) => r.id), ['a1', 'a3', 'a2']);
    assert.equal(page.filteredTotal, 3);
    assert.equal(page.total, 4);

    readerDb.prepare = origPrepare;
    const after = executeQueryFamily(readerDb, family, alice, {
      dynamicFilters: [{ fieldId: 'f-score', op: 'gte', value: 10 }],
      sort: { dynamicFieldId: 'f-score', direction: 'desc' },
      pageSize: 10,
      includeCount: true,
      includeTotal: true,
    });
    assert.equal(after.revision, initialRev + 1);
    assert.deepEqual(after.rows.map((r) => r.id), ['a_new', 'a1', 'a3', 'a2']);
    assert.equal(after.filteredTotal, 4);
    assert.equal(after.total, 5);
  } finally {
    readerDb?.close();
    writerDb?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
