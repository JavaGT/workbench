// db-adapter-app.test.mjs — workbench({ db }) accepts a conforming DbAdapter
// (S1/A1 contract): the app defers the async open() to the first boot boundary
// (app.ready / prepareSchema / start) and installs the wrapped handle plus the
// handle-bound resources. A DbAdapter must never reach wrapDriver as though it
// were a raw handle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { entity, text, ref, grant, read, write, subscribe, scope } from '../build/index.mjs';
import { createSqliteAdapter } from '../build/sqlite-adapter.mjs';
import workbench from '../build/internal.mjs';
import { SQLITE_RUNTIME } from '../build/sqlite-driver.mjs';

function assertOpenHandle(db) {
  if (SQLITE_RUNTIME === 'node') assert.ok(db instanceof DatabaseSync);
  assert.equal(db.prepare('SELECT 1 AS value').get().value, 1);
}

// A minimal owned entity (the note.mjs floor), used to confirm a db accepted as
// a conforming adapter yields a working app whose entity table is created.
function makeNote() {
  return entity('Note', {
        body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

test('workbench({ db: adapter }) defers the open and installs the handle at prepareSchema', async () => {
  const app = workbench({ db: createSqliteAdapter({ mode: 'memory' }) }).mount('/notes', makeNote());
  assert.equal(app.db, null, 'no handle before the deferred open completes');
  await app.prepareSchema();
  assertOpenHandle(app.db);
  const row = app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Note'").get();
  assert.ok(row, 'the entity table exists in the adapter-opened db');
  await app.shutdown();
});

test('awaiting app.ready resolves the deferred open before listen()', async () => {
  const app = workbench({ db: createSqliteAdapter({ mode: 'memory' }) });
  assert.equal(app.db, null);
  await app.ready;
  assertOpenHandle(app.db);
  await app.shutdown();
});

test('an adapter-backed app starts headless and shutdown closes the adapter', async () => {
  const app = workbench({ db: createSqliteAdapter({ mode: 'memory' }) }).mount('/notes', makeNote());
  await app.start();
  assertOpenHandle(app.db);
  assert.equal(
    app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Note'").get() != null,
    true,
    'schema prepared during start',
  );
  await app.shutdown();
  assert.throws(() => app.db.prepare('SELECT 1'), /not open/i, 'the adapter was closed on shutdown');
});

test('workbench refuses a DbAdapter opened database whose open() rejects', async () => {
  const failing = {
    // Memory-mode adapter (A1 contract): declares root: null so the app does
    // not fail closed on the missing owned-directory declaration.
    root: null,
    readMirror() {
      return { kind: 'read-mirror', mode: 'read-only', readOnly: true, connectionString: 'file::memory:?mode=ro' };
    },
    open() {
      return Promise.reject(new Error('adapter open failed (stub)'));
    },
  };
  const app = workbench({ db: failing });
  await assert.rejects(() => app.ready, /adapter open failed \(stub\)/, 'an open failure rejects app.ready');
  await assert.rejects(() => app.prepareSchema(), /adapter open failed \(stub\)/);
});
