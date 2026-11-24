// Wave 6 lane w6-spi-inversion-pipeline — focused verification of the
// field-kind registration SPI and the typed kernel/pipeline handler policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { attachHandlerPolicy } from '../build/kernel.mjs';
import { HANDLER_POLICY, createServer, readHandlerPolicy } from '../build/pipeline.mjs';
import {
  FIELD_KIND_CONTRIBUTIONS,
  fieldKindContribution,
  fieldKindSnapshotControlReason,
  hasFieldKindFeature,
  registerFieldKindContribution,
} from '../build/strategy/index.mjs';
import { ANNOTATED_TEXT_FIELD_KIND_CONTRIBUTION } from '../build/annotated-text-field.mjs';
import {
  hasAnnotatedTextFields,
  hasSnapshotProjectedFields,
  snapshotControlReasonFor,
} from '../build/entity-snapshot-projection.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import workbench from '../build/index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceOf = (relativePath) => readFileSync(join(root, relativePath), 'utf8');

// ---- 1. strategy/index has no upward dependency on a field kind ------------

test('strategy/index does not statically import the annotated-text field kind', () => {
  for (const path of ['src/strategy/index.ts', 'build/strategy/index.mjs']) {
    const source = sourceOf(path);
    assert.doesNotMatch(source, /\bfrom\s*['"][^'"]*annotated-text-field/, path);
    assert.doesNotMatch(source, /\bimport\s*['"][^'"]*annotated-text-field/, path);
    assert.doesNotMatch(source, /\bANNOTATED_TEXT_FIELD_KIND_CONTRIBUTION\b/, path);
  }
  assert.match(
    sourceOf('src/annotated-text-field.ts'),
    /registerFieldKindContribution\(ANNOTATED_TEXT_FIELD_KIND_CONTRIBUTION\)/,
    'the kind owns its own registration',
  );
  assert.match(sourceOf('build/annotated-text-field.mjs'), /registerFieldKindContribution\(ANNOTATED_TEXT_FIELD_KIND_CONTRIBUTION\)/);
});

// ---- 2. field-kind contributions register through the SPI ------------------

test('the annotatedText kind registers itself when loaded', () => {
  assert.equal(fieldKindContribution('annotatedText'), ANNOTATED_TEXT_FIELD_KIND_CONTRIBUTION);
  assert.ok(FIELD_KIND_CONTRIBUTIONS.includes(ANNOTATED_TEXT_FIELD_KIND_CONTRIBUTION));
  assert.ok(Object.isFrozen(FIELD_KIND_CONTRIBUTIONS));
  assert.equal(ANNOTATED_TEXT_FIELD_KIND_CONTRIBUTION.snapshotControlReason, 'annotated-text-snapshot-required');
  // Re-registering the same object is idempotent (module reload / another entry point).
  assert.doesNotThrow(() => registerFieldKindContribution(ANNOTATED_TEXT_FIELD_KIND_CONTRIBUTION));
});

test('a custom FieldKindContribution registers and queries cleanly', () => {
  const custom = Object.freeze({
    kind: 'w6CustomKind',
    blocksConditionalCreateHistory: true,
    snapshotControlReason: 'w6-custom-snapshot-required',
    rejectsPlainUpdate: () => 'w6 custom kind cannot be set through update payloads',
  });
  registerFieldKindContribution(custom);

  assert.equal(fieldKindContribution('w6CustomKind'), custom);
  assert.equal(fieldKindContribution('value'), undefined);
  assert.equal(fieldKindContribution(undefined), undefined);
  assert.ok(FIELD_KIND_CONTRIBUTIONS.includes(custom));
  assert.ok(Object.isFrozen(FIELD_KIND_CONTRIBUTIONS));
  assert.equal(
    hasFieldKindFeature({ doc: { kind: 'w6CustomKind' } }, 'blocksConditionalCreateHistory'),
    true,
  );
  assert.equal(hasFieldKindFeature({ doc: { kind: 'value' } }, 'blocksConditionalCreateHistory'), false);
  assert.equal(fieldKindSnapshotControlReason({ doc: { kind: 'w6CustomKind' } }), 'w6-custom-snapshot-required');
  assert.equal(fieldKindSnapshotControlReason({ doc: { kind: 'value' } }), null);

  // Same object is idempotent; a different object claiming the kind is rejected.
  assert.doesNotThrow(() => registerFieldKindContribution(custom));
  assert.throws(() => registerFieldKindContribution({ kind: 'w6CustomKind' }), /already registered/);
  assert.throws(() => registerFieldKindContribution(null), /non-empty kind/);
  assert.throws(() => registerFieldKindContribution({ kind: '' }), /non-empty kind/);
});

test('snapshot projection exposes a generic kind query with a compatibility alias', () => {
  const annotatedEntity = {
    name: 'Doc',
    fields: { doc: { kind: 'annotatedText' } },
    deserializeRow: (row) => row,
  };
  const plainEntity = { ...annotatedEntity, fields: { title: { kind: 'value' } } };
  assert.equal(hasSnapshotProjectedFields(annotatedEntity), true);
  assert.equal(hasAnnotatedTextFields, hasSnapshotProjectedFields);
  assert.equal(snapshotControlReasonFor(annotatedEntity), 'annotated-text-snapshot-required');
  assert.equal(hasSnapshotProjectedFields(plainEntity), false);
  assert.equal(snapshotControlReasonFor(plainEntity), null);
});

// ---- 3. typed handler policy ------------------------------------------------

const ALL_POLICY_FIELDS = [
  'inTransaction',
  'ownedResources',
  'ownedResourcePlans',
  'batchForbidden',
  'erasureCapable',
  'erasurePrepare',
  'erasurePreparationTables',
  'erasurePreparationReadTables',
  'protectedArtefactTables',
  'privateFactProjection',
  'compoundContributionPolicy',
  'dedupeReceiptMatches',
  'atomicOperation',
];

test('attachHandlerPolicy / readHandlerPolicy round-trip every policy field', () => {
  const prepare = () => {};
  const compoundPolicy = { name: 'compound' };
  const dedupe = () => true;
  const atomic = { entity: { name: 'Doc' }, read: () => ({ id: 'd1' }) };
  const plans = Object.freeze([{ pluginId: 'search', objects: [] }]);
  const policy = Object.freeze({
    inTransaction: true,
    ownedResources: true,
    ownedResourcePlans: plans,
    batchForbidden: true,
    erasureCapable: true,
    erasurePrepare: prepare,
    erasurePreparationTables: Object.freeze(['ErasureTable']),
    erasurePreparationReadTables: Object.freeze(['ReadTable']),
    protectedArtefactTables: Object.freeze(['ProtectedTable']),
    privateFactProjection: true,
    compoundContributionPolicy: compoundPolicy,
    dedupeReceiptMatches: dedupe,
    atomicOperation: atomic,
  });
  assert.deepEqual(Object.keys(policy).sort(), [...ALL_POLICY_FIELDS].sort());

  const handler = () => [];
  assert.equal(attachHandlerPolicy(handler, policy), handler);
  const read = readHandlerPolicy(handler);
  for (const key of ALL_POLICY_FIELDS) assert.equal(read[key], policy[key], key);
  assert.equal(handler[HANDLER_POLICY], read);
  assert.ok(Object.isFrozen(read), 'the attached policy is a frozen record');
  // Legacy own-property readers (annotated-text kernel seam, app shims) still work.
  for (const key of ALL_POLICY_FIELDS) assert.equal(handler[key], policy[key], `legacy ${key}`);
});

test('readHandlerPolicy falls back to legacy own properties', () => {
  const legacy = () => [];
  legacy.inTransaction = true;
  legacy.batchForbidden = true;
  legacy.atomicOperation = { entity: { name: 'Doc' } };
  const policy = readHandlerPolicy(legacy);
  assert.equal(policy.inTransaction, true);
  assert.equal(policy.batchForbidden, true);
  assert.deepEqual(policy.atomicOperation, { entity: { name: 'Doc' } });
  assert.equal(policy.ownedResources, undefined);
  assert.equal(legacy[HANDLER_POLICY], undefined);
  assert.deepEqual(readHandlerPolicy(null), {});
  assert.deepEqual(readHandlerPolicy(undefined), {});
});

test('kernel attaches one typed policy and pipeline reads only through the accessor', () => {
  const kernel = sourceOf('src/kernel.ts');
  assert.match(kernel, /attachHandlerPolicy\(handler, \{/);
  for (const field of ALL_POLICY_FIELDS) {
    assert.doesNotMatch(kernel, new RegExp(`Object\\.defineProperty\\(handler, ['"]${field}['"]`), field);
  }
  const pipeline = sourceOf('src/pipeline.ts');
  assert.match(pipeline, /export const HANDLER_POLICY = Symbol/);
  assert.match(pipeline, /export function readHandlerPolicy/);
  for (const field of ALL_POLICY_FIELDS) {
    assert.doesNotMatch(pipeline, new RegExp(`handler\\.${field}\\b`), field);
  }
  assert.match(sourceOf('build/kernel.mjs'), /attachHandlerPolicy\(handler, \{/);
  assert.match(sourceOf('build/pipeline.mjs'), /export function readHandlerPolicy/);
});

test('kernel dispatch honours the attached policy through readHandlerPolicy', async () => {
  const db = new DatabaseSync(':memory:');
  let seen = null;
  const app = workbench({
    db,
    actions: [{
      type: 'w6.ping',
      authorize: () => true,
      handler: (context) => {
        seen = {
          hasDb: Boolean(context.db),
          hasNow: typeof context.now === 'string',
          scope: context.scope,
          actionId: context.actionId,
        };
        return [{ type: 'w6.pinged', scope: 'Doc:d1', data: { actionId: context.actionId } }];
      },
    }],
  });
  await app.start();
  try {
    const result = await app.dispatch({
      actionId: 'w6-kernel-1', type: 'w6.ping', scope: 'Doc:d1',
      payload: {}, principal: { id: 'u1' },
    });
    assert.equal(result.ok, true, result.failure?.message);
    assert.deepEqual(seen, {
      hasDb: true, hasNow: true, scope: 'Doc:d1', actionId: 'w6-kernel-1',
    }, 'the declared action ran with its in-transaction policy');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM _Log WHERE eventType = 'w6.pinged'").get().n, 1);
  } finally {
    await app.shutdown();
    db.close();
  }
});

test('pipeline dispatch honours a legacy inTransaction flag via the fallback path', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  let hasDb = false;
  const handler = (context) => {
    hasDb = Boolean(context.db);
    return [{ type: 'w6.legacy.done', scope: 'Doc:d1', data: {} }];
  };
  handler.inTransaction = true; // attached directly, with no typed policy symbol
  const server = createServer({ db, handlers: { 'w6.legacy': handler }, authorize: () => true });
  try {
    const result = await server.dispatch({
      actionId: 'w6-legacy-1', type: 'w6.legacy', scope: 'Doc:d1',
      payload: {}, principal: { id: 'u1' },
    });
    assert.equal(result.ok, true, result.failure?.message);
    assert.equal(hasDb, true, 'fallback read of the legacy flag still routes into the transaction');
  } finally {
    db.close();
  }
});
