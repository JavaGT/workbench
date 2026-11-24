// Runtime/declaration export parity for the six published package surfaces.
// Every value exported at runtime must have a matching declaration; a missing
// declaration is a public API hole that TypeScript users hit at compile time.
// Extra declarations are allowed (types have no runtime counterpart), and only
// this direction is checked.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PAIRS = Object.freeze([
  { runtime: 'build/index.mjs', dts: 'index.d.ts' },
  { runtime: 'build/server.mjs', dts: 'src/server.d.ts' },
  { runtime: 'public/workbench-client.mjs', dts: 'client.d.ts' },
  { runtime: 'public/workbench-annotated-text-coords.mjs', dts: 'annotated-text-coords.d.ts' },
  { runtime: 'build/annotated-text-public.mjs', dts: 'annotated-text.d.ts' },
  { runtime: 'build/annotated-text-authoring-public.mjs', dts: 'annotated-text-authoring.d.ts' },
]);

// Blank comments while preserving string literals (a URL like 'https://…'
// inside a type must not look like a comment) and physical line positions.
export function stripComments(source) {
  let out = '';
  let i = 0;
  let state = 'code';
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { out += '  '; i += 2; state = 'line'; continue; }
      if (c === '/' && d === '*') { out += '  '; i += 2; state = 'block'; continue; }
      if (c === "'" || c === '"' || c === '`') { state = c; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { out += '\n'; state = 'code'; } else out += ' ';
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { out += '  '; i += 2; state = 'code'; } else { out += c === '\n' ? '\n' : ' '; i += 1; }
      continue;
    }
    out += c;
    if (c === '\\') { out += d ?? ''; i += 2; continue; }
    if (c === state) state = 'code';
    i += 1;
  }
  return out;
}

// Names a .d.ts file exports: direct declarations, export lists (including
// `export type { … }`), `export default`, and relative `export * from`
// specifiers (returned for the caller to resolve transitively).
export function declaredDtsExports(source) {
  const code = stripComments(source);
  const names = new Set();
  const stars = [];
  const declarationPattern = /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|namespace|(?:const\s+)?enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of code.matchAll(declarationPattern)) names.add(match[1]);
  if (/^\s*export\s+default\b/m.test(code)) names.add('default');
  for (const match of code.matchAll(/^\s*export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const token = part.trim();
      if (!token) continue;
      const aliased = token.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      if (aliased) names.add(aliased[2]);
      else if (/^[\w$]+$/.test(token)) names.add(token);
    }
  }
  for (const match of code.matchAll(/^\s*export\s+\*\s+from\s*['"]([^'"]+)['"]/gm)) stars.push(match[1]);
  return { names, stars };
}

export function findMissingExports(runtimeNames, declaredNames) {
  return [...runtimeNames].filter((name) => !declaredNames.has(name)).sort();
}

export async function runtimeExportNames(fileUrl) {
  return Object.keys(await import(fileUrl)).sort();
}

export async function checkDtsParity({ base = root, pairs = PAIRS, loadRuntime } = {}) {
  const failures = [];
  const read = (file) => readFileSync(join(base, file), 'utf8');
  const importRuntime = loadRuntime ?? ((runtime) => runtimeExportNames(pathToFileURL(join(base, runtime)).href));
  const results = [];

  for (const { runtime, dts } of pairs) {
    if (!existsSync(join(base, runtime))) {
      failures.push(`${runtime}: runtime module is missing`);
      continue;
    }
    if (!existsSync(join(base, dts))) {
      failures.push(`${dts}: declaration file is missing for runtime module ${runtime}`);
      continue;
    }
    let runtimeNames;
    try {
      runtimeNames = await importRuntime(runtime);
    } catch (error) {
      failures.push(`${runtime}: cannot load runtime module (${error.message})`);
      continue;
    }
    const parsed = declaredDtsExports(read(dts));
    const declared = new Set(parsed.names);

    const seen = new Set();
    const collectStars = (file, specifiers) => {
      for (const spec of specifiers) {
        const withoutExtension = spec.replace(/\.js$/, '');
        const target = normalize(join(dirname(file), withoutExtension.endsWith('.d') ? withoutExtension : `${withoutExtension}.d.ts`));
        if (!spec.startsWith('.') || seen.has(target) || !existsSync(join(base, target))) {
          failures.push(`${dts}: cannot resolve 'export * from ${JSON.stringify(spec)}'`);
          continue;
        }
        seen.add(target);
        const nested = declaredDtsExports(read(target));
        collectStars(target, nested.stars);
        for (const name of nested.names) declared.add(name);
      }
    };
    collectStars(dts, parsed.stars);

    const missing = findMissingExports(runtimeNames, declared);
    for (const name of missing) failures.push(`${runtime}: export '${name}' is missing from ${dts}`);
    results.push({ runtime, dts, runtimeExports: runtimeNames.length, declaredExports: declared.size, missing });
  }
  return { failures, results };
}

const invokedAsMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedAsMain) {
  const result = await checkDtsParity();
  if (result.failures.length > 0) {
    console.error(`dts-parity: FAIL (${result.failures.length} violation(s))`);
    for (const failure of result.failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  const checked = result.results.reduce((sum, entry) => sum + entry.runtimeExports, 0);
  console.log(`dts-parity: ok (${result.results.length} surfaces, ${checked} runtime exports, 0 missing declarations)`);
}
