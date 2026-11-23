// auth-coat-hardening.test.mjs — comprehensive verification of GitHub issue #290:
//   - Indexed SQL email login + async crypto.scrypt + prefix-gated tryBetterAuthHash
//   - Hashed Session.token at rest, duplicate sid cookie rejection (#218), Max-Age,
//     session revocation on password change / TOTP disable, GET/DELETE /auth/sessions
//   - Complete RFC 8949 CBOR decoder (major types 0-7, arrays/x5c, booleans, floats,
//     indefinite lengths, tags, null-prototype maps), ES256 + RS256 + EdDSA passkeys,
//     credential-ID uniqueness (#245), UV enforcement + lockout on passkey login,
//     bounded + SQLite-persistent passkey/login challenge stores
//   - Constant-time TOTP + 90s replay guard + configurable issuer + default
//     minimumPasswordLength = 8 + #247 invitation createdAt fix + password-reset flow

import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench from '../build/app.mjs';
import { entity, text, map, ref, membership, read } from '../build/index.mjs';
import { User, Session, Credential, Invitation, ApiKey, TwoFactor } from '../build/auth/entities.mjs';
import { authRoutes } from '../build/auth/routes.mjs';
import {
  sessionCookie,
  sessionTokenOf,
  sessionPrincipalOf,
  hashSessionToken,
  SESSION_COOKIE,
} from '../build/auth/session.mjs';
import {
  decodeCbor,
  generateChallenge,
  createChallengeStore,
  buildClientDataJSON,
  buildAuthenticatorData,
  buildRpIdHash,
  signAssertion,
  cosePublicKeyFromKeyPair,
  buildAttestationObject,
  verifyRegistration,
  verifyAuthentication,
  rpConfig,
} from '../build/auth/passkey.mjs';
import {
  generateSecret,
  hotp,
  verifyTotpStep,
  verifyBackupCode,
  generateBackupCodes,
} from '../build/auth/totp.mjs';
import { createLoginChallengeStore } from '../build/auth/login-challenge.mjs';
import {
  STRATEGIES,
  hashPasswordAsync,
  verifyHash,
  verifyHashAsync,
} from '../build/field-strategy.mjs';

// ---- helpers -----------------------------------------------------------------

function sidFromSetCookie(header) {
  if (!header) return null;
  const first = header.split(/,(?=[^ ;]+)/)[0];
  const match = first.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

async function bootApp(t, authOpts = {}) {
  const app = workbench({ db: ':memory:' }).auth();
  let authBasePath = '/auth';
  if (Object.keys(authOpts).length > 0) {
    const authEntities = Object.fromEntries(
      [User, Session, Credential, Invitation, ApiKey, TwoFactor]
        .map((decl) => [decl.name, app.entity(decl)]),
    );
    authBasePath = '/auth2';
    app.mount(authBasePath, authRoutes({
      entities: authEntities,
      db: app.db,
      ...authOpts,
    }));
  }
  app.listen(0);
  await app.ready;
  const { port } = app.httpServer.address();
  t.after(() => app.httpServer.close());
  const host = `http://127.0.0.1:${port}`;
  return { app, origin: host, authUrl: `${host}${authBasePath}` };
}

async function registerUser(authUrl, username, password) {
  const res = await fetch(`${authUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return res;
}

async function loginUser(authUrl, username, password) {
  return fetch(`${authUrl}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

function buildRegistrationPayload(keypair, challenge, rp, { credentialId, attStmt = {}, fmt = 'none' } = {}) {
  const cid = credentialId ?? generateChallenge(32);
  const clientDataJSON = buildClientDataJSON({
    challenge,
    origin: rp.origin,
    type: 'webauthn.create',
  });
  const authData = buildAuthenticatorData({
    rpIdHash: buildRpIdHash(rp.id),
    flags: 0x45, // UP + UV + AT
    signCount: 0,
    credentialId: cid,
    publicKey: cosePublicKeyFromKeyPair(keypair),
  });
  const attestationObject = buildAttestationObject({ fmt, attStmt, authData });
  return {
    credentialId: cid,
    credential: {
      id: cid,
      rawId: cid,
      response: { clientDataJSON, attestationObject },
      type: 'public-key',
      name: 'Hardening Key',
    },
  };
}

function buildAssertionPayload(keypair, credentialId, challenge, rp, { flags = 0x05, signCount = 1 } = {}) {
  const clientDataJSON = buildClientDataJSON({
    challenge,
    origin: rp.origin,
    type: 'webauthn.get',
  });
  const authData = buildAuthenticatorData({
    rpIdHash: buildRpIdHash(rp.id),
    flags,
    signCount,
  });
  const signature = signAssertion(keypair.privateKey, authData, clientDataJSON);
  return {
    id: credentialId,
    rawId: credentialId,
    response: {
      clientDataJSON,
      authenticatorData: authData.toString('base64url'),
      signature,
      userHandle: null,
    },
    type: 'public-key',
  };
}

// ==============================================================================
// 1. Indexed SQL email login + async scrypt + prefix-gated tryBetterAuthHash
// ==============================================================================

test('indexed SQL email login uses idx_User_email_lower and trims/folds case', async (t) => {
  const { app, authUrl } = await bootApp(t, { identifyBy: ['email', 'username'] });

  const reg = await registerUser(authUrl, '  Alice.Smith@Example.COM  ', 'securepass123');
  assert.equal(reg.status, 201);

  // Verify indexes exist and query planner uses the expression index.
  const plan = app.db
    .prepare('EXPLAIN QUERY PLAN SELECT * FROM User WHERE lower(trim(email)) = ? LIMIT 2')
    .all('alice.smith@example.com');
  const planText = plan.map((r) => String(r.detail ?? '')).join(' ');
  assert.match(planText, /idx_User_email_lower/, `expected expression index in plan: ${planText}`);

  const login = await loginUser(authUrl, 'alice.smith@example.com', 'securepass123');
  assert.equal(login.status, 201);
  assert.ok(sidFromSetCookie(login.headers.get('set-cookie')));

  const indexes = app.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((r) => r.name);
  assert.ok(indexes.includes('idx_User_email_lower'));
  assert.ok(indexes.includes('idx_User_username'));
  assert.ok(indexes.includes('idx_Session_token'));
  assert.ok(indexes.includes('idx_Session_principal'));
  assert.ok(indexes.includes('idx_Credential_credentialId'));
});

test('async scrypt produces scrypt: prefix and prefix-gates tryBetterAuthHash', async () => {
  const hashed = await hashPasswordAsync('my-secret-password');
  assert.ok(hashed.startsWith('scrypt:'), 'hashPasswordAsync writes scrypt: prefix');
  assert.equal(await verifyHashAsync('my-secret-password', hashed), true);
  assert.equal(await verifyHashAsync('wrong-password', hashed), false);
  assert.equal(verifyHash('my-secret-password', hashed), true);
  assert.equal(verifyHash('wrong-password', hashed), false);

  // Sync strategy serialize also writes the scrypt: prefix.
  const syncHashed = STRATEGIES.hash.serialize('another-password');
  assert.ok(syncHashed.startsWith('scrypt:'));
  assert.equal(await verifyHashAsync('another-password', syncHashed), true);

  // Legacy unprefixed better-auth hash (r=16, NFKC, string salt) still verifies.
  const legacySalt = crypto.randomBytes(16).toString('hex');
  const legacyKey = crypto.scryptSync('caf\u00e91234'.normalize('NFKC'), legacySalt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  });
  const legacyStored = `${legacySalt}:${legacyKey.toString('hex')}`;
  assert.equal(verifyHash('cafe\u03011234', legacyStored), true, 'sync verify accepts legacy better-auth hash');
  assert.equal(await verifyHashAsync('cafe\u03011234', legacyStored), true, 'async verify accepts legacy better-auth hash');

  // Prefix-gating: a `scrypt:`-prefixed better-auth digest MUST NOT fall through to better-auth scrypt.
  const prefixedLegacy = `scrypt:${legacyStored}`;
  assert.equal(verifyHash('cafe\u03011234', prefixedLegacy), false, 'scrypt: prefix blocks better-auth fallback (sync)');
  assert.equal(await verifyHashAsync('cafe\u03011234', prefixedLegacy), false, 'scrypt: prefix blocks better-auth fallback (async)');
});

// ==============================================================================
// 2. Hashed Session.token, duplicate sid (#218), Max-Age, revocation, /sessions
// ==============================================================================

test('Session.token is SHA-256 hashed at rest and raw DB hash cannot replay as cookie', async (t) => {
  const { app, authUrl } = await bootApp(t);
  const reg = await registerUser(authUrl, 'hashuser', 'password1234');
  assert.equal(reg.status, 201);
  const plainToken = sidFromSetCookie(reg.headers.get('set-cookie'));
  assert.ok(plainToken);

  const row = app.db.prepare('SELECT token FROM Session LIMIT 1').get();
  assert.equal(row.token, hashSessionToken(plainToken));
  assert.notEqual(row.token, plainToken);
  assert.match(row.token, /^[0-9a-f]{64}$/);

  // Replaying the stolen SHA-256 digest from DB as a sid cookie must fail closed.
  const principalOf = sessionPrincipalOf(app.db);
  assert.equal(principalOf({ headers: { cookie: `sid=${row.token}` } }).type, 'anonymous');
  assert.equal(principalOf({ headers: { cookie: `sid=${plainToken}` } }).type, 'user');
  const stolenRes = await fetch(`${authUrl}/me`, {
    headers: { cookie: `sid=${row.token}` },
  });
  assert.equal(stolenRes.status, 401);

  // Plain token still authenticates cleanly.
  const validRes = await fetch(`${authUrl}/me`, {
    headers: { cookie: `sid=${plainToken}` },
  });
  assert.equal(validRes.status, 200);
});

test('duplicate sid cookies are rejected fail-closed (#218)', async (t) => {
  assert.equal(sessionTokenOf({ headers: { cookie: 'sid=one; sid=two' } }), undefined);
  assert.equal(sessionTokenOf({ headers: { cookie: 'sid=same; sid=same' } }), undefined);
  assert.equal(sessionTokenOf({ headers: { cookie: 'foo=1; sid=a; bar=2; sid=b' } }), undefined);
  assert.equal(sessionTokenOf({ headers: { cookie: 'sid=; sid=valid' } }), undefined);
  assert.equal(sessionTokenOf({ headers: { cookie: 'other=1; sid=only-one' } }), 'only-one');

  const { authUrl } = await bootApp(t);
  const reg = await registerUser(authUrl, 'dupcookie', 'password1234');
  const sid = sidFromSetCookie(reg.headers.get('set-cookie'));

  // Valid single cookie succeeds; duplicated sid fails closed with 401.
  const ok = await fetch(`${authUrl}/me`, { headers: { cookie: `sid=${sid}` } });
  assert.equal(ok.status, 200);

  const dup = await fetch(`${authUrl}/me`, { headers: { cookie: `sid=${sid}; sid=shadow` } });
  assert.equal(dup.status, 401);

  const dupSame = await fetch(`${authUrl}/me`, { headers: { cookie: `sid=${sid}; sid=${sid}` } });
  assert.equal(dupSame.status, 401);
});

test('sessionCookie supports Max-Age and auth routes emit Max-Age on session cookies', async (t) => {
  assert.match(sessionCookie('tok', { secure: false, env: 'development', maxAge: 3600 }), /Max-Age=3600/);
  assert.match(sessionCookie('tok', { secure: true, ttlMs: 120_000 }), /Max-Age=120/);
  assert.match(sessionCookie('tok', { secure: false, env: 'development', maxAge: 0 }), /Max-Age=0/);

  const { authUrl } = await bootApp(t, { sessionDurationMs: 3_600_000 });
  const reg = await registerUser(authUrl, 'maxageuser', 'password1234');
  assert.equal(reg.status, 201);
  assert.match(reg.headers.get('set-cookie'), /Max-Age=3600/);
});

test('GET /auth/sessions and DELETE /auth/sessions/:id manage user sessions safely', async (t) => {
  const { authUrl } = await bootApp(t);
  const regA = await registerUser(authUrl, 'alice', 'password1234');
  const sidA1 = sidFromSetCookie(regA.headers.get('set-cookie'));
  const loginA2 = await loginUser(authUrl, 'alice', 'password1234');
  const sidA2 = sidFromSetCookie(loginA2.headers.get('set-cookie'));

  const regB = await registerUser(authUrl, 'bob', 'password1234');
  const sidB = sidFromSetCookie(regB.headers.get('set-cookie'));

  // Anonymous cannot list sessions.
  const anonList = await fetch(`${authUrl}/sessions`);
  assert.equal(anonList.status, 401);

  // Alice sees both of her active sessions, with current marked, and no token/hash leaked.
  const listRes = await fetch(`${authUrl}/sessions`, { headers: { cookie: `sid=${sidA1}` } });
  assert.equal(listRes.status, 200);
  const sessions = await listRes.json();
  assert.equal(sessions.length, 2);
  const current = sessions.find((s) => s.current === true);
  const other = sessions.find((s) => s.current === false);
  assert.ok(current && other);
  for (const s of sessions) {
    assert.deepEqual(Object.keys(s).sort(), ['createdAt', 'current', 'id']);
  }

  // Bob cannot revoke Alice's session (403).
  const bobRevoke = await fetch(`${authUrl}/sessions/${other.id}`, {
    method: 'DELETE',
    headers: { cookie: `sid=${sidB}` },
  });
  assert.equal(bobRevoke.status, 403);

  // Unknown session returns 404.
  const notFound = await fetch(`${authUrl}/sessions/nonexistent-id`, {
    method: 'DELETE',
    headers: { cookie: `sid=${sidA1}` },
  });
  assert.equal(notFound.status, 404);

  // Alice revokes her other session -> sidA2 becomes invalid, sidA1 stays valid.
  const revokeOther = await fetch(`${authUrl}/sessions/${other.id}`, {
    method: 'DELETE',
    headers: { cookie: `sid=${sidA1}` },
  });
  assert.equal(revokeOther.status, 204);
  assert.equal((await fetch(`${authUrl}/me`, { headers: { cookie: `sid=${sidA2}` } })).status, 401);
  assert.equal((await fetch(`${authUrl}/me`, { headers: { cookie: `sid=${sidA1}` } })).status, 200);

  // Alice revokes her current session -> clears cookie with Max-Age=0 and invalidates sidA1.
  const revokeCurrent = await fetch(`${authUrl}/sessions/${current.id}`, {
    method: 'DELETE',
    headers: { cookie: `sid=${sidA1}` },
  });
  assert.equal(revokeCurrent.status, 204);
  assert.match(revokeCurrent.headers.get('set-cookie') ?? '', /Max-Age=0/);
  assert.equal((await fetch(`${authUrl}/me`, { headers: { cookie: `sid=${sidA1}` } })).status, 401);
});

test('change-password and TOTP disable revoke other sessions while keeping current session', async (t) => {
  const { authUrl } = await bootApp(t);
  const reg = await registerUser(authUrl, 'revoker', 'oldpass123');
  const sid1 = sidFromSetCookie(reg.headers.get('set-cookie'));
  const login2 = await loginUser(authUrl, 'revoker', 'oldpass123');
  const sid2 = sidFromSetCookie(login2.headers.get('set-cookie'));

  // Change password from sid1 -> sid2 is revoked, sid1 stays valid.
  const chg = await fetch(`${authUrl}/change-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `sid=${sid1}` },
    body: JSON.stringify({ currentPassword: 'oldpass123', newPassword: 'newpass123' }),
  });
  assert.equal(chg.status, 204);
  assert.equal((await fetch(`${authUrl}/me`, { headers: { cookie: `sid=${sid1}` } })).status, 200);
  assert.equal((await fetch(`${authUrl}/me`, { headers: { cookie: `sid=${sid2}` } })).status, 401);

  // Mint another session sid3, enroll TOTP, then disable TOTP from sid1 -> sid3 revoked.
  const login3 = await loginUser(authUrl, 'revoker', 'newpass123');
  const sid3 = sidFromSetCookie(login3.headers.get('set-cookie'));
  const enroll = await fetch(`${authUrl}/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `sid=${sid1}` },
  });
  const { secret } = await enroll.json();
  const counter = Math.floor(Date.now() / 1000 / 30);
  await fetch(`${authUrl}/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `sid=${sid1}` },
    body: JSON.stringify({ token: hotp(secret, counter - 1) }),
  });

  const dis = await fetch(`${authUrl}/totp/disable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `sid=${sid1}` },
    body: JSON.stringify({ token: hotp(secret, counter) }),
  });
  assert.equal(dis.status, 204);
  assert.equal((await fetch(`${authUrl}/me`, { headers: { cookie: `sid=${sid1}` } })).status, 200);
  assert.equal((await fetch(`${authUrl}/me`, { headers: { cookie: `sid=${sid3}` } })).status, 401);
});

// ==============================================================================
// 3. Complete RFC 8949 CBOR, ES256/RS256/EdDSA passkeys, #245, UV, lockout, stores
// ==============================================================================

test('decodeCbor supports all RFC 8949 major types 0-7 including arrays/x5c, booleans, floats, tags, and indefinite lengths', () => {
  // Major 0 (unsigned) & Major 1 (negative)
  assert.equal(decodeCbor(Buffer.from([0x17])).value, 23);
  assert.equal(decodeCbor(Buffer.from([0x18, 0xff])).value, 255);
  assert.equal(decodeCbor(Buffer.from([0x19, 0x01, 0x00])).value, 256);
  assert.equal(decodeCbor(Buffer.from([0x1a, 0x00, 0x01, 0x00, 0x00])).value, 65536);
  assert.equal(decodeCbor(Buffer.from([0x38, 0x63])).value, -100);

  // Major 2 (indefinite byte string) & Major 3 (indefinite text string)
  const indefBytes = Buffer.from([0x5f, 0x42, 0x01, 0x02, 0x42, 0x03, 0x04, 0xff]);
  assert.deepEqual(decodeCbor(indefBytes).value, Buffer.from([1, 2, 3, 4]));
  const indefText = Buffer.from([0x7f, 0x62, 0x68, 0x69, 0x61, 0x21, 0xff]);
  assert.equal(decodeCbor(indefText).value, 'hi!');

  // Major 4 (definite + indefinite arrays)
  const indefArr = Buffer.from([0x9f, 0x01, 0xf5, 0xf4, 0xf6, 0xff]);
  assert.deepEqual(decodeCbor(indefArr).value, [1, true, false, null]);

  // Major 5 (map with null prototype blocking __proto__)
  const mapBuf = Buffer.from([0xa1, 0x69, ...Buffer.from('__proto__'), 0x01]);
  const decodedMap = decodeCbor(mapBuf).value;
  assert.equal(Object.getPrototypeOf(decodedMap), null);
  assert.equal(decodedMap.__proto__, 1);

  // Major 6 (semantic tag)
  const tagged = Buffer.from([0xc1, 0x1a, 0x51, 0x4b, 0x67, 0xb0]);
  assert.deepEqual(decodeCbor(tagged).value, { tag: 1, value: 1363896240 });

  // Major 7 (simple values + float16/float32/float64)
  assert.equal(decodeCbor(Buffer.from([0xf4])).value, false);
  assert.equal(decodeCbor(Buffer.from([0xf5])).value, true);
  assert.equal(decodeCbor(Buffer.from([0xf6])).value, null);
  assert.equal(decodeCbor(Buffer.from([0xf7])).value, undefined);
  assert.equal(decodeCbor(Buffer.from([0xf9, 0x3e, 0x00])).value, 1.5); // float16 1.5
  const f32 = Buffer.alloc(5);
  f32[0] = 0xfa;
  f32.writeFloatBE(3.5, 1);
  assert.equal(decodeCbor(f32).value, 3.5);
  const f64 = Buffer.alloc(9);
  f64[0] = 0xfb;
  f64.writeDoubleBE(Math.PI, 1);
  assert.equal(decodeCbor(f64).value, Math.PI);

  // Truncated input throws.
  assert.throws(() => decodeCbor(Buffer.from([0x44, 0x01, 0x02])), /truncated/);

  // Registration attestation with packed attStmt containing x5c byte-string array + booleans.
  const keypair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rp = rpConfig({});
  const challenge = generateChallenge();
  const payload = buildRegistrationPayload(keypair, challenge, rp, {
    fmt: 'packed',
    attStmt: {
      alg: -7,
      sig: Buffer.from([1, 2, 3, 4]),
      x5c: [Buffer.from('cert-leaf'), Buffer.from('cert-intermediate')],
      trusted: true,
    },
  });
  const regResult = verifyRegistration(challenge, payload.credential, rp);
  assert.equal(regResult.credentialId, payload.credentialId);
});

test('passkeys support ES256, RS256, and EdDSA end-to-end over HTTP', async (t) => {
  const { authUrl } = await bootApp(t);
  const rp = rpConfig({});

  const algorithms = [
    { label: 'ES256', keypair: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }) },
    { label: 'RS256', keypair: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }) },
    { label: 'EdDSA', keypair: crypto.generateKeyPairSync('ed25519') },
  ];

  for (const { label, keypair } of algorithms) {
    const username = `user-${label.toLowerCase()}`;
    const regUserRes = await registerUser(authUrl, username, 'password1234');
    assert.equal(regUserRes.status, 201);
    const cookie = `sid=${sidFromSetCookie(regUserRes.headers.get('set-cookie'))}`;

    // Register passkey
    const { challenge: regChallenge } = await (await fetch(`${authUrl}/passkey/challenge`)).json();
    const { credentialId, credential } = buildRegistrationPayload(keypair, regChallenge, rp);
    const regRes = await fetch(`${authUrl}/passkey/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ credential }),
    });
    assert.equal(regRes.status, 201, `${label} passkey registration failed`);

    // Authenticate passkey
    const { challenge: authChallenge } = await (await fetch(`${authUrl}/passkey/challenge`)).json();
    const assertion = buildAssertionPayload(keypair, credentialId, authChallenge, rp, { flags: 0x05, signCount: 1 });
    const authRes = await fetch(`${authUrl}/passkey/authenticate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: assertion }),
    });
    const authBody = await authRes.json();
    assert.equal(authRes.status, 201, `${label} passkey authentication failed: ${JSON.stringify(authBody)}`);
    assert.equal(authBody.user.username, username);
    assert.ok(sidFromSetCookie(authRes.headers.get('set-cookie')));
  }
});

test('passkey registration rejects duplicate credentialId across users (#245)', async (t) => {
  const { authUrl } = await bootApp(t);
  const rp = rpConfig({});
  const keypair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const sharedCredId = generateChallenge(32);

  const aliceRes = await registerUser(authUrl, 'alice', 'password1234');
  const aliceCookie = `sid=${sidFromSetCookie(aliceRes.headers.get('set-cookie'))}`;
  const bobRes = await registerUser(authUrl, 'bob', 'password1234');
  const bobCookie = `sid=${sidFromSetCookie(bobRes.headers.get('set-cookie'))}`;

  const ch1 = (await (await fetch(`${authUrl}/passkey/challenge`)).json()).challenge;
  const p1 = buildRegistrationPayload(keypair, ch1, rp, { credentialId: sharedCredId });
  const r1 = await fetch(`${authUrl}/passkey/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: aliceCookie },
    body: JSON.stringify({ credential: p1.credential }),
  });
  assert.equal(r1.status, 201);

  // Bob attempts to hijack/re-register the same credentialId -> 409.
  const ch2 = (await (await fetch(`${authUrl}/passkey/challenge`)).json()).challenge;
  const p2 = buildRegistrationPayload(keypair, ch2, rp, { credentialId: sharedCredId });
  const r2 = await fetch(`${authUrl}/passkey/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: bobCookie },
    body: JSON.stringify({ credential: p2.credential }),
  });
  assert.equal(r2.status, 409);
});

test('passkey login enforces UV by default and applies login lockout on failures', async (t) => {
  const { app, authUrl } = await bootApp(t);
  const rp = rpConfig({});
  const keypair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

  const regUserRes = await registerUser(authUrl, 'uvuser', 'password1234');
  const cookie = `sid=${sidFromSetCookie(regUserRes.headers.get('set-cookie'))}`;

  const regCh = (await (await fetch(`${authUrl}/passkey/challenge`)).json()).challenge;
  const { credentialId, credential } = buildRegistrationPayload(keypair, regCh, rp);
  assert.equal((await fetch(`${authUrl}/passkey/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ credential }),
  })).status, 201);

  // Missing UV bit (0x01) is rejected with 401 and increments lockout counter.
  const chNoUv = (await (await fetch(`${authUrl}/passkey/challenge`)).json()).challenge;
  const noUvAssertion = buildAssertionPayload(keypair, credentialId, chNoUv, rp, { flags: 0x01, signCount: 1 });
  const noUvRes = await fetch(`${authUrl}/passkey/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: noUvAssertion }),
  });
  assert.equal(noUvRes.status, 401);

  // Unit-level opt-out works when explicitly configured.
  const spki = keypair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  assert.equal(
    verifyAuthentication(chNoUv, noUvAssertion, { credentialId, publicKey: spki, signCount: 0 }, rp, {
      requireUserVerification: false,
    }).signCount,
    1,
  );

  // Two more bad attempts (total 3) arm the login lockout on the user.
  const otherKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  for (let i = 0; i < 2; i++) {
    const ch = (await (await fetch(`${authUrl}/passkey/challenge`)).json()).challenge;
    const bad = buildAssertionPayload(otherKey, credentialId, ch, rp, { flags: 0x05, signCount: i + 2 });
    const badRes = await fetch(`${authUrl}/passkey/authenticate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: bad }),
    });
    assert.equal(badRes.status, 401);
  }

  // While locked, even a VALID passkey assertion with UV is rejected with 401.
  const chLocked = (await (await fetch(`${authUrl}/passkey/challenge`)).json()).challenge;
  const validWhileLocked = buildAssertionPayload(keypair, credentialId, chLocked, rp, { flags: 0x05, signCount: 10 });
  const lockedRes = await fetch(`${authUrl}/passkey/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: validWhileLocked }),
  });
  assert.equal(lockedRes.status, 401);
  assert.equal(lockedRes.headers.get('set-cookie'), null);

  // Expire lockout -> valid passkey login succeeds and resets counters.
  app.db.prepare('UPDATE User SET lockedUntil = ? WHERE username = ?').run(Date.now() - 1000, 'uvuser');
  const chOk = (await (await fetch(`${authUrl}/passkey/challenge`)).json()).challenge;
  const validAfter = buildAssertionPayload(keypair, credentialId, chOk, rp, { flags: 0x05, signCount: 11 });
  const okRes = await fetch(`${authUrl}/passkey/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: validAfter }),
  });
  assert.equal(okRes.status, 201);
  const row = app.db.prepare('SELECT failedLoginAttempts, lockedUntil FROM User WHERE username = ?').get('uvuser');
  assert.equal(row.failedLoginAttempts, 0);
  assert.equal(row.lockedUntil, null);
});

test('passkey and login challenge stores are bounded and support SQLite persistence across restarts', () => {
  let clock = 1_000_000;

  // Bounded in-memory passkey store
  const memPasskey = createChallengeStore({ ttlMs: 1000, maxSize: 2, now: () => clock });
  memPasskey.set('c1', { n: 1 });
  memPasskey.set('c2', { n: 2 });
  memPasskey.set('c3', { n: 3 });
  assert.equal(memPasskey.size(), 2);
  assert.equal(memPasskey.get('c1'), null, 'oldest evicted');
  assert.equal(memPasskey.get('c3')?.n, 3);
  memPasskey.destroy();

  // Persistent SQLite passkey store survives restart (new store instance on same db)
  const db = new DatabaseSync(':memory:');
  const sqlPasskey1 = createChallengeStore({ db, ttlMs: 5000, maxSize: 2, now: () => clock });
  sqlPasskey1.set('p1', { step: 1 });
  clock += 10;
  sqlPasskey1.set('p2', { step: 2 });
  clock += 10;
  sqlPasskey1.set('p3', { step: 3 });
  assert.equal(sqlPasskey1.size(), 2);
  sqlPasskey1.destroy();

  const sqlPasskey2 = createChallengeStore({ db, ttlMs: 5000, maxSize: 2, now: () => clock });
  assert.equal(sqlPasskey2.get('p1'), null, 'oldest evicted in SQLite');
  assert.equal(sqlPasskey2.consume('p2')?.step, 2);
  assert.equal(sqlPasskey2.consume('p2'), null, 'consume is single-use');
  sqlPasskey2.destroy();

  // Bounded in-memory login challenge store
  const memLogin = createLoginChallengeStore(1000, 3, () => clock, { maxSize: 2 });
  const l1 = memLogin.set('u1');
  const l2 = memLogin.set('u2');
  const l3 = memLogin.set('u3');
  assert.equal(memLogin.size(), 2);
  assert.equal(memLogin.get(l1), null);
  assert.equal(memLogin.get(l2)?.userId, 'u2');
  assert.equal(memLogin.get(l3)?.userId, 'u3');
  memLogin.destroy();

  // Persistent SQLite login challenge store survives restart
  const sqlLogin1 = createLoginChallengeStore(5000, 2, () => clock, { db, maxSize: 2 });
  const sl1 = sqlLogin1.set('user-a');
  clock += 10;
  const sl2 = sqlLogin1.set('user-b');
  clock += 10;
  const sl3 = sqlLogin1.set('user-c');
  assert.equal(sqlLogin1.size(), 2);
  sqlLogin1.destroy();

  const sqlLogin2 = createLoginChallengeStore(5000, 2, () => clock, { db, maxSize: 2 });
  assert.equal(sqlLogin2.get(sl1), null);
  const claim = sqlLogin2.reserve(sl2);
  assert.equal(claim?.userId, 'user-b');
  assert.equal(sqlLogin2.reserve(sl2), null, 'exclusive reservation in SQLite');
  assert.equal(sqlLogin2.fail(claim), true); // attempt 1 of 2
  const claim2 = sqlLogin2.reserve(sl2);
  assert.equal(sqlLogin2.fail(claim2), false); // attempt 2 -> destroyed
  assert.equal(sqlLogin2.get(sl2), null);
  const claim3 = sqlLogin2.reserve(sl3);
  assert.equal(sqlLogin2.finalize(claim3), true);
  assert.equal(sqlLogin2.get(sl3), null);
  sqlLogin2.destroy();
  db.close();
});

// ==============================================================================
// 4. TOTP replay guard, configurable issuer, default min pw=8, #247, password reset
// ==============================================================================

test('TOTP enforces 90s replay guard across verify/authenticate and supports configurable issuer', async (t) => {
  // Configurable issuer in generateSecret
  const custom1 = generateSecret('alice', 'Acme Corp');
  assert.match(custom1.uri, /^otpauth:\/\/totp\/Acme%20Corp:alice\?.*&issuer=Acme%20Corp/);
  const custom2 = generateSecret('alice', { issuer: 'Scope Studio' });
  assert.match(custom2.uri, /^otpauth:\/\/totp\/Scope%20Studio:alice\?.*&issuer=Scope%20Studio/);

  // verifyTotpStep returns matched counter; verifyBackupCode works in constant time
  const now = Date.now();
  const step = Math.floor(now / 1000 / 30);
  assert.deepEqual(verifyTotpStep(custom1.secret, hotp(custom1.secret, step - 1), now), { valid: true, counter: step - 1 });
  assert.deepEqual(verifyTotpStep(custom1.secret, hotp(custom1.secret, step + 1), now), { valid: true, counter: step + 1 });
  assert.deepEqual(verifyTotpStep(custom1.secret, 'not-digits', now), { valid: false, counter: null });

  const { plainCodes, hashedCodes } = generateBackupCodes(3);
  assert.equal(verifyBackupCode(hashedCodes, plainCodes[1]), true);
  assert.equal(verifyBackupCode(hashedCodes, plainCodes[1]), false);

  // HTTP: configurable issuer + replay rejection
  const { authUrl } = await bootApp(t, { totpIssuer: 'Acme Auth' });
  const reg = await registerUser(authUrl, 'totpuser', 'password1234');
  assert.equal(reg.status, 201);
  const cookie = `sid=${sidFromSetCookie(reg.headers.get('set-cookie'))}`;

  const enrollRes = await fetch(`${authUrl}/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  assert.equal(enrollRes.status, 201);
  const { secret, uri } = await enrollRes.json();
  assert.match(uri, /^otpauth:\/\/totp\/Acme%20Auth:totpuser\?.*&issuer=Acme%20Auth/);

  const curStep = Math.floor(Date.now() / 1000 / 30);
  const codePrev = hotp(secret, curStep - 1);
  const codeCur = hotp(secret, curStep);
  const codeNext = hotp(secret, curStep + 1);

  // First verify with curStep - 1 succeeds.
  assert.equal((await fetch(`${authUrl}/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: codePrev }),
  })).status, 200);

  // Replaying the SAME code within 90s is rejected!
  assert.equal((await fetch(`${authUrl}/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: codePrev }),
  })).status, 400);

  // Advancing to curStep succeeds on /totp/authenticate, then replaying curStep fails.
  const login1 = await (await loginUser(authUrl, 'totpuser', 'password1234')).json();
  assert.equal(login1.requiresTotp, true);
  const auth1 = await fetch(`${authUrl}/totp/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: login1.challenge, token: codeCur }),
  });
  assert.equal(auth1.status, 201);

  const login2 = await (await loginUser(authUrl, 'totpuser', 'password1234')).json();
  const replayAuth = await fetch(`${authUrl}/totp/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: login2.challenge, token: codeCur }),
  });
  assert.equal(replayAuth.status, 400, 'replayed TOTP token must be rejected on authenticate');

  // Advancing to curStep + 1 succeeds.
  const authNext = await fetch(`${authUrl}/totp/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: login2.challenge, token: codeNext }),
  });
  assert.equal(authNext.status, 201);
});

test('default minimumPasswordLength is 8 on register, change-password, and password-reset', async (t) => {
  const { authUrl } = await bootApp(t);

  // 7 chars rejected on default .auth()
  assert.equal((await registerUser(authUrl, 'shortpw', '1234567')).status, 400);
  // 8 chars accepted
  const reg = await registerUser(authUrl, 'goodpw', '12345678');
  assert.equal(reg.status, 201);
  const cookie = `sid=${sidFromSetCookie(reg.headers.get('set-cookie'))}`;

  // 7 chars rejected on change-password
  const chg = await fetch(`${authUrl}/change-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ currentPassword: '12345678', newPassword: '1234567' }),
  });
  assert.equal(chg.status, 400);
});

test('invitation createdAt is stored as ISO string (#247) and expiresAt validates input', async (t) => {
  const Project = entity('Project', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['member'], default: {} }),
  });
  membership(Project, { member: { can: [read] } });

  const app = workbench({ db: ':memory:', entities: [Project] }).auth().mount('/projects', Project);
  app.listen(0);
  await app.ready;
  const { port } = app.httpServer.address();
  t.after(() => app.httpServer.close());
  const origin = `http://127.0.0.1:${port}`;
  const authUrl = `${origin}/auth`;

  const reg = await registerUser(authUrl, 'inviter', 'password1234');
  assert.equal(reg.status, 201);
  const cookie = `sid=${sidFromSetCookie(reg.headers.get('set-cookie'))}`;

  const projRes = await fetch(`${origin}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: 'Alpha' }),
  });
  assert.equal(projRes.status, 201);
  const proj = await projRes.json();

  const invRes = await fetch(`${authUrl}/invitation/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      targetEntity: 'Project',
      targetId: proj.id,
      role: 'member',
      expiresAt: Date.now() + 60_000,
    }),
  });
  assert.equal(invRes.status, 201);
  const inv = await invRes.json();
  assert.equal(typeof inv.createdAt, 'string', 'createdAt must be an ISO string (#247)');
  assert.equal(new Date(inv.createdAt).toISOString(), inv.createdAt);

  // Non-finite expiresAt rejected with 400.
  const badExp = await fetch(`${authUrl}/invitation/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      targetEntity: 'Project',
      targetId: proj.id,
      role: 'member',
      expiresAt: 'not-a-timestamp',
    }),
  });
  assert.equal(badExp.status, 400);
});

test('password-reset flow: non-enumerating request, hashed single-use token, lockout clear, and full session revocation', async (t) => {
  const sentEmails = [];
  const callbacks = [];

  const { app, authUrl } = await bootApp(t, {
    identifyBy: ['email', 'username'],
    emailSeam: {
      transport: async (payload) => { sentEmails.push(payload); },
    },
    sendPasswordResetEmail: async (ctx) => { callbacks.push(ctx); },
    passwordResetTtlMs: 60_000,
  });

  const reg = await registerUser(authUrl, 'reset@example.com', 'initialpass1');
  assert.equal(reg.status, 201);
  const sid1 = sidFromSetCookie(reg.headers.get('set-cookie'));
  const login2 = await loginUser(authUrl, 'reset@example.com', 'initialpass1');
  const sid2 = sidFromSetCookie(login2.headers.get('set-cookie'));

  // Arm a login lockout on the user to confirm reset clears it.
  app.db.prepare('UPDATE User SET failedLoginAttempts = 5, lockedUntil = ? WHERE lower(trim(email)) = ?')
    .run(Date.now() + 600_000, 'reset@example.com');

  // Unknown account returns identical 200 { ok: true } without sending email.
  const unknownReq = await fetch(`${authUrl}/password-reset/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.com' }),
  });
  assert.equal(unknownReq.status, 200);
  assert.deepEqual(await unknownReq.json(), { ok: true });
  assert.equal(sentEmails.length, 0);
  assert.equal(callbacks.length, 0);

  // Known account returns 200 { ok: true } and delivers a token.
  const knownReq = await fetch(`${authUrl}/password-reset/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'RESET@example.com' }),
  });
  assert.equal(knownReq.status, 200);
  assert.deepEqual(await knownReq.json(), { ok: true });
  assert.equal(sentEmails.length, 1);
  assert.equal(callbacks.length, 1);

  const plainToken = callbacks[0].token;
  assert.ok(plainToken.length >= 32);
  assert.ok(sentEmails[0].body.includes(plainToken));

  // Only SHA-256 hash is stored in _PasswordResetToken.
  const stored = app.db.prepare('SELECT tokenHash, usedAt FROM _PasswordResetToken').all();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].tokenHash, hashSessionToken(plainToken));
  assert.equal(stored[0].usedAt, null);

  // Requesting a second token invalidates the first unused token.
  await fetch(`${authUrl}/password-reset/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'reset@example.com' }),
  });
  assert.equal(callbacks.length, 2);
  const secondToken = callbacks[1].token;

  const confirmOld = await fetch(`${authUrl}/password-reset/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: plainToken, newPassword: 'brandnewpass1' }),
  });
  assert.equal(confirmOld.status, 400, 'superseded token is rejected');

  // Short password rejected by default minimumPasswordLength = 8.
  const shortConfirm = await fetch(`${authUrl}/password-reset/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: secondToken, newPassword: 'short' }),
  });
  assert.equal(shortConfirm.status, 400);

  // Confirm with valid token + valid password -> 204.
  const confirmOk = await fetch(`${authUrl}/password-reset/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: secondToken, newPassword: 'brandnewpass1' }),
  });
  assert.equal(confirmOk.status, 204);

  // Token is single-use: replaying it fails with 400.
  const replay = await fetch(`${authUrl}/password-reset/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: secondToken, newPassword: 'anotherpass1' }),
  });
  assert.equal(replay.status, 400);

  // ALL existing sessions were revoked.
  assert.equal((await fetch(`${authUrl}/me`, { headers: { cookie: `sid=${sid1}` } })).status, 401);
  assert.equal((await fetch(`${authUrl}/me`, { headers: { cookie: `sid=${sid2}` } })).status, 401);

  // Lockout cleared and new password logs in cleanly (old password fails).
  assert.equal((await loginUser(authUrl, 'reset@example.com', 'initialpass1')).status, 401);
  const newLogin = await loginUser(authUrl, 'reset@example.com', 'brandnewpass1');
  assert.equal(newLogin.status, 201);
});

test('password-reset confirm rejects expired tokens', async (t) => {
  const tokens = [];
  const { app, authUrl } = await bootApp(t, {
    sendPasswordResetEmail: async (ctx) => { tokens.push(ctx.token); },
  });

  assert.equal((await registerUser(authUrl, 'expreset', 'password1234')).status, 201);
  await fetch(`${authUrl}/password-reset/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'expreset' }),
  });
  assert.equal(tokens.length, 1);

  app.db.prepare('UPDATE _PasswordResetToken SET expiresAt = ?').run(Date.now() - 1000);
  const res = await fetch(`${authUrl}/password-reset/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: tokens[0], newPassword: 'newpassword1' }),
  });
  assert.equal(res.status, 400);
});
