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
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION } from '../build/search-plugin.mjs';
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
async function bootApp(t, { db = ':memory:', entities = [], setup, authorization } = {}) {
  const app = workbench({ db, entities });
  if (setup) setup(app);
  app.listen(0, {
    principalOf: (req) => {
      const user = req.headers['x-test-user'];
      return typeof user === 'string' && user.length > 0
        ? principal({ type: 'user', id: user })
        : principal({ type: 'anonymous' });
    },
    authorization,
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

// A custom policy adapter that denies either the route gate (principal) or
// every entity row, delegating every other category to the framework default.
// `calls` proves the injected instance was actually consulted by the route —
// a bypassed route would leave it empty.
function denyingAuthorizationAdapter({ denyPrincipal = false, denyEntity = false, db } = {}) {
  const inner = createAuthorizationAdapter(db ? { db } : {});
  const calls = [];
  const denied = (input, reasonCode) => ({
    admitted: false,
    operation: 'read',
    resourceCategory: input.category,
    resourceId: null,
    reasonCode,
    capabilities: [],
    trace: null,
  });
  return {
    calls,
    admit: async (input) => {
      calls.push(input);
      if (denyPrincipal && input.category === 'principal') return denied(input, 'anonymous');
      if (denyEntity && input.category === 'entity') return denied(input, 'no-capability');
      return inner.admit(input);
    },
    registerResource: (input) => inner.registerResource(input),
  };
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

async function bootNoteServer(t, authorization) {
  const Note = noteEntity();
  const { app, origin } = await bootApp(t, { entities: [Note], authorization });
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
  // The page discloses the queryIdentity its cursor is bound to.
  assert.equal(typeof first.body.queryIdentity, 'string');
  assert.equal(first.body.queryIdentity, first.body.nextCursor.queryIdentity);

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

async function bootFamilyServer(t, authorization) {
  const slice = familySlice();
  const { app, origin } = await bootApp(t, {
    entities: [slice.Artefact, slice.ValueSet, slice.ValueElement],
    authorization,
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
  assert.equal(typeof res.body.queryIdentity, 'string');

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

async function bootSearchServer(t, authorization, db = new DatabaseSync(':memory:')) {
  const Note = searchNoteEntity();
  // Wave 1 tightened resource-scope admission: with no database handle a
  // registered search scope fails closed, so a stand-alone adapter denies
  // every hit. Use ONE DB-backed adapter for plugin admission and the app's
  // route/row admission — the same engine REST and /query consult.
  const adapter = authorization ?? createAuthorizationAdapter({ db });
  const admission = (pluginId) => {
    adapter.registerResource({
      category: 'search',
      name: pluginId,
      // Bind the SQL table explicitly: the plugin id is not a SQL identifier,
      // and Wave 1 fails closed when a resource scope cannot be evaluated in
      // SQL (no implicit single-row fallback).
      entity: Note,
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
    db,
    entities: [Note],
    authorization: adapter,
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
// Derived (1:N) vector hits over the public HTTP route
// ---------------------------------------------------------------------------

function derivedNoteEntity() {
  return entity('Note', {
    title: text(),
    body: text(),
    projectId: text(),
    revision: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    embedding: text(),
    embedding_model: text(),
    grant: ownerGrant,
  });
}

function noteSegmentEntity() {
  return entity('NoteSegment', {
    noteId: ref('Note'),
    segmentId: text(),
    projectId: text(),
    revision: text(),
    embedding: text(),
    embedding_model: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: ownerGrant,
  });
}

// The plugin's own search admission is deliberately permissive here: these
// tests isolate the HTTP route's FINAL entity admission. The route must
// re-authorize the hit's CURRENT parent through the app's real adapter.
function allowEverySearchHit() {
  return {
    registerResource() {},
    async admit() { return { admitted: true, reasonCode: null }; },
  };
}

function recordingAuthorizationAdapter(db) {
  const inner = createAuthorizationAdapter({ db });
  const calls = [];
  const deniedParents = new Set();
  const denied = (input) => ({
    admitted: false,
    operation: 'read',
    resourceCategory: input.category,
    resourceId: input.resourceId ?? null,
    reasonCode: 'no-capability',
    capabilities: [],
    trace: null,
  });
  return {
    calls,
    deniedParents,
    admit: async (input) => {
      calls.push(input);
      // The route must never re-admit a derived hit by its segment identity;
      // denying every segment admission makes a provenance regression fail.
      if (input.category === 'entity' && input.entity?.name === 'NoteSegment') return denied(input);
      if (input.category === 'entity' && input.entity?.name === 'Note'
        && deniedParents.has(String(input.resourceId))) return denied(input);
      return inner.admit(input);
    },
    registerResource: (input) => inner.registerResource(input),
  };
}

async function bootDerivedSearchServer(t, db = new DatabaseSync(':memory:')) {
  const Note = derivedNoteEntity();
  const NoteSegment = noteSegmentEntity();
  const authorization = recordingAuthorizationAdapter(db);
  const admission = allowEverySearchHit();
  const fts = createFts5Plugin({
    id: 'note-fts',
    version: '1.0.0',
    tokenizer: 'porter',
    snippetLength: 32,
    source: { entity: 'Note', fields: ['title', 'body'], scopeField: 'projectId' },
    admission: { entity: Note, adapter: admission },
  });
  const vector = createVectorPlugin({
    id: 'note-vec',
    version: '1.0.0',
    source: {
      entity: 'NoteSegment',
      vector: 'embedding',
      model: 'embedding_model',
      scopeField: 'projectId',
      owns: () => true,
      parent: {
        entity: 'Note',
        field: 'noteId',
        revisionField: 'revision',
        projectField: 'projectId',
        parentRevisionField: 'revision',
        parentProjectField: 'projectId',
        segmentIdField: 'segmentId',
      },
    },
    modelSpace: { model: 'embed-v1', dimensions: 2 },
    admission: { entity: Note, adapter: admission },
  });
  const { app, origin } = await bootApp(t, {
    db,
    entities: [Note, NoteSegment],
    authorization,
    setup: (application) => {
      application.registerSearchPlugin(fts);
      application.registerSearchPlugin(vector);
    },
  });
  const insertNote = app.db.prepare(
    'INSERT INTO Note (id, title, body, projectId, revision, owner, embedding, embedding_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertSegment = app.db.prepare(
    'INSERT INTO NoteSegment (id, noteId, segmentId, projectId, revision, embedding, embedding_model, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  return {
    app,
    origin,
    calls: authorization.calls,
    deniedParents: authorization.deniedParents,
    note: (id, {
      projectId = 'p1', revision = 'r1', owner = 'alice', title = '', body = '', embedding = [0, 0],
    } = {}) => insertNote.run(id, title, body, projectId, revision, owner, JSON.stringify(embedding), 'embed-v1'),
    segment: (id, noteId, {
      segmentId = id, projectId = 'p1', revision = 'r1', owner = 'mallory', embedding = [0, 0],
    } = {}) => insertSegment.run(
      id, noteId, segmentId, projectId, revision, JSON.stringify(embedding), 'embed-v1', owner,
    ),
    rebuild: async () => {
      assert.equal((await app.searchPlugins.rebuild('note-fts')).ok, true);
      assert.equal((await app.searchPlugins.rebuild('note-vec')).ok, true);
    },
  };
}

const derivedVectorQuery = {
  mode: 'vector',
  index: 'note-vec',
  query: { model: 'embed-v1', vector: [1, 0] },
  scopeId: 'p1',
};

test('POST /search: a denied derived top hit does not shorten the page and re-admits the parent', { skip: SQLITE_AUTHORIZER }, async (t) => {
  const kit = await bootDerivedSearchServer(t);
  kit.note('n-denied', { owner: 'mallory', title: 'coastal clinic', body: 'coastal' });
  kit.note('n-allowed', { owner: 'alice', title: 'harbor scheduling', body: 'shift roster' });
  kit.segment('seg-denied', 'n-denied', { embedding: [1, 0] });
  kit.segment('seg-allowed', 'n-allowed', { embedding: [0.9, 0.1] });
  kit.deniedParents.add('n-denied');
  await kit.rebuild();

  const res = await postJson(kit.origin, '/search', { ...derivedVectorQuery, limit: 1 }, 'alice');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.hits.length, 1, 'the authorized lower-ranked hit fills the page');
  assert.equal(res.body.hits[0].id, 'seg-allowed');
  assert.equal(res.body.hits[0].sourceId, 'n-allowed');
  assert.equal(res.body.hits[0].authorizationEntity, 'Note');
  assert.equal(res.body.hits[0].authorizationRowId, 'n-allowed');

  const entityCalls = kit.calls.filter((call) => call.category === 'entity');
  assert.ok(
    entityCalls.some((call) => call.entity.name === 'Note' && call.resourceId === 'n-denied'),
    'the denied hit was re-checked as its parent',
  );
  assert.ok(
    entityCalls.some((call) => call.entity.name === 'Note' && call.resourceId === 'n-allowed'),
    'the disclosed hit was re-checked as its parent',
  );
  assert.ok(
    entityCalls.every((call) => call.entity.name === 'Note'),
    'derived hits are never re-admitted by segment identity',
  );
});

test('POST /search: offset applies to the authorized derived page, not the raw ranking', { skip: SQLITE_AUTHORIZER }, async (t) => {
  const kit = await bootDerivedSearchServer(t);
  kit.note('n-denied', { owner: 'mallory' });
  kit.note('n-allowed', { owner: 'alice' });
  kit.segment('seg-denied', 'n-denied', { embedding: [1, 0] });
  kit.segment('seg-a', 'n-allowed', { embedding: [0.9, 0.1] });
  kit.segment('seg-b', 'n-allowed', { embedding: [0.8, 0.2] });
  kit.deniedParents.add('n-denied');
  await kit.rebuild();

  const first = await postJson(kit.origin, '/search', { ...derivedVectorQuery, limit: 1, offset: 0 }, 'alice');
  const second = await postJson(kit.origin, '/search', { ...derivedVectorQuery, limit: 1, offset: 1 }, 'alice');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(first.body.hits.map((hit) => hit.id), ['seg-a']);
  assert.deepEqual(second.body.hits.map((hit) => hit.id), ['seg-b'], 'offset advances through authorized hits');
  assert.equal(second.body.hits.length, 1, 'the offset page stays full');
});

test('POST /search: revoking the parent after indexing removes its derived hit', { skip: SQLITE_AUTHORIZER }, async (t) => {
  const kit = await bootDerivedSearchServer(t);
  kit.note('n-revoked', { owner: 'alice' });
  kit.segment('seg-revoked', 'n-revoked', { embedding: [1, 0] });
  await kit.rebuild();

  const before = await postJson(kit.origin, '/search', { ...derivedVectorQuery, limit: 10 }, 'alice');
  assert.deepEqual(before.body.hits.map((hit) => hit.id), ['seg-revoked']);

  // Revoke the parent's authorization after the index snapshot. The route must
  // consult the CURRENT parent row, not the indexed provenance alone.
  kit.deniedParents.add('n-revoked');
  const after = await postJson(kit.origin, '/search', { ...derivedVectorQuery, limit: 10 }, 'alice');
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.hits, [], 'the revoked parent contributes no derived hit or metadata');
});

test('POST /search: hybrid admits derived parents before filling the fused page', { skip: SQLITE_AUTHORIZER }, async (t) => {
  const kit = await bootDerivedSearchServer(t);
  kit.note('n-denied', {
    owner: 'mallory', title: 'coastal clinic', body: 'coastal', embedding: [1, 0],
  });
  kit.note('n-vec', {
    owner: 'alice', title: 'harbor scheduling', body: 'shift roster', embedding: [0.9, 0.1],
  });
  kit.segment('seg-denied', 'n-denied', { embedding: [1, 0] });
  kit.segment('seg-vec', 'n-vec', { embedding: [0.9, 0.1] });
  kit.deniedParents.add('n-denied');
  await kit.rebuild();

  const res = await postJson(kit.origin, '/search', {
    mode: 'hybrid',
    sources: { fts: 'note-fts', vector: 'note-vec' },
    query: 'coastal',
    vector: [1, 0],
    model: 'embed-v1',
    weights: { fts: 1, vector: 1 },
    k: 60,
    scopeId: 'p1',
    limit: 1,
  }, 'alice');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.hits.length, 1);
  assert.equal(res.body.hits[0].key, 'seg-vec', 'the admitted vector-only hit fills the fused page');
  assert.ok(
    kit.calls.some((call) => call.category === 'entity'
      && call.entity.name === 'Note' && call.resourceId === 'n-vec'),
    'the fused vector hit was re-admitted as its parent',
  );
  assert.ok(
    kit.calls.filter((call) => call.category === 'entity').every((call) => call.entity.name === 'Note'),
    'hybrid admission never re-checks the segment identity',
  );
});

// ---------------------------------------------------------------------------
// Injected authorization adapter (finding 1) — every framework-owned read
// route must honor the SAME adapter REST does: a principal denial is a 401,
// and an entity denial omits rows/hits just like REST list's post-filter.
// ---------------------------------------------------------------------------

const noteQuery = { sort: { field: 'rank', direction: 'asc' }, pageSize: 10 };
const familyQuery = { sort: { field: 'rank', direction: 'asc' }, pageSize: 10 };

test('injected adapter: /query and /query-families honor the principal route gate', async (t) => {
  const denyGate = denyingAuthorizationAdapter({ denyPrincipal: true });
  const note = await bootNoteServer(t, denyGate);
  const family = await bootFamilyServer(t, denyGate);

  const queryRes = await postJson(note.origin, '/query/Note', noteQuery, 'alice');
  const familyRes = await postJson(family.origin, '/query-families/artefactsByProperty', familyQuery, 'alice');
  assert.equal(queryRes.status, 401);
  assert.equal(familyRes.status, 401);
  assert.ok(denyGate.calls.some((call) => call.category === 'principal'), 'route gate ran through the injected adapter');
});

test('injected adapter: /query and /query-families post-filter denied rows', async (t) => {
  const denyRows = denyingAuthorizationAdapter({ denyEntity: true });
  const note = await bootNoteServer(t, denyRows);
  const family = await bootFamilyServer(t, denyRows);

  const queryRes = await postJson(note.origin, '/query/Note', noteQuery, 'alice');
  const familyRes = await postJson(family.origin, '/query-families/artefactsByProperty', familyQuery, 'alice');
  assert.equal(queryRes.status, 200);
  assert.equal(familyRes.status, 200);
  assert.deepEqual(queryRes.body.rows, []);
  assert.deepEqual(familyRes.body.rows, []);
  assert.ok(denyRows.calls.some((call) => call.category === 'entity'), 'row admission ran through the injected adapter');
});

test('injected adapter: /search honors the principal route gate', { skip: SQLITE_AUTHORIZER }, async (t) => {
  const db = new DatabaseSync(':memory:');
  const denyGate = denyingAuthorizationAdapter({ denyPrincipal: true, db });
  const search = await bootSearchServer(t, denyGate, db);
  const res = await postJson(search.origin, '/search', { mode: 'fts', index: 'note-fts', query: 'coastal' }, 'alice');
  assert.equal(res.status, 401);
  assert.ok(denyGate.calls.some((call) => call.category === 'principal'), 'route gate ran through the injected adapter');
});

test('injected adapter: /search post-filters denied hits (FTS and hybrid)', { skip: SQLITE_AUTHORIZER }, async (t) => {
  const db = new DatabaseSync(':memory:');
  const denyRows = denyingAuthorizationAdapter({ denyEntity: true, db });
  const search = await bootSearchServer(t, denyRows, db);

  const fts = await postJson(search.origin, '/search', {
    mode: 'fts', index: 'note-fts', query: 'coastal', scopeId: 'proj-a', limit: 10,
  }, 'alice');
  const hybrid = await postJson(search.origin, '/search', {
    mode: 'hybrid',
    sources: { fts: 'note-fts', vector: 'note-vec' },
    query: 'coastal', vector: [1, 0, 0], model: 'embed-v1',
    scopeId: 'proj-a', limit: 10,
  }, 'alice');
  assert.equal(fts.status, 200);
  assert.equal(hybrid.status, 200);
  assert.deepEqual(fts.body.hits, []);
  assert.deepEqual(hybrid.body.hits, []);
  assert.ok(denyRows.calls.some((call) => call.category === 'entity'), 'search hit admission ran through the injected adapter');
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

// ---------------------------------------------------------------------------
// /search pagination stability and batch-failure disclosure
// ---------------------------------------------------------------------------

// Deny specific ENTITY rows at the ROUTE only. Plugin-level admission still
// passes them, so the route must refill its authorized page across raw batches.
function routeRowDenyingAdapter(db, deniedIds) {
  const inner = createAuthorizationAdapter({ db });
  return {
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
    registerResource: (input) => inner.registerResource(input),
  };
}

const hybridBody = (window) => ({
  mode: 'hybrid',
  sources: { fts: 'note-fts', vector: 'note-vec' },
  query: 'clinic',
  vector: [1, 0, 0],
  model: 'embed-v1',
  scopeId: 'proj-a',
  ...window,
});

test('POST /search: hybrid deep pages refill route-denied hits across batches, full and deduplicated', { skip: SQLITE_AUTHORIZER }, async (t) => {
  const db = new DatabaseSync(':memory:');
  const denied = new Set();
  for (let i = 1; i < 200; i += 2) denied.add(`paged-${i}`);
  const authorization = routeRowDenyingAdapter(db, denied);
  const kit = await bootSearchServer(t, authorization, db);
  const insert = kit.app.db.prepare(
    'INSERT INTO Note (id, title, body, projectId, owner, embedding, embedding_model) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < 200; i += 1) {
    const angle = i / 17;
    insert.run(`paged-${i}`, 'clinic coastal notes', `clinic coastal ${i}`, 'proj-a', 'alice',
      JSON.stringify([Math.cos(angle), Math.sin(angle), 0.05]), 'embed-v1');
  }
  assert.equal((await kit.app.searchPlugins.rebuild('note-fts')).ok, true);
  assert.equal((await kit.app.searchPlugins.rebuild('note-vec')).ok, true);

  const full = await postJson(kit.origin, '/search', hybridBody({ limit: 120 }), 'alice');
  assert.equal(full.status, 200);
  assert.equal(full.body.ok, true);
  assert.ok(full.body.hits.length > 80, 'the reference page reaches well past the tested window');

  // Each deep page needs several raw batches because half the rows are denied.
  // Every batch must see the same fused order, so the concatenation is exactly
  // the authorized prefix — no duplicates, no omissions.
  const paged = [];
  for (const offset of [40, 50, 60, 70]) {
    const page = await postJson(kit.origin, '/search', hybridBody({ offset, limit: 10 }), 'alice');
    assert.equal(page.status, 200);
    assert.equal(page.body.ok, true);
    assert.equal(page.body.truncated, false);
    assert.equal(page.body.hits.length, 10, `offset ${offset} page stays full`);
    paged.push(...page.body.hits.map((hit) => hit.key));
  }
  assert.equal(new Set(paged).size, paged.length, 'concatenated pages never repeat a hit');
  assert.deepEqual(paged, full.body.hits.slice(40, 80).map((hit) => hit.key));
});

test('POST /search: a later batch failure is reported as a failure, not as exhaustion', { skip: SQLITE_AUTHORIZER }, async (t) => {
  const db = new DatabaseSync(':memory:');
  const Note = searchNoteEntity();
  const authorization = denyingAuthorizationAdapter({ denyEntity: true, db });
  let calls = 0;
  // The fake index answers the first batch and fails on the next one, which is
  // only reached because every row is denied to this principal.
  const plugin = {
    contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
    id: 'flaky-fts',
    version: '1.0.0',
    ownedObjects: [],
    sourceInterests: [{ entity: 'Note' }],
    stalenessKey: () => null,
    prepare() {},
    validate() {},
    reconcile: () => ({ counts: {} }),
    rebuild: () => ({ counts: {} }),
    search(_ctx, request) {
      calls += 1;
      if (calls > 1) throw new Error('index scanner unavailable');
      const limit = Number(request.limit ?? 0);
      return { hits: Array.from({ length: limit }, (_, index) => ({ id: `n${index}` })) };
    },
  };
  const { app, origin } = await bootApp(t, {
    db,
    entities: [Note],
    authorization,
    setup: (application) => application.registerSearchPlugin(plugin),
  });
  const insert = app.db.prepare(
    'INSERT INTO Note (id, title, body, projectId, owner, embedding, embedding_model) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < 100; i += 1) {
    insert.run(`n${i}`, 'denied notes', 'denied notes', 'proj-a', 'mallory', '[]', 'embed-v1');
  }

  const res = await postJson(origin, '/search', { mode: 'fts', index: 'flaky-fts', query: 'denied', limit: 5 }, 'alice');
  assert.equal(calls, 2, 'the route advanced past the first batch');
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.failure?.category, 'invalid-input');
  assert.equal(res.body.hits, undefined, 'a failed batch never discloses a partial page');
});

test('POST /search: a pre-existing vector index upgrades through a real boot without a schema change', { skip: SQLITE_AUTHORIZER }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wb-vector-upgrade-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, 'workbench.sqlite'));
  const base = 'vec_note_vec';
  // The durable shape written before the derived-segment change: four columns,
  // no fence metadata, and an active generation that already holds a vector.
  db.exec(`CREATE TABLE ${base}_state (slot TEXT PRIMARY KEY CHECK (slot = 'active'), active INTEGER NOT NULL CHECK (active IN (0, 1)), previous INTEGER NOT NULL CHECK (previous IN (0, 1)), model TEXT NOT NULL, dimensions INTEGER NOT NULL);
    INSERT INTO ${base}_state VALUES ('active', 0, 0, 'embed-v1', 3);`);
  for (const name of [`${base}_g0`, `${base}_g1`]) {
    db.exec(`CREATE TABLE ${name} (source_key TEXT PRIMARY KEY, scope_id TEXT NOT NULL DEFAULT '', norm REAL NOT NULL, embedding BLOB NOT NULL);`);
    db.exec(`CREATE INDEX ${name}_scope_idx ON ${name} (scope_id);`);
  }
  db.prepare(`INSERT INTO ${base}_g0 (source_key, scope_id, norm, embedding) VALUES (?, 'proj-a', 1, ?)`)
    .run('doc-vec', new Uint8Array(new Float32Array([1, 0, 0]).buffer.slice(0)));

  // Boot runs the census, skips the existing DDL and rebuilds through the
  // legacy-shaped tables. A schema that still required parent_key would throw
  // here instead of serving search.
  const kit = await bootSearchServer(t, undefined, db);
  const res = await postJson(kit.origin, '/search', {
    mode: 'vector', index: 'note-vec', query: { model: 'embed-v1', vector: [1, 0, 0] }, scopeId: 'proj-a', limit: 10,
  }, 'alice');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.hits.some((hit) => hit.id === 'doc-vec'));
  assert.equal(res.body.truncated, false);
});
