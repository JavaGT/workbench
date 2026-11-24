// Document-wide display↔wire coordinate mapping for recipient redaction
// markers (issue #33 step 8). Coordinate spaces:
//
//   canonical  — the server text before recipient projection (not addressed
//                here: the recipient receives the projected document only);
//   wire       — the recipient's document.text, with redacted intervals
//                removed;
//   display    — the wire text as the editor renders it: each redaction
//                placeholder occupies placeholder.length display columns at
//                the display image of its wire start.
//
// A marker { start, end, placeholder } is zero-width in wire space
// (start === end); its placeholder renders as `placeholder` text at the
// display image of `start`. Markers must be sorted by `start`. Every function
// is pure and redaction lists are never mutated.

function displayInterval(redaction, displayed) {
  const start = redaction.start + displayed;
  return { start, end: start + redaction.placeholder.length, nextDisplayed: displayed + redaction.placeholder.length };
}

/** Wire → display. `value` is { offset, affinity? }. A wire offset that lands
 * exactly on a placeholder start maps to its left edge ('left' affinity) or
 * right edge ('right' affinity); a missing affinity chooses the left edge. */
export function wireToDisplayPosition(value, redactions = []) {
  let displayed = 0;
  for (const redaction of redactions) {
    if (value.offset < redaction.start) break;
    if (value.offset === redaction.start) {
      return {
        ...value,
        offset: displayed + redaction.start + (value.affinity === 'right' ? redaction.placeholder.length : 0),
        affinity: value.affinity === 'right' ? 'right' : 'left',
      };
    }
    displayed += redaction.placeholder.length;
  }
  return { ...value, offset: value.offset + displayed };
}

/** Display → wire. Throws TypeError when the offset is inside a placeholder
 * (an interior is not a legal caret). */
export function displayToWirePosition(value, redactions = []) {
  let displayed = 0;
  for (const redaction of redactions) {
    const { start, end, nextDisplayed } = displayInterval(redaction, displayed);
    if (value.offset < start) break;
    if (value.offset === start) return { ...value, offset: redaction.start, affinity: 'left' };
    if (value.offset < end) {
      /** @type {TypeError & { code?: string }} */
      const error = new TypeError('annotated text placeholder is not editable');
      error.code = 'position-redacted';
      throw error;
    }
    if (value.offset === end) return { ...value, offset: redaction.start, affinity: 'right' };
    displayed = nextDisplayed;
  }
  return { ...value, offset: value.offset - displayed };
}

/**
 * Classify a display offset against placeholders.
 * Returns `{ kind: 'left'|'interior'|'right'|'plain', offset, affinity? }`.
 * Interior is not a legal caret; callers return null.
 */
export function classifyDisplayOffset(offset, redactions = []) {
  let displayed = 0;
  for (const redaction of redactions) {
    const { start, end, nextDisplayed } = displayInterval(redaction, displayed);
    if (offset === start) return { kind: 'left', offset, affinity: 'left' };
    if (offset > start && offset < end) return { kind: 'interior', offset };
    if (offset === end) return { kind: 'right', offset, affinity: 'right' };
    displayed = nextDisplayed;
  }
  return { kind: 'plain', offset };
}

/** True when [fromOffset, toOffset] (display) overlaps any placeholder interior/edge span. */
export function selectionCrossesDisplayRedaction(fromOffset, toOffset, redactions = []) {
  let displayed = 0;
  for (const redaction of redactions) {
    const { start, end, nextDisplayed } = displayInterval(redaction, displayed);
    if (fromOffset < end && toOffset > start) return true;
    displayed = nextDisplayed;
  }
  return false;
}

/** Total display width contributed by the placeholders, to back the display
 * length of a rendered wire text out to its wire length. */
export function placeholderDisplayWidth(redactions = []) {
  let total = 0;
  for (const redaction of redactions) total += redaction.placeholder.length;
  return total;
}

// The surrogate/diff helpers are defined ONCE here — this module is a leaf
// (zero imports) — and re-exported by the editor and imported by the snapshot,
// so no consumer keeps a private copy of the UTF-16 scalar grammar.

/** Back a UTF-16 offset off a low-surrogate half onto its scalar start. */
export function scalarStart(text, offset) {
  if (offset > 0 && offset < text.length && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff
    && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff) return offset - 1;
  return offset;
}

/** Push a UTF-16 offset past a low-surrogate half onto its scalar end. */
export function scalarEnd(text, offset) {
  if (offset > 0 && offset < text.length && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff
    && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff) return offset + 1;
  return offset;
}

/**
 * The single scalar-aligned edit between two texts: common prefix/suffix are
 * trimmed, then both bounds back off to UTF-16 scalar edges so an astral
 * character is never split. Shared by the editor, redaction projector and
 * snapshot range shifter.
 */
export function changedRange(before, after) {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > from && afterEnd > from && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  from = scalarStart(before, scalarStart(after, from));
  beforeEnd = scalarEnd(before, beforeEnd);
  return { from, to: beforeEnd, text: after.slice(from, scalarEnd(after, afterEnd)) };
}

/**
 * Project zero-width redaction markers through one wire edit [from, to) →
 * `text` (an insertion has from === to). Markers are absolute in the wire
 * text. An insertion AT a marker attaches by affinity — 'left' shifts the
 * marker right by the inserted length (the text lands before the placeholder),
 * 'right' leaves it — matching the wire→canonical boundary rule. A delete
 * fully before a marker shifts it left by the deleted width; a delete that
 * would cover a marker leaves it in place (such an edit fails closed on the
 * server). Redactions are never mutated.
 */
export function projectRedactionsOverEdit(redactions = [], from, to, text, affinity = 'right') {
  if (redactions.length === 0) return redactions;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) return redactions;
  const insertion = from === to;
  const delta = (text ?? '').length - (to - from);
  return redactions.map((redaction) => {
    if (!redaction || !Number.isSafeInteger(redaction.start) || !Number.isSafeInteger(redaction.end)) return redaction;
    let start = redaction.start;
    let end = redaction.end;
    if (insertion) {
      if (redaction.start > from || (redaction.start === from && affinity === 'left')) {
        start += text.length;
        end += text.length;
      }
    } else if (redaction.start >= to) {
      start += delta;
      end += delta;
    }
    return Object.freeze({ ...redaction, start, end });
  });
}

/**
 * Project markers through the wire text transition before → after by diffing
 * the two texts (the editor's optimistic drafts are wire text, so the
 * placeholder columns never participate).
 */
export function projectRedactionsOverText(redactions = [], beforeText, afterText, affinity = 'right') {
  if (redactions.length === 0 || beforeText === afterText) return redactions;
  const { from, to, text } = changedRange(beforeText, afterText);
  return projectRedactionsOverEdit(redactions, from, to, text, affinity);
}
