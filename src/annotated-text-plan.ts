// Pure commit planning for annotated-text operations (issue #33 blockless).
//
// One continuous RGA text per document; annotations are document-scoped
// character ranges. Positions are ABSOLUTE UTF-16 offsets (the authoring
// position frame resolves to an absolute offset — there are no blocks).
//
// This planner does not write DB, mint authoring frames, or fold client ops.
// One write authority stays the entity commit handler.
//
// Emitter note (W1 #143 MAJOR 3): the functions here drive the LIVE authoring
// path — ordinary text typing and annotation add/remove on an open document.
// They emit v14 events via constructV14OperatedEvent. This is NOT dormant
// dead code and is NOT a region emitter: the region path is v15-only
// (planRegionEdit + constructV15RegionEvent) and cannot reach these functions.
// The design's "only v15 after the flip" instruction is scoped to the W3
// history-engine flip; live authoring deliberately stays v14 until then
// (see workbench#143 / scope#992 rev 1 Finding 1). check-annotated-text-
// single-authority.mjs enforces that no region module lowers to v13/v14.

import {
  applyTextOperation,
  insertAnchorForOffset,
  materializeText,
  resolveOffsetToEndpoint,
  textFamilyCheckpoint,
  textOperationForOffsetEdit,
  projectEndpointToOffset,
} from './annotated-text-continuous.ts';
import { canonicalTextOp } from './annotated-text.ts';
import { constructV14OperatedEvent } from './annotated-text-operated-event.ts';
import type { ContinuousTextFamily } from './annotated-text-continuous.ts';
import type { StructuralEndpoint } from './annotated-text-family.ts';
import type { Frontier } from './annotated-text.ts';

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) { value.forEach(deepFreeze); return Object.freeze(value) as T; }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  return Object.freeze(value) as T;
}

interface PlanBefore {
  structuralRevision: number;
  frontier: Frontier;
}

interface TextPlan {
  version: 14;
  id: string;
  before: PlanBefore;
  after: { structuralRevision: number; frontier: Frontier };
  operation: any;
  facts: any;
}

interface Annotation {
  id: string;
  family: string;
  empty: 'delete' | 'orphan';
  cardinality?: 'many' | 'one';
  fields?: Record<string, unknown>;
  protectedTargetIds?: readonly string[];
}

/** Declared edited-word behavior per family (Decision 0025 policy 4). */
export type EditOverlapBehavior =
  | { kind: 'remove' }
  | { kind: 'fields'; fields: Record<string, unknown> };

interface AnnotationRange {
  annotationId: string;
  start: StructuralEndpoint;
  end: StructuralEndpoint;
}

type OffsetEdit =
  | { kind: 'text.insert'; at: { offset: number; affinity: 'left' | 'right' }; text: string }
  | { kind: 'text.delete'; from: { offset: number }; to: { offset: number } }
  | { kind: 'text.replace'; text: string; from: { offset: number; affinity: 'left' | 'right' }; to: { offset: number } };

interface EmptiedAnnotation {
  annotationId: string;
  empty: 'delete' | 'orphan';
  disposition: {
    kind: 'orphaned' | 'deleted';
    family: string;
    savedQuote: string | null;
    lastRange: number[] | null;
  };
}

function before(family: ContinuousTextFamily, structuralRevision: number): PlanBefore {
  return Object.freeze({ structuralRevision, frontier: family.checkpoint.frontier });
}

function unifiedPlan(data: Record<string, any>): TextPlan {
  return deepFreeze(constructV14OperatedEvent({
    id: data.id,
    before: data.before,
    after: data.after,
    operation: data.operation,
    annotation: data.annotation,
    annotationUpdates: data.annotationUpdates,
    ranges: data.ranges,
    measurements: data.measurements,
    lifecycle: data.lifecycle,
    result: data.result,
    emptiedAnnotations: data.emptiedAnnotations,
    actorId: data.actorId,
    selectedRange: data.selectedRange,
    removedAnnotationIds: data.removedAnnotationIds,
  })) as TextPlan;
}

function assertForwardOffset(text: string, fromOffset: number, toOffset: number) {
  if (!Number.isSafeInteger(fromOffset) || !Number.isSafeInteger(toOffset) || fromOffset < 0 || toOffset < fromOffset || toOffset > text.length) {
    const error = new Error('selection must be a forward, in-bounds range') as Error & { code: string };
    error.code = 'position-invalid';
    throw error;
  }
}

/**
 * Calculate the range postimage for a deletion. A range which loses only part
 * of its visible text is clamped to the surviving characters in after-edit
 * coordinates. Fully-covered ranges are omitted (emptiedRanges owns dispose).
 * Affinities are copied onto the re-resolved endpoints so a later insertion
 * at the new boundary still hugs the same side the original endpoint declared.
 */
function rangesAfterDelete({ beforeFamily, afterFamily, ranges, from, to }: {
  beforeFamily: ContinuousTextFamily;
  afterFamily: ContinuousTextFamily;
  ranges: AnnotationRange[];
  from: number;
  to: number;
}): AnnotationRange[] {
  return ranges.flatMap((range) => {
    const start = projectEndpointToOffset(beforeFamily, range.start);
    const end = projectEndpointToOffset(beforeFamily, range.end);
    if (start >= end || end <= from || start >= to) return [range];

    const deletedStart = Math.max(start, from);
    const deletedEnd = Math.min(end, to);
    const surviving = (end - start) - (deletedEnd - deletedStart);
    const newStart = Math.min(start, from);
    const newEnd = newStart + surviving;
    if (newEnd <= newStart) return [];

    const startAffinity = range.start.point[2];
    const endAffinity = range.end.point[2];
    return [{
      annotationId: range.annotationId,
      start: resolveOffsetToEndpoint(afterFamily, newStart, afterFamily.checkpoint.frontier, startAffinity),
      end: resolveOffsetToEndpoint(afterFamily, newEnd, afterFamily.checkpoint.frontier, endAffinity),
    }];
  });
}

/** A range becomes empty when its visible width drops to zero after an edit. */
function emptiedRanges({ beforeFamily, afterFamily, ranges, annotations, structureVersion }: {
  beforeFamily: ContinuousTextFamily;
  afterFamily: ContinuousTextFamily;
  ranges: AnnotationRange[];
  annotations: Annotation[];
  structureVersion: number;
}): EmptiedAnnotation[] {
  const emptied: EmptiedAnnotation[] = [];
  for (const range of ranges) {
    if (projectEndpointToOffset(afterFamily, range.start) < projectEndpointToOffset(afterFamily, range.end)) continue;
    const annotation = annotations.find((candidate) => candidate.id === range.annotationId);
    if (!annotation) continue;
    emptied.push({
      annotationId: range.annotationId,
      empty: annotation.empty,
      disposition: annotation.empty === 'orphan'
        ? { kind: 'orphaned', family: annotation.family, savedQuote: materializeRangeBetween(beforeFamily, range), lastRange: null }
        : { kind: 'deleted', family: annotation.family, savedQuote: null, lastRange: null },
    });
  }
  void structureVersion;
  return emptied;
}

function materializeRangeBetween(family: ContinuousTextFamily, range: AnnotationRange): string {
  let text = '';
  const startPos = projectEndpointToOffset(family, range.start);
  const endPos = projectEndpointToOffset(family, range.end);
  const full = materializeText(family);
  if (startPos >= endPos) return text;
  return full.slice(startPos, endPos);
}

/**
 * Edited-word overlap detection (Decision 0025 policy 4). A text edit that
 * touches a range of a family declaring `editOverlap` adjusts the owning
 * annotation: removal, or a field patch. Offsets resolve against the BEFORE
 * family — the edit's own coordinates.
 *
 * An insert counts only when strictly interior (`start < at < end`): typing
 * exactly at a word boundary must not clear the neighbors' evidence. A
 * delete/replace counts on any positive-width intersection with [from, to).
 * Fully-covered ranges are excluded — they already resolve through the
 * ordinary emptied dispositions, never twice.
 */
export function findEditOverlapIds({ family, annotations, ranges, edit, editOverlapByFamily }: {
  family: ContinuousTextFamily;
  annotations: Annotation[];
  ranges: AnnotationRange[];
  edit: OffsetEdit;
  editOverlapByFamily: Record<string, EditOverlapBehavior>;
}): { removeIds: string[]; approximateIds: string[] } {
  const familyById = new Map(annotations.map((annotation) => [annotation.id, annotation.family]));
  const removeIds = new Set<string>();
  const approximateIds = new Set<string>();
  const isInsert = edit.kind === 'text.insert';
  const at = isInsert ? (edit as { at: { offset: number } }).at.offset : 0;
  const from = !isInsert ? (edit as { from: { offset: number } }).from.offset : 0;
  const to = !isInsert ? (edit as { to: { offset: number } }).to.offset : 0;
  for (const range of ranges) {
    const start = projectEndpointToOffset(family, range.start);
    const end = projectEndpointToOffset(family, range.end);
    if (start >= end) continue;
    const familyName = familyById.get(range.annotationId);
    if (!familyName) continue;
    const behavior = editOverlapByFamily[familyName];
    if (!behavior) continue;
    if (isInsert) {
      if (!(start < at && at < end)) continue;
    } else {
      if (!(start < to && from < end)) continue;
      // Fully covered: the emptied dispositions own this annotation.
      if (start >= from && end <= to) continue;
    }
    if (behavior.kind === 'remove') removeIds.add(range.annotationId);
    else approximateIds.add(range.annotationId);
  }
  return {
    removeIds: [...removeIds].sort(),
    approximateIds: [...approximateIds].sort(),
  };
}

/** Deleted-disposition entry for an overlap removal (ordinary emptied shape). */
function overlapRemovalDisposition({ annotations, annotationId, family }: {
  annotations: Annotation[];
  annotationId: string;
  family: ContinuousTextFamily;
}): EmptiedAnnotation {
  const annotation = annotations.find((candidate) => candidate.id === annotationId);
  if (!annotation) throw new Error(`overlap removal target '${annotationId}' is not a known annotation`);
  void family;
  return {
    annotationId,
    empty: annotation.empty,
    disposition: { kind: 'deleted', family: annotation.family, savedQuote: null, lastRange: null },
  };
}

/**
 * Field-patch facts for overlapped `{ fields }` families. Ids already gone
 * (emptied or removed) are skipped — there is nothing to patch. An id whose
 * stored fields already carry every patch value is skipped too, so a second
 * keystroke in an already-approximated word plans no update. A missing stored
 * record fails closed: the admit layer must supply fields for every id the
 * detector names.
 */
function overlapUpdateFacts({ adjustments, annotations, annotationFields, editOverlapByFamily, documentId }: {
  adjustments: { removeIds: string[]; approximateIds: string[] };
  annotations: Annotation[];
  annotationFields: ReadonlyMap<string, Record<string, unknown>>;
  editOverlapByFamily: Record<string, EditOverlapBehavior>;
  documentId: string;
}): Array<{ annotationId: string; fields: Record<string, unknown> }> {
  void documentId;
  const gone = new Set(adjustments.removeIds);
  const familyById = new Map(annotations.map((annotation) => [annotation.id, annotation.family]));
  const facts: Array<{ annotationId: string; fields: Record<string, unknown> }> = [];
  for (const annotationId of adjustments.approximateIds) {
    if (gone.has(annotationId)) continue;
    const familyName = familyById.get(annotationId);
    const behavior = (familyName && editOverlapByFamily[familyName]) || null;
    if (!behavior || behavior.kind !== 'fields') continue;
    const stored = annotationFields.get(annotationId);
    if (!stored) throw new Error(`overlap field patch target '${annotationId}' has no stored fields`);
    const merged = { ...stored, ...behavior.fields };
    let changed = false;
    for (const key of Object.keys(behavior.fields)) {
      if (JSON.stringify((merged as Record<string, unknown>)[key]) !== JSON.stringify(stored[key])) { changed = true; break; }
    }
    if (!changed) continue;
    facts.push({ annotationId, fields: deepFreeze({ ...merged }) });
  }
  return facts;
}

function copyRanges(ranges: AnnotationRange[]): AnnotationRange[] {
  return ranges.map((entry) => ({
    annotationId: entry.annotationId,
    start: entry.start,
    end: entry.end,
  }));
}

/**
 * Plan a document-wide text insert/delete/replace. The edit names ABSOLUTE
 * offsets; the operation applies to the whole continuous family.
 *
 * `editOverlapByFamily` carries the declared edited-word behaviors (Decision
 * 0025 policy 4): families whose overlapped annotations are removed or field-
 * patched by the edit. `annotationFields` holds the stored field records for
 * families with a `{ fields }` behavior so patches merge over current values;
 * an id missing from the map fails closed. Overlaps already emptied by the
 * edit resolve through the ordinary emptied dispositions, never twice.
 */
export function planTextOffsetEdit({ documentId, structureVersion, family, actor, lamport, edit, annotations = [], ranges = [], editOverlapByFamily = {}, annotationFields = new Map() }: {
  documentId: string;
  structureVersion: number;
  family: ContinuousTextFamily;
  actor: string;
  lamport: number;
  edit: OffsetEdit;
  annotations?: Annotation[];
  ranges?: AnnotationRange[];
  editOverlapByFamily?: Record<string, EditOverlapBehavior>;
  annotationFields?: ReadonlyMap<string, Record<string, unknown>>;
}): TextPlan {
  const text = materializeText(family);
  if (edit.kind === 'text.insert') {
    assertForwardOffset(text, edit.at.offset, edit.at.offset);
    const operation = textOperationForOffsetEdit(family, { kind: 'text.insert', at: edit.at, text: edit.text }, actor, lamport);
    const nextFamily = applyTextOperation(family, operation);
    const adjustments = findEditOverlapIds({ family, annotations, ranges, edit, editOverlapByFamily });
    const updateFacts = overlapUpdateFacts({ adjustments, annotations, annotationFields, editOverlapByFamily, documentId });
    const emptied = adjustments.removeIds.map((annotationId) => overlapRemovalDisposition({ annotations, annotationId, family }));
    const removed = new Set(emptied.map((entry) => entry.annotationId));
    const nextRanges = ranges.filter((entry) => !removed.has(entry.annotationId));
    return unifiedPlan({
      id: documentId,
      before: before(family, structureVersion),
      operation: { kind: 'text.apply', operation },
      after: Object.freeze({ structuralRevision: structureVersion + (emptied.length ? 1 : 0), frontier: nextFamily.checkpoint.frontier }),
      family: textFamilyCheckpoint(nextFamily),
      emptiedAnnotations: Object.freeze(emptied),
      annotationUpdates: Object.freeze(updateFacts),
      ranges: Object.freeze(copyRanges(nextRanges).map((entry) => deepFreeze(entry))),
    });
  }
  if (edit.kind === 'text.delete' || edit.kind === 'text.replace') {
    assertForwardOffset(text, edit.from.offset, edit.to.offset);
    if (edit.from.offset === edit.to.offset) {
      const error = new Error('delete range must be non-empty') as Error & { code: string };
      error.code = 'position-invalid';
      throw error;
    }
    if (edit.kind === 'text.replace') {
      const deleteOperation = textOperationForOffsetEdit(family, { kind: 'text.delete', from: edit.from, to: edit.to }, `${actor.slice(0, 30)}d0`, lamport);
      const intermediate = applyTextOperation(family, deleteOperation);
      // The replacement's insert anchors at the deleted range's start offset;
      // affinity never repositions the insertion point. Deletes tombstone only
      // elements FULLY inside [from, to), so the element owning that boundary
      // survives untouched and the pre-delete anchor IS the post-delete anchor
      // — resolve it from the pre-delete family's cached index instead of
      // materializing the intermediate text just to walk it again. The empty
      // result collapses to the root anchor exactly when from === 0 (a valid
      // delete leaves every element before `from` visible).
      const anchor = edit.from.offset === 0
        ? ['root']
        : insertAnchorForOffset(family, edit.from.offset);
      let insertOperation: unknown = ['workbench.text', 1, [`${actor.slice(0, 30)}e0`, 1], lamport + 1, intermediate.checkpoint.frontier, ['insert', anchor, edit.text]];
      insertOperation = canonicalTextOp(insertOperation);
      const nextFamily = applyTextOperation(intermediate, insertOperation);
      const nextRanges = rangesAfterDelete({ beforeFamily: family, afterFamily: nextFamily, ranges, from: edit.from.offset, to: edit.to.offset });
      // A replacement can empty an annotation range exactly like a delete does;
      // the emptied-annotation dispositions must be planned and applied.
      const emptied = emptiedRanges({ beforeFamily: family, afterFamily: nextFamily, ranges, annotations, structureVersion });
      const emptiedIds = new Set(emptied.map((entry) => entry.annotationId));
      const adjustments = findEditOverlapIds({ family, annotations, ranges, edit, editOverlapByFamily });
      for (const annotationId of adjustments.removeIds) {
        if (emptiedIds.has(annotationId)) continue;
        emptied.push(overlapRemovalDisposition({ annotations, annotationId, family }));
        emptiedIds.add(annotationId);
      }
      const updateFacts = overlapUpdateFacts({ adjustments, annotations, annotationFields, editOverlapByFamily, documentId })
        .filter((fact) => !emptiedIds.has(fact.annotationId));
      return unifiedPlan({
        id: documentId,
        before: before(family, structureVersion),
        operation: { kind: 'text.replace', operations: [deleteOperation, insertOperation] },
        after: Object.freeze({ structuralRevision: structureVersion + (emptied.length ? 1 : 0), frontier: nextFamily.checkpoint.frontier }),
        family: textFamilyCheckpoint(nextFamily),
        ranges: Object.freeze(nextRanges.map((entry) => deepFreeze({ annotationId: entry.annotationId, start: entry.start, end: entry.end }))),
        emptiedAnnotations: Object.freeze(emptied),
        annotationUpdates: Object.freeze(updateFacts),
      });
    }
    const operation = textOperationForOffsetEdit(family, { kind: 'text.delete', from: edit.from, to: edit.to }, actor, lamport);
    const nextFamily = applyTextOperation(family, operation);
    const nextRanges = rangesAfterDelete({ beforeFamily: family, afterFamily: nextFamily, ranges, from: edit.from.offset, to: edit.to.offset });
    const emptied = emptiedRanges({ beforeFamily: family, afterFamily: nextFamily, ranges, annotations, structureVersion });
    const emptiedIds = new Set(emptied.map((entry) => entry.annotationId));
    const adjustments = findEditOverlapIds({ family, annotations, ranges, edit, editOverlapByFamily });
    for (const annotationId of adjustments.removeIds) {
      if (emptiedIds.has(annotationId)) continue;
      emptied.push(overlapRemovalDisposition({ annotations, annotationId, family }));
      emptiedIds.add(annotationId);
    }
    const updateFacts = overlapUpdateFacts({ adjustments, annotations, annotationFields, editOverlapByFamily, documentId })
      .filter((fact) => !emptiedIds.has(fact.annotationId));
    return unifiedPlan({
      id: documentId,
      before: before(family, structureVersion),
      operation: { kind: 'text.apply', operation },
      after: Object.freeze({ structuralRevision: structureVersion + (emptied.length ? 1 : 0), frontier: nextFamily.checkpoint.frontier }),
      family: textFamilyCheckpoint(nextFamily),
      ranges: Object.freeze(nextRanges.map((entry) => deepFreeze({ annotationId: entry.annotationId, start: entry.start, end: entry.end }))),
      emptiedAnnotations: Object.freeze(emptied),
      annotationUpdates: Object.freeze(updateFacts),
    });
  }
  const error = new Error(`unsupported edit kind: ${(edit as any).kind}`) as Error & { code: string };
  error.code = 'position-invalid';
  throw error;
}

/** Plan a document-range annotation.apply: one contiguous range, no blocks. */
export function planTextRangeApply({ documentId, structureVersion, family, annotation, from, to, ranges = [], actorId, cardinality = 'many', sameFamilyAnnotationIds = null }: {
  documentId: string;
  structureVersion: number;
  family: ContinuousTextFamily;
  annotation: Annotation;
  from: { offset: number; affinity: 'left' | 'right' };
  to: { offset: number; affinity: 'left' | 'right' };
  ranges?: AnnotationRange[];
  actorId: string;
  cardinality?: 'many' | 'one';
  sameFamilyAnnotationIds?: Set<string> | null;
}): TextPlan {
  const text = materializeText(family);
  const startOffset = from.offset;
  const endOffset = to.offset;
  assertForwardOffset(text, startOffset, endOffset);
  if (startOffset === endOffset) {
    const error = new Error('annotation selection must be a forward, non-empty range') as Error & { code: string };
    error.code = 'position-invalid';
    throw error;
  }
  const start = resolveOffsetToEndpoint(family, startOffset, family.checkpoint.frontier, from.affinity);
  const end = resolveOffsetToEndpoint(family, endOffset, family.checkpoint.frontier, to.affinity);
  const range: AnnotationRange = { annotationId: annotation.id, start, end };
  // Same-id replace keeps the applied annotation at exactly one range. When the
  // family is exclusive ('one' cardinality), every OTHER same-family range that
  // overlaps the selection is trimmed in OFFSET space: its overlapped middle is
  // dropped and its non-overlapped left/right remnants are kept, so at most one
  // annotation covers any region. Different-family ranges pass through.
  const nextRanges: AnnotationRange[] = [];
  for (const entry of ranges) {
    if (entry.annotationId === annotation.id) continue;
    if (cardinality === 'one' && sameFamilyAnnotationIds?.has(entry.annotationId)) {
      const existingStart = projectEndpointToOffset(family, entry.start);
      const existingEnd = projectEndpointToOffset(family, entry.end);
      if (existingEnd > startOffset && existingStart < endOffset) {
        if (existingStart < startOffset) {
          nextRanges.push({
            annotationId: entry.annotationId,
            start: entry.start,
            end: resolveOffsetToEndpoint(family, startOffset, family.checkpoint.frontier, 'left'),
          });
        }
        if (existingEnd > endOffset) {
          nextRanges.push({
            annotationId: entry.annotationId,
            start: resolveOffsetToEndpoint(family, endOffset, family.checkpoint.frontier, 'right'),
            end: entry.end,
          });
        }
        continue;
      }
    }
    nextRanges.push(entry);
  }
  nextRanges.push(range);
  return unifiedPlan({
    id: documentId,
    before: before(family, structureVersion),
    after: Object.freeze({ structuralRevision: structureVersion, frontier: family.checkpoint.frontier }),
    operation: { kind: 'annotation.apply-range', annotation, selection: { startOffset, endOffset } },
    family: textFamilyCheckpoint(family),
    annotation,
    ranges: Object.freeze(nextRanges.map((entry) => deepFreeze({ annotationId: entry.annotationId, start: entry.start, end: entry.end }))),
    actorId,
    selectedRange: Object.freeze({ annotationId: annotation.id, start, end }),
    measurements: [],
  });
}

/** Plan a document-range annotation.remove. */
export function planAnnotationRemove({ documentId, structureVersion, family, annotationId, annotations, ranges }: {
  documentId: string;
  structureVersion: number;
  family: ContinuousTextFamily;
  annotationId: string;
  annotations: Annotation[];
  ranges: AnnotationRange[];
}): TextPlan {
  const target = annotations.find((annotation) => annotation.id === annotationId);
  if (!target) throw new Error('annotation not found');
  const retained = ranges.filter((entry) => entry.annotationId !== annotationId);
  return unifiedPlan({
    id: documentId,
    before: before(family, structureVersion),
    operation: { kind: 'annotation.remove', annotationId },
    after: Object.freeze({ structuralRevision: structureVersion, frontier: family.checkpoint.frontier }),
    family: textFamilyCheckpoint(family),
    lifecycle: { empty: target.empty },
    result: { memberships: { annotationId, postimage: [] }, disposition: { kind: 'deleted', family: target.family, savedQuote: null, lastRange: null }, changedProtectors: [] },
    ranges: Object.freeze(retained.map((entry) => deepFreeze({ annotationId: entry.annotationId, start: entry.start, end: entry.end }))),
    removedAnnotationIds: Object.freeze([annotationId]),
  });
}

/**
 * Plan the semantic atomic annotation.update (#174): new fields (and optionally
 * a moved range) on an EXISTING annotation, committed as ONE history step.
 *
 * Range unchanged → every existing endpoint object passes through VERBATIM, so
 * the stored basis anchors (decision 0023) survive untouched. Range changed →
 * mirrors planTextRangeApply: offsets resolve on the current frontier and an
 * exclusive 'one'-cardinality family trims overlapped same-family ranges.
 */
export function planAnnotationUpdate({ documentId, structureVersion, family, target, fields, annotations, ranges, actorId, cardinality = 'many', sameFamilyAnnotationIds = null, selection = null }: {
  documentId: string;
  structureVersion: number;
  family: ContinuousTextFamily;
  /** The stored annotation being updated ({ id, family, empty }); identity is immutable. */
  target: Annotation & { fields?: Record<string, unknown>; protectedTargetIds?: readonly string[] };
  /** The complete new field record (every declared field). */
  fields: Record<string, unknown>;
  annotations: Annotation[];
  ranges: AnnotationRange[];
  actorId: string;
  cardinality?: 'many' | 'one';
  sameFamilyAnnotationIds?: Set<string> | null;
  selection?: { startOffset: number; startAffinity: 'left' | 'right'; endOffset: number; endAffinity: 'left' | 'right' } | null;
}): TextPlan {
  const existing = annotations.find((annotation) => annotation.id === target.id);
  if (!existing || existing.family !== target.family) throw new Error('annotation not found');
  const updatedAnnotation = { ...target, fields };
  let nextRanges: AnnotationRange[];
  if (selection === null) {
    // Fields-only: the membership postimage is exactly the current relation;
    // endpoint objects pass through byte-identical.
    nextRanges = ranges;
  } else {
    const text = materializeText(family);
    assertForwardOffset(text, selection.startOffset, selection.endOffset);
    if (selection.startOffset === selection.endOffset) {
      const error = new Error('annotation selection must be a forward, non-empty range') as Error & { code: string };
      error.code = 'position-invalid';
      throw error;
    }
    const start = resolveOffsetToEndpoint(family, selection.startOffset, family.checkpoint.frontier, selection.startAffinity);
    const end = resolveOffsetToEndpoint(family, selection.endOffset, family.checkpoint.frontier, selection.endAffinity);
    nextRanges = [];
    for (const entry of ranges) {
      if (entry.annotationId === target.id) continue;
      if (cardinality === 'one' && sameFamilyAnnotationIds?.has(entry.annotationId)) {
        const existingStart = projectEndpointToOffset(family, entry.start);
        const existingEnd = projectEndpointToOffset(family, entry.end);
        if (existingEnd > selection.startOffset && existingStart < selection.endOffset) {
          if (existingStart < selection.startOffset) {
            nextRanges.push({
              annotationId: entry.annotationId,
              start: entry.start,
              end: resolveOffsetToEndpoint(family, selection.startOffset, family.checkpoint.frontier, 'left'),
            });
          }
          if (existingEnd > selection.endOffset) {
            nextRanges.push({
              annotationId: entry.annotationId,
              start: resolveOffsetToEndpoint(family, selection.endOffset, family.checkpoint.frontier, 'right'),
              end: entry.end,
            });
          }
          continue;
        }
      }
      nextRanges.push(entry);
    }
    nextRanges.push({ annotationId: target.id, start, end });
  }
  return unifiedPlan({
    id: documentId,
    before: before(family, structureVersion),
    after: Object.freeze({ structuralRevision: structureVersion, frontier: family.checkpoint.frontier }),
    operation: {
      kind: 'annotation.update',
      annotation: updatedAnnotation,
      selection: selection === null ? null : Object.freeze({ startOffset: selection.startOffset, endOffset: selection.endOffset }),
    },
    family: textFamilyCheckpoint(family),
    annotation: updatedAnnotation,
    ranges: Object.freeze(nextRanges.map((entry) => deepFreeze({ annotationId: entry.annotationId, start: entry.start, end: entry.end }))),
    actorId,
    measurements: [],
  });
}

export function planAnnotationApplyOffsets(): never {
  const error = new Error('planAnnotationApplyOffsets is block-era; use planTextRangeApply') as Error & { code: string };
  error.code = 'position-invalid';
  throw error;
}
