// Display-space walks over the recipient's document-wide redaction markers.
// The editor must treat placeholder interiors as non-editable and reject
// selections crossing them; these helpers translate between display and wire
// coordinates (issue #33 step 8, document-wide).
import {
  classifyDisplayOffset,
  displayToWirePosition,
  placeholderDisplayWidth,
  projectRedactionsOverEdit,
  projectRedactionsOverText,
  selectionCrossesDisplayRedaction,
  wireToDisplayPosition,
} from './workbench-annotated-text-redaction-coords.mjs';
import { applyOffsetTextEdit } from './workbench-annotated-text-continuous.mjs';
import { tryResolveRangesOffsets, shiftOffsetRangesOverEdit } from './workbench-annotated-text-snapshot.mjs';

// The blockless document renders as ONE contentEditable root span. The root
// holds interval marker spans (annotation runs) and redaction placeholders
// plus plain text nodes, so a selection point maps to the display offset by
// walking the root's text in document order rather than assuming one direct
// text child.
const BLOCK_ID = 'b';

export function scalarStart(text, offset) {
  if (offset > 0 && offset < text.length && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff
    && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff) return offset - 1;
  return offset;
}

export function scalarEnd(text, offset) {
  if (offset > 0 && offset < text.length && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff
    && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff) return offset + 1;
  return offset;
}

export function changedRange(before, after) {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from += 1;
  from = scalarStart(before, scalarStart(after, from));
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > from && afterEnd > from && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return { from, to: scalarEnd(before, beforeEnd), text: after.slice(from, scalarEnd(after, afterEnd)) };
}

// Project a caret offset through the single edit between `before` and `after`.
// Offsets before the edit are unchanged, offsets after it shift by the length
// delta, and an offset inside a replaced range collapses to the edit start. Used
// to keep a pending caret in place when a render rebases the visible draft onto
// a foreign change (issue #250).
function projectCaretOffset(offset, before, after) {
  if (before === after) return offset;
  const edit = changedRange(before, after);
  const delta = after.length - before.length;
  if (offset <= edit.from) return offset;
  if (offset >= edit.to) return offset + delta;
  return edit.from;
}

// NodeFilter.SHOW_TEXT is 4 per spec; jsdom does not expose a global
// NodeFilter, so use the numeric constant to walk text nodes in any host.
const SHOW_TEXT = 4;

function textWalker(root) {
  return root.ownerDocument.createTreeWalker(root, SHOW_TEXT);
}

function textLengthBefore(span, target) {
  let total = 0;
  const walker = textWalker(span);
  while (walker.nextNode()) {
    const current = walker.currentNode;
    if (current === target) return total;
    if (target.contains(current)) break;
    total += current.data.length;
  }
  return total;
}

function pointInSpan(span, node, offset) {
  if (node === span) {
    if (offset === 0) return 0;
    if (offset === span.childNodes.length) return (span.textContent ?? '').length;
    return null;
  }
  if (!span.contains(node)) return null;
  if (node.nodeType === 3) {
    if (offset < 0 || offset > node.data.length) return null;
    return textLengthBefore(span, node) + offset;
  }
  if (offset < 0 || offset > node.childNodes.length) return null;
  let local = textLengthBefore(span, node);
  for (let index = 0; index < offset; index += 1) local += (node.childNodes[index]?.textContent ?? '').length;
  return local;
}

function rootSpan(element) {
  return [...element.children].find((child) => child.dataset.blockId === BLOCK_ID) ?? null;
}

/**
 * Reconstruct the wire document (text + zero-width markers) from the rendered
 * DOM. Real text nodes concatenate; `[data-restricted]` placeholder spans
 * record a zero-width marker at their wire position. The editor's optimistic
 * drafts are built on the wire text, so placeholder columns never enter the
 * draft, and a placeholder shifts with adjacent typing instead of swallowing
 * the caret. Annotation marker spans wrap real text and contribute normally.
 */
function wireDocumentOf(span) {
  let wire = '';
  const redactions = [];
  const walker = textWalker(span);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.hasAttribute('data-restricted')) {
      redactions.push({ start: wire.length, end: wire.length, placeholder: node.data });
      continue;
    }
    wire += node.data;
  }
  return { text: wire, redactions };
}

/** Bind a blockless plain-text contenteditable to an annotated-text session.
 * The document is ONE `text` with absolute `ranges` and document-wide
 * `redactions`; the editor renders one contentEditable root span and reads
 * caret/selection/edit offsets through the wire↔display coordinate module. */
export function bindAnnotatedTextEditor({ element, session, onError = () => {}, caretLayer, caretColor = null }) {
  if (!element || typeof element.addEventListener !== 'function') throw new TypeError('annotated text editor requires an element');
  if (!session || typeof session.subscribe !== 'function' || typeof session.replace !== 'function') throw new TypeError('annotated text editor requires a session');
  if (typeof onError !== 'function') throw new TypeError('annotated text editor onError must be a function');
  if (caretColor !== null && typeof caretColor !== 'function') throw new TypeError('annotated text editor caretColor must be a function or null');

  let closed = false;
  let rendering = false;
  let composing = null;
  let queued = null;
  let queuedTimer = null;
  let submitted = null;
  let submitting = false;
  let blockedComposition = false;
  let historyInputHandled = false;

  // Recipient-projected caret presence (issue #9). The surface is OPTIONAL and
  // binds only when the host passes a `caretLayer` element AND the session
  // exposes the caret methods; an editor bound to a caret-less session (or no
  // layer) behaves exactly as before.
  const hasCaretSurface = Boolean(
    caretLayer
    && typeof caretLayer.appendChild === 'function'
    && typeof session.publishCaret === 'function'
    && typeof session.clearCaret === 'function'
    && typeof session.onCaret === 'function',
  );
  const CARET_THROTTLE_MS = 100;
  let caretActive = false;
  let caretFrame = null;
  let caretTimer = null;
  let caretThrottle = null;
  // Last published presence shape: either "offset" (collapsed caret) or
  // "from:to" (selection). Deduped so continuous selection drags don't spam.
  let caretSentShape = null;
  let caretLastSentAt = 0;
  let caretWasLive = isLive();
  // The server reveals this connection's own presence token via an `own` op;
  // a marker is "self" only when its presence matches (never by sourceId, which
  // two tabs of the same principal share).
  let selfPresence = null;
  const caretBars = new Map();
  // Remote selection highlights (per presence, one absolutely-positioned div
  // per line rect). Mutually exclusive with the caret bar for a presence.
  const selectionHighlights = new Map();
  const selectionShapes = new Map();
  let unsubscribeCaret = null;

  // The markers the editor is currently showing: an active optimistic draft
  // carries its own (placeholder positions move with adjacent edits), otherwise
  // the session document's. The DOM is repainted with these on every draft
  // change, so the DOM and this helper never disagree.
  function currentRedactions() {
    if (queued) return queued.redactions;
    if (submitted) return submitted.redactions;
    return session.document?.redactions ?? [];
  }

  function currentDocument() {
    return session.document ?? null;
  }

  function isLive() {
    return !session.status || session.status === 'live';
  }

  function failClosedConflict() {
    clearTimeout(queuedTimer);
    queuedTimer = null;
    queued = null;
    submitted = null;
    element.setAttribute('aria-busy', 'false');
    onError(new Error('annotated text changed before buffered input was submitted'));
  }

  /**
   * The session's transient re-projection of an in-flight insert. The fold echo
   * folds the op into the base before the sender receipt settles it, so
   * publish() projects the still-pending op over its own fold: current text
   * briefly shows the insertion applied TWICE (the "double-application"), then
   * reverts to the single application when the receipt lands. The editor must
   * neither rebase drafts onto that phantom extension nor fail closed while it
   * is on screen. Returns null when the pending op is not an insertion.
   */
  function doubleApplication(submitted) {
    if (!submitted) return null;
    const intent = changedRange(submitted.baseText, submitted.text);
    if (intent.from !== intent.to || !intent.text) return null;
    return `${submitted.text.slice(0, intent.from)}${intent.text}${submitted.text.slice(intent.from)}`;
  }

  /**
   * Collapse a queued draft whose base carried a transient tail that never
   * committed. `targetText` is a strict prefix of the draft base (so the tail
   * is a suffix); only pure-insertion drafts can carry such a phantom tail —
   * the session's double-application only extends pending insertions. Any
   * other draft shape fails closed instead of submitting re-derived offsets.
   * Returns null when the draft is not a phantom-insertion collapse.
   */
  function collapseDraft(draft, targetText) {
    const intent = changedRange(draft.baseText, draft.text);
    if (intent.from !== intent.to || !intent.text) return null;
    const at = Math.min(intent.from, targetText.length);
    const collapsed = { ...draft, baseText: targetText, text: `${targetText.slice(0, at)}${intent.text}${targetText.slice(at)}` };
    return { ...collapsed, redactions: projectRedactionsOverText(draft.redactions, draft.text, collapsed.text, draft.affinity) };
  }

  /**
   * Rebase a local draft (baseText → text) onto a foreign target text when the
   * change is compatible: a foreign append or a foreign insert elsewhere. The
   * blockless range projection handles the annotation ranges; the draft's
   * absolute offsets are re-derived from the intent, never guessed.
   */
  function rebaseDraft(draft, targetText) {
    if (draft.text === draft.baseText) {
      return {
        ...draft,
        baseText: targetText,
        text: targetText,
        redactions: projectRedactionsOverText(draft.redactions, draft.text, targetText, draft.affinity),
      };
    }
    const intent = changedRange(draft.baseText, draft.text);
    const prefix = draft.baseText.slice(0, intent.from);
    const suffix = draft.baseText.slice(intent.from);
    let rebased;
    if (intent.from === intent.to && intent.text && targetText.startsWith(draft.baseText)) {
      const foreign = targetText.slice(draft.baseText.length);
      let overlap = 0;
      while (overlap < intent.text.length && overlap < foreign.length
        && intent.text[overlap] === foreign[overlap]) overlap += 1;
      const from = overlap ? targetText.length : intent.from;
      rebased = { ...draft, baseText: targetText, text: `${targetText.slice(0, from)}${intent.text.slice(overlap)}${targetText.slice(from)}` };
    } else if (intent.from === intent.to && intent.text && targetText.startsWith(prefix) && targetText.endsWith(suffix)) {
      const foreign = targetText.slice(prefix.length, targetText.length - suffix.length);
      let overlap = 0;
      while (overlap < intent.text.length && overlap < foreign.length
        && intent.text[overlap] === foreign[overlap]) overlap += 1;
      const from = prefix.length + foreign.length;
      rebased = { ...draft, baseText: targetText, text: `${targetText.slice(0, from)}${intent.text.slice(overlap)}${targetText.slice(from)}` };
    } else {
      return null;
    }
    return { ...rebased, redactions: projectRedactionsOverText(draft.redactions, draft.text, rebased.text, draft.affinity) };
  }

  /** Map a DOM point onto a wire position in the one document text. */
  function endpoint(node, offset, document = session.document) {
    if (!document) return null;
    const redactions = currentRedactions();
    if (node === element) {
      const span = rootSpan(element);
      if (!span || element.childNodes.length === 0) return null;
      if (offset === 0) return { offset: 0, affinity: 'right' };
      if (offset === element.childNodes.length) {
        const wireLength = Math.max(0, (span.textContent ?? '').length - placeholderDisplayWidth(redactions));
        return { offset: wireLength, affinity: 'right' };
      }
      return null;
    }
    let span = node.nodeType === 3 ? node.parentElement : node;
    while (span && span !== element && span.parentElement !== element) span = span.parentElement;
    if (!span || span.dataset.blockId !== BLOCK_ID) return null;
    const local = pointInSpan(span, node, offset);
    if (local === null || local < 0 || local > (span.textContent ?? '').length) return null;
    const classified = classifyDisplayOffset(local, redactions);
    if (classified.kind === 'interior') return null;
    const wire = displayToWirePosition({ offset: local, affinity: classified.affinity ?? 'right' }, redactions);
    return { offset: wire.offset, affinity: wire.affinity };
  }

  function getSelection() {
    const document = currentDocument();
    if (!document) return null;
    const selection = element.ownerDocument.defaultView?.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const from = endpoint(range.startContainer, range.startOffset, document);
    const to = endpoint(range.endContainer, range.endOffset, document);
    if (!from || !to) return null;
    const redactions = currentRedactions();
    const fromDisplay = wireToDisplayPosition({ offset: from.offset, affinity: from.affinity }, redactions);
    const toDisplay = wireToDisplayPosition({ offset: to.offset, affinity: to.affinity }, redactions);
    if (selectionCrossesDisplayRedaction(fromDisplay.offset, toDisplay.offset, redactions)) return null;
    // A text selection's start and end become range endpoints when applied.
    // Both lean 'right' — the same convention the declaration-action handlers
    // use: an insert at the range start joins it (range grows left), while an
    // insert at the range end stays outside (typing after a marker keeps the
    // new text unannotated, e.g. after a confidential span).
    if (fromDisplay.offset > toDisplay.offset) return { from: { ...to, affinity: 'right' }, to: { ...from, affinity: 'right' } };
    if (fromDisplay.offset !== toDisplay.offset) return { from: { ...from, affinity: 'right' }, to: { ...to, affinity: 'right' } };
    return { from, to };
  }

  function setCaret(offset, affinity = 'left', redactions = session.document?.redactions ?? []) {
    const span = rootSpan(element);
    if (!span) return;
    const selection = element.ownerDocument.defaultView?.getSelection();
    if (!selection) return;
    const displayLength = (span.textContent ?? '').length;
    const wireLength = Math.max(0, displayLength - placeholderDisplayWidth(redactions));
    const clamped = Math.max(0, Math.min(offset, wireLength));
    const { offset: displayOffset } = wireToDisplayPosition({ offset: clamped, affinity }, redactions);
    let target = null;
    let nodeOffset = 0;
    let remaining = Math.max(0, Math.min(displayOffset, displayLength));
    const walker = textWalker(span);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (remaining <= node.data.length) {
        target = node;
        nodeOffset = remaining;
        break;
      }
      remaining -= node.data.length;
    }
    if (target === null) {
      target = span;
      nodeOffset = 0;
    }
    const range = element.ownerDocument.createRange();
    range.setStart(target, nodeOffset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // --- Recipient-projected caret plumbing (issue #9) ---
  //
  // LOCAL presence: publish the collapsed caret while the editor is focused
  // and the session is live; retract on blur, close, lost visibility, or any
  // session status that leaves 'live'. Publishes are deduped by offset,
  // coalesced to one per frame (requestAnimationFrame with a setTimeout(0)
  // fallback for hosts without rAF, e.g. jsdom), and throttled to ~100ms for
  // continuous moves; focus publishes immediately. A failed send (offline)
  // never marks the offset as sent, so the next trigger retries.
  // REMOTE presence: every validated annotated-text-caret frame keys a
  // decoration by presence. Carets are vertical bars at the display image of
  // their wire offset; restricted recipients render an opaque edge at the
  // container start. Bars live in `caretLayer` — NEVER inside the container
  // span, so they never enter wireDocumentOf, drafts, or history and never
  // alter text or selection — and are repositioned after every render and on
  // layer/element scroll and window resize.

  function caretDocumentHidden() {
    return element.ownerDocument.visibilityState === 'hidden';
  }

  function caretClearLocal() {
    if (!hasCaretSurface || closed) return;
    caretSentShape = null;
    caretLastSentAt = 0;
    try { session.clearCaret(); } catch { /* isolated */ }
  }

  function publishCaretShape(selection, collapsed, now) {
    try {
      const sent = collapsed
        ? session.publishCaret({ offset: selection.from.offset })
        : session.publishCaret({ offset: selection.to.offset, selection: { from: selection.from.offset, to: selection.to.offset } });
      if (sent) {
        caretSentShape = collapsed
          ? String(selection.from.offset)
          : `${selection.from.offset}:${selection.to.offset}`;
        caretLastSentAt = now;
      }
    } catch { /* isolated */ }
  }

  function caretPublish(immediate = false) {
    if (!hasCaretSurface || closed) return;
    if (!caretActive || !isLive() || caretDocumentHidden()) return;
    const selection = getSelection();
    if (!selection) return;
    const collapsed = selection.from.offset === selection.to.offset;
    const shape = collapsed ? String(selection.from.offset) : `${selection.from.offset}:${selection.to.offset}`;
    if (shape === caretSentShape) return;
    const now = Date.now();
    if (immediate || now - caretLastSentAt >= CARET_THROTTLE_MS) {
      publishCaretShape(selection, collapsed, now);
      return;
    }
    if (caretThrottle != null) return;
    caretThrottle = setTimeout(() => {
      caretThrottle = null;
      if (!closed) caretPublish();
    }, CARET_THROTTLE_MS - (now - caretLastSentAt));
  }

  function caretScheduleFlush() {
    if (!hasCaretSurface || closed) return;
    if (caretFrame != null || caretTimer != null) return;
    const view = element.ownerDocument.defaultView;
    if (view && typeof view.requestAnimationFrame === 'function') {
      caretFrame = view.requestAnimationFrame(() => {
        caretFrame = null;
        caretPublish();
      });
    } else {
      caretTimer = setTimeout(() => {
        caretTimer = null;
        caretPublish();
      }, 0);
    }
  }

  function caretTerminallyUnavailable() {
    return session.status === 'revoked' || session.status === 'unavailable';
  }

  function caretCheckStatus() {
    if (!hasCaretSurface || closed) return;
    const live = isLive();
    if (live === caretWasLive) return;
    caretWasLive = live;
    if (!live) {
      // Transient recoveries (recovering/catching-up) must NOT clear the
      // window's presence — peers keep seeing it. Only a terminal loss of the
      // document session (revoked/unavailable) retracts the caret.
      if (caretTerminallyUnavailable()) caretClearLocal();
    } else if (caretActive) {
      caretPublish(true);
    }
  }

  function handleCaretFocus() {
    if (!hasCaretSurface || closed) return;
    caretActive = true;
    caretSentShape = null;
    caretPublish(true);
  }

  function handleCaretBlur() {
    if (!hasCaretSurface || closed) return;
    caretActive = false;
    if (caretThrottle != null) {
      clearTimeout(caretThrottle);
      caretThrottle = null;
    }
    caretClearLocal();
  }

  function handleSelectionChange() {
    caretScheduleFlush();
  }

  function handleCaretFrame(frame) {
    if (closed) return;
    const change = frame?.change;
    if (!change || typeof change !== 'object') return;
    const presence = change.value?.presence ?? change.presence;
    if (typeof presence !== 'string' || presence === '') return;
    if (change.op === 'own') {
      selfPresence = change.presence;
    } else if (change.op === 'upsert') {
      const value = change.value;
      if (!value || typeof value !== 'object') return;
      // "Self" is decided CLIENT-SIDE by matching the marker's connection-scoped
      // presence token against the one the server revealed for this connection.
      const isSelf = selfPresence !== null && value.presence === selfPresence;
      if (value.kind === 'caret') upsertCaretBar(presence, 'caret', value.offset, isSelf);
      else if (value.kind === 'edge') upsertCaretBar(presence, 'edge', null, isSelf);
      else if (value.kind === 'selection') upsertSelectionHighlight(presence, value.from, value.to);
    } else if (change.op === 'remove') {
      removeCaretBar(presence);
    }
  }

  function caretBarFor(presence) {
    let bar = caretBars.get(presence);
    if (bar) return bar;
    bar = caretLayer.ownerDocument.createElement('div');
    bar.dataset.presence = presence;
    bar.dataset.kind = 'caret';
    bar.setAttribute('contenteditable', 'false');
    bar.style.position = 'absolute';
    bar.style.pointerEvents = 'none';
    // The host owns the palette: a `caretColor(presence)` hook lets each
    // session's bar render in its own color without the editor knowing what
    // the colors mean. The bar consumes the value through `--caret-color`.
    const color = typeof caretColor === 'function' ? caretColor(presence) : null;
    if (color) bar.style.setProperty('--caret-color', color);
    caretLayer.appendChild(bar);
    caretBars.set(presence, bar);
    return bar;
  }

  function upsertCaretBar(presence, kind, offset, self = false) {
    clearSelectionHighlight(presence);
    const bar = caretBarFor(presence);
    bar.dataset.kind = kind;
    if (self) bar.dataset.self = 'true';
    else delete bar.dataset.self;
    if (kind === 'caret' && Number.isSafeInteger(offset) && offset >= 0) {
      bar.dataset.offset = String(offset);
      bar.__displayOffset = wireToDisplayPosition({ offset, affinity: 'left' }, currentRedactions()).offset;
    } else {
      delete bar.dataset.offset;
      bar.__displayOffset = null;
    }
    repositionCaretBars();
  }

  function removeCaretBar(presence) {
    clearSelectionHighlight(presence);
    const bar = caretBars.get(presence);
    if (!bar) return;
    bar.remove();
    caretBars.delete(presence);
  }

  // --- Remote selection presence (issue: collaborative selection) ---
  // A session with a non-collapsed selection renders as one translucent
  // highlight div per line rect of the selected display range (multi-line
  // selections get one div per line), keyed by the same presence token and
  // consuming the same per-session color.

  function displayPointFor(displayOffset) {
    const span = rootSpan(element);
    if (!span) return null;
    const displayLength = (span.textContent ?? '').length;
    let target = null;
    let nodeOffset = 0;
    let remaining = Math.max(0, Math.min(displayOffset, displayLength));
    const walker = textWalker(span);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (remaining <= node.data.length) {
        target = node;
        nodeOffset = remaining;
        break;
      }
      remaining -= node.data.length;
    }
    if (target === null) {
      target = span;
      nodeOffset = 0;
    }
    return { node: target, offset: nodeOffset };
  }

  function selectionRects(from, to) {
    const start = displayPointFor(from);
    const end = displayPointFor(to);
    if (!start || !end) return [];
    const range = element.ownerDocument.createRange();
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    } catch {
      return [];
    }
    if (typeof range.getClientRects === 'function') {
      return [...range.getClientRects()];
    }
    const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
    return rect && !Number.isNaN(rect.left) && !Number.isNaN(rect.top) ? [rect] : [];
  }

  function upsertSelectionHighlight(presence, from, to) {
    const bar = caretBars.get(presence);
    if (bar) {
      bar.remove();
      caretBars.delete(presence);
    }
    clearSelectionHighlight(presence);
    let layerRect = null;
    try { layerRect = caretLayer.getBoundingClientRect(); } catch { /* ignore */ }
    if (!layerRect) return;
    const color = typeof caretColor === 'function' ? caretColor(presence) : null;
    const doc = caretLayer.ownerDocument;
    const els = [];
    for (const rect of selectionRects(from, to)) {
      if (rect.width <= 0 && rect.height <= 0) continue;
      const el = doc.createElement('div');
      el.dataset.presence = presence;
      el.dataset.kind = 'selection';
      el.setAttribute('contenteditable', 'false');
      el.style.position = 'absolute';
      el.style.pointerEvents = 'none';
      el.style.left = `${rect.left - layerRect.left}px`;
      el.style.top = `${rect.top - layerRect.top}px`;
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
      if (color) el.style.setProperty('--caret-color', color);
      caretLayer.appendChild(el);
      els.push(el);
    }
    if (els.length > 0) {
      selectionHighlights.set(presence, els);
      selectionShapes.set(presence, { from, to });
    }
  }

  function clearSelectionHighlight(presence) {
    const els = selectionHighlights.get(presence);
    if (!els) return;
    for (const el of els) el.remove();
    selectionHighlights.delete(presence);
    selectionShapes.delete(presence);
  }

  function clearRemoteCaretBars() {
    for (const els of selectionHighlights.values()) for (const el of els) el.remove();
    selectionHighlights.clear();
    for (const bar of caretBars.values()) bar.remove();
    caretBars.clear();
  }

  function caretDisplayPoint(displayOffset) {
    const span = rootSpan(element);
    if (!span) return null;
    const displayLength = (span.textContent ?? '').length;
    let target = null;
    let nodeOffset = 0;
    let remaining = Math.max(0, Math.min(displayOffset, displayLength));
    const walker = textWalker(span);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (remaining <= node.data.length) {
        target = node;
        nodeOffset = remaining;
        break;
      }
      remaining -= node.data.length;
    }
    if (target === null) {
      target = span;
      nodeOffset = 0;
    }
    const range = element.ownerDocument.createRange();
    range.setStart(target, nodeOffset);
    range.collapse(true);
    if (typeof range.getClientRects === 'function') {
      return range.getClientRects()[0] ?? null;
    }
    const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
    return rect && !Number.isNaN(rect.left) && !Number.isNaN(rect.top) ? rect : null;
  }

  function repositionCaretBars() {
    if (!hasCaretSurface || closed) return;
    let layerRect = null;
    try { layerRect = caretLayer.getBoundingClientRect(); } catch { /* ignore */ }
    for (const bar of caretBars.values()) {
      if (bar.__displayOffset == null) {
        // An opaque edge has no offset: pin it to the container's start.
        bar.style.left = '0px';
        bar.style.top = '0px';
        continue;
      }
      if (!layerRect) continue;
      const rect = caretDisplayPoint(bar.__displayOffset);
      if (!rect) continue;
      // A caret bar is a line-height marker at the caret's display point, not a
      // full-height column: pin its top to the caret line and size it to that
      // line box (the layer's own height is the whole editor).
      bar.style.left = `${rect.left - layerRect.left}px`;
      bar.style.top = `${rect.top - layerRect.top}px`;
      if (rect.height > 0) bar.style.height = `${rect.height}px`;
    }
    // Selections track text on scroll/resize the same way: re-render from the
    // stored display range. Iterate a snapshot — each re-render deletes and
    // re-adds its key in `selectionShapes`, which would otherwise loop forever
    // on a live Map iterator.
    for (const [presence, shape] of [...selectionShapes]) {
      upsertSelectionHighlight(presence, shape.from, shape.to);
    }
  }

  /**
   * Interval-rendered inline spans (issue #33 step 8). The blockless document
   * is ONE text with absolute annotation ranges and zero-width redaction
   * markers; the editor renders maximal flat runs of constant annotation-id
   * set as marker spans, plus a `data-restricted` placeholder span per
   * redaction. Display offsets count placeholder widths, matching the
   * redaction coords module; wire offsets name the text without placeholders.
   */

  /** Split the one document text into LF-delimited runs. Every run keeps its
   * trailing `\n` (when it has one) as its last scalar, so the container's
   * textContent — wire text plus placeholder columns — stays byte-identical to
   * the flat rendering and the display↔wire coordinate walks keep working
   * unchanged. Empty text is one empty run. */
  function splitRuns(text) {
    const runs = [];
    let start = 0;
    while (true) {
      const nl = text.indexOf('\n', start);
      if (nl === -1) {
        runs.push({ start, end: text.length, text: text.slice(start) });
        return runs;
      }
      runs.push({ start, end: nl + 1, text: text.slice(start, nl + 1) });
      start = nl + 1;
    }
  }

  /** The run-local view of the document-wide ranges and redaction markers.
   * A run covers [start, end) of the wire text; ranges and markers are clipped
   * to that window. A zero-width marker exactly at a run boundary belongs to
   * the following run (its placeholder renders at that run's start), except a
   * marker at the document end, which belongs to the last run. */
  function runLocalView(run, ranges, redactions, textLength) {
    const isLast = run.end === textLength;
    const positive = [];
    const zeroWidth = [];
    for (const range of ranges ?? []) {
      if (range.start === range.end) {
        if (range.start >= run.start && (range.start < run.end || (isLast && range.start === run.end))) {
          zeroWidth.push({ annotationId: range.annotationId, start: range.start - run.start });
        }
        continue;
      }
      const local = {
        annotationId: range.annotationId,
        start: Math.max(range.start, run.start) - run.start,
        end: Math.min(range.end, run.end) - run.start,
      };
      if (local.start < local.end) positive.push(local);
    }
    const runRedactions = (redactions ?? [])
      .filter((redaction) => redaction.start >= run.start && (redaction.start < run.end || (isLast && redaction.start === run.end)))
      .map((redaction) => ({ ...redaction, start: redaction.start - run.start, end: redaction.end - run.start }));
    return { positive, zeroWidth, redactions: runRedactions };
  }

  /** Render a run's display children: maximal flat marker spans of constant
   * annotation-id set, plus redaction placeholder spans, exactly as the flat
   * renderer would for the same segment (never nested, never altering text or
   * selection offsets). */
  function runChildren(doc, text, positiveRanges, zeroWidthRanges, redactions, annotationsById) {
    const points = new Set();
    for (const range of positiveRanges) {
      points.add(range.start);
      points.add(range.end);
    }
    for (const redaction of redactions) points.add(redaction.start);
    const sorted = [...points].sort((left, right) => left - right);
    const children = [];
    const emitRun = (from, to) => {
      if (to <= from) return;
      const activeIds = positiveRanges
        .filter((range) => range.start < to && range.end > from)
        .map((range) => range.annotationId);
      const segment = text.slice(from, to);
      if (activeIds.length === 0) {
        children.push(doc.createTextNode(segment));
        return;
      }
      const marker = doc.createElement('span');
      marker.dataset.annotationIds = activeIds.sort().join(' ');
      const families = [...new Set(activeIds.map((id) => annotationsById.get(id)).filter(Boolean))].sort();
      if (families.length) marker.dataset.annotationFamilies = families.join(' ');
      marker.textContent = segment;
      children.push(marker);
    };
    let cursor = 0;
    for (const point of sorted) {
      if (point > cursor) emitRun(cursor, point);
      for (const redaction of redactions) {
        if (redaction.start !== point) continue;
        const restricted = doc.createElement('span');
        restricted.dataset.restricted = 'true';
        restricted.contentEditable = 'false';
        restricted.textContent = redaction.placeholder;
        // Show-through: a zero-width range that coincides with a redaction
        // marker wraps the placeholder in an annotation marker span.
        const showThrough = zeroWidthRanges
          .filter((range) => range.start === redaction.start)
          .map((range) => range.annotationId)
          .sort();
        if (showThrough.length === 0) {
          children.push(restricted);
          continue;
        }
        const marker = doc.createElement('span');
        marker.dataset.annotationIds = showThrough.join(' ');
        const families = [...new Set(showThrough.map((id) => annotationsById.get(id)).filter(Boolean))].sort();
        if (families.length) marker.dataset.annotationFamilies = families.join(' ');
        marker.appendChild(restricted);
        children.push(marker);
      }
      cursor = point;
    }
    if (cursor < text.length) emitRun(cursor, text.length);
    return children;
  }

  function runSignature(run, ranges, redactions, textLength) {
    const view = runLocalView(run, ranges, redactions, textLength);
    const positivePart = view.positive.map((range) => `${range.annotationId}:${range.start}:${range.end}`).join(',');
    const zeroWidthPart = view.zeroWidth.map((range) => `${range.annotationId}:${range.start}`).join(',');
    const redactionPart = view.redactions.map((redaction) => `${redaction.start}:${redaction.placeholder}`).join(',');
    return `${run.text}|${positivePart}|${zeroWidthPart}|${redactionPart}`;
  }

  function paintRun(element, run, ranges, redactions, annotationsById, textLength) {
    const view = runLocalView(run, ranges, redactions, textLength);
    const doc = element.ownerDocument;
    const children = runChildren(doc, run.text, view.positive, view.zeroWidth, view.redactions, annotationsById);
    element.textContent = '';
    for (const child of children) element.appendChild(child);
  }

  const runPainted = new WeakMap();

  /**
   * Paint the one contentEditable root span as keyed LF-delimited run
   * fragments. `draftEdit` projects the ranges through a pending local draft
   * so optimistic text paints markers at their shifted positions. Runs are
   * reconciled by absolute interval: every node records the full text and the
   * [from, to) segment it was painted with, and on paint the single edit
   * between the stored text and the current text (a queued draft or one remote
   * change) projects each node's interval — before the edit unchanged, after
   * it shifted by the length delta, overlapping it touched. A node whose
   * projected interval EXACTLY equals a target run's interval keeps that run's
   * node, so an unchanged following run survives a split/join even when its
   * content duplicates an earlier run (absolute intervals are unique where
   * content signatures are not). Touched nodes go to a recycle pool that
   * unmatched target runs claim (repainting in place) or fresh elements fill;
   * leftover nodes are removed. Returns true when the DOM changed.
   */
  function recoverFromResolutionFailure() {
    if (typeof session.recoverFromUnresolvableRange === 'function') session.recoverFromUnresolvableRange();
    else if (typeof session.reconnect === 'function') session.reconnect();
  }

  function paintDisplay(span, document, text, draftEdit) {
    let family = session.family ?? null;
    if (family && draftEdit) {
      try {
        family = applyOffsetTextEdit(family, draftEdit.from, draftEdit.to, draftEdit.text);
      } catch {
        recoverFromResolutionFailure();
        family = null;
      }
    }
    let ranges;
    if (family) {
      ranges = tryResolveRangesOffsets(document.ranges, family);
      if (ranges === null) {
        recoverFromResolutionFailure();
        ranges = [];
      }
    } else {
      ranges = draftEdit
        ? shiftOffsetRangesOverEdit(document.ranges, draftEdit.from, draftEdit.to, draftEdit.text)
        : document.ranges;
    }
    const redactions = currentRedactions();
    const annotationsById = new Map((document.annotations ?? []).map((annotation) => [annotation.id, annotation.family]));
    const runs = splitRuns(text);
    const doc = span.ownerDocument;
    const existing = [...span.children];

    // Every node shares the text the last paint was made from, and successive
    // paints differ by exactly one edit, so changedRange names that edit and
    // the interval projection is exact.
    const previousText = existing.length ? (runPainted.get(existing[0])?.text ?? null) : null;
    const edit = previousText === null ? null : changedRange(previousText, text);
    const delta = previousText === null ? 0 : text.length - previousText.length;
    const targetByInterval = new Map();
    for (let index = 0; index < runs.length; index += 1) {
      targetByInterval.set(`${runs[index].start}:${runs[index].end}`, index);
    }

    // Which existing node each target run takes (-1 means a fresh element).
    const runNode = new Array(runs.length).fill(-1);
    const usedExisting = new Array(existing.length).fill(false);

    // First pass: exact projected-interval equality keeps the node that
    // painted that segment before. Intervals are unique, so duplicate run
    // content can never detach an unchanged run's node.
    for (let index = 0; index < existing.length; index += 1) {
      const record = runPainted.get(existing[index]);
      if (!record || !edit) continue;
      let projected;
      if (record.to <= edit.from) {
        projected = { from: record.from, to: record.to };
      } else if (record.from >= edit.to) {
        projected = { from: record.from + delta, to: record.to + delta };
      } else {
        continue;
      }
      const target = targetByInterval.get(`${projected.from}:${projected.to}`);
      if (target !== undefined && runNode[target] === -1) {
        runNode[target] = index;
        usedExisting[index] = true;
      }
    }

    // Second pass: unmatched target runs claim the first unmatched pooled node
    // (repainted in place) or create a fresh element when the pool runs out.
    let nextPool = 0;
    for (let index = 0; index < runs.length; index += 1) {
      if (runNode[index] !== -1) continue;
      while (nextPool < existing.length && usedExisting[nextPool]) nextPool += 1;
      if (nextPool < existing.length) {
        runNode[index] = nextPool;
        usedExisting[nextPool] = true;
        nextPool += 1;
      }
    }

    let domChanged = false;
    const finalChildren = [];
    for (let index = 0; index < runs.length; index += 1) {
      const existingIndex = runNode[index];
      let element;
      if (existingIndex !== -1) {
        element = existing[existingIndex];
      } else {
        element = doc.createElement('span');
        domChanged = true;
      }
      element.dataset.runIndex = String(index);
      // Repaint a node's children only when its local content — text segment,
      // overlapping ranges, and redaction markers — differs from what it shows.
      const signature = runSignature(runs[index], ranges, redactions, text.length);
      if (runPainted.get(element)?.signature !== signature) {
        paintRun(element, runs[index], ranges, redactions, annotationsById, text.length);
        domChanged = true;
      }
      runPainted.set(element, { text, from: runs[index].start, to: runs[index].end, signature });
      finalChildren.push(element);
    }
    if (finalChildren.length !== existing.length
      || finalChildren.some((child, index) => child !== existing[index])) domChanged = true;
    if (domChanged) {
      span.textContent = '';
      for (const child of finalChildren) span.appendChild(child);
    }
    return domChanged;
  }

  function pendingDraftText() {
    if (queued) return queued.text;
    if (submitted) return submitted.text;
    if (composing) return composing.text;
    return null;
  }

  function render(document = session.document) {
    if (closed || composing) return;
    if (!document) {
      for (const child of [...element.children]) child.remove();
      caretCheckStatus();
      // Retract the local caret only on terminal loss of the session; a
      // transient null document (revoke paths aside) must not wipe presence.
      if (caretTerminallyUnavailable()) caretClearLocal();
      return;
    }
    const current = document ?? session.document;
    // A render that merely confirms the already-displayed optimistic state must
    // not move the caret. Browsers collapse a selection to the start of a
    // contentEditable node the moment its text node is replaced, so capture the
    // caret before touching the DOM and restore it when the render did not
    // intentionally relocate it (a draft move sets the caret directly instead).
    const caretBeforeRender = closed ? null : getSelection();
    // The caret offset is captured in the wire text currently displayed — which
    // includes a pending queued/submitted draft. A remote change rebases that
    // draft, so the displayed wire text changes under the caret; project the
    // captured offset through that change when restoring (issue #250).
    const spanBeforeRender = caretBeforeRender ? rootSpan(element) : null;
    const wireBeforeRender = spanBeforeRender ? wireDocumentOf(spanBeforeRender).text : null;

    // Reconcile the in-flight edit against the authoritative text. The server
    // folds the edit at the absolute offsets it captured; when a compatible
    // foreign change arrived first, rebase the draft onto the foreign text.
    if (submitted) {
      if (current.text === submitted.text) {
        submitted.ingested = true;
        if (!submitting) submitted = null;
      } else if (current.text !== submitted.baseText && current.text !== doubleApplication(submitted)) {
        const rebased = rebaseDraft(submitted, current.text);
        if (rebased) submitted = rebased;
      }
    }
    if (queued && current.text !== queued.baseText) {
      if (submitted && current.text === doubleApplication(submitted) && queued.baseText === submitted.text) {
        // The session re-projected the in-flight op over its fold; current will
        // revert to submitted.text. The queued draft is already based on that
        // text; wait for the revert instead of rebasing onto the phantom.
      } else {
        const rebased = rebaseDraft(queued, current.text);
        if (rebased) {
          queued = rebased;
        } else if (queued.text === '') {
          // An emptied local draft is not a conflict; the foreign text wins.
          clearTimeout(queuedTimer);
          queuedTimer = null;
          queued = null;
        } else if (!submitting && !(submitted && current.text === submitted.baseText && queued.baseText === submitted.text) && isLive()) {
          if (current.text.length < queued.baseText.length && queued.baseText.startsWith(current.text)) {
            // The draft base carried a transient tail the session never
            // committed (double-application reverted). Only pure-insertion
            // drafts can be collapsed onto the authoritative text; anything
            // else fails closed rather than submitting re-derived offsets.
            const collapsed = collapseDraft(queued, current.text);
            if (collapsed) queued = collapsed;
            else failClosedConflict();
          } else {
            failClosedConflict();
          }
        }
      }
    }

    let draftText = null;
    if (submitted && current.text === submitted.baseText) draftText = submitted.text;
    if (queued) draftText = queued.text;
    const text = draftText ?? current.text ?? '';
    const draftEdit = queued ? changedRange(queued.baseText, queued.text) : null;

    rendering = true;
    let domMutated = false;
    let span = rootSpan(element);
    if (!span) {
      span = element.ownerDocument.createElement('span');
      span.dataset.blockId = BLOCK_ID;
      element.appendChild(span);
      domMutated = true;
    }
    if (span.contentEditable !== 'true') {
      span.contentEditable = 'true';
      domMutated = true;
    }
    if (paintDisplay(span, current, text, draftEdit)) domMutated = true;
    rendering = false;

    if (domMutated && caretBeforeRender?.from && caretBeforeRender.to
      && caretBeforeRender.from.offset === caretBeforeRender.to.offset) {
      const wireAfterRender = wireDocumentOf(span).text;
      const restoredOffset = wireBeforeRender === null
        ? caretBeforeRender.from.offset
        : projectCaretOffset(caretBeforeRender.from.offset, wireBeforeRender, wireAfterRender);
      setCaret(restoredOffset, caretBeforeRender.from.affinity, currentRedactions());
    }
    if (queued && current.text === queued.baseText && !submitting && isLive()) flushQueued();
    if (!queued && !submitted && !submitting) {
      element.setAttribute('aria-busy', 'false');
    }
    // A render may have restored or moved the caret (edits, remote folds, the
    // re-placement after a DOM repaint) — reflect the collapsed caret on the
    // wire so peers see typing in progress.
    caretCheckStatus();
    caretScheduleFlush();
    repositionCaretBars();
  }

  function report(work) {
    element.setAttribute('aria-busy', 'true');
    const tracked = Promise.resolve(work).then(async (result) => {
      if (result?.ok === false) onError(result.failure ?? result.deliveryError ?? result);
      if (result?.ok && result.settlement?.wait) await result.settlement.wait();
      return result;
    }, onError).finally(() => {
      if (!queued && !submitted && !submitting) element.setAttribute('aria-busy', 'false');
    });
    void tracked;
    return tracked;
  }

  async function replace(from, to, text, affinity = 'right') {
    submitting = true;
    try {
      const result = await report(session.replace({
        from: { offset: from, affinity },
        to: { offset: to, affinity },
        text,
      }));
      if (!result?.ok) {
        submitted = null;
        queued = null;
        clearTimeout(queuedTimer);
        queuedTimer = null;
        element.setAttribute('aria-busy', 'false');
        render();
      }
    } finally {
      submitting = false;
      const current = currentDocument();
      if (submitted?.ingested || (queued && current?.text === queued.baseText)) {
        submitted = null;
        if (queued) flushQueued();
      }
      if (submitted && submitted.text === '' && submitted.ingested) submitted = null;
      render();
    }
  }

  function flushQueued() {
    if (!queued || submitting || (session.status && session.status !== 'live')) return;
    const current = currentDocument();
    if (!current || current.text !== queued.baseText) return;
    const pending = queued;
    queued = null;
    queuedTimer = null;
    const change = changedRange(pending.baseText, pending.text);
    if (change.from !== change.to || change.text) {
      submitted = { ...pending, ingested: false };
      void replace(change.from, change.to, change.text, pending.affinity);
    } else {
      element.setAttribute('aria-busy', 'false');
    }
  }

  function bufferEdit(from, to, text, affinity = 'right') {
    if (!queued) {
      const span = rootSpan(element);
      // The in-flight op's own fold echo or its transient double-application is
      // the only authoritative baseline for a successor draft; never build a
      // queued base on the phantom doubled text the session will revert. The
      // displayed DOM is DISPLAY text, so the baseline is reconstructed as wire
      // text (placeholder columns excluded).
      const displayedWire = span ? wireDocumentOf(span).text : '';
      const pendingBase = submitting && submitted && (displayedWire === submitted.text || displayedWire === doubleApplication(submitted));
      const baseline = pendingBase ? submitted.text : session.document?.text ?? '';
      const baselineRedactions = pendingBase ? submitted.redactions : session.document?.redactions ?? [];
      queued = { baseText: baseline, baseRedactions: baselineRedactions, text: baseline, redactions: baselineRedactions, affinity };
    }
    queued.affinity = affinity;
    queued.text = `${queued.text.slice(0, from)}${text}${queued.text.slice(to)}`;
    queued.redactions = projectRedactionsOverEdit(queued.redactions ?? [], from, to, text, affinity);
    element.setAttribute('aria-busy', 'true');
    rendering = true;
    const span = rootSpan(element);
    if (span) paintDisplay(span, session.document, queued.text, changedRange(queued.baseText, queued.text));
    setCaret(from + text.length, affinity, queued.redactions);
    rendering = false;
    clearTimeout(queuedTimer);
    queuedTimer = setTimeout(flushQueued, 100);
  }

  function deleteRange(inputType, text, from, to) {
    if (from !== to) return { from: scalarStart(text, from), to: scalarEnd(text, to) };
    if (inputType === 'deleteSoftLineBackward' || inputType === 'deleteHardLineBackward') {
      const lineStart = text.lastIndexOf('\n', from - 1) + 1;
      return lineStart === from ? null : { from: lineStart, to: scalarEnd(text, from) };
    }
    if (inputType === 'deleteContentBackward') return from === 0 ? null : { from: scalarStart(text, from - 1), to: from };
    if (inputType === 'deleteContentForward' || inputType === 'deleteContent') return to === text.length ? null : { from: to, to: scalarEnd(text, to + 1) };
    return null;
  }

  function beforeInput(event) {
    if (closed || rendering) return;
    if (event.isComposing || event.inputType === 'insertCompositionText') return;
    event.preventDefault();
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      if (queued || submitted || submitting || composing) {
        onError(new Error('annotated text history is unavailable while a local change is pending'));
        return;
      }
      historyInputHandled = true;
      report(event.inputType === 'historyUndo' ? session.history.undo() : session.history.redo());
      return;
    }
    const selected = getSelection();
    if (!selected) return;
    if (event.inputType === 'insertText' || event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop'
      || event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      // Enter creates a paragraph boundary: the LF-delimited run model treats a
      // paragraph break as an ordinary '\n' scalar insertion through the one
      // replace path, so insertParagraph/insertLineBreak buffer a '\n' exactly
      // like typing any other character.
      const text = event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak'
        ? '\n'
        : (event.dataTransfer?.getData?.('text/plain') ?? event.data ?? '');
      if (text) {
        // A collapsed caret at a redaction placeholder edge carries the affinity
        // that pins it to the visible neighbor; pass it through so the typed
        // text attaches to that neighbor instead of defaulting to the marker's
        // 'right' edge (the placeholder must never swallow the caret).
        const affinity = selected.from.offset === selected.to.offset ? (selected.from.affinity ?? 'right') : 'right';
        bufferEdit(selected.from.offset, selected.to.offset, text, affinity);
      }
      return;
    }
    if (event.inputType === 'deleteByCut') {
      // Cut removes the selection through the same replace path; the clipboard
      // side of cut needs no handling here.
      if (selected.from.offset !== selected.to.offset) bufferEdit(selected.from.offset, selected.to.offset, '');
      return;
    }
    const text = pendingDraftText() ?? session.document?.text ?? '';
    // Caret left on a hollow pruned view: hop immediately.
    const onPrunedEmpty = text === '' && selected.from.offset === selected.to.offset;
    const range = onPrunedEmpty ? null : deleteRange(event.inputType, text, selected.from.offset, selected.to.offset);
    if (range) {
      bufferEdit(range.from, range.to, '');
      return;
    }
    // Blockless: there is no adjacent block to delete into.
  }

  function compositionStart(event) {
    const selected = getSelection();
    if (!selected) {
      blockedComposition = true;
      event.preventDefault();
      render();
      return;
    }
    if (submitted) {
      clearTimeout(queuedTimer);
      queuedTimer = null;
      queued = null;
      composing = { text: submitted.text, redactions: submitted.redactions, afterSubmitted: true };
      return;
    }
    // Keep buffered typing as the composition's predecessor. Composition
    // end will turn the whole visible result into one queued draft, so a
    // foreign update is rebased by the same path as ordinary typing. The base
    // markers are captured here (the pre-composition wire coordinates) so the
    // end handler can carry them onto the queued draft.
    clearTimeout(queuedTimer);
    queuedTimer = null;
    composing = {
      text: queued ? queued.text : session.document?.text ?? '',
      redactions: queued ? queued.redactions : session.document?.redactions ?? [],
      queuedBaseText: queued ? queued.baseText : session.document?.text ?? '',
    };
  }

  function compositionEnd() {
    if (blockedComposition) {
      blockedComposition = false;
      render();
      return;
    }
    if (!composing) return;
    const base = composing;
    composing = null;
    const span = rootSpan(element);
    if (!span) {
      render();
      return;
    }
    // The DOM holds DISPLAY text (placeholder columns included). Reconstruct
    // the wire text and the markers' shifted positions so the queued draft is
    // built on the wire document the session authors; the placeholder columns
    // never enter the draft and the markers move with adjacent composition.
    const wire = wireDocumentOf(span);
    const queuedBaseText = base.queuedBaseText ?? base.text;
    if (wire.text === base.text && queuedBaseText === base.text) {
      queued = null;
      render();
      return;
    }
    queued = {
      baseText: queuedBaseText,
      baseRedactions: base.redactions ?? [],
      text: wire.text,
      redactions: wire.redactions,
    };
    element.setAttribute('aria-busy', 'true');
    render();
  }

  function historyIsBlocked() {
    if (!queued && !submitted && !submitting && !composing) return false;
    onError(new Error('annotated text history is unavailable while a local change is pending'));
    return true;
  }

  function keyDown(event) {
    if (event.isComposing) return;
    const modifier = event.metaKey || event.ctrlKey;
    const undo = modifier && !event.altKey && (event.key === 'z' || event.key === 'Z');
    const redo = modifier && !event.altKey && !event.shiftKey && (event.key === 'y' || event.key === 'Y');
    if (!undo && !redo) return;
    event.preventDefault();
    historyInputHandled = false;
    queueMicrotask(() => {
      if (closed || historyInputHandled) return;
      if (historyIsBlocked()) return;
      report((redo || event.shiftKey) ? session.history.redo() : session.history.undo());
    });
  }

  function annotationSpans(annotationId) {
    if (closed || annotationId == null || annotationId === '') return [];
    return [...element.querySelectorAll('[data-annotation-ids]')]
      .filter((span) => (span.dataset.annotationIds?.split(' ') ?? []).includes(annotationId));
  }

  function setAnnotationHighlight(annotationId, active) {
    for (const span of annotationSpans(annotationId)) {
      if (active) span.dataset.activeAnnotation = 'true';
      else delete span.dataset.activeAnnotation;
    }
  }

  function selectAnnotation(annotationId) {
    const spans = annotationSpans(annotationId);
    const first = spans[0];
    const last = spans.at(-1);
    if (!first || !last) return;
    const doc = element.ownerDocument;
    const range = doc.createRange();
    range.setStart(first.firstChild ?? first, 0);
    if (last.firstChild?.nodeType === 3) range.setEnd(last.firstChild, last.firstChild.data.length);
    else range.setEnd(last, last.childNodes.length);
    element.focus();
    const selection = doc.defaultView?.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  element.setAttribute('contenteditable', 'plaintext-only');
  element.setAttribute('aria-busy', 'false');
  element.addEventListener('beforeinput', beforeInput);
  element.addEventListener('compositionstart', compositionStart);
  element.addEventListener('compositionend', compositionEnd);
  element.addEventListener('keydown', keyDown);
  const unsubscribe = session.subscribe(render);
  if (hasCaretSurface) {
    unsubscribeCaret = session.onCaret(handleCaretFrame);
    element.addEventListener('focus', handleCaretFocus);
    element.addEventListener('blur', handleCaretBlur);
    element.ownerDocument.addEventListener('selectionchange', handleSelectionChange);
    caretLayer.addEventListener('scroll', repositionCaretBars);
    element.addEventListener('scroll', repositionCaretBars);
    element.ownerDocument.defaultView?.addEventListener('resize', repositionCaretBars);
  }
  render();

  return Object.freeze({
    focus() { element.focus(); },
    getSelection,
    setAnnotationHighlight,
    selectAnnotation,
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(queuedTimer);
      unsubscribe();
      if (unsubscribeCaret) unsubscribeCaret();
      if (hasCaretSurface) {
        // Best-effort retraction and decoration teardown before listeners go.
        try { session.clearCaret(); } catch { /* best effort */ }
        clearRemoteCaretBars();
        if (caretThrottle != null) {
          clearTimeout(caretThrottle);
          caretThrottle = null;
        }
        if (caretFrame != null) {
          element.ownerDocument.defaultView?.cancelAnimationFrame?.(caretFrame);
          caretFrame = null;
        }
        if (caretTimer != null) {
          clearTimeout(caretTimer);
          caretTimer = null;
        }
        element.removeEventListener('focus', handleCaretFocus);
        element.removeEventListener('blur', handleCaretBlur);
        element.ownerDocument.removeEventListener('selectionchange', handleSelectionChange);
        caretLayer.removeEventListener('scroll', repositionCaretBars);
        element.removeEventListener('scroll', repositionCaretBars);
        element.ownerDocument.defaultView?.removeEventListener('resize', repositionCaretBars);
      }
      element.removeEventListener('beforeinput', beforeInput);
      element.removeEventListener('compositionstart', compositionStart);
      element.removeEventListener('compositionend', compositionEnd);
      element.removeEventListener('keydown', keyDown);
    },
  });
}
