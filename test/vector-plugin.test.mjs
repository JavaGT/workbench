import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createSearchPluginRegistry } from '../build/search-plugin.mjs';
import { createVectorPlugin, VectorPluginValidationError } from '../build/vector-plugin.mjs';
import { createSearchStalenessBridge } from '../build/search-staleness.mjs';
import { createSearchReconcileEngine } from '../build/search-reconcile.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { createSearchOwnedIndexCapability } from '../build/index-capability.mjs';

const PRINCIPAL = Object.freeze({ type: 'user', id: 'alice' });

function setup({ dimensions = 2, owns = () => true, admitted = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, embedding TEXT, embedding_model TEXT, owner TEXT);');
  const registry = createSearchPluginRegistry();
  const plugin = createVectorPlugin({
    id: 'note-vectors',
    version: '1.0.0',
    source: {
      entity: 'Note',
      vector: 'embedding',
      model: 'embedding_model',
      owns,
    },
    modelSpace: { model: 'embed-v1', dimensions },
    admission: {
      entity: {},
      adapter: {
        admit: async () => ({ admitted, reasonCode: admitted ? null : 'no-capability' }),
        registerResource() {},
      },
    },
  });
  registry.register(plugin);
  registry.bindSource(db);
  const insert = (id, embedding, model = 'embed-v1', owner = 'alice') => {
    db.prepare('INSERT INTO Note (id, embedding, embedding_model, owner) VALUES (?, ?, ?, ?)')
      .run(id, JSON.stringify(embedding), model, owner);
  };
  return { db, registry, plugin, insert };
}

async function rebuild(kit) {
  const outcome = await kit.registry.rebuild('note-vectors');
  assert.equal(outcome.ok, true, outcome.lastError?.message);
}

test('vector plugin rejects a source vector with wrong dimensions', async (t) => {
  const kit = setup();
  t.after(() => kit.db.close());
  kit.insert('n1', [1]);
  const outcome = await kit.registry.rebuild('note-vectors');
  assert.equal(outcome.ok, false);
  assert.ok(outcome.lastError);
  assert.match(outcome.lastError.message, /requires 2/);
  assert.equal(kit.registry.stateOf('note-vectors').state, 'failed');
});

test('vector plugin rejects NaN and infinity at ingest with a typed error', async (t) => {
  const kit = setup();
  t.after(() => kit.db.close());
  // SQLite JSON text permits neither special value, so validate through the
  // public plugin lifecycle with a reader that returns the raw bad values.
  kit.registry.bindSource({
    prepare() {
      return { all: () => [{ id: 'n1', embedding: [1, NaN], embedding_model: 'embed-v1' }], get: () => undefined };
    },
  });
  const nan = await kit.registry.rebuild('note-vectors');
  assert.equal(nan.ok, false);
  assert.match(nan.lastError.message, /non-finite/);

  kit.registry.bindSource({
    prepare() {
      return { all: () => [{ id: 'n1', embedding: [1, Infinity], embedding_model: 'embed-v1' }], get: () => undefined };
    },
  });
  const infinity = await kit.registry.rebuild('note-vectors');
  assert.equal(infinity.ok, false);
  assert.match(infinity.lastError.message, /non-finite/);
});

test('vector plugin rejects model-space mismatch and unauthorized source ownership', async (t) => {
  const mismatch = setup();
  t.after(() => mismatch.db.close());
  mismatch.insert('n1', [1, 0], 'other-model');
  const modelOutcome = await mismatch.registry.rebuild('note-vectors');
  assert.equal(modelOutcome.ok, false);
  assert.match(modelOutcome.lastError.message, /requires 'embed-v1'/);

  const owned = setup({ owns: (row) => row.owner === 'alice' });
  t.after(() => owned.db.close());
  owned.insert('n2', [1, 0], 'embed-v1', 'mallory');
  const ownerOutcome = await owned.registry.rebuild('note-vectors');
  assert.equal(ownerOutcome.ok, false);
  assert.match(ownerOutcome.lastError.message, /not owned/);
});

test('ownership rejection purges stale rows and aborts a partial rebuild', async (t) => {
  const kit = setup({ owns: (row) => row.owner === 'alice' });
  t.after(() => kit.db.close());
  kit.insert('n1', [1, 0]);
  kit.insert('n2', [0, 1]);
  await rebuild(kit);

  kit.db.prepare('UPDATE Note SET owner = ? WHERE id = ?').run('mallory', 'n2');
  const rebuilt = await kit.registry.rebuild('note-vectors');
  assert.equal(rebuilt.ok, false);
  assert.equal(kit.plugin.indexCensus({}).Note.count, 0, 'a failed direct rebuild leaves no partial index active');

  kit.db.prepare('UPDATE Note SET owner = ? WHERE id = ?').run('alice', 'n2');
  await rebuild(kit);
  kit.db.prepare('UPDATE Note SET owner = ? WHERE id = ?').run('mallory', 'n2');
  const reconciled = await kit.registry.reconcile('note-vectors', [{ entity: 'Note', rowId: 'n2', kind: 'updated' }]);
  assert.equal(reconciled.ok, false);
  assert.equal(kit.plugin.indexCensus({}).Note.count, 1, 'a row that loses ownership is removed from the active index');
});

test('vector plugin refuses sources without ownership and contains ownership predicate errors', async (t) => {
  assert.throws(() => createVectorPlugin({
    id: 'unowned-vectors',
    version: '1.0.0',
    source: { entity: 'Note', vector: 'embedding', model: 'embedding_model' },
    modelSpace: { model: 'embed-v1', dimensions: 2 },
  }), /requires an ownership predicate/);

  const kit = setup({ owns: () => { throw new Error('ownership backend unavailable'); } });
  t.after(() => kit.db.close());
  kit.insert('n1', [1, 0]);
  const outcome = await kit.registry.rebuild('note-vectors');
  assert.equal(outcome.ok, false);
  assert.match(outcome.lastError.message, /ownership could not be verified/);
  assert.equal(kit.plugin.indexCensus({}).Note.count, 0);
  assert.throws(
    () => kit.plugin.validateSourceRow({ id: 'n1', embedding: [1, 0], embedding_model: 'embed-v1' }),
    (error) => error instanceof VectorPluginValidationError && error.code === 'unauthorized-source-ownership',
  );
});

test('model or dimension changes create a new generation and refuse cross-space queries', async (t) => {
  const kit = setup();
  t.after(() => kit.db.close());
  kit.insert('n1', [1, 0]);
  await rebuild(kit);
  const before = kit.plugin.generationIdentity;
  kit.plugin.setModelSpace({ model: 'embed-v2', dimensions: 3 });
  assert.notEqual(kit.plugin.generationIdentity, before);
  const changed = kit.registry.stateOf('note-vectors');
  assert.equal(changed.state, 'building');
  assert.ok(changed.generation > 1);
  assert.deepEqual(changed.counts, {});
  const outcome = await kit.registry.search('note-vectors', { principal: PRINCIPAL, query: { model: 'embed-v1', vector: [1, 0] } });
  assert.equal(outcome.ok, false);
  assert.match(outcome.lastError.message, /requires 'embed-v2'/);
});

test('nearest-neighbour search has bounded deterministic ties and removes deleted sources', async (t) => {
  const kit = setup();
  t.after(() => kit.db.close());
  kit.insert('b', [1, 0]);
  kit.insert('a', [1, 0]);
  kit.insert('c', [0, 1]);
  await rebuild(kit);
  const found = await kit.registry.search('note-vectors', {
    principal: PRINCIPAL,
    query: { model: 'embed-v1', vector: [1, 0] },
    limit: 2,
  });
  assert.equal(found.ok, true);
  assert.deepEqual(found.result.hits.map((hit) => hit.id), ['a', 'b']);

  kit.db.prepare('DELETE FROM Note WHERE id = ?').run('a');
  const deleted = await kit.registry.reconcile('note-vectors', [{ entity: 'Note', rowId: 'a', kind: 'removed' }]);
  assert.equal(deleted.ok, true);
  const after = await kit.registry.search('note-vectors', { principal: PRINCIPAL, query: { model: 'embed-v1', vector: [1, 0] } });
  assert.deepEqual(after.result.hits.map((hit) => hit.id), ['b', 'c']);
});

test('vector search applies query-time admission and requires a principal', async (t) => {
  const denied = setup({ admitted: false });
  t.after(() => denied.db.close());
  denied.insert('n1', [1, 0]);
  await rebuild(denied);
  const deniedResult = await denied.registry.search('note-vectors', {
    principal: PRINCIPAL,
    query: { model: 'embed-v1', vector: [1, 0] },
  });
  assert.deepEqual(deniedResult.result?.hits, []);

  const missingPrincipal = await denied.registry.search('note-vectors', {
    query: { model: 'embed-v1', vector: [1, 0] },
  });
  assert.equal(missingPrincipal.ok, false);
  assert.match(missingPrincipal.lastError?.message ?? '', /requires a principal/);
});

test('vector admission configuration must expose callable admit', () => {
  assert.throws(() => createVectorPlugin({
    id: 'invalid-admission',
    version: '1.0.0',
    source: { entity: 'Note', vector: 'embedding', model: 'embedding_model', owns: () => true },
    modelSpace: { model: 'embed-v1', dimensions: 2 },
    admission: {},
  }), /requires a search admission configuration/);
});

test('vector search honors an already-cancelled request', async (t) => {
  const kit = setup();
  t.after(() => kit.db.close());
  kit.insert('n1', [1, 0]);
  await rebuild(kit);
  const controller = new AbortController();
  controller.abort();
  const result = await kit.registry.search('note-vectors', {
    principal: PRINCIPAL,
    query: { model: 'embed-v1', vector: [1, 0] },
    signal: controller.signal,
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.result, null);
});

test('vector search yields so an abort stops a large scoring pass', async (t) => {
  const kit = setup({ dimensions: 64 });
  t.after(() => kit.db.close());
  for (let index = 0; index < 4_000; index += 1) kit.insert(`n${index}`, Array(64).fill(1));
  await rebuild(kit);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 0);
  const result = await kit.registry.search('note-vectors', {
    principal: PRINCIPAL,
    query: { model: 'embed-v1', vector: Array(64).fill(1) },
    signal: controller.signal,
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.result, null);
});

test('vector plugin supports A3 shadow rebuild, validation, and parity census', async (t) => {
  const kit = setup();
  const bridge = createSearchStalenessBridge({ registry: kit.registry });
  bridge.engage(kit.db);
  const queue = createWriteQueue();
  const engine = createSearchReconcileEngine({ registry: kit.registry, staleness: bridge, db: kit.db, writeQueue: queue });
  t.after(async () => {
    await queue.close();
    kit.db.close();
  });
  kit.insert('n1', [1, 0]);
  const rebuilt = await engine.rebuildShadow('note-vectors');
  assert.equal(rebuilt.ok, true, rebuilt.lastError ?? 'rebuild failed');
  assert.equal(rebuilt.activated, true);
  assert.equal(engine.parity('note-vectors').matches, true);
  assert.equal(kit.plugin.indexCensus({}).Note.count, 1);
});

test('vector search scope is a candidate-selection predicate, not a post-ranking filter', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, projectId TEXT, embedding TEXT, embedding_model TEXT);');
  const registry = createSearchPluginRegistry();
  const plugin = createVectorPlugin({
    id: 'project-vectors',
    version: '1.0.0',
    source: {
      entity: 'Note',
      vector: 'embedding',
      model: 'embedding_model',
      owns: () => true,
    },
    modelSpace: { model: 'embed-v1', dimensions: 2 },
    // Low-level unit fixture: this test exercises scope-based CANDIDATE
    // SELECTION only, with no authorization adapter. Opting into the unsafe
    // unadmitted path explicitly keeps the production default fail-closed.
    unsafeAllowUnauthorizedSearch: true,
  });
  registry.register(plugin);
  registry.bindSource(db);
  const insert = (id, projectId, embedding) => {
    db.prepare('INSERT INTO Note (id, projectId, embedding, embedding_model) VALUES (?, ?, ?, ?)')
      .run(id, projectId, JSON.stringify(embedding), 'embed-v1');
  };
  // The foreign row outranks every row of the queried project, so a window that
  // ranks the whole index first cannot reach the project's own match.
  insert('foreign-nearest', 'project-b', [1, 0]);
  insert('own-match', 'project-a', [0.1, 0.995]);
  insert('own-other', 'project-a', [0, 1]);
  insert('foreign-other', 'project-b', [0, 1]);
  const rebuilt = await registry.rebuild('project-vectors');
  assert.equal(rebuilt.ok, true, rebuilt.lastError?.message);

  const global = await registry.search('project-vectors', {
    principal: PRINCIPAL,
    query: { model: 'embed-v1', vector: [1, 0] },
    limit: 1,
  });
  assert.deepEqual(global.result.hits.map((hit) => hit.id), ['foreign-nearest'], 'unscoped search ranks the whole index');

  const scoped = await registry.search('project-vectors', {
    principal: PRINCIPAL,
    query: { model: 'embed-v1', vector: [1, 0], scope: { projectId: 'project-a' } },
    limit: 1,
  });
  assert.deepEqual(scoped.result.hits.map((hit) => hit.id), ['own-match'], 'scoped search ranks only the matching partition');

  const scopedWindow = await registry.search('project-vectors', {
    principal: PRINCIPAL,
    query: { model: 'embed-v1', vector: [1, 0], scope: { projectId: 'project-a' } },
    offset: 1,
    limit: 1,
  });
  assert.deepEqual(scopedWindow.result.hits.map((hit) => hit.id), ['own-other'], 'the caller window slices the scoped ranking');

  const emptyScope = await registry.search('project-vectors', {
    principal: PRINCIPAL,
    query: { model: 'embed-v1', vector: [1, 0], scope: { projectId: 'project-missing' } },
    limit: 1,
  });
  assert.deepEqual(emptyScope.result.hits, [], 'a partition with no rows yields no hits');

  const invalidScope = await registry.search('project-vectors', {
    principal: PRINCIPAL,
    query: { model: 'embed-v1', vector: [1, 0], scope: ['project-a'] },
    limit: 1,
  });
  assert.equal(invalidScope.ok, false);
  assert.match(invalidScope.lastError?.message ?? '', /source-row predicate/);
});

test('vector search fails closed without a search admission adapter', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, embedding TEXT, embedding_model TEXT);');
  const registry = createSearchPluginRegistry();
  registry.register(createVectorPlugin({
    id: 'note-vectors-unadmitted',
    version: '1.0.0',
    source: { entity: 'Note', vector: 'embedding', model: 'embedding_model', owns: () => true },
    modelSpace: { model: 'embed-v1', dimensions: 2 },
  }));
  registry.bindSource(db);
  db.prepare('INSERT INTO Note (id, embedding, embedding_model) VALUES (?, ?, ?)')
    .run('n1', JSON.stringify([1, 0]), 'embed-v1');
  const rebuilt = await registry.rebuild('note-vectors-unadmitted');
  assert.equal(rebuilt.ok, true, rebuilt.lastError?.message);

  const outcome = await registry.search('note-vectors-unadmitted', {
    principal: PRINCIPAL,
    query: { model: 'embed-v1', vector: [1, 0] },
    limit: 10,
  });
  assert.equal(outcome.ok, false, 'an unadmitted vector index must not disclose hits');
  assert.equal(outcome.result, null);
  assert.match(outcome.lastError?.message ?? '', /admission adapter/);
});

test('validation errors retain a typed code', () => {
  const kit = setup();
  assert.throws(
    () => kit.plugin.validateSourceRow({ id: 'n1', embedding: [1], embedding_model: 'embed-v1' }),
    (error) => error instanceof VectorPluginValidationError && error.code === 'dimension-mismatch',
  );
  kit.db.close();
});

// ---- 1:N derived segments ---------------------------------------------------

const derivedSchema = `
  CREATE TABLE Note (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    revision TEXT NOT NULL,
    owner TEXT NOT NULL
  );
  CREATE TABLE NoteSegment (
    id TEXT PRIMARY KEY,
    segmentId TEXT NOT NULL,
    noteId TEXT NOT NULL,
    projectId TEXT NOT NULL,
    revision TEXT NOT NULL,
    embedding TEXT,
    embedding_model TEXT,
    modality TEXT,
    startMs INTEGER,
    endMs INTEGER,
    contentHash TEXT
  );
`;

async function derivedSetup(t, { dimensions = 2 } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(derivedSchema);
  const registry = createSearchPluginRegistry();
  const plugin = createVectorPlugin({
    id: 'multimodal-vectors',
    version: '1.0.0',
    source: {
      entity: 'NoteSegment',
      vector: 'embedding',
      model: 'embedding_model',
      scopeField: 'projectId',
      owns: () => true,
      parent: {
        entity: 'Note',
        field: 'noteId',
        revisionField: 'revision',
        projectField: 'projectId',
        parentRevisionField: 'revision',
        parentProjectField: 'projectId',
        segmentIdField: 'segmentId',
      },
    },
    modelSpace: { model: 'embed-v1', dimensions },
    admission: {
      entity: {},
      adapter: {
        registerResource() {},
        async admit({ row }) {
          const admitted = row?.owner === 'alice';
          return { admitted, reasonCode: admitted ? null : 'no-capability' };
        },
      },
    },
  });
  registry.register(plugin);
  registry.bindSource(db);
  for (const entry of registry.census().entries) db.exec(entry.sql);
  const queue = createWriteQueue();
  const census = new Map();
  for (const object of plugin.ownedObjects) {
    census.set(`${object.kind}:${object.name}`.toLowerCase(), {
      kind: 'plugin', owner: plugin.id, objectKind: object.kind, name: object.name,
    });
  }
  registry.bindIndex(createSearchOwnedIndexCapability({
    db,
    census,
    writeCoordinator: queue,
    fenceOf: (id) => registry.stateOf(id).fence,
  }));
  const prepared = await registry.prepare('multimodal-vectors');
  assert.equal(prepared.ok, true, prepared.lastError?.message);
  t.after(async () => {
    await queue.close();
    db.close();
  });
  const insertNote = db.prepare('INSERT INTO Note (id, projectId, revision, owner) VALUES (?, ?, ?, ?)');
  const insertSegment = db.prepare(
    `INSERT INTO NoteSegment
       (id, segmentId, noteId, projectId, revision, embedding, embedding_model, modality, startMs, endMs, contentHash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return {
    db,
    registry,
    plugin,
    queue,
    note: (id, projectId, revision = 'r1', owner = 'alice') => insertNote.run(id, projectId, revision, owner),
    segment: (id, noteId, projectId, embedding, {
      revision = 'r1', segmentId = id, modality = 'video', start = 0, end = 1, hash = `h-${id}`,
      model = 'embed-v1',
    } = {}) => insertSegment.run(
      id, segmentId, noteId, projectId, revision, JSON.stringify(embedding), model, modality, start, end, hash,
    ),
    rebuild: async () => {
      const outcome = await registry.rebuild('multimodal-vectors');
      assert.equal(outcome.ok, true, outcome.lastError?.message);
      return outcome;
    },
    search: (vector, options = {}) => registry.search('multimodal-vectors', {
      principal: PRINCIPAL,
      query: { model: 'embed-v1', vector },
      ...options,
    }),
  };
}

test('derived segments index N per parent and re-authorize the CURRENT parent', async (t) => {
  const kit = await derivedSetup(t);
  kit.note('n1', 'p1');
  kit.segment('s1', 'n1', 'p1', [1, 0], { modality: 'video', start: 0, end: 4, hash: 'h1' });
  kit.segment('s2', 'n1', 'p1', [0, 1], { modality: 'text', start: 4, end: 8, hash: 'h2' });
  await kit.rebuild();

  const found = await kit.search([1, 0], { limit: 10 });
  assert.equal(found.ok, true, found.lastError?.message);
  assert.deepEqual(found.result.hits.map((hit) => hit.id), ['s1', 's2']);
  assert.deepEqual(found.result.hits[0], {
    id: 's1',
    score: 1,
    sourceId: 'n1',
    segmentId: 's1',
    projectId: 'p1',
    sourceRevision: 'r1',
    authorizationEntity: 'Note',
    authorizationRowId: 'n1',
  });

  // Authorization is evaluated against the parent as it exists now, not at
  // index time.
  kit.db.prepare('UPDATE Note SET owner = ? WHERE id = ?').run('mallory', 'n1');
  const denied = await kit.search([1, 0], { limit: 10 });
  assert.deepEqual(denied.result.hits, []);
});

test('derived segments are fenced to the parent current revision', async (t) => {
  const kit = await derivedSetup(t);
  kit.note('n1', 'p1', 'r1');
  kit.segment('s1', 'n1', 'p1', [1, 0]);
  await kit.rebuild();
  assert.equal((await kit.search([1, 0])).result.hits.length, 1);

  kit.db.prepare('UPDATE Note SET revision = ? WHERE id = ?').run('r2', 'n1');
  assert.deepEqual((await kit.search([1, 0])).result.hits, [], 'an old-revision segment is fenced immediately');

  kit.segment('s2', 'n1', 'p1', [1, 0], { revision: 'r2' });
  const reconciled = await kit.registry.reconcile('multimodal-vectors', [
    { entity: 'NoteSegment', rowId: 's2', kind: 'created' },
  ]);
  assert.equal(reconciled.ok, true, reconciled.lastError?.message);
  assert.deepEqual((await kit.search([1, 0])).result.hits.map((hit) => hit.id), ['s2']);
});

test('derived segment and parent deletion use the existing search lifecycle', async (t) => {
  const kit = await derivedSetup(t);
  kit.note('n1', 'p1');
  kit.segment('s1', 'n1', 'p1', [1, 0]);
  kit.segment('s2', 'n1', 'p1', [0.5, 0.5]);
  await kit.rebuild();

  kit.db.prepare('DELETE FROM NoteSegment WHERE id = ?').run('s2');
  const segmentRemoved = await kit.registry.reconcile('multimodal-vectors', [
    { entity: 'NoteSegment', rowId: 's2', kind: 'removed' },
  ]);
  assert.equal(segmentRemoved.ok, true, segmentRemoved.lastError?.message);
  assert.deepEqual((await kit.search([1, 0])).result.hits.map((hit) => hit.id), ['s1']);

  kit.db.prepare('DELETE FROM Note WHERE id = ?').run('n1');
  assert.deepEqual((await kit.search([1, 0])).result.hits, [], 'a missing parent is omitted before reconciliation');
  const parentRemoved = await kit.registry.reconcile('multimodal-vectors', [
    { entity: 'Note', rowId: 'n1', kind: 'removed' },
  ]);
  assert.equal(parentRemoved.ok, true, parentRemoved.lastError?.message);
  assert.equal(kit.registry.healthOf('multimodal-vectors').plugin.vectors, 0);
});

test('derived search filters before pagination and refills denied windows', async (t) => {
  const kit = await derivedSetup(t);
  kit.note('n1', 'p1', 'r1', 'alice');
  kit.note('n2', 'p2', 'r1', 'alice');
  kit.note('n3', 'p1', 'r1', 'mallory');
  kit.segment('row-blocked', 'n3', 'p1', [1, 0]);
  kit.segment('row-foreign', 'n2', 'p2', [1, 0], { segmentId: 'shared' });
  kit.segment('row-a', 'n1', 'p1', [0.8, 0.6], { segmentId: 'shared' });
  kit.segment('row-b', 'n1', 'p1', [0.6, 0.8]);
  kit.segment('row-c', 'n1', 'p1', [0, 1]);
  await kit.rebuild();

  const firstPage = await kit.search([1, 0], { scope: { projectId: 'p1' }, limit: 2 });
  assert.equal(firstPage.ok, true, firstPage.lastError?.message);
  assert.deepEqual(firstPage.result.hits.map((hit) => hit.id), ['row-a', 'row-b']);
  assert.ok(firstPage.result.hits.every((hit) => hit.projectId === 'p1'));
  assert.equal(firstPage.result.hits[0].segmentId, 'shared');

  const secondPage = await kit.search([1, 0], { scope: { projectId: 'p1' }, offset: 1, limit: 1 });
  assert.deepEqual(secondPage.result.hits.map((hit) => hit.id), ['row-b'], 'offset slices the authorized window');

  const otherProject = await kit.search([1, 0], { scope: { projectId: 'p2' }, limit: 1 });
  assert.deepEqual(otherProject.result.hits.map((hit) => hit.id), ['row-foreign']);
  assert.equal(otherProject.result.hits[0].segmentId, 'shared', 'same segment id in another project keeps its own row identity');
});

function generationTables(plugin) {
  return plugin.ownedObjects
    .filter((object) => object.kind === 'table' && /_g[01]$/.test(object.name))
    .map((object) => object.name);
}

function stateTableOf(plugin) {
  return plugin.ownedObjects.find((object) => object.kind === 'table' && object.name.endsWith('_state')).name;
}

function storedCount(db, table, column, value) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(value).count);
}

test('erasing a parent purges its derived segments through rebuild', async (t) => {
  const kit = await derivedSetup(t);
  kit.note('n1', 'p1');
  kit.segment('s1', 'n1', 'p1', [1, 0]);
  await kit.rebuild();

  kit.db.prepare('DELETE FROM Note WHERE id = ?').run('n1');
  const outcome = await kit.registry.revoke('multimodal-vectors', {
    kind: 'erasure',
    entity: 'Note',
    rowId: 'n1',
  });
  assert.equal(outcome.ok, true, outcome.lastError?.message);
  assert.equal(kit.registry.healthOf('multimodal-vectors').plugin.vectors, 0);
});

test('an erased parent is purged from every generation and cannot return on rollback', async (t) => {
  const kit = await derivedSetup(t);
  kit.note('n1', 'p1');
  kit.segment('s1', 'n1', 'p1', [1, 0]);
  await kit.rebuild();
  const generations = generationTables(kit.plugin);
  assert.equal(generations.length, 2);
  assert.equal(generations.reduce((total, table) => total + storedCount(kit.db, table, 'parent_key', 'n1'), 0), 1);

  kit.db.prepare('DELETE FROM Note WHERE id = ?').run('n1');
  const outcome = await kit.registry.revoke('multimodal-vectors', {
    kind: 'erasure',
    entity: 'Note',
    rowId: 'n1',
  });
  assert.equal(outcome.ok, true, outcome.lastError?.message);
  assert.deepEqual(generations.map((table) => storedCount(kit.db, table, 'parent_key', 'n1')), [0, 0]);
  assert.deepEqual((await kit.search([1, 0], { limit: 10 })).result.hits, []);

  kit.db.prepare(`UPDATE ${stateTableOf(kit.plugin)} SET active = previous WHERE slot = 'active'`).run();
  assert.deepEqual((await kit.search([1, 0], { limit: 10 })).result.hits, [], 'the retained generation cannot resurrect erased derived vectors');
});

test('removing a segment purges its stored vector from every generation', async (t) => {
  const kit = await derivedSetup(t);
  kit.note('n1', 'p1');
  kit.segment('s1', 'n1', 'p1', [1, 0]);
  kit.segment('s2', 'n1', 'p1', [0, 1]);
  await kit.rebuild();
  const generations = generationTables(kit.plugin);
  assert.equal(generations.reduce((total, table) => total + storedCount(kit.db, table, 'source_key', 's2'), 0), 1);

  kit.db.prepare('DELETE FROM NoteSegment WHERE id = ?').run('s2');
  const removed = await kit.registry.reconcile('multimodal-vectors', [
    { entity: 'NoteSegment', rowId: 's2', kind: 'removed' },
  ]);
  assert.equal(removed.ok, true, removed.lastError?.message);
  assert.deepEqual(generations.map((table) => storedCount(kit.db, table, 'source_key', 's2')), [0, 0]);
  assert.deepEqual((await kit.search([1, 0], { limit: 10 })).result.hits.map((hit) => hit.id), ['s1']);
});

test('a stale embedding is never disclosed under an advanced segment revision', async (t) => {
  const kit = await derivedSetup(t);
  kit.note('n1', 'p1', 'r1');
  kit.segment('s1', 'n1', 'p1', [1, 0], { revision: 'r1' });
  await kit.rebuild();

  kit.db.prepare('UPDATE Note SET revision = ? WHERE id = ?').run('r2', 'n1');
  kit.db.prepare('UPDATE NoteSegment SET revision = ?, embedding = ? WHERE id = ?')
    .run('r2', JSON.stringify([0, 1]), 's1');
  assert.deepEqual(
    (await kit.search([1, 0], { limit: 10 })).result.hits,
    [],
    'the r1 embedding is not served as the r2 revision',
  );

  const reconciled = await kit.registry.reconcile('multimodal-vectors', [
    { entity: 'NoteSegment', rowId: 's1', kind: 'updated' },
  ]);
  assert.equal(reconciled.ok, true, reconciled.lastError?.message);
  const current = await kit.search([1, 0], { limit: 10 });
  assert.deepEqual(current.result.hits.map((hit) => hit.id), ['s1']);
  assert.equal(current.result.hits[0].sourceRevision, 'r2');
  assert.equal(current.result.hits[0].score, 0, 'the r2 embedding replaced the r1 vector');
});

test('a derived index serves the declared space only after it materializes, retaining the old space', async (t) => {
  const kit = await derivedSetup(t);
  kit.note('n1', 'p1');
  kit.segment('s1', 'n1', 'p1', [1, 0]);
  await kit.rebuild();

  kit.plugin.setModelSpace({ model: 'embed-v2', dimensions: 2 });
  assert.equal(kit.registry.stateOf('multimodal-vectors').state, 'building');
  // The retained generation is still a valid v1 index: a v1 query is answered
  // from it rather than from a half-built v2 space.
  const oldSpace = await kit.search([1, 0]);
  assert.equal(oldSpace.ok, true, oldSpace.lastError?.message);
  assert.deepEqual(oldSpace.result.hits.map((hit) => hit.id), ['s1']);
  assert.equal(oldSpace.state, 'building');
  // The declared v2 space has no materialization yet: no hits, never v1 bytes
  // reinterpreted as v2.
  const newSpace = await kit.registry.search('multimodal-vectors', {
    principal: PRINCIPAL,
    query: { model: 'embed-v2', vector: [1, 0] },
    limit: 10,
  });
  assert.deepEqual(newSpace.result.hits, []);

  // A v2 rebuild while the source rows are still v1 must FAIL and leave the
  // retained v1 index searchable — the staged transition's failure behavior.
  const failed = await kit.registry.rebuild('multimodal-vectors');
  assert.equal(failed.ok, false);
  assert.match(failed.lastError?.message ?? '', /requires 'embed-v2'/);
  assert.deepEqual((await kit.search([1, 0])).result.hits.map((hit) => hit.id), ['s1']);
  assert.deepEqual(kit.registry.healthOf('multimodal-vectors').plugin.activeSpace, { model: 'embed-v1', dimensions: 2 });

  // Only a complete v2 generation activates v2, atomically.
  kit.db.prepare('UPDATE NoteSegment SET embedding_model = ?, embedding = ? WHERE id = ?')
    .run('embed-v2', JSON.stringify([0, 1]), 's1');
  await kit.rebuild();
  const activated = await kit.registry.search('multimodal-vectors', {
    principal: PRINCIPAL,
    query: { model: 'embed-v2', vector: [0, 1] },
    limit: 10,
  });
  assert.deepEqual(activated.result.hits.map((hit) => hit.id), ['s1']);
  // The retained v1 bytes are no longer reachable once v2 is active.
  const retired = await kit.search([1, 0]);
  assert.equal(retired.ok, false);
  assert.match(retired.lastError?.message ?? '', /requires 'embed-v2'/);
});

test('derived segments shadow-rebuild with parity over the fenced projection', async (t) => {
  const kit = await derivedSetup(t);
  kit.note('n1', 'p1');
  kit.note('n2', 'p2');
  kit.segment('s1', 'n1', 'p1', [1, 0]);
  kit.segment('s2', 'n1', 'p1', [0, 1]);
  kit.segment('s3', 'n2', 'p2', [1, 0]);
  // A stale segment is not part of the materialized projection.
  kit.note('stale', 'p1', 'r1');
  kit.segment('old', 'stale', 'p1', [1, 0], { revision: 'r0' });
  await kit.rebuild();

  const bridge = createSearchStalenessBridge({ registry: kit.registry });
  bridge.engage(kit.db);
  const engine = createSearchReconcileEngine({
    registry: kit.registry,
    staleness: bridge,
    db: kit.db,
    writeQueue: kit.queue,
  });
  const shadow = await engine.rebuildShadow('multimodal-vectors');
  assert.equal(shadow.ok, true, shadow.lastError ?? 'shadow rebuild failed');
  assert.equal(shadow.activated, true);
  assert.equal(engine.parity('multimodal-vectors').matches, true);
  const found = await kit.search([1, 0], { limit: 10 });
  assert.deepEqual(found.result.hits.map((hit) => hit.id), ['s1', 's3', 's2']);
  assert.ok(!found.result.hits.some((hit) => hit.id === 'old'), 'a stale segment is not part of the projection');
});

test('a failed derived rebuild leaves the last good generation searchable', async (t) => {
  const kit = await derivedSetup(t);
  kit.note('n1', 'p1');
  kit.segment('s1', 'n1', 'p1', [1, 0]);
  await kit.rebuild();

  kit.segment('bad', 'n1', 'p1', [1, 0], { model: 'other-model' });
  const failed = await kit.registry.rebuild('multimodal-vectors');
  assert.equal(failed.ok, false);
  assert.match(failed.lastError?.message ?? '', /requires 'embed-v1'/);
  const found = await kit.search([1, 0], { limit: 10 });
  assert.deepEqual(found.result.hits.map((hit) => hit.id), ['s1'], 'the active generation survives a failed scan');
});

test('derived segments follow the CURRENT parent project fence', async (t) => {
  const kit = await derivedSetup(t);
  kit.note('n1', 'p1');
  kit.segment('s1', 'n1', 'p1', [1, 0]);
  await kit.rebuild();
  assert.deepEqual(
    (await kit.search([1, 0], { scope: { projectId: 'p1' } })).result.hits.map((hit) => hit.id),
    ['s1'],
  );

  kit.db.prepare('UPDATE Note SET projectId = ? WHERE id = ?').run('p2', 'n1');
  assert.deepEqual(
    (await kit.search([1, 0], { scope: { projectId: 'p1' } })).result.hits,
    [],
    'the old project window no longer discloses the segment',
  );
  assert.deepEqual(
    (await kit.search([1, 0], { scope: { projectId: 'p2' } })).result.hits,
    [],
    'a segment whose stored project differs from the current parent project is fenced',
  );

  const parentChanged = await kit.registry.reconcile('multimodal-vectors', [
    { entity: 'Note', rowId: 'n1', kind: 'updated' },
  ]);
  assert.equal(parentChanged.ok, true, parentChanged.lastError?.message);

  kit.segment('s2', 'n1', 'p2', [1, 0]);
  const rederived = await kit.registry.reconcile('multimodal-vectors', [
    { entity: 'NoteSegment', rowId: 's2', kind: 'created' },
  ]);
  assert.equal(rederived.ok, true, rederived.lastError?.message);
  assert.deepEqual(
    (await kit.search([1, 0], { scope: { projectId: 'p2' } })).result.hits.map((hit) => hit.id),
    ['s2'],
  );
});

// ---- persistent schema upgrade, purge and failure behavior ------------------

const BASE = 'vec_note_vectors';
const legacyGeneration = (name) => [
  `CREATE TABLE ${name} (source_key TEXT PRIMARY KEY, scope_id TEXT NOT NULL DEFAULT '', norm REAL NOT NULL, embedding BLOB NOT NULL);`,
  `CREATE INDEX ${name}_scope_idx ON ${name} (scope_id);`,
];
const legacyState = `CREATE TABLE ${BASE}_state (slot TEXT PRIMARY KEY CHECK (slot = 'active'), active INTEGER NOT NULL CHECK (active IN (0, 1)), previous INTEGER NOT NULL CHECK (previous IN (0, 1)), model TEXT NOT NULL, dimensions INTEGER NOT NULL);
  INSERT INTO ${BASE}_state VALUES ('active', 0, 0, 'embed-v1', 2);`;
const float32 = (values) => new Uint8Array(new Float32Array(values).buffer.slice(0));

async function bindOwnedIndex(t, db, registry, plugin) {
  const queue = createWriteQueue();
  const census = new Map();
  for (const object of plugin.ownedObjects) {
    census.set(`${object.kind}:${object.name}`.toLowerCase(), {
      kind: 'plugin', owner: plugin.id, objectKind: object.kind, name: object.name,
    });
  }
  registry.bindIndex(createSearchOwnedIndexCapability({
    db, census, writeCoordinator: queue, fenceOf: (id) => registry.stateOf(id).fence,
  }));
  t.after(async () => { await queue.close(); });
}

function persistentNotePlugin() {
  return createVectorPlugin({
    id: 'note-vectors',
    version: '1.0.0',
    source: { entity: 'Note', vector: 'embedding', model: 'embedding_model', owns: () => true },
    modelSpace: { model: 'embed-v1', dimensions: 2 },
    admission: {
      entity: { name: 'Note' },
      adapter: { registerResource() {}, async admit() { return { admitted: true, reasonCode: null }; } },
    },
  });
}

// An index written before the derived-segment change already holds vectors and
// its four-column tables. Boot must NOT need an ALTER: those rows stay readable
// and writable, with no rebuild and no data loss.
test('a persistent vector index created before the fence columns upgrades without losing vectors', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, embedding TEXT, embedding_model TEXT, owner TEXT);');
  for (const sql of [
    legacyState,
    ...legacyGeneration(`${BASE}_g0`),
    ...legacyGeneration(`${BASE}_g1`),
  ]) db.exec(sql);
  db.prepare(`INSERT INTO ${BASE}_g0 (source_key, scope_id, norm, embedding) VALUES (?, '', 1, ?)`)
    .run('legacy', float32([1, 0]));
  db.prepare('INSERT INTO Note (id, embedding, embedding_model, owner) VALUES (?, ?, ?, ?)')
    .run('legacy', JSON.stringify([1, 0]), 'embed-v1', 'alice');
  db.prepare('INSERT INTO Note (id, embedding, embedding_model, owner) VALUES (?, ?, ?, ?)')
    .run('fresh', JSON.stringify([0, 1]), 'embed-v1', 'alice');

  const registry = createSearchPluginRegistry();
  const plugin = persistentNotePlugin();
  registry.register(plugin);
  registry.bindSource(db);
  await bindOwnedIndex(t, db, registry, plugin);
  const prepared = await registry.prepare('note-vectors');
  assert.equal(prepared.ok, true, prepared.lastError?.message);

  // The ordinary declaration keeps the legacy column shape, so no upgrade DDL
  // is implied for existing tables.
  const generationDdl = plugin.ownedObjects
    .filter((object) => object.kind === 'table' && /_g[01]$/.test(object.name))
    .map((object) => object.ddl.join(' '))
    .join(' ');
  assert.doesNotMatch(generationDdl, /parent_key/);

  // The existing vector is served immediately, before any rebuild.
  const served = await registry.search('note-vectors', {
    principal: PRINCIPAL,
    query: { model: 'embed-v1', vector: [1, 0] },
    limit: 10,
  });
  assert.equal(served.ok, true, served.lastError?.message);
  assert.deepEqual(served.result.hits.map((hit) => hit.id), ['legacy']);
  assert.equal(served.result.hits[0].score, 1);

  // New writes and a full rebuild work against the same tables.
  const reconciled = await registry.reconcile('note-vectors', [{ entity: 'Note', rowId: 'fresh', kind: 'created' }]);
  assert.equal(reconciled.ok, true, reconciled.lastError?.message);
  const rebuilt = await registry.rebuild('note-vectors');
  assert.equal(rebuilt.ok, true, rebuilt.lastError?.message);
  const after = await registry.search('note-vectors', {
    principal: PRINCIPAL,
    query: { model: 'embed-v1', vector: [1, 0] },
    limit: 10,
  });
  assert.deepEqual(after.result.hits.map((hit) => hit.id), ['legacy', 'fresh']);
  db.close();
});

// An ordinary table written by the intermediate build carries the fence columns
// UNUSED. Explicit column lists must still read and write it.
test('an ordinary index tolerates a generation table that carries unused fence columns', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, embedding TEXT, embedding_model TEXT, owner TEXT);');
  db.exec(legacyState);
  for (const name of [`${BASE}_g0`, `${BASE}_g1`]) {
    db.exec(`CREATE TABLE ${name} (source_key TEXT PRIMARY KEY, scope_id TEXT NOT NULL DEFAULT '', norm REAL NOT NULL, embedding BLOB NOT NULL, parent_key TEXT NOT NULL DEFAULT '', revision TEXT NOT NULL DEFAULT '', project_key TEXT NOT NULL DEFAULT '');`);
    db.exec(`CREATE INDEX ${name}_scope_idx ON ${name} (scope_id);`);
  }
  db.prepare(`INSERT INTO ${BASE}_g0 (source_key, scope_id, norm, embedding) VALUES (?, '', 1, ?)`)
    .run('legacy', float32([1, 0]));
  db.prepare('INSERT INTO Note (id, embedding, embedding_model, owner) VALUES (?, ?, ?, ?)')
    .run('legacy', JSON.stringify([1, 0]), 'embed-v1', 'alice');

  const registry = createSearchPluginRegistry();
  const plugin = persistentNotePlugin();
  registry.register(plugin);
  registry.bindSource(db);
  await bindOwnedIndex(t, db, registry, plugin);
  assert.equal((await registry.prepare('note-vectors')).ok, true);
  const served = await registry.search('note-vectors', {
    principal: PRINCIPAL,
    query: { model: 'embed-v1', vector: [1, 0] },
    limit: 10,
  });
  assert.deepEqual(served.result.hits.map((hit) => hit.id), ['legacy']);
  assert.equal((await registry.rebuild('note-vectors')).ok, true);
  db.close();
});

// A DERIVED source cannot reuse a pre-fence table, and the owned-index
// capability cannot ALTER one. Refuse at boot with an actionable message
// instead of failing halfway through the first write.
test('a derived source refuses a pre-fence generation table with a rebuild diagnostic', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec(derivedSchema);
  db.exec(legacyState);
  for (const name of [`${BASE}_g0`, `${BASE}_g1`]) db.exec(legacyGeneration(name)[0]);
  const registry = createSearchPluginRegistry();
  const plugin = createVectorPlugin({
    id: 'note-vectors',
    version: '1.0.0',
    source: {
      entity: 'NoteSegment', vector: 'embedding', model: 'embedding_model', owns: () => true,
      parent: {
        entity: 'Note', field: 'noteId', revisionField: 'revision', projectField: 'projectId',
        parentRevisionField: 'revision', parentProjectField: 'projectId',
      },
    },
    modelSpace: { model: 'embed-v1', dimensions: 2 },
    admission: { entity: { name: 'Note' }, adapter: { registerResource() {}, async admit() { return { admitted: true, reasonCode: null }; } } },
  });
  registry.register(plugin);
  registry.bindSource(db);
  await bindOwnedIndex(t, db, registry, plugin);
  const prepared = await registry.prepare('note-vectors');
  assert.equal(prepared.ok, false);
  assert.match(prepared.lastError?.message ?? '', /predates the segment fence schema/);
  db.close();
});

test('removing a parent purges its vectors from BOTH generations, not just the active one', async (t) => {
  const kit = await derivedSetup(t);
  kit.note('n1', 'p1');
  kit.segment('s1', 'n1', 'p1', [1, 0]);
  await kit.rebuild();
  const generations = generationTables(kit.plugin);
  assert.equal(generations.reduce((total, table) => total + storedCount(kit.db, table, 'parent_key', 'n1'), 0), 1);

  kit.db.prepare('DELETE FROM Note WHERE id = ?').run('n1');
  const removed = await kit.registry.reconcile('multimodal-vectors', [
    { entity: 'Note', rowId: 'n1', kind: 'removed' },
  ]);
  assert.equal(removed.ok, true, removed.lastError?.message);
  assert.deepEqual(generations.map((table) => storedCount(kit.db, table, 'parent_key', 'n1')), [0, 0]);
  assert.equal(kit.registry.healthOf('multimodal-vectors').plugin.vectors, 0);
  assert.deepEqual((await kit.search([1, 0], { limit: 10 })).result.hits, []);
});

test('a stale segment is fenced BEFORE its bytes are parsed, so it cannot abort a rebuild', async (t) => {
  const kit = await derivedSetup(t);
  kit.note('n1', 'p1', 'r2');
  // A stale r1 row whose stored embedding is not valid JSON.
  kit.db.prepare(
    'INSERT INTO NoteSegment (id, segmentId, noteId, projectId, revision, embedding, embedding_model) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('stale', 'stale', 'n1', 'p1', 'r1', 'not-json', 'embed-v1');
  kit.segment('current', 'n1', 'p1', [1, 0], { revision: 'r2' });

  await kit.rebuild();
  const found = await kit.search([1, 0], { limit: 10 });
  assert.deepEqual(found.result.hits.map((hit) => hit.id), ['current']);

  // A CURRENT row with the same corruption is still a real error.
  kit.segment('broken', 'n1', 'p1', [1, 0], { revision: 'r2' });
  kit.db.prepare('UPDATE NoteSegment SET embedding = ? WHERE id = ?').run('not-json', 'broken');
  const failed = await kit.registry.rebuild('multimodal-vectors');
  assert.equal(failed.ok, false);
  assert.match(failed.lastError?.message ?? '', /invalid JSON/);
});

test('ordinary vector admission refills the page instead of underfilling it', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, embedding TEXT, embedding_model TEXT, owner TEXT);');
  const registry = createSearchPluginRegistry();
  registry.register(createVectorPlugin({
    id: 'note-vectors',
    version: '1.0.0',
    source: { entity: 'Note', vector: 'embedding', model: 'embedding_model', owns: () => true },
    modelSpace: { model: 'embed-v1', dimensions: 2 },
    admission: {
      entity: { name: 'Note' },
      adapter: {
        registerResource() {},
        async admit({ row }) {
          const admitted = row?.owner === 'alice';
          return { admitted, reasonCode: admitted ? null : 'no-capability' };
        },
      },
    },
  }));
  registry.bindSource(db);
  const insert = db.prepare('INSERT INTO Note (id, embedding, embedding_model, owner) VALUES (?, ?, ?, ?)');
  insert.run('blocked', JSON.stringify([1, 0]), 'embed-v1', 'mallory');
  insert.run('a', JSON.stringify([0.9, 0.1]), 'embed-v1', 'alice');
  insert.run('b', JSON.stringify([0.8, 0.2]), 'embed-v1', 'alice');
  assert.equal((await registry.rebuild('note-vectors')).ok, true);

  const page = await registry.search('note-vectors', {
    principal: PRINCIPAL,
    query: { model: 'embed-v1', vector: [1, 0] },
    limit: 2,
  });
  assert.equal(page.ok, true, page.lastError?.message);
  assert.deepEqual(page.result.hits.map((hit) => hit.id), ['a', 'b'], 'a denied top hit cannot shorten an ordinary vector page');

  const offsetPage = await registry.search('note-vectors', {
    principal: PRINCIPAL,
    query: { model: 'embed-v1', vector: [1, 0] },
    offset: 1,
    limit: 1,
  });
  assert.deepEqual(offsetPage.result.hits.map((hit) => hit.id), ['b']);
});

test('a derived admission entity must name the parent row it discloses', () => {
  const base = {
    id: 'mismatched-admission',
    version: '1.0.0',
    modelSpace: { model: 'embed-v1', dimensions: 2 },
    source: {
      entity: 'NoteSegment', vector: 'embedding', model: 'embedding_model', owns: () => true,
      parent: {
        entity: 'Note', field: 'noteId', revisionField: 'revision', projectField: 'projectId',
        parentRevisionField: 'revision', parentProjectField: 'projectId',
      },
    },
  };
  const adapter = { registerResource() {}, async admit() { return { admitted: true, reasonCode: null }; } };
  assert.throws(
    () => createVectorPlugin({ ...base, admission: { entity: { name: 'NoteSegment' }, adapter } }),
    /admission entity must be 'Note'/,
  );
  assert.doesNotThrow(() => createVectorPlugin({ ...base, admission: { entity: { name: 'Note' }, adapter } }));
});
