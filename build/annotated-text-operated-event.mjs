// Sole durable operated-envelope grammar (scope#992 W1 / Finding 1).
// normalizeOperatedEvent is the only version gate. Reducers consume the
// canonical form and do not branch on a wire version for kind dispatch.
// Envelope construction lives only in this module.

import { createHash } from 'node:crypto';



// TS7 (tsgo 7.0.2) mis-narrows `readonly Readonly<...>` element types on this
// union's create arm to `never`, so the annotation payload is spelled out.






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
} from './annotated-text-region-limits.mjs';

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
]         ;

export const OPERATED_ENVELOPE_KEYS = ['after', 'before', 'facts', 'id', 'operation', 'version']         ;





































































// Semantic atomic annotation update (#174): fields (and optionally the range)
// of an EXISTING annotation as one history step. `selection` is null when the
// range is unchanged; `annotation` carries the complete post-image.
// `historyAuthored` marks undo/redo compensations, which restore verbatim
// captured images (historical endpoint bases) rather than planner offsets.

















































export function packOperatedFacts(data                                                      )                {
  const arrays = (value         ) => Object.freeze(value ?? []);
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
  })                 ;
}

function isPlainObject(value         )                                   {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value        , keys                   )          {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function invalidEnvelope(entity        , field        , version         )        {
  throw new Error(`${entity}.${field}.operated v${version} event has invalid envelope`);
}

function isTextRevision(value         )                        {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value          ).sort().join() === 'frontier,structuralRevision'
    && Number.isSafeInteger((value                ).structuralRevision)
    && (value                ).structuralRevision >= 1
    && Array.isArray((value                ).frontier);
}

function parseFacts(facts         , entity        , field        , version         )                {
  if (!isPlainObject(facts)) invalidEnvelope(entity, field, version);
  const f = facts                           ;
  // Accept both the legacy 10-key set (v14 events stored before
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
  return packOperatedFacts(f);
}

function familyProofFor(family         , entity        , field        , version         )              {
  if (family !== null) invalidEnvelope(entity, field, version);
  return Object.freeze({ kind: 'derive-and-check-frontier' });
}

function serializedUtf8Bytes(value         , label        )         {
  let serialized        ;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw regionLimitError(`${label} must be JSON-serializable`);
  }
  return utf8ByteLength(serialized);
}

function preflightV16Payload(raw                         , operation                         , entity        , field        )       {
  const label = `${entity}.${field}.operated v16`;
  if (serializedUtf8Bytes(operation, `${label} operation`) > REGION_DESCRIPTOR_MAX_UTF8_BYTES) {
    throw regionLimitError(`${label} operation exceeds ${REGION_DESCRIPTOR_MAX_UTF8_BYTES} UTF-8 bytes`);
  }
  if (serializedUtf8Bytes(raw, `${label} payload`) > REGION_DESCRIPTOR_MAX_UTF8_BYTES) {
    throw regionLimitError(`${label} payload exceeds ${REGION_DESCRIPTOR_MAX_UTF8_BYTES} UTF-8 bytes`);
  }

  let memberships = 0;
  let protectedEdges = 0;
  let prerequisites = 0;
  const visit = (value         , key = '', underText = false)       => {
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

function parseRegionText(value         , entity        , field        )                       {
  if (!isPlainObject(value) || typeof value.kind !== 'string') invalidEnvelope(entity, field, 16);
  if (value.kind === 'none' && exactKeys(value, ['kind'])) return Object.freeze({ kind: 'none' });
  if (value.kind === 'delete' && exactKeys(value, ['kind', 'operation']) && Array.isArray(value.operation)) {
    return Object.freeze({ kind: 'delete', operation: value.operation });
  }
  if (value.kind === 'insert' && exactKeys(value, ['kind', 'operation']) && Array.isArray(value.operation)) {
    return Object.freeze({ kind: 'insert', operation: value.operation });
  }
  if (value.kind === 'replace' && exactKeys(value, ['kind', 'operations']) && Array.isArray(value.operations) && value.operations.length === 2) {
    return Object.freeze({ kind: 'replace', operations: Object.freeze([...value.operations])                                });
  }
  invalidEnvelope(entity, field, 16);
}

const RANGE_KEYS = ['end', 'start']         ;
const RANGE_SET_KEYS = ['annotationId', 'kind', 'ranges']         ;
const REMOVE_KEYS = ['annotationId', 'kind']         ;
const CREATE_KEYS = ['annotation', 'kind', 'ranges']         ;
const CREATE_ANNOTATION_KEYS = ['family', 'fields', 'id', 'protectedTargetIds']         ;

function parseV16Range(value         , entity        , field        )                                           {
  if (!isPlainObject(value) || !exactKeys(value, RANGE_KEYS)) invalidEnvelope(entity, field, 16);
  const { start, end } = value                                    ;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (end          ) <= (start          )) {
    invalidEnvelope(entity, field, 16);
  }
  return Object.freeze({ start: start          , end: end           });
}

function parseV16Ranges(value         , entity        , field        )                                                      {
  if (!Array.isArray(value)) invalidEnvelope(entity, field, 16);
  return Object.freeze(value.map((entry) => parseV16Range(entry, entity, field)));
}

function isStrictlySortedNonEmptyStrings(value         )                    {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== 'string' || entry.length === 0) return false;
    if (index > 0 && value[index - 1] >= entry) return false;
  }
  return true;
}

function parseOptionalLastRange(value         , entity        , field        )                                   {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2 || !Number.isSafeInteger(value[0]) || !Number.isSafeInteger(value[1])) {
    invalidEnvelope(entity, field, 16);
  }
  return value                                        ;
}

function parseV16CreateAnnotation(value         , entity        , field        )                             {
  if (!isPlainObject(value) || !exactKeys(value, CREATE_ANNOTATION_KEYS)) invalidEnvelope(entity, field, 16);
  const { id, family, fields, protectedTargetIds } = value

   ;
  if (typeof id !== 'string' || id.length === 0 || typeof family !== 'string' || family.length === 0) {
    invalidEnvelope(entity, field, 16);
  }
  if (!isPlainObject(fields)) invalidEnvelope(entity, field, 16);
  const fieldNames = Object.keys(fields);
  if (fieldNames.some((name, index) => index > 0 && fieldNames[index - 1] >= name)) invalidEnvelope(entity, field, 16);
  if (!isStrictlySortedNonEmptyStrings(protectedTargetIds)) {
    invalidEnvelope(entity, field, 16);
  }
  return Object.freeze({
    id,
    family,
    fields: Object.freeze({ ...fields }),
    protectedTargetIds: Object.freeze([...protectedTargetIds]),
  })                              ;
}

// Every wire transition is validated through the same closed grammar as
// planning's descriptor parser (region-descriptor.ts) before the reducer sees
// it. A forged range.set naming a missing/unknown annotation, a malformed
// create payload, or an unknown kind is rejected below with the canonical
// `<entity>.<field>.operated v16 event has invalid envelope` signature, so the
// reducer can never silently drop a transition while text still commits.
function parseV16Transition(value         , entity        , field        , seenIds             )                       {
  if (!isPlainObject(value) || typeof value.kind !== 'string') invalidEnvelope(entity, field, 16);
  const kind = value.kind;
  if (kind === 'range.set') {
    if (!exactKeys(value, RANGE_SET_KEYS)) invalidEnvelope(entity, field, 16);
    const annotationId = value.annotationId;
    if (typeof annotationId !== 'string' || annotationId.length === 0) invalidEnvelope(entity, field, 16);
    if (seenIds.has(annotationId)) invalidEnvelope(entity, field, 16);
    seenIds.add(annotationId);
    return Object.freeze({ kind: 'range.set', annotationId, ranges: parseV16Ranges(value.ranges, entity, field) });
  }
  if (kind === 'remove') {
    if (!exactKeys(value, REMOVE_KEYS)) invalidEnvelope(entity, field, 16);
    const annotationId = value.annotationId;
    if (typeof annotationId !== 'string' || annotationId.length === 0) invalidEnvelope(entity, field, 16);
    if (seenIds.has(annotationId)) invalidEnvelope(entity, field, 16);
    seenIds.add(annotationId);
    return Object.freeze({ kind: 'remove', annotationId });
  }
  if (kind === 'create') {
    if (!exactKeys(value, CREATE_KEYS)) invalidEnvelope(entity, field, 16);
    const annotation = parseV16CreateAnnotation(value.annotation, entity, field);
    if (seenIds.has(annotation.id)) invalidEnvelope(entity, field, 16);
    seenIds.add(annotation.id);
    return Object.freeze({ kind: 'create', annotation, ranges: parseV16Ranges(value.ranges, entity, field) });
  }
  invalidEnvelope(entity, field, 16);
}

// V16 closed operation grammar: the v16 region.edit surface plus the complete
// bounded before/after witness (declarationFingerprint, emptied, witnessBefore,
// witnessAfter). Unknown keys reject; every nested value passes the same
// canonical checks the constructor applied before the bytes were stored. All
// validation lives in this one parser — there is no second, narrower
// region-operation grammar beside it.
function parseV16Operation(operation                         , entity        , field        )                                                                                                 {
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
  if (!Number.isSafeInteger(operation.from) || !Number.isSafeInteger(operation.to) || (operation.to          ) < (operation.from          )) {
    invalidEnvelope(entity, field, 16);
  }
  if (typeof operation.beforeDigest !== 'string' || !SHA256_HEX.test(operation.beforeDigest)) {
    throw regionLimitError(`${entity}.${field}.operated v16 beforeDigest is not a SHA-256 digest`);
  }
  if (typeof operation.afterDigest !== 'string' || !SHA256_HEX.test(operation.afterDigest)) {
    throw regionLimitError(`${entity}.${field}.operated v16 afterDigest is not a SHA-256 digest`);
  }
  if (!Array.isArray(operation.affectedIds) || operation.affectedIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    invalidEnvelope(entity, field, 16);
  }
  if (operation.affectedIds.length > REGION_AFFECTED_ANNOTATION_MAX) {
    throw regionLimitError(`${entity}.${field}.operated v16 affectedIds exceed ${REGION_AFFECTED_ANNOTATION_MAX}`);
  }
  const ids = operation.affectedIds            ;
  if (ids.some((id, index) => index > 0 && ids[index - 1] >= id)) invalidEnvelope(entity, field, 16);
  if (!Array.isArray(operation.transitions) || operation.transitions.length > REGION_TRANSITION_MAX) {
    if (Array.isArray(operation.transitions) && operation.transitions.length > REGION_TRANSITION_MAX) {
      throw regionLimitError(`${entity}.${field}.operated v16 transitions exceed ${REGION_TRANSITION_MAX}`);
    }
    invalidEnvelope(entity, field, 16);
  }
  const seenIds = new Set        ();
  const transitions = Object.freeze(
    (operation.transitions                      ).map((entry) => parseV16Transition(entry, entity, field, seenIds)),
  );
  if (typeof operation.declarationFingerprint !== 'string' || !SHA256_HEX.test(operation.declarationFingerprint)) {
    throw regionLimitError(`${entity}.${field}.operated v16 declarationFingerprint is not a SHA-256 digest`);
  }
  const emptied = parseV16Emptied(operation.emptied, entity, field);
  const witnessBefore = parseV16WitnessSide(operation.witnessBefore, entity, field);
  const witnessAfter = parseV16WitnessSide(operation.witnessAfter, entity, field);
  return Object.freeze({
    kind: 'region.edit',
    from: operation.from          ,
    to: operation.to          ,
    text: parseRegionText(operation.text, entity, field),
    transitions,
    beforeDigest: operation.beforeDigest,
    afterDigest: operation.afterDigest,
    affectedIds: Object.freeze([...ids]),
    declarationFingerprint: operation.declarationFingerprint,
    emptied,
    witnessBefore,
    witnessAfter,
  });
}

const V16_EMPTIED_KEYS = ['annotationId', 'disposition']         ;
const V16_DISPOSITION_KEYS = ['family', 'kind', 'lastRange', 'savedQuote']         ;

function parseV16Emptied(value         , entity        , field        )                             {
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
        savedQuote: disposition.savedQuote                 ,
        lastRange,
      }),
    });
  }));
}

const V16_ORPHAN_KEYS = ['lastRange', 'savedQuote']         ;
const V16_PREREQUISITE_KEYS = ['entity', 'id']         ;
const V16_MEMBERSHIP_KEYS = ['end', 'ordinal', 'start']         ;

function parseV16Endpoint(value         , entity        , field        )          {
  if (!isPlainObject(value)) invalidEnvelope(entity, field, 16);
  const record = value                                                ;
  if (!Object.hasOwn(value, 'point') || !Object.hasOwn(value, 'basisFrontier') || Object.keys(value).length !== 2) {
    invalidEnvelope(entity, field, 16);
  }
  return Object.freeze({ point: record.point, basisFrontier: record.basisFrontier });
}

function parseV16WitnessImage(rawImage         , entity        , field        , seenIds             )                        {
  if (!isPlainObject(rawImage) || !exactKeys(rawImage, V16_WITNESS_IMAGE_KEYS)) invalidEnvelope(entity, field, 16);
  const image = rawImage                           ;
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
    const record = membership                           ;
    if (record.ordinal !== ordinal) invalidEnvelope(entity, field, 16);
    return Object.freeze({
      ordinal,
      start: parseV16Endpoint(record.start, entity, field),
      end: parseV16Endpoint(record.end, entity, field),
    });
  });
  let parsedOrphan                           = null;
  if (orphan !== null) {
    if (!isPlainObject(orphan) || !exactKeys(orphan, V16_ORPHAN_KEYS)) invalidEnvelope(entity, field, 16);
    const record = orphan                           ;
    if (typeof record.savedQuote !== 'string') invalidEnvelope(entity, field, 16);
    parsedOrphan = Object.freeze({
      savedQuote: record.savedQuote,
      lastRange: parseOptionalLastRange(record.lastRange, entity, field),
    });
  }
  if (!Array.isArray(prerequisites)) invalidEnvelope(entity, field, 16);
  const parsedPrerequisites = prerequisites.map((prerequisite) => {
    if (!isPlainObject(prerequisite) || !exactKeys(prerequisite, V16_PREREQUISITE_KEYS)) invalidEnvelope(entity, field, 16);
    const record = prerequisite                           ;
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
  })                         ;
}

function parseV16WitnessSide(value         , entity        , field        )                                   {
  if (!Array.isArray(value)) invalidEnvelope(entity, field, 16);
  const seenIds = new Set        ();
  let previous = '';
  const images = value.map((rawImage) => {
    const image = parseV16WitnessImage(rawImage, entity, field, seenIds);
    if (!(previous < image.id)) {
      throw regionLimitError(`${entity}.${field}.operated v16 witness closure must be sorted and unique`);
    }
    previous = image.id;
    return image;
  });
  return Object.freeze(images)                                    ;
}

export function normalizeOperatedEvent(
  raw         ,
  context                                   ,
)                         {
  return normalizeOperatedEventInternal(raw, context, false);
}

function normalizeOperatedEventInternal(
  raw         ,
  context                                   ,
  skipV16CanonicalCheck         ,
)                         {
  const { entity, field } = context;
  const version = isPlainObject(raw) ? raw.version : undefined;
  if (version !== 14 && version !== 16) {
    throw new Error(`${entity}.${field}.operated event version ${version} is not supported: only operated versions 14 and 16 are replayable; retired versions 13 and 15 and pre-13 lattice rows are rejected (issue #315)`);
  }
  if (!isPlainObject(raw) || !exactKeys(raw, OPERATED_ENVELOPE_KEYS)) {
    invalidEnvelope(entity, field, version);
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0 || !isTextRevision(raw.before) || !isTextRevision(raw.after)
    || !isPlainObject(raw.operation)) {
    invalidEnvelope(entity, field, version);
  }
  if (version === 16) {
    preflightV16Payload(raw, raw.operation, entity, field);
    if (!skipV16CanonicalCheck) {
      // The complete persisted text must itself be canonically bounded before it
      // is trusted for parse; parseStoredV16OperatedEvent already verified it.
      canonicalV16Json(raw, REGION_V16_MAX_EVENT_BYTES, `${entity}.${field}.operated v16`);
    }
  }
  const facts = parseFacts(raw.facts, entity, field, version);
  const familyProof = familyProofFor(facts.family, entity, field, version);
  const operation = raw.operation;
  if (version === 16) {
    const region = parseV16Operation(operation, entity, field);
    return Object.freeze({
      ...region,
      id: raw.id,
      before: raw.before,
      after: raw.after,
      facts,
      familyProof,
      wireVersion: 16,
    });
  }
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
      && Number.isSafeInteger((operation.selection                             ).startOffset)
      && Number.isSafeInteger((operation.selection                           ).endOffset)))) {
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
 * The ONLY parser for persisted v16 `_Log.eventData` text. Uses standard
 * JSON.parse, then structural validation and a canonical byte-for-byte
 * reserialize check. Duplicate keys, noncanonical key order/encoding, trailing
 * bytes, and over-limit payloads all fail that equality check — there is no
 * separate in-process JSON scanner to keep in sync (#315).
 * Returns the same canonical boundary as `normalizeOperatedEvent`.
 */
export function parseStoredV16OperatedEvent(eventDataText        , context                                   )                      {
  const { entity, field } = context;
  if (typeof eventDataText !== 'string' || eventDataText.length === 0) {
    throw new Error(`${entity}.${field}.operated v16 stored envelope is not canonical: shape`);
  }
  let parsed         ;
  const raw = eventDataText;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${entity}.${field}.operated v16 stored envelope is not canonical: ${(error         ).message}`);
  }
  // jsonCanonical enforces depth, byte, and string bounds and rejects any
  // value outside the closed JSON grammar before the equality check below.
  const reserialized = canonicalV16Json(parsed, REGION_V16_MAX_EVENT_BYTES, `${entity}.${field}.operated v16`);
  if (reserialized !== raw) {
    throw new Error(`${entity}.${field}.operated v16 stored envelope is not canonical: order`);
  }
  const version = isPlainObject(parsed) ? parsed.version : undefined;
  if (version !== 16) {
    throw new Error(`${entity}.${field}.operated event version ${version} is not supported: only operated versions 14 and 16 are replayable; retired versions 13 and 15 are rejected (issue #315)`);
  }
  return normalizeOperatedEventInternal(parsed                        , context, true)                       ;
}



















export function constructV14OperatedEvent(data                          )                       {
  return Object.freeze({
    version: 14,
    id: data.id,
    before: data.before,
    after: data.after,
    operation: data.operation,
    facts: packOperatedFacts({ ...data, family: null }),
  });
}

/** Loose revision shape for v16 envelope before/after (TS7-safe element type). */


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
]         ;

/** One complete bounded closure side of a v16 witness. */

/** Emptied dispositions carried by a v16 witness. */


/**
 * The ONLY new-emission region constructor. Takes the planner's validated
 * result (postimage already proven by `assertCompleteRegionWitness`) and
 * returns the frozen canonical envelope plus its canonical UTF-8 JSON text.
 * The text is what `_Log` must store verbatim — appendEvents never re-stringifies
 * a branded v16 event.
 */
export function constructV16RegionEvent(plan            , admission                       )




  {
  // Bounded canonicalization happens FIRST, on a plain (unfrozen) envelope
  // view: an over-limit witness aborts here before the durable envelope is
  // constructed or frozen. The canonical text is then attached as the
  // unforgeable brand and the frozen result returned.
  const eventView = {
    version: 16         ,
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
  const capability = brandV16Event(eventView                     , eventDataText, admission ?? {
    owningScope: '', entity: '', field: '',
    documentId: plan.descriptor.id, actionId: '',
  });
  const event = Object.freeze(eventView)                                                                                                                                                                                                                             ;
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
export function serializeV16OperatedEvent(event                      )         {
  if ((event                         ).version !== 16) {
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
const V16_BRAND                = Symbol('workbench.annotated-text.v16.brand');









/** Install the brand + mint the one-shot nonce capability (sole owner). */
function brandV16Event(
  event        ,
  eventDataText        ,
  identity                      ,
)                    {
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
export function readV16Brand(data         )                                                  {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data                                ;
  const brand = record[V16_BRAND];
  if (!brand || typeof brand !== 'object') return null;
  if (record.version !== 16 || !exactKeys(record, OPERATED_ENVELOPE_KEYS)) {
    return null;
  }
  const stamp = brand                                                ;
  if (typeof stamp.eventDataText !== 'string' || typeof stamp.nonce !== 'string') return null;
  return { eventDataText: stamp.eventDataText, nonce: stamp.nonce };
}

/**
 * The deterministic single-use admission token: binds owning scope, entity,
 * field, document, exact canonical bytes, and the canonical action/append id.
 * Two distinct actions with identical bytes derive distinct nonces; any change
 * to the binding or the bytes changes the nonce and fails verification.
 */
export function v16AdmissionNonce(identity                      , canonicalText        )         {
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
export function v16CapabilityBytesDigest(canonicalText        )         {
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
function canonicalV16Json(value         , maxBytes        , label        )         {
  // One append primitive owns ALL byte accounting: every token's UTF-8 cost is
  // charged the moment it is appended, and traversal aborts IMMEDIATELY when
  // the running total crosses `maxBytes`. No post-traversal pass exists, so an
  // oversized payload can never be fully materialized before rejection.
  const out           = [];
  let bytes = 0;
  const append = (token        )       => {
    const cost = utf8ByteLength(token);
    bytes += cost;
    if (bytes > maxBytes) {
      throw regionLimitError(`annotated-text-region-limit: operated v16 eventData exceeds ${REGION_V16_MAX_EVENT_BYTES} UTF-8 bytes`);
    }
    out.push(token);
  };
  const visit = (node         , depth        )       => {
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
          visit((node                           )[name], depth + 1);
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
