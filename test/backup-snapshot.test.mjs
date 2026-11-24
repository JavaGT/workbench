// backup-snapshot.test.mjs — S1/A3 snapshot: WAL-safe online backup under
// concurrent reads + queued writes, the enumerated manifest, and the
// complete-vs-partial boundary (single DB+blob consistency point through the
// write coordinator).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openSqliteAdapter, openMemoryAdapter } from '../build/sqlite-adapter.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import {
  createBackupManager,
  BACKUP_FORMAT_VERSION,
} from '../build/backup.mjs';
import * as safety from '../build/backup/safety.mjs';

const BACKUP_DIR_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{12}$/;

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'wb-backup-snapshot-'));
}

// Bind the freshly-created coordinator to the source (the ownership seam,
// review #82 finding 3) and construct the manager with that same coordinator.
function managerFor(opened, options = {}) {
  const writeCoordinator = options.writeCoordinator ?? createWriteQueue();
  opened.writeCoordinator = writeCoordinator;
  return createBackupManager({ source: opened, writeCoordinator, ...options });
}

// The concretely enumerated manifest surface (issue #82 spec §2) — every field
// must be present and typed correctly.
function assertEnumeratedManifest(manifest) {
  assert.equal(manifest.formatVersion, BACKUP_FORMAT_VERSION);
  assert.equal(typeof manifest.platformSchemaIdentity, 'string');
  assert.match(manifest.platformSchemaIdentity, /^[0-9a-f]{64}$/, 'platformSchemaIdentity is a sha256 hex');
  assert.ok(Array.isArray(manifest.appSchemaIdentity), 'appSchemaIdentity is an array');
  assert.ok(manifest.appSchemaIdentity.every((entry) => typeof entry === 'string'), 'each app identity is a string');
  assert.ok(manifest.migrationLedgerState, 'migrationLedgerState present');
  assert.deepEqual(manifest.migrationLedgerState, { table: '_SchemaMigration', appliedVersions: [], maxVersion: 0 }, 'fresh DB carries an empty namespaced ledger');
  assert.ok(manifest.integrityResult && typeof manifest.integrityResult.ok === 'boolean', 'integrityResult present');
  assert.ok(!Number.isNaN(Date.parse(manifest.integrityResult.checkedAt)), 'integrityResult has a checkedAt');
  assert.ok(Array.isArray(manifest.blobGenerations), 'blobGenerations is an array');
  assert.ok(!Number.isNaN(Date.parse(manifest.createdAt)), 'createdAt is an ISO instant');
  assert.ok(!Number.isNaN(Date.parse(manifest.completedAt)), 'completedAt is an ISO instant');
  assert.ok(manifest.status === 'complete' || manifest.status === 'partial', 'status is complete|partial');
  assert.equal(manifest.encryption, 'none', 'encryption is recorded explicitly per owner decision #3');
}

test('createBackupManager validates its contract fail-closed', { timeout: 120000 }, () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      const queue = createWriteQueue();
      opened.writeCoordinator = queue;
      assert.throws(() => createBackupManager({ source: opened }), /write coordinator/);
      assert.throws(() => createBackupManager({ source: opened, writeCoordinator: queue, retention: { daily: 0 } }), /daily/);
      assert.throws(() => createBackupManager({ source: opened, writeCoordinator: queue, retention: { hourly: -1 } }), /hourly/);
      assert.throws(() => createBackupManager({ source: opened, writeCoordinator: queue, blobs: {} }), /census/);
      const memory = openMemoryAdapter();
      try {
        memory.writeCoordinator = queue;
        assert.throws(
          () => createBackupManager({ source: memory, writeCoordinator: queue }),
          /FILE-mode source/,
          'a memory source has no owned directory to back into',
        );
      } finally {
        memory.close();
      }
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createBackupManager enforces coordinator ownership — a foreign coordinator is refused', { timeout: 120000 }, () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      const owner = createWriteQueue();
      opened.writeCoordinator = owner;

      // The source's own coordinator is accepted.
      assert.equal(typeof createBackupManager({ source: opened, writeCoordinator: owner }).backup, 'function');

      // A different coordinator instance does not own this source → refused.
      assert.throws(
        () => createBackupManager({ source: opened, writeCoordinator: createWriteQueue() }),
        /foreign write coordinator/,
        'a different write queue is not the source owner',
      );
      // Any object shaped like a coordinator (no ownership) is refused.
      assert.throws(
        () => createBackupManager({ source: opened, writeCoordinator: { run: async (fn) => fn() } }),
        /foreign write coordinator/,
        'a run-shaped object without ownership is refused',
      );
      // An unbound source (no declared coordinator) fails closed at construction.
      const unbound = openSqliteAdapter({ directory: join(root, 'unbound'), name: 'app' });
      try {
        assert.throws(
          () => createBackupManager({ source: unbound, writeCoordinator: createWriteQueue() }),
          /declare the write coordinator that owns it/,
          'an unbound source cannot prove its barrier excludes writes',
        );
      } finally {
        unbound.close();
      }
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup() writes backups/<timestamp>-<id>/ with snapshot, manifest, blobs and the full manifest', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)');
      opened.handle.prepare('INSERT INTO note (id, body) VALUES (?, ?)').run('n1', 'hello backup');

      const result = await managerFor(opened).backup();
      assert.equal(result.ok, true);
      assert.equal(result.status, 'complete');
      assert.match(result.backupId, BACKUP_DIR_NAME, 'backup id is <timestamp>-<id>');
      assert.equal(join(dir, 'backups', result.backupId), result.directory, 'lives under backups/');

      const entries = readdirSync(result.directory).sort();
      assert.deepEqual(entries, ['blobs', 'manifest.json', 'snapshot.sqlite'], 'layout: snapshot.sqlite, manifest.json, blobs/');

      // manifest.json on disk deep-equals the returned manifest and carries
      // every enumerated field.
      const disk = JSON.parse(readFileSync(join(result.directory, 'manifest.json'), 'utf8'));
      assert.deepEqual(disk, result.manifest);
      assertEnumeratedManifest(result.manifest);
      assert.equal(result.manifest.status, 'complete');
      assert.deepEqual(result.manifest.blobGenerations, [], 'no blob seam → empty referenced set');
      assert.equal(result.manifest.integrityResult.ok, true, 'snapshot quick_check is clean');

      // Round-trip: the snapshot is a valid, restorable database.
      const snap = new DatabaseSync(join(result.directory, 'snapshot.sqlite'), { readOnly: true });
      try {
        assert.equal(snap.prepare('SELECT body FROM note WHERE id = ?').get('n1').body, 'hello backup');
        assert.equal(snap.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      } finally {
        snap.close();
      }

      // The backup directory is covered by the S1/A2 managed-path guard, so
      // static serving and blob-root acceptance both refuse it.
      assert.equal(opened.isManagedPath(result.directory), true);
      assert.equal(opened.isManagedPath(join(result.directory, 'snapshot.sqlite')), true);
      assert.equal(opened.isManagedPath(join(result.directory, 'manifest.json')), true);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('round-trips under concurrent reads + queued writes (WAL mode) without corruption', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE note (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)');
      const insert = opened.handle.prepare('INSERT INTO note (body) VALUES (?)');
      for (let i = 0; i < 50; i++) insert.run(`seed-${i}`);
      // A generous wait so the queued writes survive a slow node:sqlite backup
      // on a contended machine (the platform default maxWaitMs=5000 is for
      // interactive writes, not for the backup barrier's capture).
      const queue = createWriteQueue({ maxWaitMs: 60_000 });
      opened.writeCoordinator = queue;
      const manager = createBackupManager({ source: opened, writeCoordinator: queue });

      const backupPromise = manager.backup();
      // Queued writes: issued AFTER the backup's barrier turn was taken, so
      // they must commit after the snapshot and never corrupt it.
      const writes = [];
      for (let i = 0; i < 25; i++) writes.push(queue.run(() => insert.run(`queued-${i}`)));
      // Concurrent reads on the same connection while the online backup runs.
      const reads = [];
      for (let i = 0; i < 25; i++) {
        reads.push(Promise.resolve().then(() => opened.handle.prepare('SELECT COUNT(*) AS c FROM note').get()));
      }

      const readResults = await Promise.all(reads);
      await Promise.all([backupPromise, ...writes]);

      const result = await backupPromise;
      assert.equal(result.ok, true, 'the backup completed under load');
      assert.equal(result.status, 'complete');
      assert.equal(result.manifest.integrityResult.ok, true, 'snapshot integrity holds under concurrent load');

      // The snapshot is a consistent committed prefix: the seed rows, none of
      // the queued writes (they committed after the barrier released).
      const snap = new DatabaseSync(join(result.directory, 'snapshot.sqlite'), { readOnly: true });
      try {
        const total = snap.prepare('SELECT COUNT(*) AS c FROM note').get().c;
        const queued = snap.prepare("SELECT COUNT(*) AS c FROM note WHERE body LIKE 'queued-%'").get().c;
        assert.equal(total, 50, 'snapshot holds exactly the committed seed prefix');
        assert.equal(queued, 0, 'no queued write leaked into the snapshot');
      } finally {
        snap.close();
      }
      // The live database stayed healthy and took every queued write.
      assert.equal(opened.handle.prepare('SELECT COUNT(*) AS c FROM note').get().c, 75, 'all queued writes committed to the source');
      // Reads ran concurrently without failing.
      for (const row of readResults) assert.equal(typeof row.c, 'number');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migrationLedgerState and schema identity reflect the committed schema', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec(`CREATE TABLE _SchemaMigration (
        namespace TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        appliedAt TEXT NOT NULL,
        suppliedBy TEXT,
        PRIMARY KEY (namespace, version)
      )`);
      opened.handle.prepare('INSERT INTO _SchemaMigration (namespace, version, name, checksum, appliedAt, suppliedBy) VALUES (?, ?, ?, ?, ?, ?)').run('alpha', 1, 'a1', 'c1', '2026-01-01T00:00:00.000Z', null);
      opened.handle.prepare('INSERT INTO _SchemaMigration (namespace, version, name, checksum, appliedAt, suppliedBy) VALUES (?, ?, ?, ?, ?, ?)').run('alpha', 3, 'a3', 'c3', '2026-01-03T00:00:00.000Z', null);
      opened.handle.prepare('INSERT INTO _SchemaMigration (namespace, version, name, checksum, appliedAt, suppliedBy) VALUES (?, ?, ?, ?, ?, ?)').run('workbench', 5, 'wb5', 'c5', '2026-01-05T00:00:00.000Z', 'workbench@0.1.2');
      opened.handle.exec('CREATE TABLE app_note (id TEXT PRIMARY KEY, body TEXT)');

      const result = await managerFor(opened).backup();      assert.equal(result.ok, true);
      const manifest = result.manifest;

      // The applied namespaced ledger, captured from the snapshot (committed
      // state): identity is (namespace, version), ordered by (namespace, version).
      assert.deepEqual(manifest.migrationLedgerState, {
        table: '_SchemaMigration',
        appliedVersions: [
          { namespace: 'alpha', version: 1 },
          { namespace: 'alpha', version: 3 },
          { namespace: 'workbench', version: 5 },
        ],
        maxVersion: 5,
      });

      // Platform identity covers the framework tables; app identity is one
      // fingerprint per app-owned table and never names a ledger.
      assert.equal(manifest.appSchemaIdentity.length, 1, 'exactly the app table is an app-schema identity');
      assert.match(manifest.appSchemaIdentity[0], /^app_note:[0-9a-f]{64}$/);
      assert.ok(
        manifest.appSchemaIdentity.every((entry) => !entry.startsWith('_SchemaMigration')),
        'the ledger is not an app-schema identity',
      );
      // The two identities are stable across a second backup of the same state.
      const again = await managerFor(opened).backup();
      assert.equal(again.ok, true);
      assert.equal(again.manifest.platformSchemaIdentity, manifest.platformSchemaIdentity);
      assert.deepEqual(again.manifest.appSchemaIdentity, manifest.appSchemaIdentity);
      assert.deepEqual(again.manifest.migrationLedgerState, manifest.migrationLedgerState);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migrationLedgerState orders namespaces by folded identity', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec(`CREATE TABLE _SchemaMigration (
        namespace TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        appliedAt TEXT NOT NULL,
        suppliedBy TEXT,
        PRIMARY KEY (namespace, version)
      )`);
      const insert = opened.handle.prepare('INSERT INTO _SchemaMigration (namespace, version, name, checksum, appliedAt, suppliedBy) VALUES (?, ?, ?, ?, ?, ?)');
      insert.run('Zulu', 1, 'z1', 'c1', '2026-01-01T00:00:00.000Z', null);
      insert.run('alpha', 1, 'a1', 'c2', '2026-01-01T00:00:00.000Z', null);

      const result = await managerFor(opened).backup();
      assert.equal(result.ok, true);
      assert.deepEqual(
        result.manifest.migrationLedgerState.appliedVersions,
        [{ namespace: 'alpha', version: 1 }, { namespace: 'Zulu', version: 1 }],
        'backup order matches recovery validation of case-insensitive namespaces',
      );
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('blob census: referenced generations are recorded and their bytes copied', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      const materialized = [];
      const blobs = {
        census: async () => ['gen-a', 'gen-b'],
        materialize: async (generation, destDir) => {
          materialized.push(generation);
          const name = `${generation}.blob`;
          const content = `bytes-${generation}`;
          writeFileSync(join(destDir, name), content);
          // Materialize must report the files it wrote (name + size) so the
          // manager can verify the bytes landed before declaring complete.
          return [{ name, size: content.length }];
        },
      };
      const result = await managerFor(opened, { blobs }).backup();
      assert.equal(result.ok, true);
      assert.equal(result.status, 'complete');
      assert.deepEqual([...result.manifest.blobGenerations].sort(), ['gen-a', 'gen-b']);
      assert.deepEqual(materialized.sort(), ['gen-a', 'gen-b'], 'every referenced generation was materialized');
      assert.equal(existsSync(join(result.directory, 'blobs', 'gen-a.blob')), true);
      assert.equal(existsSync(join(result.directory, 'blobs', 'gen-b.blob')), true);
      assertEnumeratedManifest(result.manifest);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing referenced blob makes the backup partial + quarantined — never false-complete', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      const blobs = {
        census: () => ['gen-a', 'gen-b'],
        materialize: (generation, destDir) => {
          if (generation === 'gen-b') throw new Error('BLOB_UNAVAILABLE: gen-b bytes pending finalization');
          const name = `${generation}.blob`;
          writeFileSync(join(destDir, name), 'bytes-a');
          return [{ name, size: 7 }];
        },
      };
      const result = await managerFor(opened, { blobs }).backup();
      assert.equal(result.ok, false);
      assert.equal(result.status, 'partial');
      assert.equal(result.quarantined, true);
      assert.equal(result.manifest.status, 'partial', 'the manifest says partial, never complete');
      assert.match(result.diagnostic.error, /gen-b/);
      assert.deepEqual(result.diagnostic.detail.missingGenerations, ['gen-b']);

      // The partial was quarantined OUT of backups/ — restore can never pick it up.
      assert.equal(readdirSync(join(dir, 'backups')).length, 0, 'no backup dir remains in backups/');
      assert.ok(result.directory.startsWith(join(dir, 'quarantine')), 'the partial lives in quarantine/');
      assert.equal(existsSync(join(result.directory, 'diagnostic.json')), true, 'diagnostics retained');
      const disk = JSON.parse(readFileSync(join(result.directory, 'manifest.json'), 'utf8'));
      assert.equal(disk.status, 'partial', 'the on-disk manifest is not a false-complete marker');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a blob-capable database without a census seam refuses fail-closed; a no-blob database completes without a seam', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  const plainDir = join(root, 'plain');
  try {
    // Blob-enabled source: the schema declares the framework blob-metadata
    // ledger (BlobStore), so adopted blob generations MAY exist even when the
    // table is empty — a no-seam backup must refuse, never claim complete
    // (review #82 finding 1).
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE BlobStore (id TEXT PRIMARY KEY, status TEXT NOT NULL, size INTEGER, createdAt TEXT NOT NULL)');
      const result = await managerFor(opened).backup();
      assert.equal(result.ok, false, 'no-seam backup of a blob-capable db refuses');
      assert.equal(result.status, 'failed');
      assert.equal(result.quarantined, true);
      assert.equal(result.diagnostic.stage, 'snapshot');
      assert.match(result.diagnostic.error, /census seam/);
      assert.equal(readdirSync(join(dir, 'backups')).length, 0, 'backups/ holds nothing after the refusal');

      // A supplied census seam is authoritative — even an empty census means
      // "no generations referenced", which completes.
      const withSeam = await managerFor(opened, { blobs: { census: () => [], materialize: async () => [] } }).backup();
      assert.equal(withSeam.ok, true, 'an explicit (empty) census seam completes');
      assert.equal(withSeam.status, 'complete');
    } finally {
      opened.close();
    }

    // A schema with no blob ledger cannot miss blob bytes — no seam completes.
    const plain = openSqliteAdapter({ directory: plainDir, name: 'app' });
    try {
      plain.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY)');
      const result = await managerFor(plain).backup();
      assert.equal(result.ok, true);
      assert.equal(result.status, 'complete');
      assert.deepEqual(result.manifest.blobGenerations, []);
    } finally {
      plain.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a materializer that silently writes nothing makes the backup partial + quarantined — never complete', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      const blobs = {
        census: () => ['gen-silent'],
        materialize: async () => [],
      };
      const result = await managerFor(opened, { blobs }).backup();
      assert.equal(result.ok, false);
      assert.equal(result.status, 'partial');
      assert.equal(result.quarantined, true);
      assert.equal(result.manifest.status, 'partial', 'a no-bytes materializer must never produce a complete manifest');
      assert.deepEqual(result.diagnostic.detail.missingGenerations, ['gen-silent']);
      assert.equal(readdirSync(join(result.directory, 'blobs')).length, 0, 'the quarantined partial holds no blob bytes');
      assert.equal(readdirSync(join(dir, 'backups')).length, 0, 'backups/ holds nothing after the partial');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a materializer reporting a size mismatch (wrong bytes on disk) makes the backup partial — never complete', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      const blobs = {
        census: () => ['gen-a'],
        materialize: (generation, destDir) => {
          writeFileSync(join(destDir, `${generation}.blob`), 'abc');
          return [{ name: `${generation}.blob`, size: 999 }]; // lies about the size
        },
      };
      const result = await managerFor(opened, { blobs }).backup();
      assert.equal(result.ok, false);
      assert.equal(result.status, 'partial');
      assert.equal(result.manifest.status, 'partial', 'unverified bytes can never be complete');
      assert.deepEqual(result.diagnostic.detail.missingGenerations, ['gen-a']);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a materializer reporting a symlink inside blobs/ pointing outside is a missing generation — partial, never complete', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      // The reported entry is a symlink planted inside blobs/ whose target
      // lives OUTSIDE the backup directory. Verification is lstat-based: a
      // symlink is refused outright, and its realpath would escape the blob
      // dir — either way the generation is missing, never a complete byte.
      const outside = join(root, 'outside.bin');
      writeFileSync(outside, 'outside-bytes');
      const blobs = {
        census: () => ['gen-a'],
        materialize: (generation, destDir) => {
          symlinkSync(outside, join(destDir, `${generation}.blob`));
          return [{ name: `${generation}.blob`, size: 'outside-bytes'.length }];
        },
      };
      const result = await managerFor(opened, { blobs }).backup();
      assert.equal(result.ok, false);
      assert.equal(result.status, 'partial');
      assert.equal(result.quarantined, true);
      assert.equal(result.manifest.status, 'partial', 'a symlinked byte can never be complete');
      assert.deepEqual(result.diagnostic.detail.missingGenerations, ['gen-a']);
      assert.equal(readdirSync(join(dir, 'backups')).length, 0, 'backups/ holds nothing after the partial');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a materializer reporting a legitimate contained file passes verification — even with an unreported symlink present', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      // A real regular file INSIDE blobs/ whose realpath stays inside the blob
      // directory's realpath passes lstat + realpath containment and the size
      // check → complete. A symlink planted in the same dir but NOT reported
      // cannot fail the generation: only reported entries are verified.
      const outside = join(root, 'outside.bin');
      writeFileSync(outside, 'outside-bytes');
      const blobs = {
        census: () => ['gen-a'],
        materialize: (generation, destDir) => {
          const name = `${generation}.blob`;
          const content = 'contained-bytes';
          writeFileSync(join(destDir, name), content);
          symlinkSync(outside, join(destDir, 'unreported-link'));
          return [{ name, size: content.length }];
        },
      };
      const result = await managerFor(opened, { blobs }).backup();
      assert.equal(result.ok, true, 'a contained reported file passes verification');
      assert.equal(result.status, 'complete');
      assert.equal(result.manifest.status, 'complete');
      assert.equal(existsSync(join(result.directory, 'blobs', 'gen-a.blob')), true);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the adapter backupTo hook snapshots via node:sqlite for file and memory sources', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)');
      opened.handle.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run('n1', 'file-row');
      const pages = await opened.backupTo(join(dir, 'hook-file.sqlite'));
      assert.ok(Number.isInteger(pages) && pages >= 1, 'backupTo resolves with the transferred page count');
      const read = new DatabaseSync(join(dir, 'hook-file.sqlite'), { readOnly: true });
      try {
        assert.equal(read.prepare('SELECT v FROM t WHERE id = ?').get('n1').v, 'file-row');
      } finally {
        read.close();
      }
    } finally {
      opened.close();
    }

    const memory = openMemoryAdapter();
    try {
      memory.handle.exec('CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)');
      memory.handle.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run('n2', 'mem-row');
      await memory.backupTo(join(dir, 'hook-mem.sqlite'));
      const read = new DatabaseSync(join(dir, 'hook-mem.sqlite'), { readOnly: true });
      try {
        assert.equal(read.prepare('SELECT v FROM t WHERE id = ?').get('n2').v, 'mem-row');
      } finally {
        read.close();
      }
    } finally {
      memory.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a non-WAL source is refused fail-closed — a raw main-file copy never happens', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      // A structurally valid source whose live connection is NOT in WAL mode
      // (default journal mode): the ticket's WAL-safe snapshot contract is
      // unconditional, so the manager must refuse BEFORE any byte copy.
      const nonWalHandle = new DatabaseSync(':memory:');
      nonWalHandle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      let copyAttempted = false;
      const queue = createWriteQueue();
      const fake = {
        root: dir,
        handle: nonWalHandle,
        writeCoordinator: queue,
        backupTo: async () => {
          copyAttempted = true;
          throw new Error('should never be reached');
        },
      };
      const result = await createBackupManager({ source: fake, writeCoordinator: queue }).backup();
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.match(result.diagnostic.error, /WAL-mode source/);
      assert.equal(copyAttempted, false, 'the manager never attempted a (raw) copy of the database file');
      nonWalHandle.close();
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the backup API surface is re-exported from workbench/internal', { timeout: 120000 }, async () => {
  const internal = await import('../build/internal.mjs');
  assert.equal(typeof internal.createBackupManager, 'function');
  assert.equal(internal.BACKUP_FORMAT_VERSION, 1);
  assert.deepEqual(internal.DEFAULT_RETENTION, { daily: 7, hourly: 3 });
});

// The crash-safety invariants are ONE authority: backup.ts and recovery.ts must
// both resolve layout/id validation, completeness, quarantine sweeps,
// quick_check, schema identity and verified blob containment to the SAME
// functions in backup/safety.ts — not two hand-copied implementations that can
// drift apart. Both the structural binding and the shared behavior are pinned.
test('backup and recovery share one crash-safety authority', { timeout: 120000 }, async () => {
  const runtime = (name) => readFileSync(new URL(`../build/${name}`, import.meta.url), 'utf8');
  const backupRuntime = runtime('backup.mjs');
  const recoveryRuntime = runtime('recovery.mjs');

  // Structural: both emitted loops import the shared module and neither keeps
  // a private copy of the invariants.
  for (const [name, code] of [['backup', backupRuntime], ['recovery', recoveryRuntime]]) {
    assert.match(code, /from '\.\/backup\/safety\.mjs'/, `${name} imports the shared authority`);
    for (const local of [
      'isCompleteBackupDir', 'isDirectory', 'quickCheckOf', 'schemaIdentityOf',
      'verifyMaterialization', 'verifyRestoreMaterialization', 'moveToQuarantine', 'formatTimestamp',
      'readCompleteManifest', 'compareLedgerEntry', 'sanitizeMessage', 'sanitizeError',
    ]) {
      assert.doesNotMatch(code, new RegExp(`function ${local}\\b`), `${name} has no private ${local}`);
    }
  }

  // The authority surface both loops depend on is exported, with no 'any'.
  for (const name of [
    'BACKUP_FORMAT_VERSION', 'BACKUP_NAME', 'isValidBackupId', 'formatTimestamp',
    'parseBackupTimestamp', 'isDirectory', 'isCompleteBackupDir', 'writeDiagnostic',
    'createQuarantineMover', 'quarantineIncompleteBackups', 'quickCheckOf',
    'schemaIdentityOf', 'verifyMaterialization', 'readCompleteManifest',
    'listCompleteBackups', 'compareLedgerEntry', 'createMessageSanitizer',
    'readMigrationLedger',
  ]) {
    assert.ok(name in safety, `${name} is exported by the shared authority`);
  }

  const root = tempRoot();
  try {
    const dir = join(root, 'owned');
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE parity_note (id TEXT PRIMARY KEY, body TEXT)');
      const writeCoordinator = createWriteQueue();
      opened.writeCoordinator = writeCoordinator;
      const backup = await createBackupManager({ source: opened, writeCoordinator }).backup();
      assert.equal(backup.ok, true, 'a real backup exists to check the shared recomputations');
      const backupDir = join(dir, 'backups', backup.backupId);

      // Layout / id authority: the same regex + validator both loops use.
      assert.match(backup.backupId, safety.BACKUP_NAME);
      assert.equal(safety.isValidBackupId(backup.backupId), true);
      assert.equal(safety.isValidBackupId('../escape'), false, 'a user id cannot escape backups/');
      assert.equal(safety.isValidBackupId(123), false);
      assert.equal(safety.isDirectory(backupDir), true);
      assert.equal(safety.isCompleteBackupDir(backupDir), true, 'the shared completeness gate accepts the real backup');

      // quick_check + schema identity authority: recomputing through the shared
      // functions reproduces exactly what the backup manifest recorded and what
      // recovery validates against.
      const quick = safety.quickCheckOf(opened.handle);
      assert.equal(quick.ok, backup.manifest.integrityResult.ok);
      assert.deepEqual(safety.schemaIdentityOf(opened.handle), {
        platformSchemaIdentity: backup.manifest.platformSchemaIdentity,
        appSchemaIdentity: backup.manifest.appSchemaIdentity,
      });
      assert.deepEqual(safety.readMigrationLedger(opened.handle), backup.manifest.migrationLedgerState);
      // Both modes come from the one function: backup lets a PRAGMA error throw;
      // recovery supplies a sanitizer and gets a failure finding instead.
      const throwing = { prepare: () => ({ all: () => { throw new Error('boom'); } }) };
      assert.throws(() => safety.quickCheckOf(throwing), /boom/);
      const wrapped = safety.quickCheckOf(throwing, { describeError: (err) => `wrapped:${err.message}` });
      assert.equal(wrapped.ok, false);
      assert.deepEqual(wrapped.findings, [{ severity: 'error', message: 'wrapped:boom' }]);

      // Containment authority: a regular file verifies, a symlink that escapes
      // the blob directory is refused, and the two call sites' exact wording is
      // preserved by the directoryLabel parameter.
      const blobsDir = join(backupDir, 'blobs');
      writeFileSync(join(blobsDir, 'real.byte'), 'abc');
      assert.deepEqual(safety.verifyMaterialization('g1', blobsDir, [{ name: 'real.byte', size: 3 }]), { ok: true });
      writeFileSync(join(root, 'outside.byte'), 'abcd');
      symlinkSync(join(root, 'outside.byte'), join(blobsDir, 'escape.byte'));
      const escaped = safety.verifyMaterialization('g1', blobsDir, [{ name: 'escape.byte', size: 4 }]);
      assert.equal(escaped.ok, false);
      assert.match(escaped.reason, /symlink/);
      const missingDir = join(root, 'never-created');
      assert.equal(
        safety.verifyMaterialization('g1', missingDir, [{ name: 'x', size: 1 }]).reason,
        'materialize for g1 ran before the blob directory existed',
      );
      assert.equal(
        safety.verifyMaterialization('g1', missingDir, [{ name: 'x', size: 1 }], { directoryLabel: 'target blob directory' }).reason,
        'materialize for g1 ran before the target blob directory existed',
      );
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
