// Blockless annotation ranges (issue #33 step 3).
//
// An annotation is a character range on the continuous family:
//   { annotationId, start, end }
// where start/end are structural endpoints with historical basis (they survive
// edits via the dominating-frontier projection). The annotation's shape
// (id, family, empty policy, protectedTargetIds) is reused from the block-era
// membership module — it was already block-free.
//
// The protection semantics preserved from the recipient projection:
// a protector (e.g. `confidential`) is ACTIVE only where its range intersects a
// protected target's range; when denied it redacts its own range (inline) or,
// when the range is unprojectable / whole-document, fails closed to whole
// document restriction.

import {
  materializeRange,
  projectEndpointToOffset,
  compareStructuralEndpoints,
  textFamilyVisibleLength,
} from './annotated-text-continuous.ts';
import type { ContinuousTextFamily } from './annotated-text-continuous.ts';
import type { StructuralEndpoint } from './annotated-text-family.ts';

function fail(message: string): never {
  throw new Error(`annotated-text ranges: ${message}`);
}

/** A blockless annotation record (the block-free shape reused from the block era). */
export interface Annotation {
  id: string;
  family: string;
  empty: 'delete' | 'orphan';
  protectedTargetIds?: readonly string[];
}

/** Validate and freeze an annotation record. */
export function assertAnnotation(annotation: any): Annotation {
  if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) fail('annotation must be a non-array object');
  const allowedKeys = ['id', 'family', 'empty', 'protectedTargetIds'];
  for (const key of Object.keys(annotation)) {
    if (!allowedKeys.includes(key)) fail(`unknown annotation key: ${key}`);
  }
  if (typeof annotation.id !== 'string' || annotation.id.length === 0) fail('annotation id must be a non-empty string');
  if (typeof annotation.family !== 'string' || annotation.family.length === 0) fail('annotation family must be a non-empty string');
  if (annotation.empty !== 'delete' && annotation.empty !== 'orphan') fail('annotation empty must be delete or orphan');
  if (annotation.protectedTargetIds !== undefined) {
    if (!Array.isArray(annotation.protectedTargetIds)) fail('protectedTargetIds must be an array');
    for (const id of annotation.protectedTargetIds) {
      if (typeof id !== 'string' || id.length === 0) fail('protectedTargetIds must contain non-empty strings');
    }
    const sorted = [...annotation.protectedTargetIds].sort();
    const unique = sorted.filter((id, i) => i === 0 || id !== sorted[i - 1]);
    if (JSON.stringify(annotation.protectedTargetIds) !== JSON.stringify(unique)) fail('protectedTargetIds must be sorted and unique');
  }
  return deepFreeze({
    id: annotation.id,
    family: annotation.family,
    empty: annotation.empty,
    protectedTargetIds: annotation.protectedTargetIds !== undefined
      ? Object.freeze([...annotation.protectedTargetIds])
      : undefined,
  });
}

export interface AnnotationRange {
  annotationId: string;
  start: StructuralEndpoint;
  end: StructuralEndpoint;
}

/**
 * Validate a character range over a continuous family. Endpoints must be
 * dominated by the current frontier; start must not be after end (zero-width
 * ranges are allowed and handled by the empty policy).
 */
export function assertAnnotationRange(family: ContinuousTextFamily, range: unknown, label = 'annotation range'): AnnotationRange {
  if (!range || typeof range !== 'object' || Array.isArray(range)) fail(`${label}: must be a non-array object`);
  const raw = range as Record<string, any>;
  const allowedKeys = ['annotationId', 'start', 'end'];
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.includes(key)) fail(`${label}: unknown key '${key}'`);
  }
  if (typeof raw.annotationId !== 'string' || raw.annotationId.length === 0) {
    fail(`${label}: annotationId must be a non-empty string`);
  }
  if (!raw.start || !raw.end) fail(`${label}: start and end endpoints are required`);
  if (compareStructuralEndpoints(family, raw.start, raw.end) > 0) {
    fail(`${label}: start must not be after end`);
  }
  return deepFreeze({ annotationId: raw.annotationId, start: raw.start, end: raw.end });
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value) as T;
}

/** Project a range to absolute offsets in the current document. */
export function projectRangeToOffsets(family: ContinuousTextFamily, range: AnnotationRange): { start: number; end: number } {
  assertAnnotationRange(family, range);
  return deepFreeze({
    start: projectEndpointToOffset(family, range.start),
    end: projectEndpointToOffset(family, range.end),
  });
}

/** The visible text covered by a range. */
export function rangeText(family: ContinuousTextFamily, range: AnnotationRange): string {
  assertAnnotationRange(family, range);
  return materializeRange(family, range.start, range.end);
}

/** The visible UTF-16 width of a range. */
export function rangeWidth(family: ContinuousTextFamily, range: AnnotationRange): number {
  return rangeText(family, range).length;
}

/** A range that has lost all visible width needs its empty policy run. */
export function rangeIsEmpty(family: ContinuousTextFamily, range: AnnotationRange): boolean {
  return rangeWidth(family, range) === 0;
}

/** True when an absolute document offset falls inside the range. */
export function rangeContainsOffset(family: ContinuousTextFamily, range: AnnotationRange, offset: number): boolean {
  const { start, end } = projectRangeToOffsets(family, range);
  return offset >= start && offset < end;
}

/** Two ranges overlap (used for protector activation). */
export function rangesIntersect(family: ContinuousTextFamily, left: AnnotationRange, right: AnnotationRange): boolean {
  const a = projectRangeToOffsets(family, left);
  const b = projectRangeToOffsets(family, right);
  return a.start < b.end && b.start < a.end;
}

/**
 * Decide what happens to a range that became empty, per its annotation's
 * declared policy. `'delete'` removes the annotation; `'orphan'` keeps a
 * zero-width marker so a later insertion can re-open it.
 */
export function emptyPolicy(annotation: any): 'delete' | 'orphan' {
  assertAnnotation(annotation);
  return annotation.empty === 'orphan' ? 'orphan' : 'delete';
}

/**
 * A protector range is active only where it intersects one of its protected
 * targets' ranges. Whole-document (start/end at the doc root and end) counts as
 * covering everything.
 */
export function protectorIsActive(family: ContinuousTextFamily, protectorRange: AnnotationRange, targetRanges: AnnotationRange[]): boolean {
  assertAnnotationRange(family, protectorRange);
  const { start: pStart, end: pEnd } = projectRangeToOffsets(family, protectorRange);
  const wholeDocument = pStart === 0 && pEnd === textFamilyVisibleLength(family);
  for (const target of targetRanges) {
    assertAnnotationRange(family, target);
    const { start: tStart, end: tEnd } = projectRangeToOffsets(family, target);
    if (wholeDocument || (pStart < tEnd && tStart < pEnd)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Redaction geometry: the ONE authority for denied-interval activation, merge,
// and canonical↔wire offset mapping. Both the recipient projection (which
// renders redactions) and the snapshot visibility evaluator (which binds
// authoring position frames) import these helpers, so a protector that hides a
// span and the coordinate table describing that span cannot drift apart.
// Everything here is pure and works on absolute canonical [start, end) offsets.
// ---------------------------------------------------------------------------

/** An absolute canonical [start, end) offset interval. */
export interface OffsetInterval {
  start: number;
  end: number;
}

/** The canonical interval plus the wire position of its zero-width marker. */
export interface CanonicalWireInterval extends OffsetInterval {
  visibleStart: number;
}

/** True when any interval in `left` overlaps any interval in `right`. */
export function offsetIntervalsIntersect(left: readonly OffsetInterval[], right: readonly OffsetInterval[]): boolean {
  return left.some((own) => right.some((target) => own.start < target.end && target.start < own.end));
}

/** True when a protector's interval collection covers the whole document. */
export function coversWholeDocument(intervals: readonly OffsetInterval[], textLength: number): boolean {
  return intervals.some((interval) => interval.start === 0 && interval.end === textLength);
}

/**
 * Sort denied intervals by start (longest first at an equal start) and merge
 * overlaps into a disjoint, canonical-order list. Extra fields carried by the
 * first interval of each run (for example a placeholder) survive the merge.
 * The input array is sorted in place, matching the historical projection.
 */
export function sortAndMergeIntervals<T extends OffsetInterval>(intervals: T[]): T[] {
  intervals.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: T[] = [];
  for (const interval of intervals) {
    const prior = merged.at(-1);
    if (prior && interval.start <= prior.end) {
      prior.end = Math.max(prior.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/**
 * Map merged canonical intervals to recipient-visible coordinates: the marker's
 * wire `visibleStart` is its canonical start minus the hidden width of every
 * interval before it. This is the single forward half of the canonical↔wire
 * coordinate table used by both redaction rendering and authoring frames.
 */
export function canonicalToWireIntervals(merged: readonly OffsetInterval[]): CanonicalWireInterval[] {
  let hidden = 0;
  return merged.map((interval) => {
    const mapped: CanonicalWireInterval = Object.freeze({
      start: interval.start,
      end: interval.end,
      visibleStart: interval.start - hidden,
    });
    hidden += interval.end - interval.start;
    return mapped;
  });
}
