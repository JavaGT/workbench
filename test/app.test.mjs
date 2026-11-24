// Phase 1 — Todo C: the app resolution layer (SPEC §3, §4, §6.2).
//
// `workbench()` is the default export: a chainable app. `app.mount(path, Entity)`
// RECORDS a mount declaration; the entity's `routes:(r)=>...` thunk is NOT invoked
// eagerly. Resolution (including the possibly-async thunk) happens later at
// `app.resolveRoutes()` / `app.ready`. This two-phase design preserves the fluent
// `workbench().mount(...).mount(...).listen()` chain while allowing an entity's
// `routes` thunk to be async (e.g. a parent lazily dynamic-importing a child at
// wiring time to break a circular import). `listen` returns the app synchronously
// (chainable) and sets `app.httpServer` synchronously; full boot signals on
// `app.ready` (routes resolved AND server listening).
//
// The five CRUD verbs map to method+path like Express resource routes:
//   list   GET    /base
//   create POST   /base
//   read   GET    /base/:id
//   update PATCH  /base/:id
//   remove DELETE /base/:id

import { entity, text, ref, boolean, grant, read, write, subscribe, scope, allowAnonymous, requireUser as _requireUser, principal, anonymous } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import workbench, {
  router } from '../build/internal.mjs';

const user = principal({ type: 'user', id: 'user-1' });

// Resolve an app or router and return its resolved routing table.
async function resolved(surface) {
  await surface.resolveRoutes();
  return surface.routes;
}

// A minimal owned entity (the note.mjs floor). `routes` omitted → auto-CRUD.
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

// An entity that declares an explicit per-verb gate on the entity, next to grant.
function makePost() {
  return entity('Post', {
        title: text(),
    published: boolean({ default: false }),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
    // list is public (a published blog index); everything else is default-on.
    gate: { list: allowAnonymous() },
    routes: (r) => r.resource(),
  });
}

// --- the default export is a chainable app ---

test('workbench() returns a chainable app; mount and listen return the app', async () => {
  const app = workbench();
  assert.equal(typeof app.mount, 'function');
  assert.equal(typeof app.listen, 'function');
  const Note = makeNote();
  assert.equal(app.mount('/notes', Note), app, 'mount is chainable');
  // listen opens a real socket (Phase 2); use an ephemeral port and close it.
  assert.equal(app.listen(0), app, 'listen is chainable');
  await app.ready;
  app.httpServer.close();
});

// --- mounting an entity with omitted routes auto-CRUDs all five verbs ---

test('mounting an entity with no `routes` auto-CRUDs all five verbs, each default-on', async () => {
  const app = workbench().mount('/notes', makeNote());
  const routes = await resolved(app);
  const verbs = routes.map((r) => r.verb).sort();
  assert.deepEqual(verbs, ['create', 'list', 'read', 'remove', 'update']);
  // every auto-CRUD route is default-on: anonymous denied, user admitted.
  for (const route of routes) {
    assert.equal(route.gate(anonymous), false, `${route.verb} default-on`);
    assert.equal(route.gate(user), true, `${route.verb} admits a user`);
  }
});

// --- the routing table maps each verb to the right method + path ---

test('the routing table maps the five verbs to Express resource method+path', async () => {
  const app = workbench().mount('/notes', makeNote());
  const routes = await resolved(app);
  const byVerb = Object.fromEntries(routes.map((r) => [r.verb, r]));
  assert.equal(byVerb.list.method, 'GET');
  assert.equal(byVerb.list.path, '/notes');
  assert.equal(byVerb.create.method, 'POST');
  assert.equal(byVerb.create.path, '/notes');
  assert.equal(byVerb.read.method, 'GET');
  assert.equal(byVerb.read.path, '/notes/:id');
  assert.equal(byVerb.update.method, 'PATCH');
  assert.equal(byVerb.update.path, '/notes/:id');
  assert.equal(byVerb.remove.method, 'DELETE');
  assert.equal(byVerb.remove.path, '/notes/:id');
});

// --- each route carries its entity, so the dispatcher can reach the grant ---

test('each route entry carries the entity it was mounted for', async () => {
  const Note = makeNote();
  const app = workbench().mount('/notes', Note);
  const routes = await resolved(app);
  for (const route of routes) {
    assert.equal(route.entity, app.entity(Note));
  }
});

// --- the entity gate wires the per-verb gate into the table ---

test('entity gate relaxes only the named verb; other verbs stay default-on', async () => {
  const app = workbench().mount('/posts', makePost());
  const routes = await resolved(app);
  const byVerb = Object.fromEntries(routes.map((r) => [r.verb, r]));
  // list is relaxed: anonymous admitted to the list ROUTE
  assert.equal(byVerb.list.gate(anonymous), true);
  // create/read/update/remove stay default-on
  assert.equal(byVerb.create.gate(anonymous), false);
  assert.equal(byVerb.create.gate(user), true);
  assert.equal(byVerb.read.gate(anonymous), false);
  assert.equal(byVerb.update.gate(anonymous), false);
  assert.equal(byVerb.remove.gate(anonymous), false);
});

// --- mounting multiple entities accumulates their routes under their base paths ---

test('mounting two entities accumulates both route sets under their base paths', async () => {
  const app = workbench()
    .mount('/notes', makeNote())
    .mount('/posts', makePost());
  const routes = await resolved(app);
  const notePaths = routes.filter((r) => r.entity.name === 'Note').map((r) => r.path);
  const postPaths = routes.filter((r) => r.entity.name === 'Post').map((r) => r.path);
  assert.ok(notePaths.every((p) => p.startsWith('/notes')));
  assert.ok(postPaths.every((p) => p.startsWith('/posts')));
  assert.equal(routes.length, 10, 'two resources × five verbs');
});

// --- router() builds a mini-app mounted bare into a parent app ---

test('router({mergeParams}) builds a mini-app; app.mount(path, router) merges routes under the path', async () => {
  const r = router({ mergeParams: true });
  r.mount('/', makeNote());
  // resolution fills the router's own routing table
  await r.resolveRoutes();
  assert.equal(r.routes.length, 5);
  // mounting the router into a parent app re-bases every route under the mount path
  const app = workbench().mount('/docs/:docId/notes', r);
  const routes = await resolved(app);
  assert.equal(routes.length, 5);
  for (const route of routes) {
    assert.ok(route.path.startsWith('/docs/:docId/notes'), `re-based: ${route.path}`);
  }
});

test('router records mergeParams so a child can read a parent path param', () => {
  const r = router({ mergeParams: true });
  assert.equal(r.mergeParams, true);
  const plain = router();
  assert.equal(plain.mergeParams, false);
});

// --- Slice A: imperative router verbs build a SECOND route kind ---------------
//
// `r.get/post/patch/delete(path, ...handlers)` builds an imperative route: a
// shared spine { method, path, gate } plus a discriminated tail { handlers }
// (vs the entity tail { entity, verb }). The discriminant is structural — a
// route with `handlers` is imperative, a route with `entity`/`verb` is an entity
// CRUD route. Leading BRANDED gates peel off the front into `gate`; the rest is
// the handler chain (optional middleware then exactly one final handler). A route
// with no leading gate defaults to requireUser() (fail closed).
//
// Imperative declarations validate synchronously (a route with no handler throws
// at record time), but they are resolved into the concrete routing table
// asynchronously — one resolution pipeline, whether imperative or entity.

test('router exposes the four imperative verb methods', () => {
  const r = router();
  for (const verb of ['get', 'post', 'patch', 'delete']) {
    assert.equal(typeof r[verb], 'function', `r.${verb} is a function`);
  }
});

test('r.get(path, handler) builds an imperative route with method, path, handlers and a default gate', async () => {
  const handler = (req, res) => res.json({ ok: true });
  const r = router();
  assert.equal(r.get('/ping', handler), r, 'verb method is chainable');
  const routes = await resolved(r);
  assert.equal(routes.length, 1);
  const [route] = routes;
  assert.equal(route.method, 'GET');
  assert.equal(route.path, '/ping');
  // imperative tail: a handler chain, NOT an entity/verb tail
  assert.deepEqual(route.handlers, [handler]);
  assert.equal(route.entity, undefined);
  assert.equal(route.verb, undefined);
  // no leading gate => default-on (requireUser): anonymous denied, user admitted
  assert.equal(route.gate(anonymous), false);
  assert.equal(route.gate(user), true);
});

test('a leading allowAnonymous gate peels off into route.gate, leaving only the handler chain', async () => {
  const handler = (req, res) => res.json({});
  const r = router();
  r.post('/login', allowAnonymous(), handler);
  const routes = await resolved(r);
  const [route] = routes;
  assert.equal(route.gate(anonymous), true, 'allowAnonymous admits anonymous');
  assert.deepEqual(route.handlers, [handler], 'gate is peeled, not left in the chain');
});

test('leading middleware before the final handler stays in the chain; only branded gates peel', async () => {
  const mw = (req, res, next) => next();
  const handler = (req, res) => res.json({});
  const r = router();
  r.post('/x', allowAnonymous(), mw, handler);
  const routes = await resolved(r);
  const [route] = routes;
  // allowAnonymous peels (branded); the plain middleware does NOT peel and stays in order
  assert.deepEqual(route.handlers, [mw, handler]);
  assert.equal(route.gate(anonymous), true);
});

test('an imperative route with no handlers is rejected (a route must do something)', () => {
  const r = router();
  assert.throws(() => r.get('/nothing'), /handler/i);
  assert.throws(() => r.get('/nothing', allowAnonymous()), /handler/i);
});

test('the four verbs map to their HTTP methods', async () => {
  const h = (req, res) => res.json({});
  const r = router();
  r.get('/a', h);
  r.post('/b', h);
  r.patch('/c', h);
  r.delete('/d', h);
  const routes = await resolved(r);
  const byPath = Object.fromEntries(routes.map((rt) => [rt.path, rt.method]));
  assert.deepEqual(byPath, { '/a': 'GET', '/b': 'POST', '/c': 'PATCH', '/d': 'DELETE' });
});

// --- Slice A: app.mount(path, router) mounts an imperative router --------------
//
// `mount` is the single mount operation for both routers and entities.
// Re-basing carries the imperative `handlers` tail through unchanged.

test('app.mount re-bases a mounted router under the path', async () => {
  const app = workbench();
  assert.equal(typeof app.use, 'function');
  const r = router();
  const handler = (req, res) => res.json({});
  r.post('/', allowAnonymous(), handler);
  app.mount('/sessions', r);
  const routes = await resolved(app);
  assert.equal(routes.length, 1);
  const [route] = routes;
  assert.equal(route.method, 'POST');
  assert.equal(route.path, '/sessions');
  assert.deepEqual(route.handlers, [handler]);
  assert.equal(route.gate(anonymous), true);
});

test('app.mount re-bases a multi-route imperative router and preserves each tail', async () => {
  const app = workbench();
  const h = (req, res) => res.json({});
  const r = router();
  r.get('/', h);
  r.get('/:id', h);
  app.mount('/users', r);
  const routes = await resolved(app);
  const paths = routes.map((rt) => rt.path).sort();
  assert.deepEqual(paths, ['/users', '/users/:id']);
  for (const route of routes) {
    assert.deepEqual(route.handlers, [h]);
    assert.equal(route.gate(anonymous), false);
  }
});

// --- two-phase boot tests ---

test('mount does NOT invoke an entity routes thunk eagerly; it runs at resolution', async () => {
  let invoked = false;
  const E = entity('Lazy', {
        body: text(),

    grant: () => grant(read),
    routes: (r) => {
      invoked = true;
      r.resource();
    },
  });
  const app = workbench().mount('/lazy', E);
  assert.equal(invoked, false, 'routes thunk not invoked at mount time');
  await app.resolveRoutes();
  assert.equal(invoked, true, 'routes thunk invoked at resolution');
});

test('an async routes thunk is awaited at resolution', async () => {
  let resolved = false;
  const E = entity('Async', {
        body: text(),

    grant: () => grant(read),
    routes: async (r) => {
      await Promise.resolve();
      resolved = true;
      r.resource();
    },
  });
  const app = workbench().mount('/async', E);
  assert.equal(resolved, false);
  await app.resolveRoutes();
  assert.equal(resolved, true);
  const routes = app.routes;
  assert.equal(routes.length, 5, 'async thunk produced its 5 CRUD routes');
});

test('listen(0) boots the app; app.ready resolves after routes resolved + server listening', async () => {
  const app = workbench().mount('/notes', makeNote()).listen(0);
  await app.ready;
  assert.equal(app.routes.length, 5);
  app.httpServer.close();
});

test('app.ready prepares framework and entity schema before traffic', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/notes', makeNote()).listen(0);
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });

  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_Log'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_Cursor'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Note'").get());
});
