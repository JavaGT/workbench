// search-staleness.test.mjs — the S4/A2 staleness + invalidation bridge.
//
// Covers the durable, coalescible, revocation-priority ledger (epic scope#23):
// post-commit firing for history + no-history tiers, restart-with-pending,
// coalescing (N notifications → one reconcile per source key), revocation/
// erasure priority ordering (protected content leaves results before 'ready' is
// claimed), the uncommitted-state guard, and the plugin-declared trigger census.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createSearchStalenessBridge, createSearchStalenessConsumer, SEARCH_STALENESS_PRIORITY_HIGH, SEARCH_STALENESS_PRIORITY_ORDINARY } from '../build/search-staleness.mjs';
import { createSearchPluginRegistry, SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION, SEARCH_STALENESS_LEDGER_TABLE } from '../build/search-plugin.mjs';
import { createServer, durableMutationVariant } from '../build/pipeline.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { createSqliteAdapter } from '../build/sqlite-adapter.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import workbench from '../build/app.mjs';
import { entity, grant, principal, read, subscribe, text, write } from '../build/index.mjs';

// ---- helpers ---------------------------------------------------------------

function freshNoteDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, body TEXT);');
  return db;
}

// An indexed plugin over the Note source: rebuild re-reads the committed source
// through the scoped reader; reconcile applies the delivered changes. The
// in-memory `index` Map is what the red-line test asserts against.
function makeIndexedPlugin({ id = 'notes-fts', version = '1.0.0' } = {}) {
  const index = new Map();
  const calls = [];
  return {
    index,
    calls,
    plugin: {
      contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
      id,
      version,
      ownedObjects: [
        { kind: 'virtual-table', name: 'notes_fts', disposition: { kind: 'schema-only' }, ddl: ['CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title);'] },
      ],
      sourceInterests: [{ entity: 'Note' }],
      stalenessKey: (change) => (change.entity === 'Note' ? `${change.entity}:${change.rowId}` : null),
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

function setupBridge(db, { registry } = {}) {
  const plugin = makeIndexedPlugin();
  const searchRegistry = registry ?? createSearchPluginRegistry();
  searchRegistry.register(plugin.plugin);
  searchRegistry.bindSource(db);
  const bridge = createSearchStalenessBridge({ registry: searchRegistry, now: () => 't' });
  bridge.engage(db);
  return { plugin, searchRegistry, bridge };
}

// The post-commit consumer S3's plumbing will feed the bridge with: convert each
// committed event to a source change and notify. Mirrors the future kernel
// consumer (history-tier commits today; the no-history-tier path uses the same
// seam once S3/A2 lands).
function stalenessConsumer(bridge, { tier = 'history' } = {}) {
  return async (events) => {
    for (const event of events) {
      const entity = event.handle?.entity ?? String(event.scope).split(':')[0];
      const rowId = event.data?.id ?? String(event.scope).split(':')[1];
      if (!entity || !rowId) continue;
      bridge.notifySourceChange({
        entity,
        rowId,
        kind: String(event.type).split('.')[1] ?? 'updated',
        data: event.data ?? {},
        committedAt: event.committedAt,
        tier,
      });
    }
  };
}

function durableKernel(db, { postCommitConsumers = [] } = {}) {
  return createServer({
    handlers: {
      'Note.create': ({ payload }) => [{
        type: 'Note.created',
        scope: `Note:${payload.id}`,
        data: { id: payload.id, title: payload.title },
      }],
    },
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({ postCommitConsumers }),
  });
}

// ---- post-commit firing for history + no-history tiers ----------------------

describe('staleness bridge — post-commit notification intake', () => {
  test('a history-tier committed dispatch fires a durable staleness record', async (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    executeFrameworkDDL(db);
    const registry = createSearchPluginRegistry();
    registry.register(makeIndexedPlugin().plugin);
    const bridge = createSearchStalenessBridge({ registry });
    bridge.engage(db);

    // The real post-commit fan-out proves the history-tier path: dispatch a
    // commit and let the registered consumer notify the bridge post-commit.
    const kernel = durableKernel(db, { postCommitConsumers: [stalenessConsumer(bridge)] });

    const outcome = await kernel.dispatch({
      actionId: randomUUID(),
      type: 'Note.create',
      payload: { id: 'n1', title: 'hello' },
    });
    assert.equal(outcome.ok, true);

    const pending = bridge.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].sourceResource, 'Note');
    assert.equal(pending[0].sourceKey, 'n1');
    assert.equal(pending[0].kind, 'source-change');
    assert.equal(pending[0].tier, 'history');
    assert.equal(pending[0].priority, SEARCH_STALENESS_PRIORITY_ORDINARY);
    assert.deepEqual(pending[0].affected.map((a) => a.pluginId), ['notes-fts']);
  });

  test('a no-history-tier write yields a staleness record through the same seam', () => {
    const db = freshNoteDb();
    const { bridge } = setupBridge(db);
    // S3/A2's no-history mutation path writes no _Log row; its post-commit
    // notification still flows through this same bridge seam with tier 'live'.
    const notice = bridge.notifySourceChange({
      entity: 'Note',
      rowId: 'n9',
      kind: 'updated',
      data: { title: 'live-write' },
      committedAt: '2026-08-15T00:00:00.000Z',
      tier: 'live',
    });
    assert.equal(notice.recorded, true);
    const pending = bridge.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].tier, 'live');
    db.close();
  });

  test('a change for no indexed entity records nothing', () => {
    const db = freshNoteDb();
    const { bridge } = setupBridge(db);
    const notice = bridge.notifySourceChange({
      entity: 'Other',
      rowId: 'o1',
      kind: 'created',
      committedAt: '2026-08-15T00:00:00.000Z',
    });
    assert.equal(notice.recorded, false);
    assert.equal(notice.affected, 0);
    assert.equal(bridge.pending().length, 0);
    db.close();
  });
});

// ---- uncommitted-state guard -----------------------------------------------

describe('staleness bridge — uncommitted-state guard', () => {
  test('a notification without committedAt is refused and records nothing', () => {
    const db = freshNoteDb();
    const { bridge } = setupBridge(db);
    assert.throws(
      () => bridge.notifySourceChange({ entity: 'Note', rowId: 'n1', kind: 'created' }),
      /committedAt/,
    );
    assert.equal(bridge.pending().length, 0);
    db.close();
  });

  test('a rolled-back dispatch fires no post-commit notification (no record)', async (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    executeFrameworkDDL(db);
    const registry = createSearchPluginRegistry();
    registry.register(makeIndexedPlugin().plugin);
    const bridge = createSearchStalenessBridge({ registry });
    bridge.engage(db);

    const kernel = createServer({
      handlers: {
        'Note.create': ({ payload }) => [{
          type: 'Note.created',
          scope: `Note:${payload.id}`,
          data: { id: payload.id, title: payload.title },
        }],
      },
      authorize: async () => false,
      db,
      pipeline: durableMutationVariant({ postCommitConsumers: [stalenessConsumer(bridge)] }),
    });

    const outcome = await kernel.dispatch({
      actionId: randomUUID(),
      type: 'Note.create',
      payload: { id: 'n1', title: 'never' },
    });
    assert.equal(outcome.ok, false);
    // The dispatch rolled back: the post-commit consumer never ran, so no
    // staleness record exists for state that never committed.
    assert.equal(bridge.pending().length, 0);
    const logRows = db.prepare('SELECT * FROM _Log').all();
    assert.equal(logRows.length, 0);
  });
});

// #236 regression: the post-commit consumer must derive entity + kind from the
// exported Event-type grammar authority. A dotted field event (Note.title.set,
// kind 'fieldSet') is an update to an existing row, exactly like a native field
// mutation — never a fabricated kind from a bare split('.').
describe('staleness bridge — committed-event classification parity', () => {
  test('event types map to the same source-change kind as parseEventType, including dotted field events', async () => {
    const db = freshNoteDb();
    const { bridge } = setupBridge(db);
    const consumer = createSearchStalenessConsumer(bridge);
    const { parseEventType } = await import('../build/event-handle.mjs');

    const kindOf = (handle) => handle.kind === 'created' ? 'created'
      : handle.kind === 'removed' ? 'removed'
        : 'updated'; // updated / fieldSet / native all change an existing row
    const cases = [
      ['Note.created', 'n1'],
      ['Note.updated', 'n2'],
      ['Note.removed', 'n3'],
      ['Note.title.set', 'n4'],      // dotted fieldSet
      ['Note.body.operated', 'n5'],  // native field op
    ];
    for (const [type, rowId] of cases) {
      const handle = parseEventType(type);
      assert.equal(handle.entity, 'Note', `${type} entity agrees with the grammar authority`);
      await consumer([{ type, scope: `Note:${rowId}`, data: { id: rowId }, committedAt: 't0' }]);
      const row = db.prepare('SELECT payload FROM _SearchStaleness WHERE sourceKey = ?').get(rowId);
      assert.ok(row, `${type} recorded a source change`);
      assert.equal(JSON.parse(row.payload).change.kind, kindOf(handle), `${type} maps to ${kindOf(handle)}`);
    }

    // A type outside the grammar has no authority handle: the consumer skips it
    // rather than fabricating an 'updated' change from a split('.') fallback.
    assert.throws(() => parseEventType('Note.custom'), /invalid event type/);
    assert.throws(() => parseEventType('Note.a.b.c'), /invalid event type/);
    await consumer([
      { type: 'Note.custom', scope: 'Note:nc', data: { id: 'nc' }, committedAt: 't0' },
      { type: 'Note.a.b.c', scope: 'Note:n4p', data: { id: 'n4p' }, committedAt: 't0' },
    ]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _SearchStaleness WHERE sourceKey = ?').get('nc').n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _SearchStaleness WHERE sourceKey = ?').get('n4p').n, 0,
      'a bare split(\'.\') would have fabricated an update from a 4-part type');
    db.close();
  });
});

// ---- coalescing -------------------------------------------------------------

describe('staleness bridge — coalescing', () => {
  test('N notifications for one source key collapse to one record and one reconcile', async () => {
    const db = freshNoteDb();
    const { plugin, bridge } = setupBridge(db);

    for (let i = 0; i < 3; i += 1) {
      bridge.notifySourceChange({
        entity: 'Note',
        rowId: 'n1',
        kind: 'updated',
        data: { title: `version-${i}` },
        committedAt: `2026-08-15T00:00:0${i}.000Z`,
      });
    }

    const pending = bridge.pending();
    assert.equal(pending.length, 1, 'three notifications for one key → one record');
    assert.equal(pending[0].sourceResource, 'Note');
    assert.equal(pending[0].sourceKey, 'n1');

    const summary = await bridge.drain();
    assert.equal(summary.processed, 1);
    // Coalescing acceptance: N notifications → exactly one reconcile.
    const reconciles = plugin.calls.filter((call) => call.op === 'reconcile');
    assert.equal(reconciles.length, 1);
    assert.deepEqual(reconciles[0].rowIds, ['n1']);
    assert.equal(bridge.pending().length, 0);
    // The reconcile received the NEWEST change data.
    assert.equal(plugin.index.get('n1').title, 'version-2');
    db.close();
  });
});

// ---- durability: restart with pending ---------------------------------------

describe('staleness bridge — restart with pending staleness', () => {
  test('pending records survive restart and re-process through a fresh bridge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-staleness-restart-'));
    const dataPath = join(root, 'app.db');
    try {
      let db = new DatabaseSync(dataPath);
      const first = setupBridge(db);
      first.bridge.notifySourceChange({ entity: 'Note', rowId: 'n1', kind: 'created', data: { title: 'one' }, committedAt: '2026-08-15T00:00:00.000Z' });
      first.bridge.notifySourceChange({ entity: 'Note', rowId: 'n2', kind: 'created', data: { title: 'two' }, committedAt: '2026-08-15T00:00:01.000Z' });
      assert.equal(first.bridge.pending().length, 2);
      db.close();

      // "Restart": a fresh handle + fresh registry + fresh bridge over the
      // same database. The durable ledger carries the pending set forward.
      db = new DatabaseSync(dataPath);
      const second = setupBridge(db);
      const pending = second.bridge.pending();
      assert.equal(pending.length, 2, 'pending staleness survives restart');
      const summary = await second.bridge.drain();
      assert.equal(summary.processed, 2);
      assert.equal(summary.retained, 0);
      assert.equal(second.bridge.pending().length, 0);
      assert.deepEqual(
        [...second.plugin.index.keys()].sort(),
        ['n1', 'n2'],
        'no missed source changes after restart',
      );
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---- revocation / erasure priority ------------------------------------------

describe('staleness bridge — revocation and erasure priority', () => {
  test('a revocation drains before an ordinary reconcile', async () => {
    const db = freshNoteDb();
    db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');
    db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n2', 'two');
    const { plugin, bridge, searchRegistry } = setupBridge(db);
    // Materialize so the plugin is 'ready' before invalidation arrives.
    await searchRegistry.rebuild('notes-fts');
    assert.equal(searchRegistry.stateOf('notes-fts').state, 'ready');

    // Ordinary source change first, then an access revocation.
    bridge.notifySourceChange({ entity: 'Note', rowId: 'n1', kind: 'updated', committedAt: '2026-08-15T00:00:00.000Z' });
    bridge.onRevocation(principal({ type: 'user', id: 'u1' }), { category: 'entity', key: 'Note:n2' });

    const pending = bridge.pending();
    assert.equal(pending.length, 2);
    const revocation = pending.find((record) => record.kind === 'revocation');
    assert.ok(revocation);
    assert.equal(revocation.priority, SEARCH_STALENESS_PRIORITY_HIGH, 'revocation is the high-priority channel');

    // Before drain, the plugin is stale — never fresh with a pending revocation.
    assert.equal(searchRegistry.stateOf('notes-fts').state, 'stale');

    await bridge.drain();

    const rebuildIndex = plugin.calls.findIndex((call) => call.op === 'rebuild');
    const reconcileIndex = plugin.calls.findIndex((call) => call.op === 'reconcile');
    assert.ok(rebuildIndex !== -1, 'a revocation triggers a rebuild');
    assert.ok(rebuildIndex < reconcileIndex, 'revocation rebuild runs BEFORE ordinary reconcile');
    db.close();
  });

  test('red-line: erased content leaves results before ready is claimed', async () => {
    const db = freshNoteDb();
    db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');
    db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n2', 'two');
    const { plugin, bridge, searchRegistry } = setupBridge(db);

    // Materialize a healthy index over the committed source.
    await searchRegistry.rebuild('notes-fts');
    assert.deepEqual([...plugin.index.keys()].sort(), ['n1', 'n2']);
    assert.equal(searchRegistry.stateOf('notes-fts').state, 'ready');

    // The source row is ERASED (committed removal) and an ordinary change for
    // another key is also pending.
    db.prepare('DELETE FROM Note WHERE id = ?').run('n2');
    bridge.notifySourceChange({ entity: 'Note', rowId: 'n1', kind: 'updated', data: { title: 'one-updated' }, committedAt: '2026-08-15T00:00:00.000Z' });
    bridge.notifySourceChange({
      entity: 'Note', rowId: 'n2', kind: 'removed', committedAt: '2026-08-15T00:00:01.000Z', erasure: true,
    });

    // Immediately after the invalidation the plugin is stale (fence bumped) —
    // 'ready'/'fresh' is NOT claimed while protected content is still pending.
    const stateBeforeDrain = searchRegistry.stateOf('notes-fts');
    assert.equal(stateBeforeDrain.state, 'stale');

    const summary = await bridge.drain();
    assert.equal(summary.rebuilt, 1, 'the erasure record rebuilds the index');
    assert.equal(summary.reconciled, 1);
    assert.equal(summary.retained, 0);

    // Protected (erased) content has left the plugin's results, and ready is
    // only claimed afterwards.
    assert.equal(plugin.index.has('n2'), false, 'erased content is gone from the index');
    assert.ok(plugin.index.has('n1'), 'unaffected content remains');
    assert.equal(searchRegistry.stateOf('notes-fts').state, 'ready');
    db.close();
  });

  test('a principal revocation queues a high-priority rebuild for every plugin', () => {
    const db = freshNoteDb();
    const { plugin, bridge } = setupBridge(db);
    bridge.onRevocation(principal({ type: 'user', id: 'u1' }), { category: 'principal', key: 'user:u1' });
    const pending = bridge.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'revocation');
    assert.equal(pending[0].priority, SEARCH_STALENESS_PRIORITY_HIGH);
    assert.equal(pending[0].sourceResource, '$principal');
    assert.deepEqual(pending[0].affected.map((a) => a.pluginId), [plugin.plugin.id]);
    db.close();
  });

  test('erasure then ordinary update for the same key drains as a rebuild, never a priority-1 reconcile (review #109 finding 1)', async () => {
    const db = freshNoteDb();
    const { plugin, bridge } = setupBridge(db);
    // High-priority erasure first, then an ORDINARY update for the SAME key.
    // The coalesced record must keep the highest-priority semantics — a
    // priority-1 'source-change' would reconcile instead of rebuild,
    // re-disclosing protected content.
    bridge.notifySourceChange({
      entity: 'Note', rowId: 'n1', kind: 'removed', committedAt: '2026-08-15T00:00:00.000Z', erasure: true,
    });
    bridge.notifySourceChange({
      entity: 'Note', rowId: 'n1', kind: 'updated', data: { title: 'ordinary-later' }, committedAt: '2026-08-15T00:00:01.000Z',
    });

    const pending = bridge.pending();
    assert.equal(pending.length, 1, 'one source key → one coalesced record');
    assert.equal(pending[0].priority, SEARCH_STALENESS_PRIORITY_HIGH, 'the high-priority channel survives the ordinary update');
    assert.equal(pending[0].kind, 'erasure', 'the record keeps the high-priority erasure, not the ordinary update');

    const summary = await bridge.drain();
    assert.equal(summary.rebuilt, 1, 'drain rebuilds');
    assert.equal(summary.reconciled, 0, 'never reconciles a high-priority record');
    assert.ok(plugin.calls.some((call) => call.op === 'rebuild'));
    assert.ok(!plugin.calls.some((call) => call.op === 'reconcile'));
    db.close();
  });

  test('ordinary then erasure coalesces to a rebuild carrying the erasure semantics (review #109 finding 1)', async () => {
    const db = freshNoteDb();
    const { plugin, bridge } = setupBridge(db);
    // Ordinary update first, then a high-priority erasure for the SAME key:
    // the incoming erasure REPLACES the ordinary record outright.
    bridge.notifySourceChange({
      entity: 'Note', rowId: 'n1', kind: 'updated', data: { title: 'ordinary-first' }, committedAt: '2026-08-15T00:00:00.000Z',
    });
    bridge.notifySourceChange({
      entity: 'Note', rowId: 'n1', kind: 'removed', committedAt: '2026-08-15T00:00:01.000Z', erasure: true,
    });

    const pending = bridge.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'erasure', 'the erasure payload/semantics win the coalescing');
    assert.equal(pending[0].priority, SEARCH_STALENESS_PRIORITY_HIGH);

    const summary = await bridge.drain();
    assert.equal(summary.rebuilt, 1, 'the erasure record rebuilds');
    assert.equal(summary.reconciled, 0);
    assert.ok(plugin.calls.some((call) => call.op === 'rebuild'));
    assert.ok(!plugin.calls.some((call) => call.op === 'reconcile'));
    db.close();
  });

  test('a revocation then an ordinary update for the same key keeps the high-priority rebuild (review #109 finding 1)', async () => {
    const db = freshNoteDb();
    const { plugin, bridge } = setupBridge(db);
    bridge.onRevocation(principal({ type: 'user', id: 'u1' }), { category: 'entity', key: 'Note:n1' });
    bridge.notifySourceChange({
      entity: 'Note', rowId: 'n1', kind: 'updated', data: { title: 'post-revocation' }, committedAt: '2026-08-15T00:00:00.000Z',
    });

    const pending = bridge.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'revocation', 'the coalesced record stays a revocation');
    assert.equal(pending[0].priority, SEARCH_STALENESS_PRIORITY_HIGH);

    const summary = await bridge.drain();
    assert.equal(summary.rebuilt, 1);
    assert.equal(summary.reconciled, 0);
    assert.ok(plugin.calls.some((call) => call.op === 'rebuild'));
    assert.ok(!plugin.calls.some((call) => call.op === 'reconcile'));
    db.close();
  });

  test('coalescing unions affected sets across priorities so no affected plugin is dropped (review #109 finding 1)', async () => {
    const db = freshNoteDb();
    const registry = createSearchPluginRegistry();
    const pluginA = makeIndexedPlugin({ id: 'plugin-a' });
    const pluginB = makeIndexedPlugin({ id: 'plugin-b' });
    // plugin-b refuses ordinary updates, so only a removal/revocation affects it.
    pluginB.plugin.stalenessKey = (change) => (
      change.entity === 'Note' && change.kind === 'removed' ? `${change.entity}:${change.rowId}` : null
    );
    pluginB.plugin.ownedObjects = [
      { kind: 'virtual-table', name: 'plugin_b_fts', disposition: { kind: 'schema-only' }, ddl: ['CREATE VIRTUAL TABLE IF NOT EXISTS plugin_b_fts USING fts5(title);'] },
    ];
    registry.register(pluginA.plugin);
    registry.register(pluginB.plugin);
    registry.bindSource(db);
    const bridge = createSearchStalenessBridge({ registry, now: () => 't' });
    bridge.engage(db);

    // Ordinary update affects only plugin-a...
    bridge.notifySourceChange({ entity: 'Note', rowId: 'n1', kind: 'updated', committedAt: 't0' });
    // ...then a revocation affects BOTH. The merged record keeps the revocation
    // semantics AND the union of affected plugins, so plugin-a is not dropped.
    bridge.onRevocation(principal({ type: 'user', id: 'u1' }), { category: 'entity', key: 'Note:n1' });

    const pending = bridge.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'revocation');
    assert.equal(pending[0].priority, SEARCH_STALENESS_PRIORITY_HIGH);
    assert.deepEqual(
      [...pending[0].affected].map((entry) => entry.pluginId).sort(),
      ['plugin-a', 'plugin-b'],
      'the ordinary update\'s affected plugin survives the coalescing',
    );

    const summary = await bridge.drain();
    assert.equal(summary.rebuilt, 1, 'one record drained as a rebuild');
    assert.equal(summary.retained, 0);
    assert.ok(pluginA.calls.some((call) => call.op === 'rebuild'));
    assert.ok(pluginB.calls.some((call) => call.op === 'rebuild'), 'the ordinary update\'s affected plugin is rebuilt too');
    db.close();
  });

  test('pendingPage returns a bounded priority-ordered slice and pendingCount reports total rows', () => {
    const db = freshNoteDb();
    const registry = createSearchPluginRegistry();
    const pluginA = makeIndexedPlugin({ id: 'plugin-a' });
    registry.register(pluginA.plugin);
    registry.bindSource(db);
    let tick = 0;
    const bridge = createSearchStalenessBridge({ registry, now: () => `2026-01-01T00:00:0${tick++}.000Z` });
    bridge.engage(db);

    bridge.notifySourceChange({ entity: 'Note', rowId: 'n1', kind: 'updated', committedAt: 't1' });
    bridge.notifySourceChange({ entity: 'Note', rowId: 'n2', kind: 'updated', committedAt: 't2' });
    bridge.notifySourceChange({ entity: 'Note', rowId: 'n3', kind: 'updated', committedAt: 't3' });
    bridge.onRevocation(principal({ type: 'user', id: 'u1' }), { category: 'entity', key: 'Note:n3' });

    assert.equal(bridge.pendingCount(), 3);
    const page = bridge.pendingPage(2);
    assert.equal(page.length, 2);
    assert.equal(page[0].sourceKey, 'n3', 'high-priority revocation comes first');
    assert.equal(page[1].sourceKey, 'n1', 'oldest ordinary change comes next');
    db.close();
  });
});

// ---- app wiring --------------------------------------------------------------

describe('app.searchStaleness surface', () => {
  test('a raw-handle app registers the bridge and engages it with the db', () => {
    const db = freshNoteDb();
    const app = workbench({ db });
    assert.ok(app.searchStaleness, 'the bridge is registered on the app');
    assert.ok(app.searchReconcile, 'the app binds the bounded reconcile drain to the same bridge');
    app.searchStaleness.engage(db);
    const notice = app.searchStaleness.notifySourceChange({
      entity: 'Note', rowId: 'n1', kind: 'created', committedAt: '2026-08-15T00:00:00.000Z',
    });
    assert.equal(notice.recorded, false, 'no plugins registered yet — nothing recorded');
    db.close();
  });

  test('a deferred-adapter app engages the bridge after the open lands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-staleness-deferred-'));
    try {
      const app = workbench({ db: createSqliteAdapter({ directory: join(root, 'owned'), name: 'app', mode: 'file' }) });
      try {
        await app.ready;
        assert.ok(app.db, 'awaiting ready installed the deferred handle');
        assert.equal(app.searchStaleness.tableName, '_SearchStaleness');
        // First ledger use materializes the durable table in the app database.
        assert.deepEqual(app.searchStaleness.pending(), []);
        const names = app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_SearchStaleness'").all();
        assert.equal(names.length, 1);
      } finally {
        await app.shutdown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---- plugin-declared trigger census ------------------------------------------

describe('staleness bridge — plugin-declared trigger census', () => {
  test('the bridge installs no triggers; plugin-declared triggers are the census', () => {
    const db = freshNoteDb();
    const plugin = makeIndexedPlugin();
    plugin.plugin.ownedObjects = [
      {
        kind: 'trigger', disposition: { kind: 'schema-only' },
        name: 'notes_fts_maintain',
        ddl: [
          'CREATE TRIGGER IF NOT EXISTS notes_fts_maintain AFTER INSERT ON Note BEGIN INSERT INTO notes_fts(rowid, title) VALUES (new.id, new.title); END',
        ],
      },
    ];
    const registry = createSearchPluginRegistry();
    registry.register(plugin.plugin);
    const bridge = createSearchStalenessBridge({ registry });
    bridge.engage(db);

    // The bridge's own DDL is a pure table ledger — no trigger on any source
    // table, Workbench-issued invalidations preferred (consideration #7).
    const ddl = bridge.stalenessDdl();
    assert.ok(!/trigger/i.test(ddl), 'the staleness ledger installs no triggers');

    const triggers = bridge.triggerCensus();
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0].pluginId, 'notes-fts');
    assert.equal(triggers[0].name, 'notes_fts_maintain');
    assert.equal(triggers[0].ddl.length, 1);
    assert.match(triggers[0].ddl[0], /CREATE TRIGGER/);
    db.close();
  });
});

// ---- coordinated ledger deletion (review #109 finding 3) ----------------------

describe('staleness bridge — coordinated ledger deletion', () => {
  test('drain deletes the ledger record inside the coordinated write turn', async () => {
    const db = freshNoteDb();
    const queue = createWriteQueue();
    const ownedAtDelete = [];
    // A prepare probe that records writeQueue.owned at the moment the ledger
    // DELETE executes. If drain() deleted the record OUTSIDE the coordinated
    // turn, the probe would record false.
    const probe = {
      prepare(sql) {
        const stmt = db.prepare(sql);
        if (/^DELETE FROM _SearchStaleness/.test(sql.trim())) {
          return {
            run: (...args) => {
              ownedAtDelete.push(queue.owned);
              return stmt.run(...args);
            },
          };
        }
        return stmt;
      },
    };
    const registry = createSearchPluginRegistry();
    registry.register(makeIndexedPlugin().plugin);
    registry.bindSource(db);
    const bridge = createSearchStalenessBridge({ registry, now: () => 't' });
    bridge.engage(probe);
    bridge.bindWriteQueue(queue);

    bridge.notifySourceChange({ entity: 'Note', rowId: 'n1', kind: 'created', committedAt: '2026-08-15T00:00:00.000Z' });
    assert.equal(bridge.pending().length, 1);

    const summary = await bridge.drain();
    assert.equal(summary.processed, 1);
    assert.deepEqual(ownedAtDelete, [true], 'the ledger DELETE runs inside the coordinated turn');
    assert.equal(bridge.pending().length, 0, 'the processed record was deleted');
    await queue.close();
    db.close();
  });
});

// ---- reserved-name guard (review #109 finding 4) -------------------------------

describe('staleness bridge — reserved-name guard', () => {
  test('registry refuses a plugin source interest in the reserved staleness ledger name', () => {
    const registry = createSearchPluginRegistry();
    const { plugin } = makeIndexedPlugin();
    plugin.sourceInterests = [{ entity: SEARCH_STALENESS_LEDGER_TABLE }];
    assert.throws(
      () => registry.register(plugin),
      /reserved staleness ledger table/,
    );
  });

  test('registry refuses an owned object named the reserved staleness ledger name', () => {
    const registry = createSearchPluginRegistry();
    const { plugin } = makeIndexedPlugin();
    plugin.ownedObjects = [
      { kind: 'table', name: SEARCH_STALENESS_LEDGER_TABLE, disposition: { kind: 'retained', reason: 'test fixture' }, ddl: [`CREATE TABLE ${SEARCH_STALENESS_LEDGER_TABLE} (id TEXT);`] },
    ];
    assert.throws(
      () => registry.register(plugin),
      /reserved staleness ledger table/,
    );
  });

  test('a plugin declaring the reserved name is never registered', () => {
    const registry = createSearchPluginRegistry();
    const { plugin } = makeIndexedPlugin();
    plugin.sourceInterests = [{ entity: SEARCH_STALENESS_LEDGER_TABLE }];
    assert.throws(() => registry.register(plugin), /reserved staleness ledger table/);
    assert.equal(registry.size, 0, 'the refused declaration left no plugin behind');
  });

  test('the bridge refuses a source change whose entity is the ledger table itself', () => {
    const db = freshNoteDb();
    const { bridge } = setupBridge(db);
    assert.throws(
      () => bridge.notifySourceChange({
        entity: SEARCH_STALENESS_LEDGER_TABLE, rowId: 'x', kind: 'created', committedAt: '2026-08-15T00:00:00.000Z',
      }),
      /collides with the staleness ledger table name/,
    );
    assert.equal(bridge.pending().length, 0);
    db.close();
  });
});

// ---- production wiring (review #109 finding 2) ---------------------------------

describe('staleness bridge — production wiring (app seams)', () => {
  test('a committed entity mutation records into the ledger through the app post-commit consumer', async (t) => {
    const db = new DatabaseSync(':memory:');
    const note = entity('Note', { title: text(), grant: () => grant(read, write, subscribe) });
    const app = workbench({ db, entities: [note] });
    app.registerSearchPlugin(makeIndexedPlugin().plugin);
    t.after(async () => {
      await app.shutdown();
      db.close();
    });
    await app.start();

    const outcome = await app.dispatch({
      actionId: randomUUID(),
      type: 'Note.create',
      payload: { id: 'n1', title: 'hello' },
      principal: principal({ type: 'user', id: 'u1' }),
    });
    assert.equal(outcome.ok, true, 'the authoritative mutation commits');

    const pending = app.searchStaleness.pending();
    assert.equal(pending.length, 1, 'the committed mutation recorded a staleness record');
    assert.equal(pending[0].sourceResource, 'Note');
    assert.equal(pending[0].sourceKey, 'n1');
    assert.equal(pending[0].kind, 'source-change');
    assert.equal(pending[0].tier, 'history');
    assert.ok(
      typeof pending[0].committedAt === 'string' && pending[0].committedAt.length > 0,
      'the record carries the committedAt post-commit proof',
    );
    const drained = await app.searchReconcile.reconcileBatches();
    assert.equal(drained.processed, 1, 'the app-wired bounded drain materializes one ledger record');
    assert.equal(app.searchStaleness.pending().length, 0);
  });

  test('a live-delivery revocation fences the plugin and records a high-priority rebuild', async (t) => {
    const db = new DatabaseSync(':memory:');
    const note = entity('Note', { title: text(), grant: () => grant(read, subscribe) });
    const app = workbench({ db, entities: [note] });
    app.registerSearchPlugin(makeIndexedPlugin().plugin);
    app.attachLiveDelivery({ principalOf: () => principal({ type: 'user', id: 'u1' }) });
    t.after(async () => {
      await app.shutdown();
      db.close();
    });
    await app.start();

    // Materialize a healthy index so the fence baseline is observable.
    await app.searchPlugins.rebuild('notes-fts');
    const fenceBefore = app.searchPlugins.stateOf('notes-fts').fence;
    assert.equal(app.searchPlugins.stateOf('notes-fts').state, 'ready');

    // Publish a revocation through the SAME committed live core the transports
    // present (the app wired the bridge's onRevocation as a core listener).
    app._applicationLiveDelivery.core.revoke(
      principal({ type: 'user', id: 'u1' }),
      { category: 'entity', key: 'Note:n1' },
    );

    const pending = app.searchStaleness.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'revocation');
    assert.equal(pending[0].priority, SEARCH_STALENESS_PRIORITY_HIGH);
    assert.equal(
      app.searchPlugins.stateOf('notes-fts').fence,
      fenceBefore + 1,
      'the revocation fences the plugin immediately (no fresh disclosure)',
    );
    assert.equal(app.searchPlugins.stateOf('notes-fts').state, 'stale');
  });
});
