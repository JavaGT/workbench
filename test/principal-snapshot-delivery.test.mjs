import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { defineSqliteSchema } from '../build/sqlite-schema.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { projectionSource, projectionSourcePhysical, principalSnapshot } from '../build/principal-snapshot-declaration.mjs';
import { principalSnapshotScope } from '../build/principal-snapshot-scope.mjs';
import { createPrincipalSnapshotDelivery } from '../build/principal-snapshot-delivery.mjs';
import { createPrincipalSnapshotTransaction } from '../build/principal-snapshot-transaction.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { validatePrincipalSnapshotDeclarations } from '../build/principal-snapshot-delivery.mjs';
import { createOwnedLiveDelivery } from '../build/live-delivery-public.mjs';

function hubDatabase() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const schema = defineSqliteSchema({
    name: 'principal-delivery',
    tables: [{
      name: 'HubItem',
      columns: [
        { name: 'id', type: 'text', primaryKey: true },
        { name: 'recipientId', type: 'text', notNull: true },
        { name: 'title', type: 'text', notNull: true },
        { name: 'rank', type: 'integer', notNull: true },
        { name: 'hidden', type: 'text', notNull: true },
      ],
    }],
  });
  schema.prepare(db);
  const source = projectionSource(schema, 'HubItem');
  const declaration = principalSnapshot('user-hub', {
    principalType: 'user',
    output: principalSnapshot.object({
      items: principalSnapshot.many(source, {
        via: source.field.recipientId,
        key: source.field.id,
        select: principalSnapshot.select(source.field.title),
        orderBy: [principalSnapshot.orderBy(source.field.rank)],
      }),
    }),
  });
  return { db, schema, declaration };
}

function setup() {
  const { db, schema, declaration } = hubDatabase();
  db.prepare('INSERT INTO HubItem (id, recipientId, title, rank, hidden) VALUES (?, ?, ?, ?, ?)').run('b', 'u1', 'second', 2, 'secret');
  db.prepare('INSERT INTO HubItem (id, recipientId, title, rank, hidden) VALUES (?, ?, ?, ?, ?)').run('a', 'u1', 'first', 1, 'secret');
  db.prepare('INSERT INTO HubItem (id, recipientId, title, rank, hidden) VALUES (?, ?, ?, ?, ?)').run('c', 'u2', 'other', 1, 'secret');
  const delivery = createPrincipalSnapshotDelivery({ db, declarations: [declaration], authorize: () => true });
  const app = { db, writeQueue: createWriteQueue(), _principalSnapshotTxActive: false };
  const runtime = createPrincipalSnapshotTransaction(app);
  app.principalSnapshots = { transaction: runtime.transaction };
  runtime._registerDeclaration(declaration);
  runtime._setWakeHook((decl, principal) => delivery.wake(decl, principal));
  return { db, schema, declaration, delivery, app };
}

test('principal bootstrap projects only recipient-visible declared columns with durable cursor', async () => {
  const { declaration, delivery } = setup();
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  const result = await delivery.bootstrap({ principal: { type: 'user', id: 'u1' }, scope });
  assert.deepEqual(result, { kind: 'snapshot', snapshot: { items: [{ title: 'first', id: 'a' }, { title: 'second', id: 'b' }] }, cursor: 0 });
  assert.ok(Object.isFrozen(result.snapshot));
  assert.equal('hidden' in result.snapshot.items[0], false);
});

test('principal delivery fails closed for malformed, unknown, and mismatched recipients', async () => {
  const { declaration, delivery } = setup();
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  assert.deepEqual(await delivery.bootstrap({ principal: { type: 'user', id: 'u2' }, scope }), { kind: 'revoked' });
  assert.deepEqual(await delivery.bootstrap({ principal: { type: 'link', id: 'u1' }, scope }), { kind: 'revoked' });
  assert.deepEqual(await delivery.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'PrincipalSnapshot:unknown/user/u1' }), { kind: 'revoked' });
  assert.deepEqual(await delivery.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'PrincipalSnapshot:user-hub/user/%3a' }), { kind: 'revoked' });
});

test('principal catchup is snapshot-only and exact invalidation wakes only its recipient', async () => {
  const { declaration, delivery, app } = setup();
  const one = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  const two = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u2' } });
  const delivered = [];
  const other = [];
  const a = await delivery.subscribe({ principal: { type: 'user', id: 'u1' }, scope: one, after: 0, signal: new AbortController().signal, deliver: async (batch) => delivered.push(...batch) });
  const b = await delivery.subscribe({ principal: { type: 'user', id: 'u2' }, scope: two, after: 0, signal: new AbortController().signal, deliver: async (batch) => other.push(...batch) });
  await a.activate();
  await b.activate();
  await app.principalSnapshots.transaction((tx) => tx.invalidate(declaration, { type: 'user', id: 'u1' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, [{ type: 'resync', seq: 1, reason: 'recipient-snapshot-required' }]);
  assert.deepEqual(other, []);
  assert.deepEqual(await delivery.catchup({ principal: { type: 'user', id: 'u1' }, scope: one, after: 1 }), { kind: 'catchup', envelopes: [], cursor: 1 });
  const stale = await delivery.catchup({ principal: { type: 'user', id: 'u1' }, scope: one, after: 0 });
  assert.equal(stale.kind, 'snapshot');
  assert.equal(stale.cursor, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 0);
});

test('principal delivery validation rejects a foreign source schema and undeclared source table', () => {
  const { schema } = setup();
  const source = projectionSource(schema, 'HubItem');
  const declaration = principalSnapshot('valid-source', {
    principalType: 'user',
    output: principalSnapshot.object({ rows: principalSnapshot.many(source, { via: source.field.recipientId, key: source.field.id, select: principalSnapshot.select(source.field.title) }) }),
  });
  assert.doesNotThrow(() => validatePrincipalSnapshotDeclarations([declaration], schema));
  assert.throws(() => validatePrincipalSnapshotDeclarations([declaration], defineSqliteSchema({ name: 'foreign', tables: [] })), /application schema/);
  const other = defineSqliteSchema({ name: 'other', tables: [{ name: 'Other', columns: [{ name: 'id', type: 'text', primaryKey: true }] }] });
  const foreignSource = projectionSource(other, 'Other');
  const foreignDeclaration = principalSnapshot('foreign-source', {
    principalType: 'user',
    output: principalSnapshot.object({ rows: principalSnapshot.many(foreignSource, { via: foreignSource.field.id, key: foreignSource.field.id, select: principalSnapshot.select(foreignSource.field.id) }) }),
  });
  assert.throws(() => validatePrincipalSnapshotDeclarations([foreignDeclaration], schema), /application schema/);
});

test('principal snapshot filters fail closed on unknown roles and preserve personal notifications through resync', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const schema = defineSqliteSchema({
    name: 'principal-filter',
    tables: [{ name: 'Notification', columns: [
      { name: 'id', type: 'text', primaryKey: true },
      { name: 'userId', type: 'text', notNull: true },
      { name: 'projectId', type: 'text' },
      { name: 'body', type: 'text', notNull: true },
    ] }],
  });
  schema.prepare(db);
  db.exec('CREATE TABLE Project_members (Project_id TEXT NOT NULL, member_id TEXT NOT NULL, role TEXT NOT NULL)');
  const notification = projectionSource(schema, 'Notification');
  const membership = projectionSourcePhysical('Project_members', ['Project_id', 'member_id', 'role']);
  assert.throws(() => principalSnapshot.filter.exists(membership, principalSnapshot.filter.isNull(notification.field.projectId)), /principalField requires a valid source field handle/);
  assert.throws(() => principalSnapshot.filter.exists(membership, notification.field.id, principalSnapshot.filter.isNull(notification.field.projectId)), /principalField must come from the same projection source/);
  const allowedRoles = ['editor', 'owner'];
  const declaration = principalSnapshot('user-hub-filtered', {
    principalType: 'user',
    output: principalSnapshot.object({
      notifications: principalSnapshot.many(notification, {
        via: notification.field.userId,
        key: notification.field.id,
        select: principalSnapshot.select(notification.field.id, notification.field.projectId, notification.field.body),
        where: principalSnapshot.filter.or(
          principalSnapshot.filter.isNull(notification.field.projectId),
          principalSnapshot.filter.exists(membership, membership.field.member_id, principalSnapshot.filter.and(
            principalSnapshot.filter.equal(membership.field.Project_id, notification.field.projectId),
            principalSnapshot.filter.in(membership.field.role, allowedRoles),
          )),
        ),
      }),
      projectNotifications: principalSnapshot.many(notification, {
        via: notification.field.userId,
        key: notification.field.id,
        select: principalSnapshot.select(notification.field.id, notification.field.projectId),
        join: {
          source: membership,
          on: { from: notification.field.projectId, to: membership.field.Project_id },
          select: [membership.field.role],
        },
        where: principalSnapshot.filter.exists(membership, membership.field.member_id, principalSnapshot.filter.and(
          principalSnapshot.filter.equal(membership.field.Project_id, notification.field.projectId),
          principalSnapshot.filter.in(membership.field.role, allowedRoles),
        )),
      }),
      memberships: principalSnapshot.many(membership, {
        via: membership.field.member_id,
        key: membership.field.Project_id,
        select: principalSnapshot.select(membership.field.Project_id, membership.field.role),
        where: principalSnapshot.filter.in(membership.field.role, allowedRoles),
      }),
    }),
  });
  validatePrincipalSnapshotDeclarations([declaration], schema);

  const insertNotification = db.prepare('INSERT INTO Notification (id, userId, projectId, body) VALUES (?, ?, ?, ?)');
  for (const row of [
    ['personal', 'u1', null, 'personal'],
    ['editor-project', 'u1', 'p1', 'editor'],
    ['owner-project', 'u1', 'p2', 'owner'],
    ['viewer-project', 'u1', 'p3', 'viewer'],
    ['unknown-role', 'u1', 'p4', 'unknown'],
    ['wrong-principal', 'u1', 'p5', 'other principal'],
    ['wrong-project', 'u1', 'p6', 'other project'],
    ['u2-project', 'u2', 'p5', 'user two'],
  ]) insertNotification.run(...row);
  const insertMembership = db.prepare('INSERT INTO Project_members (Project_id, member_id, role) VALUES (?, ?, ?)');
  for (const row of [
    ['p1', 'u1', 'editor'], ['p2', 'u1', 'owner'], ['p3', 'u1', 'viewer'],
    ['p4', 'u1', 'corrupt'], ['p5', 'u2', 'owner'], ['p7', 'u1', 'owner'],
  ]) insertMembership.run(...row);

  const delivery = createPrincipalSnapshotDelivery({ db, declarations: [declaration], authorize: () => true });
  const app = { db, writeQueue: createWriteQueue(), _principalSnapshotTxActive: false };
  const runtime = createPrincipalSnapshotTransaction(app);
  app.principalSnapshots = { transaction: runtime.transaction };
  runtime._registerDeclaration(declaration);
  runtime._setWakeHook((decl, principal) => delivery.wake(decl, principal));
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  const bootstrap = await delivery.bootstrap({ principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(bootstrap.kind, 'snapshot');
  assert.deepEqual(bootstrap.snapshot.notifications.map((row) => row.id), ['editor-project', 'owner-project', 'personal']);
  assert.deepEqual(bootstrap.snapshot.projectNotifications, [
    { Notification__id: 'editor-project', Notification__projectId: 'p1', Project_members__role: 'editor' },
    { Notification__id: 'owner-project', Notification__projectId: 'p2', Project_members__role: 'owner' },
  ]);
  assert.deepEqual(bootstrap.snapshot.memberships.map((row) => row.Project_id), ['p1', 'p2', 'p7']);
  const sameRevisionCatchup = await delivery.catchup({ principal: { type: 'user', id: 'u1' }, scope, after: bootstrap.cursor });
  assert.equal(sameRevisionCatchup.kind, 'snapshot', 'filtered declarations replace a cached snapshot even when its cursor is current');
  assert.deepEqual(sameRevisionCatchup.snapshot.projectNotifications, bootstrap.snapshot.projectNotifications);
  assert.deepEqual(sameRevisionCatchup.snapshot, bootstrap.snapshot);

  const otherScope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u2' } });
  const otherBootstrap = await delivery.bootstrap({ principal: { type: 'user', id: 'u2' }, scope: otherScope });
  assert.equal(otherBootstrap.kind, 'snapshot');
  assert.deepEqual(otherBootstrap.snapshot.notifications.map((row) => row.id), ['u2-project']);

  const envelopes = [];
  const subscription = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal,
    deliver: async (batch) => envelopes.push(...batch),
  });
  await subscription.activate();
  await app.principalSnapshots.transaction((tx) => {
    db.prepare('UPDATE Project_members SET role = ? WHERE Project_id = ? AND member_id = ?').run('viewer', 'p1', 'u1');
    tx.invalidate(declaration, { type: 'user', id: 'u1' });
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(envelopes, [{ type: 'resync', seq: 1, reason: 'recipient-snapshot-required' }]);
  const refreshed = await delivery.bootstrap({ principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(refreshed.kind, 'snapshot');
  assert.deepEqual(refreshed.snapshot.notifications.map((row) => row.id), ['owner-project', 'personal']);
  assert.deepEqual(refreshed.snapshot.memberships.map((row) => row.Project_id), ['p2', 'p7']);
});

test('principal snapshot filters reject empty allowlists, forged trees, and foreign-source fields', () => {
  const { schema } = setup();
  const source = projectionSource(schema, 'HubItem');
  assert.throws(() => principalSnapshot.filter.in(source.field.title, []), /one or more string values/);
  assert.throws(() => principalSnapshot.many(source, {
    via: source.field.recipientId, key: source.field.id,
    select: principalSnapshot.select(source.field.title),
    where: { kind: 'isNull', field: source.field.title },
  }), /valid filter/);
  const foreign = projectionSourcePhysical('Foreign', ['id']);
  const declaration = principalSnapshot('foreign-filter', {
    principalType: 'user',
    output: principalSnapshot.object({ rows: principalSnapshot.many(source, {
      via: source.field.recipientId, key: source.field.id,
      select: principalSnapshot.select(source.field.title),
      where: principalSnapshot.filter.in(foreign.field.id, ['allowed']),
    }) }),
  });
  assert.throws(() => validatePrincipalSnapshotDeclarations([declaration], schema), /declared filter source/);
});

test('principal delivery close revokes active subscriptions exactly once and blocks later use', async () => {
  const { delivery, declaration } = setup();
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  const revokes = [];
  const delivered = [];
  const controller = new AbortController();
  const first = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: controller.signal,
    deliver: async (batch) => delivered.push(...batch),
    revoke: () => revokes.push('first'),
  });
  const second = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal,
    deliver: async (batch) => delivered.push(...batch),
    revoke: () => revokes.push('second'),
  });
  await first.activate();
  await second.activate();
  assert.deepEqual(revokes, [], 'nothing revoked while open');
  delivery.close();
  assert.deepEqual([...revokes].sort(), ['first', 'second'], 'close revokes every active subscription once');
  controller.abort();
  delivery.close();
  assert.deepEqual([...revokes].sort(), ['first', 'second'], 'abort and repeated close never double-release');
  assert.equal(await first.activate(), undefined, 'closed activation settles without a cursor');
  await assert.rejects(
    () => delivery.subscribe({ principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal, deliver: async () => {} }),
    /is closed/,
  );
  await assert.rejects(() => delivery.bootstrap({ principal: { type: 'user', id: 'u1' }, scope }), /is closed/);
  await assert.rejects(() => delivery.catchup({ principal: { type: 'user', id: 'u1' }, scope, after: 0 }), /is closed/);
  delivery.wake(declaration, { type: 'user', id: 'u1' });
  assert.deepEqual(delivered, [], 'a wake after close reaches no subscription');
});

test('principal delivery close during an awaited drain cannot deliver after shutdown', async () => {
  const { delivery, declaration, db } = setup();
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  let releaseDelivery;
  let markDeliveryEntered;
  const deliveryGate = new Promise((resolve) => { releaseDelivery = resolve; });
  const deliveryEntered = new Promise((resolve) => { markDeliveryEntered = resolve; });
  const delivered = [];
  let revokes = 0;
  const activation = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal,
    deliver: async (batch) => {
      delivered.push(...batch);
      markDeliveryEntered();
      await deliveryGate;
    },
    revoke: () => { revokes += 1; },
  });
  assert.equal(await activation.activate(), 0, 'quiesced open subscription reports its cursor');
  db.prepare(
    `INSERT INTO _PrincipalSnapshotRevision (declaration, principalType, principalId, revision) VALUES (?, ?, ?, 1)
     ON CONFLICT(declaration, principalType, principalId) DO UPDATE SET revision = revision + 1`,
  ).run(declaration.name, 'user', 'u1');
  const draining = activation.activate();
  await deliveryEntered;
  assert.deepEqual(delivered.map((e) => e.seq), [1], 'the in-flight batch has started');
  delivery.close();
  assert.equal(revokes, 1, 'close revokes the subscription while its drain awaits delivery');
  releaseDelivery();
  assert.equal(await draining, undefined, 'shutdown drain settles without a cursor');
  assert.equal(await activation.activate(), undefined, 'a later activate on the closed subscription settles');
  assert.deepEqual(delivered.map((e) => e.seq), [1], 'no second batch is delivered after close');
});

test('principal delivery close before activation leaves no active subscription', async () => {
  const { delivery, declaration } = setup();
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  let revokes = 0;
  const delivered = [];
  const activation = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal,
    deliver: async (batch) => delivered.push(...batch),
    revoke: () => { revokes += 1; },
  });
  delivery.close();
  assert.equal(revokes, 1, 'close between subscribe and activate revokes once');
  assert.equal(await activation.activate(), undefined, 'activation of a closed subscription settles without a cursor');
  assert.deepEqual(delivered, [], 'nothing delivers after close');
  delivery.close();
  assert.equal(revokes, 1, 'repeated close after removal does not double-release');
});

test('principal delivery abort is idempotent and releases exactly once', async () => {
  const { delivery, declaration } = setup();
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  const controller = new AbortController();
  let revokes = 0;
  const activation = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: controller.signal,
    deliver: async () => {},
    revoke: () => { revokes += 1; },
  });
  controller.abort();
  assert.equal(revokes, 1, 'abort revokes the subscription once');
  controller.abort();
  assert.equal(revokes, 1, 'a second abort does not double-release');
  delivery.close();
  assert.equal(revokes, 1, 'close after abort does not double-release');
  assert.equal(await activation.activate(), undefined, 'aborted activation settles without a cursor');
});

test('owned live delivery forwards signal and revoke to principal snapshot subscriptions', async () => {
  const { db, schema, declaration } = setup();
  const owned = createOwnedLiveDelivery({
    db,
    entities: new Map(),
    mayVerb: async () => true,
    principalSnapshots: [declaration],
    principalSnapshotAuthorize: () => true,
    schema,
  });
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  const controller = new AbortController();
  let revokes = 0;
  const activation = await owned.delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: controller.signal,
    deliver: async () => {},
    revoke: () => { revokes += 1; },
  });
  assert.equal(await activation.activate(), 0, 'open subscription quiesces at its cursor');
  controller.abort();
  assert.equal(revokes, 1, 'the owned public seam forwards the transport abort to the principal delivery');
  assert.equal(await activation.activate(), undefined, 'aborted subscription settles without a cursor');
  owned.close();
  assert.equal(revokes, 1, 'close after abort does not double-release');
});

test('principal delivery wake during an active drain delivers the woken revision', async () => {
  const { delivery, declaration, db, app } = setup();
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  db.prepare(
    `INSERT INTO _PrincipalSnapshotRevision (declaration, principalType, principalId, revision) VALUES (?, ?, ?, 1)
     ON CONFLICT(declaration, principalType, principalId) DO UPDATE SET revision = revision + 1`,
  ).run(declaration.name, 'user', 'u1');
  let entered;
  let release;
  const deliveryEntered = new Promise((resolve) => { entered = resolve; });
  const deliveryGate = new Promise((resolve) => { release = resolve; });
  const delivered = [];
  let first = true;
  const activation = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal,
    deliver: async (batch) => {
      if (first) {
        first = false;
        entered();
        await deliveryGate;
      }
      delivered.push(...batch);
    },
  });
  const draining = activation.activate();
  await deliveryEntered;
  await app.principalSnapshots.transaction((tx) => tx.invalidate(declaration, { type: 'user', id: 'u1' }));
  release();
  assert.equal(await draining, 2, 'the drain picks up the woken second revision and reports the final cursor');
  assert.deepEqual(delivered.map((envelope) => envelope.seq), [1, 2]);
  delivery.close();
});

test('principal delivery terminal drain error removal revokes exactly once', async () => {
  const { delivery, declaration, db } = setup();
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  let revokes = 0;
  const activation = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal,
    deliver: async () => { throw new Error('drain boom'); },
    revoke: () => { revokes += 1; },
  });
  db.prepare(
    `INSERT INTO _PrincipalSnapshotRevision (declaration, principalType, principalId, revision) VALUES (?, ?, ?, 1)
     ON CONFLICT(declaration, principalType, principalId) DO UPDATE SET revision = revision + 1`,
  ).run(declaration.name, 'user', 'u1');
  await assert.rejects(() => activation.activate(), /drain boom/);
  assert.equal(revokes, 1, 'a terminal drain error revokes exactly once');
  delivery.close();
  assert.equal(revokes, 1, 'close after the removed subscription does not double-release');
});

// ── Reauthorization (host membership seam) ───────────────────────────────────

test('reauthorization: bootstrap and catchup revoke a principal the authorizer denies', async () => {
  const { db, declaration } = hubDatabase();
  const calls = [];
  const delivery = createPrincipalSnapshotDelivery({
    db,
    declarations: [declaration],
    authorize: ({ declaration: named, principal, trigger }) => {
      calls.push({ declaration: named.name, id: principal.id, trigger });
      return principal.id === 'u1';
    },
  });
  const denied = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u2' } });
  assert.deepEqual(await delivery.bootstrap({ principal: { type: 'user', id: 'u2' }, scope: denied }), { kind: 'revoked' });
  assert.deepEqual(await delivery.catchup({ principal: { type: 'user', id: 'u2' }, scope: denied, after: 0 }), { kind: 'revoked' });
  const admitted = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  assert.equal((await delivery.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: admitted })).kind, 'snapshot');
  assert.deepEqual(calls.map((call) => call.trigger), ['bootstrap', 'catchup', 'bootstrap']);
  assert.deepEqual(calls.map((call) => call.id), ['u2', 'u2', 'u1']);
  assert.ok(calls.every((call) => call.declaration === 'user-hub'));
  delivery.close();
});

test('reauthorization: subscription admission denial revokes before install', async () => {
  const { db, declaration } = hubDatabase();
  const delivery = createPrincipalSnapshotDelivery({ db, declarations: [declaration], authorize: () => false });
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  let revokes = 0;
  await assert.rejects(
    () => delivery.subscribe({
      principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal,
      deliver: async () => {},
      revoke: () => { revokes += 1; },
    }),
    (error) => error.code === 'live-delivery-revoked',
  );
  assert.equal(revokes, 1, 'a denied subscription revokes the transport before any delivery');
  delivery.close();
});

test('reauthorization: a resync drain denial revokes BEFORE delivering the replacement', async () => {
  const { db, declaration } = hubDatabase();
  let admit = true;
  const triggers = [];
  const delivery = createPrincipalSnapshotDelivery({
    db,
    declarations: [declaration],
    authorize: ({ principal, trigger }) => {
      triggers.push({ trigger, id: principal.id });
      return admit;
    },
  });
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  const delivered = [];
  let revokes = 0;
  const activation = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal,
    deliver: async (batch) => delivered.push(...batch),
    revoke: () => { revokes += 1; },
  });
  assert.equal(await activation.activate(), 0, 'quiesces at its cursor while admitted');
  db.prepare(
    `INSERT INTO _PrincipalSnapshotRevision (declaration, principalType, principalId, revision) VALUES (?, ?, ?, 1)
     ON CONFLICT(declaration, principalType, principalId) DO UPDATE SET revision = revision + 1`,
  ).run(declaration.name, 'user', 'u1');
  // Membership is revoked before the replacement drain runs.
  admit = false;
  assert.equal(await activation.activate(), undefined, 'a denied drain settles without a cursor');
  assert.equal(revokes, 1, 'the denied principal is revoked exactly once');
  assert.deepEqual(delivered, [], 'no replacement projection is delivered to the denied principal');
  assert.deepEqual(triggers.map((call) => call.trigger), ['subscribe', 'resync']);
  delivery.close();
});

test('reauthorization: wake-driven resync denial revokes without delivering', async () => {
  const { db, declaration } = hubDatabase();
  let admit = true;
  const delivery = createPrincipalSnapshotDelivery({ db, declarations: [declaration], authorize: () => admit });
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  const delivered = [];
  let revokes = 0;
  const activation = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal,
    deliver: async (batch) => delivered.push(...batch),
    revoke: () => { revokes += 1; },
  });
  assert.equal(await activation.activate(), 0);
  db.prepare(
    `INSERT INTO _PrincipalSnapshotRevision (declaration, principalType, principalId, revision) VALUES (?, ?, ?, 1)
     ON CONFLICT(declaration, principalType, principalId) DO UPDATE SET revision = revision + 1`,
  ).run(declaration.name, 'user', 'u1');
  admit = false;
  delivery.wake(declaration, { type: 'user', id: 'u1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(revokes, 1, 'the wake-driven drain revokes the denied principal');
  assert.deepEqual(delivered, [], 'no replacement is delivered after the wake');
  assert.equal(await activation.activate(), undefined, 'the revoked subscription settles without a cursor');
  delivery.close();
});

test('reauthorization: an authorizer error fails closed', async () => {
  const { db, declaration } = hubDatabase();
  const delivery = createPrincipalSnapshotDelivery({
    db,
    declarations: [declaration],
    authorize: () => { throw new Error('policy boom'); },
  });
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  assert.deepEqual(await delivery.bootstrap({ principal: { type: 'user', id: 'u1' }, scope }), { kind: 'revoked' });
  let revokes = 0;
  await assert.rejects(
    () => delivery.subscribe({
      principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal,
      deliver: async () => {},
      revoke: () => { revokes += 1; },
    }),
    (error) => error.code === 'live-delivery-revoked',
  );
  assert.equal(revokes, 1, 'an authorizer error revokes like a denial');
  delivery.close();
});

test('principal delivery fails closed when no authorizer is supplied', async () => {
  const { db, declaration } = hubDatabase();
  const delivery = createPrincipalSnapshotDelivery({ db, declarations: [declaration] });
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  assert.deepEqual(await delivery.bootstrap({ principal: { type: 'user', id: 'u1' }, scope }), { kind: 'revoked' });
  assert.deepEqual(await delivery.catchup({ principal: { type: 'user', id: 'u1' }, scope, after: 0 }), { kind: 'revoked' });
  await assert.rejects(
    () => delivery.subscribe({
      principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal,
      deliver: async () => {},
    }),
    (error) => error.code === 'live-delivery-revoked',
  );
  delivery.close();
});

// ── Multi-recipient isolation ────────────────────────────────────────────────

test('two-recipient bootstrap delivers each recipient ONLY its own rows', async () => {
  const { db, declaration } = hubDatabase();
  // Distinct sensitive rows per recipient, with distinct secret cell values.
  // The seeded rows from hubDatabase() are omitted; this table is populated
  // only with the two recipients' own rows so an A/B cross-read is detectable
  // by row content alone.
  db.exec(`DELETE FROM HubItem`);
  db.prepare('INSERT INTO HubItem (id, recipientId, title, rank, hidden) VALUES (?, ?, ?, ?, ?)').run('a1', 'u1', 'u1-private-alpha', 1, 's1');
  db.prepare('INSERT INTO HubItem (id, recipientId, title, rank, hidden) VALUES (?, ?, ?, ?, ?)').run('a2', 'u1', 'u1-private-beta', 2, 's1');
  db.prepare('INSERT INTO HubItem (id, recipientId, title, rank, hidden) VALUES (?, ?, ?, ?, ?)').run('b1', 'u2', 'u2-private-gamma', 1, 's2');
  const delivery = createPrincipalSnapshotDelivery({ db, declarations: [declaration], authorize: () => true });
  const one = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  const two = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u2' } });
  const u1 = await delivery.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: one });
  const u2 = await delivery.bootstrap({ principal: { type: 'user', id: 'u2' }, scope: two });
  assert.equal(u1.kind, 'snapshot');
  assert.equal(u2.kind, 'snapshot');
  assert.deepEqual(u1.snapshot.items, [{ title: 'u1-private-alpha', id: 'a1' }, { title: 'u1-private-beta', id: 'a2' }]);
  assert.deepEqual(u2.snapshot.items, [{ title: 'u2-private-gamma', id: 'b1' }]);
  const titles = (result) => result.snapshot.items.map((item) => item.title);
  assert.equal(titles(u1).includes('u2-private-gamma'), false, 'u1 never sees u2 rows');
  assert.equal(titles(u2).includes('u1-private-alpha'), false, 'u2 never sees u1 rows');
  assert.equal(titles(u2).includes('u1-private-beta'), false, 'u2 never sees u1 rows');
  assert.equal('hidden' in u1.snapshot.items[0], false, 'undeclared columns never project');
  delivery.close();
});
