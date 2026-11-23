// passkey.test.mjs — WebAuthn (passkey) challenge, verification, and HTTP
// integration tests. Zero external dependencies; `node:crypto` only.
//
// Tests exercise the passkey module directly (challenge lifecycle, registration,
// authentication, counter replay) and via HTTP integration (the framework-owned
// /auth/passkey routes: challenge → register → authenticate → list → delete).

import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import workbench from '../build/app.mjs';
import { SESSION_COOKIE } from '../build/auth/session.mjs';
import {
  generateChallenge,
  createChallengeStore,
  parseClientDataJSON,
  parseAuthenticatorData,
  buildClientDataJSON,
  buildAuthenticatorData,
  buildRpIdHash,
  signAssertion,
  cosePublicKeyFromKeyPair,
  buildAttestationObject,
  verifyRegistration,
  verifyAuthentication,
  rpConfig,
  challengeStore,
} from '../build/auth/passkey.mjs';

// ---- helpers -----------------------------------------------------------------

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

// Generate a fresh EC P-256 keypair and export the public key as SPKI base64url.
function generateTestKeypair() {
  const keypair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = keypair.publicKey.export({ format: 'der', type: 'spki' });
  return { keypair, spki: spki.toString('base64url') };
}

// Sleep helper for timing-based tests.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- challenge lifecycle ----------------------------------------------------

test('generateChallenge produces a base64url string of the requested length', () => {
  const c = generateChallenge(32);
  assert.equal(typeof c, 'string');
  // base64url of 32 bytes = ceil(32/3)*4 = 44 chars (no padding)
  assert.ok(c.length >= 42 && c.length <= 44);
  // unique
  const c2 = generateChallenge(32);
  assert.notEqual(c, c2);
});

test('challengeStore sets, gets, and expires entries', async () => {
  const store = createChallengeStore(50); // 50ms TTL
  const c = generateChallenge();
  store.set(c, { foo: 'bar' });
  const entry = store.get(c);
  assert.notEqual(entry, null);
  assert.equal(entry.foo, 'bar');

  await sleep(60);
  const expired = store.get(c);
  assert.equal(expired, null, 'expired challenge returns null');

  store.destroy();
});

test('challengeStore.consume reads once then deletes', () => {
  const store = createChallengeStore(5000);
  const c = generateChallenge();
  store.set(c);
  const first = store.consume(c);
  assert.notEqual(first, null);
  const second = store.consume(c);
  assert.equal(second, null, 'consume is single-use');
  store.destroy();
});

test('parseClientDataJSON decodes base64url JSON', () => {
  const cd = buildClientDataJSON({
    challenge: 'test-challenge',
    origin: 'http://localhost:3000',
    type: 'webauthn.create',
  });
  const parsed = parseClientDataJSON(cd);
  assert.equal(parsed.challenge, 'test-challenge');
  assert.equal(parsed.origin, 'http://localhost:3000');
  assert.equal(parsed.type, 'webauthn.create');
});

test('parseAuthenticatorData extracts rpIdHash, flags, and signCount', () => {
  const rpIdHash = buildRpIdHash('localhost');
  const ad = buildAuthenticatorData({
    rpIdHash,
    flags: 0x45, // UP + UV + AT
    signCount: 42,
  });
  const parsed = parseAuthenticatorData(ad);
  assert.deepEqual(parsed.rpIdHash, rpIdHash);
  assert.equal(parsed.flags, 0x45);
  assert.equal(parsed.signCount, 42);
});

// ---- registration verification ----------------------------------------------

test('verifyRegistration accepts a valid attestation', () => {
  const { keypair, spki } = generateTestKeypair();
  const challenge = generateChallenge();
  const rp = rpConfig({});

  const clientDataJSON = buildClientDataJSON({
    challenge,
    origin: rp.origin,
    type: 'webauthn.create',
  });

  const rpIdHash = buildRpIdHash(rp.id);
  const credentialId = generateChallenge(32);
  const cosePk = cosePublicKeyFromKeyPair(keypair);

  const authData = buildAuthenticatorData({
    rpIdHash,
    flags: 0x45, // UP + UV + AT
    signCount: 0,
    credentialId,
    publicKey: cosePk,
  });

  const attestationObject = buildAttestationObject({ fmt: 'none', authData });

  const result = verifyRegistration(challenge, {
    id: credentialId,
    rawId: credentialId,
    response: { clientDataJSON, attestationObject },
    type: 'public-key',
  }, rp);

  assert.equal(result.credentialId, credentialId);
  assert.equal(result.publicKey, spki);
  assert.equal(result.signCount, 0);
});

// ---- #245: attestation structure / fmt fail-closed ---------------------------

// A synthetic `fmt: none` registration credential. `overrides` lets a test
// corrupt exactly one part of the ceremony while every other check stays valid.
function syntheticRegistration(challenge, rp, overrides = {}) {
  const keypair = overrides.keypair ?? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = overrides.credentialId ?? generateChallenge(32);
  const clientDataJSON = buildClientDataJSON({ challenge, origin: rp.origin, type: 'webauthn.create' });
  const authData = buildAuthenticatorData({
    rpIdHash: buildRpIdHash(rp.id),
    flags: 0x45, // UP + UV + AT
    signCount: 0,
    credentialId,
    publicKey: cosePublicKeyFromKeyPair(keypair),
  });
  const attestationObject = buildAttestationObject({
    fmt: 'fmt' in overrides ? overrides.fmt : 'none',
    attStmt: 'attStmt' in overrides ? overrides.attStmt : {},
    authData: overrides.authData ?? authData,
  });
  return {
    credentialId,
    credential: {
      id: 'id' in overrides ? overrides.id : credentialId,
      rawId: 'rawId' in overrides ? overrides.rawId : credentialId,
      response: {
        clientDataJSON,
        attestationObject: overrides.attestationObject ?? attestationObject,
      },
      type: 'public-key',
    },
  };
}

test('#245: verifyRegistration accepts fmt "none" with an empty attStmt', () => {
  const rp = rpConfig({});
  const challenge = generateChallenge();
  const { credential, credentialId } = syntheticRegistration(challenge, rp);
  const result = verifyRegistration(challenge, credential, rp);
  assert.equal(result.credentialId, credentialId);
});

test('#245: verifyRegistration rejects unsupported attestation formats', () => {
  const rp = rpConfig({});
  const challenge = generateChallenge();
  for (const fmt of ['packed', 'tpm', 'fido-u2f', 'android-key']) {
    const { credential } = syntheticRegistration(challenge, rp, { fmt });
    assert.throws(
      () => verifyRegistration(challenge, credential, rp),
      /unsupported attestation format/,
      `fmt ${fmt} must be rejected`,
    );
  }
});

test('#245: verifyRegistration rejects malformed attestation structure', () => {
  const rp = rpConfig({});
  const challenge = generateChallenge();
  for (const fmt of ['', 42, null]) {
    const { credential } = syntheticRegistration(challenge, rp, { fmt });
    assert.throws(() => verifyRegistration(challenge, credential, rp), /fmt/);
  }
  // WebAuthn requires an empty attStmt for 'none'.
  const withStmt = syntheticRegistration(challenge, rp, { attStmt: { sig: Buffer.from([1]) } });
  assert.throws(() => verifyRegistration(challenge, withStmt.credential, rp), /empty attStmt/);
  // A second CBOR item after the attestation object is trailing garbage.
  const { credential } = syntheticRegistration(challenge, rp);
  const trailing = Buffer.concat([
    Buffer.from(credential.response.attestationObject, 'base64url'),
    Buffer.from([0x00]),
  ]).toString('base64url');
  credential.response.attestationObject = trailing;
  assert.throws(() => verifyRegistration(challenge, credential, rp), /trailing data/);
});

test('#245: verifyRegistration rejects a client id that does not match attested data', () => {
  const rp = rpConfig({});
  const challenge = generateChallenge();
  const byId = syntheticRegistration(challenge, rp, { id: generateChallenge(32) });
  assert.throws(() => verifyRegistration(challenge, byId.credential, rp), /does not match attested/);
  const byRawId = syntheticRegistration(challenge, rp, { rawId: generateChallenge(32) });
  assert.throws(() => verifyRegistration(challenge, byRawId.credential, rp), /does not match attested/);
});

test('verifyRegistration rejects challenge mismatch', () => {
  const { keypair } = generateTestKeypair();
  const rp = rpConfig({});

  const clientDataJSON = buildClientDataJSON({
    challenge: 'wrong-challenge',
    origin: rp.origin,
    type: 'webauthn.create',
  });

  const rpIdHash = buildRpIdHash(rp.id);
  const credentialId = generateChallenge(32);
  const cosePk = cosePublicKeyFromKeyPair(keypair);

  const authData = buildAuthenticatorData({
    rpIdHash,
    flags: 0x45,
    signCount: 0,
    credentialId,
    publicKey: cosePk,
  });

  const attestationObject = buildAttestationObject({ fmt: 'none', authData });

  assert.throws(
    () => verifyRegistration('expected', {
      id: credentialId,
      rawId: credentialId,
      response: { clientDataJSON, attestationObject },
      type: 'public-key',
    }, rp),
    /challenge mismatch/,
  );
});

test('verifyRegistration rejects origin mismatch', () => {
  const { keypair } = generateTestKeypair();
  const challenge = generateChallenge();
  const rp = rpConfig({});

  const clientDataJSON = buildClientDataJSON({
    challenge,
    origin: 'https://evil.com',
    type: 'webauthn.create',
  });

  assert.throws(
    () => verifyRegistration(challenge, {
      id: 'x',
      rawId: 'x',
      response: { clientDataJSON, attestationObject: buildAttestationObject({ fmt: 'none', authData: buildAuthenticatorData({ rpIdHash: buildRpIdHash(rp.id), flags: 0x45, signCount: 0, credentialId: generateChallenge(32), publicKey: cosePublicKeyFromKeyPair(keypair) }) }) },
      type: 'public-key',
    }, rp),
    /origin mismatch/,
  );
});

test('verifyRegistration rejects RP ID hash mismatch', () => {
  const { keypair } = generateTestKeypair();
  const challenge = generateChallenge();
  const rp = rpConfig({ rp: { id: 'evil.com', origin: 'https://evil.com' } });

  const clientDataJSON = buildClientDataJSON({
    challenge,
    origin: rp.origin,
    type: 'webauthn.create',
  });

  const rpIdHash = buildRpIdHash('localhost'); // wrong RP ID
  const credentialId = generateChallenge(32);
  const cosePk = cosePublicKeyFromKeyPair(keypair);

  const authData = buildAuthenticatorData({
    rpIdHash,
    flags: 0x45,
    signCount: 0,
    credentialId,
    publicKey: cosePk,
  });

  assert.throws(
    () => verifyRegistration(challenge, {
      id: credentialId,
      rawId: credentialId,
      response: { clientDataJSON, attestationObject: buildAttestationObject({ fmt: 'none', authData }) },
      type: 'public-key',
    }, rp),
    /RP ID hash mismatch/,
  );
});

// ---- authentication verification --------------------------------------------

test('verifyAuthentication accepts a valid assertion', () => {
  const { keypair, spki } = generateTestKeypair();
  const challenge = generateChallenge();
  const rp = rpConfig({});
  const credentialId = generateChallenge(32);

  const clientDataJSON = buildClientDataJSON({
    challenge,
    origin: rp.origin,
    type: 'webauthn.get',
  });

  const authData = buildAuthenticatorData({
    rpIdHash: buildRpIdHash(rp.id),
    flags: 0x05, // UP + UV
    signCount: 1,
  });

  const signature = signAssertion(keypair.privateKey, authData, clientDataJSON);

  const result = verifyAuthentication(challenge, {
    id: credentialId,
    rawId: credentialId,
    response: {
      clientDataJSON,
      authenticatorData: authData.toString('base64url'),
      signature,
      userHandle: null,
    },
    type: 'public-key',
  }, {
    credentialId,
    publicKey: spki,
    signCount: 0,
  }, rp);

  assert.equal(result.signCount, 1);
});

test('verifyAuthentication rejects bad signature', () => {
  const { keypair, spki } = generateTestKeypair();
  const challenge = generateChallenge();
  const rp = rpConfig({});
  const credentialId = generateChallenge(32);

  const clientDataJSON = buildClientDataJSON({
    challenge,
    origin: rp.origin,
    type: 'webauthn.get',
  });

  const authData = buildAuthenticatorData({
    rpIdHash: buildRpIdHash(rp.id),
    flags: 0x05,
    signCount: 1,
  });

  // Sign with a DIFFERENT keypair
  const otherKeypair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const badSig = signAssertion(otherKeypair.privateKey, authData, clientDataJSON);

  assert.throws(
    () => verifyAuthentication(challenge, {
      id: credentialId,
      rawId: credentialId,
      response: {
        clientDataJSON,
        authenticatorData: authData.toString('base64url'),
        signature: badSig,
        userHandle: null,
      },
      type: 'public-key',
    }, {
      credentialId,
      publicKey: spki,
      signCount: 0,
    }, rp),
    /invalid signature/,
  );
});

test('verifyAuthentication rejects counter ≤ stored counter (replay protection)', () => {
  const { keypair, spki } = generateTestKeypair();
  const challenge = generateChallenge();
  const rp = rpConfig({});
  const credentialId = generateChallenge(32);

  const clientDataJSON = buildClientDataJSON({
    challenge,
    origin: rp.origin,
    type: 'webauthn.get',
  });

  const authData = buildAuthenticatorData({
    rpIdHash: buildRpIdHash(rp.id),
    flags: 0x05,
    signCount: 1,
  });

  const signature = signAssertion(keypair.privateKey, authData, clientDataJSON);

  // Stored counter is 5, received is 1 — should reject
  assert.throws(
    () => verifyAuthentication(challenge, {
      id: credentialId,
      rawId: credentialId,
      response: {
        clientDataJSON,
        authenticatorData: authData.toString('base64url'),
        signature,
        userHandle: null,
      },
      type: 'public-key',
    }, {
      credentialId,
      publicKey: spki,
      signCount: 5, // higher than received
    }, rp),
    /counter not incremented/,
  );

  // Both zero is allowed (first use)
  const authDataZero = buildAuthenticatorData({
    rpIdHash: buildRpIdHash(rp.id),
    flags: 0x05,
    signCount: 0,
  });
  const sigZero = signAssertion(keypair.privateKey, authDataZero, clientDataJSON);

  const result = verifyAuthentication(challenge, {
    id: credentialId,
    rawId: credentialId,
    response: {
      clientDataJSON,
      authenticatorData: authDataZero.toString('base64url'),
      signature: sigZero,
      userHandle: null,
    },
    type: 'public-key',
  }, {
    credentialId,
    publicKey: spki,
    signCount: 0, // both zero = ok
  }, rp);

  assert.equal(result.signCount, 0);
});

// ---- RP config ---------------------------------------------------------------

test('rpConfig returns defaults when no overrides', () => {
  const rp = rpConfig({});
  assert.equal(rp.name, 'workbench');
  assert.equal(rp.id, 'localhost');
  assert.equal(rp.origin, 'http://localhost:3000');
});

test('rpConfig accepts overrides', () => {
  const rp = rpConfig({ rp: { name: 'MyApp', id: 'example.com', origin: 'https://example.com' } });
  assert.equal(rp.name, 'MyApp');
  assert.equal(rp.id, 'example.com');
  assert.equal(rp.origin, 'https://example.com');
});

// ---- HTTP integration -------------------------------------------------------
// Tests that exercise the live /auth/passkey routes.

test('GET /auth/passkey/challenge returns a challenge and rp info', async (t) => {
  const { origin } = await boot(t);
  const res = await fetch(`${origin}/auth/passkey/challenge`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(typeof body.challenge === 'string' && body.challenge.length > 0);
  assert.equal(body.rp.name, 'workbench');
  assert.equal(body.rp.id, 'localhost');
});

test('POST /auth/passkey/register rejects without an existing session', async (t) => {
  const { origin } = await boot(t);
  const res = await fetch(`${origin}/auth/passkey/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: {} }),
  });
  assert.equal(res.status, 401, 'requireUser gate should reject anonymous');
});

test('passkey register + authenticate + list + delete round-trip', async (t) => {
  const { origin } = await boot(t);

  // 1. Password-login to get a session (needed for register)
  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: 'passkey-test' }),
  });
  assert.equal(loginRes.status, 201);
  const cookie = `sid=${sidFromSetCookie(loginRes.headers.get('set-cookie'))}`;

  // 2. Request a challenge for registration
  const regChallengeRes = await fetch(`${origin}/auth/passkey/challenge`);
  const { challenge: regChallenge } = await regChallengeRes.json();

  // 3. Build synthetic registration credential
  const { keypair, spki } = generateTestKeypair();
  const rp = rpConfig({});
  const credentialId = generateChallenge(32);
  const cosePk = cosePublicKeyFromKeyPair(keypair);

  const regClientData = buildClientDataJSON({
    challenge: regChallenge,
    origin: rp.origin,
    type: 'webauthn.create',
  });

  const regAuthData = buildAuthenticatorData({
    rpIdHash: buildRpIdHash(rp.id),
    flags: 0x45,
    signCount: 0,
    credentialId,
    publicKey: cosePk,
  });

  const regAttestation = buildAttestationObject({ fmt: 'none', authData: regAuthData });

  // 4. Register the passkey
  const regRes = await fetch(`${origin}/auth/passkey/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      credential: {
        id: credentialId,
        rawId: credentialId,
        response: {
          clientDataJSON: regClientData,
          attestationObject: regAttestation,
        },
        type: 'public-key',
        name: 'Test Key',
        transports: ['internal'],
      },
    }),
  });
  assert.equal(regRes.status, 201, `register failed: ${await regRes.text()}`);

  // 5. List credentials — should include the one we just registered
  const listRes = await fetch(`${origin}/auth/passkey`, { headers: { cookie } });
  assert.equal(listRes.status, 200);
  const creds = await listRes.json();
  assert.equal(creds.length, 1);
  assert.equal(creds[0].credentialId, credentialId);
  assert.equal(creds[0].name, 'Test Key');

  // 6. Logout to clear the session
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  // 7. Request a challenge for authentication (anonymous, no session)
  const authChallengeRes = await fetch(`${origin}/auth/passkey/challenge`);
  const { challenge: authChallenge } = await authChallengeRes.json();

  // 8. Build authentication assertion
  const authClientData = buildClientDataJSON({
    challenge: authChallenge,
    origin: rp.origin,
    type: 'webauthn.get',
  });

  const authAuthData = buildAuthenticatorData({
    rpIdHash: buildRpIdHash(rp.id),
    flags: 0x05,
    signCount: 1,
  });

  const authSig = signAssertion(keypair.privateKey, authAuthData, authClientData);

  // 9. Authenticate with passkey
  const authRes = await fetch(`${origin}/auth/passkey/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      credential: {
        id: credentialId,
        rawId: credentialId,
        response: {
          clientDataJSON: authClientData,
          authenticatorData: authAuthData.toString('base64url'),
          signature: authSig,
          userHandle: null,
        },
        type: 'public-key',
      },
    }),
  });
  assert.equal(authRes.status, 201);
  const authBody = await authRes.json();
  assert.equal(authBody.user.username, 'bob');

  // 10. Verify session cookie was set
  const authCookie = authRes.headers.get('set-cookie');
  assert.ok(authCookie, 'authenticate sets a Set-Cookie');
  const newSid = sidFromSetCookie(authCookie);
  assert.ok(newSid);

  // 11. Delete the passkey credential
  const deleteRes = await fetch(`${origin}/auth/passkey/${encodeURIComponent(credentialId)}`, {
    method: 'DELETE',
    headers: { cookie: `sid=${newSid}` },
  });
  assert.equal(deleteRes.status, 204);

  // 12. List should be empty now
  const listAfter = await fetch(`${origin}/auth/passkey`, { headers: { cookie: `sid=${newSid}` } });
  const credsAfter = await listAfter.json();
  assert.equal(credsAfter.length, 0);
});

// #245: an attacker who knows a victim's credentialId must not be able to
// register a second key under it and shadow/lock out the victim's passkey.
test('#245: registering a duplicate credentialId is rejected before storing', async (t) => {
  const { origin } = await boot(t);

  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'dup-owner', password: 'passkey-test' }),
  });
  assert.equal(loginRes.status, 201);
  const cookie = `sid=${sidFromSetCookie(loginRes.headers.get('set-cookie'))}`;

  const rp = rpConfig({});
  const credentialId = generateChallenge(32);

  async function registerWithFreshChallenge() {
    const challengeRes = await fetch(`${origin}/auth/passkey/challenge`);
    const { challenge } = await challengeRes.json();
    const keypair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const clientDataJSON = buildClientDataJSON({ challenge, origin: rp.origin, type: 'webauthn.create' });
    const authData = buildAuthenticatorData({
      rpIdHash: buildRpIdHash(rp.id),
      flags: 0x45,
      signCount: 0,
      credentialId,
      publicKey: cosePublicKeyFromKeyPair(keypair),
    });
    const attestationObject = buildAttestationObject({ fmt: 'none', authData });
    return fetch(`${origin}/auth/passkey/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        credential: {
          id: credentialId,
          rawId: credentialId,
          response: { clientDataJSON, attestationObject },
          type: 'public-key',
        },
      }),
    });
  }

  const first = await registerWithFreshChallenge();
  assert.equal(first.status, 201, `first register failed: ${await first.text()}`);

  const duplicate = await registerWithFreshChallenge();
  assert.equal(duplicate.status, 409, `duplicate register was not rejected: ${await duplicate.text()}`);

  const listRes = await fetch(`${origin}/auth/passkey`, { headers: { cookie } });
  const creds = await listRes.json();
  assert.equal(creds.length, 1, 'the original credential was not shadowed');
  assert.equal(creds[0].credentialId, credentialId);
});

test('register without a name keeps it absent and lists name: null (#231)', async (t) => {
  const { origin } = await boot(t);

  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'noname', password: 'password12' }),
  });
  const cookie = `sid=${sidFromSetCookie(loginRes.headers.get('set-cookie'))}`;

  const { keypair, spki } = generateTestKeypair();
  const rp = rpConfig({});
  const credentialId = generateChallenge(32);
  const regChallengeRes = await fetch(`${origin}/auth/passkey/challenge`);
  const { challenge } = await regChallengeRes.json();

  const cd = buildClientDataJSON({ challenge, origin: rp.origin, type: 'webauthn.create' });
  const ad = buildAuthenticatorData({ rpIdHash: buildRpIdHash(rp.id), flags: 0x45, signCount: 0, credentialId, publicKey: cosePublicKeyFromKeyPair(keypair) });
  const att = buildAttestationObject({ fmt: 'none', authData: ad });

  // A browser RegistrationResponseJSON carries id/rawId/response/type and NO
  // name — the omitted name must stay absent, never become "Passkey".
  const regRes = await fetch(`${origin}/auth/passkey/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      credential: {
        id: credentialId,
        rawId: credentialId,
        response: { clientDataJSON: cd, attestationObject: att },
        type: 'public-key',
      },
    }),
  });
  assert.equal(regRes.status, 201, `register failed: ${await regRes.text()}`);

  const listRes = await fetch(`${origin}/auth/passkey`, { headers: { cookie } });
  assert.equal(listRes.status, 200);
  const [stored] = await listRes.json();
  assert.equal(stored.credentialId, credentialId);
  assert.equal(stored.name, null, 'an unnamed credential lists name: null, never a fabricated label');
  // The rest of the list contract is retained.
  assert.ok(Object.hasOwn(stored, 'createdAt'));
  assert.ok(Object.hasOwn(stored, 'backedUp'));
  assert.deepEqual(stored.transports, [], 'no transports supplied → empty array');
  assert.ok(spki.length > 0);
});

test('register with a blank name keeps it absent (#231)', async (t) => {
  const { origin } = await boot(t);

  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'blankname', password: 'password12' }),
  });
  const cookie = `sid=${sidFromSetCookie(loginRes.headers.get('set-cookie'))}`;

  const { keypair } = generateTestKeypair();
  const rp = rpConfig({});
  const credentialId = generateChallenge(32);
  const { challenge } = await (await fetch(`${origin}/auth/passkey/challenge`)).json();

  const cd = buildClientDataJSON({ challenge, origin: rp.origin, type: 'webauthn.create' });
  const ad = buildAuthenticatorData({ rpIdHash: buildRpIdHash(rp.id), flags: 0x45, signCount: 0, credentialId, publicKey: cosePublicKeyFromKeyPair(keypair) });
  const att = buildAttestationObject({ fmt: 'none', authData: ad });

  // Whitespace-only input is not a meaningful name — it must stay absent, not
  // be stored as a blank or coerced to "Passkey".
  const regRes = await fetch(`${origin}/auth/passkey/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      credential: {
        id: credentialId,
        rawId: credentialId,
        response: { clientDataJSON: cd, attestationObject: att },
        type: 'public-key',
        name: '   ',
      },
    }),
  });
  assert.equal(regRes.status, 201, `register failed: ${await regRes.text()}`);

  const [stored] = await (await fetch(`${origin}/auth/passkey`, { headers: { cookie } })).json();
  assert.equal(stored.credentialId, credentialId);
  assert.equal(stored.name, null, 'a blank name stays absent, never a fabricated label');
});

test('register with a supplied name stores it trimmed and round-trips (#231)', async (t) => {
  const { origin } = await boot(t);

  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'named', password: 'password12' }),
  });
  const cookie = `sid=${sidFromSetCookie(loginRes.headers.get('set-cookie'))}`;

  const { keypair } = generateTestKeypair();
  const rp = rpConfig({});
  const credentialId = generateChallenge(32);
  const { challenge } = await (await fetch(`${origin}/auth/passkey/challenge`)).json();

  const cd = buildClientDataJSON({ challenge, origin: rp.origin, type: 'webauthn.create' });
  const ad = buildAuthenticatorData({ rpIdHash: buildRpIdHash(rp.id), flags: 0x45, signCount: 0, credentialId, publicKey: cosePublicKeyFromKeyPair(keypair) });
  const att = buildAttestationObject({ fmt: 'none', authData: ad });

  const regRes = await fetch(`${origin}/auth/passkey/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      credential: {
        id: credentialId,
        rawId: credentialId,
        response: { clientDataJSON: cd, attestationObject: att },
        type: 'public-key',
        name: '  My YubiKey  ',
        transports: ['usb', 'nfc'],
      },
    }),
  });
  assert.equal(regRes.status, 201, `register failed: ${await regRes.text()}`);

  const [stored] = await (await fetch(`${origin}/auth/passkey`, { headers: { cookie } })).json();
  assert.equal(stored.name, 'My YubiKey', 'an explicit name is preserved, trimmed of surrounding space');
  assert.deepEqual(stored.transports, ['usb', 'nfc'], 'supplied transports still round-trip');
});

test('authenticate with a wrong credential ID fails', async (t) => {
  const { origin } = await boot(t);

  // Login and register a passkey
  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'testpass1' }),
  });
  const cookie = `sid=${sidFromSetCookie(loginRes.headers.get('set-cookie'))}`;

  const { keypair } = generateTestKeypair();
  const rp = rpConfig({});
  const credentialId = generateChallenge(32);
  const cosePk = cosePublicKeyFromKeyPair(keypair);

  const regChallengeRes = await fetch(`${origin}/auth/passkey/challenge`);
  const { challenge: regCh } = await regChallengeRes.json();

  const regCD = buildClientDataJSON({ challenge: regCh, origin: rp.origin, type: 'webauthn.create' });
  const regAD = buildAuthenticatorData({ rpIdHash: buildRpIdHash(rp.id), flags: 0x45, signCount: 0, credentialId, publicKey: cosePk });
  const regAtt = buildAttestationObject({ fmt: 'none', authData: regAD });

  await fetch(`${origin}/auth/passkey/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      credential: { id: credentialId, rawId: credentialId, response: { clientDataJSON: regCD, attestationObject: regAtt }, type: 'public-key' },
    }),
  });

  // Try to authenticate with a wrong credential ID
  const authChRes = await fetch(`${origin}/auth/passkey/challenge`);
  const { challenge: authCh } = await authChRes.json();

  const res = await fetch(`${origin}/auth/passkey/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      credential: { id: 'nonexistent-id', rawId: 'nonexistent-id', response: { clientDataJSON: '{}', authenticatorData: '', signature: '' }, type: 'public-key' },
    }),
  });
  assert.equal(res.status, 400);
});

test('authenticate with an expired challenge fails', async (t) => {
  const { origin } = await boot(t);

  const chRes = await fetch(`${origin}/auth/passkey/challenge`);
  const { challenge } = await chRes.json();

  // Consume the challenge ourselves to force expiry
  const entry = challengeStore.consume(challenge);
  assert.notEqual(entry, null);

  const { keypair } = generateTestKeypair();
  const rp = rpConfig({});

  const clientDataJSON = buildClientDataJSON({ challenge, origin: rp.origin, type: 'webauthn.get' });
  const authData = buildAuthenticatorData({
    rpIdHash: buildRpIdHash(rp.id),
    flags: 0x05,
    signCount: 1,
  });
  const signature = signAssertion(keypair.privateKey, authData, clientDataJSON);

  const res = await fetch(`${origin}/auth/passkey/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      credential: {
        id: 'any',
        rawId: 'any',
        response: {
          clientDataJSON,
          authenticatorData: authData.toString('base64url'),
          signature,
        },
        type: 'public-key',
      },
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.failure.message, /unknown or expired challenge/i);
});

test('delete a credential that does not exist returns 404', async (t) => {
  const { origin } = await boot(t);

  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'deletor', password: 'password12' }),
  });
  const cookie = `sid=${sidFromSetCookie(loginRes.headers.get('set-cookie'))}`;

  const res = await fetch(`${origin}/auth/passkey/nonexistent-cred`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(res.status, 404);
});

test('delete another user\'s credential returns 403', async (t) => {
  const { origin } = await boot(t);

  // Alice registers a passkey
  const aliceLogin = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'password12' }),
  });
  const aliceCookie = `sid=${sidFromSetCookie(aliceLogin.headers.get('set-cookie'))}`;

  const { keypair } = generateTestKeypair();
  const rp = rpConfig({});
  const credentialId = generateChallenge(32);

  const chRes = await fetch(`${origin}/auth/passkey/challenge`);
  const { challenge } = await chRes.json();

  const cd = buildClientDataJSON({ challenge, origin: rp.origin, type: 'webauthn.create' });
  const ad = buildAuthenticatorData({ rpIdHash: buildRpIdHash(rp.id), flags: 0x45, signCount: 0, credentialId, publicKey: cosePublicKeyFromKeyPair(keypair) });
  const att = buildAttestationObject({ fmt: 'none', authData: ad });

  await fetch(`${origin}/auth/passkey/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: aliceCookie },
    body: JSON.stringify({
      credential: { id: credentialId, rawId: credentialId, response: { clientDataJSON: cd, attestationObject: att }, type: 'public-key' },
    }),
  });

  // Bob tries to delete Alice's credential
  const bobLogin = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: 'password12' }),
  });
  const bobCookie = `sid=${sidFromSetCookie(bobLogin.headers.get('set-cookie'))}`;

  const res = await fetch(`${origin}/auth/passkey/${encodeURIComponent(credentialId)}`, {
    method: 'DELETE',
    headers: { cookie: bobCookie },
  });
  assert.equal(res.status, 403);
});

test('authenticate mints a session cookie with correct attributes', async (t) => {
  const { origin } = await boot(t);

  // Register a passkey
  const loginRes = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'user', password: 'password12' }),
  });
  const cookie = `sid=${sidFromSetCookie(loginRes.headers.get('set-cookie'))}`;

  const { keypair } = generateTestKeypair();
  const rp = rpConfig({});
  const credentialId = generateChallenge(32);

  const regChRes = await fetch(`${origin}/auth/passkey/challenge`);
  const { challenge: regCh } = await regChRes.json();
  const regCD = buildClientDataJSON({ challenge: regCh, origin: rp.origin, type: 'webauthn.create' });
  const regAD = buildAuthenticatorData({ rpIdHash: buildRpIdHash(rp.id), flags: 0x45, signCount: 0, credentialId, publicKey: cosePublicKeyFromKeyPair(keypair) });
  const regAtt = buildAttestationObject({ fmt: 'none', authData: regAD });
  await fetch(`${origin}/auth/passkey/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ credential: { id: credentialId, rawId: credentialId, response: { clientDataJSON: regCD, attestationObject: regAtt }, type: 'public-key' } }),
  });

  // Logout
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  // Authenticate with passkey
  const authChRes = await fetch(`${origin}/auth/passkey/challenge`);
  const { challenge: authCh } = await authChRes.json();
  const authCD = buildClientDataJSON({ challenge: authCh, origin: rp.origin, type: 'webauthn.get' });
  const authAD = buildAuthenticatorData({ rpIdHash: buildRpIdHash(rp.id), flags: 0x05, signCount: 1 });
  const authSig = signAssertion(keypair.privateKey, authAD, authCD);

  const authRes = await fetch(`${origin}/auth/passkey/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      credential: { id: credentialId, rawId: credentialId, response: { clientDataJSON: authCD, authenticatorData: authAD.toString('base64url'), signature: authSig, userHandle: null }, type: 'public-key' },
    }),
  });
  assert.equal(authRes.status, 201);

  const setCookie = authRes.headers.get('set-cookie');
  assert.ok(setCookie, 'authenticate sets a Set-Cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//);
  const token = sidFromSetCookie(setCookie);
  assert.ok(token, 'cookie carries a session token');
});
