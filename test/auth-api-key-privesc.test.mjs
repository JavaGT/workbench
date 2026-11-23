// Regression tests for GitHub issue #280 (API key privilege escalation via
// caller-supplied entityName/role) and related #219 (malformed expiresAt).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import workbench, {
  ApiKey,
  User,
  Session,
  Credential,
  Invitation,
  TwoFactor,
  authRoutes,
} from '../build/internal.mjs';
import { apiKeyPrincipalOf, SESSION_COOKIE } from '../build/auth/session.mjs';
import {
  entity,
  text,
  ref,
  map,
  membership,
  scope,
  grant,
  read,
  write,
  subscribe,
} from '../build/index.mjs';

function makeProject() {
  const Project = entity('Project', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['editor', 'viewer'] }),
  });
  membership(Project, {
    editor: { can: [read, write] },
    viewer: { can: [read] },
  });
  return Project;
}

function makeNoAdminNote() {
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

function sidFromSetCookie(header) {
  const first = header.split(/,(?=[^ ;]+)/)[0];
  const match = first.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

async function registerUser(origin, username, password = 'password123') {
  const res = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 201, `register ${username}`);
  const { user } = await res.json();
  const cookie = `sid=${sidFromSetCookie(res.headers.get('set-cookie'))}`;
  return { user, cookie };
}

async function createKey(origin, headers, payload) {
  const res = await fetch(`${origin}/auth/api-key/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function bootApp(t) {
  const Project = makeProject();
  const Note = makeNoAdminNote();
  const app = workbench({ db: ':memory:' })
    .auth()
    .mount('/projects', Project)
    .mount('/notes', Note);
  app.listen(0);
  await app.ready;
  t.after(() => app.httpServer.close());
  const { port } = app.httpServer.address();
  return { app, Project, Note, origin: `http://127.0.0.1:${port}` };
}

test('non-admin user cannot mint an API key with an elevated role or unauthorized entityName', async (t) => {
  const { app, Project, origin } = await bootApp(t);
  const alice = await registerUser(origin, 'alice');
  const bob = await registerUser(origin, 'bob');
  const carol = await registerUser(origin, 'carol');
  const stranger = await registerUser(origin, 'stranger');

  // Alice owns p1; Bob is an editor (read, write); Carol is a viewer (read).
  app.entity(Project).insert({ id: 'p1', title: 'Alpha', owner: alice.user.id });
  app.db
    .prepare('INSERT INTO Project_members (Project_id, member_id, role) VALUES (?, ?, ?)')
    .run('p1', bob.user.id, 'editor');
  app.db
    .prepare('INSERT INTO Project_members (Project_id, member_id, role) VALUES (?, ?, ?)')
    .run('p1', carol.user.id, 'viewer');

  const attempts = [
    { label: 'stranger unscoped admin role', cookie: stranger.cookie, payload: { name: 'k1', role: 'admin' } },
    { label: 'stranger Project admin', cookie: stranger.cookie, payload: { name: 'k2', entityName: 'Project', role: 'admin' } },
    { label: 'stranger Project viewer', cookie: stranger.cookie, payload: { name: 'k3', entityName: 'Project', role: 'viewer' } },
    { label: 'stranger Project without role', cookie: stranger.cookie, payload: { name: 'k4', entityName: 'Project' } },
    { label: 'viewer Project admin', cookie: carol.cookie, payload: { name: 'k5', entityName: 'Project', role: 'admin' } },
    { label: 'viewer Project editor', cookie: carol.cookie, payload: { name: 'k6', entityName: 'Project', role: 'editor' } },
    { label: 'viewer Project viewer', cookie: carol.cookie, payload: { name: 'k7', entityName: 'Project', role: 'viewer' } },
    { label: 'editor Project admin', cookie: bob.cookie, payload: { name: 'k8', entityName: 'Project', role: 'admin' } },
    { label: 'editor Project without role', cookie: bob.cookie, payload: { name: 'k9', entityName: 'Project' } },
    { label: 'reserved framework entity User', cookie: alice.cookie, payload: { name: 'k10', entityName: 'User', role: 'admin' } },
    { label: 'reserved framework entity ApiKey', cookie: alice.cookie, payload: { name: 'k11', entityName: 'ApiKey' } },
    { label: 'owner unscoped admin role', cookie: alice.cookie, payload: { name: 'k12', role: 'admin' } },
  ];

  for (const { label, cookie, payload } of attempts) {
    const { status } = await createKey(origin, { cookie }, payload);
    assert.equal(status, 403, `${label} must be rejected with 403`);
  }

  assert.equal(app.db.prepare('SELECT count(*) AS n FROM ApiKey').get().n, 0, 'no API key rows persisted');
});

test('entity owner without admin capability cannot mint a scoped API key', async (t) => {
  const { app, Note, origin } = await bootApp(t);
  const alice = await registerUser(origin, 'alice');
  app.entity(Note).insert({ id: 'n1', body: 'mine', owner: alice.user.id });

  const r1 = await createKey(origin, { cookie: alice.cookie }, { name: 'note-admin', entityName: 'Note', role: 'admin' });
  const r2 = await createKey(origin, { cookie: alice.cookie }, { name: 'note-owner', entityName: 'Note', role: 'owner' });
  const r3 = await createKey(origin, { cookie: alice.cookie }, { name: 'note-scope', entityName: 'Note' });

  assert.equal(r1.status, 403);
  assert.equal(r2.status, 403);
  assert.equal(r3.status, 403);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM ApiKey').get().n, 0);
});

test('entity admin can mint legitimate scoped API keys and use them via Bearer auth', async (t) => {
  const { app, Project, origin } = await bootApp(t);
  const alice = await registerUser(origin, 'alice');
  app.entity(Project).insert({ id: 'p1', title: 'Alpha', owner: alice.user.id });

  const adminKey = await createKey(origin, { cookie: alice.cookie }, {
    name: 'proj-admin',
    entityName: 'Project',
    role: 'admin',
    expiresAt: Date.now() + 60_000,
  });
  assert.equal(adminKey.status, 201);
  assert.ok(adminKey.body.token);

  const viewerKey = await createKey(origin, { cookie: alice.cookie }, {
    name: 'proj-viewer',
    entityName: 'Project',
    role: 'viewer',
  });
  assert.equal(viewerKey.status, 201);

  const entityOnlyKey = await createKey(origin, { cookie: alice.cookie }, {
    name: 'proj-entity',
    entityName: 'Project',
  });
  assert.equal(entityOnlyKey.status, 201);

  const resolver = apiKeyPrincipalOf(app.db);
  const pAdmin = resolver({ headers: { authorization: `Bearer ${adminKey.body.token}` } });
  assert.equal(pAdmin.type, 'apiKey');
  assert.equal(pAdmin.attributes.entityName, 'Project');
  assert.equal(pAdmin.attributes.role, 'admin');

  const pViewer = resolver({ headers: { authorization: `Bearer ${viewerKey.body.token}` } });
  assert.equal(pViewer.type, 'apiKey');
  assert.equal(pViewer.attributes.entityName, 'Project');
  assert.equal(pViewer.attributes.role, 'viewer');

  const pEntityOnly = resolver({ headers: { authorization: `Bearer ${entityOnlyKey.body.token}` } });
  assert.equal(pEntityOnly.type, 'apiKey');
  assert.equal(pEntityOnly.attributes.entityName, 'Project');
  assert.equal(pEntityOnly.attributes.role, undefined);

  // Admin still cannot mint undeclared / bogus roles on the entity.
  for (const bogusRole of ['superadmin', 'root', 'toString', 'constructor']) {
    const bad = await createKey(origin, { cookie: alice.cookie }, {
      name: `bad-${bogusRole}`,
      entityName: 'Project',
      role: bogusRole,
    });
    assert.equal(bad.status, 400, `undeclared role '${bogusRole}' must fail closed with 400`);
  }
});

test('malformed name, entityName, role, unknown entityName, and malformed expiresAt fail closed with 400', async (t) => {
  const { app, Project, origin } = await bootApp(t);
  const alice = await registerUser(origin, 'alice');
  app.entity(Project).insert({ id: 'p1', title: 'Alpha', owner: alice.user.id });

  const invalidPayloads = [
    { label: 'whitespace name', payload: { name: '   ' } },
    { label: 'numeric name', payload: { name: 123 } },
    { label: 'unknown entityName', payload: { name: 'k', entityName: 'NoSuchEntity' } },
    { label: 'prototype entityName', payload: { name: 'k', entityName: '__proto__' } },
    { label: 'empty entityName', payload: { name: 'k', entityName: '' } },
    { label: 'sql injection entityName', payload: { name: 'k', entityName: 'Project; DROP TABLE User' } },
    { label: 'non-string entityName', payload: { name: 'k', entityName: 42 } },
    { label: 'empty role', payload: { name: 'k', entityName: 'Project', role: '' } },
    { label: 'malformed role chars', payload: { name: 'k', entityName: 'Project', role: 'admin; --' } },
    { label: 'non-string role', payload: { name: 'k', entityName: 'Project', role: ['admin'] } },
    { label: 'string expiresAt', payload: { name: 'k', expiresAt: 'not-a-timestamp' } },
    { label: 'ISO string expiresAt', payload: { name: 'k', expiresAt: '2099-01-01T00:00:00.000Z' } },
    { label: 'zero expiresAt', payload: { name: 'k', expiresAt: 0 } },
    { label: 'negative expiresAt', payload: { name: 'k', expiresAt: -1000 } },
    { label: 'boolean expiresAt', payload: { name: 'k', expiresAt: true } },
    { label: 'object expiresAt', payload: { name: 'k', expiresAt: {} } },
  ];

  for (const { label, payload } of invalidPayloads) {
    const { status } = await createKey(origin, { cookie: alice.cookie }, payload);
    assert.equal(status, 400, `${label} must fail closed with 400`);
  }

  assert.equal(app.db.prepare('SELECT count(*) AS n FROM ApiKey').get().n, 0);
});

test('an apiKey principal cannot mint, list, or revoke API keys', async (t) => {
  const { app, origin } = await bootApp(t);
  const alice = await registerUser(origin, 'alice');

  const plain = await createKey(origin, { cookie: alice.cookie }, { name: 'plain-key' });
  assert.equal(plain.status, 201);
  const bearer = { authorization: `Bearer ${plain.body.token}` };

  const createAttempt = await createKey(origin, bearer, { name: 'chained-key' });
  assert.equal(createAttempt.status, 403);

  const listAttempt = await fetch(`${origin}/auth/api-key`, { headers: bearer });
  assert.equal(listAttempt.status, 403);

  const deleteAttempt = await fetch(`${origin}/auth/api-key/${plain.body.id}`, {
    method: 'DELETE',
    headers: bearer,
  });
  assert.equal(deleteAttempt.status, 403);

  // Legitimate Bearer access to a normal route still works.
  const notesRes = await fetch(`${origin}/notes`, { headers: bearer });
  assert.equal(notesRes.status, 200);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM ApiKey').get().n, 1);
});

test('apiKeyPrincipalOf fails closed on corrupt expiresAt, unscoped role, or malformed/reserved entityName in DB', () => {
  const app = workbench({ db: ':memory:', entities: [ApiKey] });
  app.db.exec('CREATE TABLE User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  app.db.exec(
    'CREATE TABLE ApiKey (id TEXT PRIMARY KEY, tokenHash TEXT, prefix TEXT, name TEXT, entityName TEXT, role TEXT, createdBy TEXT, expiresAt REAL, createdAt TEXT)',
  );
  const ApiKeyEntity = app.entity(ApiKey);
  const resolver = apiKeyPrincipalOf(app.db);

  // Corrupt non-numeric expiresAt values must resolve to anonymous, never admit.
  for (const badExpiry of ['not-a-timestamp', '2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '']) {
    const key = ApiKeyEntity.create({ name: 'bad-exp', createdBy: 'u1' });
    app.db.prepare('UPDATE ApiKey SET expiresAt = ? WHERE id = ?').run(badExpiry, key.id);
    const p = resolver({ headers: { authorization: `Bearer ${key.plainToken}` } });
    assert.equal(p.type, 'anonymous', `corrupt expiresAt '${badExpiry}' must fail closed`);
  }

  // Valid numeric string future timestamp resolves; past numeric string fails closed.
  const futureStrKey = ApiKeyEntity.create({ name: 'future-str', createdBy: 'u1' });
  app.db.prepare('UPDATE ApiKey SET expiresAt = ? WHERE id = ?').run(String(Date.now() + 60_000), futureStrKey.id);
  assert.equal(resolver({ headers: { authorization: `Bearer ${futureStrKey.plainToken}` } }).type, 'apiKey');

  const pastStrKey = ApiKeyEntity.create({ name: 'past-str', createdBy: 'u1' });
  app.db.prepare('UPDATE ApiKey SET expiresAt = ? WHERE id = ?').run(String(Date.now() - 1_000), pastStrKey.id);
  assert.equal(resolver({ headers: { authorization: `Bearer ${pastStrKey.plainToken}` } }).type, 'anonymous');

  // Unscoped role (role without entityName) fails closed.
  const unscopedRoleKey = ApiKeyEntity.create({ name: 'unscoped', createdBy: 'u1', role: 'admin' });
  assert.equal(
    resolver({ headers: { authorization: `Bearer ${unscopedRoleKey.plainToken}` } }).type,
    'anonymous',
    'stored role without entityName must fail closed',
  );

  // Malformed entityName / role or reserved framework entityName fails closed.
  for (const { entityName, role } of [
    { entityName: 'User', role: 'admin' },
    { entityName: 'Session', role: null },
    { entityName: 'ApiKey', role: null },
    { entityName: 'Project; --', role: 'admin' },
    { entityName: '', role: null },
    { entityName: 'Project', role: 'admin; --' },
    { entityName: 'Project', role: '' },
  ]) {
    const key = ApiKeyEntity.create({ name: 'corrupt-attr', createdBy: 'u1', entityName, role });
    assert.equal(
      resolver({ headers: { authorization: `Bearer ${key.plainToken}` } }).type,
      'anonymous',
      `stored entityName=${JSON.stringify(entityName)} role=${JSON.stringify(role)} must fail closed`,
    );
  }
});

test('authRoutes authorizeApiKey option enforces custom server policy fail-closed', async (t) => {
  const Project = makeProject();
  const app = workbench({ db: ':memory:' });
  app.register(Project);
  const authEntities = Object.fromEntries(
    [User, Session, Credential, Invitation, ApiKey, TwoFactor].map((decl) => [decl.name, app.entity(decl)]),
  );
  let allow = false;
  app.mount('/auth', authRoutes({
    entities: authEntities,
    db: app.db,
    authorizeApiKey: ({ entityName, role }) => allow && entityName === 'Project' && role === 'viewer',
  }));
  app.mount('/projects', Project);
  app.listen(0);
  await app.ready;
  t.after(() => app.httpServer.close());
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  const alice = await registerUser(origin, 'alice');

  const denied = await createKey(origin, { cookie: alice.cookie }, {
    name: 'policy-denied',
    entityName: 'Project',
    role: 'viewer',
  });
  assert.equal(denied.status, 403);

  allow = true;
  const wrongRole = await createKey(origin, { cookie: alice.cookie }, {
    name: 'policy-wrong-role',
    entityName: 'Project',
    role: 'admin',
  });
  assert.equal(wrongRole.status, 403);

  const admitted = await createKey(origin, { cookie: alice.cookie }, {
    name: 'policy-ok',
    entityName: 'Project',
    role: 'viewer',
  });
  assert.equal(admitted.status, 201);
});
