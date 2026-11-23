// query-search-http-client.test.mjs — end-to-end coverage for #312.
//
// Exercises the three framework-owned HTTP endpoints against a real listening
// server (app.listen(0)):
//
//   POST /query/:entity         — boolean expressions, counts, keyset/offset
//                                 pagination, fail-closed authz/isolation
//   POST /query-families/:name  — dynamic multi-filter + dynamic sort +
//                                 element-level authz
//   POST /search                — FTS5, disk-backed Float32 vector, hybrid RRF,
//                                 cross-project scope isolation
//
// plus the browser `createQueryClient` SDK against the same live server.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import workbench from '../build/app.mjs';
import {
  boolean,
  entity,
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
import { createFts5Plugin } from '../build/fts5-plugin.mjs';
import { createVectorPlugin } from '../build/vector-plugin.mjs';
import { createAuthorizationAdapter } from '../build/authorization-adapter.mjs';
import { createQueryClient, WorkbenchFailureError } from '../public/workbench-client.mjs';

const ownerGrant = () => [scope(({ is }) => is.owner()).can(() => grant(read, write, subscribe))];

// The app's search-index lifecycle binds an owned-index capability that requires
// a SQLite statement authorizer (`setAuthorizer`). Node's node:sqlite provides
// it; Bun's SQLite driver does not, so the search-plugin-backed tests are Node
// only. The route/client shape is still compiled and the non-search tests run on
// both runtimes.
const SQLITE_AUTHORIZER = typeof globalThis.Bun === 'undefined'
  ? false
  : 'bun SQLite driver has no setAuthorizer for the owned-index capability';

// Boot a real listening app whose principal is injected from the `x-test-user`
// request header (absent → anonymous, fail closed). Every route runs through the
// same admission collapse and authorization engine as production.
async function bootApp(t, { entities = [], setup } = {}) {
  const app = workbench({ db: ':memory:', entities });
  if (setup) setup(app);
  app.listen(0, {
    principalOf: (req) => {
      const user = req.headers['x-test-user'];
      return typeof user === 'string' && user.length > 0
        ? principal({ type: 'user', id: user })
        : principal({ type: 'anonymous' });
    },
  });
  await app.ready;
  const { port } = app.httpServer.address();
  t.after(async () => {
    try { await app.shutdown(); } catch { /* best-effort teardown */ }
    try { app.httpServer?.close(); } catch { /* already closed */ }
  });
  return { app, origin: `http://127.0.0.1:${port}` };
}

async function postJson(origin, path, body, user) {
  const res = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(user ? { 'x-test-user': user } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  return { status: res.status, body: payload };
}

// ---------------------------------------------------------------------------
// POST /query/:entity
// ---------------------------------------------------------------------------

function noteEntity() {
  return entity('Note', {
    title: text(),
    status: text(),
    rank: number(),
    projectId: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: ownerGrant,
  });
}

async function bootNoteServer(t) {
  const Note = noteEntity();
  const { app, origin } = await bootApp(t, { entities: [Note] });
  const insert = app.db.prepare(
    'INSERT INTO Note (id, title, status, rank, projectId, owner) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insert.run('n1', 'alpha', 'open', 1, 'p1', 'alice');
  insert.run('n2', 'beta', 'open', 2, 'p1', 'alice');
  insert.run('n3', 'gamma', 'review', 3, 'p1', 'alice');
  insert.run('n4', 'delta', 'closed', 4, 'p1', 'alice');
  insert.run('n5', 'echo', 'open', 1, 'p2', 'bob');
  insert.run('n6', 'foxtrot', 'review', 2, 'p2', 'bob');
  return { app, origin };
}

test('POST /query/:entity: anonymous is rejected 401 before any read', async (t) => {
  const { origin } = await bootNoteServer(t);
  const res = await postJson(origin, '/query/Note', {
    sort: { field: 'rank', direction: 'asc' },
    pageSize: 10,
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.failure.category, 'denied');
});

test('POST /query/:entity: unknown entity is 404 (case-sensitive)', async (t) => {
  const { origin } = await bootNoteServer(t);
  const lower = await postJson(origin, '/query/note', { sort: { field: 'rank', direction: 'asc' }, pageSize: 10 }, 'alice');
  assert.equal(lower.status, 404);
  const missing = await postJson(origin, '/query/Missing', { sort: { field: 'rank', direction: 'asc' }, pageSize: 10 }, 'alice');
  assert.equal(missing.status, 404);
});

test('POST /query/:entity: AND/OR/NOT expression + includeCount + includeTotal', async (t) => {
  const { origin } = await bootNoteServer(t);
  const where = {
    kind: 'and',
    children: [
      { kind: 'term', field: 'projectId', op: 'eq', value: 'p1' },
      {
        kind: 'or',
        children: [
          { kind: 'term', field: 'status', op: 'eq', value: 'open' },
          { kind: 'term', field: 'status', op: 'eq', value: 'review' },
        ],
      },
      { kind: 'not', child: { kind: 'term', field: 'status', op: 'eq', value: 'closed' } },
    ],
  };
  const res = await postJson(origin, '/query/Note', {
    where,
    sort: { field: 'rank', direction: 'asc' },
    pageSize: 10,
    includeCount: true,
    includeTotal: true,
  }, 'alice');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.rows.map((row) => row.id), ['n1', 'n2', 'n3']);
  assert.equal(res.body.hasMore, false);
  assert.equal(res.body.nextCursor, null);
  assert.equal(res.body.count, 3, 'count is the filtered authorized set');
  assert.equal(res.body.filteredTotal, 3);
  assert.equal(res.body.total, 4, 'total is the authorized set before filters');
  assert.equal(typeof res.body.revision, 'number');
});

test('POST /query/:entity: cross-user isolation via the compiled row grant', async (t) => {
  const { origin } = await bootNoteServer(t);
  const request = {
    filters: [{ field: 'projectId', op: 'eq', value: 'p1' }],
    sort: { field: 'rank', direction: 'asc' },
    pageSize: 10,
  };
  const alice = await postJson(origin, '/query/Note', request, 'alice');
  assert.deepEqual(alice.body.rows.map((row) => row.id), ['n1', 'n2', 'n3', 'n4']);
  // Bob shares the URL/body but the grant hides every p1 row from him.
  const bob = await postJson(origin, '/query/Note', request, 'bob');
  assert.deepEqual(bob.body.rows, []);
  const bobOwn = await postJson(origin, '/query/Note', {
    filters: [{ field: 'projectId', op: 'eq', value: 'p2' }],
    sort: { field: 'rank', direction: 'asc' },
    pageSize: 10,
  }, 'bob');
  assert.deepEqual(bobOwn.body.rows.map((row) => row.id), ['n5', 'n6']);
});

test('POST /query/:entity: keyset and offset pagination walk the same page', async (t) => {
  const { origin } = await bootNoteServer(t);
  const base = {
    filters: [{ field: 'projectId', op: 'eq', value: 'p1' }],
    sort: { field: 'rank', direction: 'asc' },
  };
  const first = await postJson(origin, '/query/Note', { ...base, pageSize: 2 }, 'alice');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.rows.map((row) => row.id), ['n1', 'n2']);
  assert.equal(first.body.hasMore, true);
  assert.equal(first.body.nextCursor.id, 'n2');

  const second = await postJson(origin, '/query/Note', {
    ...base,
    pageSize: 2,
    cursor: first.body.nextCursor,
  }, 'alice');
  assert.deepEqual(second.body.rows.map((row) => row.id), ['n3', 'n4']);
  assert.equal(second.body.hasMore, false);

  const offset = await postJson(origin, '/query/Note', { ...base, pageSize: 2, offset: 2 }, 'alice');
  assert.deepEqual(offset.body.rows.map((row) => row.id), ['n3', 'n4']);
});

test('POST /query/:entity: invalid contract is a 400 standard envelope', async (t) => {
  const { origin } = await bootNoteServer(t);
  const res = await postJson(origin, '/query/Note', {
    filters: [{ field: 'nope', op: 'eq', value: 'x' }],
    sort: { field: 'rank', direction: 'asc' },
    pageSize: 10,
  }, 'alice');
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.failure.category, 'invalid-input');

  const badBody = await postJson(origin, '/query/Note', { sort: { field: 'rank', direction: 'asc' }, pageSize: 101 }, 'alice');
  assert.equal(badBody.status, 400);
});

// ---------------------------------------------------------------------------
// POST /query-families/:name
// ---------------------------------------------------------------------------

function familySlice() {
  const Artefact = entity('Artefact', {
    title: text(),
    rank: number(),
    projectId: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: ownerGrant,
  });
  const ValueSet = entity('ValueSet', {
    name: text(),
    valueType: text(),
    projectId: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: ownerGrant,
  });
  const ValueElement = entity('ValueElement', {
    hostId: text(),
    fieldId: text(),
    textValue: text(),
    numberValue: number(),
    epochValue: number(),
    booleanValue: boolean(),
    optionValue: text(),
    projectId: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: ownerGrant,
  });
  return { Artefact, ValueSet, ValueElement };
}

async function bootFamilyServer(t) {
  const slice = familySlice();
  const { app, origin } = await bootApp(t, {
    entities: [slice.Artefact, slice.ValueSet, slice.ValueElement],
    setup: (application) => {
      application.queryFamily({
        name: 'artefactsByProperty',
        host: slice.Artefact,
        catalog: slice.ValueSet,
        elements: slice.ValueElement,
        hostKey: 'hostId',
        fieldKey: 'fieldId',
        typeField: 'valueType',
        valueColumns: {
          text: 'textValue',
          number: 'numberValue',
          epoch: 'epochValue',
          boolean: 'booleanValue',
          option: 'optionValue',
        },
      });
    },
  });
  app.db.prepare('INSERT INTO Artefact (id, title, rank, projectId, owner) VALUES (?, ?, ?, ?, ?)').run('a1', 'Alpha', 1, 'p1', 'alice');
  app.db.prepare('INSERT INTO Artefact (id, title, rank, projectId, owner) VALUES (?, ?, ?, ?, ?)').run('a2', 'Beta', 2, 'p1', 'alice');
  app.db.prepare('INSERT INTO Artefact (id, title, rank, projectId, owner) VALUES (?, ?, ?, ?, ?)').run('a3', 'Gamma', 3, 'p1', 'alice');
  app.db.prepare('INSERT INTO Artefact (id, title, rank, projectId, owner) VALUES (?, ?, ?, ?, ?)').run('a4', 'Delta', 1, 'p2', 'bob');
  const valueSet = app.db.prepare('INSERT INTO ValueSet (id, name, valueType, projectId, owner) VALUES (?, ?, ?, ?, ?)');
  valueSet.run('f-text', 'label', 'text', 'p1', 'alice');
  valueSet.run('f-num', 'count', 'number', 'p1', 'alice');
  valueSet.run('f-bob', 'secret', 'text', 'p2', 'bob');
  const element = app.db.prepare(
    'INSERT INTO ValueElement (id, hostId, fieldId, textValue, numberValue, epochValue, booleanValue, optionValue, projectId, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  element.run('e1', 'a1', 'f-text', 'red apple', null, null, null, null, 'p1', 'alice');
  element.run('e2', 'a2', 'f-text', 'green pear', null, null, null, null, 'p1', 'alice');
  element.run('e3', 'a3', 'f-text', '', null, null, null, null, 'p1', 'alice');
  element.run('e4', 'a1', 'f-num', null, 10, null, null, null, 'p1', 'alice');
  element.run('e5', 'a2', 'f-num', null, 50, null, null, null, 'p1', 'alice');
  // Element owned by bob referencing alice's artefact: must never leak.
  element.run('e-leak', 'a1', 'f-text', 'banana', null, null, null, null, 'p1', 'bob');
  return { app, origin };
}

test('POST /query-families/:name: unregistered family 404, anonymous 401', async (t) => {
  const { origin } = await bootFamilyServer(t);
  const unknown = await postJson(origin, '/query-families/nope', { sort: { field: 'rank', direction: 'asc' }, pageSize: 10 }, 'alice');
  assert.equal(unknown.status, 404);
  const anon = await postJson(origin, '/query-families/artefactsByProperty', {
    sort: { field: 'rank', direction: 'asc' },
    pageSize: 10,
  });
  assert.equal(anon.status, 401);
});

test('POST /query-families/:name: dynamic multi-filter + element-level authz', async (t) => {
  const { origin } = await bootFamilyServer(t);
  const res = await postJson(origin, '/query-families/artefactsByProperty', {
    dynamicFilters: [
      { fieldId: 'f-text', op: 'contains', value: 'a' },
      { fieldId: 'f-num', op: 'gte', value: 20 },
    ],
    sort: { field: 'rank', direction: 'asc' },
    pageSize: 10,
    includeCount: true,
  }, 'alice');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.rows.map((row) => row.id), ['a2']);
  assert.equal(res.body.count, 1);

  // The bob-owned element is invisible to alice even though it references her row.
  const leak = await postJson(origin, '/query-families/artefactsByProperty', {
    dynamicFilters: [{ fieldId: 'f-text', op: 'contains', value: 'banana' }],
    sort: { field: 'rank', direction: 'asc' },
    pageSize: 10,
  }, 'alice');
  assert.deepEqual(leak.body.rows, []);
});

test('POST /query-families/:name: dynamic property sort', async (t) => {
  const { origin } = await bootFamilyServer(t);
  const res = await postJson(origin, '/query-families/artefactsByProperty', {
    sortByDynamicField: { dynamicFieldId: 'f-num', direction: 'desc' },
    pageSize: 10,
  }, 'alice');
  assert.equal(res.status, 200);
  // a2 (50) > a1 (10) > a3 (no value, sorts last).
  assert.deepEqual(res.body.rows.map((row) => row.id), ['a2', 'a1', 'a3']);
});

test('POST /query-families/:name: invalid dynamic request is 400', async (t) => {
  const { origin } = await bootFamilyServer(t);
  const res = await postJson(origin, '/query-families/artefactsByProperty', {
    dynamicFilters: [{ fieldId: 'f-missing', op: 'eq', value: 'x' }],
    sort: { field: 'rank', direction: 'asc' },
    pageSize: 10,
  }, 'alice');
  assert.equal(res.status, 400);
  assert.equal(res.body.failure.category, 'invalid-input');
});

// ---------------------------------------------------------------------------
// POST /search
// ---------------------------------------------------------------------------

function searchNoteEntity() {
  return entity('Note', {
    title: text(),
    body: text(),
    projectId: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    embedding: text(),
    embedding_model: text(),
    grant: ownerGrant,
  });
}

async function bootSearchServer(t) {
  const Note = searchNoteEntity();
  const adapter = createAuthorizationAdapter();
  const admission = (pluginId) => {
    adapter.registerResource({
      category: 'search',
      name: pluginId,
      scope: ({ is }) => is.owner(),
      fields: { owner: ref('User', { role: 'owner' }) },
    });
    return { entity: Note, adapter };
  };
  const fts = createFts5Plugin({
    id: 'note-fts',
    version: '1.0.0',
    tokenizer: 'porter',
    snippetLength: 32,
    source: { entity: 'Note', fields: ['title', 'body'], scopeField: 'projectId' },
    admission: admission('note-fts'),
  });
  const vector = createVectorPlugin({
    id: 'note-vec',
    version: '1.0.0',
    source: {
      entity: 'Note',
      vector: 'embedding',
      model: 'embedding_model',
      scopeField: 'projectId',
      owns: () => true,
    },
    modelSpace: { model: 'embed-v1', dimensions: 3 },
    admission: admission('note-vec'),
  });
  const { app, origin } = await bootApp(t, {
    entities: [Note],
    setup: (application) => {
      application.registerSearchPlugin(fts);
      application.registerSearchPlugin(vector);
    },
  });
  const insert = app.db.prepare(
    'INSERT INTO Note (id, title, body, projectId, owner, embedding, embedding_model) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const row = (id, projectId, title, body, embedding) => insert.run(
    id, title, body, projectId, 'alice',
    JSON.stringify(embedding), 'embed-v1',
  );
  // Foreign project rows dominate unscoped lexical + vector retrieval.
  for (let i = 0; i < 20; i += 1) {
    row(`foreign-${String(i).padStart(2, '0')}`, 'proj-other', 'coastal clinic', 'coastal clinic triage', [1, 0, 0]);
  }
  row('doc-both', 'proj-a', 'coastal clinic', 'patient intake notes', [0.95, 0.31, 0]);
  row('doc-fts', 'proj-a', 'coastal coastal', 'coastal notes', [-1, 0, 0]);
  row('doc-vec', 'proj-a', 'harbor scheduling', 'shift roster', [1, 0, 0]);

  assert.equal((await app.searchPlugins.rebuild('note-fts')).ok, true);
  assert.equal((await app.searchPlugins.rebuild('note-vec')).ok, true);
  return { app, origin };
}

test('POST /search: anonymous is rejected 401', { skip: SQLITE_AUTHORIZER }, async (t) => {
  const { origin } = await bootSearchServer(t);
  const res = await postJson(origin, '/search', { mode: 'fts', index: 'note-fts', query: 'coastal' });
  assert.equal(res.status, 401);
});

test('POST /search: FTS5 with cross-project scope isolation', { skip: SQLITE_AUTHORIZER }, async (t) => {
  const { origin } = await bootSearchServer(t);
  const res = await postJson(origin, '/search', {
    mode: 'fts',
    index: 'note-fts',
    query: 'coastal',
    scopeId: 'proj-a',
    limit: 10,
  }, 'alice');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.mode, 'fts');
  assert.equal(res.body.staleness, 'fresh');
  assert.deepEqual(res.body.hits.map((hit) => hit.id).sort(), ['doc-both', 'doc-fts']);
  assert.ok(res.body.hits.every((hit) => !String(hit.id).startsWith('foreign-')));
});

test('POST /search: disk-backed Float32 vector search', { skip: SQLITE_AUTHORIZER }, async (t) => {
  const { origin } = await bootSearchServer(t);
  const res = await postJson(origin, '/search', {
    mode: 'vector',
    index: 'note-vec',
    query: { model: 'embed-v1', vector: [1, 0, 0] },
    scopeId: 'proj-a',
    limit: 10,
  }, 'alice');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.staleness, 'fresh');
  // Cosine: doc-vec (1.0) > doc-both (~0.95) > doc-fts (-1.0).
  assert.deepEqual(res.body.hits.map((hit) => hit.id), ['doc-vec', 'doc-both', 'doc-fts']);
  assert.ok(res.body.hits.every((hit) => !String(hit.id).startsWith('foreign-')));
});

test('POST /search: hybrid RRF fuses both branches, scoped to the project', { skip: SQLITE_AUTHORIZER }, async (t) => {
  const { origin } = await bootSearchServer(t);
  const res = await postJson(origin, '/search', {
    mode: 'hybrid',
    sources: { fts: 'note-fts', vector: 'note-vec' },
    query: 'coastal',
    vector: [1, 0, 0],
    model: 'embed-v1',
    weights: { fts: 1, vector: 1 },
    k: 60,
    scopeId: 'proj-a',
    limit: 3,
  }, 'alice');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.mode, 'hybrid');
  assert.equal(res.body.hits.length, 3);
  assert.deepEqual(res.body.hits.map((hit) => hit.key).sort(), ['doc-both', 'doc-fts', 'doc-vec']);
  const both = res.body.hits.find((hit) => hit.key === 'doc-both');
  assert.ok(both.sources['note-fts'] && both.sources['note-vec'], 'the fused hit carries both branch contributions');
  assert.ok(res.body.hits.every((hit) => !String(hit.key).startsWith('foreign-')));
  assert.equal(typeof res.body.totalCandidates, 'number');
});

test('POST /search: unknown index 404 and malformed payload 400', { skip: SQLITE_AUTHORIZER }, async (t) => {
  const { origin } = await bootSearchServer(t);
  const unknown = await postJson(origin, '/search', {
    mode: 'fts', index: 'no-such-index', query: 'coastal',
  }, 'alice');
  assert.equal(unknown.status, 404);

  const malformed = await postJson(origin, '/search', {
    mode: 'fts', index: 'note-fts', query: '',
  }, 'alice');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.failure.category, 'invalid-input');

  const badMode = await postJson(origin, '/search', { mode: 'semantic', index: 'note-fts' }, 'alice');
  assert.equal(badMode.status, 400);
});

// ---------------------------------------------------------------------------
// createQueryClient
// ---------------------------------------------------------------------------

test('createQueryClient: queryEntity / queryFamily / search against a live server', async (t) => {
  const { origin } = await bootNoteServer(t);
  const asAlice = (url, init) => fetch(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), 'x-test-user': 'alice' },
  });

  const client = createQueryClient({ baseUrl: origin, fetchImpl: asAlice });
  const page = await client.queryEntity('Note', {
    filters: [{ field: 'projectId', op: 'eq', value: 'p1' }],
    sort: { field: 'rank', direction: 'asc' },
    pageSize: 2,
    includeCount: true,
  });
  assert.deepEqual(page.rows.map((row) => row.id), ['n1', 'n2']);
  assert.equal(page.count, 4);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor.id, 'n2');

  // A non-canonical failure surfaces as a thrown WorkbenchFailureError.
  const anonymousClient = createQueryClient({ baseUrl: origin, fetchImpl: (url, init) => fetch(url, init) });
  await assert.rejects(
    anonymousClient.queryEntity('Note', { sort: { field: 'rank', direction: 'asc' }, pageSize: 2 }),
    (err) => err instanceof WorkbenchFailureError && err.failure.category === 'denied',
  );
});

test('createQueryClient: queryFamily round-trip', async (t) => {
  const family = await bootFamilyServer(t);
  const familyClient = createQueryClient({
    baseUrl: family.origin,
    fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers ?? {}), 'x-test-user': 'alice' } }),
  });
  const familyPage = await familyClient.queryFamily('artefactsByProperty', {
    dynamicFilters: [{ fieldId: 'f-text', op: 'contains', value: 'apple' }],
    sort: { field: 'rank', direction: 'asc' },
    pageSize: 10,
  });
  assert.deepEqual(familyPage.rows.map((row) => row.id), ['a1']);
});

test('createQueryClient: search round-trip', { skip: SQLITE_AUTHORIZER }, async (t) => {
  const search = await bootSearchServer(t);
  const searchClient = createQueryClient({
    baseUrl: search.origin,
    fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers ?? {}), 'x-test-user': 'alice' } }),
  });
  const hits = await searchClient.search({ mode: 'fts', index: 'note-fts', query: 'coastal', scopeId: 'proj-a', limit: 10 });
  assert.equal(hits.ok, true);
  assert.deepEqual(hits.hits.map((hit) => hit.id).sort(), ['doc-both', 'doc-fts']);
});
