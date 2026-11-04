// blob-seams-backup.test.mjs — S6/A6 (workbench#97) the backup side of the
// real blob seams: census + materialize over the real byte store + compiled
// census. Census enumerates exactly the referenced ADOPTED generations,
// deterministically; materialize writes the stable file name (the same name
// resolveBackupBlobName resolves) plus the digest sidecar, reports { name,
// size }, and fails closed on pending/missing/corrupt generations. Also the
// real backup-manager integration: a backup over the seam records the census
// in the manifest and lands verified bytes in backups/<id>/blobs/, and a
// referenced generation with missing bytes yields partial, never complete.
// Plus the app wiring: app.createBlobSeams() constructs the seam so Scope (S8)
// can build the backup/recovery/recycle managers with it wired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateFrameworkDDL } from '../build/ddl.mjs';
import { compileBlobCensus } from '../build/blob-census.mjs';
import { createBlobStore } from '../build/blob-store.mjs';
import {
  createBlobSeams,
  BLOB_GENERATION_LAYOUT_VERSION,
  blobGenerationFileName,
  blobGenerationDigestFileName,
  blobGenerationTempNames,
} from '../build/blob-seams.mjs';
import { openSqliteAdapter } from '../build/sqlite-adapter.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { createBackupManager } from '../build/backup.mjs';
import { entity, text, blob } from '../build/internal.mjs';
import workbench from '../build/internal.mjs';

function photoCensus() {
  return compileBlobCensus({
    entities: new Map(),
    declaredBlobFields: [
      { actionName: 'Photo.upload', field: 'data', resourceField: 'id', owningResource: 'Photo', erasureCategory: 'deletable' },
    ],
  });
}

// A real in-memory DB (framework DDL) + real fs blob store + the compiled
// census + the concrete seams. `adopt` uploads, adopts, and finalizes a blob.
async function setupStore() {
  const root = mkdtempSync(join(tmpdir(), 'wb-seams-backup-'));
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  db.exec('CREATE TABLE IF NOT EXISTS Photo (id TEXT PRIMARY KEY, data TEXT)');
  const store = createBlobStore({ root, db });
  const seams = createBlobSeams({ db, blobs: store, census: photoCensus() });
  const adopt = (bytes, id) => {
    const uploaded = store.upload({ bytes, id });
    db.exec('BEGIN IMMEDIATE');
    store.adopt(db, uploaded.id);
    db.exec('COMMIT');
    store.finalize(uploaded.id);
    return uploaded;
  };
  return { root, db, store, seams, adopt };
}

function cleanupRoots(...roots) {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

test('the generation-layout contract is declared and stable', () => {
  assert.equal(BLOB_GENERATION_LAYOUT_VERSION, 1);
  assert.equal(blobGenerationFileName('gen-a'), 'gen-a', 'the stable file name under blobs/ IS the generation id');
  assert.equal(blobGenerationDigestFileName('gen-a'), 'gen-a.sha256', 'the digest sidecar name is stable');
  assert.throws(() => blobGenerationFileName('../escape'), /invalid blob generation/);
  assert.throws(() => blobGenerationFileName('has space'), /invalid blob generation/);
});

test('census enumerates every referenced adopted generation, deterministically and stably', async () => {
  const { root, db, seams, adopt } = await setupStore();
  try {
    const a = adopt(Buffer.from('alpha'), 'gen-alpha');
    const b = adopt(Buffer.from('beta'), 'gen-beta');
    db.prepare('INSERT INTO Photo (id, data) VALUES (?, ?)').run('p1', a.id);
    db.prepare('INSERT INTO Photo (id, data) VALUES (?, ?)').run('p2', b.id);
    assert.deepEqual(await seams.census(), ['gen-alpha', 'gen-beta'], 'sorted referenced adopted generations');
    assert.deepEqual(await seams.census(), ['gen-alpha', 'gen-beta'], 'stable across calls');
  } finally {
    cleanupRoots(root);
  }
});

test('census excludes pending and unreferenced generations', async () => {
  const { root, db, store, seams, adopt } = await setupStore();
  try {
    const referenced = adopt(Buffer.from('ref'), 'gen-ref');
    db.prepare('INSERT INTO Photo (id, data) VALUES (?, ?)').run('p1', referenced.id);
    // Pending (never adopted) even though referenced — its bytes are not
    // content-addressed yet and must not be censused.
    const pending = store.upload({ bytes: Buffer.from('pending'), id: 'gen-pending' });
    db.prepare('INSERT INTO Photo (id, data) VALUES (?, ?)').run('p2', pending.id);
    // Adopted but unreferenced — no committed DB state reaches it.
    adopt(Buffer.from('orphan'), 'gen-orphan');
    assert.deepEqual(await seams.census(), ['gen-ref']);
  } finally {
    cleanupRoots(root);
  }
});

test('materialize writes the stable file name + digest sidecar and reports { name, size }', async () => {
  const { root, seams, adopt } = await setupStore();
  const blobsDir = mkdtempSync(join(tmpdir(), 'wb-materialize-'));
  try {
    const uploaded = adopt(Buffer.from('hello backup'), 'gen-one');
    const report = seams.materialize('gen-one', blobsDir);
    assert.deepEqual(report, [{ name: 'gen-one', size: 12 }]);
    assert.equal(existsSync(join(blobsDir, 'gen-one')), true, 'the stable byte file was written');
    assert.equal(readFileSync(join(blobsDir, 'gen-one'), 'utf8'), 'hello backup');
    assert.equal(existsSync(join(blobsDir, blobGenerationDigestFileName('gen-one'))), true, 'the digest sidecar was written');
    assert.equal(readFileSync(join(blobsDir, blobGenerationDigestFileName('gen-one')), 'utf8').trim(), uploaded.sha256);
    assert.equal(seams.resolveBackupBlobName('gen-one', blobsDir), report[0].name, 'resolve agrees with the name materialize wrote');
  } finally {
    cleanupRoots(root, blobsDir);
  }
});

test('materialize fails closed on a pending generation', async () => {
  const { root, store, seams } = await setupStore();
  const blobsDir = mkdtempSync(join(tmpdir(), 'wb-materialize-'));
  try {
    store.upload({ bytes: Buffer.from('never adopted'), id: 'gen-pending' });
    assert.throws(() => seams.materialize('gen-pending', blobsDir), /not adopted/);
  } finally {
    cleanupRoots(root, blobsDir);
  }
});

test('materialize fails closed on a missing generation', async () => {
  const { root, store, seams, adopt } = await setupStore();
  const blobsDir = mkdtempSync(join(tmpdir(), 'wb-materialize-'));
  try {
    // No metadata row at all.
    assert.throws(() => seams.materialize('gen-absent', blobsDir), /missing from the blob store metadata/);
    // Adopted row whose bytes are gone from the byte store.
    const adopted = adopt(Buffer.from('gone'), 'gen-gone');
    rmSync(store._pathFor(adopted.id), { force: true });
    assert.throws(() => seams.materialize('gen-gone', blobsDir), /missing from the byte store/);
  } finally {
    cleanupRoots(root, blobsDir);
  }
});

test('materialize verifies the bytes against the recorded digest (integrity metadata, never trust)', async () => {
  const { root, store, seams, adopt } = await setupStore();
  const blobsDir = mkdtempSync(join(tmpdir(), 'wb-materialize-'));
  try {
    const uploaded = adopt(Buffer.from('integrity'), 'gen-int');
    // Corrupt the final slot in place — the seam must refuse to back it up.
    writeFileSync(store._pathFor(uploaded.id), Buffer.from('TAMPERED!!!'));
    assert.throws(() => seams.materialize('gen-int', blobsDir), /failed digest verification/);
  } finally {
    cleanupRoots(root, blobsDir);
  }
});

test('materialize refuses a pre-existing symlink at the generation path — nothing is written outside', async () => {
  const { root, seams, adopt } = await setupStore();
  const blobsDir = mkdtempSync(join(tmpdir(), 'wb-materialize-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'wb-outside-'));
  const outsideFile = join(outsideDir, 'target');
  writeFileSync(outsideFile, 'outside bytes');
  try {
    adopt(Buffer.from('inside bytes'), 'gen-one');
    // A symlink at the byte-file name must never be written through.
    symlinkSync(outsideFile, join(blobsDir, 'gen-one'));
    assert.throws(() => seams.materialize('gen-one', blobsDir), /symlink/, 'a symlink at the generation path is refused');
    assert.equal(readFileSync(outsideFile, 'utf8'), 'outside bytes', 'the symlink target was never written through');
    assert.equal(existsSync(join(blobsDir, blobGenerationDigestFileName('gen-one'))), false, 'the sidecar was not written either');

    // The digest-sidecar name is guarded the same way.
    rmSync(join(blobsDir, 'gen-one'), { force: true });
    symlinkSync(outsideFile, join(blobsDir, blobGenerationDigestFileName('gen-one')));
    assert.throws(() => seams.materialize('gen-one', blobsDir), /symlink/, 'a symlinked sidecar path is refused');
    assert.equal(existsSync(join(blobsDir, 'gen-one')), false, 'the byte file was not written when the sidecar path is a symlink');
    assert.equal(readFileSync(outsideFile, 'utf8'), 'outside bytes', 'nothing landed outside the blob directory');
  } finally {
    cleanupRoots(root, blobsDir, outsideDir);
  }
});

test('materialize refuses a symlinked destination DIRECTORY — nothing is written outside', async () => {
  const { root, seams, adopt } = await setupStore();
  const parent = mkdtempSync(join(tmpdir(), 'wb-dest-'));
  const external = mkdtempSync(join(tmpdir(), 'wb-outside-dir-'));
  const dest = join(parent, 'blobs');
  symlinkSync(external, dest);
  try {
    adopt(Buffer.from('inside bytes'), 'gen-one');
    // A symlink AT the destination directory itself (not the generation path)
    // must not redirect mkdir/writes into `external`: refuse before anything
    // is written through the link.
    assert.throws(() => seams.materialize('gen-one', dest), /symlink/, 'a symlinked destination directory is refused');
    assert.equal(readdirSync(external).length, 0, 'nothing was written outside through the destination-directory symlink');
    assert.equal(existsSync(join(dest, 'gen-one')), false);
    assert.equal(existsSync(join(dest, blobGenerationDigestFileName('gen-one'))), false);
  } finally {
    cleanupRoots(root, parent, external);
  }
});

test('materialize is atomic — a failing sidecar write leaves no partial generation', async () => {
  const { root, db, store, adopt } = await setupStore();
  const blobsDir = mkdtempSync(join(tmpdir(), 'wb-materialize-'));
  try {
    adopt(Buffer.from('atomic bytes'), 'gen-atomic');
    // Force the sidecar write to fail AFTER the byte temp write has already
    // succeeded: pin the per-materialize temp token so the temp names are
    // predictable, and plant a directory at the sidecar temp path — the
    // exclusive 'wx' open fails (EEXIST — the path is occupied). The seam must
    // roll back exactly the files THIS invocation created: its own byte temp,
    // never the planted blocker, and never a partial byte file without its
    // sidecar.
    const token = 'fixedtesttoken';
    const temps = blobGenerationTempNames('gen-atomic', token);
    mkdirSync(join(blobsDir, temps.sidecar));
    const seams = createBlobSeams({ db, blobs: store, census: photoCensus(), tempToken: () => token });
    assert.throws(() => seams.materialize('gen-atomic', blobsDir), /EEXIST|EISDIR/, 'the sidecar write fails');
    assert.equal(existsSync(join(blobsDir, 'gen-atomic')), false, 'no partial byte file is observable');
    assert.equal(existsSync(join(blobsDir, blobGenerationDigestFileName('gen-atomic'))), false, 'no sidecar is observable either');
    assert.equal(existsSync(join(blobsDir, temps.byte)), false, 'the byte temp was rolled back');
    assert.equal(existsSync(join(blobsDir, temps.sidecar)), true, 'rollback removes only its own files — the planted blocker is untouched');
  } finally {
    cleanupRoots(root, blobsDir);
  }
});

test('rollback after a failure AFTER the byte final was published removes that published final atomically (ownership-verified), and the destination is re-materializable next call', async () => {
  const { root, db, store, adopt } = await setupStore();
  const blobsDir = mkdtempSync(join(tmpdir(), 'wb-materialize-'));
  try {
    adopt(Buffer.from('atomic bytes'), 'gen-atomic');
    // Force a failure AFTER the byte final has been published (so rollback must
    // remove a final it owns, not just temps): pin the token and use the
    // after-byte-publish test hook to plant a directory at the sidecar FINAL
    // name — the sidecar publish then fails (EEXIST — the path is occupied).
    // Rollback must atomically remove THIS invocation's own byte final, leave
    // the planted blocker untouched, and leave the destination re-materializable.
    const token = 'fixedtesttoken';
    const temps = blobGenerationTempNames('gen-atomic', token);
    const sidecarName = blobGenerationDigestFileName('gen-atomic');
    const seams = createBlobSeams({
      db,
      blobs: store,
      census: photoCensus(),
      tempToken: () => token,
      afterByteFinalPublish: () => mkdirSync(join(blobsDir, sidecarName)),
    });
    assert.throws(() => seams.materialize('gen-atomic', blobsDir), /EEXIST|already exists/, 'the sidecar publish fails');
    assert.equal(existsSync(join(blobsDir, 'gen-atomic')), false, 'the published byte final was removed by the ownership-verified rollback');
    assert.equal(existsSync(join(blobsDir, temps.byte)), false, 'the byte temp was rolled back');
    assert.equal(existsSync(join(blobsDir, temps.sidecar)), false, 'the sidecar temp was rolled back');
    assert.equal(existsSync(join(blobsDir, sidecarName)), true, 'rollback never removes what it did not create — the planted blocker is untouched');
    assert.deepEqual(
      readdirSync(blobsDir).sort(),
      [sidecarName].sort(),
      'only the planted blocker remains — no temp, no claim, no partial generation',
    );

    // The destination is clean again, so the next materialize of the same
    // generation into the SAME directory re-materializes it fully.
    rmSync(join(blobsDir, sidecarName), { recursive: true, force: true });
    const retry = createBlobSeams({ db, blobs: store, census: photoCensus() });
    retry.materialize('gen-atomic', blobsDir);
    assert.equal(existsSync(join(blobsDir, 'gen-atomic')), true, 're-materialized after the rollback');
    assert.equal(existsSync(join(blobsDir, sidecarName)), true, 'the digest sidecar is present after re-materialization');
  } finally {
    cleanupRoots(root, blobsDir);
  }
});

test('ownership-verified rollback never removes a foreign file swapped onto the published final path (no check-then-act TOCTOU)', async () => {
  const { root, db, store, adopt } = await setupStore();
  const blobsDir = mkdtempSync(join(tmpdir(), 'wb-materialize-'));
  try {
    adopt(Buffer.from('atomic bytes'), 'gen-atomic');
    // Simulate a winner's final replacing this invocation's byte final between
    // its publish and its rollback: the after-byte-publish hook unlinks the
    // byte final and puts a DIFFERENT file (different inode) at the path, and
    // plants a directory at the sidecar final so the invocation fails after
    // publish. The ownership-verified rollback must NOT delete the foreign file
    // — a losing materializer never deletes a winner's final, atomically.
    const token = 'fixedtesttoken';
    const temps = blobGenerationTempNames('gen-atomic', token);
    const sidecarName = blobGenerationDigestFileName('gen-atomic');
    const byteFinal = join(blobsDir, 'gen-atomic');
    const seams = createBlobSeams({
      db,
      blobs: store,
      census: photoCensus(),
      tempToken: () => token,
      afterByteFinalPublish: () => {
        assert.equal(existsSync(join(blobsDir, temps.byte)), true, 'the temp link pins the owned inode until rollback finishes');
        // The hook runs AFTER this invocation published its byte final: swap a
        // foreign file in at the same path (a new inode, simulating a winner's
        // final), then block the sidecar to force the failure.
        rmSync(byteFinal, { force: true });
        writeFileSync(byteFinal, 'foreign winner bytes');
        mkdirSync(join(blobsDir, sidecarName));
      },
    });
    assert.throws(() => seams.materialize('gen-atomic', blobsDir), /EEXIST|already exists/, 'the sidecar publish fails');
    assert.equal(
      readFileSync(join(blobsDir, 'gen-atomic'), 'utf8'),
      'foreign winner bytes',
      'the foreign file at the final path was NOT deleted by the losing materializer\'s rollback',
    );
    assert.equal(existsSync(join(blobsDir, sidecarName)), true, 'the planted blocker is untouched');
    assert.equal(existsSync(join(blobsDir, temps.byte)), false, 'the byte temp was rolled back');
    assert.equal(existsSync(join(blobsDir, temps.sidecar)), false, 'the sidecar temp was rolled back');
  } finally {
    cleanupRoots(root, blobsDir);
  }
});

// ---- real backup-manager integration over the real source + seam ---------

async function setupRealBackup() {
  const root = mkdtempSync(join(tmpdir(), 'wb-seams-real-'));
  const dir = join(root, 'owned');
  const opened = openSqliteAdapter({ directory: dir, name: 'app' });
  const db = opened.handle;
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  db.exec('CREATE TABLE Photo (id TEXT PRIMARY KEY, data TEXT)');
  const blobs = createBlobStore({ root: join(dir, 'blobs'), db });
  const seams = createBlobSeams({ db, blobs, census: photoCensus() });
  const coordinator = createWriteQueue();
  opened.writeCoordinator = coordinator;
  const manager = createBackupManager({ source: opened, writeCoordinator: coordinator, blobs: seams });
  return { root, dir, opened, db, blobs, seams, manager };
}

test('a backup over the real seam completes: census → materialize → manifest blobs + verified byte file', async () => {
  const { root, opened, db, blobs, manager } = await setupRealBackup();
  try {
    const uploaded = blobs.upload({ bytes: Buffer.from('backup me'), id: 'gen-in-backup' });
    db.exec('BEGIN IMMEDIATE');
    blobs.adopt(db, uploaded.id);
    db.exec('COMMIT');
    blobs.finalize(uploaded.id);
    db.prepare('INSERT INTO Photo (id, data) VALUES (?, ?)').run('p1', uploaded.id);

    const result = await manager.backup();
    assert.equal(result.ok, true, 'a blob-capable source with the seam backs up complete');
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.manifest.blobGenerations, ['gen-in-backup'], 'the manifest records the census');
    const backupBlobs = join(result.directory, 'blobs');
    assert.equal(existsSync(join(backupBlobs, 'gen-in-backup')), true);
    assert.equal(readFileSync(join(backupBlobs, 'gen-in-backup'), 'utf8'), 'backup me');
    assert.equal(existsSync(join(backupBlobs, blobGenerationDigestFileName('gen-in-backup'))), true);
  } finally {
    opened.close();
    cleanupRoots(root);
  }
});

test('a referenced generation with missing bytes makes the backup partial, never complete', async () => {
  const { root, opened, db, blobs, manager } = await setupRealBackup();
  try {
    const uploaded = blobs.upload({ bytes: Buffer.from('will vanish'), id: 'gen-vanish' });
    db.exec('BEGIN IMMEDIATE');
    blobs.adopt(db, uploaded.id);
    db.exec('COMMIT');
    blobs.finalize(uploaded.id);
    db.prepare('INSERT INTO Photo (id, data) VALUES (?, ?)').run('p1', uploaded.id);
    rmSync(blobs._pathFor(uploaded.id), { force: true });

    const result = await manager.backup();
    assert.equal(result.ok, false, 'a referenced generation without bytes fails closed');
    assert.equal(result.status, 'partial');
    assert.equal(result.quarantined, true, 'the partial is quarantined, never left as a false-complete');
    assert.deepEqual(result.manifest.blobGenerations, ['gen-vanish'], 'the census still recorded the reference');
    assert.equal(result.manifest.status, 'partial', 'the manifest itself declares partial');
    assert.match(result.directory, /quarantine/, 'the partial landed in quarantine');
  } finally {
    opened.close();
    cleanupRoots(root);
  }
});

// ---- app wiring ----------------------------------------------------------

function noteEntity() {
  return entity('Note', { title: text(), photo: blob() });
}

test('app wiring: app.createBlobSeams() constructs the seam and a backup over it completes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-seams-app-'));
  const dir = join(root, 'owned');
  const app = workbench({
    db: { directory: dir, name: 'app', mode: 'file' },
    entities: [noteEntity()],
  });
  try {
    await app.start();
    const uploaded = app.blobs.upload({ bytes: Buffer.from('app blob'), id: 'gen-app' });
    app.db.exec('BEGIN IMMEDIATE');
    app.blobs.adopt(app.db, uploaded.id);
    app.db.exec('COMMIT');
    app.blobs.finalize(uploaded.id);
    app.db.prepare('INSERT INTO Note (id, title, photo) VALUES (?, ?, ?)').run('n1', 'title', uploaded.id);

    const seams = app.createBlobSeams();
    for (const method of ['census', 'materialize', 'verifyBackupGeneration', 'materializeRestoreGeneration', 'censusAfterRestore', 'resolveBackupBlobName']) {
      assert.equal(typeof seams[method], 'function', `the app-built seam exposes ${method}`);
    }
    const manager = createBackupManager({ source: app._dbAdapter, writeCoordinator: app.writeCoordinator, blobs: seams });
    const result = await manager.backup();
    assert.equal(result.ok, true);
    assert.equal(result.status, 'complete');
    assert.ok(result.manifest.blobGenerations.includes('gen-app'), 'the app census wired into the backup');
  } finally {
    await app.shutdown();
    cleanupRoots(root);
  }
});

test('app wiring: createBlobSeams fails closed without a compiled census', async () => {
  const app = workbench({ db: ':memory:' });
  try {
    assert.throws(() => app.createBlobSeams(), /compiled blob census/, 'a not-yet-booted app has no kernel census');
  } finally {
    await app.shutdown();
  }
});
