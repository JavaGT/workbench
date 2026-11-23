import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { durableHistory } from '../build/index.mjs';
import workbench, { createServer, durableMutationVariant, executeFrameworkDDL } from '../build/internal.mjs';
import { retentionPrune, insertReceipt } from '../build/committed-log.mjs';
import { prepareErasureDirective, applyErasureDirective } from '../build/erasure-directive.mjs';
import { createHistoryContributionPolicyRegistry, compileNativeInsertContributionPolicy } from '../build/history-contribution-policy.mjs';

const principal = Object.freeze({ type: 'user', id: 'u1', attributes: {} });
const scope = 'Document:1';

function historyDescriptor(authorize = () => true) {
  return durableHistory({
    authorize,
    actions: {
      'document.set': {
        inverse: ({ action, fact }) => ({
          type: 'document.set',
          scope: action.scope,
          payload: { value: fact.before, before: fact.after },
        }),
        redo: ({ action, fact }) => ({ type: 'document.set', scope: action.scope, payload: { value: fact.after, before: fact.before } }),
      },
    },
  });
}

async function historyMove(server, operation, args) {
  const cursor = await server.history.cursor(args);
  return server.history[operation]({ actionId: `${operation}-${Math.random()}`, ...args, revision: cursor.revision });
}

// #145 S5: the retired annotatedHistory classifier option is gone. Tests build
// the compile-produced contribution-policy registry instead: native insert
// policies per action type plus the declaration-derived privateHistoryScopes
// read-privacy set (used ONLY by actions()/events()).
function annotatedRegistry(entities, actionTypes = []) {
  const policies = actionTypes.map((type) => {
    const parts = type.split('.');
    const fieldName = parts[1];
    return compileNativeInsertContributionPolicy({ entity: parts[0], fieldName }, type);
  });
  return createHistoryContributionPolicyRegistry({ policies, privateHistoryScopes: entities });
}

function makeServer(db, history = historyDescriptor(), cursorPolicy, contributionPolicies = null) {
  return createServer({
    db,
    history,
    cursorPolicy,
    contributionPolicies,
    authorize: () => true,
    handlers: {
      'document.set': ({ payload, scope: owningScope }) => owningScope === undefined || payload.before === undefined
        ? [{ type: 'document.changed', scope, data: { value: payload.value } }]
        : ({
            events: [{ type: 'document.changed', scope, data: { value: payload.value } }],
            privateFact: { before: payload.before ?? null, after: payload.value },
          }),
      'Document.body.apply': ({ payload }) => [{
        type: 'Document.body.applied',
        scope,
        data: payload,
      }],
      'explicit.eligible': ({ payload }) => [{
        type: 'explicit.changed',
        scope,
        data: payload,
      }],
      'explicit.excluded': ({ payload }) => [{
        type: 'explicit.changed',
        scope,
        data: payload,
      }],
      'AnnotatedDoc.body.operation': ({ payload }) => [{
        type: 'AnnotatedDoc.body.operated',
        scope: 'AnnotatedDoc:1',
        data: payload,
      }],
      'mixed.set': ({ payload }) => [{
        type: 'AnnotatedDoc.created',
        scope: 'AnnotatedDoc:1',
        data: payload,
      }],
    },
  });
}

async function set(server, { actionId, value, before, session }) {
  return server.dispatch({
    actionId,
    type: 'document.set',
    payload: { value, before },
    principal,
    scope,
    history: { session },
  });
}

test('durable action/event reads and session cursor survive restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'workbench-history-'));
  const filename = path.join(dir, 'history.db');
  try {
    let db = new DatabaseSync(filename);
    executeFrameworkDDL(db);
    let server = makeServer(db);
    await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });
    db.close();

    db = new DatabaseSync(filename);
    executeFrameworkDDL(db);
    server = makeServer(db);
    const actions = await server.history.actions({ scope, principal });
    const events = await server.history.events({ scope, principal });
    const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'document.set');
    assert.deepEqual(actions[0].payload, { value: 1, before: 0 });
    assert.equal(actions[0].events[0].data.value, 1);
    assert.equal(events.length, 1);
    assert.partialDeepStrictEqual(cursor, { undo: 1, redo: 0 });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two sessions have independent undo cursors', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db);
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });
  await set(server, { actionId: 'a2', value: 2, before: 1, session: 'tab-b' });

  await historyMove(server, 'undo', { scope, principal, session: 'tab-a' });

  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 0, redo: 1 });
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-b' }), { undo: 1, redo: 0 });
});

test('undo then redo dispatch through the committed pipeline', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db);
  await set(server, { actionId: 'a1', value: 7, before: 0, session: 'tab-a' });

  const undone = await historyMove(server, 'undo', { scope, principal, session: 'tab-a' });
  const redone = await historyMove(server, 'redo', { scope, principal, session: 'tab-a' });

  assert.equal(undone.ok, true);
  assert.equal(undone.events[0].data.value, 0);
  assert.equal(redone.ok, true);
  assert.equal(redone.events[0].data.value, 7);
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 0 });
  assert.deepEqual(
    (await server.history.actions({ scope, principal })).map((entry) => entry.operation),
    ['action', 'undo', 'redo'],
  );
});

test('undoToPoint atomically rewinds the current session after a scope sequence boundary', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const history = durableHistory({ authorize: () => true, actions: {
    'document.set': {
      inverse: ({ fact }) => ({ type: 'explicit.eligible', payload: { marker: fact.before } }),
      redo: ({ fact }) => ({ type: 'explicit.eligible', payload: { marker: fact.after } }),
    },
  } });
  const server = makeServer(db, history);
  await set(server, { actionId: 'point-a1', value: 1, before: 0, session: 'tab-a' });
  await set(server, { actionId: 'point-a2', value: 2, before: 1, session: 'tab-a' });
  await set(server, { actionId: 'point-a3', value: 3, before: 2, session: 'tab-a' });
  const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  const undone = await server.history.undoToPoint({
    scope, principal, session: 'tab-a', actionId: 'point-undo', revision: cursor.revision, seq: 1,
  });

  assert.equal(undone.ok, true);
  assert.deepEqual(undone.events.map((event) => event.data.marker), [2, 1]);
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 2 });
  const retry = await server.history.undoToPoint({
    scope, principal, session: 'tab-a', actionId: 'point-undo', revision: cursor.revision, seq: 1,
  });
  assert.equal(retry.deduped, true);
  assert.equal(db.prepare("SELECT operation FROM _ActionReceipt WHERE actionId = 'point-undo'").get().operation, 'undoToPoint');
  assert.equal((await server.history.actions({ scope, principal })).length, 4);
});

test('translation receives private fact internally while public cursor and move results do not expose it', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db);
  let seen;
  const history = durableHistory({ authorize: () => true, actions: {
    'document.set': {
      inverse: (context) => { seen = context; return { type: 'document.set', payload: { value: context.fact.before } }; },
      redo: ({ fact }) => ({ type: 'document.set', payload: { value: fact.after } }),
    },
  } });
  const server = makeServer(db, history);
  await set(server, { actionId: 'private-a1', value: 'after', before: 'before', session: 'tab-a' });
  const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  assert.deepEqual(Object.keys(cursor).sort(), ['redo', 'revision', 'undo']);
  const moved = await server.history.undo({ scope, principal, session: 'tab-a', actionId: 'private-u1', revision: cursor.revision });
  assert.deepEqual(seen.fact, { before: 'before', after: 'after' });
  assert.equal(seen.principal, principal); assert.equal(seen.session, 'tab-a');
  assert.equal('fact' in moved, false);
});

test('translated opaque input is transaction-bound to its handler and never enters public durable material', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db);
  const secret = Object.freeze({ beforeImage: 'never serialize me' });
  const seen = [];
  const deliveries = [];
  const history = durableHistory({ authorize: () => true, actions: {
    'document.set': {
      inverse: ({ fact }) => ({
        type: 'history.restore', payload: { publicMarker: 'undo' }, input: { secret, value: fact.before },
      }),
      redo: ({ fact }) => ({ actions: [
        { type: 'history.restore', payload: { publicMarker: 'redo-1' }, input: { secret, value: fact.after } },
        { type: 'history.restore', payload: { publicMarker: 'redo-2' }, input: { secret, value: fact.after } },
      ] }),
    },
  } });
  const server = createServer({ db, history, pipeline: durableMutationVariant({
    postCommitConsumers: [(events) => { deliveries.push(events); }],
  }), authorize: (context) => {
    assert.equal('history' in context, false);
    assert.equal(JSON.stringify(context).includes('never serialize me'), false);
    return true;
  }, handlers: {
    'document.set': ({ payload, scope: owningScope }) => ({
      events: [{ type: 'document.changed', scope: owningScope, data: { value: payload.value } }],
      privateFact: { before: payload.before, after: payload.value },
    }),
    'history.restore': ({ payload, history: handlerHistory, db: transactionDb }) => {
      assert.equal(transactionDb, db);
      seen.push({ payload, history: handlerHistory });
      return [{ type: 'document.changed', scope, data: payload }];
    },
  } });
  await set(server, { actionId: 'opaque-a1', value: 'after', before: 'before', session: 'tab-a' });
  const undone = await historyMove(server, 'undo', { scope, principal, session: 'tab-a' });
  assert.deepEqual(seen[0], {
    payload: { publicMarker: 'undo' }, history: { operation: 'undo', input: { secret, value: 'before' } },
  });
  const redone = await historyMove(server, 'redo', { scope, principal, session: 'tab-a' });
  assert.deepEqual(seen.slice(1).map(({ history: value }) => value), [
    { operation: 'redo', input: { secret, value: 'after' } },
    { operation: 'redo', input: { secret, value: 'after' } },
  ]);
  const retryCursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  const retryArgs = { scope, principal, session: 'tab-a', actionId: 'opaque-retry', revision: retryCursor.revision };
  await server.history.undo(retryArgs);
  const callsBeforeRetry = seen.length;
  assert.equal((await server.history.undo(retryArgs)).deduped, true);
  assert.equal(seen.length, callsBeforeRetry);

  const serialized = JSON.stringify({
    receipts: db.prepare('SELECT * FROM _ActionReceipt').all(),
    log: db.prepare('SELECT * FROM _Log').all(),
    undone, redone,
    deliveries,
  });
  assert.equal(serialized.includes('never serialize me'), false);
  assert.equal(serialized.includes('beforeImage'), false);
});

test('ordinary dispatch omits history handler input', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db);
  let context;
  const server = createServer({ db, authorize: () => true, handlers: {
    ordinary: (value) => { context = value; return []; },
  } });
  await server.dispatch({ actionId: 'ordinary-a1', type: 'ordinary', payload: {}, principal, scope });
  assert.equal('history' in context, false);
});

test('translated batch primitive failure keeps its child index and rolls back atomically', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db);
  const history = durableHistory({ authorize: () => true, actions: { 'document.set': {
    inverse: () => ({ actions: [
      { type: 'history.ok', input: 'first' }, { type: 'history.primitiveFailure', input: 'second' },
    ] }),
    redo: () => ({ type: 'history.ok' }),
  } } });
  const server = createServer({ db, history, authorize: () => true, handlers: {
    'document.set': ({ payload, scope: owningScope }) => ({
      events: [{ type: 'document.changed', scope: owningScope, data: payload }],
      privateFact: { before: payload.before, after: payload.value },
    }),
    'history.ok': () => [{ type: 'document.changed', scope, data: { value: 'should roll back' } }],
    'history.primitiveFailure': () => { throw 'primitive failure'; },
  } });
  await set(server, { actionId: 'primitive-a1', value: 1, before: 0, session: 'tab-a' });
  const result = await historyMove(server, 'undo', { scope, principal, session: 'tab-a' });
  assert.equal(result.ok, false);
  assert.equal(result.failure.details.actionIndex, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _Log').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _ActionReceipt').get().count, 1);
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 0 });
});

test('application runtime exposes only cursor, undo, and redo history methods', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, history: historyDescriptor(), actions: [{
    type: 'document.set', authorize: () => true,
    handler: ({ payload }) => ({
      events: [{ type: 'document.changed', scope, data: { value: payload.value } }],
      privateFact: { before: payload.before, after: payload.value },
    }),
  }] });
  app.listen(0, { principalOf: () => principal });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  assert.deepEqual(Object.keys(app.history).sort(), ['cursor', 'redo', 'undo']);
  assert.equal('actions' in app.history, false);
  assert.equal('events' in app.history, false);
});

test('inverse and redo may each translate to one atomic batch under one history transition', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db);
  const batch = ({ fact }, value) => ({ actions: [
    { type: 'document.set', payload: { value: fact[value] } },
    { type: 'explicit.eligible', payload: { marker: value } },
  ] });
  const history = durableHistory({ authorize: () => true, actions: { 'document.set': {
    inverse: (context) => batch(context, 'before'), redo: (context) => batch(context, 'after'),
  } } });
  const server = makeServer(db, history);
  await set(server, { actionId: 'batch-a1', value: 2, before: 1, session: 'tab-a' });
  const undone = await historyMove(server, 'undo', { scope, principal, session: 'tab-a' });
  const redone = await historyMove(server, 'redo', { scope, principal, session: 'tab-a' });
  assert.equal(undone.ok, true); assert.equal(undone.events.length, 2);
  assert.equal(redone.ok, true); assert.equal(redone.events.length, 2);
  assert.deepEqual(db.prepare("SELECT actionType, operation FROM _ActionReceipt WHERE operation != 'action' ORDER BY historyOrder").all().map((row) => ({ ...row })), [
    { actionType: '$batch', operation: 'undo' }, { actionType: '$batch', operation: 'redo' },
  ]);
});

test('later translated batch child failure rolls back events, receipt, and cursor', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db);
  const history = durableHistory({ authorize: () => true, actions: { 'document.set': {
    inverse: () => ({ actions: [
      { type: 'document.set', payload: { value: 0 } }, { type: 'fail.late', payload: {} },
    ] }),
    redo: () => ({ type: 'document.set', payload: { value: 1 } }),
  } } });
  const server = createServer({ db, history, authorize: () => true, handlers: {
    'document.set': ({ payload, scope: owningScope }) => owningScope === undefined
      ? [{ type: 'document.changed', scope, data: payload }]
      : ({ events: [{ type: 'document.changed', scope, data: payload }], privateFact: { before: 0, after: payload.value } }),
    'fail.late': () => { throw new Error('late failure'); },
  } });
  await set(server, { actionId: 'rollback-a1', value: 1, before: 0, session: 'tab-a' });
  const before = await server.history.cursor({ scope, principal, session: 'tab-a' });
  const result = await server.history.undo({ scope, principal, session: 'tab-a', actionId: 'rollback-u1', revision: before.revision });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _Log').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _ActionReceipt').get().count, 1);
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 0 });
});

test('translated batches reject malformed children, preserve duplicate children, and fail unknown types closed', async () => {
  for (const translated of [
    { actions: [{ type: 'explicit.eligible', payload: {}, actionId: 'forged' }] },
    { actions: [{ type: 'explicit.eligible', scope: 'Document:other', payload: {} }] },
  ]) {
    const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db);
    const history = durableHistory({ authorize: () => true, actions: { 'document.set': {
      inverse: () => translated, redo: () => ({ type: 'document.set', payload: { value: 1 } }),
    } } });
    const server = makeServer(db, history);
    await set(server, { actionId: 'malformed-a1', value: 1, before: 0, session: 'tab-a' });
    await assert.rejects(historyMove(server, 'undo', { scope, principal, session: 'tab-a' }));
    assert.equal(db.prepare('SELECT COUNT(*) count FROM _ActionReceipt').get().count, 1);
  }

  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db);
  const history = durableHistory({ authorize: () => true, actions: { 'document.set': {
    inverse: () => ({ actions: [
      { type: 'explicit.eligible', payload: { marker: 1 } },
      { type: 'explicit.eligible', payload: { marker: 2 } },
    ] }),
    redo: () => ({ type: 'document.set', payload: { value: 1 } }),
  } } });
  const server = makeServer(db, history);
  await set(server, { actionId: 'duplicate-a1', value: 1, before: 0, session: 'tab-a' });
  assert.equal((await historyMove(server, 'undo', { scope, principal, session: 'tab-a' })).events.length, 2);

  const unknownDb = new DatabaseSync(':memory:'); executeFrameworkDDL(unknownDb);
  const unknownHistory = durableHistory({ authorize: () => true, actions: { 'document.set': {
    inverse: () => ({ actions: [{ type: 'unknown.translated', payload: {} }] }),
    redo: () => ({ type: 'document.set', payload: { value: 1 } }),
  } } });
  const unknownServer = makeServer(unknownDb, unknownHistory);
  await set(unknownServer, { actionId: 'unknown-a1', value: 1, before: 0, session: 'tab-a' });
  const unknown = await historyMove(unknownServer, 'undo', { scope, principal, session: 'tab-a' });
  assert.equal(unknown.failure.category, 'unknown-action');
  assert.equal(unknownDb.prepare('SELECT COUNT(*) count FROM _ActionReceipt').get().count, 1);
  assert.partialDeepStrictEqual(await unknownServer.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 0 });
});

test('translated batch projection failure and concurrent cursor change leave its history transition untouched', async () => {
  const projectionDb = new DatabaseSync(':memory:'); executeFrameworkDDL(projectionDb);
  const projectionHistory = durableHistory({ authorize: () => true, actions: { 'document.set': {
    inverse: () => ({ actions: [{ type: 'explicit.eligible', payload: {} }] }),
    redo: () => ({ type: 'document.set', payload: { value: 1 } }),
  } } });
  const projectionServer = createServer({
    db: projectionDb,
    history: projectionHistory,
    authorize: () => true,
    pipeline: durableMutationVariant({ projectionConsumers: [{
      eventTypes: ['explicit.changed'], apply: () => { throw new Error('projection failed'); },
    }] }),
    handlers: {
      'document.set': ({ payload, scope: owningScope }) => owningScope === undefined
        ? [{ type: 'document.changed', scope, data: payload }]
        : ({
            events: [{ type: 'document.changed', scope, data: payload }],
            privateFact: { before: payload.before, after: payload.value },
          }),
      'explicit.eligible': () => [{ type: 'explicit.changed', scope, data: {} }],
    },
  });
  await set(projectionServer, { actionId: 'projection-a1', value: 1, before: 0, session: 'tab-a' });
  const projection = await historyMove(projectionServer, 'undo', { scope, principal, session: 'tab-a' });
  assert.equal(projection.ok, false);
  assert.equal(projectionDb.prepare('SELECT COUNT(*) count FROM _ActionReceipt').get().count, 1);
  assert.partialDeepStrictEqual(await projectionServer.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 0 });

  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db);
  let releaseTranslation;
  const translated = new Promise((resolve) => { releaseTranslation = resolve; });
  const history = durableHistory({ authorize: () => true, actions: { 'document.set': {
    inverse: async () => { await translated; return { actions: [{ type: 'explicit.eligible', payload: {} }] }; },
    redo: () => ({ type: 'document.set', payload: { value: 1 } }),
  } } });
  const server = makeServer(db, history);
  await set(server, { actionId: 'concurrent-a1', value: 1, before: 0, session: 'tab-a' });
  const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  const move = server.history.undo({ scope, principal, session: 'tab-a', actionId: 'concurrent-u1', revision: cursor.revision });
  await set(server, { actionId: 'concurrent-a2', value: 2, before: 1, session: 'tab-a' });
  releaseTranslation();
  const stale = await move;
  assert.equal(stale.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _ActionReceipt').get().count, 2);
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 2, redo: 0 });
});

test('missing or malformed private facts and translator throws fail closed', async () => {
  for (const damage of ['missing', 'malformed', 'throws']) {
    const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db);
    const history = durableHistory({ authorize: () => true, actions: { 'document.set': {
      inverse: damage === 'throws' ? () => { throw new Error('translator failed'); } : ({ fact }) => ({ type: 'document.set', payload: { value: fact.before } }),
      redo: ({ fact }) => ({ type: 'document.set', payload: { value: fact.after } }),
    } } });
    const server = makeServer(db, history);
    await set(server, { actionId: `${damage}-a1`, value: 1, before: 0, session: 'tab-a' });
    if (damage === 'missing') db.prepare('DELETE FROM _PrivateActionFact').run();
    if (damage === 'malformed') db.prepare("UPDATE _PrivateActionFact SET fact = '{}'").run();
    await assert.rejects(historyMove(server, 'undo', { scope, principal, session: 'tab-a' }));
    assert.equal(db.prepare('SELECT COUNT(*) count FROM _ActionReceipt').get().count, 1);
    assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 0 });
  }
});

test('a new action after undo truncates that session redo stack', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db);
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });
  await set(server, { actionId: 'a2', value: 2, before: 1, session: 'tab-a' });
  await historyMove(server, 'undo', { scope, principal, session: 'tab-a' });
  await set(server, { actionId: 'a3', value: 3, before: 1, session: 'tab-a' });

  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 2, redo: 0 });
  const redo = await historyMove(server, 'redo', { scope, principal, session: 'tab-a' });
  assert.equal(redo.empty, true);
});

test('undeclared action defaults excluded when no history rule makes it undoable', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db);
  const result = await server.dispatch({
    actionId: 'text-a1',
    type: 'Document.body.apply',
    payload: { id: '1', operation: ['workbench.text'] },
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  assert.equal(result.ok, true);
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 0, redo: 0 });
});

test('generated CRDT .apply is excluded via cursorPolicy', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([['Document.body.apply', 'excluded']]);
  const server = makeServer(db, undefined, cursorPolicy);
  const result = await server.dispatch({
    actionId: 'text-a1',
    type: 'Document.body.apply',
    payload: { id: '1', operation: ['workbench.text'] },
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  assert.equal(result.ok, true);
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 0, redo: 0 });
});

test('non-.apply action explicitly excluded via cursorPolicy', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([['explicit.excluded', 'excluded']]);
  const server = makeServer(db, undefined, cursorPolicy);
  const result = await server.dispatch({
    actionId: 'excl-a1',
    type: 'explicit.excluded',
    payload: { value: 1 },
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  assert.equal(result.ok, true);
  const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  assert.partialDeepStrictEqual(cursor, { undo: 0, redo: 0 });
});

test('cursorPolicy cannot make an undeclared action undoable', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([['explicit.eligible', 'eligible']]);
  const server = makeServer(db, undefined, cursorPolicy);
  const result = await server.dispatch({
    actionId: 'elig-a1',
    type: 'explicit.eligible',
    payload: { value: 1 },
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  assert.equal(result.ok, true);
  const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  assert.partialDeepStrictEqual(cursor, { undo: 0, redo: 0 });
});

test('invalid cursorPolicy value throws at startup', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([['document.set', 'invalid']]);
  assert.throws(
    () => makeServer(db, undefined, cursorPolicy),
    /cursorPolicy: invalid policy 'invalid'/,
  );
});

test('cursorPolicy must be a Map if provided', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  assert.throws(
    () => makeServer(db, undefined, {}),
    /cursorPolicy must be a Map/,
  );
});

test('request history cannot override cursorPolicy', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([['Document.body.apply', 'excluded']]);
  const server = makeServer(db, undefined, cursorPolicy);
  const result = await server.dispatch({
    actionId: 'no-override',
    type: 'Document.body.apply',
    payload: { id: '1', operation: ['workbench.text'] },
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  assert.equal(result.ok, true);
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 0, redo: 0 });
});

test('excluded action receipt has action metadata', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([['explicit.excluded', 'excluded']]);
  const server = makeServer(db, undefined, cursorPolicy);
  await server.dispatch({
    actionId: 'excl-meta',
    type: 'explicit.excluded',
    payload: { value: 42 },
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  const row = db.prepare(
    'SELECT actionType, actionData, principalKey, sessionId FROM _ActionReceipt WHERE actionId = ?',
  ).get('excl-meta');
  assert.equal(row.actionType, 'explicit.excluded');
  assert.ok(row.actionData);
  assert.equal(row.principalKey, 'user:u1');
  assert.equal(row.sessionId, 'tab-a');
});

test('sessionless action receipt has metadata without principalKey or sessionId', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db);
  await server.dispatch({
    actionId: 'sessionless-a1',
    type: 'document.set',
    payload: { value: 1 },
    principal,
    scope,
  });
  const row = db.prepare(
    'SELECT actionType, actionData, principalKey, sessionId FROM _ActionReceipt WHERE actionId = ?',
  ).get('sessionless-a1');
  assert.equal(row.actionType, 'document.set');
  assert.ok(row.actionData);
  assert.equal(row.principalKey, 'user:u1');
  assert.equal(row.sessionId, null);
});

test('sessionless excluded action receipt has metadata', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([['explicit.excluded', 'excluded']]);
  const server = makeServer(db, undefined, cursorPolicy);
  await server.dispatch({
    actionId: 'sessless-excl',
    type: 'explicit.excluded',
    payload: { value: 99 },
    principal,
    scope,
  });
  const row = db.prepare(
    'SELECT actionType, actionData, principalKey, sessionId, operation FROM _ActionReceipt WHERE actionId = ?',
  ).get('sessless-excl');
  assert.equal(row.actionType, 'explicit.excluded');
  assert.ok(JSON.parse(row.actionData));
  assert.equal(row.principalKey, 'user:u1');
  assert.equal(row.sessionId, null);
  assert.equal(row.operation, 'action');
});

test('durable history retains its legacy principal key grammar', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db);
  const result = await server.dispatch({
    actionId: 'legacy-principal', type: 'document.set', payload: { value: 1 },
    principal: { type: 'robot', id: 7 }, scope, history: { session: 'tab-a' },
  });
  assert.equal(result.ok, true);
  assert.equal(
    db.prepare('SELECT principalKey FROM _ActionReceipt WHERE actionId = ?').get('legacy-principal').principalKey,
    'robot:7',
  );
});

test('mixed batch: excluded action excludes cursor entry for whole batch', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([
    ['explicit.excluded', 'excluded'],
    ['document.set', 'eligible'],
  ]);
  const server = makeServer(db, undefined, cursorPolicy);
  const result = await server.dispatchBatch({
    actionId: 'batch-mixed',
    actions: [
      { type: 'document.set', payload: { value: 1 } },
      { type: 'explicit.excluded', payload: { value: 99 } },
    ],
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  assert.equal(result.ok, true);
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 0, redo: 0 });
});

test('multi-event cursor shows one cursor entry per eligible action', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([
    ['document.set', 'eligible'],
    ['explicit.excluded', 'excluded'],
  ]);
  const server = makeServer(db, undefined, cursorPolicy);
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });
  await server.dispatch({
    actionId: 'excl1',
    type: 'explicit.excluded',
    payload: { value: 99 },
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  await set(server, { actionId: 'a2', value: 2, before: 1, session: 'tab-a' });
  await server.dispatch({
    actionId: 'excl2',
    type: 'explicit.excluded',
    payload: { value: 100 },
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 2, redo: 0 });
});

test('missing cursor reconstructs only eligible receipts and undo targets the latest', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([['explicit.excluded', 'excluded']]);
  const server = makeServer(db, undefined, cursorPolicy);
  await set(server, { actionId: 'eligible-a1', value: 1, before: 0, session: 'tab-a' });
  await server.dispatch({
    actionId: 'excluded-a1', type: 'explicit.excluded', payload: { value: 99 },
    principal, scope, history: { session: 'tab-a' },
  });
  await set(server, { actionId: 'eligible-a2', value: 2, before: 1, session: 'tab-a' });
  db.prepare('DELETE FROM _HistoryCursor').run();

  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 2, redo: 0 });
  const undone = await historyMove(server, 'undo', { scope, principal, session: 'tab-a' });
  assert.equal(undone.ok, true);
  assert.equal(undone.events[0].data.value, 1);
});

test('missing cursor reconstructs undo and redo transitions', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db);
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });
  await set(server, { actionId: 'a2', value: 2, before: 1, session: 'tab-a' });
  await historyMove(server, 'undo', { scope, principal, session: 'tab-a' });
  db.prepare('DELETE FROM _HistoryCursor').run();

  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 1 });
  const redone = await historyMove(server, 'redo', { scope, principal, session: 'tab-a' });
  assert.equal(redone.ok, true);
  db.prepare('DELETE FROM _HistoryCursor').run();
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 2, redo: 0 });
});

test('history inverse rejects a translated action in another scope', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const history = durableHistory({
    authorize: () => true,
    actions: { 'document.set': {
      inverse: () => ({ type: 'document.set', scope: 'Document:other', payload: { value: 0 } }),
      redo: () => ({ type: 'document.set', payload: { value: 1 } }),
    } },
  });
  const server = makeServer(db, history);
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });

  await assert.rejects(
    historyMove(server, 'undo', { scope, principal, session: 'tab-a' }),
    /must keep the original history scope/,
  );
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 1);
});

test('history authorization fails closed', async () => {
  assert.throws(
    () => durableHistory({ inverse: () => ({ type: 'x' }) }),
    /requires an authorize function/,
  );
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db, historyDescriptor(() => false));
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });

  await assert.rejects(server.history.actions({ scope, principal }), { status: 403 });
  await assert.rejects(server.history.undo({ scope, principal, session: 'tab-a' }), { status: 403 });
});

test('annotated history reads deny through privateHistoryScopes before materialization', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const registry = annotatedRegistry(new Set(['AnnotatedDoc']), ['AnnotatedDoc.body.operation']);
  const server = makeServer(db, undefined, undefined, registry);
  await server.dispatch({
    actionId: 'annotated-a1', type: 'AnnotatedDoc.body.operation', scope: 'AnnotatedDoc:1', principal,
    payload: { operation: ['secret operation'], family: { text: 'secret body' } }, history: { session: 'tab-a' },
  });

  // Read privacy is the declaration-derived privateHistoryScopes set — the
  // actions()/events() boundary denies before any receipt/event materializes.
  await assert.rejects(server.history.actions({ scope: 'AnnotatedDoc:1', principal }), { status: 403 });
  await assert.rejects(server.history.events({ scope: 'AnnotatedDoc:1', principal }), { status: 403 });
  // Movement is policy-governed, not scope-scanned (#145 S5): the barrier
  // payload keeps the cursor empty but is NOT a move denial.
  const undone = await historyMove(server, 'undo', { scope: 'AnnotatedDoc:1', principal, session: 'tab-a' });
  assert.equal(undone.ok, true, undone.failure?.message);
  assert.partialDeepStrictEqual(await server.history.cursor({ scope: 'AnnotatedDoc:1', principal, session: 'tab-a' }), { undo: 0, redo: 0 });
});

test('history reads do not scan receipts for annotated refs (retired scanner is gone)', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const registry = annotatedRegistry(new Set(['AnnotatedDoc']), ['AnnotatedDoc.body.operation']);
  const server = makeServer(db, undefined, undefined, registry);
  await server.dispatch({
    actionId: 'mixed-a1', type: 'mixed.set', scope: 'custom:1', principal,
    payload: { text: 'secret canonical fact' }, history: { session: 'tab-a' },
  });

  // #145 S5: receipt/event-ref scanning for annotated material is gone from
  // movement AND read-denial; only the declaration-derived privateHistoryScopes
  // deny the actions()/events() boundary. A scope outside that set stays
  // readable even after retention prunes receipts.
  await retentionPrune(db, '9999-01-01T00:00:00.000Z');
  const actions = await server.history.actions({ scope: 'custom:1', principal, after: 99, limit: 1 });
  assert.ok(Array.isArray(actions.events ?? actions), 'reads on an unlisted scope are not scanner-denied');
});

test('a generic move at an annotated scope is policy-governed, not scope-blocked', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const registry = annotatedRegistry(new Set(['AnnotatedDoc']), ['AnnotatedDoc.body.operation']);
  const server = makeServer(db, undefined, undefined, registry);
  const annotatedScope = 'AnnotatedDoc:1';
  await assert.rejects(server.history.actions({ scope: annotatedScope, principal }), { status: 403 });
  await server.dispatch({
    actionId: 'zero-event', type: 'document.set', scope: annotatedScope, principal,
    payload: { value: 'ok', before: null }, history: { session: 'tab-a' },
  });
  const result = await historyMove(server, 'undo', { scope: annotatedScope, principal, session: 'tab-a' });
  assert.equal(result.ok, true, result.failure?.message);
});

test('history rejects an inverse translated to an annotated operation', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const history = durableHistory({
    authorize: () => true,
    actions: { 'document.set': {
      inverse: ({ action }) => ({ type: 'AnnotatedDoc.body.operation', scope: action.scope, payload: {} }),
      redo: ({ action }) => ({ type: 'AnnotatedDoc.body.operation', scope: action.scope, payload: {} }),
    } },
  });
  const server = makeServer(db, history, undefined, annotatedRegistry(new Set(['AnnotatedDoc']), ['AnnotatedDoc.body.operation']));
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });

  // #145 S5: an ordinary inverse may not re-target a contribution-policy action
  // (the policy owns its chain); the guard throws forbidden before any dispatch.
  await assert.rejects(historyMove(server, 'undo', { scope, principal, session: 'tab-a' }), { status: 403 });
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 0 });
});

test('undoToPoint rejects an inverse translated to an annotated operation', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db);
  const history = durableHistory({ authorize: () => true, actions: { 'document.set': {
    inverse: () => ({ type: 'AnnotatedDoc.body.operation', payload: {} }), redo: () => ({ type: 'document.set', payload: {} }),
  } } });
  const server = makeServer(db, history, undefined, annotatedRegistry(new Set(['AnnotatedDoc']), ['AnnotatedDoc.body.operation']));
  await set(server, { actionId: 'point-annotated-a1', value: 1, before: 0, session: 'tab-a' });
  const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  await assert.rejects(server.history.undoToPoint({ scope, principal, session: 'tab-a', actionId: 'point-annotated-u1', revision: cursor.revision, seq: 0 }), { status: 403 });
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 0 });
});

test('in-transaction history denial rolls back inverse event, receipt, and cursor', async () => {
  let undoChecks = 0;
  const authorize = ({ operation }) => operation !== 'undo' || ++undoChecks === 1;
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db, historyDescriptor(authorize));
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });

  const result = await historyMove(server, 'undo', { scope, principal, session: 'tab-a' });

  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'denied');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 1);
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 0 });
});

test('cursor revision rejects stale concurrent undo without moving history', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db); const server = makeServer(db);
  await set(server, { actionId: 'stale-a1', value: 1, before: 0, session: 'tab-a' });
  const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  const first = await server.history.undo({ scope, principal, session: 'tab-a', actionId: 'stale-u1', revision: cursor.revision });
  assert.equal(first.ok, true);
  await assert.rejects(server.history.undo({ scope, principal, session: 'tab-a', actionId: 'stale-u2', revision: cursor.revision }), { status: 409 });
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 0, redo: 1 });
});

test('undo retry is receipt-idempotent even after cursor moved', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db); const server = makeServer(db);
  await set(server, { actionId: 'retry-a1', value: 1, before: 0, session: 'tab-a' });
  const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  const args = { scope, principal, session: 'tab-a', actionId: 'retry-u1', revision: cursor.revision };
  assert.equal((await server.history.undo(args)).deduped, false);
  assert.equal((await server.history.undo(args)).deduped, true);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM _ActionReceipt WHERE operation = 'undo'").get().count, 1);
});

test('moves require caller action id and current revision, including empty retries', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db); const server = makeServer(db);
  const args = { scope, principal, session: 'tab-a' };
  await assert.rejects(server.history.undo(args), /actionId must be a non-empty string/);
  await assert.rejects(server.history.undo({ ...args, actionId: 'empty-u1' }), /revision must be a non-empty string/);
  const cursor = await server.history.cursor(args);
  const empty = await server.history.undo({ ...args, actionId: 'empty-u1', revision: cursor.revision });
  assert.equal(empty.empty, true);
  assert.equal((await server.history.undo({ ...args, actionId: 'empty-u1', revision: cursor.revision })).empty, true);
});

test('redo reauthorizes and retries its committed receipt', async () => {
  let allowRedo = true;
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db);
  const server = makeServer(db, historyDescriptor(({ operation }) => operation !== 'redo' || allowRedo));
  await set(server, { actionId: 'redo-a1', value: 1, before: 0, session: 'tab-a' });
  await historyMove(server, 'undo', { scope, principal, session: 'tab-a' });
  const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  const args = { scope, principal, session: 'tab-a', actionId: 'redo-r1', revision: cursor.revision };
  assert.equal((await server.history.redo(args)).deduped, false);
  allowRedo = false;
  await assert.rejects(server.history.redo(args), { status: 403 });
});

test('malformed stored cursor fails closed before a move can dispatch', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db); const server = makeServer(db);
  await set(server, { actionId: 'malformed-a1', value: 1, before: 0, session: 'tab-a' });
  db.prepare("UPDATE _HistoryCursor SET past = '[null]' WHERE scope = ?").run(scope);
  await assert.rejects(server.history.cursor({ scope, principal, session: 'tab-a' }), /malformed history cursor past/);
  await assert.rejects(server.history.undo({ scope, principal, session: 'tab-a', actionId: 'malformed-u1', revision: 'x' }), /malformed history cursor past/);
});

test('machine actions preserve provenance but never enter a human cursor', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db); const server = makeServer(db);
  await server.dispatch({ actionId: 'machine-a1', type: 'document.set', payload: { value: 1 },
    principal: { type: 'apiKey', id: 'worker-1' }, scope, history: { session: 'tab-a' } });
  assert.equal(db.prepare("SELECT principalKey FROM _ActionReceipt WHERE actionId = 'machine-a1'").get().principalKey, 'apiKey:worker-1');
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 0, redo: 0 });
});

test('retention atomically retires cursor targets and redacts action payload', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db); const server = makeServer(db);
  await set(server, { actionId: 'old-a1', value: 'secret', before: 0, session: 'tab-a' });
  await retentionPrune(db, '9999-01-01T00:00:00.000Z');
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 0, redo: 0 });
  assert.equal(db.prepare("SELECT actionData FROM _ActionReceipt WHERE actionId = 'old-a1'").get().actionData, null);
  assert.equal((await server.dispatch({ actionId: 'old-a1', type: 'document.set', payload: { value: 9 }, principal, scope })).deduped, true);
});

test('retention erases private facts and cursor recovery cannot resurrect a redacted target', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db); const server = makeServer(db);
  await set(server, { actionId: 'retired-a1', value: 'after', before: 'before', session: 'tab-a' });
  await retentionPrune(db, '9999-01-01T00:00:00.000Z');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _PrivateActionFact').get().count, 0);
  db.prepare('DELETE FROM _HistoryCursor').run();
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 0, redo: 0 });
});

test('empty move receipt prevents the same retry id from moving later history', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db); const server = makeServer(db);
  const emptyCursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  const args = { scope, principal, session: 'tab-a', actionId: 'empty-u1', revision: emptyCursor.revision };
  assert.equal((await server.history.undo(args)).empty, true);
  await set(server, { actionId: 'after-empty-a1', value: 1, before: 0, session: 'tab-a' });
  assert.equal((await server.history.undo(args)).deduped, true);
  assert.partialDeepStrictEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 0 });
});

test('empty-cursor undo returns a receipt-shaped no-op instead of a missing receipt (#230)', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db); const server = makeServer(db);
  const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  const result = await server.history.undo({ scope, principal, session: 'tab-a', actionId: 'empty-receipt-u1', revision: cursor.revision });

  assert.equal(result.empty, true);
  assert.equal(result.deduped, false);
  assert.deepEqual(Object.keys(result.resultData).sort(), ['actionId', 'confirmedThrough']);
  assert.equal(result.resultData.actionId, 'empty-receipt-u1');
  assert.ok(Number.isSafeInteger(result.resultData.confirmedThrough));

  // The HTTP skin reconciles against resultData; the same values are persisted on
  // the $history.empty receipt so a retry also answers cleanly.
  const row = db.prepare("SELECT actionType, resultData FROM _ActionReceipt WHERE actionId = 'empty-receipt-u1'").get();
  assert.equal(row.actionType, '$history.empty');
  assert.deepEqual(JSON.parse(row.resultData), {
    actionId: 'empty-receipt-u1',
    confirmedThrough: result.resultData.confirmedThrough,
  });
  const retry = await server.history.undo({ scope, principal, session: 'tab-a', actionId: 'empty-receipt-u1', revision: cursor.revision });
  assert.equal(retry.empty, true);
  assert.deepEqual(retry.resultData, result.resultData);
});

test('malformed persisted cursor fails closed without a history write', async () => {
  const db = new DatabaseSync(':memory:'); executeFrameworkDDL(db); const server = makeServer(db);
  await set(server, { actionId: 'malformed-a1', value: 1, before: 0, session: 'tab-a' });
  db.prepare("UPDATE _HistoryCursor SET past = 'not-json'").run();
  await assert.rejects(server.history.cursor({ scope, principal, session: 'tab-a' }));
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _ActionReceipt').get().count, 1);
});

test('receipt history order is a per-scope monotonic counter that survives erasure (#124)', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    executeFrameworkDDL(db);
    // Pre-counter receipt rows — the shape an upgraded database already has.
    const insertLegacy = db.prepare(
      `INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs, historyOrder, actionType, actionData, operation)
       VALUES (?, ?, ?, '[]', ?, ?, ?, 'action')`,
    );
    insertLegacy.run(scope, 'legacy-1', '2026-01-01T00:00:00.000Z', 1, 'note.keep', JSON.stringify({ author: 'keeper' }));
    insertLegacy.run(scope, 'legacy-2', '2026-01-02T00:00:00.000Z', 2, 'note.keep', JSON.stringify({ author: 'keeper' }));
    insertLegacy.run(scope, 'legacy-3', '2026-01-03T00:00:00.000Z', 3, 'note.gone', JSON.stringify({ author: 'gone-1' }));

    // The first post-upgrade commit seeds the counter from the retained maximum.
    assert.equal(insertReceipt(db, scope, 'next-4', '2026-02-01T00:00:00.000Z', [], {
      actionType: 'note.gone', actionData: { author: 'gone-1' },
    }), 4);

    // Erase the two highest-order receipts through the real erasure path —
    // applyErasureDirective deletes receipt rows outright. MAX+1 would hand
    // their order values out again, and keyset pagination
    // (historyOrder > :after) has already consumed them as reader cursors.
    const directive = prepareErasureDirective(db, {
      owningScope: scope,
      subject: 'gone-1',
      census: {
        version: 1,
        rules: [
          { kind: 'action', type: 'note.gone', disposition: 'target', identityPointers: ['/author'] },
          { kind: 'action', type: 'note.keep', disposition: 'retain', identityPointers: ['/author'] },
        ],
      },
    });
    await applyErasureDirective(db, directive, { scope, actionId: 'purge-1', actionContext: undefined });

    // The counter row itself survives erasure untouched and still forbids reuse.
    assert.equal(db.prepare('SELECT lastOrder FROM _HistoryOrderCounter WHERE scope = ?').get(scope).lastOrder, 4);
    assert.equal(insertReceipt(db, scope, 'next-5', '2026-03-01T00:00:00.000Z', []), 5);

    // Scopes allocate independently from their own counter rows.
    assert.equal(insertReceipt(db, 'Other:1', 'other-1', '2026-03-01T00:00:00.000Z', []), 1);

    // Retained rows keep their allocation order; erased rows are gone.
    assert.deepEqual(
      db.prepare('SELECT actionId FROM _ActionReceipt WHERE scope = ? ORDER BY historyOrder').all(scope).map((row) => row.actionId),
      ['legacy-1', 'legacy-2', 'next-5'],
    );
  } finally {
    db.close();
  }
});

test('framework DDL migrates a (scope, historyOrder) receipt index for ordered history reads (#124)', () => {
  const db = new DatabaseSync(':memory:');
  try {
    executeFrameworkDDL(db);
    const hasScopeHistoryIndex = db.prepare('PRAGMA index_list(_ActionReceipt)').all().some((index) => {
      const columns = db.prepare(`PRAGMA index_info("${String(index.name).replaceAll('"', '""')}")`).all().map((column) => column.name);
      return columns.length === 2 && columns[0] === 'scope' && columns[1] === 'historyOrder';
    });
    assert.equal(hasScopeHistoryIndex, true);
  } finally {
    db.close();
  }
});
