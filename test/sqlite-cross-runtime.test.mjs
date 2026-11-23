// sqlite-cross-runtime.test.mjs — cross-runtime SQLite driver seam (#284).
//
// Runs identically under BOTH Node (`node --test`) and Bun (`bun test`),
// exercising `sqlite-driver.mjs`, `driver.mjs`, `directory-lock.mjs`,
// `read-mirror.mjs`, `backup.mjs`, `recovery.mjs`, `migration-ledger.mjs`,
// and a full Workbench `app.start()` + `app.dispatch()` lifecycle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SQLITE_RUNTIME,
  backupDatabase,
  openSqliteDatabase,
} from '../build/sqlite-driver.mjs';
import {
  txn,
  exclusiveTxn,
  readSnapshotTxn,
  upsert,
} from '../build/driver.mjs';
import {
  DB_OWNED_ERROR_CODE,
  DirectoryOwnedError,
  acquireDirectoryLock,
} from '../build/directory-lock.mjs';
import {
  createSqliteAdapter,
  openMemoryAdapter,
  openSqliteAdapter,
  SQLITE_DATA_FILENAME,
} from '../build/sqlite-adapter.mjs';
import { openReadMirror, ReadMirrorError } from '../build/read-mirror.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { createBackupManager } from '../build/backup.mjs';
import { createRecoveryManager } from '../build/recovery.mjs';
import { checksumOf, runMigrations, validateMigrations } from '../build/migration-ledger.mjs';
import workbench, {
  entity,
  everyone,
  grant,
  read,
  scope,
  text,
  write,
} from '../build/internal.mjs';

function tempRoot(prefix = 'wb-cross-runtime-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('SQLITE_RUNTIME auto-detects the active JS runtime', () => {
  const expected = typeof globalThis.Bun !== 'undefined' ? 'bun' : 'node';
  assert.equal(SQLITE_RUNTIME, expected);
});

test('openSqliteDatabase normalizes open, location, isOpen, isTransaction, strict :param, get() miss, run() shape, and close()', () => {
  const dir = tempRoot();
  const dbPath = join(dir, 'driver.sqlite');
  try {
    const mem = openSqliteDatabase(':memory:');
    assert.equal(mem.isOpen, true);
    assert.equal(mem.isTransaction, false);
    assert.equal(mem.location(), null, ':memory: reports null location');
    mem.enableLoadExtension?.(false);
    assert.throws(() => mem.enableLoadExtension?.(true), /extension/i);
    mem.close();
    assert.equal(mem.isOpen, false);
    assert.throws(() => mem.prepare('SELECT 1'), /not open/i);

    const db = openSqliteDatabase(dbPath);
    try {
      assert.equal(db.isOpen, true);
      assert.equal(typeof db.location(), 'string');
      assert.ok(db.location().endsWith('driver.sqlite'));

      db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, slug TEXT NOT NULL, note TEXT)');

      // Strict :param named bindings (un-prefixed object keys) + run() shape.
      const insert = db.prepare('INSERT INTO item (slug, note) VALUES (:slug, :note)');
      const inserted = insert.run({ slug: 'alpha', note: 'first' });
      assert.equal(inserted.changes, 1);
      assert.equal(Number(inserted.lastInsertRowid), 1);

      // On Bun (`{ strict: true }`), missing named parameters throw instead of
      // silently binding NULL.
      if (SQLITE_RUNTIME === 'bun') {
        assert.throws(() => insert.run({ slug: 'missing-note' }), /note|parameter/i);
      }

      // Positional ? bindings.
      const inserted2 = db.prepare('INSERT INTO item (slug, note) VALUES (?, ?)').run('beta', 'second');
      assert.equal(inserted2.changes, 1);
      assert.equal(Number(inserted2.lastInsertRowid), 2);

      // get() returns matching object on hit and `undefined` (not null) on miss.
      const find = db.prepare('SELECT id, slug, note FROM item WHERE slug = :slug');
      const hit = find.get({ slug: 'alpha' });
      assert.deepEqual({ ...hit }, { id: 1, slug: 'alpha', note: 'first' });
      const miss = find.get({ slug: 'does-not-exist' });
      assert.strictEqual(miss, undefined);

      // isTransaction tracks BEGIN IMMEDIATE / COMMIT and ROLLBACK.
      assert.equal(db.isTransaction, false);
      db.exec('BEGIN IMMEDIATE');
      assert.equal(db.isTransaction, true);
      db.exec('ROLLBACK');
      assert.equal(db.isTransaction, false);
    } finally {
      db.close();
    }
    assert.equal(db.isOpen, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Statement.setReturnArrays(true) normalizes get(), all(), and iterate() across runtimes', () => {
  const db = openSqliteDatabase(':memory:');
  try {
    db.exec('CREATE TABLE pair (k TEXT PRIMARY KEY, v INTEGER)');
    db.prepare('INSERT INTO pair (k, v) VALUES (?, ?)').run('a', 10);
    db.prepare('INSERT INTO pair (k, v) VALUES (?, ?)').run('b', 20);

    const stmt = db.prepare('SELECT k, v FROM pair ORDER BY k');
    stmt.setReturnArrays(true);

    assert.deepEqual(stmt.all(), [['a', 10], ['b', 20]]);
    assert.deepEqual([...stmt.iterate()], [['a', 10], ['b', 20]]);

    const one = db.prepare('SELECT k, v FROM pair WHERE k = ?');
    one.setReturnArrays(true);
    assert.deepEqual(one.get('b'), ['b', 20]);
    assert.strictEqual(one.get('missing'), undefined);
  } finally {
    db.close();
  }
});

test('driver helpers: txn (BEGIN IMMEDIATE), exclusiveTxn, readSnapshotTxn, and upsert work identically', async () => {
  const db = openSqliteDatabase(':memory:');
  try {
    db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)');

    await txn(db, () => {
      assert.equal(db.isTransaction, true);
      upsert(db, { table: 'kv', keyColumns: ['k'], columns: ['v'], values: { k: 'a', v: 'one' } });
    });
    assert.equal(db.isTransaction, false);

    // Update via upsert on conflict.
    exclusiveTxn(db, () => {
      assert.equal(db.isTransaction, true);
      upsert(db, { table: 'kv', keyColumns: ['k'], columns: ['v'], values: { k: 'a', v: 'two' } });
    });

    // Failing txn rolls back cleanly.
    await assert.rejects(
      txn(db, () => {
        db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('b', 'rolled-back');
        throw new Error('abort-txn');
      }),
      /abort-txn/,
    );
    assert.equal(db.isTransaction, false);
    assert.strictEqual(db.prepare('SELECT v FROM kv WHERE k = ?').get('b'), undefined);

    const snapshotValue = await readSnapshotTxn(db, () => {
      return db.prepare('SELECT v FROM kv WHERE k = ?').get('a')?.v;
    });
    assert.equal(snapshotValue, 'two');
    assert.equal(db.isTransaction, false);
  } finally {
    db.close();
  }
});

test('directory-lock acquires BEGIN EXCLUSIVE, rejects concurrent opener with WB_DB_OWNED, and releases cleanly', () => {
  const dir = tempRoot();
  const lockFile = join(dir, 'lock.sqlite');
  try {
    const first = acquireDirectoryLock(lockFile);
    try {
      assert.equal(first.pid, process.pid);
      assert.throws(
        () => acquireDirectoryLock(lockFile),
        (err) => err instanceof DirectoryOwnedError && err.code === DB_OWNED_ERROR_CODE,
      );
    } finally {
      first.release();
    }
    const second = acquireDirectoryLock(lockFile);
    second.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read-mirror reads WAL writes and enforces read-only at rejector and engine layers', async () => {
  const dir = tempRoot();
  const owned = join(dir, 'owned');
  try {
    const adapter = createSqliteAdapter({ directory: owned, name: 'app' });
    const opened = await adapter.open();
    try {
      opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)');
      opened.handle.prepare('INSERT INTO note (id, body) VALUES (:id, :body)').run({ id: 'n1', body: 'from-wal' });

      const description = adapter.readMirror();
      const mirror = openReadMirror(description);
      try {
        const row = mirror.prepare('SELECT id, body FROM note WHERE id = :id').get({ id: 'n1' });
        assert.deepEqual({ ...row }, { id: 'n1', body: 'from-wal' });
        assert.strictEqual(mirror.prepare('SELECT id FROM note WHERE id = :id').get({ id: 'none' }), undefined);

        // Query-class rejector refuses writes, DDL, and mutating PRAGMAs.
        assert.throws(
          () => mirror.prepare('INSERT INTO note (id, body) VALUES (?, ?)'),
          (err) => err instanceof ReadMirrorError && err.kind === 'write',
        );
        assert.throws(
          () => mirror.exec('CREATE TABLE nope (x INTEGER)'),
          (err) => err instanceof ReadMirrorError && err.kind === 'ddl',
        );
        assert.throws(
          () => mirror.exec('PRAGMA foreign_keys = OFF'),
          (err) => err instanceof ReadMirrorError && err.kind === 'pragma',
        );
      } finally {
        mirror.close();
      }

      // Engine layer: opening connectionString directly still refuses writes.
      const rawRo = openSqliteDatabase(description.connectionString, { readOnly: true });
      try {
        assert.throws(
          () => rawRo.prepare('INSERT INTO note (id, body) VALUES (?, ?)').run('n2', 'blocked'),
          /readonly|read-only/i,
        );
      } finally {
        rawRo.close();
      }
    } finally {
      opened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backupDatabase (file WAL + :memory:), backup manager, and recovery manager round-trip end-to-end', async () => {
  const dir = tempRoot();
  const owned = join(dir, 'owned');
  const freshDir = join(dir, 'fresh');
  const memBackupDest = join(dir, "mem's-backup.sqlite");
  try {
    // Direct backupDatabase on :memory: (including SQL quote escaping in path).
    const mem = openMemoryAdapter();
    try {
      mem.handle.exec('CREATE TABLE seed (id INTEGER PRIMARY KEY, label TEXT)');
      mem.handle.prepare('INSERT INTO seed (label) VALUES (?)').run('memory-row');
      const pages = await backupDatabase(mem.handle, memBackupDest, { rate: 1 });
      assert.ok(pages >= 1);
      const check = openSqliteDatabase(memBackupDest, { readOnly: true });
      try {
        assert.equal(check.prepare('SELECT label FROM seed WHERE id = 1').get()?.label, 'memory-row');
      } finally {
        check.close();
      }
    } finally {
      mem.close();
    }

    // Full WAL backup + corrupt live DB + recovery + fresh-directory recovery.
    const opened = openSqliteAdapter({ directory: owned, name: 'app' });
    const queue = createWriteQueue();
    opened.writeCoordinator = queue;

    let backupId;
    try {
      // Disable autocheckpoint so the row sits strictly in the WAL sidecar.
      opened.handle.exec('PRAGMA wal_autocheckpoint = 0');
      opened.handle.exec('CREATE TABLE record (id TEXT PRIMARY KEY, value TEXT)');
      opened.handle.prepare('INSERT INTO record (id, value) VALUES (:id, :value)').run({
        id: 'r1',
        value: 'wal-committed',
      });

      const backupManager = createBackupManager({ source: opened, writeCoordinator: queue });
      const result = await backupManager.backup();
      assert.equal(result.ok, true);
      assert.equal(result.status, 'complete');
      assert.equal(result.manifest.status, 'complete');
      assert.equal(result.manifest.integrityResult.ok, true);
      backupId = result.backupId;
    } finally {
      opened.close();
    }

    // Corrupt live data.sqlite and recover via RecoveryManager.
    writeFileSync(join(owned, SQLITE_DATA_FILENAME), 'CORRUPT-DATA-'.repeat(64));
    const recoveryQueue = createWriteQueue();
    const recoveryManager = createRecoveryManager({
      source: { root: owned, writeCoordinator: recoveryQueue },
      writeCoordinator: recoveryQueue,
    });

    const probe = recoveryManager.probe();
    assert.equal(probe.ok, false);
    assert.equal(probe.state, 'recovery-required');
    assert.equal(probe.backups.length, 1);
    assert.equal(probe.backups[0].backupId, backupId);

    const restored = await recoveryManager.recover({ backupId });
    assert.equal(restored.ok, true);
    assert.equal(restored.status, 'restored');
    assert.ok(restored.quarantinedDatabase && existsSync(restored.quarantinedDatabase));

    const reopened = openSqliteAdapter({ directory: owned, name: 'app' });
    try {
      assert.equal(reopened.handle.prepare('SELECT value FROM record WHERE id = ?').get('r1')?.value, 'wal-committed');
    } finally {
      reopened.close();
    }

    // Fresh-directory restore.
    const fresh = await recoveryManager.recoverIntoFreshDirectory({ backupId, directory: freshDir });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.status, 'restored');
    const freshDb = openSqliteAdapter({ directory: freshDir, name: 'app' });
    try {
      assert.equal(freshDb.handle.prepare('SELECT value FROM record WHERE id = ?').get('r1')?.value, 'wal-committed');
    } finally {
      freshDb.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('full Workbench app.start() + dispatch() + boot integrity opt-in + explicit migration checksum', async () => {
  const dir = tempRoot();
  const owned = join(dir, 'app');
  try {
    // Explicit checksum validation.
    const pinned = 'cross-runtime-checksum-v1';
    let migrationRan = 0;
    const migration = {
      namespace: 'cross-runtime',
      name: 'init',
      version: 1,
      checksum: pinned,
      up(db) {
        migrationRan += 1;
        // Verify the migration callback receives a working handle without
        // creating an undeclared table that fails restart ownership census.
        db.prepare('SELECT 1 AS ok').get();
      },
    };
    assert.equal(checksumOf(migration), pinned);
    assert.throws(
      () => validateMigrations([{ namespace: 'bad', name: 'empty', version: 1, checksum: '   ', up: () => {} }]),
      /checksum must be a non-empty string/,
    );

    const Note = entity('Note', {
      title: text(),
      grant: [scope(() => everyone()).can(() => grant(read, write))],
    });

    // Default cold boot skips O(DB size) per-table PRAGMA integrity_check(table).
    const app = workbench({
      db: { directory: owned, name: 'app', mode: 'file' },
      entities: [Note],
      migrations: [migration],
    });
    const preparedSql = [];
    const origPrepare = app.db.prepare.bind(app.db);
    app.db.prepare = (sql) => {
      preparedSql.push(sql);
      return origPrepare(sql);
    };

    try {
      await app.start();

      assert.equal(
        preparedSql.some((sql) => /^PRAGMA integrity_check\(/i.test(sql)),
        false,
        'default boot does not run O(DB size) per-table PRAGMA integrity_check(table)',
      );
      assert.equal(
        preparedSql.some((sql) => /^PRAGMA foreign_key_check\b/i.test(sql)),
        true,
        'default boot still runs fast PRAGMA foreign_key_check',
      );

      const created = await app.dispatch({
        actionId: 'note-create-1',
        type: 'Note.create',
        scope: 'global',
        payload: { id: 'n1', title: `hello-from-${SQLITE_RUNTIME}` },
        principal: { id: 'u1' },
      });
      assert.equal(created.ok, true, created.failure?.message);
      assert.equal(migrationRan, 1, 'pinned-checksum migration ran exactly once');

      const row = app.db.prepare('SELECT id, title FROM Note WHERE id = :id').get({ id: 'n1' });
      assert.deepEqual({ ...row }, { id: 'n1', title: `hello-from-${SQLITE_RUNTIME}` });
    } finally {
      await app.shutdown();
    }

    // Opt-in verifyIntegrityOnBoot: true runs per-table PRAGMA integrity_check(table).
    const appVerified = workbench({
      db: { directory: owned, name: 'app', mode: 'file' },
      entities: [Note],
      migrations: [migration],
      verifyIntegrityOnBoot: true,
    });
    const verifiedSql = [];
    const origPrepare2 = appVerified.db.prepare.bind(appVerified.db);
    appVerified.db.prepare = (sql) => {
      verifiedSql.push(sql);
      return origPrepare2(sql);
    };
    try {
      await appVerified.start();
      assert.equal(
        verifiedSql.some((sql) => /^PRAGMA integrity_check\(/i.test(sql)),
        true,
        'verifyIntegrityOnBoot: true runs per-table PRAGMA integrity_check(table)',
      );
      // Persisted row survives restart.
      const persisted = appVerified.db.prepare('SELECT title FROM Note WHERE id = ?').get('n1');
      assert.equal(persisted?.title, `hello-from-${SQLITE_RUNTIME}`);
    } finally {
      await appVerified.shutdown();
    }

    // Sanity check runMigrations directly on a fresh cross-runtime DB.
    const ledgerDb = openSqliteDatabase(':memory:');
    try {
      runMigrations(ledgerDb, [migration]);
      const applied = ledgerDb
        .prepare("SELECT checksum FROM _SchemaMigration WHERE namespace = 'cross-runtime' AND version = 1")
        .get();
      assert.equal(applied?.checksum, pinned);
    } finally {
      ledgerDb.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
