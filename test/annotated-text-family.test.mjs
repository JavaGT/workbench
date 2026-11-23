import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyTextOp, createTextState, textCheckpoint,
} from '../build/annotated-text.mjs';
import {
  rgaTraversal, assertStructuralEndpoint,
} from '../build/annotated-text-family.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccccccccc';
const ROOT = ['root'];

function applyAll(state, ops) {
  return ops.reduce(applyTextOp, state);
}

function makeCheckpoint(ops) {
  const state = applyAll(createTextState(), ops);
  return textCheckpoint(state);
}

test('rgaTraversal returns document order for a linear RGA without consuming the call stack', () => {
  const text = 'x'.repeat(20_000);
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, text]]]);
  const order = rgaTraversal(cp);
  assert.equal(order.length, text.length);
  assert.equal(order.map(([, element]) => element.scalar).join(''), text);
});

test('rgaTraversal orders concurrent siblings by Lamport then op ID', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']];
  const left = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'x']];
  const right = ['workbench.text', 1, [B, 1], 2, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'y']];
  const later = ['workbench.text', 1, [C, 1], 3, [[A, 2], [B, 1]], ['insert', ['element', [[A, 1], 0]], 'z']];
  const cp = makeCheckpoint([first, left, right, later]);
  assert.equal(rgaTraversal(cp).map(([, element]) => element.scalar).join(''), 'azyx');
});

test('rgaTraversal includes tombstoned elements in traversal order', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']];
  const del = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 1, 1]]]];
  const cp = makeCheckpoint([first, del]);
  const order = rgaTraversal(cp);
  assert.equal(order.length, 3);
  const bElement = order.find(([, element]) => element.scalar === 'b');
  assert.ok(bElement, 'tombstoned b must still appear in traversal');
  assert.ok(bElement[1].deletedBy.length > 0);
});

test('assertStructuralEndpoint accepts and freezes a valid endpoint', () => {
  const frontier = [[A, 1]];
  const ep = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier });
  assert.deepEqual(ep, { point: ['point', ['root'], 'left'], basisFrontier: frontier });
  assert.ok(Object.isFrozen(ep));
  assert.ok(Object.isFrozen(ep.point));
  assert.ok(Object.isFrozen(ep.basisFrontier));
  assert.throws(() => { ep.point = null; }, TypeError);
});

test('assertStructuralEndpoint rejects unknown keys', () => {
  const frontier = [[A, 1]];
  assert.throws(() => assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier, extra: true }), /unknown endpoint key/);
});

test('assertStructuralEndpoint rejects invalid point', () => {
  const frontier = [[A, 1]];
  assert.throws(() => assertStructuralEndpoint({ point: ['point', ['root'], 'middle'], basisFrontier: frontier }), /affinity/);
  assert.throws(() => assertStructuralEndpoint({ point: null, basisFrontier: frontier }), /point/);
});

test('assertStructuralEndpoint rejects invalid basisFrontier', () => {
  assert.throws(() => assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: null }), /frontier/);
  assert.throws(() => assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: 'not-a-frontier' }), /frontier/);
});
