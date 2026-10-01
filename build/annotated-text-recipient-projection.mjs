// Public recipient projection for the blockless annotated-text model (issue #33).
//
// The canonical document is ONE continuous text plus document-scoped
// annotation ranges. A denied protector redacts its range (inline placeholder)
// or, when unprojectable, restricts the whole document (fail closed — never
// partial disclosure). Ranges are mapped from canonical offsets to
// recipient-visible offsets (hidden intervals removed).

import { getAnnotatedTextCompiledMetadata } from './annotated-text-field.mjs';

// Snapshot minting needs the canonical intervals to bind an authoring token,
// but those intervals must never serialize with the recipient.
const recipientRedactionIntervals = new WeakMap          ();

export function authoringRedactionsForRecipient(recipient     ) {
  return recipientRedactionIntervals.get(recipient) ?? [];
}

// The authoring redaction entry a recipient's position frame carries: the
// hidden interval's CANONICAL [start, end) plus the wire (recipient-visible)
// marker position `visibleStart` where it renders. This is the inverse
// coordinate table of the projection: the recipient edits against wire
// offsets, the server maps them back to canonical before planning.






/**
 * Map a redacted recipient's WIRE offset (an index into the projected
 * recipient text, where every denied interval is a zero-width marker at its
 * `visibleStart`) to the canonical offset that offset edits. A collapsed
 * offset AT a marker is the non-editable-gap boundary: affinity selects the
 * visible neighbor ('left' → the interval's canonical start, 'right' → its
 * end). A RANGE endpoint pins to the boundary facing the range's interior
 * (`side` 'right' for a range starting at a marker, 'left' for one ending
 * there), so a selection adjacent to a placeholder deletes visible text only.
 */
export function mapVisibleOffsetToCanonical(offset        , affinity                  , redactions                               , side                          = null)         {
  let hidden = 0;
  for (const redaction of redactions) {
    if (offset < redaction.visibleStart) break;
    if (offset === redaction.visibleStart) {
      if (side === 'left') return redaction.start;
      if (side === 'right') return redaction.end;
      return affinity === 'right' ? redaction.end : redaction.start;
    }
    hidden += redaction.end - redaction.start;
  }
  return offset + hidden;
}

function fail(message        )        { throw new Error(`annotated-text recipient projection: ${message}`); }

function freeze(value     ) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key in value) {
      if (Object.hasOwn(value, key)) freeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function exact(value     , keys          , label        ) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail(`${label} has invalid shape`);
}

const recipientSources = new WeakSet        ();



















function rangesOf(value                             )                                         {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function rangeCollectionsIntersect(left                 , right                 )          {
  const leftRanges = rangesOf(left);
  const rightRanges = rangesOf(right);
  return leftRanges.some((own) => rightRanges.some((target) => own.start < target.end && target.start < own.end));
}












































/** Mint the only source capability accepted by the recipient policy. */
export function createAnnotatedTextRecipientSource(source                              )                               {
  exact(source, ['version', 'text', 'rangeFormat', 'annotations', 'ranges', 'measurements', 'orphans'], 'source');
  if (Object.getPrototypeOf(source) !== Object.prototype) fail('source must be a plain capability object');
  if (typeof source.text !== 'string' || !['offset', 'anchored'].includes(source.rangeFormat)
      || !Array.isArray(source.annotations) || !Array.isArray(source.ranges)
      || !Array.isArray(source.measurements) || !Array.isArray(source.orphans)) fail('source data is invalid');
  const capability = Object.freeze(source);
  recipientSources.add(capability);
  return capability;
}

function freezeArray   (values     )               {
  return Object.freeze(values);
}

function pointShape(value     )         {
  const anchor = value[1];
  return anchor[0] === 'root'
    ? `r:${value[2]}`
    : `e:${anchor[1][0][0]}:${anchor[1][0][1]}:${anchor[1][1]}:${value[2]}`;
}

function internValue(value        , values          , byIdentity                         , byShape                     , shapeOf                        )         {
  const known = byIdentity.get(value);
  if (known !== undefined) return known;
  const shape = shapeOf(value);
  const matching = byShape.get(shape);
  if (matching !== undefined) {
    byIdentity.set(value, matching);
    return matching;
  }
  const index = values.length;
  values.push(value);
  byIdentity.set(value, index);
  byShape.set(shape, index);
  return index;
}

export function projectAnnotatedTextRecipient({ source, descriptor, decisions }



 )      {
  const meta = getAnnotatedTextCompiledMetadata(descriptor);
  if (!meta) fail('descriptor must be compiled');
  exact(source, ['version', 'text', 'rangeFormat', 'annotations', 'ranges', 'measurements', 'orphans'], 'source');
  if (!recipientSources.has(source)) fail('source was not created by the recipient source factory');
  exact(decisions, ['version', 'protectors', 'capabilityHints'], 'decisions');
  if (source.version !== 1 || decisions.version !== 1 || typeof source.text !== 'string' ||
      !['offset', 'anchored'].includes(source.rangeFormat) || !Array.isArray(source.annotations) || !Array.isArray(source.ranges) ||
      !Array.isArray(source.measurements) || !Array.isArray(source.orphans) ||
      !Array.isArray(decisions.protectors) || !Array.isArray(decisions.capabilityHints)) fail('invalid version or collection');

  const canonicalText = source.text;
  const rangeFormat = source.rangeFormat;
  if (typeof canonicalText !== 'string' || !['offset', 'anchored'].includes(rangeFormat)) fail('source text or range format is invalid');
  const textLength = canonicalText.length;
  const annotations = new Map                                          ();
  for (const annotation of source.annotations) {
    const keys = annotation?.protectedTargetIds === undefined
      ? (annotation?.owner === undefined ? ['id', 'family', 'fields'] : ['id', 'family', 'fields', 'owner'])
      : (annotation?.owner === undefined ? ['id', 'family', 'fields', 'protectedTargetIds'] : ['id', 'family', 'fields', 'owner', 'protectedTargetIds']);
    exact(annotation, keys, 'annotation');
    if (typeof annotation.id !== 'string' || annotations.has(annotation.id) || !Object.hasOwn(meta.annotationHandles, annotation.family)) fail('annotation is invalid');
    if (annotation.protectedTargetIds !== undefined && (!Object.hasOwn(meta.protectingFamilies, annotation.family) || !Array.isArray(annotation.protectedTargetIds) || annotation.protectedTargetIds.some((id         , i        , all           ) => typeof id !== 'string' || (i > 0 && (typeof all[i - 1] !== 'string' || (all[i - 1]          ) >= id))))) fail('protector targets are invalid');
    annotations.set(annotation.id, annotation);
  }

  // Document-scoped ranges: absolute offsets. An annotation may own ZERO or MORE
  // (disjoint) ranges: an exclusive 'one'-cardinality apply trims the overlapped
  // middle of a same-family annotation into left/right remnants, so a single
  // annotation is no longer guaranteed one contiguous range.
  const relevantRangeIds = new Set        ();
  for (const annotation of annotations.values()) {
    if (!Object.hasOwn(meta.protectingFamilies, annotation.family) || !annotation.protectedTargetIds?.length) continue;
    relevantRangeIds.add(annotation.id);
    for (const targetId of annotation.protectedTargetIds) relevantRangeIds.add(targetId);
  }
  const rangeByAnnotation = new Map                         ();
  let anchoredRangeCount = 0;
  let rangeCount = 0;
  for (const range of source.ranges) {
    const anchored = range?.anchoredStart !== undefined || range?.anchoredEnd !== undefined;
    exact(range, anchored ? ['annotationId', 'start', 'end', 'anchoredStart', 'anchoredEnd'] : ['annotationId', 'start', 'end'], 'range');
    if (anchored && (range.anchoredStart === undefined || range.anchoredEnd === undefined)) fail('range is invalid');
    const annotation = annotations.get(range.annotationId);
    if (!annotation || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
        range.start < 0 || range.end < range.start || range.end > textLength) fail('range is invalid');
    if (relevantRangeIds.has(range.annotationId)) {
      const own = rangeByAnnotation.get(range.annotationId);
      if (Array.isArray(own)) own.push(range);
      else if (own) rangeByAnnotation.set(range.annotationId, [own, range]);
      else rangeByAnnotation.set(range.annotationId, range);
    }
    rangeCount += 1;
    if (anchored) anchoredRangeCount += 1;
  }

  const orphanIds = new Set        ();
  const disclosableOrphans                                 = [];
  for (const orphan of source.orphans) {
    exact(orphan, orphan?.owner === undefined ? ['id', 'family', 'fields', 'savedQuote', 'savedRange'] : ['id', 'family', 'fields', 'owner', 'savedQuote', 'savedRange'], 'orphan');
    if (typeof orphan.id !== 'string' || orphanIds.has(orphan.id) || !Object.hasOwn(meta.annotationHandles, orphan.family) ||
        typeof orphan.savedQuote !== 'string' || !Array.isArray(orphan.savedRange) || orphan.savedRange.length !== 2 ||
        !Number.isSafeInteger(orphan.savedRange[0]) || !Number.isSafeInteger(orphan.savedRange[1]) || orphan.savedRange[0] < 0 || orphan.savedRange[1] < orphan.savedRange[0]) fail('orphan is invalid');
    if (annotations.has(orphan.id)) fail('orphan id conflicts with active annotation');
    orphanIds.add(orphan.id);
    disclosableOrphans.push(orphan);
  }

  const measurementIds = new Set        ();
  const measurements                                      = [];
  for (const measurement of source.measurements) {
    exact(measurement, ['id', 'family', 'formatVersion', 'payload'], 'measurement');
    if (typeof measurement.id !== 'string' || measurementIds.has(measurement.id) ||
        !Object.hasOwn(meta.measurementHandles, measurement.family) || !Number.isSafeInteger(measurement.formatVersion) || measurement.formatVersion < 1) fail('measurement is invalid');
    measurementIds.add(measurement.id);
    measurements.push(measurement);
  }

  // Protector activation: a protector range must intersect a protected target's
  // range. Whole-document (0..textLength) protectors cover everything. A stale
  // protectedTargetIds entry (naming an annotation that does not exist) is
  // invalid canonical state and fails closed — validate EVERY target id before
  // any intersection break. A rangeless protector or target (its only range was
  // displaced by an exclusive apply) is legal but can never activate.
  for (const annotation of annotations.values()) {
    if (!Object.hasOwn(meta.protectingFamilies, annotation.family) || !annotation.protectedTargetIds?.length) continue;
    for (const targetId of annotation.protectedTargetIds) {
      if (!annotations.has(targetId)) fail(`protector '${annotation.id}' names an unknown protected target '${targetId}'`);
    }
  }
  const active = new Set        ();
  for (const annotation of annotations.values()) {
    if (!Object.hasOwn(meta.protectingFamilies, annotation.family) || !annotation.protectedTargetIds?.length) continue;
    const ownRanges = rangeByAnnotation.get(annotation.id);
    if (!ownRanges) continue;
    const wholeDocument = rangesOf(ownRanges).some((own) => own.start === 0 && own.end === textLength);
    for (const targetId of annotation.protectedTargetIds) {
      const targetRanges = rangeByAnnotation.get(targetId);
      const intersects = targetRanges ? rangeCollectionsIntersect(ownRanges, targetRanges) : false;
      if (wholeDocument || intersects) {
        active.add(annotation.id);
        break;
      }
    }
  }

  const outcomes = new Map                ();
  for (const decision of decisions.protectors) {
    exact(decision, ['protectorId', 'outcome'], 'protector decision');
    if (!active.has(decision.protectorId) || outcomes.has(decision.protectorId) || !['allow', 'deny'].includes(decision.outcome)) fail('protector decisions must exactly match active protectors');
    outcomes.set(decision.protectorId, decision.outcome);
  }
  if (outcomes.size !== active.size) fail('protector decisions must exactly match active protectors');
  const capabilityHints = new Set        ();
  for (const hint of decisions.capabilityHints) {
    if (typeof hint !== 'string' || !Object.hasOwn(meta.capabilityHandles ?? {}, hint) || capabilityHints.has(hint)) fail('capability hints must be unique declared capabilities');
    capabilityHints.add(hint);
  }

  // A denied protector redacts its own range. If the range is the whole
  // document, restrict the document (fail closed) and return NO text.
  const deniedIntervals                                                          = [];
  let restricted = false;
  for (const id of active) {
    if (outcomes.get(id) !== 'deny') continue;
    const ownRanges = rangesOf(rangeByAnnotation.get(id));
    if (ownRanges.some((range) => range.start === 0 && range.end === textLength)) {
      restricted = true;
      break;
    }
    for (const range of ownRanges) {
      deniedIntervals.push({ start: range.start, end: range.end, placeholder: meta.protectingFamilies[annotations.get(id) .family].placeholder });
    }
  }
  if (restricted) {
    // Restricted recipients are review-only and receive no authoring hints.
    const result = { kind: 'workbench.annotatedText.recipient', version: 1, restricted: true, text: '', ranges: freezeArray([]), annotations: freezeArray([]), measurements: freezeArray([]), capabilityHints: freezeArray([]), orphans: freezeArray([]) };
    recipientRedactionIntervals.set(result, []);
    return Object.freeze(result);
  }
  deniedIntervals.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged                                                          = [];
  for (const interval of deniedIntervals) {
    const prior = merged.at(-1);
    if (prior && interval.start <= prior.end) {
      prior.end = Math.max(prior.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }

  // Build the recipient-visible text (hidden intervals replaced by their
  // placeholder) and map canonical offsets to visible offsets.
  let text = '';
  let offset = 0;
  const authoring                                                              = [];
  const redactions = merged.map((interval) => {
    text += canonicalText.slice(offset, interval.start);
    const visibleStart = text.length;
    offset = interval.end;
    authoring.push(Object.freeze({ visibleStart, start: interval.start, end: interval.end }));
    return { start: visibleStart, end: visibleStart, placeholder: interval.placeholder };
  });
  text += canonicalText.slice(offset);

  const visibleOffsetFor = (canonicalOffset        ) => {
    let hidden = 0;
    for (const interval of authoring) {
      if (canonicalOffset < interval.start) break;
      // An offset at or inside a hidden interval maps to the interval's visible
      // marker position (zero-width); never to an unrelated earlier offset.
      if (canonicalOffset <= interval.end) return interval.visibleStart;
      hidden += interval.end - interval.start;
    }
    return canonicalOffset - hidden;
  };

  // The protected things of DENIED protectors stay hidden even where
  // show-through would otherwise retain a fully-redacted annotation.
  const deniedProtectedTargets = new Set        ();
  for (const id of active) {
    if (outcomes.get(id) !== 'deny') continue;
    for (const targetId of annotations.get(id) .protectedTargetIds ?? []) deniedProtectedTargets.add(targetId);
  }

  const recipientRanges                                                                                                   = [];
  const retainedAnnotationIds = new Set        ();
  const offsetsUnchanged = authoring.length === 0;
  const fullyAnchored = authoring.length === 0 && rangeFormat === 'anchored' && anchoredRangeCount === rangeCount;
  const points           = [];
  const frontiers           = [];
  const pointByIdentity = new WeakMap                ();
  const frontierByIdentity = new WeakMap                ();
  const pointByShape = new Map                ();
  const frontierByShape = new Map                ();
  const appendRecipientRange = (annotationId        , range                             ) => {
    const start = visibleOffsetFor(range.start);
    const end = visibleOffsetFor(range.end);
    if (end > start) {
      retainedAnnotationIds.add(annotationId);
      if (fullyAnchored) {
        const anchoredStart = range.anchoredStart                                            ;
        const anchoredEnd = range.anchoredEnd                                            ;
        exact(anchoredStart, ['point', 'basisFrontier'], 'anchored range start');
        exact(anchoredEnd, ['point', 'basisFrontier'], 'anchored range end');
        recipientRanges.push([
          annotationId,
          internValue(anchoredStart.point, points, pointByIdentity, pointByShape, pointShape),
          internValue(anchoredStart.basisFrontier, frontiers, frontierByIdentity, frontierByShape, JSON.stringify),
          internValue(anchoredEnd.point, points, pointByIdentity, pointByShape, pointShape),
          internValue(anchoredEnd.basisFrontier, frontiers, frontierByIdentity, frontierByShape, JSON.stringify),
        ]);
      } else {
        recipientRanges.push(offsetsUnchanged ? { annotationId, start: range.start, end: range.end } : { annotationId, start, end });
      }
      return;
    }
    // Show-through: an annotation fully inside the redacted union still shows
    // at the zero-width marker, unless it is a denied protector's target.
    if (start === end && redactions.some((redaction) => redaction.start === start) && !deniedProtectedTargets.has(annotationId)) {
      retainedAnnotationIds.add(annotationId);
      recipientRanges.push({ annotationId, start, end });
    }
  };
  for (const range of source.ranges) {
    const annotationId = range.annotationId;
    const family = annotations.get(annotationId) .family;
    if (Object.hasOwn(meta.protectingFamilies, family)) continue;
    appendRecipientRange(annotationId, range);
  }
  const recipientAnnotations                                     = [];
  for (const annotation of annotations.values()) {
    if (retainedAnnotationIds.has(annotation.id)) recipientAnnotations.push(freeze(annotation));
  }

  const result = {
    kind: 'workbench.annotatedText.recipient', version: fullyAnchored ? 3 : 1,
    text,
    ...(fullyAnchored ? {
      points: freezeArray(points.map((point) => freeze(point))),
      frontiers: freezeArray(frontiers.map((frontier) => freeze(frontier))),
    } : {}),
    ranges: freezeArray(recipientRanges.map((range) => freeze(range))),
    annotations: freezeArray(recipientAnnotations),
    measurements: freezeArray(measurements.map((measurement) => freeze(measurement))),
    capabilityHints: freezeArray([...capabilityHints].filter((hint) => (!redactions.length) || hint !== 'body.read')),
    orphans: freezeArray(disclosableOrphans
      .filter((orphan) => !Object.hasOwn(meta.protectingFamilies, orphan.family))
      // An orphan's savedQuote is HISTORICAL text (the range it lived in is
      // gone) and cannot be provenance-checked against the current text. Any
      // redaction for this recipient could have come to cover where that quote
      // originated, so fail closed: no redacted document discloses orphans.
      .filter(() => redactions.length === 0)
      .map(({ id, family, fields, savedQuote, owner }) => freeze({ id, family, fields: { ...fields }, savedQuote, ...(owner ? { owner } : {}) }))),
    ...(redactions.length ? { redactions: freezeArray(redactions.map((redaction) => freeze(redaction))) } : {}),
  };
  recipientRedactionIntervals.set(result, authoring);
  Object.freeze(authoring);
  return Object.freeze(result);
}

/** Canonical-array adapter retained for caret projection and existing package tests. */
export function projectAnnotatedTextForRecipient(canonical                        , descriptor     , decisions                                 )      {
  const canonicalKeys = ['kind', 'version', 'text', 'annotations', 'ranges', 'measurements', 'capabilityHints'];
  if (Object.hasOwn(canonical ?? {}, 'orphans')) canonicalKeys.push('orphans');
  exact(canonical, canonicalKeys, 'canonical');
  if (canonical.kind !== 'workbench.annotatedText.canonical' || canonical.version !== 1 || typeof canonical.text !== 'string' ||
      !Array.isArray(canonical.annotations) || !Array.isArray(canonical.ranges) || !Array.isArray(canonical.measurements) ||
      !Array.isArray(canonical.capabilityHints) || (canonical.orphans !== undefined && !Array.isArray(canonical.orphans))) fail('invalid version or collection');
  return projectAnnotatedTextRecipient({
    source: createAnnotatedTextRecipientSource({
      version: 1,
      text: canonical.text,
      rangeFormat: 'offset',
      annotations: canonical.annotations,
      ranges: canonical.ranges,
      measurements: canonical.measurements,
      orphans: canonical.orphans ?? [],
    }),
    descriptor,
    decisions,
  });
}
