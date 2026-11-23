// Sole durable operated-envelope grammar (scope#992 W1 / Finding 1).
// normalizeOperatedEvent is the only version gate. Reducers consume the
// canonical form and do not branch on a wire version for kind dispatch.
// Envelope construction lives only in this module.

import { createHash } from 'node:crypto';
import type { RegionEditTransition } from './annotated-text-region-descriptor.ts';
import type { RegionPlan, RegionTextOperations } from './annotated-text-region-plan.ts';
import type { RegionAnnotationImage, RegionOrphanImage, RegionPostimage } from './annotated-text-region-reducer.ts';
// TS7 (tsgo 7.0.2) mis-narrows `readonly Readonly<...>` element types on this
// union's create arm to `never`, so the annotation payload is spelled out.
type V15CreateAnnotationPayload = Readonly<{
  id: string;
  family: string;
  fields: Readonly<Record<string, unknown>>;
  protectedTargetIds: readonly string[];
}>;
import {
  REGION_AFFECTED_ANNOTATION_MAX,
  REGION_DESCRIPTOR_MAX_UTF8_BYTES,
  REGION_MEMBERSHIP_MAX,
  REGION_PREREQUISITE_MAX,
  REGION_PROTECTED_EDGE_MAX,
  REGION_REPLACEMENT_MAX_UTF8_BYTES,
  REGION_TRANSITION_MAX,
  REGION_V16_MAX_DEPTH,
  REGION_V16_MAX_EVENT_BYTES,
  REGION_V16_MAX_STRING_BYTES,
  SHA256_HEX,
  regionLimitError,
  utf8ByteLength,
} from './annotated-text-region-limits.ts';

export const OPERATED_FACT_KEYS = [
  'actorId',
  'annotation',
  'annotationUpdates',
  'emptiedAnnotations',
  'family',
  'lifecycle',
  'measurements',
  'ranges',
  'removedAnnotationIds',
  'result',
  'selectedRange',
] as const;

export const OPERATED_ENVELOPE_KEYS = ['after', 'before', 'facts', 'id', 'operation', 'version'] as const;

const V15_PROOF_KEYS = ['affectedIds', 'afterDigest', 'beforeDigest'] as const;

export type FamilyProof =
  | Readonly<{ kind: 'checkpoint'; checkpoint: unknown }>
  | Readonly<{ kind: 'derive-and-check-frontier' }>;

export type OperatedFacts = Readonly<{
  actorId: string | null;
  annotation: Record<string, unknown> | null;
  annotationUpdates: readonly unknown[];
  emptiedAnnotations: readonly unknown[];
  family: unknown;
  lifecycle: unknown;
  measurements: readonly unknown[];
  ranges: readonly unknown[];
  removedAnnotationIds: readonly unknown[];
  result: unknown;
  selectedRange: Record<string, unknown> | null;
}>;

export type TextRevision = Readonly<{
  structuralRevision: number;
  frontier: unknown[];
}>;

export type CanonicalTextApply = Readonly<{
  kind: 'text.apply';
  id: string;
  before: TextRevision;
  after: TextRevision;
  operation: unknown[];
  facts: OperatedFacts;
  familyProof: FamilyProof;
  wireVersion: 13 | 14;
}>;

export type CanonicalTextReplace = Readonly<{
  kind: 'text.replace';
  id: string;
  before: TextRevision;
  after: TextRevision;
  operations: readonly unknown[];
  facts: OperatedFacts;
  familyProof: FamilyProof;
  wireVersion: 13 | 14;
}>;

export type CanonicalAnnotationApplyRange = Readonly<{
  kind: 'annotation.apply-range';
  id: string;
  before: TextRevision;
  after: TextRevision;
  annotation: unknown;
  selection: unknown;
  facts: OperatedFacts;
  familyProof: FamilyProof;
  wireVersion: 13 | 14;
}>;

export type CanonicalAnnotationRemove = Readonly<{
  kind: 'annotation.remove';
  id: string;
  before: TextRevision;
  after: TextRevision;
  annotationId: string;
  facts: OperatedFacts;
  familyProof: FamilyProof;
  wireVersion: 13 | 14;
}>;

// Semantic atomic annotation update (#174): fields (and optionally the range)
// of an EXISTING annotation as one history step. `selection` is null when the
// range is unchanged; `annotation` carries the complete post-image.
// `historyAuthored` marks undo/redo compensations, which restore verbatim
// captured images (historical endpoint bases) rather than planner offsets.
export type CanonicalAnnotationUpdate = Readonly<{
  kind: 'annotation.update';
  id: string;
  before: TextRevision;
  after: TextRevision;
  annotation: unknown;
  selection: unknown;
  historyAuthored: boolean;
  facts: OperatedFacts;
  familyProof: FamilyProof;
  wireVersion: 13 | 14;
}>;

export type CanonicalRegionEdit = Readonly<{
  kind: 'region.edit';
  id: string;
  before: TextRevision;
  after: TextRevision;
  from: number;
  to: number;
  text: RegionTextOperations;
  transitions: readonly RegionEditTransition[];
  beforeDigest: string;
  afterDigest: string;
  affectedIds: readonly string[];
  declarationFingerprint: string | null;
  witnessBefore: readonly RegionAnnotationImage[] | null;
  witnessAfter: readonly RegionAnnotationImage[] | null;
  facts: OperatedFacts;
  familyProof: FamilyProof;
  wireVersion: 15 | 16;
}>;

export type CanonicalOperatedEvent =
  | CanonicalTextApply
  | CanonicalTextReplace
  | CanonicalAnnotationApplyRange
  | CanonicalAnnotationRemove
  | CanonicalAnnotationUpdate
  | CanonicalRegionEdit;
export type OperatedWireEnvelope = Readonly<{
  version: 13 | 14 | 15 | 16;
  id: string;
  before: TextRevision;
  after: TextRevision;
  operation: Record<string, unknown>;
  facts: OperatedFacts;
}>;

export function packOperatedFacts(data: Record<string, unknown> | { [key: string]: unknown }): OperatedFacts {
  const arrays = (value: unknown) => Object.freeze(value ?? []);
  return Object.freeze({
    family: data.family ?? null,
    annotation: data.annotation ?? null,
    annotationUpdates: arrays(data.annotationUpdates),
    ranges: arrays(data.ranges),
    measurements: arrays(data.measurements),
    lifecycle: data.lifecycle ?? null,
    result: data.result ?? null,
    emptiedAnnotations: arrays(data.emptiedAnnotations),
    actorId: data.actorId ?? null,
    selectedRange: data.selectedRange ?? null,
    removedAnnotationIds: arrays(data.removedAnnotationIds),
  }) as OperatedFacts;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function invalidEnvelope(entity: string, field: string, version: unknown): never {
  throw new Error(`${entity}.${field}.operated v${version} event has invalid envelope`);
}

function isTextRevision(value: unknown): value is TextRevision {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value as object).sort().join() === 'frontier,structuralRevision'
    && Number.isSafeInteger((value as TextRevision).structuralRevision)
    && (value as TextRevision).structuralRevision >= 1
    && Array.isArray((value as TextRevision).frontier);
}

function parseFacts(facts: unknown, entity: string, field: string, version: unknown): OperatedFacts {
  if (!isPlainObject(facts)) invalidEnvelope(entity, field, version);
  const f = facts as Record<string, unknown>;
  // Accept both the legacy 10-key set (v13/v14 events stored before
  // annotationUpdates was added) and the current 11-key set. The new key
  // must be an array when present.
  const hasAnnotationUpdates = Object.hasOwn(f, 'annotationUpdates');
  const expectedKeys = hasAnnotationUpdates ? OPERATED_FACT_KEYS : OPERATED_FACT_KEYS.filter((k) => k !== 'annotationUpdates');
  if (!exactKeys(f, expectedKeys)) invalidEnvelope(entity, field, version);
  if (hasAnnotationUpdates && !Array.isArray(f.annotationUpdates)) invalidEnvelope(entity, field, version);
  if (!Array.isArray(f.ranges) || !Array.isArray(f.measurements) || !Array.isArray(f.emptiedAnnotations) || !Array.isArray(f.removedAnnotationIds)
    || (f.family !== null && (!f.family || typeof f.family !== 'object'))
    || (f.annotation !== null && (!f.annotation || typeof f.annotation !== 'object'))
    || (f.lifecycle !== null && (!f.lifecycle || typeof f.lifecycle !== 'object'))
    || (f.result !== null && (!f.result || typeof f.result !== 'object'))
    || (f.actorId !== null && (typeof f.actorId !== 'string' || !f.actorId))
    || (f.selectedRange !== null && (!f.selectedRange || typeof f.selectedRange !== 'object'))) {
    invalidEnvelope(entity, field, version);
  }
  for (const key of V15_PROOF_KEYS) {
    if (Object.hasOwn(f, key)) invalidEnvelope(entity, field, version);
  }
  return packOperatedFacts(f);
}

function familyProofFor(version: 13 | 14 | 15 | 16, family: unknown, entity: string, field: string): FamilyProof {
  if (version === 13) {
    if (!family || typeof family !== 'object' || Array.isArray(family)) invalidEnvelope(entity, field, version);
    return Object.freeze({ kind: 'checkpoint', checkpoint: family });
  }
  if (family !== null) invalidEnvelope(entity, field, version);
  return Object.freeze({ kind: 'derive-and-check-frontier' });
}

function assertNoV15Proof(operation: Record<string, unknown>, entity: string, field: string, version: unknown): void {
  for (const key of V15_PROOF_KEYS) {
    if (Object.hasOwn(operation, key)) invalidEnvelope(entity, field, version);
  }
}

function serializedUtf8Bytes(value: unknown, label: string): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw regionLimitError(`${label} must be JSON-serializable`);
  }
  return utf8ByteLength(serialized);
}

function preflightV15Payload(raw: Record<string, unknown>, operation: Record<string, unknown>, entity: string, field: string): void {
  const label = `${entity}.${field}.operated v15`;
  if (serializedUtf8Bytes(operation, `${label} operation`) > REGION_DESCRIPTOR_MAX_UTF8_BYTES) {
    throw regionLimitError(`${label} operation exceeds ${REGION_DESCRIPTOR_MAX_UTF8_BYTES} UTF-8 bytes`);
  }
  if (serializedUtf8Bytes(raw, `${label} payload`) > REGION_DESCRIPTOR_MAX_UTF8_BYTES) {
    throw regionLimitError(`${label} payload exceeds ${REGION_DESCRIPTOR_MAX_UTF8_BYTES} UTF-8 bytes`);
  }

  let memberships = 0;
  let protectedEdges = 0;
  let prerequisites = 0;
  const visit = (value: unknown, key = '', underText = false): void => {
    if (typeof value === 'string') {
      if (underText && utf8ByteLength(value) > REGION_REPLACEMENT_MAX_UTF8_BYTES) {
        throw regionLimitError(`${label} text operation exceeds ${REGION_REPLACEMENT_MAX_UTF8_BYTES} UTF-8 bytes`);
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      if (key === 'ranges' || key === 'memberships') memberships += value.length;
      if (key === 'protectedTargetIds') protectedEdges += value.length;
      if (key === 'prerequisites') prerequisites += value.length;
      for (const child of value) visit(child, '', underText);
      return;
    }
    for (const [name, child] of Object.entries(value)) visit(child, name, underText || name === 'text');
  };
  visit(raw);
  if (memberships > REGION_MEMBERSHIP_MAX) throw regionLimitError(`${label} memberships exceed ${REGION_MEMBERSHIP_MAX}`);
  if (protectedEdges > REGION_PROTECTED_EDGE_MAX) throw regionLimitError(`${label} protected edges exceed ${REGION_PROTECTED_EDGE_MAX}`);
  if (prerequisites > REGION_PREREQUISITE_MAX) throw regionLimitError(`${label} prerequisites exceed ${REGION_PREREQUISITE_MAX}`);
}

function parseRegionText(value: unknown, entity: string, field: string): RegionTextOperations {
  if (!isPlainObject(value) || typeof value.kind !== 'string') invalidEnvelope(entity, field, 15);
  if (value.kind === 'none' && exactKeys(value, ['kind'])) return Object.freeze({ kind: 'none' });
  if (value.kind === 'delete' && exactKeys(value, ['kind', 'operation']) && Array.isArray(value.operation)) {
    return Object.freeze({ kind: 'delete', operation: value.operation });
  }
  if (value.kind === 'insert' && exactKeys(value, ['kind', 'operation']) && Array.isArray(value.operation)) {
    return Object.freeze({ kind: 'insert', operation: value.operation });
  }
  if (value.kind === 'replace' && exactKeys(value, ['kind', 'operations']) && Array.isArray(value.operations) && value.operations.length === 2) {
    return Object.freeze({ kind: 'replace', operations: Object.freeze([...value.operations]) as readonly [unknown, unknown] });
  }
  invalidEnvelope(entity, field, 15);
}

const RANGE_KEYS = ['end', 'start'] as const;
const RANGE_SET_KEYS = ['annotationId', 'kind', 'ranges'] as const;
const REMOVE_KEYS = ['annotationId', 'kind'] as const;
const CREATE_KEYS = ['annotation', 'kind', 'ranges'] as const;
const CREATE_ANNOTATION_KEYS = ['family', 'fields', 'id', 'protectedTargetIds'] as const;

function parseV15Range(value: unknown, entity: string, field: string): Readonly<{ start: number; end: number }> {
  if (!isPlainObject(value) || !exactKeys(value, RANGE_KEYS)) invalidEnvelope(entity, field, 15);
  const { start, end } = value as { start: unknown; end: unknown };
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (end as number) <= (start as number)) {
    invalidEnvelope(entity, field, 15);
  }
  return Object.freeze({ start: start as number, end: end as number });
}

function parseV15Ranges(value: unknown, entity: string, field: string): readonly Readonly<{ start: number; end: number }>[] {
  if (!Array.isArray(value)) invalidEnvelope(entity, field, 15);
  return Object.freeze(value.map((entry) => parseV15Range(entry, entity, field)));
}

function isStrictlySortedNonEmptyStrings(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== 'string' || entry.length === 0) return false;
    if (index > 0 && value[index - 1] >= entry) return false;
  }
  return true;
}

function parseOptionalLastRange(value: unknown, entity: string, field: string): readonly [number, number] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2 || !Number.isSafeInteger(value[0]) || !Number.isSafeInteger(value[1])) {
    invalidEnvelope(entity, field, 16);
  }
  return value as unknown as readonly [number, number];
}

function parseV15CreateAnnotation(value: unknown, entity: string, field: string): V15CreateAnnotationPayload {
  if (!isPlainObject(value) || !exactKeys(value, CREATE_ANNOTATION_KEYS)) invalidEnvelope(entity, field, 15);
  const { id, family, fields, protectedTargetIds } = value as {
    id: unknown; family: unknown; fields: unknown; protectedTargetIds: unknown;
  };
  if (typeof id !== 'string' || id.length === 0 || typeof family !== 'string' || family.length === 0) {
    invalidEnvelope(entity, field, 15);
  }
  if (!isPlainObject(fields)) invalidEnvelope(entity, field, 15);
  const fieldNames = Object.keys(fields);
  if (fieldNames.some((name, index) => index > 0 && fieldNames[index - 1] >= name)) invalidEnvelope(entity, field, 15);
  if (!isStrictlySortedNonEmptyStrings(protectedTargetIds)) {
    invalidEnvelope(entity, field, 15);
  }
  return Object.freeze({
    id,
    family,
    fields: Object.freeze({ ...fields }),
    protectedTargetIds: Object.freeze([...protectedTargetIds]),
  }) as V15CreateAnnotationPayload;
}

// Every wire transition is validated through the same closed grammar as
// planning's descriptor parser (region-descriptor.ts) before the reducer sees
// it. A forged range.set naming a missing/unknown annotation, a malformed
// create payload, or an unknown kind is rejected below with the canonical
// `<entity>.<field>.operated v15 event has invalid envelope` signature, so the
// reducer can never silently drop a transition while text still commits.
function parseV15Transition(value: unknown, entity: string, field: string, seenIds: Set<string>): RegionEditTransition {
  if (!isPlainObject(value) || typeof value.kind !== 'string') invalidEnvelope(entity, field, 15);
  const kind = value.kind;
  if (kind === 'range.set') {
    if (!exactKeys(value, RANGE_SET_KEYS)) invalidEnvelope(entity, field, 15);
    const annotationId = value.annotationId;
    if (typeof annotationId !== 'string' || annotationId.length === 0) invalidEnvelope(entity, field, 15);
    if (seenIds.has(annotationId)) invalidEnvelope(entity, field, 15);
    seenIds.add(annotationId);
    return Object.freeze({ kind: 'range.set', annotationId, ranges: parseV15Ranges(value.ranges, entity, field) });
  }
  if (kind === 'remove') {
    if (!exactKeys(value, REMOVE_KEYS)) invalidEnvelope(entity, field, 15);
    const annotationId = value.annotationId;
    if (typeof annotationId !== 'string' || annotationId.length === 0) invalidEnvelope(entity, field, 15);
    if (seenIds.has(annotationId)) invalidEnvelope(entity, field, 15);
    seenIds.add(annotationId);
    return Object.freeze({ kind: 'remove', annotationId });
  }
  if (kind === 'create') {
    if (!exactKeys(value, CREATE_KEYS)) invalidEnvelope(entity, field, 15);
    const annotation = parseV15CreateAnnotation(value.annotation, entity, field);
    if (seenIds.has(annotation.id)) invalidEnvelope(entity, field, 15);
    seenIds.add(annotation.id);
    return Object.freeze({ kind: 'create', annotation, ranges: parseV15Ranges(value.ranges, entity, field) });
  }
  invalidEnvelope(entity, field, 15);
}

function parseV15Operation(operation: Record<string, unknown>, entity: string, field: string): Omit<CanonicalRegionEdit, 'id' | 'before' | 'after' | 'facts' | 'familyProof' | 'wireVersion'> {
  const keys = ['affectedIds', 'afterDigest', 'beforeDigest', 'from', 'kind', 'text', 'to', 'transitions'];
  if (!exactKeys(operation, keys) || operation.kind !== 'region.edit') invalidEnvelope(entity, field, 15);
  if (!Number.isSafeInteger(operation.from) || !Number.isSafeInteger(operation.to) || (operation.to as number) < (operation.from as number)) {
    invalidEnvelope(entity, field, 15);
  }
  if (typeof operation.beforeDigest !== 'string' || !SHA256_HEX.test(operation.beforeDigest)) {
    throw regionLimitError(`${entity}.${field}.operated v15 beforeDigest is not a SHA-256 digest`);
  }
  if (typeof operation.afterDigest !== 'string' || !SHA256_HEX.test(operation.afterDigest)) {
    throw regionLimitError(`${entity}.${field}.operated v15 afterDigest is not a SHA-256 digest`);
  }
  if (!Array.isArray(operation.affectedIds) || operation.affectedIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    invalidEnvelope(entity, field, 15);
  }
  if (operation.affectedIds.length > REGION_AFFECTED_ANNOTATION_MAX) {
    throw regionLimitError(`${entity}.${field}.operated v15 affectedIds exceed ${REGION_AFFECTED_ANNOTATION_MAX}`);
  }
  const ids = operation.affectedIds as string[];
  if (ids.some((id, index) => index > 0 && ids[index - 1] >= id)) invalidEnvelope(entity, field, 15);
  if (!Array.isArray(operation.transitions) || operation.transitions.length > REGION_TRANSITION_MAX) {
    if (Array.isArray(operation.transitions) && operation.transitions.length > REGION_TRANSITION_MAX) {
      throw regionLimitError(`${entity}.${field}.operated v15 transitions exceed ${REGION_TRANSITION_MAX}`);
    }
    invalidEnvelope(entity, field, 15);
  }
  const seenIds = new Set<string>();
  const transitions = Object.freeze(
    (operation.transitions as readonly unknown[]).map((entry) => parseV15Transition(entry, entity, field, seenIds)),
  );
  return Object.freeze({
    kind: 'region.edit',
    from: operation.from as number,
    to: operation.to as number,
    text: parseRegionText(operation.text, entity, field),
    transitions,
    beforeDigest: operation.beforeDigest,
    afterDigest: operation.afterDigest,
    affectedIds: Object.freeze([...ids]),
    declarationFingerprint: null,
    witnessBefore: null,
    witnessAfter: null,
  });
}

// V16 closed operation grammar: the v15 region.edit surface plus the complete
// bounded before/after witness (declarationFingerprint, emptied, witnessBefore,
// witnessAfter). Unknown keys reject; every nested value passes the same
// canonical checks the constructor applied before the bytes were stored.
function parseV16Operation(operation: Record<string, unknown>, entity: string, field: string): Omit<CanonicalRegionEdit, 'id' | 'before' | 'after' | 'facts' | 'familyProof' | 'wireVersion'> {
  const keys = [
    'affectedIds',
    'afterDigest',
    'beforeDigest',
    'declarationFingerprint',
    'emptied',
    'from',
    'kind',
    'text',
    'to',
    'transitions',
    'witnessAfter',
    'witnessBefore',
  ];
  if (!exactKeys(operation, keys) || operation.kind !== 'region.edit') invalidEnvelope(entity, field, 16);
  const base = parseV15Operation({
    affectedIds: operation.affectedIds,
    afterDigest: operation.afterDigest,
    beforeDigest: operation.beforeDigest,
    from: operation.from,
    kind: 'region.edit',
    text: operation.text,
    to: operation.to,
    transitions: operation.transitions,
  }, entity, field);
  if (typeof operation.declarationFingerprint !== 'string' || !SHA256_HEX.test(operation.declarationFingerprint)) {
    throw regionLimitError(`${entity}.${field}.operated v16 declarationFingerprint is not a SHA-256 digest`);
  }
  const emptied = parseV16Emptied(operation.emptied, entity, field);
  const witnessBefore = parseV16WitnessSide(operation.witnessBefore, entity, field);
  const witnessAfter = parseV16WitnessSide(operation.witnessAfter, entity, field);
  return Object.freeze({
    ...base,
    declarationFingerprint: operation.declarationFingerprint,
    emptied,
    witnessBefore,
    witnessAfter,
  });
}

const V16_EMPTIED_KEYS = ['annotationId', 'disposition'] as const;
const V16_DISPOSITION_KEYS = ['family', 'kind', 'lastRange', 'savedQuote'] as const;

function parseV16Emptied(value: unknown, entity: string, field: string): RegionPostimage['emptied'] {
  if (!Array.isArray(value)) invalidEnvelope(entity, field, 16);
  return Object.freeze(value.map((entry) => {
    if (!isPlainObject(entry) || !exactKeys(entry, V16_EMPTIED_KEYS)) invalidEnvelope(entity, field, 16);
    const disposition = entry.disposition;
    if (!isPlainObject(disposition) || !exactKeys(disposition, V16_DISPOSITION_KEYS)) invalidEnvelope(entity, field, 16);
    if (disposition.kind !== 'deleted' && disposition.kind !== 'orphaned') invalidEnvelope(entity, field, 16);
    if (typeof disposition.family !== 'string' || disposition.family.length === 0) invalidEnvelope(entity, field, 16);
    if (disposition.savedQuote !== null && typeof disposition.savedQuote !== 'string') invalidEnvelope(entity, field, 16);
    const lastRange = parseOptionalLastRange(disposition.lastRange, entity, field);
    if (typeof entry.annotationId !== 'string' || entry.annotationId.length === 0) invalidEnvelope(entity, field, 16);
    return Object.freeze({
      annotationId: entry.annotationId,
      disposition: Object.freeze({
        kind: disposition.kind,
        family: disposition.family,
        savedQuote: disposition.savedQuote as string | null,
        lastRange,
      }),
    });
  }));
}

const V16_ORPHAN_KEYS = ['lastRange', 'savedQuote'] as const;
const V16_PREREQUISITE_KEYS = ['entity', 'id'] as const;
const V16_MEMBERSHIP_KEYS = ['end', 'ordinal', 'start'] as const;

function parseV16Endpoint(value: unknown, entity: string, field: string): unknown {
  if (!isPlainObject(value)) invalidEnvelope(entity, field, 16);
  const record = value as { point?: unknown; basisFrontier?: unknown };
  if (!Object.hasOwn(value, 'point') || !Object.hasOwn(value, 'basisFrontier') || Object.keys(value).length !== 2) {
    invalidEnvelope(entity, field, 16);
  }
  return Object.freeze({ point: record.point, basisFrontier: record.basisFrontier });
}

function parseV16WitnessImage(rawImage: unknown, entity: string, field: string, seenIds: Set<string>): RegionAnnotationImage {
  if (!isPlainObject(rawImage) || !exactKeys(rawImage, V16_WITNESS_IMAGE_KEYS)) invalidEnvelope(entity, field, 16);
  const image = rawImage as Record<string, unknown>;
  const { id, family, fields, protectedTargetIds, memberships, orphan, empty, cardinality, prerequisites } = image;
  if (typeof id !== 'string' || id.length === 0 || seenIds.has(id)) invalidEnvelope(entity, field, 16);
  seenIds.add(id);
  if (typeof family !== 'string' || family.length === 0) invalidEnvelope(entity, field, 16);
  if (!isPlainObject(fields)) invalidEnvelope(entity, field, 16);
  const fieldNames = Object.keys(fields);
  if (fieldNames.some((name, index) => index > 0 && fieldNames[index - 1] >= name)) invalidEnvelope(entity, field, 16);
  if (!isStrictlySortedNonEmptyStrings(protectedTargetIds)) {
    invalidEnvelope(entity, field, 16);
  }
  const targets = protectedTargetIds;
  if (empty !== 'delete' && empty !== 'orphan') invalidEnvelope(entity, field, 16);
  if (cardinality !== 'many' && cardinality !== 'one') invalidEnvelope(entity, field, 16);
  if (!Array.isArray(memberships)) invalidEnvelope(entity, field, 16);
  const parsedMemberships = memberships.map((membership, ordinal) => {
    if (!isPlainObject(membership) || !exactKeys(membership, V16_MEMBERSHIP_KEYS)) invalidEnvelope(entity, field, 16);
    const record = membership as Record<string, unknown>;
    if (record.ordinal !== ordinal) invalidEnvelope(entity, field, 16);
    return Object.freeze({
      ordinal,
      start: parseV16Endpoint(record.start, entity, field),
      end: parseV16Endpoint(record.end, entity, field),
    });
  });
  let parsedOrphan: RegionOrphanImage | null = null;
  if (orphan !== null) {
    if (!isPlainObject(orphan) || !exactKeys(orphan, V16_ORPHAN_KEYS)) invalidEnvelope(entity, field, 16);
    const record = orphan as Record<string, unknown>;
    if (typeof record.savedQuote !== 'string') invalidEnvelope(entity, field, 16);
    parsedOrphan = Object.freeze({
      savedQuote: record.savedQuote,
      lastRange: parseOptionalLastRange(record.lastRange, entity, field),
    });
  }
  if (!Array.isArray(prerequisites)) invalidEnvelope(entity, field, 16);
  const parsedPrerequisites = prerequisites.map((prerequisite) => {
    if (!isPlainObject(prerequisite) || !exactKeys(prerequisite, V16_PREREQUISITE_KEYS)) invalidEnvelope(entity, field, 16);
    const record = prerequisite as Record<string, unknown>;
    if (typeof record.entity !== 'string' || record.entity.length === 0
      || typeof record.id !== 'string' || record.id.length === 0) {
      invalidEnvelope(entity, field, 16);
    }
    return Object.freeze({ entity: record.entity, id: record.id });
  });
  return Object.freeze({
    id,
    family,
    fields: Object.freeze({ ...fields }),
    protectedTargetIds: Object.freeze([...targets]),
    memberships: Object.freeze(parsedMemberships),
    orphan: parsedOrphan,
    empty,
    cardinality,
    prerequisites: Object.freeze(parsedPrerequisites),
  }) as RegionAnnotationImage;
}

function parseV16WitnessSide(value: unknown, entity: string, field: string): readonly RegionAnnotationImage[] {
  if (!Array.isArray(value)) invalidEnvelope(entity, field, 16);
  const seenIds = new Set<string>();
  let previous = '';
  const images = value.map((rawImage) => {
    const image = parseV16WitnessImage(rawImage, entity, field, seenIds);
    if (!(previous < image.id)) {
      throw regionLimitError(`${entity}.${field}.operated v16 witness closure must be sorted and unique`);
    }
    previous = image.id;
    return image;
  });
  return Object.freeze(images) as readonly RegionAnnotationImage[];
}

export function normalizeOperatedEvent(
  raw: unknown,
  context: { entity: string; field: string },
): CanonicalOperatedEvent {
  return normalizeOperatedEventInternal(raw, context, false);
}

function normalizeOperatedEventInternal(
  raw: unknown,
  context: { entity: string; field: string },
  skipV16CanonicalCheck: boolean,
): CanonicalOperatedEvent {
  const { entity, field } = context;
  const version = isPlainObject(raw) ? raw.version : undefined;
  if (version !== 13 && version !== 14 && version !== 15 && version !== 16) {
    throw new Error(`${entity}.${field}.operated event version ${version} is not supported: only operated versions 13, 14, 15, and 16 are replayable; pre-13 lattice rows were retired (issue #23)`);
  }
  if (!isPlainObject(raw) || !exactKeys(raw, OPERATED_ENVELOPE_KEYS)) {
    invalidEnvelope(entity, field, version);
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0 || !isTextRevision(raw.before) || !isTextRevision(raw.after)
    || !isPlainObject(raw.operation)) {
    invalidEnvelope(entity, field, version);
  }
  if (version === 15 || version === 16) preflightV15Payload(raw, raw.operation, entity, field);
  if (version === 16 && !skipV16CanonicalCheck) {
    // The complete persisted text must itself be canonically bounded before it
    // is trusted for parse; parseStoredV16OperatedEvent already verified it.
    canonicalV16Json(raw, REGION_V16_MAX_EVENT_BYTES, `${entity}.${field}.operated v16`);
  }
  const facts = parseFacts(raw.facts, entity, field, version);
  const familyProof = familyProofFor(version === 16 ? 15 : version, facts.family, entity, field);
  const operation = raw.operation;
  if (version === 15 || version === 16) {
    const region = version === 16
      ? parseV16Operation(operation, entity, field)
      : parseV15Operation(operation, entity, field);
    return Object.freeze({
      ...region,
      id: raw.id,
      before: raw.before,
      after: raw.after,
      facts,
      familyProof,
      wireVersion: version,
    });
  }
  assertNoV15Proof(operation, entity, field, version);
  const kind = operation.kind;
  if (kind === 'text.apply' && exactKeys(operation, ['kind', 'operation']) && Array.isArray(operation.operation)) {
    return Object.freeze({
      kind: 'text.apply',
      id: raw.id,
      before: raw.before,
      after: raw.after,
      operation: operation.operation,
      facts,
      familyProof,
      wireVersion: version,
    });
  }
  if (kind === 'text.replace' && exactKeys(operation, ['kind', 'operations']) && Array.isArray(operation.operations) && operation.operations.length === 2) {
    return Object.freeze({
      kind: 'text.replace',
      id: raw.id,
      before: raw.before,
      after: raw.after,
      operations: Object.freeze([...operation.operations]),
      facts,
      familyProof,
      wireVersion: version,
    });
  }
  if (kind === 'annotation.apply-range' && exactKeys(operation, ['annotation', 'kind', 'selection'])) {
    return Object.freeze({
      kind: 'annotation.apply-range',
      id: raw.id,
      before: raw.before,
      after: raw.after,
      annotation: operation.annotation,
      selection: operation.selection,
      facts,
      familyProof,
      wireVersion: version,
    });
  }
  if (kind === 'annotation.remove' && exactKeys(operation, ['annotationId', 'kind']) && typeof operation.annotationId === 'string' && operation.annotationId) {
    return Object.freeze({
      kind: 'annotation.remove',
      id: raw.id,
      before: raw.before,
      after: raw.after,
      annotationId: operation.annotationId,
      facts,
      familyProof,
      wireVersion: version,
    });
  }
  // #174: annotation.update — one history step updating fields (and optionally
  // the range) of an existing annotation. `selection` null = fields-only (the
  // stored endpoint basis anchors must survive untouched); non-null carries the
  // new absolute offsets the planner resolved. History-AUTHORED compensations
  // (undo/redo of an update) carry `authored: 'history'`: they restore the
  // captured verbatim images whose endpoints keep their historical bases, so
  // the planner-offset recompute cannot apply to them.
  if (kind === 'annotation.update' &&
      (exactKeys(operation, ['annotation', 'kind', 'selection']) ||
       (exactKeys(operation, ['annotation', 'kind', 'selection', 'authored']) && operation.authored === 'history'))
    && operation.annotation && typeof operation.annotation === 'object' && !Array.isArray(operation.annotation)
    && (operation.selection === null || (
      operation.selection && typeof operation.selection === 'object' && !Array.isArray(operation.selection)
      && Number.isSafeInteger((operation.selection as { startOffset?: unknown }).startOffset)
      && Number.isSafeInteger((operation.selection as { endOffset?: unknown }).endOffset)))) {
    return Object.freeze({
      kind: 'annotation.update',
      id: raw.id,
      before: raw.before,
      after: raw.after,
      annotation: operation.annotation,
      selection: operation.selection,
      historyAuthored: operation.authored === 'history',
      facts,
      familyProof,
      wireVersion: version,
    });
  }
  invalidEnvelope(entity, field, version);
}

/**
 * The ONLY parser for persisted v16 `_Log.eventData` text. Scans the raw text
 * BEFORE JSON.parse (rejecting duplicate keys at any depth, noncanonical key
 * order/encoding, trailing bytes, and invalid UTF-8/JSON), then requires the
 * parsed value to canonically reserialize byte-equal to the stored text.
 * Returns the same canonical boundary as `normalizeOperatedEvent`.
 */
export function parseStoredV16OperatedEvent(eventDataText: string, context: { entity: string; field: string }): CanonicalRegionEdit {
  const { entity, field } = context;
  if (typeof eventDataText !== 'string' || eventDataText.length === 0) {
    throw new Error(`${entity}.${field}.operated v16 stored envelope is not canonical: shape`);
  }
  let parsed: unknown;
  try {
    parsed = parseCanonicalJsonText(eventDataText);
  } catch (error) {
    throw new Error(`${entity}.${field}.operated v16 stored envelope is not canonical: ${(error as Error).message}`);
  }
  const reserialized = canonicalV16Json(parsed, REGION_V16_MAX_EVENT_BYTES, `${entity}.${field}.operated v16`);
  if (reserialized !== eventDataText) {
    throw new Error(`${entity}.${field}.operated v16 stored envelope is not canonical: order`);
  }
  const version = isPlainObject(parsed) ? parsed.version : undefined;
  if (version !== 16) {
    throw new Error(`${entity}.${field}.operated event version ${version} is not supported: only operated versions 13, 14, 15, and 16 are replayable; pre-13 lattice rows were retired (issue #23)`);
  }
  return normalizeOperatedEventInternal(parsed as OperatedWireEnvelope, context, true) as CanonicalRegionEdit;
}

// Escape-aware JSON string-literal scanner. Returns the complete literal
// INCLUDING quotes, advancing over backslash escapes: `\"` never terminates,
// `\\` is a literal backslash, and `\uXXXX` must carry exactly four hex digits.
// A raw control character (< 0x20) inside the literal is invalid JSON. The
// scanner returns the raw source slice so JSON.parse owns value decoding.
function scanJsonStringLiteral(text: string, start: number): string {
  if (text[start] !== '"') throw new Error('expected string');
  let cursor = start + 1;
  for (;;) {
    if (cursor >= text.length) throw new Error('unterminated string');
    const ch = text[cursor];
    if (ch === '"') return text.slice(start, cursor + 1);
    if (ch === '\\') {
      const escape = text[cursor + 1];
      if (escape === 'u') {
        const hex = text.slice(cursor + 2, cursor + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('invalid unicode escape');
        cursor += 6;
        continue;
      }
      if (!'"\\/bfnrt'.includes(escape)) throw new Error('invalid escape');
      cursor += 2;
      continue;
    }
    if (ch < ' ') throw new Error('raw control character in string');
    cursor += 1;
  }
}

// Strict JSON text scanner: duplicate keys at any depth are rejected before a
// value is ever produced, so a tampered row cannot rely on last-key-wins.
function parseCanonicalJsonText(text: string): unknown {
  let index = 0;
  const fail = (why: string): never => { throw new Error(why); };
  const skipWhitespace = () => { while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1; };
  const parseValue = (depth: number): unknown => {
    if (depth > REGION_V16_MAX_DEPTH) fail(`depth exceeds ${REGION_V16_MAX_DEPTH}`);
    skipWhitespace();
    if (index >= text.length) fail('unexpected end');
    const ch = text[index];
    if (ch === '{') {
      index += 1;
      const seen = new Set<string>();
      skipWhitespace();
      if (text[index] === '}') { index += 1; return {}; }
      const result: Record<string, unknown> = {};
      for (;;) {
        skipWhitespace();
        if (text[index] !== '"') fail('expected object key');
        const keyLiteral = scanJsonStringLiteral(text, index);
        index += keyLiteral.length;
        let key: string;
        try {
          key = JSON.parse(keyLiteral) as string;
        } catch {
          return fail('invalid string encoding');
        }
        if (seen.has(key)) fail('duplicate-key');
        seen.add(key);
        skipWhitespace();
        if (text[index] !== ':') fail('expected colon');
        index += 1;
        result[key] = parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === ',') { index += 1; continue; }
        if (text[index] === '}') { index += 1; return result; }
        fail('expected , or }');
      }
    }
    if (ch === '[') {
      index += 1;
      const result: unknown[] = [];
      skipWhitespace();
      if (text[index] === ']') { index += 1; return result; }
      for (;;) {
        result.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[index] === ',') { index += 1; continue; }
        if (text[index] === ']') { index += 1; return result; }
        fail('expected , or ]');
      }
    }
    if (ch === '"') {
      const literal = scanJsonStringLiteral(text, index);
      index += literal.length;
      try {
        return JSON.parse(literal);
      } catch {
        return fail('invalid string encoding');
      }
    }
    const rest = text.slice(index);
    const literalMatch: string = /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)/.exec(rest)?.[0] ?? '';
    if (literalMatch.length === 0) fail('invalid literal');
    index += literalMatch.length;
    return JSON.parse(literalMatch);
  };
  const value = parseValue(1);
  skipWhitespace();
  if (index !== text.length) fail('trailing bytes');
  return value;
}

interface LegacyOperatedEventInput {
  id: string;
  before: TextRevision;
  after: TextRevision;
  operation: Record<string, unknown>;
  annotation?: unknown;
  annotationUpdates?: unknown;
  ranges?: unknown;
  measurements?: unknown;
  lifecycle?: unknown;
  result?: unknown;
  emptiedAnnotations?: unknown;
  actorId?: unknown;
  selectedRange?: unknown;
  removedAnnotationIds?: unknown;
}

export function constructV13OperatedEvent(data: LegacyOperatedEventInput & { family: unknown }): OperatedWireEnvelope {
  return Object.freeze({
    version: 13,
    id: data.id,
    before: data.before,
    after: data.after,
    operation: data.operation,
    facts: packOperatedFacts({ ...data, family: data.family }),
  });
}

export function constructV14OperatedEvent(data: LegacyOperatedEventInput): OperatedWireEnvelope {
  return Object.freeze({
    version: 14,
    id: data.id,
    before: data.before,
    after: data.after,
    operation: data.operation,
    facts: packOperatedFacts({ ...data, family: null }),
  });
}

/** Loose revision shape shared by legacy constructors (TS7-safe element type). */
type LegacyTextRevision = Readonly<{ structuralRevision: number; frontier: ReadonlyArray<unknown> }>;

export function constructV15RegionEvent(plan: RegionPlan): { version: 15; id: string; before: LegacyTextRevision; after: LegacyTextRevision; operation: Record<string, unknown>; facts: OperatedFacts } {
  return {
    version: 15,
    id: plan.descriptor.id,
    before: plan.before,
    after: plan.after,
    operation: Object.freeze({
      kind: 'region.edit',
      from: plan.descriptor.from,
      to: plan.descriptor.to,
      text: plan.textOperations,
      transitions: plan.descriptor.transitions,
      beforeDigest: plan.postimage.beforeDigest,
      afterDigest: plan.postimage.afterDigest,
      affectedIds: plan.postimage.affectedIds,
    }),
    facts: packOperatedFacts({
      family: null,
      emptiedAnnotations: plan.postimage.emptied,
      removedAnnotationIds: plan.postimage.emptied
        .filter((entry) => entry.disposition.kind === 'deleted')
        .map((entry) => entry.annotationId),
    }),
  };
}

// ---- V16 durable grammar (#148 rev 2 "V16 durable grammar") ----
// The sole new-emission region constructor, canonical byte serializer, and
// persisted-text parser. W2/W3 consume the compiled policy result and may not
// construct, parse, serialize, or modify v16 witnesses.

const V16_WITNESS_IMAGE_KEYS = [
  'cardinality',
  'empty',
  'family',
  'fields',
  'id',
  'memberships',
  'orphan',
  'prerequisites',
  'protectedTargetIds',
] as const;

/** One complete bounded closure side of a v16 witness. */
export type RegionWitnessSide = readonly RegionAnnotationImage[];
/** Emptied dispositions carried by a v16 witness. */
export type RegionWitnessEmptied = RegionPostimage['emptied'];

/**
 * The ONLY new-emission region constructor. Takes the planner's validated
 * result (postimage already proven by `assertCompleteRegionWitness`) and
 * returns the frozen canonical envelope plus its canonical UTF-8 JSON text.
 * The text is what `_Log` must store verbatim — appendEvents never re-stringifies
 * a branded v16 event.
 */
export function constructV16RegionEvent(plan: RegionPlan, admission?: V16AdmissionIdentity): {
  event: { version: 16; id: string; before: LegacyTextRevision; after: LegacyTextRevision; operation: Record<string, unknown>; facts: OperatedFacts };
  eventDataText: string;
  /** Single-use admission capability for the pipeline-copied append path. */
  capability: { nonce: string };
} {
  // Bounded canonicalization happens FIRST, on a plain (unfrozen) envelope
  // view: an over-limit witness aborts here before the durable envelope is
  // constructed or frozen. The canonical text is then attached as the
  // unforgeable brand and the frozen result returned.
  const eventView = {
    version: 16 as const,
    id: plan.descriptor.id,
    before: plan.before,
    after: plan.after,
    operation: {
      affectedIds: plan.postimage.affectedIds,
      afterDigest: plan.postimage.afterDigest,
      beforeDigest: plan.postimage.beforeDigest,
      declarationFingerprint: plan.declarationFingerprint,
      emptied: plan.postimage.emptied,
      from: plan.descriptor.from,
      kind: 'region.edit',
      text: plan.textOperations,
      to: plan.descriptor.to,
      transitions: plan.descriptor.transitions,
      witnessAfter: plan.postimage.annotations,
      witnessBefore: plan.postimage.beforeAnnotations,
    },
    facts: packOperatedFacts({
      family: null,
      emptiedAnnotations: plan.postimage.emptied,
      removedAnnotationIds: plan.postimage.emptied
        .filter((entry) => entry.disposition.kind === 'deleted')
        .map((entry) => entry.annotationId),
    }),
  };
  const eventDataText = canonicalV16Json(eventView, REGION_V16_MAX_EVENT_BYTES, 'operated v16 event');
  // Brand while still extensible, THEN freeze — the stamp is immutable and
  // invisible to JSON/enumeration, but must be installed before sealing. The
  // returned nonce capability is the ONLY route for a pipeline-copied (symbol-
  // stripped) envelope to be admitted at append; it is consumed exactly once.
  const capability = brandV16Event(eventView as unknown as object, eventDataText, admission ?? {
    owningScope: '', entity: '', field: '',
    documentId: plan.descriptor.id, actionId: '',
  });
  const event = Object.freeze(eventView) as unknown as { version: 16; id: string; before: { structuralRevision: number; frontier: unknown[] }; after: { structuralRevision: number; frontier: unknown[] }; operation: Record<string, unknown>; facts: OperatedFacts };
  return Object.freeze({
    event,
    eventDataText,
    capability: Object.freeze({ nonce: capability.nonce }),
  });
}
/**
 * The ONLY canonical byte serializer for operated events. For a branded v16
 * envelope it emits sorted-key canonical UTF-8 JSON under the full 2 MiB
 * event/depth/string accounting; anything else falls back to stable
 * JSON.stringify (legacy rows keep their current durable representation).
 */
export function serializeV16OperatedEvent(event: OperatedWireEnvelope): string {
  if ((event as { version?: unknown }).version !== 16) {
    return JSON.stringify(event);
  }
  return canonicalV16Json(event, REGION_V16_MAX_EVENT_BYTES, 'operated v16 event');
}

// ---- Unforgeable v16 admission capability (#149 review Findings 3+2R) ----
// Two coordinated mechanisms, both owned exclusively by this module:
//
// 1. BRAND — a module-private Symbol (never Symbol.for) stamped on the
//    constructor's frozen result. Non-enumerable/non-configurable, invisible
//    to JSON and dedupe comparisons. Direct appends of the constructor's own
//    return are admitted through it.
//
// 2. NONCE CAPABILITY — for the pipeline's NOW-token deep copy, which rebuilds
//    event data key-by-key (Object.keys) and therefore drops symbols. The
//    constructor mints a single-use opaque nonce bound to the canonical bytes
//    plus document/event identity; `claimV16NonceCapability` consumes it
//    EXACTLY once inside appendEvents. Replays, stale reuse after consumption,
//    post-restart tokens (memory-only), and mutated bytes all fail before the
//    _Log insert. The claim table is a Map keyed by nonce with a hard bound;
//    every path (success, failure, expiry) removes its entry.
const V16_BRAND: unique symbol = Symbol('workbench.annotated-text.v16.brand');

export interface V16AdmissionIdentity {
  owningScope: string;
  entity: string;
  field: string;
  documentId: string;
  actionId: string;
}

/** Install the brand + mint the one-shot nonce capability (sole owner). */
function brandV16Event(
  event: object,
  eventDataText: string,
  identity: V16AdmissionIdentity,
): { nonce: string } {
  // Deterministic single-use token bound to the FULL append identity — owning
  // scope, entity, field, document, exact canonical bytes, and the canonical
  // action/append id. Consumption is durable (committed-log's
  // _V16CapabilityClaim row, written inside the append transaction), so a
  // rollback removes the claim — restoring the capability for a legitimate
  // retry of the SAME action — while a commit makes consumption permanent.
  // Distinct actions with byte-identical envelopes mint distinct nonces and
  // are both admitted; replay/reuse of one action's nonce fails forever.
  const nonce = v16AdmissionNonce(identity, eventDataText);
  Object.defineProperty(event, V16_BRAND, {
    value: Object.freeze({ eventDataText, nonce }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return { nonce };
}

/**
 * Read the brand off an appended event's data. Returns null unless `data` is
 * exactly the constructor's frozen return carrying a valid stamp. (Exported
 * for the committed-log append authority only.)
 */
export function readV16Brand(data: unknown): { eventDataText: string; nonce: string } | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<PropertyKey, unknown>;
  const brand = record[V16_BRAND];
  if (!brand || typeof brand !== 'object') return null;
  if (record.version !== 16 || !exactKeys(record, OPERATED_ENVELOPE_KEYS)) {
    return null;
  }
  const stamp = brand as { eventDataText?: unknown; nonce?: unknown };
  if (typeof stamp.eventDataText !== 'string' || typeof stamp.nonce !== 'string') return null;
  return { eventDataText: stamp.eventDataText, nonce: stamp.nonce };
}

/**
 * The deterministic single-use admission token: binds owning scope, entity,
 * field, document, exact canonical bytes, and the canonical action/append id.
 * Two distinct actions with identical bytes derive distinct nonces; any change
 * to the binding or the bytes changes the nonce and fails verification.
 */
export function v16AdmissionNonce(identity: V16AdmissionIdentity, canonicalText: string): string {
  return createHash('sha256')
    .update('workbench.v16.capability\u0000')
    .update(identity.owningScope).update('\u0000')
    .update(identity.entity).update('\u0000')
    .update(identity.field).update('\u0000')
    .update(identity.documentId).update('\u0000')
    .update(identity.actionId).update('\u0000')
    .update(canonicalText)
    .digest('hex');
}

/**
 * The bytes digest recorded with a nonce claim — binds the capability to the
 * exact canonical envelope. Exported for committed-log's durable claim row.
 */
export function v16CapabilityBytesDigest(canonicalText: string): string {
  return createHash('sha256').update(canonicalText).digest('hex');
}

/**
 * Iterative canonical JSON writer and byte/depth accountant. Accepts only the
 * closed scalar/object grammar (null, booleans, finite numbers, well-formed
 * strings, arrays, plain objects); aborts as soon as the running canonical
 * UTF-8 count exceeds `maxBytes`, or nesting exceeds depth 32, BEFORE any
 * clone, freeze, or SQLite write. Returns the canonical string only after
 * every check passes.
 */
function canonicalV16Json(value: unknown, maxBytes: number, label: string): string {
  // One append primitive owns ALL byte accounting: every token's UTF-8 cost is
  // charged the moment it is appended, and traversal aborts IMMEDIATELY when
  // the running total crosses `maxBytes`. No post-traversal pass exists, so an
  // oversized payload can never be fully materialized before rejection.
  const out: string[] = [];
  let bytes = 0;
  const append = (token: string): void => {
    const cost = utf8ByteLength(token);
    bytes += cost;
    if (bytes > maxBytes) {
      throw regionLimitError(`annotated-text-region-limit: operated v16 eventData exceeds ${REGION_V16_MAX_EVENT_BYTES} UTF-8 bytes`);
    }
    out.push(token);
  };
  const visit = (node: unknown, depth: number): void => {
    if (depth > REGION_V16_MAX_DEPTH) {
      throw regionLimitError(`annotated-text-region-limit: operated v16 JSON depth exceeds ${REGION_V16_MAX_DEPTH}`);
    }
    if (node === null) { append('null'); return; }
    switch (typeof node) {
      case 'boolean':
        append(node ? 'true' : 'false');
        return;
      case 'number': {
        if (!Number.isFinite(node)) throw regionLimitError(`${label} must be a finite JSON number`);
        append(JSON.stringify(node));
        return;
      }
      case 'string': {
        // Well-formedness: strip valid pairs; any surviving surrogate is lone.
        if (/[\uD800-\uDFFF]/.test(node.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) {
          throw regionLimitError(`${label} contains unpaired surrogates`);
        }
        const encoded = JSON.stringify(node);
        const cost = utf8ByteLength(encoded);
        if (cost > REGION_V16_MAX_STRING_BYTES) {
          throw regionLimitError(`annotated-text-region-limit: operated v16 string exceeds ${REGION_V16_MAX_STRING_BYTES} UTF-8 bytes`);
        }
        append(encoded);
        return;
      }
      case 'object': {
        if (Array.isArray(node)) {
          append('[');
          node.forEach((child, index) => {
            if (index > 0) append(',');
            visit(child, depth + 1);
          });
          append(']');
          return;
        }
        const proto = Object.getPrototypeOf(node);
        if (proto !== Object.prototype && proto !== null) {
          throw regionLimitError(`${label} must contain only plain objects`);
        }
        const names = Object.keys(node).sort();
        append('{');
        names.forEach((name, index) => {
          if (index > 0) append(',');
          visit(name, depth + 1);
          append(':');
          visit((node as Record<string, unknown>)[name], depth + 1);
        });
        append('}');
        return;
      }
      default:
        throw regionLimitError(`${label} contains an unsupported value type`);
    }
  };
  visit(value, 1);
  return out.join('');
}
