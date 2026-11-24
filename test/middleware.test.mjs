// Phase 2 — slice 3: the baked-in middleware stack (SPEC §3).
//
// The framework owns the boilerplate every server repeats; the app mounts none
// of it by hand (an app that had to would be a leak — AGENTS.md → Defaults).
// This slice lands the structurally load-bearing, fail-closed subset:
//
//   - security headers on EVERY response (even 401/404/500) — fail-closed
//     defaults that need no per-app knowledge (nosniff, frame DENY, no-referrer);
//   - a single error renderer that logs details but always sends a safe body
//     vs an opaque prod-safe body — the SPEC §3 "4-argument JSON error handler";
//   - body parsing capped (~1mb) so an unbounded upload is rejected, not buffered;
//   - graceful shutdown: SIGTERM/SIGINT close the live server, and an
//     unhandledRejection/uncaughtException is trapped (the framework owns the
//     traps; an app mounting its own is a leak).
//
// `config` is the env-sourced override surface (port, env); the app reads it and
// never re-implements the knobs.

import { entity, text, ref, grant, read, write, subscribe, scope, allowAnonymous } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import workbench, {
  config } from '../build/internal.mjs';

// An owned entity whose list verb is public, so a request can reach dispatch
// (where, without a db, it fails closed at 500 — useful to exercise the error
// path and the headers on a 500).
function makePublicListNote() {
  return entity('Note', {
        body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
    routes: (r) => r.resource(),
    gate: { list: allowAnonymous(), create: allowAnonymous() },
  });
}

// Start an app on an ephemeral port; tear down via t.after so a failing
// assertion never leaks an open handle (node:test hangs on open handles).
// `options` are server-owned listen options (e.g. `env` to force the error
// renderer's mode) — never client-controlled.
async function serve(t, app, options = {}) {
  app.listen(0, options);
  await new Promise((resolve) => {
    if (app.httpServer.listening) resolve();
    else app.httpServer.once('listening', resolve);
  });
  t.after(() => app.shutdown());
  const { port } = app.httpServer.address();
  return { origin: `http://127.0.0.1:${port}` };
}

test('config exposes env-sourced port and env', () => {
  assert.equal(typeof config.port, 'number', 'config.port is a number');
  assert.equal(typeof config.env, 'string', 'config.env is a string');
});

test('security headers are present on every response, including a 404', async (t) => {
  const app = workbench().mount('/notes', makePublicListNote());
  const { origin } = await serve(t, app);

  const res = await fetch(`${origin}/nonexistent`); // a 404
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

test('security headers are present on a 401 from the route gate', async (t) => {
  // a default-on entity (no public verbs) → anonymous list is denied 401.
  const Note = entity('Note', {
        body: text(), owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read))],
  });
  const app = workbench().mount('/notes', Note);
  const { origin } = await serve(t, app);

  const res = await fetch(`${origin}/notes`);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('an oversized request body is rejected, not buffered', async (t) => {
  const app = workbench().mount('/notes', makePublicListNote());
  const { origin } = await serve(t, app);

  // > 1mb of JSON. The body-parse cap rejects it before the handler runs.
  const huge = JSON.stringify({ body: 'x'.repeat(1_000_001) });
  const res = await fetch(`${origin}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: huge,
  });
  assert.equal(res.status, 413, 'oversized body → 413 Payload Too Large');
});

test('a malformed JSON body returns 400', async (t) => {
  const app = workbench().mount('/notes', makePublicListNote());
  const { origin } = await serve(t, app);

  const res = await fetch(`${origin}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(res.status, 400, 'malformed body → 400 Bad Request');
});

// A db handle whose query throws — to force an UNEXPECTED exception through the
// error renderer (distinct from the deliberate fail-closed no-db 500). `.prepare`
// throwing simulates an internal failure the handler did not anticipate.
function throwingDb() {
  return {
    prepare() {
      throw new Error('simulated internal db failure');
    },
  };
}

test('the error renderer is prod-safe (no stack leak) in production', async (t) => {
  // An unexpected exception in dispatch must render opaque in production — no
  // stack, no internal message leaked. The env is a SERVER-owned listen option
  // (never a client header — a client must never be able to force a stack
  // trace), defaulting to config.env.
  const app = workbench({ db: throwingDb() }).mount('/notes', makePublicListNote());
  const { origin } = await serve(t, app, { env: 'production' });

  const res = await fetch(`${origin}/notes`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.deepEqual(body, {
    ok: false,
    failure: { category: 'internal', message: 'Internal error.' },
  }, 'opaque error in prod');
  assert.equal(body.stack, undefined, 'no stack leaked in prod');
  assert.ok(
    !JSON.stringify(body).includes('simulated internal db failure'),
    'no internal message leaked in prod',
  );
});

test('the error renderer keeps public JSON sanitized in development', async (t) => {
  const app = workbench({ db: throwingDb() }).mount('/notes', makePublicListNote());
  const { origin } = await serve(t, app, { env: 'development' });

  const res = await fetch(`${origin}/notes`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.deepEqual(body, {
    ok: false,
    failure: { category: 'internal', message: 'Internal error.' },
  });
});

test('graceful shutdown closes the live server', async (_t) => {
  const app = workbench().mount('/notes', makePublicListNote());
  app.listen(0);
  await new Promise((resolve) => {
    if (app.httpServer.listening) resolve();
    else app.httpServer.once('listening', resolve);
  });
  // shutdown() is the framework-owned graceful close (what the SIGTERM/SIGINT
  // trap calls). After it resolves the server is no longer listening.
  await app.shutdown();
  assert.equal(app.httpServer.listening, false, 'server closed after shutdown');
});

test('app.listen(port, callback) fires the listening callback', async (t) => {
  const app = workbench().mount('/notes', makePublicListNote());
  await new Promise((resolve) => {
    app.listen(0, () => resolve());
  });
  t.after(() => app.shutdown());
  assert.equal(app.httpServer.listening, true, 'callback fired after listening');
});
