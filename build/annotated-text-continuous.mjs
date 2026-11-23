// Blockless continuous annotated-text family (issue #33).
//
// The RGA checkpoint already holds the whole document text; blocks were a
// redundant partition imposed by elementKeys ownership. This module drops the
// block layer entirely: one continuous text stream per document, absolute
// UTF-16 offsets, and annotations as character ranges resolved to structural
// endpoints.
//
// Endpoint semantics (the load-bearing correction): stored endpoints keep their
// historical `basisFrontier` and are positioned against the CURRENT checkpoint
// as long as the current frontier DOMINATES the basis and the anchor element
// still exists (including as a tombstone). They are never rebased to the latest
// frontier — that would silently move boundary semantics after ordinary edits.

import {
  assertFrontier,
  assertStructuralPoint,
  assertUtf16Offset,
  buildRgaPieces,
  canonicalTextOp,
  compareOpIdValidated,
  createTextState,
  ensureRunUtf16Starts,
  frontierDominatesValidated,
  hasTextElement,
  restoreTextCheckpoint,
  textStateElementCount,
  textStateMaxLamport,
  applyTextOp,
  compactTextCheckpoint,
} from './annotated-text.mjs';



import {
  assertStructuralEndpoint,
} from './annotated-text-family.mjs';


const ROOT_ID = 'root';
const trustedFamilies = new WeakSet        ();
const serializedFamilyCache = new Map                              ();
const SERIALIZED_FAMILY_CACHE_LIMIT = 16;
const derivedIndexCache = new WeakMap                                                  ();

































function trustFamily(family                      )                       {
  const trusted = deepFreeze(family);
  trustedFamilies.add(trusted);
  return trusted;
}

function assertTrustedFamily(family                      )                       {
  if (!family || typeof family !== 'object' || !trustedFamilies.has(family)) {
    fail('family must be created or restored by this module');
  }
  return family;
}

function rememberSerializedFamily(serialized        , family                      )                       {
  serializedFamilyCache.delete(serialized);
  serializedFamilyCache.set(serialized, family);
  if (serializedFamilyCache.size > SERIALIZED_FAMILY_CACHE_LIMIT) {
    serializedFamilyCache.delete(serializedFamilyCache.keys().next().value          );
  }
  return family;
}

function fail(message        )        {
  throw new Error(`annotated-text continuous: ${message}`);
}

function anchorKeyStr(anchor        )         {
  if (anchor[0] === 'root') return ROOT_ID;
  return `${anchor[1][0][0]}:${anchor[1][0][1]}:${anchor[1][1]}`;
}

/** A continuous family is the document id + the RGA checkpoint. No blocks. */
export function restoreTextFamily(familyCheckpoint         )                       {
  const raw = familyCheckpoint                       ;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('family checkpoint must be a non-array object');
  }
  const allowedKeys = new Set(['id', 'checkpoint']);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) fail(`unknown family checkpoint key: ${key}`);
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    fail('family checkpoint id must be a non-empty string');
  }
  const checkpoint = restoreTextCheckpoint(raw.checkpoint);
  return trustFamily({ id: raw.id, checkpoint });
}

/**
 * Restore an exact serialized durable family with a small process-local LRU.
 * The serialized bytes are the cache key, so a write from this or another
 * process necessarily misses unless it names the identical already-validated
 * immutable checkpoint.
 */
export function restoreTextFamilySerialized(serialized         )                       {
  if (typeof serialized !== 'string') fail('serialized family checkpoint must be a string');
  const cached = serializedFamilyCache.get(serialized);
  if (cached) {
    return rememberSerializedFamily(serialized, cached);
  }
  const restored = restoreTextFamily(JSON.parse(serialized));
  return rememberSerializedFamily(serialized, restored);
}

export function createTextFamily(id        , checkpoint         )                       {
  if (typeof id !== 'string' || id.length === 0) fail('document id must be a non-empty string');
  const restored = restoreTextCheckpoint(checkpoint);
  return trustFamily({ id, checkpoint: restored });
}

/**
 * Seed a continuous family from plain text (one root element; blocks are gone).
 * A single multi-scalar element is the canonical import shape — mid-element
 * offset edits resolve correctly (verified) — so import is O(1), not O(chars).
 */
export function importTextToFamily(documentId        , actor        , text        )                       {
  if (typeof documentId !== 'string' || documentId.length === 0) fail('document id must be a non-empty string');
  if (typeof actor !== 'string' || !/^[0-9a-f]{32}$/.test(actor)) fail('import actor must be a 32-hex id');
  if (typeof text !== 'string') fail('import text must be a string');
  let state            = createTextState();
  if (text.length > 0) {
    state = applyTextOp(state, ['workbench.text', 1, [actor, 1], 1, [], ['insert', ['root'], text]]);
  }
  // `state` was just produced by the validated reducer (`createTextState` +
  // `applyTextOp`), so trusting it directly avoids sorting/replaying every
  // character through a v1 checkpoint round-trip.
  return trustFamily({ id: documentId, checkpoint: state });
}

export function textFamilyCheckpoint(family                      )                       {
  assertTrustedFamily(family);
  return trustFamily({ id: family.id, checkpoint: family.checkpoint });
}

export function compactTextFamilyCheckpoint(family                      )                                                                                         {
  assertTrustedFamily(family);
  return deepFreeze({ id: family.id, checkpoint: compactTextCheckpoint(family.checkpoint) });
}

export function serializeCompactTextFamilyCheckpoint(family                      )         {
  assertTrustedFamily(family);
  const serialized = JSON.stringify(compactTextFamilyCheckpoint(family));
  rememberSerializedFamily(serialized, family);
  return serialized;
}

export function textFamilyBasis(family                      )                                                                            {
  assertTrustedFamily(family);
  return deepFreeze({ version: 1, id: family.id, frontier: family.checkpoint.frontier });
}

/** O(1) max element Lamport clock for a trusted continuous family. */
export function textFamilyMaxLamport(family                      )         {
  return textStateMaxLamport(assertTrustedFamily(family).checkpoint);
}

/** O(1) total RGA element count (live + tombstones) for a trusted continuous family. */
export function textFamilyElementCount(family                      )         {
  return textStateElementCount(assertTrustedFamily(family).checkpoint);
}

export function materializeText(family                      )         {
  return derivedIndex(assertTrustedFamily(family)).text;
}

/** Return the cached visible UTF-16 length of a continuous family. */
export function textFamilyVisibleLength(family                      )         {
  return derivedIndex(assertTrustedFamily(family)).textLength;
}

/**
 * Build the immutable run-aware traversal index once per checkpoint.
 * Operating on contiguous RGA pieces keeps index construction O(pieces)
 * (~O(edits)) instead of O(chars), even on 200k-char transcripts.
 */
function derivedIndex(family                      )                             {
  assertTrustedFamily(family);
  const cached = derivedIndexCache.get(family);
  if (cached) return cached;

  const rawPieces = buildRgaPieces(family.checkpoint);
  const pieces                 = new Array(rawPieces.length);
  const visiblePieces                 = [];
  const rootPieces                 = [];
  const piecesByOpMutable = new Map                        ();
  let virtualPos = 0;
  let visibleOffset = 0;

  for (let i = 0; i < rawPieces.length; i += 1) {
    const piece = rawPieces[i];
    const startVirtualPos = virtualPos;
    const endVirtualPos = startVirtualPos + piece.length;
    const visibleStart = visibleOffset;
    const visibleEnd = piece.deleted ? visibleStart : visibleStart + piece.text.length;
    const indexed               = {
      piece,
      startVirtualPos,
      endVirtualPos,
      visibleStart,
      visibleEnd,
    };
    pieces[i] = indexed;
    if (!piece.deleted) visiblePieces.push(indexed);
    if (piece.startOrdinal === 0 && piece.parentKey === ROOT_ID) rootPieces.push(indexed);
    let opList = piecesByOpMutable.get(piece.opKey);
    if (!opList) {
      opList = [];
      piecesByOpMutable.set(piece.opKey, opList);
    }
    opList.push(indexed);
    virtualPos = endVirtualPos;
    visibleOffset = visibleEnd;
  }

  for (const list of piecesByOpMutable.values()) {
    if (list.length > 1) list.sort((a, b) => a.piece.startOrdinal - b.piece.startOrdinal);
  }

  let materializedText                    ;
  const derived                             = Object.freeze({
    pieces,
    visiblePieces,
    piecesByOp: piecesByOpMutable,
    rootPieces,
    totalVirtualLength: virtualPos,
    textLength: visibleOffset,
    get text() {
      if (materializedText === undefined) {
        if (visiblePieces.length === 0) materializedText = '';
        else if (visiblePieces.length === 1) materializedText = visiblePieces[0].piece.text;
        else {
          const chunks = new Array        (visiblePieces.length);
          for (let i = 0; i < visiblePieces.length; i += 1) chunks[i] = visiblePieces[i].piece.text;
          materializedText = chunks.join('');
        }
      }
      return materializedText;
    },
  });
  derivedIndexCache.set(family, derived);
  return derived;
}

function deepFreeze   (value   )    {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value                           )) deepFreeze(child);
  return Object.freeze(value)     ;
}

function findPieceForElement(derived                            , opKeyStr        , ordinal        )                      {
  const list = derived.piecesByOp.get(opKeyStr);
  if (!list) return null;
  if (list.length === 1) {
    const only = list[0];
    return ordinal >= only.piece.startOrdinal && ordinal < only.piece.startOrdinal + only.piece.length ? only : null;
  }
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = list[mid];
    if (ordinal < candidate.piece.startOrdinal) hi = mid - 1;
    else if (ordinal >= candidate.piece.startOrdinal + candidate.piece.length) lo = mid + 1;
    else return candidate;
  }
  return null;
}

function findPieceAtVirtualPos(pieces                         , pos        )         {
  let lo = 0;
  let hi = pieces.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pieces[mid].endVirtualPos > pos) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function findVisiblePieceForOffset(visiblePieces                         , utf16Offset        )         {
  let lo = 0;
  let hi = visiblePieces.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (visiblePieces[mid].visibleEnd >= utf16Offset) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function localOrdinalForOffsetInPiece(ip              , utf16Offset        )                                                    {
  const rel = utf16Offset - ip.visibleStart;
  if (ip.piece.isBmp) {
    const localOrdinal = Math.ceil(rel) - 1;
    return { localOrdinal, scalarEndOffset: ip.visibleStart + localOrdinal + 1 };
  }
  const starts = ensureRunUtf16Starts(ip.piece.run);
  const baseOrdinal = ip.piece.startOrdinal;
  const baseUtf16 = starts[baseOrdinal];
  let lo = 0;
  let hi = ip.piece.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[baseOrdinal + mid + 1] - baseUtf16 >= rel) hi = mid;
    else lo = mid + 1;
  }
  return {
    localOrdinal: lo,
    scalarEndOffset: ip.visibleStart + (starts[baseOrdinal + lo + 1] - baseUtf16),
  };
}

function visibleOffsetAtVirtualPos(derived                            , virtualPos        )         {
  if (virtualPos <= 0) return 0;
  if (virtualPos >= derived.totalVirtualLength) return derived.textLength;
  const idx = findPieceAtVirtualPos(derived.pieces, virtualPos);
  const ip = derived.pieces[idx];
  if (ip.piece.deleted) return ip.visibleStart;
  const localOrdinal = virtualPos - ip.startVirtualPos;
  if (localOrdinal === 0) return ip.visibleStart;
  if (ip.piece.isBmp) return ip.visibleStart + localOrdinal;
  const starts = ensureRunUtf16Starts(ip.piece.run);
  return ip.visibleStart + (starts[ip.piece.startOrdinal + localOrdinal] - starts[ip.piece.startOrdinal]);
}

/**
 * Absolute document-wide endpoint position: the index in the RGA traversal
 * order where this endpoint (with its HISTORICAL basis frontier + affinity)
 * sits against the CURRENT checkpoint.
 */
function endpointVirtualPosition(family                      , endpoint                    )         {
  const derived = derivedIndex(family);
  const anchor = endpoint.point[1];
  const affinity = endpoint.point[2];
  const basis = endpoint.basisFrontier;

  if (anchor[0] === ROOT_ID) {
    if (affinity === 'left') return 0;
    const { rootPieces, totalVirtualLength } = derived;
    for (let i = 0; i < rootPieces.length; i += 1) {
      const ip = rootPieces[i];
      if (frontierDominatesValidated(basis, [ip.piece.op])) return ip.startVirtualPos;
    }
    return totalVirtualLength;
  }

  const [op, ordinal] = anchor[1];
  const opKeyStr = `${op[0]}:${op[1]}`;
  const ip = findPieceForElement(derived, opKeyStr, ordinal);
  if (!ip) fail('anchor element not found in checkpoint');
  const anchorIdx = ip.startVirtualPos + (ordinal - ip.piece.startOrdinal);

  // Clean boundary semantics for the continuous model:
  //   [element, left]  = the boundary BEFORE element K       (index of K)
  //   [element, right] = the boundary AFTER element K's own
  //                      scalar, BEFORE its children (old or
  //                      new)                                (index of K + 1)
  return affinity === 'left' ? anchorIdx : anchorIdx + 1;
}

function assertDominatingBasis(family                      , endpoint                    , label        )       {
  if (!frontierDominatesValidated(family.checkpoint.frontier, endpoint.basisFrontier)) {
    fail(`${label}: current frontier does not dominate endpoint basis — anchor is lost`);
  }
  const anchorKey = anchorKeyStr(endpoint.point[1]);
  if (anchorKey !== ROOT_ID && !hasTextElement(family.checkpoint, anchorKey)) {
    fail(`${label}: endpoint anchor element no longer exists`);
  }
}

/**
 * Compare two structural endpoints against the current checkpoint. Each keeps
 * its historical basis; both must be dominated by the current frontier.
 */
export function compareStructuralEndpoints(family                      , left                    , right                    )         {
  assertTrustedFamily(family);
  assertDominatingBasis(family, left, 'compareStructuralEndpoints');
  assertDominatingBasis(family, right, 'compareStructuralEndpoints');

  const leftAnchor = left.point[1];
  const rightAnchor = right.point[1];
  const leftKey = anchorKeyStr(leftAnchor);
  const rightKey = anchorKeyStr(rightAnchor);

  if (leftKey === rightKey) {
    const leftAffinity = left.point[2];
    const rightAffinity = right.point[2];
    if (leftAffinity === rightAffinity) return 0;
    return leftAffinity === 'left' ? -1 : 1;
  }

  const leftPos = endpointVirtualPosition(family, left);
  const rightPos = endpointVirtualPosition(family, right);
  if (leftPos !== rightPos) return leftPos - rightPos;
  return 0;
}

/** Materialize the visible text between two structural endpoints (zero-width allowed). */
export function materializeRange(family                      , start                    , end                    )         {
  assertTrustedFamily(family);
  assertDominatingBasis(family, start, 'materializeRange');
  assertDominatingBasis(family, end, 'materializeRange');
  if (compareStructuralEndpoints(family, start, end) > 0) fail('materializeRange: start must not be after end');
  const derived = derivedIndex(family);
  const startPos = endpointVirtualPosition(family, start);
  const endPos = endpointVirtualPosition(family, end);
  if (startPos >= endPos || derived.pieces.length === 0) return '';

  const chunks           = [];
  let idx = findPieceAtVirtualPos(derived.pieces, startPos);
  while (idx < derived.pieces.length) {
    const ip = derived.pieces[idx];
    if (ip.startVirtualPos >= endPos) break;
    if (!ip.piece.deleted) {
      const localFrom = Math.max(0, startPos - ip.startVirtualPos);
      const localTo = Math.min(ip.piece.length, endPos - ip.startVirtualPos);
      if (localFrom === 0 && localTo === ip.piece.length) {
        chunks.push(ip.piece.text);
      } else if (ip.piece.isBmp) {
        chunks.push(ip.piece.text.slice(localFrom, localTo));
      } else {
        const starts = ensureRunUtf16Starts(ip.piece.run);
        const base = starts[ip.piece.startOrdinal];
        chunks.push(ip.piece.text.slice(
          starts[ip.piece.startOrdinal + localFrom] - base,
          starts[ip.piece.startOrdinal + localTo] - base,
        ));
      }
    }
    idx += 1;
  }
  return chunks.length === 1 ? chunks[0] : chunks.join('');
}

function frontierEqualsValidated(left          , right          )          {
  if (left === right) return true;
  return left.length === right.length
    && frontierDominatesValidated(left, right)
    && frontierDominatesValidated(right, left);
}

/**
 * Resolve an ABSOLUTE UTF-16 offset into the whole document to a structural
 * endpoint. The basis must equal the current frontier (offsets are always
 * resolved against the live document).
 */
export function resolveOffsetToEndpoint(family                      , utf16Offset        , basisFrontier          , affinity                  )                     {
  assertTrustedFamily(family);
  const trustedBasis = assertFrontier(basisFrontier);
  if (!frontierEqualsValidated(family.checkpoint.frontier, trustedBasis)) {
    fail('resolveOffsetToEndpoint requires basisFrontier equal to family checkpoint frontier');
  }
  const derived = derivedIndex(family);
  assertUtf16Offset(derived.text, utf16Offset);
  if (affinity !== 'left' && affinity !== 'right') fail('resolveOffsetToEndpoint requires an explicit affinity');

  if (utf16Offset === 0) {
    return assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier });
  }
  if (utf16Offset === derived.textLength) {
    return endpointAfterLastVisible(derived, basisFrontier);
  }

  const { visiblePieces } = derived;
  const pieceIdx = findVisiblePieceForOffset(visiblePieces, utf16Offset);
  const ip = visiblePieces[pieceIdx];
  const { localOrdinal, scalarEndOffset } = localOrdinalForOffsetInPiece(ip, utf16Offset);
  const ordinal = ip.piece.startOrdinal + localOrdinal;
  const anchor         = ['element', [[...ip.piece.op], ordinal]];

  if (utf16Offset === scalarEndOffset) {
    if (affinity === 'left') {
      const nextAnchor = nextVisibleAnchorAfter(visiblePieces, pieceIdx, localOrdinal);
      if (nextAnchor) {
        return assertStructuralEndpoint({ point: ['point', nextAnchor, 'left'], basisFrontier });
      }
    }
    return assertStructuralEndpoint({ point: ['point', anchor, 'right'], basisFrontier });
  }
  return assertStructuralEndpoint({ point: ['point', anchor, 'left'], basisFrontier });
}

function nextVisibleAnchorAfter(visiblePieces                         , pieceIdx        , localOrdinal        )                {
  const ip = visiblePieces[pieceIdx];
  if (localOrdinal + 1 < ip.piece.length) {
    return ['element', [[...ip.piece.op], ip.piece.startOrdinal + localOrdinal + 1]];
  }
  if (pieceIdx + 1 < visiblePieces.length) {
    const next = visiblePieces[pieceIdx + 1];
    return ['element', [[...next.piece.op], next.piece.startOrdinal]];
  }
  return null;
}

/**
 * The RGA anchor element for an insert AT an absolute offset: the last visible
 * element whose scalar ends at or contains the offset.
 */
export function insertAnchorForOffset(family                      , utf16Offset        )         {
  const derived = derivedIndex(family);
  if (!(utf16Offset > 0 && utf16Offset <= derived.textLength)) fail('failed to resolve insert anchor for offset');
  const { visiblePieces } = derived;
  const pieceIdx = findVisiblePieceForOffset(visiblePieces, utf16Offset);
  const ip = visiblePieces[pieceIdx];
  const { localOrdinal } = localOrdinalForOffsetInPiece(ip, utf16Offset);
  return ['element', [[...ip.piece.op], ip.piece.startOrdinal + localOrdinal]];
}

function endpointAfterLastVisible(derived                            , basisFrontier          )                     {
  const last = derived.visiblePieces.at(-1);
  if (last) {
    const lastOrdinal = last.piece.startOrdinal + last.piece.length - 1;
    return assertStructuralEndpoint({ point: ['point', ['element', [[...last.piece.op], lastOrdinal]], 'right'], basisFrontier });
  }
  return assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier });
}

/**
 * Project a HISTORICAL-basis endpoint to an absolute UTF-16 offset in the
 * CURRENT document. The current frontier must dominate the endpoint basis and
 * the anchor must still exist (including as a tombstone).
 */
export function projectEndpointToOffset(family                      , endpoint                    )         {
  assertTrustedFamily(family);
  assertDominatingBasis(family, endpoint, 'projectEndpointToOffset');
  const derived = derivedIndex(family);
  const pos = endpointVirtualPosition(family, endpoint);
  return visibleOffsetAtVirtualPos(derived, pos);
}

/** An absolute-offset insert/delete against the whole document (unique actor per edit). */
export function textOperationForOffsetEdit(family                      , edit            , actor        , lamport        )         {
  assertTrustedFamily(family);
  const basis = family.checkpoint.frontier;
  const derived = derivedIndex(family);
  const text = derived.text;
  if (edit.kind === 'text.insert') {
    assertUtf16Offset(text, edit.at.offset);
    const anchor = edit.at.offset === 0 || derived.textLength === 0
      ? ['root']
      : insertAnchorForOffset(family, edit.at.offset);
    return canonicalTextOp(['workbench.text', 1, [actor, 1], lamport, basis, ['insert', anchor, edit.text]]);
  }
  if (edit.kind !== 'text.delete') fail('text.replace is not supported by this builder — compose delete + insert operations; emitting a delete-only op would silently drop the replacement text');
  if (edit.from.offset >= edit.to.offset) fail('delete range must be non-empty and forward');
  assertUtf16Offset(text, edit.from.offset);
  assertUtf16Offset(text, edit.to.offset);

  const rawSpans                                = [];
  const { visiblePieces } = derived;
  if (visiblePieces.length > 0) {
    // First visible piece whose visibleEnd > edit.from.offset.
    let lo = 0;
    let hi = visiblePieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (visiblePieces[mid].visibleEnd > edit.from.offset) hi = mid;
      else lo = mid + 1;
    }
    for (let idx = lo; idx < visiblePieces.length; idx += 1) {
      const ip = visiblePieces[idx];
      if (ip.visibleStart >= edit.to.offset) break;
      const sliceFrom = Math.max(edit.from.offset, ip.visibleStart);
      const sliceTo = Math.min(edit.to.offset, ip.visibleEnd);
      if (sliceFrom >= sliceTo) continue;

      let localStart        ;
      let localEnd        ;
      if (ip.piece.isBmp) {
        localStart = sliceFrom - ip.visibleStart;
        localEnd = sliceTo - ip.visibleStart;
      } else {
        const starts = ensureRunUtf16Starts(ip.piece.run);
        const baseOrdinal = ip.piece.startOrdinal;
        const baseUtf16 = starts[baseOrdinal];
        const relFrom = sliceFrom - ip.visibleStart;
        const relTo = sliceTo - ip.visibleStart;
        let sLo = 0;
        let sHi = ip.piece.length;
        while (sLo < sHi) {
          const mid = (sLo + sHi) >>> 1;
          if (starts[baseOrdinal + mid] - baseUtf16 < relFrom) sLo = mid + 1;
          else sHi = mid;
        }
        localStart = sLo;
        let eLo = localStart;
        let eHi = ip.piece.length;
        while (eLo < eHi) {
          const mid = (eLo + eHi) >>> 1;
          if (starts[baseOrdinal + mid] - baseUtf16 < relTo) eLo = mid + 1;
          else eHi = mid;
        }
        localEnd = eLo;
      }
      if (localEnd > localStart) {
        rawSpans.push([[...ip.piece.op]        , ip.piece.startOrdinal + localStart, localEnd - localStart]);
      }
    }
  }
  if (rawSpans.length === 0) fail('delete range cannot be resolved');

  rawSpans.sort((left, right) => compareOpIdValidated(left[0], right[0]) || left[1] - right[1]);
  const spans                                = [];
  for (let i = 0; i < rawSpans.length; i += 1) {
    const [op, first, count] = rawSpans[i];
    const prior = spans.at(-1);
    if (prior && compareOpIdValidated(prior[0], op) === 0 && prior[1] + prior[2] === first) {
      prior[2] += count;
    } else {
      spans.push([op, first, count]);
    }
  }
  return canonicalTextOp(['workbench.text', 1, [actor, 1], lamport, basis, ['delete', spans]]);
}

/** Apply a whole-document text operation, returning the next family. */
export function applyTextOperation(family                      , operation         )                       {
  assertTrustedFamily(family);
  const nextState = applyTextOp(family.checkpoint, operation);
  return trustFamily({ id: family.id, checkpoint: nextState });
}

export function assertTextEndpointPair(family                      , start                    , end                    , label = 'range')                         {
  assertTrustedFamily(family);
  assertStructuralPoint(start.point);
  assertStructuralPoint(end.point);
  assertFrontier(start.basisFrontier);
  assertFrontier(end.basisFrontier);
  assertDominatingBasis(family, start, label);
  assertDominatingBasis(family, end, label);
  if (compareStructuralEndpoints(family, start, end) >= 0) {
    fail(`${label}: start must be structurally before end`);
  }
  return deepFreeze({ start, end });
}
