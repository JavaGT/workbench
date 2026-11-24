// membership-example: a Project entity with owner + members,
// a Document entity inheriting from Project, demonstrating read/write/subscribe
// with two-plane auth driven by a single membership() call.
//
// Run: node --test projects/membership-example.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  entity, map, ref, owner, text, read, write as _write, subscribe, inherit, membership,
} from '../build/index.mjs';
import workbench, { executeDDL } from '../build/internal.mjs';
import { principal } from '../build/principal.mjs';

// ---- Entities ----

const projectMembership = { member: { can: [read, subscribe] } };

const Project = entity('Project', {
  title: text(),
  owner: owner(),
  members: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),
});
membership(Project, projectMembership);

const Document = entity('Document', {
  title: text(),
  project: ref('Project', { required: true }),

  grant: inherit(Project, { via: 'project' }),
});

// ---- Test: end-to-end two-plane auth ----

test('membership example: owner has full access', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeDDL(Project, db);
  executeDDL(Document, db);

  // Seed: a project owned by alice, with bob as member
  db.prepare('INSERT INTO Project (id, title, owner) VALUES (?, ?, ?)')
    .run('proj-1', 'Alice project', 'alice');
  db.prepare('INSERT INTO Project_members (Project_id, member_id, role) VALUES (?, ?, ?)')
    .run('proj-1', 'bob', 'editor');
  db.prepare('INSERT INTO Document (id, title, project) VALUES (?, ?, ?)')
    .run('doc-1', 'Alice document', 'proj-1');

  const alice = principal({ type: 'user', id: 'alice' });
  const _bob = principal({ type: 'user', id: 'bob' });
  const _carol = principal({ type: 'user', id: 'carol' });

  const app = workbench({ db });
  app.mount('/projects', Project);
  app.mount('/documents', Document);
  app.listen(0, { principalOf: () => alice });
  await app.ready;
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  // Owner can read own project
  const projRead = await fetch(`${origin}/projects/proj-1`);
  assert.equal(projRead.status, 200);
  assert.equal((await projRead.json()).title, 'Alice project');

  // Owner can write own project
  const projWrite = await fetch(`${origin}/projects/proj-1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Alice project (updated)' }),
  });
  assert.equal(projWrite.status, 200);

  // Owner can read inherited document
  const docRead = await fetch(`${origin}/documents/doc-1`);
  assert.equal(docRead.status, 200);
  assert.equal((await docRead.json()).title, 'Alice document');

  app.httpServer.close();
});

test('membership example: member can read but not write', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeDDL(Project, db);
  executeDDL(Document, db);

  db.prepare('INSERT INTO Project (id, title, owner) VALUES (?, ?, ?)')
    .run('proj-1', 'Alice project', 'alice');
  db.prepare('INSERT INTO Project_members (Project_id, member_id, role) VALUES (?, ?, ?)')
    .run('proj-1', 'bob', 'editor');
  db.prepare('INSERT INTO Document (id, title, project) VALUES (?, ?, ?)')
    .run('doc-1', 'Alice document', 'proj-1');

  const bob = principal({ type: 'user', id: 'bob' });

  const app = workbench({ db });
  app.mount('/projects', Project);
  app.mount('/documents', Document);
  app.listen(0, { principalOf: () => bob });
  await app.ready;
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  // Member can list projects (read-scope)
  const list = await fetch(`${origin}/projects`);
  assert.equal(list.status, 200);
  const rows = await list.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'proj-1');

  // Member can read a project
  const projRead = await fetch(`${origin}/projects/proj-1`);
  assert.equal(projRead.status, 200);
  assert.equal((await projRead.json()).title, 'Alice project');

  // Member cannot write (only read+subscribe granted)
  const projWrite = await fetch(`${origin}/projects/proj-1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Hijacked' }),
  });
  assert.equal(projWrite.status, 403, 'member cannot write');

  // Member can read inherited document
  const docRead = await fetch(`${origin}/documents/doc-1`);
  assert.equal(docRead.status, 200);

  // Member cannot write inherited document
  const docWrite = await fetch(`${origin}/documents/doc-1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Hijacked' }),
  });
  assert.equal(docWrite.status, 403, 'member cannot write inherited document');

  app.httpServer.close();
});

test('membership example: non-member is rejected', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeDDL(Project, db);
  executeDDL(Document, db);

  db.prepare('INSERT INTO Project (id, title, owner) VALUES (?, ?, ?)')
    .run('proj-1', 'Alice project', 'alice');
  db.prepare('INSERT INTO Document (id, title, project) VALUES (?, ?, ?)')
    .run('doc-1', 'Alice document', 'proj-1');

  const carol = principal({ type: 'user', id: 'carol' });

  const app = workbench({ db });
  app.mount('/projects', Project);
  app.mount('/documents', Document);
  app.listen(0, { principalOf: () => carol });
  await app.ready;
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  // Non-member sees empty list
  const list = await fetch(`${origin}/projects`);
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), []);

  // Non-member gets 404 on project read
  const projRead = await fetch(`${origin}/projects/proj-1`);
  assert.equal(projRead.status, 404);

  // Non-member gets 404 on document read
  const docRead = await fetch(`${origin}/documents/doc-1`);
  assert.equal(docRead.status, 404);

  app.httpServer.close();
});

test('membership example: checks object is callable', () => {
  // Verify the membership helper populated entity.checks
  assert.equal(typeof Project.checks.owner, 'function', 'is.owner exists');
  assert.equal(typeof Project.checks.member, 'function', 'is.member exists');
});

test('membership example: grant is a thunk returning scope+can clause', () => {
  const clauses = Project.grant();
  assert.ok(Array.isArray(clauses), 'grant() returns an array');
  assert.equal(clauses.length, 1, 'one clause');
  assert.equal(typeof clauses[0].predicate, 'function', 'has scope predicate');
  assert.equal(typeof clauses[0].can, 'function', 'has .can body');
});
