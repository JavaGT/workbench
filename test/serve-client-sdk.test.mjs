// serve-client-sdk.test.mjs — the framework serves its browser SDK by default.
//
// `GET /workbench.mjs` is a framework-owned endpoint (like /health, /snapshot,
// /blobs, and the /events WS transport): intercepted before matchRoute, served
// verbatim with a module-script content-type, resolved relative to the
// framework package via import.meta.url. It is engaged only when a db is
// present (the live kernel is running) — a db-less app has no live protocol to
// wire up and the endpoint falls through to 404.

import { entity, text, ref, scope, grant, read, write, subscribe } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import workbench from '../build/app.mjs';

function ownedNote() {
  return entity('Note', {
    body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

// A db-less app: no `.auth()`, no db string. The live kernel is not engaged.
async function bootDbLess(t) {
  const app = workbench().mount('/notes', ownedNote());
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const { port } = app.httpServer.address();
  t.after(() => app.httpServer.close());
  return `http://127.0.0.1:${port}`;
}

// A db-backed app: the live kernel is engaged, so the SDK endpoint is live.
async function bootDb(t) {
  const app = workbench({ db: ':memory:' }).auth().mount('/notes', ownedNote());
  app.listen(0);
  await app.ready;
  const { port } = app.httpServer.address();
  t.after(() => app.httpServer.close());
  return `http://127.0.0.1:${port}`;
}

test('db-backed app: GET /workbench.mjs → 200 + text/javascript + SDK body', async (t) => {
  const origin = await bootDb(t);
  const res = await fetch(`${origin}/workbench.mjs`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const body = await res.text();
  // the body is the real browser SDK, verbatim — an exported symbol is present
  assert.match(body, /createLiveStore/);
  assert.match(body, /createAuthClient/);
});

test('db-backed app serves the same pure annotated-text reducer module used by the browser client', async (t) => {
  const origin = await bootDb(t);
  const res = await fetch(`${origin}/workbench-annotated-text.mjs`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(await res.text(), /export function applyTextOp/);
});

test('db-backed app serves the annotated-text snapshot module', async (t) => {
  const origin = await bootDb(t);
  const res = await fetch(`${origin}/workbench-annotated-text-snapshot.mjs`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(await res.text(), /materializeAnnotatedTextSnapshot/);
});

test('db-backed app serves every relative module imported by the browser SDK', async (t) => {
  const origin = await bootDb(t);
  const body = await (await fetch(`${origin}/workbench.mjs`)).text();
  for (const dependency of body.matchAll(/from '([^']+)'/g)) {
    assert.equal((await fetch(new URL(dependency[1], `${origin}/workbench.mjs`))).status, 200, dependency[1]);
  }
});

test('db-backed app serves /workbench.mjs and every transitive ./workbench-client-*.mjs import as JS', async (t) => {
  const origin = await bootDb(t);
  const entry = `${origin}/workbench.mjs`;
  const entryRes = await fetch(entry);
  assert.equal(entryRes.status, 200);
  assert.equal(entryRes.headers.get('content-type'), 'text/javascript; charset=utf-8');

  // Walk the relative-import graph from the barrel. Side-effect imports
  // (`import './x.mjs'`) and re-exports (`export … from './x.mjs'`) both count.
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const res = await fetch(url);
    assert.equal(res.status, 200, url);
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8', url);
    const body = await res.text();
    for (const match of body.matchAll(/['"](\.\/workbench-client-[A-Za-z0-9-]+\.mjs)['"]/g)) {
      queue.push(new URL(match[1], url).href);
    }
  }
  // The barrel plus at least one real split module must have been exercised.
  assert.ok(seen.size > 1, 'expected split modules to be referenced by /workbench.mjs');
});

test('the split SDK route never serves an unlisted or traversal path', async (t) => {
  const origin = await bootDb(t);
  for (const path of [
    '/workbench-client-nope.mjs',
    '/workbench-client-%2e%2e%2fworkbench-client-core.mjs',
    '/workbench-client-core.mjs.map',
  ]) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
  }
});

test('db-backed app: an app route is not shadowed by the SDK endpoint', async (t) => {
  // a mounted route at /notes still works alongside the framework SDK endpoint.
  const origin = await bootDb(t);
  const res = await fetch(`${origin}/health`);
  assert.equal(res.status, 200);
});

test('db-less app: GET /workbench.mjs falls through (no live kernel → not served)', async (t) => {
  const origin = await bootDbLess(t);
  const res = await fetch(`${origin}/workbench.mjs`);
  // no db engaged → the framework endpoint returns false → matchRoute finds no
  // app route at /workbench.mjs → 404 (fail closed, never a phantom file).
  assert.equal(res.status, 404);
  assert.equal((await fetch(`${origin}/workbench-annotated-text.mjs`)).status, 404);
  assert.equal((await fetch(`${origin}/workbench-annotated-text-snapshot.mjs`)).status, 404);
});
