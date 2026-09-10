// sqlite-adapter-lifecycle.test.mjs — S1/A2 lifecycle: owned-directory layout
// + permissions, the centralized PRAGMA layer, fail-closed quick_check at open,
// checkpoint/close ordering, the periodic WAL checkpoint-starvation guard, and
// the teardown guard (db file + -wal/-shm + lock sidecar removed,
// backups/quarantine/recycle untouched).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  openSqliteAdapter,
  openMemoryAdapter,
  SQLITE_DATA_FILENAME,
  SQLITE_LOCK_FILENAME,
  MANAGED_SUBDIRECTORIES,
  WAL_GUARD_INTERVAL_MS,
  WAL_GUARD_SIZE_THRESHOLD_BYTES,
} from '../build/sqlite-adapter.mjs';

const EXPECTED_CAPABILITIES = {
  transactionalDdl: true,
  onlineBackup: true,
  readOnlyConnections: true,
  integrityCheck: true,
  maintenance: true,
  encryption: false,
};

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'wb-adapter-lifecycle-'));
}

test('openSqliteAdapter creates the owned directory (0o700) and stable layout', () => {
  const base = tempRoot();
  const root = path.join(base, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: root, name: 'app', mode: 'file' });
    try {
      assert.equal(existsSync(root), true, 'owned directory exists');
      assert.equal(statSync(root).mode & 0o777, 0o700, 'owned directory is 0o700');
      assert.equal(existsSync(path.join(root, SQLITE_DATA_FILENAME)), true, 'db file exists');
      assert.equal(existsSync(path.join(root, SQLITE_LOCK_FILENAME)), true, 'lock sidecar exists');
      for (const sub of MANAGED_SUBDIRECTORIES) {
        assert.equal(existsSync(path.join(root, sub)), true, `${sub}/ exists`);
        assert.equal(statSync(path.join(root, sub)).mode & 0o777, 0o700, `${sub}/ is 0o700`);
      }
      assert.equal(opened.mode, 'file');
      assert.equal(opened.root, path.resolve(root));
    } finally {
      opened.close();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('openSqliteAdapter reports the closed capability set and a working handle', () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      assert.deepEqual(opened.capabilities, EXPECTED_CAPABILITIES);
      assert.ok(opened.handle instanceof DatabaseSync, 'handle is a DatabaseSync');
      assert.equal(typeof opened.handle.txn, 'function', 'driver helpers attached');
      assert.equal(typeof opened.handle.upsert, 'function', 'driver helpers attached');
      const row = opened.handle.prepare('SELECT 1 AS one').get();
      assert.deepEqual({ ...row }, { one: 1 });
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the centralized PRAGMA layer is applied at open (single source of truth)', () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      const pragmas = (sql) => opened.handle.prepare(sql).get();
      assert.deepEqual({ ...pragmas('PRAGMA journal_mode') }, { journal_mode: 'wal' });
      assert.deepEqual({ ...pragmas('PRAGMA foreign_keys') }, { foreign_keys: 1 });
      assert.deepEqual({ ...pragmas('PRAGMA synchronous') }, { synchronous: 1 });
      assert.deepEqual({ ...pragmas('PRAGMA busy_timeout') }, { timeout: 5000 });
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PRAGMA layer source is exactly one module: driver.ts declares the SQL', () => {
  // The adapter path must never rely on wrapDriver's silent bootstrap — the
  // PRAGMA strings live in exactly one module (driver.ts) and the adapter
  // applies them fail-closed. Guard the source of truth: sqlite-adapter.ts
  // must import, not redeclare, the PRAGMA list.
  const adapterSource = readFileSync(new URL('../src/sqlite-adapter.ts', import.meta.url), 'utf8');
  const driverSource = readFileSync(new URL('../src/driver.ts', import.meta.url), 'utf8');
  assert.match(adapterSource, /applyConnectionPragmas/);
  assert.doesNotMatch(adapterSource, /PRAGMA (journal_mode|foreign_keys|synchronous|busy_timeout)/);
  assert.match(driverSource, /CONNECTION_PRAGMA_SQL/);
  assert.match(driverSource, /PRAGMA foreign_keys = ON/);
});

test('integrityCheck() reports ok on a healthy database and findings on corruption', () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      const report = opened.integrityCheck();
      assert.equal(report.ok, true);
      assert.deepEqual(report.findings, []);
      assert.ok(!Number.isNaN(Date.parse(report.checkedAt)));
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('open fails closed when quick_check detects a corrupt database', () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  try {
    // Create a healthy, checkpointed database with allocated pages.
    const healthy = openSqliteAdapter({ directory: dir, name: 'app' });
    healthy.handle.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT)');
    const insert = healthy.handle.prepare('INSERT INTO items (body) VALUES (?)');
    for (let i = 0; i < 500; i++) insert.run('payload-' + i);
    healthy.close(); // checkpoints the WAL into data.sqlite

    // Corrupt allocated leaf pages mid-file, leaving the header intact so the
    // file still opens as a SQLite database and quick_check is what fails.
    const dbFile = path.join(dir, SQLITE_DATA_FILENAME);
    const bytes = readFileSync(dbFile);
    const lo = Math.floor(bytes.length * 0.25);
    const hi = Math.min(bytes.length - 100, Math.floor(bytes.length * 0.5));
    for (let i = lo; i < hi; i += 97) bytes[i] ^= 0xff;
    writeFileSync(dbFile, bytes);

    assert.throws(
      () => openSqliteAdapter({ directory: dir, name: 'app' }),
      /quick_check integrity verification/,
      'a corrupt database must fail closed at open',
    );
    // The failure path released the ownership lock: a fresh adapter can open
    // after the corrupt database file is removed.
    rmSync(dbFile, { force: true });
    const reopened = openSqliteAdapter({ directory: dir, name: 'app' });
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkpoint() truncates the WAL; close() checkpoints then closes (clean shutdown)', () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    // A committed write creates WAL content.
    opened.handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    opened.handle.exec('INSERT INTO t (v) VALUES (\'hello\')');
    const walFile = path.join(dir, SQLITE_DATA_FILENAME + '-wal');
    assert.equal(existsSync(walFile), true, '-wal exists after a write');

    opened.checkpoint();
    assert.equal(statSync(walFile).size, 0, 'wal_checkpoint(TRUNCATE) empties the WAL');

    opened.handle.exec('INSERT INTO t (v) VALUES (\'again\')');
    assert.ok(statSync(walFile).size > 0, '-wal regrows after the next write');

    opened.close();
    // close() = checkpoint-then-close: the WAL is drained into the main file and
    // the handle no longer accepts statements.
    if (existsSync(walFile)) {
      assert.equal(statSync(walFile).size, 0, 'close() checkpointed the WAL');
    }
    assert.throws(() => opened.handle.prepare('SELECT 1'), /not open/i, 'handle is closed');
    assert.doesNotThrow(() => opened.close(), 'close() is idempotent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('teardown removes db file, -wal/-shm and lock sidecar but never backups/quarantine/recycle', () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  const protectedDirs = ['backups', 'quarantine', 'recycle'];
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    // Give the protected + non-protected managed dirs identifiable contents.
    const markers = new Map();
    for (const sub of [...MANAGED_SUBDIRECTORIES]) {
      const marker = path.join(dir, sub, 'keep-me.bin');
      mkdirSync(path.dirname(marker), { recursive: true });
      writeFileSync(marker, 'survives-teardown');
      markers.set(sub, marker);
    }
    opened.handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    opened.handle.exec('INSERT INTO t DEFAULT VALUES');
    opened.teardown();

    assert.equal(existsSync(path.join(dir, SQLITE_DATA_FILENAME)), false, 'db file removed');
    assert.equal(existsSync(path.join(dir, SQLITE_DATA_FILENAME + '-wal')), false, '-wal removed');
    assert.equal(existsSync(path.join(dir, SQLITE_DATA_FILENAME + '-shm')), false, '-shm removed');
    assert.equal(existsSync(path.join(dir, SQLITE_LOCK_FILENAME)), false, 'lock sidecar removed');
    for (const sub of MANAGED_SUBDIRECTORIES) {
      assert.equal(existsSync(path.join(dir, sub)), true, `${sub}/ directory survives`);
    }
    for (const sub of protectedDirs) {
      assert.equal(existsSync(markers.get(sub)), true, `${sub}/ contents survive (S1/A3/A4/A6)`);
    }
    // The lock is gone: a fresh adapter can re-own the directory.
    const reopened = openSqliteAdapter({ directory: dir, name: 'app' });
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('openSqliteAdapter rejects a config without a directory and routes memory mode', () => {
  assert.throws(() => openSqliteAdapter({ name: 'app', mode: 'file' }), /requires a `directory`/);
  const memory = openSqliteAdapter({ mode: 'memory' });
  try {
    assert.equal(memory.mode, 'memory');
    assert.equal(memory.root, null);
    assert.equal(memory.isManagedPath('/anything'), false);
  } finally {
    memory.close();
  }
  const viaMemory = openMemoryAdapter();
  viaMemory.close();
});

test('an existing owned directory is tightened to 0o700 at open (explicit chmod policy)', () => {
  const base = tempRoot();
  try {
    const loose = path.join(base, 'loose');
    mkdirSync(loose, { recursive: true, mode: 0o755 });
    const opened = openSqliteAdapter({ directory: loose, name: 'app' });
    try {
      assert.equal(statSync(loose).mode & 0o777, 0o700, 'a pre-existing loose root is tightened to 0o700');
      for (const sub of MANAGED_SUBDIRECTORIES) {
        assert.equal(statSync(path.join(loose, sub)).mode & 0o777, 0o700, `${sub}/ is 0o700`);
      }
    } finally {
      opened.close();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('close() releases the ownership lock so a second adapter can open', () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  try {
    const first = openSqliteAdapter({ directory: dir, name: 'app' });
    // A second open in the same process is refused while the lock is held.
    assert.throws(() => openSqliteAdapter({ directory: dir, name: 'app' }), /WB_DB_OWNED/);
    first.close();
    const second = openSqliteAdapter({ directory: dir, name: 'app' });
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adapter surface includes the managed-path predicate over the owned root', () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      assert.equal(opened.isManagedPath(dir), true, 'the owned root itself');
      assert.equal(opened.isManagedPath(path.join(dir, SQLITE_DATA_FILENAME)), true, 'db file');
      assert.equal(opened.isManagedPath(path.join(dir, SQLITE_LOCK_FILENAME)), true, 'lock sidecar');
      for (const sub of MANAGED_SUBDIRECTORIES) {
        assert.equal(opened.isManagedPath(path.join(dir, sub)), true, `${sub}/`);
      }
      assert.equal(opened.isManagedPath(path.join(dir, 'backups', 'x.bak')), true, 'nested protected');
      assert.equal(opened.isManagedPath(path.join(root, 'elsewhere')), false, 'outside the root');
      assert.equal(opened.isManagedPath('/etc'), false, 'unrelated path');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the owned directory reflects a sensible derived physical layout', () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'myapp', mode: 'file' });
    try {
      const entries = readdirSync(dir);
      assert.ok(entries.includes(SQLITE_DATA_FILENAME), 'data.sqlite present');
      assert.ok(entries.includes(SQLITE_LOCK_FILENAME), 'lock.sqlite present');
      // The physical db filename is never exposed on the surface.
      assert.equal('dbFile' in opened, false);
      assert.equal('filename' in opened, false);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the WAL starvation guard checkpoints an oversized WAL, tolerates a busy reader, and its timer dies with close()', () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  mock.timers.enable({ apis: ['setInterval'] });
  let prevClearInterval = null;
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    const walFile = path.join(dir, SQLITE_DATA_FILENAME + '-wal');
    const dbFile = path.join(dir, SQLITE_DATA_FILENAME);
    opened.handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    // Under the threshold a tick must not checkpoint: the main db file is
    // untouched while the small write sits in the WAL.
    opened.handle.exec("INSERT INTO t (v) VALUES ('small')");
    const dbBytesBefore = statSync(dbFile).size;
    mock.timers.tick(WAL_GUARD_INTERVAL_MS);
    assert.equal(statSync(dbFile).size, dbBytesBefore, 'tick under the threshold is a no-op');

    // Starve the WAL the way the read mirror does: a reader holding an old
    // snapshot while the WAL outgrows the guard threshold.
    const reader = new DatabaseSync(dbFile, { readOnly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM t').get();
    const payload = 'x'.repeat(64 * 1024);
    const insert = opened.handle.prepare('INSERT INTO t (v) VALUES (?)');
    opened.handle.exec('BEGIN');
    for (let i = 0; i < Math.ceil((WAL_GUARD_SIZE_THRESHOLD_BYTES * 1.25) / payload.length); i++) {
      insert.run(payload);
    }
    opened.handle.exec('COMMIT');
    assert.ok(statSync(walFile).size > WAL_GUARD_SIZE_THRESHOLD_BYTES, '-wal outgrew the threshold');

    // Busy tick: the pinned reader must be swallowed without throwing, without
    // stalling (the guard checkpoints with busy_timeout 0), and without
    // draining the WAL into the main db.
    const busyTickStarted = Date.now();
    assert.doesNotThrow(() => mock.timers.tick(WAL_GUARD_INTERVAL_MS), 'busy tick does not throw');
    assert.ok(Date.now() - busyTickStarted < 2000, 'busy tick does not honor the 5s busy_timeout');
    assert.ok(statSync(dbFile).size < WAL_GUARD_SIZE_THRESHOLD_BYTES, 'busy tick did not drain the WAL');
    reader.exec('COMMIT');
    reader.close();

    // Success tick: with the reader gone, the guard's checkpoint drains the
    // WAL into the main db and a probe RESTART reports the WAL un-pinned.
    mock.timers.tick(WAL_GUARD_INTERVAL_MS);
    assert.ok(statSync(dbFile).size > WAL_GUARD_SIZE_THRESHOLD_BYTES, 'guard checkpoint drained the WAL');
    opened.handle.exec('PRAGMA busy_timeout = 0');
    const probe = opened.handle.prepare('PRAGMA wal_checkpoint(RESTART)').get();
    opened.handle.exec('PRAGMA busy_timeout = 5000');
    assert.equal(probe.busy, 0, 'WAL is no longer pinned after the guard checkpoint');

    // The guard timer is cleared on close and never fires against a closed db.
    prevClearInterval = globalThis.clearInterval;
    let cleared = false;
    globalThis.clearInterval = (...args) => {
      cleared = true;
      return prevClearInterval(...args);
    };
    opened.close();
    globalThis.clearInterval = prevClearInterval;
    prevClearInterval = null;
    assert.ok(cleared, 'close() cleared the guard interval');
    assert.doesNotThrow(() => mock.timers.tick(WAL_GUARD_INTERVAL_MS), 'no guard tick after close');
  } finally {
    if (prevClearInterval) globalThis.clearInterval = prevClearInterval;
    mock.timers.reset();
    rmSync(root, { recursive: true, force: true });
  }
});
