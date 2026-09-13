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
  insert.run('n3', 'gamma', 'open', 2, 'p1', 'alice');
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

function p1Dep(fields) {
  return { entity: 'Note', fields, scope: 'Project:p1' };
}

function registerFor(hub, { db, Note, principal, id, fields, revision }) {
  hub.register({
    id,
    dependency: p1Dep(fields),
    principal,
    entity: Note,
    db,
    revision: revision ?? readCommittedRevision(db),
  });
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

test('DESC sort pages with the id ASC tie-break', () => {
  const { db, Note } = setup();
  try {
    const compiled = compileQueryContract({
      entity: 'Note',
      filters: [{ field: 'status', op: 'eq', value: 'open' }, { field: 'projectId', op: 'eq', value: 'p1' }],
      sort: { field: 'rank', direction: 'desc' },
      pageSize: 2,
    }, Note);
    const first = executeQueryPage(db, Note, alice, compiled);
    assert.deepEqual(first.rows.map((row) => row.id), ['n6', 'n2']);
    const second = executeQueryPage(db, Note, alice, compiled, { cursor: first.nextCursor });
    assert.deepEqual(second.rows.map((row) => row.id), ['n3', 'n1']);
    assert.equal(second.nextCursor, null);
  } finally {
    db.close();
  }
});

test('NULL sort keys paginate without stalling the keyset', () => {
  const { db, Note } = setup();
  try {
    db.prepare("INSERT INTO Note (id, body, status, rank, projectId, owner) VALUES ('n0', 'null-rank', 'open', NULL, 'p1', 'alice')").run();
    const compiled = compileQueryContract({
      entity: 'Note',
      filters: [{ field: 'projectId', op: 'eq', value: 'p1' }],
      sort: { field: 'rank', direction: 'asc' },
      pageSize: 1,
    }, Note);
    const first = executeQueryPage(db, Note, alice, compiled);
    assert.equal(first.rows[0].id, 'n0');
    assert.equal(first.rows[0].rank, null);
    const second = executeQueryPage(db, Note, alice, compiled, { cursor: first.nextCursor });
    assert.equal(second.rows[0].id, 'n1');
    assert.notEqual(second.rows[0].rank, null);
  } finally {
    db.close();
  }
});

test('a membership-changing edit invalidates and refetches correctly', async () => {
  const { db, Note } = setup();
  try {
    const compiled = openPage(Note, 10);
    const before = executeQueryPage(db, Note, alice, compiled, { includeCount: true });
    assert.equal(before.count, 4);
    assert.ok(before.rows.some((row) => row.id === 'n2'));

    const hub = createQueryInvalidationHub();
    registerFor(hub, { db, Note, principal: alice, id: 'alice-open-p1', fields: [...compiled.dependencyFields] });
    const consumer = createQueryInvalidationConsumer(hub, db);

    db.prepare("UPDATE Note SET status = 'closed' WHERE id = 'n2'").run();
    db.prepare("UPDATE _CommittedRevision SET revision = revision + 1 WHERE name = 'actions'").run();
    const revision = readCommittedRevision(db);
    await consumer([{
      type: updated('Note').type,
      handle: updated('Note'),
      scope: 'Note:n2',
      data: { id: 'n2', status: 'closed', projectId: 'p1' },
      committedAt: '2026-09-13T00:00:00.000Z',
    }]);

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

test('a grant-field transition invalidates membership', () => {
  const { db, Note } = setup();
  try {
    const compiled = openPage(Note, 10);
    const hub = createQueryInvalidationHub();
    registerFor(hub, { db, Note, principal: alice, id: 'q', fields: [...compiled.dependencyFields] });
    const at = readCommittedRevision(db);
    hub.notice([{
      type: fieldSet('Note', 'owner').type,
      handle: fieldSet('Note', 'owner'),
      scope: 'Note:n1',
      data: { id: 'n1', owner: 'bob', projectId: 'p1' },
      committedAt: 't',
    }], at + 1);
    assert.equal(hub.changedSince({ id: 'q', principal: alice, sinceRevision: at, revision: at + 1 }).kind, 'changed');
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

test('count retries when a concurrent write moves the revision fence', () => {
  const { db, Note } = setup();
  try {
    const compiled = openPage(Note, 2);
    let bumped = false;
    const inner = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = inner(sql);
      if (typeof sql === 'string' && sql.includes('COUNT(*)') && !bumped) {
        bumped = true;
        inner("UPDATE _CommittedRevision SET revision = revision + 1 WHERE name = 'actions'").run();
      }
      return statement;
    };
    const page = executeQueryPage(db, Note, alice, compiled, { includeCount: true });
    assert.equal(page.count, 4);
    assert.equal(typeof page.revision, 'number');
    assert.ok(bumped);
  } finally {
    db.close();
  }
});

test('unknown operators, fields, and null filter values fail closed at compile', () => {
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
  assert.throws(
    () => compileQueryContract({
      entity: 'Note',
      filters: [{ field: 'status', op: 'eq', value: null }],
      sort: { field: 'rank', direction: 'asc' },
      pageSize: 10,
    }, Note),
    /must not be null/,
  );
  assert.throws(
    () => compileQueryContract({
      entity: 'Note',
      filters: [{ field: 'status', op: 'in', value: ['open', null] }],
      sort: { field: 'rank', direction: 'asc' },
      pageSize: 10,
    }, Note),
    /must not be null/,
  );
});

test('an invalid explicit scopeField is refused', () => {
  const { db, Note } = setup();
  try {
    const hub = createQueryInvalidationHub();
    const revision = readCommittedRevision(db);
    assert.throws(
      () => hub.register({
        id: 'bad-field',
        dependency: { entity: 'Note', fields: ['status'], scope: 'Project:p1', scopeField: 'notAField' },
        principal: alice,
        entity: Note,
        db,
        revision,
      }),
      /scopeField 'notAField' is not a declared field/,
    );
    assert.throws(
      () => hub.register({
        id: 'empty-field',
        dependency: { entity: 'Note', fields: ['status'], scope: 'Project:p1', scopeField: '' },
        principal: alice,
        entity: Note,
        db,
        revision,
      }),
      /scopeField must be a declared field name/,
    );
    assert.equal(hub.size, 0, 'a rejected scopeField must not register');
  } finally {
    db.close();
  }
});

test('wrong-project registration is refused; own-project registration succeeds', () => {
  const { db, Note } = setup();
  try {
    const hub = createQueryInvalidationHub();
    registerFor(hub, { db, Note, principal: alice, id: 'alice-p1', fields: ['status'] });
    assert.equal(hub.size, 1);
    assert.throws(
      () => registerFor(hub, { db, Note, principal: bob, id: 'bob-p1', fields: ['status'] }),
      /cannot see this query scope/,
    );
  } finally {
    db.close();
  }
});

test('delivery after revocation is denied; foreign and unknown ids are not an existence oracle', () => {
  const { db, Note } = setup();
  try {
    const hub = createQueryInvalidationHub();
    registerFor(hub, { db, Note, principal: alice, id: 'alice-open-p1', fields: ['status'] });
    const revision = readCommittedRevision(db);
    const foreign = hub.changedSince({ id: 'alice-open-p1', principal: bob, sinceRevision: revision, revision });
    const unknown = hub.changedSince({ id: 'no-such', principal: bob, sinceRevision: revision, revision });
    assert.equal(foreign.kind, 'resync');
    assert.equal(unknown.kind, 'resync');

    Note.scopeFilter = () => ({ sql: '1 = 0', params: {} });
    const revoked = hub.changedSince({ id: 'alice-open-p1', principal: alice, sinceRevision: revision, revision });
    assert.equal(revoked.kind, 'denied');
  } finally {
    db.close();
  }
});

test('a field-set on a dependency invalidates; an unrelated field or other project does not', () => {
  const { db, Note } = setup();
  try {
    const hub = createQueryInvalidationHub();
    const compiled = openPage(Note, 10);
    registerFor(hub, { db, Note, principal: alice, id: 'q', fields: [...compiled.dependencyFields] });
    const at = readCommittedRevision(db);
    hub.notice([{
      type: fieldSet('Note', 'body').type,
      handle: fieldSet('Note', 'body'),
      scope: 'Note:n1',
      data: { id: 'n1', projectId: 'p1' },
      committedAt: 't',
    }], at + 1);
    assert.equal(hub.changedSince({ id: 'q', principal: alice, sinceRevision: at, revision: at + 1 }).kind, 'unchanged');
    hub.notice([{
      type: fieldSet('Note', 'status').type,
      handle: fieldSet('Note', 'status'),
      scope: 'Note:n5',
      data: { id: 'n5', projectId: 'p2' },
      committedAt: 't',
    }], at + 2);
    assert.equal(hub.changedSince({ id: 'q', principal: alice, sinceRevision: at, revision: at + 2 }).kind, 'unchanged', 'other-project events do not signal');
    hub.notice([{
      type: fieldSet('Note', 'status').type,
      handle: fieldSet('Note', 'status'),
      scope: 'Note:n1',
      data: { id: 'n1', projectId: 'p1' },
      committedAt: 't',
    }], at + 3);
    assert.equal(hub.changedSince({ id: 'q', principal: alice, sinceRevision: at, revision: at + 3 }).kind, 'changed');
    hub.notice([{
      type: created('Note').type,
      handle: created('Note'),
      scope: 'Note:n9',
      data: { id: 'n9', projectId: 'p1' },
      committedAt: 't',
    }], at + 4);
    assert.equal(hub.changedSince({ id: 'q', principal: alice, sinceRevision: at + 3, revision: at + 4 }).kind, 'changed');
  } finally {
    db.close();
  }
});

test('a fetch that predates registration resyncs; stale notices do not rewind', () => {
  const { db, Note } = setup();
  try {
    const hub = createQueryInvalidationHub();
    const at = readCommittedRevision(db);
    registerFor(hub, { db, Note, principal: alice, id: 'q', fields: ['status'], revision: at + 2 });
    assert.equal(hub.changedSince({ id: 'q', principal: alice, sinceRevision: at, revision: at + 2 }).kind, 'resync');
    hub.notice([{
      type: fieldSet('Note', 'status').type,
      handle: fieldSet('Note', 'status'),
      scope: 'Note:n1',
      data: { id: 'n1', projectId: 'p1' },
      committedAt: 't',
    }], at + 5);
    hub.notice([{
      type: fieldSet('Note', 'status').type,
      handle: fieldSet('Note', 'status'),
      scope: 'Note:n1',
      data: { id: 'n1', projectId: 'p1' },
      committedAt: 't',
    }], at + 4);
    assert.equal(hub.changedSince({ id: 'q', principal: alice, sinceRevision: at + 2, revision: at + 5 }).kind, 'changed');
    assert.equal(hub.changedSince({ id: 'q', principal: alice, sinceRevision: at + 5, revision: at + 5 }).kind, 'unchanged');
  } finally {
    db.close();
  }
});

test('an unsafe committed revision fails closed', () => {
  const { db } = setup();
  try {
    db.prepare("UPDATE _CommittedRevision SET revision = 9007199254740992 WHERE name = 'actions'").run();
    assert.throws(() => readCommittedRevision(db), QueryScopedReadError);
  } finally {
    db.close();
  }
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
