import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, { durableHistory, erasureDirective, erasureDirectivePreparation } from '../build/index.mjs';
import { generateFrameworkDDL, prepareErasureDirective } from '../build/internal.mjs';
import { frameworkTableNames } from '../build/server.mjs';
import { frameworkTableNamesWithoutAuthCompile } from '../build/framework-table-names.mjs';
import { defineSqliteSchema } from '../build/server.mjs';

// Fixture tables the tests create out-of-band (application domain tables plus
// the deliberately non-canonical underscore identifiers used to prove the
// erasure guard denies them) and the triggers they carry; declared through the
// externalTables/externalTriggers seams so the settled census attributes them
// to this schema. Declaring does not create them and does not grant write
// authority — the guard under test still denies every access.
// Boot now validates the settled census against SQLite (fail closed). Each
// test creates only the out-of-band tables/triggers it needs — including the
// deliberately non-canonical underscore identifiers — so declare exactly the
// objects present in its database. Declaring does not create them and does not
// grant the erasure guard any authority: the guard's own allowlist still
// decides every read and write. Framework-owned names keep their one authority.
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
  return defineSqliteSchema({ name: 'erasure-directive-fixtures', tables: [], externalTables, externalTriggers });
}

const scope = 'Project:project-1';
const oldData = JSON.stringify({ projectId: 'project-1', id: 'artefact-1', sensitive: 'remove-me' });
const refs = JSON.stringify([{ scope, seq: 1 }]);
const digest = (value) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(scope, 1, 'artefact.deleted', oldData, 'old-action', '2026-07-27T00:00:00.000Z');
  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?)').run(scope, 1);
  db.prepare(`INSERT INTO _ActionReceipt
    (scope, actionId, committedAt, eventRefs, historyOrder, actionType, actionData, principalKey, sessionId, operation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(scope, 'old-action', '2026-07-27T00:00:00.000Z', refs, 1, 'artefact.delete', JSON.stringify({ id: 'artefact-1' }), 'user:u1', 's1', 'action');
  db.prepare(`INSERT INTO _PrivateActionFact (scope, actionId, committedAt, fact, effects)
    VALUES (?, ?, ?, ?, ?)`)
    .run(scope, 'old-action', '2026-07-27T00:00:00.000Z', JSON.stringify({ before: { id: 'artefact-1', sensitive: 'remove-me' }, after: {} }), '[]');
  db.prepare('INSERT INTO _HistoryCursor (principalKey, sessionId, scope, past, future) VALUES (?, ?, ?, ?, ?)')
    .run('user:u1', 's1', scope,
      JSON.stringify([
        { rootActionId: 'before', headActionId: 'before' },
        { rootActionId: 'old-action', headActionId: 'old-action' },
        { rootActionId: 'old-action', headActionId: 'retained-head' },
        { rootActionId: 'after', headActionId: 'after' },
        { rootActionId: 'after', headActionId: 'old-action' },
      ]),
      JSON.stringify([
        { rootActionId: 'old-action', headActionId: 'old-action' },
        { rootActionId: 'later', headActionId: 'later' },
      ]));
  return db;
}

function directive(db, overrides = {}) {
  const receipt = db.prepare('SELECT * FROM _ActionReceipt WHERE scope = ? AND actionId = ?').get(scope, 'old-action');
  return erasureDirective({
    kind: 'workbench.erasure', version: 1, owningScope: scope, subject: 'artefact-1',
    actions: [{
      scope, actionId: 'old-action', historyOrder: receipt.historyOrder, committedAt: receipt.committedAt,
      receiptDigest: digest(JSON.stringify({ actionType: receipt.actionType, actionData: receipt.actionData, principalKey: receipt.principalKey, sessionId: receipt.sessionId, operation: receipt.operation, eventRefs: JSON.parse(receipt.eventRefs) })),
      events: [{ scope, seq: 1, actionId: 'old-action', eventType: 'artefact.deleted', committedAt: '2026-07-27T00:00:00.000Z', eventDataDigest: digest(oldData) }],
    }],
    census: { version: 1, rules: [
      { kind: 'action', type: 'artefact.delete', disposition: 'target', identityPointers: ['/id'] },
      { kind: 'event', type: 'artefact.deleted', disposition: 'target', identityPointers: ['/id'] },
      { kind: 'event', type: 'lifecycle.purged', disposition: 'retain', identityPointers: ['/id'] },
    ] },
    ...overrides,
  });
}

function app(db, makeDirective, erasure = true) {
  const privilege = erasure === true ? true : {
    tables: erasure.tables ?? ['DomainCleanup'], readTables: erasure.readTables ?? [], ...erasure,
  };
  return workbench({ db, schema: fixtureSchema(db), actions: [{
    type: 'lifecycle.purge', erasure: privilege, history: { cursor: 'excluded' }, authorize: () => true,
    handler(context) {
      return { events: [{ type: 'lifecycle.purged', scope, data: { done: true } }], directive: makeDirective(context.db) };
    },
  }] });
}

test('package prepares the exact frozen structural manifest from the transaction snapshot', () => {
  const db = fixture();
  const prepared = prepareErasureDirective(db, {
    owningScope: scope, subject: 'artefact-1', census: directive(db).census,
  });
  assert.deepEqual(prepared.actions, directive(db).actions);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.actions), true);
  assert.equal(Object.isFrozen(prepared.actions[0].events[0]), true);
});

test('package deep-freezes a shallow-frozen explicit manifest', () => {
  const db = fixture(); const shallow = { ...directive(db), actions: [{ ...directive(db).actions[0] }] };
  Object.freeze(shallow);
  const prepared = erasureDirective(shallow);
  assert.equal(Object.isFrozen(prepared.actions), true);
  assert.equal(Object.isFrozen(prepared.actions[0]), true);
  assert.equal(Object.isFrozen(prepared.actions[0].events), true);
  assert.equal(Object.isFrozen(prepared.census.rules[0]), true);
});

test('opted-in preparation receives only the validated manifest and joins the erasure transaction', async () => {
  const db = fixture();
  db.exec('CREATE TABLE DomainCleanup (id TEXT PRIMARY KEY, targetCount INTEGER NOT NULL)');
  let calls = 0; let escaped; let escapedActions; let observedActionId;
  const instance = app(db, (database) => erasureDirectivePreparation({
    owningScope: scope, subject: 'artefact-1', census: directive(database).census,
  }), { prepare({ writes, manifest }) {
    calls += 1; escaped = manifest; escapedActions = manifest.actions; observedActionId = manifest.actions[0].actionId;
    writes.insert('DomainCleanup', { id: 'cleanup', targetCount: manifest.actions.length });
    return { secret: 'must not become a dispatch result' };
  } });
  await instance.start();
  const first = await instance.dispatch({ actionId: 'purge-prepare', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(first.ok, true); assert.equal(calls, 1);
  assert.deepEqual({ ...db.prepare('SELECT * FROM DomainCleanup').get() }, { id: 'cleanup', targetCount: 1 });
  assert.equal(observedActionId, 'old-action');
  assert.throws(() => escaped.actions, /preparation|revoked/);
  assert.throws(() => Object.keys(escaped), /preparation|revoked/);
  assert.throws(() => escapedActions.length, /preparation|revoked/);
  assert.equal(JSON.stringify(first).includes('secret'), false);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM _ActionReceipt WHERE actionId = ?').get('purge-prepare')).includes('old-action'), false);
  const retry = await instance.dispatch({ actionId: 'purge-prepare', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(retry.ok, true); assert.equal(retry.deduped, true); assert.equal(calls, 1);
});

test('explicit application-owned underscore tables support atomic preparation reads, writes, and receipt retries', async () => {
  const db = fixture();
  db.exec('CREATE TABLE _ApplicationDeletion (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
  db.exec('CREATE TABLE _ApplicationCleanupOutbox (id TEXT PRIMARY KEY, deletionId TEXT NOT NULL)');
  db.prepare('INSERT INTO _ApplicationDeletion VALUES (?, ?)').run('deletion-1', 'ready');
  let calls = 0;
  const instance = app(db, (database) => erasureDirectivePreparation({
    owningScope: scope, subject: 'artefact-1', census: directive(database).census,
  }), {
    tables: ['_ApplicationCleanupOutbox'], readTables: ['_ApplicationDeletion'],
    prepare({ reads, writes }) {
      calls += 1;
      const [deletion] = reads.find('_ApplicationDeletion', { id: 'deletion-1' });
      assert.equal(deletion.status, 'ready');
      writes.insert('_ApplicationCleanupOutbox', { id: 'cleanup-1', deletionId: deletion.id });
    },
  });
  await instance.start();
  const action = { actionId: 'purge-underscore', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope };
  const first = await instance.dispatch(action);
  const retry = await instance.dispatch(action);
  assert.equal(first.ok, true); assert.equal(retry.ok, true); assert.equal(retry.deduped, true); assert.equal(calls, 1);
  assert.deepEqual({ ...db.prepare('SELECT * FROM _ApplicationCleanupOutbox').get() }, { id: 'cleanup-1', deletionId: 'deletion-1' });
});

test('every canonical package table remains denied to declared preparation reads and writes', async () => {
  assert.deepEqual(
    [...frameworkTableNamesWithoutAuthCompile].map((name) => name.toLowerCase()).sort(),
    [...frameworkTableNames].map((name) => name.toLowerCase()).sort(),
  );
  for (const operation of ['reads', 'writes']) {
    for (const table of frameworkTableNames) {
      const db = fixture();
      const erasure = operation === 'reads'
        ? { tables: [], readTables: [table], prepare({ reads }) { reads.find(table, { id: 'x' }); } }
        : { tables: [table], readTables: [], prepare({ writes }) { writes.delete(table, { id: 'x' }); } };
      const instance = app(db, directive, erasure);
      await instance.start();
      const result = await instance.dispatch({ actionId: `deny-${operation}-${table}`, type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
      assert.equal(result.ok, false, `${operation} ${table}`);
      assert.ok(db.prepare('SELECT 1 FROM _ActionReceipt WHERE actionId = ?').get('old-action'), `${operation} ${table}`);
    }
  }
});

test('private cursor tables are denied before valid reads or writes execute', async () => {
  for (const table of ['_ProjectedCursor', '_ConsumerCursor']) {
    for (const operation of ['reads', 'writes']) {
      const db = fixture();
      if (table === '_ProjectedCursor') db.prepare('INSERT INTO _ProjectedCursor VALUES (?, ?, ?)').run('Entity', 'field', 7);
      else db.prepare('INSERT INTO _ConsumerCursor VALUES (?, ?, ?)').run('consumer', scope, 7);
      let completed = false;
      const where = table === '_ProjectedCursor' ? { entity: 'Entity' } : { consumer: 'consumer' };
      const erasure = operation === 'reads'
        ? { tables: [], readTables: [table], prepare({ reads }) { reads.find(table, where); completed = true; } }
        : { tables: [table], readTables: [], prepare({ writes }) { writes.delete(table, where); completed = true; } };
      const instance = app(db, directive, erasure); await instance.start();
      const result = await instance.dispatch({ actionId: `deny-cursor-${operation}-${table}`, type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
      assert.equal(result.ok, false); assert.equal(completed, false);
      assert.equal(db.prepare(`SELECT lastSeq FROM ${table}`).get().lastSeq, 7);
    }
  }
});

test('package-table case variants and non-canonical underscore identifiers remain denied', async () => {
  const cases = [
    { table: '_lOg' },
    { table: '_applicationPrivate', create: true, canonical: '_ApplicationPrivate' },
    { table: '__ApplicationPrivate', create: true },
    { table: '_Application Private', create: true },
    { table: '_Application"Private', create: true },
  ];
  for (const entry of cases) {
    const db = fixture();
    if (entry.create) db.exec(`CREATE TABLE "${(entry.canonical ?? entry.table).replaceAll('"', '""')}" (id TEXT)`);
    const instance = app(db, directive, {
      tables: [entry.table], readTables: [], prepare({ writes }) { writes.delete(entry.table, { id: 'x' }); },
    });
    await instance.start();
    const result = await instance.dispatch({ actionId: `deny-tricky-${cases.indexOf(entry)}`, type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
    assert.equal(result.ok, false, entry.table);
  }
});

test('preparation receives authentic frozen action/subject context with canonical commit time and bound equality reads only transiently', async () => {
  const db = fixture();
  db.exec('CREATE TABLE DomainSource (id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, secret TEXT NOT NULL)');
  db.exec('CREATE TABLE DomainCleanup (id TEXT PRIMARY KEY, targetCount INTEGER NOT NULL)');
  db.prepare('INSERT INTO DomainSource VALUES (?, ?, ?)').run("hostile' OR 1=1 --", 'owner-1', 'domain-secret');
  db.prepare('INSERT INTO DomainSource VALUES (?, ?, ?)').run('other', 'owner-1', 'other-secret');
  let escaped; let escapedContext; let escapedAction; let escapedRow; let payloadGetter; let observed;
  const payload = { entityKind: 'record', rootId: 'artefact-1', deletionId: 'deletion-1', marker: 'payload-secret' };
  const instance = app(db, (database) => erasureDirectivePreparation({
    owningScope: scope, subject: 'artefact-1', census: directive(database).census,
  }), { readTables: ['DomainSource'], prepare({ reads, writes, context }) {
    escaped = reads; escapedContext = context; escapedAction = context.action;
    assert.equal(Object.isFrozen(context.action), true);
    assert.throws(() => { context.action.committedAt = 'substituted'; }, TypeError);
    payloadGetter = Object.getOwnPropertyDescriptor(escapedAction, 'payload').get;
    observed = {
      action: {
        id: context.action.id, type: context.action.type, scope: context.action.scope, operation: context.action.operation,
        committedAt: context.action.committedAt,
        payload: { ...context.action.payload }, principal: { ...context.action.principal },
      },
      subject: { ...context.subject },
    };
    const rows = reads.find('DomainSource', { id: "hostile' OR 1=1 --" });
    escapedRow = rows[0];
    assert.equal(rows.length, 1); assert.equal(rows[0].secret, 'domain-secret');
    assert.equal(Object.isFrozen(rows), true); assert.equal(Object.isFrozen(rows[0]), true);
    writes.insert('DomainCleanup', { id: context.action.payload.deletionId, targetCount: rows.length });
  } });
  await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-context', type: 'lifecycle.purge', payload, principal: { type: 'user', id: 'actor-1' }, scope });
  assert.equal(result.ok, true);
  const originReceipt = db.prepare('SELECT * FROM _ActionReceipt WHERE actionId = ?').get('purge-context');
  const originEvent = db.prepare('SELECT * FROM _Log WHERE actionId = ?').get('purge-context');
  assert.deepEqual(observed, {
    action: { id: 'purge-context', type: 'lifecycle.purge', scope, operation: 'erasure', committedAt: originReceipt.committedAt, payload, principal: { type: 'user', id: 'actor-1' } },
    subject: { owningScope: scope, id: 'artefact-1' },
  });
  assert.equal(observed.action.committedAt, originEvent.committedAt);
  assert.notEqual(observed.action.committedAt, '2026-07-27T00:00:00.000Z');
  assert.throws(() => escapedContext.action, /preparation|revoked/);
  assert.throws(() => Object.keys(escapedAction), /preparation|revoked/);
  assert.throws(() => payloadGetter(), /preparation|revoked/);
  assert.throws(() => escapedRow.secret, /preparation|revoked/);
  assert.throws(() => escaped.find('DomainSource', { ownerId: 'owner-1' }), /available only during erasure preparation/);
  const durable = JSON.stringify({
    log: db.prepare('SELECT * FROM _Log WHERE actionId = ?').all('purge-context'),
    receipt: db.prepare('SELECT * FROM _ActionReceipt WHERE actionId = ?').get('purge-context'), result,
  });
  assert.equal(durable.includes('payload-secret'), false);
  assert.equal(durable.includes('actor-1'), false);
  assert.equal(durable.includes('domain-secret'), false);
  assert.equal(durable.includes('"context"'), false);
});

test('preparation action context is snapshotted before the handler can mutate its request', async () => {
  const db = fixture(); let observed;
  const instance = workbench({ db, schema: fixtureSchema(db), actions: [{
    type: 'lifecycle.purge', erasure: { tables: [], readTables: [], prepare({ context }) { observed = JSON.parse(JSON.stringify(context)); } },
    history: { cursor: 'excluded' }, authorize: () => true,
    handler(context) {
      context.payload.rootId = 'handler-substitution';
      context.principal.id = 'handler-substitution';
      return { events: [{ type: 'lifecycle.purged', scope, data: { done: true } }], directive: erasureDirectivePreparation({
        owningScope: scope, subject: 'artefact-1', census: directive(context.db).census,
      }) };
    },
  }] });
  await instance.start();
  const result = await instance.dispatch({
    actionId: 'purge-snapshot', type: 'lifecycle.purge', payload: { rootId: 'artefact-1' },
    principal: { type: 'user', id: 'actor-1' }, scope,
  });
  assert.equal(result.ok, true);
  assert.equal(observed.action.payload.rootId, 'artefact-1');
  assert.equal(observed.action.principal.id, 'actor-1');
});

test('preparation action context is snapshotted before authorization can mutate its request', async () => {
  const db = fixture(); let observed; let authorizationCalls = 0;
  const instance = workbench({ db, schema: fixtureSchema(db), actions: [{
    type: 'lifecycle.purge', erasure: { tables: [], readTables: [], prepare({ context }) { observed = JSON.parse(JSON.stringify(context)); } },
    history: { cursor: 'excluded' },
    authorize({ payload, principal }) {
      authorizationCalls += 1;
      payload.rootId = `authorization-substitution-${authorizationCalls}`;
      principal.id = `authorization-substitution-${authorizationCalls}`;
      return true;
    },
    handler(context) {
      return { events: [{ type: 'lifecycle.purged', scope, data: { done: true } }], directive: erasureDirectivePreparation({
        owningScope: scope, subject: 'artefact-1', census: directive(context.db).census,
      }) };
    },
  }] });
  await instance.start();
  const result = await instance.dispatch({
    actionId: 'purge-authorization-snapshot', type: 'lifecycle.purge', payload: { rootId: 'artefact-1' },
    principal: { type: 'user', id: 'actor-1' }, scope,
  });
  assert.equal(result.ok, true); assert.equal(authorizationCalls, 2);
  assert.equal(observed.action.payload.rootId, 'artefact-1');
  assert.equal(observed.action.principal.id, 'actor-1');
});

test('preparation reads reject undeclared, internal, case-variant, temp, view, and raw predicates', async () => {
  const cases = [
    { name: 'undeclared', setup(db) { db.exec('CREATE TABLE OtherTable (id TEXT); CREATE TRIGGER other_trigger AFTER INSERT ON OtherTable BEGIN SELECT 1; END'); }, tables: [], table: 'OtherTable', where: { id: 'x' } },
    { name: 'internal', setup(db) { db.exec('CREATE TRIGGER log_trigger AFTER INSERT ON _Log BEGIN SELECT 1; END'); }, tables: ['_Log'], table: '_Log', where: { scope } },
    { name: 'case variant', setup(db) { db.exec('CREATE TABLE DomainSource (id TEXT); CREATE TRIGGER source_trigger AFTER INSERT ON DomainSource BEGIN SELECT 1; END'); }, tables: ['DomainSource'], table: 'domainsource', where: { id: 'x' } },
    { name: 'temp shadow', setup(db) { db.exec('CREATE TABLE DomainSource (id TEXT); CREATE TEMP TABLE DomainSource (id TEXT); CREATE TEMP TRIGGER source_shadow_trigger AFTER INSERT ON DomainSource BEGIN SELECT 1; END'); }, tables: ['DomainSource'], table: 'DomainSource', where: { id: 'x' } },
    { name: 'view', setup(db) { db.exec('CREATE TABLE BaseTable (id TEXT); CREATE VIEW DomainSource AS SELECT * FROM BaseTable; CREATE TRIGGER source_view_trigger INSTEAD OF INSERT ON DomainSource BEGIN INSERT INTO BaseTable VALUES (NEW.id); END'); }, tables: ['DomainSource'], table: 'DomainSource', where: { id: 'x' } },
    { name: 'raw predicate', setup(db) { db.exec('CREATE TABLE DomainSource (id TEXT)'); }, tables: ['DomainSource'], table: 'DomainSource', where: 'id = 1' },
  ];
  for (const entry of cases) {
    const db = fixture(); entry.setup?.(db);
    const instance = app(db, directive, { tables: [], readTables: entry.tables, prepare({ reads }) { reads.find(entry.table, entry.where); } });
    await instance.start();
    const result = await instance.dispatch({ actionId: `reject-${entry.name}`, type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
    assert.equal(result.ok, false, entry.name);
    assert.ok(db.prepare('SELECT 1 FROM _ActionReceipt WHERE actionId = ?').get('old-action'), entry.name);
  }
});

test('preparation reads declared triggered application tables but writes cannot invoke their triggers', async () => {
  const triggeredSchema = `
    CREATE TABLE DomainSource (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE DomainSourceIntegrity (sourceId TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TRIGGER domain_source_integrity AFTER INSERT ON DomainSource BEGIN
      INSERT INTO DomainSourceIntegrity (sourceId, value) VALUES (NEW.id, NEW.value);
    END;
    INSERT INTO DomainSource (id, value) VALUES ('source-1', 'canonical');
  `;
  const readDb = fixture();
  readDb.exec(triggeredSchema);
  let observed;
  const reader = app(readDb, directive, {
    tables: [], readTables: ['DomainSource'],
    prepare({ reads }) { observed = reads.find('DomainSource', { id: 'source-1' })[0].value; },
  });
  await reader.start();
  const readResult = await reader.dispatch({ actionId: 'read-triggered-app-table', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(readResult.ok, true);
  assert.equal(observed, 'canonical');

  // An app owns the single write coordinator for its database handle, so the
  // writer gets an identically seeded handle of its own rather than a second
  // uncoordinated queue on the reader's handle.
  const writeDb = fixture();
  writeDb.exec(triggeredSchema);
  const writer = app(writeDb, directive, {
    tables: ['DomainSource'], readTables: [],
    prepare({ writes }) { writes.insert('DomainSource', { id: 'escape', value: 'must-not-run' }); },
  });
  await writer.start();
  const writeResult = await writer.dispatch({ actionId: 'write-triggered-app-table', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(writeResult.ok, false);
  assert.equal(writeDb.prepare('SELECT 1 FROM DomainSource WHERE id = ?').get('escape'), undefined);
  assert.equal(writeDb.prepare('SELECT 1 FROM DomainSourceIntegrity WHERE sourceId = ?').get('escape'), undefined);
});

test('preparation failure rolls back its writes, purge event, receipt, and erasure', async () => {
  const db = fixture();
  db.exec('CREATE TABLE DomainCleanup (id TEXT PRIMARY KEY)');
  const instance = app(db, directive, { prepare({ writes }) {
    writes.insert('DomainCleanup', { id: 'rolled-back' });
    throw new Error('domain preparation failed');
  } });
  await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-fails', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes('domain preparation failed'), false);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM DomainCleanup').get().count, 0);
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE seq = 1').get().eventType, 'artefact.deleted');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _Log').get().count, 1);
  assert.equal(db.prepare('SELECT 1 FROM _ActionReceipt WHERE actionId = ?').get('purge-fails'), undefined);
});

test('preparation has no raw Workbench-table authority even if mis-allowlisted', async () => {
  const db = fixture();
  const instance = app(db, directive, { tables: ['_Log'], prepare({ writes }) { writes.delete('_Log', { scope }); } });
  await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-no-raw-db', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE seq = 1').get().eventType, 'artefact.deleted');
});

test('preparation cannot mutate package-owned non-underscore tables', async () => {
  const db = fixture();
  const instance = app(db, directive, { tables: ['BlobStore'], prepare({ writes }) { writes.delete('BlobStore', { id: 'x' }); } });
  await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-no-blobstore', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE seq = 1').get().eventType, 'artefact.deleted');
});

test('preparation rejects allowlisted tables whose triggers could escape the capability', async () => {
  const db = fixture();
  db.exec('CREATE TABLE DomainCleanup (id TEXT PRIMARY KEY)');
  db.exec('CREATE TRIGGER cleanup_escape AFTER INSERT ON DomainCleanup BEGIN DELETE FROM _ActionReceipt; END');
  const instance = app(db, directive, { prepare({ writes }) { writes.insert('DomainCleanup', { id: 'escape' }); } });
  await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-no-trigger', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, false);
  assert.ok(db.prepare('SELECT 1 FROM _ActionReceipt WHERE actionId = ?').get('old-action'));
  assert.equal(db.prepare('SELECT COUNT(*) count FROM DomainCleanup').get().count, 0);
});

test('preparation writes reject foreign-key escape paths in either direction', async () => {
  const cases = [
    {
      name: 'outbound', table: '_ApplicationChild',
      setup(db) { db.exec('CREATE TABLE Parent (id TEXT PRIMARY KEY); CREATE TABLE _ApplicationChild (id TEXT PRIMARY KEY, parentId TEXT REFERENCES Parent(id))'); },
    },
    {
      name: 'inbound', table: '_ApplicationParent',
      setup(db) { db.exec('CREATE TABLE _ApplicationParent (id TEXT PRIMARY KEY); CREATE TABLE Child (id TEXT PRIMARY KEY, parentId TEXT REFERENCES _ApplicationParent(id))'); },
    },
    {
      name: 'inbound temp', table: '_ApplicationParent',
      setup(db) { db.exec('CREATE TABLE _ApplicationParent (id TEXT PRIMARY KEY); CREATE TEMP TABLE TempChild (id TEXT PRIMARY KEY, parentId TEXT REFERENCES _ApplicationParent(id))'); },
    },
  ];
  for (const entry of cases) {
    const db = fixture(); entry.setup(db);
    const instance = app(db, directive, {
      tables: [entry.table], prepare({ writes }) { writes.delete(entry.table, { id: 'x' }); },
    });
    await instance.start();
    const result = await instance.dispatch({ actionId: `deny-fk-${entry.name}`, type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
    assert.equal(result.ok, false, entry.name);
  }
});

test('preparation writes cannot escape their transaction-bound callback', async () => {
  const db = fixture(); db.exec('CREATE TABLE DomainCleanup (id TEXT PRIMARY KEY)');
  let escaped;
  const instance = app(db, directive, { prepare({ writes }) { escaped = writes; } });
  await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-no-escape', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, true);
  assert.throws(() => escaped.insert('DomainCleanup', { id: 'late' }), /available only during erasure preparation/);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM DomainCleanup').get().count, 0);
});

test('private projection replay does not invoke erasure preparation', async () => {
  const db = fixture(); let calls = 0;
  const instance = app(db, directive, { prepare() { calls += 1; } });
  await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-before-replay', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, true); assert.equal(calls, 1);
  assert.deepEqual(await instance.replayPrivateFactProjections(), { projected: 0 });
  assert.equal(calls, 1);
});

test('ordinary actions cannot opt into erasure preparation', async () => {
  const db = fixture();
  const ordinary = workbench({ db, schema: fixtureSchema(db), actions: [{
    type: 'ordinary.action', erasure: { tables: [], readTables: [], prepare() {} }, authorize: () => true, handler: () => [],
  }] });
  await assert.rejects(ordinary.start(), /must exclude its history cursor/);
});

test('registered erasure atomically tombstones targets, retires receipts/cursors, and sanitizes retries', async () => {
  const db = fixture(); const instance = app(db, directive); await instance.start();
  const first = await instance.dispatch({ actionId: 'purge-1', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(first.ok, true);
  const erased = db.prepare('SELECT * FROM _Log WHERE scope = ? AND seq = 1').get(scope);
  assert.deepEqual({ eventType: erased.eventType, eventData: erased.eventData, actionId: erased.actionId }, { eventType: '$workbench.erased', eventData: '{"version":1}', actionId: '$workbench.erased' });
  assert.equal(db.prepare('SELECT 1 FROM _ActionReceipt WHERE scope = ? AND actionId = ?').get(scope, 'old-action'), undefined);
  assert.equal(db.prepare('SELECT 1 FROM _PrivateActionFact WHERE scope = ? AND actionId = ?').get(scope, 'old-action'), undefined);
  const cursor = db.prepare('SELECT past, future FROM _HistoryCursor WHERE scope = ?').get(scope);
  assert.equal(cursor.past, JSON.stringify([
    { rootActionId: 'before', headActionId: 'before' },
    { rootActionId: 'after', headActionId: 'after' },
  ]));
  assert.equal(cursor.future, JSON.stringify([
    { rootActionId: 'later', headActionId: 'later' },
  ]));
  const receipt = db.prepare('SELECT * FROM _ActionReceipt WHERE scope = ? AND actionId = ?').get(scope, 'purge-1');
  assert.deepEqual({ actionType: receipt.actionType, actionData: receipt.actionData, principalKey: receipt.principalKey, sessionId: receipt.sessionId, operation: receipt.operation }, { actionType: 'lifecycle.purge', actionData: '{"version":1}', principalKey: null, sessionId: null, operation: 'erasure' });
  const second = await instance.dispatch({ actionId: 'purge-1', type: 'lifecycle.purge', payload: { confirmation: 'never persisted' }, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(second.ok, true); assert.equal(second.deduped, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE scope = ?').get(scope).count, 2);
});

test('a stale erasure manifest rolls back its new event and leaves existing history untouched', async () => {
  const db = fixture(); const instance = app(db, (database) => directive(database, { actions: [{ ...directive(database).actions[0], receiptDigest: '0'.repeat(64) }] })); await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-stale', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE scope = ? AND seq = 1').get(scope).eventType, 'artefact.deleted');
  assert.ok(db.prepare('SELECT 1 FROM _ActionReceipt WHERE scope = ? AND actionId = ?').get(scope, 'old-action'));
  assert.equal(db.prepare('SELECT 1 FROM _ActionReceipt WHERE scope = ? AND actionId = ?').get(scope, 'purge-stale'), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE scope = ?').get(scope).count, 1);
});

test('only an explicitly privileged, cursor-excluded registered action can return an erasure directive', async () => {
  const db = fixture();
  const unprivileged = workbench({ db, schema: fixtureSchema(db), actions: [{
    type: 'not.purge', history: { cursor: 'excluded' }, authorize: () => true,
    handler(context) { return { events: [], directive: directive(context.db) }; },
  }] });
  await unprivileged.start();
  const result = await unprivileged.dispatch({ actionId: 'not-purge', type: 'not.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE scope = ? AND seq = 1').get(scope).eventType, 'artefact.deleted');
  const invalidDb = new DatabaseSync(':memory:');
  const invalid = workbench({ db: invalidDb, schema: fixtureSchema(invalidDb), actions: [{
    type: 'bad.purge', erasure: true, authorize: () => true, handler: () => [],
  }] });
  await assert.rejects(invalid.start(), /must exclude its history cursor/);
});

test('a retain rule that structurally references the subject aborts without tombstoning', async () => {
  const db = fixture();
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(scope, 2, 'lifecycle.purged', JSON.stringify({ id: 'artefact-1' }), 'retained-action', '2026-07-27T00:00:01.000Z');
  db.prepare('UPDATE _Cursor SET lastSeq = 2 WHERE scope = ?').run(scope);
  const instance = app(db, directive); await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-retain', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE scope = ? AND seq = 1').get(scope).eventType, 'artefact.deleted');
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE scope = ? AND seq = 2').get(scope).eventType, 'lifecycle.purged');
});

test('a census target omitted from the manifest aborts without partial erasure', async () => {
  const db = fixture();
  const data = JSON.stringify({ projectId: 'project-1', id: 'artefact-1' });
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(scope, 2, 'artefact.deleted', data, 'second-action', '2026-07-27T00:00:01.000Z');
  db.prepare('UPDATE _Cursor SET lastSeq = 2 WHERE scope = ?').run(scope);
  db.prepare(`INSERT INTO _ActionReceipt
    (scope, actionId, committedAt, eventRefs, historyOrder, actionType, actionData, principalKey, sessionId, operation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(scope, 'second-action', '2026-07-27T00:00:01.000Z', JSON.stringify([{ scope, seq: 2 }]), 2, 'artefact.delete', JSON.stringify({ id: 'artefact-1' }), 'user:u1', 's1', 'action');
  const instance = app(db, directive); await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-incomplete', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE scope = ? AND seq = 1').get(scope).eventType, 'artefact.deleted');
  assert.ok(db.prepare('SELECT 1 FROM _ActionReceipt WHERE scope = ? AND actionId = ?').get(scope, 'old-action'));
});

test('legacy string-array history cursors are still pruned by erasure', async () => {
  const db = fixture();
  db.prepare('UPDATE _HistoryCursor SET past = ?, future = ? WHERE scope = ?')
    .run(JSON.stringify(['before', 'old-action', 'after']), JSON.stringify(['old-action', 'later']), scope);
  const instance = app(db, directive); await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-legacy-cursor', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, true);
  const cursor = db.prepare('SELECT past, future FROM _HistoryCursor WHERE scope = ?').get(scope);
  assert.equal(cursor.past, JSON.stringify(['before', 'after']));
  assert.equal(cursor.future, JSON.stringify(['later']));
});

test('erasure prunes durableHistory frame cursors and erases private facts so erased actions are unreachable', async () => {
  const db = new DatabaseSync(':memory:');
  const history = durableHistory({
    authorize: () => true,
    actions: {
      'document.set': {
        inverse: ({ fact }) => ({ type: 'document.set', payload: { value: fact.before } }),
        redo: ({ fact }) => ({ type: 'document.set', payload: { value: fact.after } }),
      },
    },
  });
  const instance = workbench({ db, schema: fixtureSchema(db), history, actions: [
    {
      type: 'document.set', authorize: () => true,
      handler({ payload }) {
        const commit = { events: [{ type: 'document.changed', scope, data: { id: payload.id, value: payload.value } }] };
        if (payload.before !== undefined) commit.privateFact = { before: payload.before, after: payload.value };
        return commit;
      },
    },
    {
      type: 'lifecycle.purge', erasure: true, history: { cursor: 'excluded' }, authorize: () => true,
      handler() {
        return {
          events: [{ type: 'lifecycle.purged', scope, data: { done: true } }],
          directive: erasureDirectivePreparation({
            owningScope: scope, subject: 'artefact-1',
            census: {
              version: 1,
              rules: [
                { kind: 'action', type: 'document.set', disposition: 'target', identityPointers: ['/id'] },
                { kind: 'event', type: 'document.changed', disposition: 'target', identityPointers: ['/id'] },
                { kind: 'event', type: 'lifecycle.purged', disposition: 'retain', identityPointers: ['/id'] },
              ],
            },
          }),
        };
      },
    },
  ] });
  await instance.start();

  const principal = Object.freeze({ type: 'user', id: 'u1' });
  const cursorArgs = { scope, principal, session: 'tab-a' };
  await instance.dispatch({ actionId: 'doc-a1', type: 'document.set', payload: { id: 'artefact-1', value: 1, before: 0 }, principal, scope, history: { session: 'tab-a' } });
  await instance.dispatch({ actionId: 'doc-a2', type: 'document.set', payload: { id: 'artefact-2', value: 1, before: 0 }, principal, scope, history: { session: 'tab-a' } });
  assert.deepEqual(JSON.parse(db.prepare('SELECT past FROM _HistoryCursor WHERE scope = ?').get(scope).past), [
    { rootActionId: 'doc-a1', headActionId: 'doc-a1' },
    { rootActionId: 'doc-a2', headActionId: 'doc-a2' },
  ]);

  const beforeUndo = await instance.history.cursor(cursorArgs);
  const undone = await instance.history.undo({ ...cursorArgs, actionId: 'undo-a2', revision: beforeUndo.revision });
  assert.equal(undone.ok, true);
  const prePurge = JSON.parse(db.prepare('SELECT future FROM _HistoryCursor WHERE scope = ?').get(scope).future);
  assert.deepEqual(prePurge, [{ rootActionId: 'doc-a2', headActionId: 'undo-a2' }]);
  const prePurgeRevision = (await instance.history.cursor(cursorArgs)).revision;

  const purged = await instance.dispatch({ actionId: 'purge-int', type: 'lifecycle.purge', payload: {}, principal, scope });
  assert.equal(purged.ok, true);

  const stored = db.prepare('SELECT past, future FROM _HistoryCursor WHERE scope = ?').get(scope);
  assert.deepEqual(JSON.parse(stored.past), []);
  assert.deepEqual(JSON.parse(stored.future), [{ rootActionId: 'doc-a2', headActionId: 'undo-a2' }]);

  assert.equal(db.prepare('SELECT 1 FROM _PrivateActionFact WHERE scope = ? AND actionId = ?').get(scope, 'doc-a1'), undefined);
  assert.equal(db.prepare('SELECT 1 FROM _ActionReceipt WHERE scope = ? AND actionId = ?').get(scope, 'doc-a1'), undefined);
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE scope = ? AND seq = 1').get(scope).eventType, '$workbench.erased');

  assert.partialDeepStrictEqual(await instance.history.cursor(cursorArgs), { undo: 0, redo: 1 });
  await assert.rejects(instance.history.undo({ ...cursorArgs, actionId: 'undo-a1', revision: prePurgeRevision }), /cursor is stale/);

  const current = await instance.history.cursor(cursorArgs);
  const redone = await instance.history.redo({ ...cursorArgs, actionId: 'redo-a2', revision: current.revision });
  assert.equal(redone.ok, true);

  db.prepare('UPDATE _HistoryCursor SET past = ?, future = ? WHERE scope = ?')
    .run(JSON.stringify([{ rootActionId: 'doc-a1', headActionId: 'doc-a1' }]), '[]', scope);
  const rogue = await instance.history.cursor(cursorArgs);
  await assert.rejects(instance.history.undo({ ...cursorArgs, actionId: 'undo-rogue', revision: rogue.revision }), /no longer retained/);
});
