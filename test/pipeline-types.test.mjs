// Phase 1 — Action and Event are distinct branded types (SPEC §7).
//
// An ACTION is an imperative client request that MAY be rejected. An EVENT is a
// past-tense fact the server emitted; it already happened. The two are not
// assignable to each other, and an event type declared with NO REDUCER is a
// LOAD-TIME ERROR (the reducer is non-optional) — there is no way to land an
// event in client state except by folding it through its reducer (the one
// reconciliation path, AGENTS.md).
//
// These are the irreducible type invariants the rest of the pipeline builds on.
// Source of truth: SPEC §7. House rule: distinguish similar-but-different
// concepts with distinct names — an action and an event look alike (both carry a
// type + payload) but are different facts, so they brand differently.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { action, event } from '../build/internal.mjs';

test('action(type) declares an action with that type', () => {
  const Publish = action('post.publish');
  assert.equal(Publish.type, 'post.publish');
});

test('event(type, reducer) declares an event carrying its reducer', () => {
  const reducer = (state, _payload) => ({ ...state, published: true });
  const Published = event('post.published', reducer);
  assert.equal(Published.type, 'post.published');
  assert.equal(Published.reduce, reducer);
});

test('an event with no reducer is a load-time error (the reducer is non-optional)', () => {
  assert.throws(
    () => event('post.published'),
    /reducer/i,
    'declaring an event without a reducer must throw at load time',
  );
});

test('an action and an event are distinct branded types, not assignable', () => {
  const Publish = action('post.publish');
  const Published = event('post.published', (s) => s);
  // They brand differently: an action is not an event and vice-versa.
  assert.notEqual(Publish.brand, Published.brand);
  assert.equal(Publish.brand, 'action');
  assert.equal(Published.brand, 'event');
});

test('branded declarations are frozen (immutable)', () => {
  assert.ok(Object.isFrozen(action('a')));
  assert.ok(Object.isFrozen(event('e', (s) => s)));
});
