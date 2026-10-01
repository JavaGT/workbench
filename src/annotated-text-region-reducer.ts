// Deterministic region postimage reducer (scope#992 rev 2 Finding 2).
// One pure function used by both planning and replay. The affected closure is
// a complete, sorted image — never a sparse caller-supplied list. Forged
// events cannot choose an interpretation: replay recomputes this reducer and
// requires the event's afterDigest to match before the first side-table write.

import { canonicalEndpointJSON } from './annotated-text-delete-history-shared.ts';
import type { StoredAnnotationImage, StoredMembershipEntry } from './annotated-text-delete-history.ts';
import {
  materializeText,
  projectEndpointToOffset,
  resolveOffsetToEndpoint,
  type ContinuousTextFamily,
} from './annotated-text-continuous.ts';
import type { RegionEditDescriptor, RegionEditTransition } from './annotated-text-region-descriptor.ts';
import {
  REGION_AFFECTED_ANNOTATION_MAX,
  REGION_MEMBERSHIP_MAX,
  REGION_PREREQUISITE_MAX,
  REGION_PROTECTED_EDGE_MAX,
  lengthPrefixedUtf8Digest,
  regionLimitError,
  regionStaleError,
} from './annotated-text-region-limits.ts';

export const REGION_POSTIMAGE_DISAGREES = 'region postimage disagrees with operated event';

export type RegionMembership = StoredMembershipEntry;

export type RegionOrphanImage = Readonly<{
  savedQuote: string;
  lastRange: readonly [number, number] | null;
}>;

export type RegionAnnotationImage = Readonly<{
  id: string;
  family: string;
  fields: Readonly<Record<string, unknown>>;
  protectedTargetIds: readonly string[];
  memberships: readonly RegionMembership[];
  orphan: RegionOrphanImage | null;
  empty: 'delete' | 'orphan';
  cardinality: 'many' | 'one';
  prerequisites: readonly Readonly<{ entity: string; id: string }>[];
}>;

export type RegionDeclaration = Readonly<{
  annotationName: string;
  fields: Readonly<Record<string, unknown>>;
  empty?: string;
  cardinality?: string;
  kind?: string;
  protects?: string | null;
  /** Declared restricted placeholder for protecting families (#148 rev 2). */
  placeholder?: string | null;
  /**
   * Declared authorization-policy handle: the guard-source text of the
   * compiled `access` function (or null for plain annotations). The SOURCE
   * TEXT is the stable identity — a function identity would differ per
   * compile, and any policy change rewrites the source, changing the
   * fingerprint and invalidating old v16 events as required.
   */
  accessPolicySource?: string | null;
}>;

export type RegionPostimage = Readonly<{
  annotations: readonly RegionAnnotationImage[];
  /** Complete sorted before-closure images — the v16 before-side witness. */
  beforeAnnotations: readonly RegionAnnotationImage[];
  affectedIds: readonly string[];
  emptied: ReadonlyArray<Readonly<{
    annotationId: string;
    disposition: Readonly<{
      kind: 'deleted' | 'orphaned';
      family: string;
      savedQuote: string | null;
      lastRange: readonly [number, number] | null;
    }>;
  }>>;
  beforeDigest: string;
  afterDigest: string;
  /** Fingerprint-covered side digests — present when the caller supplies the compiled fingerprint (v16). */
  witnessBeforeDigest?: string;
  witnessAfterDigest?: string;
}>;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as T;
  }
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value) as T;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw regionLimitError('annotation field must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const names = Object.keys(value).sort();
    return `{${names.map((name) => `${JSON.stringify(name)}:${canonicalJson((value as Record<string, unknown>)[name])}`).join(',')}}`;
  }
  throw regionLimitError('annotation field must be JSON-serializable');
}

function annotationDigestFields(image: RegionAnnotationImage): string[] {
  const fields: string[] = [image.id, image.family, image.empty, image.cardinality];
  const names = Object.keys(image.fields).sort();
  fields.push(String(names.length));
  for (const name of names) fields.push(name, canonicalJson(image.fields[name]));
  fields.push(String(image.protectedTargetIds.length), ...image.protectedTargetIds);
  fields.push(String(image.memberships.length));
  for (const membership of image.memberships) {
    fields.push(String(membership.ordinal), canonicalEndpointJSON(membership.start), canonicalEndpointJSON(membership.end));
  }
  fields.push(image.orphan ? 'orphan' : 'none');
  if (image.orphan) {
    fields.push(image.orphan.savedQuote, image.orphan.lastRange === null ? '' : `${image.orphan.lastRange[0]},${image.orphan.lastRange[1]}`);
  }
  fields.push(String(image.prerequisites.length));
  for (const prerequisite of image.prerequisites) fields.push(prerequisite.entity, prerequisite.id);
  return fields;
}

// Nested identity sets are canonicalized here so planner and replay hashes do
// not depend on SQLite row order or caller-provided array order.
function canonicalImage(image: RegionAnnotationImage): RegionAnnotationImage {
  return deepFreeze({
    ...image,
    protectedTargetIds: Object.freeze([...image.protectedTargetIds].sort()),
    prerequisites: Object.freeze([...image.prerequisites].sort((left, right) => (
      left.entity === right.entity
        ? left.id.localeCompare(right.id)
        : left.entity.localeCompare(right.entity)
    ))),
  });
}

export function digestAffectedClosure(annotations: readonly RegionAnnotationImage[], declarationFingerprint?: string): string {
  const sorted = sortAnnotations(annotations.map(canonicalImage));
  const fields: string[] = [String(sorted.length)];
  if (declarationFingerprint !== undefined) {
    // Side digest covers the declaration fingerprint (Finding 4): the witness
    // images are only meaningful under the compiled declarations.
    fields.push(declarationFingerprint);
  }
  for (const image of sorted) fields.push(...annotationDigestFields(image));
  return lengthPrefixedUtf8Digest(fields);
}

export function sortAnnotations<T extends { id: string }>(annotations: readonly T[]): T[] {
  return [...annotations].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function membershipsIntersectRegion(memberships: readonly RegionMembership[], family: ContinuousTextFamily, from: number, to: number): boolean {
  for (const membership of memberships) {
    const start = projectEndpointToOffset(family, membership.start);
    const end = projectEndpointToOffset(family, membership.end);
    if (Math.min(end, to) - Math.max(start, from) > 0) return true;
  }
  return false;
}

/**
 * Complete affected closure: intersecting memberships, explicitly named IDs,
 * and the protecting/protected transitive fixed point. Cycles are retained
 * once each. Result is sorted by annotation ID; memberships stay in ordinal order.
 */
export function computeAffectedClosure({
  annotations,
  family,
  from,
  to,
  namedIds,
}: {
  annotations: readonly RegionAnnotationImage[];
  family: ContinuousTextFamily;
  from: number;
  to: number;
  namedIds: Iterable<string>;
}): RegionAnnotationImage[] {
  const byId = new Map(annotations.map((image) => [image.id, image]));
  const protectorsOf = new Map<string, string[]>();
  for (const image of annotations) {
    for (const targetId of image.protectedTargetIds) {
      const list = protectorsOf.get(targetId) ?? [];
      list.push(image.id);
      protectorsOf.set(targetId, list);
    }
  }
  const seed = new Set<string>(namedIds);
  for (const image of annotations) {
    if (membershipsIntersectRegion(image.memberships, family, from, to)) seed.add(image.id);
  }
  const included = new Set<string>();
  const queue = [...seed];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (included.has(id)) continue;
    included.add(id);
    const image = byId.get(id);
    if (!image) continue;
    for (const targetId of image.protectedTargetIds) {
      if (!included.has(targetId)) queue.push(targetId);
    }
    for (const protectorId of protectorsOf.get(id) ?? []) {
      if (!included.has(protectorId)) queue.push(protectorId);
    }
  }
  return sortAnnotations([...included].flatMap((id) => {
    const image = byId.get(id);
    return image ? [image] : [];
  }));
}

export function assertRegionClosureLimits(annotations: readonly RegionAnnotationImage[]): void {
  if (annotations.length > REGION_AFFECTED_ANNOTATION_MAX) {
    throw regionLimitError(`region.edit affected annotations exceed ${REGION_AFFECTED_ANNOTATION_MAX}`);
  }
  let memberships = 0;
  let edges = 0;
  let prerequisites = 0;
  for (const image of annotations) {
    memberships += image.memberships.length;
    edges += image.protectedTargetIds.length;
    prerequisites += image.prerequisites.length;
  }
  if (memberships > REGION_MEMBERSHIP_MAX) throw regionLimitError(`region.edit memberships exceed ${REGION_MEMBERSHIP_MAX}`);
  if (edges > REGION_PROTECTED_EDGE_MAX) throw regionLimitError(`region.edit protected edges exceed ${REGION_PROTECTED_EDGE_MAX}`);
  if (prerequisites > REGION_PREREQUISITE_MAX) throw regionLimitError(`region.edit prerequisites exceed ${REGION_PREREQUISITE_MAX}`);
}

function declarationOf(declarations: readonly RegionDeclaration[], family: string): RegionDeclaration {
  const declared = declarations.find((entry) => entry.annotationName === family);
  if (!declared) throw new Error(REGION_POSTIMAGE_DISAGREES);
  return declared;
}

// A surviving image must never keep an edge naming a removed annotation: the
// projection's deletion cascade removes both edge directions, so the durable
// postimage has to agree or replay would diverge (and the after-side closure
// would reference a nonexistent target). Pruning happens BEFORE digesting.
function pruneRemovedTargets(images: RegionAnnotationImage[], removedIds: ReadonlySet<string>): RegionAnnotationImage[] {
  return images.map((image) => {
    if (!image.protectedTargetIds.some((targetId) => removedIds.has(targetId))) return image;
    return canonicalImage({
      ...image,
      protectedTargetIds: image.protectedTargetIds.filter((targetId) => !removedIds.has(targetId)),
    });
  });
}

function resolvePostRegionRanges(
  afterFamily: ContinuousTextFamily,
  regionStart: number,
  ranges: readonly Readonly<{ start: number; end: number }>[],
): RegionMembership[] {
  const text = materializeText(afterFamily);
  const memberships: RegionMembership[] = [];
  for (const [ordinal, range] of ranges.entries()) {
    const startOffset = regionStart + range.start;
    const endOffset = regionStart + range.end;
    if (startOffset < 0 || endOffset > text.length || endOffset <= startOffset) {
      throw new Error(REGION_POSTIMAGE_DISAGREES);
    }
    memberships.push(Object.freeze({
      ordinal,
      start: resolveOffsetToEndpoint(afterFamily, startOffset, afterFamily.checkpoint.frontier, 'left'),
      end: resolveOffsetToEndpoint(afterFamily, endOffset, afterFamily.checkpoint.frontier, 'right'),
    }));
  }
  return memberships;
}

function projectRetainedMemberships(
  beforeFamily: ContinuousTextFamily,
  afterFamily: ContinuousTextFamily,
  memberships: readonly RegionMembership[],
): RegionMembership[] {
  const retained: RegionMembership[] = [];
  let ordinal = 0;
  for (const membership of memberships) {
    let start: number;
    let end: number;
    try {
      start = projectEndpointToOffset(afterFamily, membership.start);
      end = projectEndpointToOffset(afterFamily, membership.end);
    } catch {
      continue;
    }
    if (start >= end) continue;
    retained.push(Object.freeze({
      ordinal,
      start: membership.start,
      end: membership.end,
    }));
    ordinal += 1;
    void beforeFamily;
  }
  return retained;
}

/** Trim existing exclusive-family memberships around newly created ranges. */
function trimExclusiveMemberships(
  family: ContinuousTextFamily,
  memberships: readonly RegionMembership[],
  occupied: readonly Readonly<{ start: number; end: number }>[],
): RegionMembership[] {
  const retained: RegionMembership[] = [];
  for (const membership of memberships) {
    let pieces: Array<Readonly<{ start: number; end: number }>> = [];
    try {
      const start = projectEndpointToOffset(family, membership.start);
      const end = projectEndpointToOffset(family, membership.end);
      pieces = [{ start, end }];
    } catch {
      continue;
    }
    for (const range of occupied) {
      pieces = pieces.flatMap((piece) => [
        ...(piece.start < range.start ? [{ start: piece.start, end: Math.min(piece.end, range.start) }] : []),
        ...(piece.end > range.end ? [{ start: Math.max(piece.start, range.end), end: piece.end }] : []),
      ].filter((piece) => piece.end > piece.start));
    }
    for (const piece of pieces) {
      retained.push({
        ordinal: retained.length,
        start: resolveOffsetToEndpoint(family, piece.start, family.checkpoint.frontier, 'left'),
        end: resolveOffsetToEndpoint(family, piece.end, family.checkpoint.frontier, 'right'),
      });
    }
  }
  return retained;
}

function cloneImage(image: RegionAnnotationImage, memberships: readonly RegionMembership[], orphan: RegionOrphanImage | null = image.orphan): RegionAnnotationImage {
  return deepFreeze({
    ...image,
    memberships: Object.freeze([...memberships]),
    orphan,
  });
}

/**
 * Deterministic postimage of the affected closure. Callers supply the complete
 * before-closure (not a sparse list) and the already-applied afterFamily.
 */
export function reduceRegionPostimage({
  beforeFamily,
  afterFamily,
  beforeAnnotations,
  region,
  transitions,
  declarations,
  expectedBeforeDigest,
  declarationFingerprint,
}: {
  beforeFamily: ContinuousTextFamily;
  afterFamily: ContinuousTextFamily;
  beforeAnnotations: readonly RegionAnnotationImage[];
  region: Readonly<{ from: number; to: number }>;
  transitions: readonly RegionEditTransition[];
  declarations: readonly RegionDeclaration[];
  expectedBeforeDigest?: string;
  /** When provided, both side digests cover the declaration fingerprint. */
  declarationFingerprint?: string;
}): RegionPostimage {
  const before = sortAnnotations(beforeAnnotations.map(canonicalImage));
  assertRegionClosureLimits(before);
  // The v10 descriptor contract compares the plain closure digest; the
  // declaration-fingerprint-covered digest is a separate WITNESS digest
  // carried alongside it (Finding 4).
  const beforeDigest = digestAffectedClosure(before);
  if (expectedBeforeDigest !== undefined && expectedBeforeDigest !== beforeDigest) {
    throw regionStaleError('affected closure digest does not match the live document');
  }
  const witnessBeforeDigest = declarationFingerprint === undefined
    ? undefined
    : digestAffectedClosure(before, declarationFingerprint);

  const byId = new Map(before.map((image) => [image.id, image]));
  const named = new Map<string, RegionEditTransition>();
  for (const transition of transitions) {
    const id = transition.kind === 'create' ? transition.annotation.id : transition.annotationId;
    if (transition.kind !== 'create' && !byId.has(id)) throw new Error(REGION_POSTIMAGE_DISAGREES);
    named.set(id, transition);
  }

  const next = new Map<string, RegionAnnotationImage>();
  const emptied: RegionPostimage['emptied'][number][] = [];
  const exclusiveCreatedRanges = transitions.flatMap((transition) => {
    if (transition.kind !== 'create') return [];
    const declared = declarationOf(declarations, transition.annotation.family);
    if ((declared.cardinality ?? 'many') !== 'one') return [];
    return transition.ranges.map((range) => ({ start: region.from + range.start, end: region.from + range.end, family: transition.annotation.family }));
  });

  for (const transition of transitions) {
    if (transition.kind !== 'remove') continue;
    const existing = byId.get(transition.annotationId);
    if (!existing) throw new Error(REGION_POSTIMAGE_DISAGREES);
    emptied.push(Object.freeze({
      annotationId: existing.id,
      disposition: Object.freeze({
        kind: 'deleted' as const,
        family: existing.family,
        savedQuote: null,
        lastRange: null,
      }),
    }));
  }

  for (const image of before) {
    const transition = named.get(image.id);
    if (transition?.kind === 'remove') continue;
    if (transition?.kind === 'range.set') {
      const declared = declarationOf(declarations, image.family);
      if ((declared.cardinality ?? 'many') !== 'many') throw new Error(REGION_POSTIMAGE_DISAGREES);
      next.set(image.id, cloneImage(image, resolvePostRegionRanges(afterFamily, region.from, transition.ranges)));
      continue;
    }
    if (transition?.kind === 'create') throw new Error(REGION_POSTIMAGE_DISAGREES);
    const retained = projectRetainedMemberships(beforeFamily, afterFamily, image.memberships);
    const exclusiveRanges = exclusiveCreatedRanges
      .filter((range) => range.family === image.family)
      .map(({ start, end }) => ({ start, end }));
    const exclusiveRetained = image.cardinality === 'one' && exclusiveRanges.length > 0
      ? trimExclusiveMemberships(afterFamily, retained, exclusiveRanges)
      : retained;
    if (exclusiveRetained.length > 0) {
      next.set(image.id, cloneImage(image, exclusiveRetained));
      continue;
    }
    const declared = declarationOf(declarations, image.family);
    const empty = declared.empty === 'orphan' ? 'orphan' : 'delete';
    if (empty === 'orphan') {
      // Complete-membership orphan witness (Finding 6): the saved quote spans
      // the FULL pre-edit extent of every membership in ordinal order (not
      // just the first), and lastRange records the LAST membership's resolved
      // pre-edit offsets. Snapshot projection coerces a null lastRange to
      // [0,0], so recording the real range preserves exact historical state.
      const quote = materializeText(beforeFamily);
      let savedQuote = '';
      let lastRange: readonly [number, number] | null = null;
      try {
        let quoteStart = -1;
        let quoteEnd = -1;
        for (const membership of image.memberships) {
          const start = projectEndpointToOffset(beforeFamily, membership.start);
          const end = projectEndpointToOffset(beforeFamily, membership.end);
          if (end > start) {
            if (quoteStart < 0 || start < quoteStart) quoteStart = start;
            if (end > quoteEnd) quoteEnd = end;
            lastRange = [start, end];
          }
        }
        if (quoteStart >= 0 && quoteEnd > quoteStart) {
          savedQuote = quote.slice(quoteStart, quoteEnd);
        }
      } catch {
        savedQuote = '';
        lastRange = null;
      }
      next.set(image.id, cloneImage(image, [], { savedQuote, lastRange }));
      emptied.push(Object.freeze({
        annotationId: image.id,
        disposition: Object.freeze({
          kind: 'orphaned' as const,
          family: image.family,
          savedQuote,
          lastRange,
        }),
      }));
    } else {
      emptied.push(Object.freeze({
        annotationId: image.id,
        disposition: Object.freeze({
          kind: 'deleted' as const,
          family: image.family,
          savedQuote: null,
          lastRange: null,
        }),
      }));
    }
  }

  for (const transition of transitions) {
    if (transition.kind !== 'create') continue;
    if (byId.has(transition.annotation.id) || next.has(transition.annotation.id)) {
      throw new Error(REGION_POSTIMAGE_DISAGREES);
    }
    const declared = declarationOf(declarations, transition.annotation.family);
    const cardinality = (declared.cardinality ?? 'many') === 'one' ? 'one' : 'many';
    const declaredNames = Object.keys(declared.fields).sort();
    const suppliedNames = Object.keys(transition.annotation.fields).sort();
    if (declaredNames.join('\0') !== suppliedNames.join('\0')) throw new Error(REGION_POSTIMAGE_DISAGREES);
    next.set(transition.annotation.id, canonicalImage({
      id: transition.annotation.id,
      family: transition.annotation.family,
      fields: transition.annotation.fields,
      protectedTargetIds: transition.annotation.protectedTargetIds,
      memberships: resolvePostRegionRanges(afterFamily, region.from, transition.ranges),
      orphan: null,
      empty: declared.empty === 'orphan' ? 'orphan' : 'delete',
       cardinality,
      prerequisites: Object.freeze([]),
    }));
  }

  const annotations = sortAnnotations([...next.values()]);
  assertRegionClosureLimits(annotations);
  const removedIds = new Set(
    emptied.filter((entry) => entry.disposition.kind === 'deleted').map((entry) => entry.annotationId),
  );
  return deepFreeze({
    annotations: pruneRemovedTargets(annotations, removedIds),
    beforeAnnotations: before,
    affectedIds: Object.freeze(before.map((image) => image.id)),
    emptied: Object.freeze(emptied),
    beforeDigest,
    afterDigest: digestAffectedClosure(pruneRemovedTargets([...annotations], removedIds)),
    // Fingerprint-covered witness digests (Finding 4) — present only when the
    // caller supplies the compiled declaration fingerprint.
    ...(declarationFingerprint === undefined ? {} : {
      witnessBeforeDigest,
      witnessAfterDigest: digestAffectedClosure(pruneRemovedTargets([...annotations], removedIds), declarationFingerprint),
    }),
  });
}

/** Lift a storage-loaded delete-history image into the region-closure shape. */
export function regionImageFromStored(
  image: StoredAnnotationImage & { empty?: string; cardinality?: string; orphan?: RegionOrphanImage | null },
  declaration?: RegionDeclaration,
): RegionAnnotationImage {
  return canonicalImage({
    id: image.id,
    family: image.family,
    fields: image.fields,
    protectedTargetIds: image.protectedTargetIds,
    memberships: image.memberships,
    orphan: image.orphan ?? null,
    empty: (declaration?.empty ?? image.empty) === 'orphan' ? 'orphan' : 'delete',
    cardinality: (declaration?.cardinality ?? image.cardinality) === 'one' ? 'one' : 'many',
    prerequisites: image.prerequisites,
  });
}

export function namedTransitionIds(descriptor: RegionEditDescriptor): string[] {
  return descriptor.transitions.map((transition) => (
    transition.kind === 'create' ? transition.annotation.id : transition.annotationId
  ));
}

// ---- V16 complete bounded witness (#148 rev 2 "Witness completeness") ----
// One completeness predicate for planning AND replay. `assertCompleteRegionWitness`
// is the sole gate between a computed postimage and a v16 event; it proves both
// sides complete, bounded, and reducer-derived before any bytes are written.

const REGION_V16_DECLARATION_FINGERPRINT_VERSION = 1;

// Field descriptors contain executable framework helpers (`can`, `validate`)
// and may point at an entity object. Fingerprints cover their declaration
// contract, not those per-compile objects or runtime-only callbacks.
function declarationFieldShape(value: unknown, stack = new Set<object>()): unknown {
  if (value === undefined) return null;
  if (typeof value === 'function') return `function:${Function.prototype.toString.call(value)}`;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => declarationFieldShape(entry, stack));
  const record = value as Record<string, unknown>;
  if (typeof record.name === 'string' && record.fields && typeof record.fields === 'object') {
    return { name: record.name };
  }
  if (stack.has(record)) throw regionLimitError('region.edit declaration contains a cycle');
  stack.add(record);
  const shaped: Record<string, unknown> = {};
  for (const name of Object.keys(record).sort()) {
    if (name === 'access' || name === 'can') continue;
    shaped[name] = declarationFieldShape(record[name], stack);
  }
  stack.delete(record);
  return shaped;
}

/**
 * SHA-256 over canonical family names, declared fields/types, empty/cardinality
 * policy, protecting relation, placeholder declaration, and the named
 * authorization-policy handle. Replay requires the currently compiled value.
 */
export function regionDeclarationFingerprint(declarations: readonly RegionDeclaration[]): string {
  const sorted = [...declarations].sort((left, right) => left.annotationName.localeCompare(right.annotationName));
  const fields = [REGION_V16_DECLARATION_FINGERPRINT_VERSION === 1 ? 'v1' : 'v?', String(sorted.length)];
  for (const declaration of sorted) {
    const names = Object.keys(declaration.fields ?? {}).sort();
    // Fail closed: a protecting declaration without its placeholder or
    // authorization-policy identity cannot be fingerprinted — the v16
    // witness contract requires both (#148 rev 2).
    const isProtecting = typeof declaration.protects === 'string' || (declaration.kind === 'protectingAnnotation');
    const placeholder = declaration.placeholder ?? null;
    const policy = declaration.accessPolicySource ?? null;
    if (isProtecting && (placeholder === null || policy === null)) {
      throw regionLimitError('region.edit protecting declaration is missing its placeholder or authorization-policy handle');
    }
    fields.push(
      declaration.annotationName,
      String(names.length),
      ...names.flatMap((name) => [name, canonicalJson(declarationFieldShape((declaration.fields ?? {})[name]))]),
      (declaration.empty === 'orphan' ? 'orphan' : 'delete'),
      ((declaration as { cardinality?: string }).cardinality === 'one' ? 'one' : 'many'),
      (typeof declaration.protects === 'string' ? declaration.protects : ''),
      placeholder ?? '',
      policy ?? '',
    );
  }
  return lengthPrefixedUtf8Digest(fields);
}

function assertWitnessImage(image: RegionAnnotationImage): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(image.id) || image.id.length > 256 || !image.id) {
    throw regionLimitError('region.edit witness annotation id must be 1-256 ASCII letters/digits/-/_');
  }
  if (!Array.isArray(image.memberships)) throw new Error(REGION_POSTIMAGE_DISAGREES);
  for (const membership of image.memberships) {
    try {
      canonicalEndpointJSON(membership.start);
      canonicalEndpointJSON(membership.end);
    } catch {
      throw new Error(REGION_POSTIMAGE_DISAGREES);
    }
  }
}

function assertWitnessSide(images: readonly RegionAnnotationImage[], label: string): void {
  assertRegionClosureLimits(images);
  let previous = '';
  for (const image of images) {
    assertWitnessImage(image);
    if (!(previous < image.id)) {
      throw regionLimitError(`region.edit ${label} closure must be sorted and unique`);
    }
    previous = image.id;
  }
}

/**
 * The one completeness predicate. Given the planner/reducer-computed postimage
 * plus the live pre-image annotations, prove:
 * - before side equals the complete affected closure of the pre-image;
 * - after side equals the fresh reducer-derived postimage closure;
 * - created/removed IDs explain the set difference exactly;
 * - every edge resolves inside its own side's ID set (no dangling targets).
 * Throws ValidationError (`annotated-text-region-limit`) on overflow and
 * `region witness disagrees with operated event` on incompleteness.
 */
export function assertCompleteRegionWitness({
  postimage,
  liveAnnotations,
  family,
  from,
  to,
  namedIds,
}: {
  postimage: RegionPostimage;
  liveAnnotations: readonly RegionAnnotationImage[];
  family: ContinuousTextFamily;
  from: number;
  to: number;
  namedIds: readonly string[];
}): void {
  assertWitnessSide(postimage.beforeAnnotations, 'before');
  assertWitnessSide(postimage.annotations, 'after');

  const expectedBefore = computeAffectedClosure({
    annotations: liveAnnotations.map(canonicalImage),
    family,
    from,
    to,
    namedIds,
  });
  // digestAffectedClosure sorts and hashes every canonical field, so digest
  // equality here IS exact before-closure equality (content and order).
  if (digestAffectedClosure(expectedBefore) !== postimage.beforeDigest
    || JSON.stringify(postimage.beforeAnnotations.map((image) => image.id))
      !== JSON.stringify(postimage.affectedIds)) {
    throw new Error('region witness disagrees with operated event');
  }

  const beforeIds = new Set(postimage.beforeAnnotations.map((image) => image.id));
  const afterById = new Map(postimage.annotations.map((image) => [image.id, image]));
  for (const id of postimage.affectedIds) {
    if (!beforeIds.has(id)) throw new Error('region witness disagrees with operated event');
  }
  // Orphan-policy empties keep a (membership-free) image in the after side;
  // only 'deleted' dispositions must vanish from it entirely.
  for (const emptied of postimage.emptied) {
    if (!beforeIds.has(emptied.annotationId)) {
      throw new Error('region witness disagrees with operated event');
    }
    if (emptied.disposition.kind === 'deleted' && afterById.has(emptied.annotationId)) {
      throw new Error('region witness disagrees with operated event');
    }
    if (emptied.disposition.kind === 'orphaned') {
      const afterImage = afterById.get(emptied.annotationId);
      if (!afterImage || afterImage.memberships.length !== 0
        || afterImage.orphan === null
        || afterImage.orphan.savedQuote !== emptied.disposition.savedQuote) {
        throw new Error('region witness disagrees with operated event');
      }
    }
  }
  for (const image of postimage.beforeAnnotations) {
    if (!afterById.has(image.id) && !postimage.emptied.some((entry) => entry.annotationId === image.id)) {
      throw new Error('region witness disagrees with operated event');
    }
  }
  for (const targetId of postimage.annotations.flatMap((image) => image.protectedTargetIds)) {
    if (!afterById.has(targetId)) {
      throw new Error('region witness disagrees with operated event');
    }
  }
}
