// Slice A2 piece 1 — the runtime query API on a compiled entity. A hand-written
// handler (the imperative-router surface from slice A) needs to read and write
// entities directly: User.findOne(User.username.is(name)), User.create(...),
// User.findAll().select(...), User.getOrFail(id), User.delete(id). This is the
// SERVER's own trusted data-access primitive (like Express + an ORM) — it runs
// UNSCOPED/PRIVILEGED, NOT through a principal's read-scope, because the login
// lookup is inherently pre-principal and the handler already passed its gate.
// It is not a request path, so it is not a second auth path (DECISIONLOG #41).
//
// The db handle is application-scoped: workbench({ db }) binds it to this app so a
// standalone entity (declared before any app) can run queries with no db arg.

import { text, date, scope, grant, read, everyone } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import workbench, { entity } from '../build/internal.mjs';
import { lowerToSql } from '../build/scope-sql.mjs';

function bindUser(db) {
  const decl = entity('User', { username: text(), password: text(), grant: () => [scope(() => everyone()).can(() => grant(read))], });
  const app = workbench({ db, entities: [decl] });
  return app.entity(decl);
}

// A real on-disk-shaped in-memory DB seeded with a User table.
function seedDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  db.prepare("INSERT INTO User (id, username, password) VALUES (1, 'alice', 'pw-a')").run();
  db.prepare("INSERT INTO User (id, username, password) VALUES (2, 'bob', 'pw-b')").run();
  return db;
}

function seedEventDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Event (id TEXT PRIMARY KEY, title TEXT, startsAt INTEGER)');
  const insert = db.prepare('INSERT INTO Event (id, title, startsAt) VALUES (?, ?, ?)');
  insert.run('before', 'Before', new Date('2026-01-01T00:00:00.000Z').getTime());
  insert.run('first', 'First', new Date('2026-01-02T00:00:00.000Z').getTime());
  insert.run('second', 'Second', new Date('2026-01-03T00:00:00.000Z').getTime());
  insert.run('after', 'After', new Date('2026-01-04T00:00:00.000Z').getTime());
  return db;
}

test('Entity.<field> is a typed handle whose .is(value) lowers to a value-eq WHERE', () => {
  const UserDecl = entity('User', { username: text(), password: text(), grant: () => [scope(() => everyone()).can(() => grant(read))], });
  const User = UserDecl;  // field handles work on declarations, not bindings
  const node = User.username.is('alice');
  const { sql, params } = lowerToSql(node);
  assert.match(sql, /t0\.username = :/);
  // the literal is bound as a param, not a principalId placeholder
  const [key] = Object.keys(params);
  assert.equal(params[key], 'alice');
});

test('Entity.findOne(predicate) returns the matching row, or null when absent', () => {
  const User = bindUser(seedDb());
  const found = User.findOne(User.username.is('alice'));
  assert.equal(found.username, 'alice');
  assert.equal(found.password, 'pw-a');
  assert.equal(User.findOne(User.username.is('nobody')), null);
});

test('Entity.findAll() returns every row', () => {
  const User = bindUser(seedDb());
  const rows = User.findAll();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.username).sort(), ['alice', 'bob']);
});

test('Entity.findAll().select(...handles) projects only the named columns', () => {
  const User = bindUser(seedDb());
  const rows = User.findAll().select(User.id, User.username);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'username']);
    assert.equal(row.password, undefined);
  }
});

test('Entity.getOrFail(id) returns the row; a missing id throws a 404-status error', () => {
  const User = bindUser(seedDb());
  const row = User.getOrFail('1');
  assert.equal(row.username, 'alice');
  assert.throws(
    () => User.getOrFail('999'),
    (err) => err.status === 404,
  );
});

test('repeated entity queries reuse the prepared statement for the same SQL shape', () => {
  const db = seedDb();
  let prepareCount = 0;
  const counted = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (sql) => {
          prepareCount += 1;
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const User = bindUser(counted);
  const before = prepareCount;
  User.findOne(User.username.is('alice'));
  User.findOne(User.username.is('alice'));
  assert.equal(prepareCount - before, 1);
});

test('Entity.create(payload) inserts and returns the new row with its id', () => {
  const User = bindUser(seedDb());
  const created = User.create({ username: 'carol', password: 'pw-c' });
  assert.ok(created.id);
  assert.equal(created.username, 'carol');
  // it is really persisted
  const found = User.findOne(User.username.is('carol'));
  assert.equal(found.id, created.id);
});

test('Entity.create(payload) materializes server-owned defaults', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE AuditEntry (id TEXT PRIMARY KEY, body TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)');
  const instant = new Date('2026-07-14T00:00:00.000Z');
  const AuditEntryDecl = entity('AuditEntry', {
    body: text(),
    createdAt: date({ readonly: true, default: () => instant }),
    updatedAt: date({ touch: true, default: () => instant }),
    grant: () => [scope(() => everyone()).can(() => grant(read))],
  });
  const AuditEntry = workbench({ db, entities: [AuditEntryDecl] }).entity(AuditEntryDecl);

  const created = AuditEntry.create({ body: 'owned by the server' });

  assert.equal(created.createdAt, instant.getTime());
  assert.equal(created.updatedAt, instant.getTime());
});

test('Entity.delete(id) removes the row', () => {
  const User = bindUser(seedDb());
  const target = User.findOne(User.username.is('bob'));
  User.delete(target.id);
  assert.equal(User.findOne(User.username.is('bob')), null);
});

test('the query API runs UNSCOPED — it bypasses the read-scope (trusted server code)', () => {
  const db = seedDb();
  const HiddenDecl = entity('User', {
        username: text(), password: text(),

    // owner-scoped with no owner field would be empty; use a scope that compiles
    // to a column comparison that no seeded row satisfies if it WERE applied.
    grant: () => [scope(({ fields }) => fields.username.is('___never___')).can(() => grant(read))],
  });
  const app = workbench({ db, entities: [HiddenDecl] });
  const Hidden = app.entity(HiddenDecl);
  // unscoped: both seeded rows come back despite the restrictive scope
  assert.equal(Hidden.findAll().length, 2);
});

test('findAll(predicate) supports date range predicates for timeline queries', async () => {
  const EventDecl = entity('Event', { title: text(), startsAt: date(), grant: () => [scope(() => everyone()).can(() => grant(read))], });
  const app = workbench({ db: seedEventDb(), entities: [EventDecl] });
  const Event = app.entity(EventDecl);

  const rows = await Event
    .findAll(
      Event.startsAt
        .gte(new Date('2026-01-02T00:00:00.000Z'))
        .and(Event.startsAt.lte(new Date('2026-01-03T23:59:59.999Z'))),
    )
    .sort(Event.startsAt, 'asc');

  assert.deepEqual(rows.map((r) => r.id), ['first', 'second']);
  assert.equal(rows[0].startsAt, new Date('2026-01-02T00:00:00.000Z').getTime());
});
