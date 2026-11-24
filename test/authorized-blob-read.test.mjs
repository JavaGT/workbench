// authorized-blob-read.mjs — the S6/A4 authorized blob read seam.
//
// readBlob is the framework read seam: it admits through the S5 authorization
// adapter (principal / owning resource / operation / registered policy) BEFORE
// bytes are served, and it collapses every failure — a denied read, a missing
// owning resource, missing bytes — into ONE generic denial so a caller can
// never distinguish "the blob does not exist" from "you may not read it". This
// file proves:
//   - the admission matrix: owner admits, stranger denies, missing row denies
//   - generic-denial leakage checks (denied === missing-row === missing-bytes),
//     including the identical PUBLIC error shape — reasonCode is internal,
//     non-enumerable diagnostics, never part of the API surface
//   - a throwing or malformed admission collapses into the same generic denial
//   - the operation label (defaults to the blob-read category)
//   - machine principals (S5/A5) read through the same seam, attributed
//   - non-active principals collapse to anonymous and are denied
//   - bytes are served only AFTER admission, and only the requested range

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  principal, anonymous, machinePrincipal, ref,
} from '../build/index.mjs';
import { createAuthorizationAdapter } from '../build/authorization-adapter.mjs';
import { readBlob, BlobReadDeniedError } from '../build/server.mjs';

const alice = principal({ type: 'user', id: 'alice' });
const bob = principal({ type: 'user', id: 'bob' });
const service = machinePrincipal({ id: 'svc-1', operations: ['blob-read'] });

// The owning resource row for the registered blob resource: an Avatar row whose
// owner can read its bytes. The registered scope is the resource-level policy
// the app mounts on the adapter — the read seam re-verifies the row against it.
const ownerRow = { id: 'avatar-1', owner: 'alice' };

function avatarAdapter() {
  const adapter = createAuthorizationAdapter();
  adapter.registerResource({
    allowRowScopeFallback: true, // legitimate DB-less policy test: evaluate the supplied row
    category: 'blob',
    name: 'avatar',
    scope: ({ is }) => is.owner(),
    fields: { owner: ref('User', { role: 'owner' }) },
  });
  return adapter;
}

const BYTES = Buffer.from('0123456789');
const reader = (range) => {
  if (!range) return BYTES;
  const [start, end] = range;
  return BYTES.subarray(start ?? 0, end ?? BYTES.length);
};

function genericDenial(error) {
  assert.ok(error instanceof BlobReadDeniedError, 'every failure is a generic BlobReadDeniedError');
  assert.equal(error.status, 403);
  assert.equal(error.message, 'forbidden');
  assert.deepEqual(error.failure, { category: 'denied', message: 'forbidden' });
  // The public error shape carries ONLY the generic surface. reasonCode is
  // server-side diagnostics stored non-enumerably — never a key a caller can
  // enumerate, serialize, or branch on.
  assert.deepEqual(Object.keys(error).sort(), ['failure', 'name', 'status'], 'the public surface is exactly status/failure/name — no reasonCode');
  assert.equal(Object.keys(error).includes('reasonCode'), false, 'reasonCode is not part of the public error shape');
  assert.equal(JSON.stringify(error).includes('reasonCode'), false, 'reasonCode never serializes onto the wire');
}

// ─── admission matrix ───────────────────────────────────────────────────────

test('an admitted read serves bytes — full and ranged — after the policy admits', async () => {
  const authorize = avatarAdapter();
  assert.deepEqual(await readBlob({ principal: alice, resource: ownerRow, field: 'avatar', authorize, read: reader }), BYTES);
  assert.deepEqual(await readBlob({ principal: alice, resource: ownerRow, field: 'avatar', range: [2, 7], authorize, read: reader }), Buffer.from('23456'));
});

test('the admission input names the blob category, the field, and defaults to the blob-read operation', async () => {
  const inner = avatarAdapter();
  const calls = [];
  const authorize = {
    admit: async (input) => { calls.push(input); return inner.admit(input); },
    registerResource: (input) => inner.registerResource(input),
  };
  await readBlob({ principal: alice, resource: ownerRow, field: 'avatar', authorize, read: reader });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].category, 'blob');
  assert.equal(calls[0].resourceName, 'avatar');
  assert.equal(calls[0].resourceId, 'avatar-1');
  assert.equal(calls[0].row, ownerRow);
  assert.equal(calls[0].operation.operation, 'blob-read', 'the default operation is the blob-read category');
});

// ─── generic-denial leakage ─────────────────────────────────────────────────

test('a denied read is a generic 403 — never which policy condition failed', async () => {
  const authorize = avatarAdapter();
  // Stranger owns nothing on alice's avatar row: denied by the registered scope.
  await assert.rejects(
    readBlob({ principal: bob, resource: ownerRow, field: 'avatar', authorize, read: reader }),
    (error) => { genericDenial(error); return true; },
  );
});

test('a missing owning resource looks exactly like a denied read (no existence signal)', async () => {
  const authorize = avatarAdapter();
  const missing = await readBlob({ principal: alice, resource: null, field: 'avatar', authorize, read: reader }).catch((e) => e);
  const denied = await readBlob({ principal: bob, resource: ownerRow, field: 'avatar', authorize, read: reader }).catch((e) => e);
  genericDenial(missing);
  genericDenial(denied);
  // Identical denial surfaces: a caller cannot tell "the row is gone" from
  // "I am not allowed" — same constructor, same enumerable shape, same
  // serialized bytes. The internal reason code (non-enumerable diagnostics)
  // differs but is invisible at the API boundary.
  assert.equal(missing.constructor, denied.constructor);
  assert.deepEqual(missing.failure, denied.failure);
  assert.equal(missing.message, denied.message);
  assert.equal(missing.status, denied.status);
  assert.deepEqual(Object.keys(missing), Object.keys(denied), 'identical enumerable public surface');
  assert.deepEqual(JSON.parse(JSON.stringify(missing)), JSON.parse(JSON.stringify(denied)), 'identical serialized public surface');
});

test('an unregistered field (no resource policy mounted) denies', async () => {
  const authorize = avatarAdapter();
  await assert.rejects(
    readBlob({ principal: alice, resource: ownerRow, field: 'unregistered', authorize, read: reader }),
    (error) => { genericDenial(error); return true; },
  );
});

test('missing bytes AFTER admission look exactly like a denied read — never an existence leak', async () => {
  const authorize = avatarAdapter();
  const missingBytes = await readBlob({
    principal: alice, resource: ownerRow, field: 'avatar', authorize,
    read: () => { throw new Error('blob not found'); },
  }).catch((e) => e);
  const denied = await readBlob({ principal: bob, resource: ownerRow, field: 'avatar', authorize, read: reader }).catch((e) => e);
  genericDenial(missingBytes);
  genericDenial(denied);
  assert.deepEqual(missingBytes.failure, denied.failure, 'byte unavailability and denial are the SAME generic failure');
  assert.equal(missingBytes.message, denied.message);
  // These two carry DIFFERENT internal diagnostics (blob-unavailable vs the
  // adapter's deny code) — yet the public shape must be indistinguishable.
  assert.deepEqual(Object.keys(missingBytes), Object.keys(denied), 'identical enumerable public surface');
  assert.deepEqual(JSON.parse(JSON.stringify(missingBytes)), JSON.parse(JSON.stringify(denied)), 'identical serialized public surface');
});

// ─── admission failures collapse too (S6 consideration #11) ────────────────

test('a throwing or malformed admission collapses into the same generic denial', async () => {
  const throwing = {
    admit: async () => { throw new Error('adapter exploded'); },
    registerResource: () => {},
  };
  const error = await readBlob({ principal: alice, resource: ownerRow, field: 'avatar', authorize: throwing, read: reader }).catch((e) => e);
  genericDenial(error);
  // A malformed adapter (e.g. resolves with no decision) must not leak as a
  // TypeError — it is the same generic 403.
  const malformed = {
    admit: async () => undefined,
    registerResource: () => {},
  };
  const error2 = await readBlob({ principal: alice, resource: ownerRow, field: 'avatar', authorize: malformed, read: reader }).catch((e) => e);
  genericDenial(error2);
  // Same public shape as a plain denial — indistinguishable at the boundary.
  const denied = await readBlob({ principal: bob, resource: ownerRow, field: 'avatar', authorize: avatarAdapter(), read: reader }).catch((e) => e);
  genericDenial(denied);
  assert.deepEqual(Object.keys(error), Object.keys(denied), 'an admission failure is not distinguishable from a denial');
  assert.deepEqual(JSON.parse(JSON.stringify(error2)), JSON.parse(JSON.stringify(denied)), 'a malformed admission is not distinguishable from a denial');
});

// ─── operation label ────────────────────────────────────────────────────────

test('an explicit operation is honored on the admission', async () => {
  const inner = avatarAdapter();
  const calls = [];
  const authorize = {
    admit: async (input) => { calls.push(input); return inner.admit(input); },
    registerResource: (input) => inner.registerResource(input),
  };
  await readBlob({ principal: alice, resource: ownerRow, field: 'avatar', operation: 'read', authorize, read: reader });
  assert.equal(calls[0].operation, 'read', 'the explicit operation is passed through to the adapter');
});

// ─── machine principals (S5/A5) ─────────────────────────────────────────────

test('a machine principal reads through the same seam when its resource policy admits', async () => {
  const authorize = avatarAdapter();
  // The machine principal is attributed (S5/A5) and the registered scope binds
  // it: a row owned by the service identity admits the machine read.
  const serviceRow = { id: 'avatar-2', owner: 'svc-1' };
  assert.deepEqual(await readBlob({ principal: service, resource: serviceRow, field: 'avatar', authorize, read: reader }), BYTES);
  // The same machine principal on a human-owned row is denied.
  await assert.rejects(
    readBlob({ principal: service, resource: ownerRow, field: 'avatar', authorize, read: reader }),
    (error) => { genericDenial(error); return true; },
  );
});

// ─── principal status collapse (S5/A1) ──────────────────────────────────────

test('anonymous and non-active principals collapse to anonymous and are denied', async () => {
  const authorize = avatarAdapter();
  const revoked = principal({ type: 'user', id: 'alice', status: 'revoked' });
  for (const who of [anonymous, revoked]) {
    await assert.rejects(
      readBlob({ principal: who, resource: ownerRow, field: 'avatar', authorize, read: reader }),
      (error) => { genericDenial(error); return true; },
    );
  }
});
