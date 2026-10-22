// Sole v10 public `region.edit` descriptor grammar (scope#992 W1).
// Closed keys only. Bounds are checked before hashing or allocating derived
// structures. This module is the single exported v10 parser/discriminator.

import { assertWellFormedText } from './annotated-text.mjs';

import { ValidationError } from './field-strategy.mjs';
import {
  REGION_DESCRIPTOR_MAX_UTF8_BYTES,
  REGION_REPLACEMENT_MAX_UTF8_BYTES,
  REGION_TRANSITION_MAX,
  assertSha256Digest,
  regionLimitError,
  utf8ByteLength,
} from './annotated-text-region-limits.mjs';

export const REGION_DESCRIPTOR_VERSION = 10;
export const REGION_EDIT_KIND = 'region.edit';










































const DESCRIPTOR_KEYS = [
  'affectedClosureDigest',
  'basis',
  'coveredTextDigest',
  'expectedCoveredAnnotationIds',
  'from',
  'id',
  'kind',
  'replacement',
  'to',
  'transitions',
  'version',
]         ;

const BASIS_KEYS = ['frontier', 'id', 'version']         ;
const RANGE_KEYS = ['end', 'start']         ;
const RANGE_SET_KEYS = ['annotationId', 'kind', 'ranges']         ;
const REMOVE_KEYS = ['annotationId', 'kind']         ;
const CREATE_KEYS = ['annotation', 'kind', 'ranges']         ;
const ANNOTATION_KEYS = ['family', 'fields', 'id', 'protectedTargetIds']         ;

function isPlainObject(value         )                                   {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value        , keys                   )          {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function failClosed(reason        )        {
  throw regionLimitError(`region.edit ${reason}`);
}

function parseNonEmptyId(value         , label        )         {
  if (typeof value !== 'string' || value.length === 0) failClosed(`${label} must be a non-empty string`);
  return value;
}

function parseRelativeRange(value         , label        )                                           {
  if (!isPlainObject(value) || !exactKeys(value, RANGE_KEYS)) failClosed(`${label} must be { start, end }`);
  const start = value.start;
  const end = value.end;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    failClosed(`${label} must be a forward integer range`);
  }
  return Object.freeze({ start, end });
}

function parseRanges(value         , label        )                                                      {
  if (!Array.isArray(value)) failClosed(`${label} must be an array`);
  return Object.freeze(value.map((entry, index) => parseRelativeRange(entry, `${label}[${index}]`)));
}

function parseCreateAnnotation(value         )                                                                  {
  if (!isPlainObject(value) || !exactKeys(value, ANNOTATION_KEYS)) {
    failClosed('create.annotation must be { id, family, fields, protectedTargetIds }');
  }
  const id = parseNonEmptyId(value.id, 'create.annotation.id');
  const family = parseNonEmptyId(value.family, 'create.annotation.family');
  if (!isPlainObject(value.fields)) failClosed('create.annotation.fields must be a non-array object');
  const fieldNames = Object.keys(value.fields);
  if (fieldNames.some((name, index) => index > 0 && fieldNames[index - 1] >= name)) {
    failClosed('create.annotation.fields keys must be canonically ordered');
  }
  if (!Array.isArray(value.protectedTargetIds) || value.protectedTargetIds.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    failClosed('create.annotation.protectedTargetIds must be non-empty strings');
  }
  const targets = value.protectedTargetIds            ;
  if (targets.some((id, index) => index > 0 && targets[index - 1] >= id)) {
    failClosed('create.annotation.protectedTargetIds must be sorted and unique');
  }
  return Object.freeze({
    id,
    family,
    fields: Object.freeze({ ...value.fields }),
    protectedTargetIds: Object.freeze([...targets]),
  });
}

function parseTransition(value         , index        , seenIds             )                       {
  const label = `transitions[${index}]`;
  if (!isPlainObject(value) || typeof value.kind !== 'string') failClosed(`${label} must be a closed transition`);
  if (value.kind === 'range.set') {
    if (!exactKeys(value, RANGE_SET_KEYS)) failClosed(`${label} range.set must be { kind, annotationId, ranges }`);
    const annotationId = parseNonEmptyId(value.annotationId, `${label}.annotationId`);
    if (seenIds.has(annotationId)) failClosed(`${label} names annotation '${annotationId}' more than once`);
    seenIds.add(annotationId);
    return Object.freeze({ kind: 'range.set', annotationId, ranges: parseRanges(value.ranges, `${label}.ranges`) });
  }
  if (value.kind === 'remove') {
    if (!exactKeys(value, REMOVE_KEYS)) failClosed(`${label} remove must be { kind, annotationId }`);
    const annotationId = parseNonEmptyId(value.annotationId, `${label}.annotationId`);
    if (seenIds.has(annotationId)) failClosed(`${label} names annotation '${annotationId}' more than once`);
    seenIds.add(annotationId);
    return Object.freeze({ kind: 'remove', annotationId });
  }
  if (value.kind === 'create') {
    if (!exactKeys(value, CREATE_KEYS)) failClosed(`${label} create must be { kind, annotation, ranges }`);
    const annotation = parseCreateAnnotation(value.annotation);
    if (seenIds.has(annotation.id)) failClosed(`${label} names annotation '${annotation.id}' more than once`);
    seenIds.add(annotation.id);
    return Object.freeze({ kind: 'create', annotation, ranges: parseRanges(value.ranges, `${label}.ranges`) });
  }
  failClosed(`${label} has unknown kind '${value.kind}'`);
}

function parseBasis(value         )                    {
  if (!isPlainObject(value) || !exactKeys(value, BASIS_KEYS) || value.version !== 1) {
    failClosed('basis must be { version: 1, id, frontier }');
  }
  const id = parseNonEmptyId(value.id, 'basis.id');
  if (!Array.isArray(value.frontier)) failClosed('basis.frontier must be an array');
  return Object.freeze({ version: 1, id, frontier: Object.freeze([...(value.frontier            )])             });
}

function parseExpectedIds(value         )                    {
  if (!Array.isArray(value)) failClosed('expectedCoveredAnnotationIds must be an array');
  const ids           = [];
  let previous                = null;
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) failClosed('expectedCoveredAnnotationIds entries must be non-empty strings');
    if (previous !== null && entry <= previous) failClosed('expectedCoveredAnnotationIds must be sorted and unique');
    previous = entry;
    ids.push(entry);
  }
  return Object.freeze(ids);
}

/**
 * Parse the closed v10 `region.edit` descriptor. Unknown keys, bad Unicode,
 * non-canonical order, and over-limit payloads fail before any derived
 * allocation. The planner re-checks identity/digest staleness against live state.
 */
export function parseRegionEditDescriptor(raw         )                       {
  if (raw === null || raw === undefined) failClosed('descriptor is required');
  let serialized        ;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    failClosed('descriptor is not JSON-serializable');
  }
  if (utf8ByteLength(serialized) > REGION_DESCRIPTOR_MAX_UTF8_BYTES) {
    throw regionLimitError(`region.edit descriptor exceeds ${REGION_DESCRIPTOR_MAX_UTF8_BYTES} UTF-8 bytes`);
  }
  if (!isPlainObject(raw) || !exactKeys(raw, DESCRIPTOR_KEYS)) {
    failClosed(`descriptor must carry exactly { ${DESCRIPTOR_KEYS.join(', ')} }`);
  }
  if (raw.version !== REGION_DESCRIPTOR_VERSION) failClosed(`version must be ${REGION_DESCRIPTOR_VERSION}`);
  if (raw.kind !== REGION_EDIT_KIND) failClosed(`kind must be '${REGION_EDIT_KIND}'`);
  const id = parseNonEmptyId(raw.id, 'id');
  const basis = parseBasis(raw.basis);
  if (!Number.isSafeInteger(raw.from) || !Number.isSafeInteger(raw.to) || (raw.from          ) < 0 || (raw.to          ) < (raw.from          )) {
    failClosed('from/to must be a forward in-bounds UTF-16 region');
  }
  const from = raw.from          ;
  const to = raw.to          ;
  if (typeof raw.replacement !== 'string') failClosed('replacement must be a string');
  if (utf8ByteLength(raw.replacement) > REGION_REPLACEMENT_MAX_UTF8_BYTES) {
    throw regionLimitError(`region.edit replacement exceeds ${REGION_REPLACEMENT_MAX_UTF8_BYTES} UTF-8 bytes`);
  }
  let replacement        ;
  try {
    replacement = assertWellFormedText(raw.replacement);
  } catch (error) {
    failClosed(`replacement ${(error         ).message}`);
  }
  if (from === to && replacement.length === 0) {
    throw new ValidationError('empty replacement over an empty region is not a semantic operation', {
      code: 'annotated-text-no-operation',
    });
  }
  const coveredTextDigest = assertSha256Digest(raw.coveredTextDigest, 'coveredTextDigest');
  const affectedClosureDigest = assertSha256Digest(raw.affectedClosureDigest, 'affectedClosureDigest');
  const expectedCoveredAnnotationIds = parseExpectedIds(raw.expectedCoveredAnnotationIds);
  if (!Array.isArray(raw.transitions)) failClosed('transitions must be an array');
  if (raw.transitions.length > REGION_TRANSITION_MAX) {
    throw regionLimitError(`region.edit transitions exceed ${REGION_TRANSITION_MAX}`);
  }
  const seenIds = new Set        ();
  const transitions = Object.freeze(raw.transitions.map((entry, index) => parseTransition(entry, index, seenIds)));
  return Object.freeze({
    version: REGION_DESCRIPTOR_VERSION,
    kind: REGION_EDIT_KIND,
    id,
    basis,
    from,
    to,
    coveredTextDigest,
    affectedClosureDigest,
    expectedCoveredAnnotationIds,
    replacement,
    transitions,
  });
}

export function isRegionEditDescriptor(value         )                                {
  try {
    parseRegionEditDescriptor(value);
    return true;
  } catch {
    return false;
  }
}
