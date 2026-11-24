// w5-durability-writers.test.mjs — Wave 1 durability lane: single-writer holes,
// honest log retention, recovery integrity, and non-blocking Bun backups.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import workbench from '../build/app.mjs';
import { durableHistory } from '../build/index.mjs';
import { createServer, executeFrameworkDDL } from '../build/internal.mjs';
import { retentionPrune } from '../build/committed-log.mjs';
import { createPostCommitEffectRunner, replayPrivateFactProjections } from '../build/post-commit-effects.mjs';
import { backupDatabaseViaVacuum, openSqliteDatabase } from '../build/sqlite-driver.mjs';
import { createRecoveryManager } from '../build/recovery.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { createBackupManager } from '../build/backup.mjs';
import { openSqliteAdapter } from '../build/sqlite-adapter.mjs';
import { hashSessionToken } from '../build/auth/session.mjs';
import { serializeV16OperatedEvent, v16AdmissionNonce } from '../build/annotated-text-operated-event.mjs';

const principal = Object.freeze({ type: 'user', id: 'u1', attributes: {} });

function tempRoot(prefix = 'wb-w5-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function countingCoordinator() {
  let calls = 0;
  return {
    get calls() { return calls; },
    run(fn) { calls += 1; return Promise.resolve().then(fn); },
    close() { return Promise.resolve(); },
    depth: 0,
    running: false,
    closed: false,
    owned: false,
  };
}

// ---- 1. single-writer SQLite holes ----------------------------------------

test('auth route write transactions enter the attached write coordinator', async (t) => {
  const app = workbench({ db: ':memory:' }).auth();
  app.listen(0);
  await app.ready;
  t.after(async () => {
    if (app.httpServer?.listening) await new Promise((resolve) => app.httpServer.close(resolve));
    await app.shutdown();
  });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const registered = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'reset-user', password: 'initialpass1' }),
  });
  assert.equal(registered.status, 201);

  const userId = app.db.prepare('SELECT id FROM User WHERE username = ?').get('reset-user').id;
  const token = 'w5-reset-token-0123456789abcdef';
  app.db.exec(`CREATE TABLE IF NOT EXISTS _PasswordResetToken (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE,
    expiresAt INTEGER NOT NULL, usedAt INTEGER, createdAt INTEGER NOT NULL)`);
  app.db.prepare(
    'INSERT INTO _PasswordResetToken (id, userId, tokenHash, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, ?, NULL, ?)',
  ).run('reset-1', userId, hashSessionToken(token), Date.now() + 60_000, Date.now());

  const originalRun = app.writeQueue.run.bind(app.writeQueue);
  let coordinated = 0;
  app.writeQueue.run = (fn) => {
    coordinated += 1;
    return originalRun(fn);
  };

  const confirmed = await fetch(`${origin}/auth/password-reset/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, newPassword: 'brandnewpass1' }),
  });
  assert.equal(confirmed.status, 204);
  assert.ok(coordinated >= 1, 'the reset-confirm write transaction went through the platform coordinator');
  assert.equal(app.db.prepare('SELECT usedAt FROM _PasswordResetToken WHERE id = ?').get('reset-1').usedAt !== null, true);
});

test('no-op undo/redo receipts are committed through the write coordinator', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const coordinator = countingCoordinator();
  const history = durableHistory({ authorize: () => true, actions: {} });
  const server = createServer({ db, history, authorize: () => true, writeQueue: coordinator });
  const args = { scope: 'Document:1', principal, session: 'tab-a' };
  const cursor = await server.history.cursor(args);

  const before = coordinator.calls;
  const undo = await server.history.undo({ actionId: 'noop-undo', ...args, revision: cursor.revision });
  assert.equal(undo.empty, true, 'an empty cursor produces the $history.empty receipt');
  assert.ok(coordinator.calls > before, 'the no-op undo txn was routed through the coordinator');

  const afterUndo = coordinator.calls;
  const redo = await server.history.redo({ actionId: 'noop-redo', ...args, revision: cursor.revision });
  assert.equal(redo.empty, true);
  assert.ok(coordinator.calls > afterUndo, 'the no-op redo txn was routed through the coordinator');
  db.close();
});

test('post-commit runner writes defer while a foreign coordinated turn is in flight', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const coordinator = countingCoordinator();
  createServer({ db, authorize: () => true, writeQueue: coordinator });
  const runner = createPostCommitEffectRunner({ db });

  // A kernel BEGIN IMMEDIATE turn is in flight: the runner must not write into
  // it. It queues through the same coordinator and returns a Promise.
  coordinator.running = true;
  const deferred = runner.claim('w1');
  assert.equal(typeof deferred.then, 'function', 'contended claim is deferred');
  assert.equal(coordinator.calls, 1);
  assert.equal(await deferred, null);

  // Inside an owned turn the write is already serialized — no extra queueing.
  coordinator.owned = true;
  const nested = runner.claim('w2');
  assert.equal(nested, null, 'nested claim joins the current turn synchronously');
  assert.equal(coordinator.calls, 1);

  // Idle and standalone callers keep the historical synchronous return shape.
  coordinator.owned = false;
  coordinator.running = false;
  assert.equal(runner.claim('w3'), null);
  assert.equal(coordinator.calls, 1, 'an uncontended write does not need a turn');
  db.close();
});

test('replay invokes only explicitly private-fact projections', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const committedAt = '2026-01-01T00:00:00.000Z';
  db.prepare(
    'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('project:a', 1, 'Item.changed', JSON.stringify({ id: 'i1' }), 'a1', committedAt);
  db.prepare(
    `INSERT INTO _ActionReceipt
       (scope, actionId, committedAt, eventRefs, historyOrder, actionType, actionData)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('project:a', 'a1', committedAt, JSON.stringify([{ scope: 'project:a', seq: 1 }]), 1, 'item.set', '{}');
  db.prepare(
    'INSERT INTO _PrivateActionFact (scope, actionId, committedAt, fact, effects, originOrder) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('project:a', 'a1', committedAt, '{"before":{},"after":{}}', '[]', 1);

  let genericCalls = 0;
  let privateCalls = 0;
  const result = replayPrivateFactProjections(db, [
    {
      eventTypes: ['Item.changed'],
      apply() { genericCalls += 1; },
    },
    {
      eventTypes: ['Item.changed'],
      privateFact: true,
      apply(_event, _db, context) {
        privateCalls += 1;
        assert.deepEqual(context.privateFact, { before: {}, after: {} });
      },
    },
  ]);
  assert.deepEqual(result, { projected: 1 });
  assert.equal(genericCalls, 0, 'a generic entity projection is never replayed');
  assert.equal(privateCalls, 1, 'the opted-in private projection runs exactly once');
  db.close();
});

// ---- 2. honest retention ---------------------------------------------------

test('retention never crosses a lagging consumer cursor and prunes obsolete v16 claims', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const old = '2020-01-01T00:00:00.000Z';
  const insertLog = db.prepare(
    'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const seq of [1, 2, 3]) insertLog.run('lagging', seq, 'Document.changed', '{}', `a${seq}`, old);
  for (const seq of [1, 2]) insertLog.run('caught-up', seq, 'Document.changed', '{}', `b${seq}`, old);
  db.prepare('INSERT INTO _ConsumerCursor (consumer, scope, lastSeq) VALUES (?, ?, ?)')
    .run('blob.finalize', 'lagging', 1);

  // A retained v16 log row keeps its one-shot claim; an obsolete one is pruned.
  const envelope = {
    version: 16,
    id: 'doc-1',
    before: { structuralRevision: 1, frontier: [] },
    after: { structuralRevision: 2, frontier: [] },
    operation: { kind: 'region.edit', from: 0, to: 0 },
    facts: {},
  };
  const canonical = serializeV16OperatedEvent(envelope);
  const liveNonce = v16AdmissionNonce({
    owningScope: 'v16', entity: 'ReplayDoc', field: 'body', documentId: 'doc-1', actionId: 'v16-a1',
  }, canonical);
  insertLog.run('v16', 1, 'ReplayDoc.body.operated', canonical, 'v16-a1', old);
  db.prepare('INSERT INTO _ConsumerCursor (consumer, scope, lastSeq) VALUES (?, ?, ?)').run('blob.finalize', 'v16', 0);
  const insertClaim = db.prepare('INSERT INTO _V16CapabilityClaim (nonce, document_id, bytes_digest) VALUES (?, ?, ?)');
  insertClaim.run(liveNonce, 'doc-1', 'digest');
  insertClaim.run('obsolete-nonce', 'gone', 'digest');

  await retentionPrune(db, '2021-01-01T00:00:00.000Z');

  const surviving = db.prepare('SELECT scope, seq FROM _Log ORDER BY scope, seq').all()
    .map((row) => `${row.scope}:${row.seq}`);
  assert.deepEqual(surviving, ['lagging:2', 'lagging:3', 'v16:1'], 'rows beyond a consumer cursor are retained');
  const nonces = db.prepare('SELECT nonce FROM _V16CapabilityClaim').all().map((row) => row.nonce);
  assert.deepEqual(nonces, [liveNonce], 'only the claim guarding a retained v16 row survives');
  db.close();
});

// ---- 3. recovery integrity -------------------------------------------------

test('orphan WAL/shm sidecars with no database file are recovery-required', () => {
  const root = tempRoot('wb-w5-recovery-');
  try {
    const queue = createWriteQueue();
    const manager = createRecoveryManager({ source: { root, writeCoordinator: queue }, writeCoordinator: queue });
    const wal = path.join(root, 'data.sqlite-wal');
    writeFileSync(wal, 'ORPHAN-WAL');
    const damaged = manager.probe();
    assert.equal(damaged.ok, false);
    assert.equal(damaged.state, 'recovery-required');
    assert.ok(damaged.findings.includes(wal), 'the orphan sidecar is reported');
    rmSync(wal);
    assert.equal(manager.probe().ok, true, 'a fresh owned directory is healthy again');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migration ledger object key order does not cause a false recovery mismatch', async () => {
  const root = tempRoot('wb-w5-ledger-');
  const dir = path.join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    let backup;
    try {
      opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)');
      opened.handle.prepare('INSERT INTO note (id, body) VALUES (?, ?)').run('n1', 'ledger-order');
      const queue = createWriteQueue();
      opened.writeCoordinator = queue;
      backup = await createBackupManager({ source: opened, writeCoordinator: queue }).backup();
    } finally {
      opened.close();
    }
    assert.equal(backup.ok, true);
    const manifestPath = path.join(dir, 'backups', backup.backupId, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const ledger = manifest.migrationLedgerState;
    manifest.migrationLedgerState = {
      maxVersion: ledger.maxVersion,
      appliedVersions: ledger.appliedVersions.map((entry) => ({ version: entry.version, namespace: entry.namespace })),
      table: ledger.table,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const queue = createWriteQueue();
    const recovered = await createRecoveryManager({
      source: { root: dir, writeCoordinator: queue },
      writeCoordinator: queue,
    }).recover({ backupId: backup.backupId });
    assert.equal(recovered.ok, true, 'a reordered ledger object is the same ledger');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 4. non-blocking Bun backup -------------------------------------------

test('file-backed VACUUM INTO uses a separate read-only source connection', async () => {
  const dir = tempRoot('wb-w5-vacuum-file-');
  const dest = path.join(dir, 'backup.sqlite');
  const source = openSqliteDatabase(path.join(dir, 'source.sqlite'));
  try {
    source.exec('CREATE TABLE seed (id INTEGER PRIMARY KEY, label TEXT)');
    source.prepare('INSERT INTO seed (label) VALUES (?)').run('committed-row');
    // Guard the live handle: if VACUUM ran on it, the backup would fail.
    const guarded = {
      get isOpen() { return source.isOpen; },
      location: () => source.location(),
      exec(sql) {
        if (sql.includes('VACUUM')) throw new Error('VACUUM ran on the live handle');
        return source.exec(sql);
      },
      prepare: (sql) => source.prepare(sql),
      close: () => source.close(),
    };
    assert.ok((await backupDatabaseViaVacuum(guarded, dest)) >= 1);
    const restored = openSqliteDatabase(dest, { readOnly: true });
    try {
      assert.equal(restored.prepare('SELECT label FROM seed WHERE id = 1').get().label, 'committed-row');
    } finally {
      restored.close();
    }
  } finally {
    source.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test(':memory: VACUUM INTO stays on the live handle and keeps atomic rename', async () => {
  const dir = tempRoot('wb-w5-vacuum-memory-');
  try {
    const source = openSqliteDatabase(':memory:');
    try {
      source.exec('CREATE TABLE seed (id INTEGER PRIMARY KEY, label TEXT)');
      source.prepare('INSERT INTO seed (label) VALUES (?)').run('memory-row');
      const dest = path.join(dir, "backup's.sqlite");
      assert.ok((await backupDatabaseViaVacuum(source, dest)) >= 1);
      const restored = openSqliteDatabase(dest, { readOnly: true });
      try {
        assert.equal(restored.prepare('SELECT label FROM seed WHERE id = 1').get().label, 'memory-row');
      } finally {
        restored.close();
      }
    } finally {
      source.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
