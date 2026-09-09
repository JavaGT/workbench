import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import workbench from '../build/index.mjs';
import { defineSqliteSchema } from '../build/server.mjs';

const schema = defineSqliteSchema({
  name: 'annotated-contribution-admission',
  tables: [],
  externalTables: [{ name: 'PrivateProjection', columns: ['value'] }],
});

const principal = { type: 'user', id: 'editor', attributes: {} };

function contribution(overrides = {}) {
  return {
    kind: 'text.insert',
    opId: ['editor', 'op-1'],
    anchor: ['doc-1', 0],
    text: 'hi',
    scalarCount: 2,
    ...overrides,
  };
}

function privateFact(contributionValue, overrides = {}) {
  return {
    version: 2,
    kind: 'annotated-text.contribution',
    documentId: 'doc-1',
    contribution: contributionValue,
    ...overrides,
  };
}

function compensationFact(contributionValue, overrides = {}) {
  return {
    version: 2,
    kind: 'annotated-text.compensation',
    documentId: 'doc-1',
    linkage: {
      rootActionId: 'origin',
      targetActionId: 'target',
      direction: 'undo',
      outcome: 'applied',
    },
    contribution: contributionValue,
    redo: contributionValue,
    ...overrides,
  };
}

async function dispatchFact(t, fact, actionId = 'fact') {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE PrivateProjection (value TEXT)');
  const app = workbench({
    db, schema,
    actions: [{
      type: 'annotated.fact',
      authorize: () => true,
      handler: () => ({
        events: [{ type: 'annotated.fact.committed', scope: 'owner:owner', data: {} }],
        privateFact: fact,
      }),
      projections: [{ eventTypes: ['annotated.fact.committed'], apply: () => {} }],
    }],
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  return app.dispatch({
    actionId,
    scope: 'owner:owner',
    type: 'annotated.fact',
    payload: {},
    principal,
  });
}

test('annotated contribution admission accepts v2 and legacy blockId facts at both history gates', async (t) => {
  const v2 = await dispatchFact(t, privateFact(contribution()), 'v2-origin');
  assert.equal(v2.ok, true, JSON.stringify(v2));

  const legacy = await dispatchFact(t, privateFact(contribution({ blockId: 'block-1' })), 'legacy-origin');
  assert.equal(legacy.ok, true, legacy.failure?.message);

  const compensation = await dispatchFact(t, compensationFact(contribution()), 'compensation');
  assert.equal(compensation.ok, true, compensation.failure?.message);
});

test('annotated contribution admission rejects malformed contribution shapes without durable writes', async (t) => {
  const cases = [
    ['invalid kind', contribution({ kind: 'text.delete' })],
    ['missing key', (() => { const value = contribution(); delete value.text; return value; })()],
    ['extra key', contribution({ unexpected: true })],
    ['zero scalarCount', contribution({ scalarCount: 0 })],
    ['fractional scalarCount', contribution({ scalarCount: 1.5 })],
    ['malformed overlap removals', contribution({ overlapRemovals: [{}] })],
    ['overlap removal with extra key', contribution({ overlapRemovals: [{
      annotationId: 'a1', family: 'timing', fields: {}, protectedTargetIds: [], memberships: [], extra: true,
    }] })],
  ];

  for (const [name, value] of cases) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE PrivateProjection (value TEXT)');
    const app = workbench({
      db, schema,
      actions: [{
        type: 'annotated.fact',
        authorize: () => true,
        handler: () => ({
          events: [{ type: 'annotated.fact.committed', scope: 'owner:owner', data: {} }],
          privateFact: privateFact(value),
        }),
        projections: [{ eventTypes: ['annotated.fact.committed'], apply: () => {} }],
      }],
    });
    await app.start();
    t.after(async () => { await app.shutdown(); db.close(); });
    const result = await app.dispatch({
      actionId: `invalid-${name.replaceAll(' ', '-')}`,
      scope: 'owner:owner',
      type: 'annotated.fact',
      payload: {},
      principal,
    });
    assert.equal(result.ok, false, name);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _PrivateActionFact').get().count, 0, name);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 0, name);
  }
});

test('compensation admission rejects malformed contribution shapes through its shared gate', async (t) => {
  const malformed = compensationFact(contribution({ scalarCount: 0 }));
  const result = await dispatchFact(t, malformed, 'invalid-compensation');
  assert.equal(result.ok, false);
});
