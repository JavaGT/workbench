// Issue #281 — compiled SQL scope evaluation on AuthorizationAdapter resources,
// three-valued anyOf in rowMatchesScope, single rowCapabilities execution,
// membership SQL harvest role filtering, and registry harvest/run context alignment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  text, ref, map, scope, grant, deny, read, write, subscribe, anyOf, inherit,
  membership, principal, anonymous,
} from '../build/index.mjs';
import workbench, {
  entity, executeDDL, rowMatchesScope, bindReadScope,
} from '../build/internal.mjs';
import { createAuthorizationAdapter } from '../build/authorization-adapter.mjs';

const owner = principal({ type: 'user', id: 'owner-1' });
const editor = principal({ type: 'user', id: 'editor-1' });
const viewer = principal({ type: 'user', id: 'viewer-1' });
const suspended = principal({ type: 'user', id: 'suspended-1' });
const stranger = principal({ type: 'user', id: 'stranger-1' });
const revokedOwner = principal({ type: 'user', id: 'owner-1', status: 'revoked' });

function seedProjectWorkspace() {
  const db = new DatabaseSync(':memory:');
  const Project = entity('Project', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),
  });
  membership(Project, {
    editor: { can: [read, write, subscribe] },
    viewer: { can: [read, subscribe] },
  });

  const ProjectDoc = entity('ProjectDoc', {
    project: ref('Project', { required: true }),
    title: text(),
    grant: inherit(Project, { via: 'project' }),
  });

  executeDDL(Project, db);
  executeDDL(ProjectDoc, db);

  const app = workbench({ db, entities: [Project, ProjectDoc] });
  const Project_b = app.entity(Project);
  const ProjectDoc_b = app.entity(ProjectDoc);

  db.prepare('INSERT INTO Project (id, title, owner) VALUES (?, ?, ?)').run('p1', 'Shared Project', owner.id);
  db.prepare('INSERT INTO Project (id, title, owner) VALUES (?, ?, ?)').run('p2', 'Private Project', owner.id);
  db.prepare('INSERT INTO Project_members (Project_id, member_id, role) VALUES (?, ?, ?)').run('p1', editor.id, 'editor');
  db.prepare('INSERT INTO Project_members (Project_id, member_id, role) VALUES (?, ?, ?)').run('p1', viewer.id, 'viewer');
  // An unauthorized/suspended role stored in the side-table must be excluded in SQL too.
  db.prepare('INSERT INTO Project_members (Project_id, member_id, role) VALUES (?, ?, ?)').run('p1', suspended.id, 'suspended');

  db.prepare('INSERT INTO ProjectDoc (id, project, title) VALUES (?, ?, ?)').run('d1', 'p1', 'Shared Doc');
  db.prepare('INSERT INTO ProjectDoc (id, project, title) VALUES (?, ?, ?)').run('d2', 'p2', 'Private Doc');

  return { db, Project: Project_b, ProjectDoc: ProjectDoc_b, ProjectDecl: Project, ProjectDocDecl: ProjectDoc };
}

// --- 1a. SQL scope evaluation across entity, blob, search, subscription -------

test('anyOf(is.owner(), is.member()) admits owners and authorized members on entity, blob, search, and subscription', async (t) => {
  const { db, Project } = seedProjectWorkspace();
  t.after(() => db.close());

  const adapter = createAuthorizationAdapter({ db });
  adapter.registerResource({
    category: 'blob',
    name: 'project-cover',
    entity: Project,
  });
  adapter.registerResource({
    category: 'search',
    name: 'project-index',
    table: 'Project',
    scope: ({ is }) => anyOf(is.owner(), is.editor(), is.viewer()),
    fields: Project.fields,
    registry: Project.registry,
  });
  adapter.registerResource({
    category: 'subscription',
    name: 'project-stream',
    entity: Project,
  });

  const sharedRow = { id: 'p1', title: 'Shared Project', owner: owner.id };
  const privateRow = { id: 'p2', title: 'Private Project', owner: owner.id };

  // entity category
  for (const who of [owner, editor, viewer]) {
    const d = await adapter.admit({ category: 'entity', verb: 'read', principal: who, entity: Project, row: sharedRow });
    assert.equal(d.admitted, true, `entity admits ${who.id} on shared project`);
  }
  for (const who of [stranger, suspended, anonymous, revokedOwner]) {
    const d = await adapter.admit({ category: 'entity', verb: 'read', principal: who, entity: Project, row: sharedRow });
    assert.equal(d.admitted, false, `entity denies ${who.id ?? 'anon'} on shared project`);
  }

  // blob, search, subscription categories
  const resourceCases = [
    { category: 'blob', operation: 'blob-read', resourceName: 'project-cover' },
    { category: 'search', operation: 'search', resourceName: 'project-index' },
    { category: 'subscription', operation: 'subscribe', resourceName: 'project-stream' },
  ];

  for (const rc of resourceCases) {
    for (const who of [owner, editor, viewer]) {
      const admitted = await adapter.admit({ ...rc, principal: who, row: sharedRow });
      assert.equal(admitted.admitted, true, `${rc.category} admits ${who.id} on p1`);
    }
    // Owner admitted on private project; members denied on private project
    assert.equal((await adapter.admit({ ...rc, principal: owner, row: privateRow })).admitted, true, `${rc.category} admits owner on p2`);
    assert.equal((await adapter.admit({ ...rc, principal: editor, row: privateRow })).admitted, false, `${rc.category} denies editor on p2`);

    // Unauthorized principals denied
    for (const who of [stranger, suspended, anonymous, revokedOwner]) {
      const denied = await adapter.admit({ ...rc, principal: who, row: sharedRow });
      assert.equal(denied.admitted, false, `${rc.category} denies ${who.id ?? 'anon'} on p1`);
      assert.equal(denied.reasonCode, 'no-row-scope');
    }

    // Forged in-memory row claiming stranger is owner must still be denied by SQL
    const forged = await adapter.admit({ ...rc, principal: stranger, row: { id: 'p1', title: 'Shared Project', owner: stranger.id } });
    assert.equal(forged.admitted, false, `${rc.category} denies forged row via SQL`);
    assert.equal(forged.reasonCode, 'no-row-scope');
  }
});

test('inherit(Project) admits owners and authorized members on entity, blob, search, and subscription', async (t) => {
  const { db, ProjectDecl, ProjectDoc } = seedProjectWorkspace();
  t.after(() => db.close());

  // Use an adapter WITHOUT { db } for bound-entity registrations (resolves runtime.db)
  // AND an adapter WITH { db } for explicit table + inherit() registrations.
  const runtimeAdapter = createAuthorizationAdapter();
  runtimeAdapter.registerResource({ category: 'blob', name: 'doc-attachment', entity: ProjectDoc });
  runtimeAdapter.registerResource({ category: 'subscription', name: 'doc-events', entity: ProjectDoc });

  const dbAdapter = createAuthorizationAdapter({ db });
  dbAdapter.registerResource({
    category: 'search',
    name: 'doc-search',
    table: 'ProjectDoc',
    scope: inherit(ProjectDecl, { via: 'project' }),
  });

  const sharedDoc = { id: 'd1', project: 'p1', title: 'Shared Doc' };
  const privateDoc = { id: 'd2', project: 'p2', title: 'Private Doc' };

  // entity category
  for (const who of [owner, editor, viewer]) {
    const d = await runtimeAdapter.admit({ category: 'entity', verb: 'read', principal: who, entity: ProjectDoc, row: sharedDoc });
    assert.equal(d.admitted, true, `entity inherit admits ${who.id}`);
  }
  for (const who of [stranger, suspended, anonymous, revokedOwner]) {
    const d = await runtimeAdapter.admit({ category: 'entity', verb: 'read', principal: who, entity: ProjectDoc, row: sharedDoc });
    assert.equal(d.admitted, false, `entity inherit denies ${who.id ?? 'anon'}`);
  }

  // blob, search, subscription categories
  const checks = [
    { adapter: runtimeAdapter, category: 'blob', operation: 'blob-read', resourceName: 'doc-attachment' },
    { adapter: dbAdapter, category: 'search', operation: 'search', resourceName: 'doc-search' },
    { adapter: runtimeAdapter, category: 'subscription', operation: 'subscribe', resourceName: 'doc-events' },
  ];

  for (const c of checks) {
    for (const who of [owner, editor, viewer]) {
      const d = await c.adapter.admit({ category: c.category, operation: c.operation, resourceName: c.resourceName, principal: who, row: sharedDoc });
      assert.equal(d.admitted, true, `${c.category} inherit admits ${who.id} on d1`);
    }
    assert.equal(
      (await c.adapter.admit({ category: c.category, operation: c.operation, resourceName: c.resourceName, principal: owner, row: privateDoc })).admitted,
      true,
      `${c.category} inherit admits owner on d2`,
    );
    assert.equal(
      (await c.adapter.admit({ category: c.category, operation: c.operation, resourceName: c.resourceName, principal: editor, row: privateDoc })).admitted,
      false,
      `${c.category} inherit denies editor on d2`,
    );
    for (const who of [stranger, suspended, anonymous, revokedOwner]) {
      const d = await c.adapter.admit({ category: c.category, operation: c.operation, resourceName: c.resourceName, principal: who, row: sharedDoc });
      assert.equal(d.admitted, false, `${c.category} inherit denies ${who.id ?? 'anon'} on d1`);
      assert.equal(d.reasonCode, 'no-row-scope');
    }
  }
});

// --- 1b. Three-valued logic in rowMatchesScope() ------------------------------

test('rowMatchesScope 3VL: anyOf(owner, membership) admits owner in either operand order and denies non-owners', () => {
  const DocA = entity('DocA', {
    owner: ref('User', { role: 'owner' }),
    members: map(ref('User')),
    checks: { member: ({ DocA, principal: p }) => DocA.members.has(p.id) },
    grant: () => [scope(({ is }) => anyOf(is.owner(), is.member())).can(() => grant(read))],
  });
  const DocB = entity('DocB', {
    owner: ref('User', { role: 'owner' }),
    members: map(ref('User')),
    checks: { member: ({ DocB, principal: p }) => DocB.members.has(p.id) },
    grant: () => [scope(({ is }) => anyOf(is.member(), is.owner())).can(() => grant(read))],
  });

  for (const Doc of [DocA, DocB]) {
    const template = { ...Doc.readScope, nearest: null, ast: Doc.scopeAst };
    const row = { id: 'r1', owner: owner.id };
    assert.equal(rowMatchesScope(template, row, owner), true, `${Doc.name}: owner admitted`);
    assert.equal(rowMatchesScope(template, row, editor), false, `${Doc.name}: non-owner fails closed without DB`);
    assert.equal(rowMatchesScope(template, row, anonymous), false, `${Doc.name}: anonymous fails closed`);
    assert.equal(rowMatchesScope(template, { id: 'r1', owner: null }, owner), false, `${Doc.name}: null owner fails closed`);
  }
});

// --- 2. Single rowCapabilities / .can execution per admitted request ----------

test('admit() executes .can exactly once per admitted request for both direct and inherited entities', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());

  let parentCanCalls = 0;
  const Parent = entity('SingleCanParent', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) => {
        parentCanCalls += 1;
        return (await is.owner()) ? grant(read, write, subscribe) : deny('no');
      }),
    ],
  });
  const Child = entity('SingleCanChild', {
    parent: ref('SingleCanParent', { required: true }),
    body: text(),
    grant: inherit(Parent, { via: 'parent' }),
  });

  executeDDL(Parent, db);
  executeDDL(Child, db);
  const app = workbench({ db, entities: [Parent, Child] });
  const Parent_b = app.entity(Parent);
  const Child_b = app.entity(Child);

  db.prepare('INSERT INTO SingleCanParent (id, title, owner) VALUES (?, ?, ?)').run('p1', 'Mine', owner.id);
  db.prepare('INSERT INTO SingleCanChild (id, parent, body) VALUES (?, ?, ?)').run('c1', 'p1', 'Hello');

  const adapter = createAuthorizationAdapter({ db });

  parentCanCalls = 0;
  const direct = await adapter.admit({
    category: 'entity', verb: 'update', principal: owner, entity: Parent_b, row: { id: 'p1', title: 'Mine', owner: owner.id },
  });
  assert.equal(direct.admitted, true);
  assert.deepEqual(direct.capabilities, [read, write, subscribe]);
  assert.equal(parentCanCalls, 1, 'direct entity admission executes .can once');

  parentCanCalls = 0;
  const inherited = await adapter.admit({
    category: 'entity', verb: 'update', principal: owner, entity: Child_b, row: { id: 'c1', parent: 'p1', body: 'Hello' },
  });
  assert.equal(inherited.admitted, true);
  assert.deepEqual(inherited.capabilities, [read, write, subscribe]);
  assert.equal(parentCanCalls, 1, 'inherited entity admission executes parent .can once');
});

// --- 3. Membership SQL harvest role filter (#248 descriptor.roles) ------------

test('membership SQL harvest excludes unauthorized roles using descriptor.roles and explicit field.role', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());

  const EditorOnly = entity('EditorOnlyProject', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),
    // No explicit field: { role: 'editor' } — must derive ['editor'] from descriptor.roles!
    membership: {
      editor: { can: [read, write] },
    },
  });

  executeDDL(EditorOnly, db);
  db.prepare('INSERT INTO EditorOnlyProject (id, title, owner) VALUES (?, ?, ?)').run('p1', 'Secret', owner.id);
  db.prepare('INSERT INTO EditorOnlyProject_members (EditorOnlyProject_id, member_id, role) VALUES (?, ?, ?)').run('p1', editor.id, 'editor');
  db.prepare('INSERT INTO EditorOnlyProject_members (EditorOnlyProject_id, member_id, role) VALUES (?, ?, ?)').run('p1', viewer.id, 'viewer');

  assert.match(EditorOnly.readScope.sql, /\.role IN \(/i, 'harvested SQL includes role filter predicate');

  const visibleIds = (who) => {
    const bound = bindReadScope(EditorOnly.readScope, who);
    return db.prepare(`SELECT id FROM EditorOnlyProject AS t0 WHERE ${bound.sql}`).all(bound.params).map((r) => r.id);
  };

  assert.deepEqual(visibleIds(owner), ['p1'], 'owner sees row via SQL');
  assert.deepEqual(visibleIds(editor), ['p1'], 'editor sees row via SQL');
  assert.deepEqual(visibleIds(viewer), [], 'viewer is excluded by SQL role filter');
  assert.deepEqual(visibleIds(stranger), [], 'stranger is excluded by SQL');
});

test('membership SQL harvest works cleanly on role-less map fields (no role column)', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());

  const SimpleTeam = entity('SimpleTeam', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User')),
    membership: {
      member: { can: [read] },
    },
  });

  executeDDL(SimpleTeam, db);
  db.prepare('INSERT INTO SimpleTeam (id, title, owner) VALUES (?, ?, ?)').run('t1', 'Team', owner.id);
  db.prepare('INSERT INTO SimpleTeam_members (SimpleTeam_id, member_id) VALUES (?, ?)').run('t1', editor.id);

  assert.doesNotMatch(SimpleTeam.readScope.sql, /\.role IN \(/i, 'role-less map omits role predicate');
  const bound = bindReadScope(SimpleTeam.readScope, editor);
  const rows = db.prepare(`SELECT id FROM SimpleTeam AS t0 WHERE ${bound.sql}`).all(bound.params);
  assert.deepEqual(rows.map((r) => r.id), ['t1']);
});

// --- 4. Registry harvest vs run context alignment -----------------------------

test('declared check using { entity, principal } works in BOTH scope harvest (SQL) and runtime .can', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());

  const SharedNote = entity('SharedNote', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),
    checks: {
      // Uses generic `{ entity, principal }` instead of `{ SharedNote, principal }`
      collaborator: ({ entity: self, principal: p }) => self.members.has(p.id),
    },
    grant: () => [
      scope(({ is }) => anyOf(is.owner(), is.collaborator())).can(async ({ is }) => {
        if (await is.owner()) return grant(read, write, subscribe);
        if (await is.collaborator()) return grant(read);
        return deny('no');
      }),
    ],
  });

  executeDDL(SharedNote, db);
  const app = workbench({ db, entities: [SharedNote] });
  const SharedNote_b = app.entity(SharedNote);

  db.prepare('INSERT INTO SharedNote (id, title, owner) VALUES (?, ?, ?)').run('n1', 'Hello', owner.id);
  db.prepare('INSERT INTO SharedNote_members (SharedNote_id, member_id, role) VALUES (?, ?, ?)').run('n1', editor.id, 'viewer');

  const bound = bindReadScope(SharedNote_b.readScope, editor);
  const ids = db.prepare(`SELECT id FROM SharedNote AS t0 WHERE ${bound.sql}`).all(bound.params).map((r) => r.id);
  assert.deepEqual(ids, ['n1'], 'harvested SQL admits collaborator using { entity, principal }');

  const adapter = createAuthorizationAdapter({ db });
  const admitted = await adapter.admit({
    category: 'entity', verb: 'read', principal: editor, entity: SharedNote_b, row: { id: 'n1', title: 'Hello', owner: owner.id },
  });
  assert.equal(admitted.admitted, true, 'runtime .can admits collaborator using { entity, principal }');
  assert.deepEqual(admitted.capabilities, [read]);

  const denied = await adapter.admit({
    category: 'entity', verb: 'read', principal: stranger, entity: SharedNote_b, row: { id: 'n1', title: 'Hello', owner: owner.id },
  });
  assert.equal(denied.admitted, false);
});
