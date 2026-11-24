// query-http-seam-cutover.test.mjs — Wave 1 lane regression coverage.
//
//  1. Blob read composition: a custom adapter's admitted:true can NEVER replace
//     the compiled scopeFilter / mayReadField AND gate; upload admission goes
//     through the SAME route gate adapter, not a bare principal.id check.
//  2. Query pagination: the adapter post-filter runs after SQL LIMIT, so the
//     route walks pages and recomputes hasMore/nextCursor from admitted rows.
//  3. Query invalidation: /queries/register + /queries/changed-since work out
//     of the box after app.listen(), including a committed mutation signal.
//  4. Browser query client: bounded cache, stale-page rejection, in-flight
//     refetch dedup, and canonical WorkbenchFailure failure shapes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import workbench, {
  anonymous,
  blob,
  entity,
  grant,
  inherit,
  number,
  principal,
  read,
  ref,
  scope,
  subscribe,
  text,
  write,
} from '../build/index.mjs';
import { createAuthorizationAdapter } from '../build/authorization-adapter.mjs';
import { createQueryClient, createLiveDeliverySession, WorkbenchFailureError } from '../public/workbench-client.mjs';

function decision(input, admitted, reasonCode) {
  return {
    admitted,
    operation: 'read',
    resourceCategory: input.category,
    resourceId: input.resourceId ?? null,
    reasonCode,
    capabilities: [],
    trace: null,
  };
}

async function boot(t, { entities, authorization, blobs, principalOf, mounts = [] } = {}) {
  const app = workbench({ db: ':memory:', entities, ...(blobs ? { blobs } : {}) });
  for (const [path, entityRecord] of mounts) app.mount(path, entityRecord);
  app.listen(0, {
    principalOf: principalOf ?? ((req) => {
      const user = req.headers['x-test-user'];
      return typeof user === 'string' && user.length > 0
        ? principal({ type: 'user', id: user })
        : anonymous;
    }),
    ...(authorization ? { authorization } : {}),
  });
  await app.ready;
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  t.after(async () => {
    try { await app.shutdown(); } catch { /* best effort */ }
    try { app.httpServer?.close(); } catch { /* already closed */ }
    if (blobs?.root) rmSync(blobs.root, { recursive: true, force: true });
  });
  return { app, origin };
}

async function post(origin, path, body, user) {
  const res = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  return { status: res.status, body: payload };
}

// --- 1. Blob authorization AND composition ----------------------------------

const Project = () => entity('Project', {
  title: text(),
  owner: ref('User', { role: 'owner', readonly: true }),
  grant: () => [scope(({ is }) => is.owner()).can(() => grant(read, write, subscribe))],
});

const Artifact = (project) => entity('Artifact', {
  project: ref('Project', { required: true }),
  title: text(),
  media: blob(),
  grant: inherit(project, { via: 'project' }),
});

test('blob read: a custom admitted:true decision cannot replace scopeFilter/mayReadField', async (t) => {
  let project;
  const artifact = Artifact(project = Project());
  const root = mkdtempSync(join(tmpdir(), 'wb-cutover-blob-'));
  const inner = createAuthorizationAdapter();
  const allowAllBlobs = {
    admit: async (input) => input.category === 'blob' ? decision(input, true, 'owner') : inner.admit(input),
    registerResource: (input) => inner.registerResource(input),
  };
  const { app, origin } = await boot(t, {
    entities: [project, artifact],
    mounts: [['/artifacts', artifact]],
    blobs: { root },
    authorization: allowAllBlobs,
  });

  app.db.prepare('INSERT INTO Project (id, title, owner) VALUES (?, ?, ?)').run('p1', 'private', 'alice');
  const upload = await fetch(`${origin}/blobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-test-user': 'alice' },
    body: Buffer.from('secret-bytes'),
  });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json();
  const created = await post(origin, '/artifacts', {
    project: 'p1', title: 'private media', media: uploaded.id,
  }, 'alice');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const url = `${origin}/blobs/Artifact/${created.body.id}/media`;

  // alice passes the compiled scopeFilter: bytes are served.
  const ownerRead = await fetch(url, { headers: { 'x-test-user': 'alice' } });
  assert.equal(ownerRead.status, 200);

  // bob is allowed by the custom blob policy but the compiled inherit(Project)
  // scopeFilter excludes him. The old short-circuit returned 200 here.
  const strangerRead = await fetch(url, { headers: { 'x-test-user': 'bob' } });
  assert.equal(strangerRead.status, 403, 'custom allow must be ANDed with the compiled scopeFilter');
});

test('blob upload: route gate goes through the injected adapter, not a bare id check', async (t) => {
  let project;
  const root = mkdtempSync(join(tmpdir(), 'wb-cutover-upload-'));
  const inner = createAuthorizationAdapter();
  const denyPrincipal = {
    admit: async (input) => input.category === 'principal' ? decision(input, false, 'anonymous') : inner.admit(input),
    registerResource: (input) => inner.registerResource(input),
  };
  const { origin } = await boot(t, {
    entities: [(project = Project()), Artifact(project)],
    blobs: { root },
    authorization: denyPrincipal,
  });
  const res = await fetch(`${origin}/blobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-test-user': 'alice' },
    body: Buffer.from('blocked'),
  });
  assert.equal(res.status, 401, 'an adapter-denied active principal must not upload');
});

// --- 2. Query pagination after post-filter ----------------------------------

const Note = () => entity('Note', {
  title: text(),
  rank: number(),
  owner: ref('User', { role: 'owner', readonly: true }),
  grant: () => [scope(({ is }) => is.owner()).can(() => grant(read, write, subscribe))],
});

async function bootNotes(t, authorization) {
  const { app, origin } = await boot(t, { entities: [Note()], authorization });
  const insert = app.db.prepare('INSERT INTO Note (id, title, rank, owner) VALUES (?, ?, ?, ?)');
  for (let i = 1; i <= 6; i += 1) {
    insert.run(`n${i}`, `note-${i}`, i, 'alice');
  }
  return { app, origin };
}

test('query page: post-filter refills the page and recomputes hasMore/nextCursor', async (t) => {
  const inner = createAuthorizationAdapter();
  // The adapter admits every row except n2 and n4, both owned by alice and
  // therefore visible to the compiled scopeFilter.
  const filterRows = {
    admit: async (input) => {
      if (input.category === 'entity') {
        return decision(input, input.resourceId !== 'n2' && input.resourceId !== 'n4', 'no-capability');
      }
      return inner.admit(input);
    },
    registerResource: (input) => inner.registerResource(input),
  };
  const { origin } = await bootNotes(t, filterRows);
  const request = { sort: { field: 'rank', direction: 'asc' }, pageSize: 2 };

  const first = await post(origin, '/query/Note', request, 'alice');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.rows.map((row) => row.id), ['n1', 'n3']);
  assert.equal(first.body.hasMore, true);
  assert.equal(first.body.nextCursor.id, 'n3');
  assert.equal(first.body.nextCursor.queryIdentity, first.body.queryIdentity);

  const second = await post(origin, '/query/Note', { ...request, cursor: first.body.nextCursor }, 'alice');
  assert.deepEqual(second.body.rows.map((row) => row.id), ['n5', 'n6']);
  assert.equal(second.body.hasMore, false);
  assert.equal(second.body.nextCursor, null);

  // A page whose entire underlying window is filtered still reports exact
  // pagination instead of inheriting the pre-filter hasMore/cursor.
  const allDenied = {
    admit: async (input) => input.category === 'entity'
      ? decision(input, false, 'no-capability')
      : inner.admit(input),
    registerResource: (input) => inner.registerResource(input),
  };
  const denied = await bootNotes(t, allDenied);
  const empty = await post(denied.origin, '/query/Note', request, 'alice');
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(empty.body.rows, []);
  assert.equal(empty.body.hasMore, false);
  assert.equal(empty.body.nextCursor, null);
});

// --- 3. Query invalidation HTTP seam ----------------------------------------

test('POST /queries/register + /queries/changed-since work after app.listen()', async (t) => {
  const { app, origin } = await bootNotes(t);
  const qc = createQueryClient({ baseUrl: origin, fetchImpl: fetch });
  const withUser = { headers: { 'x-test-user': 'alice' } };

  const registered = await qc.registerQueryInvalidation({
    id: 'alice-note-list', entity: 'Note', scope: 'Note:n1', fields: ['title', 'rank'],
  }, withUser);
  assert.equal(registered.ok, true);
  const since = registered.revision;

  const unchanged = await qc.changedSince({ id: 'alice-note-list', entity: 'Note', sinceRevision: since }, withUser);
  assert.equal(unchanged.kind, 'unchanged');

  const write = await app.dispatch({
    actionId: 'cutover-update', type: 'Note.update',
    payload: { id: 'n1', title: 'renamed' },
    principal: principal({ type: 'user', id: 'alice' }), scope: 'Note:n1',
  });
  assert.equal(write.ok, true, JSON.stringify(write));

  const changed = await qc.changedSince({
    id: 'alice-note-list', entity: 'Note', sinceRevision: since,
  }, withUser);
  assert.equal(changed.kind, 'changed', 'a committed matching event invalidates the registration');
  assert.equal(changed.revision >= since, true);

  const anonymous = await post(origin, '/queries/changed-since', {
    id: 'alice-note-list', entity: 'Note', sinceRevision: since,
  });
  assert.equal(anonymous.status, 401, 'the route gate applies to invalidation polling');
});

// --- 4. Browser query client -----------------------------------------------

function res(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('createQueryClient caches pages, rejects stale revisions and dedupes in-flight fetches', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const page = { rows: [{ id: 'n1' }], revision: 7, hasMore: false, nextCursor: null, queryIdentity: 'q1' };
  let nextPage = page;
  const qc = createQueryClient({
    baseUrl: 'http://test',
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return res(nextPage);
    },
  });
  const request = { sort: { field: 'rank', direction: 'asc' }, pageSize: 1 };
  const a = qc.queryEntity('Note', request);
  const b = qc.queryEntity('Note', request);
  assert.equal(a, b, 'identical in-flight queries share one promise');
  release();
  assert.equal(await a, page);
  assert.equal(calls, 1);

  assert.equal(qc.getCachedQueryPage('entity', 'Note', request), page);
  assert.equal(qc.acceptQueryPage({ ...page, revision: 6 }), 'reject-stale');
  assert.equal(qc.acceptQueryPage({ ...page, revision: 7 }), 'accept');
  assert.throws(
    () => qc.acceptQueryPage({ ...page, revision: NaN }),
    (error) => error instanceof WorkbenchFailureError && error.failure.category === 'invalid-input',
  );

  const staleCalls = calls;
  nextPage = { ...page, revision: 6 };
  await assert.rejects(
    qc.queryEntity('Note', request),
    (error) => error instanceof WorkbenchFailureError && error.failure.category === 'conflict',
  );
  assert.equal(calls, staleCalls + 1, 'a stale response is rejected after its fetch and not cached');
  assert.equal(qc.getCachedQueryPage('entity', 'Note', request), page, 'the cached newer page survives');
});

test('failed-rolled-back results always carry a canonical WorkbenchFailure', async () => {
  const session = createLiveDeliverySession({
    bootstrap: async () => ({ kind: 'snapshot', snapshot: {}, cursor: 0 }),
    subscribe: async () => ({ close() {} }),
    validateSnapshot: (snapshot) => snapshot,
    sendAction: async () => ({ ok: true }),
  });
  await session.ready;
  const result = await session.retry('no-such-op');
  assert.equal(result.status, 'failed-rolled-back');
  assert.equal(result.failure.category, 'internal');
  assert.equal(result.failure.message, 'operation is not awaiting transport retry');
  assert.doesNotThrow(() => new WorkbenchFailureError(result.failure));
  session.close();
});
