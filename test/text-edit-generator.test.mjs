import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyTextOp, createTextState, materializeText,
  assertAnchor as _assertAnchor, assertFrontier as _assertFrontier, assertOpId as _assertOpId, compareOpId as _compareOpId,
  assertTextOp as _assertTextOp, assertUtf16Offset as _assertUtf16Offset, assertUtf16Range as _assertUtf16Range, assertWellFormedText as _assertWellFormedText,
  canonicalTextOp, scalarCount as _scalarCount,
} from '../build/annotated-text.mjs';
import {
  resolveUtf16ToAnchor, collectVisibleScalarIds, insertText, deleteText,
} from '../public/workbench-text-edit.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccccccccc';

function stateFrom(ops) {
  return ops.reduce(applyTextOp, createTextState());
}

function id(actor = A, counter = 1, lamport = 1) {
  return { actor, counter, lamport };
}

const ROOT_LEFT = ['point', ['root'], 'left'];
const _ROOT_RIGHT = ['point', ['root'], 'right'];

// --- resolveUtf16ToAnchor ---

test('resolveUtf16ToAnchor: offset 0 on empty document returns root-left', () => {
  const s = createTextState();
  assert.deepEqual(resolveUtf16ToAnchor(s, 0), ROOT_LEFT);
});

test('resolveUtf16ToAnchor: offset 0 on non-empty document returns root-left', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'hello']]]);
  assert.deepEqual(resolveUtf16ToAnchor(s, 0), ROOT_LEFT);
});

test('resolveUtf16ToAnchor: offset in middle returns right-affinity of containing scalar', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'abc']]]);
  const anchor = resolveUtf16ToAnchor(s, 2);
  assert.equal(anchor[0], 'point');
  assert.deepEqual(anchor[1], ['element', [[A, 1], 1]]);
  assert.equal(anchor[2], 'right');
});

test('resolveUtf16ToAnchor: offset at end returns last scalar right', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'abc']]]);
  const anchor = resolveUtf16ToAnchor(s, 3);
  assert.equal(anchor[0], 'point');
  assert.deepEqual(anchor[1], ['element', [[A, 1], 2]]);
  assert.equal(anchor[2], 'right');
});

test('resolveUtf16ToAnchor: emoji pair is single scalar', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'a😀b']]]);
  // 'a' = offset 0-1, 😀 = offset 1-3, 'b' = offset 3-4
  const anchor0 = resolveUtf16ToAnchor(s, 0);
  assert.deepEqual(anchor0, ROOT_LEFT);
  const anchor1 = resolveUtf16ToAnchor(s, 1);
  assert.deepEqual(anchor1[1], ['element', [[A, 1], 0]]);
  const anchor3 = resolveUtf16ToAnchor(s, 3);
  assert.deepEqual(anchor3[1], ['element', [[A, 1], 1]]);
  const anchor4 = resolveUtf16ToAnchor(s, 4);
  assert.deepEqual(anchor4[1], ['element', [[A, 1], 2]]);
});

test('resolveUtf16ToAnchor: rejects split surrogate offset', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'a😀b']]]);
  assert.throws(() => resolveUtf16ToAnchor(s, 2), /splits/);
});

test('resolveUtf16ToAnchor: combining marks are separate scalars', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'e\u0301']]]);
  // 'e' = offset 0-1, combining acute = offset 1-2
  const anchor1 = resolveUtf16ToAnchor(s, 1);
  assert.deepEqual(anchor1[1], ['element', [[A, 1], 0]]);
  const anchor2 = resolveUtf16ToAnchor(s, 2);
  assert.deepEqual(anchor2[1], ['element', [[A, 1], 1]]);
});

test('resolveUtf16ToAnchor: deleted scalars are invisible', () => {
  const s = stateFrom([
    ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'abc']],
    ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 1, 1]]]],
  ]);
  // 'b' is deleted, so visible text is 'ac'. offsets: a=0-1, c=1-2.
  // Offset 1 is boundary between a and c, so after-scalar of a (element 0 right).
  assert.deepEqual(resolveUtf16ToAnchor(s, 0), ROOT_LEFT);
  const anchor1 = resolveUtf16ToAnchor(s, 1);
  assert.deepEqual(anchor1[1], ['element', [[A, 1], 0]]);
  assert.equal(anchor1[2], 'right');
  // Offset 2 is end of visible text: last visible scalar right.
  const anchor2 = resolveUtf16ToAnchor(s, 2);
  assert.deepEqual(anchor2[1], ['element', [[A, 1], 2]]);
  assert.equal(anchor2[2], 'right');
});

test('resolveUtf16ToAnchor: empty after delete returns root-right', () => {
  const s = stateFrom([
    ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'a']],
    ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 0, 1]]]],
  ]);
  assert.equal(materializeText(s), '');
  assert.deepEqual(resolveUtf16ToAnchor(s, 0), ROOT_LEFT);
});

test('resolveUtf16ToAnchor: concurrent inserts preserve order', () => {
  const s = stateFrom([
    ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'a']],
    ['workbench.text', 1, [B, 1], 2, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'x']],
  ]);
  // RGA DFS: root -> a (lamport=1) -> x (child of a, lamport=2). visible: 'ax'
  assert.equal(materializeText(s), 'ax');
  assert.deepEqual(resolveUtf16ToAnchor(s, 0), ROOT_LEFT);
  const anchor1 = resolveUtf16ToAnchor(s, 1);
  assert.deepEqual(anchor1[1], ['element', [[A, 1], 0]]);
  assert.equal(anchor1[2], 'right');
});

// --- collectVisibleScalarIds ---

test('collectVisibleScalarIds: empty range returns empty', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'abc']]]);
  assert.deepEqual(collectVisibleScalarIds(s, 0, 0), []);
  assert.deepEqual(collectVisibleScalarIds(s, 2, 2), []);
});

test('collectVisibleScalarIds: collects half-open range by scalar', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'abc']]]);
  const ids = collectVisibleScalarIds(s, 1, 3);
  assert.equal(ids.length, 2);
  assert.deepEqual(ids[0], [[A, 1], 1]);
  assert.deepEqual(ids[1], [[A, 1], 2]);
});

test('collectVisibleScalarIds: emoji respects scalar boundaries', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'a😀b']]]);
  // offset 1-3 covers the emoji scalar only
  const ids = collectVisibleScalarIds(s, 1, 3);
  assert.equal(ids.length, 1);
  assert.deepEqual(ids[0], [[A, 1], 1]);
});

test('collectVisibleScalarIds: skips deleted scalars', () => {
  const s = stateFrom([
    ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'abc']],
    ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 1, 1]]]],
  ]);
  const ids = collectVisibleScalarIds(s, 0, 2);
  assert.equal(ids.length, 2);
  assert.deepEqual(ids[0], [[A, 1], 0]);
  assert.deepEqual(ids[1], [[A, 1], 2]);
});

test('collectVisibleScalarIds: rejects split surrogate range', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'a😀b']]]);
  // offset 2 is inside the surrogate pair, so this should throw
  assert.throws(() => collectVisibleScalarIds(s, 0, 2), /splits/);
});

// --- insertText ---

test('insertText: inserts at root-left in empty document', () => {
  const s = createTextState();
  const op = insertText(s, id(A, 1, 1), 0, 'hello');
  assert.equal(op[0], 'workbench.text');
  assert.equal(op[1], 1);
  assert.deepEqual(op[2], [A, 1]);
  assert.deepEqual(op[5], ['insert', ['root'], 'hello']);
  const applied = applyTextOp(s, op);
  assert.equal(materializeText(applied), 'hello');
});

test('insertText: inserts at correct anchor in populated document', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'abc']]]);
  const op = insertText(s, id(A, 2, 2), 1, 'xy');
  assert.deepEqual(op[5][1], ['element', [[A, 1], 0]]);
  const applied = applyTextOp(s, op);
  assert.equal(materializeText(applied), 'axybc');
});

test('insertText: inserts at end of document', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'abc']]]);
  const op = insertText(s, id(A, 2, 2), 3, 'z');
  assert.deepEqual(op[5][1], ['element', [[A, 1], 2]]);
  const applied = applyTextOp(s, op);
  assert.equal(materializeText(applied), 'abcz');
});

test('insertText: counter must be one past actor frontier', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'abc']]]);
  assert.throws(() => insertText(s, id(A, 1, 2), 0, 'x'), /one past/);
});

test('insertText: rejects empty text', () => {
  assert.throws(() => insertText(createTextState(), id(A, 1, 1), 0, ''), /cannot be empty/);
});

test('insertText: rejects split surrogate offset', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'a😀b']]]);
  assert.throws(() => insertText(s, id(A, 2, 2), 2, 'x'), /splits/);
});

test('insertText: produces canonical operation', () => {
  const s = createTextState();
  const op = insertText(s, id(A, 1, 1), 0, 'hello');
  assert.doesNotThrow(() => canonicalTextOp(op));
});

test('insertText: multiple inserts with emoji', () => {
  let s = createTextState();
  s = applyTextOp(s, insertText(s, id(A, 1, 1), 0, '😀'));
  assert.equal(materializeText(s), '😀');
  // '😀' is 2 UTF-16 units, so insert at offset 2 (after emoji)
  s = applyTextOp(s, insertText(s, id(A, 2, 2), 2, 'b'));
  assert.equal(materializeText(s), '😀b');
  s = applyTextOp(s, insertText(s, id(B, 1, 2), 0, 'a'));
  // a is inserted at root-left, which is before '😀b'. visible: 'a😀b'
  assert.equal(materializeText(s), 'a😀b');
});

// --- deleteText ---

test('deleteText: deletes exact range and groups by source op', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'abcde']]]);
  const op = deleteText(s, id(A, 2, 2), 1, 4);
  assert.deepEqual(op[5][1], [[[A, 1], 1, 3]]);
  const applied = applyTextOp(s, op);
  assert.equal(materializeText(applied), 'ae');
});

test('deleteText: compact disjoint spans from same source op', () => {
  const s = stateFrom([
    ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'abc']],
    ['workbench.text', 1, [B, 1], 2, [[A, 1]], ['delete', [[[A, 1], 1, 1]]]],
  ]);
  // The visible range 'ac' corresponds to non-adjacent A ordinals 0 and 2.
  const op = deleteText(s, id(A, 2, 3), 0, 2);
  assert.deepEqual(op[5][1], [[[A, 1], 0, 1], [[A, 1], 2, 1]]);
  assert.equal(materializeText(applyTextOp(s, op)), '');
});

test('deleteText: deletes across concurrent inserts', () => {
  const s = stateFrom([
    ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'abc']],
    ['workbench.text', 1, [B, 1], 2, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'x']],
  ]);
  // RGA DFS emits an anchor before its children: root -> a -> x -> b -> c.
  assert.equal(materializeText(s), 'axbc');
  // delete 'ax' (offsets 0-2)
  const op = deleteText(s, id(A, 2, 3), 0, 2);
  assert.equal(op[5][0], 'delete');
  const applied = applyTextOp(s, op);
  assert.equal(materializeText(applied), 'bc');
});

test('deleteText: empty range throws', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'abc']]]);
  assert.throws(() => deleteText(s, id(A, 2, 2), 1, 1), /non-empty/);
});

test('deleteText: counter must be one past actor frontier', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'abc']]]);
  assert.throws(() => deleteText(s, id(A, 1, 2), 0, 1), /one past/);
});

test('deleteText: produces canonical operation', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'abc']]]);
  const op = deleteText(s, id(A, 2, 2), 0, 2);
  assert.doesNotThrow(() => canonicalTextOp(op));
});

test('deleteText: deleting an anchor preserves visible descendants', () => {
  const s = stateFrom([
    ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'a']],
    ['workbench.text', 1, [B, 1], 2, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'x']],
    ['workbench.text', 1, [C, 1], 3, [[A, 1], [B, 1]], ['insert', ['element', [[B, 1], 0]], 'y']],
  ]);
  // RGA DFS: root -> a -> x -> y. visible: 'axy'
  assert.equal(materializeText(s), 'axy');
  // delete 'a' (offset 0-1) — deletes A:1:0 element
  const op = deleteText(s, id(A, 2, 4), 0, 1);
  const applied = applyTextOp(s, op);
  // Only 'a' is deleted; 'x' and 'y' remain as children of tombstoned a
  assert.equal(materializeText(applied), 'xy');
});

test('deleteText: emoji range respects scalar boundaries', () => {
  const s = stateFrom([['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'a😀b']]]);
  const op = deleteText(s, id(A, 2, 2), 1, 3);
  // This deletes the emoji only
  assert.deepEqual(op[5][1], [[[A, 1], 1, 1]]);
  const applied = applyTextOp(s, op);
  assert.equal(materializeText(applied), 'ab');
});

// --- Integration ---

test('round-trip: insert then delete produces matching text', () => {
  let s = createTextState();
  s = applyTextOp(s, insertText(s, id(A, 1, 1), 0, 'hello world'));
  assert.equal(materializeText(s), 'hello world');
  s = applyTextOp(s, deleteText(s, id(A, 2, 2), 5, 11));
  assert.equal(materializeText(s), 'hello');
});

test('round-trip: multiple actors concurrent insert', () => {
  let s = createTextState();
  s = applyTextOp(s, insertText(s, id(A, 1, 1), 0, 'ab'));
  s = applyTextOp(s, insertText(s, id(B, 1, 2), 0, 'x'));
  // Both inserts anchor at root, so the later Lamport insert precedes A's run.
  assert.equal(materializeText(s), 'xab');
  s = applyTextOp(s, insertText(s, id(A, 2, 3), 2, 'y'));
  assert.equal(materializeText(s), 'xayb');
});

test('round-trip: delete from concurrent actor includes deps', () => {
  let s = createTextState();
  s = applyTextOp(s, insertText(s, id(A, 1, 1), 0, 'abc'));
  s = applyTextOp(s, insertText(s, id(B, 1, 2), 1, 'x'));
  // visible: 'axbc'
  assert.equal(materializeText(s), 'axbc');
  // B deletes 'xb' (offsets 1-3)
  s = applyTextOp(s, deleteText(s, id(B, 2, 3), 1, 3));
  assert.equal(materializeText(s), 'ac');
});
