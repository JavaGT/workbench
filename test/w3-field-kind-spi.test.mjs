// Wave 3 lane w3-field-kind-spi: field-kind contribution SPI.
//
// Core modules must not branch on the annotatedText kind string. They query the
// FieldKindContribution registry in strategy/index.ts instead. The annotatedText
// kind owns its behavior in ONE descriptor, exported by annotated-text-field.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  FIELD_KIND_CONTRIBUTIONS,
  fieldKindContribution,
  hasFieldKindFeature,
  isFieldKindOperationEvent,
  markFieldKindProjections,
  resolveFieldKindEventScope,
  suppressesFieldKindDelta,
  validateFieldKindEntities,
} from '../build/strategy/index.mjs';
import { ANNOTATED_TEXT_FIELD_KIND_CONTRIBUTION } from '../build/annotated-text-field.mjs';
import { EventKind } from '../build/event-handle.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const CORE_MODULES = [
  {
    path: 'src/entity/compile.ts',
    seam: ['validateFieldKindEntities', 'resolveFieldKindEventScope', 'hasFieldKindFeature'],
  },
  {
    path: 'src/entity/crud.ts',
    seam: ['resolveFieldKindEventScope', 'fieldKindContribution'],
  },
  {
    path: 'src/entity/projection.ts',
    seam: ['fieldKindContribution', 'markFieldKindProjections'],
  },
  {
    path: 'src/entity-snapshot-projection.ts',
    seam: ['fieldKindContribution', 'hasFieldKindFeature'],
  },
  {
    path: 'src/live-fanout.ts',
    seam: ['hasFieldKindFeature', 'isFieldKindOperationEvent', 'suppressesFieldKindDelta'],
  },
];

const HARDCODED_KIND = /\.kind\s*(?:!==|===|!=|==)\s*['"]annotatedText['"]/g;

function sourceOf(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function emittedPath(relativePath) {
  return relativePath.replace(/^src\//, 'build/').replace(/\.ts$/, '.mjs');
}

for (const { path, seam } of CORE_MODULES) {
  test(`${path}: no hardcoded annotatedText kind branches`, () => {
    const source = sourceOf(path);
    assert.deepEqual(source.match(HARDCODED_KIND) ?? [], [], `${path} still branches on the kind string`);
    const emitted = sourceOf(emittedPath(path));
    assert.deepEqual(emitted.match(HARDCODED_KIND) ?? [], [], `${emittedPath(path)} still branches on the kind string`);
  });

  test(`${path}: routes through the field-kind contribution registry`, () => {
    const source = sourceOf(path);
    for (const symbol of seam) {
      assert.match(source, new RegExp(`\\b${symbol}\\b`), `${path} never queries ${symbol}`);
      assert.match(sourceOf(emittedPath(path)), new RegExp(`\\b${symbol}\\b`), `${emittedPath(path)} never queries ${symbol}`);
    }
  });
}

test('registry is frozen and owns exactly the annotatedText contribution', () => {
  assert.ok(Object.isFrozen(FIELD_KIND_CONTRIBUTIONS));
  assert.deepEqual(FIELD_KIND_CONTRIBUTIONS.map((contribution) => contribution.kind), ['annotatedText']);
  assert.equal(fieldKindContribution('annotatedText'), ANNOTATED_TEXT_FIELD_KIND_CONTRIBUTION);
  assert.equal(fieldKindContribution('value'), undefined);
  assert.equal(fieldKindContribution(undefined), undefined);
  assert.ok(Object.isFrozen(ANNOTATED_TEXT_FIELD_KIND_CONTRIBUTION));
});

test('the annotatedText contribution concentrates the core-loop hooks', () => {
  for (const hook of [
    'validateEntityFields',
    'resolveEntityEventScope',
    'rejectsPlainUpdate',
    'projectRowField',
    'markEntityProjection',
    'snapshotField',
    'isOperationEvent',
    'suppressesDelta',
  ]) {
    assert.equal(typeof ANNOTATED_TEXT_FIELD_KIND_CONTRIBUTION[hook], 'function', `missing ${hook}`);
  }
  assert.equal(ANNOTATED_TEXT_FIELD_KIND_CONTRIBUTION.blocksConditionalCreateHistory, true);
});

test('hasFieldKindFeature is driven by declared field kinds', () => {
  assert.equal(hasFieldKindFeature({ doc: { kind: 'annotatedText' } }, 'snapshotField'), true);
  assert.equal(hasFieldKindFeature({ doc: { kind: 'value' } }, 'snapshotField'), false);
  assert.equal(hasFieldKindFeature({ doc: { kind: 'annotatedText' } }, 'blocksConditionalCreateHistory'), true);
  assert.equal(hasFieldKindFeature({}, 'snapshotField'), false);
});

test('validateFieldKindEntities delegates annotatedText declaration validation to the contribution', () => {
  assert.throws(
    () => validateFieldKindEntities('Doc', { doc: { kind: 'annotatedText' } }),
    /must name an enclosing ref field/,
  );
  assert.doesNotThrow(() => validateFieldKindEntities('Doc', { title: { kind: 'value', type: 'text' } }));
});

test('resolveFieldKindEventScope returns the contributed owning scope', () => {
  const fields = {
    doc: { kind: 'annotatedText', project: 'project' },
    project: { kind: 'value', type: 'ref', target: 'Project' },
  };
  assert.equal(resolveFieldKindEventScope({ name: 'Doc', fields }, { project: 'p1' }), 'Project:p1');
  assert.equal(resolveFieldKindEventScope({ name: 'Doc', fields: { title: { kind: 'value' } } }, {}), null);
});

test('plain-update rejection and recipient redaction come from the contribution', () => {
  const field = { kind: 'annotatedText' };
  assert.match(fieldKindContribution(field.kind).rejectsPlainUpdate(field), /cannot be set through update payloads/);
  const placeholder = fieldKindContribution(field.kind).projectRowField(field, 'doc', {}, undefined);
  assert.equal(placeholder.kind, 'workbench.annotatedText.recipient');
  assert.equal(placeholder.restricted, true);
  assert.equal(fieldKindContribution('value')?.rejectsPlainUpdate, undefined);
});

test('operation-event classification and delta suppression come from the contribution', () => {
  const fields = { doc: { kind: 'annotatedText' }, title: { kind: 'value' } };
  const base = { eventScope: 'Doc:d1', directScope: 'Doc:d1' };
  const operated = { handle: { kind: EventKind.native, nativeName: 'operated', field: 'doc' }, ...base };
  const applied = { handle: { kind: EventKind.native, nativeName: 'applied', field: 'doc' }, ...base };

  assert.equal(isFieldKindOperationEvent(fields, operated), true);
  assert.equal(isFieldKindOperationEvent(fields, applied), false);
  assert.equal(isFieldKindOperationEvent(fields, { ...operated, handle: { ...operated.handle, field: 'title' } }), false);
  assert.equal(isFieldKindOperationEvent(fields, { ...operated, eventScope: 'other' }), false);

  assert.equal(suppressesFieldKindDelta({ scopeAnchored: false, isOperationEvent: true, ephemeralField: null, entityHasContributedKind: true }), true);
  assert.equal(suppressesFieldKindDelta({ scopeAnchored: false, isOperationEvent: false, ephemeralField: 'caret', entityHasContributedKind: true }), true);
  assert.equal(suppressesFieldKindDelta({ scopeAnchored: false, isOperationEvent: false, ephemeralField: 'caret', entityHasContributedKind: false }), false);
  assert.equal(suppressesFieldKindDelta({ scopeAnchored: true, isOperationEvent: true, ephemeralField: null, entityHasContributedKind: true }), false);
});

test('markFieldKindProjections is a no-op for entities without contributed fields', () => {
  const projection = Object.freeze({ eventTypes: [], apply() {} });
  assert.doesNotThrow(() => markFieldKindProjections(projection, { title: { kind: 'value' } }));
  assert.doesNotThrow(() => markFieldKindProjections(projection, { doc: { kind: 'annotatedText' } }));
});
