// T1 owns the stable annotated-text operation grammar. T2 owns reduction.

const ACTOR = /^[0-9a-f]{32}$/;
const SAFE_POSITIVE = (value         )          => Number.isSafeInteger(value) && (value          ) > 0;
const HIGH_SURROGATE = /^[\uD800-\uDBFF]$/;
const LOW_SURROGATE = /^[\uDC00-\uDFFF]$/;
const EMPTY_DELETED_BY = Object.freeze([])                       ;



















































































const stateRunStore = new WeakMap                     ();
const statePiecesCache = new WeakMap                       ();

function fail(message        )        {
  throw new Error(`invalid annotated-text value: ${message}`);
}

const SMALL_INDEX_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'];

function assertClosedArray(value         , length        , name        ) {
  if (!Array.isArray(value) || value.length !== length) fail(`${name} must be an array of length ${length}`);
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (i < 16 && key === SMALL_INDEX_KEYS[i]) continue;
    if (key === String(i)) continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) fail(`${name} has an extra property`);
  }
}

function assertActor(actor         ) {
  if (typeof actor !== 'string' || actor.length !== 32) fail('actor must be 32 lowercase hexadecimal characters');
  for (let i = 0; i < 32; i += 1) {
    const c = actor.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) {
      if (!ACTOR.test(actor)) fail('actor must be 32 lowercase hexadecimal characters');
    }
  }
}

export function assertWellFormedText(text        )         {
  if (typeof text !== 'string') fail('text must be a string');
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      if (index + 1 === text.length) fail('text contains an unpaired high surrogate');
      const next = text.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) fail('text contains an unpaired high surrogate');
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      fail('text contains an unpaired low surrogate');
    }
  }
  return text;
}

function countWellFormedScalars(text        )         {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) index += 1;
    count += 1;
  }
  return count;
}

export function ensureRunUtf16Starts(run           )              {
  if (run.utf16Starts) return run.utf16Starts;
  const starts = new Uint32Array(run.scalarCount + 1);
  let ordinal = 0;
  for (let index = 0; index < run.text.length; index += 1) {
    starts[ordinal] = index;
    const code = run.text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) index += 1;
    ordinal += 1;
  }
  starts[ordinal] = run.text.length;
  run.utf16Starts = starts;
  return starts;
}

export function scalarCount(text        )         {
  assertWellFormedText(text);
  return countWellFormedScalars(text);
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

/** Read a validated (sorted, unique-actor) frontier via O(log n) binary search. */
function frontierCounterValidated(frontier          , actor        )         {
  let lo = 0;
  let hi = frontier.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = frontier[mid][0];
    if (candidate === actor) return frontier[mid][1];
    if (candidate < actor) lo = mid + 1;
    else hi = mid - 1;
  }
  return 0;
}

export function frontierDominates(left          , right          )          {
  assertFrontier(left);
  assertFrontier(right);
  return frontierDominatesValidated(left, right);
}

/** Like frontierDominates, for frontiers already validated at their boundary. */
export function frontierDominatesValidated(left          , right          )          {
  const rightLen = right.length;
  if (rightLen === 0) return true;
  const leftLen = left.length;
  if (leftLen < rightLen) return false;
  if (rightLen === 1) {
    const [actor, counter] = right[0];
    return frontierCounterValidated(left, actor) >= counter;
  }
  // Both frontiers are sorted by actor ascending with unique actors. When the
  // right side is much smaller than the left, binary search each right entry;
  // otherwise run a zero-allocation two-pointer merge scan.
  if (rightLen * 4 < leftLen) {
    for (let index = 0; index < rightLen; index += 1) {
      const [actor, counter] = right[index];
      if (frontierCounterValidated(left, actor) < counter) return false;
    }
    return true;
  }
  let leftIdx = 0;
  for (let rightIdx = 0; rightIdx < rightLen; rightIdx += 1) {
    const [rightActor, rightCounter] = right[rightIdx];
    while (leftIdx < leftLen && left[leftIdx][0] < rightActor) leftIdx += 1;
    if (leftIdx >= leftLen || left[leftIdx][0] !== rightActor || left[leftIdx][1] < rightCounter) {
      return false;
    }
    leftIdx += 1;
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
      const compare = compareOpIdValidated(previous.op, canonicalOp);
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

function parseElementKey(key        )                                            {
  const lastColon = key.lastIndexOf(':');
  if (lastColon <= 0 || lastColon === key.length - 1) return null;
  const ordinalStr = key.slice(lastColon + 1);
  const ordinal = Number(ordinalStr);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || String(ordinal) !== ordinalStr) return null;
  return { opKey: key.slice(0, lastColon), ordinal };
}

function canonicalFrontier(frontier          )         {
  return frontier.map(([actor, counter])       => [actor, counter]);
}

function makeNormalizedRegistry   ()                    {
  const registry                    = {};
  const normalizable = registry                           ;
  normalizable.__normalized__ = 1;
  delete normalizable.__normalized__;
  return registry;
}

function cloneRegistry                                           (registry                   )                    {
  const clone = makeNormalizedRegistry   ();
  for (const key in registry) clone[key] = registry[key];
  return clone;
}

function createEmptyRunState()           {
  return {
    inserts: new Map(),
    deletes: new Map(),
    maxLamport: 0,
    elementCount: 0,
  };
}

function cloneRunState(runs          )           {
  return {
    inserts: new Map(runs.inserts),
    deletes: new Map(runs.deletes),
    maxLamport: runs.maxLamport,
    elementCount: runs.elementCount,
  };
}

function materializeElementsFromRunState(runs          )                              {
  const elements = makeNormalizedRegistry             ();
  for (const run of runs.inserts.values()) {
    const delIntervals = runs.deletes.get(run.opKey);
    const starts = run.isBmp ? null : ensureRunUtf16Starts(run);
    let previous = run.parentKey;
    for (let ordinal = 0; ordinal < run.scalarCount; ordinal += 1) {
      const key = `${run.opKey}:${ordinal}`;
      const scalar = starts === null ? run.text[ordinal] : run.text.slice(starts[ordinal], starts[ordinal + 1]);
      let deletedBy           = EMPTY_DELETED_BY;
      if (delIntervals !== undefined) {
        let tags                  = null;
        for (let i = 0; i < delIntervals.length; i += 1) {
          const interval = delIntervals[i];
          if (interval.first <= ordinal && ordinal < interval.end) {
            if (tags === null) tags = [interval.deleteTag];
            else if (!tags.includes(interval.deleteTag)) tags.push(interval.deleteTag);
          }
        }
        if (tags !== null) deletedBy = Object.freeze(tags)                       ;
      }
      elements[key] = Object.freeze({
        op: run.op,
        ordinal,
        scalar,
        parent: previous,
        lamport: run.lamport,
        deletedBy,
      });
      previous = key;
    }
  }
  return elements;
}

/**
 * Attach the lazy `elements` projection to a RunState-backed TextState so hot
 * paths (applyTextOp, compact restore, maxLamport, run traversal) stay O(ops)
 * while any caller inspecting `state.elements` receives the exact deeply-frozen
 * per-scalar element map (memoized per immutable state instance).
 */
function makeRunBackedState(options                              , runs          )            {
  const maxPending = options?.maxPending ?? DEFAULT_MAX_PENDING;
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new TypeError('maxPending must be a positive safe integer');
  let materializedElements                                         ;
  // Preserve exact canonical property order:
  // version, frontier, elements, operations, pending, maxPending, rebootstrapRequired.
  const state = {
    version: 1         ,
    frontier: []            ,
  }             ;
  Object.defineProperty(state, 'elements', {
    enumerable: true,
    configurable: false,
    get()                              {
      materializedElements ??= materializeElementsFromRunState(runs);
      return materializedElements;
    },
  });
  state.operations = {};
  state.pending = {};
  state.maxPending = maxPending;
  state.rebootstrapRequired = false;
  stateRunStore.set(state, runs);
  return state;
}

function makePlainState({ maxPending = DEFAULT_MAX_PENDING }                   = {})            {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new TypeError('maxPending must be a positive safe integer');
  return {
    version: 1,
    frontier: [],
    elements: makeNormalizedRegistry             (),
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
    op: Object.isFrozen(op) ? op : Object.freeze([...op]                   ),
    ordinal,
    scalar,
    parent,
    lamport,
    deletedBy: deletedBy.length === 0 ? EMPTY_DELETED_BY : Object.freeze([...deletedBy])                       ,
  });
}

function deriveRunStateFromExternalState(state           )                  {
  const existing = stateRunStore.get(state);
  if (existing) return existing;
  const opEntries = Object.values(state.operations);
  if (opEntries.length === 0 && Object.keys(state.elements).length > 0) return null;
  const runs = createEmptyRunState();
  for (let i = 0; i < opEntries.length; i += 1) {
    const op = opEntries[i].op;
    const body = op[5];
    if (body[0] === 'insert') {
      const key = opKey(op[2]);
      const text = body[2];
      const count = countWellFormedScalars(text);
      const run            = {
        op: op[2],
        opKey: key,
        lamport: op[3],
        parentKey: anchorKey(body[1]),
        text,
        scalarCount: count,
        isBmp: count === text.length,
      };
      runs.inserts.set(key, run);
      if (op[3] > runs.maxLamport) runs.maxLamport = op[3];
      runs.elementCount += count;
    }
  }
  for (let i = 0; i < opEntries.length; i += 1) {
    const op = opEntries[i].op;
    const body = op[5];
    if (body[0] === 'delete') {
      const deleteTag = opKey(op[2]);
      for (const [target, first, count] of body[1]) {
        const targetKey = opKey(target);
        const existingIntervals = runs.deletes.get(targetKey);
        const entry                 = { first, end: first + count, deleteTag };
        runs.deletes.set(targetKey, existingIntervals ? [...existingIntervals, entry] : [entry]);
      }
    }
  }
  if (Object.isFrozen(state)) stateRunStore.set(state, runs);
  return runs;
}

function cloneState(state           )                                       {
  const sourceRuns = deriveRunStateFromExternalState(state);
  if (!sourceRuns) {
    // External hand-crafted state whose elements were supplied without matching operations.
    const runs = createEmptyRunState();
    const cloned            = {
      version: 1,
      frontier: [...state.frontier],
      elements: cloneRegistry(state.elements),
      operations: cloneRegistry(state.operations),
      pending: cloneRegistry(state.pending),
      maxPending: state.maxPending,
      rebootstrapRequired: state.rebootstrapRequired,
    };
    return { state: cloned, runs };
  }
  const nextRuns = cloneRunState(sourceRuns);
  const nextState = makeRunBackedState({ maxPending: state.maxPending }, nextRuns);
  nextState.frontier = [...state.frontier];
  nextState.operations = cloneRegistry(state.operations);
  nextState.pending = cloneRegistry(state.pending);
  nextState.rebootstrapRequired = state.rebootstrapRequired;
  return { state: nextState, runs: nextRuns };
}

function assertState(state           )            {
  if (!state || state.version !== 1 || !Array.isArray(state.frontier) || !state.operations || !state.pending) {
    throw new TypeError('invalid annotated-text reducer state');
  }
  // Trusted RunState-backed states were validated and constructed by this
  // module; do not trigger the lazy `elements` getter or re-run frontier
  // regex checks on the per-keystroke hot path.
  if (stateRunStore.has(state)) return state;
  if (!state.elements) throw new TypeError('invalid annotated-text reducer state');
  assertFrontier(state.frontier);
  return state;
}

export function createTextState(options                   )            {
  const runs = createEmptyRunState();
  return Object.freeze(makeRunBackedState(options, runs));
}

/** O(1) max element Lamport clock for a validated TextState (avoids O(chars) scans). */
export function textStateMaxLamport(state           )         {
  assertState(state);
  const runs = deriveRunStateFromExternalState(state);
  if (runs) return runs.maxLamport;
  let maxLamport = 0;
  for (const key in state.elements) {
    const lamport = state.elements[key].lamport;
    if (lamport > maxLamport) maxLamport = lamport;
  }
  return maxLamport;
}

/** O(1) total element count (live + tombstones) for a validated TextState. */
export function textStateElementCount(state           )         {
  assertState(state);
  const runs = deriveRunStateFromExternalState(state);
  if (runs) return runs.elementCount;
  return Object.keys(state.elements).length;
}

/** O(1) membership check for an element key without materializing `state.elements`. */
export function hasTextElement(state           , key        )          {
  assertState(state);
  const runs = deriveRunStateFromExternalState(state);
  if (!runs) return Object.hasOwn(state.elements, key);
  const parsed = parseElementKey(key);
  if (!parsed) return false;
  const run = runs.inserts.get(parsed.opKey);
  return run !== undefined && parsed.ordinal < run.scalarCount;
}

/** O(1) liveness check for an element key without materializing `state.elements`. */
export function isTextElementLive(state           , key        )          {
  assertState(state);
  const runs = deriveRunStateFromExternalState(state);
  if (!runs) return state.elements[key]?.deletedBy.length === 0;
  const parsed = parseElementKey(key);
  if (!parsed) return false;
  const run = runs.inserts.get(parsed.opKey);
  if (!run || parsed.ordinal >= run.scalarCount) return false;
  const intervals = runs.deletes.get(parsed.opKey);
  if (!intervals) return true;
  for (let i = 0; i < intervals.length; i += 1) {
    if (intervals[i].first <= parsed.ordinal && parsed.ordinal < intervals[i].end) return false;
  }
  return true;
}

function stateFrontierCounter(state           , actor        )         {
  return frontierCounterValidated(state.frontier, actor);
}

function operationTargetsReady(runs          , op        )          {
  const body = op[5];
  if (body[0] === 'insert') {
    const anchor = body[1];
    if (anchor[0] === 'root') return true;
    const run = runs.inserts.get(opKey(anchor[1][0]));
    return run !== undefined && anchor[1][1] < run.scalarCount;
  }
  for (let i = 0; i < body[1].length; i += 1) {
    const [target, first, count] = body[1][i];
    const run = runs.inserts.get(opKey(target));
    if (!run || first + count > run.scalarCount) return false;
  }
  return true;
}

function operationReady(state           , runs                 , op        )          {
  if (!frontierDominatesValidated(state.frontier, op[4])) return false;
  if (runs) return operationTargetsReady(runs, op);
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
  const current = state.frontier;
  const entry = Object.freeze([actor, counter])        ;
  // Insert/replace in sorted order in O(frontier) without calling Array.sort.
  let lo = 0;
  let hi = current.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (current[mid][0] < actor) lo = mid + 1;
    else hi = mid;
  }
  if (lo < current.length && current[lo][0] === actor) {
    const next = current.slice();
    next[lo] = entry;
    state.frontier = next;
  } else {
    const next = new Array      (current.length + 1);
    for (let i = 0; i < lo; i += 1) next[i] = current[i];
    next[lo] = entry;
    for (let i = lo; i < current.length; i += 1) next[i + 1] = current[i];
    state.frontier = next;
  }
}

function applyReadyToRunState(state           , runs          , op        , digest        , updateFrontier = true) {
  const body = op[5];
  const key = opKey(op[2]);
  if (body[0] === 'insert') {
    const text = body[2];
    const count = countWellFormedScalars(text);
    const run            = {
      op: op[2],
      opKey: key,
      lamport: op[3],
      parentKey: anchorKey(body[1]),
      text,
      scalarCount: count,
      isBmp: count === text.length,
    };
    runs.inserts.set(key, run);
    if (op[3] > runs.maxLamport) runs.maxLamport = op[3];
    runs.elementCount += count;
  } else {
    const deleteTag = key;
    for (let i = 0; i < body[1].length; i += 1) {
      const [target, first, count] = body[1][i];
      const targetKey = opKey(target);
      const existing = runs.deletes.get(targetKey);
      const entry                 = { first, end: first + count, deleteTag };
      runs.deletes.set(targetKey, existing ? [...existing, entry] : [entry]);
    }
  }
  state.operations[key] = Object.freeze({ digest, op });
  if (updateFrontier) advanceFrontier(state, op);
}

function applyReadyToPlainState(state           , op        , digest        ) {
  const body = op[5];
  if (body[0] === 'insert') {
    const parent = anchorKey(body[1]);
    const opTag = opKey(op[2]);
    const text = body[2];
    let previous = parent;
    let ordinal = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      const scalar = code >= 0xD800 && code <= 0xDBFF
        ? text.slice(index, (index += 1) + 1)
        : text[index];
      const key = `${opTag}:${ordinal}`;
      state.elements[key] = frozenElement(op[2], ordinal, scalar, previous, op[3], EMPTY_DELETED_BY);
      previous = key;
      ordinal += 1;
    }
  } else {
    const deleteTag = opKey(op[2]);
    for (const [target, first, count] of body[1]) {
      const targetTag = opKey(target);
      for (let ordinal = first; ordinal < first + count; ordinal += 1) {
        const key = `${targetTag}:${ordinal}`;
        const element = state.elements[key];
        if (!element.deletedBy.includes(deleteTag)) {
          state.elements[key] = frozenElement(element.op, element.ordinal, element.scalar, element.parent, element.lamport, [...element.deletedBy, deleteTag]);
        }
      }
    }
  }
  state.operations[opKey(op[2])] = Object.freeze({ digest, op });
  advanceFrontier(state, op);
}

function drainPending(state           , runs                 ) {
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const key of Object.keys(state.pending).sort()) {
      const entry = state.pending[key];
      if (!operationReady(state, runs, entry.op)) continue;
      delete state.pending[key];
      if (runs) applyReadyToRunState(state, runs, entry.op, entry.digest, true);
      else applyReadyToPlainState(state, entry.op, entry.digest);
      progressed = true;
    }
  }
}

/**
 * O(ops + totalDeps) causal topological replay using the watched-literal
 * readiness queue: each operation watches a single currently-unsatisfied
 * dependency, waking only when that exact dependency commits and advancing
 * monotonically through its dependency list. Total memory is O(ops).
 */
function replayAppliedOperations(
  restored           ,
  runs          ,
  applied                                       ,
  checkBehindFrontier         ,
  unreducibleMessage        ,
)       {
  const count = applied.length;
  if (count === 0) return;

  const frontierMap = new Map                ();
  const watchIdx = new Int32Array(count);
  const waiters = new Map                  ();
  const ready           = [];

  for (let i = 0; i < count; i += 1) {
    const deps = applied[i].op[4];
    if (deps.length === 0) {
      ready.push(i);
    } else {
      watchIdx[i] = 0;
      const [depActor, depCounter] = deps[0];
      const depKey = `${depActor}:${depCounter}`;
      let list = waiters.get(depKey);
      if (!list) {
        list = [];
        waiters.set(depKey, list);
      }
      list.push(i);
    }
  }

  let head = 0;
  let appliedCount = 0;
  while (head < ready.length) {
    const idx = ready[head];
    head += 1;
    const { op, digest } = applied[idx];
    const [actor, counter] = op[2];
    if (checkBehindFrontier && (frontierMap.get(actor) ?? 0) >= counter) {
      throw new Error('annotated-text operation ID is behind the applied frontier');
    }
    if (!operationTargetsReady(runs, op)) {
      throw new TypeError(unreducibleMessage);
    }
    applyReadyToRunState(restored, runs, op, digest, false);
    frontierMap.set(actor, counter);
    appliedCount += 1;

    const appliedKey = `${actor}:${counter}`;
    const waiting = waiters.get(appliedKey);
    if (waiting) {
      waiters.delete(appliedKey);
      for (let w = 0; w < waiting.length; w += 1) {
        const waiterIdx = waiting[w];
        const deps = applied[waiterIdx].op[4];
        let pos = watchIdx[waiterIdx] + 1;
        let blocked = false;
        while (pos < deps.length) {
          const [depActor, depCounter] = deps[pos];
          if ((frontierMap.get(depActor) ?? 0) < depCounter) {
            watchIdx[waiterIdx] = pos;
            const depKey = `${depActor}:${depCounter}`;
            let list = waiters.get(depKey);
            if (!list) {
              list = [];
              waiters.set(depKey, list);
            }
            list.push(waiterIdx);
            blocked = true;
            break;
          }
          pos += 1;
        }
        if (!blocked) ready.push(waiterIdx);
      }
    }
  }

  if (appliedCount !== count) {
    throw new TypeError(unreducibleMessage);
  }

  const frontierEntries         = [];
  for (const [actor, counter] of frontierMap) {
    frontierEntries.push(Object.freeze([actor, counter])        );
  }
  frontierEntries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  restored.frontier = frontierEntries;
}

function assertCheckpoint(value         )            {
  const raw = value                       ;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => !['version', 'frontier', 'elements', 'operations', 'pending', 'maxPending', 'rebootstrapRequired'].includes(key))) {
    throw new TypeError('invalid annotated-text checkpoint');
  }
  const state = makePlainState({ maxPending: raw.maxPending });
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
  const runs = createEmptyRunState();
  const restored = makeRunBackedState({ maxPending: supplied.maxPending }, runs);
  replayAppliedOperations(
    restored,
    runs,
    applied,
    true,
    'annotated-text checkpoint applied operations are not causally reducible',
  );
  for (const { op, digest } of pending.sort((left, right) => compareOpIdValidated(left.op[2], right.op[2]))) {
    if (operationReady(restored, runs, op)) {
      throw new TypeError('annotated-text checkpoint contains a ready pending operation');
    }
    if (stateFrontierCounter(restored, op[2][0]) >= op[2][1]) {
      throw new Error('annotated-text operation ID is behind the applied frontier');
    }
    if (Object.keys(restored.pending).length >= restored.maxPending) {
      restored.rebootstrapRequired = true;
    } else {
      restored.pending[opKey(op[2])] = Object.freeze({ digest, op });
    }
  }
  // The operation that exceeded the live pending cap is intentionally not
  // retained. Its terminal outcome is nevertheless durable checkpoint state.
  if (supplied.rebootstrapRequired) restored.rebootstrapRequired = true;
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
  const runs = createEmptyRunState();
  const restored = makeRunBackedState({ maxPending: raw.maxPending }, runs);
  replayAppliedOperations(
    restored,
    runs,
    applied,
    false,
    'compact annotated-text checkpoint operations are not causally reducible',
  );
  for (const { op, digest } of pending.sort((left, right) => compareOpIdValidated(left.op[2], right.op[2]))) {
    if (operationReady(restored, runs, op)) throw new TypeError('compact annotated-text checkpoint contains a ready pending operation');
    restored.pending[opKey(op[2])] = Object.freeze({ digest, op });
  }
  if (raw.rebootstrapRequired) restored.rebootstrapRequired = true;
  if (restored.frontier.length !== expectedFrontier.length
    || restored.frontier.some((entry, idx) => !sameOpId(entry, expectedFrontier[idx]))) {
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
  const frozen = Object.freeze({
    version: 1         ,
    frontier: canonicalFrontier(state.frontier),
    elements: sortedElements,
    operations: registry(state.operations),
    pending: registry(state.pending),
    maxPending: state.maxPending,
    rebootstrapRequired: state.rebootstrapRequired,
  });
  const runs = stateRunStore.get(state);
  if (runs) stateRunStore.set(frozen, runs);
  return frozen;
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

function comparePieceOrder(left          , right          )         {
  return right.lamport - left.lamport || -compareOpIdValidated(left.op, right.op);
}

/**
 * Run/piece-aware RGA DFS traversal derived directly from RunState.
 * Splitting each insert run at external child anchors and delete interval
 * boundaries produces a piece sequence strictly isomorphic to scalar-by-scalar
 * RGA traversal in O(pieces log pieces) instead of O(chars).
 */
export function buildRgaPieces(state           )             {
  assertState(state);
  const cached = statePiecesCache.get(state);
  if (cached) return cached;
  const runs = deriveRunStateFromExternalState(state);
  if (!runs) return [];

  const splitsByOp = new Map                     ();
  const addSplit = (targetOpKey        , ordinal        , scalarLen        ) => {
    if (ordinal <= 0 || ordinal >= scalarLen) return;
    let set = splitsByOp.get(targetOpKey);
    if (!set) {
      set = new Set();
      splitsByOp.set(targetOpKey, set);
    }
    set.add(ordinal);
  };

  for (const run of runs.inserts.values()) {
    if (run.parentKey !== ROOT_ID) {
      const parsed = parseElementKey(run.parentKey);
      if (parsed) {
        const parentRun = runs.inserts.get(parsed.opKey);
        if (parentRun) addSplit(parsed.opKey, parsed.ordinal + 1, parentRun.scalarCount);
      }
    }
  }
  for (const [targetOpKey, intervals] of runs.deletes) {
    const targetRun = runs.inserts.get(targetOpKey);
    if (!targetRun) continue;
    for (let i = 0; i < intervals.length; i += 1) {
      addSplit(targetOpKey, intervals[i].first, targetRun.scalarCount);
      addSplit(targetOpKey, intervals[i].end, targetRun.scalarCount);
    }
  }

  const singleChild = new Map                  ();
  const multiChildren = new Map                    ();
  const attachChild = (parentKey        , piece          ) => {
    const multi = multiChildren.get(parentKey);
    if (multi !== undefined) {
      multi.push(piece);
      return;
    }
    const existing = singleChild.get(parentKey);
    if (existing !== undefined) {
      singleChild.delete(parentKey);
      multiChildren.set(parentKey, [existing, piece]);
      return;
    }
    singleChild.set(parentKey, piece);
  };

  for (const run of runs.inserts.values()) {
    const splitSet = splitsByOp.get(run.opKey);
    const delIntervals = runs.deletes.get(run.opKey);
    const starts = run.isBmp ? null : (splitSet && splitSet.size > 0 ? ensureRunUtf16Starts(run) : null);

    if (!splitSet || splitSet.size === 0) {
      const deleted = delIntervals !== undefined && delIntervals.some((iv) => iv.first <= 0 && 0 < iv.end);
      attachChild(run.parentKey, {
        op: run.op,
        opKey: run.opKey,
        lamport: run.lamport,
        parentKey: run.parentKey,
        startOrdinal: 0,
        length: run.scalarCount,
        deleted,
        text: run.text,
        isBmp: run.isBmp,
        run,
      });
      continue;
    }

    const boundaries = Array.from(splitSet).sort((a, b) => a - b);
    let segStart = 0;
    for (let i = 0; i <= boundaries.length; i += 1) {
      const segEnd = i < boundaries.length ? boundaries[i] : run.scalarCount;
      const deleted = delIntervals !== undefined && delIntervals.some((iv) => iv.first <= segStart && segStart < iv.end);
      const text = starts === null
        ? run.text.slice(segStart, segEnd)
        : run.text.slice(starts[segStart], starts[segEnd]);
      const parentKey = segStart === 0 ? run.parentKey : `${run.opKey}:${segStart - 1}`;
      const length = segEnd - segStart;
      attachChild(parentKey, {
        op: run.op,
        opKey: run.opKey,
        lamport: run.lamport,
        parentKey,
        startOrdinal: segStart,
        length,
        deleted,
        text,
        isBmp: text.length === length,
        run,
      });
      segStart = segEnd;
    }
  }

  for (const list of multiChildren.values()) {
    list.sort(comparePieceOrder);
  }

  const pieces             = [];
  const stack             = [];
  const rootSingle = singleChild.get(ROOT_ID);
  if (rootSingle !== undefined) {
    stack.push(rootSingle);
  } else {
    const rootMulti = multiChildren.get(ROOT_ID);
    if (rootMulti !== undefined) {
      for (let i = rootMulti.length - 1; i >= 0; i -= 1) stack.push(rootMulti[i]);
    }
  }

  while (stack.length > 0) {
    let piece                       = stack.pop();
    while (piece !== undefined) {
      pieces.push(piece);
      const tailKey = `${piece.opKey}:${piece.startOrdinal + piece.length - 1}`;
      const nextSingle = singleChild.get(tailKey);
      if (nextSingle !== undefined) {
        piece = nextSingle;
        continue;
      }
      const nextMulti = multiChildren.get(tailKey);
      if (nextMulti !== undefined) {
        for (let i = nextMulti.length - 1; i >= 1; i -= 1) stack.push(nextMulti[i]);
        piece = nextMulti[0];
        continue;
      }
      piece = undefined;
    }
  }

  if (Object.isFrozen(state)) statePiecesCache.set(state, pieces);
  return pieces;
}

export function materializeText(state           )         {
  assertState(state);
  const runs = deriveRunStateFromExternalState(state);
  if (runs) {
    const pieces = buildRgaPieces(state);
    if (pieces.length === 0) return '';
    if (pieces.length === 1) return pieces[0].deleted ? '' : pieces[0].text;
    const chunks           = [];
    for (let i = 0; i < pieces.length; i += 1) {
      if (!pieces[i].deleted) chunks.push(pieces[i].text);
    }
    return chunks.join('');
  }
  const children = new Map                                      ([[ROOT_ID, []]]);
  for (const [key, element] of Object.entries(state.elements)) {
    const list = children.get(element.parent) ?? [];
    list.push([key, element]);
    children.set(element.parent, list);
  }
  for (const list of children.values()) {
    list.sort(([, left], [, right]) => right.lamport - left.lamport || -compareOpIdValidated(left.op, right.op));
  }
  const chunks           = [];
  const stack                               = [...(children.get(ROOT_ID) ?? [])].reverse();
  while (stack.length > 0) {
    const [key, element] = stack.pop() ;
    if (element.deletedBy.length === 0) chunks.push(element.scalar);
    const descendants = children.get(key);
    if (descendants) stack.push(...descendants.slice().reverse());
  }
  return chunks.join('');
}

// Applies one immutable operation. It is deliberately atomic: an operation is
// either fully reduced, retained intact in the bounded pending registry, or the
// replica fails closed and must rebootstrap from a checkpoint.
export function applyTextOp(current           , value         )            {
  const validated = assertState(current);
  // A failed-closed replica freezes in place; cloning the registries before the
  // early return spent the full per-apply copy for an unchanged result.
  if (validated.rebootstrapRequired) return Object.freeze(validated);
  const { op, digest } = canonicalTextOpDigest(value);
  const key = opKey(op[2]);
  const known = validated.operations[key] ?? validated.pending[key];
  if (known) {
    if (known.digest !== digest) throw new Error('annotated-text operation ID was reused with different content');
    return Object.freeze(validated);
  }
  // A contiguous frontier also makes a counter at or behind it equivocal even
  // if a damaged checkpoint omitted its operation registry entry.
  if (stateFrontierCounter(validated, op[2][0]) >= op[2][1]) throw new Error('annotated-text operation ID is behind the applied frontier');
  const { state, runs } = cloneState(validated);
  const hasRuns = stateRunStore.has(state);
  if (operationReady(state, hasRuns ? runs : null, op)) {
    if (hasRuns) applyReadyToRunState(state, runs, op, digest, true);
    else applyReadyToPlainState(state, op, digest);
    drainPending(state, hasRuns ? runs : null);
  } else if (Object.keys(state.pending).length >= state.maxPending) {
    state.rebootstrapRequired = true;
  } else {
    state.pending[key] = Object.freeze({ digest, op });
  }
  return Object.freeze(state);
}
