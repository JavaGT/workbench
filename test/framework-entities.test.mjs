// Slice A2 piece 3 — the framework-provided User and Session entities.
//
// session.mjs (the binding exemplar) imports `User` and `Session` FROM the
// framework (not app-declared) and drives the auth boundary through them:
//   - login:  User.findOne(User.username.is(name)); User.create({username, password});
//             user.password.verify(pw); Session.create({ userId: user.id }) -> { token }
//   - link:   Session.create({ kind: 'link', token }) -> { token }
//   - logout: Session.delete(id)
//   - views:  User.findAll().select(User.id, User.username); User.getOrFail(id)
//
// User is an ordinary entity (username: text, password: hash) — the generic
// query API already serves it. Session is the contentious one: its STORED row is
// (token, principalType, principalId) — exactly what sessionPrincipalOf reads —
// but its create() is called in two shapes whose payload keys (userId, kind) are
// NOT stored columns and whose stored columns are all server-minted. So Session
// declares those three cells as readonly framework-owned fields and supplies a
// custom create() that accepts only the two known session intents and mints the
// canonical row. This is trusted framework code minting a session server-side —
// the same trust class as the unscoped query API, not a second auth path.

import { Session } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { User } from '../build/internal.mjs';
import { sessionPrincipalOf, hashSessionToken, SESSION_COOKIE } from '../build/auth/session.mjs';

// Seed the two framework tables. The framework does not generate DDL in Phase 1;
// the app/test harness owns CREATE TABLE. The Session schema is exactly the shape
// sessionPrincipalOf queries.
function bootApp() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  db.exec(
    'CREATE TABLE Session (id TEXT PRIMARY KEY, token TEXT, principalType TEXT, principalId TEXT, createdAt TEXT)',
  );
  return workbench({ db, entities: [User, Session] });
}

// --- User: an ordinary entity over the generic query API ---

test('User is a compiled entity with username and a hash password', () => {
  assert.equal(User.name, 'User');
  assert.equal(User.fields.username.kind, 'value');
  assert.equal(User.fields.password.kind, 'hash');
});

test('User.create digests the password; user.password.verify checks it', () => {
  const app = bootApp();
  const user = app.entity(User).create({ username: 'alice', password: 'hunter2' });
  assert.ok(user.id);
  assert.equal(user.username, 'alice');
  // the stored cell is a digest, never the plaintext
  assert.notEqual(user.password, 'hunter2');
  assert.equal(user.password.verify('hunter2'), true);
  assert.equal(user.password.verify('wrong'), false);
});

test('User.findOne(User.username.is(name)) round-trips with a verifiable password', () => {
  const app = bootApp();
  app.entity(User).create({ username: 'bob', password: 'sekret' });
  const found = app.entity(User).findOne(User.username.is('bob'));
  assert.equal(found.username, 'bob');
  assert.equal(found.password.verify('sekret'), true);
  assert.equal(app.entity(User).findOne(User.username.is('nobody')), null);
});

test('User.findAll().select(User.id, User.username) projects without the password', () => {
  const app = bootApp();
  app.entity(User).create({ username: 'alice', password: 'a' });
  app.entity(User).create({ username: 'bob', password: 'b' });
  const rows = app.entity(User).findAll().select(User.id, User.username);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'username']);
  }
});

// --- Session: the framework-minted capability record ---

test('Session declares its stored cells as readonly framework-owned fields', () => {
  assert.equal(Session.name, 'Session');
  assert.equal(Session.fields.token.readonly, true);
  assert.equal(Session.fields.principalType.readonly, true);
  assert.equal(Session.fields.principalId.readonly, true);
});

test('Session.create({ userId }) mints a token and a user principal row', () => {
  const app = bootApp();
  const session = app.entity(Session).create({ userId: 'alice' });
  assert.ok(session.token, 'a session token is minted');
  assert.equal(session.principalType, 'user');
  assert.equal(session.principalId, 'alice');
});

test('two Session.create calls mint distinct tokens', () => {
  const app = bootApp();
  const a = app.entity(Session).create({ userId: 'alice' });
  const b = app.entity(Session).create({ userId: 'alice' });
  assert.notEqual(a.token, b.token);
});

test('Session.create({ kind: "link", token }) mints a link principal carrying the share token', () => {
  const app = bootApp();
  const shareToken = 'share-abc';
  const session = app.entity(Session).create({ kind: 'link', token: shareToken });
  assert.ok(session.token, 'a fresh session token is minted (distinct from the share token)');
  assert.notEqual(session.token, shareToken);
  assert.equal(session.principalType, 'link');
  // the link principal carries WHICH share granted it — the share token itself
  assert.equal(session.principalId, shareToken);
});

test('Session.create rejects an unknown intent (fail closed)', () => {
  const app = bootApp();
  assert.throws(() => app.entity(Session).create({ bogus: 1 }), /session/i);
});

test('a minted user session resolves through sessionPrincipalOf', () => {
  const app = bootApp();
  const session = app.entity(Session).create({ userId: 'alice' });
  const principalOf = sessionPrincipalOf(app.db);
  const req = { headers: { cookie: `${SESSION_COOKIE}=${session.token}` } };
  const who = principalOf(req);
  assert.equal(who.type, 'user');
  assert.equal(who.id, 'alice');
});

test('a minted link session resolves to a link principal through sessionPrincipalOf', () => {
  const app = bootApp();
  const session = app.entity(Session).create({ kind: 'link', token: 'share-xyz' });
  const principalOf = sessionPrincipalOf(app.db);
  const req = { headers: { cookie: `${SESSION_COOKIE}=${session.token}` } };
  const who = principalOf(req);
  assert.equal(who.type, 'link');
  assert.equal(who.id, 'share-xyz');
  // A link principal must carry its token as attributes.token — the linkHolder
  // check reads it to admit rows the token grants (#1 symbolic attribute bind).
  assert.equal(who.attributes?.token, 'share-xyz');
});

test('Session.delete(id) removes the session row', () => {
  const app = bootApp();
  const session = app.entity(Session).create({ userId: 'alice' });
  const tokenHash = hashSessionToken(session.token);
  const row = app.entity(Session).findOne(Session.token.is(tokenHash));
  assert.ok(row);
  app.entity(Session).delete(row.id);
  assert.equal(app.entity(Session).findOne(Session.token.is(tokenHash)), null);
});
