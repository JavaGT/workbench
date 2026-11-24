import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  assertNoFrameworkTableSql,
  claimedBlobLifecycle,
  createLiveDelivery,
  createSchemaReport,
  declaredTableNames,
  EMPTY_BLOB_CENSUS,
  executeDDL,
  frameworkTableNames,
  readCommittedCursor,
} from '../build/server.mjs';
import { entity, grant, read, subscribe, text, snapshot } from '../build/index.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { scope } from '../build/scope.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('server exports the claimed blob lifecycle facade', () => {
  assert.equal(typeof claimedBlobLifecycle, 'function');
});

test('server exports the promoted DDL, blob-census, and schema-report contract', () => {
  // Wave 1 promoted these from internal paths onto the public server surface.
  assert.equal(typeof executeDDL, 'function');
  assert.equal(typeof executeFrameworkDDL, 'function');
  assert.equal(typeof createSchemaReport, 'function');
  assert.equal(typeof EMPTY_BLOB_CENSUS, 'object');
  assert.deepEqual(EMPTY_BLOB_CENSUS.references, []);
});

function appendEvent(db, scope, seq, type, data = {}) {
  db.prepare(`
    INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(scope, seq, type, JSON.stringify(data), `action-${seq}`, '2026-07-26T00:00:00.000Z');
  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET lastSeq = excluded.lastSeq')
    .run(scope, seq);
}

function noteEntity() {
  return {
    name: 'Note',
    fields: { title: { kind: 'value' } },
    // Declare a real read/subscribe capability. An empty grant array is no
    // longer a permissive fixture: fail-closed mayRow (and live admission)
    // consult the declared grant before an injected mayVerb, so a grant-less
    // entity would revoke every subscription/catch-up regardless of injection.
    grant: () => [scope(() => true).can(() => grant(read, subscribe))],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
}

test('declared relational snapshots gate every row, hide denied counts, enforce ref joins and deterministic ties', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE Comment (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), body TEXT, rank INTEGER, visible INTEGER);');
  db.prepare('INSERT INTO Project VALUES (?, ?)').run('p1', 'One');
  db.prepare('INSERT INTO Project VALUES (?, ?)').run('p2', 'Two');
  for (const row of [['c2', 'p1', 'second', 1, 1], ['c1', 'p1', 'first', 1, 1], ['hidden', 'p1', 'hidden', 0, 0], ['injected', 'p2', 'other project', 0, 1]]) db.prepare('INSERT INTO Comment VALUES (?, ?, ?, ?, ?)').run(...row);
  const ownGrant = () => [scope(() => true).can(() => grant(subscribe))];
  const project = { name: 'Project', fields: { name: { kind: 'value', type: 'text' } }, field: { id: { fieldName: 'id' }, name: { fieldName: 'name' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ id: row.id, name: row.name }) };
  const comment = { name: 'Comment', fields: { projectId: { kind: 'value', type: 'ref', target: project }, body: { kind: 'value', type: 'text' }, rank: { kind: 'value', type: 'number' } }, field: { id: { fieldName: 'id' }, projectId: { fieldName: 'projectId' }, body: { fieldName: 'body' }, rank: { fieldName: 'rank' } }, grant: ownGrant, scopeFilter: () => ({ sql: 't0.visible = 1', params: {} }), hydrate: (row) => ({ id: row.id, projectId: row.projectId, body: row.body, rank: row.rank }) };
  const declaration = snapshot(project, { output: snapshot.object({
    name: snapshot.select(project.field.name),
    comments: snapshot.many(comment, { via: comment.field.projectId, select: snapshot.select(comment.field.body, comment.field.rank), orderBy: snapshot.orderBy(comment.field.rank) }),
    visibleCount: snapshot.count(comment, { via: comment.field.projectId }),
  }) });
  const live = createLiveDelivery({ db, entities: new Map([['Project', project], ['Comment', comment]]), mayVerb: (_entity, _verb, row) => row.id !== 'c2', snapshots: [declaration] });
  const result = await live.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1' });
  assert.deepEqual(result.snapshot, { id: 'p1', name: 'One', comments: [{ id: 'c1', body: 'first', rank: 1 }], visibleCount: 1 });
  assert.deepEqual(result.cursor, { anchor: 0, aggregate: 0 });
  assert.equal(JSON.stringify(result).includes('hidden'), false);
  assert.equal(JSON.stringify(result).includes('injected'), false);
  assert.throws(() => snapshot.many(project, { select: snapshot.select(project.field.name) }), /via requires/);
  db.close();
});

test('declared tombstones exclude hidden targets from every snapshot appearance and fail closed', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE Comment (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), body TEXT); CREATE TABLE Tombstone (id TEXT PRIMARY KEY, entityId TEXT REFERENCES Project(id), kind TEXT, state TEXT);');
  db.prepare('INSERT INTO Project VALUES (?, ?)').run('visible', 'Visible');
  db.prepare('INSERT INTO Project VALUES (?, ?)').run('deleted', 'Deleted');
  db.prepare('INSERT INTO Project VALUES (?, ?)').run('pending', 'Pending');
  db.prepare('INSERT INTO Project VALUES (?, ?)').run('restored', 'Restored');
  db.prepare('INSERT INTO Comment VALUES (?, ?, ?)').run('c1', 'deleted', 'must not appear');
  db.prepare('INSERT INTO Tombstone VALUES (?, ?, ?, ?)').run('t1', 'deleted', 'project', 'deleted');
  db.prepare('INSERT INTO Tombstone VALUES (?, ?, ?, ?)').run('t2', 'pending', 'project', 'purge_pending');
  db.prepare('INSERT INTO Tombstone VALUES (?, ?, ?, ?)').run('t3', 'restored', 'project', 'restored');
  const ownGrant = () => [scope(() => true).can(() => grant(subscribe))];
  const project = { name: 'Project', fields: { name: { kind: 'value', type: 'text' } }, field: { id: { fieldName: 'id' }, name: { fieldName: 'name' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const comment = { name: 'Comment', fields: { projectId: { kind: 'value', type: 'ref', target: project }, body: { kind: 'value', type: 'text' } }, field: { projectId: { fieldName: 'projectId' }, body: { fieldName: 'body' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const tombstone = { name: 'Tombstone', fields: { entityId: { kind: 'value', type: 'ref', target: project }, kind: { kind: 'value', type: 'text' }, state: { kind: 'value', type: 'text' } }, field: { entityId: { fieldName: 'entityId' }, kind: { fieldName: 'kind' }, state: { fieldName: 'state' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const declaration = snapshot(project, { tombstones: snapshot.tombstones(project, { entity: tombstone, entityId: tombstone.field.entityId, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'project', hidden: ['deleted', 'purge_pending'] }), output: snapshot.object({ name: snapshot.select(project.field.name), comments: snapshot.many(comment, { via: comment.field.projectId, select: snapshot.select(comment.field.body) }), commentCount: snapshot.count(comment, { via: comment.field.projectId }) }) });
  const live = createLiveDelivery({ db, entities: new Map([['Project', project], ['Comment', comment], ['Tombstone', tombstone]]), mayVerb: () => true, snapshots: [declaration] });
  for (const id of ['deleted', 'pending']) assert.deepEqual(await live.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: `Project:${id}` }), { kind: 'revoked' });
  assert.deepEqual((await live.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:restored' })).snapshot, { id: 'restored', name: 'Restored', comments: [], commentCount: 0 });
  db.exec('DROP TABLE Tombstone');
  assert.deepEqual(await live.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:visible' }), { kind: 'revoked' });
  db.close();
});

test('project-scoped polymorphic tombstones hide only the matching project kind', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE Tombstone (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), entityId TEXT, kind TEXT, state TEXT);');
  db.prepare('INSERT INTO Project VALUES (?, ?)').run('p1', 'One');
  db.prepare('INSERT INTO Project VALUES (?, ?)').run('p2', 'Two');
  db.prepare('INSERT INTO Tombstone VALUES (?, ?, ?, ?, ?)').run('child', 'p1', 'p1', 'artefact', 'deleted');
  db.prepare('INSERT INTO Tombstone VALUES (?, ?, ?, ?, ?)').run('project', 'p2', 'p2', 'project', 'deleted');
  const ownGrant = () => [scope(() => true).can(() => grant(subscribe))];
  const project = { name: 'Project', fields: { name: { kind: 'value', type: 'text' } }, field: { name: { fieldName: 'name' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const tombstone = { name: 'Tombstone', fields: { projectId: { kind: 'value', type: 'ref', target: project }, entityId: { kind: 'value', type: 'text' }, kind: { kind: 'value', type: 'text' }, state: { kind: 'value', type: 'text' } }, field: { projectId: { fieldName: 'projectId' }, entityId: { fieldName: 'entityId' }, kind: { fieldName: 'kind' }, state: { fieldName: 'state' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const visibility = snapshot.tombstones(project, { entity: tombstone, entityId: tombstone.field.entityId, scopeId: tombstone.field.projectId, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'project', hidden: ['deleted'] });
  const live = createLiveDelivery({ db, entities: new Map([['Project', project], ['Tombstone', tombstone]]), mayVerb: () => true, snapshots: [snapshot(project, { tombstones: visibility, output: snapshot.object({ project: snapshot.select(project.field.name) }) })] });
  assert.equal((await live.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1' })).snapshot.name, 'One');
  assert.deepEqual(await live.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p2' }), { kind: 'revoked' });
  db.close();
});

test('identity-only terminal tombstone scopes retain an enforced FK after target erasure', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('PRAGMA foreign_keys = ON; CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE ProjectErasureIdentity (id TEXT PRIMARY KEY); CREATE TABLE Tombstone (id TEXT PRIMARY KEY, projectId TEXT REFERENCES ProjectErasureIdentity(id) ON DELETE RESTRICT, entityId TEXT, kind TEXT, state TEXT);');
  db.prepare('INSERT INTO Project VALUES (?, ?)').run('p1', 'Sensitive project');
  db.prepare('INSERT INTO ProjectErasureIdentity VALUES (?)').run('p1');
  db.prepare('INSERT INTO Tombstone VALUES (?, ?, ?, ?, ?)').run('t1', 'p1', 'p1', 'project', 'deleted');
  const ownGrant = () => [scope(() => true).can(() => grant(subscribe))];
  const project = { name: 'Project', fields: { name: { kind: 'value', type: 'text' } }, field: { name: { fieldName: 'name' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const terminalScope = { name: 'ProjectErasureIdentity', fields: {}, field: { id: { fieldName: 'id' } }, grant: ownGrant, scopeFilter: () => ({ sql: '0=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const tombstone = { name: 'Tombstone', fields: { projectId: { kind: 'value', type: 'ref', target: terminalScope }, entityId: { kind: 'value', type: 'text' }, kind: { kind: 'value', type: 'text' }, state: { kind: 'value', type: 'text' } }, field: { projectId: { fieldName: 'projectId' }, entityId: { fieldName: 'entityId' }, kind: { fieldName: 'kind' }, state: { fieldName: 'state' } }, grant: ownGrant, scopeFilter: () => ({ sql: '0=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const declaration = snapshot(project, { tombstones: snapshot.tombstones(project, { entity: tombstone, entityId: tombstone.field.entityId, scopeId: tombstone.field.projectId, terminalScope, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'project', hidden: ['deleted'] }), output: snapshot.object({ name: snapshot.select(project.field.name) }) });
  const live = createLiveDelivery({ db, entities: new Map([['Project', project], ['ProjectErasureIdentity', terminalScope], ['Tombstone', tombstone]]), mayVerb: () => true, snapshots: [declaration] });
  assert.deepEqual(await live.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1' }), { kind: 'revoked' });
  db.prepare('DELETE FROM Project WHERE id = ?').run('p1');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Tombstone WHERE projectId = ?').get('p1').count, 1);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.throws(() => db.prepare('DELETE FROM ProjectErasureIdentity WHERE id = ?').run('p1'), /FOREIGN KEY/);
  const payloadScope = { ...terminalScope, fields: { label: { kind: 'value', type: 'text' } } };
  const payloadTombstone = { ...tombstone, fields: { ...tombstone.fields, projectId: { kind: 'value', type: 'ref', target: payloadScope } } };
  const unsafeDeclaration = snapshot(project, { tombstones: snapshot.tombstones(project, { entity: payloadTombstone, entityId: tombstone.field.entityId, scopeId: tombstone.field.projectId, terminalScope: payloadScope, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'project', hidden: ['deleted'] }), output: snapshot.object({}) });
  assert.throws(() => createLiveDelivery({ db, entities: new Map([['Project', project], ['ProjectErasureIdentity', payloadScope], ['Tombstone', payloadTombstone]]), mayVerb: () => true, snapshots: [unsafeDeclaration] }), /identity-only/);
  db.exec('CREATE TABLE CascadeTombstone (id TEXT PRIMARY KEY, projectId TEXT REFERENCES ProjectErasureIdentity(id) ON DELETE CASCADE, entityId TEXT, kind TEXT, state TEXT);');
  const cascadeTombstone = { ...tombstone, name: 'CascadeTombstone' };
  const cascadeDeclaration = snapshot(project, { tombstones: snapshot.tombstones(project, { entity: cascadeTombstone, entityId: cascadeTombstone.field.entityId, scopeId: cascadeTombstone.field.projectId, terminalScope, kind: cascadeTombstone.field.kind, state: cascadeTombstone.field.state, kindValue: 'project', hidden: ['deleted'] }), output: snapshot.object({}) });
  assert.throws(() => createLiveDelivery({ db, entities: new Map([['Project', project], ['ProjectErasureIdentity', terminalScope], ['CascadeTombstone', cascadeTombstone]]), mayVerb: () => true, snapshots: [cascadeDeclaration] }), /ON DELETE RESTRICT or NO ACTION/);
  const scalarIdentityProject = { ...project, fields: { ...project.fields, projectId: { kind: 'value', type: 'text' } }, field: { ...project.field, projectId: { fieldName: 'projectId', entityName: 'Project' } } };
  const scalarIdentityDeclaration = snapshot(scalarIdentityProject, { tombstones: snapshot.tombstones(scalarIdentityProject, { entity: tombstone, entityId: tombstone.field.entityId, scopeId: tombstone.field.projectId, terminalScope, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'project', hidden: ['deleted'] }), output: snapshot.object({}) });
  const scalarIdentityLive = createLiveDelivery({ db, entities: new Map([['Project', scalarIdentityProject], ['ProjectErasureIdentity', terminalScope], ['Tombstone', tombstone]]), mayVerb: () => true, snapshots: [scalarIdentityDeclaration] });
  assert.deepEqual(await scalarIdentityLive.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1' }), { kind: 'revoked' });
  const malformedOwnerDeclaration = snapshot(scalarIdentityProject, { tombstones: snapshot.tombstones(scalarIdentityProject, { entity: tombstone, entityId: tombstone.field.entityId, scopeId: tombstone.field.projectId, targetScopeId: scalarIdentityProject.field.projectId, targetScope: project, terminalScope, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'project', hidden: ['deleted'] }), output: snapshot.object({}) });
  assert.throws(() => createLiveDelivery({ db, entities: new Map([['Project', scalarIdentityProject], ['ProjectErasureIdentity', terminalScope], ['Tombstone', tombstone]]), mayVerb: () => true, snapshots: [malformedOwnerDeclaration] }), /owner scope 'projectId'.*declared ref/);
  const wrongOwnerDeclaration = snapshot(scalarIdentityProject, { tombstones: snapshot.tombstones(scalarIdentityProject, { entity: tombstone, entityId: tombstone.field.entityId, scopeId: tombstone.field.projectId, targetScopeId: tombstone.field.projectId, targetScope: project, terminalScope, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'project', hidden: ['deleted'] }), output: snapshot.object({}) });
  assert.throws(() => createLiveDelivery({ db, entities: new Map([['Project', scalarIdentityProject], ['ProjectErasureIdentity', terminalScope], ['Tombstone', tombstone]]), mayVerb: () => true, snapshots: [wrongOwnerDeclaration] }), /owner scope must belong to Project/);
  const targetScopeOnly = snapshot(project, { tombstones: snapshot.tombstones(project, { entity: tombstone, entityId: tombstone.field.entityId, scopeId: tombstone.field.projectId, targetScope: project, terminalScope, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'project', hidden: ['deleted'] }), output: snapshot.object({}) });
  assert.throws(() => createLiveDelivery({ db, entities: new Map([['Project', project], ['ProjectErasureIdentity', terminalScope], ['Tombstone', tombstone]]), mayVerb: () => true, snapshots: [targetScopeOnly] }), /targetScope requires targetScopeId/);
  const targetScopeIdOnly = snapshot(project, { tombstones: snapshot.tombstones(project, { entity: tombstone, entityId: tombstone.field.entityId, scopeId: tombstone.field.projectId, targetScopeId: project.field.name, terminalScope, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'project', hidden: ['deleted'] }), output: snapshot.object({}) });
  assert.throws(() => createLiveDelivery({ db, entities: new Map([['Project', project], ['ProjectErasureIdentity', terminalScope], ['Tombstone', tombstone]]), mayVerb: () => true, snapshots: [targetScopeIdOnly] }), /targetScopeId requires targetScope/);
  db.close();
});

test('terminal self-owner User tombstones compare the retained scope to User.id', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY, name TEXT, displayName TEXT, image TEXT); CREATE TABLE UserErasureIdentity (id TEXT PRIMARY KEY); CREATE TABLE Project (id TEXT PRIMARY KEY, ownerId TEXT REFERENCES User(id)); CREATE TABLE Tombstone (id TEXT PRIMARY KEY, userId TEXT REFERENCES UserErasureIdentity(id) ON DELETE RESTRICT, entityId TEXT, kind TEXT, state TEXT);');
  db.prepare('INSERT INTO User VALUES (?, ?, ?, ?)').run('u1', 'Ada', 'Ada', null);
  db.prepare('INSERT INTO UserErasureIdentity VALUES (?)').run('u1');
  db.prepare('INSERT INTO Project VALUES (?, ?)').run('p1', 'u1');
  db.prepare('INSERT INTO Tombstone VALUES (?, ?, ?, ?, ?)').run('t1', 'u1', 'u1', 'user', 'deleted');
  const ownGrant = () => [scope(() => true).can(() => grant(subscribe))];
  const User = { name: 'User', fields: { name: { kind: 'value', type: 'text' }, displayName: { kind: 'value', type: 'text' }, image: { kind: 'value', type: 'text' } }, field: {}, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const terminalScope = { name: 'UserErasureIdentity', fields: {}, field: { id: { fieldName: 'id' } }, grant: ownGrant, scopeFilter: () => ({ sql: '0=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const project = { name: 'Project', fields: { ownerId: { kind: 'value', type: 'ref', target: User } }, field: { ownerId: { fieldName: 'ownerId' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const tombstone = { name: 'Tombstone', fields: { userId: { kind: 'value', type: 'ref', target: terminalScope }, entityId: { kind: 'value', type: 'text' }, kind: { kind: 'value', type: 'text' }, state: { kind: 'value', type: 'text' } }, field: { userId: { fieldName: 'userId' }, entityId: { fieldName: 'entityId' }, kind: { fieldName: 'kind' }, state: { fieldName: 'state' } }, grant: ownGrant, scopeFilter: () => ({ sql: '0=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const visibility = snapshot.tombstones(User, { entity: tombstone, entityId: tombstone.field.entityId, scopeId: tombstone.field.userId, terminalScope, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'user', hidden: ['deleted'] });
  const live = createLiveDelivery({ db, entities: new Map([['User', User], ['UserErasureIdentity', terminalScope], ['Project', project], ['Tombstone', tombstone]]), mayVerb: () => true, snapshots: [snapshot(User, { tombstones: visibility, output: snapshot.object({}) }), snapshot(project, { output: snapshot.object({ owner: snapshot.user({ via: project.field.ownerId }) }) })] });
  assert.equal((await live.bootstrap({ principal: { type: 'user', id: 'other' }, scope: 'Project:p1' })).snapshot.owner, null);
  db.close();
});

test('scoped polymorphic User tombstones use the User owner scope in user projections', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Organization (id TEXT PRIMARY KEY); CREATE TABLE User (id TEXT PRIMARY KEY, organizationId TEXT REFERENCES Organization(id), name TEXT, displayName TEXT, image TEXT); CREATE TABLE Project (id TEXT PRIMARY KEY, ownerId TEXT REFERENCES User(id)); CREATE TABLE Tombstone (id TEXT PRIMARY KEY, organizationId TEXT REFERENCES Organization(id), entityId TEXT, kind TEXT, state TEXT);');
  db.prepare('INSERT INTO Organization VALUES (?)').run('o1');
  db.prepare('INSERT INTO Organization VALUES (?)').run('o2');
  db.prepare('INSERT INTO User VALUES (?, ?, ?, ?, ?)').run('u1', 'o1', 'Ada', 'Ada', null);
  db.prepare('INSERT INTO Project VALUES (?, ?)').run('p1', 'u1');
  db.prepare('INSERT INTO Tombstone VALUES (?, ?, ?, ?, ?)').run('wrong-scope', 'o2', 'u1', 'user', 'deleted');
  const ownGrant = () => [scope(() => true).can(() => grant(subscribe))];
  const organization = { name: 'Organization', fields: {}, field: { id: { fieldName: 'id' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const User = { name: 'User', fields: { organizationId: { kind: 'value', type: 'ref', target: organization }, name: { kind: 'value', type: 'text' }, displayName: { kind: 'value', type: 'text' }, image: { kind: 'value', type: 'text' } }, field: { organizationId: { fieldName: 'organizationId' }, name: { fieldName: 'name' }, displayName: { fieldName: 'displayName' }, image: { fieldName: 'image' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const project = { name: 'Project', fields: { ownerId: { kind: 'value', type: 'ref', target: User } }, field: { ownerId: { fieldName: 'ownerId' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const tombstone = { name: 'Tombstone', fields: { organizationId: { kind: 'value', type: 'ref', target: organization }, entityId: { kind: 'value', type: 'text' }, kind: { kind: 'value', type: 'text' }, state: { kind: 'value', type: 'text' } }, field: { organizationId: { fieldName: 'organizationId' }, entityId: { fieldName: 'entityId' }, kind: { fieldName: 'kind' }, state: { fieldName: 'state' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const visibility = snapshot.tombstones(User, { entity: tombstone, entityId: tombstone.field.entityId, scopeId: tombstone.field.organizationId, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'user', hidden: ['deleted'] });
  const live = createLiveDelivery({ db, entities: new Map([['Organization', organization], ['User', User], ['Project', project], ['Tombstone', tombstone]]), mayVerb: () => true, snapshots: [snapshot(User, { tombstones: visibility, output: snapshot.object({}) }), snapshot(project, { output: snapshot.object({ owner: snapshot.user({ via: project.field.ownerId }) }) })] });
  assert.deepEqual((await live.bootstrap({ principal: { type: 'user', id: 'other' }, scope: 'Project:p1' })).snapshot.owner, { id: 'u1', name: 'Ada', image: null });
  db.prepare('UPDATE Tombstone SET organizationId = ? WHERE id = ?').run('o1', 'wrong-scope');
  assert.equal((await live.bootstrap({ principal: { type: 'user', id: 'other' }, scope: 'Project:p1' })).snapshot.owner, null);
  db.close();
});

test('declared tombstones reject malformed, duplicate, and recipient-selectable declarations', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY); CREATE TABLE Tombstone (id TEXT PRIMARY KEY, entityId TEXT REFERENCES Project(id), kind TEXT, state TEXT);');
  const ownGrant = () => [scope(() => true).can(() => grant(subscribe))];
  const project = { name: 'Project', fields: {}, field: { id: { fieldName: 'id' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const tombstone = { name: 'Tombstone', fields: { entityId: { kind: 'value', type: 'ref', target: project }, kind: { kind: 'value', type: 'text' }, state: { kind: 'value', type: 'text' } }, field: { entityId: { fieldName: 'entityId' }, kind: { fieldName: 'kind' }, state: { fieldName: 'state' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const visibility = () => snapshot.tombstones(project, { entity: tombstone, entityId: tombstone.field.entityId, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'project', hidden: ['deleted', 'deleted'] });
  assert.throws(() => createLiveDelivery({ db, entities: new Map([['Project', project], ['Tombstone', tombstone]]), mayVerb: () => true, snapshots: [snapshot(project, { tombstones: visibility(), output: snapshot.object({}) })] }), /hidden/);
  assert.throws(() => createLiveDelivery({ db, entities: new Map([['Project', project], ['Tombstone', tombstone]]), mayVerb: () => true, snapshots: [snapshot(project, { tombstones: snapshot.tombstones(project, { entity: tombstone, entityId: tombstone.field.kind, scopeId: tombstone.field.state, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'project', hidden: ['deleted'] }), output: snapshot.object({}) })] }), /scopeId.*ref\(Project\)/);
  assert.throws(() => createLiveDelivery({ db, entities: new Map([['Project', project], ['Tombstone', tombstone]]), mayVerb: () => true, snapshots: [snapshot(tombstone, { tombstones: snapshot.tombstones(project, { entity: tombstone, entityId: tombstone.field.entityId, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'project', hidden: ['deleted'] }), output: snapshot.object({ state: snapshot.select(tombstone.field.state) }) })] }), /read-internal.*anchor/);
  assert.throws(() => createLiveDelivery({ db, entities: new Map([['Project', project], ['Tombstone', tombstone]]), mayVerb: () => true, snapshots: [snapshot(project, { tombstones: snapshot.tombstones(project, { entity: tombstone, entityId: tombstone.field.entityId, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'project', hidden: ['deleted'] }), output: snapshot.object({ tombstones: snapshot.many(tombstone, { via: tombstone.field.entityId, select: snapshot.select(tombstone.field.state) }) }) })] }), /read-internal/);
  db.close();
});

test('declared tombstones exclude their target from other aggregate outputs', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY); CREATE TABLE Task (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), label TEXT); CREATE TABLE Tombstone (id TEXT PRIMARY KEY, entityId TEXT REFERENCES Task(id), kind TEXT, state TEXT);');
  db.prepare('INSERT INTO Project VALUES (?)').run('p1');
  db.prepare('INSERT INTO Task VALUES (?, ?, ?)').run('gone', 'p1', 'hidden task');
  db.prepare('INSERT INTO Tombstone VALUES (?, ?, ?, ?)').run('t1', 'gone', 'task', 'deleted');
  const ownGrant = () => [scope(() => true).can(() => grant(subscribe))];
  const project = { name: 'Project', fields: {}, field: { id: { fieldName: 'id' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const task = { name: 'Task', fields: { projectId: { kind: 'value', type: 'ref', target: project }, label: { kind: 'value', type: 'text' } }, field: { id: { fieldName: 'id' }, projectId: { fieldName: 'projectId' }, label: { fieldName: 'label' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const tombstone = { name: 'Tombstone', fields: { entityId: { kind: 'value', type: 'ref', target: task }, kind: { kind: 'value', type: 'text' }, state: { kind: 'value', type: 'text' } }, field: { entityId: { fieldName: 'entityId' }, kind: { fieldName: 'kind' }, state: { fieldName: 'state' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const live = createLiveDelivery({ db, entities: new Map([['Project', project], ['Task', task], ['Tombstone', tombstone]]), mayVerb: () => true, snapshots: [snapshot(task, { tombstones: snapshot.tombstones(task, { entity: tombstone, entityId: tombstone.field.entityId, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'task', hidden: ['deleted', 'purge_pending'] }), output: snapshot.object({ label: snapshot.select(task.field.label) }) }), snapshot(project, { output: snapshot.object({ tasks: snapshot.many(task, { via: task.field.projectId, select: snapshot.select(task.field.label) }), taskCount: snapshot.count(task, { via: task.field.projectId }) }) })] });
  assert.deepEqual((await live.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1' })).snapshot, { id: 'p1', tasks: [], taskCount: 0 });
  db.close();
});

test('declared snapshots reject cyclic outputs and retry an asynchronous authorization revision race', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY); CREATE TABLE Comment (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id));');
  db.prepare('INSERT INTO Project VALUES (?)').run('p1');
  const ownGrant = () => [scope(() => true).can(() => grant(subscribe))];
  const project = { name: 'Project', fields: {}, field: { id: { fieldName: 'id' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ id: row.id }) };
  const comment = { name: 'Comment', fields: { projectId: { kind: 'value', type: 'ref', target: project } }, field: { id: { fieldName: 'id' }, projectId: { fieldName: 'projectId' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ id: row.id, projectId: row.projectId }) };
  const output = snapshot.object({ comments: snapshot.many(comment, { via: comment.field.projectId, include: snapshot.object({ project: snapshot.one(project, { via: comment.field.projectId, include: snapshot.object({}) }) }) }) });
  assert.throws(() => createLiveDelivery({ db, entities: new Map([['Project', project], ['Comment', comment]]), mayVerb: () => true, snapshots: [snapshot(project, { output })] }), /cyclic/);
  const declaration = snapshot(project, { output: snapshot.object({ comments: snapshot.many(comment, { via: comment.field.projectId, select: snapshot.select(comment.field.projectId) }) }) });
  db.prepare('INSERT INTO Comment VALUES (?, ?)').run('c1', 'p1');
  let raced = false;
  const live = createLiveDelivery({ db, entities: new Map([['Project', project], ['Comment', comment]]), mayVerb: async (_entity, _verb, row) => { if (row.id === 'c1' && !raced) { raced = true; db.prepare("UPDATE _CommittedRevision SET revision = revision + 1 WHERE name = 'actions'").run(); } return true; }, snapshots: [declaration] });
  assert.deepEqual(await live.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1' }), {
    kind: 'snapshot', snapshot: { id: 'p1', comments: [{ id: 'c1', projectId: 'p1' }] }, cursor: { anchor: 0, aggregate: 1 },
  });
  db.close();
});

test('declared snapshots require physical ref foreign keys and expose only terminal User presentation fields', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`
    CREATE TABLE User (id TEXT PRIMARY KEY, name TEXT, displayName TEXT, image TEXT, password TEXT, deletedAt TEXT);
    CREATE TABLE Project (id TEXT PRIMARY KEY, ownerId TEXT REFERENCES User(id));
  `);
  db.prepare('INSERT INTO User VALUES (?, ?, ?, ?, ?, ?)').run('u1', null, 'Ada', 'https://example.test/ada.png', 'secret', null);
  db.prepare('INSERT INTO Project VALUES (?, ?)').run('p1', 'u1');
  const ownGrant = () => [scope(() => true).can(() => grant(subscribe))];
  const User = { name: 'User', fields: { name: { kind: 'value', type: 'text' }, displayName: { kind: 'value', type: 'text' }, image: { kind: 'value', type: 'text' } }, field: {}, grant: ownGrant, scopeFilter: () => ({ sql: '0=1', params: {} }), hydrate: () => null };
  const project = { name: 'Project', fields: { ownerId: { kind: 'value', type: 'ref', target: User } }, field: { ownerId: { fieldName: 'ownerId' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const declaration = snapshot(project, { output: snapshot.object({ owner: snapshot.user({ via: project.field.ownerId }) }) });
  const live = createLiveDelivery({ db, entities: new Map([['Project', project], ['User', User]]), mayVerb: () => true, snapshots: [declaration] });
  const result = await live.bootstrap({ principal: { type: 'user', id: 'other' }, scope: 'Project:p1' });
  assert.deepEqual(result.snapshot, { id: 'p1', owner: { id: 'u1', name: 'Ada', image: 'https://example.test/ada.png' } });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  db.prepare('UPDATE User SET deletedAt = ? WHERE id = ?').run('2026-07-28T00:00:00.000Z', 'u1');
  assert.deepEqual((await live.bootstrap({ principal: { type: 'user', id: 'other' }, scope: 'Project:p1' })).snapshot, { id: 'p1', owner: null });

  db.exec('CREATE TABLE Broken (id TEXT PRIMARY KEY, projectId TEXT);');
  const broken = { name: 'Broken', fields: { projectId: { kind: 'value', type: 'ref', target: project } }, field: { projectId: { fieldName: 'projectId' } }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  assert.throws(() => createLiveDelivery({ db, entities: new Map([['Project', project], ['Broken', broken], ['User', User]]), mayVerb: () => true, snapshots: [snapshot(project, { output: snapshot.object({ children: snapshot.many(broken, { via: broken.field.projectId, select: snapshot.select(broken.field.projectId) }) }) })] }), /physical FOREIGN KEY/);
  db.close();
});

test('server exposes committed cursors without raw event delivery', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.prepare(`
    INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'Project:project-1',
    1,
    'Project.renamed',
    JSON.stringify({ name: 'Field notes' }),
    'action-1',
    '2026-07-13T00:00:00.000Z',
  );
  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?)')
    .run('Project:project-1', 1);

  assert.equal(readCommittedCursor(db, 'Project:project-1'), 1);
  db.close();
});

test('server exposes immutable framework and declaration table censuses', () => {
  const Widget = entity('Widget', { name: text() });

  assert.ok(Object.isFrozen(frameworkTableNames));
  assert.ok(frameworkTableNames.includes('_Log'));
  assert.deepEqual(declaredTableNames([Widget]), ['Widget']);
  assert.equal(typeof assertNoFrameworkTableSql, 'function');
  assert.throws(() => assertNoFrameworkTableSql('DELETE FROM _Log'), /framework table _Log/);
  assert.doesNotThrow(() => assertNoFrameworkTableSql('SELECT id FROM Widget'));
});

test('server exposes the transport-neutral live delivery factory', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const live = createLiveDelivery({
    db,
    entities: new Map(),
    mayVerb: async () => true,
  });

  assert.equal(typeof live.subscribe, 'function');
  assert.equal(typeof live.bootstrap, 'function');
  assert.equal(typeof live.wake, 'function');
  assert.equal('emit' in live, false);
  assert.equal('close' in live, false);
  db.close();
});

test('public live delivery bounds catch-up with a recipient snapshot rather than raw history', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'visible');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { secret: 'raw-one' });
  appendEvent(db, 'Note:n1', 2, 'Note.updated', { secret: 'raw-two' });
  const live = createLiveDelivery({ db, entities: new Map([['Note', noteEntity()]]), mayVerb: async () => true, maxCatchupEvents: 1 });
  const result = await live.catchup({ principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0 });
  assert.deepEqual(result, { kind: 'snapshot', snapshot: { id: 'n1', title: 'visible' }, cursor: 2 });
  db.close();
});

test('public live delivery bootstrap fails closed and rejects asynchronous snapshot readers', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO Project (id, name) VALUES (?, ?)').run('p1', 'Field notes');
  const entity = {
    name: 'Project', fields: { name: { kind: 'value' } }, grant: () => [scope(() => true).can(() => grant(read, subscribe))],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
  const denied = createLiveDelivery({ db, entities: new Map([['Project', entity]]), mayVerb: async () => false });
  assert.deepEqual(
    await denied.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1' }),
    { kind: 'revoked' },
  );

  db.close();
});

test('public live delivery bootstrap suppresses a paired snapshot when final authorization is revoked', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO Project (id, name) VALUES (?, ?)').run('p1', 'Field notes');
  const entity = {
    name: 'Project', fields: { name: { kind: 'value' } },
    grant: () => [scope(() => true).can(() => grant(read, subscribe))],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
  let authorizations = 0;
  const live = createLiveDelivery({
    db, entities: new Map([['Project', entity]]),
    mayVerb: async () => ++authorizations === 1,
  });
  assert.deepEqual(
    await live.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1' }),
    { kind: 'revoked' },
  );
  assert.equal(authorizations, 2);
  db.close();
});

test('public live delivery revokes an active subscription when the anchor is no longer authorized', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO Project (id, name) VALUES (?, ?)').run('p1', 'Field notes');
  const entity = {
    name: 'Project', fields: { name: { kind: 'value' } },
    grant: () => [scope(() => true).can(() => grant(read, subscribe))],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
  const live = createLiveDelivery({ db, entities: new Map([['Project', entity]]), mayVerb: async () => true });
  const controller = new AbortController();
  let revoked = false;
  const activation = await live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', signal: controller.signal,
    deliver: async () => {}, revoke: () => { revoked = true; },
  });
  await activation.activate();
  db.prepare('DELETE FROM Project WHERE id = ?').run('p1');
  live.wake('Project:p1');
  await sleep(30);
  assert.equal(revoked, true);
  controller.abort();
  db.close();
});

test('public live delivery catch-up returns only recipient-safe envelopes and its exact cursor', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO Project (id, name) VALUES (?, ?)').run('p1', 'Field notes');
  appendEvent(db, 'Project:p1', 1, 'Source.created', { secret: 'raw source data' });
  const live = createLiveDelivery({
    db,
    entities: new Map([['Project', {
      name: 'Project', fields: { name: { kind: 'value' } },
      grant: () => [scope(() => true).can(() => grant(read, subscribe))],
      scopeFilter: () => ({ sql: '1=1', params: {} }),
      hydrate: (row) => ({ id: row.id, name: row.name }),
    }]]),
    mayVerb: async () => true,
  });

  const catchup = await live.catchup({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', after: 0 });
  assert.deepEqual(catchup, {
    kind: 'catchup',
    cursor: 1,
    envelopes: [{ type: 'resync', entity: 'Project', id: 'p1', seq: 1, reason: 'recipient-snapshot-required' }],
  });
  assert.equal(JSON.stringify(catchup).includes('raw source data'), false);
  db.close();
});

test('public live delivery catch-up revokes when the anchor is unavailable', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  const entity = {
    name: 'Project', fields: { name: { kind: 'value' } },
    grant: () => [scope(() => true).can(() => grant(read, subscribe))],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
  const live = createLiveDelivery({ db, entities: new Map([['Project', entity]]), mayVerb: async () => true });
  assert.deepEqual(
    await live.catchup({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', after: 0 }),
    { kind: 'revoked' },
  );
  db.close();
});

test('public live delivery catch-up maps a second authorization denial to revocation', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO Project (id, name) VALUES (?, ?)').run('p1', 'Field notes');
  const entity = {
    name: 'Project', fields: { name: { kind: 'value' } },
    grant: () => [scope(() => true).can(() => grant(read, subscribe))],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
  let authorizations = 0;
  const live = createLiveDelivery({
    db, entities: new Map([['Project', entity]]),
    mayVerb: async () => ++authorizations === 1,
  });
  assert.deepEqual(
    await live.catchup({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', after: 0 }),
    { kind: 'revoked' },
  );
  assert.equal(authorizations, 2);
  db.close();
});

test('public live delivery catch-up preserves the cursor for a contiguous terminal removal', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO Project (id, name) VALUES (?, ?)').run('p1', 'Field notes');
  const entity = {
    name: 'Project', fields: { name: { kind: 'value' } },
    grant: () => [scope(() => true).can(() => grant(read, subscribe))],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
  const live = createLiveDelivery({ db, entities: new Map([['Project', entity]]), mayVerb: async () => true });
  db.prepare('DELETE FROM Project WHERE id = ?').run('p1');
  appendEvent(db, 'Project:p1', 1, 'Project.removed');
  assert.deepEqual(
    await live.catchup({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', after: 0 }),
    {
      kind: 'catchup', cursor: 1,
      envelopes: [{ type: 'event', entity: 'Project', id: 'p1', seq: 1, seqSpan: [1, 1], event: {
        type: 'Project.removed', scope: 'Project:p1', seq: 1, actionId: 'action-1', committedAt: '2026-07-26T00:00:00.000Z', data: { id: 'p1' },
      } }],
    },
  );
  db.close();
});

test('public live delivery waits for activation, strips raw event data, and requires cancellation', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, secret TEXT)');
  db.prepare('INSERT INTO Note (id, title, secret) VALUES (?, ?, ?)').run('n1', 'visible', 'raw-secret');
  appendEvent(db, 'Note:n1', 1, 'Note.updated', { title: 'visible', secret: 'raw-secret', operation: 'raw-operation' });

  const live = createLiveDelivery({
    db,
    entities: new Map([['Note', noteEntity()]]),
    mayVerb: async () => true,
  });
  assert.throws(() => live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, deliver: async () => {},
  }), /requires an AbortSignal/);
  const aborted = new AbortController();
  aborted.abort();
  assert.throws(() => live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: aborted.signal, deliver: async () => {},
  }), /subscription is aborted/);

  const batches = [];
  const controller = new AbortController();
  const subscription = await live.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: controller.signal,
    deliver: async (batch) => { batches.push(batch); },
  });
  live.wake('Note:n1');
  assert.equal(batches.length, 0, 'a paused subscription cannot deliver before acknowledgement');
  await Promise.all([subscription.activate(), subscription.activate()]);

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], [{
    type: 'event', entity: 'Note', id: 'n1', seq: 1, seqSpan: [1, 1],
    event: {
      type: 'Note.updated', scope: 'Note:n1', seq: 1, actionId: 'action-1',
      committedAt: '2026-07-26T00:00:00.000Z', data: { id: 'n1', title: 'visible' },
    },
  }]);
  assert.equal(JSON.stringify(batches).includes('raw-secret'), false);
  assert.equal(JSON.stringify(batches).includes('raw-operation'), false);

  appendEvent(db, 'Note:n1', 2, 'Note.title.operated', { operation: 'another-raw-operation' });
  live.wake('Note:n1');
  await sleep(20);
  assert.deepEqual(batches[1], [{
    type: 'resync', entity: 'Note', id: 'n1', seq: 2, reason: 'recipient-snapshot-required',
  }]);
  assert.equal(JSON.stringify(batches).includes('another-raw-operation'), false);

  controller.abort();
  db.close();
});

test('public live delivery does not acknowledge a rejected batch', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'visible');
  appendEvent(db, 'Note:n1', 1, 'Note.updated', { title: 'visible' });

  const live = createLiveDelivery({ db, entities: new Map([['Note', noteEntity()]]), mayVerb: async () => true });
  const failing = new AbortController();
  const failed = await live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: failing.signal,
    deliver: async () => { throw new Error('SSE write failed'); },
  });
  await assert.rejects(() => failed.activate(), /delivery callback threw/);

  const batches = [];
  const retry = new AbortController();
  const resumed = await live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: retry.signal,
    deliver: async (batch) => { batches.push(batch); },
  });
  await resumed.activate();
  assert.equal(batches[0][0].seq, 1);

  retry.abort();
  db.close();
});
