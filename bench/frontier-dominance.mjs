// Frontier-dominance benchmark (scope#3039).
//
// `frontierDominatesValidated` runs once per anchored endpoint projection
// (twice for frontier-equality checks). It used to scan `left` once per entry
// of `right` — O(|left| x |right|) — and the indexed form is O(|left| + |right|)
// for multi-entry bases, keeping the single scan for one-entry bases. This
// script A/Bs the retired formula against the current implementation on a
// shared frontier, parity-checks every case, and reports totals so the claim is
// reproducible from a clean commit.
//
// Run: node bench/frontier-dominance.mjs
// Env: K (frontier size, default 512), ITERATIONS (default 3000)

import { frontierDominatesValidated } from '../build/annotated-text.mjs';

function actor(index) {
  return index.toString(16).padStart(8, '0').repeat(4).slice(0, 32);
}

function makeFrontier(size, start = 0) {
  const entries = [];
  for (let index = 0; index < size; index += 1) entries.push([actor(index + start), 1 + ((index + start) % 89)]);
  return entries;
}

/** The retired `every` + `find` shape, verbatim. */
function legacyDominates(left, right) {
  return right.every(([actorName, counter]) => {
    const found = left.find(([candidate]) => candidate === actorName);
    return (found ? found[1] : 0) >= counter;
  });
}

const K = Number(process.env.K || 512);
const ITERATIONS = Number(process.env.ITERATIONS || 3000);

const left = makeFrontier(K);
const cases = {
  'equal frontier (true)': makeFrontier(K),
  'single entry (true)': [left[7]],
  'single entry (false)': [[left[7][0], left[7][1] + 1]],
  'superset, early false at the end (false)': makeFrontier(K + 8),
};

// Parity: both implementations must agree on every case before timing.
for (const [name, right] of Object.entries(cases)) {
  const legacy = legacyDominates(left, right);
  const indexed = frontierDominatesValidated(left, right);
  if (legacy !== indexed) throw new Error(`parity failure on "${name}"`);
}

function time(fn) {
  for (let index = 0; index < 50; index += 1) {
    for (const right of Object.values(cases)) fn(left, right);
  }
  const started = performance.now();
  for (let index = 0; index < ITERATIONS; index += 1) {
    for (const right of Object.values(cases)) fn(left, right);
  }
  return performance.now() - started;
}

const legacyMs = time(legacyDominates);
const indexedMs = time(frontierDominatesValidated);
const checks = ITERATIONS * Object.keys(cases).length;

console.log(`frontier-dominance: K=${K} iterations=${ITERATIONS} checks=${checks} node=${process.version} ${process.platform}/${process.arch}`);
console.log(`retired every+find scan: ${legacyMs.toFixed(1)}ms`);
console.log(`indexed dominance:       ${indexedMs.toFixed(1)}ms`);
console.log(`speedup: ${(legacyMs / indexedMs).toFixed(1)}x`);
