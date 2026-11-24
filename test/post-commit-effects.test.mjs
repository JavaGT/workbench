import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import workbench, { admin, authorizedRows, createAuthorizationAdapter, entity, everyone, grant, map, membership, postCommitEffect, read, ref, scope, subscribe, text, write } from '../build/index.mjs';
import { defineSqliteSchema, frameworkTableNames } from '../build/server.mjs';

// Fixture tables the tests create out-of-band and application projections
// write (Artefact) or private-fact projections write (PrivateProjection);
// declared through the externalTables seam for the settled census.
// Boot now validates the settled census against SQLite (fail closed). Each
// test creates only the out-of-band tables it exercises, so declare exactly the
// objects present in its database: no missing census entry, no undeclared
// drift. Framework-owned names already have their own authority.
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
  return defineSqliteSchema({ name: 'post-commit-effects-fixtures', tables: [], externalTables, externalTriggers });
}

const principal = { type: 'user', id: 'editor', attributes: {} };

function transferAction({ authorize = () => true, failProjection = false, ran }) {
  return {
    type: 'artefact.transfer',
    authorize,
    handler({ payload }) {
      ran.handlers += 1;
      return {
        events: [
          { type: 'artefact.transferred', scope: `project:${payload.source}`, data: { id: payload.id, project: payload.target } },
          { type: 'artefact.received', scope: `project:${payload.target}`, data: { id: payload.id } },
        ],
        privateFact: { before: { project: payload.source, secret: 'canonical' }, after: { project: payload.target } },
        effects: [
          postCommitEffect({ file: 'media', operation: 'copy', key: payload.id, verification: 'target-sha', payload: { from: payload.source, to: payload.target } }),
          postCommitEffect({ file: 'media', operation: 'retain-source', key: payload.id, verification: 'retained-sha' }),
        ],
      };
    },
    projections: [{
      eventTypes: ['artefact.transferred'],
      apply(event, db) {
        db.prepare('UPDATE Artefact SET project = ? WHERE id = ?').run(event.data.project, event.data.id);
        if (failProjection) throw new Error('projection failed');
      },
    }],
  };
}

async function setup(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE Artefact (id TEXT PRIMARY KEY, project TEXT NOT NULL); INSERT INTO Artefact VALUES ('a1', 'source')");
  const ran = { handlers: 0, io: 0 };
  const app = workbench({ db, schema: fixtureSchema(db), actions: [transferAction({ ...options, ran })] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  return { app, db, ran };
}

function request() {
  return { actionId: 'move-1', scope: 'project:source', type: 'artefact.transfer', payload: { id: 'a1', source: 'source', target: 'target' }, principal };
}

test('multi-project events, ownership, private fact, receipt, and effects commit atomically; projection runs no I/O', async (t) => {
  const { app, db, ran } = await setup(t);
  const result = await app.dispatch(request());
  assert.equal(result.ok, true);
  assert.deepEqual(result.events.map((event) => event.scope), ['project:source', 'project:target']);
  assert.equal(db.prepare("SELECT project FROM Artefact WHERE id = 'a1'").get().project, 'target');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _ActionReceipt').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _PrivateActionFact').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _PostCommitEffect').get().c, 2);
  assert.equal(ran.io, 0, 'projection/replay cannot execute runner I/O');

  const duplicate = await app.dispatch(request());
  assert.equal(duplicate.deduped, true);
  assert.equal(ran.handlers, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _PostCommitEffect').get().c, 2);
});

test('authorization and projection failure leave no cross-project, fact, receipt, or effect footprint', async (t) => {
  for (const options of [{ authorize: () => false }, { failProjection: true }]) {
    const { app, db } = await setup(t, options);
    const result = await app.dispatch(request());
    assert.equal(result.ok, false);
    assert.equal(db.prepare("SELECT project FROM Artefact WHERE id = 'a1'").get().project, 'source');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM _Log').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM _PrivateActionFact').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM _PostCommitEffect').get().c, 0);
  }
});

test('authorizedRows requires the same principal capability on both project rows through the check/grant grammar', async (t) => {
  const Project = entity('TransferProject', {
    name: text(),
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(() => everyone()).can(async ({ is }) =>
      (await is.owner()) ? grant(read, write) : grant(read))],
  });
  let handled = 0;
  const action = {
    type: 'cross-project.authorized',
    authorize: authorizedRows(({ payload }) => [
      { entity: Project, id: payload.source, capability: write },
      { entity: Project, id: payload.target, capability: write },
    ]),
    handler: ({ payload }) => {
      handled += 1;
      return [{ type: 'cross-project.committed', scope: `TransferProject:${payload.source}`, data: {} }];
    },
  };
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, schema: fixtureSchema(db), entities: [Project], actions: [action] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  db.prepare('INSERT INTO TransferProject (id, name, owner) VALUES (?, ?, ?)').run('source', 'Source', 'editor');
  db.prepare('INSERT INTO TransferProject (id, name, owner) VALUES (?, ?, ?)').run('target', 'Target', 'other');

  const denied = await app.dispatch({ actionId: 'denied-both', scope: 'TransferProject:source', type: action.type, payload: { source: 'source', target: 'target' }, principal });
  assert.equal(denied.ok, false);
  assert.equal(handled, 0);
  db.prepare("UPDATE TransferProject SET owner = 'editor' WHERE id = 'target'").run();
  const granted = await app.dispatch({ actionId: 'granted-both', scope: 'TransferProject:source', type: action.type, payload: { source: 'source', target: 'target' }, principal });
  assert.equal(granted.ok, true);
  assert.equal(handled, 1);
});

test('registered durable actions consult the app-injected authorization adapter (S5/A2 single path)', async (t) => {
  const Project = entity('AdapterTransferProject', {
    name: text(),
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(() => everyone()).can(async ({ is }) =>
      (await is.owner()) ? grant(read, write) : grant(read))],
  });
  let handled = 0;
  const action = {
    type: 'adapter.authorized',
    authorize: authorizedRows(({ payload }) => [
      { entity: Project, id: payload.source, capability: write },
    ]),
    handler: () => {
      handled += 1;
      return [{ type: 'adapter.committed', scope: 'AdapterTransferProject:source', data: {} }];
    },
  };
  const db = new DatabaseSync(':memory:');
  const defaultAdapter = createAuthorizationAdapter();
  const calls = [];
  const spy = {
    admit: async (input) => {
      calls.push(input);
      return defaultAdapter.admit(input);
    },
    registerResource: (input) => defaultAdapter.registerResource(input),
  };
  const app = workbench({ db, schema: fixtureSchema(db), entities: [Project], actions: [action] });
  app._authorization = spy; // what serve.ts listen() stashes from { authorization }
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  db.prepare('INSERT INTO AdapterTransferProject (id, name, owner) VALUES (?, ?, ?)').run('source', 'Source', 'editor');

  const granted = await app.dispatch({ actionId: 'adapter-granted', scope: 'AdapterTransferProject:source', type: action.type, payload: { source: 'source' }, principal });
  assert.equal(granted.ok, true);
  assert.equal(handled, 1);
  const actionCalls = calls.filter((c) => c.category === 'action');
  // Registered-action authorization runs at both durable auth gates (the two
  // admission halts of the commit pipeline), so one dispatch consults the
  // adapter twice — but every consultation is a single composite admit() call.
  assert.ok(actionCalls.length >= 1, 'the composite action admission consulted the injected adapter');
  assert.ok(actionCalls.every((c) => c.category === 'action' && c.operation === 'execute'), 'every consultation is a whole-action composite admit');
});

test('an injected adapter denial blocks the registered durable action', async (t) => {
  const Project = entity('AdapterDenyProject', {
    name: text(),
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(() => everyone()).can(async ({ is }) =>
      (await is.owner()) ? grant(read, write) : grant(read))],
  });
  let handled = 0;
  const action = {
    type: 'adapter.denied',
    authorize: authorizedRows(({ payload }) => [
      { entity: Project, id: payload.source, capability: write },
    ]),
    handler: () => {
      handled += 1;
      return [{ type: 'adapter.denied.committed', scope: 'AdapterDenyProject:source', data: {} }];
    },
  };
  const db = new DatabaseSync(':memory:');
  const denying = {
    admit: async (input) => {
      assert.equal(input.category, 'action');
      return { admitted: false, reasonCode: 'no-capability' };
    },
    registerResource: () => {},
  };
  const app = workbench({ db, schema: fixtureSchema(db), entities: [Project], actions: [action] });
  app._authorization = denying;
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  db.prepare('INSERT INTO AdapterDenyProject (id, name, owner) VALUES (?, ?, ?)').run('source', 'Source', 'editor');

  const denied = await app.dispatch({ actionId: 'adapter-denied', scope: 'AdapterDenyProject:source', type: action.type, payload: { source: 'source' }, principal });
  assert.equal(denied.ok, false);
  assert.equal(handled, 0, 'a denied action never runs its handler');
});

test('authorizedRows binds a post-compilation membership declaration and checks both row subjects', async (t) => {
  const Project = entity('MembershipTransferProject', {
    name: text(),
    owner: ref('User', { role: 'owner' }),
    members: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),
  });
  membership(Project, {
    viewer: { can: [read, subscribe], field: { role: 'viewer' } },
    editor: { can: [read, write, subscribe], field: { role: 'editor' } },
  });
  let handled = 0;
  const action = {
    type: 'membership.cross-project.authorized',
    authorize: authorizedRows(({ payload }) => [
      { entity: Project, id: payload.source, capability: write },
      { entity: Project, id: payload.target, capability: write },
    ]),
    handler: () => { handled += 1; return []; },
  };
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, schema: fixtureSchema(db), entities: [Project], actions: [action] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  db.prepare('INSERT INTO MembershipTransferProject (id, name, owner) VALUES (?, ?, ?)').run('source', 'Source', 'owner');
  db.prepare('INSERT INTO MembershipTransferProject (id, name, owner) VALUES (?, ?, ?)').run('target', 'Target', 'owner');
  db.prepare('INSERT INTO MembershipTransferProject_members (MembershipTransferProject_id, member_id, role) VALUES (?, ?, ?)').run('source', 'editor', 'editor');
  db.prepare('INSERT INTO MembershipTransferProject_members (MembershipTransferProject_id, member_id, role) VALUES (?, ?, ?)').run('target', 'editor', 'viewer');

  const base = { scope: 'MembershipTransferProject:source', type: action.type, payload: { source: 'source', target: 'target' }, principal };
  assert.equal((await app.dispatch({ ...base, actionId: 'membership-denied' })).ok, false);
  assert.equal(handled, 0);
  db.prepare("UPDATE MembershipTransferProject_members SET role = 'editor' WHERE MembershipTransferProject_id = 'target'").run();
  assert.equal((await app.dispatch({ ...base, actionId: 'membership-granted' })).ok, true);
  assert.equal(handled, 1);
});

test('authorizedRows requires an explicit admin grant on every selected row and fails closed for malformed requirements', async (t) => {
  const Project = entity('AdminAuthorizedRowsProject', {
    name: text(),
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(() => everyone()).can(async ({ is }) =>
      (await is.owner()) ? grant(read, write, subscribe, admin) : grant(read, write, subscribe))],
  });
  const NoAdminProject = entity('NoAdminAuthorizedRowsProject', {
    name: text(),
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  const ScopeOnlyProject = entity('ScopeOnlyAdminAuthorizedRowsProject', {
    name: text(),
    grant: () => [scope(() => everyone())],
  });
  const ScopedAdminProject = entity('ScopedAdminAuthorizedRowsProject', {
    name: text(),
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read, write, subscribe, admin))],
  });
  let handled = 0;
  const action = {
    type: 'admin.cross-project.authorized',
    authorize: authorizedRows(({ payload }) => [
      { entity: Project, id: payload.source, capability: admin },
      { entity: Project, id: payload.target, capability: admin },
    ]),
    handler: () => { handled += 1; return []; },
  };
  const noAdminAction = {
    type: 'admin.absent.authorized',
    authorize: authorizedRows(() => [{ entity: NoAdminProject, id: 'without-admin', capability: admin }]),
    handler: () => { handled += 1; return []; },
  };
  const malformedAction = {
    type: 'admin.malformed.authorized',
    authorize: authorizedRows(() => [{ entity: Project, id: 'source', capability: { capability: 'admin' } }]),
    handler: () => { handled += 1; return []; },
  };
  const scopeOnlyAction = {
    type: 'admin.scope-only.authorized',
    authorize: authorizedRows(() => [{ entity: ScopeOnlyProject, id: 'scope-only', capability: admin }]),
    handler: () => { handled += 1; return []; },
  };
  const outOfScopeAction = {
    type: 'admin.out-of-scope.authorized',
    authorize: authorizedRows(() => [{ entity: ScopedAdminProject, id: 'outside-scope', capability: admin }]),
    handler: () => { handled += 1; return []; },
  };
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, schema: fixtureSchema(db), entities: [Project, NoAdminProject, ScopeOnlyProject, ScopedAdminProject], actions: [action, noAdminAction, malformedAction, scopeOnlyAction, outOfScopeAction] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  db.prepare('INSERT INTO AdminAuthorizedRowsProject (id, name, owner) VALUES (?, ?, ?)').run('source', 'Source', 'editor');
  db.prepare('INSERT INTO AdminAuthorizedRowsProject (id, name, owner) VALUES (?, ?, ?)').run('target', 'Target', 'other');
  db.prepare('INSERT INTO NoAdminAuthorizedRowsProject (id, name, owner) VALUES (?, ?, ?)').run('without-admin', 'No admin', 'editor');
  db.prepare('INSERT INTO ScopeOnlyAdminAuthorizedRowsProject (id, name) VALUES (?, ?)').run('scope-only', 'Scope only');
  db.prepare('INSERT INTO ScopedAdminAuthorizedRowsProject (id, name, owner) VALUES (?, ?, ?)').run('outside-scope', 'Outside scope', 'other');

  const base = { scope: 'AdminAuthorizedRowsProject:source', type: action.type, payload: { source: 'source', target: 'target' }, principal };
  assert.equal((await app.dispatch({ ...base, actionId: 'admin-cross-row-denied' })).ok, false, 'admin on one row does not authorize another row');
  assert.equal((await app.dispatch({ actionId: 'admin-absent-denied', scope: 'NoAdminAuthorizedRowsProject:without-admin', type: noAdminAction.type, payload: {}, principal })).ok, false, 'write does not imply admin');
  assert.equal((await app.dispatch({ actionId: 'admin-malformed-denied', scope: 'AdminAuthorizedRowsProject:source', type: malformedAction.type, payload: {}, principal })).ok, false, 'lookalike capability token is rejected');
  assert.equal((await app.dispatch({ actionId: 'admin-scope-only-denied', scope: 'ScopeOnlyAdminAuthorizedRowsProject:scope-only', type: scopeOnlyAction.type, payload: {}, principal })).ok, false, 'scope visibility does not imply admin');
  assert.equal((await app.dispatch({ actionId: 'admin-out-of-scope-denied', scope: 'ScopedAdminAuthorizedRowsProject:outside-scope', type: outOfScopeAction.type, payload: {}, principal })).ok, false, 'an explicit admin grant outside the declared read scope is rejected');
  assert.equal(handled, 0);

  db.prepare("UPDATE AdminAuthorizedRowsProject SET owner = 'editor' WHERE id = 'target'").run();
  assert.equal((await app.dispatch({ ...base, actionId: 'admin-both-rows-granted' })).ok, true, 'explicit admin grants on both rows authorize the action');
  assert.equal(handled, 1);
});

test('inline membership compiles registry entries instead of treating them as declared check functions', () => {
  assert.doesNotThrow(() => entity('InlineMembershipProject', {
    name: text(),
    owner: ref('User', { role: 'owner' }),
    members: map(ref('User'), { role: ['viewer'], default: {} }),
    membership: { viewer: { can: [read, subscribe], field: { role: 'viewer' } } },
  }));
});

test('inline membership rejects a role that collides with an existing authorization check', () => {
  assert.throws(() => entity('CollidingMembershipProject', {
    name: text(),
    owner: ref('User', { role: 'owner' }),
    members: map(ref('User'), { role: ['owner'], default: {} }),
    membership: { owner: { can: [read], field: { role: 'owner' } } },
  }), /collides with an existing/);
});

test('standalone membership rejects a role that collides with an existing authorization check', () => {
  const Project = entity('StandaloneCollidingMembershipProject', {
    name: text(), owner: ref('User', { role: 'owner' }),
    members: map(ref('User'), { role: ['owner'], default: {} }),
  });
  assert.throws(() => membership(Project, {
    owner: { can: [read], field: { role: 'owner' } },
  }), /collides with an existing/);
});

test('private fact projection is bound to its declaring action when event types overlap', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE PrivateProjection (value TEXT NOT NULL)');
  const projected = {
    eventTypes: ['shared.private.event'], privateFact: true,
    apply(_event, tx, { privateFact }) { tx.prepare('INSERT INTO PrivateProjection VALUES (?)').run(privateFact.after.value); },
  };
  const app = workbench({ db, schema: fixtureSchema(db), actions: [
    {
      type: 'private.owner', authorize: () => true,
      handler: () => ({ events: [{ type: 'shared.private.event', scope: 'r:1', data: {} }], privateFact: { before: {}, after: { value: 'owned' } } }),
      projections: [projected],
    },
    {
      type: 'ordinary.other', authorize: () => true,
      handler: () => [{ type: 'shared.private.event', scope: 'r:2', data: {} }],
    },
  ] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  assert.equal((await app.dispatch({ actionId: 'other', scope: 'owner:other', type: 'ordinary.other', payload: {}, principal })).ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM PrivateProjection').get().count, 0);
  assert.equal((await app.dispatch({ actionId: 'owner', scope: 'owner:owner', type: 'private.owner', payload: {}, principal })).ok, true);
  assert.deepEqual(db.prepare('SELECT value FROM PrivateProjection').all().map((row) => row.value), ['owned']);
  db.prepare('DELETE FROM PrivateProjection').run();
  assert.deepEqual(await app.replayPrivateFactProjections(), { projected: 1 });
  assert.deepEqual(db.prepare('SELECT value FROM PrivateProjection').all().map((row) => row.value), ['owned']);
});

test('batch rejects a private-fact-projection action before any handler runs while ordinary batches remain supported', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE PrivateProjection (value TEXT NOT NULL)');
  const ran = { ordinary: 0, private: 0 };
  const app = workbench({ db, schema: fixtureSchema(db), actions: [
    {
      type: 'ordinary.batchable', authorize: () => true,
      handler: () => {
        ran.ordinary += 1;
        return [{ type: 'ordinary.batched', scope: 'owner:o1', data: {} }];
      },
    },
    {
      type: 'private.single-only', authorize: () => true,
      handler: () => {
        ran.private += 1;
        return {
          events: [{ type: 'private.single-only.committed', scope: 'owner:o1', data: {} }],
          privateFact: { before: {}, after: { value: 'projected' } },
        };
      },
      projections: [{
        eventTypes: ['private.single-only.committed'], privateFact: true,
        apply(_event, tx, { privateFact }) {
          tx.prepare('INSERT INTO PrivateProjection VALUES (?)').run(privateFact.after.value);
        },
      }],
    },
  ] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });

  const rejected = await app.kernel.dispatchBatch({
    actionId: 'mixed-private', scope: 'owner:o1', principal,
    actions: [
      { type: 'ordinary.batchable', payload: {} },
      { type: 'private.single-only', payload: {} },
    ],
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.failure.category, 'invalid-input');
  assert.match(rejected.failure.message, /private-fact projection.*requires single dispatch/);
  assert.deepEqual(ran, { ordinary: 0, private: 0 }, 'batch eligibility is checked before handlers');
  for (const table of ['PrivateProjection', '_Log', '_PrivateActionFact', '_ActionReceipt']) {
    assert.equal(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0, `${table} remains untouched`);
  }

  const ordinary = await app.kernel.dispatchBatch({
    actionId: 'ordinary-batch', scope: 'owner:o1', principal,
    actions: [{ type: 'ordinary.batchable', payload: {} }],
  });
  assert.equal(ordinary.ok, true);
  assert.equal(ran.ordinary, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _Log').get().count, 1);
});

test('private-fact projection receives canonical fact while public durable records remain sanitized', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE PrivateProjection (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const action = {
    type: 'private.project', authorize: () => true,
    handler: () => ({
      events: [{ type: 'private.projected', scope: 'recipient:r1', data: { resync: true } }],
      privateFact: { before: { id: 'row', value: 'before', secret: 'hidden' }, after: { id: 'row', value: 'after' } },
    }),
    projections: [{
      eventTypes: ['private.projected'], privateFact: true,
      apply(_event, tx, context) {
        tx.prepare('INSERT OR REPLACE INTO PrivateProjection (id, value) VALUES (?, ?)').run(context.privateFact.after.id, context.privateFact.after.value);
      },
    }],
  };
  const app = workbench({ db, schema: fixtureSchema(db), actions: [action] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  const result = await app.dispatch({ actionId: 'private-project', scope: 'owner:o1', type: action.type, payload: {}, principal });
  assert.equal(result.ok, true);
  assert.deepEqual({ ...db.prepare('SELECT * FROM PrivateProjection').get() }, { id: 'row', value: 'after' });
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM _Log').all()).includes('hidden'), false);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM _ActionReceipt').all()).includes('hidden'), false);
  assert.equal(JSON.stringify(result).includes('hidden'), false);

  db.prepare('DELETE FROM PrivateProjection').run();
  assert.deepEqual(await app.replayPrivateFactProjections(), { projected: 1 });
  assert.deepEqual({ ...db.prepare('SELECT * FROM PrivateProjection').get() }, { id: 'row', value: 'after' });
});

test('private-fact projection fails closed for missing or forged durable facts', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE PrivateProjection (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const projection = {
    eventTypes: ['private.required'], privateFact: true,
    apply(_event, tx, context) { tx.prepare('INSERT INTO PrivateProjection VALUES (?, ?)').run(context.privateFact.after.id, context.privateFact.after.value); },
  };
  const app = workbench({ db, schema: fixtureSchema(db), actions: [{
    type: 'private.required', authorize: () => true,
    handler: () => ({ events: [{ type: 'private.required', scope: 'recipient:r1', data: {} }] }),
    projections: [projection],
  }] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  const missing = await app.dispatch({ actionId: 'missing-private', scope: 'owner:o1', type: 'private.required', payload: {}, principal });
  assert.equal(missing.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _Log').get().c, 0);

  db.prepare(`INSERT INTO _Log VALUES ('recipient:r1', 1, 'private.required', '{}', 'forged', '2026-01-01')`).run();
  db.prepare(`INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs, historyOrder, actionData) VALUES ('owner:o1', 'forged', '2026-01-01', '[{"scope":"recipient:r1","seq":1}]', 1, 'null')`).run();
  db.prepare(`INSERT INTO _PrivateActionFact (scope, actionId, committedAt, fact, effects) VALUES ('owner:o1', 'forged', '2026-01-01', '{"after":{"id":"row","value":"forged"}}', '[]')`).run();
  await assert.rejects(() => app.replayPrivateFactProjections(), /before and after/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM PrivateProjection').get().c, 0);
});

test('private fact is withheld from ordinary projections and private projection failure rolls back every origin write', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE PrivateProjection (value TEXT NOT NULL)');
  let ordinaryArguments;
  const app = workbench({ db, schema: fixtureSchema(db), actions: [{
    type: 'private.rollback', authorize: () => true,
    handler: () => ({
      events: [{ type: 'private.rollback.committed', scope: 'recipient:r1', data: {} }],
      privateFact: { before: { secret: 'hidden' }, after: { value: 'after' } },
    }),
    projections: [
      {
        eventTypes: ['private.rollback.committed'],
        apply(...args) { ordinaryArguments = args; },
      },
      {
        eventTypes: ['private.rollback.committed'], privateFact: true,
        apply(_event, tx, { privateFact }) {
          tx.prepare('INSERT INTO PrivateProjection VALUES (?)').run(privateFact.after.value);
          throw new Error('private projection failed');
        },
      },
    ],
  }] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });

  const result = await app.dispatch({ actionId: 'private-rollback', scope: 'owner:o1', type: 'private.rollback', payload: {}, principal });
  assert.equal(result.ok, false);
  assert.equal(ordinaryArguments.length, 2, 'ordinary projections receive no private context argument');
  for (const table of ['PrivateProjection', '_Log', '_PrivateActionFact', '_ActionReceipt']) {
    assert.equal(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0);
  }
});

test('canonical private fact is deeply immutable and replay remains repeatable', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE PrivateProjection (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  let observed;
  const app = workbench({ db, schema: fixtureSchema(db), actions: [{
    type: 'private.immutable', authorize: () => true,
    handler: () => ({
      events: [{ type: 'private.immutable.committed', scope: 'recipient:r1', data: {} }],
      privateFact: { before: { nested: { value: 'before' } }, after: { id: 'row', nested: { value: 'after' } } },
    }),
    projections: [
      {
        eventTypes: ['private.immutable.committed'], privateFact: true,
        apply(_event, _tx, { privateFact }) {
          assert.throws(() => { privateFact.after.nested.value = 'mutated'; }, TypeError);
        },
      },
      {
        eventTypes: ['private.immutable.committed'], privateFact: true,
        apply(_event, tx, { privateFact }) {
          observed = privateFact.after.nested.value;
          tx.prepare('INSERT OR REPLACE INTO PrivateProjection VALUES (?, ?)').run(privateFact.after.id, observed);
        },
      },
    ],
  }] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });

  assert.equal((await app.dispatch({ actionId: 'private-immutable', scope: 'owner:o1', type: 'private.immutable', payload: {}, principal })).ok, true);
  assert.equal(observed, 'after');
  assert.deepEqual(await app.replayPrivateFactProjections(), { projected: 2 });
  assert.deepEqual(await app.replayPrivateFactProjections(), { projected: 2 });
  assert.deepEqual({ ...db.prepare('SELECT * FROM PrivateProjection').get() }, { id: 'row', value: 'after' });
});

test('private replay rejects duplicate receipt references transactionally', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE PrivateProjection (value TEXT NOT NULL)');
  const app = workbench({ db, schema: fixtureSchema(db), actions: [{
    type: 'private.duplicate', authorize: () => true,
    handler: () => ({
      events: [{ type: 'private.duplicate.committed', scope: 'recipient:r1', data: {} }],
      privateFact: { before: {}, after: { value: 'once' } },
    }),
    projections: [{
      eventTypes: ['private.duplicate.committed'], privateFact: true,
      apply(_event, tx, { privateFact }) {
        tx.prepare('INSERT INTO PrivateProjection VALUES (?)').run(privateFact.after.value);
      },
    }],
  }] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.dispatch({ actionId: 'duplicate', scope: 'owner:o1', type: 'private.duplicate', payload: {}, principal });
  db.prepare('DELETE FROM PrivateProjection').run();
  db.prepare(`UPDATE _ActionReceipt SET eventRefs = '[{"scope":"recipient:r1","seq":1},{"scope":"recipient:r1","seq":1}]'`).run();

  await assert.rejects(app.replayPrivateFactProjections(), /duplicate event reference/);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM PrivateProjection').get().count, 0);
});

test('private replay validates every fact before current-projection filtering', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, schema: fixtureSchema(db) });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  const receipt = db.prepare(
    'INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs, historyOrder, actionData) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const fact = db.prepare(
    'INSERT INTO _PrivateActionFact (scope, actionId, committedAt, fact, effects) VALUES (?, ?, ?, ?, ?)',
  );
  const malformed = '{"after":{}}';

  receipt.run('owner:none', 'none', '2026-01-01', '[]', 1, 'null');
  fact.run('owner:none', 'none', '2026-01-01', malformed, '[]');
  await assert.rejects(app.replayPrivateFactProjections(), /before and after/);

  db.prepare('DELETE FROM _PrivateActionFact').run();
  db.prepare('DELETE FROM _ActionReceipt').run();
  db.prepare("INSERT INTO _Log VALUES ('recipient:r1', 1, 'unrelated.retained', '{}', 'unrelated', '2026-01-02')").run();
  receipt.run('owner:unrelated', 'unrelated', '2026-01-02', '[{"scope":"recipient:r1","seq":1}]', 2, 'null');
  fact.run('owner:unrelated', 'unrelated', '2026-01-02', malformed, '[]');
  await assert.rejects(app.replayPrivateFactProjections(), /before and after/);

  db.prepare('DELETE FROM _PrivateActionFact').run();
  db.prepare('DELETE FROM _ActionReceipt').run();
  db.prepare('DELETE FROM _Log').run();
  db.prepare("INSERT INTO _Log VALUES ('recipient:r2', 1, 'retired.private.projection', '{}', 'retired', '2026-01-03')").run();
  receipt.run('owner:retired', 'retired', '2026-01-03', '[{"scope":"recipient:r2","seq":1}]', 3, 'null');
  fact.run('owner:retired', 'retired', '2026-01-03', malformed, '[]');
  await assert.rejects(app.replayPrivateFactProjections(), /before and after/);
});

test('private replay corruption rolls back projections applied earlier in the transaction', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE PrivateProjection (value TEXT NOT NULL)');
  const app = workbench({ db, schema: fixtureSchema(db), actions: [{
    type: 'private.replay.atomic', authorize: () => true,
    handler: () => ({
      events: [{ type: 'private.replay.atomic.committed', scope: 'recipient:r1', data: {} }],
      privateFact: { before: {}, after: { value: 'projected' } },
    }),
    projections: [{
      eventTypes: ['private.replay.atomic.committed'], privateFact: true,
      apply(_event, tx, { privateFact }) {
        tx.prepare('INSERT INTO PrivateProjection VALUES (?)').run(privateFact.after.value);
      },
    }],
  }] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.dispatch({ actionId: 'valid', scope: 'owner:valid', type: 'private.replay.atomic', payload: {}, principal });
  db.prepare('DELETE FROM PrivateProjection').run();

  db.prepare("INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs, historyOrder, actionData) VALUES ('owner:bad', 'bad', '9999-01-01', '[]', 99, 'null')").run();
  db.prepare("INSERT INTO _PrivateActionFact (scope, actionId, committedAt, fact, effects) VALUES ('owner:bad', 'bad', '9999-01-01', '{\"after\":{}}', '[]')").run();

  await assert.rejects(app.replayPrivateFactProjections(), /before and after/);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM PrivateProjection').get().count, 0);
});

test('recipient event and ordinary receipt do not leak canonical fact or effect descriptors', async (t) => {
  const { app, db } = await setup(t);
  await app.dispatch(request());
  const recipient = db.prepare("SELECT eventData FROM _Log WHERE scope = 'project:target'").get();
  assert.deepEqual(JSON.parse(recipient.eventData), { id: 'a1' });
  const receipt = db.prepare('SELECT * FROM _ActionReceipt').get();
  assert.equal(JSON.stringify(receipt).includes('canonical'), false);
  assert.equal(JSON.stringify(recipient).includes('target-sha'), false);
});

test('claim is ordered per key, fenced, lease-recoverable, target-verified, and completion-idempotent', async (t) => {
  let now = 100;
  const { app } = await setup(t);
  await app.dispatch(request());
  const runner = (await import('../build/post-commit-effects.mjs')).createPostCommitEffectRunner({ db: app.db, leaseMs: 10, now: () => now });
  const first = runner.claim('w1');
  assert.equal(first.id.ordinal, 0);
  assert.equal(runner.claim('w2'), null, 'same key preserves order while predecessor incomplete');
  assert.deepEqual(runner.complete(first.id, 'w1', first.fence, { verification: 'wrong' }), { accepted: false, verification: false });
  now = 111;
  const recovered = runner.claim('w2');
  assert.equal(recovered.id.ordinal, 0);
  assert.ok(recovered.fence > first.fence);
  assert.equal(runner.complete(first.id, 'w1', first.fence, { verification: 'target-sha' }).accepted, false, 'stale fence rejected');
  assert.deepEqual(runner.complete(recovered.id, 'w2', recovered.fence, { verification: 'target-sha' }), { accepted: true, noop: false });
  assert.deepEqual(runner.complete(recovered.id, 'w2', recovered.fence, { verification: 'wrong' }), { accepted: false, verification: false });
  assert.deepEqual(runner.complete(recovered.id, 'w2', recovered.fence, { verification: 'target-sha' }), { accepted: true, noop: true });
  assert.equal(runner.claim('w3').id.ordinal, 1);
});

test('independent keys claim concurrently; heartbeat extends a lease and fail honors retry time', async (t) => {
  let now = 100;
  const { app, db } = await setup(t);
  await app.dispatch(request());
  db.prepare("UPDATE _PostCommitEffect SET exclusionKey = 'independent' WHERE ordinal = 1").run();
  const runner = (await import('../build/post-commit-effects.mjs')).createPostCommitEffectRunner({ db, leaseMs: 10, now: () => now });

  const first = runner.claim('w1');
  const second = runner.claim('w2');
  assert.equal(first.id.ordinal, 0);
  assert.equal(second.id.ordinal, 1, 'a claimed effect does not block an independent key');
  now = 105;
  assert.equal(runner.heartbeat(first.id, 'w1', first.fence), true);
  assert.deepEqual(runner.fail(second.id, 'w2', second.fence, { retryAt: 120 }), { accepted: true });
  now = 111;
  assert.equal(runner.claim('w3'), null, 'heartbeat keeps the original lease live');
  assert.equal(runner.complete(first.id, 'w1', first.fence, { verification: 'target-sha' }).accepted, true);
  assert.equal(runner.claim('w3'), null, 'failed work remains unavailable before retryAt');
  now = 120;
  const retried = runner.claim('w3');
  assert.equal(retried.id.ordinal, 1);
  assert.ok(retried.fence > second.fence);
});

test('expired ownership cannot heartbeat or complete before recovery', async (t) => {
  let now = 100;
  const { app, db } = await setup(t);
  await app.dispatch(request());
  const runner = (await import('../build/post-commit-effects.mjs')).createPostCommitEffectRunner({ db, leaseMs: 10, now: () => now });
  const claimed = runner.claim('expired');
  now = 110;
  assert.equal(runner.heartbeat(claimed.id, 'expired', claimed.fence), false);
  assert.equal(runner.complete(claimed.id, 'expired', claimed.fence, { verification: 'target-sha' }).accepted, false);
  assert.equal(runner.fail(claimed.id, 'expired', claimed.fence).accepted, false);
  const recovered = runner.claim('recovery');
  assert.ok(recovered.fence > claimed.fence);
});

test('effects require a canonical private before/after envelope', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, schema: fixtureSchema(db), actions: [{
    type: 'invalid.fact', authorize: () => true,
    handler: () => ({
      events: [],
      effects: [postCommitEffect({ file: 'f', operation: 'copy', verification: 'v' })],
    }),
  }] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  const result = await app.dispatch({ actionId: 'invalid-fact', scope: 'project:p', type: 'invalid.fact', payload: {}, principal });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _PrivateActionFact').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _PostCommitEffect').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _ActionReceipt').get().c, 0);
});

test('effects reject private fact keys erased by JSON serialization without persisting action state', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, schema: fixtureSchema(db), actions: [{
    type: 'undefined.fact', authorize: () => true,
    handler: () => ({
      events: [{ type: 'undefined.fact.committed', scope: 'project:p', data: {} }],
      privateFact: { before: undefined, after: undefined },
      effects: [postCommitEffect({ file: 'f', operation: 'copy', verification: 'v' })],
    }),
  }] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });

  const result = await app.dispatch({ actionId: 'undefined-fact', scope: 'project:p', type: 'undefined.fact', payload: {}, principal });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _Log').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _PrivateActionFact').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _PostCommitEffect').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _ActionReceipt').get().c, 0);
});

test('fresh reconstruction derives missing pending rows without changing completed rows or running I/O', async (t) => {
  const { app, db, ran } = await setup(t);
  await app.dispatch(request());
  const first = app.postCommitEffects.claim('w');
  app.postCommitEffects.complete(first.id, 'w', first.fence, { verification: 'target-sha' });
  db.prepare('DELETE FROM _PostCommitEffect WHERE ordinal = 1').run();
  assert.deepEqual(app.postCommitEffects.reconstruct(), { inserted: 1 });
  assert.deepEqual(app.postCommitEffects.reconstruct(), { inserted: 0 });
  assert.equal(db.prepare('SELECT status FROM _PostCommitEffect WHERE ordinal = 0').get().status, 'completed');
  assert.equal(db.prepare('SELECT status FROM _PostCommitEffect WHERE ordinal = 1').get().status, 'pending');
  assert.equal(ran.io, 0);
});

test('reconstruction restores an earlier same-key effect ahead of its retained sibling', async (t) => {
  const { app, db } = await setup(t);
  await app.dispatch(request());
  const retained = db.prepare('SELECT declarationOrder, originOrder FROM _PostCommitEffect WHERE ordinal = 1').get();
  db.prepare('DELETE FROM _PostCommitEffect WHERE ordinal = 0').run();

  assert.deepEqual(app.postCommitEffects.reconstruct(), { inserted: 1 });
  const recovered = db.prepare('SELECT declarationOrder, originOrder FROM _PostCommitEffect WHERE ordinal = 0').get();
  assert.ok(recovered.declarationOrder > retained.declarationOrder, 'reconstruction receives a later mutable row id');
  assert.equal(recovered.originOrder, retained.originOrder, 'reconstruction restores immutable origin ordering');

  const first = app.postCommitEffects.claim('first');
  assert.equal(first.id.ordinal, 0);
  assert.equal(app.postCommitEffects.claim('blocked'), null, 'retained sibling waits for reconstructed predecessor');
  assert.equal(app.postCommitEffects.complete(first.id, 'first', first.fence, { verification: 'target-sha' }).accepted, true);
  assert.equal(app.postCommitEffects.claim('second').id.ordinal, 1);
});
