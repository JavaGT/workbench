// Annotation-aware paste planner: one text event carrying the pasted run plus
// the freshly minted annotation anchored to the inserted scalars.
//
// NOTE (convergence): this function was authored alongside the edited-word
// overlap work as `planAnnotationPaste` in `src/annotated-text-plan.ts`, but
// that definition was never committed — only its build output and the
// `src/annotated-text-admit.ts` import were, so every server-side import of
// the workbench root threw SyntaxError. This module is the committed canonical
// home, depending only on committed planner exports. When the in-flight
// `annotated-text-plan.ts` remainder lands it must re-export from here and
// drop its twin (plus the `annotationsAfterDispositions` / `annotationPostimage`
// helpers) instead of keeping two planners.

import {
  applyTextOperation,
  type ContinuousTextFamily,
} from './annotated-text-continuous.ts';
import { constructV14OperatedEvent } from './annotated-text-operated-event.ts';
import { planTextOffsetEdit, planTextRangeApply, type EditOverlapBehavior } from './annotated-text-plan.ts';
import type { AnnotationRange } from './annotated-text-ranges.ts';

interface PasteAnnotation {
  id: string;
  family: string;
  empty: 'delete' | 'orphan';
  cardinality?: 'many' | 'one';
  fields?: Record<string, unknown>;
  protectedTargetIds?: readonly string[];
  orphan?: { savedQuote: string; lastRange: number[] | null } | null;
}

interface PasteEmptied {
  annotationId: string;
  empty: 'delete' | 'orphan';
  disposition: {
    kind: 'deleted' | 'orphaned';
    family: string;
    savedQuote: string | null;
    lastRange: number[] | null;
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value) as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  return Object.freeze(value) as T;
}

function unifiedPlan(data: Record<string, any>): ReturnType<typeof planTextOffsetEdit> {
  return deepFreeze(
    constructV14OperatedEvent({
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
    }),
  ) as ReturnType<typeof planTextOffsetEdit>;
}

function annotationsAfterDispositions(
  annotations: PasteAnnotation[],
  emptied: PasteEmptied[],
  updates: Array<{ annotationId: string; fields: Record<string, unknown> }>,
): PasteAnnotation[] {
  const deletedIds = new Set(emptied.filter((entry) => entry.disposition.kind === 'deleted').map((entry) => entry.annotationId));
  const orphanedById = new Map(emptied.filter((entry) => entry.disposition.kind === 'orphaned').map((entry) => [entry.annotationId, entry.disposition]));
  const updatedById = new Map(updates.map((entry) => [entry.annotationId, entry.fields]));
  return annotations
    .filter((annotation) => !deletedIds.has(annotation.id))
    .map((annotation) => ({
      ...annotation,
      ...(updatedById.has(annotation.id) ? { fields: updatedById.get(annotation.id) } : {}),
      ...(orphanedById.has(annotation.id)
        ? {
            orphan: {
              savedQuote: orphanedById.get(annotation.id)!.savedQuote ?? '',
              lastRange: orphanedById.get(annotation.id)!.lastRange,
            },
          }
        : {}),
    }));
}

function annotationPostimage({ annotations, ranges }: { annotations: PasteAnnotation[]; ranges: AnnotationRange[] }): Record<string, unknown>[] {
  const ordinalByAnnotation = new Map<string, number>();
  // The companion id list is canonicalized by id. Keep the image list in the
  // same order so projection can prove the two witnesses byte-for-byte,
  // including when paste appends a freshly minted id after an older image.
  return [...annotations]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((annotation) => {
      const memberships = ranges
        .filter((range) => range.annotationId === annotation.id)
        .map((range) => {
          const ordinal = ordinalByAnnotation.get(annotation.id) ?? 0;
          ordinalByAnnotation.set(annotation.id, ordinal + 1);
          return { ordinal, start: range.start, end: range.end };
        });
      return {
        id: annotation.id,
        family: annotation.family,
        fields: { ...(annotation.fields ?? {}) },
        protectedTargetIds: [...(annotation.protectedTargetIds ?? [])].sort(),
        memberships,
        empty: annotation.empty,
        cardinality: annotation.cardinality ?? 'many',
        orphan: annotation.orphan ?? null,
      };
    });
}

/**
 * Plan an annotation-aware paste as one text event. The copied annotation is
 * deliberately supplied with a caller-minted fresh id by admission; this
 * planner only anchors that new identity to the inserted scalars. Existing
 * overlap policy effects are inherited from the ordinary insert planner, so a
 * paste cannot create a second text-edit authority.
 */
export function planAnnotationPaste({
  documentId,
  structureVersion,
  family,
  actor,
  lamport,
  text,
  at,
  annotation,
  annotations = [],
  ranges = [],
  editOverlapByFamily = {},
  annotationFields = new Map(),
  actorId,
}: {
  documentId: string;
  structureVersion: number;
  family: ContinuousTextFamily;
  actor: string;
  lamport: number;
  text: string;
  at: { offset: number; affinity: 'left' | 'right' };
  annotation: PasteAnnotation;
  annotations?: PasteAnnotation[];
  ranges?: AnnotationRange[];
  editOverlapByFamily?: Record<string, EditOverlapBehavior>;
  annotationFields?: ReadonlyMap<string, Record<string, unknown>>;
  actorId: string;
}): ReturnType<typeof planTextOffsetEdit> {
  const base = planTextOffsetEdit({
    documentId,
    structureVersion,
    family,
    actor,
    lamport,
    edit: { kind: 'text.insert', at, text },
    annotations,
    ranges,
    editOverlapByFamily,
    annotationFields,
  });
  const operation = base.operation as { kind: 'text.apply'; operation: unknown };
  const afterFamily = applyTextOperation(family, operation.operation);
  const emptied = base.facts.emptiedAnnotations as PasteEmptied[];
  const updates = base.facts.annotationUpdates as Array<{ annotationId: string; fields: Record<string, unknown> }>;
  const surviving = annotationsAfterDispositions(annotations, emptied, updates);
  const postimageAnnotations = [...surviving, annotation];
  const applied = planTextRangeApply({
    documentId,
    structureVersion: base.after.structuralRevision,
    family: afterFamily,
    annotation,
    from: { offset: at.offset, affinity: 'right' },
    to: { offset: at.offset + text.length, affinity: 'left' },
    ranges: base.facts.ranges as AnnotationRange[],
    actorId,
    cardinality: annotation.cardinality ?? 'many',
    sameFamilyAnnotationIds: new Set(surviving.filter((candidate) => candidate.family === annotation.family).map((candidate) => candidate.id)),
  });
  const postimageRanges = applied.facts.ranges as AnnotationRange[];
  return unifiedPlan({
    id: base.id,
    before: base.before,
    after: base.after,
    operation: base.operation,
    family: base.facts.family,
    annotation,
    actorId,
    selectedRange: applied.facts.selectedRange,
    emptiedAnnotations: emptied,
    annotationUpdates: updates,
    ranges: Object.freeze(postimageRanges.map((entry) => deepFreeze({ annotationId: entry.annotationId, start: entry.start, end: entry.end }))),
    result: {
      kind: 'text-edit-postimage',
      from: at.offset,
      to: at.offset,
      annotationIds: postimageAnnotations.map((candidate) => candidate.id).sort(),
      annotations: annotationPostimage({ annotations: postimageAnnotations, ranges: postimageRanges }),
      createdAnnotationId: annotation.id,
    },
  });
}
