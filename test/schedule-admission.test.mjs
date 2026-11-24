import { schedule, date, scope, everyone, grant, read, write, subscribe } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import workbench, { entity, executeFrameworkDDL } from '../build/internal.mjs';
import { generateDDL } from '../build/ddl.mjs';
import {
  admitSystemMutation,
  clearRemovedScheduleReceipts,
  machinePrincipal,
  pruneInactiveScheduleReceipts,
  rearmChangedScheduleReceipts,
  schedulerSource,
} from '../build/schedule.mjs';

// P6d Spine A step 4b — scheduler admission (Option A, in-txn re-check).
// A reaper-fired dispatch runs under a SCHEDULER SYSTEM PRINCIPAL. The scheduler
// principal is NOT a user with a row grant — its authority is the entity's
// DECLARED schedule. admitSystemMutation re-checks due/while/payload IN-TXN
// against the current row (TOCTOU: the row may have changed between discovery
// and dispatch) and admits ONLY the payload derived from the declared `with`.
// A scheduler principal may NEVER send an arbitrary payload (else "due" =
// "system write-anything"). Fail-closed on every mismatch. This is a SIBLING to
// the durable variant's afterProjection create row-grant — NOT a widened
// admitsEffects, NOT a second auth path (same dispatch spine, branch on principal kind).

function setupEntity(now) {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const publishedAt = date();
  const Blog = entity('BlogAdmit', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt, status: { kind: 'value', type: 'text' },

    schedule: {
      // Due when publishedAt <= now; the dispatched payload is FIXED by `with`.
      update: schedule.at(publishedAt, {
        while: ({ fields }) => fields.status.is('draft'),
        with: { published: true },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  return { db, Blog, publishedAt };
}

test('admitSystemMutation admits a matching scheduler dispatch (in-txn due + while + payload)', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('row1', now - 1000, 'draft');

  const principal = machinePrincipal({ id: 'BlogAdmit.update.publishedAt', operations: ['update'] });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1',
    payload: { published: true }, principal, db, now,
  });
  assert.equal(granted, true, 'a due + while-holding row with the exact declared payload is admitted');
});

test('admitSystemMutation DENIES a future-due row (not due at dispatch time)', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('row1', now + 100_000, 'draft');

  const principal = machinePrincipal({ id: 'BlogAdmit.update.publishedAt', operations: ['update'] });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1',
    payload: { published: true }, principal, db, now,
  });
  assert.equal(granted, false, 'TOCTOU: row was due at discovery but future at dispatch → deny');
});

test('admitSystemMutation DENIES when while no longer holds (in-txn re-check)', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  // due AND status is 'archived' (NOT 'draft') — while fails.
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('row1', now - 1000, 'archived');

  const principal = machinePrincipal({ id: 'BlogAdmit.update.publishedAt', operations: ['update'] });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1',
    payload: { published: true }, principal, db, now,
  });
  assert.equal(granted, false, 'while predicate failed at dispatch time → deny (no second auth path; the declared will governs)');
});

test('admitSystemMutation DENIES an arbitrary payload (security: scheduler cannot write-anything)', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('row1', now - 1000, 'draft');

  const principal = machinePrincipal({ id: 'BlogAdmit.update.publishedAt', operations: ['update'] });
  // A payload the schedule did NOT declare (owner hijack attempt):
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1',
    payload: { owner: 'attacker' }, principal, db, now,
  });
  assert.equal(granted, false, 'dispatched payload must equal the declared `with` payload exactly');
});

test('admitSystemMutation DENIES a principal whose source is not this entity/verb/field', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('row1', now - 1000, 'draft');

  // A scheduler principal for a DIFFERENT source must not admit this dispatch.
  const principal = machinePrincipal({ id: 'OtherEntity.update.publishedAt', operations: ['update'] });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1',
    payload: { published: true }, principal, db, now,
  });
  assert.equal(granted, false, 'principal source must bind to the declared schedule (BlogAdmit.update.publishedAt)');
});

test('admitSystemMutation DENIES a verb the entity did not declare a schedule for', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('row1', now - 1000, 'draft');

  const principal = machinePrincipal({ id: 'BlogAdmit.remove.publishedAt', operations: ['remove'] });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'remove', rowId: 'row1',
    payload: {}, principal, db, now,
  });
  assert.equal(granted, false, 'no schedule declared for remove → deny (fail closed)');
});

test('admitSystemMutation DENIES a non-system principal (fail closed)', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('row1', now - 1000, 'draft');

  const principal = { type: 'user', id: 'someone', attributes: {} };
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1',
    payload: { published: true }, principal, db, now,
  });
  assert.equal(granted, false, 'only a bound scheduler system principal goes through admitSystemMutation');
});

test('admitSystemMutation DENIES a missing row (TOCTOU: row deleted between discovery + dispatch)', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  // No row inserted — pretend it was deleted after discovery.
  const principal = machinePrincipal({ id: 'BlogAdmit.update.publishedAt', operations: ['update'] });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'gone',
    payload: { published: true }, principal, db, now,
  });
  assert.equal(granted, false, 'row vanished between discovery + dispatch → deny');
});

test('admitSystemMutation recomputes the `with` function-form payload from the CURRENT row', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const dueAt = date();
  const Todo = entity('TodoAdmit', {
    grant: scope(() => everyone()).can(() => grant(read)),
        title: { kind: 'value', type: 'text' }, dueAt,

    schedule: {
      update: schedule.at(dueAt, {
        // payload derived from the row at DISPATCH time, not discovery time.
        with: ({ row }) => ({ title: row.title + ' [DONE]' }),
      }),
    },
  });
  for (const sql of generateDDL(Todo)) db.exec(sql);
  const now = Date.now();
  db.prepare('INSERT INTO TodoAdmit (id, title, dueAt) VALUES (?, ?, ?)').run('t1', 'buy milk', now - 1000);

  const principal = machinePrincipal({ id: 'TodoAdmit.update.dueAt', operations: ['update'] });
  const granted = admitSystemMutation({
    entity: Todo, verb: 'update', rowId: 't1',
    payload: { title: 'buy milk [DONE]' }, principal, db, now,
  });
  assert.equal(granted, true, 'function-form with recomputed from current row matches the dispatched payload');

  // Mismatch (the row title changed since discovery → recomputed payload differs):
  db.prepare('UPDATE TodoAdmit SET title = ? WHERE id = ?').run('buy groceries', 't1');
  const granted2 = admitSystemMutation({
    entity: Todo, verb: 'update', rowId: 't1',
    payload: { title: 'buy milk [DONE]' }, principal, db, now,
  });
  assert.equal(granted2, false, 'payload recomputed from current row no longer matches the stale dispatched payload → deny');
});

test('admitSystemMutation: schedule.after due = row.field + delay <= now', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const createdAt = date();
  const Task = entity('TaskAfter', {
    grant: scope(() => everyone()).can(() => grant(read)),
        createdAt, status: { kind: 'value', type: 'text' },

    schedule: {
      update: schedule.after(createdAt, 5000, { with: { status: 'stale' } }),
    },
  });
  for (const sql of generateDDL(Task)) db.exec(sql);
  const now = Date.now();
  // createdAt 10s ago + 5s delay = 5s before now → DUE
  db.prepare('INSERT INTO TaskAfter (id, createdAt, status) VALUES (?, ?, ?)').run('k1', now - 10_000, 'open');
  const principal = machinePrincipal({ id: `TaskAfter.update.${Task.schedule.update.triggerId}`, operations: ['update'] });
  const granted = admitSystemMutation({
    entity: Task, verb: 'update', rowId: 'k1',
    payload: { status: 'stale' }, principal, db, now,
  });
  assert.equal(granted, true, 'after: field + delay <= now → due → admit');

  // createdAt 1s ago + 5s delay = 6s after now → NOT due
  db.prepare('UPDATE TaskAfter SET createdAt = ? WHERE id = ?').run(now - 1000, 'k1');
  const granted2 = admitSystemMutation({
    entity: Task, verb: 'update', rowId: 'k1',
    payload: { status: 'stale' }, principal, db, now,
  });
  assert.equal(granted2, false, 'after: field + delay > now → not due → deny');
});

// ============================================================
// END-TO-END: the wired dispatch spine admits / denies a scheduler principal
// through the durable variant's beforeProjection admission seam.
// ============================================================
import { createServer, durableMutationVariant } from '../build/pipeline.mjs';
import { principal as makePrincipal } from '../build/principal.mjs';

function setupAppServer() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const publishedAt = date();
  const status = { kind: 'value', type: 'text' };
  const Blog = entity('BlogE2E', {
    // The wired dispatch projects the scheduler update: declare the scope AND
    // the write capability as a compiled grant clause array (a bare clause
    // object does not survive entity compilation and confers nothing).
    grant: () => [scope(() => everyone()).can(() => grant(read, write))],
        publishedAt, status,

    schedule: {
      update: schedule.at(publishedAt, {
        while: ({ fields }) => fields.status.is('draft'),
        with: { status: 'published' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  const app = workbench({ db, entities: [Blog] });
  const Blog_b = app.entity(Blog);
  const server = createServer({
    handlers: Blog_b.crudHandlers,
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [Blog_b.projection],
      admission: {
        beforeProjection: async ({ entityName, verb, principal: p, event, payload, db: hookDb, now }) => {
          if (p?.type !== 'system' || !p.attributes?.source) return true;
          return admitSystemMutation({
            entity: Blog_b, verb, rowId: event?.data?.id,
            payload, principal: p, db: hookDb ?? db, now: now ?? Date.now(),
          });
        },
        afterProjection: async () => true,
      },
    }),
  });
  return { db, Blog: Blog_b, server };
}

test('a deadline receipt makes successful admission one-shot', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('once', now - 1000, 'draft');
  const principal = machinePrincipal({ id: `BlogAdmit.update.${Blog.schedule.update.triggerId}`, operations: ['update'] });
  const request = {
    entity: Blog,
    verb: 'update',
    rowId: 'once',
    payload: { published: true },
    principal,
    db,
    now,
  };

  assert.equal(admitSystemMutation(request), true);
  assert.equal(admitSystemMutation(request), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ScheduleReceipt').get().count, 1);
});

test('a changed deadline replaces its old receipt instead of growing receipt history', () => {
  const { db, Blog, publishedAt } = setupEntity();
  const now = Date.now();
  const firstDueAt = now - 2000;
  const secondDueAt = now - 1000;
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('moved', firstDueAt, 'draft');
  const request = {
    entity: Blog,
    verb: 'update',
    rowId: 'moved',
    payload: { published: true },
    principal: machinePrincipal({ id: `BlogAdmit.update.${Blog.schedule.update.triggerId}`, operations: ['update'] }),
    db,
    now,
  };

  assert.equal(admitSystemMutation(request), true);
  db.prepare('UPDATE BlogAdmit SET publishedAt = ? WHERE id = ?').run(secondDueAt, 'moved');
  assert.equal(rearmChangedScheduleReceipts({
    entity: Blog,
    event: { data: { id: 'moved', publishedAt: secondDueAt } },
    principal: { type: 'user', id: 'owner' },
    db,
  }), 1);
  assert.equal(admitSystemMutation(request), true);

  const receipts = db.prepare(
    'SELECT dueAt FROM _ScheduleReceipt WHERE rowId = ? ORDER BY dueAt',
  ).all('moved');
  assert.deepEqual(receipts.map((row) => ({ ...row })), [{ dueAt: secondDueAt }]);
  assert.equal(admitSystemMutation(request), false, 'the replacement value is still one-shot');
  assert.equal(publishedAt, Blog.fields.publishedAt);
});

test('receipt rearming is field-scoped and scheduler mutations cannot rearm themselves', () => {
  const { db, Blog } = setupEntity();
  const source = `BlogAdmit.update.${Blog.schedule.update.triggerId}`;
  db.prepare(
    'INSERT INTO _ScheduleReceipt (source, rowId, dueAt) VALUES (?, ?, ?)',
  ).run(source, 'row1', 123);

  assert.equal(rearmChangedScheduleReceipts({
    entity: Blog,
    event: { data: { id: 'row1', status: 'published' } },
    principal: { type: 'user', id: 'owner' },
    db,
  }), 0);
  assert.equal(rearmChangedScheduleReceipts({
    entity: Blog,
    event: { data: { id: 'row1', publishedAt: 123 } },
    principal: { type: 'system', attributes: { source } },
    db,
  }), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ScheduleReceipt').get().count, 1);
});

test('one scheduler rearms a sibling deadline source but retains its own receipt', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const dueAt = date();
  const Multi = entity('MultiDeadlineRearm', {
    dueAt,
    grant: scope(() => everyone()).can(() => grant(read)),
    schedule: {
      update: [
        schedule.at(dueAt, { key: 'first', with: { first: true } }),
        schedule.at(dueAt, { key: 'second', with: { second: true } }),
      ],
    },
  });
  const first = schedulerSource(Multi.name, 'update', 'first');
  const second = schedulerSource(Multi.name, 'update', 'second');
  const insert = db.prepare(
    'INSERT INTO _ScheduleReceipt (source, rowId, dueAt) VALUES (?, ?, ?)',
  );
  insert.run(first, 'row1', 123);
  insert.run(second, 'row1', 123);

  assert.equal(rearmChangedScheduleReceipts({
    entity: Multi,
    event: { data: { id: 'row1', dueAt: 456 } },
    principal: { type: 'system', attributes: { source: first } },
    db,
  }), 1);
  assert.deepEqual(
    db.prepare('SELECT source FROM _ScheduleReceipt ORDER BY source').all()
      .map((row) => row.source),
    [first],
  );
});

test('inactive trigger receipts are pruned while active sources survive', () => {
  const { db, Blog } = setupEntity();
  const active = schedulerSource(Blog.name, 'update', Blog.schedule.update.triggerId);
  const insert = db.prepare(
    'INSERT INTO _ScheduleReceipt (source, rowId, dueAt) VALUES (?, ?, ?)',
  );
  insert.run(active, 'active-row', 1);
  insert.run('RenamedEntity.update.old-key', 'orphan', 2);

  assert.equal(pruneInactiveScheduleReceipts({ db, entities: [Blog] }), 1);
  assert.deepEqual(
    db.prepare('SELECT source, rowId FROM _ScheduleReceipt').all()
      .map((row) => ({ ...row })),
    [{ source: active, rowId: 'active-row' }],
  );
});

test('removing a row clears all of its deadline receipts and no others', () => {
  const { db, Blog } = setupEntity();
  const source = `BlogAdmit.update.${Blog.schedule.update.triggerId}`;
  const insert = db.prepare(
    'INSERT INTO _ScheduleReceipt (source, rowId, dueAt) VALUES (?, ?, ?)',
  );
  insert.run(source, 'gone', 1);
  insert.run(source, 'kept', 2);

  assert.equal(clearRemovedScheduleReceipts({ entity: Blog, rowId: 'gone', db }), 1);
  assert.deepEqual(
    db.prepare('SELECT rowId, dueAt FROM _ScheduleReceipt ORDER BY rowId').all()
      .map((row) => ({ ...row })),
    [{ rowId: 'kept', dueAt: 2 }],
  );
});

test('the canonical app kernel rearms updates and clears removals in-transaction', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const dueAt = date();
  const Lifecycle = entity('ScheduleReceiptLifecycle', {
    dueAt,
    status: { kind: 'value', type: 'text' },
    grant: () => grant(read, write, subscribe),
    schedule: {
      update: schedule.at(dueAt, { with: { status: 'fired' } }),
    },
  });
  const app = workbench({ db }).mount('/schedule-receipt-lifecycle', Lifecycle).listen(0);
  t.after(async () => {
    await app.shutdown();
    db.close();
  });
  await app.ready;

  const bound = app.entity('ScheduleReceiptLifecycle');
  const source = schedulerSource(
    bound.name,
    'update',
    bound.schedule.update.triggerId,
  );
  const future = Date.now() + 60_000;
  db.prepare(
    'INSERT INTO ScheduleReceiptLifecycle (id, dueAt, status) VALUES (?, ?, ?)',
  ).run('lifecycle', future, 'armed');
  db.prepare(
    'INSERT INTO _ScheduleReceipt (source, rowId, dueAt) VALUES (?, ?, ?)',
  ).run(source, 'lifecycle', future);

  const user = makePrincipal({ type: 'user', id: 'owner' });
  const updated = await app.dispatch({
    actionId: 'schedule-receipt-update',
    type: 'ScheduleReceiptLifecycle.update',
    payload: { id: 'lifecycle', dueAt: future + 1000 },
    principal: user,
  });
  assert.equal(updated.ok, true);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM _ScheduleReceipt WHERE rowId = ?').get('lifecycle').count,
    0,
  );

  db.prepare(
    'INSERT INTO _ScheduleReceipt (source, rowId, dueAt) VALUES (?, ?, ?)',
  ).run(source, 'lifecycle', future + 1000);
  const removed = await app.dispatch({
    actionId: 'schedule-receipt-remove',
    type: 'ScheduleReceiptLifecycle.remove',
    payload: { id: 'lifecycle' },
    principal: user,
  });
  assert.equal(removed.ok, true);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM _ScheduleReceipt WHERE rowId = ?').get('lifecycle').count,
    0,
  );
});

test('deadline receipt rolls back with the mutation transaction', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('retry', now - 1000, 'draft');
  const request = {
    entity: Blog,
    verb: 'update',
    rowId: 'retry',
    payload: { published: true },
    principal: machinePrincipal({ id: `BlogAdmit.update.${Blog.schedule.update.triggerId}`, operations: ['update'] }),
    db,
    now,
  };

  db.exec('BEGIN');
  assert.equal(admitSystemMutation(request), true);
  db.exec('ROLLBACK');
  assert.equal(admitSystemMutation(request), true);
});

test('a denied deadline payload does not consume its one-shot receipt', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('deny-first', now - 1000, 'draft');
  const base = {
    entity: Blog,
    verb: 'update',
    rowId: 'deny-first',
    principal: machinePrincipal({ id: `BlogAdmit.update.${Blog.schedule.update.triggerId}`, operations: ['update'] }),
    db,
    now,
  };

  assert.equal(admitSystemMutation({ ...base, payload: { published: false } }), false);
  assert.equal(admitSystemMutation({ ...base, payload: { published: true } }), true);
});

test('e2e: a bound scheduler dispatch is ADMITTED through the wired dispatch hook', async () => {
  const { db, Blog, server } = setupAppServer();
  const now = Date.now();
  db.prepare('INSERT INTO BlogE2E (id, publishedAt, status) VALUES (?, ?, ?)').run('b1', now - 1000, 'draft');

  const res = await server.dispatch({
    actionId: 'sched-1',
    type: 'BlogE2E.update',
    payload: { id: 'b1', status: 'published' },
    principal: machinePrincipal({ id: 'BlogE2E.update.publishedAt', operations: ['update'] }),
  });
  assert.equal(res.ok, true, 'scheduler principal dispatched the declared payload on a due+while-holding row');
  assert.ok(res.events?.length >= 1, 'the update event was committed');
  // The row was mutated by the projection:
  const row = db.prepare('SELECT * FROM BlogE2E WHERE id = ?').get('b1');
  assert.equal(row.status, 'published', 'projection applied the declared with payload (status: published)');
});

test('e2e: a scheduler principal sending an UNDECLARED payload is DENIED (write-anything hole)', async () => {
  const { db, server } = setupAppServer();
  const now = Date.now();
  db.prepare('INSERT INTO BlogE2E (id, publishedAt, status) VALUES (?, ?, ?)').run('b2', now - 1000, 'draft');

  const res = await server.dispatch({
    actionId: 'sched-2',
    type: 'BlogE2E.update',
    payload: { id: 'b2', status: 'hijacked' }, // wrong value: schedule declared { status: 'published' }
    principal: machinePrincipal({ id: 'BlogE2E.update.publishedAt', operations: ['update'] }),
  });
  assert.equal(res.ok, false, 'undeclared payload → deny; the scheduler principal cannot write-anything');
});

test('e2e: a scheduler principal with the WRONG source is DENIED', async () => {
  const { db, server } = setupAppServer();
  const now = Date.now();
  db.prepare('INSERT INTO BlogE2E (id, publishedAt, status) VALUES (?, ?, ?)').run('b3', now - 1000, 'draft');

  const res = await server.dispatch({
    actionId: 'sched-3',
    type: 'BlogE2E.update',
    payload: { id: 'b3', status: 'published' },
    principal: machinePrincipal({ id: 'Other.update.publishedAt', operations: ['update'] }),
  });
  assert.equal(res.ok, false, 'wrong source → deny; principal must bind to the declared schedule');
});

test('e2e: production ISO transaction time still denies a future deadline', async () => {
  const { db, server } = setupAppServer();
  db.prepare('INSERT INTO BlogE2E (id, publishedAt, status) VALUES (?, ?, ?)')
    .run('future', Date.now() + 60_000, 'draft');

  const res = await server.dispatch({
    actionId: 'sched-future-iso-now',
    type: 'BlogE2E.update',
    payload: { id: 'future', status: 'published' },
    principal: machinePrincipal({ id: 'BlogE2E.update.publishedAt', operations: ['update'] }),
  });
  assert.equal(res.ok, false, 'a future deadline is never admitted through the production pipeline');
  assert.equal(
    db.prepare('SELECT status FROM BlogE2E WHERE id = ?').get('future').status,
    'draft',
  );
});

test('e2e: a scheduler dispatch on a NON-draft row (while-fails) is DENIED', async () => {
  const { db, server } = setupAppServer();
  const now = Date.now();
  db.prepare('INSERT INTO BlogE2E (id, publishedAt, status) VALUES (?, ?, ?)').run('b4', now - 1000, 'archived');

  const res = await server.dispatch({
    actionId: 'sched-4',
    type: 'BlogE2E.update',
    payload: { id: 'b4', status: 'published' },
    principal: machinePrincipal({ id: 'BlogE2E.update.publishedAt', operations: ['update'] }),
  });
  assert.equal(res.ok, false, 'while no longer holds → deny (the declared will still governs)');
});
