// Query-scoped reads (#225, ADR-0009): authorized pages with a revision token,
// keyset pagination, invalidation + bounded refetch, and stale-response rejection.

import { text, ref, number, grant, read, subscribe, scope } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { entity, generateDDL, generateFrameworkDDL } from '../build/internal.mjs';
import { principal } from '../build/principal.mjs';
import {
  compileQueryContract,
  executeQueryPage,
  acceptQueryPage,
  overlayOptimisticQueryPage,
  readCommittedRevision,
  createQueryInvalidationHub,
  createQueryInvalidationConsumer,
  QueryScopedReadError,
} from '../build/query-scoped-read.mjs';
import { created, updated, fieldSet } from '../build/event-handle.mjs';

const alice = principal({ type: 'user', id: 'alice' });
const bob = principal({ type: 'user', id: 'bob' });

function makeNote() {
  return entity('Note', {
    body: text(),
    status: text(),
    rank: number(),
    projectId: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(() => grant(read, subscribe)),
    ],
  });
}

function seed(db, Note) {
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  for (const sql of generateDDL(Note)) db.exec(sql);
  const insert = db.prepare('INSERT INTO Note (id, body, status, rank, projectId, owner) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('n1', 'alpha', 'open', 1, 'p1', 'alice');
  insert.run('n2', 'beta', 'open', 2, 'p1', 'alice');
  insert.run('n3', 'gamma', 'open', 2, 'p1', 'alice'); // same rank as n2 — id tie-break
  insert.run('n4', 'delta', 'closed', 3, 'p1', 'alice');
  insert.run('n5', 'echo', 'open', 1, 'p2', 'bob');
  insert.run('n6', 'foxtrot', 'open', 4, 'p1', 'alice');
}

function setup() {
  const db = new DatabaseSync(':memory:');
  const Note = makeNote();
  seed(db, Note);
  return { db, Note };
}

function openPage(Note, pageSize = 2) {
  return compileQueryContract({
    entity: 'Note',
    filters: [{ field: 'status', op: 'eq', value: 'open' }, { field: 'projectId', op: 'eq', value: 'p1' }],
    sort: { field: 'rank', direction: 'asc' },
    pageSize,
  }, Note);
}

test('authorization fails closed for the wrong principal', () => {
  const { db, Note } = setup();
  try {
    const compiled = openPage(Note, 10);
    const alicePage = executeQueryPage(db, Note, alice, compiled, { includeCount: true });
    assert.deepEqual(alicePage.rows.map((row) => row.id), ['n1', 'n2', 'n3', 'n6']);
    const bobPage = executeQueryPage(db, Note, bob, compiled, { includeCount: true });
    assert.deepEqual(bobPage.rows, []);
    assert.equal(bobPage.count, 0);
  } finally {
    db.close();
  }
});

test('authorization fails closed for the wrong project even when the cursor is reused', () => {
  const { db, Note } = setup();
  try {
    const compiled = openPage(Note, 10);
    const alicePage = executeQueryPage(db, Note, alice, compiled);
    const bobWithAliceCursor = executeQueryPage(db, Note, bob, compiled, { cursor: alicePage.nextCursor });
    assert.deepEqual(bobWithAliceCursor.rows, [], 'a page token is not authorization');
    const bobOwn = compileQueryContract({
      entity: 'Note',
      filters: [{ field: 'projectId', op: 'eq', value: 'p1' }],
      sort: { field: 'rank', direction: 'asc' },
      pageSize: 10,
    }, Note);
    const bobP1 = executeQueryPage(db, Note, bob, bobOwn);
    assert.deepEqual(bobP1.rows, [], 'row-scope grant excludes another principal\'s project rows');
  } finally {
    db.close();
  }
});

test('page boundaries hold with the unique id tie-break', () => {
  const { db, Note } = setup();
  try {
    const compiled = openPage(Note, 2);
    const first = executeQueryPage(db, Note, alice, compiled);
    assert.deepEqual(first.rows.map((row) => row.id), ['n1', 'n2']);
    assert.equal(first.nextCursor.id, 'n2');
    assert.equal(first.nextCursor.sortValue, 2);
    const second = executeQueryPage(db, Note, alice, compiled, { cursor: first.nextCursor });
    // n3 shares rank 2 with n2; id ASC places n3 after n2, then n6 (rank 4).
    assert.deepEqual(second.rows.map((row) => row.id), ['n3', 'n6']);
    assert.equal(second.nextCursor, null);
    const foreign = compileQueryContract({
      entity: 'Note',
      filters: [{ field: 'status', op: 'eq', value: 'closed' }],
      sort: { field: 'rank', direction: 'asc' },
      pageSize: 2,
    }, Note);
    assert.throws(
      () => executeQueryPage(db, Note, alice, foreign, { cursor: first.nextCursor }),
      QueryScopedReadError,
    );
  } finally {
    db.close();
  }
});

test('a membership-changing edit invalidates and refetches correctly', () => {
  const { db, Note } = setup();
  try {
    const compiled = openPage(Note, 10);
    const before = executeQueryPage(db, Note, alice, compiled, { includeCount: true });
    assert.equal(before.count, 4);
    assert.ok(before.rows.some((row) => row.id === 'n2'));

    const hub = createQueryInvalidationHub();
    hub.register({
      id: 'alice-open-p1',
      dependency: { entity: 'Note', fields: [...compiled.dependencyFields] },
      principal: alice,
    });
    const consumer = createQueryInvalidationConsumer(hub, db);

    db.prepare("UPDATE Note SET status = 'closed' WHERE id = 'n2'").run();
    db.prepare("UPDATE _CommittedRevision SET revision = revision + 1 WHERE name = 'actions'").run();
    const revision = readCommittedRevision(db);
    consumer([{ type: updated('Note').type, handle: updated('Note'), data: { id: 'n2', status: 'closed' }, committedAt: '2026-09-13T00:00:00.000Z' }]);

    const signal = hub.changedSince({
      id: 'alice-open-p1',
      principal: alice,
      sinceRevision: before.revision,
      revision,
    });
    assert.equal(signal.kind, 'changed');

    const after = executeQueryPage(db, Note, alice, compiled, { includeCount: true });
    assert.equal(after.count, 3);
    assert.deepEqual(after.rows.map((row) => row.id), ['n1', 'n3', 'n6']);
    assert.ok(after.revision > before.revision);
  } finally {
    db.close();
  }
});

test('a stale response is rejected', () => {
  const { db, Note } = setup();
  try {
    const compiled = openPage(Note, 10);
    const fresh = executeQueryPage(db, Note, alice, compiled);
    assert.equal(acceptQueryPage(fresh.revision, fresh.revision), 'accept');
    assert.equal(acceptQueryPage(fresh.revision, fresh.revision + 1), 'accept');
    assert.equal(acceptQueryPage(fresh.revision + 1, fresh.revision), 'reject-stale');
  } finally {
    db.close();
  }
});

test('count is the authorized matching set, not the page size', () => {
  const { db, Note } = setup();
  try {
    const compiled = openPage(Note, 2);
    const page = executeQueryPage(db, Note, alice, compiled, { includeCount: true });
    assert.equal(page.rows.length, 2);
    assert.equal(page.count, 4);
    const ranged = compileQueryContract({
      entity: 'Note',
      filters: [
        { field: 'projectId', op: 'eq', value: 'p1' },
        { field: 'rank', op: 'gte', value: 2 },
        { field: 'rank', op: 'lte', value: 3 },
        { field: 'status', op: 'in', value: ['open', 'closed'] },
      ],
      sort: { field: 'rank', direction: 'asc' },
      pageSize: 10,
    }, Note);
    const rangePage = executeQueryPage(db, Note, alice, ranged, { includeCount: true });
    assert.deepEqual(rangePage.rows.map((row) => row.id), ['n2', 'n3', 'n4']);
    assert.equal(rangePage.count, 3);
  } finally {
    db.close();
  }
});

test('unknown operators and fields fail closed at compile', () => {
  const Note = makeNote();
  assert.throws(
    () => compileQueryContract({
      entity: 'Note',
      filters: [{ field: 'status', op: 'sql', value: '1=1' }],
      sort: { field: 'rank', direction: 'asc' },
      pageSize: 10,
    }, Note),
    QueryScopedReadError,
  );
  assert.throws(
    () => compileQueryContract({
      entity: 'Note',
      filters: [{ field: 'missing', op: 'eq', value: 'x' }],
      sort: { field: 'rank', direction: 'asc' },
      pageSize: 10,
    }, Note),
    QueryScopedReadError,
  );
});

test('delivery re-authorizes: a foreign principal cannot read another registration', () => {
  const hub = createQueryInvalidationHub();
  hub.register({
    id: 'alice-open-p1',
    dependency: { entity: 'Note', fields: ['status'] },
    principal: alice,
  });
  const denied = hub.changedSince({
    id: 'alice-open-p1',
    principal: bob,
    sinceRevision: 0,
    revision: 1,
  });
  assert.equal(denied.kind, 'denied');
  const resync = hub.changedSince({
    id: 'unknown',
    principal: alice,
    sinceRevision: 0,
    revision: 1,
  });
  assert.equal(resync.kind, 'resync');
});

test('a field-set on a dependency invalidates; an unrelated field does not', () => {
  const hub = createQueryInvalidationHub();
  hub.register({
    id: 'q',
    dependency: { entity: 'Note', fields: ['status'] },
    principal: alice,
  });
  hub.notice([{ type: fieldSet('Note', 'body').type, handle: fieldSet('Note', 'body'), data: { id: 'n1' }, committedAt: 't' }], 4);
  assert.equal(hub.changedSince({ id: 'q', principal: alice, sinceRevision: 3, revision: 4 }).kind, 'unchanged');
  hub.notice([{ type: fieldSet('Note', 'status').type, handle: fieldSet('Note', 'status'), data: { id: 'n1' }, committedAt: 't' }], 5);
  assert.equal(hub.changedSince({ id: 'q', principal: alice, sinceRevision: 3, revision: 5 }).kind, 'changed');
  hub.notice([{ type: created('Note').type, handle: created('Note'), data: { id: 'n9' }, committedAt: 't' }], 6);
  assert.equal(hub.changedSince({ id: 'q', principal: alice, sinceRevision: 5, revision: 6 }).kind, 'changed');
});

test('optimistic overlay previews safe fields and flags membership-uncertain writes', () => {
  const { db, Note } = setup();
  try {
    const compiled = openPage(Note, 10);
    const page = executeQueryPage(db, Note, alice, compiled);
    const safe = overlayOptimisticQueryPage(page, [{ id: 'n1', verb: 'update', fields: { body: 'preview' } }], compiled);
    assert.equal(safe.membershipUncertain, false);
    assert.equal(safe.rows.find((row) => row.id === 'n1').body, 'preview');
    const membership = overlayOptimisticQueryPage(page, [{ id: 'n1', verb: 'update', fields: { status: 'closed' } }], compiled);
    assert.equal(membership.membershipUncertain, true);
    assert.equal(membership.rows.find((row) => row.id === 'n1').status, 'open', 'membership writes are not guessed into the page');
  } finally {
    db.close();
  }
});
