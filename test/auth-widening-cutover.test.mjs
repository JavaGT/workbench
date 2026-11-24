// Wave 1 auth-widening cutover regressions.
//
// Four fail-closed repairs, each proved against the behavior that used to be
// silently open:
//   1. a scope-only grant (no `.can`) is read-class visibility, NOT an implicit
//      CRUD grant — mayRow / rowCapabilities / fieldCapabilities agree;
//   2. a field `.can` body is statically guarded at declaration time, so an
//      un-awaited `is.*` check cannot silently grant access;
//   3. the authorization adapter has one VERB_CAPABILITY authority, rejects
//      colliding check names, and never silently substitutes JS row matching
//      for an unavailable SQL scope without an explicit opt-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  text, ref, scope, grant, deny, read, write, subscribe, admin, everyone,
  principal,
} from '../build/index.mjs';
import { entity, UnawaitedCheckError } from '../build/internal.mjs';
import {
  mayRow, mayVerb, rowCapabilities, fieldCapabilities, mayFieldOp,
  VERB_CAPABILITY,
} from '../build/row-grant.mjs';
import { createAuthorizationAdapter } from '../build/authorization-adapter.mjs';

const alice = principal({ type: 'user', id: 'alice' });
const row = { id: 'r1', title: 'open' };

// ─── 1. scope-only grant: read-class visibility, never an implicit write ─────

function scopeOnlyRecord() {
  return entity('CutoverScopeOnly', {
    title: text(),
    grant: () => [scope(() => everyone())],
  });
}

test('scope-only grant admits read-class verbs and denies every write verb', async () => {
  const Open = scopeOnlyRecord();
  for (const verb of ['list', 'read', 'subscribe']) {
    assert.equal(await mayRow(Open, verb, row, alice), true, `${verb} is read-class`);
  }
  for (const verb of ['create', 'update', 'remove', 'admin']) {
    assert.equal(await mayRow(Open, verb, row, alice), false, `${verb} needs an explicit .can grant`);
  }
  assert.equal(await mayVerb(Open, 'update', row, alice), false, 'mayVerb agrees with mayRow');
});

test('scope-only row/field capabilities agree with mayRow (read-class only)', async () => {
  const Open = entity('CutoverScopeOnlyFields', {
    title: text(),
    grant: () => [scope(() => everyone())],
  });
  const rowDecision = await rowCapabilities(Open, row, alice);
  assert.equal(rowDecision.granted, true);
  assert.deepEqual([...rowDecision.capabilities], [read, subscribe]);
  assert.ok(rowDecision.capabilities.includes(read));
  assert.ok(rowDecision.capabilities.includes(subscribe));
  assert.ok(!rowDecision.capabilities.includes(write));
  assert.ok(!rowDecision.capabilities.includes(admin));

  // A field with no own `.can` strong-inherits the row decision: field reads
  // stay readable, field writes stay denied — the same authority, not a second
  // path that re-admits the mutation mayRow just denied.
  const fieldDecision = await fieldCapabilities(Open, 'title', row, alice);
  assert.deepEqual(fieldDecision.capabilities, rowDecision.capabilities);
  assert.equal(await mayFieldOp(Open, 'title', read, row, alice), true);
  assert.equal(await mayFieldOp(Open, 'title', write, row, alice), false);
});

test('an explicit .can grant still confers write (the fix does not over-correct)', async () => {
  const Owned = entity('CutoverExplicitGrant', {
    title: text(),
    owner: ref('User', { role: 'owner' }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
  const ownedRow = { id: 'r2', title: 'x', owner: 'alice' };
  assert.equal(await mayRow(Owned, 'update', ownedRow, alice), true);
  assert.equal(await mayRow(Owned, 'update', ownedRow, principal({ type: 'user', id: 'bob' })), false);
});

// ─── 2. field `.can` declaration-time await guard ───────────────────────────

test('field .can rejects an un-awaited is.* check at declaration time', () => {
  assert.throws(
    () => text().can(({ is }) => is.owner() ? grant(read) : deny('no')),
    (error) => error instanceof UnawaitedCheckError && /without `await`/.test(error.message),
    'a pending check in a field .can is a silent grant — reject it immediately',
  );
});

test('a field .can that awaits its checks is accepted', () => {
  const guarded = text().can(async ({ is }) => (await is.owner()) ? grant(read) : deny('no'));
  assert.equal(typeof guarded.access, 'function');
  assert.notEqual(guarded.access, undefined);
});

// ─── 3a. one VERB_CAPABILITY authority ──────────────────────────────────────

test('the adapter reports capabilities from the shared row-grant VERB_CAPABILITY table', async () => {
  assert.deepEqual(Object.keys(VERB_CAPABILITY).sort(), [
    'admin', 'create', 'list', 'read', 'remove', 'subscribe', 'update',
  ]);
  const adapter = createAuthorizationAdapter({ mayRow: async () => true });
  for (const verb of ['list', 'read', 'create', 'update', 'remove', 'subscribe', 'admin']) {
    const decision = await adapter.admit({
      category: 'entity', verb, principal: alice, entity: scopeOnlyRecord(), row,
    });
    assert.deepEqual(decision.capabilities, [VERB_CAPABILITY[verb]], `${verb} uses the shared table`);
  }
});

// ─── 3b. check-name collisions fail at registration ─────────────────────────

test('a resource registry that redefines a derived check throws at registration', () => {
  const adapter = createAuthorizationAdapter();
  const Decl = entity('CutoverCollision', {
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read))],
  });
  assert.throws(
    () => adapter.registerResource({
      category: 'search',
      name: 'collision',
      scope: ({ is }) => is.owner(),
      // Both sources derive `owner` with a harvest (SQL) face — two canonical
      // sources for one check would let the registry rewrite the row filter.
      fields: { owner: ref('User', { role: 'owner' }) },
      registry: Decl.registry,
    }),
    /collides with an existing.*authorization checks must have one source/,
  );
});

test('a non-colliding precompiled registry still registers', () => {
  const adapter = createAuthorizationAdapter();
  const Decl = entity('CutoverNoCollision', {
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read))],
  });
  assert.doesNotThrow(() => adapter.registerResource({
    category: 'search',
    name: 'no-collision',
    scope: ({ is }) => is.owner(),
    registry: Decl.registry,
  }));
});

// ─── 3c. unavailable SQL scope fails closed unless explicitly opted in ──────

function publicResource(extra = {}) {
  return {
    category: 'blob',
    name: 'cutover_public',
    scope: ({ fields }) => fields.public.is(1),
    fields: { public: text() },
    ...extra,
  };
}

test('a DB-less resource denies without the explicit row-fallback opt-in', async () => {
  const adapter = createAuthorizationAdapter();
  adapter.registerResource(publicResource());
  const decision = await adapter.admit({
    category: 'blob', operation: 'blob-read', principal: alice,
    resourceName: 'cutover_public', row: { id: 'b1', public: 1 },
  });
  assert.equal(decision.admitted, false);
  assert.equal(decision.reasonCode, 'no-row-scope');
});

test('a DB-less resource admits with the explicit row-fallback opt-in', async () => {
  const adapter = createAuthorizationAdapter();
  adapter.registerResource(publicResource({ allowRowScopeFallback: true }));
  const decision = await adapter.admit({
    category: 'blob', operation: 'blob-read', principal: alice,
    resourceName: 'cutover_public', row: { id: 'b1', public: 1 },
  });
  assert.equal(decision.admitted, true);
});

test('a missing table fails closed (policy-error), never a silent JS fallback', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const adapter = createAuthorizationAdapter({ db });
    // The resource name is not a SQL table, so the compiled scope query throws
    // "no such table". Previously that silently fell back to rowMatchesScope.
    adapter.registerResource(publicResource());
    const decision = await adapter.admit({
      category: 'blob', operation: 'blob-read', principal: alice,
      resourceName: 'cutover_public', row: { id: 'b1', public: 1 },
    });
    assert.equal(decision.admitted, false);
    assert.equal(decision.reasonCode, 'policy-error');

    const optedIn = createAuthorizationAdapter({ db });
    optedIn.registerResource(publicResource({ allowRowScopeFallback: true }));
    const allowed = await optedIn.admit({
      category: 'blob', operation: 'blob-read', principal: alice,
      resourceName: 'cutover_public', row: { id: 'b1', public: 1 },
    });
    assert.equal(allowed.admitted, true, 'the explicit opt-in preserves the in-memory policy path');
  } finally {
    db.close();
  }
});
