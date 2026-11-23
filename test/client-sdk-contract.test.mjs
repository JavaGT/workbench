// Client SDK contract drift guard (issue #293).
//
// Two independent checks:
//   (a) public/workbench-client.mjs runtime exports and client.d.ts declarations
//       agree in BOTH directions: every runtime export is declared, and every
//       declared VALUE export (class/function/const — not type-only) exists at
//       runtime. Type-only declarations (interface/type) are allowed to have no
//       runtime binding.
//   (b) the decideReplay / normalizeSeqSpan copy embedded in the zero-import
//       browser client behaves identically to build/replay-decision.mjs over a
//       table of valid and invalid cases.
//
// This file is intentionally structural: it names no specific symbol it is
// trying to pin, so adding a real export without a declaration (or declaring a
// value that no longer ships) fails here rather than silently drifting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as client from '../public/workbench-client.mjs';
import { decideReplay, normalizeSeqSpan } from '../build/replay-decision.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dtsPath = join(root, 'client.d.ts');

/**
 * Parse declared VALUE and TYPE exports from the ambient client.d.ts.
 *
 * - `export class Name`, `export function Name`, `export const Name` are values.
 * - `export interface Name`, `export type Name` are type-only.
 * - `export { A, B } from '...'` re-exports are parsed as values (a bare
 *   identifier list; the client declares none today, but the parser stays
 *   honest if one is added).
 */
function parseDeclaredExports(source) {
  const values = new Set();
  const types = new Set();
  for (const match of source.matchAll(/^\s*export\s+(class|function|const|let|var)\s+([A-Za-z0-9_$]+)/gm)) {
    values.add(match[2]);
  }
  for (const match of source.matchAll(/^\s*export\s+(interface|type)\s+([A-Za-z0-9_$]+)/gm)) {
    types.add(match[2]);
  }
  for (const match of source.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) values.add(name);
    }
  }
  return { values, types };
}

test('every runtime export is declared in client.d.ts', () => {
  const declared = parseDeclaredExports(readFileSync(dtsPath, 'utf8'));
  const runtime = Object.keys(client).sort();
  const undeclared = runtime.filter((name) => !declared.values.has(name) && !declared.types.has(name));
  assert.deepEqual(undeclared, [], `runtime exports missing from client.d.ts: ${undeclared.join(', ')}`);
});

test('every declared value export exists at runtime', () => {
  const declared = parseDeclaredExports(readFileSync(dtsPath, 'utf8'));
  const runtime = new Set(Object.keys(client));
  const missing = [...declared.values].filter((name) => !runtime.has(name)).sort();
  assert.deepEqual(missing, [], `declared value exports absent at runtime: ${missing.join(', ')}`);
  // Type-only declarations are permitted to have no runtime binding, but must
  // not be misclassified as values (which would make the reverse check pass by
  // accident). A type name that IS a runtime value is harmless; a value that is
  // declared only as a type is the drift this guard is here to catch.
  for (const name of declared.types) {
    assert.ok(!declared.values.has(name), `${name} cannot be both a value and a type-only export`);
  }
});

// --- decideReplay / normalizeSeqSpan parity -------------------------------

const BEGIN_MARKER = '// --- BEGIN GENERATED from src/replay-decision.ts';
const END_MARKER = '// --- END GENERATED from src/replay-decision.ts';

function extractEmbeddedReplayDecision() {
  const clientSource = readFileSync(join(root, 'public/workbench-client.mjs'), 'utf8');
  const begin = clientSource.indexOf(BEGIN_MARKER);
  const end = clientSource.indexOf(END_MARKER);
  assert.ok(begin !== -1, 'client missing BEGIN GENERATED marker');
  assert.ok(end !== -1 && end > begin, 'client missing END GENERATED marker');
  const blockStart = clientSource.indexOf('\n', begin) + 1;
  const blockEnd = clientSource.lastIndexOf('\n', end);
  const blockText = clientSource.slice(blockStart, blockEnd);
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

test('client decideReplay/normalizeSeqSpan behave identically to build/replay-decision.mjs', () => {
  const embedded = extractEmbeddedReplayDecision();

  // Valid corpus: [cursor, seqOrSpan, expectedVerdict]. Covers next on a single
  // seq, duplicate (hi < expected), gap (lo > expected), span inputs, spans
  // ending exactly at the boundary, scalar coercions, and negative/decimal seqs.
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
      `embedded vs build verdict for cursor=${cursor} seqOrSpan=${JSON.stringify(seqOrSpan)}`,
    );
    assert.deepEqual(
      embedded.decideReplay(cursor, seqOrSpan),
      expected,
      `unexpected verdict for cursor=${cursor} seqOrSpan=${JSON.stringify(seqOrSpan)}`,
    );
    assert.deepEqual(
      embedded.normalizeSeqSpan(seqOrSpan),
      normalizeSeqSpan(seqOrSpan),
      `embedded vs build span for ${JSON.stringify(seqOrSpan)}`,
    );
  }

  // Invalid inputs: both reject non-finite seqs with the same error message.
  const invalidInputs = [NaN, Infinity, -Infinity, 'abc', undefined, {}, [NaN, 1], [1, Infinity], ['x', 2]];
  for (const bad of invalidInputs) {
    const embeddedError = captureError(() => embedded.decideReplay(0, bad));
    const buildError = captureError(() => decideReplay(0, bad));
    assert.ok(embeddedError, `embedded should throw for ${JSON.stringify(bad)}`);
    assert.ok(buildError, `build should throw for ${JSON.stringify(bad)}`);
    assert.equal(embeddedError.message, buildError.message);
    assert.equal(embeddedError.name, buildError.name);
  }
});
