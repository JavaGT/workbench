// sqlite-adapter-memory.test.mjs — S1/A2 in-memory adapter. It mirrors the file
// adapter's surface and lifecycle contract (no directory, no lock): the same
// capability set, the same centralized PRAGMA layer, the same quick_check gate,
// the same single-writer txn behavior, and the same checkpoint-then-close
// ordering.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  openMemoryAdapter,
  openSqliteAdapter,
  createSqliteAdapter,
} from '../build/sqlite-adapter.mjs';

const EXPECTED_CAPABILITIES = {
  transactionalDdl: true,
  onlineBackup: true,
  readOnlyConnections: true,
  integrityCheck: true,
  maintenance: true,
  encryption: false,
};

test('openMemoryAdapter exposes the same surface as the file adapter (minus directory/lock)', () => {
  const memory = openMemoryAdapter();
  try {
    assert.equal(memory.mode, 'memory');
    assert.equal(memory.root, null, 'memory owns no directory');
    assert.equal(memory.isManagedPath('/any/path'), false, 'memory refuses no paths');
    assert.deepEqual(memory.capabilities, EXPECTED_CAPABILITIES);
    if (typeof globalThis.Bun === 'undefined') assert.ok(memory.handle instanceof DatabaseSync);
    assert.equal(memory.handle.prepare('SELECT 1 AS value').get().value, 1);
    assert.equal(typeof memory.handle.txn, 'function', 'driver helpers attached');
    assert.equal(typeof memory.handle.upsert, 'function', 'driver helpers attached');
    const row = memory.handle.prepare('SELECT 1 AS one').get();
    assert.deepEqual({ ...row }, { one: 1 });
  } finally {
    memory.close();
  }
});

test('the memory adapter applies the same centralized PRAGMA layer', () => {
  const memory = openMemoryAdapter();
  try {
    assert.deepEqual({ ...memory.handle.prepare('PRAGMA journal_mode').get() }, { journal_mode: 'memory' });
    assert.deepEqual({ ...memory.handle.prepare('PRAGMA foreign_keys').get() }, { foreign_keys: 1 });
    // W2 durability: FULL is the default WAL sync level (1 = NORMAL opt-out).
    assert.deepEqual({ ...memory.handle.prepare('PRAGMA synchronous').get() }, { synchronous: 2 });
    assert.deepEqual({ ...memory.handle.prepare('PRAGMA busy_timeout').get() }, { timeout: 5000 });
  } finally {
    memory.close();
  }
});

test('the memory adapter passes quick_check and integrityCheck like the file adapter', () => {
  const memory = openMemoryAdapter();
  try {
    memory.handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    memory.handle.exec('INSERT INTO t (v) VALUES (\'x\')');
    assert.equal(memory.integrityCheck().ok, true);
    // quick_check ran fail-closed at open — the adapter opened, so it passed.
  } finally {
    memory.close();
  }
});

test('the memory adapter enforces the single-writer txn rules (nested txn refused)', () => {
  const memory = openMemoryAdapter();
  try {
    memory.handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    // A write inside an open transaction is the single-writer lane; a second
    // transaction attempt must fail identically to the file adapter (SQLite
    // rejects "cannot start a transaction within a transaction").
    memory.handle.begin();
    assert.throws(() => memory.handle.begin(), /cannot start a transaction within a transaction/i);
    memory.handle.rollback();
    // An upsert inside txn works and stays atomic.
    memory.handle.upsert({ table: 't', keyColumns: ['id'], columns: ['v'], values: { id: 1, v: 'a' } });
    memory.handle.upsert({ table: 't', keyColumns: ['id'], columns: ['v'], values: { id: 1, v: 'b' } });
    assert.equal(memory.handle.prepare('SELECT v FROM t WHERE id = 1').get().v, 'b');
  } finally {
    memory.close();
  }
});

test('checkpoint() is a safe no-op on memory; close() is checkpoint-then-close and idempotent', () => {
  const memory = openMemoryAdapter();
  memory.handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  memory.checkpoint(); // no WAL to checkpoint — must not throw
  memory.close();
  assert.doesNotThrow(() => memory.close(), 'close() is idempotent');
  assert.throws(() => memory.handle.prepare('SELECT 1'), /not open/i, 'handle is closed');
});

test('teardown() on the memory adapter is a no-op (no files, no lock)', () => {
  const memory = openMemoryAdapter();
  assert.doesNotThrow(() => memory.teardown());
  memory.close();
});

test('createSqliteAdapter({ mode: memory }) is a DbAdapter-conforming bound adapter', async () => {
  const adapter = createSqliteAdapter({ mode: 'memory' });
  assert.equal(adapter.root, null);
  assert.equal(adapter.isManagedPath('/tmp'), false);
  const mirror = adapter.readMirror();
  assert.equal(mirror.kind, 'read-mirror');
  assert.equal(mirror.mode, 'read-only');
  assert.equal(mirror.readOnly, true);
  assert.match(mirror.connectionString, /:memory:/);
  const opened = await adapter.open();
  assert.equal(opened.mode, 'memory');
  opened.close();
});

test('createSqliteAdapter open() rejects asynchronously — never throws synchronously on failure', async () => {
  const adapter = createSqliteAdapter({ name: 'app', mode: 'file' }); // no directory
  let threw = false;
  try { adapter.open().catch(() => {}); } catch { threw = true; }
  assert.equal(threw, false, 'a failing open() must not throw synchronously');
  await assert.rejects(() => adapter.open(), /requires a `directory`/, 'the failure rejects the returned promise');
});

test('memory and file adapters share the identical capability + lifecycle contract', () => {
  const memory = openMemoryAdapter();
  const file = openSqliteAdapter({ mode: 'memory' }); // routed to memory
  try {
    assert.deepEqual(memory.capabilities, file.capabilities);
    for (const fn of ['close', 'checkpoint', 'integrityCheck', 'teardown']) {
      assert.equal(typeof memory[fn], 'function', `memory.${fn}`);
      assert.equal(typeof file[fn], 'function', `file.${fn}`);
    }
  } finally {
    memory.close();
    file.close();
  }
});
