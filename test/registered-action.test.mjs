import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import workbench from '../build/index.mjs';
import { readCommittedCursor, defineSqliteSchema, frameworkTableNames } from '../build/server.mjs';

// The fixture tables the tests create out-of-band and the application
// projections write; declared through the externalTables seam so the census
// attributes them to this schema instead of rejecting them as undeclared.
// Boot validates the settled census against SQLite (fail closed). Each test
// creates only the out-of-band tables it needs, so declare exactly the objects
// present in its database: no missing census entry, no undeclared drift.
// Framework-owned names already have their own authority.
function fixtureSchema(db) {
  const reserved = new Set(frameworkTableNames.map((name) => String(name).toLowerCase()));
  const externalTables = [];
  const externalTriggers = [];
  const objects = db.prepare(
    "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'trigger') ORDER BY type, name",
  ).all();
  for (const object of objects) {
    const name = String(object.name);
    if (reserved.has(name.toLowerCase())) continue;
    if (object.type === 'trigger') {
      externalTriggers.push({ name });
      continue;
    }
    const columns = db.prepare(`PRAGMA table_xinfo("${name.replaceAll('"', '""')}")`).all()
      .filter((column) => Number(column.hidden) === 0)
      .map((column) => String(column.name));
    externalTables.push({ name, columns: columns.length > 0 ? columns : ['id'] });
  }
  return defineSqliteSchema({ name: 'registered-action-fixtures', tables: [], externalTables, externalTriggers });
}

function sourceAction(_db, authorize = () => true) {
  return {
    type: 'source.create',
    authorize,
    handler: ({ payload, now }) => [{
      type: 'source.created',
      scope: `project:${payload.projectId}`,
      data: { id: payload.id, entity: { ...payload, createdAt: now } },
    }],
    projections: [{
      eventTypes: ['source.created'],
      apply(event, tx) {
        tx.prepare('INSERT INTO Source (id, projectId, name) VALUES (?, ?, ?)').run(
          event.data.entity.id,
          event.data.entity.projectId,
          event.data.entity.name,
        );
      },
    }],
  };
}

async function appWith(action) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Source (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL)');
  const app = workbench({ db, actions: [action(db)], schema: fixtureSchema(db) });
  await app.start();
  return { app, db };
}

test('registered action commits projection, project event, cursor, and receipt once', async () => {
  const { app, db } = await appWith(sourceAction);
  const request = {
    actionId: 'action-1', scope: 'project:p1', type: 'source.create',
    payload: { id: 's1', projectId: 'p1', name: 'Interview' },
    principal: { type: 'user', id: 'u1', attributes: {} },
  };

  const first = await app.dispatch(request);
  const duplicate = await app.dispatch(request);

  assert.equal(first.ok, true);
  assert.equal(first.events[0].type, 'source.created');
  assert.equal(first.events[0].scope, 'project:p1');
  assert.equal(first.events[0].seq, 1);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.deduped, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Source').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 1);
  assert.equal(readCommittedCursor(db, 'project:p1'), 1);
});

test('registered action re-enters the public writer without releasing its transaction', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE ExternalWrite (id TEXT PRIMARY KEY)');
  let app;
  let releaseNested;
  const nestedCanFinish = new Promise((resolve) => { releaseNested = resolve; });
  let nestedStarted;
  const nestedHasStarted = new Promise((resolve) => { nestedStarted = resolve; });
  let nestedRuns = 0;
  const action = {
    type: 'source.create',
    authorize: () => true,
    handler: async ({ payload, now }) => {
      await app.writeQueue.run(async () => {
        nestedRuns++;
        assert.equal(app.writeQueue.owned, true);
        assert.equal(db.isTransaction, true, 'a writer slot does not open the transaction; this dispatch already did');
        db.prepare('INSERT INTO ExternalWrite (id) VALUES (?)').run(payload.id);
        nestedStarted();
        await nestedCanFinish;
      });
      return [{
        type: 'source.created',
        scope: `project:${payload.projectId}`,
        data: { id: payload.id, entity: { ...payload, createdAt: now } },
      }];
    },
    projections: [{
      eventTypes: ['source.created'],
      apply(event, tx) {
        tx.prepare('INSERT INTO Source (id, projectId, name) VALUES (?, ?, ?)').run(
          event.data.entity.id,
          event.data.entity.projectId,
          event.data.entity.name,
        );
      },
    }],
  };
  db.exec('CREATE TABLE Source (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL)');
  app = workbench({ db, actions: [action], schema: fixtureSchema(db) });
  await app.start();

  const dispatch = app.dispatch({
    actionId: 'reentrant-action', scope: 'project:p1', type: 'source.create',
    payload: { id: 's1', projectId: 'p1', name: 'Interview' },
    principal: { type: 'user', id: 'u1', attributes: {} },
  });
  await nestedHasStarted;

  let externalRan = false;
  const external = app.writeQueue.run(() => { externalRan = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(externalRan, false, 'an unrelated writer waits for the dispatch transaction');

  releaseNested();
  assert.equal((await dispatch).ok, true);
  await external;
  assert.equal(nestedRuns, 1);
  assert.equal(externalRan, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ExternalWrite').get().count, 1);
  db.close();
});

test('a failed re-entrant writer stays inside the dispatch rollback', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE ExternalWrite (id TEXT PRIMARY KEY)');
  let app;
  const action = {
    type: 'source.create',
    authorize: () => true,
    handler: async ({ payload }) => {
      await app.writeQueue.run(() => {
        db.prepare('INSERT INTO ExternalWrite (id) VALUES (?)').run(payload.id);
      });
      throw new Error('reject re-entrant action');
    },
  };
  app = workbench({ db, actions: [action], schema: fixtureSchema(db) });
  await app.start();

  const result = await app.dispatch({
    actionId: 'reentrant-rollback', scope: 'project:p1', type: 'source.create',
    payload: { id: 's1' }, principal: { type: 'user', id: 'u1', attributes: {} },
  });

  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ExternalWrite').get().count, 0);
  db.close();
});

test('registered action handler receives the exact caller-selected owning scope', async () => {
  let receivedScope = null;
  const scopeAware = (db) => {
    const declaration = sourceAction(db);
    return {
      ...declaration,
      handler: ({ scope, ...context }) => {
        receivedScope = scope;
        return declaration.handler(context);
      },
    };
  };
  const { app } = await appWith(scopeAware);
  const result = await app.dispatch({
    actionId: 'scope-aware', scope: 'project:distinct-scope', type: 'source.create',
    payload: { id: 's1', projectId: 'p1', name: 'Interview' },
    principal: { type: 'user', id: 'u1', attributes: {} },
  });
  assert.equal(result.ok, true);
  assert.equal(receivedScope, 'project:distinct-scope');
});

test('registered action batch handler receives owning scope, now, and db like single dispatch', async () => {
  let received = null;
  const scopeChecked = (db) => {
    const declaration = sourceAction(db);
    return {
      ...declaration,
      handler: (context) => {
        received = {
          scope: context.scope,
          now: context.now,
          hasDb: context.db != null && typeof context.db.prepare === 'function',
        };
        if (context.scope !== 'project:batch-scope') throw new Error('Source fact scope is invalid.');
        return declaration.handler(context);
      },
    };
  };
  const { app, db } = await appWith(scopeChecked);
  const result = await app.batch([{
    type: 'source.create', payload: { id: 's-batch', projectId: 'p1', name: 'Batch Interview' },
  }], {
    principal: { type: 'user', id: 'u1', attributes: {} }, scope: 'project:batch-scope',
  });

  assert.equal(result.ok, true, 'batch must not fail scope-checked registered actions');
  assert.equal(received?.scope, 'project:batch-scope');
  assert.equal(typeof received?.now, 'string');
  assert.equal(received?.hasDb, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Source').get().count, 1, 'registered projections must apply under $batch');
  assert.equal(db.prepare('SELECT id FROM Source').get().id, 's-batch');
  assert.equal(db.prepare('SELECT name FROM Source').get().name, 'Batch Interview');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _ActionReceipt WHERE scope = 'project:batch-scope'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE eventType = 'source.created'").get().count, 1);
});

test('registered action receipt commits immutable request attribution', async () => {
  const { app, db } = await appWith(sourceAction);
  const request = {
    actionId: 'attributed-action', scope: 'project:p1', type: 'source.create',
    payload: { id: 's1', projectId: 'p1', name: 'Interview' },
    principal: { type: 'user', id: 'u1', attributes: {} }, clientId: 'session-1',
  };

  assert.equal((await app.dispatch(request)).ok, true);
  assert.equal((await app.dispatch({ ...request, principal: { type: 'user', id: 'u2', attributes: {} }, clientId: 'session-2' })).deduped, true);
  const receipt = db.prepare('SELECT principalKey, sessionId FROM _ActionReceipt WHERE actionId = ?').get('attributed-action');
  assert.equal(receipt.principalKey, 'user:u1');
  assert.equal(receipt.sessionId, 'session-1');

  assert.equal((await app.dispatch({
    ...request, actionId: 'anonymous-attribution', payload: { id: 's2', projectId: 'p1', name: 'Anonymous' },
    principal: { type: 'anonymous', id: null, attributes: {} }, clientId: 'session-3',
  })).ok, true);
  const anonymousReceipt = db.prepare('SELECT principalKey, sessionId FROM _ActionReceipt WHERE actionId = ?').get('anonymous-attribution');
  assert.equal(anonymousReceipt.principalKey, null);
  assert.equal(anonymousReceipt.sessionId, 'session-3');
});

test('registered actions reject malformed receipt client attribution before writes', async () => {
  const { app, db } = await appWith(sourceAction);
  const result = await app.dispatch({
    actionId: 'invalid-attribution', scope: 'project:p1', type: 'source.create',
    payload: { id: 's1', projectId: 'p1', name: 'Interview' },
    principal: { type: 'user', id: 'u1', attributes: {} }, clientId: '',
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Source').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 0);

  const mismatch = await app.dispatch({
    actionId: 'mismatched-attribution', scope: 'project:p1', type: 'source.create',
    payload: { id: 's2', projectId: 'p1', name: 'Interview' },
    principal: { type: 'user', id: 'u1', attributes: {} }, clientId: 'session-1', history: { session: 'session-2' },
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.failure.category, 'invalid-input');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 0);

  const emptyBatch = await app.batch([], {
    principal: { type: 'user', id: 'u1', attributes: {} }, clientId: '',
  });
  assert.equal(emptyBatch.ok, false);
  assert.equal(emptyBatch.failure.category, 'invalid-input');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 0);
});

test('registered action batch commits request attribution once', async () => {
  const { app, db } = await appWith(sourceAction);
  const result = await app.batch([{
    type: 'source.create', payload: { id: 's1', projectId: 'p1', name: 'Interview' },
  }], {
    principal: { type: 'user', id: 'u1', attributes: {} }, clientId: 'session-1',
  });

  assert.equal(result.ok, true);
  const receipt = db.prepare('SELECT principalKey, sessionId FROM _ActionReceipt').get();
  assert.equal(receipt.principalKey, 'user:u1');
  assert.equal(receipt.sessionId, 'session-1');
});

test('registered action batch owns its receipt and delivery cursor in the caller-selected project stream', async () => {
  const { app, db } = await appWith(sourceAction);

  const actions = [{
    type: 'source.create', payload: { id: 's1', projectId: 'p1', name: 'Interview' },
  }];
  const result = await app.batch(actions, {
    principal: { type: 'user', id: 'u1', attributes: {} }, scope: 'project:receipt-owner',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.events.map((event) => event.scope), ['project:p1'], 'delivery remains on the emitted project stream');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _ActionReceipt WHERE scope = 'project:receipt-owner'").get().count, 1, 'the receipt belongs to the caller-selected owning stream');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _ActionReceipt WHERE scope = ''").get().count, 0);
  assert.equal(readCommittedCursor(db, 'project:p1'), 1);

  const retry = await app.kernel.dispatchBatch({
    actionId: result.events[0].actionId, actions,
    principal: { type: 'user', id: 'u1', attributes: {} }, scope: 'project:receipt-owner',
  });
  assert.equal(retry.deduped, true, 'the project-owned receipt recovers the committed batch');
  assert.equal(readCommittedCursor(db, 'project:p1'), 1, 'receipt recovery does not redeliver or advance the project cursor');
});

test('registered action authorization denies before handler and projection', async () => {
  let handled = false;
  const denied = (db) => {
    const declaration = sourceAction(db, () => false);
    return { ...declaration, handler: (context) => { handled = true; return declaration.handler(context); } };
  };
  const { app, db } = await appWith(denied);

  const result = await app.dispatch({
    actionId: 'denied', scope: 'project:p1', type: 'source.create',
    payload: { id: 's1', projectId: 'p1', name: 'Denied' },
    principal: { type: 'user', id: 'u1', attributes: {} },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'denied');
  assert.equal(handled, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Source').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 0);
});

test('registered action projection failure rolls back log, cursor, row, and receipt', async () => {
  const broken = (db) => {
    const declaration = sourceAction(db);
    return {
      ...declaration,
      projections: [{
        eventTypes: ['source.created'],
        apply(event, tx) {
          declaration.projections[0].apply(event, tx);
          throw new Error('injected projection failure');
        },
      }],
    };
  };
  const { app, db } = await appWith(broken);

  const result = await app.dispatch({
    actionId: 'broken', scope: 'project:p1', type: 'source.create',
    payload: { id: 's1', projectId: 'p1', name: 'Broken' },
    principal: { type: 'user', id: 'u1', attributes: {} },
  });

  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Source').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Cursor').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 0);
});
