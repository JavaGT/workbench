// Pure generation helpers for workbench.text v1 insert/delete ops from UTF-16 coords.
// Depends on: workbench-annotated-text.mjs (same directory)
import {
  assertUtf16Offset, assertUtf16Range, assertWellFormedText,
  assertFrontier, assertTextOp as _assertTextOp, canonicalTextOp,
  compareOpId, compareOpIdValidated, frontierCounter, materializeText,
} from './workbench-annotated-text.mjs';

const ACTOR_RE = /^[0-9a-f]{32}$/;
const SAFE_POSITIVE = (v) => Number.isSafeInteger(v) && v > 0;

function assertActor(v) {
  if (typeof v !== 'string' || !ACTOR_RE.test(v)) throw new Error('actor must be 32 lowercase hex characters');
}

function assertState(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.frontier) || !state.elements || !state.operations || !state.pending) {
    throw new TypeError('invalid annotated-text reducer state');
  }
  assertFrontier(state.frontier);
}

function opKey(op) {
  return `${op[0]}:${op[1]}`;
}

function* visibleElements(state) {
  const children = new Map();
  children.set('root', []);
  for (const [key, element] of Object.entries(state.elements)) {
    const list = children.get(element.parent);
    if (list) list.push([key, element]);
    else children.set(element.parent, [[key, element]]);
  }
  for (const list of children.values()) {
    list.sort(([, a], [, b]) => b.lamport - a.lamport || -compareOpIdValidated(a.op, b.op));
  }
  function* visit(parent) {
    for (const [key, element] of children.get(parent) ?? []) {
      if (element.deletedBy.length === 0) yield [key, element];
      yield* visit(key);
    }
  }
  yield* visit('root');
}

// Resolve a visible UTF-16 code-unit offset to a structural point anchor.
// offset 0 returns ['point', ['root'], 'left'].
// offset > 0 returns ['point', ['element', [op, ordinal]], 'right'] for the
// visible scalar at or immediately before the boundary.
// offset === text.length returns the last visible scalar or root-right for
// an empty document.
export function resolveUtf16ToAnchor(state, offset) {
  assertState(state);
  const text = materializeText(state);
  assertUtf16Offset(text, offset);
  if (offset === 0) return Object.freeze(['point', Object.freeze(['root']), 'left']);
  let accumulated = 0;
  for (const [, element] of visibleElements(state)) {
    accumulated += element.scalar.length;
    if (accumulated >= offset) {
      return Object.freeze(['point', Object.freeze(['element', Object.freeze([Object.freeze([...element.op]), element.ordinal])]), 'right']);
    }
  }
  return Object.freeze(['point', Object.freeze(['root']), 'right']);
}

// Collect the visible scalar identities (op, ordinal) for the half-open
// UTF-16 code-unit range [start, end). Returns a frozen array of frozen
// [op, ordinal] tuples in document order.
export function collectVisibleScalarIds(state, start, end) {
  assertState(state);
  const text = materializeText(state);
  assertUtf16Range(text, start, end);
  const result = [];
  let accumulated = 0;
  for (const [, element] of visibleElements(state)) {
    const scalarLen = element.scalar.length;
    const nextAccumulated = accumulated + scalarLen;
    if (nextAccumulated > start && accumulated < end) {
      result.push(Object.freeze([Object.freeze([...element.op]), element.ordinal]));
    }
    accumulated = nextAccumulated;
    if (accumulated >= end) break;
  }
  return Object.freeze(result);
}

// Build a dependency frontier that includes the state frontier and ensures
// the actor's own counter-1 is present.
function buildDeps(state, actor, counter) {
  const deps = state.frontier.map(([a, c]) => [a, c]);
  const ownCounter = counter - 1;
  const existing = deps.find(([a]) => a === actor);
  if (existing) {
    if (existing[1] < ownCounter) existing[1] = ownCounter;
  } else if (ownCounter > 0) {
    deps.push([actor, ownCounter]);
  }
  deps.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return deps;
}

// Generate a canonical insert operation for newText at the given visible
// UTF-16 startOffset. identity must be {actor, counter, lamport} where
// counter and lamport are the next available values for this actor.
// Returns the canonical workbench.text v1 insert operation.
export function insertText(state, identity, startOffset, newText) {
  assertState(state);
  assertWellFormedText(newText);
  if (newText.length === 0) throw new Error('insert text cannot be empty');
  const { actor, counter, lamport } = identity;
  assertActor(actor);
  if (!SAFE_POSITIVE(counter)) throw new Error('counter must be a positive safe integer');
  if (!SAFE_POSITIVE(lamport)) throw new Error('lamport must be a positive safe integer');
  if (counter !== frontierCounter(state.frontier, actor) + 1) throw new Error('counter must be one past the actor frontier');
  const point = resolveUtf16ToAnchor(state, startOffset);
  const anchor = point[1];
  const deps = assertFrontier(buildDeps(state, actor, counter));
  return canonicalTextOp(['workbench.text', 1, [actor, counter], lamport, deps, ['insert', anchor, newText]]);
}

// Generate a canonical delete operation for the visible UTF-16 code-unit
// range [startOffset, endOffset). Spans are compacted per source operation
// and sorted by op ordinal. Returns the canonical workbench.text v1 delete
// operation.
export function deleteText(state, identity, startOffset, endOffset) {
  assertState(state);
  if (startOffset === endOffset) throw new Error('delete range must be non-empty');
  const ids = collectVisibleScalarIds(state, startOffset, endOffset);
  if (ids.length === 0) throw new Error('delete range contains no visible scalars');
  const { actor, counter, lamport } = identity;
  assertActor(actor);
  if (!SAFE_POSITIVE(counter)) throw new Error('counter must be a positive safe integer');
  if (!SAFE_POSITIVE(lamport)) throw new Error('lamport must be a positive safe integer');
  if (counter !== frontierCounter(state.frontier, actor) + 1) throw new Error('counter must be one past the actor frontier');

  const groups = new Map();
  for (const [op, ordinal] of ids) {
    const key = opKey(op);
    const list = groups.get(key);
    if (list) list.push(ordinal);
    else groups.set(key, [ordinal]);
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const [aActor, aCounterS] = a.split(':');
    const [bActor, bCounterS] = b.split(':');
    return compareOpId([aActor, Number(aCounterS)], [bActor, Number(bCounterS)]);
  });

  const spans = [];
  for (const key of sortedKeys) {
    const [spActor, spCounterS] = key.split(':');
    const spCounter = Number(spCounterS);
    const ordinals = groups.get(key).sort((a, b) => a - b);
    let spanStart = ordinals[0];
    let spanCount = 1;
    for (let i = 1; i < ordinals.length; i++) {
      if (ordinals[i] === ordinals[i - 1] + 1) {
        spanCount++;
      } else {
        spans.push([Object.freeze([spActor, spCounter]), spanStart, spanCount]);
        spanStart = ordinals[i];
        spanCount = 1;
      }
    }
    spans.push([Object.freeze([spActor, spCounter]), spanStart, spanCount]);
  }

  const deps = buildDeps(state, actor, counter);
  for (const [op] of spans) {
    const existing = deps.find(([a]) => a === op[0]);
    if (!existing || existing[1] < op[1]) {
      deps.push([...op]);
    }
  }
  deps.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

  return canonicalTextOp(['workbench.text', 1, [actor, counter], lamport, assertFrontier(deps), ['delete', Object.freeze(spans)]]);
}