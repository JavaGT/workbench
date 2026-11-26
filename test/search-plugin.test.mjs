// search-plugin.test.mjs — the S4/A1 search plugin contract (epic scope#23).
//
// Covers the registry (id/version validation, registration-time failure),
// owned-object census-ingestible shape, scoped source readers (the no-raw-
// handle red line), failure isolation (stale/failed with retained retry info,
// never an authoritative-write error), generation/fence state transitions, and
// prepare/validate failure modes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createSearchPluginRegistry,
  createSearchSourceReader,
  hybridSearch,
  SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
} from '../build/search-plugin.mjs';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_PAGE_SIZE,
} from '../build/search-response.mjs';
import { collectTableNamesFromDdl } from '../build/schema-table-census.mjs';
import { createSqliteAdapter } from '../build/sqlite-adapter.mjs';
import workbench from '../build/app.mjs';
import { entity, grant, principal, read, subscribe, text, write } from '../build/index.mjs';

// ---- helpers ---------------------------------------------------------------

function makePlugin({
  id = 'notes-fts',
  version = '1.0.0',
  contractVersion = SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
  ownedObjectName = `${id.replace(/[^A-Za-z0-9_]/g, '_')}_fts`,
  ownedObjects = [
    {
      kind: 'virtual-table',
      name: ownedObjectName,
      ddl: [`CREATE VIRTUAL TABLE IF NOT EXISTS ${ownedObjectName} USING fts5(title);`],
    },
  ],
  sourceInterests = [{ entity: 'Note' }],
  stalenessKey = (change) => (change.entity === 'Note' ? `${change.entity}:${change.rowId}` : null),
  prepare = () => {},
  validate = () => {},
  reconcile = (_ctx, changes) => ({ counts: { documents: changes.length } }),
  rebuild = () => ({ counts: { documents: 0 } }),
  search = () => ({ hits: [] }),
  health,
} = {}) {
  return {
    contractVersion,
    id,
    version,
    ownedObjects: ownedObjects.map((entry) => ({
      ...entry,
      disposition: entry.disposition ?? (entry.kind === 'table'
        ? { kind: 'retained', reason: 'test fixture' }
        : { kind: 'schema-only' }),
    })),
    sourceInterests,
    stalenessKey,
    prepare,
    validate,
    reconcile,
    rebuild,
    search,
    health,
  };
}

function freshNoteDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, body TEXT);');
  return db;
}

// ---- registry: id / version validation -------------------------------------

describe('search plugin registry — declaration validation', () => {
  test('registers a well-formed declaration', () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin());
    assert.equal(registry.size, 1);
    assert.equal(registry.has('notes-fts'), true);
    assert.deepEqual(registry.ids(), ['notes-fts']);
  });

  test('refuses a duplicate id at registration', () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({ id: 'dup' }));
    assert.throws(() => registry.register(makePlugin({ id: 'dup' })), /already registered/);
    assert.equal(registry.size, 1);
  });

  test('refuses an unsupported contract version (version compatibility)', () => {
    const registry = createSearchPluginRegistry();
    assert.throws(
      () => registry.register(makePlugin({ contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION + 1 })),
      /contract version/,
    );
  });

  test('refuses a missing or empty id / version', () => {
    const registry = createSearchPluginRegistry();
    assert.throws(() => registry.register(makePlugin({ id: '' })), /id/);
    assert.throws(() => registry.register(makePlugin({ version: '' })), /version/);
  });

  test('refuses an unknown owned-object kind', () => {
    const registry = createSearchPluginRegistry();
    assert.throws(
      () => registry.register(makePlugin({
        ownedObjects: [{ kind: 'shard', name: 'notes_shard', ddl: ['CREATE TABLE notes_shard (id TEXT);'], disposition: { kind: 'schema-only' } }],
      })),
      /unknown kind/,
    );
  });

  test('refuses an owned-object name already owned by another plugin', () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({ id: 'one', ownedObjects: [{ kind: 'table', name: 'shared_obj', ddl: ['CREATE TABLE shared_obj (id TEXT);'], disposition: { kind: 'retained', reason: 'test fixture' } }] }));
    assert.throws(
      () => registry.register(makePlugin({ id: 'two', ownedObjects: [{ kind: 'table', name: 'shared_obj', ddl: ['CREATE TABLE shared_obj (id TEXT);'], disposition: { kind: 'retained', reason: 'test fixture' } }] })),
      /already owned by another plugin/,
    );
  });

  test('refuses a duplicate owned-object name within one plugin', () => {
    const registry = createSearchPluginRegistry();
    assert.throws(
      () => registry.register(makePlugin({
        ownedObjects: [
          { kind: 'table', name: 'notes_idx', ddl: ['CREATE TABLE notes_idx (id TEXT);'], disposition: { kind: 'retained', reason: 'test fixture' } },
          { kind: 'index', name: 'notes_idx', ddl: ['CREATE INDEX notes_idx ON Note(id);'], disposition: { kind: 'schema-only' } },
        ],
      })),
      /declares owned object 'notes_idx' more than once/,
      'an intra-plugin duplicate name must be refused before the object is adopted',
    );
  });

  test('refuses a non-compilable source scope at registration', () => {
    const registry = createSearchPluginRegistry();
    assert.throws(
      () => registry.register(makePlugin({
        sourceInterests: [{
          entity: 'Note',
          fields: { title: { kind: 'value', type: 'text' } },
          scope: ({ fields }) => fields.ghost.is('x'),
        }],
      })),
      /no field 'ghost'/,
    );
  });

  test('accepts a source scope that compiles to constrained SQL', () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      sourceInterests: [{
        entity: 'Note',
        fields: { title: { kind: 'value', type: 'text' } },
        scope: ({ fields }) => fields.title.is('hello'),
      }],
    }));
    assert.equal(registry.size, 1);
  });

  test('refuses a declaration missing a lifecycle method', () => {
    const registry = createSearchPluginRegistry();
    const incomplete = makePlugin();
    delete incomplete.search;
    assert.throws(() => registry.register(incomplete), /search must be a function/);
  });

  test('stateOf / healthOf refuse an unregistered id', () => {
    const registry = createSearchPluginRegistry();
    assert.throws(() => registry.stateOf('missing'), /not registered/);
    assert.throws(() => registry.healthOf('missing'), /not registered/);
  });
});

// ---- owned-object census-ingestible shape ----------------------------------

describe('search plugin registry — owned-object census', () => {
  test('census entries are { source, sql } and yield the owned table names', () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      id: 'notes-fts',
      ownedObjects: [
        { kind: 'virtual-table', name: 'notes_fts', ddl: ['CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title);'] },
        { kind: 'index', name: 'idx_note_title', ddl: ['CREATE INDEX IF NOT EXISTS idx_note_title ON Note(title);'] },
      ],
    }));
    const census = registry.census();
    assert.equal(census.entries.length, 2);
    for (const entry of census.entries) {
      assert.equal(typeof entry.source, 'string');
      assert.equal(typeof entry.sql, 'string');
      assert.match(entry.source, /search plugin 'notes-fts'/);
    }
    const names = collectTableNamesFromDdl(census.entries);
    assert.deepEqual(names, ['notes_fts']);
  });

  test('census objects carry owner + version + kind + name metadata', () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({ id: 'notes-fts', version: '2.3.0' }));
    const objects = registry.census().objects;
    assert.equal(objects.length, 1);
    assert.equal(objects[0].owner, 'notes-fts');
    assert.equal(objects[0].version, '2.3.0');
    assert.equal(objects[0].kind, 'virtual-table');
    assert.equal(objects[0].name, 'notes_fts_fts');
  });

  test('census reflects every registered plugin', () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({ id: 'a' }));
    registry.register(makePlugin({ id: 'b' }));
    const census = registry.census();
    assert.equal(census.entries.length, 2);
    assert.deepEqual(new Set(census.objects.map((object) => object.owner)), new Set(['a', 'b']));
  });
});

// ---- scoped source readers: the no-raw-handle red line ---------------------

describe('search plugin registry — scoped source readers', () => {
  test('a reader carries no write verb and no raw handle', () => {
    const db = freshNoteDb();
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin());
    registry.bindSource(db);
    const reader = registry.sourceReader('notes-fts');
    assert.equal(reader.writeCapable, false);
    assert.equal(reader.prepare, undefined);
    assert.equal(reader.exec, undefined);
    assert.equal(reader.run, undefined);
    assert.equal(reader.handle, undefined);
    assert.equal(reader.transaction, undefined);
    assert.equal(reader.db, undefined);
    assert.deepEqual(reader.sources(), ['Note']);
    db.close();
  });

  test('a reader refuses an entity outside its declared interests', () => {
    const db = freshNoteDb();
    db.exec('CREATE TABLE Secret (id TEXT PRIMARY KEY, value TEXT);');
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({ sourceInterests: [{ entity: 'Note' }] }));
    registry.bindSource(db);
    const reader = registry.sourceReader('notes-fts');
    assert.throws(() => reader.rows('Secret'), /not a declared source interest/);
    assert.throws(() => reader.row('Secret', 's1'), /not a declared source interest/);
    db.close();
  });

  test('rows / row read only through the declared interests', () => {
    const db = freshNoteDb();
    db.prepare('INSERT INTO Note (id, title, body) VALUES (?, ?, ?)').run('n1', 'hello', 'world');
    db.prepare('INSERT INTO Note (id, title, body) VALUES (?, ?, ?)').run('n2', 'second', 'note');
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin());
    registry.bindSource(db);
    const reader = registry.sourceReader('notes-fts');

    const all = reader.rows('Note');
    assert.equal(all.length, 2);
    assert.equal(all[0].title, 'hello');

    const filtered = reader.rows('Note', { ids: ['n2'] });
    assert.deepEqual(filtered.map((row) => row.id), ['n2']);

    const limited = reader.rows('Note', { limit: 1 });
    assert.equal(limited.length, 1);

    const single = reader.row('Note', 'n1');
    assert.equal(single.body, 'world');
    assert.equal(reader.row('Note', 'missing'), undefined);
    db.close();
  });

  test('rows / row enforce the declared source scope on every read', () => {
    const db = freshNoteDb();
    db.prepare('INSERT INTO Note (id, title, body) VALUES (?, ?, ?)').run('n1', 'hello', 'world');
    db.prepare('INSERT INTO Note (id, title, body) VALUES (?, ?, ?)').run('n2', 'secret', 'note');
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      sourceInterests: [{
        entity: 'Note',
        fields: { title: { kind: 'value', type: 'text' } },
        scope: ({ fields }) => fields.title.is('hello'),
      }],
    }));
    registry.bindSource(db);
    const reader = registry.sourceReader('notes-fts');

    // The plugin declaring scope 'title === hello' must not read other rows —
    // through any read verb, ids filter included.
    const all = reader.rows('Note');
    assert.deepEqual(all.map((row) => row.id), ['n1']);
    const filtered = reader.rows('Note', { ids: ['n1', 'n2'] });
    assert.deepEqual(filtered.map((row) => row.id), ['n1']);
    assert.equal(reader.row('Note', 'n1').body, 'world');
    assert.equal(reader.row('Note', 'n2'), undefined);
    db.close();
  });

  test('a scope with multiple bound params applies all of them in order', () => {
    const db = freshNoteDb();
    db.prepare('INSERT INTO Note (id, title, body) VALUES (?, ?, ?)').run('n1', 'hello', 'world');
    db.prepare('INSERT INTO Note (id, title, body) VALUES (?, ?, ?)').run('n2', 'later', 'note');
    db.prepare('INSERT INTO Note (id, title, body) VALUES (?, ?, ?)').run('n3', 'goodbye', 'note');
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      sourceInterests: [{
        entity: 'Note',
        fields: { title: { kind: 'value', type: 'text' } },
        scope: ({ fields }) => fields.title.in(['hello', 'later']),
      }],
    }));
    registry.bindSource(db);
    const reader = registry.sourceReader('notes-fts');
    assert.deepEqual(reader.rows('Note').map((row) => row.id), ['n1', 'n2']);
    assert.equal(reader.row('Note', 'n3'), undefined);
    db.close();
  });

  test('a reader with no bound source fails closed on use', () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin());
    const reader = registry.sourceReader('notes-fts');
    assert.throws(() => reader.rows('Note'), /no bound source handle/);
  });

  test('plugin lifecycle context carries only identity and the scoped reader', async () => {
    const db = freshNoteDb();
    const registry = createSearchPluginRegistry();
    let seen = null;
    registry.register(makePlugin({
      rebuild: (ctx) => {
        seen = ctx;
        return { counts: {} };
      },
    }));
    registry.bindSource(db);
    await registry.rebuild('notes-fts');
    assert.ok(seen);
    assert.equal(seen.id, 'notes-fts');
    assert.equal(seen.version, '1.0.0');
    assert.equal(typeof seen.generation, 'number');
    assert.equal(typeof seen.fence, 'number');
    assert.equal(seen.reader.writeCapable, false);
    assert.equal(seen.db, undefined);
    assert.equal(seen.handle, undefined);
    db.close();
  });

  test('createSearchSourceReader is directly reachable and read-only', () => {
    const db = freshNoteDb();
    const reader = createSearchSourceReader(db, { plugin: 'direct', interests: [{ entity: 'Note' }] });
    assert.equal(reader.writeCapable, false);
    assert.equal(reader.plugin, 'direct');
    assert.deepEqual(reader.sources(), ['Note']);
    db.close();
  });
});

// ---- failure isolation -----------------------------------------------------

describe('search plugin registry — failure isolation', () => {
  test('an index failure marks the plugin failed with retained retry info and never throws', async () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      id: 'broken',
      rebuild: () => {
        throw new Error('index disk full');
      },
    }));
    let outcome;
    await assert.doesNotReject(async () => {
      outcome = await registry.rebuild('broken');
    });
    assert.equal(outcome.ok, false);
    const state = registry.stateOf('broken');
    assert.equal(state.state, 'failed');
    assert.equal(state.generation, 1);
    assert.equal(state.fence, 1);
    assert.equal(state.lastError.message, 'index disk full');
    assert.equal(state.lastError.attempt, 1);
    assert.equal(state.lastError.retryable, true);
    assert.equal(typeof state.lastError.at, 'string');
  });

  test('a failed plugin does not affect a healthy plugin', async () => {
    const db = freshNoteDb();
    const registry = createSearchPluginRegistry();
    registry.bindSource(db);
    registry.register(makePlugin({
      id: 'broken',
      rebuild: () => {
        throw new Error('boom');
      },
    }));
    registry.register(makePlugin({
      id: 'healthy',
      rebuild: () => ({ counts: { documents: 7 } }),
      search: () => ({ hits: [{ id: 'n1' }] }),
    }));
    await registry.rebuild('broken');
    assert.equal(registry.stateOf('broken').state, 'failed');
    const outcome = await registry.rebuild('healthy');
    assert.equal(outcome.ok, true);
    assert.equal(registry.stateOf('healthy').state, 'ready');
    assert.deepEqual(registry.stateOf('healthy').counts, { documents: 7 });
    const search = await registry.search('healthy', { query: 'x' });
    assert.equal(search.ok, true);
    db.close();
  });

  test('a search failure is recorded but does not invalidate the index state', async () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      id: 'flaky-search',
      search: () => {
        throw new Error('query exploded');
      },
    }));
    await registry.rebuild('flaky-search');
    const before = registry.stateOf('flaky-search');
    assert.equal(before.state, 'ready');

    const outcome = await registry.search('flaky-search', { query: 'x' });
    assert.equal(outcome.ok, false);
    const after = registry.stateOf('flaky-search');
    assert.equal(after.state, 'ready');
    assert.equal(after.fence, before.fence);
    assert.equal(after.generation, before.generation);
    assert.equal(after.lastError.message, 'query exploded');
  });

  test('a reconcile failure leaves the plugin failed with retry info', async () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      id: 'reconcile-broken',
      reconcile: () => {
        throw new Error('merge conflict in index');
      },
    }));
    const outcome = await registry.reconcile('reconcile-broken', []);
    assert.equal(outcome.ok, false);
    const state = registry.stateOf('reconcile-broken');
    assert.equal(state.state, 'failed');
    assert.match(state.lastError.message, /merge conflict/);
    assert.equal(state.lastError.attempt, 1);
  });

  test('a throwing stalenessKey is isolated, recorded in health, and recovers', async () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      id: 'throwy-key',
      stalenessKey: () => {
        throw new Error('key explode');
      },
    }));
    let notification;
    assert.doesNotThrow(() => {
      notification = registry.notifyChange('throwy-key', { entity: 'Note', rowId: 'n1', kind: 'updated' });
    });
    assert.equal(notification.invalidated, false);
    let state = registry.stateOf('throwy-key');
    assert.equal(state.state, 'failed');
    assert.equal(state.fence, 1);
    assert.equal(state.lastError.message, 'key explode');
    assert.equal(state.lastError.attempt, 1);
    assert.equal(state.lastError.retryable, true);

    // The failure is isolated: a successful rebuild clears it and recovers.
    const outcome = await registry.rebuild('throwy-key');
    assert.equal(outcome.ok, true);
    state = registry.stateOf('throwy-key');
    assert.equal(state.state, 'ready');
    assert.equal(state.lastError, null);
  });
});

// ---- S4/A6 search composition: bounds, cancellation, start-stamp -----------

describe('search plugin registry — search composition', () => {
  test('the registry owns the window: the plugin is asked from offset 0 for the full span, and the output is sliced exactly once (cap + page)', async () => {
    let received = null;
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      id: 'windowed',
      search: (_ctx, request) => {
        received = request;
        return { hits: Array.from({ length: 300 }, (_, i) => ({ id: `n${i}`, rank: i })) };
      },
    }));
    await registry.rebuild('windowed');
    // a page size past the cap is CLAMPED at the boundary, never honored
    const outcome = await registry.search('windowed', { page: 3, pageSize: 5000 });
    assert.equal(outcome.ok, true);
    assert.equal(received.offset, 0, 'the caller’s offset is never forwarded — the registry owns offsetting');
    assert.equal(received.limit, 200 + SEARCH_MAX_PAGE_SIZE, 'the plugin is asked for the full span the window needs');
    assert.equal(outcome.result.hits.length, SEARCH_MAX_PAGE_SIZE, 'nothing beyond the page window escapes the registry');
    assert.equal(outcome.result.hits[0].id, 'n200');
  });

  test('a plugin that HONORS its request window is never double-windowed', async () => {
    let received = null;
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      id: 'honoring',
      search: (_ctx, request) => {
        received = request;
        const all = Array.from({ length: 300 }, (_, i) => ({ id: `n${i}`, rank: i }));
        // the plugin faithfully applies its received window (offset + limit)
        return { hits: all.slice(request.offset ?? 0, (request.offset ?? 0) + request.limit) };
      },
    }));
    await registry.rebuild('honoring');
    const outcome = await registry.search('honoring', { page: 3, pageSize: 100 });
    assert.equal(received.offset, 0, 'an offset-honoring plugin is only ever given offset 0, so no second window is possible');
    assert.equal(received.limit, 300);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.hits.length, 100);
    assert.equal(outcome.result.hits[0].id, 'n200');
    assert.equal(outcome.result.hits[99].id, 'n299');
  });

  test('a flat offset/limit window lands on the requested span without re-offsetting', async () => {
    let received = null;
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      id: 'flat-window',
      search: (_ctx, request) => {
        received = request;
        const all = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, rank: i }));
        return { hits: all.slice(request.offset ?? 0, (request.offset ?? 0) + request.limit) };
      },
    }));
    await registry.rebuild('flat-window');
    const outcome = await registry.search('flat-window', { offset: 10, limit: 30 });
    assert.equal(received.offset, 0);
    assert.equal(received.limit, 40);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.hits.length, 30);
    assert.equal(outcome.result.hits[0].id, 'n10');
    assert.equal(outcome.result.hits[29].id, 'n39');
  });

  test('a bound-less search is windowed to the default limit', async () => {
    let received = null;
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      id: 'default-window',
      search: (_ctx, request) => {
        received = request;
        return { hits: Array.from({ length: 300 }, (_, i) => ({ id: `n${i}`, rank: i })) };
      },
    }));
    await registry.rebuild('default-window');
    const outcome = await registry.search('default-window', {});
    assert.equal(received.limit, SEARCH_DEFAULT_LIMIT);
    assert.equal(received.offset, 0);
    assert.equal(outcome.result.hits.length, SEARCH_DEFAULT_LIMIT);
  });

  test('an already-aborted search is a closed non-ok outcome and never queries the plugin', async () => {
    let invoked = false;
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      id: 'cancellable',
      search: () => {
        invoked = true;
        return { hits: [{ id: 'n1' }] };
      },
    }));
    await registry.rebuild('cancellable');
    const controller = new AbortController();
    controller.abort();
    const outcome = await registry.search('cancellable', { query: 'x', signal: controller.signal });
    assert.equal(invoked, false, 'an already-aborted search never queries the plugin');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.cancelled, true);
    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.result, null);
    // a query-side interruption never touches index health
    assert.equal(registry.stateOf('cancellable').state, 'ready');
  });

  test('a search that exceeds the registry deadline times out closed and the run signal is aborted', async () => {
    let receivedSignal = null;
    const registry = createSearchPluginRegistry({ searchTimeoutMs: 20 });
    registry.register(makePlugin({
      id: 'hangy',
      search: (_ctx, request) => {
        receivedSignal = request.signal;
        return new Promise(() => {}); // never resolves, ignores the signal
      },
    }));
    await registry.rebuild('hangy');
    const outcome = await registry.search('hangy', { query: 'x' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.cancelled, false);
    assert.equal(outcome.result, null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(receivedSignal.aborted, true, 'the plugin received an aborted signal at the deadline');
    assert.equal(registry.stateOf('hangy').state, 'ready');
  });

  test('generation/fence/state are stamped at search START, not after the await', async () => {
    let registry;
    const plugin = makePlugin({
      id: 'stampy',
      search: async () => {
        // a mid-run rebuild advances the generation while this search is in flight
        await registry.rebuild('stampy');
        return { hits: [{ id: 'n1', rank: 1 }] };
      },
    });
    registry = createSearchPluginRegistry();
    registry.register(plugin);
    await registry.rebuild('stampy');
    const before = registry.stateOf('stampy').generation;
    const outcome = await registry.search('stampy', { query: 'x' });
    assert.equal(registry.stateOf('stampy').generation, before + 1, 'the mid-run rebuild actually advanced the index');
    // the run labeled its hits with the generation that existed when it STARTED
    assert.equal(outcome.generation, before);
    assert.equal(outcome.result.generation, before);
  });
});

// ---- generation / fence state transitions ----------------------------------

describe('search plugin registry — generation and fence transitions', () => {
  test('registration starts at generation 0, fence 0, building', () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin());
    const state = registry.stateOf('notes-fts');
    assert.equal(state.generation, 0);
    assert.equal(state.fence, 0);
    assert.equal(state.state, 'building');
    assert.deepEqual(state.counts, {});
    assert.equal(state.lastError, null);
  });

  test('a successful rebuild advances the generation to ready', async () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin());
    const outcome = await registry.rebuild('notes-fts');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.generation, 1);
    const state = registry.stateOf('notes-fts');
    assert.equal(state.generation, 1);
    assert.equal(state.fence, 0);
    assert.equal(state.state, 'ready');
  });

  test('a matching change advances the fence and marks the index stale', async () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin());
    await registry.rebuild('notes-fts');
    const none = registry.notifyChange('notes-fts', { entity: 'Other', rowId: 'o1', kind: 'created' });
    assert.equal(none.invalidated, false);
    assert.equal(registry.stateOf('notes-fts').fence, 0);
    assert.equal(registry.stateOf('notes-fts').state, 'ready');

    const hit = registry.notifyChange('notes-fts', { entity: 'Note', rowId: 'n1', kind: 'updated', data: { title: 'new' } });
    assert.equal(hit.invalidated, true);
    assert.equal(hit.stalenessKey, 'Note:n1');
    const state = registry.stateOf('notes-fts');
    assert.equal(state.fence, 1);
    assert.equal(state.state, 'stale');
  });

  test('reconcile consumes the invalidation and returns to ready', async () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin());
    await registry.rebuild('notes-fts');
    registry.notifyChange('notes-fts', { entity: 'Note', rowId: 'n1', kind: 'updated' });
    assert.equal(registry.stateOf('notes-fts').state, 'stale');
    const outcome = await registry.reconcile('notes-fts', [
      { entity: 'Note', rowId: 'n1', kind: 'updated' },
    ]);
    assert.equal(outcome.ok, true);
    const state = registry.stateOf('notes-fts');
    assert.equal(state.generation, 2);
    assert.equal(state.fence, 1);
    assert.equal(state.state, 'ready');
  });

  test('a rebuild failure bumps the fence and marks the plugin failed; a retry recovers', async () => {
    let failNext = true;
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      id: 'flaky-build',
      rebuild: () => {
        if (failNext) {
          failNext = false;
          throw new Error('transient rebuild failure');
        }
        return { counts: { documents: 3 } };
      },
    }));
    const failed = await registry.rebuild('flaky-build');
    assert.equal(failed.ok, false);
    let state = registry.stateOf('flaky-build');
    assert.equal(state.state, 'failed');
    assert.equal(state.fence, 1);
    assert.equal(state.lastError.attempt, 1);
    assert.equal(state.lastError.retryable, true);

    const recovered = await registry.rebuild('flaky-build');
    assert.equal(recovered.ok, true);
    state = registry.stateOf('flaky-build');
    assert.equal(state.state, 'ready');
    assert.equal(state.generation, 2);
    assert.equal(state.fence, 1);
    assert.equal(state.lastError, null);
    assert.deepEqual(state.counts, { documents: 3 });
  });

  test('a change arriving on a failed plugin does not leave the failed state', async () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      id: 'broken',
      rebuild: () => {
        throw new Error('never');
      },
    }));
    await registry.rebuild('broken');
    assert.equal(registry.stateOf('broken').state, 'failed');
    const fenceBefore = registry.stateOf('broken').fence;
    registry.notifyChange('broken', { entity: 'Note', rowId: 'n1', kind: 'removed' });
    assert.equal(registry.stateOf('broken').fence, fenceBefore + 1);
    assert.equal(registry.stateOf('broken').state, 'failed');
  });

  test('a change landing during an in-flight rebuild ends stale, not ready', async () => {
    const registry = createSearchPluginRegistry();
    let releaseBuild;
    let started = false;
    const gate = new Promise((resolve) => {
      releaseBuild = resolve;
    });
    registry.register(makePlugin({
      id: 'gated-build',
      rebuild: async () => {
        started = true;
        await gate;
        return { counts: { documents: 5 } };
      },
    }));
    const building = registry.rebuild('gated-build');
    assert.equal(started, true, 'the rebuild is in flight before the change lands');
    registry.notifyChange('gated-build', { entity: 'Note', rowId: 'n1', kind: 'updated' });
    releaseBuild();
    const outcome = await building;
    assert.equal(outcome.ok, true, 'the in-flight rebuild itself still succeeded');
    // The fence moved while the rebuild was in flight: the completed index does
    // NOT reflect the current source, so it must end stale — never overwritten
    // to ready by the older cycle.
    const state = registry.stateOf('gated-build');
    assert.equal(state.state, 'stale');
    assert.equal(state.fence, 1);
    assert.equal(state.generation, 1);
    assert.deepEqual(state.counts, { documents: 5 });
  });

  test('an identity change during rebuild stays building with cleared counts', async () => {
    const registry = createSearchPluginRegistry();
    let generationIdentity = 'model-v1';
    let releaseBuild;
    const gate = new Promise((resolve) => {
      releaseBuild = resolve;
    });
    const plugin = makePlugin({
      id: 'identity-gated-build',
      rebuild: async () => {
        await gate;
        return { counts: { documents: 5 } };
      },
    });
    Object.defineProperty(plugin, 'generationIdentity', { get: () => generationIdentity });
    registry.register(plugin);

    const building = registry.rebuild('identity-gated-build');
    generationIdentity = 'model-v2';
    releaseBuild();
    const outcome = await building;
    assert.equal(outcome.state, 'building');
    assert.deepEqual(outcome.counts, {});
    const state = registry.stateOf('identity-gated-build');
    assert.equal(state.state, 'building');
    assert.deepEqual(state.counts, {});
    assert.equal(state.generation, 2);
    assert.equal(state.fence, 1);
  });

  test('an overlapping stale rebuild cannot overwrite a newer identity', async () => {
    const registry = createSearchPluginRegistry();
    let generationIdentity = 'model-v1';
    let releaseOld;
    const oldGate = new Promise((resolve) => {
      releaseOld = resolve;
    });
    let firstCall = true;
    const plugin = makePlugin({
      id: 'overlap-build',
      rebuild: async () => {
        if (firstCall) {
          firstCall = false;
          await oldGate;
          // The OLD identity's stale result: if it were allowed to land, it
          // would clobber the newer generation's counts.
          return { counts: { documents: 1 } };
        }
        return { counts: { documents: 99 } };
      },
    });
    Object.defineProperty(plugin, 'generationIdentity', { get: () => generationIdentity });
    registry.register(plugin);

    // The OLD rebuild goes in flight under model-v1.
    const oldBuild = registry.rebuild('overlap-build');
    // The identity changes, and a NEWER materialization runs to completion,
    // synchronizing the ledger to model-v2 with the new counts.
    generationIdentity = 'model-v2';
    await registry.rebuild('overlap-build');
    assert.deepEqual(registry.stateOf('overlap-build').counts, { documents: 99 });
    // Now the OLD rebuild resumes. Its result belongs to model-v1 and must not
    // clobber the model-v2 generation's counts/state.
    releaseOld();
    const oldOutcome = await oldBuild;
    const state = registry.stateOf('overlap-build');
    assert.equal(state.state, 'ready');
    assert.deepEqual(state.counts, { documents: 99 });
    assert.equal(oldOutcome.state, 'ready');
    assert.deepEqual(oldOutcome.counts, { documents: 99 });
  });
});

// ---- prepare / validate ----------------------------------------------------

describe('search plugin registry — prepare and validate', () => {
  test('a successful prepare leaves the plugin building, not ready', async () => {
    const registry = createSearchPluginRegistry();
    let prepared = false;
    registry.register(makePlugin({
      prepare: () => {
        prepared = true;
      },
    }));
    const outcome = await registry.prepare('notes-fts');
    assert.equal(outcome.ok, true);
    assert.equal(prepared, true);
    assert.equal(registry.stateOf('notes-fts').state, 'building');
    assert.equal(registry.stateOf('notes-fts').generation, 1);
  });

  test('a failing prepare marks the plugin failed with retry info', async () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      prepare: () => {
        throw new Error('cannot create virtual table');
      },
    }));
    const outcome = await registry.prepare('notes-fts');
    assert.equal(outcome.ok, false);
    const state = registry.stateOf('notes-fts');
    assert.equal(state.state, 'failed');
    assert.match(state.lastError.message, /virtual table/);
  });

  test('a successful validate marks the index ready', async () => {
    const registry = createSearchPluginRegistry();
    let validated = false;
    registry.register(makePlugin({
      validate: () => {
        validated = true;
      },
    }));
    const outcome = await registry.validate('notes-fts');
    assert.equal(outcome.ok, true);
    assert.equal(validated, true);
    assert.equal(registry.stateOf('notes-fts').state, 'ready');
  });

  test('a failing validate marks the plugin failed', async () => {
    const registry = createSearchPluginRegistry();
    registry.register(makePlugin({
      validate: () => {
        throw new Error('index integrity check failed');
      },
    }));
    const outcome = await registry.validate('notes-fts');
    assert.equal(outcome.ok, false);
    assert.equal(registry.stateOf('notes-fts').state, 'failed');
    assert.equal(registry.stateOf('notes-fts').lastError.attempt, 1);
  });
});

// ---- app-level registerSearchPlugin surface --------------------------------

describe('app.registerSearchPlugin surface', () => {
  test('registers, validates, and binds the app database as the source', () => {
    const db = new DatabaseSync(':memory:');
    const app = workbench({ db });
    const chained = app.registerSearchPlugin(makePlugin());
    assert.equal(chained, app);
    assert.equal(app.searchPlugins.size, 1);
    assert.throws(() => app.registerSearchPlugin(makePlugin({ id: 'notes-fts' })), /already registered/);
    assert.throws(
      () => app.registerSearchPlugin(makePlugin({
        id: 'bad-kind',
         ownedObjects: [{ kind: 'shard', name: 'bad_shard', ddl: ['CREATE TABLE bad_shard (id TEXT);'], disposition: { kind: 'schema-only' } }],
      })),
      /unknown kind/,
    );
    const reader = app.searchPlugins.sourceReader('notes-fts');
    assert.equal(reader.writeCapable, false);
    db.close();
  });

  test('a failing plugin never surfaces as an authoritative-write error', async (t) => {
    const db = new DatabaseSync(':memory:');
    const note = entity('Note', {
      title: text(),
      grant: () => grant(read, write, subscribe),
    });
    const app = workbench({ db }).mount('/notes', note);
    t.after(async () => {
      await app.shutdown();
      db.close();
    });
    await app.start();

    app.registerSearchPlugin(makePlugin({
      id: 'failing-index',
      rebuild: () => {
        throw new Error('index disk full');
      },
      search: () => {
        throw new Error('query exploded');
      },
    }));

    const outcome = await app.searchPlugins.rebuild('failing-index');
    assert.equal(outcome.ok, false);
    assert.equal(app.searchPlugins.stateOf('failing-index').state, 'failed');

    const writeResult = await app.dispatch({
      actionId: 'after-plugin-failure',
      type: 'Note.create',
      payload: { id: 'n-1', title: 'still works' },
      principal: principal({ type: 'user', id: 'authoritative-writer' }),
    });
    assert.equal(writeResult.ok, true);
    assert.equal(db.prepare('SELECT title FROM Note WHERE id = ?').get('n-1').title, 'still works');
  });

  test('a plugin registered before a deferred adapter open lands is bound after ready', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-search-deferred-'));
    try {
      const app = workbench({ db: createSqliteAdapter({ directory: join(root, 'owned'), name: 'app', mode: 'file' }) });
      try {
        assert.equal(app.db, null, 'the deferred adapter has no handle before the open lands');
        app.registerSearchPlugin(makePlugin());
        await app.ready;
        assert.ok(app.db, 'awaiting ready installed the deferred handle');
        app.db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, body TEXT);');
        app.db.prepare('INSERT INTO Note (id, title, body) VALUES (?, ?, ?)').run('n1', 'hello', 'world');
        const reader = app.searchPlugins.sourceReader('notes-fts');
        assert.deepEqual(reader.sources(), ['Note']);
        const rows = reader.rows('Note');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].title, 'hello');
        assert.equal(reader.row('Note', 'n1').body, 'world');
      } finally {
        await app.shutdown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('search plugin registry — hybrid fusion pagination contract', () => {
  // A registry whose branches answer the requested depth, like the real one:
  // whatever `limit` the composer asks for bounds that branch's candidate list.
  function depthBoundRegistry(branches) {
    return {
      search(pluginId, request) {
        const hits = (branches[pluginId] ?? []).slice(0, request.limit ?? 0).map((id) => ({ id }));
        return {
          ok: true, generation: 1, fence: 0, state: 'ready', counts: {}, lastError: null,
          result: { hits, generation: 1, fence: 0, state: 'ready' },
          cancelled: false, timedOut: false,
        };
      },
    };
  }

  test('per-page windows read ONE stable fused ranking, so pages never repeat a hit', async () => {
    // `c` and `d` rank low lexically but gain a vector contribution only when
    // the vector branch is read deeply. A branch depth derived from each page's
    // own offset would let the shallow page rank a,b first and the deeper page
    // rank c,d first — repeating `a` across pages 0 and 2.
    const registry = depthBoundRegistry({ fts: ['a', 'b', 'c', 'd'], vec: ['c', 'd'] });
    const pages = [];
    for (let offset = 0; offset < 4; offset += 1) {
      const page = await hybridSearch({
        registry,
        principal: { type: 'user', id: 'alice' },
        fts: { pluginId: 'fts', query: 'q' },
        vector: { pluginId: 'vec', query: {} },
        offset,
        limit: 1,
      });
      assert.equal(page.ok, true);
      pages.push(...page.hits.map((hit) => hit.key));
    }
    assert.deepEqual(pages, ['c', 'd', 'a', 'b']);
    assert.equal(new Set(pages).size, pages.length, 'paginated hits are unique');

    // The full pool is disclosed, so a caller can tell exhaustion from a
    // window that was cut short.
    const full = await hybridSearch({
      registry,
      principal: { type: 'user', id: 'alice' },
      fts: { pluginId: 'fts', query: 'q' },
      vector: { pluginId: 'vec', query: {} },
      limit: 10,
    });
    assert.equal(full.totalCandidates, 4);
    assert.deepEqual(full.hits.map((hit) => hit.key), ['c', 'd', 'a', 'b']);
  });
});
