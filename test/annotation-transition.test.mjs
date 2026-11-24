// Canonical annotationTransition parser — committed home for the validator the
// post-commit transition gate imports.
//
// Regression: `src/post-commit-effects.ts` imported `parseAnnotationTransition`
// from `./annotated-text-delete-history.ts`, which never exported it, so every
// server-side import of the workbench root failed with a SyntaxError. These
// tests pin the parser contract: writer-shaped transitions (as `entity/crud.ts`
// serializes them, rangeOffsets included) parse to frozen canonical form, and
// anything malformed throws so gates fail closed.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseAnnotationTransition } from '../build/annotation-transition.mjs';

const endpoint = (affinity) => ({ point: ['point', ['root'], affinity], basisFrontier: [] });

function image(id, overrides = {}) {
  return {
    id,
    family: 'codes',
    empty: 'delete',
    cardinality: 'many',
    fields: { code: 'code-1' },
    protectedTargetIds: [],
    memberships: [{ ordinal: 0, start: endpoint('left'), end: endpoint('right') }],
    prerequisites: [],
    orphan: null,
    rangeOffsets: [{ ordinal: 0, start: 0, end: 5 }],
    ...overrides,
  };
}

test('accepts an empty transition and freezes it', () => {
  const parsed = parseAnnotationTransition({ before: [], after: [] });
  assert.deepEqual(parsed, { before: [], after: [] });
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.before) && Object.isFrozen(parsed.after));
});

test('accepts a writer-shaped single-image transition', () => {
  const parsed = parseAnnotationTransition({ before: [], after: [image('ann-1')] });
  assert.equal(parsed.after.length, 1);
  assert.equal(parsed.after[0].id, 'ann-1');
  assert.ok(Object.isFrozen(parsed.after[0]));
});

test('accepts images without the optional rangeOffsets', () => {
  const { rangeOffsets: _rangeOffsets, ...without } = image('ann-1');
  assert.ok(without.rangeOffsets === undefined);
  const parsed = parseAnnotationTransition({ before: [without], after: [] });
  assert.equal(parsed.before.length, 1);
});

test('rejects non-transitions fail-closed', () => {
  for (const bad of [null, 42, 'x', [], { before: [] }, { after: [] }, { before: {}, after: [] }, { before: [], after: {}, extra: 1 }]) {
    assert.throws(() => parseAnnotationTransition(bad), TypeError);
  }
});

test('rejects images with wrong keys or values', () => {
  const { family: _family, ...noFamily } = image('ann-1');
  assert.ok(noFamily.family === undefined);
  assert.throws(() => parseAnnotationTransition({ before: [noFamily], after: [] }), TypeError);
  assert.throws(() => parseAnnotationTransition({ before: [image('ann-1', { empty: 'keep' })], after: [] }), TypeError);
  assert.throws(() => parseAnnotationTransition({ before: [image('ann-1', { cardinality: 'one-ish' })], after: [] }), TypeError);
  assert.throws(() => parseAnnotationTransition({ before: [image('ann-1', { fields: { code: undefined } })], after: [] }), TypeError);
});

test('enforces canonical id ordering and uniqueness per side', () => {
  assert.throws(() => parseAnnotationTransition({ before: [image('b'), image('a')], after: [] }), TypeError);
  assert.throws(() => parseAnnotationTransition({ before: [image('a'), image('a')], after: [] }), TypeError);
  // Ordering is per side: the same id may appear in both before and after.
  const parsed = parseAnnotationTransition({ before: [image('a')], after: [image('a')] });
  assert.equal(parsed.before[0].id, 'a');
});

test('rejects membership/offset inconsistencies', () => {
  assert.throws(
    () => parseAnnotationTransition({ before: [image('ann-1', { rangeOffsets: [] })], after: [] }),
    TypeError,
  );
  assert.throws(
    () => parseAnnotationTransition({ before: [image('ann-1', { orphan: { savedQuote: 'q', lastRange: null } })], after: [] }),
    TypeError,
  );
  assert.throws(
    () => parseAnnotationTransition({ before: [image('ann-1', { prerequisites: [{ entity: 'Code', id: 'c1' }, { entity: 'Code', id: 'c1' }] })], after: [] }),
    TypeError,
  );
  assert.throws(
    () => parseAnnotationTransition({ before: [image('ann-1', { prerequisites: [{ entity: 'Code' }] })], after: [] }),
    TypeError,
  );
  assert.throws(
    () => parseAnnotationTransition({ before: [image('ann-1', { protectedTargetIds: ['t2', 't1'] })], after: [] }),
    TypeError,
  );
});

test('canonicalizes field order', () => {
  const parsed = parseAnnotationTransition({
    before: [],
    after: [image('ann-1', { fields: { zeta: 1, alpha: 2 } })],
  });
  assert.deepEqual(Object.keys(parsed.after[0].fields), ['alpha', 'zeta']);
});
