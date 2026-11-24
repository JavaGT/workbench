import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench from '../build/index.mjs';
import { defineSqliteSchema, frameworkTableNames } from '../build/server.mjs';

// Fixture tables the tests create out-of-band and the app's protected-artefact
// writes mutate; declared through the externalTables seam for the settled census.
const fixtureSchema = defineSqliteSchema({
  name: 'protected-artefact-store-fixtures',
  tables: [],
  externalTables: [],
});

// Boot validates the settled census against SQLite (fail closed). Each test
// creates only the out-of-band tables/triggers it needs, so declare exactly the
// objects present in its database: no missing census entry, no undeclared
// drift. Framework-owned names already have their own authority.
function censusSchema(db) {
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
  return defineSqliteSchema({ name: 'protected-artefact-store-fixtures', tables: [], externalTables, externalTriggers });
}

const scope = 'Project:project-1';
const user = { type: 'user', id: 'u1', attributes: {} };
const VECTOR = JSON.stringify([0.123456789, 0.987654321]);
const VECTOR_NEEDLE = '[0.123456789,0.987654321]';

// Every application table (package tables excluded) that contains the needle.
// Proves the protected payload lives in exactly the declared store and nowhere
// any ordinary log, receipt, cursor, snapshot, delivery, or export path reads.
function leakedLocations(db, needle) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  const hits = [];
  for (const { name } of tables) {
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
    if (JSON.stringify(rows).includes(needle)) hits.push(name);
  }
  return hits;
}

// A registered action that writes one immutable protected observation (a vector
// payload) into its declared store, emits an event carrying only the
// observation id + provenance, and returns a canonicalPayload stripped of the
// vector. `afterWrite` hooks let a test inject a second capability call or a
// failure after the store write to prove rollback boundaries.
function observationAction({ authorize = () => true, afterWrite, tables = ['SpeakerObservation'] } = {}) {
  let calls = 0;
  return {
    type: 'observation.commit',
    authorize,
    protectedArtefacts: { tables },
    handler({ payload, protectedArtefact, now }) {
      calls += 1;
      if (!protectedArtefact) throw new Error('protected artefact capability missing');
      protectedArtefact.write('SpeakerObservation', {
        id: payload.observationId,
        profileId: payload.profileId,
        vector: VECTOR,
        createdAt: now,
      });
      afterWrite?.(protectedArtefact);
      return {
        events: [{
          type: 'observation.committed',
          scope,
          data: { observationId: payload.observationId, profileId: payload.profileId },
        }],
        canonicalPayload: { observationId: payload.observationId, profileId: payload.profileId },
      };
    },
    get calls() { return calls; },
  };
}

function commitRequest(overrides = {}) {
  return {
    actionId: 'obs-1', scope, type: 'observation.commit',
    payload: { observationId: 'o1', profileId: 'p1', vector: [0.123456789, 0.987654321] },
    principal: user,
    ...overrides,
  };
}

async function appWith(actions) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE SpeakerObservation (id TEXT PRIMARY KEY, profileId TEXT NOT NULL, vector TEXT NOT NULL, createdAt TEXT NOT NULL)');
  const app = workbench({ schema: censusSchema(db), db, actions });
  await app.start();
  return { app, db };
}

test('protected write commits the store row while log, receipt, and delivered events carry only non-sensitive ids', async () => {
  const { app, db } = await appWith([observationAction()]);
  const result = await app.dispatch(commitRequest());

  assert.equal(result.ok, true);
  assert.equal(result.events[0].data.observationId, 'o1');
  assert.equal(result.events[0].data.profileId, 'p1');
  assert.equal(JSON.stringify(result.events[0].data).includes(VECTOR_NEEDLE), false, 'delivered event data must not carry the protected payload');

  const row = db.prepare('SELECT * FROM SpeakerObservation WHERE id = ?').get('o1');
  assert.deepEqual({ ...row }, { id: 'o1', profileId: 'p1', vector: VECTOR, createdAt: row.createdAt });

  const logRow = db.prepare('SELECT * FROM _Log WHERE actionId = ?').get('obs-1');
  assert.equal(logRow.eventType, 'observation.committed');
  assert.equal(JSON.stringify(JSON.parse(logRow.eventData)).includes(VECTOR_NEEDLE), false, '_Log.eventData must not carry the protected payload');

  const receipt = db.prepare('SELECT actionData FROM _ActionReceipt WHERE actionId = ?').get('obs-1');
  assert.deepEqual(JSON.parse(receipt.actionData), { observationId: 'o1', profileId: 'p1' }, 'receipt actionData must be the canonicalPayload, never the request payload');
});

test('the protected payload exists in exactly one table across the whole database', async () => {
  const { app, db } = await appWith([observationAction()]);
  await app.dispatch(commitRequest());
  assert.deepEqual(leakedLocations(db, VECTOR_NEEDLE), ['SpeakerObservation']);
});

test('action deduplication and replay cannot duplicate or rerun the protected write', async () => {
  const action = observationAction();
  const { app, db } = await appWith([action]);

  const first = await app.dispatch(commitRequest());
  const retry = await app.dispatch(commitRequest());

  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true);
  assert.equal(action.calls, 1, 'the handler (and its store write) must not rerun on a deduped retry');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM SpeakerObservation').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _Log').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _ActionReceipt').get().count, 1);
});

test('a failure after a protected write rolls back the store row, log, cursor, and receipt together', async () => {
  const action = observationAction({
    afterWrite(protectedArtefact) {
      assert.equal(protectedArtefact.erase('SpeakerObservation', { id: 'o1' }), 1, 'the store write must be visible inside the owning transaction');
      throw new Error('injected post-write failure');
    },
  });
  const { app, db } = await appWith([action]);

  const result = await app.dispatch(commitRequest());

  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM SpeakerObservation').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _Log').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _Cursor').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _ActionReceipt').get().count, 0);
});

test('authorization denial leaves the protected store untouched', async () => {
  const { app, db } = await appWith([observationAction({ authorize: () => false })]);

  const result = await app.dispatch(commitRequest());

  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'denied');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM SpeakerObservation').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _Log').get().count, 0);
});

test('declared erasure permanently hard-deletes protected rows with no recoverable copy in canonical history', async () => {
  const commit = observationAction();
  const eraseAction = {
    type: 'observation.erase',
    authorize: () => true,
    protectedArtefacts: { tables: ['SpeakerObservation'] },
    handler({ payload, protectedArtefact, now }) {
      if (!protectedArtefact) throw new Error('protected artefact capability missing');
      const changes = protectedArtefact.erase('SpeakerObservation', { id: payload.observationId });
      if (changes !== 1) throw new Error('observation not found');
      return {
        events: [{ type: 'observation.erased', scope, data: { observationId: payload.observationId } }],
        canonicalPayload: { observationId: payload.observationId, erasedAt: now },
      };
    },
  };
  const { app, db } = await appWith([commit, eraseAction]);

  await app.dispatch(commitRequest());
  const erased = await app.dispatch({
    actionId: 'obs-2', scope, type: 'observation.erase',
    payload: { observationId: 'o1' }, principal: user,
  });

  assert.equal(erased.ok, true);
  assert.equal(db.prepare('SELECT 1 FROM SpeakerObservation WHERE id = ?').get('o1'), undefined);
  assert.deepEqual(leakedLocations(db, VECTOR_NEEDLE), [], 'after erasure the protected payload must be gone from every table');
});

test('the capability cannot reach undeclared application tables or Workbench package tables', async () => {
  const attempts = [
    (p) => p.write('OtherTable', { id: 'x' }),
    (p) => p.write('_Log', { scope, seq: 99, eventType: 'x', eventData: '{}', actionId: 'x', committedAt: 'now' }),
    (p) => p.erase('_Log', { scope }),
    (p) => p.erase('BlobStore', { id: 'x' }),
  ];
  for (const attempt of attempts) {
    const { app, db } = await appWith([observationAction({ afterWrite: attempt })]);
    const result = await app.dispatch(commitRequest());
    assert.equal(result.ok, false, 'store access outside the declared tables must fail closed');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM SpeakerObservation').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM _Log').get().count, 0);
  }
});

test('protected writes reject views, shadowed tables, triggers, and foreign-key escape paths', async () => {
  const cases = [
    { name: 'view', setup(db) { db.exec('CREATE TABLE Base (id TEXT PRIMARY KEY); CREATE VIEW SpeakerObservation AS SELECT * FROM Base'); } },
    { name: 'temp shadow', setup(db) { db.exec('CREATE TABLE SpeakerObservation (id TEXT PRIMARY KEY); CREATE TEMP TABLE SpeakerObservation (id TEXT PRIMARY KEY)'); } },
    { name: 'trigger', setup(db) { db.exec('CREATE TABLE SpeakerObservation (id TEXT PRIMARY KEY); CREATE TRIGGER obs_escape AFTER INSERT ON SpeakerObservation BEGIN SELECT 1; END'); } },
    { name: 'outbound FK', setup(db) { db.exec('CREATE TABLE Parent (id TEXT PRIMARY KEY); CREATE TABLE SpeakerObservation (id TEXT PRIMARY KEY, profileId TEXT REFERENCES Parent(id))'); } },
    { name: 'inbound FK', setup(db) { db.exec('CREATE TABLE SpeakerObservation (id TEXT PRIMARY KEY); CREATE TABLE Child (id TEXT PRIMARY KEY, profileId TEXT REFERENCES SpeakerObservation(id))'); } },
  ];
  for (const entry of cases) {
    const db = new DatabaseSync(':memory:');
    entry.setup(db);
    const app = workbench({ schema: censusSchema(db), db, actions: [observationAction()] });
    await app.start();
    const result = await app.dispatch(commitRequest());
    assert.equal(result.ok, false, entry.name);
  }
});

test('a protected artefact capability escaped from the handler is dead after the dispatch', async () => {
  let escaped;
  const action = observationAction({ afterWrite(p) { escaped = p; } });
  const { app, db } = await appWith([action]);

  const result = await app.dispatch(commitRequest());

  assert.equal(result.ok, true);
  assert.throws(() => escaped.write('SpeakerObservation', { id: 'late', profileId: 'p1', vector: '[]', createdAt: 'now' }), /only within the owning action transaction/);
  assert.throws(() => escaped.erase('SpeakerObservation', { id: 'o1' }), /only within the owning action transaction/);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM SpeakerObservation').get().count, 1);
});

test('a protected-artefact action must return a canonicalPayload or the whole dispatch rolls back', async () => {
  const action = {
    type: 'observation.commit',
    authorize: () => true,
    protectedArtefacts: { tables: ['SpeakerObservation'] },
    handler({ payload, protectedArtefact }) {
      protectedArtefact.write('SpeakerObservation', { id: payload.observationId, profileId: payload.profileId, vector: VECTOR, createdAt: 'now' });
      return [{ type: 'observation.committed', scope, data: { observationId: payload.observationId } }];
    },
  };
  const { app, db } = await appWith([action]);

  const result = await app.dispatch(commitRequest());

  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM SpeakerObservation').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _Log').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _ActionReceipt').get().count, 0);
});

test('protected-artefact actions require single dispatch', async () => {
  const { app, db } = await appWith([observationAction()]);

  const result = await app.batch([{ type: 'observation.commit', payload: commitRequest().payload }], { principal: user, scope });

  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM SpeakerObservation').get().count, 0);
});

test('protected-artefact actions fail closed without a durable database', async () => {
  const app = workbench({ schema: fixtureSchema, actions: [observationAction()] });
  await app.start();

  const result = await app.dispatch(commitRequest());

  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
});

test('malformed protectedArtefacts declarations fail at app assembly', async () => {
  const declarations = [
    { tables: [] },
    { tables: 'SpeakerObservation' },
    { tables: [123] },
    { tables: [''] },
    { tables: ['SpeakerObservation'], extra: true },
    true,
  ];
  for (const protectedArtefacts of declarations) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE SpeakerObservation (id TEXT PRIMARY KEY)');
    const app = workbench({ schema: censusSchema(db), db, actions: [{ type: 'x.commit', authorize: () => true, protectedArtefacts, handler: () => [] }] });
    await assert.rejects(app.start(), /protectedArtefacts/);
  }
});
