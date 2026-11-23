import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(root, 'src');
const buildRoot = join(root, 'build');
const publicRoot = join(root, 'public');
const nodeBinary = process.versions.bun ? (process.env.WORKBENCH_NODE_BIN ?? 'node') : process.execPath;

// Every emitted .mjs under `dir` (build/ and public/ hold emitted modules).
function walkEmitted(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkEmitted(path, out);
    else if (name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

// TypeScript emission uses Node's stripTypeScriptTypes, which Bun does not
// implement. Run the freshness assertions with the build runtime instead.
function requireNodeRuntime() {
  if (!process.versions.bun) return false;
  const testFile = fileURLToPath(import.meta.url);
  execFileSync(nodeBinary, ['--test', '--test-name-pattern=current against src/', testFile], {
    cwd: root, stdio: 'pipe',
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
  });
  return true;
}

test('no emitted src/**/*.mjs siblings remain (src is source-only)', () => {
  const strays = walkEmitted(srcRoot);
  assert.deepEqual(
    strays,
    [],
    'src/ must contain only .ts sources; found emitted .mjs (edit src/**/*.ts, never the emitted copy)',
  );
});

test('build/ and public/ are current against src/ (exact image)', async () => {
  if (requireNodeRuntime()) return;
  const { emitPlan } = await import(pathToFileURL(join(root, 'scripts', 'emit-ts.mjs')).href);
  const { expected: expectedBuild, expectedPublic } = emitPlan();
  assert.ok(expectedBuild.size > 0, 'expected at least one src/**/*.ts module');

  const built = walkEmitted(buildRoot).map((p) => relative(buildRoot, p));
  assert.deepEqual(
    [...built].sort(),
    [...expectedBuild.keys()].sort(),
    'build/ must mirror src/ exactly (run pnpm build)',
  );
  for (const [rel, want] of expectedBuild) {
    assert.equal(
      readFileSync(join(buildRoot, rel), 'utf8'),
      want,
      `build/${rel} is stale; run pnpm build`,
    );
  }

  // Every generated public/ leaf (including workbench-annotated-text-continuous.mjs)
  // must match the fresh emit byte-for-byte, so stale drift in public/ fails too.
  // public/ also holds hand-maintained modules, so this asserts the generated
  // set is present and current, not that it is the whole directory.
  assert.ok(expectedPublic.size > 0, 'expected at least one generated public/ module');
  for (const [rel, want] of expectedPublic) {
    assert.equal(
      readFileSync(join(publicRoot, rel), 'utf8'),
      want,
      `public/${rel} is stale; run pnpm build`,
    );
  }
});

test('emit:ts script rewrites without error', () => {
  execFileSync(nodeBinary, ['scripts/emit-ts.mjs'], {
    cwd: root,
    stdio: 'pipe',
  });
});
