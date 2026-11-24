// `owner.only()` is the TRANSPARENT expansion of the most-repeated block across
// the sample apps — the owner-only grant. D4 (docs/ideation/FABLE-5-REVIEW.md)
// settles the shape: `owner.only()` returns a VISIBLE array of grant clauses
// (scope(...).can(...)), not a magic string and not a hidden default grant. An
// entity that writes `grant: owner.only()` and one that writes the expansion by
// hand must compile to the identical record and behave identically at runtime.
//
// This test proves that equivalence at three layers:
//   1. COMPILE — read-scope SQL / AST / params identical (modulo entity name).
//   2. RUNTIME — rowCapabilities + mayVerb confer [read,write,subscribe,admin]
//      to the owner and deny everyone else, identically for both forms.
//   3. HTTP — owner reads/writes/deletes (200/200/204), a non-owner is denied
//      at the read-scope (404, fail closed — no existence leak), and an
//      anonymous principal is denied at the route gate (401). Identical status
//      codes across both forms.
//
// The called form `grant: owner.only()` returns a bare clause array. Before the
// row-grant fix, rowCapabilities resolved only FUNCTION grants and returned null
// for an array grant — silently denying the owner at runtime while the compile
// half already accepted the array. That compile/runtime inconsistency is the
// seam this test pins down (AGENTS: one reconciliation path).

import { text, ref, owner, scope, grant, deny, read, write, subscribe, admin } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { entity } from '../build/internal.mjs';
import { rowCapabilities, mayVerb } from '../build/row-grant.mjs';
import workbench, { executeDDL, executeFrameworkDDL } from '../build/internal.mjs';
import { User } from '../build/index.mjs';

// The handwritten expansion D4 says owner.only() must be identical to. Reused
// verbatim by the runtime/HTTP comparisons so equivalence is literal, not
// paraphrased.
const ownerOnlyGrant = () => [
  scope(({ is }) => is.owner()).can(
    async ({ is }) => (await is.owner()) ? grant(read, write, subscribe, admin) : deny('not the owner'),
  ),
];

function buildSugared() {
  return entity('SugaredThing', { body: text(), owner: owner(), grant: owner.only() });
}
function buildManual() {
  return entity('ManualThing', { body: text(), owner: ref('User', { role: 'owner', readonly: true }), grant: ownerOnlyGrant });
}

// ---- compile equivalence ---------------------------------------------------

test('owner.only() compiles to the identical read-scope as the handwritten grant', () => {
  const Sugared = buildSugared();
  const Manual = buildManual();

  // SQL is identical modulo the entity's own table alias name.
  assert.equal(Sugared.readScope.sql, Manual.readScope.sql.replaceAll('ManualThing', 'SugaredThing'));
  assert.deepEqual(Sugared.readScope.params, Manual.readScope.params);
  assert.deepEqual(
    { node: Sugared.scopeAst.node, field: Sugared.scopeAst.field, param: Sugared.scopeAst.param },
    { node: Manual.scopeAst.node, field: Manual.scopeAst.field, param: Manual.scopeAst.param },
  );
  // The owner ref-role derives checks.owner from the one field in both forms.
  assert.equal(typeof Sugared.checks.owner, 'function');
});

// ---- runtime equivalence ---------------------------------------------------

test('owner.only() confers owner capabilities and denies others identically at runtime', async () => {
  const Sugared = buildSugared();
  const Manual = buildManual();
  const row = { id: 'd1', owner: 'u1' };

  for (const E of [Sugared, Manual]) {
    const ownerDecision = await rowCapabilities(E, row, { id: 'u1' });
    assert.equal(ownerDecision.granted, true, `${E.name}: owner must be granted`);
    assert.deepEqual(ownerDecision.capabilities, [read, write, subscribe, admin],
      `${E.name}: owner gets the full owner capability set`);

    const otherDecision = await rowCapabilities(E, row, { id: 'u2' });
    assert.equal(otherDecision.granted, false, `${E.name}: non-owner must be denied`);
    assert.deepEqual(otherDecision.capabilities, [], `${E.name}: non-owner gets no capabilities`);

    // mayVerb maps each CRUD verb to the capability it requires; the owner holds
    // all of them, the non-owner none. subscribe is the live re-authorization
    // capability (a peer of read), confirmed directly here.
    assert.equal(await mayVerb(E, 'read', row, { id: 'u1' }), true, `${E.name}: owner may read`);
    assert.equal(await mayVerb(E, 'update', row, { id: 'u1' }), true, `${E.name}: owner may write`);
    assert.equal(await mayVerb(E, 'subscribe', row, { id: 'u1' }), true, `${E.name}: owner may subscribe`);
    assert.equal(await mayVerb(E, 'subscribe', row, { id: 'u2' }), false, `${E.name}: non-owner may not subscribe`);
  }
});

// ---- HTTP end-to-end equivalence -------------------------------------------

// One in-memory DB per entity form: each gets its own schema (entity names
// differ) and its own user rows. Both forms are exercised through the identical
// sequence so status codes are directly comparable.
function setupDb(E) {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  executeDDL(User, db);
  executeDDL(E, db);
  db.prepare("INSERT INTO User (id, username, password) VALUES (1, 'alice', 'salt:a')").run();
  db.prepare("INSERT INTO User (id, username, password) VALUES (2, 'bob', 'salt:b')").run();
  return db;
}

// Start an app bound to a single principal (one app per principal, the
// field-authz harness pattern). null principal = anonymous, denied at the route
// gate by the default requireUser() gate.
async function startApp(db, E, principalId) {
  const app = workbench({ db }).mount('/things', E);
  const principal = principalId == null
    ? { type: 'anonymous', id: null }
    : { type: 'user', id: principalId };
  app.listen(0, { principalOf: () => principal });
  await app.ready;
  const { port } = app.httpServer.address();
  return { app, origin: `http://127.0.0.1:${port}` };
}

async function stopApp(app) {
  // Each principal gets its own app over the SAME db handle. Shutting the app
  // down drains and closes its handle-attached write coordinator; closing only
  // the HTTP listener would leave that coordinator attached and the next app
  // would correctly refuse to mint a second, uncoordinated mutex.
  await app.shutdown();
}

async function createThing(origin) {
  const created = await fetch(`${origin}/things`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'owner-only test' }),
  });
  assert.equal(created.status, 201, 'owner must be able to create (201)');
  return (await created.json()).id;
}

// The expected status matrix — owner full access, non-owner denied at the
// read-scope (404, fail closed), anonymous denied at the gate (401). Asserted
// against BOTH forms so a drift between sugar and expansion is caught here.
async function assertMatrix(label, E) {
  const db = setupDb(E);
  try {
    // Create as the owner (alice, id 1).
    const ownerApp = await startApp(db, E, '1');
    let id;
    try {
      id = await createThing(ownerApp.origin);
    } finally {
      await stopApp(ownerApp.app);
    }

    // Owner: read 200, update 200, delete 204.
    const ownerAgain = await startApp(db, E, '1');
    try {
      const got = await fetch(`${ownerAgain.origin}/things/${id}`);
      assert.equal(got.status, 200, `${label}: owner GET must be 200`);
      const patched = await fetch(`${ownerAgain.origin}/things/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'changed' }),
      });
      assert.equal(patched.status, 200, `${label}: owner PATCH must be 200`);
      const removed = await fetch(`${ownerAgain.origin}/things/${id}`, { method: 'DELETE' });
      assert.equal(removed.status, 204, `${label}: owner DELETE must be 204`);
    } finally {
      await stopApp(ownerAgain.app);
    }

    // Recreate: the owner just deleted the row.
    const ownerRecreate = await startApp(db, E, '1');
    try {
      id = await createThing(ownerRecreate.origin);
    } finally {
      await stopApp(ownerRecreate.app);
    }

    // Non-owner (bob, id 2): denied at the read-scope → 404 on every verb (fail
    // closed: bob must not learn the thing exists), not 403.
    const bobApp = await startApp(db, E, '2');
    try {
      const got = await fetch(`${bobApp.origin}/things/${id}`);
      assert.equal(got.status, 404, `${label}: non-owner GET must be 404 (read-scope denial)`);
      const patched = await fetch(`${bobApp.origin}/things/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'changed' }),
      });
      assert.equal(patched.status, 404, `${label}: non-owner PATCH must be 404`);
      const removed = await fetch(`${bobApp.origin}/things/${id}`, { method: 'DELETE' });
      assert.equal(removed.status, 404, `${label}: non-owner DELETE must be 404`);
    } finally {
      await stopApp(bobApp.app);
    }

    // Anonymous: denied at the route gate (default requireUser()) → 401.
    const anonApp = await startApp(db, E, null);
    try {
      const got = await fetch(`${anonApp.origin}/things/${id}`);
      assert.equal(got.status, 401, `${label}: anonymous GET must be 401 (gate denial)`);
      const posted = await fetch(`${anonApp.origin}/things`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'anon' }),
      });
      assert.equal(posted.status, 401, `${label}: anonymous POST must be 401`);
    } finally {
      await stopApp(anonApp.app);
    }
  } finally {
    db.close();
  }
}

test('owner.only() and the handwritten grant behave identically over HTTP', async () => {
  await assertMatrix('sugared', buildSugared());
  await assertMatrix('manual', buildManual());
});
