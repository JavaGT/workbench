// Priority 4 SLICE C — Ops bundle (CSP/HSTS/CORS/logging/metrics/health/envGate/onShutdown).

import { text, ref, scope, grant, read, write } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity } from '../build/internal.mjs';

function ownedNote() {
  return entity('Note', {
        body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [scope(({ is }) => is.owner()).can(async ({ is }) =>
      (await is.owner()) ? grant(read, write) : grant(read))],
  });
}

// Piece 1: /health framework endpoint
test('GET /health returns 200 with status and env', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, 'ok');
  assert.ok('env' in body);
});

test('GET /health/stats returns 200 with metrics', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  // Make a few requests to increment the counter
  await fetch(`${base}/health`);
  await fetch(`${base}/notes`);

  const r = await fetch(`${base}/health/stats`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, 'ok');
  assert.ok('env' in body);
  assert.ok('uptimeMs' in body);
  assert.ok('rssBytes' in body);
  assert.ok('requestCount' in body);
  assert.ok(body.requestCount >= 2); // at least the health + notes requests
});

// Piece 2: envGate — fail-closed at app construction
test('envGate: missing required env at construction throws', () => {
  const db = new DatabaseSync(':memory:');
  assert.throws(
    () => workbench({ db, requireEnv: ['NONEXISTENT_VAR_ZZZ'] }),
    /missing required env/i,
  );
  db.close();
});

test('envGate: present env passes', () => {
  const db = new DatabaseSync(':memory:');
  // PATH should always exist
  const app = workbench({ db, requireEnv: ['PATH'] });
  assert.ok(app);
  db.close();
});

// Piece 4: CSP / HSTS / CORS — ALL OPT-IN via listen()
test('CSP: opt-in via listen sets Content-Security-Policy header', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, {
    principalOf: () => ({ id: 'u1' }),
    csp: "default-src 'self'"
  });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-security-policy'), "default-src 'self'");
});

test('CSP: not configured → no CSP header (opt-in)', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-security-policy'), null);
});

test('HSTS: opt-in via listen sets Strict-Transport-Security header', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, {
    principalOf: () => ({ id: 'u1' }),
    hsts: true
  });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('strict-transport-security')?.includes('max-age=31536000'));
});

test('HSTS: not configured → no HSTS header (opt-in, default off)', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('strict-transport-security'), null);
});

test('CORS: configured origin in allowlist sets ACAO header', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, {
    principalOf: () => ({ id: 'u1' }),
    cors: { origins: ['https://app.example.com'] }
  });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  const r = await fetch(`${base}/health`, {
    headers: { origin: 'https://app.example.com' }
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.example.com');
  assert.equal(r.headers.get('access-control-expose-headers'), 'x-workbench-seq, x-workbench-action-id, Content-Range, Accept-Ranges, Content-Length, ETag');
  assert.equal(r.headers.get('vary'), 'Origin');
});

test('CORS: origin NOT in allowlist → no ACAO header', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, {
    principalOf: () => ({ id: 'u1' }),
    cors: { origins: ['https://app.example.com'] }
  });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  const r = await fetch(`${base}/health`, {
    headers: { origin: 'https://evil.example.com' }
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('CORS: OPTIONS preflight returns 204 with ACAO/ACAM/ACAH', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, {
    principalOf: () => ({ id: 'u1' }),
    cors: { origins: ['https://app.example.com'] }
  });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  const r = await fetch(`${base}/notes`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://app.example.com',
      'access-control-request-method': 'POST'
    }
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.example.com');
  assert.ok(r.headers.get('access-control-allow-methods')?.includes('POST'));
  assert.ok(r.headers.get('access-control-allow-headers')?.includes('content-type'));
  assert.equal(r.headers.get('vary'), 'Origin');
});

// Piece 5: requestLog + basic metrics
test('requestCount in /health/stats increments per request', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  const before = await (await fetch(`${base}/health/stats`)).json();
  const startCount = before.requestCount;

  // Make 3 more requests
  await fetch(`${base}/health`);
  await fetch(`${base}/health`);
  await fetch(`${base}/health`);

  const after = await (await fetch(`${base}/health/stats`)).json();
  assert.equal(after.requestCount, startCount + 4); // 3x /health + 1x /health/stats
});

// Piece 3: onShutdown deadline registry
test('onShutdown: registered hooks run on shutdown', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;

  let hookRan = false;
  app.onShutdown('test-hook', () => {
    hookRan = true;
  });

  await app.shutdown();
  assert.equal(hookRan, true);
  db.close();
});

test('onShutdown: hooks run in registration order', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;

  const order = [];
  app.onShutdown('first', () => { order.push(1); });
  app.onShutdown('second', () => { order.push(2); });
  app.onShutdown('third', () => { order.push(3); });

  await app.shutdown();
  assert.deepEqual(order, [1, 2, 3]);
  db.close();
});

test('onShutdown: hook exceeding timeout is force-abandoned', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;

  let slowRan = false;
  let slowCompleted = false;
  app.onShutdown('slow', async () => {
    slowRan = true;
    // This should timeout
    await new Promise(resolve => setTimeout(resolve, 100));
    slowCompleted = true;
  }, { timeoutMs: 50 });

  const start = Date.now();
  await app.shutdown();
  const elapsed = Date.now() - start;

  // Hook started but didn't complete
  assert.equal(slowRan, true);
  assert.equal(slowCompleted, false);
  // Shutdown should not wait for the slow hook
  assert.ok(elapsed < 500, `Shutdown took ${elapsed}ms, should be < 500ms`);
  db.close();
});
