import { createAnnotatedTextSnapshotSessionBinding, getAnnotatedTextSnapshotSessionBinding } from './workbench-annotated-text-snapshot-internal.mjs';
import { projectEndpointToOffset, resolveOffsetToEndpoint } from './workbench-annotated-text-continuous.mjs';
import { changedRange, scalarStart } from './workbench-annotated-text-redaction-coords.mjs';

const deeplyFrozen = new WeakSet();

// A 36k-word transcript can carry ~200k materialized objects (points,
// frontiers, ranges, annotations). Recursively freezing every one of them is a
// 50–90 ms client stall, so deep freezing is reserved for small envelopes.
// Above this estimate only the document shell and its top-level collection
// arrays are frozen: the O(n) validation above stays byte-identical, but the
// recursive `Object.freeze` + WeakSet walk over every tuple is skipped.
const DEEP_FREEZE_OBJECT_BUDGET = 4096;

function shouldDeepFreezeSnapshot(snapshot) {
  const estimate = (Array.isArray(snapshot.ranges) ? snapshot.ranges.length : 0)
    + (Array.isArray(snapshot.annotations) ? snapshot.annotations.length * 2 : 0)
    + (Array.isArray(snapshot.measurements) ? snapshot.measurements.length * 2 : 0)
    + (Array.isArray(snapshot.orphans) ? snapshot.orphans.length * 2 : 0)
    + (Array.isArray(snapshot.points) ? snapshot.points.length * 3 : 0)
    + (Array.isArray(snapshot.frontiers) ? snapshot.frontiers.length * 2 : 0)
    + (Array.isArray(snapshot.redactions) ? snapshot.redactions.length : 0);
  return estimate <= DEEP_FREEZE_OBJECT_BUDGET;
}

function deepFreeze(value, track = false) {
  if (value === null || typeof value !== 'object') return value;
  const wasFrozen = Object.isFrozen(value);
  if (wasFrozen && deeplyFrozen.has(value)) return value;
  if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child, track);
    if (!wasFrozen) Object.freeze(value);
    if (track || wasFrozen) deeplyFrozen.add(value);
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child, track);
  if (!wasFrozen) Object.freeze(value);
  if (track || wasFrozen) deeplyFrozen.add(value);
  return value;
}

// Fast shallow freeze for large envelopes: freeze the document and its
// top-level collection arrays, never recursing into per-point / per-frontier /
// per-range tuples. Validation has already run before this is called.
function freezeSnapshotCollections(document) {
  for (const key of ['ranges', 'annotations', 'orphans', 'measurements', 'capabilities', 'redactions']) {
    const collection = document[key];
    if (Array.isArray(collection)) Object.freeze(collection);
  }
  return Object.freeze(document);
}

function isStructuralEndpoint(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'point') && Object.hasOwn(value, 'basisFrontier');
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasStrictExactKeys(value, keys) {
  if (!hasExactKeys(value, keys)) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true;
  });
}

// Strict-closed-array check on the hot v3 materialization path (every point,
// frontier, and endpoint table pays it), so the walk avoids per-key regular
// expressions and property descriptors. A real array's own keys are ordered
// canonical integer indices ascending, then string keys in insertion order
// ('length' first for an array), then symbols. So the table is strict-closed
// iff there are exactly `length` index keys followed by 'length', no symbols,
// and every index is enumerable. One Reflect.ownKeys walk sees planted symbols
// and extra (even non-enumerable) string keys; the Object.keys count rejects a
// non-enumerable index.
function isStrictClosedArray(value, length) {
  if (!Array.isArray(value) || value.length !== length) return false;
  // One own-key walk replaces the former getOwnPropertySymbols +
  // getOwnPropertyNames + per-index compare: Reflect.ownKeys yields ascending
  // integer indices, then insertion-ordered string keys (always `length` first
  // for an array), then symbols. Exact count + `length` position rejects any
  // planted symbol or extra string key; the Object.keys count catches a
  // non-enumerable index (visible to Reflect, absent from Object.keys).
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1 || ownKeys[length] !== 'length') return false;
  for (let index = 0; index < length; index += 1) {
    if (ownKeys[index] !== `${index}`) return false;
  }
  return Object.keys(value).length === length;
}

function compactPointKey(point) {
  if (!isStrictClosedArray(point, 3) || point[0] !== 'point' || (point[2] !== 'left' && point[2] !== 'right')) {
    throw new Error('annotatedText snapshot: v3 point table entry is invalid');
  }
  const anchor = point[1];
  if (isStrictClosedArray(anchor, 1) && anchor[0] === 'root') return `root:${point[2]}`;
  if (!isStrictClosedArray(anchor, 2) || anchor[0] !== 'element' || !isStrictClosedArray(anchor[1], 2)
    || !isStrictClosedArray(anchor[1][0], 2) || !/^[0-9a-f]{32}$/.test(anchor[1][0][0])
    || !Number.isSafeInteger(anchor[1][0][1]) || anchor[1][0][1] < 1
    || !Number.isSafeInteger(anchor[1][1]) || anchor[1][1] < 0) {
    throw new Error('annotatedText snapshot: v3 point table entry is invalid');
  }
  return `element:${anchor[1][0][0]}:${anchor[1][0][1]}:${anchor[1][1]}:${point[2]}`;
}

function compactFrontierKey(frontier) {
  if (!Array.isArray(frontier) || !isStrictClosedArray(frontier, frontier.length)) {
    throw new Error('annotatedText snapshot: v3 frontier table entry is invalid');
  }
  let previousActor = null;
  let key = '';
  for (const entry of frontier) {
    if (!isStrictClosedArray(entry, 2) || !/^[0-9a-f]{32}$/.test(entry[0])
      || !Number.isSafeInteger(entry[1]) || entry[1] < 1
      || (previousActor !== null && previousActor >= entry[0])) {
      throw new Error('annotatedText snapshot: v3 frontier table entry is invalid');
    }
    previousActor = entry[0];
    key += `${entry[0]}:${entry[1]};`;
  }
  return key;
}

function materializeCompactRecipientRanges(snapshot, family, consume, deep) {
  if (!family) throw new Error('annotatedText snapshot: v3 endpoints require a family replica');
  if (!Array.isArray(snapshot.points) || !isStrictClosedArray(snapshot.points, snapshot.points.length)
    || !Array.isArray(snapshot.frontiers) || !isStrictClosedArray(snapshot.frontiers, snapshot.frontiers.length)
    || !isStrictClosedArray(snapshot.ranges, snapshot.ranges.length)) {
    throw new Error('annotatedText snapshot: v3 endpoint tables are required');
  }
  const pointShapes = new Set();
  for (const point of snapshot.points) {
    const shape = compactPointKey(point);
    if (pointShapes.has(shape)) throw new Error('annotatedText snapshot: v3 point table must be deduplicated');
    pointShapes.add(shape);
  }
  const frontierShapes = new Set();
  for (const frontier of snapshot.frontiers) {
    const shape = compactFrontierKey(frontier);
    if (frontierShapes.has(shape)) throw new Error('annotatedText snapshot: v3 frontier table must be deduplicated');
    frontierShapes.add(shape);
  }
  let nextPoint = 0;
  let nextFrontier = 0;
  for (const range of snapshot.ranges) {
    if (!isStrictClosedArray(range, 5) || typeof range[0] !== 'string') {
      throw new Error('annotatedText snapshot: v3 ranges must be compact endpoint references');
    }
    if (!Number.isSafeInteger(range[1]) || range[1] < 0 || range[1] >= snapshot.points.length
      || !Number.isSafeInteger(range[3]) || range[3] < 0 || range[3] >= snapshot.points.length) {
      throw new Error('annotatedText snapshot: v3 range point reference is out of bounds');
    }
    if (!Number.isSafeInteger(range[2]) || range[2] < 0 || range[2] >= snapshot.frontiers.length
      || !Number.isSafeInteger(range[4]) || range[4] < 0 || range[4] >= snapshot.frontiers.length) {
      throw new Error('annotatedText snapshot: v3 range frontier reference is out of bounds');
    }
    if (range[1] > nextPoint) throw new Error('annotatedText snapshot: v3 point table is not in canonical first-use order');
    if (range[1] === nextPoint) nextPoint += 1;
    if (range[3] > nextPoint) throw new Error('annotatedText snapshot: v3 point table is not in canonical first-use order');
    if (range[3] === nextPoint) nextPoint += 1;
    if (range[2] > nextFrontier) throw new Error('annotatedText snapshot: v3 frontier table is not in canonical first-use order');
    if (range[2] === nextFrontier) nextFrontier += 1;
    if (range[4] > nextFrontier) throw new Error('annotatedText snapshot: v3 frontier table is not in canonical first-use order');
    if (range[4] === nextFrontier) nextFrontier += 1;
  }
  if (nextPoint !== snapshot.points.length || nextFrontier !== snapshot.frontiers.length) {
    throw new Error('annotatedText snapshot: v3 endpoint tables contain unused entries');
  }

  const ranges = consume && !Object.isFrozen(snapshot.ranges) ? snapshot.ranges : new Array(snapshot.ranges.length);
  if (deep) {
    for (const point of snapshot.points) deepFreeze(point, true);
    for (const frontier of snapshot.frontiers) deepFreeze(frontier, true);
  } else {
    Object.freeze(snapshot.points);
    Object.freeze(snapshot.frontiers);
  }
  const endpointByReference = new Map();
  const endpoint = (point, frontier) => {
    const key = point * snapshot.frontiers.length + frontier;
    let value = endpointByReference.get(key);
    if (!value) {
      const candidate = { point: snapshot.points[point], basisFrontier: snapshot.frontiers[frontier] };
      value = deep ? deepFreeze(candidate, true) : Object.freeze(candidate);
      endpointByReference.set(key, value);
    }
    return value;
  };
  for (let index = 0; index < snapshot.ranges.length; index += 1) {
    const range = snapshot.ranges[index];
    ranges[index] = { annotationId: range[0], start: endpoint(range[1], range[2]), end: endpoint(range[3], range[4]) };
  }
  if (ranges === snapshot.ranges) {
    delete snapshot.points;
    delete snapshot.frontiers;
  }
  return ranges;
}

function materializeRecipientRanges(snapshot, family, consume, deep) {
  if (snapshot.version === 1) {
    for (const range of snapshot.ranges) {
      if (!range || typeof range !== 'object' || Array.isArray(range)
        || !hasExactKeys(range, ['annotationId', 'start', 'end'])
        || typeof range.annotationId !== 'string'
        || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) {
        throw new Error('annotatedText snapshot: v1 ranges must be offset pairs');
      }
      if (isStructuralEndpoint(range.start) || isStructuralEndpoint(range.end)) {
        throw new Error('annotatedText snapshot: v1 envelope must not carry endpoints');
      }
    }
    return snapshot.ranges;
  }
  if (snapshot.version === 3) return materializeCompactRecipientRanges(snapshot, family, consume, deep);
  if (snapshot.version !== 2) {
    throw new Error('annotatedText snapshot: snapshot must be a complete blockless recipient envelope');
  }
  if (!family) {
    throw new Error('annotatedText snapshot: v2 endpoints require a family replica');
  }
  for (const range of snapshot.ranges) {
    if (!range || typeof range !== 'object' || Array.isArray(range)
      || !hasExactKeys(range, ['annotationId', 'start', 'end'])
      || typeof range.annotationId !== 'string'
      || !isStructuralEndpoint(range.start) || !isStructuralEndpoint(range.end)) {
      throw new Error('annotatedText snapshot: v2 ranges must be structural endpoints');
    }
  }
  return snapshot.ranges;
}

export function isOffsetRange(range) {
  return !!range && typeof range === 'object' && !Array.isArray(range)
    && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end);
}

/** Resolve one document range to UTF-16 offsets. Offset-form (redacted) passes through. */
export function resolveRangeOffsets(range, family) {
  if (isOffsetRange(range)) return { annotationId: range.annotationId, start: range.start, end: range.end };
  if (!family) throw new Error('annotated text range resolution requires a family replica');
  return {
    annotationId: range.annotationId,
    start: projectEndpointToOffset(family, range.start),
    end: projectEndpointToOffset(family, range.end),
  };
}

export function resolveRangesOffsets(ranges, family) {
  if (!Array.isArray(ranges)) return ranges;
  return ranges.map((range) => resolveRangeOffsets(range, family));
}

/** Resolve ranges or return null so render can fail closed to snapshot recovery. */
export function tryResolveRangesOffsets(ranges, family) {
  if (!Array.isArray(ranges)) return ranges;
  const resolved = [];
  for (const range of ranges) {
    try {
      resolved.push(resolveRangeOffsets(range, family));
    } catch {
      return null;
    }
  }
  return resolved;
}

/**
 * Shift redacted/offset ranges through one absolute-offset edit. Anchored
 * ranges are returned unchanged — callers resolve them against a family.
 */
export function shiftOffsetRangesOverEdit(ranges, from, to, text) {
  if (!Array.isArray(ranges) || ranges.length === 0) return ranges;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) return ranges;
  const insertion = from === to;
  const delta = text.length - (to - from);
  if (insertion && text.length === 0) return ranges;
  return ranges.map((range) => {
    if (!isOffsetRange(range)) return range;
    let start;
    let end;
    if (insertion) {
      if (range.end <= from) {
        start = range.start;
        end = range.end;
      } else if (range.start <= from) {
        start = range.start;
        end = range.end + text.length;
      } else {
        start = range.start + text.length;
        end = range.end + text.length;
      }
    } else {
      start = range.start < from ? range.start : range.start >= to ? range.start + delta : from + text.length;
      end = range.end <= from ? range.end : range.end > to ? range.end + delta : from + text.length;
    }
    return Object.freeze({ ...range, start, end });
  });
}

export function shiftOffsetRangesOverText(ranges, beforeText, afterText) {
  if (!Array.isArray(ranges) || ranges.length === 0 || beforeText === afterText) return ranges;
  const { from, to, text } = changedRange(beforeText, afterText);
  return shiftOffsetRangesOverEdit(ranges, from, to, text);
}

export function materializeAnnotatedTextSnapshot(snapshot, handle, options = {}) {
  const suppliedBinding = getAnnotatedTextSnapshotSessionBinding(options?.binding ?? options);
  const binding = suppliedBinding ?? createAnnotatedTextSnapshotSessionBinding();
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      snapshot.kind !== 'workbench.annotatedText.recipient' ||
      (snapshot.version !== 1 && snapshot.version !== 2 && snapshot.version !== 3) ||
      typeof snapshot.text !== 'string' || !Array.isArray(snapshot.ranges) ||
      !Array.isArray(snapshot.annotations) || !Array.isArray(snapshot.measurements)) {
    throw new Error('annotatedText snapshot: snapshot must be a complete blockless recipient envelope');
  }
  if (snapshot.version === 3) {
    const keys = ['kind', 'version', 'text', 'points', 'frontiers', 'ranges', 'annotations', 'measurements', 'capabilityHints', 'orphans'];
    if (Object.hasOwn(snapshot, 'authoring')) keys.push('authoring');
    if (!hasStrictExactKeys(snapshot, keys)) throw new Error('annotatedText snapshot: v3 envelope has invalid shape');
  }
  if (snapshot.orphans !== undefined && !Array.isArray(snapshot.orphans)) throw new Error('annotatedText snapshot: orphans must be an array');
  if (snapshot.redactions !== undefined && !Array.isArray(snapshot.redactions)) throw new Error('annotatedText snapshot: redactions must be an array');
  for (const marker of snapshot.redactions ?? []) {
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)
      || !hasExactKeys(marker, ['start', 'end', 'placeholder'])
      || !Number.isSafeInteger(marker.start) || !Number.isSafeInteger(marker.end)
      || marker.start < 0 || marker.end < marker.start || marker.end > snapshot.text.length
      || typeof marker.placeholder !== 'string') {
      throw new Error('annotatedText snapshot: redaction markers must be in-bounds { start, end, placeholder } intervals');
    }
  }
  // Fail closed on an undeclared annotation family: the handle names the
  // declared families, and a hostile/malformed stream must not smuggle an
  // annotation the application never declared.
  const declaredFamilies = handle?.annotations ? new Set(Object.keys(handle.annotations)) : null;
  for (const annotation of snapshot.annotations) {
    const keys = annotation?.owner === undefined ? ['id', 'family', 'fields'] : ['id', 'family', 'fields', 'owner'];
    if (!hasExactKeys(annotation, keys) || typeof annotation.id !== 'string' || typeof annotation.family !== 'string'
      || !annotation.fields || typeof annotation.fields !== 'object' || Array.isArray(annotation.fields)
      || (annotation.owner !== undefined && (typeof annotation.owner !== 'string' || annotation.owner.length === 0))) {
      throw new Error('annotatedText snapshot: annotation is invalid');
    }
    if (declaredFamilies !== null && !declaredFamilies.has(annotation.family)) {
      throw new Error(`annotatedText snapshot: annotation family '${annotation.family}' is not declared`);
    }
  }
  const orphans = snapshot.orphans ?? [];
  for (const orphan of orphans) {
    const keys = orphan?.owner === undefined ? ['id', 'family', 'fields', 'savedQuote'] : ['id', 'family', 'fields', 'owner', 'savedQuote'];
    if (!hasExactKeys(orphan, keys) || typeof orphan.id !== 'string' || typeof orphan.family !== 'string'
      || !orphan.fields || typeof orphan.fields !== 'object' || Array.isArray(orphan.fields)
      || typeof orphan.savedQuote !== 'string'
      || (orphan.owner !== undefined && (typeof orphan.owner !== 'string' || orphan.owner.length === 0))) {
      throw new Error('annotatedText snapshot: orphan is invalid');
    }
  }
  for (const measurement of snapshot.measurements) {
    if (!hasExactKeys(measurement, ['id', 'family', 'formatVersion', 'payload'])
      || typeof measurement.id !== 'string' || typeof measurement.family !== 'string'
      || !Number.isSafeInteger(measurement.formatVersion) || measurement.formatVersion < 1) {
      throw new Error('annotatedText snapshot: measurement is invalid');
    }
  }
  // Capability hints are recipient-specific, snapshot-fenced guidance derived
  // from current authorization. A compiled handle validates the hint vocabulary;
  // callers without a handle retain the plain projected names.
  const declaredCapabilities = handle?.capabilities ? new Set(Object.keys(handle.capabilities)) : null;
  let capabilities = snapshot.capabilityHints ? [...snapshot.capabilityHints] : [];
  if (declaredCapabilities !== null) {
    if (!Array.isArray(snapshot.capabilityHints)) {
      throw new Error('annotatedText snapshot: capabilityHints must be an array when capabilities are declared');
    }
    const seen = new Set();
    const names = [];
    for (const hint of snapshot.capabilityHints) {
      if (typeof hint !== 'string' || !declaredCapabilities.has(hint) || seen.has(hint)) {
        throw new Error(`annotatedText snapshot: capability hint '${String(hint)}' is not a unique declared capability`);
      }
      seen.add(hint);
      names.push(hint);
    }
    capabilities = names;
  }
  const deep = shouldDeepFreezeSnapshot(snapshot);
  const unfrozen = {
    kind: 'workbench.annotatedText.recipient', version: snapshot.version,
    text: snapshot.text,
    ranges: materializeRecipientRanges(snapshot, options.family, suppliedBinding !== null || options.consume === true, deep),
    annotations: snapshot.annotations,
    orphans,
    measurements: snapshot.measurements,
    // Authoring capability signal: the wire envelope carries `capabilityHints`
    // (granted capability names); project them into the public `capabilities`
    // array the host uses to expose authoring affordances. A restricted
    // recipient is review-only and exposes `capabilities: null`.
    capabilities: snapshot.restricted ? null : capabilities,
    ...(snapshot.restricted ? { restricted: true } : {}),
    ...(snapshot.redactions?.length ? { redactions: snapshot.redactions } : {}),
  };
  const document = deep ? deepFreeze(unfrozen) : freezeSnapshotCollections(unfrozen);
  binding.document = document;
  binding.generation = (binding.generation ?? 0) + 1;
  return document;
}

// Optimistic document-bound projections (issue #33 blockless). Text edits are
// DISPOSITION-NEUTRAL: a range the edit collapses to zero width stays collapsed
// and its annotation stays attached, so the visible placeholder never infers
// the server's delete-vs-orphan policy. Explicit annotation removal is already
// a precise delete of a stable annotation id, so its pending projection can
// remove that id immediately; the authoritative delivery snapshot still owns
// reconciliation and restores the preimage if the action is rejected.
//
// annotation.apply / reapply projects a pending annotation at document-absolute
// authoring offsets. The projection resolves those offsets to recipient-v2/v3
// anchored endpoints against the family (holding the historical basis, per
// Decision 0025) so the placeholder range stays positional across a concurrent
// foreign text edit instead of bolting an offset range onto the anchored
// document. Reapply by stable annotation id is an upsert — the annotation and
// its one range replace any same-id rows, never duplicate. An apply that cannot
// be anchored (no family, unresolvable offsets) is left UNPROJECTED (returns
// the document unchanged) rather than guessing a mutation; the session surfaces
// the inapplicable apply as a conflict/failure to the caller.
export function projectPendingAnnotatedTextDocument(document, action, options) {
  const edit = action?.payload?.version === 9 ? action.payload.edit : null;
  if (!edit) return document;
  if (edit.kind === 'annotation.remove') {
    const annotationId = edit.annotationId;
    if (typeof annotationId !== 'string' || annotationId.length === 0 || !Array.isArray(document?.annotations)) return document;
    const annotations = document.annotations.filter((annotation) => annotation?.id !== annotationId);
    const ranges = Array.isArray(document.ranges)
      ? document.ranges.filter((range) => range?.annotationId !== annotationId)
      : document.ranges;
    const orphans = Array.isArray(document.orphans)
      ? document.orphans.filter((orphan) => orphan?.id !== annotationId)
      : document.orphans;
    if (annotations.length === document.annotations.length
      && ranges?.length === document.ranges?.length
      && orphans?.length === document.orphans?.length) return document;
    return Object.freeze({
      ...document,
      annotations: Object.freeze(annotations),
      ...(Array.isArray(document.ranges) ? { ranges: Object.freeze(ranges) } : {}),
      ...(Array.isArray(document.orphans) ? { orphans: Object.freeze(orphans) } : {}),
    });
  }
  if (edit.kind === 'annotation.apply') {
    return projectAnnotationApply(document, edit, options);
  }
  if (edit.kind !== 'text.insert' && edit.kind !== 'text.delete' && edit.kind !== 'text.replace') return document;
  const text = document?.text ?? '';
  const start = edit.kind === 'text.insert' ? edit.at.offset : edit.from.offset;
  const end = edit.kind === 'text.insert' ? start : edit.to.offset;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length) return document;
  if (scalarStart(text, start) !== start || scalarStart(text, end) !== end) return document;
  const inserted = edit.kind === 'text.insert' || edit.kind === 'text.replace' ? edit.text : '';
  const spliced = `${text.slice(0, start)}${inserted}${text.slice(end)}`;
  const ranges = Array.isArray(document.ranges) && document.ranges.some((range) => isOffsetRange(range))
    ? Object.freeze(shiftOffsetRangesOverEdit(document.ranges, start, end, inserted))
    : document.ranges;
  return Object.freeze({
    ...document,
    text: spliced,
    ...(Array.isArray(document.ranges) ? { ranges } : {}),
  });
}

// Whether `document` carries recipient-v2/v3 anchored endpoints (the authoring
// surface) rather than redacted/legacy offset ranges.
function isAnchoredDocument(document) {
  return document?.version === 2 || document?.version === 3;
}

// A document with no ranges array yet is treated as offset-form only when it
// is not an anchored recipient. This keeps the v1/redacted splice path unchanged.
function projectAnnotationApply(document, edit, options) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return document;
  const annotation = edit.annotation;
  if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)
    || typeof annotation.id !== 'string' || annotation.id.length === 0
    || typeof annotation.family !== 'string' || annotation.family.length === 0
    || !annotation.fields || typeof annotation.fields !== 'object' || Array.isArray(annotation.fields)
    || !edit.from || typeof edit.from !== 'object' || Array.isArray(edit.from)
    || !edit.to || typeof edit.to !== 'object' || Array.isArray(edit.to)
    || typeof edit.from.offset !== 'number' || typeof edit.to.offset !== 'number') {
    return document;
  }
  const fromOffset = edit.from.offset;
  const toOffset = edit.to.offset;
  // Affinities fail closed: freshly-supplied offset input must state an explicit
  // 'left' or 'right'; anything else (missing/invalid) leaves the projection
  // unchanged so the authoritative dispatch/validation decides, never a silent
  // default that could display a guessed range.
  const fromAffinity = edit.from.affinity;
  const toAffinity = edit.to.affinity;
  if ((fromAffinity !== 'left' && fromAffinity !== 'right')
    || (toAffinity !== 'left' && toAffinity !== 'right')) {
    return document;
  }

  let range;
  const preResolved = options?.range;
  const family = options?.family;
  if (preResolved && isStructuralEndpoint(preResolved.start) && isStructuralEndpoint(preResolved.end)) {
    // The session captured the authoring-basis anchored endpoints once and they
    // were validated at capture time. They stay structurally valid even when a
    // concurrent foreign edit shifts the CURRENT document text's character
    // counts (e.g. a delete before the selection), so skip the current-text
    // offset-bounds and empty-selection checks (those belong only to
    // freshly-supplied offset input) and place the anchored endpoints verbatim;
    // they resolve against the current family at point of use. A captured range
    // that can no longer resolve (anchor lost / basis no longer dominating) is
    // surfaced downstream as an unresolvable visible conflict, never a guess.
    range = Object.freeze({ annotationId: annotation.id, start: preResolved.start, end: preResolved.end });
  } else if (family && isAnchoredDocument(document)) {
    // Freshly-supplied offset input against an anchored document. Mirror of the
    // server plan: the selection must be a forward, non-empty, in-bounds pair
    // against the CURRENT text or it is inapplicable (never guess).
    const text = document.text ?? '';
    if (!Number.isSafeInteger(fromOffset) || !Number.isSafeInteger(toOffset)
      || fromOffset < 0 || toOffset < fromOffset || toOffset > text.length
      || fromOffset === toOffset) {
      return document;
    }
    try {
      range = Object.freeze({
        annotationId: annotation.id,
        start: resolveOffsetToEndpoint(family, fromOffset, family.checkpoint.frontier, fromAffinity),
        end: resolveOffsetToEndpoint(family, toOffset, family.checkpoint.frontier, toAffinity),
      });
    } catch {
      return document;
    }
  } else if (!isAnchoredDocument(document)) {
    // Freshly-supplied offset input against a v1 / redacted offset surface:
    // apply as a plain offset range (forward, non-empty, in-bounds).
    const text = document.text ?? '';
    if (!Number.isSafeInteger(fromOffset) || !Number.isSafeInteger(toOffset)
      || fromOffset < 0 || toOffset < fromOffset || toOffset > text.length
      || fromOffset === toOffset) {
      return document;
    }
    range = Object.freeze({ annotationId: annotation.id, start: fromOffset, end: toOffset });
  } else {
    // Anchored document without a family or pre-resolved range: cannot anchor.
    return document;
  }

  // Upsert the annotation entity by stable id (replace fields, never append a
  // duplicate row for the same annotation).
  const annotations = Array.isArray(document.annotations) ? [...document.annotations] : [];
  const existingIndex = annotations.findIndex((candidate) => candidate?.id === annotation.id);
  const projectedAnnotation = Object.freeze({
    id: annotation.id,
    family: annotation.family,
    fields: Object.freeze({ ...annotation.fields }),
    ...(annotation.owner ? { owner: annotation.owner } : {}),
  });
  const nextAnnotations = existingIndex >= 0
    ? annotations.map((candidate, index) => (index === existingIndex ? projectedAnnotation : candidate))
    : [...annotations, projectedAnnotation];

  // Upsert the range by stable id: same-id replace keeps exactly ONE range at
  // the latest selection (mirrors planTextRangeApply), never a duplicate.
  const ranges = Array.isArray(document.ranges) ? document.ranges : [];
  const nextRanges = Object.freeze([
    ...ranges.filter((candidate) => candidate?.annotationId !== annotation.id),
    range,
  ]);

  return Object.freeze({
    ...document,
    annotations: Object.freeze(nextAnnotations),
    ...(Array.isArray(document.ranges) ? { ranges: nextRanges } : {}),
  });
}

// Scalar-boundary handling lives in the leaf `redaction-coords` module: bounds
// may land between a surrogate pair when a transition crosses an astral
// character, so all three public consumers back off to the same scalar edges.
