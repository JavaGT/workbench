// blobs-streaming-range.test.mjs — Issue #287 verification suite:
// 1. PendingBlobLifecycle.stage() streams + hashes OUTSIDE app.writeQueue.run(...)
//    so concurrent entity writes commit with 0 ms stall (and cleans up staged
//    bytes if metadata insert fails).
// 2. POST /blobs streams request chunks directly via writePendingStream/stagePendingStream
//    OUTSIDE app.writeCoordinator.run(...), enforcing configurable maxBytes
//    (default 50 MiB) and returning 413 cleanly on BlobTooLargeError.
// 3. BlobStore.replace() validates the previous generation without calling
//    full-file readRange() / readRangeBytes() with no range argument.
// 4. First-class authorized HTTP Range / 206 / HEAD media playback:
//    RFC 9110 parseByteRange(), serveAuthorizedBlob / handleAuthorizedBlobRequest,
//    and GET/HEAD /blobs/:entity/:id/:field with membership() / inherit(Project)
//    grants and opaque 403 existence-hiding denials.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import workbench, {
  anonymous,
  blob,
  entity,
  grant,
  inherit,
  map,
  membership,
  principal,
  read,
  ref,
  scope,
  subscribe,
  text,
  write,
} from '../build/index.mjs';
import {
  BlobTooLargeError,
  createBlobStore,
  declaredBlobField,
  handleAuthorizedBlobRequest,
  parseByteRange,
  pendingBlobStager,
  serveAuthorizedBlob,
} from '../build/server.mjs';
import { DEFAULT_BLOB_MAX_BYTES } from '../build/blob-store.mjs';
import { fsBlobs } from '../build/fs-blobs.mjs';
import { generateFrameworkDDL } from '../build/ddl.mjs';
import { createAuthorizationAdapter } from '../build/authorization-adapter.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const md5 = (bytes) => createHash('md5').update(bytes).digest('hex');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ─── 1. PendingBlobLifecycle.stage() never holds writeQueue while streaming ─

test('PendingBlobLifecycle.stage() streams outside app.writeQueue — concurrent writes commit with 0 ms stall', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'wb-stage-nonblock-'));
  const Note = entity('Note', {
    body: text(),
    grant: () => grant(read, write, subscribe),
  });
  const app = workbench({
    db,
    entities: [Note],
    blobs: { root },
    blobLifecycle: {
      fields: [declaredBlobField({
        actionName: 'File.upload',
        field: 'blob',
        resourceField: 'id',
        owningResource: 'File',
        erasureCategory: 'deletable',
      })],
      pendingTtlMs: 60_000,
      adoptedRecoveryTtlMs: 60_000,
    },
  });
  await app.start();
  t.after(async () => {
    await app.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const firstChunkLanded = deferred();
  const releaseSecondChunk = deferred();
  const chunk1 = Buffer.from('first-slow-chunk-');
  const chunk2 = Buffer.from('second-slow-chunk');
  const fullPayload = Buffer.concat([chunk1, chunk2]);

  async function* slowUpload() {
    yield chunk1;
    firstChunkLanded.resolve();
    await releaseSecondChunk.promise;
    yield chunk2;
  }

  const actor = principal({ type: 'user', id: 'u1' });
  const stagePromise = pendingBlobStager(app, actor).stage({
    scopeId: 'project:p1',
    resourceId: 'slow-1',
    bytes: slowUpload(),
    mediaType: 'video/mp4',
  });

  // Wait until streaming upload is actively mid-flight (chunk 1 yielded, chunk 2 paused).
  await firstChunkLanded.promise;

  // Concurrent entity writes must commit IMMEDIATELY while the upload is still paused!
  let concurrentCommittedBeforeUploadFinished = false;
  const writeStart = performance.now();
  await app.writeQueue.run(() => {
    db.prepare('INSERT INTO Note (id, body) VALUES (?, ?)').run('n-concurrent', 'zero-stall');
  });
  const writeElapsedMs = performance.now() - writeStart;
  concurrentCommittedBeforeUploadFinished = true;

  assert.equal(concurrentCommittedBeforeUploadFinished, true);
  assert.ok(writeElapsedMs < 50, `expected concurrent write without stall, got ${writeElapsedMs.toFixed(1)}ms`);
  assert.equal(db.prepare('SELECT body FROM Note WHERE id = ?').get('n-concurrent').body, 'zero-stall');

  // Now finish the upload and verify its durable attestation.
  releaseSecondChunk.resolve();
  const staged = await stagePromise;
  assert.equal(staged.byteLength, fullPayload.length);
  assert.equal(staged.contentDigest, sha256(fullPayload));
});

test('PendingBlobLifecycle.stage() cleans up staged temp file on disk if metadata insert fails/races', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'wb-stage-cleanup-'));
  const app = workbench({
    db,
    blobs: { root },
    blobLifecycle: {
      fields: [declaredBlobField({
        actionName: 'File.upload',
        field: 'blob',
        resourceField: 'id',
        owningResource: 'File',
        erasureCategory: 'deletable',
      })],
      pendingTtlMs: 60_000,
      adoptedRecoveryTtlMs: 60_000,
    },
  });
  await app.start();
  t.after(async () => {
    await app.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const actor = principal({ type: 'user', id: 'u1' });
  const paused = deferred();
  const resume = deferred();

  async function* slowDuplicate() {
    yield Buffer.from('loser-payload');
    paused.resolve();
    await resume.promise;
    yield Buffer.from('-tail');
  }

  // Start slow staging for (project:p1, r1)
  const loser = pendingBlobStager(app, actor).stage({
    scopeId: 'project:p1',
    resourceId: 'r1',
    bytes: slowDuplicate(),
  });
  await paused.promise;

  // A faster concurrent stage wins the same pendingKey while loser is still streaming.
  const winner = await pendingBlobStager(app, actor).stage({
    scopeId: 'project:p1',
    resourceId: 'r1',
    bytes: Buffer.from('winner-payload'),
  });
  assert.equal(winner.byteLength, 'winner-payload'.length);

  // Release loser: metadata insert must fail with PENDING_KEY_EXISTS AND clean up its staged disk file.
  resume.resolve();
  await assert.rejects(loser, /PENDING_KEY_EXISTS/);

  // Only the winner's single pending file should exist on disk and in BlobStore.
  const filesOnDisk = readdirSync(root);
  assert.equal(filesOnDisk.length, 1, `expected only winner pending file on disk, found: ${filesOnDisk.join(', ')}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM BlobStore').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _PendingBlob').get().count, 1);
});

// ─── 2. POST /blobs streams outside writeCoordinator + configurable maxBytes ─

test('POST /blobs streams outside writeCoordinator — concurrent HTTP entity write commits with 0 ms stall', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'wb-http-stream-nonblock-'));
  const Note = entity('Note', {
    body: text(),
    photo: blob(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
  const app = workbench({ db, blobs: { root } });
  app.mount('/notes', Note);
  await app.ddl();
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'u1' }) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  assert.equal(app.blobs.maxBytes, DEFAULT_BLOB_MAX_BYTES, 'default blob maxBytes is 50 MiB');
  assert.equal(DEFAULT_BLOB_MAX_BYTES, 50 * 1024 * 1024);

  const chunk1 = Buffer.from('http-chunk-one-');
  const chunk2 = Buffer.from('http-chunk-two');
  const expected = Buffer.concat([chunk1, chunk2]);

  // Open a real chunked HTTP POST /blobs request and hold it open after chunk 1.
  const uploadResponse = deferred();
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path: '/blobs',
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      uploadResponse.resolve({
        status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
    });
  });
  req.on('error', (err) => uploadResponse.reject(err));

  req.write(chunk1);
  // Give the server a tick to receive chunk 1 and begin streaming to disk.
  await new Promise((r) => setTimeout(r, 25));

  // While POST /blobs is mid-flight, perform a real HTTP entity write (acquires writeCoordinator).
  const writeStart = performance.now();
  const noteRes = await fetch(`${base}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'committed-during-upload' }),
  });
  const writeElapsedMs = performance.now() - writeStart;
  assert.equal(noteRes.status, 201, 'concurrent entity write committed while POST /blobs was streaming');
  assert.ok(writeElapsedMs < 150, `concurrent write should not stall behind upload (took ${writeElapsedMs.toFixed(1)}ms)`);

  // Finish the upload and confirm hashes + pending file landed.
  req.end(chunk2);
  const uploaded = await uploadResponse.promise;
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.size, expected.length);
  assert.equal(uploaded.body.md5, md5(expected));
  assert.equal(uploaded.body.sha256, sha256(expected));
  assert.equal(uploaded.body.mime, 'application/octet-stream');
  assert.ok(existsSync(path.join(root, `${uploaded.body.id}.pending`)));
});

test('POST /blobs honors configurable maxBytes and returns 413 cleanly on BlobTooLargeError (chunked & Content-Length)', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'wb-http-maxbytes-'));
  const app = workbench({ db, blobs: fsBlobs({ root, maxBytes: 64 }) });
  await app.ddl();
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'u1' }) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  assert.equal(app.blobs.maxBytes, 64);

  // 1. Exact limit succeeds with 201.
  const exact = await fetch(`${base}/blobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(64, 0x41),
  });
  assert.equal(exact.status, 201);

  // 2. Oversized with Content-Length -> clean 413.
  const overKnown = await fetch(`${base}/blobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(65, 0x42),
  });
  assert.equal(overKnown.status, 413);

  // 3. Oversized chunked stream (no Content-Length) -> mid-stream BlobTooLargeError -> clean 413.
  const chunkedResult = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/blobs',
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'transfer-encoding': 'chunked',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(Buffer.alloc(40, 0x43));
    req.write(Buffer.alloc(40, 0x44));
    req.end();
  });
  assert.equal(chunkedResult.status, 413, 'chunked oversized upload returns clean 413');

  // Verify no torn pending files or rows survived the 413 rejections.
  assert.equal(readdirSync(root).length, 1, 'only the single valid 64-byte upload left a pending file');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM BlobStore').get().count, 1);

  // Direct createBlobStore({ maxBytes }) also enforces BlobTooLargeError.
  const directStore = createBlobStore({ root, db, maxBytes: 16 });
  assert.equal(directStore.maxBytes, 16);
  async function* tooBig() {
    yield Buffer.alloc(10, 1);
    yield Buffer.alloc(10, 2);
  }
  await assert.rejects(
    directStore.stagePendingStream('too-big-id', tooBig()),
    BlobTooLargeError,
  );
});

// ─── 3. replace() never calls full-file readRange() without range ───────────

test('BlobStore.replace() validates previous generation without full-file readRange()', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wb-replace-no-fullread-'));
  const db = new DatabaseSync(':memory:');
  try {
    for (const sql of generateFrameworkDDL()) db.exec(sql);
    const backing = fsBlobs({ root });
    const readRangeCalls = [];
    const spyByteStore = {
      ...backing,
      readRange(id, range) {
        readRangeCalls.push({ id, range });
        if (range === undefined) {
          throw new Error('BUG: full-file readRange() called without range');
        }
        return backing.readRange(id, range);
      },
    };
    const store = createBlobStore({ db, bytes: spyByteStore });

    // Upload, adopt, and finalize a 256 KiB previous generation.
    const bigPayload = Buffer.alloc(256 * 1024, 0x5a);
    const v1 = store.upload({ bytes: bigPayload, mime: 'audio/wav', id: 'gen-big-v1' });
    db.exec('BEGIN IMMEDIATE');
    store.adopt(db, v1.id);
    db.exec('COMMIT');
    store.finalize(v1.id);

    readRangeCalls.length = 0;
    const staged = store.replace(v1.id, { bytes: Buffer.from('replacement-v2'), mime: 'audio/mp4' });
    assert.equal(staged.previousId, v1.id);
    assert.equal(staged.size, 'replacement-v2'.length);

    // Every readRange call during replace() MUST carry an explicit bounded range (<= 1 byte each).
    assert.ok(readRangeCalls.length > 0, 'bounded probe verified readability');
    for (const call of readRangeCalls) {
      assert.ok(Array.isArray(call.range), 'readRange was never called without a range tuple');
      const [start, end] = call.range;
      assert.equal(typeof start, 'number');
      assert.equal(typeof end, 'number');
      assert.ok(end - start <= 1, `expected <= 1 byte probe, got [${start}, ${end})`);
    }

    // Missing/deleted file is still refused with /unreadable/.
    rmSync(path.join(root, v1.id), { force: true });
    assert.throws(() => store.replace(v1.id, { bytes: 'v3' }), /unreadable/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 4a. RFC 9110 parseByteRange() parser ───────────────────────────────────

test('parseByteRange implements RFC 9110 bytes=start-end, bytes=start-, bytes=-suffix, and 416 cases', () => {
  assert.deepEqual(parseByteRange(undefined, 32), { kind: 'none' });
  assert.deepEqual(parseByteRange(null, 32), { kind: 'none' });
  assert.deepEqual(parseByteRange('   ', 32), { kind: 'none' });

  assert.deepEqual(parseByteRange('bytes=0-15', 32), {
    kind: 'range', start: 0, end: 15, length: 16, contentRange: 'bytes 0-15/32',
  });
  assert.deepEqual(parseByteRange('bytes=10-', 32), {
    kind: 'range', start: 10, end: 31, length: 22, contentRange: 'bytes 10-31/32',
  });
  assert.deepEqual(parseByteRange('bytes=-8', 32), {
    kind: 'range', start: 24, end: 31, length: 8, contentRange: 'bytes 24-31/32',
  });
  // Clamping end >= totalSize and suffix > totalSize
  assert.deepEqual(parseByteRange('bytes=0-999', 32), {
    kind: 'range', start: 0, end: 31, length: 32, contentRange: 'bytes 0-31/32',
  });
  assert.deepEqual(parseByteRange('bytes=-100', 32), {
    kind: 'range', start: 0, end: 31, length: 32, contentRange: 'bytes 0-31/32',
  });

  // Invalid / unsatisfiable -> 416
  for (const invalid of [
    'bytes=32-40',
    'bytes=100-',
    'bytes=15-10',
    'bytes=-0',
    'bytes=-',
    'bytes=abc-def',
    'bytes=0-5, 10-15',
    'items=0-5',
    'not-a-range',
  ]) {
    assert.deepEqual(
      parseByteRange(invalid, 32),
      { kind: 'unsatisfiable', contentRange: 'bytes */32' },
      `expected unsatisfiable for ${invalid}`,
    );
  }
  assert.deepEqual(parseByteRange('bytes=0-0', 0), {
    kind: 'unsatisfiable', contentRange: 'bytes */0',
  });
});

// ─── 4b. Authorized HTTP GET / HEAD / 200 / 206 / 416 / 403 playback ────────

test('GET and HEAD authorized media playback with membership() + inherit(Project) grants, 200/206/416, and opaque 403', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'wb-media-range-'));

  const Project = entity('Project', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['editor', 'viewer'] }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
  membership(Project, {
    editor: { can: [read, write, subscribe] },
    viewer: { can: [read, subscribe] },
  });

  const Artifact = entity('Artifact', {
    project: ref('Project', { required: true }),
    title: text(),
    media: blob(),
    grant: inherit(Project, { via: 'project' }),
  });

  const alice = principal({ type: 'user', id: 'alice' });
  const memberViewer = principal({ type: 'user', id: 'carol' });
  const stranger = principal({ type: 'user', id: 'bob' });

  const principals = new Map([
    ['alice', alice],
    ['carol', memberViewer],
    ['bob', stranger],
  ]);

  const app = workbench({ db, entities: [Project, Artifact], blobs: { root } });
  app.mount('/projects', Project);
  app.mount('/artifacts', Artifact);
  await app.ddl();
  app.listen(0, {
    principalOf: (req) => {
      const key = req.headers['x-test-user'];
      return (typeof key === 'string' && principals.get(key)) || anonymous;
    },
  });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  // Seed Project owned by alice, with carol as viewer member via membership().
  db.prepare('INSERT INTO Project (id, title, owner) VALUES (?, ?, ?)').run('p1', 'Coastal Health', alice.id);
  db.prepare('INSERT INTO Project_members (Project_id, member_id, role) VALUES (?, ?, ?)').run('p1', memberViewer.id, 'viewer');

  // Upload 32-byte media blob via streaming POST /blobs.
  const mediaBytes = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUV'); // 32 bytes
  assert.equal(mediaBytes.length, 32);
  const uploadRes = await fetch(`${base}/blobs`, {
    method: 'POST',
    headers: { 'content-type': 'audio/mp4', 'x-test-user': 'alice' },
    body: mediaBytes,
  });
  assert.equal(uploadRes.status, 201);
  const uploaded = await uploadRes.json();

  // Create Artifact referencing the blob (adopts + finalizes).
  const createRes = await fetch(`${base}/artifacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'alice' },
    body: JSON.stringify({ project: 'p1', title: 'Interview a7', media: uploaded.id }),
  });
  assert.equal(createRes.status, 201);
  const artifact = await createRes.json();
  const mediaUrl = `${base}/blobs/Artifact/${artifact.id}/media`;

  // Instrument readRangeStream to prove HEAD never streams body bytes.
  let streamOpens = 0;
  const origReadRangeStream = app.blobs.readRangeStream.bind(app.blobs);
  app.blobs.readRangeStream = (...args) => {
    streamOpens += 1;
    return origReadRangeStream(...args);
  };

  // 1. Full GET by inherited membership viewer (carol) -> 200 OK.
  const fullRes = await fetch(mediaUrl, { headers: { 'x-test-user': 'carol' } });
  assert.equal(fullRes.status, 200);
  assert.equal(fullRes.headers.get('accept-ranges'), 'bytes');
  assert.equal(fullRes.headers.get('etag'), `"${uploaded.sha256}"`);
  assert.equal(fullRes.headers.get('content-type'), 'audio/mp4');
  assert.equal(fullRes.headers.get('content-length'), '32');
  assert.equal(fullRes.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await fullRes.arrayBuffer()), mediaBytes);
  assert.equal(streamOpens, 1);

  // 2. HEAD by member -> 200 OK, headers present, 0 body bytes, readRangeStream NOT called.
  const headOpensBefore = streamOpens;
  const headRes = await fetch(mediaUrl, { method: 'HEAD', headers: { 'x-test-user': 'carol' } });
  assert.equal(headRes.status, 200);
  assert.equal(headRes.headers.get('accept-ranges'), 'bytes');
  assert.equal(headRes.headers.get('etag'), `"${uploaded.sha256}"`);
  assert.equal(headRes.headers.get('content-type'), 'audio/mp4');
  assert.equal(headRes.headers.get('content-length'), '32');
  assert.equal(headRes.headers.get('cache-control'), 'private, no-store');
  assert.equal((await headRes.arrayBuffer()).byteLength, 0);
  assert.equal(streamOpens, headOpensBefore, 'HEAD must not open a byte stream');

  // 3. Range: bytes=0-15 -> 206 Partial Content.
  const r1 = await fetch(mediaUrl, {
    headers: { 'x-test-user': 'carol', range: 'bytes=0-15' },
  });
  assert.equal(r1.status, 206);
  assert.equal(r1.headers.get('content-range'), 'bytes 0-15/32');
  assert.equal(r1.headers.get('content-length'), '16');
  assert.equal(r1.headers.get('accept-ranges'), 'bytes');
  assert.equal(r1.headers.get('etag'), `"${uploaded.sha256}"`);
  assert.deepEqual(Buffer.from(await r1.arrayBuffer()), mediaBytes.subarray(0, 16));

  // 4. Open-ended Range: bytes=10- -> 206 Partial Content.
  const r2 = await fetch(mediaUrl, {
    headers: { 'x-test-user': 'alice', range: 'bytes=10-' },
  });
  assert.equal(r2.status, 206);
  assert.equal(r2.headers.get('content-range'), 'bytes 10-31/32');
  assert.equal(r2.headers.get('content-length'), '22');
  assert.deepEqual(Buffer.from(await r2.arrayBuffer()), mediaBytes.subarray(10));

  // 5. Suffix Range: bytes=-8 -> 206 Partial Content.
  const r3 = await fetch(mediaUrl, {
    headers: { 'x-test-user': 'carol', range: 'bytes=-8' },
  });
  assert.equal(r3.status, 206);
  assert.equal(r3.headers.get('content-range'), 'bytes 24-31/32');
  assert.equal(r3.headers.get('content-length'), '8');
  assert.deepEqual(Buffer.from(await r3.arrayBuffer()), mediaBytes.subarray(24));

  // 6. HEAD with Range -> 206 Partial Content, no body, no stream open.
  const headRangeBefore = streamOpens;
  const rHeadRange = await fetch(mediaUrl, {
    method: 'HEAD',
    headers: { 'x-test-user': 'carol', range: 'bytes=0-15' },
  });
  assert.equal(rHeadRange.status, 206);
  assert.equal(rHeadRange.headers.get('content-range'), 'bytes 0-15/32');
  assert.equal(rHeadRange.headers.get('content-length'), '16');
  assert.equal(streamOpens, headRangeBefore, 'ranged HEAD must not open a byte stream');

  // 7. Unsatisfiable / invalid Range -> 416 Range Not Satisfiable + Content-Range: bytes */32.
  for (const badRange of ['bytes=100-200', 'bytes=20-10', 'bytes=-0', 'bytes=invalid']) {
    const r416 = await fetch(mediaUrl, {
      headers: { 'x-test-user': 'carol', range: badRange },
    });
    assert.equal(r416.status, 416, `expected 416 for ${badRange}`);
    assert.equal(r416.headers.get('content-range'), 'bytes */32');
    assert.equal(r416.headers.get('accept-ranges'), 'bytes');
  }

  // 8. Unauthorized non-member (bob), anonymous, missing row, and non-blob field -> opaque identical 403!
  const deniedStranger = await fetch(mediaUrl, { headers: { 'x-test-user': 'bob' } });
  const deniedStrangerBody = await deniedStranger.text();
  assert.equal(deniedStranger.status, 403);

  // Even with an unsatisfiable Range header, unauthorized caller MUST get 403 (never 416 leaking size).
  const deniedStrangerRange = await fetch(mediaUrl, {
    headers: { 'x-test-user': 'bob', range: 'bytes=999-1000' },
  });
  assert.equal(deniedStrangerRange.status, 403, 'unauthorized caller never receives 416 size oracle');
  assert.equal(deniedStrangerRange.headers.get('content-range'), null);
  assert.equal(await deniedStrangerRange.text(), deniedStrangerBody);

  const deniedStrangerHead = await fetch(mediaUrl, {
    method: 'HEAD',
    headers: { 'x-test-user': 'bob' },
  });
  assert.equal(deniedStrangerHead.status, 403);

  const deniedAnon = await fetch(mediaUrl);
  assert.equal(deniedAnon.status, 403);
  assert.equal(await deniedAnon.text(), deniedStrangerBody);

  const missingRow = await fetch(`${base}/blobs/Artifact/nonexistent-id/media`, {
    headers: { 'x-test-user': 'alice' },
  });
  assert.equal(missingRow.status, 403, 'missing row collapses to opaque 403');
  assert.equal(await missingRow.text(), deniedStrangerBody);

  const nonBlobField = await fetch(`${base}/blobs/Artifact/${artifact.id}/title`, {
    headers: { 'x-test-user': 'alice' },
  });
  assert.equal(nonBlobField.status, 403, 'non-blob field collapses to opaque 403');
  assert.equal(await nonBlobField.text(), deniedStrangerBody);

  // 9. Missing bytes on disk after authorization -> collapses to opaque 403 on BOTH GET and HEAD.
  rmSync(path.join(root, uploaded.id), { force: true });
  const missingBlobGet = await fetch(mediaUrl, { headers: { 'x-test-user': 'alice' } });
  assert.equal(missingBlobGet.status, 403);
  assert.equal(await missingBlobGet.text(), deniedStrangerBody);

  const missingBlobHead = await fetch(mediaUrl, { method: 'HEAD', headers: { 'x-test-user': 'alice' } });
  assert.equal(missingBlobHead.status, 403);
});

test('serveAuthorizedBlob / handleAuthorizedBlobRequest works directly as a reusable HTTP helper', async (t) => {
  assert.equal(handleAuthorizedBlobRequest, serveAuthorizedBlob);

  const root = mkdtempSync(path.join(tmpdir(), 'wb-helper-range-'));
  const bytesStore = fsBlobs({ root });
  const payload = Buffer.from('abcdefghijklmnopqrstuvwxyz012345'); // 32 bytes
  bytesStore.writePending('b1', payload);
  bytesStore.finalizePending('b1');

  const authorize = createAuthorizationAdapter();
  authorize.registerResource({
    category: 'blob',
    name: 'audio',
    scope: ({ is }) => is.owner(),
    fields: { owner: ref('User', { role: 'owner' }) },
  });

  const ownerRow = { id: 'a1', owner: 'alice' };
  const server = http.createServer(async (req, res) => {
    const who = req.headers['x-user'] === 'alice'
      ? principal({ type: 'user', id: 'alice' })
      : principal({ type: 'user', id: 'bob' });
    await serveAuthorizedBlob({
      req,
      res,
      principal: who,
      resource: ownerRow,
      field: 'audio',
      authorize,
      stat: () => ({ size: payload.length, mime: 'audio/mpeg', sha256: sha256(payload) }),
      readStream: (range, options) => bytesStore.readRangeStream('b1', range, options),
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  t.after(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const okRange = await fetch(`${base}/media`, {
    headers: { 'x-user': 'alice', range: 'bytes=-8' },
  });
  assert.equal(okRange.status, 206);
  assert.equal(okRange.headers.get('content-range'), 'bytes 24-31/32');
  assert.deepEqual(Buffer.from(await okRange.arrayBuffer()), payload.subarray(24));

  const denied = await fetch(`${base}/media`, {
    headers: { 'x-user': 'bob', range: 'bytes=0-5' },
  });
  assert.equal(denied.status, 403);
});

test('HEAD /blobs/:entity/:id/:field works directly on app.listen(0) without app.use()', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'wb-direct-head-'));

  const Clip = entity('Clip', {
    title: text(),
    audio: blob(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });

  const alice = principal({ type: 'user', id: 'alice' });
  const app = workbench({ db, entities: [Clip], blobs: { root } });
  app.mount('/clips', Clip);
  await app.ddl();
  app.listen(0, { principalOf: () => alice });
  await app.ready;
  const { port } = app.httpServer.address();
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const payload = Buffer.from('direct-head-media-bytes-01234567');
  const uploadRes = await fetch(`${base}/blobs`, {
    method: 'POST',
    headers: { 'content-type': 'audio/mpeg' },
    body: payload,
  });
  assert.equal(uploadRes.status, 201);
  const uploaded = await uploadRes.json();

  const createRes = await fetch(`${base}/clips`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Direct HEAD clip', audio: uploaded.id }),
  });
  assert.equal(createRes.status, 201);
  const clip = await createRes.json();

  let streamOpens = 0;
  const origReadRangeStream = app.blobs.readRangeStream.bind(app.blobs);
  app.blobs.readRangeStream = (...args) => {
    streamOpens += 1;
    return origReadRangeStream(...args);
  };

  const headRes = await fetch(`${base}/blobs/Clip/${clip.id}/audio`, { method: 'HEAD' });
  assert.equal(headRes.status, 200);
  assert.equal(headRes.headers.get('accept-ranges'), 'bytes');
  assert.equal(headRes.headers.get('content-length'), String(payload.length));
  assert.equal(headRes.headers.get('etag'), `"${uploaded.sha256}"`);
  assert.equal((await headRes.arrayBuffer()).byteLength, 0);
  assert.equal(streamOpens, 0, 'direct HEAD must not open a byte stream');
});
