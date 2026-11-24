// w6-http-fetch-adapter.test.mjs — Web Fetch / Bun.serve adapter and the two
// framework-route bugs it must preserve the fixes for.
//
// The adapter is a bridge over makeRequestHandler, NOT a second HTTP or auth
// spine. These tests therefore drive a headless Workbench app through standard
// Web Request/Response objects and assert the same CRUD, principal, CORS/CSRF,
// Set-Cookie, and framework-route behavior the node:http transport exposes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity } from '../build/internal.mjs';
import {
  createAuthorizationAdapter,
  everyone,
  grant,
  number,
  principal,
  read,
  ref,
  scope,
  subscribe,
  text,
  write,
} from '../build/index.mjs';
import { createFetchHandler as fromServe } from '../build/serve.mjs';
import { createFetchHandler as fromIndex } from '../build/index.mjs';
import { createFetchHandler as fromServer } from '../build/server.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function publicPost() {
  return entity('Post', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(() => everyone()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

function noteEntity() {
  return entity('Note', {
    title: text(),
    rank: number(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read, write, subscribe))],
  });
}

async function bootFetch(t, { db = new DatabaseSync(':memory:'), entities = [publicPost()], search, authorization, useCookies = false } = {}) {
  const app = workbench({ db, entities, search });
  // Registering an entity makes it available to the framework query/search
  // routes; REST CRUD additionally needs a mounted base path.
  for (const compiled of entities) app.mount(`/${compiled.name.toLowerCase()}s`, compiled);
  if (useCookies) {
    app.use('/cookies', (_req, res) => {
      res.setHeader('Set-Cookie', ['sid=abc123; Path=/; HttpOnly', 'theme=dark; Path=/']);
      res.json({ ok: true });
    });
  }
  // A headless app must boot before it can dispatch CRUD or resolve routes;
  // no socket is opened, so the Web handler is the only transport.
  app.start();
  await app.ready;
  t.after(async () => {
    try { await app.shutdown(); } catch { /* best-effort teardown */ }
    try { db.close(); } catch { /* already closed */ }
  });

  const handler = fromServe(app, {
    db,
    authorization,
    principalOf: (req) => {
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
      if (bearer.startsWith('alice')) return principal({ type: 'user', id: 'alice' });
      if (bearer.startsWith('bob')) return principal({ type: 'user', id: 'bob' });
      return principal({ type: 'anonymous' });
    },
  });
  return { app, db, handler };
}

function request(path, { method = 'GET', token, body, headers } = {}) {
  const merged = new Headers(headers ?? {});
  if (token) merged.set('authorization', `Bearer ${token}`);
  if (body !== undefined && !merged.has('content-type')) merged.set('content-type', 'application/json');
  return new Request(`http://localhost${path}`, {
    method,
    headers: merged,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(res) {
  const text = await res.text();
  return text === '' ? null : JSON.parse(text);
}

// An adapter that delegates everything but denies the listed entity rows. The
// denial is the post-filter REST/query/search all share — it forces the query
// page-fill loop to scan a second physical page.
function denyRows(db, deniedIds) {
  const inner = createAuthorizationAdapter({ db });
  return {
    registerResource: (input) => inner.registerResource(input),
    admit: async (input) => {
      if (input.category === 'entity' && deniedIds.has(String(input.resourceId))) {
        return {
          admitted: false,
          operation: 'read',
          resourceCategory: 'entity',
          resourceId: input.resourceId ?? null,
          reasonCode: 'no-capability',
          capabilities: [],
          trace: null,
        };
      }
      return inner.admit(input);
    },
  };
}

// ---------------------------------------------------------------------------
// (c) Web Fetch adapter: exports, CRUD, principals, cookies, framework routes
// ---------------------------------------------------------------------------

test('createFetchHandler is exported from every public entrypoint', () => {
  for (const factory of [fromServe, fromIndex, fromServer]) {
    assert.equal(typeof factory, 'function');
    const handler = factory({}, {});
    assert.equal(typeof handler, 'function');
  }
});

test('createFetchHandler serves GET/POST/PATCH/DELETE entity CRUD', async (t) => {
  const { db, handler } = await bootFetch(t);

  const empty = await handler(request('/posts', { token: 'alice' }));
  assert.equal(empty.status, 200);
  assert.deepEqual(await json(empty), []);

  const created = await handler(request('/posts', {
    method: 'POST', token: 'alice', body: { title: 'first' },
  }));
  assert.equal(created.status, 201);
  const row = await json(created);
  assert.equal(row.title, 'first');
  assert.equal(row.owner, 'alice');
  assert.ok(Number(created.headers.get('x-workbench-seq')) >= 1);
  assert.ok(created.headers.get('x-workbench-action-id'));

  const readBack = await handler(request(`/posts/${row.id}`, { token: 'alice' }));
  assert.equal(readBack.status, 200);
  assert.equal((await json(readBack)).title, 'first');

  const patched = await handler(request(`/posts/${row.id}`, {
    method: 'PATCH', token: 'alice', body: { title: 'second' },
  }));
  assert.equal(patched.status, 200);
  assert.equal(db.prepare('SELECT title FROM Post WHERE id = ?').get(row.id).title, 'second');

  const removed = await handler(request(`/posts/${row.id}`, { method: 'DELETE', token: 'alice' }));
  assert.equal(removed.status, 204);
  assert.equal(db.prepare('SELECT * FROM Post WHERE id = ?').get(row.id), undefined);
});

test('custom Bearer principalOf fails closed on 401 and 403', async (t) => {
  const { db, handler } = await bootFetch(t);
  db.prepare('INSERT INTO Post (id, title, owner) VALUES (?, ?, ?)').run('p1', 'bob post', 'bob');

  const anonymous = await handler(request('/posts'));
  assert.equal(anonymous.status, 401);
  assert.equal((await json(anonymous)).failure.category, 'denied');

  const foreignWrite = await handler(request('/posts/p1', {
    method: 'PATCH', token: 'alice', body: { title: 'hijack' },
  }));
  assert.equal(foreignWrite.status, 403);

  // The public /health route is the one explicit anonymous exception.
  const health = await handler(request('/health'));
  assert.equal(health.status, 200);
  assert.equal((await json(health)).status, 'ok');
});

test('multi-value Set-Cookie headers survive the Web Response bridge', async (t) => {
  const { handler } = await bootFetch(t, { entities: [], useCookies: true });
  const res = await handler(request('/cookies'));
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });
  const cookies = res.headers.getSetCookie?.() ?? [];
  assert.deepEqual(cookies, ['sid=abc123; Path=/; HttpOnly', 'theme=dark; Path=/']);
});

test('framework routes work through Web Request/Response objects', async (t) => {
  const { handler } = await bootFetch(t);
  const sdk = await handler(request('/workbench.mjs'));
  assert.equal(sdk.status, 200);
  assert.match(sdk.headers.get('content-type'), /text\/javascript/);
  assert.ok((await sdk.text()).length > 0);

  const page = await handler(request('/query/Post', {
    method: 'POST', token: 'alice', body: { sort: { field: 'title', direction: 'asc' }, pageSize: 10 },
  }));
  assert.equal(page.status, 200);
  const body = await json(page);
  assert.ok(Array.isArray(body.rows));
  assert.equal(typeof body.revision, 'number');

  const action = await handler(request('/action', { method: 'POST', token: 'alice', body: {} }));
  assert.ok([400, 404].includes(action.status), 'unknown action fails closed through the one spine');
});

// ---------------------------------------------------------------------------
// (a) Fail-closed search hits
// ---------------------------------------------------------------------------

test('POST /search drops hits whose entity or row cannot be resolved', async (t) => {
  const registry = {
    has: (index) => index === 'fake',
    search: async () => ({
      ok: true,
      generation: 1,
      state: 'ready',
      result: {
        hits: [
          { id: 'n1', entity: 'Note', score: 3 },        // resolvable row → kept
          { id: 'gone', entity: 'Note', score: 2 },      // row vanished → dropped
          { id: 'x', entity: 'NoSuchEntity', score: 1 }, // unknown entity → dropped
          { key: 'fused', entity: 'Note', score: 0 },    // no id → dropped
        ],
      },
    }),
  };
  const db = new DatabaseSync(':memory:');
  const { handler } = await bootFetch(t, {
    db,
    entities: [noteEntity()],
    search: registry,
    authorization: createAuthorizationAdapter({ db }),
  });
  db.prepare('INSERT INTO Note (id, title, rank, owner) VALUES (?, ?, ?, ?)').run('n1', 'kept', 1, 'alice');

  const res = await handler(request('/search', {
    method: 'POST', token: 'alice', body: { index: 'fake', query: 'anything' },
  }));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(body.hits.map((hit) => hit.id), ['n1']);
});

// ---------------------------------------------------------------------------
// (b) Offset pagination fill without a cursor+offset 400
// ---------------------------------------------------------------------------

test('POST /query/:entity offset fill never combines cursor and offset', async (t) => {
  const db = new DatabaseSync(':memory:');
  const authorization = denyRows(db, new Set(['n2', 'n4']));
  const { handler } = await bootFetch(t, {
    db,
    entities: [noteEntity()],
    authorization,
  });
  for (let i = 1; i <= 6; i += 1) {
    db.prepare('INSERT INTO Note (id, title, rank, owner) VALUES (?, ?, ?, ?)')
      .run(`n${i}`, `title-${i}`, i, 'alice');
  }

  const res = await handler(request('/query/Note', {
    method: 'POST',
    token: 'alice',
    body: {
      sort: { field: 'rank', direction: 'asc' },
      pageSize: 2,
      offset: 0,
    },
  }));
  assert.equal(res.status, 200, `offset fill must not 400: ${await res.clone().text()}`);
  const page = await json(res);
  // n2 and n4 are denied by the injected adapter; the fill loop walks the
  // second physical page and anchors on the last row it actually returns.
  assert.deepEqual(page.rows.map((row) => row.id), ['n1', 'n3']);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextCursor);
});
