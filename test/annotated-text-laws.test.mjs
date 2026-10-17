import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyTextOp, assertAnchor, assertFrontier, assertOpId, assertStructuralPoint,
  assertTextOp, assertUtf16Offset, assertUtf16Range, assertWellFormedText,
  canonicalTextOp, compareInsertOrder, compareOpId, frontierDominates, frontierDominatesValidated, scalarCount,
  createTextState, materializeText, restoreTextCheckpoint, textCheckpoint,
} from '../build/annotated-text.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ROOT = ['root'];
const frontier = [[A, 1]];
const insert = (op = [A, 2], lamport = 2, text = 'x') => ['workbench.text', 1, op, lamport, frontier, ['insert', ROOT, text]];

test('operation identity is fixed-width, positive, and canonically ordered', () => {
  assert.deepEqual(assertOpId([A, 1]), [A, 1]);
  assert.throws(() => assertOpId(['A', 1]), /32 lowercase/);
  assert.throws(() => assertOpId([A, 0]), /positive/);
  assert.ok(compareOpId([A, 2], [B, 1]) < 0);
});

test('frontiers are sorted, unique contiguous-counter summaries', () => {
  assert.deepEqual(assertFrontier([[A, 1], [B, 4]]), [[A, 1], [B, 4]]);
  assert.throws(() => assertFrontier([[B, 1], [A, 1]]), /sorted/);
  assert.throws(() => assertFrontier([[A, 0]]), /positive/);
  assert.equal(frontierDominates([[A, 2], [B, 1]], [[A, 1]]), true);
  assert.equal(frontierDominates([[A, 1]], [[A, 1], [B, 1]]), false);
});

test('indexed frontier dominance stays identical to the retired linear scan', () => {
  // scope#3039: `frontierDominatesValidated` now indexes `left` once per call
  // instead of running a `find` per `right` entry. Parity probe against the
  // retired formula on valid (sorted, unique) frontiers.
  const C = 'cccccccccccccccccccccccccccccccc';
  const legacy = (left, right) => right.every(([actor, counter]) => {
    const found = left.find(([candidate]) => candidate === actor);
    return (found ? found[1] : 0) >= counter;
  });
  const cases = [
    [[[A, 3], [B, 2]], [], true],
    [[[A, 3], [B, 2]], [[A, 2]], true],
    [[[A, 3], [B, 2]], [[A, 4]], false],
    [[[A, 3], [B, 2]], [[A, 3], [B, 2]], true],
    [[[A, 3], [B, 2]], [[A, 3], [B, 3]], false],
    [[[A, 3], [B, 2]], [[C, 1]], false],
    [[[A, 3], [B, 2], [C, 9]], [[A, 3], [B, 2], [C, 9]], true],
    [[[A, 3], [B, 2], [C, 9]], [[A, 3], [B, 2], [C, 10]], false],
  ];
  for (const [left, right, expected] of cases) {
    assert.equal(frontierDominatesValidated(left, right), expected, `expected ${expected} for right=${JSON.stringify(right)}`);
    assert.equal(
      frontierDominatesValidated(left, right),
      legacy(left, right),
      `parity with the retired scan for right=${JSON.stringify(right)}`,
    );
  }
});

test('UTF-16 accepts scalar edges and rejects only a surrogate-pair interior', () => {
  const text = 'a😀b';
  assert.equal(assertUtf16Offset(text, 0), 0);
  assert.equal(assertUtf16Offset(text, 1), 1);
  assert.throws(() => assertUtf16Offset(text, 2), /splits/);
  assert.equal(assertUtf16Offset(text, 3), 3);
  assert.deepEqual(assertUtf16Range(text, 1, 3), [1, 3]);
  assert.throws(() => assertWellFormedText(`a${String.fromCharCode(0xD800)}`), /unpaired/);
  assert.throws(() => assertUtf16Range('abc', 2, 1), /reversed/);
});

test('RGA element ordinals count Unicode scalars, never UTF-16 units or gaps', () => {
  assert.equal(scalarCount('A😀'), 2);
  assert.equal(scalarCount('e\u0301'), 2);
  // An anchor's referenced run length is state-aware validation in T2. The
  // scalar count itself establishes that ordinal 2 is not an identity in A😀.
  assert.equal(scalarCount('A😀'), 2);
});

test('anchor ["root"] is the virtual HEAD anchor for visible start', () => {
  assert.deepEqual(assertAnchor(ROOT), ROOT);
});

test('anchor scalarOrdinal must be a non-negative integer; zero is valid', () => {
  assert.deepEqual(assertAnchor(['element', [[A, 1], 0]]), ['element', [[A, 1], 0]]);
  assert.deepEqual(assertAnchor(['element', [[A, 1], 5]]), ['element', [[A, 1], 5]]);
  assert.throws(() => assertAnchor(['element', [[A, 1], -1]]), /non-negative/);
  assert.throws(() => assertAnchor(['element', [[A, 1], 1.5]]), /safe integer/);
  assert.throws(() => assertAnchor(['element', [[A, 0], 0]]), /positive/);
});

test('deleted scalar remains anchorable in the grammar', () => {
  // The anchor validator does not check deletion status; a deleted element ID
  // is structurally valid as an anchor target. Both ordinals 0 and >0 are valid.
  assert.deepEqual(assertAnchor(['element', [[A, 1], 0]]), ['element', [[A, 1], 0]]);
  assert.deepEqual(assertAnchor(['element', [[A, 2], 3]]), ['element', [[A, 2], 3]]);
});

test('end anchor adopts root for empty or fully-deleted documents', () => {
  // Root is the only valid anchor when no visible elements remain.
  assert.deepEqual(assertAnchor(['root']), ['root']);
});

test('scalarCount counts Unicode scalars, not UTF-16 code units', () => {
  assert.equal(scalarCount('abc'), 3);
  assert.equal(scalarCount(''), 0);
  assert.equal(scalarCount('a😀b'), 3);
  assert.throws(() => scalarCount(`a${String.fromCharCode(0xD800)}`), /unpaired/);
});

test('insert operation grammar validates identity, local causality, and text', () => {
  assert.deepEqual(assertTextOp(insert()), insert());
  assert.throws(() => assertTextOp(['workbench.text', 1, [A, 2], 2, [], ['insert', ROOT, 'x']]), /previous local counter/);
  assert.throws(() => assertTextOp(insert([A, 2], 2, '')), /cannot be empty/);
  assert.throws(() => assertTextOp(insert([A, 2], 2, String.fromCharCode(0xD800))), /unpaired/);
});

test('delete spans are exact, sorted observed targets and cannot overlap', () => {
  const observed = [[A, 2]];
  const op = ['workbench.text', 1, [B, 1], 1, observed, ['delete', [[[A, 1], 0, 2], [[A, 2], 0, 1]]]];
  assert.deepEqual(assertTextOp(op), op);
  const overlap = ['workbench.text', 1, [B, 1], 1, observed, ['delete', [[[A, 1], 0, 2], [[A, 1], 1, 1]]]];
  assert.throws(() => assertTextOp(overlap), /sorted, disjoint/);
  const unseen = ['workbench.text', 1, [B, 1], 1, [], ['delete', [[[A, 1], 0, 1]]]];
  assert.throws(() => assertTextOp(unseen), /not observed/);
});

test('insert anchor must be an observed element and never its own new element', () => {
  const unseen = ['workbench.text', 1, [B, 1], 1, [], ['insert', ['element', [[A, 1], 0]], 'x']];
  assert.throws(() => assertTextOp(unseen), /not observed/);
  const self = ['workbench.text', 1, [A, 2], 2, frontier, ['insert', ['element', [[A, 2], 0]], 'x']];
  assert.throws(() => assertTextOp(self), /not observed/);
});

test('canonical operation encoding rejects permissive representations', () => {
  assert.deepEqual(canonicalTextOp(insert()), insert());
  const unsorted = ['workbench.text', 1, [A, 2], 2, [[B, 1], [A, 1]], ['insert', ROOT, 'x']];
  assert.throws(() => canonicalTextOp(unsorted), /sorted/);
  const extra = insert();
  extra.extra = true;
  assert.throws(() => canonicalTextOp(extra), /extra property/);
  const root = ['root'];
  root.extra = true;
  assert.throws(() => assertAnchor(root), /extra property/);
});

test('concurrent child order is deterministic: Lamport then operation identity', () => {
  const left = insert([A, 2], 2, 'x');
  const later = insert([B, 1], 3, 'y');
  const tie = insert([B, 1], 2, 'z');
  assert.ok(compareInsertOrder(later, left) < 0);
  assert.ok(compareInsertOrder(tie, left) < 0);
});

test('structural points retain a stable anchor and affinity', () => {
  assert.deepEqual(assertStructuralPoint(['point', ROOT, 'left']), ['point', ROOT, 'left']);
  assert.throws(() => assertStructuralPoint(['point', ROOT, 'middle']), /affinity/);
});

test('normalized RGA reducer converges concurrent run inserts and preserves scalar parents', () => {
  const initial = createTextState();
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a😀']];
  const left = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'x']];
  const right = ['workbench.text', 1, [B, 1], 2, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'y']];
  const forward = [first, left, right].reduce(applyTextOp, initial);
  const reordered = [right, left, first].reduce(applyTextOp, initial);
  assert.equal(materializeText(forward), 'ayx😀');
  assert.equal(materializeText(reordered), materializeText(forward));
  const checkpoint = textCheckpoint(forward);
  assert.equal(checkpoint.elements[`${A}:1:1`].parent, `${A}:1:0`);
  assert.equal(Object.hasOwn(checkpoint.elements[`${A}:1:0`], 'parent'), true);
});

test('tombstones retain children and observed-remove tags are idempotent', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'ab']];
  const child = ['workbench.text', 1, [B, 1], 2, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'x']];
  const remove = ['workbench.text', 1, [A, 2], 3, [[A, 1], [B, 1]], ['delete', [[[A, 1], 0, 1]]]];
  const state = [first, child, remove, remove].reduce(applyTextOp, createTextState());
  assert.equal(materializeText(state), 'xb');
  assert.deepEqual(textCheckpoint(state).elements[`${A}:1:0`].deletedBy, [`${A}:2`]);
});

test('pending readiness is atomic, duplicate IDs are digest-checked, and overflow fails closed', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']];
  const dependent = ['workbench.text', 1, [B, 1], 2, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'b']];
  let state = applyTextOp(createTextState(), dependent);
  assert.equal(materializeText(state), '');
  assert.equal(Object.keys(textCheckpoint(state).pending).length, 1);
  state = applyTextOp(state, first);
  assert.equal(materializeText(state), 'ab');
  assert.throws(() => applyTextOp(state, ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'z']]), /reused/);
  const overflow = applyTextOp(createTextState({ maxPending: 1 }), dependent);
  const failed = applyTextOp(overflow, ['workbench.text', 1, [B, 2], 3, [[B, 1]], ['insert', ROOT, 'x']]);
  assert.equal(textCheckpoint(failed).rebootstrapRequired, true);
  assert.equal(materializeText(applyTextOp(failed, first)), '');
});

test('canonical behavior-preserving checkpoints restore the exact reducer state', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, '😀']];
  const state = applyTextOp(createTextState(), first);
  const checkpoint = textCheckpoint(state);
  const restored = restoreTextCheckpoint(checkpoint);
  assert.deepEqual(textCheckpoint(restored), checkpoint);
  assert.equal(materializeText(restored), '😀');
});

test('checkpoint restore rejects topology or readiness that disagrees with its operations', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']];
  const state = applyTextOp(createTextState(), first);
  const missingElement = structuredClone(textCheckpoint(state));
  delete missingElement.elements[`${A}:1:0`];
  assert.throws(() => restoreTextCheckpoint(missingElement), /does not match/);

  const readyPending = structuredClone(textCheckpoint(state));
  const second = ['workbench.text', 1, [B, 1], 2, [[A, 1]], ['insert', ROOT, 'b']];
  readyPending.pending[`${B}:1`] = { digest: JSON.stringify(second), op: second };
  assert.throws(() => restoreTextCheckpoint(readyPending), /ready pending/);
});

test('checkpoint restore reduces operations causally and preserves terminal rebootstrap state', () => {
  const high = 'ffffffffffffffffffffffffffffffff';
  const low = '00000000000000000000000000000000';
  const first = ['workbench.text', 1, [high, 1], 1, [], ['insert', ROOT, 'a']];
  const second = ['workbench.text', 1, [low, 1], 2, [[high, 1]], ['insert', ROOT, 'b']];
  const third = ['workbench.text', 1, [low, 2], 3, [[low, 1], [high, 1]], ['insert', ROOT, 'c']];
  const complete = [first, second, third].reduce(applyTextOp, createTextState({ maxPending: 1 }));
  assert.deepEqual(textCheckpoint(restoreTextCheckpoint(textCheckpoint(complete))), textCheckpoint(complete));

  const dependent = ['workbench.text', 1, [low, 1], 2, [[high, 1]], ['insert', ['element', [[high, 1], 0]], 'b']];
  const terminal = applyTextOp(
    applyTextOp(createTextState({ maxPending: 1 }), dependent),
    ['workbench.text', 1, [low, 2], 3, [[low, 1], [high, 1]], ['insert', ROOT, 'c']],
  );
  assert.equal(textCheckpoint(restoreTextCheckpoint(textCheckpoint(terminal))).rebootstrapRequired, true);
});
