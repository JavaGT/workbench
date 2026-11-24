// search-staleness-cursor.test.mjs — Wave 1: cursor-backed, crash-safe search
// staleness intake.
//
// The post-commit notification used to be a lossy handoff: a commit that landed
// in _Log but whose notification never ran left the source-change ledger
// permanently incomplete. These tests pin the new contract:
//   - recording a source change AND advancing the per-scope _ConsumerCursor are
//     one transaction;
//   - a boot sweep (reconcileSearchStaleness) replays any missed commit and the
//     plugin actually indexes it;
//   - replay is idempotent — no duplicate or lost work;
//   - bootApplication runs the sweep before serving.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  createSearchStalenessBridge,
  createSearchStalenessConsumer,
  reconcileSearchStaleness,
  SEARCH_STALENESS_CURSOR,
} from '../build/search-staleness.mjs';
import {
  createSearchPluginRegistry,
  SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
  SEARCH_STALENESS_LEDGER_TABLE,
} from '../build/search-plugin.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { entity, generateDDL } from '../build/internal.mjs';
import workbench from '../build/app.mjs';
import { text, grant, read, write, subscribe } from '../build/index.mjs';

// ---- helpers ---------------------------------------------------------------

function freshDb() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT);');
  return db;
}

// The boot integration needs Note declared as an entity so the schema census
// recognises the table created before boot (bare SQL tables are rejected).
function noteEntity() {
  return entity('Note', {
    title: text(),
    grant: () => grant(read, write, subscribe),
  });
}

function freshAppDb() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  for (const sql of generateDDL(noteEntity())) db.exec(sql);
  return db;
}

function appendCommittedLog(db, scope, seq, eventType, data, actionId = `action-${scope}-${seq}`) {
  db.prepare(
    'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(scope, seq, eventType, JSON.stringify(data), actionId, '2026-11-24T00:00:00.000Z');
}

function cursorOf(db, scope) {
  const row = db.prepare(
    'SELECT lastSeq FROM _ConsumerCursor WHERE consumer = ? AND scope = ?',
  ).get(SEARCH_STALENESS_CURSOR, scope);
  return row?.lastSeq;
}

// A minimal indexed plugin over the Note source. `reconcile` applies delivered
// changes to the in-memory index; `calls` lets the tests prove no duplicate
// work happens on replay.
function makeIndexedPlugin() {
  const index = new Map();
  const calls = [];
  return {
    index,
    calls,
    plugin: {
      contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
      id: 'notes-fts',
      version: '1.0.0',
      ownedObjects: [],
      sourceInterests: [{ entity: 'Note' }],
      stalenessKey: (change) => (change.entity === 'Note' ? `Note:${change.rowId}` : null),
      prepare: () => {},
      validate: () => {},
      reconcile: (_ctx, changes) => {
        calls.push({ op: 'reconcile', rowIds: changes.map((change) => change.rowId) });
        for (const change of changes) {
          if (change.kind === 'removed') index.delete(change.rowId);
          else index.set(change.rowId, { id: change.rowId, ...(change.data ?? {}) });
        }
        return { counts: { documents: index.size } };
      },
      rebuild: (ctx) => {
        calls.push({ op: 'rebuild' });
        index.clear();
        for (const row of ctx.reader.rows('Note')) index.set(String(row.id), { ...row });
        return { counts: { documents: index.size } };
      },
      search: () => ({ hits: [...index.keys()].map((rowId) => ({ id: rowId })) }),
    },
  };
}

function makeBridge(db) {
  const indexed = makeIndexedPlugin();
  const registry = createSearchPluginRegistry();
  registry.register(indexed.plugin);
  registry.bindSource(db);
  const bridge = createSearchStalenessBridge({ registry, now: () => 't' });
  bridge.engage(db);
  return { ...indexed, registry, bridge };
}

function reconcileCalls(kit) {
  return kit.calls.filter((call) => call.op === 'reconcile');
}

// ---- crash recovery --------------------------------------------------------

test('committed events the consumer never saw are recovered on boot and indexed', async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const kit = makeBridge(db);

  // Simulate a crash between COMMIT and the post-commit consumer: the rows are
  // on the committed log, but no staleness record and no cursor exist yet.
  appendCommittedLog(db, 'Note:n1', 1, 'Note.created', { id: 'n1', title: 'Recovered one' });
  appendCommittedLog(db, 'Note:n2', 1, 'Note.updated', { id: 'n2', title: 'Recovered two' });
  assert.equal(kit.bridge.pending().length, 0, 'nothing was recorded before recovery');

  const first = await reconcileSearchStaleness(db, kit.bridge);
  assert.deepEqual(first, { recorded: 2, blocked: 0 });
  assert.equal(kit.bridge.pending().length, 2, 'both missed commits entered the durable ledger');
  assert.equal(cursorOf(db, 'Note:n1'), 1);
  assert.equal(cursorOf(db, 'Note:n2'), 1);

  // Recovery completes the ledger; the existing drain path now indexes the
  // recovered source changes (reconcileSearchStaleness does not bypass it).
  const drained = await kit.bridge.drain();
  assert.equal(drained.processed, 2);
  assert.equal(kit.index.get('n1')?.title, 'Recovered one');
  assert.equal(kit.index.get('n2')?.title, 'Recovered two');
  assert.equal(reconcileCalls(kit).length, 2);
  assert.equal(kit.bridge.pending().length, 0);

  // A second recovery sweep is a no-op: the cursor bounds work to the gap.
  const second = await reconcileSearchStaleness(db, kit.bridge);
  assert.deepEqual(second, { recorded: 0, blocked: 0 });
  assert.equal(reconcileCalls(kit).length, 2, 'replay never duplicates index work');
});

test('recording and checkpoint are one transaction; a failed checkpoint replays once', async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const kit = makeBridge(db);

  // The commit is on the log. A trigger makes the checkpoint insert fail, which
  // stands in for a crash after the ledger write but before the cursor write.
  appendCommittedLog(db, 'Note:n1', 1, 'Note.created', { id: 'n1', title: 'Atomic' });
  db.exec(`CREATE TRIGGER fail_search_cursor
    BEFORE INSERT ON _ConsumerCursor
    BEGIN SELECT RAISE(ABORT, 'cursor blocked'); END`);

  const event = {
    type: 'Note.created',
    scope: 'Note:n1',
    seq: 1,
    data: { id: 'n1', title: 'Atomic' },
    committedAt: '2026-11-24T00:00:00.000Z',
  };
  await createSearchStalenessConsumer(kit.bridge)([event], { db });
  assert.equal(kit.bridge.pending().length, 0, 'the ledger write rolled back with the cursor write');
  assert.equal(cursorOf(db, 'Note:n1'), undefined);

  db.exec('DROP TRIGGER fail_search_cursor');
  const recovered = await reconcileSearchStaleness(db, kit.bridge);
  assert.deepEqual(recovered, { recorded: 1, blocked: 0 });
  assert.equal(kit.bridge.pending().length, 1, 'exactly one record, not a half-applied one');
  assert.equal(cursorOf(db, 'Note:n1'), 1);

  assert.equal((await kit.bridge.drain()).processed, 1);
  assert.equal(kit.index.get('n1')?.title, 'Atomic');

  const replay = await reconcileSearchStaleness(db, kit.bridge);
  assert.deepEqual(replay, { recorded: 0, blocked: 0 });
  assert.equal(kit.bridge.pending().length, 0);
});

test('a later same-scope success never skips past an earlier failure', async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const kit = makeBridge(db);
  db.exec(`CREATE TRIGGER fail_search_cursor_once
    BEFORE INSERT ON _ConsumerCursor
    WHEN (SELECT COUNT(*) FROM _ConsumerCursor) = 0
    BEGIN SELECT RAISE(ABORT, 'cursor blocked'); END`);

  const consumer = createSearchStalenessConsumer(kit.bridge);
  await consumer([
    { type: 'Note.created', scope: 'Note:n1', seq: 1, data: { id: 'n1', title: 'a' }, committedAt: 't0' },
    { type: 'Note.updated', scope: 'Note:n1', seq: 2, data: { id: 'n1', title: 'b' }, committedAt: 't1' },
  ], { db });
  assert.equal(cursorOf(db, 'Note:n1'), undefined, 'the failed first event blocks its whole scope');

  db.exec('DROP TRIGGER fail_search_cursor_once');
  // No _Log rows were committed in this fixture, so there is nothing for the
  // boot sweep to replay — the point is only that the cursor did not jump to 2.
  const result = await reconcileSearchStaleness(db, kit.bridge);
  assert.deepEqual(result, { recorded: 0, blocked: 0 });
  assert.equal(cursorOf(db, 'Note:n1'), undefined);
});

test('a successful live delivery coalesces a batch and advances the cursor once', async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const kit = makeBridge(db);
  const consumer = createSearchStalenessConsumer(kit.bridge);

  await consumer([
    { type: 'Note.created', scope: 'Note:n1', seq: 1, data: { id: 'n1', title: 'first' }, committedAt: 't0' },
    { type: 'Note.updated', scope: 'Note:n1', seq: 2, data: { id: 'n1', title: 'newest' }, committedAt: 't1' },
  ], { db });
  assert.equal(cursorOf(db, 'Note:n1'), 2, 'cursor advances to the batch head');
  const pending = kit.bridge.pending();
  assert.equal(pending.length, 1, 'two changes to one key coalesce to one record');
  assert.equal(pending[0].committedAt, 't1', 'the newest payload wins');

  // Nothing was missed, so the boot sweep finds no gap.
  assert.deepEqual(await reconcileSearchStaleness(db, kit.bridge), { recorded: 0, blocked: 0 });
});

// ---- boot integration ------------------------------------------------------

test('app.ready runs the search staleness recovery sweep before serving', async (t) => {
  const db = freshAppDb();
  const app = workbench({ db, entities: [noteEntity()] });
  const indexed = makeIndexedPlugin();
  app.registerSearchPlugin(indexed.plugin);

  // A commit that landed before boot but whose notification never ran.
  appendCommittedLog(db, 'Note:n1', 1, 'Note.created', { id: 'n1', title: 'Boot recovered' });
  app.mount('/notes', app.entity('Note'));
  app.listen(0);
  t.after(async () => { await app.shutdown(); db.close(); });

  await app.ready;

  assert.equal(typeof app.reconcileSearchStaleness, 'function');
  assert.equal(app.searchStaleness.pending().length, 1, 'boot recorded the missed commit');
  assert.equal(cursorOf(db, 'Note:n1'), 1);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM ${SEARCH_STALENESS_LEDGER_TABLE}`).get().n,
    1,
  );
  // The recorded change flows through the existing drain path to the index.
  assert.equal((await app.searchStaleness.drain()).processed, 1);
  assert.equal(indexed.index.get('n1')?.title, 'Boot recovered', 'boot recovery made the missed commit indexable');
  assert.equal(reconcileCalls(indexed).length, 1);
});
