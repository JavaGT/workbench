// W5 lane: FTS5 query safety, bounded search windows, shadow-first vector
// rebuild, NaN/length-safe scoring, and observable bounded query invalidation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  createFts5Plugin,
  sanitizeFts5Query,
  Fts5QueryValidationError,
} from '../build/fts5-plugin.mjs';
import {
  createSearchPluginRegistry,
  SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
} from '../build/search-plugin.mjs';
import { createSearchOwnedIndexCapability } from '../build/index-capability.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import {
  searchPageWindow,
  SearchWindowValidationError,
  SEARCH_MAX_WINDOW,
  MAX_SEARCH_WINDOW,
} from '../build/search-response.mjs';
import { createVectorPlugin } from '../build/vector-plugin.mjs';
import { cosineSimilarity, cosineSimilarityFloat32 } from '../build/vector.mjs';
import { text, number, ref, grant, read, subscribe, scope } from '../build/index.mjs';
import { entity, generateDDL, generateFrameworkDDL } from '../build/internal.mjs';
import { principal } from '../build/principal.mjs';
import {
  compileQueryContract,
  executeQueryPage,
  createQueryInvalidationHub,
  createQueryInvalidationConsumer,
  readCommittedRevision,
  QUERY_REGISTRATION_TTL_MS,
} from '../build/query-scoped-read.mjs';
import { createLog, withLog } from '../build/log.mjs';

const alice = principal({ type: 'user', id: 'alice' });
const ALLOW = { admit: async () => ({ admitted: true, reasonCode: null }), registerResource() {} };

function censusOf(plugin) {
  const census = new Map();
  for (const object of plugin.ownedObjects) {
    census.set(`${object.kind}:${object.name}`.toLowerCase(), {
      kind: 'plugin', owner: plugin.id, objectKind: object.kind, name: object.name,
    });
  }
  return census;
}

// ---- FTS5 query safety -------------------------------------------------------

test('sanitizeFts5Query quotes terms but preserves operators, phrases and prefixes', () => {
  assert.equal(sanitizeFts5Query('hello world'), '"hello" "world"');
  assert.equal(sanitizeFts5Query('needle*'), '"needle"*');
  assert.equal(sanitizeFts5Query('foo OR bar'), '"foo" OR "bar"');
  assert.equal(sanitizeFts5Query('"phrase here"'), '"phrase here"');
  assert.equal(sanitizeFts5Query('"phrase here"*'), '"phrase here"*');
  assert.equal(sanitizeFts5Query('title:needle'), '"title:needle"');
  assert.equal(sanitizeFts5Query('foo-bar'), '"foo-bar"');
  assert.equal(sanitizeFts5Query('a-b:c'), '"a-b:c"');
});

test('sanitizeFts5Query rejects malformed operator/quote/wildcard grammar', () => {
  assert.throws(
    () => sanitizeFts5Query('hello AND'),
    (error) => error instanceof Fts5QueryValidationError && /dangling operator/.test(error.message),
  );
  assert.throws(() => sanitizeFts5Query('AND hello'), /dangling operator/);
  assert.throws(() => sanitizeFts5Query('foo OR OR bar'), /adjacent operators/);
  assert.throws(() => sanitizeFts5Query('"unbalanced'), /unterminated quoted phrase/);
  assert.throws(() => sanitizeFts5Query('*'), /stray wildcard/);
  assert.throws(() => sanitizeFts5Query('   '), /non-empty string/);
  assert.throws(() => sanitizeFts5Query('x'.repeat(5000)), /characters/);
});

async function ftsKit(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, body TEXT);');
  const registry = createSearchPluginRegistry();
  const plugin = createFts5Plugin({
    id: 'note-fts',
    version: '1.0.0',
    tokenizer: 'porter',
    source: { entity: 'Note', fields: ['title', 'body'] },
    admission: { entity: {}, adapter: ALLOW },
  });
  registry.register(plugin);
  registry.bindSource(db);
  for (const entry of registry.census().entries) db.exec(entry.sql);
  const queue = createWriteQueue();
  registry.bindIndex(createSearchOwnedIndexCapability({
    db,
    census: censusOf(plugin),
    writeCoordinator: queue,
    fenceOf: (id) => registry.stateOf(id).fence,
  }));
  await registry.prepare('note-fts');
  t.after(async () => {
    await queue.close();
    db.close();
  });
  const insert = db.prepare('INSERT INTO Note (id, title, body) VALUES (?, ?, ?)');
  return { db, registry, insert };
}

test('FTS5 search never leaks a SQLite syntax error for punctuation or stray operators', async (t) => {
  const kit = await ftsKit(t);
  kit.insert.run('a', 'needle in haystack', 'body');
  kit.insert.run('b', 'title:with-hyphen "quoted"', 'body needle');
  const rebuilt = await kit.registry.rebuild('note-fts');
  assert.equal(rebuilt.ok, true, rebuilt.lastError?.message);

  for (const query of ['needle', 'needle*', 'title:with-hyphen', '"quoted phrase"', 'alpha OR needle', '"needle" AND "body"']) {
    const outcome = await kit.registry.search('note-fts', { query, principal: alice });
    assert.equal(outcome.ok, true, `${query}: ${outcome.lastError?.message}`);
  }
  for (const query of ['needle AND', 'OR needle', '"unclosed', 'needle**']) {
    const outcome = await kit.registry.search('note-fts', { query, principal: alice });
    assert.equal(outcome.ok, false, query);
    assert.match(outcome.lastError.message, /FTS5 query/);
    assert.doesNotMatch(outcome.lastError.message, /fts5: syntax error/, 'sanitizer rejects before SQLite parses');
  }
});

// ---- Bounded search windows --------------------------------------------------

test('searchPageWindow rejects windows past the server-side bound', () => {
  assert.equal(MAX_SEARCH_WINDOW, SEARCH_MAX_WINDOW);
  assert.deepEqual(searchPageWindow({ limit: 10, offset: SEARCH_MAX_WINDOW - 10 }), {
    offset: SEARCH_MAX_WINDOW - 10, limit: 10,
  });
  assert.throws(
    () => searchPageWindow({ limit: 10, offset: SEARCH_MAX_WINDOW - 9 }),
    SearchWindowValidationError,
    /exceeds the 10000 result bound/,
  );
  assert.throws(() => searchPageWindow({ page: 500, pageSize: 100 }), /exceeds the 10000 result bound/);
});

test('registry rejects an over-wide window before invoking the plugin', async () => {
  let calls = 0;
  const registry = createSearchPluginRegistry();
  registry.register({
    contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
    id: 'windowed',
    version: '1.0.0',
    ownedObjects: [],
    sourceInterests: [],
    stalenessKey: () => null,
    prepare() {},
    validate() {},
    reconcile() {},
    rebuild() {},
    search() { calls += 1; return { hits: [] }; },
  });
  const before = registry.stateOf('windowed');
  const outcome = await registry.search('windowed', { query: 'x', principal: alice, offset: 20_000, limit: 50 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.result, null);
  assert.match(outcome.lastError.message, /exceeds the 10000 result bound/);
  assert.equal(calls, 0, 'no plugin work for a rejected window');
  const after = registry.stateOf('windowed');
  assert.equal(after.fence, before.fence, 'a validation rejection does not invalidate the index');
  assert.equal(after.state, before.state);
});

// ---- NaN and length safety ---------------------------------------------------

test('cosine scoring treats length mismatches and NaNs as non-matches', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, NaN], [1, 0]), 0);
  assert.equal(cosineSimilarityFloat32(new Float32Array([1, 0]), 1, new Float32Array([1, 0, 0]), 1), 0);
  assert.equal(cosineSimilarityFloat32(new Float32Array([1, 0]), 1, new Float32Array([1, 0]), 1, 2), 0);
});

async function vectorKit(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, embedding TEXT, embedding_model TEXT);');
  const registry = createSearchPluginRegistry();
  const plugin = createVectorPlugin({
    id: 'note-vec',
    version: '1.0.0',
    source: {
      entity: 'Note', vector: 'embedding', model: 'embedding_model', owns: () => true,
    },
    modelSpace: { model: 'embed-v1', dimensions: 2 },
    admission: { entity: {}, adapter: ALLOW },
  });
  registry.register(plugin);
  registry.bindSource(db);
  for (const entry of registry.census().entries) db.exec(entry.sql);
  const queue = createWriteQueue();
  registry.bindIndex(createSearchOwnedIndexCapability({
    db,
    census: censusOf(plugin),
    writeCoordinator: queue,
    fenceOf: (id) => registry.stateOf(id).fence,
  }));
  await registry.prepare('note-vec');
  t.after(async () => {
    await queue.close();
    db.close();
  });
  const insert = db.prepare('INSERT INTO Note (id, embedding, embedding_model) VALUES (?, ?, ?)');
  return {
    db, registry, plugin,
    insert: (id, embedding) => insert.run(id, JSON.stringify(embedding), 'embed-v1'),
    state: () => db.prepare('SELECT active, model, dimensions FROM vec_note_vec_state').get(),
    count: (generation) => db.prepare(`SELECT count(*) AS count FROM vec_note_vec_g${generation}`).get().count,
  };
}

test('a failed vector rebuild leaves the active generation searchable', async (t) => {
  const kit = await vectorKit(t);
  kit.insert('n1', [1, 0]);
  kit.insert('n2', [0, 1]);
  const first = await kit.registry.rebuild('note-vec');
  assert.equal(first.ok, true, first.lastError?.message);
  const activeBefore = kit.state().active;
  const shadowBefore = activeBefore === 0 ? 1 : 0;

  kit.db.prepare('UPDATE Note SET embedding = ? WHERE id = ?').run('[1]', 'n2');
  const failed = await kit.registry.rebuild('note-vec');
  assert.equal(failed.ok, false);
  assert.match(failed.lastError.message, /requires 2/);
  assert.equal(kit.state().active, activeBefore, 'active pointer is untouched');
  assert.equal(kit.count(activeBefore), 2, 'active table keeps the last good rows');
  assert.equal(kit.count(shadowBefore), 0, 'only the shadow was cleaned');
  const stillSearchable = await kit.registry.search('note-vec', {
    principal: alice, query: { model: 'embed-v1', vector: [1, 0] },
  });
  assert.deepEqual(stillSearchable.result.hits.map((hit) => hit.id).sort(), ['n1', 'n2']);

  kit.db.prepare('UPDATE Note SET embedding = ? WHERE id = ?').run('[0,1]', 'n2');
  const second = await kit.registry.rebuild('note-vec');
  assert.equal(second.ok, true, second.lastError?.message);
  assert.equal(kit.state().active, shadowBefore, 'a successful scan flips the pointer atomically');
});

test('corrupt BLOBs are skipped in search and refused by validation', async (t) => {
  const kit = await vectorKit(t);
  kit.insert('good', [1, 0]);
  kit.insert('bad', [0, 1]);
  assert.equal((await kit.registry.rebuild('note-vec')).ok, true);

  const active = kit.state().active;
  const nanBytes = new Uint8Array(8).fill(0xff);
  kit.db.prepare(`UPDATE vec_note_vec_g${active} SET embedding = ? WHERE source_key = ?`).run(nanBytes, 'bad');

  const found = await kit.registry.search('note-vec', {
    principal: alice, query: { model: 'embed-v1', vector: [1, 0] },
  });
  assert.equal(found.ok, true);
  assert.deepEqual(found.result.hits.map((hit) => hit.id), ['good'], 'no NaN-scored tie at the top');
  assert.ok(found.result.hits.every((hit) => Number.isFinite(hit.score ?? hit.rank ?? 1)));
  const validated = await kit.registry.validate('note-vec');
  assert.equal(validated.ok, false);
  assert.match(validated.lastError.message, /non-finite/);
});

// ---- Query invalidation ------------------------------------------------------

function noteKit() {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  const Note = entity('Note', {
    body: text(),
    rank: number(),
    projectId: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read, subscribe))],
  });
  for (const sql of generateDDL(Note)) db.exec(sql);
  const insert = db.prepare('INSERT INTO Note (id, body, rank, projectId, owner) VALUES (?, ?, ?, ?, ?)');
  insert.run('n1', 'a', 1, 'p1', 'alice');
  insert.run('n2', 'b', 2, 'p1', 'alice');
  insert.run('n3', 'c', 3, 'p1', 'alice');
  return { db, Note };
}

function register(hub, db, Note, id, revision) {
  hub.register({
    id,
    dependency: { entity: 'Note', fields: ['body'], scope: 'Project:p1' },
    principal: alice,
    entity: Note,
    db,
    revision: revision ?? readCommittedRevision(db),
  });
}

test('an offset of zero is not a spurious conflict with a keyset cursor', () => {
  const { db, Note } = noteKit();
  try {
    const compiled = compileQueryContract({ entity: 'Note', sort: { field: 'rank', direction: 'asc' }, pageSize: 2 }, Note);
    const first = executeQueryPage(db, Note, alice, compiled, {});
    assert.ok(first.nextCursor);
    const advanced = executeQueryPage(db, Note, alice, compiled, { cursor: first.nextCursor, offset: 0 });
    assert.equal(advanced.rows.length, 1, 'offset 0 is ignored, not treated as a conflicting page');
    assert.throws(
      () => executeQueryPage(db, Note, alice, compiled, { cursor: first.nextCursor, offset: 2 }),
      /cursor and offset cannot be combined/,
    );
  } finally {
    db.close();
  }
});

test('invalidation registrations are bounded by capacity and idle TTL', () => {
  const { db, Note } = noteKit();
  try {
    let clock = 1_000;
    const revision = readCommittedRevision(db);
    const hub = createQueryInvalidationHub({ maxRegistrations: 2, ttlMs: 100, now: () => clock });
    assert.ok(QUERY_REGISTRATION_TTL_MS > 0);
    register(hub, db, Note, 'old', revision);

    clock += 50;
    register(hub, db, Note, 'new', revision);
    assert.equal(hub.size, 2);

    clock += 60;
    assert.equal(hub.size, 1, 'an idle registration expires on observation');
    assert.equal(hub.changedSince({ id: 'old', principal: alice, sinceRevision: revision, revision }).kind, 'resync');

    register(hub, db, Note, 'fresh', revision);
    assert.equal(hub.size, 2, 'expired and LRU entries never leak past the cap');
    register(hub, db, Note, 'overflow', revision);
    assert.equal(hub.size, 2);
    assert.equal(hub.changedSince({ id: 'new', principal: alice, sinceRevision: revision, revision }).kind, 'resync');
  } finally {
    db.close();
  }
});

test('invalidation failures are logged and reported to an onError hook', async () => {
  const lines = [];
  const log = createLog({
    level: 'warn',
    format: 'json',
    output: (level, channel, message) => lines.push(`${level} ${channel} ${message}`),
  });
  const db = { prepare: () => ({ get: () => ({ revision: 3 }), all: () => [] }) };
  const events = Object.freeze([{ type: 'Note.updated' }]);
  const seen = [];
  const consumer = createQueryInvalidationConsumer(
    { notice() { throw new Error('notice exploded'); } },
    db,
    { onError: (error, failedEvents) => seen.push({ message: error.message, events: failedEvents }) },
  );
  await withLog(log, () => consumer(events));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].message, 'notice exploded');
  assert.equal(seen[0].events, events);
  assert.ok(lines.some((line) => line.includes('query invalidation notice failed')));
});
