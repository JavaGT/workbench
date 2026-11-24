// authorized-blob-stream.mjs — the streaming variant of the authorized blob
// read seam (#738 W1).
//
// readBlobStream proves the SAME guarantees as readBlob (authorized-blob-read
// .test.mjs) for byte STREAMS:
//   - admit-then-pipe: admission completes before `read` runs, so a stream is
//     only ever constructed for an admitted principal, and its bytes flow
//     through untouched (full + ranged)
//   - denial BEFORE any chunk flows: a denied principal never constructs a
//     stream — the reader callback is not even invoked — and every denial has
//     the identical generic public error shape
//   - a synchronous missing-slot failure inside `read` collapses into the same
//     generic denial before any streaming starts
//   - cancellation passes through: the app wires an AbortSignal into its own
//     reader; the seam returns the cancellable stream as-is

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import {
  principal, ref,
} from '../build/index.mjs';
import { createAuthorizationAdapter } from '../build/authorization-adapter.mjs';
import { readBlobStream, BlobReadDeniedError } from '../build/server.mjs';
import { BlobSlotNotFoundError } from '../build/fs-blobs.mjs';

const alice = principal({ type: 'user', id: 'alice' });
const bob = principal({ type: 'user', id: 'bob' });

// The owning resource row + registered policy, mirroring the buffered seam's
// fixtures so both variants prove the same admission matrix shape.
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

// A reader over real streams that counts constructions — the probe for
// "admission happens before the reader ever runs".
let constructed = 0;
const streamReader = (range) => {
  constructed += 1;
  if (!range) return Readable.from([BYTES]);
  const [start, end] = range;
  return Readable.from([BYTES.subarray(start ?? 0, end ?? BYTES.length)]);
};

function genericDenial(error) {
  assert.ok(error instanceof BlobReadDeniedError, 'every failure is a generic BlobReadDeniedError');
  assert.equal(error.status, 403);
  assert.equal(error.message, 'forbidden');
  assert.deepEqual(error.failure, { category: 'denied', message: 'forbidden' });
  assert.deepEqual(Object.keys(error).sort(), ['failure', 'name', 'status'], 'the public surface is exactly status/failure/name — no reasonCode');
  return true; // assert.rejects validators must affirmatively return true
}

const collect = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };

// ─── admit-then-pipe ─────────────────────────────────────────────────────────

test('an admitted read serves the stream — full and ranged — after the policy admits', async () => {
  const authorize = avatarAdapter();
  assert.deepEqual(await collect(await readBlobStream({ principal: alice, resource: ownerRow, field: 'avatar', authorize, read: streamReader })), BYTES);
  assert.deepEqual(await collect(await readBlobStream({ principal: alice, resource: ownerRow, field: 'avatar', range: [2, 7], authorize, read: streamReader })), Buffer.from('23456'));
});

// ─── denial before ANY chunk flows ───────────────────────────────────────────

test('a denied read never constructs a stream — denial precedes ANY chunk flow', async () => {
  const authorize = avatarAdapter();
  constructed = 0;
  await assert.rejects(
    readBlobStream({ principal: bob, resource: ownerRow, field: 'avatar', authorize, read: streamReader }),
    genericDenial,
  );
  assert.equal(constructed, 0, 'the reader callback never ran — no stream existed to flow');
});

test('a missing owning resource denies identically for streams (no existence signal)', async () => {
  const authorize = avatarAdapter();
  const missing = await readBlobStream({ principal: alice, resource: null, field: 'avatar', authorize, read: streamReader }).catch((e) => e);
  const denied = await readBlobStream({ principal: bob, resource: ownerRow, field: 'avatar', authorize, read: streamReader }).catch((e) => e);
  genericDenial(missing);
  genericDenial(denied);
  assert.deepEqual(Object.keys(missing).sort(), Object.keys(denied).sort());
});

// ─── missing-slot collapse before streaming starts ──────────────────────────

test('a synchronously throwing reader (missing slot) collapses into the generic denial BEFORE streaming starts', async () => {
  const authorize = avatarAdapter();
  const error = await readBlobStream({
    principal: alice,
    resource: ownerRow,
    field: 'avatar',
    authorize,
    read: () => { throw new BlobSlotNotFoundError(); },
  }).catch((e) => e);
  genericDenial(error);
  // reasonCode stays internal diagnostics: present on the instance, never
  // enumerable — the caller cannot branch on it.
  assert.equal(error.reasonCode, 'blob-unavailable');
  assert.equal(Object.keys(error).includes('reasonCode'), false);
});

// ─── abort destroys the stream (cancellation passes through) ────────────────

test('the returned stream is the app-wired cancellable stream — abort destroys it mid-flight', async () => {
  const authorize = avatarAdapter();
  const settle = (stream) => new Promise((resolve) => {
    let ended = false;
    stream.on('data', () => {});
    stream.on('end', () => { ended = true; resolve({ kind: 'end' }); });
    stream.on('error', (error) => { if (!ended) resolve({ kind: 'error', error }); });
  });

  const controller = new AbortController();
  const live = await readBlobStream({
    principal: alice,
    resource: ownerRow,
    field: 'avatar',
    range: [0, 5_000_000],
    authorize,
    // The app owns the signal wiring (here: a slow synthetic source); the seam
    // must hand back exactly that cancellable stream.
    read: () => {
      const stream = new Readable({ read() {} });
      stream.push(Buffer.alloc(5_000_000, 7));
      controller.signal.addEventListener('abort', () => stream.destroy(controller.signal.reason ?? new Error('The operation was aborted')), { once: true });
      return stream;
    },
  });
  controller.abort(); // cancel immediately after construction
  assert.equal((await settle(live)).kind, 'error', 'aborting after construction errors the stream instead of ending it');
});
