// T1 owns the stable annotated-text operation grammar. T2 owns reduction.

const ACTOR = /^[0-9a-f]{32}$/;
const SAFE_POSITIVE = (value         )          => Number.isSafeInteger(value) && (value          ) > 0;
const HIGH_SURROGATE = /^[\uD800-\uDBFF]$/;
const LOW_SURROGATE = /^[\uDC00-\uDFFF]$/;














































function fail(message        )        {
  throw new Error(`invalid annotated-text value: ${message}`);
}

function assertClosedArray(value         , length        , name        ) {
  if (!Array.isArray(value) || value.length !== length) fail(`${name} must be an array of length ${length}`);
  for (const key of Object.keys(value)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) fail(`${name} has an extra property`);
  }
}

function assertActor(actor         ) {
  if (typeof actor !== 'string' || !ACTOR.test(actor)) fail('actor must be 32 lowercase hexadecimal characters');
}

export function assertWellFormedText(text        )         {
  if (typeof text !== 'string') fail('text must be a string');
  for (let index = 0; index < text.length; index += 1) {
    const unit = text[index];
    if (HIGH_SURROGATE.test(unit)) {
      if (index + 1 === text.length || !LOW_SURROGATE.test(text[index + 1])) fail('text contains an unpaired high surrogate');
      index += 1;
    } else if (LOW_SURROGATE.test(unit)) {
      fail('text contains an unpaired low surrogate');
    }
  }
  return text;
}

export function scalarCount(text        )         {
  assertWellFormedText(text);
  return [...text].length;
}

export function assertUtf16Offset(text        , offset        )         {
  // Text well-formedness is validated once at import/operation boundaries
  // (assertWellFormedText in assertTextOp/assertCheckpoint). Re-scanning the
  // whole text here made bulk offset resolution O(offsets × text) — the hot
  // path for source-range seeding. Only the offset
  // itself is validated per call.
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) fail('offset is outside text bounds');
  if (offset > 0 && offset < text.length && HIGH_SURROGATE.test(text[offset - 1]) && LOW_SURROGATE.test(text[offset])) {
    fail('offset splits a surrogate pair');
  }
  return offset;
}

export function assertUtf16Range(text        , start        , end        )                   {
  assertUtf16Offset(text, start);
  assertUtf16Offset(text, end);
  if (start > end) fail('range is reversed');
  return [start, end];
}

export function assertOpId(value         )       {
  assertClosedArray(value, 2, 'operation ID');
  const [actor, counter] = value        ;
  assertActor(actor);
  if (!SAFE_POSITIVE(counter)) fail('operation counter must be a positive safe integer');
  return Object.freeze([actor, counter]);
}

export function compareOpId(left      , right      )         {
  assertOpId(left);
  assertOpId(right);
  return compareOpIdValidated(left, right);
}

/**
 * Compare two operation IDs that were already validated at their trust boundary
 * (admission / checkpoint). Used by hot full-document traversal sorts so they
 * do not re-run assertOpId -> assertClosedArray + assertActor regex for every
 * comparison, which is the dominant per-keystroke cost in large transcripts.
 */
export function compareOpIdValidated(left      , right      )         {
  const [leftActor, leftCounter] = left;
  const [rightActor, rightCounter] = right;
  return leftActor === rightActor ? leftCounter - rightCounter : leftActor < rightActor ? -1 : 1;
}

export function assertFrontier(value         )           {
  if (!Array.isArray(value)) fail('frontier must be an array');
  for (const key of Object.keys(value)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) fail('frontier has an extra property');
  }
  let previousActor                = null;
  for (const entry of value) {
    const [actor, counter] = assertOpId(entry);
    if (previousActor !== null && previousActor >= actor) fail('frontier actors must be sorted and unique');
    previousActor = actor;
    if (counter < 1) fail('frontier counters cannot be zero');
  }
  return Object.freeze(value.map((entry) => Object.freeze([...entry]                   )))            ;
}

export function frontierCounter(frontier          , actor        )         {
  assertFrontier(frontier);
  assertActor(actor);
  return frontierCounterValidated(frontier, actor);
}

/** Read a frontier after its shape and actor ids have already been checked. */
function frontierCounterValidated(frontier          , actor        )         {
  return frontier.find(([candidate]) => candidate === actor)?.[1] ?? 0;
}

export function frontierDominates(left          , right          )          {
  assertFrontier(left);
  assertFrontier(right);
  return frontierDominatesValidated(left, right);
}

/** Like frontierDominates, for frontiers already validated at their boundary. */
export function frontierDominatesValidated(left          , right          )          {
  // Index the left frontier once per call: dominance is then O(|left| + |right|)
  // instead of a linear find per basis entry. Anchored endpoint projection runs
  // this once per endpoint against the live family frontier (twice for
  // equality), so the scan-per-entry shape was a dominant cost in the
  // 2026-09-14 Studio highlight profile (scope#3039). A single-entry basis is
  // just one scan, so it skips the index allocation (root-anchor walks call
  // this per element with a one-entry right side).
  if (right.length === 0) return true;
  if (right.length === 1) {
    const [actor, counter] = right[0];
    return frontierCounterValidated(left, actor) >= counter;
  }
  const counters = new Map                ();
  for (const [actor, counter] of left) {
    // First-wins, matching the retired `find` scan exactly: duplicates cannot
    // occur on a validated frontier, but the result stays identical if one does.
    if (!counters.has(actor)) counters.set(actor, counter);
  }
  for (const [actor, counter] of right) {
    if ((counters.get(actor) ?? 0) < counter) return false;
  }
  return true;
}

export function assertAnchor(value         )         {
  if (!Array.isArray(value)) fail('anchor must be an array');
  if (value.length === 1 && value[0] === 'root') {
    assertClosedArray(value, 1, 'root anchor');
    return Object.freeze(['root']);
  }
  if (value.length !== 2 || value[0] !== 'element' || !Array.isArray(value[1]) || value[1].length !== 2) {
    fail('anchor must be root or an element identity');
  }
  assertClosedArray(value, 2, 'anchor');
  assertClosedArray(value[1], 2, 'element identity');
  const [op, ordinal] = value[1];
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) fail('element ordinal must be a non-negative safe integer');
  // The operation grammar cannot know the referenced run length. T2 admission
  // verifies this names an observed scalar, never the run-end gap.
  return Object.freeze(['element', Object.freeze([assertOpId(op), ordinal]                           )]);
}

function assertDeleteSpans(value         , deps          )                        {
  if (!Array.isArray(value) || value.length === 0) fail('delete spans must be a non-empty array');
  let previous                                   = null;
  return Object.freeze(value.map((span) => {
    assertClosedArray(span, 3, 'delete span');
    const [op, first, count] = span;
    const canonicalOp = assertOpId(op);
    if (frontierCounterValidated(deps, canonicalOp[0]) < canonicalOp[1]) fail('delete target was not observed');
    if (!Number.isSafeInteger(first) || first < 0 || !SAFE_POSITIVE(count)) fail('delete span bounds are invalid');
    if (previous !== null) {
      const compare = compareOpId(previous.op, canonicalOp);
      if (compare > 0 || (compare === 0 && previous.end >= first)) fail('delete spans must be sorted, disjoint, and minimally merged');
    }
    previous = { op: canonicalOp, end: first + count - 1 };
    return Object.freeze([canonicalOp, first, count])              ;
  }));
}

export function compareInsertOrder(left        , right        )         {
  const [, , leftOp, leftLamport] = assertTextOp(left);
  const [, , rightOp, rightLamport] = assertTextOp(right);
  if (leftLamport !== rightLamport) return rightLamport - leftLamport;
  return -compareOpId(leftOp, rightOp);
}

export function assertTextOp(value         )         {
  if (!Array.isArray(value) || value.length !== 6 || value[0] !== 'workbench.text' || value[1] !== 1) {
    fail('operation must use the workbench.text v1 array grammar');
  }
  assertClosedArray(value, 6, 'operation');
  const op = assertOpId(value[2]);
  const lamport = value[3];
  if (!SAFE_POSITIVE(lamport)) fail('Lamport clock must be a positive safe integer');
  const deps = assertFrontier(value[4]);
  if (frontierCounterValidated(deps, op[0]) !== op[1] - 1) fail('operation dependencies must include the previous local counter');
  const body = value[5];
  if (!Array.isArray(body) || body.length < 2) fail('operation body is invalid');
  let canonicalBody            ;
  if (body[0] === 'insert' && body.length === 3) {
    assertClosedArray(body, 3, 'insert body');
    const anchor = assertAnchor(body[1]);
    if (anchor[0] === 'element' && frontierCounterValidated(deps, anchor[1][0][0]) < anchor[1][0][1]) {
      fail('insert anchor was not observed');
    }
    const text = assertWellFormedText(body[2]);
    if (text.length === 0) fail('insert text cannot be empty');
    canonicalBody = Object.freeze(['insert', anchor, text]);
  } else if (body[0] === 'delete' && body.length === 2) {
    assertClosedArray(body, 2, 'delete body');
    canonicalBody = Object.freeze(['delete', assertDeleteSpans(body[1], deps)]);
  } else {
    fail('operation body must be an insert or delete');
  }
  return Object.freeze(['workbench.text', 1, op, lamport, deps, canonicalBody]);
}

// assertTextOp closes every nested array and validates every leaf as a string
// or safe integer, so structural identity with the canonical form implies
// identical JSON. An inherited toJSON hook is the one way an equal structure
// could still serialize differently, so the exact string comparison is kept
// for that adversarial case (and re-derives the same failure for genuine
// structural differences). This removes the two per-apply full-op
// JSON.stringify passes from the keystroke hot path.
function assertCanonicalForm(value         , canonical        ) {
  if (!sameArrayTree(value, canonical) || treeHasToJSONHook(value)) {
    if (JSON.stringify(value) !== JSON.stringify(canonical)) fail('operation is not in canonical form');
  }
}

function sameArrayTree(left         , right         )          {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!sameArrayTree(left[index], right[index])) return false;
  }
  return true;
}

function treeHasToJSONHook(value         )          {
  if (!Array.isArray(value)) return false;
  if (typeof (value                        ).toJSON === 'function') return true;
  return value.some((child) => treeHasToJSONHook(child));
}

export function canonicalTextOp(value         )         {
  const canonical = assertTextOp(value);
  assertCanonicalForm(value, canonical);
  return canonical;
}

/** Canonicalize an operation and produce its integrity digest in one pass. */
function canonicalTextOpDigest(value         )                                 {
  const op = assertTextOp(value);
  assertCanonicalForm(value, op);
  return { op, digest: JSON.stringify(op) };
}

export function assertStructuralPoint(value         )                  {
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== 'point') fail('structural point is invalid');
  assertClosedArray(value, 3, 'structural point');
  const anchor = assertAnchor(value[1]);
  if (value[2] !== 'left' && value[2] !== 'right') fail('structural point affinity is invalid');
  return Object.freeze(['point', anchor, value[2]]);
}

const ROOT_ID = 'root';
const DEFAULT_MAX_PENDING = 1_000;

function opKey(op               )         {
  return `${op[0]}:${op[1]}`;
}

function elementKey(op      , ordinal        )         {
  return `${opKey(op)}:${ordinal}`;
}

function anchorKey(anchor        )         {
  return anchor[0] === 'root' ? ROOT_ID : elementKey(anchor[1][0], anchor[1][1]);
}

function canonicalFrontier(frontier          )         {
  return frontier.map(([actor, counter])       => [actor, counter]);
}

function makeState({ maxPending = DEFAULT_MAX_PENDING }                   = {})            {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new TypeError('maxPending must be a positive safe integer');
  return {
    version: 1,
    frontier: [],
    elements: {},
    operations: {},
    pending: {},
    maxPending,
    rebootstrapRequired: false,
  };
}

/**
 * Create a deeply-immutable element so states can SHARE element objects without
 * aliasing: delete ops replace rather than mutate a shared element, and the
 * derived caches can rely on nested state never changing. Freezing the nested
 * `op`/`deletedBy` arrays is what makes shallow registry sharing sound.
 */
function frozenElement(op      , ordinal        , scalar        , parent        , lamport        , deletedBy                   )              {
  return Object.freeze({
    op: Object.freeze([...op]                   ),
    ordinal,
    scalar,
    parent,
    lamport,
    deletedBy: Object.freeze([...deletedBy])            ,
  });
}

function cloneState(state           )            {
  // Shallow-copy the registries and SHARE their (now immutable) element/entry
  // values. The prior deep copy allocated a fresh element (with fresh op +
  // deletedBy arrays) per document element on every apply — O(document) per key.
  // Sharing immutable values keeps apply O(registry keys) instead of O(elements
  // × fields), while copy-on-write preserves prior states.
  return {
    version: 1,
    frontier: [...state.frontier],
    elements: cloneRegistry(state.elements),
    operations: cloneRegistry(state.operations),
    pending: cloneRegistry(state.pending),
    maxPending: state.maxPending,
    rebootstrapRequired: state.rebootstrapRequired,
  };
}

// The element registry holds one computed string key per document scalar, so
// the per-apply copy is the dominant apply cost on large documents. Adding
// thousands of computed keys to a fast-mode object pays a hidden-class
// transition per key; a normalized (dictionary-mode) target hash-inserts
// without transitioning and clones roughly twice as fast. Dictionary-mode
// objects keep insertion order for string keys, so iteration is unchanged,
// and reads pay only a small constant lookup.
function cloneRegistry                                           (registry                   )                    {
  const clone                    = {};
  const normalizable = clone                           ;
  normalizable.__normalized__ = 1;
  delete normalizable.__normalized__;
  for (const key in registry) clone[key] = registry[key];
  return clone;
}

function assertState(state           )            {
  if (!state || state.version !== 1 || !Array.isArray(state.frontier) || !state.elements || !state.operations || !state.pending) {
    throw new TypeError('invalid annotated-text reducer state');
  }
  assertFrontier(state.frontier);
  return state;
}

export function createTextState(options                   )            {
  return Object.freeze(makeState(options));
}

function stateFrontierCounter(state           , actor        )         {
  return state.frontier.find(([candidate]) => candidate === actor)?.[1] ?? 0;
}

function operationReady(state           , op        )          {
  // Both frontiers are validated at their boundaries (applyTextOp's assertState
  // and canonicalTextOp); the validating frontierDominates wrapper re-ran the
  // full regex walk per readiness check on the hot apply path.
  if (!frontierDominatesValidated(state.frontier, op[4])) return false;
  const body = op[5];
  if (body[0] === 'insert') return body[1][0] === 'root' || Object.hasOwn(state.elements, anchorKey(body[1]));
  return body[1].every(([target, first, count]) => {
    for (let ordinal = first; ordinal < first + count; ordinal += 1) {
      if (!Object.hasOwn(state.elements, elementKey(target, ordinal))) return false;
    }
    return true;
  });
}

function advanceFrontier(state           , op        ) {
  const [actor, counter] = op[2];
  const frontier = state.frontier.filter(([candidate]) => candidate !== actor);
  frontier.push([actor, counter]);
  frontier.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  state.frontier = frontier;
}

function applyReadyOperation(state           , op        , digest        ) {
  const body = op[5];
  if (body[0] === 'insert') {
    const parent = anchorKey(body[1]);
    let previous = parent;
    let ordinal = 0;
    for (const scalar of body[2]) {
      const key = elementKey(op[2], ordinal);
      state.elements[key] = frozenElement(op[2], ordinal, scalar, previous, op[3], []);
      previous = key;
      ordinal += 1;
    }
  } else {
    const deleteTag = opKey(op[2]);
    for (const [target, first, count] of body[1]) {
      for (let ordinal = first; ordinal < first + count; ordinal += 1) {
        const key = elementKey(target, ordinal);
        const element = state.elements[key];
        // Copy-on-write: never push into a SHARED (immutable) deletedBy array.
        // Read the draft's current element so stacked deletes accumulate.
        if (!element.deletedBy.includes(deleteTag)) {
          state.elements[key] = frozenElement(element.op, element.ordinal, element.scalar, element.parent, element.lamport, [...element.deletedBy, deleteTag]);
        }
      }
    }
  }
  state.operations[opKey(op[2])] = Object.freeze({ digest, op });
  advanceFrontier(state, op);
}

function drainPending(state           ) {
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const key of Object.keys(state.pending).sort()) {
      const entry = state.pending[key];
      if (!operationReady(state, entry.op)) continue;
      delete state.pending[key];
      applyReadyOperation(state, entry.op, entry.digest);
      progressed = true;
    }
  }
}

function assertCheckpoint(value         )            {
  const raw = value                       ;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => !['version', 'frontier', 'elements', 'operations', 'pending', 'maxPending', 'rebootstrapRequired'].includes(key))) {
    throw new TypeError('invalid annotated-text checkpoint');
  }
  const state = makeState({ maxPending: raw.maxPending });
  state.frontier = assertFrontier(raw.frontier).map((entry) => [...entry]);
  state.rebootstrapRequired = raw.rebootstrapRequired === true;
  for (const [key, element] of Object.entries((raw.elements ?? {})                       )) {
    if (!element || typeof element.scalar !== 'string' || scalarCount(element.scalar) !== 1 || typeof element.parent !== 'string' || !Array.isArray(element.op) || !Number.isSafeInteger(element.ordinal) || element.ordinal < 0 || !SAFE_POSITIVE(element.lamport) || !Array.isArray(element.deletedBy)) throw new TypeError('invalid annotated-text checkpoint element');
    if (key !== elementKey(element.op, element.ordinal)) throw new TypeError('invalid annotated-text checkpoint element identity');
    state.elements[key] = frozenElement(assertOpId(element.op), element.ordinal, element.scalar, element.parent, element.lamport, [...element.deletedBy].sort());
  }
  for (const registryName of ['operations', 'pending']         ) {
    for (const [key, entry] of Object.entries((raw[registryName] ?? {})                       )) {
      const { op, digest } = canonicalTextOpDigest(entry?.op);
      if (key !== opKey(op[2]) || entry.digest !== digest) throw new TypeError('invalid annotated-text checkpoint operation registry');
      state[registryName][key] = Object.freeze({ digest, op });
    }
  }
  return state;
}

function sameOpId(left      , right      )          {
  return left[0] === right[0] && left[1] === right[1];
}

function sameTextOp(left        , right        )          {
  return left[0] === right[0] && left[1] === right[1]
    && sameOpId(left[2], right[2]) && left[3] === right[3]
    && left[4].length === right[4].length && left[4].every((dep, index) => sameOpId(dep, right[4][index]))
    && left[5][0] === right[5][0] && JSON.stringify(left[5]) === JSON.stringify(right[5]);
}

/**
 * Structural equality of two canonical v1 checkpoints. `textCheckpoint` output
 * is deterministic (sorted keys, sorted tombstone tags), so this accepts and
 * rejects exactly the pairs the previous JSON.stringify comparison did, without
 * materializing two full-document JSON strings per restore.
 */
function sameCheckpointState(left           , right           )          {
  if (left.maxPending !== right.maxPending || left.rebootstrapRequired !== right.rebootstrapRequired) return false;
  if (left.frontier.length !== right.frontier.length) return false;
  for (let index = 0; index < left.frontier.length; index += 1) {
    if (!sameOpId(left.frontier[index], right.frontier[index])) return false;
  }
  const leftElementKeys = Object.keys(left.elements);
  if (leftElementKeys.length !== Object.keys(right.elements).length) return false;
  for (const key of leftElementKeys) {
    const a = left.elements[key];
    const b = right.elements[key];
    if (!b || a.ordinal !== b.ordinal || a.scalar !== b.scalar || a.parent !== b.parent
      || a.lamport !== b.lamport || !sameOpId(a.op, b.op)
      || a.deletedBy.length !== b.deletedBy.length
      || a.deletedBy.some((tag, tagIndex) => tag !== b.deletedBy[tagIndex])) return false;
  }
  for (const registryName of ['operations', 'pending']         ) {
    const a = left[registryName];
    const b = right[registryName];
    if (Object.keys(a).length !== Object.keys(b).length) return false;
    for (const [key, entry] of Object.entries(a)) {
      const other = b[key];
      if (!other || entry.digest !== other.digest || !sameTextOp(entry.op, other.op)) return false;
    }
  }
  return true;
}

export function restoreTextCheckpoint(checkpoint         )            {
  const compact = checkpoint                                         ;
  if (compact?.version === 2) return restoreCompactTextCheckpoint(compact);
  const supplied = assertCheckpoint(checkpoint);
  const applied = Object.values(supplied.operations);
  const pending = Object.values(supplied.pending);
  const appliedIds = new Set(applied.map(({ op }) => opKey(op[2])));
  if (pending.some(({ op }) => appliedIds.has(opKey(op[2])))) {
    throw new TypeError('annotated-text checkpoint duplicates an operation across registries');
  }

  // Reducer effects are derived from the canonical operation registry. Never
  // admit independently supplied topology, tombstones, or frontier state.
  // Replay on ONE mutable state using the entries assertCheckpoint already
  // canonicalized (same trust pattern as restoreCompactTextCheckpoint). Going
  // through applyTextOp re-cloned the whole element registry per operation —
  // O(operations × elements) — and re-canonicalized validated ops. The
  // behind-frontier and pending-cap rules below replicate applyTextOp exactly.
  const restored = makeState({ maxPending: supplied.maxPending });
  const remaining = [...applied];
  while (remaining.length > 0) {
    const nextIndex = remaining.findIndex(({ op }) => operationReady(restored, op));
    if (nextIndex === -1) {
      throw new TypeError('annotated-text checkpoint applied operations are not causally reducible');
    }
    const [{ op, digest }] = remaining.splice(nextIndex, 1);
    if (stateFrontierCounter(restored, op[2][0]) >= op[2][1]) {
      throw new Error('annotated-text operation ID is behind the applied frontier');
    }
    applyReadyOperation(restored, op, digest);
  }
  for (const { op, digest } of pending.sort((left, right) => compareOpId(left.op[2], right.op[2]))) {
    if (operationReady(restored, op)) {
      throw new TypeError('annotated-text checkpoint contains a ready pending operation');
    }
    if (stateFrontierCounter(restored, op[2][0]) >= op[2][1]) {
      throw new Error('annotated-text operation ID is behind the applied frontier');
    }
    if (Object.keys(restored.pending).length >= restored.maxPending) {
      restored.rebootstrapRequired = true;
    } else {
      restored.pending[opKey(op[2])] = { digest, op };
    }
  }
  // The operation that exceeded the live pending cap is intentionally not
  // retained. Its terminal outcome is nevertheless durable checkpoint state.
  if (supplied.rebootstrapRequired) restored.rebootstrapRequired = true;
  // `supplied` is already normalized by assertCheckpoint (canonical frontier,
  // sorted tombstone tags, key-checked elements); only the replayed side needs
  // canonicalization. Same acceptance as the previous double-JSON comparison.
  if (!sameCheckpointState(supplied, textCheckpoint(restored))) {
    throw new TypeError('annotated-text checkpoint does not match its operation registry');
  }
  return Object.freeze(restored);
}

function restoreCompactTextCheckpoint(raw                                )            {
  const keys = Object.keys(raw).sort();
  const expectedKeys = ['frontier', 'maxPending', 'operations', 'pending', 'rebootstrapRequired', 'version'];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || !Number.isSafeInteger(raw.maxPending) || (raw.maxPending          ) < 1
    || typeof raw.rebootstrapRequired !== 'boolean'
    || !raw.operations || typeof raw.operations !== 'object' || Array.isArray(raw.operations)
    || !raw.pending || typeof raw.pending !== 'object' || Array.isArray(raw.pending)) {
    throw new TypeError('invalid compact annotated-text checkpoint');
  }
  const expectedFrontier = assertFrontier(raw.frontier);
  const readRegistry = (registry                                   ) => Object.entries(registry).map(([key, entry]) => {
    const { op, digest } = canonicalTextOpDigest(entry?.op);
    if (key !== opKey(op[2]) || entry?.digest !== digest) throw new TypeError('invalid compact annotated-text checkpoint operation registry');
    return { op, digest };
  });
  const applied = readRegistry(raw.operations                                     );
  const pending = readRegistry(raw.pending                                     );
  const appliedIds = new Set(applied.map(({ op }) => opKey(op[2])));
  if (pending.some(({ op }) => appliedIds.has(opKey(op[2])))) {
    throw new TypeError('compact annotated-text checkpoint duplicates an operation across registries');
  }
  const restored = makeState({ maxPending: raw.maxPending });
  const remaining = [...applied];
  while (remaining.length > 0) {
    const nextIndex = remaining.findIndex(({ op }) => operationReady(restored, op));
    if (nextIndex === -1) throw new TypeError('compact annotated-text checkpoint operations are not causally reducible');
    const [{ op, digest }] = remaining.splice(nextIndex, 1);
    applyReadyOperation(restored, op, digest);
  }
  for (const { op, digest } of pending.sort((left, right) => compareOpId(left.op[2], right.op[2]))) {
    if (operationReady(restored, op)) throw new TypeError('compact annotated-text checkpoint contains a ready pending operation');
    restored.pending[opKey(op[2])] = { digest, op };
  }
  if (raw.rebootstrapRequired) restored.rebootstrapRequired = true;
  if (JSON.stringify(restored.frontier) !== JSON.stringify(expectedFrontier)) {
    throw new TypeError('compact annotated-text checkpoint frontier does not match its operation registry');
  }
  return Object.freeze(restored);
}

export function textCheckpoint(state           )            {
  assertState(state);
  const sortedElements = Object.fromEntries(Object.entries(state.elements).sort(([left], [right]) => left.localeCompare(right)).map(([key, element]) => [key, {
    op: [...element.op]        , ordinal: element.ordinal, scalar: element.scalar, parent: element.parent,
    lamport: element.lamport, deletedBy: [...element.deletedBy].sort(),
  }]));
  const registry = (entries                                   ) => Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, { digest: entry.digest, op: entry.op }]));
  return Object.freeze({ version: 1, frontier: canonicalFrontier(state.frontier), elements: sortedElements, operations: registry(state.operations), pending: registry(state.pending), maxPending: state.maxPending, rebootstrapRequired: state.rebootstrapRequired });
}

/**
 * Durable checkpoint form. Element topology and tombstones are deterministic
 * reducer output, so persisting them beside the operation registry duplicates
 * almost the entire document on every edit. Version 2 stores only the causal
 * operation registry plus its integrity frontier; restore derives the exact
 * same v1 in-memory state and continues accepting historical v1 checkpoints.
 */
export function compactTextCheckpoint(state           )                        {
  assertState(state);
  const registry = (entries                                   ) => Object.fromEntries(
    Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, { digest: entry.digest, op: entry.op }]),
  );
  return Object.freeze({
    version: 2,
    frontier: canonicalFrontier(state.frontier),
    operations: registry(state.operations),
    pending: registry(state.pending),
    maxPending: state.maxPending,
    rebootstrapRequired: state.rebootstrapRequired,
  });
}

export function materializeText(state           )         {
  assertState(state);
  const children = new Map                                      ([[ROOT_ID, []]]);
  for (const [key, element] of Object.entries(state.elements)) {
    const list = children.get(element.parent) ?? [];
    list.push([key, element]);
    children.set(element.parent, list);
  }
  for (const list of children.values()) {
    list.sort(([, left], [, right]) => right.lamport - left.lamport || -compareOpIdValidated(left.op, right.op));
  }
  let text = '';
  const stack                               = [...(children.get(ROOT_ID) ?? [])].reverse();
  while (stack.length > 0) {
    const [key, element] = stack.pop() ;
    if (element.deletedBy.length === 0) text += element.scalar;
    const descendants = children.get(key);
    if (descendants) stack.push(...descendants.slice().reverse());
  }
  return text;
}

// Applies one immutable operation. It is deliberately atomic: an operation is
// either fully reduced, retained intact in the bounded pending registry, or the
// replica fails closed and must rebootstrap from a checkpoint.
export function applyTextOp(current           , value         )            {
  const validated = assertState(current);
  // A failed-closed replica freezes in place; cloning the registries before the
  // early return spent the full per-apply copy for an unchanged result.
  if (validated.rebootstrapRequired) return Object.freeze(validated);
  const state = cloneState(validated);
  const { op, digest } = canonicalTextOpDigest(value);
  const key = opKey(op[2]);
  const known = state.operations[key] ?? state.pending[key];
  if (known) {
    if (known.digest !== digest) throw new Error('annotated-text operation ID was reused with different content');
    return Object.freeze(state);
  }
  // A contiguous frontier also makes a counter at or behind it equivocal even
  // if a damaged checkpoint omitted its operation registry entry.
  if (stateFrontierCounter(state, op[2][0]) >= op[2][1]) throw new Error('annotated-text operation ID is behind the applied frontier');
  if (operationReady(state, op)) {
    applyReadyOperation(state, op, digest);
    drainPending(state);
  } else if (Object.keys(state.pending).length >= state.maxPending) {
    state.rebootstrapRequired = true;
  } else {
    state.pending[key] = { digest, op };
  }
  return Object.freeze(state);
}
