import { text, ref, scope, grant, deny, read, write, subscribe, inherit } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entity, explain } from '../build/internal.mjs';
import { principal } from '../build/principal.mjs';

const alice = principal({ type: 'user', id: 'alice' });
const bob = principal({ type: 'user', id: 'bob' });

function makeDoc() {
  return entity('Doc', {
    body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

test('explain row-level read for the owner (own-scope, admitted)', async () => {
  const Doc = makeDoc();
  const row = { id: 'd1', body: 'hello', owner: 'alice' };
  const result = await explain({ entity: Doc, row, principal: alice, verb: 'read' });

  assert.equal(result.verb, 'read');
  assert.equal(result.entity, 'Doc');
  assert.equal(result.admitted, true);
  // checks
  assert.ok(result.checks);
  assert.equal(result.checks.owner.source, 'ref-role');
  assert.equal(result.checks.owner.result, true);
  // grant
  assert.equal(result.grant.type, 'own-scope');
  assert.ok(result.grant.capabilities.includes('read'));
  assert.ok(result.grant.capabilities.includes('write'));
  assert.ok(result.grant.capabilities.includes('subscribe'));
  assert.ok(result.grant.verbAdmitted);
  assert.equal(result.grant.verbRequired, 'read');
  // scope
  assert.ok(result.scope);
  assert.ok(result.scope.sql.includes('owner'));
  // field is not requested
  assert.equal(result.field, undefined);
});

test('explain row-level read for a non-owner (own-scope, admitted with fewer caps)', async () => {
  const Doc = makeDoc();
  const row = { id: 'd1', body: 'hello', owner: 'alice' };
  const result = await explain({ entity: Doc, row, principal: bob, verb: 'read' });

  assert.equal(result.admitted, true);
  assert.equal(result.checks.owner.result, false);
  // grant
  assert.ok(result.grant.capabilities.includes('read'));
  assert.ok(!result.grant.capabilities.includes('write'));
  assert.ok(result.grant.verbAdmitted);
  // scope: the SQL doesn't bind for bob, so principalId param is 'bob'
  assert.ok(result.scope.sql.includes('owner'));
});

test('explain row-level write for non-owner (not admitted)', async () => {
  const Doc = makeDoc();
  const row = { id: 'd1', body: 'hello', owner: 'alice' };
  const result = await explain({ entity: Doc, row, principal: bob, verb: 'write' });

  assert.equal(result.admitted, false);
  assert.equal(result.checks.owner.result, false);
  assert.equal(result.grant.verbRequired, 'write');
  assert.equal(result.grant.verbAdmitted, false);
});

test('explain on an inherit child entity reports grant type inherit', async () => {
  const Doc = makeDoc();
  const parentEntity = { name: 'Doc', scopeAst: Doc.scopeAst, registry: Doc.registry, fields: { id: text(), owner: ref('User', { role: 'owner' }) }, grant: Doc.grant };
  const Comment = entity('Comment', {
    body: text(),
    doc: ref('Doc', { required: true }),
    grant: inherit(parentEntity, { via: 'doc' }),
  });

  const row = { id: 'c1', body: 'nice', doc: 'd1' };
  // Comment inherits Doc's grant, so rowCapabilities recurses into Doc.
  // We need a real rowCapabilities call — it will look up the parent by FK.
  // For this test, the parent lookup would fail (no real findById).
  // Instead, test the EXPLAIN shape without running full rowCapabilities.
  const result = await explain({ entity: Comment, row, principal: alice, verb: 'read' });

  assert.equal(result.grant.type, 'inherit');
  assert.ok(result.grant.chain);
  assert.equal(result.grant.chain.parentEntity, 'Doc');
  assert.equal(result.grant.chain.via, 'doc');
  // scope SQL shows the inherited JOIN
  assert.ok(result.scope.sql.includes('EXISTS'));
  // checks come from the child's own registry (empty for inherit)
  assert.deepStrictEqual(result.checks, {});
});

test('explain on an entity with no .can returns grant type none', async () => {
  const NoCan = entity('NoCan', {
    body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [scope(({ is }) => is.owner())],
  });
  const row = { id: 'r1', body: 'x', owner: 'alice' };
  const result = await explain({ entity: NoCan, row, principal: alice, verb: 'read' });

  // A scope-only grant confers exactly the read-class capabilities mayRow uses:
  // read/list/subscribe admitted, every write denied. explain reports the SAME
  // decision, not an unconditional admit.
  assert.equal(result.admitted, true);
  assert.equal(result.grant.type, 'scope-only');
  assert.deepStrictEqual(result.grant.capabilities, ['read', 'subscribe']);
  assert.equal(result.grant.verbAdmitted, true);
  assert.equal(result.grant.verbRequired, 'read');
});

test('explain with field name returns field-level decision', async () => {
  const Doc = entity('Doc', {
    body: text(),
    secret: text().can(async ({ is }) => (await is.owner()) ? grant(read) : deny('not owner')),
    owner: ref('User', { role: 'owner' }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
  const row = { id: 'd1', body: 'hi', secret: 's3cret', owner: 'alice' };

  // Owner can read secret
  let result = await explain({ entity: Doc, row, principal: alice, verb: 'read', field: 'secret' });
  assert.equal(result.admitted, true);
  assert.ok(result.field);
  assert.equal(result.field.name, 'secret');
  assert.equal(result.field.hasAccessFn, true);
  assert.equal(result.field.admitted, true);

  // Non-owner cannot read secret
  result = await explain({ entity: Doc, row, principal: bob, verb: 'read', field: 'secret' });
  assert.equal(result.admitted, false);
  assert.ok(result.field.hasAccessFn);
  assert.equal(result.field.admitted, false);
});
