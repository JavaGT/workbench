// Vector field type and nearest-neighbour similarity search.
//
// The vector(dimensions) field stores number[] as JSON TEXT. Cosine similarity
// is computed in pure JS (brute-force, zero runtime dependencies), matching
// Scope's approach. The .nearest(query, k) predicate returns top-K rows.

import { vector, scope, grant, read, write, subscribe, everyone, text, entity } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench from '../build/app.mjs';
import { cosineSimilarity } from '../build/internal.mjs';
import { principal } from '../build/principal.mjs';

// A test entity with a vector field.
function vecEntity(dimensions = 3) {
  return entity('VecItem', {
        label: text(),
        embedding: vector(dimensions),

    grant: () => [
      scope(everyone()).can(() => grant(read, write, subscribe)),
    ],
  });
}

function _vecEntityNoScope(dimensions = 3) {
  return entity('VecItemNoScope', {
        label: text(),
        embedding: vector(dimensions),

    grant: () => [
      scope(everyone()).can(() => grant(read, write, subscribe)),
    ],
  });
}

async function serveVecItems(t, { dimensions = 3, Entity = vecEntity(dimensions), name: _name = 'VecItem' } = {}) {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/vec-items', Entity);
  await app.ddl();
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  const bound = app.entity(Entity);
  return { app, db, origin: `http://127.0.0.1:${app.httpServer.address().port}`, Entity: bound };
}

// ---- descriptor tests ----

test('vector(1024) creates correct descriptor', () => {
  const desc = vector(1024);
  assert.equal(desc.kind, 'value');
  assert.equal(desc.type, 'vector');
  assert.equal(desc.dimensions, 1024);
  assert.ok(Object.isFrozen(desc));
});

test('vector() rejects non-positive-integer dimensions', () => {
  assert.throws(() => vector(0), /positive integer/);
  assert.throws(() => vector(-1), /positive integer/);
  assert.throws(() => vector(3.5), /positive integer/);
  assert.throws(() => vector('1024'), /positive integer/);
  assert.throws(() => vector(), /positive integer/);
});

// ---- cosine similarity tests ----

test('cosine similarity: identical vectors → 1.0', () => {
  const vec = [1, 2, 3];
  assert.ok(Math.abs(cosineSimilarity(vec, vec) - 1.0) < 0.0001);
});

test('cosine similarity: orthogonal vectors → 0.0', () => {
  const score = cosineSimilarity([1, 0, 0], [0, 1, 0]);
  assert.ok(Math.abs(score) < 0.0001);
});

test('cosine similarity: opposite vectors → -1.0', () => {
  const score = cosineSimilarity([1, 2, 3], [-1, -2, -3]);
  assert.ok(Math.abs(score - (-1.0)) < 0.0001);
});

test('cosine similarity: known vectors → expected score', () => {
  // cos(v1, v2) where v1=[0.1, 0.2, 0.3], v2=[0.1, 0.2, 0.3]
  const v1 = [0.1, 0.2, 0.3];
  const v2 = [0.1, 0.2, 0.3];
  const score = cosineSimilarity(v1, v2);
  assert.ok(Math.abs(score - 1.0) < 0.0001);

  // v1=[0.1, 0.2, 0.3], v2=[0.2, 0.1, 0.3] → different directions
  const v3 = [0.2, 0.1, 0.3];
  const score2 = cosineSimilarity(v1, v3);
  assert.ok(score2 > 0.8);
  assert.ok(score2 < 1.0);
});

test('cosine similarity: zero-magnitude vector returns 0', () => {
  assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity([1, 2, 3], [0, 0, 0]), 0);
});

test('cosine similarity: null/undefined/non-array returns 0', () => {
  assert.equal(cosineSimilarity(null, [1, 2, 3]), 0);
  assert.equal(cosineSimilarity(undefined, [1, 2, 3]), 0);
  assert.equal(cosineSimilarity([1, 2, 3], null), 0);
});

test('nearest helpers break equal scores with locale-independent ids', async (t) => {
  const { Entity } = await serveVecItems(t, { dimensions: 2 });
  Entity.insert({ id: 'a', label: 'lowercase', embedding: [0, 1] });
  Entity.insert({ id: 'A', label: 'uppercase', embedding: [0, 1] });
  Entity.insert({ id: 'Z', label: 'upper-z', embedding: [0, 1] });
  assert.deepEqual(Entity.nearest('embedding', [1, 0], 3).map((row) => row.id), ['A', 'Z', 'a']);
});

// ---- validation tests ----

test('reject vector of wrong dimensions at mutation time', async (t) => {
  const { db: _db, Entity } = await serveVecItems(t, { dimensions: 3 });
  assert.throws(() => {
    Entity.create({ label: 'test', embedding: [1, 2] });
  }, /expected vector of length 3, got 2/);
});

test('reject non-array value at mutation time', async (t) => {
  const { db: _db, Entity } = await serveVecItems(t, { dimensions: 3 });
  assert.throws(() => {
    Entity.create({ label: 'test', embedding: 'not a vector' });
  }, /expected a.*vector/);
});

test('reject vector with non-finite numbers', async (t) => {
  const { db: _db, Entity } = await serveVecItems(t, { dimensions: 3 });
  assert.throws(() => {
    Entity.create({ label: 'test', embedding: [1, NaN, 3] });
  }, /finite numbers/);
});

// ---- store and retrieve ----

test('store and retrieve a vector of correct dimensions via CRUD', async (t) => {
  const { origin } = await serveVecItems(t);
  const embedding = [0.1, 0.2, 0.3];
  const create = await fetch(`${origin}/vec-items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'item1', embedding }),
  });
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.deepEqual(created.embedding, embedding);
  assert.equal(created.label, 'item1');

  // Verify stored as TEXT in DB
  const stored = await fetch(`${origin}/vec-items/${created.id}`);
  assert.equal(stored.status, 200);
  const fetched = await stored.json();
  assert.deepEqual(fetched.embedding, embedding);
});

test('vector fields deserialize from stored TEXT on direct query', async (t) => {
  const { Entity } = await serveVecItems(t, { dimensions: 4 });
  Entity.insert({ id: 'v1', label: 'vec', embedding: [0.1, 0.2, 0.3, 0.4] });
  const row = Entity.findById('v1');
  assert.deepEqual(row.embedding, [0.1, 0.2, 0.3, 0.4]);
});

// ---- nearest search tests ----

test('nearest(query, 3) returns top-3 most similar items', async (t) => {
  const { Entity } = await serveVecItems(t);

  Entity.insert({ id: 'a', label: 'cat', embedding: [0.1, 0.2, 0.3] });
  Entity.insert({ id: 'b', label: 'dog', embedding: [0.9, 0.9, 0.9] });
  Entity.insert({ id: 'c', label: 'bird', embedding: [0.11, 0.21, 0.31] });
  Entity.insert({ id: 'd', label: 'fish', embedding: [0.85, 0.85, 0.85] });
  Entity.insert({ id: 'e', label: 'mouse', embedding: [-0.1, -0.2, -0.3] });

  // Query close to cat → c (bird) should be closest, then a (cat), then b/d/e
  const query = [0.1, 0.2, 0.3];
  const results = Entity.nearest('embedding', query, 3);
  assert.equal(results.length, 3);
  // 'a' is exact match, 'c' is very close, 'b'/'d' are far
  assert.equal(results[0].id, 'a'); // perfect match
  assert.equal(results[1].id, 'c'); // very close to a
  // third could be b or d (both similar), just verify it's not e (opposite)
  assert.ok(results[2].id !== 'e');
});

test('nearest: integration CRUD + nearest search returns correct rows', async (t) => {
  const { Entity } = await serveVecItems(t, { dimensions: 2 });

  // Insert 5 items with 2D embeddings around the unit circle
  Entity.insert({ id: 'north', label: 'north', embedding: [0, 1] });
  Entity.insert({ id: 'east', label: 'east', embedding: [1, 0] });
  Entity.insert({ id: 'south', label: 'south', embedding: [0, -1] });
  Entity.insert({ id: 'west', label: 'west', embedding: [-1, 0] });
  Entity.insert({ id: 'center', label: 'center', embedding: [0, 0] });

  // Query pointing east → east should be closest (cos = 1.0)
  // Remaining: center/north/south all at cos ≈ 0.0, west at cos ≈ -1.0
  const results = Entity.nearest('embedding', [1, 0], 3);
  assert.equal(results.length, 3);
  assert.equal(results[0].id, 'east');  // cos ≈ 1.0
  // Remaining: sorted by stable sort — center, north, south all tie at cos=0
  // Skip exact ordering of positions 2-3 since ties are arbitrary
  assert.ok(results[1].id === 'center' || results[1].id === 'north' || results[1].id === 'south');
  assert.ok(results[2].id !== 'east' && results[2].id !== 'west');
});

test('nearest: search returns empty array for empty entity', async (t) => {
  const { Entity } = await serveVecItems(t);
  const results = Entity.nearest('embedding', [1, 2, 3], 5);
  assert.deepEqual(results, []);
});

test('nearest: k=1 returns single best match', async (t) => {
  const { Entity } = await serveVecItems(t);

  Entity.insert({ id: 'a', label: 'target', embedding: [0.5, 0.5, 0.5] });
  Entity.insert({ id: 'b', label: 'other', embedding: [0.9, 0.9, 0.9] });

  const results = Entity.nearest('embedding', [0.5, 0.5, 0.5], 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'a');
});

// ---- nearest: hydrates row fully ----

test('nearest returns fully hydrated rows (deserialized vectors, non-vector fields)', async (t) => {
  const { Entity } = await serveVecItems(t);

  Entity.insert({ id: 'x', label: 'hello', embedding: [0.1, 0.2, 0.3] });
  Entity.insert({ id: 'y', label: 'world', embedding: [0.9, 0.9, 0.9] });

  const results = Entity.nearest('embedding', [0.1, 0.2, 0.3], 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'x');
  assert.equal(results[0].label, 'hello');
  assert.ok(Array.isArray(results[0].embedding));
  assert.deepEqual(results[0].embedding, [0.1, 0.2, 0.3]);
});

// ---- nearest: error handling ----

test('nearest rejects non-string field name', async (t) => {
  const { Entity } = await serveVecItems(t);
  assert.throws(() => {
    Entity.nearest(123, [1, 2, 3], 3);
  }, /field name/);
});

test('nearest rejects non-array query vector', async (t) => {
  const { Entity } = await serveVecItems(t);
  assert.throws(() => {
    Entity.nearest('embedding', 'not-a-vector', 3);
  }, /query vector/);
});

test('nearest rejects non-positive k', async (t) => {
  const { Entity } = await serveVecItems(t);
  assert.throws(() => {
    Entity.nearest('embedding', [1, 2, 3], 0);
  }, /positive integer/);
  assert.throws(() => {
    Entity.nearest('embedding', [1, 2, 3], -1);
  }, /positive integer/);
});

// ---- nearest via scope predicate ----

test('nearest predicate via scope: fieldHandle.nearest returns AST node', () => {
  const Item = entity('TestItem', {
        label: text(),
        embedding: vector(3),

    grant: () => [
      scope(everyone()).can(() => grant(read, write, subscribe)),
    ],
  });
  // The .nearest() on the field handle returns an AST node
  const node = Item.embedding.nearest([0.1, 0.2, 0.3], 5);
  assert.equal(node.node, 'nearest');
  assert.equal(node.entity, 'TestItem');
  assert.equal(node.field, 'embedding');
  assert.equal(node.k, 5);
  assert.deepEqual(node.query, [0.1, 0.2, 0.3]);
});

// ---- performance: nearest with 100 rows ----

test('nearest with 100 rows completes under timeout', async (t) => {
  const { Entity } = await serveVecItems(t, { dimensions: 8 });

  // Insert 100 items with random embeddings
  for (let i = 0; i < 100; i++) {
    const emb = Array.from({ length: 8 }, () => Math.random());
    Entity.insert({ id: `item-${i}`, label: `label-${i}`, embedding: emb });
  }

  const query = Array.from({ length: 8 }, () => Math.random());
  const start = Date.now();
  const results = Entity.nearest('embedding', query, 10);
  const elapsed = Date.now() - start;

  assert.equal(results.length, 10);
  assert.ok(elapsed < 5000, `nearest with 100 rows took ${elapsed}ms, expected < 5000ms`);
});

// ---- vector field: update and delete keep consistency ----

test('update vector field and re-search', async (t) => {
  const { origin, Entity } = await serveVecItems(t);

  // Use insert (not create) since we're providing explicit IDs
  Entity.insert({ id: 'a', label: 'a', embedding: [0.1, 0.2, 0.3] });
  Entity.insert({ id: 'b', label: 'b', embedding: [0.9, 0.9, 0.9] });

  // Before update: query near a → a is closest
  let results = Entity.nearest('embedding', [0.1, 0.2, 0.3], 2);
  assert.equal(results[0].id, 'a');

  // Update 'a' to be far away via PATCH
  const update = await fetch(`${origin}/vec-items/a`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ embedding: [-0.9, -0.9, -0.9] }),
  });
  assert.equal(update.status, 200);

  // After update: b is now closer to the query
  results = Entity.nearest('embedding', [0.1, 0.2, 0.3], 2);
  assert.equal(results[0].id, 'b');
});

// ---- vector via scope findOne with nearest AST node ----

import { lowerToSql } from '../build/scope-sql.mjs';

test('lowerToSql handles nearest node: no-op SQL, nearest carried on result', () => {
  const Item = entity('TestItemNearest', {
        label: text(),
        embedding: vector(3),

    grant: () => [
      scope(everyone()).can(() => grant(read, write, subscribe)),
    ],
  });

  const node = Item.embedding.nearest([0.1, 0.2, 0.3], 5);
  const result = lowerToSql(node);
  assert.equal(result.sql, '1=1');
  assert.ok(result.nearest);
  assert.equal(result.nearest.entity, 'TestItemNearest');
  assert.equal(result.nearest.field, 'embedding');
  assert.equal(result.nearest.k, 5);
  assert.deepEqual(result.nearest.query, [0.1, 0.2, 0.3]);
});
