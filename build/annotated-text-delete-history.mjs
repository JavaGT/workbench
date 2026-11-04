// Private delete-contribution algebra for annotated-text history (#133,
// Phase A of docs/reviews/sol-day-2026-08-23/delete-undo-design.md §3/§11).
//
// A text deletion is captured as ONE narrow private fact (version 3): the
// exact canonical scalar spans the forward delete consumed, the structural
// insertion gap that survives tombstoning, the deleted text in RGA order, and
// the annotation membership deltas with complete images for emptied rows.
// Undo (Phase D) compensates with a FRESH RGA insertion at the recorded gap —
// it never revives the dead operation identity — and restores only annotation
// contributions whose post-delete state still matches the captured CAS
// expectations.
//
// This module owns parsing, capture, and applicability planning. It performs
// no DB writes and changes no eligibility: every delete remains a cursor
// barrier until Phase D. Storage producers/consumers for the images live in
// `annotated-text-storage.ts` (one-way dependency: this module never imports
// it at runtime).

import { createHash } from 'node:crypto';

import {
  assertAnchor,
  assertOpId,
  assertUtf16Range,
  assertWellFormedText,
  compareOpIdValidated,
  scalarCount,
} from './annotated-text.mjs';

import {
  insertAnchorForOffset,
  materializeText,
  projectEndpointToOffset,
  resolveOffsetToEndpoint,
} from './annotated-text-continuous.mjs';

import { rgaTraversal } from './annotated-text-family.mjs';

import { membershipDigest } from './annotated-text-delete-history-shared.mjs';
export { membershipDigest } from './annotated-text-delete-history-shared.mjs';

export const DELETE_FACT_VERSION = 3;
export const DELETE_FACT_KIND = 'annotated-text.delete-contribution';

/** Fact-size guards: oversized captures are rejected, never stored. */





const DEFAULT_LIMITS                             = { maxBytes: 1024 * 1024, maxAnnotationImages: 4096 };



/** One contiguous run of element ordinals of a single operation, in the exact canonical shape the forward delete operation carries. */


/**
 * Annotation range coordinates relative to the deleted window in UNICODE
 * SCALAR indexes (never UTF-16 indexes): Undo binds restored endpoints directly
 * to the fresh insert contribution's scalars, so a collaborator's insertion at
 * the same gap can never be absorbed into a restored range.
 */



















/**
 * Immutable image of one annotation affected by the delete. `fields` carries
 * the declaration's canonical SERIALIZED field values (the stored cells), not
 * projected recipient values. For a `deleted` disposition the row is removed
 * by the `empty: 'delete'` policy and `expectedPostDelete` is null; for a
 * `retained` annotation it is the digest of the annotation's COMPLETE
 * post-delete membership set (compare-and-compensate expectation).
 */




























/** Storage-side capture view of one annotation (loaded rows, parsed endpoints). */






















/** Current-state view of one annotation used by applicability planning. */













function fail(message        )        {
  throw new TypeError(`annotated-text delete history: ${message}`);
}

function deepFreeze   (value   )    {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value                           )) deepFreeze(child);
  return Object.freeze(value)     ;
}

function declarationTargetName(descriptor         )                {
  const target = (descriptor                                           )?.target;
  if (typeof target === 'string') return target;
  if (target && typeof target === 'object' && typeof (target                      ).name === 'string') return (target                    ).name;
  return null;
}

/**
 * Project-field column on the ref target that guards generated triggers
 * (src/annotated-text-field.ts) — two refs can name the same entity but bind
 * different project columns, producing incompatible storage shapes.
 */
function declarationTargetProjectField(descriptor         )                {
  const target = (descriptor                                                                                                         )?.target;
  if (!target || typeof target !== 'object') return null;
  if (typeof (target                                         ).project?.fieldName === 'string') return (target                                      ).project.fieldName;
  if ((target                                      ).fields && typeof (target                                    ).fields.project === 'object') return 'project';
  return null;
}

/** SHA-256 identity of the extension-row shape used by affected annotation families. */
export function annotationDeclarationFingerprint(declarations                                      , relevantFamilies                  )         {
  const byName = new Map([...declarations].map((declaration) => [declaration.annotationName, declaration]));
  const families = [...new Set(relevantFamilies)].sort().map((family) => {
    const declaration = byName.get(family);
    if (!declaration) fail(`declaration fingerprint cannot resolve annotation family '${family}'`);
    return {
      family,
      kind: declaration.kind ?? null,
      empty: declaration.empty ?? null,
      cardinality: declaration.cardinality ?? null,
      protects: declaration.protects ?? null,
      fields: Object.keys(declaration.fields).sort().map((name) => {
        const descriptor = declaration.fields[name]                                              ;
        return {
          name,
          kind: descriptor?.kind ?? null,
          type: descriptor?.type ?? null,
          optional: descriptor?.optional === true,
          nullable: descriptor?.nullable === true,
          target: descriptor?.type === 'ref' ? declarationTargetName(descriptor) : null,
          targetProjectField: descriptor?.type === 'ref' ? declarationTargetProjectField(descriptor) : null,
        };
      }),
    };
  });
  return createHash('sha256').update(JSON.stringify(families)).digest('hex');
}

// ---------------------------------------------------------------------------
// Unicode scalar <-> UTF-16 conversion
// ---------------------------------------------------------------------------

function isHighSurrogate(unit        )          {
  return unit >= '\uD800' && unit <= '\uDBFF';
}

function isLowSurrogate(unit        )          {
  return unit >= '\uDC00' && unit <= '\uDFFF';
}

/** Convert an absolute UTF-16 offset to a unicode scalar index, rejecting offsets that split a surrogate pair. */
export function utf16OffsetToScalarIndex(text        , offset        )         {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) fail(`offset ${offset} is outside text`);
  let scalar = 0;
  let unit = 0;
  while (unit < offset) {
    const width = isHighSurrogate(text[unit]) && unit + 1 < offset && isLowSurrogate(text[unit + 1]) ? 2 : 1;
    if (width === 1 && isHighSurrogate(text[unit]) && isLowSurrogate(text[unit + 1])) fail('offset splits a surrogate pair');
    unit += width;
    scalar += 1;
  }
  return scalar;
}

/** Convert a unicode scalar index to the absolute UTF-16 offset where that scalar starts. */
export function scalarIndexToUtf16Offset(text        , scalarIndex        )         {
  if (!Number.isSafeInteger(scalarIndex) || scalarIndex < 0) fail('scalar index must be a non-negative safe integer');
  let scalar = 0;
  let unit = 0;
  while (scalar < scalarIndex) {
    if (unit >= text.length) fail('scalar index is outside text');
    unit += text.codePointAt(unit)  > 0xffff ? 2 : 1;
    scalar += 1;
  }
  return unit;
}

/** Convert a UTF-16 window to scalar-index boundaries; both edges must land between scalars. */
export function utf16RangeToScalarWindow(text        , start        , end        )                                             {
  return { startScalar: utf16OffsetToScalarIndex(text, start), endScalar: utf16OffsetToScalarIndex(text, end) };
}

// ---------------------------------------------------------------------------
// Forward-delete capture
// ---------------------------------------------------------------------------

function elementKeyOf(op      , ordinal        )         {
  return `${op[0]}:${op[1]}:${ordinal}`;
}

/**
 * The canonical scalar spans a forward delete over `[fromUtf16, toUtf16)`
 * consumes: every live element fully inside the window, grouped into
 * contiguous per-operation ordinal runs, operations ordered by `compareOpId`.
 * Each RGA element carries exactly one scalar and offsets never split
 * surrogates, so elements are always fully inside or fully outside.
 *
 * The window is in LIVE-text coordinates (the same scalar sequence
 * `materializeText` produces): tombstones (deleted elements) contribute
 * nothing to the running offset, so a window after a deleted collaborator
 * scalar resolves against the exact text it is measured against (hostile
 * review MAJOR 3 — shared-codec twin of the liveInsertWindow fix).
 */
export function deleteScalarSpans(family                      , fromUtf16        , toUtf16        )               {
  const spans               = [];
  const byOp = new Map                                          ();
  let offset = 0;
  for (const [, element] of rgaTraversal(family.checkpoint)) {
    if (element.deletedBy.length > 0) continue;
    const width = element.scalar.length;
    if (offset >= fromUtf16 && offset + width <= toUtf16) {
      const key = `${element.op[0]}:${element.op[1]}`;
      const entry = byOp.get(key);
      if (entry) entry.ordinals.push(element.ordinal);
      else byOp.set(key, { op: element.op, ordinals: [element.ordinal] });
    }
    offset += width;
  }
  const ordered = [...byOp.values()].sort((left, right) => compareOpIdValidated(left.op, right.op));
  for (const { op, ordinals } of ordered) {
    ordinals.sort((a, b) => a - b);
    let first = ordinals[0];
    let count = 1;
    for (let i = 1; i < ordinals.length; i += 1) {
      if (ordinals[i] === ordinals[i - 1] + 1) {
        count += 1;
      } else {
        spans.push(Object.freeze([op, first, count]));
        first = ordinals[i];
        count = 1;
      }
    }
    spans.push(Object.freeze([op, first, count]));
  }
  return spans.map((span) => Object.freeze(span));
}

function relativeRangeForWindow(family                      , text        , fromUtf16        , toUtf16        , ordinal        , start                    , end                    )                {
  const rangeStart = projectEndpointToOffset(family, start);
  const rangeEnd = projectEndpointToOffset(family, end);
  const clippedStart = Math.max(rangeStart, fromUtf16);
  const clippedEnd = Math.min(rangeEnd, toUtf16);
  return deepFreeze({
    ordinal,
    startScalar: utf16OffsetToScalarIndex(text, clippedStart - fromUtf16),
    endScalar: utf16OffsetToScalarIndex(text, clippedEnd - fromUtf16),
  });
}

/**
 * Capture the private delete fact for a forward delete over absolute UTF-16
 * offsets. `annotations` are the storage-loaded images of the document's
 * annotations (see `annotated-text-storage.ts`). Every annotation membership
 * INTERSECTING the window is captured — not only annotations emptied by the
 * `empty: 'delete'` policy — because true partial-delete Undo must restore
 * preimage coverage. Document-scoped measurements are intentionally absent:
 * no measurement coupling exists, and one would belong in this same fact.
 *
 * Pure: reads the family and the provided images only; emits no operations.
 */
export function captureDeleteContribution({ documentId, family, fromUtf16, toUtf16, annotations = [], declarations = [], limits }







 )             {
  if (typeof documentId !== 'string' || documentId.length === 0) fail('documentId must be a non-empty string');
  const text = assertWellFormedText(materializeText(family));
  assertUtf16Range(text, fromUtf16, toUtf16);
  if (annotations.length > DEFAULT_LIMITS.maxAnnotationImages) fail('too many annotation images');
  const deletedText = text.slice(fromUtf16, toUtf16);
  const scalars = scalarCount(deletedText);
  const spans = deleteScalarSpans(family, fromUtf16, toUtf16);
  const spanScalars = spans.reduce((total, span) => total + span[2], 0);
  if (spanScalars !== scalars) fail('scalar spans do not account for the deleted text');

  const gapAnchor         = fromUtf16 === 0 ? Object.freeze(['root']) : insertAnchorForOffset(family, fromUtf16);

  const images                    = [];
  for (const annotation of annotations) {
    const affected                  = [];
    let survivingWidth = 0;
    for (const membership of annotation.memberships) {
      const start = projectEndpointToOffset(family, membership.start);
      const end = projectEndpointToOffset(family, membership.end);
      const overlap = Math.min(end, toUtf16) - Math.max(start, fromUtf16);
      if (overlap <= 0) {
        survivingWidth += end - start;
        continue;
      }
      affected.push(relativeRangeForWindow(family, text, fromUtf16, toUtf16, membership.ordinal, membership.start, membership.end));
      survivingWidth += (end - start) - overlap;
    }
    if (affected.length === 0) continue;
    // An annotation emptied under `empty: 'orphan'` keeps its row plus
    // orphan_state; the delete fact owns only `deleted`/`retained`
    // dispositions, so orphan-policy collapse is not restorable here.
    const metadata = annotation                                               ;
    const emptied = survivingWidth === 0;
    if (emptied && metadata.empty === 'orphan') continue;
    images.push(deepFreeze({
      id: annotation.id,
      family: annotation.family,
      fields: deepFreeze(canonicalFieldRecord(annotation.fields)),
      protectedTargetIds: Object.freeze([...annotation.protectedTargetIds].sort()),
      ranges: Object.freeze(affected),
      expectedPostDelete: emptied ? null : membershipDigest(annotation.memberships),
      disposition: emptied ? 'deleted' : 'retained',
      prerequisites: Object.freeze([...annotation.prerequisites].sort((left, right) => {
        const leftKey = `${left.entity}\u0000${left.id}`;
        const rightKey = `${right.entity}\u0000${right.id}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })),
    }));
  }
  images.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const declarationFingerprint = annotationDeclarationFingerprint(declarations, images.map((image) => image.family));

  const fact             = deepFreeze({
    version: DELETE_FACT_VERSION,
    kind: DELETE_FACT_KIND,
    documentId,
    declarationFingerprint,
    contribution: deepFreeze({
      kind: 'text.delete',
      deletedSpans: Object.freeze(spans),
      gapAnchor,
      text: deletedText,
      scalarCount: scalars,
      annotations: Object.freeze(images),
    }),
  });
  assertDeleteFactLimits(fact, limits);
  return fact;
}

function assertDeleteFactLimits(fact            , limits                   )       {
  const resolved = { ...DEFAULT_LIMITS, ...limits };
  const bytes = Buffer.byteLength(JSON.stringify(fact));
  if (bytes > resolved.maxBytes) fail(`delete fact is ${bytes} bytes, above the ${resolved.maxBytes} byte limit`);
  if (fact.contribution.annotations.length > resolved.maxAnnotationImages) fail('delete fact carries too many annotation images');
}

// ---------------------------------------------------------------------------
// Canonical parsing (exact-key, declaration-shaped validation)
// ---------------------------------------------------------------------------

function exactKeys(value        , keys                   )          {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isPlainObject(value         )                                   {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSafeNonNegativeInt(value         )                  {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseScalarSpan(value         , where        )             {
  if (!Array.isArray(value) || value.length !== 3) fail(`${where} must be [opId, first, count]`);
  const [opId, first, count] = value             ;
  let parsedOp      ;
  try {
    parsedOp = assertOpId(opId);
  } catch (error) {
    throw new TypeError(`${where} has an invalid operation ID: ${(error         ).message}`);
  }
  if (!isSafeNonNegativeInt(first) || !isSafeNonNegativeInt(count) || count < 1) fail(`${where} must carry a non-negative first ordinal and a positive count`);
  return Object.freeze([parsedOp, first, count]);
}

function parseRelativeRanges(value         , scalarCountLimit        , where        )                  {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  const seenOrdinals = new Set        ();
  const ranges                  = [];
  let previousOrdinal = -1;
  for (const entry of value) {
    if (!isPlainObject(entry) || !exactKeys(entry, ['ordinal', 'startScalar', 'endScalar'])) fail(`${where} entries must carry exactly { ordinal, startScalar, endScalar }`);
    const { ordinal, startScalar, endScalar } = entry                           ;
    if (!isSafeNonNegativeInt(ordinal) || seenOrdinals.has(ordinal)) fail(`${where} ordinals must be unique non-negative integers`);
    if (ordinal <= previousOrdinal) fail(`${where} must be ordered by ascending unique ordinal`);
    previousOrdinal = ordinal;
    seenOrdinals.add(ordinal);
    if (!isSafeNonNegativeInt(startScalar) || !isSafeNonNegativeInt(endScalar)) fail(`${where} bounds must be non-negative safe integers`);
    if (startScalar >= endScalar || endScalar > scalarCountLimit) fail(`${where} must be forward and inside the deleted window`);
    ranges.push(deepFreeze({ ordinal, startScalar, endScalar }));
  }
  return ranges;
}

function parsePrerequisites(value         , where        )                           {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  const prerequisites                           = [];
  let previous                = null;
  for (const entry of value) {
    if (!isPlainObject(entry) || !exactKeys(entry, ['entity', 'id'])) fail(`${where} entries must carry exactly { entity, id }`);
    const { entity, id } = entry                           ;
    if (typeof entity !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entity)) fail(`${where} entity must be an identifier`);
    if (typeof id !== 'string' || id.length === 0) fail(`${where} id must be a non-empty string`);
    const signature = `${entity}\u0000${id}`;
    if (previous !== null && signature <= previous) fail(`${where} must be sorted and unique`);
    previous = signature;
    prerequisites.push(Object.freeze({ entity, id }));
  }
  return prerequisites;
}

function parseAnnotationImage(value         , scalarCountLimit        , where        , seenIds             )                  {
  if (!isPlainObject(value) || !exactKeys(value, ['id', 'family', 'fields', 'protectedTargetIds', 'ranges', 'expectedPostDelete', 'disposition', 'prerequisites'])) {
    fail(`${where} must carry exactly { id, family, fields, protectedTargetIds, ranges, expectedPostDelete, disposition, prerequisites }`);
  }
  const record = value                           ;
  const { id, family, fields, protectedTargetIds, ranges, expectedPostDelete, disposition, prerequisites } = record;
  if (typeof id !== 'string' || id.length === 0) fail(`${where}.id must be a non-empty string`);
  if (seenIds.has(id)) fail(`${where} carries a duplicate annotation id '${id}'`);
  seenIds.add(id);
  if (typeof family !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(family)) fail(`${where}.family must be an identifier`);
  if (!isPlainObject(fields)) fail(`${where}.fields must be an object`);
  const fieldNames = Object.keys(fields);
  if (fieldNames.some((name, index) => index > 0 && fieldNames[index - 1] >= name)) fail(`${where}.fields keys must be canonically ordered`);
  for (const fieldValue of Object.values(fields)) jsonSerializable(fieldValue, `${where}.fields`);
  if (!Array.isArray(protectedTargetIds)) fail(`${where}.protectedTargetIds must be an array`);
  let previousTarget                = null;
  for (const targetId of protectedTargetIds) {
    if (typeof targetId !== 'string' || targetId.length === 0) fail(`${where}.protectedTargetIds entries must be non-empty strings`);
    if (previousTarget !== null && targetId <= previousTarget) fail(`${where}.protectedTargetIds must be sorted and unique`);
    previousTarget = targetId;
  }
  const parsedRanges = parseRelativeRanges(ranges, scalarCountLimit, `${where}.ranges`);
  if (expectedPostDelete !== null && (typeof expectedPostDelete !== 'string' || expectedPostDelete.length === 0)) fail(`${where}.expectedPostDelete must be null or a digest string`);
  if (disposition !== 'deleted' && disposition !== 'retained') fail(`${where}.disposition must be 'deleted' or 'retained'`);
  if (disposition === 'deleted' && expectedPostDelete !== null) fail(`${where}: a deleted annotation must expect an absent post-delete state (expectedPostDelete null)`);
  if (disposition === 'retained' && typeof expectedPostDelete !== 'string') fail(`${where}: a retained annotation must carry its post-delete membership digest`);
  return deepFreeze({
    id,
    family,
    fields: deepFreeze({ ...fields }),
    protectedTargetIds: Object.freeze([...protectedTargetIds            ]),
    ranges: Object.freeze(parsedRanges),
    expectedPostDelete,
    disposition,
    prerequisites: Object.freeze(parsePrerequisites(prerequisites, `${where}.prerequisites`)),
  });
}

function jsonSerializable(value         , where        )       {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${where} must be finite`);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) jsonSerializable(entry, where);
    return;
  }
  if (isPlainObject(value)) {
    for (const entry of Object.values(value)) jsonSerializable(entry, where);
    return;
  }
  fail(`${where} must be JSON-serializable`);
}

/**
 * Validate and restore an exact canonical delete fact. Rejects unknown keys,
 * malformed spans/anchors/ranges, duplicate IDs, non-canonical array ordering,
 * inconsistent dispositions, and facts above the configured size limits.
 * Declaration-aware field/prerequisite validation happens where the compiled
 * declaration is available (`annotated-text-storage.ts`).
 */
export function parseDeleteFact(raw         , limits                   )             {
  if (!isPlainObject(raw) || !exactKeys(raw, ['version', 'kind', 'documentId', 'declarationFingerprint', 'contribution'])) {
    fail('fact must carry exactly { version, kind, documentId, declarationFingerprint, contribution }');
  }
  const record = raw                           ;
  if (record.version !== DELETE_FACT_VERSION) fail(`fact version must be ${DELETE_FACT_VERSION}`);
  if (record.kind !== DELETE_FACT_KIND) fail(`fact kind must be '${DELETE_FACT_KIND}'`);
  if (typeof record.documentId !== 'string' || record.documentId.length === 0) fail('documentId must be a non-empty string');
  if (typeof record.declarationFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.declarationFingerprint)) fail('declarationFingerprint must be a SHA-256 digest');
  const contributionRaw = record.contribution;
  if (!isPlainObject(contributionRaw) || !exactKeys(contributionRaw, ['kind', 'deletedSpans', 'gapAnchor', 'text', 'scalarCount', 'annotations'])) {
    fail('contribution must carry exactly { kind, deletedSpans, gapAnchor, text, scalarCount, annotations }');
  }
  const contribution = contributionRaw                           ;
  if (contribution.kind !== 'text.delete') fail("contribution kind must be 'text.delete'");
  if (!Array.isArray(contribution.deletedSpans) || contribution.deletedSpans.length === 0) fail('deletedSpans must be a non-empty array');
  const spans               = [];
  let previous                    = null;
  for (const span of contribution.deletedSpans) {
    const parsed = parseScalarSpan(span, 'deletedSpans entry');
    if (previous) {
      const order = compareOpIdValidated(previous[0], parsed[0]);
      if (order > 0 || (order === 0 && parsed[1] <= previous[1])) fail('deletedSpans must be canonically ordered');
      if (order === 0 && previous[1] + previous[2] >= parsed[1]) fail('deletedSpans of one operation must not overlap or be mergeable');
    }
    previous = parsed;
    spans.push(parsed);
  }
  let gapAnchor        ;
  try {
    gapAnchor = assertAnchor(contribution.gapAnchor);
  } catch (error) {
    throw new TypeError(`gapAnchor is invalid: ${(error         ).message}`);
  }
  if (typeof contribution.text !== 'string' || contribution.text.length === 0) fail('text must be a non-empty string');
  let text        ;
  try {
    text = assertWellFormedText(contribution.text);
  } catch (error) {
    throw new TypeError(`text is malformed: ${(error         ).message}`);
  }
  if (contribution.scalarCount !== scalarCount(text)) fail('scalarCount must equal the deleted text scalar length');
  const scalars = contribution.scalarCount          ;
  const spanScalars = spans.reduce((total, span) => total + span[2], 0);
  if (spanScalars !== scalars) fail('deletedSpans must account for exactly scalarCount elements');
  if (!Array.isArray(contribution.annotations)) fail('annotations must be an array');
  const seenIds = new Set        ();
  const images = contribution.annotations.map((entry, index) => parseAnnotationImage(entry, scalars, `annotations[${index}]`, seenIds));
  if (images.some((image, index) => index > 0 && images[index - 1].id >= image.id)) fail('annotations must be canonically ordered by id');

  const fact             = deepFreeze({
    version: DELETE_FACT_VERSION,
    kind: DELETE_FACT_KIND,
    documentId: record.documentId,
    declarationFingerprint: record.declarationFingerprint,
    contribution: deepFreeze({
      kind: 'text.delete',
      deletedSpans: Object.freeze(spans),
      gapAnchor,
      text,
      scalarCount: scalars,
      annotations: Object.freeze(images),
    }),
  });
  assertDeleteFactLimits(fact, limits);
  return fact;
}

/** Canonical serialized bytes of a validated delete fact. */
export function serializeDeleteFact(fact            )         {
  return JSON.stringify(parseDeleteFact(fact));
}

export function isDeleteFact(value         )                      {
  try {
    parseDeleteFact(value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Applicability planning (compare-and-compensate preconditions)
// ---------------------------------------------------------------------------

function anchorExists(family                      , anchor        )          {
  if (anchor[0] === 'root') return true;
  // Anchors survive tombstoning: any element record qualifies, deleted or not.
  const [op, ordinal] = anchor[1];
  return Object.hasOwn(family.checkpoint.elements, elementKeyOf(op, ordinal));
}

/**
 * Evaluate every pure Undo precondition of a delete fact against the CURRENT
 * family and annotation views. Validation finishes before any write is
 * constructed; a failed precondition yields a durable-noop plan, never a
 * partial compensation.
 *
 * Laws enforced here (design §1): compare-and-compensate (a changed annotation
 * blocks the whole move), erasure (absent prerequisites block it), and
 * isolation (the gap anchor must still exist, including as a tombstone).
 * Cardinality-one geometry is judged against the fresh insert at restore time
 * (Phase D), where the restored scalars exist.
 */
export function planDeleteUndo({ fact, family, annotations, declarations = [], prerequisiteLiveness, protectedTargetValidation }








 )                 {
  const { contribution } = fact;
  if (!anchorExists(family, contribution.gapAnchor)) {
    return Object.freeze({ outcome: 'noop', code: 'missing-anchor', reason: 'the recorded gap anchor no longer exists in the document' });
  }
  let currentDeclarationFingerprint        ;
  try {
    currentDeclarationFingerprint = annotationDeclarationFingerprint(declarations, contribution.annotations.map((image) => image.family));
  } catch (error) {
    return Object.freeze({ outcome: 'noop', code: 'declaration-drift', reason: `annotation declaration drift: ${(error         ).message}` });
  }
  if (currentDeclarationFingerprint !== fact.declarationFingerprint) {
    return Object.freeze({ outcome: 'noop', code: 'declaration-drift', reason: 'annotation declaration drift: current extension-row shape differs from the captured fact' });
  }
  const currentById = new Map((annotations ?? []).map((annotation) => [annotation.id, annotation]));
  for (const image of contribution.annotations) {
    if (image.disposition === 'deleted') {
      if (currentById.has(image.id)) {
        return Object.freeze({ outcome: 'noop', code: 'annotation-id-collision', reason: `annotation '${image.id}' was recreated while absent; restoring would overwrite a collaborator's edit` });
      }
      continue;
    }
    const current = currentById.get(image.id);
    if (!current) {
      return Object.freeze({ outcome: 'noop', code: 'annotation-changed', reason: `retained annotation '${image.id}' is missing` });
    }
    if (current.family !== image.family) {
      return Object.freeze({ outcome: 'noop', code: 'annotation-changed', reason: `retained annotation '${image.id}' changed family` });
    }
    if (JSON.stringify(canonicalFieldRecord(current.fields)) !== JSON.stringify(canonicalFieldRecord(image.fields))) {
      return Object.freeze({ outcome: 'noop', code: 'annotation-changed', reason: `retained annotation '${image.id}' changed fields` });
    }
    if (membershipDigest(current.memberships) !== image.expectedPostDelete) {
      return Object.freeze({ outcome: 'noop', code: 'annotation-changed', reason: `retained annotation '${image.id}' membership set moved after the delete` });
    }
  }
  const capturedById = new Map(contribution.annotations.map((image) => [image.id, image]));
  for (const image of contribution.annotations) {
    for (const prerequisite of image.prerequisites) {
      if (!prerequisiteLiveness || !prerequisiteLiveness(prerequisite)) {
        return Object.freeze({ outcome: 'noop', code: 'prerequisite-missing', reason: `prerequisite ${prerequisite.entity}:${prerequisite.id} could not be proven live` });
      }
    }
    for (const targetId of image.protectedTargetIds) {
      const target = capturedById.get(targetId) ?? currentById.get(targetId);
      if (!target || !protectedTargetValidation || !protectedTargetValidation(image, target)) {
        return Object.freeze({ outcome: 'noop', code: 'protected-target-invalid', reason: `protected target '${targetId}' could not be proven live and valid for '${image.id}'` });
      }
    }
  }
  return Object.freeze({ outcome: 'applied' });
}

function canonicalFieldRecord(fields                                   )                                    {
  return Object.fromEntries(Object.keys(fields).sort().map((name) => [name, fields[name]]));
}

// ---------------------------------------------------------------------------
// Fresh-insert geometry
// ---------------------------------------------------------------------------

/**
 * The RGA element keys a restored RelativeRange will cover once Undo's fresh
 * insert contribution (`insertedOpId`) lands. Restored endpoints bind ONLY to
 * these fresh scalars — never to a collaborator's concurrent insertion at the
 * same gap.
 */
export function relativeRangeCovers(relative               , insertedOpId      )           {
  const keys           = [];
  for (let scalar = relative.startScalar; scalar < relative.endScalar; scalar += 1) {
    keys.push(elementKeyOf(insertedOpId, scalar));
  }
  return keys;
}

/**
 * The structural anchor Undo inserts at: exactly the recorded gap, resolved as
 * the surviving structural neighbor left of the deleted window. Root for
 * offset zero; otherwise the anchor captured in the fact.
 */
export function undoInsertAnchor(fact            )         {
  return fact.contribution.gapAnchor;
}

/** Visible text of the surviving structural neighbor left of `offset`, for tests and diagnostics. */
export function structuralNeighborLeftOf(family                      , offset        )                {
  if (offset === 0) return null;
  const anchor = insertAnchorForOffset(family, offset);
  if (anchor[0] === 'root') return null;
  const element = family.checkpoint.elements[elementKeyOf(anchor[1][0], anchor[1][1])];
  return element ? element.scalar : null;
}

// Re-export for storage-side producers so both modules share one canonicalizer.
export { resolveOffsetToEndpoint };
