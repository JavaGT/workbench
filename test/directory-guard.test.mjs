// directory-guard.test.mjs — S1/A2 managed-path guard. The adapter's owned
// directory (db file, -wal/-shm, lock sidecar, blobs/, staging/, backups/,
// quarantine/, recycle/) must never be served by static-file serving and must
// never overlap the blob store root — in either direction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openSqliteAdapter, SQLITE_DATA_FILENAME } from '../build/sqlite-adapter.mjs';
import { serveStatic } from '../build/views.mjs';
import workbench from '../build/internal.mjs';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'wb-directory-guard-'));
}

function mockRes() {
  return {
    headersSent: false,
    status: null,
    body: null,
    writeHead(s) { this.status = s; this.headersSent = true; },
    end(b) { this.body = b; },
  };
}

test('serveStatic refuses files under the owned directory (managed paths are never served)', () => {
  const root = tempRoot();
  const owned = path.join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: owned, name: 'app' });
    try {
      // The owned directory genuinely contains servable-looking content; the
      // guard must refuse it regardless.
      writeFileSync(path.join(owned, 'index.html'), '<h1>managed</h1>');
      const handler = serveStatic(owned, { prefix: '/public', isManagedPath: opened.isManagedPath });

      // Direct request for a managed file → 404 (fail closed).
      const res = mockRes();
      handler({ params: { path: 'index.html' }, url: '/public/index.html' }, res, null);
      assert.equal(res.status, 404);
      assert.deepEqual(JSON.parse(res.body), {
        ok: false,
        failure: { category: 'not-found', message: 'not found' },
      });

      // Even the db file itself is refused.
      const dbRes = mockRes();
      handler({ params: { path: SQLITE_DATA_FILENAME }, url: '/public/' + SQLITE_DATA_FILENAME }, dbRes, null);
      assert.equal(dbRes.status, 404);

      // With a `next`, refusal falls through like an unsafe path.
      let nextCalled = false;
      const nextRes = mockRes();
      handler({ params: { path: 'index.html' }, url: '/public/index.html' }, nextRes, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
      assert.equal(nextRes.status, null);

      // A path that RESOLVES into the owned dir from a parent root is refused too.
      const parentHandler = serveStatic(root, { prefix: '/', isManagedPath: opened.isManagedPath });
      const traversalRes = mockRes();
      parentHandler({ params: { path: 'owned/index.html' }, url: '/owned/index.html' }, traversalRes, null);
      assert.equal(traversalRes.status, 404);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serveStatic without the guard keeps its existing behavior (no managed refusal)', () => {
  const root = tempRoot();
  const owned = path.join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: owned, name: 'app' });
    try {
      writeFileSync(path.join(owned, 'plain.txt'), 'plain');
      const handler = serveStatic(owned, { prefix: '/public' });
      const res = mockRes();
      handler({ params: { path: 'plain.txt' }, url: '/public/plain.txt' }, res, null);
      assert.equal(res.status, 200);
      assert.equal(String(res.body), 'plain');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serveStatic refuses a symlink from an allowed static dir into the owned directory', () => {
  const root = tempRoot();
  const owned = path.join(root, 'owned');
  const staticDir = path.join(root, 'public');
  try {
    const opened = openSqliteAdapter({ directory: owned, name: 'app' });
    try {
      mkdirSync(staticDir, { recursive: true });
      writeFileSync(path.join(owned, 'index.html'), '<h1>managed</h1>');
      // A symlink INSIDE the allowed static root pointing into the owned
      // directory must not bypass the managed-path guard.
      symlinkSync(path.join(owned, 'index.html'), path.join(staticDir, 'index.html'));
      const handler = serveStatic(staticDir, { prefix: '/public', isManagedPath: opened.isManagedPath });
      const res = mockRes();
      handler({ params: { path: 'index.html' }, url: '/public/index.html' }, res, null);
      assert.equal(res.status, 404, 'a symlinked managed file is refused');
      const ok = mockRes();
      writeFileSync(path.join(staticDir, 'plain.txt'), 'plain');
      handler({ params: { path: 'plain.txt' }, url: '/public/plain.txt' }, ok, null);
      assert.equal(ok.status, 200, 'a genuinely-static sibling file still serves');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workbench refuses a blobs.root that overlaps the owned directory (both directions)', async () => {
  const root = tempRoot();
  const owned = path.join(root, 'owned');
  const sibling = path.join(root, 'sibling');
  try {
    // blobs.root == owned directory → refused.
    assert.throws(
      () => workbench({ db: { directory: owned, name: 'app', mode: 'file' }, blobs: { root: owned } }),
      /overlaps the database-owned directory/,
    );
    // blobs.root inside the owned directory → refused.
    assert.throws(
      () => workbench({ db: { directory: owned, name: 'app', mode: 'file' }, blobs: { root: path.join(owned, 'uploads') } }),
      /overlaps the database-owned directory/,
    );
    // Vice versa: the owned directory inside the blob root → refused.
    assert.throws(
      () => workbench({ db: { directory: owned, name: 'app', mode: 'file' }, blobs: { root } }),
      /overlaps the database-owned directory/,
    );
    // A sibling, non-overlapping root is accepted.
    const ok = workbench({ db: { directory: owned, name: 'app', mode: 'file' }, blobs: { root: sibling } });
    assert.ok(ok.blobs, 'blob store constructed');
    // The retired pathFor survives as the explicit internal/test handle; an
    // explicit root keeps the legacy single-root layout (<root>/<id>.pending).
    assert.equal(ok.blobs._pathFor('any-id', { pending: true }).startsWith(sibling), true);
    await ok.shutdown();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file-mode database roots the default blob store under the owned blobs/ + staging/ directories', async () => {
  const base = tempRoot();
  const previous = process.cwd();
  process.chdir(base);
  try {
    // S6/A2 relocation: with no blob config, the default byte root is ALWAYS
    // the owned directory's managed `blobs/` subdirectory (final) with
    // `staging/` for pending slots — never the retired cwd/.blobs default. The
    // guarantee is "inside the adapter-owned directory when one exists"; here
    // the owned directory IS the (relative) cwd, so the managed subdirectories
    // land at cwd/blobs + cwd/staging — the owned root, not an unrelated
    // cwd/.blobs default.
    const app = workbench({ db: { directory: '.', name: 'app', mode: 'file' } });
    assert.ok(app.blobs, 'blob store constructed');
    const finalPath = path.resolve(app.blobs._pathFor('any-id'));
    const pendingPath = path.resolve(app.blobs._pathFor('any-id', { pending: true }));
    // process.cwd() returns the REAL (symlink-resolved) cwd after chdir, so it
    // is the right anchor for the resolved blob paths.
    assert.equal(
      finalPath.startsWith(path.join(process.cwd(), 'blobs')),
      true,
      'the default blob root is the owned directory\'s managed blobs/ dir',
    );
    assert.equal(
      pendingPath.startsWith(path.join(process.cwd(), 'staging')),
      true,
      'pending slots stage in the owned directory\'s managed staging/ dir',
    );
    await app.shutdown();
  } finally {
    process.chdir(previous);
    rmSync(base, { recursive: true, force: true });
  }
});

test('workbench wires the managed-path guard into app.static', async () => {
  const root = tempRoot();
  const owned = path.join(root, 'owned');
  const staticDir = path.join(root, 'public');
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(path.join(staticDir, 'app.js'), 'console.log(1)', 'utf-8');
  try {
    // Non-overlapping static root still serves its own files.
    const app = workbench({ db: { directory: owned, name: 'app', mode: 'file' } })
      .static('/public', staticDir)
      .listen(0);
    await app.ready;
    const port = app.httpServer.address().port;
    const served = await fetch(`http://127.0.0.1:${port}/public/app.js`);
    assert.equal(served.status, 200);
    assert.equal(await served.text(), 'console.log(1)');
    // Release the adapter (checkpoint + close + ownership lock) before a second
    // app opens the same owned directory.
    await app.shutdown();

    // The owned directory contains a served-name file; app.static must refuse it.
    writeFileSync(path.join(owned, 'app.js'), 'managed-content', 'utf-8');

    // A static root that IS the owned directory refuses everything in it.
    const guardedApp = workbench({ db: { directory: owned, name: 'app', mode: 'file' } })
      .static('/public', owned)
      .listen(0);
    await guardedApp.ready;
    const guardedPort = guardedApp.httpServer.address().port;
    const refused = await fetch(`http://127.0.0.1:${guardedPort}/public/app.js`);
    assert.equal(refused.status, 404, 'a managed path is never served');
    const dbFileRefused = await fetch(`http://127.0.0.1:${guardedPort}/public/${SQLITE_DATA_FILENAME}`);
    assert.equal(dbFileRefused.status, 404, 'the db file is never served');
    await guardedApp.shutdown();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
