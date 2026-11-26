// Emit runtime .mjs modules from typed src/**/*.ts sources into build/.
// Node refuses type-stripping under node_modules, so the published package
// must ship plain .mjs while .ts remains the editable source of truth.
// build/ is kept an exact image of the .ts tree WITHOUT a full wipe first:
// stale files (no matching .ts) are deleted and only changed files are
// rewritten, so a concurrent process importing from build/ (e.g. the node
// test suite) never sees a missing module during the emit.
//
// The blockless browser leaves under public/ are emitted from the same src/
// sources (issue #316): the browser port of the continuous family and its
// structural-endpoint grammar are generated, not hand-copied, so the client
// automatically inherits reducer/projection speedups. Relative `.ts` imports
// are rewritten to their public `./workbench-*.mjs` browser paths.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { buildSync } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(root, 'src');
const buildRoot = join(root, 'build');
const publicRoot = join(root, 'public');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (
      name.endsWith('.ts')
      && !name.endsWith('.d.ts')
      && !name.endsWith('.d.mts')
    ) out.push(path);
  }
  return out;
}

// Rewrite every relative `.ts` module specifier (static import/export and
// dynamic import) through `mapSpecifier`. `spec` is the path without `.ts`.
function rewriteImports(source, mapSpecifier) {
  return source.replaceAll(
    /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?\/[^'"]+)\.ts\2/g,
    (_match, lead, quote, spec) => `${lead}${quote}${mapSpecifier(spec)}${quote}`,
  );
}

function toRuntime(source, mapSpecifier = (spec) => `${spec}.mjs`) {
  const stripped = stripTypeScriptTypes(source, {
    filename: 'module.ts',
  });
  // stripTypeScriptTypes blanks stripped type-only constructs (import type,
  // export type, interface) with whitespace, which would otherwise leave
  // trailing-whitespace lines in every type-heavy module (git's --check flags
  // them). The src tree has no trailing whitespace, so trimming every line is
  // semantically safe — no template-literal content changes.
  return rewriteImports(stripped.replaceAll(/[ \t]+$/gm, ''), mapSpecifier);
}

// Browser leaves emitted from src/. `annotated-text.ts` and
// `annotated-text-family.ts` resolve to the served `./workbench-*.mjs` URLs.
function browserSpecifier(spec) {
  return `./workbench-${spec.split('/').pop()}.mjs`;
}

// Extract a top-level `export function <name>(...) { ... }` declaration from a
// module source, brace-matched while ignoring braces inside strings, template
// literals, and comments.
function extractExportedFunction(source, name) {
  const marker = `export function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`emit-ts: ${name} is not exported by source`);
  let depth = 0;
  let mode = 'code';
  let index = start;
  for (; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (mode === 'code') {
      if (char === "'") mode = 'single';
      else if (char === '"') mode = 'double';
      else if (char === '`') mode = 'template';
      else if (char === '/' && next === '/') { mode = 'line'; index += 1; }
      else if (char === '/' && next === '*') { mode = 'block'; index += 1; }
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
      }
    } else if (mode === 'single' || mode === 'double') {
      if (char === '\\') index += 1;
      else if ((mode === 'single' && char === "'") || (mode === 'double' && char === '"')) mode = 'code';
    } else if (mode === 'template') {
      if (char === '\\') index += 1;
      else if (char === '`') mode = 'code';
    } else if (mode === 'line') {
      if (char === '\n') mode = 'code';
    } else if (mode === 'block' && char === '*' && next === '/') {
      mode = 'code';
      index += 1;
    }
  }
  throw new Error(`emit-ts: unbalanced braces in ${name}`);
}

// The browser has exactly one served annotated-text dependency
// (`./workbench-annotated-text.mjs`, from build/annotated-text.mjs). The
// structural-endpoint validator lives in `annotated-text-family.ts` server
// side, so it is derived from that source and inlined here rather than
// introducing a second served module that the framework's SDK route does not
// expose. Deriving it (rather than hand-copying) keeps the browser bound to the
// single server-side grammar.
function structuralEndpointValidator() {
  const familySource = stripTypeScriptTypes(
    readFileSync(join(srcRoot, 'annotated-text-family.ts'), 'utf8'),
    { filename: 'annotated-text-family.ts' },
  ).replaceAll(/[ \t]+$/gm, '');
  const body = extractExportedFunction(familySource, 'assertStructuralEndpoint')
    .replace(/^export\s+/, '');
  return `
// Generated from src/annotated-text-family.ts (browser inlining — see
// scripts/emit-ts.mjs). Keeps the browser module on the single served
// annotated-text dependency.
${body}
`;
}

// The browser surface applies an absolute splice by composing the pure
// operation builders from the continuous source. Kept generated (not a second
// hand-maintained module) so the client's `applyOffsetTextEdit` follows the
// emitted continuous implementation.
const CONTINUOUS_BROWSER_ADAPTER = `
// Browser session adapter (generated by scripts/emit-ts.mjs). The continuous
// source exposes pure operation builders; the browser applies a splice by
// composing an optional delete and an optional insert.
let offsetEditActor = 0;
function nextOffsetEditActor() {
  offsetEditActor += 1;
  return offsetEditActor.toString(16).padStart(32, '0');
}
export function applyOffsetTextEdit(family, from, to, text) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
    throw new Error('annotated text continuous: applyOffsetTextEdit requires a forward [from, to) interval');
  }
  let next = family;
  if (from < to) {
    next = applyTextOperation(next, textOperationForOffsetEdit(
      next, { kind: 'text.delete', from: { offset: from }, to: { offset: to } },
      nextOffsetEditActor(), textFamilyMaxLamport(next) + 1,
    ));
  }
  if (typeof text === 'string' && text.length > 0) {
    next = applyTextOperation(next, textOperationForOffsetEdit(
      next, { kind: 'text.insert', at: { offset: from, affinity: 'right' }, text },
      nextOffsetEditActor(), textFamilyMaxLamport(next) + 1,
    ));
  }
  return next;
}
`;

const FAMILY_VALUE_IMPORT = /import\s*\{[^}]*\}\s*from\s*(['"])\.\/annotated-text-family\.ts\1\s*;?\n?/;

const publicTargets = [
  {
    source: 'annotated-text-continuous.ts',
    target: 'workbench-annotated-text-continuous.mjs',
    // Drop the family value import; its endpoint validator is inlined below so
    // the browser needs only the served annotated-text module.
    transformSource: (source) => source.replace(FAMILY_VALUE_IMPORT, ''),
    inlineStructuralEndpoint: true,
    adapter: CONTINUOUS_BROWSER_ADAPTER,
  },
];

// Pre-bundled browser ESM vendor leaves (consumed by public/workbench-*.mjs so
// Workbench consumers never need to install or run a bundler).
const browserVendorTargets = [
  {
    target: 'workbench-client-vendor-idb.mjs',
    entrySource: "export { openDB } from 'idb';\n",
  },
  {
    target: 'workbench-client-vendor-msgpackr.mjs',
    entrySource: "export { Unpackr } from 'msgpackr/unpack';\n",
  },
  {
    target: 'workbench-client-vendor-xstate.mjs',
    entrySource: "export { createActor, createMachine } from 'xstate';\n",
  },
];

function bundleBrowserVendor(entrySource) {
  const result = buildSync({
    stdin: { contents: entrySource, resolveDir: root, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2024',
    minify: true,
    treeShaking: true,
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const code = result.outputFiles[0].text.replace(/\n+$/, '\n');
  return `// Generated by scripts/emit-ts.mjs — pre-bundled browser ESM (do not hand-edit).\n${code}`;
}

// The exact image this script produces, relative to build/ and public/
// respectively. Exported so `test/emit-ts-fresh.test.mjs` asserts freshness
// against the emit's own logic instead of re-implementing it.
export function emitPlan() {
  const sources = walk(srcRoot);
  const expected = new Map(sources.map((tsPath) => [
    relative(srcRoot, tsPath).replace(/\.ts$/, '.mjs'),
    toRuntime(readFileSync(tsPath, 'utf8')),
  ]));

  const expectedPublic = new Map([
    ...publicTargets.map(({
      source, target, transformSource, inlineStructuralEndpoint, adapter,
    }) => {
      const raw = readFileSync(join(srcRoot, source), 'utf8');
      const prepared = transformSource ? transformSource(raw) : raw;
      const emitted = toRuntime(prepared, browserSpecifier).replace(/\n+$/, '\n');
      const generated = `${inlineStructuralEndpoint ? structuralEndpointValidator() : ''}${adapter ?? ''}`;
      return [target, `${emitted}${generated}`];
    }),
    ...browserVendorTargets.map(({ target, entrySource }) => [
      target,
      bundleBrowserVendor(entrySource),
    ]),
  ]);

  return { expected, expectedPublic };
}

// Delete anything in build/ that has no matching .ts source (exact image),
// pruning directories emptied by the sweep.
function sweepStale(dir, expected) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sweepStale(path, expected);
      if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
    } else if (!expected.has(relative(buildRoot, path))) {
      rmSync(path);
    }
  }
}

export function emit() {
  const { expected, expectedPublic } = emitPlan();
  if (existsSync(buildRoot)) {
    sweepStale(buildRoot, expected);
  } else {
    mkdirSync(buildRoot, { recursive: true });
  }

  let written = 0;
  const writeIfChanged = (path, emitted) => {
    if (existsSync(path) && readFileSync(path, 'utf8') === emitted) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, emitted);
    written += 1;
    if (process.env.WORKBENCH_EMIT_VERBOSE === '1') {
      console.log(`emit ${relative(root, path)}`);
    }
  };

  for (const [rel, emitted] of expected) {
    writeIfChanged(join(buildRoot, rel), emitted);
  }
  for (const [rel, emitted] of expectedPublic) {
    writeIfChanged(join(publicRoot, rel), emitted);
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const written = emit();
  if (process.argv.includes('--print')) {
    console.log(`emitted ${written} module(s)`);
  }
}
