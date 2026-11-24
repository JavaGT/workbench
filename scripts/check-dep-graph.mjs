// Deterministic dependency-direction guardrails.
//
// Four independent rules, all structural (no heuristic naming):
//   1. browser modules (public/**/*.mjs) never import a `node:*` specifier;
//   2. the strategy barrel never imports the annotated-text field kind (SPI
//      inversions turn the registry into a hidden dependency on its consumer);
//   3. raw transaction SQL (BEGIN/COMMIT/ROLLBACK) only lives in the two files
//      that own transaction control;
//   4. the runtime ES import graph of src/**/*.ts gains no new cycles.
//
// The cycle rule is a one-way ratchet: the cycles already present in the tree
// are recorded in BASELINE_CYCLES below, and any cycle whose member set is not
// in that set fails the check. Shrinking or breaking a baseline cycle is fine;
// the stale entries are reported so they can be deleted deliberately.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const STRATEGY_INDEX = 'src/strategy/index.ts';
const FIELD_KIND_SPECIFIER = /annotated-text-field/;
const TRANSACTION_OWNERS = new Set(['src/driver.ts', 'src/directory-lock.ts']);

function cycleKey(members) {
  return [...members].sort().join(' | ');
}

// BASELINE_CYCLES — pre-existing SCCs at the time this guard was introduced
// (2026-11-25). Each key is the sorted member set of one strongly connected
// component. Do NOT add to this set to make a check pass: a new key means a new
// dependency cycle, which must be removed in source instead. Delete keys only
// when the corresponding cycle has actually been broken.
const BASELINE_CYCLES = new Set([
  cycleKey([
    'src/annotated-text-caret-projection.ts',
    'src/annotated-text-field.ts',
    'src/annotated-text-recipient-projection.ts',
    'src/annotated-text-snapshot.ts',
    'src/entity/query.ts',
    'src/fts-strategy.ts',
    'src/fts5-plugin.ts',
    'src/registry.ts',
    'src/scope-sql.ts',
    'src/search-plugin.ts',
    'src/search-reconcile.ts',
    'src/strategy/ephemeral.ts',
    'src/strategy/index.ts',
    'src/strategy/log.ts',
    'src/strategy/map.ts',
    'src/strategy/ordered.ts',
  ]),
  cycleKey(['src/app.ts', 'src/auth/routes.ts']),
  cycleKey(['src/http-fetch.ts', 'src/live-delivery-bun-ws.ts', 'src/serve.ts']),
  cycleKey(['src/schedule-runtime.ts', 'src/schedule.ts']),
]);

// A small tokenizer. TypeScript's JS AST API is unavailable in TS 7 (native
// port), and regex-only import matching confuses comments/strings with real
// statements, so imports and db.exec calls are read from tokens instead.
// Tokens carry their source offset so diagnostics can name an exact line.
function tokenize(source) {
  const tokens = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      const quote = c;
      i += 1;
      let value = '';
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') { value += source[i + 1] ?? ''; i += 2; } else { value += source[i]; i += 1; }
      }
      i += 1;
      tokens.push({ type: 'string', value, start });
      continue;
    }
    if (c === '`') {
      const start = i;
      i += 1;
      let value = '';
      let prefixDone = false;
      while (i < n) {
        if (source[i] === '\\') { if (!prefixDone) value += source[i + 1] ?? ''; i += 2; continue; }
        if (!prefixDone && source[i] === '$' && source[i + 1] === '{') { prefixDone = true; i += 2; continue; }
        if (source[i] === '`') { i += 1; break; }
        if (!prefixDone) value += source[i];
        i += 1;
      }
      tokens.push({ type: 'template', value, start });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      let j = i + 1;
      while (j < n && /[\w$]/.test(source[j])) j += 1;
      tokens.push({ type: 'ident', value: source.slice(i, j), start });
      i = j;
      continue;
    }
    tokens.push({ type: 'punct', value: c, start: i });
    i += 1;
  }
  return tokens;
}

function lineNumbers(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid; else high = mid - 1;
    }
    return low + 1;
  };
}

// Returns every static import/export-from specifier (plus dynamic import()) in
// source order. `typeOnly` marks `import type` / `export type`, which are erased
// at runtime and therefore excluded from the dependency graph but still
// included by the SPI rule (a type-only inversion is still an inversion).
export function findImportSpecifiers(source) {
  const tokens = tokenize(source);
  const lineOf = lineNumbers(source);
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type !== 'ident' || (t.value !== 'import' && t.value !== 'export')) continue;
    let j = i + 1;
    let typeOnly = false;
    if (tokens[j]?.value === 'type') { typeOnly = true; j += 1; }
    const next = tokens[j];
    if (next?.type === 'punct' && next.value === '(') {
      // dynamic import('specifier')
      const spec = tokens[j + 1];
      if (spec?.type === 'string') out.push({ specifier: spec.value, line: lineOf(t.start), typeOnly: false, keyword: 'import', dynamic: true });
      continue;
    }
    if (next?.type === 'punct' && next.value === '.') continue; // import.meta
    if (next?.type === 'string' && t.value === 'import') {
      // side-effect import: import 'specifier'
      out.push({ specifier: next.value, line: lineOf(next.start), typeOnly: false, keyword: 'import', dynamic: false });
      continue;
    }
    // import/export ... from 'specifier'
    for (let k = j; k < tokens.length; k += 1) {
      const cur = tokens[k];
      if (cur.type === 'punct' && cur.value === ';') break;
      if (cur.type === 'ident' && (cur.value === 'import' || cur.value === 'export') && k > j) break;
      if (cur.type === 'ident' && cur.value === 'from') {
        const spec = tokens[k + 1];
        if (spec?.type === 'string') out.push({ specifier: spec.value, line: lineOf(spec.start), typeOnly, keyword: t.value, dynamic: false });
        break;
      }
    }
  }
  return out;
}

export function findNodeSpecifierImports(source) {
  return findImportSpecifiers(source).filter((im) => im.specifier.startsWith('node:'));
}

export function findStrategyFieldKindImports(source) {
  return findImportSpecifiers(source).filter((im) => FIELD_KIND_SPECIFIER.test(im.specifier));
}

// Only a leading transaction statement counts as raw transaction control:
// `ROLLBACK TO <savepoint>` and `CREATE TRIGGER ... BEGIN ... END` do not start
// with BEGIN/COMMIT/ROLLBACK and are therefore ignored by construction.
export function findRawTransactionSql(source) {
  const tokens = tokenize(source);
  const lineOf = lineNumbers(source);
  const out = [];
  for (let i = 0; i + 4 < tokens.length; i += 1) {
    if (tokens[i].type !== 'ident' || tokens[i].value !== 'db') continue;
    if (tokens[i + 1].value !== '.' || tokens[i + 2].value !== 'exec') continue;
    if (tokens[i + 3].value !== '(') continue;
    const arg = tokens[i + 4];
    if (arg.type !== 'string' && arg.type !== 'template') continue;
    const sql = arg.value.trim();
    if (!/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) continue;
    if (/^ROLLBACK\s+TO\b/i.test(sql)) continue;
    out.push({ sql, line: lineOf(arg.start) });
  }
  return out;
}

export function buildImportGraph(files, readSource) {
  const known = new Set(files);
  const graph = new Map([...files].sort().map((file) => [file, new Set()]));
  for (const file of graph.keys()) {
    for (const im of findImportSpecifiers(readSource(file))) {
      if (im.typeOnly || !im.specifier.startsWith('.')) continue;
      const target = normalize(join(dirname(file), im.specifier));
      if (known.has(target)) graph.get(file).add(target);
    }
  }
  return graph;
}

// Tarjan SCC. Returns sorted member lists in deterministic order; a self-loop
// is also a cycle.
export function findCycles(graph) {
  let index = 0;
  const indices = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];
  function visit(node) {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    const deps = [...(graph.get(node) ?? [])].sort();
    for (const dep of deps) {
      if (!indices.has(dep)) {
        visit(dep);
        low.set(node, Math.min(low.get(node), low.get(dep)));
      } else if (onStack.has(dep)) {
        low.set(node, Math.min(low.get(node), indices.get(dep)));
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1 || graph.get(node)?.has(node)) cycles.push([...component].sort());
    }
  }
  for (const node of [...graph.keys()].sort()) if (!indices.has(node)) visit(node);
  return cycles.sort((a, b) => cycleKey(a).localeCompare(cycleKey(b)));
}

export function walkFiles(dir, extension, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, extension, out);
    else if (entry.name.endsWith(extension)) out.push(relative(root, path).replaceAll('\\', '/'));
  }
  return out;
}

export function runDepGraphCheck(base = root) {
  const failures = [];
  const read = (rel) => readFileSync(join(base, rel), 'utf8');
  const publicFiles = walkFiles(join(base, 'public'), '.mjs').sort();
  const srcFiles = walkFiles(join(base, 'src'), '.ts')
    .filter((file) => !file.endsWith('.d.ts'))
    .sort();

  for (const file of publicFiles) {
    for (const im of findNodeSpecifierImports(read(file))) {
      failures.push(`${file}:${im.line} browser module imports node-only specifier '${im.specifier}'`);
    }
  }

  if (srcFiles.includes(STRATEGY_INDEX)) {
    for (const im of findStrategyFieldKindImports(read(STRATEGY_INDEX))) {
      failures.push(`${STRATEGY_INDEX}:${im.line} strategy barrel imports field-kind module '${im.specifier}' (SPI inversion)`);
    }
  }

  for (const file of srcFiles) {
    if (TRANSACTION_OWNERS.has(file)) continue;
    for (const hit of findRawTransactionSql(read(file))) {
      failures.push(`${file}:${hit.line} raw transaction SQL outside ${[...TRANSACTION_OWNERS].join(' / ')}: ${JSON.stringify(hit.sql)}`);
    }
  }

  const graph = buildImportGraph(srcFiles, read);
  const cycles = findCycles(graph);
  const newCycles = cycles.filter((cycle) => !BASELINE_CYCLES.has(cycleKey(cycle)));
  for (const cycle of newCycles) {
    failures.push(`new import cycle (${cycle.length} modules): ${cycle.join(' -> ')}`);
  }

  return {
    failures,
    srcFiles: srcFiles.length,
    publicFiles: publicFiles.length,
    runtimeImports: [...graph.values()].reduce((sum, deps) => sum + deps.size, 0),
    cycles,
    newCycles,
  };
}

const invokedAsMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedAsMain) {
  const result = runDepGraphCheck();
  if (result.failures.length > 0) {
    console.error(`dep-graph: FAIL (${result.failures.length} violation(s))`);
    for (const failure of result.failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  const stale = [...BASELINE_CYCLES].filter((key) => !result.cycles.some((cycle) => cycleKey(cycle) === key));
  console.log(
    `dep-graph: ok (${result.srcFiles} src modules, ${result.publicFiles} public modules, `
    + `${result.runtimeImports} runtime imports, ${result.cycles.length} baselined cycles, 0 new)`,
  );
  if (stale.length > 0) console.log(`dep-graph: note — ${stale.length} baseline cycle(s) no longer present and can be removed`);
}
