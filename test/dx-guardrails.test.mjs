import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  buildImportGraph,
  findCycles,
  findNodeSpecifierImports,
  findRawTransactionSql,
  findStrategyFieldKindImports,
} from '../scripts/check-dep-graph.mjs';
import { checkFileSizes, countLines } from '../scripts/check-file-sizes.mjs';
import {
  checkDtsParity,
  declaredDtsExports,
  findMissingExports,
  stripComments,
} from '../scripts/check-dts-parity.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (script) => execFileSync(process.execPath, [join(root, 'scripts', script)], { cwd: root, encoding: 'utf8' });

test('all three guardrail scripts exit 0 on the repo', () => {
  assert.match(run('check-dep-graph.mjs'), /^dep-graph: ok/m);
  assert.match(run('check-file-sizes.mjs'), /^file-sizes: ok/m);
  assert.match(run('check-dts-parity.mjs'), /^dts-parity: ok/m);
});

test('public node:* imports are caught with exact lines, comments and strings ignored', () => {
  const hits = findNodeSpecifierImports([
    "import fs from 'node:fs';",
    "import 'node:path';",
    "const notAnImport = 'node:os';",
    "// import 'node:tty';",
    '/* import "node:vm"; */',
  ].join('\n'));
  assert.deepEqual(hits.map((hit) => [hit.specifier, hit.line]), [['node:fs', 1], ['node:path', 2]]);
  assert.deepEqual(findNodeSpecifierImports("const url = 'https://node:fs';"), []);
});

test('strategy barrel detects an annotated-text-field import, including type-only', () => {
  assert.equal(findStrategyFieldKindImports("import { x } from '../annotated-text-field.ts';").length, 1);
  assert.equal(findStrategyFieldKindImports("import type { X } from '../annotated-text-field.ts';").length, 1);
  assert.equal(findStrategyFieldKindImports("import { x } from './shared.ts'; // from '../annotated-text-field.ts'").length, 0);
  assert.equal(findStrategyFieldKindImports("import { x } from './shared.ts';").length, 0);
});

test('raw transaction SQL detects BEGIN/COMMIT/ROLLBACK but not savepoints or triggers', () => {
  assert.deepEqual(
    findRawTransactionSql("db.exec('BEGIN IMMEDIATE');\n  db.exec('COMMIT');\n  db.exec('ROLLBACK');")
      .map((hit) => [hit.sql, hit.line]),
    [['BEGIN IMMEDIATE', 1], ['COMMIT', 2], ['ROLLBACK', 3]],
  );
  assert.deepEqual(findRawTransactionSql("db.exec('ROLLBACK TO authoring_snapshot_acknowledge');"), []);
  assert.deepEqual(findRawTransactionSql('db.exec("CREATE TRIGGER t BEFORE INSERT ON x BEGIN SELECT 1; END;");'), []);
  assert.deepEqual(findRawTransactionSql("// db.exec('BEGIN')\nconst sql = 'COMMIT';"), []);
  assert.equal(findRawTransactionSql("db.exec('BEGIN');").length, 1);
});

test('import graph ignores type-only edges and finds cycles', () => {
  const read = (file) => file === 'a.ts'
    ? "import type { T } from './b.ts';\nimport './c.ts';\n"
    : '';
  const graph = buildImportGraph(['a.ts', 'b.ts', 'c.ts'], read);
  assert.deepEqual([...graph.get('a.ts')], ['c.ts']);
  assert.deepEqual(findCycles(graph), []);

  const cyclic = new Map([
    ['a.ts', new Set(['b.ts'])],
    ['b.ts', new Set(['a.ts'])],
    ['c.ts', new Set(['c.ts'])],
    ['d.ts', new Set()],
  ]);
  assert.deepEqual(findCycles(cyclic), [['a.ts', 'b.ts'], ['c.ts']]);
});

test('file-size ratchet fails growth, new over-limit files, stale entries, and split files', () => {
  assert.equal(countLines('a\nb\n'), 2);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines(''), 0);

  const { failures } = checkFileSizes(
    new Map([['src/big.ts', 501], ['src/over.ts', 700], ['src/shrunk.ts', 400]]),
    { 'src/over.ts': 650, 'src/shrunk.ts': 600, 'src/gone.ts': 700 },
  );
  assert.equal(failures.length, 4);
  assert.match(failures.find((line) => line.includes('src/big.ts')), /exceeds the 500-line limit/);
  assert.match(failures.find((line) => line.includes('src/over.ts')), /grew to 700 lines/);
  assert.match(failures.find((line) => line.includes('src/shrunk.ts')), /remove its BASELINE_LIMITS entry/);
  assert.match(failures.find((line) => line.includes('src/gone.ts')), /no longer exists/);

  const shrunk = checkFileSizes(new Map([['src/a.ts', 520]]), { 'src/a.ts': 600 });
  assert.deepEqual(shrunk.failures, []);
  assert.deepEqual(shrunk.tighten, ['src/a.ts: can tighten BASELINE_LIMITS from 600 to 520']);
});

test('d.ts export extraction handles declarations, export lists, defaults, and comments', () => {
  const { names, stars } = declaredDtsExports([
    'export function a(): void;',
    'export const b = 1;',
    'export type { T } from \'./x.js\';',
    'export {',
    '  c,',
    '  d as e,',
    "} from './y.js';",
    'export default function f(): void;',
    "export * from './z.js';",
    '// export function hidden(): void;',
  ].join('\n'));
  assert.deepEqual([...names].sort(), ['T', 'a', 'b', 'c', 'default', 'e']);
  assert.deepEqual(stars, ['./z.js']);
  assert.deepEqual(findMissingExports(['a', 'd', 'z'], names), ['d', 'z']);
  const stripped = stripComments("const url = 'https://example.com//path'; // import 'x'");
  assert.match(stripped, /const url = 'https:\/\/example\.com\/\/path';/);
  assert.ok(!stripped.includes("import 'x'"));
});

test('d.ts parity catches a runtime export missing from its declaration', async () => {
  const result = await checkDtsParity({
    pairs: [{ runtime: 'build/index.mjs', dts: 'index.d.ts' }],
    loadRuntime: async () => ['SESSION_COOKIE', 'totallyMissingExport'],
  });
  assert.deepEqual(result.failures, ["build/index.mjs: export 'totallyMissingExport' is missing from index.d.ts"]);
});
