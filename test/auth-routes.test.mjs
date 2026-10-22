// auth-routes.test.mjs — the framework-owned `.auth()` battery, end-to-end.
//
// `.auth()` mounts `/auth` (registration + login + logout) built from the SAME public
// primitives an app would use, PLUS the Set-Cookie handling the exemplar omits
// — the 0→1 auth bug: `sessionPrincipalOf` reads ONLY the cookie, so a
// body-only login leaves the client anonymous on every subsequent request.
//
// The invariant under test: login sets a fail-closed `sid` cookie, a
// subsequent request carrying it hydrates a user principal (owner-scoped CRUD
// succeeds), wrong password → 401 + no cookie, logout deletes the session and
// clears the cookie, and `.auth()` on a db-less app throws at construction.

import { entity, text, ref, scope, grant, read, write, subscribe } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import workbench from '../build/app.mjs';
import { SESSION_COOKIE } from '../build/auth/session.mjs';
import { createAuthClient } from '../public/workbench-client.mjs';

// An owner-scoped Note: the default-on route gate admits a user, the row grant
// scopes rows to the owner. Proves a hydrated principal reaches dispatch and is
// filtered by the row scope — the whole point of setting the cookie.
function ownedNote() {
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

// Boot an app with `.auth()` + an owner-scoped Note. `listen(0)` picks an
// ephemeral port; `app.ready` resolves once routes + schema + server are up.
// No explicit principalOf → session hydration (sessionPrincipalOf) is the
// default principal source, exactly the path the cookie fixes.
async function boot(t) {
  const app = workbench({ db: ':memory:' }).auth().mount('/notes', ownedNote());
  app.listen(0);
  await app.ready;
  const { port } = app.httpServer.address();
  t.after(() => app.httpServer.close());
  return { app, origin: `http://127.0.0.1:${port}` };
}

// Pull the `sid=...` value out of a Set-Cookie header (Node joins multiple
// Set-Cookie headers with `, ` — split on the attribute boundary, not commas).
function sidFromSetCookie(header) {
  const first = header.split(/,(?=[^ ;]+)/)[0];
  const match = first.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

test('register sets a fail-closed Set-Cookie (HttpOnly, SameSite=Lax, Path=/)', async (t) => {
  const { origin } = await boot(t);
  const res = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
  });
  assert.equal(res.status, 201);
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie, 'login sets a Set-Cookie header');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\//);
  // the cookie value is an opaque token, not the username or a body echo
  const token = sidFromSetCookie(cookie);
  assert.ok(token, 'the sid cookie carries a token');
  assert.doesNotMatch(cookie, /alice/);
  // the body carries the public user shape, NOT the token
  const body = await res.json();
  assert.deepEqual(body, { user: { id: body.user.id, username: 'alice' } });
  assert.equal(body.token, undefined, 'the token travels in the cookie, not the body');
});

test('login never creates an unknown user', async (t) => {
  const { origin, app } = await boot(t);
  const res = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'unknown', password: 'hunter2' }),
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.deepEqual(await res.json(), { ok: false, failure: { category: 'denied', message: 'bad credentials' } });
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM User').get().n, 0);
});

test('register rejects an existing identity without minting a session', async (t) => {
  const { origin, app } = await boot(t);
  const register = () => fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
  });
  assert.equal((await register()).status, 201);
  const duplicate = await register();
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.headers.get('set-cookie'), null);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM User').get().n, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM Session').get().n, 1);
});

test('a subsequent request carrying the cookie hydrates a user principal (owner CRUD succeeds)', async (t) => {
  const { origin } = await boot(t);
  // register alice → capture the cookie
  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
  });
  const cookie = `sid=${sidFromSetCookie(loginRes.headers.get('set-cookie'))}`;

  // create a note as alice — the owner is auto-set from the hydrated principal
  const created = await fetch(`${origin}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ body: 'hello' }),
  });
  assert.equal(created.status, 201);
  const note = await created.json();

  // a second request with the same cookie lists the note — the principal is
  // hydrated from the cookie, and the owner-scoped grant returns alice's row
  const listed = await fetch(`${origin}/notes`, { headers: { cookie } });
  assert.equal(listed.status, 200);
  const rows = await listed.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, note.id);
  assert.equal(rows[0].owner, rows[0].owner, 'owner is set');
});

test('wrong password → 401 and no cookie', async (t) => {
  const { origin } = await boot(t);
  // registration creates alice
  await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
  });
  // a wrong-password login is rejected and mints nothing
  const res = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'wrong' }),
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null, 'no cookie on a failed login');
  const body = await res.json();
  assert.deepEqual(body, {
    ok: false,
    failure: { category: 'denied', message: 'bad credentials' },
  });
});

test('login after an expired lock does not instantly relock (wrong password → 401)', async (t) => {
  const { origin, app } = await boot(t);
  await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
  });
  // Arm an EXPIRED lock: the pre-lock failed-attempt counter is stale and the
  // lock time has passed. The next wrong password must restart the series, not
  // immediately relock (the stale counter alone would trip the threshold).
  app.db.prepare('UPDATE User SET failedLoginAttempts = ?, lockedUntil = ? WHERE username = ?')
    .run(3, Date.now() - 1000, 'alice');

  const res = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'wrong' }),
  });
  assert.equal(res.status, 401, 'an expired lock must not make the next wrong password a relock (403)');
  const row = app.db.prepare('SELECT failedLoginAttempts FROM User WHERE username = ?').get('alice');
  assert.equal(row.failedLoginAttempts, 1, 'the failed-attempt series restarts at 1');

  // A correct password after the expiry logs in normally.
  const ok = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
  });
  assert.equal(ok.status, 201);
  assert.ok(ok.headers.get('set-cookie'));
});

test('logout deletes the session and clears the cookie; the old cookie is anonymous afterwards', async (t) => {
  const { origin, app } = await boot(t);
  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
  });
  const cookieValue = sidFromSetCookie(loginRes.headers.get('set-cookie'));
  const cookie = `sid=${cookieValue}`;

  // logout clears the cookie (Max-Age=0) and deletes the session row
  const logoutRes = await fetch(`${origin}/auth/logout`, {
    method: 'POST',
    headers: { cookie },
  });
  assert.equal(logoutRes.status, 204);
  const cleared = logoutRes.headers.get('set-cookie');
  assert.ok(cleared, 'logout clears the cookie');
  assert.match(cleared, /Max-Age=0/i);
  assert.match(cleared, new RegExp(`${SESSION_COOKIE}=`));

  // the session row is gone — the old cookie resolves to anonymous (401)
  const after = await fetch(`${origin}/notes`, { headers: { cookie } });
  assert.equal(after.status, 401, 'the old cookie is anonymous after logout');
  // the Session table is empty
  const count = app.db.prepare('SELECT COUNT(*) AS n FROM Session').get().n;
  assert.equal(count, 0, 'logout deleted the session row');
});

test('no cookie → anonymous → default-on route gate denies (401)', async (t) => {
  const { origin } = await boot(t);
  const res = await fetch(`${origin}/notes`);
  assert.equal(res.status, 401);
});

test('.auth() on a db-less app throws at construction (fail closed, loud)', () => {
  assert.throws(
    () => workbench().auth(),
    /db/i,
    'auth() on a db-less app throws at construction, not mid-login',
  );
});

test('createAuthClient.login returns the user and propagates errors', async (t) => {
  const { origin } = await boot(t);
  const client = createAuthClient({ baseUrl: origin });
  await client.register('alice', 'hunter2');
  const result = await client.login('alice', 'hunter2');
  assert.equal(result.user.username, 'alice');
  // a wrong-password login throws with the server's error message
  await assert.rejects(() => client.login('alice', 'wrong'), /bad credentials/i);
});

test('createAuthClient.logout clears the session', async (t) => {
  const { origin, app } = await boot(t);
  // The client SDK uses credentials: 'include' so the cookie round-trips; in
  // Node's fetch the Set-Cookie is not auto-stored across requests, so we drive
  // the cookie manually here to exercise the logout path against the live route.
  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
  });
  const cookieValue = sidFromSetCookie(loginRes.headers.get('set-cookie'));
  const client = createAuthClient({
    baseUrl: origin,
    fetchImpl: (url, opts) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), cookie: `sid=${cookieValue}` } }),
  });
  const result = await client.logout();
  assert.equal(result.ok, true);
  const count = app.db.prepare('SELECT COUNT(*) AS n FROM Session').get().n;
  assert.equal(count, 0, 'logout deleted the session row');
});

// --- /auth/me session-read endpoint ---------------------------------------
//
// GET /auth/me returns the authenticated user's profile from the active session.
// requireUser() rejects anonymous callers.

test('/auth/me returns the authenticated user profile', async (t) => {
  const { origin } = await boot(t);
  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
  });
  const cookie = `sid=${sidFromSetCookie(loginRes.headers.get('set-cookie'))}`;

  const meRes = await fetch(`${origin}/auth/me`, { headers: { cookie } });
  assert.equal(meRes.status, 200);
  const body = await meRes.json();
  assert.equal(body.user.id, (await loginRes.json()).user.id);
  assert.equal(body.user.username, 'alice');
  // Optional profile fields are null (not set at login).
  assert.equal(body.user.email, null);
});

test('/auth/me returns 401 without a valid session', async (t) => {
  const { origin } = await boot(t);
  const res = await fetch(`${origin}/auth/me`);
  assert.equal(res.status, 401);
});

test('/auth/me denies an expired session row before scheduled cleanup', async (t) => {
  const { origin, app } = await boot(t);
  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
  });
  const cookie = `sid=${sidFromSetCookie(loginRes.headers.get('set-cookie'))}`;
  app.db.prepare('UPDATE Session SET createdAt = ? WHERE token = ?').run(Date.now() - 7 * 86_400_000, cookie.slice('sid='.length));

  const res = await fetch(`${origin}/auth/me`, { headers: { cookie } });
  assert.equal(res.status, 401);
});

test('/auth/me with email identity returns the email field', async (t) => {
  const { origin } = await bootWithEmail(t);
  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice@example.com', password: 'hunter2' }),
  });
  const cookie = `sid=${sidFromSetCookie(loginRes.headers.get('set-cookie'))}`;

  const meRes = await fetch(`${origin}/auth/me`, { headers: { cookie } });
  assert.equal(meRes.status, 200);
  const body = await meRes.json();
  assert.equal(body.user.email, 'alice@example.com');
  assert.equal(body.user.username, null, 'username was not populated by an email-first login');
});

// --- /auth/change-password endpoint ---------------------------------------
//
// POST /auth/change-password updates the authenticated user's password.
// Verifies the current password before setting the new one.

test('/auth/change-password succeeds with a correct current password', async (t) => {
  const { origin } = await boot(t);
  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
  });
  const cookie = `sid=${sidFromSetCookie(loginRes.headers.get('set-cookie'))}`;

  const changeRes = await fetch(`${origin}/auth/change-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ currentPassword: 'hunter2', newPassword: 'newpw' }),
  });
  assert.equal(changeRes.status, 204, 'password changed successfully');

  // The old password no longer works; the new password does.
  const oldLogin = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
  });
  assert.equal(oldLogin.status, 401, 'old password is rejected');

  const newLogin = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'newpw' }),
  });
  assert.equal(newLogin.status, 201, 'new password is accepted');
});

test('/auth/change-password returns 401 with a wrong current password', async (t) => {
  const { origin } = await boot(t);
  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
  });
  const cookie = `sid=${sidFromSetCookie(loginRes.headers.get('set-cookie'))}`;

  const changeRes = await fetch(`${origin}/auth/change-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'newpw' }),
  });
  assert.equal(changeRes.status, 401);
});

test('/auth/change-password returns 400 with missing body fields', async (t) => {
  const { origin } = await boot(t);
  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
  });
  const cookie = `sid=${sidFromSetCookie(loginRes.headers.get('set-cookie'))}`;

  const noCurrent = await fetch(`${origin}/auth/change-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ newPassword: 'newpw' }),
  });
  assert.equal(noCurrent.status, 400);

  const noNew = await fetch(`${origin}/auth/change-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ currentPassword: 'hunter2' }),
  });
  assert.equal(noNew.status, 400);
});

// --- identifyBy: configurable login identity field(s) ---------------------
//
// `.auth({ identifyBy })` declares which User field(s) a login credential is
// matched against, in order. The built-in User now carries an optional `email`
// field, so an email-login app passes `identifyBy: ['email']` (or
// `['email', 'username']` to accept either). The credential always travels in
// the body's `username` slot — only the lookup columns change.

async function bootWithEmail(t) {
  const app = workbench({ db: ':memory:' })
    .auth({ identifyBy: ['email', 'username'] })
    .mount('/notes', ownedNote());
  app.listen(0);
  await app.ready;
  const { port } = app.httpServer.address();
  t.after(() => app.httpServer.close());
  return { app, origin: `http://127.0.0.1:${port}` };
}

test('identifyBy: a credential is matched against email first', async (t) => {
  const { origin, app } = await bootWithEmail(t);
  // Registration with an email credential creates a user with that email.
  const res = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice@example.com', password: 'hunter2' }),
  });
  assert.equal(res.status, 201);
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie, 'email login sets a cookie');
  // The user row stores the email in the `email` column (the primary field).
  const user = app.db.prepare('SELECT email, username FROM User').get();
  assert.equal(user.email, 'alice@example.com');
  assert.equal(user.username, null, 'username was not populated by an email-first login');
});

test('identifyBy: a second login with the same email verifies the password', async (t) => {
  const { origin } = await bootWithEmail(t);
  await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice@example.com', password: 'hunter2' }),
  });
  // Correct password → 201 + cookie.
  const ok = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice@example.com', password: 'hunter2' }),
  });
  assert.equal(ok.status, 201);
  assert.ok(ok.headers.get('set-cookie'));
  // Wrong password → 401 + no cookie (fail closed).
  const bad = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice@example.com', password: 'wrong' }),
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null, 'no cookie on a failed email login');
});

test('identifyBy: a credential matching no email falls through to username', async (t) => {
  const { origin, app } = await bootWithEmail(t);
  // Seed a user directly in the username column (the SECOND identity field),
  // so the email lookup misses but the username lookup hits.
  const { User } = await import('../build/auth/entities.mjs');
  app.entity(User).create({ username: 'bob', password: 'hunter2' });
  // A login with the bob username credential: no email match, username match.
  const res = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: 'hunter2' }),
  });
  assert.equal(res.status, 201);
  assert.ok(res.headers.get('set-cookie'), 'username fall-through login mints a session');
  // Wrong password against the username-matched user fails closed.
  const bad = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: 'wrong' }),
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);
  // No extra user was created by the two logins above.
  const count = app.db.prepare('SELECT COUNT(*) AS n FROM User').get().n;
  assert.equal(count, 1, 'fall-through lookup reuses the seeded user, no duplicate');
});

test('identifyBy: an unknown field fails closed with a 500 at first login', async (t) => {
  const app = workbench({ db: ':memory:' }).auth({ identifyBy: ['nope'] }).mount('/notes', ownedNote());
  app.listen(0);
  await app.ready;
  const { port } = app.httpServer.address();
  t.after(() => app.httpServer.close());
  const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
  });
  assert.equal(res.status, 500, 'an unknown identity field fails closed, loudly');
});

// --- #7602: email identity folds case, and collisions refuse -----------------

test('identifyBy: email case folds for sign-in on a pre-existing account', async (t) => {
  const { origin, app } = await bootWithEmail(t);
  const { User } = await import('../build/auth/entities.mjs');
  app.entity(User).create({ email: 'Ada.Lovelace@Example.com', password: 'hunter2' });
  for (const variant of ['ada.lovelace@example.com', 'ADA.LOVELACE@EXAMPLE.COM', 'Ada.Lovelace@Example.com']) {
    const res = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: variant, password: 'hunter2' }),
    });
    assert.equal(res.status, 201, `${variant} signs in`);
    assert.ok(res.headers.get('set-cookie'), `${variant} mints a session`);
  }
});

test('identifyBy: two case-variant emails are refused, never silently merged', async (t) => {
  const { origin, app } = await bootWithEmail(t);
  const { User } = await import('../build/auth/entities.mjs');
  app.entity(User).create({ email: 'dup@example.com', password: 'first' });
  app.entity(User).create({ email: 'DUP@example.com', password: 'second' });
  const res = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Dup@Example.com', password: 'first' }),
  });
  assert.equal(res.status, 409, 'an ambiguous fold is a refusal, not a pick');
  assert.equal(res.headers.get('set-cookie'), null, 'no session is minted on an ambiguous fold');
});

test('identifyBy: registration rejects a case-variant of an existing email', async (t) => {
  const { origin, app } = await bootWithEmail(t);
  const first = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Alice@Example.com', password: 'hunter2' }),
  });
  assert.equal(first.status, 201);
  const duplicate = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice@example.com', password: 'hunter2' }),
  });
  assert.equal(duplicate.status, 409, 'a case variant is the same identity');
  const count = app.db.prepare('SELECT COUNT(*) AS n FROM User').get().n;
  assert.equal(count, 1, 'no second account is created for a case variant');
});

test('auth: minimumPasswordLength refuses a short registration and accepts the floor', async (t) => {
  const app = workbench({ db: ':memory:' })
    .auth({ identifyBy: ['email', 'username'], minimumPasswordLength: 8 })
    .mount('/notes', ownedNote());
  app.listen(0);
  await app.ready;
  const { port } = app.httpServer.address();
  t.after(() => app.httpServer.close());
  const origin = `http://127.0.0.1:${port}`;
  const short = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'short@example.com', password: 'short' }),
  });
  assert.equal(short.status, 400, 'a password below the app floor is refused');
  const atFloor = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'floor@example.com', password: '12345678' }),
  });
  assert.equal(atFloor.status, 201, 'a password at the floor is accepted');
});
