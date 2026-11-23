import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

// A 36k-word transcript with 72k annotations is the client's worst case. A v2
// recipient inlines a point + basis frontier for every range endpoint, so the
// old recursive `deepFreeze` walked ~500k nested objects per delivery and
// stalled the client. Shallow freezing for large envelopes must keep
// materialization well under the 25 ms p95 budget.
//
// The measurement runs in a dedicated child process: the node test runner
// shares CPU accounting across concurrently-running test files, which inflates
// an in-process timing sample by 5–10x and makes the budget assertion useless.
const snapshotModuleUrl = new URL('../public/workbench-annotated-text-snapshot.mjs', import.meta.url).href;

const MEASUREMENT_SCRIPT = `
import { materializeAnnotatedTextSnapshot } from ${JSON.stringify(snapshotModuleUrl)};

const ACTOR = 'a'.repeat(32);
const WORD_COUNT = 36000;
const ANNOTATION_COUNT = 72000;
const text = 'word '.repeat(WORD_COUNT);

const ranges = new Array(ANNOTATION_COUNT);
const annotations = new Array(ANNOTATION_COUNT);
for (let index = 0; index < ANNOTATION_COUNT; index += 1) {
  const op = [ACTOR, index + 1];
  ranges[index] = {
    annotationId: \`a\${index}\`,
    start: { point: ['point', ['element', [op, 0]], 'left'], basisFrontier: [[ACTOR, 1]] },
    end: { point: ['point', ['element', [op, 0]], 'right'], basisFrontier: [[ACTOR, 1]] },
  };
  annotations[index] = { id: \`a\${index}\`, family: 'comment', fields: { note: \`n\${index}\` } };
}
const handle = { annotations: { comment: {} } };
const makeSnapshot = () => ({
  kind: 'workbench.annotatedText.recipient', version: 2, text, ranges, annotations,
  orphans: [], measurements: [], capabilityHints: [],
});

// Warm the JIT and both materialization paths.
for (let index = 0; index < 5; index += 1) {
  materializeAnnotatedTextSnapshot(makeSnapshot(), handle, { family: {} });
}
const samples = [];
for (let index = 0; index < 20; index += 1) {
  const started = process.cpuUsage();
  const document = materializeAnnotatedTextSnapshot(makeSnapshot(), handle, { family: {} });
  const used = process.cpuUsage(started);
  samples.push((used.user + used.system) / 1000);
  if (!Object.isFrozen(document) || !Object.isFrozen(document.ranges) || document.ranges.length !== ANNOTATION_COUNT) {
    throw new Error('materialized document shape is invalid');
  }
}
samples.sort((left, right) => left - right);
const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
console.log(p95.toFixed(3));
`;

function measureP95CpuMs() {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', MEASUREMENT_SCRIPT], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  return Number.parseFloat(stdout.trim());
}

test('36k-word / 72k-annotation materialization stays under the 25 ms p95 budget', () => {
  const measured = measureP95CpuMs();
  assert.ok(Number.isFinite(measured), 'expected a numeric p95 measurement');
  assert.ok(
    measured < 25,
    `expected 36k-word/72k-annotation materialization p95 < 25 ms, measured ${measured.toFixed(2)} ms`,
  );
});
