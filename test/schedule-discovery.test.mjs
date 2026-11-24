// Schedule constructor grammar + fire-path deadline dispatch via startClockTriggers.
// Discovery is private; tests assert dispatch calls from the immediate scan.

import { boolean, date, json, link, text, scope, everyone, grant, read } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  entity, generateDDL, executeFrameworkDDL } from '../build/internal.mjs';
import { admitSystemMutation, schedule, startClockTriggers, schedulerSource } from '../build/schedule.mjs';

function setupDb() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  return db;
}

/** Fire-path helper: run the immediate scan, stop timers, return dispatch calls. */
function fireDeadline(db, entities, now) {
  const calls = [];
  const handle = startClockTriggers({
    db,
    entities,
    dispatch: (args) => { calls.push(args); },
    now: typeof now === 'function' ? now : () => now,
  });
  handle.stop();
  return calls;
}

function deadlinePayload(call) {
  const { id: _id, ...rest } = call.payload ?? {};
  return rest;
}

// ============================================================
// with: OBJECT PAYLOAD
// ============================================================

test('schedule.at with { with: { ... } } object stores the object', () => {
  const publishedAt = date();
  const trigger = schedule.at(publishedAt, { with: { published: true } });
  assert.equal(trigger.kind, 'schedule.at');
  assert.deepEqual(trigger.with, { published: true });
});

test('schedule.after with { with: { ... } } object stores the object', () => {
  const createdAt = date();
  const trigger = schedule.after(createdAt, '1h', { with: { reminded: true } });
  assert.equal(trigger.kind, 'schedule.after');
  assert.deepEqual(trigger.with, { reminded: true });
});

test('schedule.at rejects with: boolean (fail-closed)', () => {
  const f = date();
  assert.throws(
    () => schedule.at(f, { with: true }),
    /schedule\.at: 'with' must be an object or a function/,
  );
  assert.throws(
    () => schedule.at(f, { with: false }),
    /schedule\.at: 'with' must be an object or a function/,
  );
});

test('schedule.after rejects with: array (fail-closed)', () => {
  const f = date();
  assert.throws(
    () => schedule.after(f, '1h', { with: [1, 2, 3] }),
    /schedule\.after: 'with' must be an object or a function/,
  );
});

test('schedule.at rejects with: string (fail-closed)', () => {
  const f = date();
  assert.throws(
    () => schedule.at(f, { with: 'not-an-object' }),
    /schedule\.at: 'with' must be an object or a function/,
  );
});

test('schedule.at with { with: null } is valid (omitted/sentinel)', () => {
  const f = date();
  const trigger = schedule.at(f, { with: null });
  assert.strictEqual(trigger.with, null);
});

test('schedule.at without with option: with is undefined', () => {
  const f = date();
  const trigger = schedule.at(f);
  assert.strictEqual(trigger.with, undefined);
});

test('startClockTriggers deadline applies when as a runtime guard after due discovery', () => {
  const db = setupDb();
  const publishedAt = date();
  const status = text();
  const Blog = entity('DeadlineWhenGuard', {
    grant: scope(() => everyone()).can(() => grant(read)),
    publishedAt,
    status,
    schedule: {
      update: schedule.at(publishedAt, {
        when: ({ row }) => row.status === 'ready',
        with: { status: 'published' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  db.prepare('INSERT INTO DeadlineWhenGuard (id, publishedAt, status) VALUES (?, ?, ?)')
    .run('ready', 100, 'ready');
  db.prepare('INSERT INTO DeadlineWhenGuard (id, publishedAt, status) VALUES (?, ?, ?)')
    .run('blocked', 100, 'blocked');

  const calls = fireDeadline(db, [Blog], 200);
  assert.deepEqual(calls.map((call) => call.payload.id), ['ready']);
  db.close();
});

// ============================================================
// with: FUNCTION PAYLOAD
// ============================================================

test('schedule.at with { with: fn } stores the function', () => {
  const f = date();
  const payloadFn = ({ row }) => ({ computed: row.id });
  const trigger = schedule.at(f, { with: payloadFn });
  assert.equal(typeof trigger.with, 'function');
  assert.strictEqual(trigger.with, payloadFn);
});

test('schedule.after with { with: fn } stores the function', () => {
  const f = date();
  const payloadFn = ({ row }) => ({ rowId: row.id });
  const trigger = schedule.after(f, 1000, { with: payloadFn });
  assert.equal(typeof trigger.with, 'function');
});

test('schedule.at rejects with: number (fail-closed)', () => {
  const f = date();
  assert.throws(
    () => schedule.at(f, { with: 123 }),
    /schedule\.at: 'with' must be an object or a function/,
  );
});

// ============================================================
// CRUD VERB VALIDATION
// ============================================================

test('entity with schedule.create: valid CRUD verb', () => {
  const publishedAt = date();
  const Blog = entity('ScheduleCreateTest', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt,

    schedule: {
      create: schedule.at(publishedAt),
    },
  });
  assert.ok(Blog.schedule.create);
  assert.equal(Blog.schedule.create.kind, 'schedule.at');
});

test('entity with schedule.update: valid CRUD verb', () => {
  const publishedAt = date();
  const Blog = entity('ScheduleUpdateTest', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt,

    schedule: {
      update: schedule.at(publishedAt),
    },
  });
  assert.ok(Blog.schedule.update);
});

test('entity with schedule.remove: valid CRUD verb', () => {
  const publishedAt = date();
  const Blog = entity('ScheduleRemoveTest', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt,

    schedule: {
      remove: schedule.at(publishedAt),
    },
  });
  assert.ok(Blog.schedule.remove);
});

test('entity with non-CRUD verb (publish) throws at load (fail-closed)', () => {
  const publishedAt = date();
  assert.throws(
    () => entity('BadVerbEntity', {
      grant: scope(() => everyone()).can(() => grant(read)),
            publishedAt,

      schedule: {
        publish: schedule.at(publishedAt),
      },
    }),
    /schedule verb 'publish' must be one of create \| update \| remove/,
  );
});

test('entity with non-CRUD verb (archive) throws at load', () => {
  const publishedAt = date();
  assert.throws(
    () => entity('BadVerbEntity2', {
      grant: scope(() => everyone()).can(() => grant(read)),
            publishedAt,

      schedule: {
        archive: schedule.at(publishedAt),
      },
    }),
    /schedule verb 'archive' must be one of create \| update \| remove/,
  );
});

// ============================================================
// FIELD IDENTITY RESOLUTION
// ============================================================

test('schedule field identity-resolves to fieldName on validated entry', () => {
  const publishedAt = date();
  const Blog = entity('FieldNameResolveTest', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt,

    schedule: {
      update: schedule.at(publishedAt),
    },
  });
  assert.strictEqual(Blog.schedule.update.field, publishedAt);
  assert.strictEqual(Blog.schedule.update.fieldName, 'publishedAt');
});

test('schedule with non-declared field throws at load', () => {
  const fakeField = { kind: 'value', type: 'date' };
  assert.throws(
    () => entity('BadFieldEntity', {
      grant: scope(() => everyone()).can(() => grant(read)),
            title: text(),

      schedule: {
        update: schedule.at(fakeField),
      },
    }),
    /schedule 'update': field descriptor is not a declared field on entity/,
  );
});

test('schedule field must be date/number (value kind, comparable)', () => {
  const txt = text();
  assert.throws(
    () => entity('BadFieldTypeEntity', {
      grant: scope(() => everyone()).can(() => grant(read)),
            title: txt,

      schedule: {
        update: schedule.at(txt),
      },
    }),
    /schedule 'update': field 'title' must be a date or number field/,
  );
});


// ============================================================
// startClockTriggers deadline fire-path
// ============================================================

test('startClockTriggers deadline: schedule.at finds past-due rows', () => {
  const db = setupDb();
  const publishedAt = date();
  const Blog = entity('BlogAtDiscovery', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt,

    schedule: {
      update: schedule.at(publishedAt, { with: { published: true } }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const pastTime = Date.now() - 100_000;
  const futureTime = Date.now() + 100_000;

  db.prepare('INSERT INTO BlogAtDiscovery (id, publishedAt) VALUES (?, ?)').run('row1', pastTime);
  db.prepare('INSERT INTO BlogAtDiscovery (id, publishedAt) VALUES (?, ?)').run('row2', futureTime);

  const calls = fireDeadline(db, [Blog], Date.now());
  assert.equal(calls.length, 1, 'only past-due row should fire');
  assert.equal(calls[0].type, 'BlogAtDiscovery.update');
  assert.equal(calls[0].payload.id, 'row1');
  assert.deepEqual(deadlinePayload(calls[0]), { published: true });
  assert.equal(calls[0].principal.attributes.source, schedulerSource('BlogAtDiscovery', 'update', 'publishedAt'));
});

test('startClockTriggers deadline: schedule.at excludes future rows', () => {
  const db = setupDb();
  const publishedAt = date();
  const Blog = entity('BlogAtFuture', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt,

    schedule: {
      update: schedule.at(publishedAt),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const futureTime = Date.now() + 100_000;
  db.prepare('INSERT INTO BlogAtFuture (id, publishedAt) VALUES (?, ?)').run('row1', futureTime);

  const calls = fireDeadline(db, [Blog], Date.now());
  assert.equal(calls.length, 0, 'future row should not fire');
});

test('startClockTriggers deadline: schedule.after finds rows where field + delay <= now', () => {
  const db = setupDb();
  const createdAt = date();
  const now = Date.now();
  const delay = 1000;

  const Todo = entity('TodoAfterDiscovery', {
    grant: scope(() => everyone()).can(() => grant(read)),
        createdAt,

    schedule: {
      update: schedule.after(createdAt, delay, { with: { reminded: true } }),
    },
  });
  for (const sql of generateDDL(Todo)) db.exec(sql);

  const pastTime = now - 2000;
  const recentTime = now - 500;

  db.prepare('INSERT INTO TodoAfterDiscovery (id, createdAt) VALUES (?, ?)').run('row1', pastTime);
  db.prepare('INSERT INTO TodoAfterDiscovery (id, createdAt) VALUES (?, ?)').run('row2', recentTime);

  const calls = fireDeadline(db, [Todo], now);
  assert.equal(calls.length, 1, 'only the old enough row should fire');
  assert.equal(calls[0].payload.id, 'row1');
  assert.deepEqual(deadlinePayload(calls[0]), { reminded: true });
});

test('startClockTriggers deadline: with function receives full row', () => {
  const db = setupDb();
  const createdAt = date();
  const title = text();
  const now = Date.now();

  const payloadCalls = [];
  const payloadFn = ({ row }) => {
    payloadCalls.push(row);
    return { computed: row.id, title: row.title };
  };

  const Doc = entity('DocFnPayload', {
    grant: scope(() => everyone()).can(() => grant(read)),
        createdAt, title, owner: text(),

    schedule: {
      update: schedule.at(createdAt, { with: payloadFn }),
    },
  });
  for (const sql of generateDDL(Doc)) db.exec(sql);

  const pastTime = now - 100_000;
  db.prepare('INSERT INTO DocFnPayload (id, createdAt, title, owner) VALUES (?, ?, ?, ?)').run('row1', pastTime, 'Doc1', 'user1');
  db.prepare('INSERT INTO DocFnPayload (id, createdAt, title, owner) VALUES (?, ?, ?, ?)').run('row2', pastTime, 'Doc2', 'user2');

  const calls = fireDeadline(db, [Doc], now);
  assert.equal(calls.length, 2, 'both rows fire');
  assert.equal(payloadCalls.length, 2, 'function called for each row');
  assert.ok(payloadCalls.some((r) => r.id === 'row1'), 'function received row1');
  assert.ok(payloadCalls.some((r) => r.id === 'row2'), 'function received row2');

  const row1 = calls.find((c) => c.payload.id === 'row1');
  assert.equal(row1.payload.computed, 'row1');
  assert.equal(row1.payload.title, 'Doc1');
});

test('startClockTriggers deadline: with omitted → payload fields empty', () => {
  const db = setupDb();
  const publishedAt = date();

  const Blog = entity('BlogNoWith', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt,

    schedule: {
      update: schedule.at(publishedAt),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const pastTime = Date.now() - 100_000;
  db.prepare('INSERT INTO BlogNoWith (id, publishedAt) VALUES (?, ?)').run('row1', pastTime);

  const calls = fireDeadline(db, [Blog], Date.now());
  assert.equal(calls.length, 1);
  assert.deepEqual(deadlinePayload(calls[0]), {}, 'no with → empty payload fields');
});

test('startClockTriggers deadline: while predicate narrows results', () => {
  const db = setupDb();
  const status = text();
  const publishedAt = date();
  const now = Date.now();
  const pastTime = now - 100_000;

  const Blog = entity('BlogWhileNarrow', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status, publishedAt,

    schedule: {
      update: schedule.at(publishedAt, {
        while: ({ fields }) => fields.status.is('scheduled'),
        with: { action: 'process' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  db.prepare('INSERT INTO BlogWhileNarrow (id, publishedAt, status) VALUES (?, ?, ?)').run('row1', pastTime, 'scheduled');
  db.prepare('INSERT INTO BlogWhileNarrow (id, publishedAt, status) VALUES (?, ?, ?)').run('row2', pastTime, 'draft');
  db.prepare('INSERT INTO BlogWhileNarrow (id, publishedAt, status) VALUES (?, ?, ?)').run('row3', pastTime, 'published');

  const calls = fireDeadline(db, [Blog], now);
  assert.equal(calls.length, 1, 'only scheduled row should fire');
  assert.equal(calls[0].payload.id, 'row1');
  assert.equal(calls[0].payload.action, 'process');
});

test('startClockTriggers deadline: multiple due rows all fire', () => {
  const db = setupDb();
  const publishedAt = date();

  const Blog = entity('BlogMultiple', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt,

    schedule: {
      update: schedule.at(publishedAt, { with: { processed: true } }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const pastTime = Date.now() - 100_000;
  db.prepare('INSERT INTO BlogMultiple (id, publishedAt) VALUES (?, ?)').run('row1', pastTime);
  db.prepare('INSERT INTO BlogMultiple (id, publishedAt) VALUES (?, ?)').run('row2', pastTime);
  db.prepare('INSERT INTO BlogMultiple (id, publishedAt) VALUES (?, ?)').run('row3', pastTime);

  const calls = fireDeadline(db, [Blog], Date.now());
  assert.equal(calls.length, 3, 'all three rows fire');
  const ids = calls.map((c) => c.payload.id).sort();
  assert.deepEqual(ids, ['row1', 'row2', 'row3']);
});

test('startClockTriggers deadline: entity with no schedule is no-op', () => {
  const db = setupDb();
  const Blog = entity('BlogNoScheduleEntity', {
    grant: scope(() => everyone()).can(() => grant(read)),
        title: text()

  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const calls = fireDeadline(db, [Blog], Date.now());
  assert.equal(calls.length, 0, 'no schedule → no dispatch');
});

test('startClockTriggers deadline: empty entities array is no-op', () => {
  const db = setupDb();
  const calls = fireDeadline(db, [], Date.now());
  assert.equal(calls.length, 0);
});

test('startClockTriggers deadline: clock injection - now BEFORE row time → empty', () => {
  const db = setupDb();
  const publishedAt = date();
  const baseNow = Date.now();
  const futureTime = baseNow + 1_000_000;

  const Blog = entity('BlogClockEarly', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt,

    schedule: {
      update: schedule.at(publishedAt),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  db.prepare('INSERT INTO BlogClockEarly (id, publishedAt) VALUES (?, ?)').run('row1', futureTime);

  const early = fireDeadline(db, [Blog], baseNow);
  assert.equal(early.length, 0, 'now before row time → not due');

  const late = futureTime + 1000;
  const lateCalls = fireDeadline(db, [Blog], late);
  assert.equal(lateCalls.length, 1, 'now after row time → due');
});

test('startClockTriggers deadline: multiple entities with schedules', () => {
  const db = setupDb();
  const now = Date.now();
  const pastTime = now - 100_000;

  const blogPublishedAt = date();
  const Blog = entity('BlogMultiEntity', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt: blogPublishedAt,

    schedule: {
      update: schedule.at(blogPublishedAt, { with: { source: 'blog' } }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const todoDueAt = date();
  const Todo = entity('TodoMultiEntity', {
    grant: scope(() => everyone()).can(() => grant(read)),
        dueAt: todoDueAt,

    schedule: {
      update: schedule.at(todoDueAt, { with: { source: 'todo' } }),
    },
  });
  for (const sql of generateDDL(Todo)) db.exec(sql);

  db.prepare('INSERT INTO BlogMultiEntity (id, publishedAt) VALUES (?, ?)').run('b1', pastTime);
  db.prepare('INSERT INTO TodoMultiEntity (id, dueAt) VALUES (?, ?)').run('t1', pastTime);

  const calls = fireDeadline(db, [Blog, Todo], now);
  assert.equal(calls.length, 2, 'one from each entity');
  const sources = calls.map((c) => c.payload.source).sort();
  assert.deepEqual(sources, ['blog', 'todo']);
});

test('startClockTriggers deadline: with: null treated as omitted → {}', () => {
  const db = setupDb();
  const publishedAt = date();

  const Blog = entity('BlogNullWith', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt,

    schedule: {
      update: schedule.at(publishedAt, { with: null }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const pastTime = Date.now() - 100_000;
  db.prepare('INSERT INTO BlogNullWith (id, publishedAt) VALUES (?, ?)').run('row1', pastTime);

  const calls = fireDeadline(db, [Blog], Date.now());
  assert.equal(calls.length, 1);
  assert.deepEqual(deadlinePayload(calls[0]), {}, 'with: null → empty payload fields');
});

test('with function receives row with id field', () => {
  const db = setupDb();
  const publishedAt = date();
  let receivedId = null;

  const payloadFn = ({ row }) => {
    receivedId = row.id;
    return { test: true };
  };

  const Blog = entity('BlogFnRowId', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt,

    schedule: {
      update: schedule.at(publishedAt, { with: payloadFn }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const pastTime = Date.now() - 100_000;
  db.prepare('INSERT INTO BlogFnRowId (id, publishedAt) VALUES (?, ?)').run('test-id-123', pastTime);

  fireDeadline(db, [Blog], Date.now());
  assert.equal(receivedId, 'test-id-123', 'function should receive row.id');
});

test('schedule callbacks receive an immutable public row, not SQLite storage cells', () => {
  const db = setupDb();
  const publishedAt = date();
  let callbackRow;
  const Article = entity('PublicScheduleRow', {
    grant: scope(() => everyone()).can(() => grant(read)),
    publishedAt,
    enabled: boolean(),
    metadata: json(),
    share: link({ tiers: ['comment'], tier: 'comment' }),
    schedule: {
      update: schedule.at(publishedAt, {
        when: ({ row }) => {
          callbackRow = row;
          return row.enabled === true && row.metadata.tags[0] === 'ready' && row.share.tier === 'comment';
        },
        with: ({ row }) => ({ enabled: row.enabled }),
      }),
    },
  });
  for (const sql of generateDDL(Article)) db.exec(sql);
  db.prepare(
    'INSERT INTO PublicScheduleRow (id, publishedAt, enabled, metadata, share__token, share__tier) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('article-1', Date.now() - 1000, 1, JSON.stringify({ tags: ['ready'] }), 'token-1', 'comment');

  const calls = fireDeadline(db, [Article], Date.now());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.enabled, true);
  assert.deepEqual(callbackRow.metadata, { tags: ['ready'] });
  assert.deepEqual(callbackRow.share, { token: 'token-1', tier: 'comment' });
  assert.equal(callbackRow.share__token, undefined);
  assert.equal(Object.isFrozen(callbackRow), true);
});

test('one throwing lifecycle callback does not skip later due rows', () => {
  const db = setupDb();
  const dueAt = date();
  const Scheduled = entity('IsolatedScheduleCallback', {
    grant: scope(() => everyone()).can(() => grant(read)),
    dueAt,
    schedule: {
      update: schedule.at(dueAt, {
        when: ({ row }) => {
          if (row.id === 'bad') throw new Error('bad callback');
          return true;
        },
        with: { fired: true },
      }),
    },
  });
  for (const sql of generateDDL(Scheduled)) db.exec(sql);
  const past = Date.now() - 1000;
  db.prepare('INSERT INTO IsolatedScheduleCallback (id, dueAt) VALUES (?, ?)').run('bad', past);
  db.prepare('INSERT INTO IsolatedScheduleCallback (id, dueAt) VALUES (?, ?)').run('good', past);

  const calls = fireDeadline(db, [Scheduled], Date.now());
  assert.deepEqual(calls.map((call) => call.payload.id), ['good']);
});

test('deadline discovery excludes a row after its one-shot receipt is admitted', () => {
  const db = setupDb();
  const dueAt = date();
  const Scheduled = entity('ReceivedDeadline', {
    grant: scope(() => everyone()).can(() => grant(read)),
    dueAt,
    schedule: {
      update: schedule.at(dueAt, { with: { fired: true } }),
    },
  });
  for (const sql of generateDDL(Scheduled)) db.exec(sql);
  const now = Date.now();
  db.prepare('INSERT INTO ReceivedDeadline (id, dueAt) VALUES (?, ?)').run('received', now - 1000);
  const first = fireDeadline(db, [Scheduled], now);
  assert.equal(first.length, 1);

  const granted = admitSystemMutation({
    entity: Scheduled,
    verb: 'update',
    rowId: 'received',
    payload: { fired: true },
    principal: first[0].principal,
    db,
    now,
  });
  assert.equal(granted, true);
  assert.equal(fireDeadline(db, [Scheduled], now).length, 0);
});
