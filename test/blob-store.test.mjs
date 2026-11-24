// BlobStore module — RED-GREEN TDD.
// Isolated module for durable blob storage with pending/adopted lifecycle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { rmSync, existsSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fsBlobs } from '../build/fs-blobs.mjs';

import { generateFrameworkDDL } from '../build/ddl.mjs';
import { EMPTY_BLOB_CENSUS, compileBlobCensus } from '../build/blob-census.mjs';

// A compiled census declaring (Photo, data) as a blob reference — the refcount
// sweep's ONLY column source (S6/A3: no runtime blobColumns scan).
const photoCensus = compileBlobCensus({
  entities: new Map(),
  declaredBlobFields: [
    { actionName: 'Photo.upload', field: 'data', resourceField: 'id', owningResource: 'Photo', erasureCategory: 'deletable' },
  ],
});

async function setupBlobStore() {
  const root = path.join(tmpdir(), 'express-blob-' + randomUUID());
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  
  const { createBlobStore } = await import('../build/blob-store.mjs');
  const store = createBlobStore({ root, db });
  
  return { root, db, store };
}

test('upload streams to .pending + computes md5+sha256 one-pass', async () => {
  const { root, db: _db, store } = await setupBlobStore();
  
  const content = 'hello world';
  const bytes = Buffer.from(content);
  const expectedMd5 = '5eb63bbbe01eeed093cb22bb8f5acdc3';
  const expectedSha256 = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
  
  const result = store.upload({ bytes, mime: 'text/plain' });
  
  assert.ok(result.id, 'returns id');
  assert.equal(result.md5, expectedMd5, 'md5 matches');
  assert.equal(result.sha256, expectedSha256, 'sha256 matches');
  assert.equal(result.size, 11, 'size matches');
  assert.equal(result.mime, 'text/plain', 'mime matches');
  
  // File exists at .pending
  const pendingPath = path.join(root, result.id + '.pending');
  assert.ok(existsSync(pendingPath), '.pending file exists');
  
  // Status is pending
  const stat = store.stat(result.id);
  assert.equal(stat.status, 'pending', 'status is pending');
  
  rmSync(root, { recursive: true, force: true });
});

test('metadata failure removes only the upload-owned pending file', async () => {
  const { root, db } = await setupBlobStore();
  const bytes = fsBlobs({ root });
  const { createBlobStore } = await import('../build/blob-store.mjs');
  const store = createBlobStore({ root, db, bytes });
  db.exec("CREATE TRIGGER reject_blob_metadata BEFORE INSERT ON BlobStore BEGIN SELECT RAISE(ABORT, 'metadata blocked'); END");
  assert.throws(() => store.upload({ id: 'metadata-failure', bytes: Buffer.from('orphan') }), /metadata blocked/);
  assert.equal(bytes.exists('metadata-failure', { pending: true }), false);
  rmSync(root, { recursive: true, force: true });
});

test('the portable BlobStore surface has no pathFor — bytes are read by id, never by path (S6/A2)', async () => {
  const { db, store } = await setupBlobStore();
  const { id } = store.upload({ bytes: Buffer.from('no-path-read') });
  db.exec('BEGIN IMMEDIATE'); store.adopt(db, id); db.exec('COMMIT'); store.finalize(id);

  assert.equal(typeof store.pathFor, 'undefined', 'pathFor retired from the portable BlobStore surface');
  assert.equal(typeof store._pathFor, 'function', 'the explicit internal/test handle survives');
  assert.deepStrictEqual(store.readRange(id), Buffer.from('no-path-read'), 'readRange serves bytes by id alone');
  assert.ok(!existsSync(store._pathFor(id, { pending: true })), 'no pending slot after finalize');

  rmSync(store._pathFor(id), { force: true });
});

test('path-containment guard', async () => {
  const { store } = await setupBlobStore();
  
  const badIds = ['../evil', '/abs/path', 'a/b', 'a\x00b', '..', '', 'has space'];
  
  for (const id of badIds) {
    assert.throws(
      () => store.upload({ bytes: 'x', id }),
      /invalid blob id/,
      `rejects id: ${JSON.stringify(id)}`,
    );
  }
  
  // Valid UUID passes
  const validId = randomUUID();
  const result = store.upload({ bytes: 'x', id: validId });
  assert.ok(result.id, 'valid UUID accepted');
  
  rmSync(store._pathFor(validId, { pending: true }), { recursive: true, force: true });
});

test('range read [start,end)', async () => {
  const { db, store } = await setupBlobStore();
  
  const content = '0123456789';
  const bytes = Buffer.from(content);
  const { id } = store.upload({ bytes });
  
  db.exec('BEGIN IMMEDIATE');
  store.adopt(db, id);
  db.exec('COMMIT');
  store.finalize(id);
  
  const range2to5 = store.readRange(id, [2, 5]);
  assert.deepStrictEqual(range2to5, Buffer.from('234'), 'range [2,5)');
  
  const rangeClamped = store.readRange(id, [0, 100]);
  assert.deepStrictEqual(rangeClamped, bytes, 'range clamped to file size');
  
  rmSync(store._pathFor(id), { force: true });
});

test('adopt in caller txn — commit → adopted + renamed; rollback → pending + .pending', async () => {
  const { root: _root, db, store } = await setupBlobStore();
  
  const { id } = store.upload({ bytes: Buffer.from('test') });
  const pendingPath = store._pathFor(id, { pending: true });
  const finalPath = store._pathFor(id);
  
  // COMMIT path
  db.exec('BEGIN IMMEDIATE');
  const adoptResult = store.adopt(db, id);
  assert.equal(adoptResult.adopted, 1, 'one row adopted');
  db.exec('COMMIT');
  store.finalize(id);
  
  let stat = store.stat(id);
  assert.equal(stat.status, 'adopted', 'status adopted after commit');
  assert.ok(existsSync(finalPath), 'final file exists');
  assert.ok(!existsSync(pendingPath), '.pending file gone');
  
  rmSync(finalPath, { force: true });
  
  // ROLLBACK path
  const { id: id2 } = store.upload({ bytes: Buffer.from('test2') });
  const pendingPath2 = store._pathFor(id2, { pending: true });
  
  db.exec('BEGIN IMMEDIATE');
  store.adopt(db, id2);
  db.exec('ROLLBACK');
  
  stat = store.stat(id2);
  assert.equal(stat.status, 'pending', 'status still pending after rollback');
  assert.ok(existsSync(pendingPath2), '.pending file still exists');
  
  rmSync(pendingPath2, { force: true });
});

test('reaper orphan sweep', async () => {
  const { db, store } = await setupBlobStore();
  
  const staleDate = new Date(Date.now() - 7200_000).toISOString();
  const { id } = store.upload({ bytes: Buffer.from('stale') });
  
  // Manually set createdAt to the past
  db.prepare('UPDATE BlobStore SET createdAt = ? WHERE id = ?').run(staleDate, id);
  
  const { orphans } = await store.reap({ ttl: 3600_000, census: EMPTY_BLOB_CENSUS });
  assert.equal(orphans, 1, 'stale pending blob swept');
  
  assert.equal(store.stat(id), undefined, 'row deleted');
  
  rmSync(path.dirname(store._pathFor(id, { pending: true })), { recursive: true, force: true });
});

test('reaper refcount sweep', async () => {
  const { db, store } = await setupBlobStore();
  
  // Create Photo table for refcount test
  db.exec('CREATE TABLE IF NOT EXISTS Photo (id TEXT PRIMARY KEY, data TEXT)');
  
  const { id } = store.upload({ bytes: Buffer.from('blob') });
  db.exec('BEGIN IMMEDIATE');
  store.adopt(db, id);
  db.exec('COMMIT');
  store.finalize(id);
  
  // No reference → dangling
  let result = await store.reap({ ttl: 3600_000, census: photoCensus });
  assert.equal(result.danglers, 1, 'dangling blob swept');
  assert.equal(store.stat(id), undefined, 'dangling row deleted');
  
  rmSync(store._pathFor(id), { force: true });
  
  // Now create a referenced blob
  const { id: refId } = store.upload({ bytes: Buffer.from('refblob') });
  db.exec('BEGIN IMMEDIATE');
  store.adopt(db, refId);
  db.exec('COMMIT');
  store.finalize(refId);
  
  // Create reference
  db.prepare('INSERT INTO Photo (id, data) VALUES (?, ?)').run(randomUUID(), refId);
  
  result = await store.reap({ ttl: 3600_000, census: photoCensus });
  assert.equal(result.danglers, 0, 'referenced blob kept');
  assert.ok(store.stat(refId), 'referenced row exists');
  
  rmSync(store._pathFor(refId), { force: true });
});

test('reaper treats an empty census as no adopted blob references', async () => {
  const { root, db, store } = await setupBlobStore();
  const { id } = store.upload({ bytes: Buffer.from('unreferenced') });
  db.exec('BEGIN IMMEDIATE');
  store.adopt(db, id);
  db.exec('COMMIT');
  store.finalize(id);

  const result = await store.reap({ ttl: 3600_000, census: EMPTY_BLOB_CENSUS });

  assert.equal(result.danglers, 1, 'an empty census declares no adopted references');
  assert.equal(store.stat(id), undefined, 'the unreferenced adopted blob is reaped');
  rmSync(root, { recursive: true, force: true });
});

test('readRange closes the file descriptor (no leak)', async () => {
  // Regression: readRange opened with openSync but never closeSync'd (a comment
  // claimed "GC handles it" — sync fds are raw OS fds Node does NOT GC). A
  // leaked fd blocks reuse of its number, so the next openSync returns a HIGHER
  // fd. Detect deterministically (ulimit-independent): consecutive open/close
  // cycles return the SAME fd unless readRange leaked one in between.
  const { db, store } = await setupBlobStore();
  const { id } = store.upload({ bytes: Buffer.from('0123456789') });
  db.exec('BEGIN IMMEDIATE'); store.adopt(db, id); db.exec('COMMIT'); store.finalize(id);

  const p = store._pathFor(id);
  const fd0 = openSync(p, 'r'); closeSync(fd0);

  store.readRange(id, [0, 3]); // must open+close internally
  const fd1 = openSync(p, 'r'); closeSync(fd1);
  assert.equal(fd1, fd0, `readRange leaked an fd (fd0=${fd0} fd1=${fd1})`);

  store.readRange(id, [3, 6]);
  const fd2 = openSync(p, 'r'); closeSync(fd2);
  assert.equal(fd2, fd0, `second readRange leaked an fd (fd0=${fd0} fd2=${fd2})`);

  rmSync(p, { force: true });
});

test('readRange rejects bogus ranges (negative / non-finite / inverted)', async () => {
  const { db, store } = await setupBlobStore();
  const { id } = store.upload({ bytes: Buffer.from('0123456789') });
  db.exec('BEGIN IMMEDIATE'); store.adopt(db, id); db.exec('COMMIT'); store.finalize(id);

  // Negative start must fail cleanly (not reach readSync with a negative position).
  assert.throws(() => store.readRange(id, [-1, 5]), /invalid blob range/);
  // Inverted range must fail cleanly (not reach Buffer.alloc with a negative length).
  assert.throws(() => store.readRange(id, [5, 2]), /invalid blob range/);
  // Negative end.
  assert.throws(() => store.readRange(id, [0, -5]), /invalid blob range/);
  // Non-finite.
  assert.throws(() => store.readRange(id, [NaN, 5]), /invalid blob range/);
  assert.throws(() => store.readRange(id, [0, NaN]), /invalid blob range/);

  // Sanity: a valid empty range returns an empty buffer (no throw).
  assert.deepStrictEqual(store.readRange(id, [5, 5]), Buffer.alloc(0));

  rmSync(store._pathFor(id), { force: true });
});
