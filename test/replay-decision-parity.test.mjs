import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decideReplay, normalizeSeqSpan } from '../build/replay-decision.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const BEGIN_MARKER = '// --- BEGIN GENERATED from src/replay-decision.ts';
const END_MARKER = '// --- END GENERATED from src/replay-decision.ts';

// The browser SDK is split across workbench-client-*.mjs modules; structural
// checks read the whole surface so the embed can live in any slice.
function readClientSources() {
  return readdirSync(join(root, 'public'))
    .filter((file) => /^workbench-client(-.*)?\.mjs$/.test(file))
    .map((file) => readFileSync(join(root, 'public', file), 'utf8'))
    .join('\n');
}

// Slice the embedded zero-import body out of the client and evaluate it in a
// controlled scope so we can drive the client's own functions, not a copy.
function extractEmbeddedReplayDecision() {
  const client = readClientSources();
  const begin = client.indexOf(BEGIN_MARKER);
  const end = client.indexOf(END_MARKER);
  assert.ok(begin !== -1, 'client missing BEGIN GENERATED marker');
  assert.ok(end !== -1 && end > begin, 'client missing END GENERATED marker');
  const blockStart = client.indexOf('\n', begin) + 1;
  const blockEnd = client.lastIndexOf('\n', end);
  // Split modules export these helpers for cross-slice imports; strip the
  // keyword before evaluating the embedded copy in isolation.
  const blockText = client.slice(blockStart, blockEnd).replace(/^export\s+/gm, '');
  const factory = new Function(`${blockText}\nreturn { normalizeSeqSpan, decideReplay };`);
  return factory();
}

function captureError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

test('workbench-client embeds a replay-decision that behaves identically to src', () => {
  const src = readFileSync(join(root, 'src/replay-decision.ts'), 'utf8');
  const client = readClientSources();

  // Lightweight marker check: the zero-import embed is flagged and both function
  // names survive, so accidental deletion/rename is caught without pinning the
  // verbatim formatting (the load-bearing check is behavioral, below).
  assert.match(client, /BEGIN GENERATED from src\/replay-decision\.ts/);
  assert.match(client, /END GENERATED from src\/replay-decision\.ts/);
  assert.match(client, /function decideReplay\(cursor, seqOrSpan\)/);
  assert.match(client, /function normalizeSeqSpan\(seqOrSpan\)/);
  assert.ok(src.includes('export function decideReplay'));
  assert.ok(src.includes('export function normalizeSeqSpan'));

  const embedded = extractEmbeddedReplayDecision();

  // Behavioral corpus: [cursor, seqOrSpan, expectedVerdict]. Covers next on a
  // single seq, duplicate (hi < expected), gap (lo > expected), span inputs,
  // spans crossing / ending exactly at the boundary, reversed and oversized
  // arrays, scalar coercions, and hostile cursor values.
  const corpus = [
    [0, 1, { kind: 'next', cursor: 1 }],
    [0, 0, { kind: 'duplicate' }],
    [5, 4, { kind: 'duplicate' }],
    [1, 3, { kind: 'gap' }],
    [3, 4, { kind: 'next', cursor: 4 }],
    [-3, -2, { kind: 'next', cursor: -2 }],
    [-3, -4, { kind: 'duplicate' }],
    [2.5, 3.5, { kind: 'next', cursor: 3.5 }],
    [1, [2, 4], { kind: 'next', cursor: 4 }],
    [1, [1, 4], { kind: 'next', cursor: 4 }],
    [1, [3, 5], { kind: 'gap' }],
    [4, [1, 4], { kind: 'duplicate' }],
    [1, [4, 2], { kind: 'gap' }],
    [0, [1, 1], { kind: 'next', cursor: 1 }],
    [2, [3, 3], { kind: 'next', cursor: 3 }],
    [1, [2, 4, 99], { kind: 'next', cursor: 4 }],
    [1, [2], { kind: 'next', cursor: 2 }],
    [0, [], { kind: 'duplicate' }],
    [3, '5', { kind: 'gap' }],
    [0, '', { kind: 'duplicate' }],
    [0, null, { kind: 'duplicate' }],
    [0, true, { kind: 'next', cursor: 1 }],
    ['4', 5, { kind: 'next', cursor: 5 }],
    [NaN, 1, { kind: 'next', cursor: 1 }],
    [2, [2.5, 4.5], { kind: 'next', cursor: 4.5 }],
  ];
  for (const [cursor, seqOrSpan, expected] of corpus) {
    assert.deepEqual(
      embedded.decideReplay(cursor, seqOrSpan),
      decideReplay(cursor, seqOrSpan),
      `embedded vs src verdict for cursor=${cursor} seqOrSpan=${JSON.stringify(seqOrSpan)}`,
    );
    assert.deepEqual(
      embedded.decideReplay(cursor, seqOrSpan),
      expected,
      `unexpected verdict for cursor=${cursor} seqOrSpan=${JSON.stringify(seqOrSpan)}`,
    );
    assert.deepEqual(
      embedded.normalizeSeqSpan(seqOrSpan),
      normalizeSeqSpan(seqOrSpan),
      `embedded vs src span for ${JSON.stringify(seqOrSpan)}`,
    );
  }

  // Invalid inputs: normalizeSeqSpan rejects non-finite seqs on both sides,
  // throwing the same error message; decideReplay propagates that throw.
  const invalidInputs = [NaN, Infinity, -Infinity, 'abc', undefined, {}, [NaN, 1], [1, Infinity], ['x', 2]];
  for (const bad of invalidInputs) {
    const embeddedError = captureError(() => embedded.decideReplay(0, bad));
    const srcError = captureError(() => decideReplay(0, bad));
    assert.ok(embeddedError, `embedded should throw for ${JSON.stringify(bad)}`);
    assert.ok(srcError, `src should throw for ${JSON.stringify(bad)}`);
    assert.equal(embeddedError.message, srcError.message);
    assert.equal(embeddedError.name, srcError.name);
  }

  // Parity-only for the Infinity cursor: both implementations must agree, but
  // the Infinity-cursor verdict (every finite event is a duplicate) is a
  // poisoned-cursor hazard — NOT blessed as intended behavior here. See the
  // coercion note in src/replay-decision.ts.
  assert.deepEqual(embedded.decideReplay(Infinity, 5), decideReplay(Infinity, 5), 'embedded and src agree on an Infinity cursor');
});

test('createClient is span-aware via decideReplay (shared core)', async () => {
  const { createClient, event } = await import('../build/pipeline.mjs');
  const e = event('Note.created', (s, ev) => ({ ...s, ...ev.data }));
  const client = createClient({ events: [e] });
  client.bootstrap('Note:1', { id: '1' }, 0);

  // Single-seq next
  assert.deepEqual(
    client.ingest({ type: 'Note.created', scope: 'Note:1', seq: 1, data: { title: 'a' } }),
    { applied: true },
  );
  assert.equal(client.cursor('Note:1'), 1);

  // Coalesced span next (P6e-4 forward-compat): covers expected=2, advances to hi
  assert.deepEqual(
    client.ingest({
      type: 'Note.created',
      scope: 'Note:1',
      seq: 4,
      seqSpan: [2, 4],
      data: { title: 'b' },
    }),
    { applied: true },
  );
  assert.equal(client.cursor('Note:1'), 4);

  // Duplicate (seq already covered by prior span)
  assert.deepEqual(
    client.ingest({ type: 'Note.created', scope: 'Note:1', seq: 3, data: {} }),
    { applied: false, duplicate: true },
  );

  // Gap
  assert.deepEqual(
    client.ingest({ type: 'Note.created', scope: 'Note:1', seq: 9, data: {} }),
    { applied: false, resync: true },
  );

  // decideReplay itself is the shared core
  assert.deepEqual(decideReplay(1, [2, 4]), { kind: 'next', cursor: 4 });
  assert.deepEqual(normalizeSeqSpan(7), [7, 7]);
});
