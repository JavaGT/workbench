// search-scale-hardening.test.mjs — scale, persistence, scoping, incremental
// revocation, generation fencing (#243), and hybrid RRF tests for #288.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFts5Plugin } from '../build/fts5-plugin.mjs';
import { createVectorPlugin } from '../build/vector-plugin.mjs';
import { createSearchOwnedIndexCapability } from '../build/index-capability.mjs';
import {
  composeHybridSearch,
  createSearchPluginRegistry,
  HYBRID_SEARCH_DEFAULT_RRF_K,
  hybridSearch,
} from '../build/search-plugin.mjs';
import { createSearchStalenessBridge } from '../build/search-staleness.mjs';
import { createSearchReconcileEngine } from '../build/search-reconcile.mjs';
import { createAuthorizationAdapter } from '../build/authorization-adapter.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { entity } from '../build/internal.mjs';
import {
  deny,
  grant,
  principal,
  read,
  ref,
  scope,
  subscribe,
  text,
  write,
} from '../build/index.mjs';

const alice = principal({ type: 'user', id: 'alice' });

function makeAdmission(db, pluginIds = ['note-fts', 'note-vec']) {
  const Note = entity('Note', {
    projectId: text(),
    title: text(),
    body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : deny('no'),
      ),
    ],
  });
  // Every per-result admission verifies the registered owner scope against the
  // actual Note table via the compiled SQL engine. A DB-less adapter now fails
  // closed, so bind the source handle and table at registration time.
  const adapter = createAuthorizationAdapter({ db });
  for (const name of pluginIds) {
    adapter.registerResource({
      category: 'search',
      name,
      scope: ({ is }) => is.owner(),
      fields: { owner: ref('User', { role: 'owner' }) },
      table: 'Note',
      db,
    });
  }
  return { entity: Note, adapter };
}

function buildCensusMap(registry) {
  const census = new Map();
  for (const object of registry.census().objects) {
    census.set(`${object.kind}:${object.name}`.toLowerCase(), {
      kind: 'plugin',
      owner: object.owner,
      objectKind: object.kind,
      name: object.name,
    });
  }
  return census;
}

async function setupSearchSuite({
  dbPath = ':memory:',
  dimensions = 4,
  withVector = true,
  withFts = true,
  snippetLength = 32,
  maxRows = 10_000,
} = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS Note (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      embedding TEXT,
      embedding_model TEXT,
      owner TEXT NOT NULL
    );
  `);

  const registry = createSearchPluginRegistry();
  const admission = makeAdmission(db, ['note-fts', 'note-vec']);

  const ftsPlugin = withFts
    ? createFts5Plugin({
      id: 'note-fts',
      version: '1.0.0',
      tokenizer: 'porter',
      snippetLength,
      source: { entity: 'Note', fields: ['title', 'body'], scopeField: 'projectId' },
      admission,
    })
    : null;

  const vecPlugin = withVector
    ? createVectorPlugin({
      id: 'note-vec',
      version: '1.0.0',
      source: {
        entity: 'Note',
        vector: 'embedding',
        model: 'embedding_model',
        scopeField: 'projectId',
        owns: () => true,
      },
      modelSpace: { model: 'embed-v1', dimensions },
      admission,
    })
    : null;

  if (ftsPlugin) registry.register(ftsPlugin);
  if (vecPlugin) registry.register(vecPlugin);

  for (const entry of registry.census().entries) {
    db.exec(entry.sql);
  }

  const census = buildCensusMap(registry);
  const queue = createWriteQueue();
  registry.bindSource(db);
  registry.bindIndex(createSearchOwnedIndexCapability({
    db,
    census,
    writeCoordinator: queue,
    fenceOf: (id) => registry.stateOf(id).fence,
    maxRows,
  }));

  if (ftsPlugin) {
    const prep = await registry.prepare(ftsPlugin.id);
    assert.equal(prep.ok, true, prep.lastError?.message);
  }
  if (vecPlugin) {
    const prep = await registry.prepare(vecPlugin.id);
    assert.equal(prep.ok, true, prep.lastError?.message);
  }

  const insertStmt = db.prepare(
    'INSERT INTO Note (id, projectId, title, body, embedding, embedding_model, owner) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insert = (id, projectId, title, body, embedding = null, owner = 'alice') => {
    insertStmt.run(
      id,
      projectId,
      title,
      body,
      embedding === null ? null : JSON.stringify(embedding),
      embedding === null ? null : 'embed-v1',
      owner,
    );
  };

  const close = async () => {
    await queue.close();
    db.close();
  };

  return { db, registry, ftsPlugin, vecPlugin, queue, census, admission, insert, close };
}

describe('index-capability runtime portability', () => {
  test('index-capability has zero node:sqlite imports in source and build output', () => {
    const src = readFileSync(new URL('../src/index-capability.ts', import.meta.url), 'utf8');
    const built = readFileSync(new URL('../build/index-capability.mjs', import.meta.url), 'utf8');
    assert.equal(/from\s+['"]node:sqlite['"]/.test(src), false, 'src/index-capability.ts must not import node:sqlite');
    assert.equal(/from\s+['"]node:sqlite['"]/.test(built), false, 'build/index-capability.mjs must not import node:sqlite');
  });
});

describe('FTS5 scale hardening (>12k rows, single-query MATCH, no payload UNINDEXED)', () => {
  test('rebuilds and shadow-rebuilds >12,000 rows without tripping default maxRows=10,000', async (t) => {
    const kit = await setupSearchSuite({ withVector: false, snippetLength: 80 });
    t.after(() => kit.close());

    // Confirm DDL has scope_id UNINDEXED and no payload UNINDEXED column.
    const ftsTables = kit.registry.census().objects.filter((obj) => obj.kind === 'virtual-table');
    assert.equal(ftsTables.length, 2);
    for (const table of ftsTables) {
      assert.match(table.ddl[0], /scope_id UNINDEXED/);
      assert.doesNotMatch(table.ddl[0], /payload UNINDEXED/);
    }

    const totalRows = 12_500;
    kit.db.exec('BEGIN');
    for (let i = 0; i < totalRows; i += 1) {
      const id = `n-${String(i).padStart(5, '0')}`;
      const projectId = i % 50 === 0 ? 'proj-rare' : 'proj-bulk';
      const title = i === 12_450 ? 'lighthouse beacon target' : `Bulk document ${i}`;
      const body = i % 100 === 0 ? `periodic coastal signal ${i}` : `routine transcript entry ${i}`;
      kit.insert(id, projectId, title, body);
    }
    kit.db.exec('COMMIT');

    // First full rebuild over 12,500 rows.
    const first = await kit.registry.rebuild('note-fts');
    assert.equal(first.ok, true, first.lastError?.message);
    assert.equal(first.counts.documents, totalRows);
    assert.equal(first.state, 'ready');

    // Second full rebuild must clear >10,000 existing rows cleanly via clear() without tripping maxRows.
    const second = await kit.registry.rebuild('note-fts');
    assert.equal(second.ok, true, second.lastError?.message);
    assert.equal(second.counts.documents, totalRows);

    // Shadow rebuild over 12,500 rows with boundary census parity and health check.
    const bridge = createSearchStalenessBridge({ registry: kit.registry });
    bridge.engage(kit.db);
    const engine = createSearchReconcileEngine({
      registry: kit.registry,
      staleness: bridge,
      db: kit.db,
      writeQueue: kit.queue,
    });
    const shadow = await engine.rebuildShadow('note-fts');
    assert.equal(shadow.ok, true, shadow.lastError ?? 'shadow rebuild failed');
    assert.equal(shadow.activated, true);
    assert.equal(engine.parity('note-fts').matches, true);
    assert.equal(kit.registry.healthOf('note-fts').plugin.integrity.ok, true);

    // Search works cleanly on the promoted >12k generation, including snippetLength > 64.
    const found = await kit.registry.search('note-fts', {
      query: 'lighthouse',
      scope: { projectId: 'proj-rare' },
      principal: alice,
      limit: 5,
    });
    assert.equal(found.ok, true, found.lastError?.message);
    assert.equal(found.result.hits.length, 1);
    assert.equal(found.result.hits[0].id, 'n-12450');
    assert.equal(found.result.hits[0].excerptField, 'title');
    assert.match(found.result.hits[0].excerpt, /lighthouse/);
  });

  test('FTS5 search runs a single MATCH query (no per-hit N+1 MATCH)', async (t) => {
    const kit = await setupSearchSuite({ withVector: false });
    t.after(() => kit.close());

    for (let i = 0; i < 25; i += 1) {
      kit.insert(`hit-${String(i).padStart(2, '0')}`, 'proj-a', `sharedterm title ${i}`, `body text ${i}`);
    }
    const rebuilt = await kit.registry.rebuild('note-fts');
    assert.equal(rebuilt.ok, true, rebuilt.lastError?.message);

    // Wrap the owned-index capability to count MATCH statements issued during one search.
    const baseCap = createSearchOwnedIndexCapability({
      db: kit.db,
      census: kit.census,
      writeCoordinator: kit.queue,
      fenceOf: (id) => kit.registry.stateOf(id).fence,
    });
    const queries = [];
    kit.registry.bindIndex((pluginId) => {
      const inner = baseCap(pluginId);
      return Object.freeze({
        ...inner,
        query(stmt) {
          queries.push(stmt.sql);
          return inner.query(stmt);
        },
      });
    });

    const outcome = await kit.registry.search('note-fts', {
      query: 'sharedterm',
      scopeId: 'proj-a',
      principal: alice,
      limit: 20,
    });
    assert.equal(outcome.ok, true, outcome.lastError?.message);
    assert.equal(outcome.result.hits.length, 20);
    const matchQueries = queries.filter((sql) => /\bMATCH\b/i.test(sql));
    assert.equal(matchQueries.length, 1, `expected exactly 1 MATCH query for 20 hits, got ${matchQueries.length}`);
  });
});

describe('scoped SQL/slab pre-filtering prevents cross-project hit starvation', () => {
  test('FTS5 and Vector pre-filter by scope before LIMIT', async (t) => {
    const kit = await setupSearchSuite({ dimensions: 2 });
    t.after(() => kit.close());

    kit.db.exec('BEGIN');
    // 500 foreign rows that strictly outrank target rows in both BM25 and cosine similarity.
    for (let i = 0; i < 500; i += 1) {
      kit.insert(
        `foreign-${String(i).padStart(3, '0')}`,
        'project-noisy',
        'needle needle needle needle',
        'needle needle needle',
        [1, 0],
      );
    }
    kit.insert('target-1', 'project-target', 'needle', 'contextual summary', [0.8, 0.6]);
    kit.insert('target-2', 'project-target', 'overview', 'single needle mention', [0.6, 0.8]);
    kit.insert('target-3', 'project-target', 'unrelated', 'quiet note', [0.1, 0.995]);
    kit.db.exec('COMMIT');

    assert.equal((await kit.registry.rebuild('note-fts')).ok, true);
    assert.equal((await kit.registry.rebuild('note-vec')).ok, true);

    // Unscoped limit=2 is completely saturated by project-noisy.
    const unscopedFts = await kit.registry.search('note-fts', {
      query: 'needle',
      principal: alice,
      limit: 2,
    });
    assert.equal(unscopedFts.ok, true);
    assert.ok(unscopedFts.result.hits.every((h) => h.id.startsWith('foreign-')));

    // Scoped FTS5 pre-filters in SQL before LIMIT and returns target rows immediately.
    const scopedFts = await kit.registry.search('note-fts', {
      query: 'needle',
      scope: { projectId: 'project-target' },
      principal: alice,
      limit: 2,
    });
    assert.equal(scopedFts.ok, true, scopedFts.lastError?.message);
    assert.deepEqual(
      scopedFts.result.hits.map((h) => h.id).sort(),
      ['target-1', 'target-2'],
    );

    // Scoped Vector pre-filters via O(1) scope bucket before top-K scan.
    const scopedVec = await kit.registry.search('note-vec', {
      query: { model: 'embed-v1', vector: [1, 0] },
      scopeId: 'project-target',
      principal: alice,
      limit: 2,
    });
    assert.equal(scopedVec.ok, true, scopedVec.lastError?.message);
    assert.deepEqual(
      scopedVec.result.hits.map((h) => h.id),
      ['target-1', 'target-2'],
    );
  });
});

describe('incremental revocation without full rebuild', () => {
  test('row and scope revocations delete incrementally from FTS5 and Vector without calling rebuild()', async (t) => {
    const kit = await setupSearchSuite({ dimensions: 2 });
    t.after(() => kit.close());

    kit.insert('keep-1', 'proj-keep', 'alpha signal', 'kept content', [1, 0]);
    kit.insert('revoke-row', 'proj-keep', 'alpha signal', 'single revoked row', [0.99, 0.1]);
    kit.insert('revoke-scope-1', 'proj-gone', 'alpha signal', 'scope gone 1', [0.98, 0.2]);
    kit.insert('revoke-scope-2', 'proj-gone', 'alpha signal', 'scope gone 2', [0.97, 0.24]);
    kit.insert('erased-row', 'proj-keep', 'alpha signal', 'erased content', [0.96, 0.28]);

    assert.equal((await kit.registry.rebuild('note-fts')).ok, true);
    assert.equal((await kit.registry.rebuild('note-vec')).ok, true);

    // Wrap plugins in a new registry? No — spy on registry.rebuild vs registry.revoke
    // by instrumenting the engine's registry facade or checking counts + call log.
    let rebuildCalls = 0;
    let revokeCalls = 0;
    const origRebuild = kit.registry.rebuild;
    const origRevoke = kit.registry.revoke;
    const spiedRegistry = {
      ...kit.registry,
      rebuild(id) {
        rebuildCalls += 1;
        return origRebuild(id);
      },
      revoke(id, target) {
        revokeCalls += 1;
        return origRevoke(id, target);
      },
    };

    const bridge = createSearchStalenessBridge({ registry: spiedRegistry });
    bridge.engage(kit.db);
    const engine = createSearchReconcileEngine({
      registry: spiedRegistry,
      staleness: bridge,
      db: kit.db,
      writeQueue: kit.queue,
    });

    // Queue single-row revocation, scope revocation, and erasure.
    bridge.onRevocation(alice, { category: 'entity', key: 'Note:revoke-row' });
    bridge.onRevocation(alice, { category: 'entity', key: 'Note:scope:proj-gone' });
    bridge.notifySourceChange({
      entity: 'Note',
      rowId: 'erased-row',
      kind: 'removed',
      committedAt: '2026-11-23T00:00:00.000Z',
      erasure: true,
    });

    const summary = await engine.reconcileBatches({ batchSize: 10 });
    assert.equal(summary.failures.length, 0, JSON.stringify(summary.failures));
    assert.equal(summary.processed, 3);
    assert.equal(summary.rebuilt, 0, 'incremental revocation must not trigger full rebuild');
    assert.equal(rebuildCalls, 0, 'registry.rebuild() must not be called for entity/scope revocations');
    assert.equal(revokeCalls, 6, 'both FTS5 and Vector plugins should handle all 3 revocations incrementally');

    // Verify only keep-1 remains in both FTS5 and Vector indexes (SQLite + slab).
    const ftsHits = await kit.registry.search('note-fts', {
      query: 'alpha',
      principal: alice,
      limit: 10,
    });
    assert.equal(ftsHits.ok, true);
    assert.deepEqual(ftsHits.result.hits.map((h) => h.id), ['keep-1']);

    const vecHits = await kit.registry.search('note-vec', {
      query: { model: 'embed-v1', vector: [1, 0] },
      principal: alice,
      limit: 10,
    });
    assert.equal(vecHits.ok, true);
    assert.deepEqual(vecHits.result.hits.map((h) => h.id), ['keep-1']);

    // Verify persisted SQLite vector table has only keep-1 as well.
    const persistedKeys = kit.db
      .prepare('SELECT source_key FROM vec_note_vec_g0 ORDER BY source_key')
      .all()
      .map((r) => r.source_key);
    assert.deepEqual(persistedKeys, ['keep-1']);
  });
});

describe('persistent Float32Array vector storage and restart survival', () => {
  test('persists Float32Array BLOBs + precomputed norms + scope_id and survives full DB reopen without rebuild()', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-vector-persist-'));
    const dbPath = join(root, 'vectors.db');
    try {
      // Boot 1: index rows into persistent SQLite BLOB storage.
      const boot1 = await setupSearchSuite({ dbPath, dimensions: 4, withFts: false });
      boot1.insert('a1', 'proj-a', 't1', 'b1', [1, 0, 0, 0]);
      boot1.insert('a2', 'proj-a', 't2', 'b2', [0.6, 0.8, 0, 0]);
      boot1.insert('b1', 'proj-b', 't3', 'b3', [1, 0, 0, 0]);
      const rebuilt = await boot1.registry.rebuild('note-vec');
      assert.equal(rebuilt.ok, true, rebuilt.lastError?.message);
      assert.equal(rebuilt.counts.vectors, 3);

      // Verify raw SQLite storage format: Float32 BLOB (16 bytes for 4 dims) + REAL norm + scope_id.
      const storedRows = boot1.db
        .prepare('SELECT source_key, scope_id, norm, embedding FROM vec_note_vec_g0 ORDER BY source_key')
        .all();
      assert.equal(storedRows.length, 3);
      for (const row of storedRows) {
        assert.ok(row.embedding instanceof Uint8Array, 'embedding must be stored as a SQLite BLOB');
        assert.equal(row.embedding.byteLength, 4 * 4, 'Float32Array(4) must occupy exactly 16 bytes');
        assert.equal(typeof row.norm, 'number');
        assert.ok(Math.abs(row.norm - 1) < 1e-5, `expected unit L2 norm, got ${row.norm}`);
      }
      assert.deepEqual(
        storedRows.map((r) => [r.source_key, r.scope_id]),
        [['a1', 'proj-a'], ['a2', 'proj-a'], ['b1', 'proj-b']],
      );
      await boot1.close();

      // Boot 2: brand new DB handle, registry, and VectorPlugin — NO rebuild() called!
      const boot2 = await setupSearchSuite({ dbPath, dimensions: 4, withFts: false });
      try {
        const validated = await boot2.registry.validate('note-vec');
        assert.equal(validated.ok, true, validated.lastError?.message);
        assert.equal(boot2.registry.healthOf('note-vec').plugin.vectors, 3);

        // Query immediately after restart using only hydrated Float32Array BLOBs.
        const scoped = await boot2.registry.search('note-vec', {
          query: { model: 'embed-v1', vector: [0.95, 0.3, 0, 0] },
          scope: { projectId: 'proj-a' },
          principal: alice,
          limit: 2,
        });
        assert.equal(scoped.ok, true, scoped.lastError?.message);
        assert.deepEqual(scoped.result.hits.map((h) => h.id), ['a1', 'a2']);
        assert.ok(scoped.result.hits[0].score > scoped.result.hits[1].score);
      } finally {
        await boot2.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('scoped hybrid RRF retrieval composer', () => {
  test('hybridSearch fuses scoped FTS5 + Vector hits via RRF with truthful staleness and deterministic ties', async (t) => {
    const kit = await setupSearchSuite({ dimensions: 3 });
    t.after(() => kit.close());

    // Foreign project rows that would dominate unscoped search in both FTS5 and Vector.
    for (let i = 0; i < 40; i += 1) {
      kit.insert(
        `other-${String(i).padStart(2, '0')}`,
        'proj-other',
        'coastal clinic triage coastal clinic',
        'coastal clinic triage',
        [1, 0, 0],
      );
    }

    // Target project rows:
    // - doc-both matches both lexical ("coastal") and vector ([0.95, 0.31, 0]) -> ranks #1 in RRF.
    // - doc-fts-only matches lexical strongly ("coastal coastal coastal") but is opposite in vector ([-1, 0, 0]).
    // - doc-vec-only matches vector perfectly ([1, 0, 0]) but has no lexical match ("harbor scheduling").
    // - Additional filler docs in proj-a push doc-fts-only outside the vector top-K window.
    for (let i = 0; i < 8; i += 1) {
      kit.insert(`doc-filler-${i}`, 'proj-a', `meeting notes ${i}`, 'general discussion', [0.5, 0.86, 0]);
    }
    kit.insert('doc-both', 'proj-a', 'coastal clinic', 'patient intake notes', [0.95, 0.31, 0]);
    kit.insert('doc-fts-only', 'proj-a', 'coastal coastal coastal', 'coastal coastal notes', [-1, 0, 0]);
    kit.insert('doc-vec-only', 'proj-a', 'harbor scheduling', 'shift roster', [1, 0, 0]);

    assert.equal((await kit.registry.rebuild('note-fts')).ok, true);
    assert.equal((await kit.registry.rebuild('note-vec')).ok, true);

    const hybrid = await hybridSearch({
      registry: kit.registry,
      principal: alice,
      scope: { projectId: 'proj-a' },
      fts: { pluginId: 'note-fts', query: 'coastal', weight: 1 },
      vector: { pluginId: 'note-vec', query: { model: 'embed-v1', vector: [1, 0, 0] }, weight: 1 },
      k: HYBRID_SEARCH_DEFAULT_RRF_K,
      limit: 3,
    });

    assert.equal(hybrid.ok, true);
    assert.equal(hybrid.cancelled, false);
    assert.equal(hybrid.timedOut, false);
    assert.equal(hybrid.staleness, 'fresh');
    assert.equal(hybrid.hits.length, 3);
    // All hits strictly from proj-a (no cross-project leakage or starvation).
    assert.ok(hybrid.hits.every((h) => h.key.startsWith('doc-')));
    // doc-both appears in both branches, so its combined RRF score strictly beats single-branch hits.
    assert.equal(hybrid.hits[0].key, 'doc-both');
    assert.ok(hybrid.hits[0].sources['note-fts']);
    assert.ok(hybrid.hits[0].sources['note-vec']);
    assert.equal(hybrid.hits[0].excerptField, 'title');
    assert.match(hybrid.hits[0].excerpt, /coastal/);

    // Invalidating one branch flips combined staleness truthfully from 'fresh' to 'stale'.
    kit.registry.notifyChange('note-fts', { entity: 'Note', rowId: 'doc-both', kind: 'updated' });
    const staleHybrid = await hybridSearch({
      registry: kit.registry,
      principal: alice,
      scopeId: 'proj-a',
      fts: { pluginId: 'note-fts', query: 'coastal' },
      vector: { pluginId: 'note-vec', query: { model: 'embed-v1', vector: [1, 0, 0] } },
      limit: 3,
    });
    assert.equal(staleHybrid.ok, true);
    assert.equal(staleHybrid.staleness, 'stale');

    // Direct composeHybridSearch deterministic tie-breaking on equal RRF scores.
    const tied = composeHybridSearch(
      [
        { pluginId: 'fts', hits: [{ id: 'z-doc' }], weight: 1 },
        { pluginId: 'vec', hits: [{ id: 'a-doc' }], weight: 1 },
      ],
      { k: 60 },
    );
    assert.deepEqual(tied.hits.map((h) => h.key), ['a-doc', 'z-doc']);
  });
});

describe('generation fencing for overlapping same-identity writes (#243)', () => {
  test('an older in-flight rebuild cannot overwrite a newer reconcile generation', async (t) => {
    const kit = await setupSearchSuite({ withVector: false });
    t.after(() => kit.close());

    // Populate >128 rows so rebuild() spans multiple write batches.
    for (let i = 0; i < 200; i += 1) {
      kit.insert(`r-${String(i).padStart(3, '0')}`, 'proj-a', `original token ${i}`, 'body');
    }

    const baseCap = createSearchOwnedIndexCapability({
      db: kit.db,
      census: kit.census,
      writeCoordinator: kit.queue,
      fenceOf: (id) => kit.registry.stateOf(id).fence,
    });

    let pauseFirstBatch = true;
    let releaseFirstBatch;
    const firstBatchPaused = new Promise((resolve) => {
      releaseFirstBatch = resolve;
    });
    let firstBatchStarted;
    const startedPromise = new Promise((resolve) => {
      firstBatchStarted = resolve;
    });

    kit.registry.bindIndex((pluginId) => {
      const inner = baseCap(pluginId);
      return Object.freeze({
        ...inner,
        async write(req) {
          if (pauseFirstBatch && req.statements.length === 128) {
            pauseFirstBatch = false;
            firstBatchStarted();
            await firstBatchPaused;
          }
          return inner.write(req);
        },
      });
    });

    // Start generation 1 (rebuild) — pauses before its first batch executes.
    const rebuildPromise = kit.registry.rebuild('note-fts');
    await startedPromise;

    // While generation 1 is suspended, mutate r-000 and run generation 2 (reconcile).
    kit.db.prepare('UPDATE Note SET title = ? WHERE id = ?').run('updated newer generation', 'r-000');
    const rec = await kit.registry.reconcile('note-fts', [{ entity: 'Note', rowId: 'r-000', kind: 'updated' }]);
    assert.equal(rec.ok, true, rec.lastError?.message);
    assert.equal(rec.generation > 1, true);

    // Release generation 1 — it must observe supersession and must NOT overwrite r-000 or state.
    releaseFirstBatch();
    const olderOutcome = await rebuildPromise;
    assert.equal(olderOutcome.ok, true);
    assert.equal(kit.registry.stateOf('note-fts').generation, rec.generation);

    // Newer generation's text for r-000 remains intact in the FTS5 table.
    const found = await kit.registry.search('note-fts', {
      query: 'updated',
      scopeId: 'proj-a',
      principal: alice,
      limit: 5,
    });
    assert.equal(found.ok, true);
    assert.deepEqual(found.result.hits.map((h) => h.id), ['r-000']);
  });
});

// ---- bounded, disk-backed vector search (#288) ------------------------------

// Wrap a plugin's owned-index capability to record every embedding-bearing
// SELECT. Used to prove the persistent path never issues an unbounded vector
// scan (each page carries an explicit LIMIT) and pushes the scope filter into
// SQL before fetching vectors.
function instrumentVectorIndex(kit) {
  const baseCap = createSearchOwnedIndexCapability({
    db: kit.db,
    census: kit.census,
    writeCoordinator: kit.queue,
    fenceOf: (id) => kit.registry.stateOf(id).fence,
  });
  const queries = [];
  kit.registry.bindIndex((pluginId) => {
    const inner = baseCap(pluginId);
    return Object.freeze({
      ...inner,
      query(stmt) {
        queries.push({ sql: stmt.sql, params: stmt.params ?? [] });
        return inner.query(stmt);
      },
    });
  });
  return queries;
}

function embeddingQueries(queries) {
  return queries.filter((q) => /\bembedding\b/.test(q.sql));
}

describe('disk-backed bounded-page vector search (#288)', () => {
  test('persistent search pages embeddings with an explicit LIMIT and never reads the whole table', async (t) => {
    const kit = await setupSearchSuite({ dimensions: 2 });
    t.after(() => kit.close());

    kit.db.exec('BEGIN');
    for (let i = 0; i < 40; i += 1) {
      kit.insert(`p-${String(i).padStart(3, '0')}`, 'proj-a', `note ${i}`, 'body', [1, i / 100]);
    }
    kit.db.exec('COMMIT');
    assert.equal((await kit.registry.rebuild('note-vec')).ok, true);

    const queries = instrumentVectorIndex(kit);
    const found = await kit.registry.search('note-vec', {
      query: { model: 'embed-v1', vector: [1, 0] },
      principal: alice,
      limit: 5,
    });
    assert.equal(found.ok, true, found.lastError?.message);
    assert.equal(found.result.hits.length, 5);

    const embedding = embeddingQueries(queries);
    assert.ok(embedding.length > 0, 'persistent search must read embeddings from SQLite');
    for (const q of embedding) {
      assert.match(q.sql, /LIMIT \d+/, `embedding SELECT must carry a bounded LIMIT: ${q.sql}`);
      assert.doesNotMatch(q.sql, /LIMIT\s+\d{4,}/, `embedding page must stay bounded, got: ${q.sql}`);
    }
    // 40 rows fit in one 512-row page, so a second page must not be fetched.
    assert.equal(embedding.length, 1);
  });

  test('scope filter is applied in SQL before any vector is fetched', async (t) => {
    const kit = await setupSearchSuite({ dimensions: 2 });
    t.after(() => kit.close());

    kit.db.exec('BEGIN');
    for (let i = 0; i < 20; i += 1) {
      kit.insert(`noise-${String(i).padStart(2, '0')}`, 'project-noisy', 'x', 'x', [1, 0]);
    }
    kit.insert('target-1', 'project-target', 'x', 'x', [0.8, 0.6]);
    kit.insert('target-2', 'project-target', 'x', 'x', [0.6, 0.8]);
    kit.db.exec('COMMIT');
    assert.equal((await kit.registry.rebuild('note-vec')).ok, true);

    const queries = instrumentVectorIndex(kit);
    const scoped = await kit.registry.search('note-vec', {
      query: { model: 'embed-v1', vector: [1, 0] },
      scopeId: 'project-target',
      principal: alice,
      limit: 5,
    });
    assert.equal(scoped.ok, true, scoped.lastError?.message);
    assert.deepEqual(scoped.result.hits.map((h) => h.id), ['target-1', 'target-2']);

    const embedding = embeddingQueries(queries);
    assert.ok(embedding.length > 0);
    for (const q of embedding) {
      assert.match(q.sql, /scope_id = \?/, 'scope must be filtered in SQL before vectors are fetched');
      assert.deepEqual(q.params[0], 'project-target');
    }
  });

  test('arbitrary-predicate scope stays isolated without a resident slab', async (t) => {
    const kit = await setupSearchSuite({ dimensions: 2 });
    t.after(() => kit.close());

    kit.db.exec('BEGIN');
    for (let i = 0; i < 30; i += 1) {
      kit.insert(`foreign-${String(i).padStart(2, '0')}`, 'project-foreign', 't', 'b', [1, 0]);
    }
    kit.insert('own-1', 'project-own', 't', 'b', [0.1, 0.995]);
    kit.insert('own-2', 'project-own', 't', 'b', [0, 1]);
    kit.db.exec('COMMIT');
    assert.equal((await kit.registry.rebuild('note-vec')).ok, true);

    // The scope key is a real source column that is NOT the declared scopeField,
    // so this exercises the page-driven predicate fallback rather than the
    // scope_id equality filter.
    const scoped = await kit.registry.search('note-vec', {
      query: { model: 'embed-v1', vector: [1, 0] },
      scope: { title: 't', projectId: 'project-own' },
      principal: alice,
      limit: 5,
    });
    assert.equal(scoped.ok, true, scoped.lastError?.message);
    // `own-1` outranks every foreign row only inside its partition; a whole-index
    // ranking would have filled the window with `foreign-*` rows.
    assert.deepEqual(scoped.result.hits.map((h) => h.id), ['own-1', 'own-2']);
  });

  test('restart serves bounded pages from BLOBs without rebuild or slab hydration', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'wb-vector-bounded-'));
    const dbPath = join(root, 'vectors.db');
    try {
      const boot1 = await setupSearchSuite({ dbPath, dimensions: 3, withFts: false });
      boot1.insert('a1', 'proj-a', 't', 'b', [1, 0, 0]);
      boot1.insert('a2', 'proj-a', 't', 'b', [0.9, 0.1, 0]);
      boot1.insert('b1', 'proj-b', 't', 'b', [1, 0, 0]);
      assert.equal((await boot1.registry.rebuild('note-vec')).ok, true);
      await boot1.close();

      // Fresh handle, registry, and plugin: only the durable BLOB table exists.
      const boot2 = await setupSearchSuite({ dbPath, dimensions: 3, withFts: false });
      try {
        await boot2.registry.prepare('note-vec');
        const queries = instrumentVectorIndex(boot2);
        const found = await boot2.registry.search('note-vec', {
          query: { model: 'embed-v1', vector: [1, 0, 0] },
          scopeId: 'proj-a',
          principal: alice,
          limit: 2,
        });
        assert.equal(found.ok, true, found.lastError?.message);
        assert.deepEqual(found.result.hits.map((h) => h.id), ['a1', 'a2']);

        const embedding = embeddingQueries(queries);
        assert.ok(embedding.length > 0, 'restart search must read persisted BLOBs');
        for (const q of embedding) assert.match(q.sql, /LIMIT \d+/);
      } finally {
        await boot2.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('shadow rebuild and incremental revocation keep the disk index authoritative', async (t) => {
    const kit = await setupSearchSuite({ dimensions: 2 });
    t.after(() => kit.close());

    kit.insert('keep', 'proj-a', 't', 'b', [1, 0]);
    kit.insert('drop-row', 'proj-a', 't', 'b', [0.99, 0.1]);
    kit.insert('drop-scope-1', 'proj-gone', 't', 'b', [0.98, 0.2]);
    kit.insert('drop-scope-2', 'proj-gone', 't', 'b', [0.97, 0.23]);
    assert.equal((await kit.registry.rebuild('note-vec')).ok, true);

    // A shadow rebuild over the same source must activate and preserve parity.
    const bridge = createSearchStalenessBridge({ registry: kit.registry });
    bridge.engage(kit.db);
    const engine = createSearchReconcileEngine({
      registry: kit.registry,
      staleness: bridge,
      db: kit.db,
      writeQueue: kit.queue,
    });
    const shadow = await engine.rebuildShadow('note-vec');
    assert.equal(shadow.ok, true, shadow.lastError ?? 'shadow rebuild failed');
    assert.equal(shadow.activated, true);
    assert.equal(engine.parity('note-vec').matches, true);

    // Shadow activation flips the durable active pointer to the other generation.
    const active = Number(kit.db.prepare('SELECT active FROM vec_note_vec_state WHERE slot = ?').get('active').active);
    const activeTable = active === 1 ? 'vec_note_vec_g1' : 'vec_note_vec_g0';

    // Scope + row revocation delete incrementally from the durable table.
    await kit.registry.revoke('note-vec', { kind: 'revocation', entity: 'Note', scopeId: 'proj-gone' });
    await kit.registry.revoke('note-vec', { kind: 'erasure', entity: 'Note', rowId: 'drop-row' });

    const persisted = kit.db
      .prepare(`SELECT source_key FROM ${activeTable} ORDER BY source_key`)
      .all()
      .map((r) => r.source_key);
    assert.deepEqual(persisted, ['keep']);

    const after = await kit.registry.search('note-vec', {
      query: { model: 'embed-v1', vector: [1, 0] },
      principal: alice,
      limit: 10,
    });
    assert.equal(after.ok, true, after.lastError?.message);
    assert.deepEqual(after.result.hits.map((h) => h.id), ['keep']);
  });
});
