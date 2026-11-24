// Priority 2, part 3 — the user-facing blob upload route + the blob-field wiring.
// `POST /blobs` streams the request body to the BlobStore as a PENDING blob
// (`.pending` file + row), returning { id, md5, sha256, size, mime }. The blob is
// ADOPTED by the dispatch that references it (an entity field marked `blob: true`
// carrying the blob id) — adopted IN that dispatch's transaction, finalized
// post-commit. A rolled-back dispatch leaves the blob pending for the reaper
// (eng-review §3.2, Walk 1b; spec #2 atomicity). One BlobStore, reached by the
// upload route AND the kernel's blob adopter — not a second persistence path.

import { text, ref, blob, scope, grant, read, write, subscribe } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import workbench, {
  entity, createBlobLifecycle } from '../build/internal.mjs';

function photoNote() {
  return entity('Note', {
        body: text(),
    photo: blob(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

async function harness(t) {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'express-blob-'));
  const app = workbench({ db, blobs: { root } });
  app.mount('/notes', photoNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => {
    app.httpServer.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { app, db, base, root };
}

const json = (r) => r.json();

test('POST /blobs uploads a pending blob with one-pass hashes', async (t) => {
  const { base, root } = await harness(t);
  const bytes = Buffer.from('hello world');
  const r = await fetch(`${base}/blobs`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: bytes,
  });
  assert.equal(r.status, 201);
  const meta = await json(r);
  assert.equal(meta.size, bytes.length);
  assert.equal(meta.md5, createHash('md5').update(bytes).digest('hex'));
  assert.equal(meta.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(meta.mime, 'image/png');
  assert.ok(existsSync(path.join(root, `${meta.id}.pending`)), 'a .pending file landed on disk');
});

test('the /blobs route and app surface read bytes by id — pathFor is retired (S6/A2)', async (t) => {
  const { app, base } = await harness(t);
  assert.equal(typeof app.blobs.pathFor, 'undefined', 'no portable pathFor on the app blob store');
  assert.equal(typeof app.blobs._pathFor, 'function', 'the explicit internal/test handle survives');

  const bytes = Buffer.from('route-reads-by-id');
  const up = await json(await fetch(`${base}/blobs`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: bytes,
  }));
  // The upload route and the kernel blob adopter locate/read bytes through the
  // injected byte store's methods by blob id — never a physical path. A pending
  // upload is NOT readable through the generic final-slot read: its bytes are
  // served only through the claim-gated pending read (S6/A4).
  assert.throws(() => app.blobs.readRange(up.id), /blob not found/, 'an unclaimed pending blob id never serves bytes via the generic read');
  assert.deepStrictEqual(app.blobs.readPending(up.id), bytes, 'pending bytes are reachable only through the explicit pending read');
});

test('POST /blobs is fail-closed for anonymous', async (t) => {
  const { base: _base } = await harness(t);
  // No principal wiring override here would be the way, but the harness pins u1;
  // exercise the anonymous path with a bare app whose principalOf returns nobody.
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'express-blob-'));
  const app = workbench({ db, blobs: { root } });
  app.mount('/notes', photoNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: null }) });
  await app.ready;
  const port = app.httpServer.address().port;
  t.after(() => {
    app.httpServer.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const r = await fetch(`http://127.0.0.1:${port}/blobs`, {
    method: 'POST',
    body: Buffer.from('x'),
  });
  assert.equal(r.status, 401, 'an anonymous upload is refused at the route gate');
});

test('a create referencing a blob adopts + finalizes it in the dispatch commit', async (t) => {
  const { app, base, root } = await harness(t);
  const bytes = Buffer.from('an image');
  const up = await json(await fetch(`${base}/blobs`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: bytes,
  }));
  assert.ok(existsSync(path.join(root, `${up.id}.pending`)), 'the upload is pending');

  // Create a note referencing the pending blob; the dispatch commit adopts it
  // (UPDATE BlobStore in-txn) and finalizes it (post-commit .pending->final).
  const created = await json(await fetch(`${base}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'n', photo: up.id }),
  }));
  assert.equal(created.photo, up.id, 'the blob id is stored on the note');
  assert.equal(
    app.blobs.stat(up.id).status,
    'adopted',
    'the committed dispatch adopted the blob',
  );
  assert.ok(existsSync(path.join(root, up.id)), 'the adopted blob was finalized to its final path');
  assert.ok(
    !existsSync(path.join(root, `${up.id}.pending`)),
    'no leftover .pending after finalize',
  );
});

// NOTE: the rollback contract (a denied dispatch leaves the blob pending) is
// covered by test/blob-atomicity.test.mjs, which exercises the kernel's
// blob adapter with afterProjection admission that denies. The HTTP app.kernel
// (buildKernel) admits the create path through its own afterProjection seam — a dispatched
// create always commits there — so that contract is not reachable via HTTP and
// is not re-tested here.

test('blob lifecycle owns field discovery, adopt, finalize, and reaper columns', async () => {
  const adopted = [];
  const finalized = [];
  const blobs = {
    adopt: (db, id) => adopted.push([db, id]),
    finalize: (id) => finalized.push(id),
  };
  const entities = new Map([
    ['Note', photoNote()],
    ['Plain', { fields: { body: text() } }],
  ]);
  const lifecycle = createBlobLifecycle({ blobs, entities });

  assert.deepEqual(
    lifecycle.census.references,
    [{
      table: 'Note', column: 'photo', owningResource: 'Note', field: 'photo',
      lifecycle: 'finalize', erasureCategory: 'deletable', ownership: 'exclusive',
    }],
    'the compiled census carries the entity blob field with full reference metadata',
  );

  const db = {};
  const events = [
    { type: 'Note.created', data: { id: 'n1', photo: 'b1' } },
    { type: 'Note.updated', data: { id: 'n1', photo: 'b1' } },
    { type: 'Plain.created', data: { id: 'p1', body: 'ignore' } },
    { type: 'Other.created', data: { id: 'o1', photo: 'ignore' } },
  ];

  await lifecycle.blobAdapter.adoptInTxn(db, events);
  await lifecycle.blobFinalizeConsumer(events);

  assert.deepEqual(adopted, [[db, 'b1']]);
  assert.deepEqual(finalized, ['b1']);
});
