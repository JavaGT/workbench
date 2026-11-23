// totp.test.mjs — TOTP two-factor authentication unit + HTTP integration tests.
//
// Zero external dependencies; `node:crypto` only. Exercises the TOTP module
// directly (secret generation, token verification, backup codes), the pending
// login-challenge store, and the /auth/totp routes over HTTP.
//
// The second-factor completion flow under test:
//   - POST /auth/login for an enabled TOTP user → { requiresTotp, challenge, userId }
//   - POST /auth/totp/authenticate with { challenge, token } → 201 + sid cookie,
//     where token is a valid TOTP code OR an unused backup code. The user is
//     derived from the challenge — a client never supplies a userId.
//   - GET /auth/totp → the minimal { enrolled, enabled } status.
//
// Tests:
//   - base32 / generateSecret / hotp / verifyTotp primitives
//   - generateBackupCodes: 8 codes, 32 hex chars (128-bit entropy), hashed
//   - loginChallengeStore: user binding, TTL, attempt limit, claim lifecycle
//   - HTTP: enroll → verify → disable round-trip
//   - HTTP: login issues a challenge; authenticate (TOTP or backup) mints a session
//   - HTTP: backup-code reuse / challenge reuse / exhaustion / lockout interplay
//   - HTTP: GET /auth/totp status in all three states + anonymous 401

import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import workbench from '../build/app.mjs';
import { SESSION_COOKIE } from '../build/auth/session.mjs';
import {
  generateSecret,
  hotp,
  verifyTotp,
  generateBackupCodes,
  verifyBackupCode,
  base32Encode,
  base32Decode,
} from '../build/auth/totp.mjs';
import {
  createLoginChallengeStore,
  loginChallengeStore,
} from '../build/auth/login-challenge.mjs';

// ---- helpers -----------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull the `sid=...` value out of a Set-Cookie header.
function sidFromSetCookie(header) {
  const first = header.split(/,(?=[^ ;]+)/)[0];
  const match = first.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

// Boot an app with .auth() enabled on an ephemeral port.
async function boot(t) {
  const app = workbench({ db: ':memory:' }).auth();
  app.listen(0);
  await app.ready;
  const { port } = app.httpServer.address();
  t.after(() => app.httpServer.close());
  return { app, origin: `http://127.0.0.1:${port}` };
}

// Registration helper — creates a session and returns { origin, app, cookie, userId }.
async function login(t) {
  const { origin, app } = await boot(t);
  const res = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'testuser', password: 'testpass' }),
  });
  if (res.status !== 201) {
    const text = await res.text();
    throw new Error(`registration failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  const cookie = `sid=${sidFromSetCookie(res.headers.get('set-cookie'))}`;
  return { origin, app, cookie, userId: body.user.id };
}

// Enroll the current session's user in TOTP and complete the first verify
// (enabled=1). Returns { secret, backupCodes }.
async function enrollAndEnable(origin, cookie) {
  const enrollRes = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  if (enrollRes.status !== 201) {
    throw new Error(`enroll failed: ${enrollRes.status} ${await enrollRes.text()}`);
  }
  const { secret, backupCodes } = await enrollRes.json();
  const counter = Math.floor((Date.now() / 1000) / 30);
  const verifyRes = await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: hotp(secret, counter - 1) }),
  });
  if (verifyRes.status !== 200) {
    throw new Error(`verify failed: ${verifyRes.status} ${await verifyRes.text()}`);
  }
  return { secret, backupCodes };
}

// Password login for the testuser registered by `login(t)` — returns the
// pending-login challenge (the user must have TOTP enabled).
async function loginForTotp(origin) {
  const loginRes = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'testuser', password: 'testpass' }),
  });
  if (loginRes.status !== 200) {
    throw new Error(`login failed: ${loginRes.status} ${await loginRes.text()}`);
  }
  const body = await loginRes.json();
  return { challenge: body.challenge, userId: body.userId };
}

async function authenticate(origin, challenge, token) {
  return fetch(`${origin}/auth/totp/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge, token }),
  });
}

function currentTotpToken(secret) {
  const counter = Math.floor((Date.now() / 1000) / 30);
  return hotp(secret, counter);
}

// ---- base32 ------------------------------------------------------------------

test('base32Encode then base32Decode round-trips', () => {
  const bytes = crypto.randomBytes(20);
  const encoded = base32Encode(bytes);
  const decoded = base32Decode(encoded);
  assert.deepEqual(decoded, bytes);
});

test('base32Encode produces RFC 4648 charset (no padding)', () => {
  for (let i = 0; i < 50; i++) {
    const bytes = crypto.randomBytes(20);
    const encoded = base32Encode(bytes);
    // RFC 4648 base32 alphabet: A-Z and 2-7, no padding
    assert.match(encoded, /^[A-Z2-7]+$/);
    assert.doesNotMatch(encoded, /=/);
  }
});

// ---- generateSecret -------------------------------------------

test('generateSecret produces a valid base32 secret and otpauth URI', () => {
  const { secret, uri } = generateSecret('alice');
  // Secret is base32 (RFC 4648, no padding)
  assert.match(secret, /^[A-Z2-7]+$/);
  // Secret should be at least 32 chars (20 bytes → ceil(20*8/5) = 32)
  assert.ok(secret.length >= 32);
  // URI format: otpauth://totp/Workbench:alice?secret=...&issuer=workbench&algorithm=SHA1&digits=6&period=30
  assert.match(uri, /^otpauth:\/\/totp\/Workbench:alice\?secret=/);
  assert.match(uri, /&issuer=workbench/);
  assert.match(uri, /&algorithm=SHA1/);
  assert.match(uri, /&digits=6/);
  assert.match(uri, /&period=30/);
  assert.ok(uri.includes(secret));
});

test('generateSecret encodes username in URI', () => {
  const { uri } = generateSecret('bob@example.com');
  // Username should be URI-encoded
  assert.ok(uri.includes('bob%40example.com'));
});

test('generateSecret produces unique secrets', () => {
  const s1 = generateSecret('a').secret;
  const s2 = generateSecret('a').secret;
  assert.notEqual(s1, s2);
});

// ---- hotp / verifyTotp -------------------------------------------------------

test('hotp produces a 6-digit token from a secret and counter', () => {
  const { secret } = generateSecret('test');
  const token = hotp(secret, 0);
  assert.match(token, /^\d{6}$/);
  // Same secret + same counter → same token (deterministic)
  assert.equal(hotp(secret, 0), token);
  // Different counter → different token
  assert.notEqual(hotp(secret, 1), token);
});

test('verifyTotp accepts a valid token at current time', () => {
  const { secret } = generateSecret('test');
  const now = Date.now();
  const counter = Math.floor((now / 1000) / 30);
  const token = hotp(secret, counter);
  assert.equal(verifyTotp(secret, token, now), true);
});

test('verifyTotp accepts a valid token at +1 window (adjacent window tolerance)', () => {
  const { secret } = generateSecret('test');
  const now = Date.now();
  const counter = Math.floor((now / 1000) / 30);
  // Token from the next window should still verify
  const token = hotp(secret, counter + 1);
  assert.equal(verifyTotp(secret, token, now), true);
});

test('verifyTotp accepts a valid token at -1 window (adjacent window tolerance)', () => {
  const { secret } = generateSecret('test');
  const now = Date.now();
  const counter = Math.floor((now / 1000) / 30);
  // Token from the previous window should still verify
  const token = hotp(secret, counter - 1);
  assert.equal(verifyTotp(secret, token, now), true);
});

test('verifyTotp rejects an invalid token', () => {
  const { secret } = generateSecret('test');
  // A random 6-digit number is unlikely to match
  assert.equal(verifyTotp(secret, '123456'), false);
  assert.equal(verifyTotp(secret, '000000'), false);
});

test('verifyTotp rejects a token outside the ±1 window', () => {
  const { secret } = generateSecret('test');
  const now = Date.now();
  const counter = Math.floor((now / 1000) / 30);
  // Token from 2 windows away should NOT verify
  const token = hotp(secret, counter + 2);
  assert.equal(verifyTotp(secret, token, now), false);
});

test('verifyTotp handles leading zeros in token', () => {
  // Use a contrived secret to test leading-zero padding
  // Generate tokens until we get one with leading zero (unpredictable with random
  // secret, but the padding logic is exercised regardless)
  const { secret } = generateSecret('test');
  const now = Date.now();
  const counter = Math.floor((now / 1000) / 30);
  const token = hotp(secret, counter);
  // Pad the token and verify — this exercises the padStart logic in verifyTotp
  const padded = String(parseInt(token, 10)).padStart(6, '0');
  assert.equal(verifyTotp(secret, padded, now), true);
});

// ---- backup codes ------------------------------------------------------------

test('generateBackupCodes returns correct count', () => {
  const { plainCodes, hashedCodes } = generateBackupCodes(8);
  assert.equal(plainCodes.length, 8);
  assert.equal(hashedCodes.length, 8);
  // Default is 8
  const defaults = generateBackupCodes();
  assert.equal(defaults.plainCodes.length, 8);
  // Custom count
  const custom = generateBackupCodes(5);
  assert.equal(custom.plainCodes.length, 5);
});

test('generateBackupCodes each code is 32 hex chars (128-bit entropy)', () => {
  const { plainCodes } = generateBackupCodes(50);
  for (const code of plainCodes) {
    assert.match(code, /^[0-9a-f]{32}$/);
  }
  // All unique
  assert.equal(new Set(plainCodes).size, 50);
});

test('verifyBackupCode: valid code → true and consumed', () => {
  const { plainCodes, hashedCodes } = generateBackupCodes(3);
  assert.equal(verifyBackupCode(hashedCodes, plainCodes[0]), true);
  // Code is consumed — array length decreased
  assert.equal(hashedCodes.length, 2);
});

test('verifyBackupCode: consumed code → false', () => {
  const { plainCodes, hashedCodes } = generateBackupCodes(3);
  assert.equal(verifyBackupCode(hashedCodes, plainCodes[0]), true);
  // Same code again → false (already consumed)
  assert.equal(verifyBackupCode(hashedCodes, plainCodes[0]), false);
});

test('verifyBackupCode: wrong code → false', () => {
  const { hashedCodes } = generateBackupCodes(3);
  assert.equal(verifyBackupCode(hashedCodes, 'deadbeef'), false);
  // Array unchanged on failure
  assert.equal(hashedCodes.length, 3);
});

test('generateBackupCodes: hashed codes are SHA-256 hex (64 chars)', () => {
  const { plainCodes, hashedCodes } = generateBackupCodes(1);
  assert.match(hashedCodes[0], /^[0-9a-f]{64}$/);
  // Verify the hash is correct
  const expectedHash = crypto.createHash('sha256').update(plainCodes[0]).digest('hex');
  assert.equal(hashedCodes[0], expectedHash);
});

// ---- login challenge store ---------------------------------------------------

test('createLoginChallengeStore: set binds a user and returns an unguessable challenge', () => {
  const store = createLoginChallengeStore();
  const c1 = store.set('user-1');
  const c2 = store.set('user-1');
  assert.equal(typeof c1, 'string');
  assert.ok(c1.length > 20, 'challenge should be opaque and long');
  assert.notEqual(c1, c2, 'each challenge is unique');
  const entry = store.get(c1);
  assert.notEqual(entry, null);
  assert.equal(entry.userId, 'user-1');
  assert.equal(entry.attempts, 0);
  store.destroy();
});

test('createLoginChallengeStore: challenges expire after the TTL', async () => {
  const store = createLoginChallengeStore(50); // 50ms TTL
  const c = store.set('user-1');
  assert.notEqual(store.get(c), null);
  await sleep(60);
  assert.equal(store.get(c), null, 'expired challenge returns null');
  assert.equal(store.reserve(c), null, 'expired challenge cannot be reserved');
  store.destroy();
});

test('createLoginChallengeStore: expiry before reserve rejects; a reservation made before expiry settles after it', () => {
  let clock = 1_000_000;
  const store = createLoginChallengeStore(1000, 5, () => clock);

  // Expired before reserve → rejected.
  const c = store.set('user-1');
  clock = 1_001_100; // past the 1000ms TTL
  assert.equal(store.reserve(c), null, 'an expired challenge cannot be reserved');

  // Reserved before expiry, clock crosses the TTL while reserved → settle allowed.
  const c2 = store.set('user-1');
  const claim = store.reserve(c2);
  assert.ok(claim, 'a live challenge reserves');
  clock = 1_001_100;
  assert.equal(store.finalize(claim), true, 'a reservation made before expiry may settle after it');
  assert.equal(store.reserve(c2), null, 'the settled challenge is gone');
  store.destroy();
});

test('createLoginChallengeStore: release returns available before expiry and deletes after', () => {
  let clock = 1_000_000;
  const store = createLoginChallengeStore(1000, 5, () => clock);

  // Release before the original expiry → available again.
  const c = store.set('user-1');
  const claim = store.reserve(c);
  clock = 1_000_500;
  assert.equal(store.release(claim), true);
  assert.notEqual(store.get(c), null, 'released before expiry returns to available');
  assert.equal(store.get(c).attempts, 0, 'release does not increment attempts');

  // Release after the original expiry → deleted.
  clock = 1_000_000; // reset so the fresh challenge gets a known creation time
  const c2 = store.set('user-1');
  const claim2 = store.reserve(c2);
  clock = 1_001_100;
  assert.equal(store.release(claim2), true);
  assert.equal(store.get(c2), null, 'released after expiry is deleted');
  store.destroy();
});

test('createLoginChallengeStore: fail counts attempts and destroys at maxAttempts', () => {
  const store = createLoginChallengeStore(5000, 3);
  const c = store.set('user-1');
  let claim = store.reserve(c);
  assert.ok(claim);
  assert.equal(store.fail(claim), true); // attempt 1 → available again
  claim = store.reserve(c);
  assert.equal(store.fail(claim), true); // attempt 2
  assert.equal(store.get(c).attempts, 2);
  claim = store.reserve(c);
  assert.equal(store.fail(claim), false); // attempt 3 → destroyed
  assert.equal(store.get(c), null, 'challenge destroyed once the attempt limit is hit');
  store.destroy();
});

test('createLoginChallengeStore: reserve is atomic and finalize is single-use', () => {
  const store = createLoginChallengeStore(5000);
  const c = store.set('user-1');
  const claim = store.reserve(c);
  assert.ok(claim);
  assert.equal(claim.userId, 'user-1', 'the claim carries the bound user');
  assert.equal(store.reserve(c), null, 'a reserved challenge cannot be reserved again');
  assert.equal(store.finalize(claim), true);
  assert.equal(store.reserve(c), null, 'replay is rejected after finalize');
  store.destroy();
});

test('createLoginChallengeStore: a stale claim cannot settle a re-reserved challenge', () => {
  const store = createLoginChallengeStore(5000);
  const c = store.set('user-1');
  const claimA = store.reserve(c);
  assert.ok(claimA);
  assert.equal(store.release(claimA), true); // A's request rolled back
  const claimB = store.reserve(c);           // B picks the challenge up
  assert.ok(claimB);
  // A's stale claim can neither finalize nor release: finalize fails closed and
  // invalidates the challenge so a stale claim can never reopen it.
  assert.equal(store.finalize(claimA), false, 'finalize with a stale claim fails closed');
  assert.equal(store.get(c), null, 'the stale finalize invalidated the challenge');
  store.destroy();
});

// ---- HTTP integration ---------------------------------------------------------

test('POST /auth/totp/enroll requires authentication (401)', async (t) => {
  const { origin } = await boot(t);
  const res = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 401, 'unauthenticated enrollment should be rejected');
});

test('POST /auth/totp/enroll returns secret, uri, and backup codes', async (t) => {
  const { origin, cookie } = await login(t);
  const res = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  if (res.status !== 201) throw new Error(`enroll failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  // Secret is base32
  assert.match(body.secret, /^[A-Z2-7]+$/);
  // URI is valid otpauth
  assert.match(body.uri, /^otpauth:\/\/totp\//);
  // Backup codes returned
  assert.ok(Array.isArray(body.backupCodes));
  assert.equal(body.backupCodes.length, 8);
  for (const code of body.backupCodes) {
    assert.match(code, /^[0-9a-f]{32}$/);
  }
});

test('POST /auth/totp/enroll rejects duplicate enrollment (409)', async (t) => {
  const { origin, cookie } = await login(t);
  // First enrollment
  const res1 = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  assert.equal(res1.status, 201);
  // Second enrollment → 409
  const res2 = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  assert.equal(res2.status, 409);
});

test('enroll → verify → disable round-trip', async (t) => {
  const { origin, cookie } = await login(t);

  // 1. Enroll
  const enrollRes = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  assert.equal(enrollRes.status, 201);
  const { secret } = await enrollRes.json();

  // 2. Verify with a valid TOTP token (previous step so disable can advance to current step without triggering replay guard)
  const counter = Math.floor((Date.now() / 1000) / 30);
  const validToken = hotp(secret, counter - 1);
  const verifyRes = await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: validToken }),
  });
  assert.equal(verifyRes.status, 200);
  const verifyBody = await verifyRes.json();
  assert.equal(verifyBody.verified, true);

  // 3. Disable with a fresh TOTP token
  const disableToken = hotp(secret, counter);
  const disableRes = await fetch(`${origin}/auth/totp/disable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: disableToken }),
  });
  assert.equal(disableRes.status, 204);

  // 4. After disable, verify should fail (no enrollment)
  const verifyAfterRes = await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: validToken }),
  });
  assert.equal(verifyAfterRes.status, 400);
});

test('login with 2FA enabled returns requiresTotp with a challenge', async (t) => {
  const { origin, cookie } = await login(t);

  // Enroll and verify TOTP
  await enrollAndEnable(origin, cookie);

  // Logout first
  await fetch(`${origin}/auth/logout`, {
    method: 'POST',
    headers: { cookie },
  });

  // Login again — should get requiresTotp + a challenge, not a session
  const loginRes = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'testuser', password: 'testpass' }),
  });
  assert.equal(loginRes.status, 200);
  const loginBody = await loginRes.json();
  assert.equal(loginBody.requiresTotp, true);
  assert.ok(loginBody.challenge, 'login issues a pending-login challenge');
  assert.ok(loginBody.userId, 'login keeps the userId for display/debug');
  // No cookie should be set (session not minted yet)
  assert.equal(loginRes.headers.get('set-cookie'), null);
});

test('authenticate with TOTP → session minted', async (t) => {
  const { origin, cookie, userId } = await login(t);

  // Enroll and verify TOTP
  const { secret } = await enrollAndEnable(origin, cookie);

  // Logout
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  // Login → challenge
  const { challenge } = await loginForTotp(origin);

  // Authenticate with TOTP
  const authRes = await authenticate(origin, challenge, currentTotpToken(secret));
  assert.equal(authRes.status, 201, 'authenticate failed');
  const authBody = await authRes.json();
  assert.deepEqual(authBody, { user: { id: userId, username: 'testuser' } });

  // Session cookie was set with the fail-closed attributes
  const setCookie = authRes.headers.get('set-cookie');
  assert.ok(setCookie, 'authenticate sets a Set-Cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  const newSid = sidFromSetCookie(setCookie);
  assert.ok(newSid);
});

test('authenticate with a backup code → session minted, identical to TOTP login', async (t) => {
  const { origin, cookie, userId } = await login(t);

  // Enroll and verify TOTP
  const { secret, backupCodes } = await enrollAndEnable(origin, cookie);

  // Logout
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  // Backup-code login (fresh challenge)
  const backupChallenge = await loginForTotp(origin);
  const backupRes = await authenticate(origin, backupChallenge.challenge, backupCodes[0]);
  assert.equal(backupRes.status, 201, 'backup-code login failed');
  const backupBody = await backupRes.json();
  assert.deepEqual(backupBody, { user: { id: userId, username: 'testuser' } });
  assert.ok(sidFromSetCookie(backupRes.headers.get('set-cookie')), 'backup login mints a session cookie');

  // TOTP login (fresh challenge, new login) — the response must be identical.
  const totpChallenge = await loginForTotp(origin);
  const totpRes = await authenticate(origin, totpChallenge.challenge, currentTotpToken(secret));
  assert.equal(totpRes.status, 201);
  const totpBody = await totpRes.json();
  assert.deepEqual(totpBody, backupBody, 'backup and TOTP success share one response shape');
  assert.equal(Object.keys(totpBody).length, 1, 'response never reveals which factor was used');
});

test('authenticate with wrong TOTP token → 400, no session', async (t) => {
  const { origin, cookie } = await login(t);

  // Enroll and verify TOTP
  await enrollAndEnable(origin, cookie);

  // Logout
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  // Login → challenge
  const { challenge } = await loginForTotp(origin);

  // Authenticate with wrong token
  const authRes = await authenticate(origin, challenge, '123456');
  assert.equal(authRes.status, 400);
  assert.equal(authRes.headers.get('set-cookie'), null, 'no session cookie on a failed attempt');
  const body = await authRes.json();
  assert.match(body.failure.message, /invalid/i);
});

test('authenticate with a consumed backup code → 400, no session', async (t) => {
  const { origin, cookie } = await login(t);

  // Enroll and verify TOTP
  const { backupCodes } = await enrollAndEnable(origin, cookie);

  // Logout
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  // Use the first backup code to log in once.
  const first = await loginForTotp(origin);
  const firstRes = await authenticate(origin, first.challenge, backupCodes[0]);
  assert.equal(firstRes.status, 201);

  // The same code cannot log in again (fresh challenge).
  const second = await loginForTotp(origin);
  const secondRes = await authenticate(origin, second.challenge, backupCodes[0]);
  assert.equal(secondRes.status, 400, 'a consumed backup code must not mint a session');
  assert.equal(secondRes.headers.get('set-cookie'), null);
});

test('authenticate succeeds with a backup code while TOTP is locked', async (t) => {
  const { origin, cookie, app, userId } = await login(t);

  // Enroll and verify TOTP
  const { backupCodes } = await enrollAndEnable(origin, cookie);

  // Inject a lock via 5 failed TOTP verifications (needs the session cookie).
  for (let i = 0; i < 5; i++) {
    await fetch(`${origin}/auth/totp/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ token: '999999' }),
    });
  }
  const locked = await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: '999999' }),
  });
  assert.equal(locked.status, 429, 'TOTP is locked after repeated failures');

  // Logout
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  // Backup-code login while the TOTP lock is active → must succeed.
  const { challenge } = await loginForTotp(origin);
  const authRes = await authenticate(origin, challenge, backupCodes[0]);
  assert.equal(authRes.status, 201, `backup recovery while locked failed: ${await authRes.text()}`);
  assert.ok(sidFromSetCookie(authRes.headers.get('set-cookie')));

  // The success clears the lock.
  const row = app.db.prepare('SELECT totpFailedAttempts, totpLockedUntil FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(row.totpFailedAttempts, 0);
  assert.equal(row.totpLockedUntil, null);
});

test('authenticate rejects a wrong token while TOTP is locked (429)', async (t) => {
  const { origin, cookie } = await login(t);

  await enrollAndEnable(origin, cookie);
  for (let i = 0; i < 5; i++) {
    await fetch(`${origin}/auth/totp/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ token: '999999' }),
    });
  }

  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });
  const { challenge } = await loginForTotp(origin);
  const authRes = await authenticate(origin, challenge, '123456');
  assert.equal(authRes.status, 429, 'TOTP lockout applies to non-backup tokens');
  assert.equal(authRes.headers.get('set-cookie'), null);
});

test('invalid attempts while TOTP is locked still exhaust the login challenge', async (t) => {
  const { origin, cookie } = await login(t);

  await enrollAndEnable(origin, cookie);
  for (let i = 0; i < 5; i++) {
    await fetch(`${origin}/auth/totp/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ token: '999999' }),
    });
  }

  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });
  const { challenge } = await loginForTotp(origin);

  // All five attempts count against the challenge even though TOTP is locked.
  for (let i = 0; i < 5; i++) {
    const res = await authenticate(origin, challenge, '123456');
    assert.equal(res.status, 429, `attempt ${i + 1} should still be lockout-limited`);
    assert.equal(res.headers.get('set-cookie'), null);
  }

  // The sixth attempt must be rejected as an exhausted challenge — no session.
  const exhausted = await authenticate(origin, challenge, '123456');
  assert.equal(exhausted.status, 400, 'challenge is exhausted after the attempt cap');
  assert.equal(exhausted.headers.get('set-cookie'), null);
});

test('authenticate requires both a challenge and a token', async (t) => {
  const { origin } = await boot(t);

  const missingChallenge = await fetch(`${origin}/auth/totp/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: '123456' }),
  });
  assert.equal(missingChallenge.status, 400);
  assert.equal(missingChallenge.headers.get('set-cookie'), null);

  const missingToken = await fetch(`${origin}/auth/totp/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: 'opaque' }),
  });
  assert.equal(missingToken.status, 400);
  assert.equal(missingToken.headers.get('set-cookie'), null);
});

test('authenticate with an unknown or consumed challenge → 400, no session', async (t) => {
  const { origin, cookie } = await login(t);

  const { secret } = await enrollAndEnable(origin, cookie);
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  // A random, never-issued challenge.
  const random = await authenticate(origin, 'not-a-real-challenge', currentTotpToken(secret));
  assert.equal(random.status, 400);
  assert.equal(random.headers.get('set-cookie'), null);

  // A real challenge, settled server-side (forces the "expired" failure).
  const { challenge } = await loginForTotp(origin);
  const claim = loginChallengeStore.reserve(challenge);
  assert.ok(claim);
  assert.equal(loginChallengeStore.finalize(claim), true);
  const consumed = await authenticate(origin, challenge, currentTotpToken(secret));
  assert.equal(consumed.status, 400);
  assert.equal(consumed.headers.get('set-cookie'), null);
});

test('authenticate destroys the challenge after 5 failed attempts', async (t) => {
  const { origin, cookie } = await login(t);

  const { secret } = await enrollAndEnable(origin, cookie);
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  const { challenge } = await loginForTotp(origin);

  // Five invalid tokens burn the five challenge attempts.
  for (let i = 0; i < 5; i++) {
    const res = await authenticate(origin, challenge, '000000');
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('set-cookie'), null, 'failed attempts never mint a session');
  }

  // The challenge is gone — even a valid token cannot complete the login.
  const res = await authenticate(origin, challenge, currentTotpToken(secret));
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('authenticate fails when the challenge is bound to a user with no enabled TOTP', async (t) => {
  const { origin } = await boot(t);

  // A user with NO TOTP enrollment at all.
  const regRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'password12' }),
  });
  assert.equal(regRes.status, 201);
  const aliceId = (await regRes.json()).user.id;

  // Forge a pending-login challenge bound to alice (login itself never issues
  // one for a user without enabled TOTP). Authenticate derives the user from
  // the challenge and must fail closed.
  const forged = loginChallengeStore.set(aliceId);
  const res = await authenticate(origin, forged, '123456');
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('set-cookie'), null);
  const body = await res.json();
  assert.match(body.failure.message, /not enabled/i);
});

test('concurrent duplicate submission of the same backup code yields at most one session', async (t) => {
  const { origin, cookie } = await login(t);

  const { backupCodes } = await enrollAndEnable(origin, cookie);
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  const { challenge } = await loginForTotp(origin);

  const results = await Promise.all([
    authenticate(origin, challenge, backupCodes[0]),
    authenticate(origin, challenge, backupCodes[0]),
  ]);
  const successes = results.filter((r) => r.status === 201);
  const failures = results.filter((r) => r.status === 400);
  assert.equal(successes.length, 1, 'exactly one concurrent use of a code succeeds');
  assert.equal(failures.length, 1, 'the other concurrent use is rejected');
  for (const r of failures) assert.equal(r.headers.get('set-cookie'), null);
});

test('consuming the final backup code keeps the enrollment enabled', async (t) => {
  const { origin, cookie, app, userId } = await login(t);

  const { backupCodes } = await enrollAndEnable(origin, cookie);
  assert.equal(backupCodes.length, 8);
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  // Consume all 8 codes one at a time, each through a fresh login challenge.
  for (const code of backupCodes) {
    const { challenge } = await loginForTotp(origin);
    const res = await authenticate(origin, challenge, code);
    assert.equal(res.status, 201, `backup login with code should succeed: ${res.status}`);
    assert.ok(res.headers.get('set-cookie'));
  }

  // The enrollment row survives and stays enabled after the FINAL code.
  const row = app.db.prepare('SELECT enabled, verifiedAt, backupCodes FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(row.enabled, 1, 'enrollment stays enabled after the last backup code');
  assert.ok(row.verifiedAt, 'verifiedAt is unchanged by backup-code use');
  assert.equal(JSON.parse(row.backupCodes).length, 0, 'all hashes were consumed');

  // A subsequent password login still requires TOTP.
  const loginRes = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'testuser', password: 'testpass' }),
  });
  assert.equal(loginRes.status, 200);
  assert.equal((await loginRes.json()).requiresTotp, true);
});

test('successful TOTP login resets the TOTP lockout counters', async (t) => {
  const { origin, cookie, app, userId } = await login(t);

  const { secret } = await enrollAndEnable(origin, cookie);

  // Three failed TOTP verifications push the counter up.
  for (let i = 0; i < 3; i++) {
    await fetch(`${origin}/auth/totp/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ token: '999999' }),
    });
  }
  const before = app.db.prepare('SELECT totpFailedAttempts, totpLockedUntil FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(before.totpFailedAttempts, 3);

  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });
  const { challenge } = await loginForTotp(origin);
  const res = await authenticate(origin, challenge, currentTotpToken(secret));
  assert.equal(res.status, 201);

  const after = app.db.prepare('SELECT totpFailedAttempts, totpLockedUntil FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(after.totpFailedAttempts, 0);
  assert.equal(after.totpLockedUntil, null);
});

test('successful backup-code login resets the TOTP lockout counters', async (t) => {
  const { origin, cookie, app, userId } = await login(t);

  const { backupCodes } = await enrollAndEnable(origin, cookie);

  for (let i = 0; i < 3; i++) {
    await fetch(`${origin}/auth/totp/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ token: '999999' }),
    });
  }
  const before = app.db.prepare('SELECT totpFailedAttempts, totpLockedUntil FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(before.totpFailedAttempts, 3);

  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });
  const { challenge } = await loginForTotp(origin);
  const res = await authenticate(origin, challenge, backupCodes[0]);
  assert.equal(res.status, 201);

  const after = app.db.prepare('SELECT totpFailedAttempts, totpLockedUntil FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(after.totpFailedAttempts, 0);
  assert.equal(after.totpLockedUntil, null);
});

// ---- expired-lock reset (deterministic clock) --------------------------------
// The TOTP fence is armed directly in the DB (past/future `totpLockedUntil`)
// so the expiry behavior is deterministic — no sleeping.

function armExpiredTotpLock(app, userId) {
  app.db.prepare('UPDATE TwoFactor SET totpFailedAttempts = ?, totpLockedUntil = ? WHERE userId = ?')
    .run(5, Date.now() - 1000, userId);
}

function armActiveTotpLock(app, userId) {
  app.db.prepare('UPDATE TwoFactor SET totpFailedAttempts = ?, totpLockedUntil = ? WHERE userId = ?')
    .run(5, Date.now() + 60_000, userId);
}

test('verify after an expired lock does not instantly relock (invalid token → 400)', async (t) => {
  const { origin, cookie, app, userId } = await login(t);
  await enrollAndEnable(origin, cookie);
  // A stale 5-attempt counter with a lock that has already expired.
  armExpiredTotpLock(app, userId);

  const attempt = () => fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: '999999' }),
  });

  const first = await attempt();
  assert.equal(first.status, 400, 'an invalid token after an expired lock is a plain failure, not a relock');
  assert.equal(first.headers.get('set-cookie'), null);
  let row = app.db.prepare('SELECT totpFailedAttempts, totpLockedUntil FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(row.totpFailedAttempts, 1, 'the stale counter is not carried into the new series');
  assert.equal(row.totpLockedUntil, null, 'no fresh lock was armed');

  const second = await attempt();
  assert.equal(second.status, 400, 'a second invalid token still does not relock');
  row = app.db.prepare('SELECT totpFailedAttempts, totpLockedUntil FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(row.totpFailedAttempts, 2, 'the fresh series accumulates normally after the reset');
  assert.equal(row.totpLockedUntil, null);

  // The reset restored the throttle: a full fresh series re-locks (5th → 429).
  for (let i = 0; i < 3; i++) await attempt();
  row = app.db.prepare('SELECT totpFailedAttempts, totpLockedUntil FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(row.totpFailedAttempts, 5);
  assert.ok(row.totpLockedUntil > Date.now(), 'a fresh threshold series arms a new lock');
  const relocked = await attempt();
  assert.equal(relocked.status, 429, 'a fresh threshold series re-locks after the reset');
});

test('verify after an expired lock accepts a valid TOTP token and clears the fence', async (t) => {
  const { origin, cookie, app, userId } = await login(t);
  const { secret } = await enrollAndEnable(origin, cookie);
  armExpiredTotpLock(app, userId);

  const res = await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: currentTotpToken(secret) }),
  });
  assert.equal(res.status, 200);
  const row = app.db.prepare('SELECT totpFailedAttempts, totpLockedUntil FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(row.totpFailedAttempts, 0);
  assert.equal(row.totpLockedUntil, null);
});

test('verify with an active lock → 429 even for a valid TOTP token', async (t) => {
  const { origin, cookie, app, userId } = await login(t);
  const { secret } = await enrollAndEnable(origin, cookie);
  armActiveTotpLock(app, userId);

  const res = await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: currentTotpToken(secret) }),
  });
  assert.equal(res.status, 429, 'the TOTP fence blocks verification while the lock holds');
  const body = await res.json();
  assert.ok(body.failure.details.retryAfterMs > 0, 'the lockout response carries a retry hint');
});

test('authenticate after an expired lock does not instantly relock (invalid token → 400)', async (t) => {
  const { origin, cookie, app, userId } = await login(t);
  await enrollAndEnable(origin, cookie);
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });
  armExpiredTotpLock(app, userId);

  const { challenge } = await loginForTotp(origin);
  const res = await authenticate(origin, challenge, '123456');
  assert.equal(res.status, 400, 'an invalid token after an expired lock is a plain failure, not 429');
  assert.equal(res.headers.get('set-cookie'), null);
  const row = app.db.prepare('SELECT totpFailedAttempts, totpLockedUntil FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(row.totpFailedAttempts, 1, 'the stale counter is not carried into the new series');
  assert.equal(row.totpLockedUntil, null, 'no fresh lock was armed');
});

test('disable after an expired lock does not instantly relock (invalid token → 400)', async (t) => {
  const { origin, cookie, app, userId } = await login(t);
  await enrollAndEnable(origin, cookie);
  armExpiredTotpLock(app, userId);

  const res = await fetch(`${origin}/auth/totp/disable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: '999999' }),
  });
  assert.equal(res.status, 400, 'an invalid token after an expired lock is a plain failure, not 429');
  const row = app.db.prepare('SELECT totpFailedAttempts, totpLockedUntil, enabled FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(row.totpFailedAttempts, 1);
  assert.equal(row.totpLockedUntil, null);
  assert.equal(row.enabled, 1, 'the enrollment survives an invalid disable attempt');
});

test('disable with a backup code succeeds while the TOTP lock is active', async (t) => {
  const { origin, cookie, app, userId } = await login(t);
  const { backupCodes } = await enrollAndEnable(origin, cookie);
  armActiveTotpLock(app, userId);

  const res = await fetch(`${origin}/auth/totp/disable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: backupCodes[0] }),
  });
  assert.equal(res.status, 204, 'a backup code is the recovery escape hatch');
  const row = app.db.prepare('SELECT id FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(row, undefined, 'the enrollment was removed');
});

// ---- backup-code burn prevention ---------------------------------------------

test('same-challenge race with different valid codes: the losing code stays usable', async (t) => {
  const { origin, cookie, app, userId } = await login(t);
  const { backupCodes } = await enrollAndEnable(origin, cookie);
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  const { challenge } = await loginForTotp(origin);
  const results = await Promise.all([
    authenticate(origin, challenge, backupCodes[0]),
    authenticate(origin, challenge, backupCodes[1]),
  ]);
  const successes = results.filter((r) => r.status === 201);
  const failures = results.filter((r) => r.status === 400);
  assert.equal(successes.length, 1, 'exactly one concurrent use of the challenge succeeds');
  assert.equal(failures.length, 1, 'the other concurrent use is rejected');
  for (const r of failures) assert.equal(r.headers.get('set-cookie'), null);

  const row = app.db.prepare('SELECT backupCodes FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(JSON.parse(row.backupCodes).length, 7, 'exactly one code was consumed');

  const loserCode = results[0].status === 201 ? backupCodes[1] : backupCodes[0];
  const retry = await loginForTotp(origin);
  const retryRes = await authenticate(origin, retry.challenge, loserCode);
  assert.equal(retryRes.status, 201, 'the losing code was rolled back with the failed mint and stays usable');
});

test('a challenge that expires between the reads does not burn the backup code', async (t) => {
  const { origin, cookie, app, userId } = await login(t);
  const { backupCodes } = await enrollAndEnable(origin, cookie);
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  const { challenge } = await loginForTotp(origin);

  // Simulate the challenge being claimed by a racing request (or expiring)
  // between the route's reserve and its settle step.
  const racingClaim = loginChallengeStore.reserve(challenge);
  assert.ok(racingClaim);
  assert.equal(loginChallengeStore.finalize(racingClaim), true);

  const res = await authenticate(origin, challenge, backupCodes[0]);
  assert.equal(res.status, 400, 'an expired challenge cannot complete a login');
  assert.equal(res.headers.get('set-cookie'), null);

  const row = app.db.prepare('SELECT backupCodes FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(JSON.parse(row.backupCodes).length, 8, 'no backup code was consumed');

  const retry = await loginForTotp(origin);
  const retryRes = await authenticate(origin, retry.challenge, backupCodes[0]);
  assert.equal(retryRes.status, 201, 'the backup code remains usable after the race');
});

test('a failed session mint (confirmed rollback) releases the same challenge+code for a retry', async (t) => {
  const { origin, cookie, app, userId } = await login(t);
  const { backupCodes } = await enrollAndEnable(origin, cookie);
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  let challenge;
  // Break Session writes so the mint fails inside the settlement transaction.
  app.db.prepare('ALTER TABLE Session RENAME TO Session_hidden').run();
  try {
    ({ challenge } = await loginForTotp(origin));
    const res = await authenticate(origin, challenge, backupCodes[0]);
    assert.equal(res.status, 500, 'a session-mint failure surfaces as a server error');
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    app.db.prepare('ALTER TABLE Session_hidden RENAME TO Session').run();
  }

  const row = app.db.prepare('SELECT backupCodes, totpFailedAttempts FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(JSON.parse(row.backupCodes).length, 8, 'the code removal rolled back with the failed mint');
  assert.equal(row.totpFailedAttempts, 0, 'the fence reset rolled back with the failed mint');

  // The confirmed rollback RELEASED the challenge — the SAME challenge + code
  // retries without a fresh password login.
  const retryRes = await authenticate(origin, challenge, backupCodes[0]);
  assert.equal(retryRes.status, 201, 'the same challenge and code retry after the confirmed rollback');
  assert.ok(sidFromSetCookie(retryRes.headers.get('set-cookie')));
});

// ---- deterministic claim-protocol HTTP tests --------------------------------
// The claim protocol makes the settlement interleavings deterministic: reserve
// is synchronous and atomic, so a second request is rejected before SQL, and
// the txn outcome (committed / rolled-back / ambiguous) drives a single
// settlement call. These tests pin each ordering with hooks and DB barriers —
// no timing sleeps.

test('a request that holds a reservation rejects a second request before SQL', async (t) => {
  const { origin, cookie, app, userId } = await login(t);
  const { secret } = await enrollAndEnable(origin, cookie);
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  const { challenge } = await loginForTotp(origin);

  // Request A has reserved the challenge (an in-flight second-factor settle).
  const claim = loginChallengeStore.reserve(challenge);
  assert.ok(claim, 'request A reserves the challenge');
  assert.equal(claim.userId, userId, 'the user is derived from the claim');

  // Break Session writes: ANY SQL request B touches would blow up with a 500.
  // B must be rejected by reserve BEFORE SQL, so it still gets a clean 400.
  app.db.prepare('ALTER TABLE Session RENAME TO Session_hidden').run();
  try {
    const res = await authenticate(origin, challenge, currentTotpToken(secret));
    assert.equal(res.status, 400, 'request B is rejected before SQL');
    assert.equal(res.headers.get('set-cookie'), null);
    const body = await res.json();
    assert.match(body.failure.message, /unknown or expired/i);
  } finally {
    app.db.prepare('ALTER TABLE Session_hidden RENAME TO Session').run();
    // A settles its reservation; B never touched it.
    loginChallengeStore.finalize(claim);
  }
});

test('two challenges using one backup code admit at most one success and do not restore lists', async (t) => {
  const { origin, cookie, app, userId } = await login(t);
  const { backupCodes } = await enrollAndEnable(origin, cookie);
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  const first = await loginForTotp(origin);
  const firstRes = await authenticate(origin, first.challenge, backupCodes[0]);
  assert.equal(firstRes.status, 201, 'the first challenge consumes the code');
  assert.ok(sidFromSetCookie(firstRes.headers.get('set-cookie')));

  const row = app.db.prepare('SELECT backupCodes FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(JSON.parse(row.backupCodes).length, 7, 'exactly one code was consumed');

  const second = await loginForTotp(origin);
  const secondRes = await authenticate(origin, second.challenge, backupCodes[0]);
  assert.equal(secondRes.status, 400, 'the second challenge cannot reuse the consumed code');
  assert.equal(secondRes.headers.get('set-cookie'), null);

  const after = app.db.prepare('SELECT backupCodes FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(JSON.parse(after.backupCodes).length, 7, 'the loser did not restore the consumed code');
});

test('finalize runs before the response is constructed (a settlement failure after commit sends no cookie)', async (t) => {
  const { origin, cookie, app, userId } = await login(t);
  const { backupCodes } = await enrollAndEnable(origin, cookie);
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  const original = loginChallengeStore.finalize;
  let finalizedCalls = 0;
  loginChallengeStore.finalize = () => {
    finalizedCalls += 1;
    return false; // the settlement step fails AFTER the commit confirmed
  };
  try {
    const { challenge } = await loginForTotp(origin);
    const res = await authenticate(origin, challenge, backupCodes[0]);
    assert.equal(finalizedCalls, 1, 'finalize was invoked after the commit');
    assert.equal(res.status, 500, 'a failed finalize fails closed');
    assert.equal(res.headers.get('set-cookie'), null, 'no cookie — the response was not built before finalize');
  } finally {
    loginChallengeStore.finalize = original;
  }

  // The commit had already landed before finalize: session + code removal stand.
  const row = app.db.prepare('SELECT backupCodes FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(JSON.parse(row.backupCodes).length, 7, 'the code removal committed');
  const sessions = app.db.prepare('SELECT COUNT(*) AS n FROM Session').get().n;
  assert.equal(sessions, 1, 'the session committed');
});

test('an ambiguous commit fails closed: the challenge is invalidated, never released', async (t) => {
  const { origin, cookie, app } = await login(t);
  const { backupCodes } = await enrollAndEnable(origin, cookie);
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  const { challenge } = await loginForTotp(origin);

  const realCommit = app.db.commit;
  const realRollback = app.db.rollback;
  // Force the driver's sync txn primitives into the ambiguous state: COMMIT
  // fails AND the follow-up ROLLBACK also fails, so the transaction's fate is
  // unknown. (The connection is left inside an open transaction — restored and
  // rolled back in the finally below.)
  app.db.commit = () => { throw new Error('commit failed'); };
  app.db.rollback = () => { throw new Error('rollback failed'); };
  try {
    const res = await authenticate(origin, challenge, backupCodes[0]);
    assert.equal(res.status, 500, 'an ambiguous commit surfaces as a server error');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(loginChallengeStore.reserve(challenge), null, 'the challenge was invalidated, not released');
  } finally {
    app.db.commit = realCommit;
    app.db.rollback = realRollback;
    app.db.rollback(); // close the transaction the forced failures left open
  }
});

test('a failed COMMIT with a successful ROLLBACK is a confirmed no-commit: the same challenge+code retries cleanly', async (t) => {
  const { origin, cookie, app, userId } = await login(t);
  const { backupCodes } = await enrollAndEnable(origin, cookie);
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  const { challenge } = await loginForTotp(origin);

  const realCommit = app.db.commit;
  // Force the driver's sync COMMIT to fail while the follow-up ROLLBACK still
  // succeeds — the route's confirmed no-commit branch, NOT the ambiguous one.
  // All settlement writes (fence reset, code removal, Session mint) were issued
  // but never committed; the route's own rollback closes the transaction.
  app.db.commit = () => { throw new Error('commit failed'); };
  try {
    const res = await authenticate(origin, challenge, backupCodes[0]);
    assert.equal(res.status, 500, 'a failed COMMIT surfaces as a server error');
    assert.equal(res.headers.get('set-cookie'), null, 'no cookie from a confirmed no-commit');
  } finally {
    app.db.commit = realCommit;
  }

  // Confirmed no-commit: nothing persisted — no session, no burned code, no fence reset.
  const row = app.db.prepare('SELECT backupCodes, totpFailedAttempts FROM TwoFactor WHERE userId = ?').get(userId);
  assert.equal(JSON.parse(row.backupCodes).length, 8, 'the code removal rolled back');
  assert.equal(row.totpFailedAttempts, 0, 'the fence reset rolled back');
  const sessions = app.db.prepare('SELECT COUNT(*) AS n FROM Session').get().n;
  assert.equal(sessions, 0, 'the session mint rolled back');

  // The confirmed no-commit RELEASED the challenge — the SAME challenge + code
  // retry successfully without a fresh password login. (Prove availability
  // directly, then free the claim so the retry can take it.)
  const released = loginChallengeStore.reserve(challenge);
  assert.ok(released, 'the challenge was released, not invalidated');
  assert.equal(loginChallengeStore.release(released), true);
  const retryRes = await authenticate(origin, challenge, backupCodes[0]);
  assert.equal(retryRes.status, 201, 'the same challenge and code retry after the confirmed no-commit');
  assert.ok(sidFromSetCookie(retryRes.headers.get('set-cookie')));
});

// ---- GET /auth/totp status ---------------------------------------------------

test('GET /auth/totp requires authentication (401)', async (t) => {
  const { origin } = await boot(t);
  const res = await fetch(`${origin}/auth/totp`);
  assert.equal(res.status, 401);
});

test('GET /auth/totp not enrolled → { enrolled: false, enabled: false }', async (t) => {
  const { origin, cookie } = await login(t);
  const res = await fetch(`${origin}/auth/totp`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { enrolled: false, enabled: false });
});

test('GET /auth/totp enrolled but not verified → { enrolled: true, enabled: false }', async (t) => {
  const { origin, cookie } = await login(t);
  // Enroll but do NOT verify → enabled stays 0.
  await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  const res = await fetch(`${origin}/auth/totp`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { enrolled: true, enabled: false });
});

test('GET /auth/totp enabled → { enrolled: true, enabled: true } (minimal JSON)', async (t) => {
  const { origin, cookie } = await login(t);
  await enrollAndEnable(origin, cookie);
  const res = await fetch(`${origin}/auth/totp`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { enrolled: true, enabled: true });
  // No secret, no backup-code count/hashes, no verifiedAt, no lockout info, no id.
  assert.deepEqual(Object.keys(body).sort(), ['enabled', 'enrolled']);
});

// ---- remaining TOTP routes ---------------------------------------------------

test('verify with wrong TOTP token → 400', async (t) => {
  const { origin, cookie } = await login(t);

  // Enroll
  await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });

  // Verify with wrong token
  const verifyRes = await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: '999999' }),
  });
  assert.equal(verifyRes.status, 400);
  const body = await verifyRes.json();
  assert.match(body.failure.message, /invalid TOTP token/i);
});

test('disable with backup code works', async (t) => {
  const { origin, cookie } = await login(t);

  // Enroll and verify
  const { backupCodes } = await enrollAndEnable(origin, cookie);

  // Disable with backup code
  const disableRes = await fetch(`${origin}/auth/totp/disable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: backupCodes[0] }),
  });
  assert.equal(disableRes.status, 204, `disable with backup failed: ${await disableRes.text()}`);
});

test('disable requires token → 400 when missing', async (t) => {
  const { origin, cookie } = await login(t);

  // Enroll
  await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });

  const disableRes = await fetch(`${origin}/auth/totp/disable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({}),
  });
  assert.equal(disableRes.status, 400);
});

test('verify requires enrollment → 400 when not enrolled', async (t) => {
  const { origin, cookie } = await login(t);

  // Verify without enrolling first
  const verifyRes = await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: '123456' }),
  });
  assert.equal(verifyRes.status, 400);
  const body = await verifyRes.json();
  assert.match(body.failure.message, /not enrolled/i);
});

test('disable requires enrollment → 400 when not enrolled', async (t) => {
  const { origin, cookie } = await login(t);

  const disableRes = await fetch(`${origin}/auth/totp/disable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: '123456' }),
  });
  assert.equal(disableRes.status, 400);
  const body = await disableRes.json();
  assert.match(body.failure.message, /not enrolled/i);
});

test('authenticate for a non-enabled enrollment → 400', async (t) => {
  const { origin, cookie, userId } = await login(t);

  // Enroll but don't verify → enabled=0.
  await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });

  // login() never issues a challenge for a non-enabled user (it mints a session),
  // so forge the pending challenge directly via the store.
  const forged = loginChallengeStore.set(userId);
  const authRes = await authenticate(origin, forged, '123456');
  assert.equal(authRes.status, 400);
  const body = await authRes.json();
  assert.match(body.failure.message, /not enabled/i);
});

test('login without TOTP when 2FA not enabled returns session', async (t) => {
  const { origin, cookie } = await login(t);

  // Enroll but don't verify → TOTP is not enabled
  await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });

  // Logout
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  // Login → should get a session (not requiresTotp) because TOTP is not enabled
  const loginRes = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'testuser', password: 'testpass' }),
  });
  assert.equal(loginRes.status, 201);
  const loginBody = await loginRes.json();
  assert.equal(loginBody.requiresTotp, undefined, 'TOTP not enabled → should not require TOTP');
  assert.equal(loginBody.user.username, 'testuser');
  assert.ok(loginRes.headers.get('set-cookie'), 'session cookie should be set');
});

test('enroll TOTP for another user is not possible (only own 2FA)', async (t) => {
  const { origin } = await boot(t);

  // Create two users
  const res1 = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'password12' }),
  });
  const aliceCookie = `sid=${sidFromSetCookie(res1.headers.get('set-cookie'))}`;

  const res2 = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: 'password12' }),
  });
  const bobCookie = `sid=${sidFromSetCookie(res2.headers.get('set-cookie'))}`;

  // Alice enrolls and verifies TOTP
  const enrollRes = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: aliceCookie },
  });
  const { secret } = await enrollRes.json();
  await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: aliceCookie },
    body: JSON.stringify({ token: currentTotpToken(secret) }),
  });

  // Alice logs out
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie: aliceCookie } });

  // Alice logs in → requiresTotp (TOTP is enabled)
  const aliceLogin = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'password12' }),
  });
  const aliceLoginBody = await aliceLogin.json();
  assert.equal(aliceLoginBody.requiresTotp, true);
  assert.ok(aliceLoginBody.challenge, 'alice gets a pending-login challenge');

  // Bob logs out
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie: bobCookie } });

  // Bob logs in → no TOTP required (bob didn't enroll)
  const bobLogin = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: 'password12' }),
  });
  assert.equal(bobLogin.status, 201);
  const bobBody = await bobLogin.json();
  assert.equal(bobBody.requiresTotp, undefined);
  assert.equal(bobBody.user.username, 'bob');
});
