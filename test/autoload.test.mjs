// req.doc auto-loading: an entity-bound builder mounting a `:<entity>Id`
// subtree auto-loads the parent row onto req.<entity> for every descendant
// route. A missing parent row is a 404 (the resource the handler operates on
// does not exist), not an opaque 500 from a null deref.

import { text, ref, map, grant, read, write, scope, allowAnonymous as _allowAnonymous } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, generateDDL } from '../build/internal.mjs';

function makeDoc() {
  return entity('Doc', {
        title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    collaborators: map(ref('User'), { role: ['viewer', 'editor'] }),

    grant: () => grant(read, write),
    routes: (r) => {
      r.resource();
      // A child router under /:docId/shares — req.doc is auto-loaded.
      const shares = workbench.router();
      shares.get('/', async (req, res) => {
        res.json({ docId: req.doc.id, title: req.doc.title });
      });
      r.mount('/:docId/shares', shares);
    },
  });
}

test('req.doc is auto-loaded for a route under /:docId', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  const Doc = makeDoc();
  for (const sql of generateDDL(Doc)) db.exec(sql);
  db.prepare("INSERT INTO Doc (id, title, owner) VALUES (1, 'Hello', 1)").run();

  const app = workbench({ db }).mount('/docs', Doc);
  app.listen(0, { principalOf: () => ({ type: 'user', id: '1' }) });
  await app.ready;
  const { port } = app.httpServer.address();

  const r = await fetch(`http://127.0.0.1:${port}/docs/1/shares`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.docId, '1');
  assert.equal(body.title, 'Hello');

  app.httpServer.close();
});

test('a missing parent row is 404, not a null-deref 500', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  const Doc = makeDoc();
  for (const sql of generateDDL(Doc)) db.exec(sql);

  const app = workbench({ db }).mount('/docs', Doc);
  app.listen(0, { principalOf: () => ({ type: 'user', id: '1' }) });
  await app.ready;
  const { port } = app.httpServer.address();

  const r = await fetch(`http://127.0.0.1:${port}/docs/999/shares`);
  assert.equal(r.status, 404);

  app.httpServer.close();
});

test('a generic router :userId param does NOT auto-load (no entity context)', async () => {
  // The share delete route uses :userId; it is declared in a GENERIC router, so
  // no auto-load fires and req.user is undefined. The handler reads the raw param.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  const Doc = entity('Doc', {
        title: text(), owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => grant(read, write),
    routes: (r) => {
      r.resource();
      const shares = workbench.router();
      shares.delete('/:userId', async (req, res) => {
        // req.user is NOT auto-loaded (generic router) — only req.doc is.
        assert.equal(req.user, undefined);
        res.sendStatus(204);
      });
      r.mount('/:docId/shares', shares);
    },
  });
  for (const sql of generateDDL(Doc)) db.exec(sql);
  db.prepare("INSERT INTO Doc (id, title, owner) VALUES (1, 'Hello', 1)").run();

  const app = workbench({ db }).mount('/docs', Doc);
  app.listen(0, { principalOf: () => ({ type: 'user', id: '1' }) });
  await app.ready;
  const { port } = app.httpServer.address();

  const r = await fetch(`http://127.0.0.1:${port}/docs/1/shares/42`, { method: 'DELETE' });
  assert.equal(r.status, 204);

  app.httpServer.close();
});

// H1: auto-load used the UNSCOPED trusted query API (findById), so a principal
// who cannot read the parent row still got it as req.<entity> — a read-scope
// bypass reachable from every imperative child route. Auto-load must run the
// row through the SAME authorizeRead admission path that snapshot/events-since
// use (bindReadScope + mayVerb('read')): out-of-scope = 404 (no existence leak),
// in-scope-but-denied = 403, and the handler never runs for an admitted row.
function makeDocScoped() {
  return entity('Doc', {
        title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    collaborators: map(ref('User'), { role: ['viewer', 'editor'] }),

    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read, write))],
    routes: (r) => {
      r.resource();
      const shares = workbench.router();
      shares.get('/', async (req, res) => {
        // only reachable when auto-load admitted the row for THIS principal.
        res.json({ docId: req.doc.id, title: req.doc.title });
      });
      r.mount('/:docId/shares', shares);
    },
  });
}

async function bootScopedDoc() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  const Doc = makeDocScoped();
  for (const sql of generateDDL(Doc)) db.exec(sql);
  db.prepare("INSERT INTO Doc (id, title, owner) VALUES (1, 'Hello', 'alice')").run();
  const app = workbench({ db }).mount('/docs', Doc);
  // principalOf from the x-test-user header so alice and bob are distinguishable.
  app.listen(0, {
    principalOf: (req) => {
      const id = req.headers['x-test-user'];
      return id ? { type: 'user', id } : { type: 'anonymous', id: null };
    },
  });
  await app.ready;
  return { port: app.httpServer.address().port, app };
}

test('auto-load admits the parent row only to a principal whose read-scope includes it', async () => {
  const { port, app } = await bootScopedDoc();
  try {
    // alice owns the doc → in scope → handler runs.
    const ok = await fetch(`http://127.0.0.1:${port}/docs/1/shares`, { headers: { 'x-test-user': 'alice' } });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.docId, '1');
    assert.equal(okBody.title, 'Hello');
  } finally {
    app.httpServer.close();
  }
});

test('auto-load DENIES a principal whose read-scope excludes the row (404, handler skipped)', async () => {
  const { port, app } = await bootScopedDoc();
  try {
    // bob is NOT the owner → read-scope `owner = :principalId` excludes the row
    // → 404 (out of scope = "not found", no existence leak) and the /shares
    // handler must NOT run (its body would carry docId).
    const denied = await fetch(`http://127.0.0.1:${port}/docs/1/shares`, { headers: { 'x-test-user': 'bob' } });
    assert.equal(denied.status, 404);
    const body = await denied.json();
    assert.equal(body.docId, undefined, 'handler must not run for an unadmitted row');
  } finally {
    app.httpServer.close();
  }
});
