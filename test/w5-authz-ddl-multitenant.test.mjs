// Wave 1 lane w5-authz-ddl-multitenant: focused regression coverage for the
// authorization/DDL seams hardened in this lane.
//
//   1. the authorization adapter compiles an inherited scope's `.where()`
//      refinement with the resource's fields/registry/entityName context;
//   2. nearest metadata survives re-lowering an inherited AST and a membership
//      overlay instead of silently degrading to SQL `1=1`;
//   3. cyclic inherit graphs fail closed (no stack overflow) and one walk
//      re-uses an ancestor row lookup across its multi-hop checks;
//   4. declared ref FK columns are indexed even without `physical: true`, and
//      colliding generated index names are deduplicated.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { text, ref, map, vector, scope, grant, read, everyone, principal } from '../build/index.mjs';
import { entity, inherit } from '../build/internal.mjs';
import { compileInheritScope, makeNode } from '../build/scope-sql.mjs';
import { createAuthorizationAdapter } from '../build/authorization-adapter.mjs';
import { mayRow, rowCapabilities } from '../build/row-grant.mjs';
import { generateDDL, generatedIndexNames } from '../build/ddl.mjs';
import { membership } from '../build/auth/membership.mjs';

const alice = principal({ type: 'user', id: 'alice' });
const grants = () => grant(read);

// --- 1. inherit context loss in the authorization adapter --------------------

test('an adapter inherited scope compiles child .where() is.* checks with the resource registry', () => {
  const Parent = entity('W5AuthParent', {
    label: text(),
    subscribers: map(ref('User')),
    checks: {
      subscriber: ({ W5AuthParent, principal: p }) => W5AuthParent.subscribers.has(p.id),
    },
    grant: () => [scope(({ is }) => is.subscriber())],
  });

  const adapter = createAuthorizationAdapter();
  // Before the fix, compileInheritScope received only `{ where }`, so the child
  // predicate's `is.owner()` saw an empty registry and threw "no check 'owner'"
  // at registration time.
  assert.doesNotThrow(() => adapter.registerResource({
    category: 'search',
    name: 'w5-inherit-is-check',
    scope: inherit(Parent, { via: 'parentId' }).where(({ is }) => is.owner()),
    fields: {
      parentId: ref(Parent),
      owner: ref('User', { role: 'owner' }),
    },
    allowRowScopeFallback: true,
  }));
});

test('an adapter inherited scope compiles child .where() field handles with the resource fields', () => {
  const Parent = entity('W5AuthParentFields', {
    label: text(),
    subscribers: map(ref('User')),
    checks: {
      subscriber: ({ W5AuthParentFields, principal: p }) => W5AuthParentFields.subscribers.has(p.id),
    },
    grant: () => [scope(({ is }) => is.subscriber())],
  });

  const adapter = createAuthorizationAdapter();
  assert.doesNotThrow(() => adapter.registerResource({
    category: 'search',
    name: 'w5-inherit-field-check',
    scope: inherit(Parent, { via: 'parentId' }).where(({ fields }) => fields.status.is('live')),
    fields: { parentId: ref(Parent), status: text() },
    allowRowScopeFallback: true,
  }));
});

// --- 2. nearest preservation across inherit + membership ---------------------

test('re-lowering an inherited AST carries the parent nearest spec upward', () => {
  const spec = { entity: 'W5VecParent', field: 'embedding', query: [1, 0, 0], k: 2 };
  const parent = { name: 'W5VecParent', scopeAst: makeNode({ node: 'nearest', ...spec }) };

  const once = compileInheritScope(inherit(parent, { via: 'parentId' }), { where: 'one hop' });
  assert.deepEqual(once.nearest, spec, 'the nearest predicate is not reduced to 1=1');
  assert.match(once.sql, /EXISTS/);

  // A second hop re-lowers an AST that is itself a join: nearest must survive
  // through both levels of sub-lowering.
  const mid = { name: 'W5VecMid', scopeAst: once.ast };
  const nested = compileInheritScope(inherit(mid, { via: 'midId' }), { where: 'two hops' });
  assert.deepEqual(nested.nearest, spec);
});

test('two nearest predicates in one inherited scope fail closed', () => {
  const parent = {
    name: 'W5VecParentTwo',
    scopeAst: makeNode({
      node: 'nearest', entity: 'W5VecParentTwo', field: 'embedding', query: [1, 0, 0], k: 2,
    }),
  };
  assert.throws(
    () => compileInheritScope(
      inherit(parent, { via: 'parentId' }).where(({ fields }) => fields.other.nearest([0, 1, 0], 1)),
      { where: 'two nearest', fields: { other: vector(3) }, entityName: 'W5VecChild' },
    ),
    /only one .nearest\(\) predicate is allowed per scope/,
  );
});

test('a membership overlay keeps the full read-scope template shape including nearest', () => {
  const Doc = entity('W5MembershipDoc', {
    owner: ref('User', { role: 'owner' }),
    members: map(ref('User')),
    grant: () => [scope(() => everyone()).can(async () => grant(read))],
  });
  membership(Doc, { member: { can: [read], field: { name: 'members', role: 'member' } } });

  assert.ok(Doc.readScope, 'the overlay produced a compiled read scope');
  assert.ok(Object.hasOwn(Doc.readScope, 'nearest'), 'nearest metadata is carried, not dropped');
  assert.equal(Doc.readScope.nearest, null, 'this membership predicate has no nearest arm');
  assert.ok(Doc.scopeAst, 'the harvested AST survives the overlay');
});

// --- 3. cycle guard + per-call ancestor memoization --------------------------

function cyclicInherit({ withChildCan }) {
  const A = { name: 'W5CycleA' };
  const B = { name: 'W5CycleB' };
  const childCan = withChildCan ? { childCan: () => grant(read) } : {};
  A.grant = { inherit: B, via: 'bId', ...childCan };
  B.grant = { inherit: A, via: 'aId', ...childCan };
  const runtime = { entityOf: (target) => target };
  A.runtime = runtime;
  B.runtime = runtime;
  A.findById = () => ({ id: 'b1', aId: 'a1' });
  B.findById = () => ({ id: 'a1', bId: 'b1' });
  return { A, rowA: { id: 'a1', bId: 'b1' } };
}

test('a cyclic inherit graph denies mayRow and rowCapabilities instead of overflowing', async () => {
  for (const withChildCan of [false, true]) {
    const { A, rowA } = cyclicInherit({ withChildCan });
    assert.equal(await mayRow(A, 'read', rowA, alice), false, 'a cycle denies the verb');
    const decision = await rowCapabilities(A, rowA, alice);
    assert.equal(decision.granted, false, 'a cycle confers no capabilities');
  }
});

test('one walk reuses an ancestor row lookup across a multi-hop capability check', async () => {
  let rootFinds = 0;
  const Root = {
    name: 'W5MemoRoot',
    grant: grants,
    findById(id) {
      rootFinds += 1;
      return { id, owner: alice.id };
    },
  };
  const Leaf = {
    name: 'W5MemoLeaf',
    grant: { inherit: Root, via: 'rootId' },
    runtime: { entityOf: (target) => target },
  };
  const row = { id: 'leaf', rootId: 'root' };

  // mayRow traverses Root once through the inherit recursion and again from the
  // capability-refinement path; the per-call memo collapses both findById calls.
  assert.equal(await mayRow(Leaf, 'read', row, alice), true);
  assert.equal(rootFinds, 1);

  rootFinds = 0;
  const decision = await rowCapabilities(Leaf, row, alice);
  assert.equal(decision.granted, true);
  assert.equal(rootFinds, 1, 'rowCapabilities reuses the same ancestor lookup');
});

// --- 4. multi-tenant FK indexing + generated index names ---------------------

test('declared ref FKs are indexed without physical:true; unresolved logical refs are not', () => {
  const Parent = entity('W5DdlParent', { name: text(), grant: grants });
  const Child = entity('W5DdlChild', {
    tenantId: ref(Parent),                 // a relation FK, no physical constraint
    selfId: ref('W5DdlChild'),             // self-reference
    externalId: ref('UnresolvedExternal'),  // logical only: no FK column
    grant: grants,
  });

  const ddl = generateDDL(Child).join('\n');
  assert.match(ddl, /CREATE INDEX IF NOT EXISTS "idx_W5DdlChild_tenantId" ON "W5DdlChild" \("tenantId"\);/);
  assert.match(ddl, /CREATE INDEX IF NOT EXISTS "idx_W5DdlChild_selfId" ON "W5DdlChild" \("selfId"\);/);
  assert.doesNotMatch(ddl, /idx_W5DdlChild_externalId/, 'an unresolved logical ref has no index');
  assert.doesNotMatch(ddl, /FOREIGN KEY/, 'indexing widens without changing physical FK emission');
});

test('a ref field also declared in indexes emits one CREATE INDEX for its name', () => {
  const Parent = entity('W5DdlDedupParent', { name: text(), grant: grants });
  const entityRecord = {
    name: 'W5DdlDedup',
    fields: {
      tenantId: { ...ref(Parent), indexed: true },
    },
    indexes: [{ fields: ['tenantId'], unique: false }],
  };

  const statements = generateDDL(entityRecord).filter((sql) => sql.startsWith('CREATE INDEX'));
  const forTenant = statements.filter((sql) => sql.includes('"idx_W5DdlDedup_tenantId"'));
  assert.equal(forTenant.length, 1, 'no colliding idx_Entity_field CREATE INDEX pair');
  assert.deepEqual(
    generatedIndexNames(entityRecord).filter((name) => name === 'idx_W5DdlDedup_tenantId'),
    ['idx_W5DdlDedup_tenantId'],
    'the census sees the same single generated index name',
  );
});
