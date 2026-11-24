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
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

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

// A browser consumer of `workbench/client` must not inherit Node-only global
// types through a transitive `/// <reference types="node" />` from a declaration
// it never asked for. Follow the relative declaration import graph from
// client.d.ts and fail if any reached file carries that directive.
test('client.d.ts does not transitively reference Node types', () => {
  const visited = new Set();
  const queue = [dtsPath];
  const leaking = [];
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    if (/^\s*\/\/\/\s*<reference\s+types=["']node["']\s*\/?\s*>/m.test(source)) leaking.push(file);
    for (const match of source.matchAll(/['"](\.\.?\/[^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!/\.(?:js|d\.ts)$/.test(specifier)) continue;
      const resolved = resolve(join(dirname(file), specifier.replace(/\.js$/, '.d.ts')));
      if (existsSync(resolved)) queue.push(resolved);
    }
  }
  assert.ok(visited.size > 1, 'client.d.ts graph should reach shared declarations');
  assert.deepEqual(leaking, [], `browser client must not pull in Node triple-slash references: ${leaking.join(', ')}`);
});

// --- ScopeDispatchResult.settlement contract (#239) ------------------------
//
// The optional `settlement` field must describe the real runtime producers:
// the legacy scope engine never mints one, while the document-path producers
// (the annotated-text session) always return the live-delivery settlement.
// Both directions are pinned so the declaration cannot drift either way.
test('ScopeDispatchResult.settlement optionality matches its runtime producers', async () => {
  const dts = readFileSync(dtsPath, 'utf8');
  const scopeResult = dts.slice(
    dts.indexOf('export type ScopeDispatchResult'),
    dts.indexOf('export interface ScopeLiveStoreConfig'),
  );
  assert.match(scopeResult, /settlement\?:\s*LiveDeliverySettlement/,
    'client.d.ts must declare settlement as optional (legacy scope engine omits it)');

  // Legacy scope engine: a bare receipt/value result, no settlement key.
  const channel = {
    subscribeScope: async () => ({ currentSeq: 0 }),
    subscribe: async () => ({ currentSeq: 0 }),
    unsubscribe: async () => {},
    unsubscribeScope: async () => {},
    updateCaret: () => true,
    clearCaret: () => true,
    close() {},
    onConnectionChange: () => () => {},
  };
  const scopeStore = client.createScopeLiveStore({
    baseUrl: 'https://example.test',
    scope: 'Project:p1',
    channel,
    fetchImpl: async () => ({ ok: true, json: async () => ({ snapshot: { id: 'n1' }, seq: 0 }) }),
    validateSnapshot: (snapshot) => snapshot,
    fold: (snapshot) => snapshot,
    sendAction: async () => ({ ok: true, cursor: 1 }),
  });
  await scopeStore.ready;
  const legacy = await scopeStore.dispatch('Note.update', { title: 'x' });
  assert.equal(Object.hasOwn(legacy, 'settlement'), false,
    'createScopeLiveStore().dispatch must not mint a settlement');
  scopeStore.close();

  // Document-path producer: applyAnnotation returns the live-delivery result,
  // which always carries the operation's settlement.
  const { annotatedText, annotation, entity, ref } = await import('../build/index.mjs');
  const Doc = entity('ContractDoc', {
    project: ref('Project'), owner: ref('User'),
    body: annotatedText({ project: 'project', owner: 'owner', annotations: [annotation('note', { fields: {} })] }),
  });
  const token = (label) => `${label}${'x'.repeat(43)}`.slice(0, 43);
  let cursor = 0;
  let actionNumber = 0;
  const docSession = client.createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Doc, field: Doc.body, documentId: 'contract-d1' },
    historySession: 'contract-tab', createActionId: () => `contract-${++actionNumber}`,
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: cursor }) };
        const body = JSON.parse(options.body);
        const confirmedThrough = cursor;
        return { ok: true, status: 200, json: async () => ({ ok: true, actionId: body.actionId, confirmedThrough }) };
      }
      cursor += 1;
      const body = {
        kind: 'workbench.annotatedText.recipient', version: 1, text: 'Hello',
        ranges: [], annotations: [], orphans: [], measurements: [],
      };
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: {
        version: 1, stream: token('s'), lease: token('l'), snapshot: token(`snap${cursor}`),
        acknowledgementFence: cursor, positionFrames: [{ positionToken: token(`p${cursor}`) }],
      } }) };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await docSession.ready;
  const applied = docSession.applyAnnotation({
    mutationId: 'contract-ann',
    annotation: { id: 'a1', family: 'note', fields: {} },
    from: { offset: 0, affinity: 'left' },
    to: { offset: 2, affinity: 'right' },
  });
  assert.equal(Object.hasOwn(await applied, 'settlement'), true,
    'document-path applyAnnotation must carry the live-delivery settlement');
  docSession.close();
});

// --- snapshot-patch cursor verdict is built on the shared Replay decision ---
function extractSnapshotPatchVerdict() {
  const source = readFileSync(join(root, 'public/workbench-client.mjs'), 'utf8');
  const start = source.indexOf('function snapshotPatchVerdict(cursor, head, tail) {');
  assert.ok(start !== -1, 'client missing snapshotPatchVerdict helper');
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > start, 'snapshotPatchVerdict helper is not balanced');
  const factory = new Function('decideReplay', `${source.slice(start, end)}\nreturn snapshotPatchVerdict;`);
  return factory(decideReplay);
}

test('snapshotPatchVerdict derives its cursor verdict from decideReplay', () => {
  const verdict = extractSnapshotPatchVerdict();
  const cursor = (a, c) => ({ anchor: a, composite: c });
  const cases = [
    // [held, patch from, patch to, expected status, expected next composite]
    [cursor(1, 1), cursor(1, 1), cursor(1, 2), 'next', 2],
    [cursor(1, 1), cursor(1, 1), cursor(1, 4), 'next', 4],
    [cursor(1, 1), cursor(1, 1), cursor(3, 2), 'next', 2], // anchor may jump forward
    [cursor(1, 2), cursor(1, 1), cursor(1, 2), 'duplicate'],
    [cursor(1, 5), cursor(1, 1), cursor(1, 2), 'resync'], // stale regression, not a replay
    [cursor(1, 1), cursor(1, 3), cursor(1, 4), 'resync'], // gap: patch starts ahead
    [cursor(2, 1), cursor(1, 1), cursor(1, 2), 'resync'], // anchor mismatch, not at tail
    [cursor(2, 2), cursor(1, 1), cursor(2, 2), 'duplicate'], // tail matches held, anchor chain
    [cursor(1, 1), cursor(1, 1), cursor(1, 1), 'next', 1], // inclusive empty patch stays next
  ];
  for (const [held, head, tail, status, nextComposite] of cases) {
    const result = verdict(held, head, tail);
    assert.equal(result.status, status, `verdict for ${JSON.stringify({ held, head, tail })}`);
    if (status === 'next') {
      assert.equal(result.cursor.composite, nextComposite);
      assert.equal(result.cursor.anchor, tail.anchor);
    }
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
