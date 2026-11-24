// Wave 8 auth cleanup regressions.
//
// 1. The ONE row-level admin-authority evaluation drives both scoped API-key
//    creation and invitation creation: a non-admin is refused, a missing or
//    invisible row fails closed (403 for keys, 404/not-found for invitations),
//    and a row admin is admitted with the same declared-role allowlist.
// 2. The consolidated auth helpers (sha256hex, challenge generation, and the
//    session timestamp parser) behave identically for every consumer module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  ApiKey,
  Invitation,
  entity,
  text,
  ref,
  map,
  read,
  membership,
} from '../build/index.mjs';
import { principal } from '../build/principal.mjs';
import { createInvitationApi } from '../build/auth/invitation.mjs';
import {
  sha256hex,
  sessionCreatedAtMs,
  hashSessionToken,
  SESSION_COOKIE,
} from '../build/auth/session.mjs';
import { generateChallenge } from '../build/auth/passkey.mjs';
import { generateLoginChallenge } from '../build/auth/login-challenge.mjs';
import { generateBackupCodes, verifyBackupCode } from '../build/auth/totp.mjs';
import { SESSION_COOKIE as ROUTES_SESSION_COOKIE } from '../build/auth/routes.mjs';

const targetEntityName = 'W8CleanupProject';

function makeTargetEntity() {
  const Target = entity(targetEntityName, {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['member'] }),
  });
  membership(Target, { member: { can: [read] } });
  return Target;
}

async function boot(t) {
  const Target = makeTargetEntity();
  const app = workbench({ db: ':memory:' })
    .auth()
    .mount('/projects', Target);
  app.listen(0);
  await app.ready;
  t.after(() => app.httpServer.close());
  const { port } = app.httpServer.address();
  return {
    app,
    Target,
    origin: `http://127.0.0.1:${port}`,
    invitations: createInvitationApi({ Invitation: app.entity(Invitation) }),
  };
}

async function register(origin, username) {
  const res = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password123' }),
  });
  assert.equal(res.status, 201, `register ${username}`);
  const { user } = await res.json();
  const cookie = res.headers.get('set-cookie').split(/,(?=[^ ;]+)/)[0].match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))[1];
  return { user, cookie: `${SESSION_COOKIE}=${cookie}` };
}

async function createKey(origin, cookie, payload) {
  const res = await fetch(`${origin}/auth/api-key/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

function asUser(user) {
  return principal({ type: 'user', id: user.id });
}

test('one admin-authority gate: scoped API keys and invitation creation agree on 403/404 and admin', async (t) => {
  const { app, origin, invitations } = await boot(t);
  const owner = await register(origin, 'w8-owner');
  const member = await register(origin, 'w8-member');

  app.db.prepare(`INSERT INTO ${targetEntityName} (id, title, owner) VALUES (?, ?, ?)`)
    .run('p1', 'Shared target', owner.user.id);
  // The member can SEE the row but holds no admin capability on it. This is the
  // exact split the shared row-admin evaluation decides for both callers.
  app.db.prepare(`INSERT INTO ${targetEntityName}_members (${targetEntityName}_id, member_id, role) VALUES (?, ?, ?)`)
    .run('p1', member.user.id, 'member');

  // Fail-closed (403): a visible-but-non-admin row cannot mint a scoped key.
  const deniedKey = await createKey(origin, member.cookie, {
    name: 'w8-member-key', entityName: targetEntityName, role: 'member',
  });
  assert.equal(deniedKey.status, 403);

  // Fail-closed (denied): the SAME principal on the SAME row cannot create an
  // invitation. The kernel surfaces the shared verdict as a denied failure.
  await assert.rejects(
    invitations.createInvitation({
      targetEntity: targetEntityName, targetId: 'p1', role: 'member', principal: asUser(member.user),
    }),
    (error) => error?.failure?.category === 'denied',
  );

  // Fail-closed (403 for keys / 404 for invitations): no visible row at all.
  const stranger = await register(origin, 'w8-stranger');
  const invisibleKey = await createKey(origin, stranger.cookie, {
    name: 'w8-invisible-key', entityName: targetEntityName, role: 'member',
  });
  assert.equal(invisibleKey.status, 403);
  await assert.rejects(
    invitations.createInvitation({
      targetEntity: targetEntityName, targetId: 'missing', role: 'member', principal: asUser(owner.user),
    }),
    (error) => error?.failure?.category === 'not-found',
  );

  // Allowed admin: the owner passes both gates on the same target row.
  const allowedKey = await createKey(origin, owner.cookie, {
    name: 'w8-owner-key', entityName: targetEntityName, role: 'member',
  });
  assert.equal(allowedKey.status, 201, 'row admin may mint a scoped key');
  assert.ok(allowedKey.body.token);
  const storedHash = app.db.prepare('SELECT tokenHash FROM ApiKey WHERE name = ?').get('w8-owner-key').tokenHash;
  assert.equal(storedHash, sha256hex(allowedKey.body.token));

  const invitation = await invitations.createInvitation({
    targetEntity: targetEntityName, targetId: 'p1', role: 'member', principal: asUser(owner.user),
  });
  assert.equal(invitation.targetEntity, targetEntityName);
  assert.equal(invitation.targetId, 'p1');

  // The declared-role allowlist still rejects a bogus role from an admin.
  const bogusRole = await createKey(origin, owner.cookie, {
    name: 'w8-bogus-role', entityName: targetEntityName, role: 'superadmin',
  });
  assert.equal(bogusRole.status, 400);

  assert.equal(app.db.prepare('SELECT count(*) AS n FROM Invitation').get().n, 1);

  // routes.ts imports the shared timestamp parser for /sessions. A corrupt ISO
  // creation time on a second session must be filtered out by that same parser,
  // while the caller's own valid session still lists normally.
  const listed = await register(origin, 'w8-listed');
  app.db.prepare(
    "INSERT INTO Session (id, token, principalType, principalId, createdAt) VALUES (?, ?, 'user', ?, ?)",
  ).run('w8-corrupt-session', 'w8-corrupt-token', listed.user.id, '2021-02-30T00:00:00.000Z');
  const sessions = await fetch(`${origin}/auth/sessions`, { headers: { cookie: listed.cookie } });
  assert.equal(sessions.status, 200);
  const active = await sessions.json();
  assert.equal(active.length, 1);
  assert.equal(active[0].createdAt !== '2021-02-30T00:00:00.000Z', true);
});

test('shared auth helpers are identical across their consumer modules', () => {
  // sha256hex: one export backs session token hashing, API key row hashing,
  // and TOTP backup-code hashing.
  const input = 'wave-8-cleanup';
  const expected = createHash('sha256').update(input).digest('hex');
  assert.equal(sha256hex(input), expected);
  assert.equal(hashSessionToken(input), expected);
  const { plainCodes, hashedCodes } = generateBackupCodes(2);
  assert.deepEqual(hashedCodes, plainCodes.map((code) => sha256hex(code)));
  assert.ok(verifyBackupCode([...hashedCodes], plainCodes[0]));

  // Challenge generation: the login ceremony delegates to the passkey generator.
  for (const [challenge, bytes] of [[generateChallenge(), 32], [generateLoginChallenge(), 32],
    [generateChallenge(16), 16], [generateLoginChallenge(16), 16]]) {
    assert.equal(Buffer.from(challenge, 'base64url').length, bytes);
    assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  }

  // Timestamp parsing: the parser imported by routes.ts is the one session.ts
  // uses to admit principals, across every stored representation.
  const now = Date.now();
  const iso = new Date(now).toISOString();
  for (const value of [now, new Date(now), String(now), iso]) {
    assert.equal(sessionCreatedAtMs(value), now, `accepted ${JSON.stringify(value)}`);
  }
  assert.equal(sessionCreatedAtMs('1.5'), 1.5);
  for (const bad of [null, undefined, {}, [], NaN, Infinity, -Infinity, 'not-a-date',
    '2021-02-30T00:00:00.000Z', '', '1e3', true]) {
    assert.equal(sessionCreatedAtMs(bad), null, `rejected ${JSON.stringify(bad)}`);
  }

  // Public surface untouched by the cleanup.
  assert.equal(ROUTES_SESSION_COOKIE, SESSION_COOKIE);
  assert.equal(SESSION_COOKIE, 'sid');
});

test('entities.ts API key hashing uses the shared sha256hex helper', async () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [ApiKey] });
  await app.prepareSchema();
  const key = app.entity(ApiKey).create({ name: 'w8-shared-hash', createdBy: 'u1' });
  const row = db.prepare('SELECT tokenHash FROM ApiKey WHERE id = ?').get(key.id);
  assert.equal(row.tokenHash, sha256hex(key.plainToken));
  db.close();
});
