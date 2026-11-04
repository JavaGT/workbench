import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { bindAnnotatedTextEditor } from '../public/workbench-client.mjs';

function visible(text) {
  return { version: 1, text, ranges: [], annotations: [] };
}

function setup(text = 'Hello', document = visible(text)) {
  const dom = new JSDOM('<div id="editor"></div>');
  const element = dom.window.document.getElementById('editor');
  const calls = [];
  const errors = [];
  let listener = null;
  const session = {
    document,
    history: {
      undo: async () => { calls.push(['undo']); },
      redo: async () => { calls.push(['redo']); },
    },
    replace: async (input) => { calls.push(['replace', input]); return { ok: true }; },
    subscribe(next) { listener = next; return () => { listener = null; }; },
  };
  const binding = bindAnnotatedTextEditor({ element, session, onError: (error) => errors.push(error) });
  // Select a range by DISPLAY offsets (placeholder columns included) across all
  // text nodes inside the one root span. The keyed-run DOM splits the text into
  // per-run text nodes, so offsets are resolved by walking the span's text in
  // document order (semantically identical to the old single-flat-text-node
  // selection for any document that rendered as one text node before).
  function select(from, to = from) {
    element.focus();
    const span = element.querySelector('[data-block-id="b"]');
    const point = (target) => {
      let offset = 0;
      const walker = span.ownerDocument.createTreeWalker(span, 4);
      let node;
      while ((node = walker.nextNode())) {
        const next = offset + node.data.length;
        if (target <= next) return [node, target - offset];
        offset = next;
      }
      if (target === offset) return [span, 0];
      throw new Error('display offset is outside the editor');
    };
    const [startNode, startOffset] = point(from);
    const [endNode, endOffset] = point(to);
    const range = dom.window.document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    dom.window.getSelection().removeAllRanges();
    dom.window.getSelection().addRange(range);
  }
  function beforeinput(inputType, data = null, extras = {}) {
    const event = new dom.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data, ...extras });
    element.dispatchEvent(event);
    return event;
  }
  // Replace the whole document's rendered text (used by the composition tests,
  // which mutate the DOM between compositionstart and compositionend the way a
  // real IME does). The first text node holds the whole single-run text; set
  // its data so the keyed-run structure survives until the repaint.
  function setDocumentText(text) {
    const span = element.querySelector('[data-block-id="b"]');
    const node = span?.ownerDocument.createTreeWalker(span, 4).nextNode();
    if (node) node.data = text;
    else if (span) span.textContent = text;
  }
  // Select a range by DISPLAY offsets (placeholder columns included) across all
  // text nodes inside the one root span. Used for redacted documents where the
  // placeholder splits the DOM into several text nodes.
  function displaySelect(from, to = from) {
    select(from, to);
  }
  return { dom, element, session, calls, errors, binding, select, displaySelect, beforeinput, setDocumentText, publish(document) { session.document = document; listener?.(document); } };
}

const flushInput = () => new Promise((resolve) => setTimeout(resolve, 110));

test('annotated editor replaces a selection within the document', async () => {
  const harness = setup();
  assert.equal(harness.element.textContent, 'Hello');
  harness.select(1, 4);
  const event = harness.beforeinput('insertText', 'i');
  assert.equal(event.defaultPrevented, true);
  assert.equal(harness.element.textContent, 'Hio');
  await flushInput();
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 1, affinity: 'right' },
    to: { offset: 4, affinity: 'right' },
    text: 'i',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor backspace and forward delete preserve surrogate pairs', async () => {
  const backward = setup('a😀b');
  backward.select(3);
  backward.beforeinput('deleteContentBackward');
  await flushInput();
  assert.deepEqual(backward.calls[0][1], {
    from: { offset: 1, affinity: 'right' },
    to: { offset: 3, affinity: 'right' },
    text: '',
  });
  backward.binding.close();

  const forward = setup('a😀b');
  forward.select(1);
  forward.beforeinput('deleteContentForward');
  await flushInput();
  assert.deepEqual(forward.calls[0][1], {
    from: { offset: 1, affinity: 'right' },
    to: { offset: 3, affinity: 'right' },
    text: '',
  });
  forward.binding.close();
});

test('annotated editor deletes at a collapsed document boundary are no-ops', async () => {
  const backward = setup('ab');
  backward.select(0);
  backward.beforeinput('deleteContentBackward');
  await flushInput();
  assert.deepEqual(backward.calls, []);
  assert.deepEqual(backward.errors, []);
  backward.binding.close();

  const forward = setup('ab');
  forward.select(2);
  forward.beforeinput('deleteContentForward');
  await flushInput();
  assert.deepEqual(forward.calls, []);
  assert.deepEqual(forward.errors, []);
  forward.binding.close();
});

test('annotated editor deletes to the start of the line for soft and hard line backward input', async () => {
  for (const inputType of ['deleteSoftLineBackward', 'deleteHardLineBackward']) {
    const harness = setup('a\nb');
    harness.select(3);
    harness.beforeinput(inputType);
    await flushInput();
    assert.deepEqual(harness.calls[0][1], {
      from: { offset: 2, affinity: 'right' },
      to: { offset: 3, affinity: 'right' },
      text: '',
    });
    harness.binding.close();

    const emoji = setup('a\n😀b');
    emoji.select(5);
    emoji.beforeinput(inputType);
    await flushInput();
    assert.deepEqual(emoji.calls[0][1], {
      from: { offset: 2, affinity: 'right' },
      to: { offset: 5, affinity: 'right' },
      text: '',
    });
    emoji.binding.close();

    const lineStart = setup('a\nb');
    lineStart.select(2);
    lineStart.beforeinput(inputType);
    await flushInput();
    assert.deepEqual(lineStart.calls, []);
    lineStart.binding.close();
  }
});

test('annotated editor commits composition once and delegates history', async () => {
  const harness = setup('ab');
  harness.select(1);
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  harness.setDocumentText('a語b');
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionend', { bubbles: true, data: '語' }));
  await Promise.resolve();
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0][0], 'replace');
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 1, affinity: 'right' },
    to: { offset: 1, affinity: 'right' },
    text: '語',
  });
  harness.beforeinput('historyUndo');
  harness.beforeinput('historyRedo');
  assert.deepEqual(harness.calls.slice(1), []);
  assert.match(harness.errors.at(-1).message, /history is unavailable/);
  harness.binding.close();
});

test('annotated editor clears busy state after an unchanged composition', () => {
  const harness = setup('Hello');
  harness.select(5);
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionend', { bubbles: true }));

  assert.equal(harness.element.getAttribute('aria-busy'), 'false');
  assert.deepEqual(harness.calls, []);
  harness.binding.close();
});

test('annotated editor accepts a foreign update during an unchanged composition', () => {
  const harness = setup('Hello');
  harness.select(5);
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  harness.publish(visible('Hello!'));
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionend', { bubbles: true }));

  assert.equal(harness.element.textContent, 'Hello!');
  assert.equal(harness.element.getAttribute('aria-busy'), 'false');
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor rebases compatible buffered insertion over a foreign append', async () => {
  const harness = setup('ab');
  harness.select(1);
  harness.beforeinput('insertText', 'X');
  harness.publish(visible('ab!'));
  assert.equal(harness.element.textContent, 'aXb!');
  await flushInput();
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 1, affinity: 'right' },
    to: { offset: 1, affinity: 'right' },
    text: 'X',
  });
  harness.binding.close();
});

test('annotated editor preserves the caret across a compatible foreign fold while input is buffered', async () => {
  const harness = setup('ab');
  harness.select(1);
  harness.beforeinput('insertText', 'X');
  assert.equal(harness.element.textContent, 'aXb');
  assert.deepEqual(harness.binding.getSelection(), {
    from: { offset: 2, affinity: 'right' },
    to: { offset: 2, affinity: 'right' },
  });
  // A foreign fold appends text; the draft rebases onto the foreign text and
  // the caret stays after the locally-typed character (not at the buffer start).
  harness.publish(visible('ab!'));
  assert.equal(harness.element.textContent, 'aXb!');
  assert.deepEqual(harness.binding.getSelection(), {
    from: { offset: 2, affinity: 'right' },
    to: { offset: 2, affinity: 'right' },
  });
  harness.binding.close();
});

test('annotated editor preserves later typing while the preceding replacement settles', async () => {
  const harness = setup('a');
  const settlements = [];
  harness.session.status = 'live';
  harness.session.replace = async (input) => {
    harness.calls.push(['replace', input]);
    return { ok: true, settlement: { wait: () => new Promise((resolve) => { settlements.push(resolve); }) } };
  };
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  await flushInput();
  assert.equal(harness.calls.length, 1);
  harness.element.focus();
  harness.select(2);
  harness.beforeinput('insertText', 'c');
  await flushInput();
  assert.equal(harness.element.textContent, 'abc');
  assert.equal(harness.calls.length, 1, 'later input remains buffered while the first replacement settles');
  // The package session projects the first replacement before its receipt settles.
  harness.publish(visible('ab'));
  settlements.shift()();
  await flushInput();
  assert.deepEqual(harness.calls[1][1], {
    from: { offset: 2, affinity: 'right' },
    to: { offset: 2, affinity: 'right' },
    text: 'c',
  });
  harness.element.focus();
  harness.select(3);
  harness.beforeinput('insertText', 'd');
  await flushInput();
  assert.equal(harness.element.textContent, 'abcd');
  assert.equal(harness.calls.length, 2, 'the second in-flight draft remains the baseline for later input');
  harness.publish(visible('abc'));
  settlements.shift()();
  await flushInput();
  assert.deepEqual(harness.calls[2][1], {
    from: { offset: 3, affinity: 'right' },
    to: { offset: 3, affinity: 'right' },
    text: 'd',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor waits for receipt ingest before flushing a queued successor', async () => {
  const harness = setup('a');
  const settlements = [];
  harness.session.status = 'live';
  harness.session.replace = async (input) => {
    harness.calls.push(['replace', input]);
    return { ok: true, settlement: { wait: () => new Promise((resolve) => settlements.push(resolve)) } };
  };
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  await flushInput();
  harness.select(2);
  harness.beforeinput('insertText', 'c');
  await flushInput();
  settlements.shift()();
  await flushInput();
  assert.equal(harness.element.textContent, 'abc');
  assert.equal(harness.element.getAttribute('aria-busy'), 'true');
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.errors, []);

  harness.publish(visible('ab'));
  await flushInput();
  assert.deepEqual(harness.calls[1][1], {
    from: { offset: 2, affinity: 'right' },
    to: { offset: 2, affinity: 'right' },
    text: 'c',
  });
  harness.publish(visible('abc'));
  settlements.shift()();
  await flushInput();
  assert.equal(harness.element.getAttribute('aria-busy'), 'false');
  harness.binding.close();
});

test('annotated editor folds queued typing into one composition replacement', async () => {
  const harness = setup('a');
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  harness.setDocumentText('ab語');
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionend', { bubbles: true, data: '語' }));
  await Promise.resolve();

  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 1, affinity: 'right' },
    to: { offset: 1, affinity: 'right' },
    text: 'b語',
  });
  harness.binding.close();
});

test('annotated editor rebases queued typing and composition over a compatible foreign append', () => {
  const harness = setup('a');
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  harness.publish(visible('ac'));
  harness.setDocumentText('ab語');
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionend', { bubbles: true, data: '語' }));

  assert.equal(harness.element.textContent, 'ab語c');
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 1, affinity: 'right' },
    to: { offset: 1, affinity: 'right' },
    text: 'b語',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor reports an incompatible update after queued composition instead of dropping it', () => {
  const harness = setup('a');
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  harness.publish(visible('foreign replacement'));
  harness.setDocumentText('ab語');
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionend', { bubbles: true, data: '語' }));

  assert.equal(harness.element.textContent, 'foreign replacement');
  assert.match(harness.errors.at(-1).message, /changed before buffered input/);
  harness.binding.close();
});

test('annotated editor blocks history while queued and permits retry after ingest', async () => {
  const harness = setup('a');
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  harness.beforeinput('historyUndo');
  assert.deepEqual(harness.calls, []);

  await flushInput();
  harness.publish(visible('ab'));
  await flushInput();
  harness.beforeinput('historyUndo');
  await Promise.resolve();
  assert.deepEqual(harness.calls.slice(1), [['undo']]);
  harness.binding.close();
});

test('annotated editor blocks keydown history while local work is pending', async () => {
  const harness = setup('a');
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  const event = new harness.dom.window.KeyboardEvent('keydown', {
    bubbles: true, cancelable: true, key: 'z', ctrlKey: true,
  });
  harness.element.dispatchEvent(event);
  await Promise.resolve();
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(harness.calls, []);
  assert.match(harness.errors.at(-1).message, /history is unavailable/);
  harness.binding.close();
});

test('annotated editor queues composition behind a submitted replacement', async () => {
  const harness = setup('a');
  const settlements = [];
  harness.session.status = 'live';
  harness.session.replace = async (input) => {
    harness.calls.push(['replace', input]);
    return { ok: true, settlement: { wait: () => new Promise((resolve) => settlements.push(resolve)) } };
  };
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  await flushInput();
  harness.select(2);
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  harness.setDocumentText('ab語');
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionend', { bubbles: true, data: '語' }));
  await flushInput();

  assert.equal(harness.element.textContent, 'ab語');
  assert.equal(harness.calls.length, 1, 'composition waits for the submitted replacement to ingest');
  harness.publish(visible('ab'));
  settlements.shift()();
  await flushInput();
  assert.deepEqual(harness.calls[1][1], {
    from: { offset: 2, affinity: 'right' },
    to: { offset: 2, affinity: 'right' },
    text: '語',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor reports an incompatible foreign update after submitted input ingests', async () => {
  const harness = setup('a');
  const settlements = [];
  harness.session.status = 'live';
  harness.session.replace = async (input) => {
    harness.calls.push(['replace', input]);
    return { ok: true, settlement: { wait: () => new Promise((resolve) => { settlements.push(resolve); }) } };
  };
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  await flushInput();
  harness.publish(visible('ab'));
  settlements.shift()();
  await flushInput();
  harness.element.focus();
  harness.select(2);
  harness.beforeinput('insertText', 'c');
  harness.publish(visible('foreign replacement'));

  assert.equal(harness.element.textContent, 'foreign replacement');
  assert.equal(harness.element.getAttribute('aria-busy'), 'false');
  assert.match(harness.errors.at(-1).message, /changed before buffered input/);
  harness.binding.close();
});

test('annotated editor discards buffered successor after its predecessor is rejected', async () => {
  const harness = setup('a');
  let reject;
  harness.session.status = 'live';
  harness.session.replace = async (input) => {
    harness.calls.push(['replace', input]);
    return new Promise((resolve) => { reject = resolve; });
  };
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  await flushInput();
  harness.element.focus();
  harness.select(2);
  harness.beforeinput('insertText', 'c');
  reject({ ok: false, failure: new Error('replacement rejected') });
  await flushInput();

  assert.equal(harness.element.textContent, 'a');
  assert.match(harness.errors.at(-1).message, /replacement rejected/);
  harness.binding.close();
});

test('annotated editor submits new input from a foreign snapshot after its predecessor settles', async () => {
  const harness = setup('a');
  let settle;
  harness.session.status = 'live';
  harness.session.replace = async (input) => {
    harness.calls.push(['replace', input]);
    return { ok: true, settlement: { wait: () => new Promise((resolve) => { settle = resolve; }) } };
  };
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  await flushInput();
  harness.publish(visible('foreign'));
  harness.element.focus();
  harness.select(7);
  harness.beforeinput('insertText', '!');
  settle();
  await flushInput();

  assert.deepEqual(harness.calls[1][1], {
    from: { offset: 7, affinity: 'right' },
    to: { offset: 7, affinity: 'right' },
    text: '!',
  });
  harness.binding.close();
});

test('annotated editor conflict errors never include buffered or document text', () => {
  const harness = setup('private document text');
  harness.select(1);
  harness.beforeinput('insertText', 'secret buffered text');
  harness.publish(visible('incompatible replacement'));

  assert.equal(harness.errors[0].message, 'annotated text changed before buffered input was submitted');
  assert.doesNotMatch(harness.errors[0].message, /private|secret|replacement/);
  harness.binding.close();
});

test('annotated editor fails closed when a buffered delete base reverts to a shorter prefix', () => {
  // A transient tail (double-application reversion) collapses onto the
  // authoritative text only for pure insertions. A buffered DELETE whose base
  // becomes a strict prefix must fail closed instead of re-deriving offsets.
  const harness = setup('abXc');
  harness.select(1, 2);
  harness.beforeinput('deleteContentBackward');
  harness.publish(visible('abX'));

  assert.deepEqual(harness.calls, []);
  assert.equal(harness.errors[0].message, 'annotated text changed before buffered input was submitted');
  harness.binding.close();
});

test('annotated editor collapses a buffered insertion whose base reverts to a shorter prefix', () => {
  const harness = setup('abc');
  harness.select(3);
  harness.beforeinput('insertText', 'X');
  // The optimistic base 'abcX' reverts to the committed 'abc' (the tail never
  // landed); the pure-insertion draft collapses and still submits exactly once.
  harness.publish(visible('abc'));
  harness.session.status = 'live';
  return flushInput().then(() => {
    assert.equal(harness.calls.length, 1);
    assert.deepEqual(harness.calls[0][1], {
      from: { offset: 3, affinity: 'right' },
      to: { offset: 3, affinity: 'right' },
      text: 'X',
    });
    assert.deepEqual(harness.errors, []);
    harness.binding.close();
  });
});

test('annotated editor renders redaction placeholders inside the one root span', () => {
  const document = {
    version: 1, text: 'hello  world', ranges: [], annotations: [],
    redactions: [{ start: 6, end: 6, placeholder: '[restricted]' }],
  };
  const harness = setup('', document);
  assert.equal(harness.element.children.length, 1);
  const span = harness.element.firstChild;
  assert.equal(span.dataset.blockId, 'b');
  assert.equal(span.contentEditable, 'true');
  assert.equal(harness.element.textContent, 'hello [restricted] world');
  const restricted = harness.element.querySelector('[data-restricted="true"]');
  assert.ok(restricted);
  assert.equal(restricted.contentEditable, 'false');
  assert.equal(restricted.textContent, '[restricted]');
  harness.binding.close();
});

test('annotated editor wraps a redaction placeholder in an annotation marker at a zero-width comment range', () => {
  const document = {
    version: 1, text: 'hello  world',
    ranges: [{ annotationId: 'comment-1', start: 6, end: 6 }],
    annotations: [{ id: 'comment-1', family: 'comment', fields: {} }],
    redactions: [{ start: 6, end: 6, placeholder: '[restricted]' }],
  };
  const harness = setup('', document);
  assert.equal(harness.element.textContent, 'hello [restricted] world');
  const marker = harness.element.querySelector('[data-annotation-ids="comment-1"]');
  assert.ok(marker);
  assert.equal(marker.dataset.annotationFamilies, 'comment');
  assert.equal(marker.hasAttribute('contenteditable'), false);
  assert.equal(marker.textContent, '[restricted]');
  const restricted = marker.querySelector('[data-restricted="true"]');
  assert.ok(restricted);
  assert.equal(restricted.contentEditable, 'false');
  assert.equal(restricted.textContent, '[restricted]');
  harness.binding.close();
});

test('annotated editor exposes annotation families and identities on interval markers', () => {
  const document = {
    version: 1, text: 'marked', ranges: [{ annotationId: 'comment-1', start: 0, end: 6 }],
    annotations: [{ id: 'comment-1', family: 'comment', fields: {} }],
  };
  const harness = setup('', document);
  const marked = harness.element.querySelector('[data-annotation-ids="comment-1"]');
  assert.equal(marked.dataset.annotationFamilies, 'comment');
  assert.equal(marked.textContent, 'marked');
  harness.binding.close();
});

test('annotated editor maps a span boundary to the end of the document', () => {
  const harness = setup('Right');
  const span = harness.element.querySelector('[data-block-id="b"]');
  const range = harness.dom.window.document.createRange();
  range.setStart(span, span.childNodes.length);
  range.collapse(true);
  const selection = harness.dom.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  assert.deepEqual(harness.binding.getSelection(), {
    from: { offset: 5, affinity: 'right' },
    to: { offset: 5, affinity: 'right' },
  });
  harness.binding.close();
});

test('annotated editor rejects selections crossing a redaction placeholder', () => {
  const document = {
    version: 1, text: 'hello  world', ranges: [], annotations: [],
    redactions: [{ start: 6, end: 6, placeholder: '[restricted]' }],
  };
  const harness = setup('', document);
  const selection = harness.dom.window.getSelection();
  const span = harness.element.querySelector('[data-block-id="b"]');
  // A caret at the placeholder's left display edge maps to its wire start
  // (the keyed-run DOM splits the text into fragments, so place it by display
  // offset across the run's text nodes).
  harness.displaySelect(6);
  assert.deepEqual(harness.binding.getSelection(), {
    from: { offset: 6, affinity: 'left' },
    to: { offset: 6, affinity: 'left' },
  });
  // A selection spanning the placeholder maps to no valid range.
  const crossing = harness.dom.window.document.createRange();
  const displayPoint = (target) => {
    let offset = 0;
    const walker = span.ownerDocument.createTreeWalker(span, 4);
    let node;
    while ((node = walker.nextNode())) {
      const next = offset + node.data.length;
      if (target <= next) return [node, target - offset];
      offset = next;
    }
    throw new Error('display offset is outside the editor');
  };
  const [startNode, startOffset] = displayPoint(2);
  const [endNode, endOffset] = displayPoint(20);
  crossing.setStart(startNode, startOffset);
  crossing.setEnd(endNode, endOffset);
  selection.removeAllRanges(); selection.addRange(crossing);
  assert.equal(harness.binding.getSelection(), null);
  // A caret inside the placeholder is not a legal position.
  const restricted = harness.element.querySelector('[data-restricted="true"]');
  const interior = harness.dom.window.document.createRange();
  interior.setStart(restricted.firstChild, 2);
  interior.collapse(true);
  selection.removeAllRanges(); selection.addRange(interior);
  assert.equal(harness.binding.getSelection(), null);
  harness.binding.close();
});

test('annotated editor fails closed when an incompatible foreign change arrives while input is buffered', () => {
  const harness = setup('Right');
  harness.select(5);
  harness.beforeinput('insertText', '!');
  harness.publish(visible('foreign replacement'));

  assert.equal(harness.element.textContent, 'foreign replacement');
  assert.equal(harness.element.getAttribute('aria-busy'), 'false');
  assert.match(harness.errors[0].message, /changed before buffered input/);
  harness.binding.close();
});

test('annotated editor optimistically empties the document and keeps the one root span', async () => {
  const harness = setup('ab');
  harness.session.status = 'live';
  harness.select(2);
  harness.beforeinput('deleteContentBackward');
  harness.element.focus();
  harness.select(1);
  harness.beforeinput('deleteContentBackward');
  assert.equal(harness.element.textContent, '');
  assert.equal(harness.element.querySelectorAll('[data-block-id="b"]').length, 1);
  await flushInput();
  assert.ok(harness.calls.length >= 1, 'emptying the document submits a delete');
  harness.publish(visible(''));
  await flushInput();
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

function annotatedDocument() {
  return {
    version: 1,
    text: 'abcdef',
    ranges: [
      { annotationId: 'ann-1', start: 0, end: 4 },
      { annotationId: 'ann-2', start: 2, end: 6 },
    ],
    annotations: [
      { id: 'ann-1', family: 'comment', fields: {} },
      { id: 'ann-2', family: 'comment', fields: {} },
    ],
  };
}

function markerSpans(element) {
  return [...element.querySelectorAll('[data-annotation-ids]')];
}

test('setAnnotationHighlight toggles data-active-annotation on matching spans only', () => {
  const harness = setup('', annotatedDocument());
  const onlyAnn1 = markerSpans(harness.element).find((span) => span.textContent === 'ab');
  const overlap = markerSpans(harness.element).find((span) => span.textContent === 'cd');
  const onlyAnn2 = markerSpans(harness.element).find((span) => span.textContent === 'ef');
  assert.ok(onlyAnn1 && overlap && onlyAnn2);

  harness.binding.setAnnotationHighlight('ann-1', true);
  assert.equal(onlyAnn1.dataset.activeAnnotation, 'true');
  assert.equal(overlap.dataset.activeAnnotation, 'true');
  assert.equal(onlyAnn2.hasAttribute('data-active-annotation'), false);

  harness.binding.setAnnotationHighlight('ann-1', false);
  assert.equal(onlyAnn1.hasAttribute('data-active-annotation'), false);
  assert.equal(overlap.hasAttribute('data-active-annotation'), false);
  assert.equal(onlyAnn2.hasAttribute('data-active-annotation'), false);
  harness.binding.close();
});

test('setAnnotationHighlight is a no-op for an unknown annotation id', () => {
  const harness = setup('', annotatedDocument());
  const before = harness.element.innerHTML;
  harness.binding.setAnnotationHighlight('missing', true);
  assert.equal(harness.element.innerHTML, before);
  harness.binding.close();
});

test('selectAnnotation selects the contiguous range across all matching spans', () => {
  const harness = setup('', annotatedDocument());
  harness.binding.selectAnnotation('ann-1');
  const selection = harness.dom.window.getSelection();
  assert.equal(selection.rangeCount, 1);
  const range = selection.getRangeAt(0);
  const onlyAnn1 = markerSpans(harness.element).find((span) => span.textContent === 'ab');
  const overlap = markerSpans(harness.element).find((span) => span.textContent === 'cd');
  assert.equal(range.startContainer, onlyAnn1.firstChild);
  assert.equal(range.startOffset, 0);
  assert.equal(range.endContainer, overlap.firstChild);
  assert.equal(range.endOffset, overlap.firstChild.data.length);
  assert.equal(harness.element.ownerDocument.activeElement, harness.element);
  harness.binding.close();
});

test('selectAnnotation is a no-op for an unknown annotation id', () => {
  const harness = setup('', annotatedDocument());
  harness.element.focus();
  const selection = harness.dom.window.getSelection();
  selection.removeAllRanges();
  harness.binding.selectAnnotation('missing');
  assert.equal(selection.rangeCount, 0);
  harness.binding.close();
});

test('annotation helpers fail closed after close', () => {
  const harness = setup('', annotatedDocument());
  const onlyAnn1 = markerSpans(harness.element).find((span) => span.textContent === 'ab');
  harness.binding.close();
  harness.binding.setAnnotationHighlight('ann-1', true);
  assert.equal(onlyAnn1.hasAttribute('data-active-annotation'), false);
  harness.binding.selectAnnotation('ann-1');
  assert.equal(harness.dom.window.getSelection().rangeCount, 0);
});

function redactedDocument() {
  return {
    version: 1, text: 'hello  world', ranges: [], annotations: [],
    redactions: [{ start: 6, end: 6, placeholder: '[restricted]' }],
  };
}

test('annotated editor attaches a right-edge caret to the visible right neighbor', async () => {
  const harness = setup('', redactedDocument());
  assert.equal(harness.element.textContent, 'hello [restricted] world');
  // The caret at the placeholder's right display edge maps to the marker with
  // right affinity, pinning it to the visible right neighbor.
  harness.displaySelect(18);
  assert.deepEqual(harness.binding.getSelection(), {
    from: { offset: 6, affinity: 'right' },
    to: { offset: 6, affinity: 'right' },
  });

  harness.beforeinput('insertText', 'Y');
  // Y renders on the placeholder's right side and the caret passes it — the
  // placeholder never swallows the caret.
  assert.equal(harness.element.textContent, 'hello [restricted]Y world');
  assert.deepEqual(harness.binding.getSelection(), {
    from: { offset: 7, affinity: 'right' },
    to: { offset: 7, affinity: 'right' },
  });
  await flushInput();
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 6, affinity: 'right' },
    to: { offset: 6, affinity: 'right' },
    text: 'Y',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor attaches a left-edge caret to the visible left neighbor', async () => {
  const harness = setup('', redactedDocument());
  harness.displaySelect(6);
  assert.deepEqual(harness.binding.getSelection(), {
    from: { offset: 6, affinity: 'left' },
    to: { offset: 6, affinity: 'left' },
  });

  harness.beforeinput('insertText', 'X');
  // X renders on the placeholder's left side; the zero-width marker shifts past
  // it (wire 7) instead of swallowing the typed text.
  assert.equal(harness.element.textContent, 'hello X[restricted] world');
  assert.deepEqual(harness.binding.getSelection(), {
    from: { offset: 7, affinity: 'left' },
    to: { offset: 7, affinity: 'left' },
  });
  await flushInput();
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 6, affinity: 'left' },
    to: { offset: 6, affinity: 'left' },
    text: 'X',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor composes consecutive edge typing through the placeholder boundary', async () => {
  // Left edge: two keystrokes buffer into one replacement; the marker keeps
  // shifting ahead of the typed text and the caret stays on the visible side.
  const left = setup('', redactedDocument());
  left.displaySelect(6);
  left.beforeinput('insertText', 'X');
  assert.equal(left.element.textContent, 'hello X[restricted] world');
  assert.deepEqual(left.binding.getSelection(), {
    from: { offset: 7, affinity: 'left' },
    to: { offset: 7, affinity: 'left' },
  });
  left.beforeinput('insertText', 'Y');
  assert.equal(left.element.textContent, 'hello XY[restricted] world');
  assert.deepEqual(left.binding.getSelection(), {
    from: { offset: 8, affinity: 'left' },
    to: { offset: 8, affinity: 'left' },
  });
  await flushInput();
  assert.equal(left.calls.length, 1, 'consecutive edge typing composes into one replacement');
  assert.deepEqual(left.calls[0][1], {
    from: { offset: 6, affinity: 'left' },
    to: { offset: 6, affinity: 'left' },
    text: 'XY',
  });
  assert.deepEqual(left.errors, []);
  left.binding.close();

  // Right edge: the same two keystrokes compose on the visible right neighbor.
  const right = setup('', redactedDocument());
  right.displaySelect(18);
  right.beforeinput('insertText', 'X');
  right.beforeinput('insertText', 'Y');
  assert.equal(right.element.textContent, 'hello [restricted]XY world');
  assert.deepEqual(right.binding.getSelection(), {
    from: { offset: 8, affinity: 'right' },
    to: { offset: 8, affinity: 'right' },
  });
  await flushInput();
  assert.equal(right.calls.length, 1, 'consecutive right-edge typing composes into one replacement');
  assert.deepEqual(right.calls[0][1], {
    from: { offset: 6, affinity: 'right' },
    to: { offset: 6, affinity: 'right' },
    text: 'XY',
  });
  assert.deepEqual(right.errors, []);
  right.binding.close();
});

test('annotated editor rejects a spanning selection client-side without folding', async () => {
  const harness = setup('', redactedDocument());
  harness.displaySelect(2, 20);
  assert.equal(harness.binding.getSelection(), null);
  // A delete over the rejected selection is a no-op: the editor never submits a
  // range the coords layer refused to map.
  harness.beforeinput('deleteContentBackward');
  await flushInput();
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

function runElements(harness) {
  return [...harness.element.querySelector('[data-block-id="b"]').children];
}

test('annotated editor creates a paragraph boundary with insertParagraph', async () => {
  const harness = setup('ab');
  harness.select(1);
  const event = harness.beforeinput('insertParagraph');
  assert.equal(event.defaultPrevented, true);
  assert.equal(harness.element.textContent, 'a\nb');
  await flushInput();
  assert.equal(harness.calls.length, 1, 'Enter is exactly one durable mutation');
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 1, affinity: 'right' },
    to: { offset: 1, affinity: 'right' },
    text: '\n',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor creates a paragraph boundary with insertLineBreak', async () => {
  const harness = setup('ab');
  harness.select(1);
  const event = harness.beforeinput('insertLineBreak');
  assert.equal(event.defaultPrevented, true);
  await flushInput();
  assert.equal(harness.element.textContent, 'a\nb');
  assert.equal(harness.calls.length, 1, 'Shift+Enter is exactly one durable mutation');
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 1, affinity: 'right' },
    to: { offset: 1, affinity: 'right' },
    text: '\n',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor replaces a selection with a paragraph break on Enter', async () => {
  const harness = setup('abcd');
  harness.select(1, 3);
  harness.beforeinput('insertLineBreak');
  await flushInput();
  assert.equal(harness.element.textContent, 'a\nd');
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 1, affinity: 'right' },
    to: { offset: 3, affinity: 'right' },
    text: '\n',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor removes the selection on cut and treats a collapsed cut as a no-op', async () => {
  const cut = setup('abcd');
  cut.select(1, 3);
  const event = cut.beforeinput('deleteByCut');
  assert.equal(event.defaultPrevented, true);
  assert.equal(cut.element.textContent, 'ad');
  await flushInput();
  assert.equal(cut.calls.length, 1, 'cut is exactly one durable mutation');
  assert.deepEqual(cut.calls[0][1], {
    from: { offset: 1, affinity: 'right' },
    to: { offset: 3, affinity: 'right' },
    text: '',
  });
  assert.deepEqual(cut.errors, []);
  cut.binding.close();

  const collapsed = setup('ab');
  collapsed.select(1);
  collapsed.beforeinput('deleteByCut');
  await flushInput();
  assert.deepEqual(collapsed.calls, []);
  assert.deepEqual(collapsed.errors, []);
  collapsed.binding.close();
});

test('annotated editor replaces a multi-run selection as one durable mutation', async () => {
  const harness = setup('a\nb');
  harness.select(0, 3);
  harness.beforeinput('insertText', 'X');
  await flushInput();
  assert.equal(harness.element.textContent, 'X');
  assert.equal(harness.calls.length, 1, 'a cross-paragraph replacement is one replace, not a delete+insert pair');
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 0, affinity: 'right' },
    to: { offset: 3, affinity: 'right' },
    text: 'X',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor renders empty LF-delimited runs as keyed fragments', () => {
  const harness = setup('a\n\nb');
  const runs = runElements(harness);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map((run) => run.dataset.runIndex), ['0', '1', '2']);
  assert.deepEqual(runs.map((run) => run.textContent), ['a\n', '\n', 'b']);
  assert.equal(harness.element.textContent, 'a\n\nb');
  harness.binding.close();
});

test('annotated editor splits a run into two runs with insertParagraph', async () => {
  const harness = setup('ab');
  harness.select(1);
  harness.beforeinput('insertParagraph');
  assert.equal(harness.element.textContent, 'a\nb');
  const runs = runElements(harness);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((run) => run.dataset.runIndex), ['0', '1']);
  assert.deepEqual(runs.map((run) => run.textContent), ['a\n', 'b']);
  await flushInput();
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 1, affinity: 'right' },
    to: { offset: 1, affinity: 'right' },
    text: '\n',
  });
  harness.binding.close();
});

test('annotated editor joins runs when backspacing across a paragraph boundary', async () => {
  const harness = setup('a\nb');
  assert.equal(runElements(harness).length, 2);
  harness.select(2);
  harness.beforeinput('deleteContentBackward');
  await flushInput();
  assert.equal(harness.element.textContent, 'ab');
  const runs = runElements(harness);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].textContent, 'ab');
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 1, affinity: 'right' },
    to: { offset: 2, affinity: 'right' },
    text: '',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor repaints only the touched run and preserves unchanged run nodes', async () => {
  const harness = setup('aaa\nbbb\nccc');
  const before = runElements(harness);
  assert.equal(before.length, 3);
  assert.deepEqual(before.map((run) => run.textContent), ['aaa\n', 'bbb\n', 'ccc']);

  harness.select(1);
  harness.beforeinput('insertText', 'X');
  await flushInput();
  assert.equal(harness.element.textContent, 'aXaa\nbbb\nccc');
  const after = runElements(harness);
  assert.equal(after.length, 3);
  assert.equal(after[0], before[0], 'the edited run element is reused, not recreated');
  assert.equal(after[0].textContent, 'aXaa\n');
  assert.equal(after[1], before[1], 'the untouched run keeps its node identity');
  assert.equal(after[1].textContent, 'bbb\n');
  assert.equal(after[2], before[2], 'the untouched run keeps its node identity');
  assert.equal(after[2].textContent, 'ccc');
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 1, affinity: 'right' },
    to: { offset: 1, affinity: 'right' },
    text: 'X',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor preserves later run nodes when insertParagraph splits an earlier run', async () => {
  const harness = setup('aaa\nbbb\nccc');
  const before = runElements(harness);
  assert.equal(before.length, 3);
  assert.deepEqual(before.map((run) => run.textContent), ['aaa\n', 'bbb\n', 'ccc']);

  harness.select(1);
  harness.beforeinput('insertParagraph');
  // The split inserts a '\n' at offset 1: run 0 'aaa\n' becomes 'a\n' + 'aa\n'.
  assert.equal(harness.element.textContent, 'a\naa\nbbb\nccc');
  const after = runElements(harness);
  assert.equal(after.length, 4);
  assert.deepEqual(after.map((run) => run.dataset.runIndex), ['0', '1', '2', '3']);
  assert.deepEqual(after.map((run) => run.textContent), ['a\n', 'aa\n', 'bbb\n', 'ccc']);
  // The edited run's first fragment reuses the original run element in place;
  // its second fragment is a fresh element.
  assert.equal(after[0], before[0], 'the split run\'s first half reuses the edited run element');
  assert.notEqual(after[1], before[0], 'the split run\'s second half is a fresh element');
  assert.equal(after[1].isConnected, true);
  // The later unchanged runs keep their exact node identity even though their
  // index shifted by the split.
  assert.equal(after[2], before[1], 'the unchanged run after the split keeps its node identity');
  assert.equal(after[2].textContent, 'bbb\n');
  assert.equal(after[3], before[2], 'the trailing unchanged run keeps its node identity');
  assert.equal(after[3].textContent, 'ccc');
  await flushInput();
  assert.equal(harness.calls.length, 1, 'the split is exactly one durable mutation');
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 1, affinity: 'right' },
    to: { offset: 1, affinity: 'right' },
    text: '\n',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor preserves following run nodes when backspace joins two runs', async () => {
  const harness = setup('aaa\nbbb\nccc');
  const before = runElements(harness);
  assert.equal(before.length, 3);
  assert.deepEqual(before.map((run) => run.textContent), ['aaa\n', 'bbb\n', 'ccc']);

  // Caret between the first '\n' and 'bbb': backspace deletes the boundary.
  harness.select(4);
  harness.beforeinput('deleteContentBackward');
  assert.equal(harness.element.textContent, 'aaabbb\nccc');
  const after = runElements(harness);
  assert.equal(after.length, 2);
  assert.deepEqual(after.map((run) => run.dataset.runIndex), ['0', '1']);
  assert.deepEqual(after.map((run) => run.textContent), ['aaabbb\n', 'ccc']);
  // The joined run reuses the first fragment's element (repainted); the second
  // run's node is detached, and the trailing run keeps its exact node identity
  // across the join.
  assert.equal(after[0], before[0], 'the joined run reuses the first run\'s element');
  assert.equal(before[1].isConnected, false, 'the consumed run is detached');
  assert.equal(after[1], before[2], 'the following run keeps its node identity across the join');
  assert.equal(after[1].textContent, 'ccc');
  await flushInput();
  assert.equal(harness.calls.length, 1, 'the join is exactly one durable mutation');
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 3, affinity: 'right' },
    to: { offset: 4, affinity: 'right' },
    text: '',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor keeps a duplicate-content following run node when insertParagraph splits an earlier run', async () => {
  // Enter at offset 1 splits the first run and the new middle run duplicates
  // the first run's content; content-based matching could pair the old
  // following run with that middle run and detach the genuinely unchanged
  // follower. Absolute-interval matching must keep the exact node on the
  // shifted following run.
  const harness = setup('aa\naa');
  const before = runElements(harness);
  assert.equal(before.length, 2);
  assert.deepEqual(before.map((run) => run.textContent), ['aa\n', 'aa']);

  harness.select(1);
  harness.beforeinput('insertParagraph');
  // The split inserts a '\n' at offset 1: run 0 'aa\n' becomes 'a\n' + 'a\n',
  // and the trailing 'aa' run shifts from [3,5) to [4,6).
  assert.equal(harness.element.textContent, 'a\na\naa');
  const after = runElements(harness);
  assert.equal(after.length, 3);
  assert.deepEqual(after.map((run) => run.dataset.runIndex), ['0', '1', '2']);
  assert.deepEqual(after.map((run) => run.textContent), ['a\n', 'a\n', 'aa']);
  // Only the split run's fragments repaint: its first half reuses the edited
  // run element, its second half is a fresh element, and the duplicate-content
  // following run keeps its exact node identity.
  assert.equal(after[0], before[0], 'the split run\'s first half reuses the edited run element');
  assert.notEqual(after[1], before[0], 'the split run\'s second half is a fresh element');
  assert.notEqual(after[1], before[1], 'the split run\'s second half is a fresh element');
  assert.equal(after[1].isConnected, true);
  assert.equal(after[2], before[1], 'the duplicate-content following run keeps its node identity');
  assert.equal(after[2].textContent, 'aa');
  await flushInput();
  assert.equal(harness.calls.length, 1, 'the split is exactly one durable mutation');
  assert.deepEqual(harness.calls[0][1], {
    from: { offset: 1, affinity: 'right' },
    to: { offset: 1, affinity: 'right' },
    text: '\n',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor rebuilds run nodes when the whole document is replaced', async () => {
  const harness = setup('aaa\nbbb\nccc');
  const before = runElements(harness);
  harness.select(0, 11);
  harness.beforeinput('insertText', 'z');
  await flushInput();
  assert.equal(harness.element.textContent, 'z');
  const after = runElements(harness);
  assert.equal(after.length, 1);
  assert.equal(after[0].textContent, 'z');
  assert.equal(after[0], before[0], 'the first run element is reused at index 0');
  assert.equal(before[1].isConnected, false, 'the replaced runs are legitimately detached');
  assert.equal(before[2].isConnected, false, 'the replaced runs are legitimately detached');
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

// --- recipient-projected caret presence (issue #9) ---

const caretTick = () => new Promise((resolve) => setTimeout(resolve, 0));

function caretHarness(text = 'Hello', document = visible(text)) {
  const dom = new JSDOM('<div id="editor"></div><div id="carets"></div>');
  const element = dom.window.document.getElementById('editor');
  const caretLayer = dom.window.document.getElementById('carets');
  const calls = [];
  const errors = [];
  const listeners = new Set();
  let caretListener = null;
  const session = {
    document,
    history: { undo: async () => {}, redo: async () => {} },
    replace: async (input) => { calls.push(['replace', input]); return { ok: true }; },
    subscribe(next) { listeners.add(next); return () => listeners.delete(next); },
    publishCaret: ({ offset }) => { calls.push(['publish', offset]); return true; },
    clearCaret: () => { calls.push(['clear']); return true; },
    onCaret(listener) { caretListener = listener; return () => { if (caretListener === listener) caretListener = null; }; },
  };
  const binding = bindAnnotatedTextEditor({ element, session, caretLayer, onError: (error) => errors.push(error) });
  // Place a collapsed caret at a DISPLAY offset without focusing (the focus
  // path is exercised explicitly by the caret tests).
  function placeCaret(offset) {
    const span = element.querySelector('[data-block-id="b"]');
    let remaining = Math.max(0, Math.min(offset, (span.textContent ?? '').length));
    const walker = span.ownerDocument.createTreeWalker(span, 4);
    let node = null;
    let nodeOffset = 0;
    while (walker.nextNode()) {
      const current = walker.currentNode;
      if (remaining <= current.data.length) {
        node = current;
        nodeOffset = remaining;
        break;
      }
      remaining -= current.data.length;
    }
    const range = dom.window.document.createRange();
    range.setStart(node ?? span, nodeOffset);
    range.collapse(true);
    const selection = dom.window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  function publish(document) {
    session.document = document;
    for (const listener of [...listeners]) listener(document);
  }
  function emitCaret(frame) { caretListener?.(frame); }
  return { dom, element, session, caretLayer, calls, errors, binding, placeCaret, publish, emitCaret };
}

function caretFrame(presence, kind = 'caret', offset) {
  const value = kind === 'edge'
    ? { kind: 'edge', presence, edge: 'start', sourceId: 'demo' }
    : { kind: 'caret', presence, offset, sourceId: 'demo' };
  return {
    type: 'annotated-text-caret', version: 1,
    entity: 'Doc', id: 'd1', field: 'body',
    change: { op: 'upsert', value },
  };
}

test('annotated editor publishes a collapsed caret on focus and clears on blur', async () => {
  const h = caretHarness();
  h.placeCaret(2);
  await caretTick();
  assert.deepEqual(h.calls, [], 'a caret is not published until the editor is focused');
  h.element.focus();
  await caretTick();
  assert.deepEqual(h.calls, [['publish', 2]]);
  h.element.blur();
  await caretTick();
  assert.deepEqual(h.calls, [['publish', 2], ['clear']]);
  h.binding.close();
});

test('annotated editor publishes only collapsed carets', async () => {
  const h = caretHarness();
  h.element.focus();
  await caretTick();
  assert.deepEqual(h.calls, [['publish', 0]], 'focus publishes the initial collapsed caret');
  // jsdom resets the selection on focus, so set the non-collapsed range after
  // focusing and drive a selectionchange through the coalesce path.
  const span = h.element.querySelector('[data-block-id="b"]');
  const text = span.ownerDocument.createTreeWalker(span, 4).nextNode();
  assert.ok(text, 'the run renders a text node');
  const range = h.dom.window.document.createRange();
  range.setStart(text, 1);
  range.setEnd(text, 4);
  h.dom.window.getSelection().removeAllRanges();
  h.dom.window.getSelection().addRange(range);
  h.element.ownerDocument.dispatchEvent(new h.dom.window.Event('selectionchange'));
  await caretTick();
  assert.deepEqual(h.calls, [['publish', 0]], 'a non-collapsed selection never publishes a caret');
  h.binding.close();
});

test('annotated editor dedupes and coalesces caret publishes', async () => {
  const h = caretHarness();
  h.element.focus();
  await caretTick();
  h.calls.length = 0;
  h.placeCaret(1);
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'publish'), [['publish', 1]]);
  // Repeated selectionchange events at the same offset coalesce into nothing.
  h.element.ownerDocument.dispatchEvent(new h.dom.window.Event('selectionchange'));
  h.element.ownerDocument.dispatchEvent(new h.dom.window.Event('selectionchange'));
  await caretTick();
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'publish'), [['publish', 1]]);
  // A caret move coalesces several selectionchange events into one publish.
  h.placeCaret(3);
  h.element.ownerDocument.dispatchEvent(new h.dom.window.Event('selectionchange'));
  h.element.ownerDocument.dispatchEvent(new h.dom.window.Event('selectionchange'));
  h.element.ownerDocument.dispatchEvent(new h.dom.window.Event('selectionchange'));
  await caretTick();
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'publish'), [['publish', 1]], 'the throttled publish has not fired yet');
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'publish'), [['publish', 1], ['publish', 3]]);
  h.binding.close();
});

test('annotated editor renders remote caret and edge bars and removes them', async () => {
  const h = caretHarness();
  h.emitCaret(caretFrame('peer-1', 'caret', 2));
  const caretBar = h.caretLayer.querySelector('[data-presence="peer-1"]');
  assert.ok(caretBar, 'a remote caret renders a bar in the caret layer');
  assert.equal(caretBar.dataset.kind, 'caret');
  assert.equal(caretBar.dataset.offset, '2');
  assert.equal(caretBar.getAttribute('contenteditable'), 'false');
  assert.equal(caretBar.style.position, 'absolute');
  assert.equal(caretBar.style.pointerEvents, 'none');

  h.emitCaret(caretFrame('peer-2', 'edge'));
  const edgeBar = h.caretLayer.querySelector('[data-presence="peer-2"]');
  assert.ok(edgeBar, 'a restricted edge renders an opaque edge marker');
  assert.equal(edgeBar.dataset.kind, 'edge');
  assert.equal(edgeBar.hasAttribute('data-offset'), false);

  h.emitCaret({ type: 'annotated-text-caret', version: 1, entity: 'Doc', id: 'd1', field: 'body', change: { op: 'remove', presence: 'peer-1' } });
  assert.equal(h.caretLayer.querySelector('[data-presence="peer-1"]'), null, 'a remove deletes the bar');
  assert.ok(h.caretLayer.querySelector('[data-presence="peer-2"]'), 'other presences survive');
  h.binding.close();
});

test('annotated editor never places caret decorations inside the container span', async () => {
  const h = caretHarness();
  h.emitCaret(caretFrame('peer-1', 'caret', 2));
  h.emitCaret(caretFrame('peer-2', 'edge'));
  const span = h.element.querySelector('[data-block-id="b"]');
  assert.equal(span.querySelector('[data-presence]'), null);
  assert.equal(span.querySelector('[data-kind]'), null);
  assert.equal(h.element.querySelector('[data-presence]'), null);
  assert.equal(h.element.querySelector('[data-kind]'), null);
  h.binding.close();
});

test('annotated editor clears remote bars and local presence on close', async () => {
  const h = caretHarness();
  h.emitCaret(caretFrame('peer-1', 'caret', 2));
  h.placeCaret(2);
  h.element.focus();
  await caretTick();
  assert.ok(h.caretLayer.querySelector('[data-presence="peer-1"]'));
  h.binding.close();
  assert.equal(h.caretLayer.children.length, 0, 'close removes all caret bars');
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'clear'), [['clear']], 'close retracts local presence');
});

test('annotated editor with a caret layer but a caret-less session stays inert', async () => {
  const dom = new JSDOM('<div id="editor"></div><div id="carets"></div>');
  const element = dom.window.document.getElementById('editor');
  const caretLayer = dom.window.document.getElementById('carets');
  const session = {
    document: visible('Hello'),
    history: { undo: async () => {}, redo: async () => {} },
    replace: async () => ({ ok: true }),
    subscribe() { return () => {}; },
  };
  const binding = bindAnnotatedTextEditor({ element, session, caretLayer });
  element.focus();
  await caretTick();
  assert.equal(caretLayer.children.length, 0);
  binding.close();
});
