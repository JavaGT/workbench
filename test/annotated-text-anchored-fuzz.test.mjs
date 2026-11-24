// Anchored-range stress harness (Scope issue JavaGT/scope#720, feeding
// Decision 0025). Two deterministic, seeded lanes:
//
// 1. Convergence lane — N virtual clients author raw text ops from stale
//    causal views; deliveries are probabilistic and flushed at batch end.
//    Invariant: every replica converges to an identical RGA traversal.
//
// 2. Oracle lane — a converged document is driven through the planning seam
//    (`planTextOffsetEdit` / `planTextRangeApply` / `planAnnotationRemove`)
//    while a naive offset-space reimplementation applies the same visible
//    edits with standard shrink/clamp remapping. Invariants per batch:
//      - replica convergence (identical RGA sequence across clients),
//      - every surviving anchored range materializes exactly the naive
//        oracle substring (modulo the documented shrink/clamp rules),
//      - emptied-range dispositions account for exactly the deletions that
//        collapse a range, with saved quotes matching the lost substring.
//
// Everything is reproducible from numeric seeds (mulberry32). Every failure
// message carries the seed and step so drift bugs are directly reportable.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTextState, applyTextOp, materializeText, textCheckpoint } from '../build/annotated-text.mjs';
import { insertText, deleteText } from '../public/workbench-text-edit.mjs';
import {
  applyTextOperation,
  createTextFamily,
  materializeRange,
  materializeText as materializeFamilyText,
  projectEndpointToOffset,
} from '../build/annotated-text-continuous.mjs';
import { rgaTraversal } from '../build/annotated-text-family.mjs';
import {
  planTextOffsetEdit,
  planAnnotationRemove,
  planTextRangeApply,
} from '../build/annotated-text-plan.mjs';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACTORS = ['a', 'b', 'c', 'd', 'e'].map((ch) => ch.repeat(32));
const DOC = 'fuzz-doc';
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'ok', 'x', 'zet', 'word', 'q'];

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

/** Scalar-aligned offsets of a string (UTF-16 aware). */
function scalarOffsets(text) {
  const offsets = [0];
  for (const scalar of text) offsets.push(offsets[offsets.length - 1] + scalar.length);
  return offsets;
}

// ---------------------------------------------------------------------------
// Lane 1: replica convergence under concurrent, delayed delivery.
// ---------------------------------------------------------------------------

function runConvergenceSeed(seed, steps) {
  const rng = mulberry32(seed);
  const replicas = new Map(ACTORS.map((actor) => [actor, createTextState()]));
  const applied = new Map(ACTORS.map((actor) => [actor, new Set()]));
  const counters = new Map(ACTORS.map((actor) => [actor, 0]));
  const log = [];
  let lamport = 0;

  function identity(actor) {
    counters.set(actor, counters.get(actor) + 1);
    return { actor, counter: counters.get(actor), lamport: ++lamport };
  }

  function tryDeliver(op, actor, force) {
    if (applied.get(actor).has(op)) return;
    if (force || rng() < 0.6) {
      replicas.set(actor, applyTextOp(replicas.get(actor), op));
      applied.get(actor).add(op);
    }
  }

  function flushAll() {
    for (const actor of ACTORS) for (const op of log) tryDeliver(op, actor, true);
  }

  function publish(op, author, forceAll) {
    log.push(op);
    tryDeliver(op, author, true);
    for (const other of ACTORS) {
      if (other !== author) tryDeliver(op, other, forceAll);
    }
  }

  // Scripted seed document: one multi-scalar chunk from actor A everywhere.
  publish(
    insertText(replicas.get(ACTORS[0]), identity(ACTORS[0]), 0, 'the quick brown fox'),
    ACTORS[0],
    true,
  );

  for (let step = 0; step < steps; step += 1) {
    if (step % 12 === 11) flushAll(); // batch boundary: authors see fresh views

    const actor = pick(rng, ACTORS);
    const state = replicas.get(actor);
    const text = materializeText(state);
    if (text.length > 0 && rng() < 0.45) {
      const offsets = scalarOffsets(text);
      const count = offsets.length - 1;
      const startIdx = Math.floor(rng() * count);
      const length = 1 + Math.floor(rng() * Math.min(6, count - startIdx));
      publish(
        deleteText(state, identity(actor), offsets[startIdx], offsets[startIdx + length]),
        actor,
        false,
      );
    } else {
      const offset = pick(rng, scalarOffsets(text));
      publish(insertText(state, identity(actor), offset, pick(rng, WORDS)), actor, false);
    }
  }

  flushAll(); // final convergence: every op reaches every replica

  return { master: createTextState(), replicas };
}

test('anchored fuzz lane 1: replicas converge to identical RGA sequences', () => {
  for (const seed of [0xc0ffee, 1234, 0x5eed01]) {
    const { replicas } = runConvergenceSeed(seed, 400);
    const referenceActor = ACTORS[0];
    const referenceState = replicas.get(referenceActor);
    const referenceRgaKeys = JSON.stringify(rgaTraversal(referenceState).map(([key]) => key));
    const referenceCheckpoint = JSON.stringify(textCheckpoint(referenceState));
    const referenceText = materializeText(referenceState);
    assert.ok(referenceText.length > 10, `seed ${seed}: document unexpectedly small`);
    for (const [actor, state] of replicas) {
      assert.equal(
        materializeText(state), referenceText,
        `seed ${seed}: replica ${actor.slice(0, 4)} materialized different text`,
      );
      // Canonical checkpoints sort deletedBy, so equality here means the full
      // element/tombstone state converged, not just the visible text.
      assert.equal(
        JSON.stringify(textCheckpoint(state)), referenceCheckpoint,
        `seed ${seed}: replica ${actor.slice(0, 4)} diverged from master canonical checkpoint`,
      );
      assert.equal(
        JSON.stringify(rgaTraversal(state).map(([key]) => key)), referenceRgaKeys,
        `seed ${seed}: replica ${actor.slice(0, 4)} diverged from master RGA sequence`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Lane 2: anchored ranges vs a naive offset-space reimplementation.
//
// A single converged document is driven through the planning seam while a
// naive model applies the same visible edits in offset space. Tokens are
// atomic inserted chunks: text edits land on token boundaries and annotation
// selections cover whole tokens, so naive token edges always coincide with
// element boundaries and the two models are directly comparable.
// ---------------------------------------------------------------------------

/**
 * Naive remap of one range across inserting L scalars at offset i. An
 * insertion before or inside the range shifts the relevant bounds; exactly
 * AT a boundary it joins only per the endpoint affinity (mirrors
 * resolveOffsetToEndpoint: start 'right' admits it, 'left' does not; end
 * 'left' admits it, 'right' does not).
 */
/**
 * Naive remap of one range across inserting L scalars at offset i. The
 * anchored model absorbs joining insertions into the materialized substring
 * (endpoints are pinned), so the naive span GROWS rather than sliding:
 *  - i < s: text lands wholly before the range — shift both bounds;
 *  - i === s: joins only under 'right' start affinity (then e grows; s is
 *    already i); 'left' excludes and nothing moves;
 *  - s < i < e: strictly inside — absorbed, e grows, s stays;
 *  - i >= e: outside after; joins only at exactly e under 'left' end
 *    affinity (and never for an end pinned at the document end).
 * A start created at offset 0 is pinned to root-'left' forever: it never
 * moves and every prepend is absorbed.
 */
/**
 * Naive remap of one range across inserting L scalars at offset i. The
 * generator never inserts exactly AT a tracked span boundary (see
 * opInsert), so only four shapes reach here:
 *  - i < s: text wholly before — slide both bounds;
 *  - s < i < e: strictly inside — the anchored endpoints are pinned, the
 *    text is absorbed: s stays, e grows;
 *  - i > e: wholly after — nothing moves;
 *  - s0 spans (created at offset 0) are root-'left'-pinned: s stays 0 and
 *    every prepend before them is absorbed into the slice.
 */
function naiveRemapInsert(span, sA, eA, i, L) {
  if (i < span.s) return { s: span.s0 ? 0 : span.s + L, e: span.e + L };
  if (i > span.e) return { s: span.s0 ? 0 : span.s, e: span.e };
  // i inside (s <= i <= e can only be strictly inside here)
  return { s: span.s0 ? 0 : span.s, e: span.e + L };
}

/** Naive remap across deleting [a, b): shift past it, clamp into it. A
 * root-pinned start stays at absolute 0 — nothing can precede it. */
function naiveRemapDelete(span, a, b) {
  const shift = b - a;
  const remap = (p) => (p <= a ? p : p >= b ? p - shift : a);
  return {
    s: span.s0 ? 0 : remap(span.s),
    e: remap(span.e),
  };
}

let lastTrace = [];

function runOracleSeed(seed, { batches, batchOps }) {
  const rng = mulberry32(seed);
  const ctx = () => `seed ${seed} step ${step}`;
  const trace = [];
  lastTrace = trace;
  let step = 0;
  let structureVersion = 0;
  let lamport = 0;
  let annotationCounter = 0;

  const families = new Map(ACTORS.map((actor) => [actor, createTextFamily(DOC, createTextState())]));
  const applyToAll = (operations) => {
    for (const operation of operations) {
      for (const actor of ACTORS) {
        families.set(actor, applyTextOperation(families.get(actor), operation));
      }
    }
  };

  // Naive model: visible text, atomic token spans, per-annotation offset
  // spans with creation-time affinities, plus the planned anchored ranges.
  let naiveText = '';
  let tokens = []; // [{ s, e }] — atomic chunks, never partially deleted
  const spans = new Map(); // id -> { s, e, sA, eA }
  const annotations = new Map(); // id -> Annotation
  let trackedRanges = []; // latest planned AnnotationRange[]
  const collapseTally = { orphaned: 0, deleted: 0 };
  let _collapsedCount = 0;

  // The plan builder mints [actor, 1] per text op and requires each actor's
  // next op to chain causally from its previous one — so every edit needs a
  // fresh actor id (mirrors how sessions scope edit identities).
  let editCounter = 0;
  // The counter leads so the replace path's `actor.slice(0, 30)` + 'd0'/'e0'
  // derivation stays unique per edit.
  function nextActor() {
    return (++editCounter).toString(16).padStart(30, '0') + 'e1';
  }

  function textOperationsOf(plan_) {
    if (plan_.operation.kind === 'text.apply') return [plan_.operation.operation];
    if (plan_.operation.kind === 'text.replace') return [...plan_.operation.operations];
    return [];
  }

  /** Apply a plan to every family and reconcile emptied-range dispositions. */
  function commit(plan_) {
    applyToAll(textOperationsOf(plan_));
    for (const emptied of plan_.facts.emptiedAnnotations) {
      const span = spans.get(emptied.annotationId);
      assert.ok(span, `${ctx()}: disposition for untracked annotation ${emptied.annotationId}`);
      const quoteBefore = naiveText.slice(span.s, span.e);
      assert.ok(quoteBefore.length > 0, `${ctx()}: ${emptied.annotationId} collapsed but naive quote is empty`);
      if (emptied.disposition.kind === 'orphaned') {
        assert.equal(
          emptied.disposition.savedQuote, quoteBefore,
          `${ctx()}: savedQuote mismatch for ${emptied.annotationId}`,
        );
      }
      collapseTally[emptied.disposition.kind] += 1;
      _collapsedCount += 1;
      spans.delete(emptied.annotationId);
      annotations.delete(emptied.annotationId);
      trackedRanges = trackedRanges.filter((entry) => entry.annotationId !== emptied.annotationId);
    }
  }

  /** Plan a document-wide edit against a fully caught-up author family. */
  function planEdit(edit) {
    trace.push(`step ${step}: ${edit.kind} ${JSON.stringify(edit)}`);
    const plan_ = planTextOffsetEdit({
      documentId: DOC,
      structureVersion,
      family: families.get(pick(rng, ACTORS)),
      actor: nextActor(),
      lamport: ++lamport,
      edit,
      annotations: [...annotations.values()],
      ranges: trackedRanges,
    });
    commit(plan_);
    structureVersion += 1;
    return plan_;
  }

  function opInsert() {
    const tracked = new Set();
    for (const span of spans.values()) {
      if (!span.s0) tracked.add(span.s);
      tracked.add(span.e);
    }
    // Never insert exactly at a tracked span edge: affinity-join behavior
    // there depends on sibling history an offset oracle cannot model. The
    // dedicated boundary join-table test covers those cases exactly.
    const boundaries = [0, naiveText.length].filter((b) => !tracked.has(b));
    for (const token of tokens) {
      if (!tracked.has(token.s)) boundaries.push(token.s);
      if (!tracked.has(token.e)) boundaries.push(token.e);
    }
    if (boundaries.length === 0) return false;
    const i = pick(rng, boundaries);
    const word = `${pick(rng, WORDS)} `;
    planEdit({ kind: 'text.insert', at: { offset: i, affinity: 'left' }, text: word });
    for (const [id, span] of [...spans]) spans.set(id, { ...span, ...naiveRemapInsert(span, span.sA, span.eA, i, word.length) });
    tokens = tokens.map((t) => ({ s: t.s + (t.s >= i ? word.length : 0), e: t.e + (t.e > i ? word.length : 0) }));
    tokens.push({ s: i, e: i + word.length });
    naiveText = naiveText.slice(0, i) + word + naiveText.slice(i);
    return true;
  }

  function opDelete() {
    const offsets = scalarOffsets(naiveText);
    if (offsets.length < 3) return false;
    const ai = Math.floor(rng() * (offsets.length - 2));
    const bi = ai + 1 + Math.floor(rng() * Math.min(5, offsets.length - 2 - ai));
    const a = offsets[ai];
    const b = offsets[Math.min(bi, offsets.length - 1)];
    if (a >= b) return false;
    planEdit({ kind: 'text.delete', from: { offset: a }, to: { offset: b } });
    for (const [id, span] of [...spans]) spans.set(id, { ...span, ...naiveRemapDelete(span, a, b) });
    // Partially deleted chunks lose atomic-element status; drop them so later
    // annotations never target a mid-element boundary.
    tokens = tokens
      .filter((t) => t.s < a || t.e > b ? t.e <= a || t.s >= b : false)
      .map((t) => ({ s: t.s + (t.s >= b ? -(b - a) : 0), e: t.e + (t.e >= b ? -(b - a) : 0) }));
    naiveText = naiveText.slice(0, a) + naiveText.slice(b);
    return true;
  }

  function opReplace() {
    if (tokens.length === 0) return false;
    const token = pick(rng, tokens);
    // Excluded corners: any replace TOUCHING a tracked annotated span
    // (overlapping or exactly adjacent). When the replaced region abuts a
    // span, the replacement insert lands in/near a fresh deletion gap and
    // newest-sibling-first ordering decides absorption from tombstone-pinned
    // slots — element-level state a naive offset-space oracle cannot model.
    // Planner/disposition policy owns those outcomes; disjoint replaces (the
    // common remap shape) are still exercised fully.
    for (const span of spans.values()) {
      if (token.s <= span.e && span.s <= token.e) return false;
    }
    const word = `${pick(rng, WORDS)} `;
    planEdit({
      kind: 'text.replace',
      from: { offset: token.s, affinity: 'left' },
      to: { offset: token.e },
      text: word,
    });
    // Replace = delete [s,e) then insert at s.
    for (const [id, span] of [...spans]) {
      const deleted = { ...span, ...naiveRemapDelete(span, token.s, token.e) };
      spans.set(id, { ...span, ...naiveRemapInsert(deleted, span.sA, span.eA, token.s, word.length) });
    }
    tokens = tokens.filter((t) => t !== token).map((t) => ({
      s: t.s + (t.s >= token.e ? word.length - (token.e - token.s) : 0),
      e: t.e + (t.e >= token.e ? word.length - (token.e - token.s) : 0),
    }));
    tokens.push({ s: token.s, e: token.s + word.length });
    naiveText = naiveText.slice(0, token.s) + word + naiveText.slice(token.e);
    return true;
  }

  function opAnnotate() {
    if (tokens.length === 0) return false;
    const author = pick(rng, ACTORS);
    const token = pick(rng, tokens);
    const id = `ann-${seed}-${annotationCounter++}`;
    trace.push(`step ${step}: annotate ${id} token [${token.s},${token.e})`);
    const annotation = { id, family: 'code', empty: rng() < 0.5 ? 'delete' : 'orphan' };
    const sA = rng() < 0.7 ? 'left' : 'right';
    const eA = rng() < 0.8 ? 'right' : 'left';
    const plan_ = planTextRangeApply({
      documentId: DOC,
      structureVersion,
      family: families.get(author),
      annotation,
      from: { offset: token.s, affinity: sA },
      to: { offset: token.e, affinity: eA },
      ranges: trackedRanges,
      actorId: author,
    });
    trackedRanges = [...plan_.facts.ranges];
    annotations.set(id, annotation);
    // Corner pins: a selection touching offset 0 resolves to root-'left';
    // one ending at the document end resolves to last-visible-'right'.
    spans.set(id, { s: token.s, e: token.e, sA, eA, s0: token.s === 0, eEOF: token.e === naiveText.length });
    // Creation-time anchor correctness: the resolved range must materialize
    // exactly the selected substring on every converged replica.
    for (const [, family] of families) {
      assert.equal(
        materializeRange(family, plan_.facts.selectedRange.start, plan_.facts.selectedRange.end),
        naiveText.slice(token.s, token.e),
        `${ctx()}: anchored selection for ${id} does not match the naive substring at creation`,
      );
    }
    return true;
  }

  function opRemove() {
    const ids = [...annotations.keys()];
    if (ids.length === 0) return false;
    const author = pick(rng, ACTORS);
    const id = pick(rng, ids);
    trace.push(`step ${step}: remove ${id}`);
    const plan_ = planAnnotationRemove({
      documentId: DOC,
      structureVersion,
      family: families.get(author),
      annotationId: id,
      annotations: [...annotations.values()],
      ranges: trackedRanges,
    });
    trackedRanges = [...plan_.facts.ranges];
    assert.deepEqual(
      [...plan_.facts.removedAnnotationIds], [id],
      `${ctx()}: remove planned unexpected membership changes`,
    );
    annotations.delete(id);
    spans.delete(id);
    return true;
  }

  // Scripted seed document, one whole-word chunk at a time so every initial
  // token is a single atomic element.
  for (const word of ['the ', 'quick ', 'brown ', 'fox ', 'jumps ']) {
    opInsertAt(word);
  }

  function opInsertAt(word) {
    const plan_ = planTextOffsetEdit({
      documentId: DOC,
      structureVersion,
      family: families.get(ACTORS[0]),
      actor: nextActor(),
      lamport: ++lamport,
      edit: { kind: 'text.insert', at: { offset: naiveText.length, affinity: 'left' }, text: word },
    });
    applyToAll([plan_.operation.operation]);
    structureVersion += 1;
    tokens.push({ s: naiveText.length, e: naiveText.length + word.length });
    naiveText += word;
  }

  const generators = [
    [0.30, opInsert],
    [0.25, opDelete],
    [0.10, opReplace],
    [0.20, opAnnotate],
    [0.15, opRemove],
  ];

  function pickOp() {
    let roll = rng();
    for (const [weight, gen] of generators) {
      roll -= weight;
      if (roll <= 0) return gen;
    }
    return opInsert;
  }

  /** Batch invariants: convergence + oracle equality + projection sanity. */
  function checkBatch() {
    const referenceFamily = families.get(ACTORS[0]);
    const referenceCheckpoint = JSON.stringify(textCheckpoint(referenceFamily.checkpoint));
    const referenceKeys = JSON.stringify(rgaTraversal(referenceFamily.checkpoint).map(([key]) => key));
    const referenceText = materializeFamilyText(referenceFamily);
    for (const [actor, family] of families) {
      assert.equal(
        materializeFamilyText(family), referenceText,
        `${ctx()}: family ${actor.slice(0, 4)} materialized different text`,
      );
      assert.equal(
        JSON.stringify(textCheckpoint(family.checkpoint)), referenceCheckpoint,
        `${ctx()}: family ${actor.slice(0, 4)} diverged from canonical checkpoint`,
      );
      assert.equal(
        JSON.stringify(rgaTraversal(family.checkpoint).map(([key]) => key)), referenceKeys,
        `${ctx()}: family ${actor.slice(0, 4)} diverged from RGA sequence`,
      );
    }
    assert.equal(
      trackedRanges.length, spans.size,
      `${ctx()}: tracked range count ${trackedRanges.length} != naive span count ${spans.size}`,
    );
    const length = materializeFamilyText(referenceFamily).length;
    for (const range of trackedRanges) {
      const span = spans.get(range.annotationId);
      assert.ok(span, `${ctx()}: anchored range without naive span: ${range.annotationId}`);
      const projectedStart = projectEndpointToOffset(referenceFamily, range.start);
      const projectedEnd = projectEndpointToOffset(referenceFamily, range.end);
      assert.ok(
        projectedStart >= 0 && projectedEnd >= projectedStart && projectedEnd <= length,
        `${ctx()}: projected offsets out of bounds for ${range.annotationId}: [${projectedStart}, ${projectedEnd}] in 0..${length}`,
      );
      for (const [, family] of families) {
        assert.equal(
          materializeRange(family, range.start, range.end),
          naiveText.slice(span.s, span.e),
          `${ctx()}: oracle mismatch for ${range.annotationId} — anchored "${materializeRange(family, range.start, range.end)}" vs naive "${naiveText.slice(span.s, span.e)}" (naive span [${span.s}, ${span.e}])`,
        );
      }
    }
    return { referenceCheckpoint };
  }

  for (let batch = 0; batch < batches; batch += 1) {
    for (let i = 0; i < batchOps; i += 1) {
      step += 1;
      const generate = pickOp();
      if (!generate()) opInsert(); // fall back to insert when op is unavailable
    }
    checkBatch();
  }

  return { collapseTally };
}

test('anchored fuzz lane 2: anchored ranges match the naive offset oracle', () => {
  const totals = { orphaned: 0, deleted: 0 };
  for (const seed of [0xc0ffee, 1234, 0x5eed01]) {
    let result;
    try {
      result = runOracleSeed(seed, { batches: 6, batchOps: 30 });
    } catch (error) {
      console.error(`TRACE seed ${seed}:\n${lastTrace.join('\n')}`);
      throw error;
    }
    // Per-seed floor: deletions happen often enough that several runs must
    // exercise the collapse path.
    const { collapseTally } = result;
    assert.ok(
      collapseTally.orphaned + collapseTally.deleted >= 1,
      `seed ${seed}: no range ever collapsed — fuzzer exercised nothing`,
    );
    totals.orphaned += collapseTally.orphaned;
    totals.deleted += collapseTally.deleted;
  }
  // Across seeds both server dispositions (orphan vs delete) must fire.
  assert.ok(
    totals.orphaned >= 1 && totals.deleted >= 1,
    `both dispositions must be exercised across seeds, got ${JSON.stringify(totals)}`,
  );
});

// ---------------------------------------------------------------------------
// Boundary join table: deterministic coverage of the exact-at-boundary
// insertion semantics the random lane deliberately skips. Expected values
// were extracted empirically from resolveOffsetToEndpoint + materializeRange
// and match the D0025 affinity prose (start 'left' excludes, 'right'
// absorbs; end 'right' excludes, 'left' absorbs).
// ---------------------------------------------------------------------------

test('anchored fuzz boundary join table: insertion exactly at range edges', () => {
  const nextActor = () => `e${(++lamportCounter).toString(16).padStart(29, '0')}f1`;
  const buildDoc = () => {
    let fam = createTextFamily(DOC, createTextState());
    for (const w of ['the ', 'quick ', 'brown ', 'fox ', 'jumps ', 'gamma ', 'delta ']) {
      const p = planTextOffsetEdit({
        documentId: DOC, structureVersion: 0, family: fam,
        actor: nextActor(), lamport: ++lamportCounter,
        edit: { kind: 'text.insert', at: { offset: materializeFamilyText(fam).length, affinity: 'left' }, text: w },
      });
      fam = applyTextOperation(fam, p.operation.operation);
    }
    return fam;
  };
  const annotate = (fam, s, e, sA, eA) => planTextRangeApply({
    documentId: DOC, structureVersion: 0, family: fam,
    annotation: { id: 'a', family: 'code', empty: 'delete' },
    from: { offset: s, affinity: sA }, to: { offset: e, affinity: eA },
    ranges: [], actorId: nextActor(),
  }).facts.selectedRange;
  const insertAt = (fam, i, text) => {
    const p = planTextOffsetEdit({
      documentId: DOC, structureVersion: 0, family: fam,
      actor: nextActor(), lamport: ++lamportCounter,
      edit: { kind: 'text.insert', at: { offset: i, affinity: 'left' }, text },
    });
    return applyTextOperation(fam, p.operation.operation);
  };

  // Doc: "the quick brown fox jumps gamma delta " — "brown " is [10, 16).
  for (const sA of ['left', 'right']) {
    for (const eA of ['left', 'right']) {
      let fam = buildDoc();
      const range = annotate(fam, 10, 16, sA, eA);
      assert.equal(materializeRange(fam, range.start, range.end), 'brown ', 'precondition');
      fam = insertAt(fam, 10, 'X ');
      const atStart = materializeRange(fam, range.start, range.end);
      assert.equal(
        atStart, sA === 'right' ? 'X brown ' : 'brown ',
        `insert at start, start affinity ${sA}: ${JSON.stringify(atStart)}`,
      );

      fam = buildDoc();
      const r2 = annotate(fam, 10, 16, sA, eA);
      fam = insertAt(fam, 16, 'Y ');
      const atEnd = materializeRange(fam, r2.start, r2.end);
      assert.equal(
        atEnd, eA === 'left' ? 'brown Y ' : 'brown ',
        `insert at end, end affinity ${eA} (start ${sA}): ${JSON.stringify(atEnd)}`,
      );
    }
  }

  // Corner pins: a selection starting at offset 0 resolves to root-'left'
  // and absorbs prepends regardless of requested affinity; a selection
  // ending at the document end never absorbs appends.
  let fam = buildDoc();
  const pinned = annotate(fam, 0, 4, 'left', 'right');
  fam = insertAt(fam, 0, 'HEAD ');
  assert.equal(
    materializeRange(fam, pinned.start, pinned.end), 'HEAD the ',
    'offset-0 start must absorb prepends',
  );

  fam = buildDoc();
  const tail = annotate(fam, 32, 38, 'left', 'left'); // "delta " ends the doc
  fam = insertAt(fam, 38, 'TAIL ');
  assert.equal(
    materializeRange(fam, tail.start, tail.end), 'delta ',
    'document-end end must exclude appends even under left affinity',
  );
});

let lamportCounter = 100;
