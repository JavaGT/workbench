// Priority 2 reaper (finding #3, eng-review spec #10, consult #17). The blob
// store's `reap()` is a WRITER: it DELETEs BlobStore rows and unlinks files. A
// dispatch's transaction spans an `await` (the async `mayVerb`), so a sync reaper
// firing during that yield would race the adopt/finalize in flight — deleting a
// row the dispatch just adopted, or unlinking a file mid-finalize. The reaper must
// therefore run under the writeQueue mutex (the same single-writer lock dispatch
// uses), so a sweep and a mutation can NEVER interleave. The framework owns this
// (app.blobs is auto-built on db-engaged and POST /blobs is always live, so an
// abandoned upload leaks .pending forever with no operator lever — fail-closed
// default baked into the framework, not an app responsibility).

import { text, ref, blob, scope, grant, read, write, subscribe } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import workbench, {
  entity } from '../build/internal.mjs';
import { declaredBlobField } from '../build/server.mjs';

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

async function harness(t, options = {}, beforeStart = () => {}) {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'express-blobreap-'));
  const app = workbench({ db, blobs: { root }, ...options });
  app.mount('/notes', photoNote());
  await app.ddl();
  beforeStart(app);
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  t.after(async () => {
    await app.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { app, db, root };
}

// Backdate a pending blob's createdAt so the orphan sweep treats it as abandoned.
function backdate(db, id, agoMs) {
  db.prepare('UPDATE BlobStore SET createdAt = ? WHERE id = ?').run(
    new Date(Date.now() - agoMs).toISOString(),
    id,
  );
}

test('blob reaper sweeps stale orphan .pending blobs', async (t) => {
  const { app, db, root } = await harness(t);
  const _up = app.blobs.upload({ bytes: Buffer.from('orphaned upload'), id: 'orph1' });
  assert.ok(existsSync(path.join(root, 'orph1.pending')), 'the .pending file landed');
  backdate(db, 'orph1', 2 * 3600_000); // older than the default 1h TTL

  await app.sweepBlobs();

  assert.ok(!existsSync(path.join(root, 'orph1.pending')), 'the .pending file was reaped');
  assert.ok(!app.blobs.stat('orph1'), 'the BlobStore row was reaped');
});

test('blob reaper TTL is configured when the application is constructed', async (t) => {
  const { app, db, root } = await harness(t, { blobReapTtlMs: 10 });
  app.blobs.upload({ bytes: Buffer.from('short-lived orphan'), id: 'orph-override' });
  backdate(db, 'orph-override', 20);

  await app.sweepBlobs();

  assert.ok(!existsSync(path.join(root, 'orph-override.pending')));
  assert.ok(!app.blobs.stat('orph-override'));
});

test('the replaced-generation policy is the single authority for the app sweep (S6/A5 #21)', async (t) => {
  const { app, db } = await harness(t, { blobRetention: { replacedGenerationRetentionMs: 60_000 } });
  const v1 = app.blobs.upload({ bytes: Buffer.from('old-policy'), id: 'gen-policy' });
  adoptAndFinalize(app, v1.id);
  const staged = app.blobs.replace(v1.id, { bytes: Buffer.from('new-policy') });
  db.exec('BEGIN IMMEDIATE');
  app.blobs.switchReplacement(db, v1.id, staged.id);
  db.exec('COMMIT');
  app.blobs.finalize(staged.id);
  db.prepare('INSERT INTO Note (id, body, photo) VALUES (?, ?, ?)').run('n1', 'x', staged.id);

  // Inside the 60s window the replaced generation is kept.
  await app.sweepBlobs();
  assert.ok(app.blobs.stat(v1.id), 'the replaced generation is kept inside the replaced-generation window');

  // The window elapses (backdated replacedAt) → the app sweep reclaims it.
  db.prepare('UPDATE BlobStore SET replacedAt = ? WHERE id = ?').run(new Date(Date.now() - 120_000).toISOString(), v1.id);
  await app.sweepBlobs();
  assert.equal(app.blobs.stat(v1.id), undefined, 'the replaced generation is reaped once the policy window elapsed');
  assert.ok(app.blobs.stat(staged.id), 'the referenced replacement generation is kept');
});

test('application runtime registers the construction-level blob reaper interval', async (t) => {
  const registrations = [];
  const { app } = await harness(
    t,
    { blobReapIntervalMs: 1234 },
    (runtime) => {
      const add = runtime.clock.add;
      runtime.clock.add = (watcher) => {
        registrations.push(watcher);
        return add(watcher);
      };
    },
  );

  assert.equal(registrations.find((watcher) => watcher.name === 'blob-reaper')?.intervalMs, 1234);
  assert.equal(app.ready, app.start());
});

test('blob reaper runs under the writeQueue mutex — waits for an in-flight dispatch', async (t) => {
  const { app, db, root } = await harness(t);
  const _up = app.blobs.upload({ bytes: Buffer.from('orphaned upload'), id: 'orph2' });
  backdate(db, 'orph2', 2 * 3600_000);

  // Hold the writeQueue — a stand-in for an in-flight dispatch whose txn spans an
  // await. The reaper must WAIT; a sync reap firing mid-txn would race the
  // adopt/finalize in flight (eng-review spec #10 — the reaper acquires the mutex).
  let releaseDispatch;
  const held = app.writeQueue.run(() => new Promise((r) => { releaseDispatch = r; }));
  for (let i = 0; i < 1000 && !releaseDispatch; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(releaseDispatch, 'the writeQueue lock is held by the in-flight dispatch');

  let swept = false;
  const sweepP = app.sweepBlobs().then(() => { swept = true; });
  for (let i = 0; i < 100 && !swept; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(swept, false, 'the reaper waits for the writeQueue mutex');
  assert.ok(existsSync(path.join(root, 'orph2.pending')), 'the orphan is NOT reaped while the lock is held');

  releaseDispatch();
  await held;
  await sweepP;
  assert.equal(swept, true, 'the reaper ran once the writeQueue released');
  assert.ok(!existsSync(path.join(root, 'orph2.pending')), 'the orphan was reaped after release');
});

// ---- refcount sweep over the COMPILED census (S6/A3) -----------------------
// The refcount sweep's ONLY column source is the census compiled at prepare
// time — there is no runtime blobColumns scan. The declared reference points at
// a plain `Photo` table created here, mirroring an app-declared table that
// holds blob ids without being an entity `blob: true` field.

function declaredBlobHarness(t) {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'express-blobreap-census-'));
  const app = workbench({
    db,
    blobs: { root },
    blobLifecycle: {
      fields: [declaredBlobField({ actionName: 'Photo.upload', field: 'data', resourceField: 'id', owningResource: 'Photo', erasureCategory: 'deletable' })],
      pendingTtlMs: 60_000,
      adoptedRecoveryTtlMs: 60_000,
    },
  });
  app.mount('/notes', photoNote());
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  return { app, db, root, t };
}

function adoptAndFinalize(app, id) {
  app.db.exec('BEGIN IMMEDIATE');
  app.blobs.adopt(app.db, id);
  app.db.exec('COMMIT');
  app.blobs.finalize(id);
}

test('the reaper refcount sweep is driven by the compiled census — referenced blobs are kept, dangling ones reaped', async (t) => {
  const { app, db, root } = declaredBlobHarness(t);
  await app.ddl();
  db.exec('CREATE TABLE Photo (id TEXT PRIMARY KEY, data TEXT)');
  await app.ready;
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });

  const kept = app.blobs.upload({ bytes: Buffer.from('kept'), id: 'kept1' });
  const dangling = app.blobs.upload({ bytes: Buffer.from('dangling'), id: 'dang1' });
  adoptAndFinalize(app, kept.id);
  adoptAndFinalize(app, dangling.id);
  db.prepare('INSERT INTO Photo (id, data) VALUES (?, ?)').run('p1', kept.id);

  await app.sweepBlobs();

  assert.ok(app.blobs.stat(kept.id), 'the blob referenced by a census column is kept');
  assert.equal(app.blobs.stat(dangling.id), undefined, 'the unreferenced blob is reaped as a dangler');
});

test('matching content hashes never merge ownership — identical bytes are reaped independently (#7)', async (t) => {
  const { app, db, root } = declaredBlobHarness(t);
  await app.ddl();
  db.exec('CREATE TABLE Photo (id TEXT PRIMARY KEY, data TEXT)');
  await app.ready;
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });

  const bytes = Buffer.from('identical-bytes');
  const referenced = app.blobs.upload({ bytes, id: 'same1' });
  const unreferenced = app.blobs.upload({ bytes, id: 'same2' });
  assert.equal(referenced.sha256, unreferenced.sha256, 'the two blobs hold identical bytes (matching hashes)');
  adoptAndFinalize(app, referenced.id);
  adoptAndFinalize(app, unreferenced.id);
  db.prepare('INSERT INTO Photo (id, data) VALUES (?, ?)').run('p1', referenced.id);

  await app.sweepBlobs();

  assert.ok(app.blobs.stat(referenced.id), 'the referenced generation is kept');
  assert.equal(app.blobs.stat(unreferenced.id), undefined, 'the same-bytes generation with no reference is still reaped — no hash-based dedup or merging');
});

test('the refcount sweep consults ONLY census-declared columns — a blob id in an undeclared column is not a reference', async (t) => {
  const { app, db, root } = declaredBlobHarness(t);
  await app.ddl();
  db.exec('CREATE TABLE Photo (id TEXT PRIMARY KEY, data TEXT, thumb TEXT)');
  await app.ready;
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });

  const up = app.blobs.upload({ bytes: Buffer.from('hidden ref'), id: 'thumb-ref' });
  adoptAndFinalize(app, up.id);
  db.prepare('INSERT INTO Photo (id, data, thumb) VALUES (?, ?, ?)').run('p1', null, up.id);

  await app.sweepBlobs();

  assert.equal(app.blobs.stat(up.id), undefined, 'an id living only in an undeclared column reads as unreferenced');
});

test('a declared reference whose table is not provisioned is skipped, not fatal', async (t) => {
  const { app, db, root } = declaredBlobHarness(t);
  await app.ddl();
  // The census declares a reference on (Photo, data) but no Photo table exists.
  await app.ready;
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });

  const up = app.blobs.upload({ bytes: Buffer.from('lonely'), id: 'lonely1' });
  adoptAndFinalize(app, up.id);

  await app.sweepBlobs();

  assert.equal(app.blobs.stat(up.id), undefined, 'no table means no reference — the blob is reaped as a dangler without a crash');
});
