import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodeModule from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(root, 'src');
const buildRoot = join(root, 'build');
const stripTypeScriptTypes = nodeModule.stripTypeScriptTypes;
const nodeBinary = process.versions.bun ? (process.env.WORKBENCH_NODE_BIN ?? 'node') : process.execPath;

// Mirrors the emit script's source walk: every .ts except hand-written .d.ts / .d.mts.
function walkSources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkSources(path, out);
    else if (
      name.endsWith('.ts')
      && !name.endsWith('.d.ts')
      && !name.endsWith('.d.mts')
    ) out.push(path);
  }
  return out;
}

// Every emitted .mjs in build/ (nothing else lives there).
function walkEmitted(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkEmitted(path, out);
    else if (name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

function expectedRuntime(source) {
  return stripTypeScriptTypes(source, { filename: 'module.ts' })
    .replaceAll(/[ \t]+$/gm, '')
    .replaceAll(/from\s+(['"])(\.\.?\/[^'"]+)\.ts\1/g, 'from $1$2.mjs$1')
    .replaceAll(/import\s+(['"])(\.\.?\/[^'"]+)\.ts\1/g, 'import $1$2.mjs$1')
    .replaceAll(/import\s*\(\s*(['"])(\.\.?\/[^'"]+)\.ts\1\s*\)/g, 'import($1$2.mjs$1)');
}

test('no emitted src/**/*.mjs siblings remain (src is source-only)', () => {
  const strays = walkEmitted(srcRoot);
  assert.deepEqual(
    strays,
    [],
    'src/ must contain only .ts sources; found emitted .mjs (edit src/**/*.ts, never the emitted copy)',
  );
});

test('build/ is current against src/ (exact image)', () => {
  // TypeScript emission uses Node's stripTypeScriptTypes, which Bun does not
  // implement. Run this same freshness assertion with the build runtime.
  if (process.versions.bun) {
    execFileSync(nodeBinary, ['--test', '--test-name-pattern=build/ is current against src/', 'test/emit-ts-fresh.test.mjs'], {
      cwd: root, stdio: 'pipe',
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
    });
    return;
  }
  const sources = walkSources(srcRoot);
  assert.ok(sources.length > 0, 'expected at least one src/**/*.ts module');
  const expected = new Map(sources.map((p) => [
    relative(srcRoot, p).replace(/\.ts$/, '.mjs'),
    expectedRuntime(readFileSync(p, 'utf8')),
  ]));
  const built = walkEmitted(buildRoot);
  const builtRelative = built.map((p) => relative(buildRoot, p));
  assert.deepEqual(
    [...builtRelative].sort(),
    [...expected.keys()].sort(),
    'build/ must mirror src/ exactly (run pnpm emit:ts)',
  );
  for (const [rel, want] of expected) {
    assert.equal(
      readFileSync(join(buildRoot, rel), 'utf8'),
      want,
      `build/${rel} is stale; run pnpm emit:ts`,
    );
  }
});

test('emit:ts script rewrites without error', () => {
  execFileSync(nodeBinary, ['scripts/emit-ts.mjs'], {
    cwd: root,
    stdio: 'pipe',
  });
});
