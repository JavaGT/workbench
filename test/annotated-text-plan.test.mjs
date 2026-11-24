import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  importTextToFamily,
  applyTextOperation,
  materializeText,
  resolveOffsetToEndpoint,
  projectEndpointToOffset,
  textOperationForOffsetEdit,
} from '../build/annotated-text-continuous.mjs';
import {
  planTextOffsetEdit,
  planAnnotationRemove,
  planTextRangeApply,
} from '../build/annotated-text-plan.mjs';

const ACTOR = 'a'.repeat(32);
const EDIT_ACTOR = 'b'.repeat(32);

function familyFromText(text) {
  return importTextToFamily('doc1', ACTOR, text);
}

function at(offset, affinity = 'right') {
  return { offset, affinity };
}

function input(family, edit, extra = {}) {
  return planTextOffsetEdit({
    documentId: 'doc1',
    structureVersion: 1,
    family,
    actor: EDIT_ACTOR,
    lamport: 2,
    edit,
    ...extra,
  });
}

function materializePlan(family, plan) {
  const operations = plan.operation.kind === 'text.replace' ? plan.operation.operations : [plan.operation.operation];
  return materializeText(operations.reduce((current, operation) => applyTextOperation(current, operation), family));
}

function rangeFor(family, annotationId, startOffset, endOffset) {
  const frontier = family.checkpoint.frontier;
  return {
    annotationId,
    start: resolveOffsetToEndpoint(family, startOffset, frontier, 'left'),
    end: resolveOffsetToEndpoint(family, endOffset, frontier, 'right'),
  };
}

test('plans insert, delete, and replace as unified document-wide operations', () => {
  const family = familyFromText('abc');

  const inserted = input(family, { kind: 'text.insert', text: 'x', at: at(1) });
  assert.equal(inserted.version, 14);
  assert.equal(inserted.operation.kind, 'text.apply');
  assert.equal(inserted.id, 'doc1');
  assert.deepEqual(inserted.before, { structuralRevision: 1, frontier: family.checkpoint.frontier });
  assert.equal(inserted.after.structuralRevision, 1, 'insert does not bump structuralRevision');
  assert.equal(inserted.facts.family, null);
  assert.equal(materializePlan(family, inserted), 'axbc');
  assert.equal(inserted.operation.operation[0], 'workbench.text');
  assert.equal(inserted.operation.operation[5][0], 'insert');
  assert.equal(inserted.operation.operation[5][2], 'x');
  assert.deepEqual(inserted.facts.emptiedAnnotations, []);

  const deleted = input(family, { kind: 'text.delete', from: at(1), to: at(2) });
  assert.equal(deleted.version, 14);
  assert.equal(deleted.operation.kind, 'text.apply');
  assert.equal(materializePlan(family, deleted), 'ac');
  assert.equal(deleted.operation.operation[5][0], 'delete');
  assert.equal(deleted.after.structuralRevision, 1, 'delete without emptied ranges keeps revision');

  const replaced = input(family, { kind: 'text.replace', text: 'xy', from: at(1), to: at(2) });
  assert.equal(replaced.version, 14);
  assert.equal(replaced.operation.kind, 'text.replace');
  assert.equal(replaced.operation.operations.length, 2);
  assert.equal(replaced.operation.operations[0][5][0], 'delete');
  assert.equal(replaced.operation.operations[1][5][0], 'insert');
  assert.equal(replaced.operation.operations[1][5][2], 'xy');
  assert.equal(materializePlan(family, replaced), 'axyc');
  assert.equal(replaced.after.structuralRevision, 1);
  assert.ok(Array.isArray(replaced.after.frontier));
});

test('delete empties an orphan-policy annotation and bumps structuralRevision', () => {
  const family = familyFromText('abcd');
  const annotation = { id: 'ann1', family: 'comment', empty: 'orphan', protectedTargetIds: [] };
  const ranges = [rangeFor(family, 'ann1', 2, 4)];
  const plan = input(family, { kind: 'text.delete', from: at(2), to: at(4) }, {
    annotations: [annotation],
    ranges,
  });
  assert.equal(plan.version, 14);
  assert.equal(materializePlan(family, plan), 'ab');
  assert.equal(plan.after.structuralRevision, 2, 'emptied range bumps structuralRevision');
  assert.equal(plan.facts.emptiedAnnotations.length, 1);
  assert.equal(plan.facts.emptiedAnnotations[0].annotationId, 'ann1');
  assert.equal(plan.facts.emptiedAnnotations[0].empty, 'orphan');
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.kind, 'orphaned');
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.family, 'comment');
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.savedQuote, 'cd');
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.lastRange, null);
});

test('replace empties a delete-policy annotation like a delete does', () => {
  const family = familyFromText('abcd');
  const annotation = { id: 'ann1', family: 'comment', empty: 'delete', protectedTargetIds: [] };
  // Range endpoints use left affinity so a replace that covers the annotated
  // span can leave start>=end after the delete+insert pair (insert sits after
  // a right-affinity end and would keep the range non-empty).
  const frontier = family.checkpoint.frontier;
  const ranges = [{
    annotationId: 'ann1',
    start: resolveOffsetToEndpoint(family, 1, frontier, 'left'),
    end: resolveOffsetToEndpoint(family, 2, frontier, 'left'),
  }];
  const plan = input(family, {
    kind: 'text.replace',
    text: 'Z',
    from: at(0, 'left'),
    to: at(2, 'left'),
  }, {
    annotations: [annotation],
    ranges,
  });
  assert.equal(plan.operation.kind, 'text.replace');
  assert.equal(plan.operation.operations.length, 2);
  assert.equal(materializePlan(family, plan), 'Zcd');
  assert.equal(plan.after.structuralRevision, 2);
  assert.equal(plan.facts.emptiedAnnotations.length, 1);
  assert.equal(plan.facts.emptiedAnnotations[0].annotationId, 'ann1');
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.kind, 'deleted');
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.savedQuote, null);
});

test('delete shrinks partial ranges and preserves endpoint affinities', () => {
  const family = familyFromText('abcdef');
  const annotation = { id: 'ann1', family: 'code', empty: 'delete', protectedTargetIds: [] };
  const ranges = [{
    annotationId: 'ann1',
    start: resolveOffsetToEndpoint(family, 1, family.checkpoint.frontier, 'right'),
    end: resolveOffsetToEndpoint(family, 5, family.checkpoint.frontier, 'left'),
  }];
  const plan = input(family, { kind: 'text.delete', from: at(2), to: at(4) }, { annotations: [annotation], ranges });
  assert.equal(materializePlan(family, plan), 'abef');
  const after = applyTextOperation(family, plan.operation.operation);
  assert.deepEqual(offsetsOf(after, plan.facts.ranges), [{ annotationId: 'ann1', start: 1, end: 3 }]);
  assert.equal(plan.facts.ranges[0].start.point[2], 'right');
  assert.equal(plan.facts.ranges[0].end.point[2], 'left');
  assert.deepEqual(plan.facts.emptiedAnnotations, []);
});

test('delete that starts before a range and ends inside it shrinks to surviving text', () => {
  const family = familyFromText('abcdefghijklmnopqrstu');
  const annotation = { id: 'ann1', family: 'code', empty: 'delete', protectedTargetIds: [] };
  const ranges = [rangeFor(family, 'ann1', 3, 15)];
  const plan = input(family, { kind: 'text.delete', from: at(0), to: at(10) }, { annotations: [annotation], ranges });
  assert.equal(materializePlan(family, plan), 'klmnopqrstu');
  const after = applyTextOperation(family, plan.operation.operation);
  assert.deepEqual(offsetsOf(after, plan.facts.ranges), [{ annotationId: 'ann1', start: 0, end: 5 }]);
  assert.deepEqual(plan.facts.emptiedAnnotations, []);
});

test('delete that fully covers a range omits it from the postimage and empties it', () => {
  const family = familyFromText('abcdefghijklmnop');
  const annotation = { id: 'ann1', family: 'code', empty: 'delete', protectedTargetIds: [] };
  const ranges = [rangeFor(family, 'ann1', 5, 10)];
  const plan = input(family, { kind: 'text.delete', from: at(3), to: at(15) }, { annotations: [annotation], ranges });
  assert.equal(plan.facts.ranges.length, 0);
  assert.equal(plan.facts.emptiedAnnotations.length, 1);
  assert.equal(plan.facts.emptiedAnnotations[0].annotationId, 'ann1');
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.kind, 'deleted');
});

test('delete that does not empty a covering range leaves emptiedAnnotations empty', () => {
  const family = familyFromText('abcd');
  const annotation = { id: 'ann1', family: 'comment', empty: 'orphan', protectedTargetIds: [] };
  const ranges = [rangeFor(family, 'ann1', 0, 4)];
  const plan = input(family, { kind: 'text.delete', from: at(1), to: at(2) }, {
    annotations: [annotation],
    ranges,
  });
  assert.equal(materializePlan(family, plan), 'acd');
  assert.deepEqual(plan.facts.emptiedAnnotations, []);
  assert.equal(plan.after.structuralRevision, 1);
});

test('removes an annotation and freezes the compact operated result', () => {
  const family = familyFromText('abc');
  const annotation = { id: 'ann1', family: 'comment', empty: 'delete', protectedTargetIds: [] };
  const ranges = [rangeFor(family, 'ann1', 0, 3)];
  const plan = planAnnotationRemove({
    documentId: 'doc1',
    structureVersion: 1,
    family,
    annotationId: 'ann1',
    annotations: [annotation],
    ranges,
  });
  assert.equal(plan.version, 14);
  assert.equal(plan.operation.kind, 'annotation.remove');
  assert.equal(plan.operation.annotationId, 'ann1');
  assert.equal(plan.facts.result.disposition.kind, 'deleted');
  assert.deepEqual(plan.facts.removedAnnotationIds, ['ann1']);
  assert.deepEqual(plan.facts.ranges, []);
  assert.equal(plan.after.structuralRevision, 1);
  assert.equal(plan.facts.family, null);
  assert.ok(Object.isFrozen(plan));
});

test('plans a text-range apply as one document range with no family change', () => {
  const family = familyFromText('A diarized transcript');
  const annotation = { id: 'code1', family: 'code', fields: {} };
  const plan = planTextRangeApply({
    documentId: 'doc1',
    structureVersion: 1,
    family,
    annotation,
    from: at(2),
    to: at(12),
  });
  assert.equal(plan.version, 14);
  assert.equal(plan.operation.kind, 'annotation.apply-range');
  assert.deepEqual(plan.operation.selection, { startOffset: 2, endOffset: 12 });
  assert.equal(plan.operation.annotation.id, 'code1');
  assert.equal(plan.after.structuralRevision, 1, 'revision unchanged');
  assert.deepEqual(plan.after.frontier, family.checkpoint.frontier);
  assert.equal(plan.facts.family, null);
  assert.equal(materializeText(family), 'A diarized transcript');
  assert.equal(plan.facts.ranges.length, 1);
  assert.equal(plan.facts.ranges[0].annotationId, 'code1');
  assert.ok(plan.facts.ranges[0].start.point, 'carries structural start endpoint');
  assert.ok(plan.facts.ranges[0].end.point, 'carries structural end endpoint');
  assert.equal(plan.facts.selectedRange.annotationId, 'code1');
  assert.ok(plan.facts.selectedRange.start.point);
  assert.ok(plan.facts.selectedRange.end.point);
  assert.deepEqual(plan.facts.measurements, []);
});

test('text-range apply replaces an existing range for the same annotation', () => {
  const family = familyFromText('hello world');
  const annotation = { id: 'code1', family: 'code', fields: {} };
  const existing = [rangeFor(family, 'code1', 0, 5), rangeFor(family, 'other', 6, 11)];
  const plan = planTextRangeApply({
    documentId: 'doc1',
    structureVersion: 1,
    family,
    annotation,
    from: at(6),
    to: at(11),
    ranges: existing,
  });
  assert.equal(plan.facts.ranges.length, 2);
  const byId = Object.fromEntries(plan.facts.ranges.map((entry) => [entry.annotationId, entry]));
  assert.ok(byId.code1);
  assert.ok(byId.other);
  assert.equal(plan.operation.selection.startOffset, 6);
  assert.equal(plan.operation.selection.endOffset, 11);
});

// ---------------------------------------------------------------------------
// Exclusive ('one'-cardinality) range-apply semantics. Applying an annotation
// of an exclusive family over a region already covered by another SAME-FAMILY
// annotation atomically removes the overlapped middle and keeps the other
// annotation's non-overlapped left/right remnants, so at most one annotation
// covers any region. Offsets are compared in ABSOLUTE offset space via
// projectEndpointToOffset.
// ---------------------------------------------------------------------------

function offsetsOf(family, ranges) {
  return ranges.map((range) => ({
    annotationId: range.annotationId,
    start: projectEndpointToOffset(family, range.start),
    end: projectEndpointToOffset(family, range.end),
  }));
}

function exclusiveApply(family, ranges, options) {
  return planTextRangeApply({
    documentId: 'doc1',
    structureVersion: 1,
    family,
    ranges,
    actorId: 'u1',
    ...options,
  });
}

test('one-cardinality apply trims an overlapping same-family range into left/right remnants', () => {
  const family = familyFromText('ABCDEFGHIJ');
  const applyB = exclusiveApply(family, [rangeFor(family, 'speaker-a', 2, 8)], {
    annotation: { id: 'speaker-b', family: 'speaker', fields: {} },
    from: at(4),
    to: at(6),
    cardinality: 'one',
    sameFamilyAnnotationIds: new Set(['speaker-a', 'speaker-b']),
  });
  assert.deepEqual(offsetsOf(family, applyB.facts.ranges), [
    { annotationId: 'speaker-a', start: 2, end: 4 },
    { annotationId: 'speaker-a', start: 6, end: 8 },
    { annotationId: 'speaker-b', start: 4, end: 6 },
  ]);
  assert.equal(applyB.facts.selectedRange.annotationId, 'speaker-b');
  assert.equal(applyB.operation.kind, 'annotation.apply-range');
  assert.equal(applyB.facts.actorId, 'u1');
  assert.deepEqual(applyB.facts.measurements, []);
});

test('one-cardinality apply drops a same-family range fully inside the selection', () => {
  const family = familyFromText('ABCDEFGHIJ');
  const applyB = exclusiveApply(family, [rangeFor(family, 'speaker-a', 2, 4)], {
    annotation: { id: 'speaker-b', family: 'speaker', fields: {} },
    from: at(1),
    to: at(9),
    cardinality: 'one',
    sameFamilyAnnotationIds: new Set(['speaker-a', 'speaker-b']),
  });
  assert.deepEqual(offsetsOf(family, applyB.facts.ranges), [
    { annotationId: 'speaker-b', start: 1, end: 9 },
  ]);
});

test('one-cardinality apply splits a fully-covering same-family range into two remnants', () => {
  const family = familyFromText('ABCDEFGHIJ');
  const applyB = exclusiveApply(family, [rangeFor(family, 'speaker-a', 0, 10)], {
    annotation: { id: 'speaker-b', family: 'speaker', fields: {} },
    from: at(4),
    to: at(6),
    cardinality: 'one',
    sameFamilyAnnotationIds: new Set(['speaker-a', 'speaker-b']),
  });
  assert.deepEqual(offsetsOf(family, applyB.facts.ranges), [
    { annotationId: 'speaker-a', start: 0, end: 4 },
    { annotationId: 'speaker-a', start: 6, end: 10 },
    { annotationId: 'speaker-b', start: 4, end: 6 },
  ]);
});

test('one-cardinality apply leaves non-overlapping same-family ranges untouched', () => {
  const family = familyFromText('ABCDEFGHIJ');
  const applyB = exclusiveApply(family, [
    rangeFor(family, 'speaker-a', 0, 2),
    rangeFor(family, 'speaker-c', 7, 9),
  ], {
    annotation: { id: 'speaker-b', family: 'speaker', fields: {} },
    from: at(4),
    to: at(6),
    cardinality: 'one',
    sameFamilyAnnotationIds: new Set(['speaker-a', 'speaker-b', 'speaker-c']),
  });
  assert.deepEqual(offsetsOf(family, applyB.facts.ranges), [
    { annotationId: 'speaker-a', start: 0, end: 2 },
    { annotationId: 'speaker-c', start: 7, end: 9 },
    { annotationId: 'speaker-b', start: 4, end: 6 },
  ]);
});

test('one-cardinality apply still replaces the same annotation id', () => {
  const family = familyFromText('ABCDEFGHIJ');
  const applyB = exclusiveApply(family, [
    rangeFor(family, 'speaker-b', 0, 10),
    rangeFor(family, 'speaker-a', 4, 6),
  ], {
    annotation: { id: 'speaker-b', family: 'speaker', fields: {} },
    from: at(2),
    to: at(3),
    cardinality: 'one',
    sameFamilyAnnotationIds: new Set(['speaker-a', 'speaker-b']),
  });
  // speaker-b's own range is REPLACED by the new selection (same-id replace),
  // while speaker-a's non-overlapping range passes through unchanged.
  assert.deepEqual(offsetsOf(family, applyB.facts.ranges), [
    { annotationId: 'speaker-a', start: 4, end: 6 },
    { annotationId: 'speaker-b', start: 2, end: 3 },
  ]);
});

test('many-cardinality apply preserves overlaps (no exclusivity)', () => {
  const family = familyFromText('ABCDEFGHIJ');
  const applyC = exclusiveApply(family, [
    rangeFor(family, 'code-a', 0, 5),
    rangeFor(family, 'code-b', 3, 8),
  ], {
    annotation: { id: 'code-c', family: 'code', fields: {} },
    from: at(4),
    to: at(6),
  });
  assert.deepEqual(offsetsOf(family, applyC.facts.ranges), [
    { annotationId: 'code-a', start: 0, end: 5 },
    { annotationId: 'code-b', start: 3, end: 8 },
    { annotationId: 'code-c', start: 4, end: 6 },
  ]);
});

test('one-cardinality apply leaves different-family ranges untouched', () => {
  const family = familyFromText('ABCDEFGHIJ');
  const applyB = exclusiveApply(family, [
    rangeFor(family, 'speaker-a', 0, 5),
    rangeFor(family, 'note-x', 2, 8),
  ], {
    annotation: { id: 'speaker-b', family: 'speaker', fields: {} },
    from: at(3),
    to: at(7),
    cardinality: 'one',
    sameFamilyAnnotationIds: new Set(['speaker-a', 'speaker-b']),
  });
  // speaker-a is trimmed; the different-family note-x range is untouched even
  // though it overlaps the selection.
  assert.deepEqual(offsetsOf(family, applyB.facts.ranges), [
    { annotationId: 'speaker-a', start: 0, end: 3 },
    { annotationId: 'note-x', start: 2, end: 8 },
    { annotationId: 'speaker-b', start: 3, end: 7 },
  ]);
});

test('rejects out-of-bounds offsets and empty delete ranges', () => {
  const family = familyFromText('abc');
  assert.throws(
    () => input(family, { kind: 'text.insert', text: 'x', at: at(9) }),
    (error) => error.code === 'position-invalid',
  );
  assert.throws(
    () => input(family, { kind: 'text.delete', from: at(1), to: at(1) }),
    (error) => error.code === 'position-invalid' && /non-empty/.test(error.message),
  );
  assert.throws(
    () => input(family, { kind: 'text.delete', from: at(2), to: at(1) }),
    (error) => error.code === 'position-invalid',
  );
  assert.throws(
    () => input(family, { kind: 'text.replace', text: 'z', from: at(0), to: at(99) }),
    (error) => error.code === 'position-invalid',
  );
});

test('annotation remove requires the annotation to exist', () => {
  const family = familyFromText('abc');
  assert.throws(
    () => planAnnotationRemove({
      documentId: 'doc1',
      structureVersion: 1,
      family,
      annotationId: 'missing',
      annotations: [],
      ranges: [],
    }),
    /annotation not found/,
  );
});

test('text-range apply rejects empty or inverted selections', () => {
  const family = familyFromText('hello world');
  const annotation = { id: 'code1', family: 'code', fields: {} };
  assert.throws(
    () => planTextRangeApply({
      documentId: 'doc1',
      structureVersion: 1,
      family,
      annotation,
      from: at(2),
      to: at(2),
    }),
    (error) => error.code === 'position-invalid' && /forward, non-empty range/.test(error.message),
  );
  assert.throws(
    () => planTextRangeApply({
      documentId: 'doc1',
      structureVersion: 1,
      family,
      annotation,
      from: at(5),
      to: at(2),
    }),
    (error) => error.code === 'position-invalid',
  );
  assert.throws(
    () => planTextRangeApply({
      documentId: 'doc1',
      structureVersion: 1,
      family,
      annotation,
      from: at(0),
      to: at(99),
    }),
    (error) => error.code === 'position-invalid',
  );
});

// ---------------------------------------------------------------------------
// text.replace anchoring (#127). The replacement's insert anchor is derived
// from the PRE-delete family's cached index: deletes only tombstone elements
// fully inside [from, to), so the element owning the from-boundary survives
// untouched and post-delete anchoring would resolve identically. These tests
// pin that equivalence across split and non-split delete shapes.
// ---------------------------------------------------------------------------

test('replace anchored inside a multi-scalar import element (non-split path) lands exactly', () => {
  const family = familyFromText('hello world');
  // The import family is ONE root child carrying 'hello world'; the deleted
  // middle sits strictly inside it, so no element is split away.
  const plan = input(family, { kind: 'text.replace', text: 'X', from: at(3), to: at(8) });
  assert.equal(plan.operation.kind, 'text.replace');
  // 'hello world'.slice(3, 8) === 'lo wo'; the replacement lands exactly there.
  assert.equal(materializePlan(family, plan), 'helXrld');
});

test('replace at the document start anchors the insert at root', () => {
  const family = familyFromText('hello world');
  const plan = input(family, { kind: 'text.replace', text: 'J', from: at(0), to: at(5) });
  assert.equal(plan.operation.operations[1][5][1][0], 'root', 'from=0 inserts as a root child');
  assert.equal(materializePlan(family, plan), 'J world');
});

test('replace ending at the last character keeps the pre-delete boundary owner as its anchor', () => {
  const family = familyFromText('hello world');
  const plan = input(family, { kind: 'text.replace', text: '!?', from: at(6), to: at(11) });
  // The from-boundary (offset 6) is owned by the import element; the whole
  // visible tail dies but the owner survives as its tombstone-free parent.
  assert.equal(plan.operation.operations[1][5][2], '!?');
  assert.equal(materializePlan(family, plan), 'hello !?');
});

test('replace across per-character elements resolves the same anchor before and after the delete', () => {
  // Unique actor per seeded element, mirroring the real per-edit flow.
  const actorFor = (index) => (index + 1).toString(16).padStart(32, '0');
  let family = familyFromText('');
  for (const [index, ch] of [...'abcdefgh'].entries()) {
    family = applyTextOperation(family, textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: index, affinity: 'right' }, text: ch }, actorFor(index), 1));
  }
  assert.equal(materializeText(family), 'abcdefgh');

  // Replace "cde" with new text. The from-boundary is owned by 'b' both before
  // the delete (visible) and after it (untouched by the delete op), so the
  // pre-delete derived index must yield the identical anchor.
  const plan = input(family, { kind: 'text.replace', text: 'XYZ', from: at(2), to: at(5) });
  const [, identity] = plan.operation.operations[1][5][1];
  assert.deepEqual(identity[0], [actorFor(1), 1], 'b owns the insert boundary');
  assert.equal(identity[1], 0);
  assert.equal(materializePlan(family, plan), 'abXYZfgh');
});

test('replace spanning the entire document collapses to a root-anchored insert', () => {
  const family = familyFromText('abcdef');
  const plan = input(family, { kind: 'text.replace', text: 'Q', from: at(0), to: at(6) });
  assert.equal(plan.operation.operations[1][5][1][0], 'root');
  assert.equal(materializePlan(family, plan), 'Q');
});

// ---------------------------------------------------------------------------
// Edited-word overlap detection (Decision 0025 policy 4). A text edit that
// overlaps a range of a family declaring `editOverlap` adjusts the owning
// annotation: removal or a field patch. Offsets resolve against the BEFORE
// family. An insert counts only when strictly interior. A delete/replace
// counts on any positive-width intersection. Fully-covered ranges are
// excluded (they already resolve through emptied dispositions).
// ---------------------------------------------------------------------------

test('edited-word insert interior to a timing range sets approximate=true', () => {
  const family = familyFromText('abc def ghi');
  const annotations = [
    { id: 't1', family: 'timing', empty: 'delete' },
    { id: 'u1', family: 'uncertainty', empty: 'delete' },
  ];
  const ranges = [rangeFor(family, 't1', 4, 7), rangeFor(family, 'u1', 0, 3)];
  const editOverlapByFamily = {
    timing: { kind: 'fields', fields: { approximate: true } },
    uncertainty: { kind: 'remove' },
  };
  const annotationFields = new Map([
    ['t1', { mediaStartMs: 100, mediaEndMs: 200, timingSource: 'original', approximate: false }],
    ['u1', { confidence: 0.5 }],
  ]);
  // Insert at offset 5 (strictly interior to t1's range [4, 7), exterior to u1's [0, 3)).
  const plan = input(family, { kind: 'text.insert', text: 'X', at: at(5) }, {
    annotations, ranges, editOverlapByFamily, annotationFields,
  });
  assert.equal(materializePlan(family, plan), 'abc dXef ghi');
  assert.equal(plan.after.structuralRevision, 1, 'insert alone does not bump revision');
  // t1 is overlapped (interior insert) → field patch to set approximate
  assert.equal(plan.facts.annotationUpdates.length, 1);
  assert.equal(plan.facts.annotationUpdates[0].annotationId, 't1');
  assert.equal(plan.facts.annotationUpdates[0].fields.approximate, true);
  assert.equal(plan.facts.annotationUpdates[0].fields.mediaStartMs, 100, 'other fields preserved');
  // u1 is not overlapped by interior insert (offset 5 is outside [0, 3)) → untouched
  assert.equal(plan.facts.emptiedAnnotations.length, 0);
});

test('edited-word insert at boundary does NOT trigger overlap', () => {
  const family = familyFromText('abc def ghi');
  const annotations = [
    { id: 't1', family: 'timing', empty: 'delete' },
    { id: 't2', family: 'timing', empty: 'delete' },
  ];
  const ranges = [rangeFor(family, 't1', 0, 3), rangeFor(family, 't2', 4, 7)];
  const editOverlapByFamily = { timing: { kind: 'fields', fields: { approximate: true } } };
  const annotationFields = new Map([
    ['t1', { mediaStartMs: 0, mediaEndMs: 100, timingSource: 'original', approximate: false }],
    ['t2', { mediaStartMs: 100, mediaEndMs: 200, timingSource: 'original', approximate: false }],
  ]);
  // Insert at offset 3 — exactly at the boundary between t1 and t2, not interior.
  const plan = input(family, { kind: 'text.insert', text: 'X', at: at(3) }, {
    annotations, ranges, editOverlapByFamily, annotationFields,
  });
  assert.equal(plan.facts.annotationUpdates.length, 0, 'boundary insert does not trigger overlap');
});

test('edited-word delete that partially overlaps timing sets approximate=true; removes uncertainty', () => {
  const family = familyFromText('abc def ghi');
  const annotations = [
    { id: 't1', family: 'timing', empty: 'delete' },
    { id: 'u1', family: 'uncertainty', empty: 'delete' },
  ];
  const ranges = [rangeFor(family, 't1', 4, 7), rangeFor(family, 'u1', 0, 3)];
  const editOverlapByFamily = {
    timing: { kind: 'fields', fields: { approximate: true } },
    uncertainty: { kind: 'remove' },
  };
  const annotationFields = new Map([
    ['t1', { mediaStartMs: 100, mediaEndMs: 200, timingSource: 'original', approximate: false }],
    ['u1', { confidence: 0.5 }],
  ]);
  // Delete from offset 2 to 5: overlaps u1 ([0, 3) ∩ [2, 5) = [2, 3)) and t1 ([4, 7) ∩ [2, 5) = [4, 5))
  const plan = input(family, { kind: 'text.delete', from: at(2), to: at(5) }, {
    annotations, ranges, editOverlapByFamily, annotationFields,
  });
  assert.equal(materializePlan(family, plan), 'abef ghi');
  // t1 is partially overlapped → field patch sets approximate
  assert.ok(plan.facts.annotationUpdates.some((u) => u.annotationId === 't1' && u.fields.approximate === true), 'timing gets approximate=true');
  // u1 is partially overlapped → removed
  assert.ok(plan.facts.emptiedAnnotations.some((e) => e.annotationId === 'u1'), 'uncertainty is emptied');
});

test('edited-word replace that partially overlaps timing sets approximate=true', () => {
  const family = familyFromText('abc def ghi');
  const annotations = [
    { id: 't1', family: 'timing', empty: 'delete' },
  ];
  const ranges = [rangeFor(family, 't1', 4, 7)];
  const editOverlapByFamily = { timing: { kind: 'fields', fields: { approximate: true } } };
  const annotationFields = new Map([
    ['t1', { mediaStartMs: 100, mediaEndMs: 200, timingSource: 'original', approximate: false }],
  ]);
  // Replace from 3 to 6: "abc def ghi" → delete " de" (offset 3-6), insert "XYZ"
  const plan = input(family, { kind: 'text.replace', text: 'XYZ', from: at(3), to: at(6) }, {
    annotations, ranges, editOverlapByFamily, annotationFields,
  });
  assert.equal(materializePlan(family, plan), 'abcXYZf ghi');
  assert.equal(plan.facts.annotationUpdates.length, 1);
  assert.equal(plan.facts.annotationUpdates[0].annotationId, 't1');
  assert.equal(plan.facts.annotationUpdates[0].fields.approximate, true);
});

test('edited-word delete fully covering a range does NOT double-dip (emptied dispositions own it)', () => {
  const family = familyFromText('abc def ghi');
  const annotations = [
    { id: 't1', family: 'timing', empty: 'delete' },
  ];
  const ranges = [rangeFor(family, 't1', 0, 3)];
  const editOverlapByFamily = { timing: { kind: 'fields', fields: { approximate: true } } };
  const annotationFields = new Map([
    ['t1', { mediaStartMs: 0, mediaEndMs: 100, timingSource: 'original', approximate: false }],
  ]);
  // Delete fully covers t1's range [0, 3) → emptied, not overlapped.
  const plan = input(family, { kind: 'text.delete', from: at(0), to: at(5) }, {
    annotations, ranges, editOverlapByFamily, annotationFields,
  });
  assert.equal(plan.facts.emptiedAnnotations.length, 1);
  assert.equal(plan.facts.emptiedAnnotations[0].annotationId, 't1');
  assert.equal(plan.facts.annotationUpdates.length, 0, 'no field patch for fully-covered range');
});

test('edited-word idempotence: second overlap on already-approximate timing skips field update', () => {
  const family = familyFromText('abc def ghi');
  const annotations = [
    { id: 't1', family: 'timing', empty: 'delete' },
  ];
  const ranges = [rangeFor(family, 't1', 4, 7)];
  const editOverlapByFamily = { timing: { kind: 'fields', fields: { approximate: true } } };
  // Already approximate: stored.approximate === true, same as the patch.
  const annotationFields = new Map([
    ['t1', { mediaStartMs: 100, mediaEndMs: 200, timingSource: 'original', approximate: true }],
  ]);
  const plan = input(family, { kind: 'text.insert', text: 'X', at: at(5) }, {
    annotations, ranges, editOverlapByFamily, annotationFields,
  });
  assert.equal(plan.facts.annotationUpdates.length, 0, 'already-approximate timing produces no update');
});

test('edited-word with no overlap behavior declared keeps historical shrinking behavior', () => {
  const family = familyFromText('abc def ghi');
  const annotations = [
    { id: 'c1', family: 'code', empty: 'delete' },
  ];
  const ranges = [rangeFor(family, 'c1', 4, 7)];
  // No editOverlapByFamily entry for 'code' → no overlap behavior.
  const plan = input(family, { kind: 'text.delete', from: at(2), to: at(5) }, {
    annotations, ranges,
    editOverlapByFamily: {}, annotationFields: new Map(),
  });
  assert.equal(plan.facts.annotationUpdates.length, 0, 'no overlap behavior → no annotation update');
  assert.equal(plan.facts.emptiedAnnotations.length, 0, 'partial overlap still shrinks, not emptied');
});

test('edited-word insert that overlaps uncertainty removes it', () => {
  const family = familyFromText('abc def ghi');
  const annotations = [
    { id: 'u1', family: 'uncertainty', empty: 'delete' },
  ];
  const ranges = [rangeFor(family, 'u1', 0, 3)];
  const editOverlapByFamily = { uncertainty: { kind: 'remove' } };
  const annotationFields = new Map();
  // Insert at offset 1 (strictly interior to u1's [0, 3))
  const plan = input(family, { kind: 'text.insert', text: 'X', at: at(1) }, {
    annotations, ranges, editOverlapByFamily, annotationFields,
  });
  assert.equal(plan.facts.emptiedAnnotations.length, 1);
  assert.equal(plan.facts.emptiedAnnotations[0].annotationId, 'u1');
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.kind, 'deleted');
});
