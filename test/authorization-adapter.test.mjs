// The authorization adapter (S5/A2) — pure unit decisions with zero HTTP,
// sockets, or global DB state.
//
// The adapter is THE admission seam: REST dispatch, the route gate, and
// composite (registered) actions consult one adapter instance instead of
// module-global row-grant calls. This file proves the adapter's decision
// surface in isolation:
//   - principal admissions (human/machine/anonymous/inactive/expired/revoked)
//   - the closed reason-code mapping
//   - fail-closed on a policy exception (policy-error, never a 500)
//   - dev decision traces vs the production null trace
//   - composite action admission against EVERY requirement through one call
//   - non-entity resource registration failing at registration, not query time

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  text, date, ref, map, scope, grant, deny, read, write, subscribe, everyone, anyOf,
  principal, anonymous, requireUser, allowAnonymous,
} from '../build/index.mjs';
import { entity, NonCompilableError } from '../build/internal.mjs';
import { createAuthorizationAdapter } from '../build/authorization-adapter.mjs';
import { authorizedRows, bindAuthorizedRows } from '../build/action-authorization.mjs';

// An owner-scoped Note: the owner may read+write+subscribe; anyone else is
// denied outright (no partial capability grant), so a visible-but-denied row
// exercises the 'no-capability' reason code.
function ownedNote() {
  return entity('Note', {
    body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : deny('no'),
      ),
    ],
  });
}

// A public-read Post: everyone may SEE every row; only the owner may write.
function publicPost() {
  return entity('Post', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(() => everyone()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

const alice = principal({ type: 'user', id: 'alice' });
const bob = principal({ type: 'user', id: 'bob' });
const machine = principal({ type: 'system', id: 'svc-1' });
const link = principal({ type: 'link', id: 'link-1' });

const aliceRow = { id: 'n1', body: 'a', owner: 'alice' };
const bobRow = { id: 'n2', body: 'b', owner: 'bob' };

// --- principal admission: human / machine / anonymous / status collapse -------

test('principal admission admits human, machine, and link principals (requireUser)', async () => {
  const adapter = createAuthorizationAdapter({ trace: true });
  for (const who of [alice, machine, link]) {
    const d = await adapter.admit({ category: 'principal', operation: 'read', principal: who });
    assert.equal(d.admitted, true, `${who.type} admitted`);
    assert.equal(d.reasonCode, null);
    assert.equal(d.resourceCategory, 'principal');
    assert.equal(d.operation.operation, 'read');
    assert.deepEqual(d.capabilities, []);
    assert.ok(Array.isArray(d.trace) && d.trace.length > 0);
  }
});

test('principal admission denies anonymous with reasonCode anonymous', async () => {
  const adapter = createAuthorizationAdapter();
  const d = await adapter.admit({ category: 'principal', operation: 'read', principal: anonymous });
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'anonymous');
});

test('a non-active principal collapses to anonymous — indistinguishable from an unknown one', async () => {
  const adapter = createAuthorizationAdapter({ trace: true });
  const gate = requireUser();
  const anonDecision = await adapter.admit({ category: 'principal', operation: 'read', principal: anonymous, gate });
  for (const status of ['disabled', 'expired', 'revoked']) {
    const who = principal({ type: 'user', id: 'alice', status });
    const d = await adapter.admit({ category: 'principal', operation: 'read', principal: who, gate });
    assert.equal(d.admitted, false, `${status} denied`);
    // the decision surface NEVER says which non-active status applied
    assert.equal(d.reasonCode, anonDecision.reasonCode, `${status} reason matches anonymous`);
    assert.equal(d.resourceCategory, anonDecision.resourceCategory);
    assert.equal(d.operation.operation, anonDecision.operation.operation);
    assert.deepEqual(d.capabilities, anonDecision.capabilities);
  }
});

test('allowAnonymous() admits anonymous and a collapsed non-active principal alike', async () => {
  const adapter = createAuthorizationAdapter();
  const gate = allowAnonymous();
  const revoked = principal({ type: 'user', id: 'alice', status: 'revoked' });
  const dAnon = await adapter.admit({ category: 'principal', principal: anonymous, gate });
  const dRevoked = await adapter.admit({ category: 'principal', principal: revoked, gate });
  assert.equal(dAnon.admitted, true);
  assert.equal(dRevoked.admitted, true);
});

// --- entity admission: reason-code mapping ------------------------------------

test('an absent row denies with no-row-scope (out of scope / nonexistent)', async () => {
  const adapter = createAuthorizationAdapter();
  const d = await adapter.admit({
    category: 'entity', verb: 'read', principal: alice, entity: ownedNote(), row: null,
  });
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'no-row-scope');
});

test('a visible row the principal holds no capability on denies with no-capability', async () => {
  const adapter = createAuthorizationAdapter();
  const d = await adapter.admit({
    category: 'entity', verb: 'update', principal: alice, entity: ownedNote(), row: bobRow,
  });
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'no-capability');
});

test('an admitted row reports the conferred capabilities and a null reason', async () => {
  const adapter = createAuthorizationAdapter();
  const d = await adapter.admit({
    category: 'entity', verb: 'update', principal: alice, entity: ownedNote(), row: aliceRow,
  });
  assert.equal(d.admitted, true);
  assert.equal(d.reasonCode, null);
  assert.ok(d.capabilities.some((c) => c === write));
  assert.equal(d.resourceId, 'n1');
});

test('an admitted public read confers only the read capability to a non-owner', async () => {
  const adapter = createAuthorizationAdapter();
  const d = await adapter.admit({
    category: 'entity', verb: 'read', principal: bob, entity: publicPost(), row: aliceRow,
  });
  assert.equal(d.admitted, true);
  assert.deepEqual(d.capabilities, [read]);
});

test('a field admission denies with no-field-access when the field .can denies', async () => {
  const Note = entity('Note', {
    body: text(),
    secret: text().can(async () => deny('no field access')),
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(({ is }) => is.owner()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : deny('no'))],
  });
  const adapter = createAuthorizationAdapter();
  const d = await adapter.admit({
    category: 'entity', verb: 'read', principal: alice, entity: Note, row: aliceRow,
    fieldName: 'secret', capability: read,
  });
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'no-field-access');
});

test('a field admission admits when the field .can grants the capability', async () => {
  const Note = entity('Note', {
    body: text(),
    secret: text().can(async () => grant(read)),
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(({ is }) => is.owner()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : deny('no'))],
  });
  const adapter = createAuthorizationAdapter();
  const d = await adapter.admit({
    category: 'entity', verb: 'read', principal: alice, entity: Note, row: aliceRow,
    fieldName: 'secret', capability: read,
  });
  assert.equal(d.admitted, true);
  assert.ok(d.capabilities.includes(read));
});

test('an unknown category is a fail-closed denial (unknown-category)', async () => {
  const adapter = createAuthorizationAdapter();
  const d = await adapter.admit({ category: 'frobnicate', principal: alice });
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'unknown-category');
});

// --- unknown operation vocabulary fails closed, never an admitted 'read' ------

test('an unknown operation string denies with unknown-operation (never an admitted read)', async () => {
  const adapter = createAuthorizationAdapter();
  const d = await adapter.admit({
    category: 'entity', verb: 'read', operation: 'frobnicate', principal: alice, entity: ownedNote(), row: aliceRow,
  });
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'unknown-operation');
  // an unrecognized operation is not a category, so the decision carries no label
  assert.equal(d.operation, null);
});

test('an unknown entity verb denies with unknown-operation (no fallback to read)', async () => {
  const adapter = createAuthorizationAdapter();
  const d = await adapter.admit({
    category: 'entity', verb: 'frobnicate', principal: alice, entity: ownedNote(), row: aliceRow,
  });
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'unknown-operation');
  assert.equal(d.operation, null);
});

test('an unknown operation on a principal admission denies with unknown-operation', async () => {
  const adapter = createAuthorizationAdapter();
  const d = await adapter.admit({ category: 'principal', operation: 'frobnicate', principal: alice });
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'unknown-operation');
  assert.equal(d.operation, null);
});

test('a missing operation on a non-entity input keeps the access-check label (read)', async () => {
  const adapter = createAuthorizationAdapter();
  const d = await adapter.admit({ category: 'principal', principal: alice });
  assert.equal(d.admitted, true);
  assert.equal(d.operation.operation, 'read');
});

// --- fail closed on a policy exception ----------------------------------------

test('a throwing row policy yields admitted:false policy-error, never a throw', async () => {
  const adapter = createAuthorizationAdapter({ mayRow: async () => { throw new Error('boom'); } });
  const d = await adapter.admit({
    category: 'entity', verb: 'read', principal: alice, entity: ownedNote(), row: aliceRow,
  });
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'policy-error');
});

test('a throwing field .can yields admitted:false policy-error, never a throw', async () => {
  const Note = entity('Note', {
    body: text(),
    secret: text().can(() => { throw new Error('boom'); }),
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(({ is }) => is.owner()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : deny('no'))],
  });
  const adapter = createAuthorizationAdapter();
  const d = await adapter.admit({
    category: 'entity', verb: 'read', principal: alice, entity: Note, row: aliceRow,
    fieldName: 'secret', capability: read,
  });
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'policy-error');
});

// --- dev decision traces vs the production null trace --------------------------

test('dev mode attaches named check outcomes; production default is trace null', async () => {
  const dev = createAuthorizationAdapter({ trace: true });
  const devDecision = await dev.admit({
    category: 'entity', verb: 'update', principal: alice, entity: ownedNote(), row: bobRow,
  });
  assert.ok(Array.isArray(devDecision.trace));
  const checks = devDecision.trace.map((entry) => entry.check);
  assert.ok(checks.includes('principal.status'));
  assert.ok(checks.includes('row.visible'));
  assert.ok(checks.includes('row.may.update'));
  assert.ok(devDecision.trace.every((entry) => typeof entry.outcome === 'boolean'));
  assert.ok(devDecision.trace.some((entry) => entry.outcome === false), 'the denying check is visible');

  const prod = createAuthorizationAdapter({ trace: false });
  const prodDecision = await prod.admit({
    category: 'entity', verb: 'update', principal: alice, entity: ownedNote(), row: bobRow,
  });
  assert.equal(prodDecision.trace, null);
  // production denial carries a closed reason code and no payload content
  assert.equal(prodDecision.reasonCode, 'no-capability');
  assert.equal(prodDecision.admitted, false);
});

test('the env/test flag enables traces for the default adapter', async () => {
  const previous = process.env.WORKBENCH_AUTH_TRACE;
  process.env.WORKBENCH_AUTH_TRACE = '1';
  try {
    const adapter = createAuthorizationAdapter();
    const d = await adapter.admit({ category: 'principal', principal: anonymous });
    assert.ok(Array.isArray(d.trace) && d.trace.length > 0);
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_AUTH_TRACE;
    else process.env.WORKBENCH_AUTH_TRACE = previous;
  }
});

// --- composite action admission (one adapter call, every requirement) ---------

test('a composite action admits only when EVERY requirement admits (one adapter call)', async () => {
  const adapter = createAuthorizationAdapter({ trace: true });
  const d = await adapter.admit({
    category: 'action',
    operation: 'execute',
    principal: alice,
    requirements: [
      { entity: ownedNote(), verb: 'read', row: aliceRow },
      { entity: ownedNote(), verb: 'update', row: aliceRow, capability: write },
    ],
  });
  assert.equal(d.admitted, true);
  assert.ok(d.capabilities.includes(write));
  assert.equal(d.resourceCategory, 'action');
  assert.equal(d.operation.operation, 'execute');
});

test('a composite action denies the whole action when ONE requirement denies', async () => {
  const adapter = createAuthorizationAdapter({ trace: true });
  const d = await adapter.admit({
    category: 'action',
    operation: 'execute',
    principal: alice,
    requirements: [
      { entity: ownedNote(), verb: 'read', row: aliceRow },
      { entity: ownedNote(), verb: 'update', row: bobRow },
    ],
  });
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'no-capability');
  assert.deepEqual(d.capabilities, []);
});

test('a composite action with a missing row denies with no-row-scope', async () => {
  const adapter = createAuthorizationAdapter();
  const d = await adapter.admit({
    category: 'action',
    operation: 'execute',
    principal: alice,
    requirements: [{ entity: ownedNote(), verb: 'read', row: null }],
  });
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'no-row-scope');
});

test('a composite action with no requirements is denied (fail closed)', async () => {
  const adapter = createAuthorizationAdapter();
  const d = await adapter.admit({ category: 'action', operation: 'execute', principal: alice, requirements: [] });
  assert.equal(d.admitted, false);
});

test('bindAuthorizedRows routes ALL requirements through ONE adapter admit call', async () => {
  const declaration = authorizedRows(() => [
    { entity: 'Note', id: 'n1', capability: read },
    { entity: 'Note', id: 'n2', capability: write },
  ]);
  const entityStub = {
    name: 'Note',
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    deserializeRow: (row) => ({ ...row }),
  };
  const app = {
    entities: new Map([['Note', entityStub]]),
    db: { prepare: () => ({ get: (params) => ({ id: params.id, owner: 'alice' }) }) },
  };
  const calls = [];
  const spy = {
    admit: async (input) => { calls.push(input); return { admitted: true }; },
    registerResource: () => {},
  };
  const bound = bindAuthorizedRows(declaration, app, spy);
  assert.equal(await bound({ payload: {}, principal: alice }), true);
  assert.equal(calls.length, 1, 'exactly one adapter call for the whole action');
  assert.equal(calls[0].category, 'action');
  assert.equal(calls[0].operation, 'execute');
  assert.equal(calls[0].requirements.length, 2);
});

test('bindAuthorizedRows denies when the adapter denies (any single requirement denies all)', async () => {
  const declaration = authorizedRows(() => [
    { entity: 'Note', id: 'n1', capability: read },
  ]);
  const entityStub = {
    name: 'Note',
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    deserializeRow: (row) => ({ ...row }),
  };
  const app = {
    entities: new Map([['Note', entityStub]]),
    db: { prepare: () => ({ get: (params) => ({ id: params.id, owner: 'alice' }) }) },
  };
  const spy = { admit: async () => ({ admitted: false }), registerResource: () => {} };
  const bound = bindAuthorizedRows(declaration, app, spy);
  assert.equal(await bound({ payload: {}, principal: alice }), false);
});

// --- non-entity resource registration (fail at registration, not query time) --

test('a non-entity resource with a non-compilable scope FAILS at registration', () => {
  const adapter = createAuthorizationAdapter();
  // a predicate returning a raw boolean is not an AST → cannot lower to SQL
  assert.throws(
    () => adapter.registerResource({
      category: 'search',
      name: 'articles',
      scope: () => true,
    }),
    NonCompilableError,
  );
  // a predicate referencing an unknown check cannot compile either
  assert.throws(
    () => adapter.registerResource({
      category: 'search',
      name: 'articles',
      scope: ({ is }) => is.owner(),
    }),
    /no check 'owner'|NonCompilable/i,
  );
  // a scope-less resource is refused outright (would load every row and filter in JS)
  assert.throws(
    () => adapter.registerResource({ category: 'blob', name: 'files' }),
    /scope predicate/i,
  );
});

test('a compilable resource registers and admits through the same seam', async () => {
  const adapter = createAuthorizationAdapter();
  adapter.registerResource({
    allowRowScopeFallback: true, // legitimate DB-less policy test: evaluate the supplied row
    category: 'search',
    name: 'articles',
    scope: ({ fields }) => fields.title.is('published'),
    fields: { title: text() },
  });
  // unregistered name → no-resource
  const missing = await adapter.admit({
    category: 'search', operation: 'search', principal: alice, resourceName: 'missing', row: {},
  });
  assert.equal(missing.admitted, false);
  assert.equal(missing.reasonCode, 'no-resource');
  // registered but no row → no-row-scope
  const noRow = await adapter.admit({
    category: 'search', operation: 'search', principal: alice, resourceName: 'articles', row: null,
  });
  assert.equal(noRow.admitted, false);
  assert.equal(noRow.reasonCode, 'no-row-scope');
  // registered + row → admitted
  const admitted = await adapter.admit({
    category: 'search', operation: 'search', principal: alice, resourceName: 'articles', row: { id: 'a1', title: 'published' },
  });
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.resourceCategory, 'search');
  assert.equal(admitted.operation.operation, 'search');
});

test('a non-null row without a resource name fails closed', async () => {
  const adapter = createAuthorizationAdapter();
  const decision = await adapter.admit({
    category: 'search', operation: 'search', principal: alice, row: { id: 'a1' },
  });
  assert.equal(decision.admitted, false);
  assert.equal(decision.reasonCode, 'no-resource');
});

test('blob/policy resources admit through the same generic seam', async () => {
  const adapter = createAuthorizationAdapter();
  adapter.registerResource({
    allowRowScopeFallback: true, // legitimate DB-less policy test: evaluate the supplied row
    category: 'blob',
    name: 'assets',
    scope: ({ fields }) => fields.public.is(1),
    fields: { public: text() },
  });
  const d = await adapter.admit({
    category: 'blob', operation: 'blob-read', principal: anonymous, resourceName: 'assets', row: { id: 'b1', public: '1' },
  });
  assert.equal(d.admitted, true);
  assert.equal(d.resourceCategory, 'blob');
  assert.equal(d.operation.operation, 'blob-read');
});

// --- the registered scope CONSTRAINS admission (not validation-only) ---------

test('a registered scope denies a row that does not satisfy it (no-row-scope)', async () => {
  const adapter = createAuthorizationAdapter({ trace: true });
  adapter.registerResource({
    allowRowScopeFallback: true, // legitimate DB-less policy test: evaluate the supplied row
    category: 'search',
    name: 'articles',
    scope: ({ fields }) => fields.status.is('published'),
    fields: { status: text() },
  });
  const inScope = await adapter.admit({
    category: 'search', operation: 'search', principal: alice, resourceName: 'articles', row: { id: 'a1', status: 'published' },
  });
  assert.equal(inScope.admitted, true, 'a row inside the registered scope admits');
  const outOfScope = await adapter.admit({
    category: 'search', operation: 'search', principal: alice, resourceName: 'articles', row: { id: 'a2', status: 'draft' },
  });
  assert.equal(outOfScope.admitted, false, 'a row outside the registered scope is denied');
  assert.equal(outOfScope.reasonCode, 'no-row-scope');
  assert.ok(outOfScope.trace.some((entry) => entry.check === 'resource.scope' && entry.outcome === false), 'the scope denial is visible on the trace');
});

test('a registered scope binds the principal — the owner admits, a stranger is denied', async () => {
  const adapter = createAuthorizationAdapter();
  adapter.registerResource({
    allowRowScopeFallback: true, // legitimate DB-less policy test: evaluate the supplied row
    category: 'search',
    name: 'mydocs',
    scope: ({ is }) => is.owner(),
    fields: { owner: ref('User', { role: 'owner' }) },
  });
  const ownerDecision = await adapter.admit({
    category: 'search', operation: 'search', principal: alice, resourceName: 'mydocs', row: { id: 'd1', owner: 'alice' },
  });
  assert.equal(ownerDecision.admitted, true, 'the owner admits');
  const strangerDecision = await adapter.admit({
    category: 'search', operation: 'search', principal: bob, resourceName: 'mydocs', row: { id: 'd1', owner: 'alice' },
  });
  assert.equal(strangerDecision.admitted, false, 'a non-owner is denied against the same row');
  assert.equal(strangerDecision.reasonCode, 'no-row-scope');
});

test('a scope this seam cannot verify against a single row fails closed (membership check)', async () => {
  const adapter = createAuthorizationAdapter();
  adapter.registerResource({
    allowRowScopeFallback: true, // legitimate DB-less policy test: evaluate the supplied row
    category: 'search',
    name: 'docs',
    scope: ({ is }) => is.collaborator(),
    fields: { collaborators: map(ref('User')) },
    checks: { collaborator: ({ docs, principal }) => docs.collaborators.has(principal.id) },
  });
  // The compiled scope is an EXISTS over the membership side-table — not
  // verifiable against one row without a database, so admission fails closed.
  const d = await adapter.admit({
    category: 'search', operation: 'search', principal: alice, resourceName: 'docs', row: { id: 'd1' },
  });
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'no-row-scope');
});

test('a NEGATED membership scope still fails closed — not(...) cannot flip an unverifiable predicate to true', async () => {
  const adapter = createAuthorizationAdapter();
  adapter.registerResource({
    allowRowScopeFallback: true, // legitimate DB-less policy test: evaluate the supplied row
    category: 'search',
    name: 'docs',
    scope: ({ is }) => is.collaborator().not(),
    fields: { collaborators: map(ref('User')) },
    checks: { collaborator: ({ docs, principal }) => docs.collaborators.has(principal.id) },
  });
  // The row's admission is decided by NOT (EXISTS ...) in SQL — a decision the
  // single-row gate cannot prove. It must deny, never treat the membership as
  // "false" and invert it into an admit.
  const d = await adapter.admit({
    category: 'search', operation: 'search', principal: alice, resourceName: 'docs', row: { id: 'd1' },
  });
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'no-row-scope');
});

test('a scope combining a satisfiable eq with an unverifiable FTS match denies', async () => {
  const adapter = createAuthorizationAdapter();
  adapter.registerResource({
    allowRowScopeFallback: true, // legitimate DB-less policy test: evaluate the supplied row
    category: 'search',
    name: 'articles',
    scope: ({ fields }) => fields.status.is('published').and(fields.body.matches('needle')),
    fields: { status: text(), body: text({ indexed: 'fts' }) },
  });
  // The eq arm is satisfiable from the row alone, but the FTS arm is an EXISTS
  // over the FTS side-table — the whole scope is unevaluable, so it denies.
  const d = await adapter.admit({
    category: 'search', operation: 'search', principal: alice, resourceName: 'articles',
    row: { id: 'a1', status: 'published', body: 'needle in the haystack' },
  });
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'no-row-scope');
});

test('an in-list containing NULL follows SQLite semantics — never an admit on null == null', async () => {
  const adapter = createAuthorizationAdapter();
  adapter.registerResource({
    allowRowScopeFallback: true, // legitimate DB-less policy test: evaluate the supplied row
    category: 'search',
    name: 'articles',
    scope: ({ fields }) => fields.status.in([null]),
    fields: { status: text() },
  });
  // SQLite evaluates `status IN (NULL)` as NULL — not satisfied. A JS evaluator
  // that treats null == null as equal would wrongly admit the row.
  const d = await adapter.admit({
    category: 'search', operation: 'search', principal: alice, resourceName: 'articles', row: { id: 'a1', status: null },
  });
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'no-row-scope');
});

test('a missing row field does not satisfy isNull — an incomplete caller row denies', async () => {
  const adapter = createAuthorizationAdapter();
  adapter.registerResource({
    allowRowScopeFallback: true, // legitimate DB-less policy test: evaluate the supplied row
    category: 'search',
    name: 'articles',
    scope: ({ fields }) => fields.deletedAt.isNull(),
    fields: { deletedAt: date() },
  });
  const absent = await adapter.admit({
    category: 'search', operation: 'search', principal: alice, resourceName: 'articles', row: { id: 'a1' },
  });
  assert.equal(absent.admitted, false, 'a row that omits the field is not "deleted at null"');
  assert.equal(absent.reasonCode, 'no-row-scope');
  const nullField = await adapter.admit({
    category: 'search', operation: 'search', principal: alice, resourceName: 'articles', row: { id: 'a1', deletedAt: null },
  });
  assert.equal(nullField.admitted, true, 'a present NULL satisfies isNull');
});

// --- decisions are immutable and free of payload values ------------------------

test('decisions are frozen and traces never carry payload values', async () => {
  const adapter = createAuthorizationAdapter({ trace: true });
  const d = await adapter.admit({
    category: 'entity', verb: 'update', principal: alice, entity: ownedNote(), row: bobRow,
  });
  assert.ok(Object.isFrozen(d));
  assert.ok(Object.isFrozen(d.capabilities));
  assert.ok(Object.isFrozen(d.trace));
  assert.ok(d.trace.every((entry) => !String(entry.outcome).includes('bob')));
  assert.ok(d.trace.every((entry) => typeof entry.check === 'string' && typeof entry.outcome === 'boolean'));
});

test('entity admission runs .can (rowCapabilities) exactly once per admitted request', async () => {
  let canCalls = 0;
  const CountedNote = entity('CountedNote', {
    body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) => {
        canCalls += 1;
        return (await is.owner()) ? grant(read, write, subscribe) : deny('no');
      }),
    ],
  });
  const adapter = createAuthorizationAdapter();
  const d = await adapter.admit({
    category: 'entity', verb: 'update', principal: alice, entity: CountedNote, row: aliceRow,
  });
  assert.equal(d.admitted, true);
  assert.deepEqual(d.capabilities, [read, write, subscribe]);
  assert.equal(canCalls, 1, '.can must execute exactly once per admitted entity request');
});

test('DB-less three-valued anyOf(is.owner(), is.collaborator()) admits owner and fails closed for non-owners', async () => {
  const adapter = createAuthorizationAdapter();
  adapter.registerResource({
    allowRowScopeFallback: true, // legitimate DB-less policy test: evaluate the supplied row
    category: 'search',
    name: 'docs',
    scope: ({ is }) => anyOf(is.owner(), is.collaborator()),
    fields: {
      owner: ref('User', { role: 'owner' }),
      collaborators: map(ref('User')),
    },
    checks: { collaborator: ({ docs, principal: p }) => docs.collaborators.has(p.id) },
  });
  // Owner branch proves true even though membership branch is UNEVALUABLE without DB.
  const ownerDecision = await adapter.admit({
    category: 'search', operation: 'search', principal: alice, resourceName: 'docs',
    row: { id: 'd1', owner: 'alice' },
  });
  assert.equal(ownerDecision.admitted, true, 'owner admits under 3VL anyOf(owner, membership)');

  // Non-owner: owner branch is false and membership branch is UNEVALUABLE → fail closed.
  const nonOwnerDecision = await adapter.admit({
    category: 'search', operation: 'search', principal: bob, resourceName: 'docs',
    row: { id: 'd1', owner: 'alice' },
  });
  assert.equal(nonOwnerDecision.admitted, false, 'non-owner fails closed without DB');
  assert.equal(nonOwnerDecision.reasonCode, 'no-row-scope');

  // Anonymous: owner branch is UNEVALUABLE (NULL) and membership is UNEVALUABLE → fail closed.
  const anonDecision = await adapter.admit({
    category: 'search', operation: 'search', principal: anonymous, resourceName: 'docs',
    row: { id: 'd1', owner: 'alice' },
  });
  assert.equal(anonDecision.admitted, false, 'anonymous fails closed without DB');
  assert.equal(anonDecision.reasonCode, 'no-row-scope');
});
