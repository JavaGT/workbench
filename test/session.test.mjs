// Phase 2, slice 4 — session → req principal hydration (the requireAuth concept
// on HTTP). SPEC §3 (cookie sessions; `req.user` hydrated from the session),
// §572 (the principal is built SERVER-SIDE from the session; the client cannot
// supply its own identity), §660 (session.mjs — session/auth wiring).
//
// The invariant under test: a request's principal is derived server-side from an
// opaque session token carried in a cookie. The cookie holds ONLY the token; the
// identity (type, id) is looked up in the Session table and constructed by the
// framework. A missing, malformed, or unknown token yields `anonymous` — and the
// default-on route gate then denies it. This is the SAME admission path as the
// `principalOf` default it replaces, never a second auth path.

import { text, ref, scope, grant, deny as _deny, read, write, subscribe } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity } from '../build/internal.mjs';
import {
  parseCookies, sessionCookie, sessionPrincipalOf, SESSION_COOKIE,
} from '../build/auth/session.mjs';
import { anonymous } from '../build/principal.mjs';

// An owner-scoped Note (default-on route gate + owner row grant). Used to prove
// that a hydrated principal reaches dispatch and is filtered by the row scope.
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

// Seed a DB with a Note table and a Session table mapping opaque tokens to a
// server-side principal identity (type + id). The Session row is what the
// framework reads to BUILD the principal — the client never sends type/id.
function seed() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT, owner TEXT)');
  db.exec(
    'CREATE TABLE Session (id TEXT PRIMARY KEY, token TEXT, principalType TEXT, principalId TEXT, createdAt INTEGER)',
  );
  db.prepare('INSERT INTO Note (id, body, owner) VALUES (?, ?, ?)').run(1, 'a', 'alice');
  db.prepare(
    'INSERT INTO Session (id, token, principalType, principalId, createdAt) VALUES (?, ?, ?, ?, ?)',
  ).run('session-alice', 'alice-token', 'user', 'alice', Date.now());
  return db;
}

// --- the cookie codec (zero-dep) ---

test('parseCookies splits a Cookie header into a name→value map', () => {
  assert.deepEqual(parseCookies('sid=abc; other=1'), { sid: 'abc', other: '1' });
});

test('parseCookies handles an empty / missing header', () => {
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
});

test('parseCookies url-decodes values', () => {
  assert.deepEqual(parseCookies('sid=a%20b'), { sid: 'a b' });
});

test('sessionCookie emits a fail-closed Set-Cookie (HttpOnly, SameSite=Lax, Secure)', () => {
  const header = sessionCookie('tok123');
  assert.match(header, new RegExp(`^${SESSION_COOKIE}=tok123`));
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/i);
  assert.match(header, /Secure/);
  assert.match(header, /Path=\//);
});

test('sessionCookie can drop Secure for a non-TLS context', () => {
  const header = sessionCookie('tok123', { secure: false, env: 'development' });
  assert.doesNotMatch(header, /Secure/);
  assert.match(header, /HttpOnly/); // HttpOnly is never dropped
});

// --- server-side principal construction ---

test('sessionPrincipalOf builds the principal SERVER-SIDE from the token', () => {
  const db = seed();
  const principalOf = sessionPrincipalOf(db);
  const req = { headers: { cookie: `${SESSION_COOKIE}=alice-token` } };
  const who = principalOf(req);
  assert.equal(who.type, 'user');
  assert.equal(who.id, 'alice');
  db.close();
});

test('sessionPrincipalOf yields anonymous for a missing cookie (fail closed)', () => {
  const db = seed();
  const principalOf = sessionPrincipalOf(db);
  assert.equal(principalOf({ headers: {} }), anonymous);
  db.close();
});

test('sessionPrincipalOf yields anonymous for an UNKNOWN token (fail closed)', () => {
  const db = seed();
  const principalOf = sessionPrincipalOf(db);
  const req = { headers: { cookie: `${SESSION_COOKIE}=forged-token` } };
  assert.equal(principalOf(req), anonymous);
  db.close();
});

test('sessionPrincipalOf rejects a session exactly at its configured expiry boundary', () => {
  const db = seed();
  db.prepare('UPDATE Session SET createdAt = ? WHERE token = ?').run(1000, 'alice-token');
  const principalOf = sessionPrincipalOf(db, { durationMs: 7000, now: () => 8000 });
  assert.equal(principalOf({ headers: { cookie: `${SESSION_COOKIE}=alice-token` } }), anonymous);
  db.close();
});

test('sessionPrincipalOf accepts a session before its configured expiry boundary', () => {
  const db = seed();
  db.prepare('UPDATE Session SET createdAt = ? WHERE token = ?').run(1000, 'alice-token');
  const principalOf = sessionPrincipalOf(db, { durationMs: 7000, now: () => 7999 });
  assert.equal(principalOf({ headers: { cookie: `${SESSION_COOKIE}=alice-token` } }).id, 'alice');
  db.close();
});

test('sessionPrincipalOf accepts canonical timestamp encodings and fails closed for malformed or future timestamps', () => {
  const db = seed();
  const principalOf = sessionPrincipalOf(db, { durationMs: 7000, now: () => 8000 });
  db.prepare('UPDATE Session SET createdAt = ? WHERE token = ?').run(new Date(1001).toISOString(), 'alice-token');
  assert.equal(principalOf({ headers: { cookie: `${SESSION_COOKIE}=alice-token` } }).id, 'alice');
  db.prepare('UPDATE Session SET createdAt = ? WHERE token = ?').run('1001.0', 'alice-token');
  assert.equal(principalOf({ headers: { cookie: `${SESSION_COOKIE}=alice-token` } }).id, 'alice');
  db.prepare('UPDATE Session SET createdAt = ? WHERE token = ?').run('not-a-timestamp', 'alice-token');
  assert.equal(principalOf({ headers: { cookie: `${SESSION_COOKIE}=alice-token` } }), anonymous);
  db.prepare('UPDATE Session SET createdAt = ? WHERE token = ?').run('2026-02-30T00:00:00.000Z', 'alice-token');
  assert.equal(principalOf({ headers: { cookie: `${SESSION_COOKIE}=alice-token` } }), anonymous);
  db.prepare('UPDATE Session SET createdAt = ? WHERE token = ?').run(8001, 'alice-token');
  assert.equal(principalOf({ headers: { cookie: `${SESSION_COOKIE}=alice-token` } }), anonymous);
  db.close();
});

test('sessionPrincipalOf fails closed for invalid clock or duration configuration', () => {
  const db = seed();
  const req = { headers: { cookie: `${SESSION_COOKIE}=alice-token` } };
  for (const durationMs of [0, -1, NaN, Infinity, '7000']) {
    assert.equal(sessionPrincipalOf(db, { durationMs, now: () => Date.now() })(req), anonymous);
  }
  assert.equal(sessionPrincipalOf(db, { durationMs: 7000, now: () => NaN })(req), anonymous);
  db.close();
});

test('a client cannot inject its own identity — only the opaque token is honored', () => {
  const db = seed();
  const principalOf = sessionPrincipalOf(db);
  // The client tries to smuggle a different identity in the cookie. There is no
  // type/id in the cookie protocol; the token is unknown, so it is anonymous.
  const req = {
    headers: { cookie: `${SESSION_COOKIE}=alice-token; principalId=root; type=system` },
  };
  const who = principalOf(req);
  // Honored: the alice-token lookup. Ignored: the smuggled principalId/type.
  assert.equal(who.type, 'user');
  assert.equal(who.id, 'alice');
  db.close();
});

// --- end-to-end over the real socket ---

async function serve(t, db) {
  const app = workbench({ db }); // no explicit principalOf → session hydration
  app.mount('/notes', ownedNote());
  app.listen(0);
  await new Promise((resolve) => app.httpServer.once('listening', resolve));
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  const { port } = app.httpServer.address();
  return { origin: `http://127.0.0.1:${port}` };
}

test('a session cookie hydrates the principal and admits the request end-to-end', async (t) => {
  const db = seed();
  const { origin } = await serve(t, db);
  const res = await fetch(`${origin}/notes`, {
    headers: { cookie: `${SESSION_COOKIE}=alice-token` },
  });
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner, 'alice');
});

test('no cookie → anonymous → default-on route gate denies (401)', async (t) => {
  const db = seed();
  const { origin } = await serve(t, db);
  const res = await fetch(`${origin}/notes`);
  assert.equal(res.status, 401);
});

test('a forged token → anonymous → 401 (fail closed end-to-end)', async (t) => {
  const db = seed();
  const { origin } = await serve(t, db);
  const res = await fetch(`${origin}/notes`, {
    headers: { cookie: `${SESSION_COOKIE}=forged` },
  });
  assert.equal(res.status, 401);
});

test('an expired session row is denied over HTTP before scheduled cleanup', async (t) => {
  const db = seed();
  db.prepare('UPDATE Session SET createdAt = ? WHERE token = ?').run(Date.now() - 7 * 86_400_000, 'alice-token');
  const { origin } = await serve(t, db);
  const res = await fetch(`${origin}/notes`, {
    headers: { cookie: `${SESSION_COOKIE}=alice-token` },
  });
  assert.equal(res.status, 401);
});

test('the HTTP resolver uses the app-specific session duration', async (t) => {
  const db = seed();
  db.prepare('UPDATE Session SET createdAt = ? WHERE token = ?').run(Date.now() - 1000, 'alice-token');
  const app = workbench({ db, session: { durationMs: 1000 } });
  app.mount('/notes', ownedNote());
  app.listen(0);
  await new Promise((resolve) => app.httpServer.once('listening', resolve));
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  const { port } = app.httpServer.address();

  const res = await fetch(`http://127.0.0.1:${port}/notes`, {
    headers: { cookie: `${SESSION_COOKIE}=alice-token` },
  });
  assert.equal(res.status, 401);
});
