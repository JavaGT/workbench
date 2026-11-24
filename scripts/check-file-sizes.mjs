// One-way file-size ratchet for authored source.
//
// Files under src/**/*.ts (excluding declarations) and public/**/*.mjs have a
// 500-line ceiling. Files already over the ceiling when this guard landed are
// recorded in BASELINE_LIMITS at their exact current size; they may shrink, but
// may never grow past the recorded count. Entries whose file disappears or
// drops to <= 500 lines fail the check so the baseline tightens as monoliths
// are split. Entries that merely shrink stay green and are reported so a human
// can lower the recorded number deliberately.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 500;

// BASELINE_LIMITS — exact line counts at 2026-11-25. Do NOT add a file here to
// dodge the 500-line limit; split the file instead. Lower an existing number
// only after the file has actually shrunk.
const BASELINE_LIMITS = Object.freeze({
  'public/workbench-annotated-text-continuous.mjs': 714,
  'public/workbench-annotated-text-editor.mjs': 1402,
  'public/workbench-annotated-text-snapshot.mjs': 588,
  'public/workbench-client.mjs': 6338,
  'public/workbench-local-store.mjs': 1096,
  'src/annotated-text-admit.ts': 815,
  'src/annotated-text-authoring-stream.ts': 665,
  'src/annotated-text-continuous.ts': 672,
  'src/annotated-text-crud.ts': 1591,
  'src/annotated-text-delete-history.ts': 758,
  'src/annotated-text-field.ts': 981,
  'src/annotated-text-operated-event.ts': 1040,
  'src/annotated-text-plan.ts': 750,
  'src/annotated-text-projection.ts': 1124,
  'src/annotated-text-region-reducer.ts': 726,
  'src/annotated-text-snapshot.ts': 1130,
  'src/annotated-text.ts': 1351,
  'src/app-schema-boot.ts': 553,
  'src/app.ts': 897,
  'src/application-action-http.ts': 511,
  'src/application-runtime.ts': 547,
  'src/auth/passkey.ts': 1031,
  'src/auth/routes.ts': 1537,
  'src/authorization-adapter.ts': 640,
  'src/authorized-blob-read.ts': 568,
  'src/backup.ts': 710,
  'src/backup/recycle.ts': 865,
  'src/blob-seams.ts': 938,
  'src/blob-store.ts': 839,
  'src/committed-log.ts': 870,
  'src/composite-journal.ts': 821,
  'src/composite-patch-projector.ts': 1007,
  'src/durable-history.ts': 892,
  'src/entity/compile.ts': 768,
  'src/erasure-directive.ts': 512,
  'src/field-strategy.ts': 901,
  'src/fs-blobs.ts': 640,
  'src/fts5-plugin.ts': 674,
  'src/http-routes-resync.ts': 529,
  'src/job-queue.ts': 1059,
  'src/kernel.ts': 696,
  'src/live-connection.ts': 598,
  'src/live-delivery-core.ts': 1056,
  'src/live-delivery-public.ts': 946,
  'src/live-fanout.ts': 784,
  'src/migration-ledger.ts': 553,
  'src/pending-blob.ts': 772,
  'src/pipeline.ts': 2037,
  'src/post-commit-effects.ts': 673,
  'src/principal-snapshot-delivery.ts': 540,
  'src/query-family.ts': 772,
  'src/query-scoped-read.ts': 1327,
  'src/recovery.ts': 1388,
  'src/row-grant.ts': 728,
  'src/schedule-runtime.ts': 515,
  'src/schema-census.ts': 768,
  'src/schema-exact-validation.ts': 581,
  'src/scope-sql.ts': 1089,
  'src/search-plugin.ts': 1239,
  'src/search-reconcile.ts': 774,
  'src/search-response.ts': 619,
  'src/search-staleness.ts': 800,
  'src/serve.ts': 736,
  'src/snapshot-projection.ts': 713,
  'src/sqlite-schema.ts': 1170,
  'src/vector-plugin.ts': 1081,
  'src/vector.ts': 522,
  'src/workbench-migrations.ts': 501,
});

// Physical lines: a trailing newline terminates the last line rather than
// creating an empty one (same convention as `wc -l`).
export function countLines(source) {
  if (source.length === 0) return 0;
  let newlines = 0;
  for (const char of source) if (char === '\n') newlines += 1;
  return source.endsWith('\n') ? newlines : newlines + 1;
}

export function walkSourceFiles(dir, extension, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(path, extension, out);
    else if (entry.name.endsWith(extension)
      && !(extension === '.ts' && entry.name.endsWith('.d.ts'))) {
      out.push(relative(root, path).replaceAll('\\', '/'));
    }
  }
  return out;
}

export function measureFiles(base = root) {
  const files = [
    ...walkSourceFiles(join(base, 'src'), '.ts'),
    ...walkSourceFiles(join(base, 'public'), '.mjs'),
  ];
  return new Map(files.sort().map((file) => [file, countLines(readFileSync(join(base, file), 'utf8'))]));
}

// Pure core: given rel path -> line count, apply the ratchet and return
// { failures, tighten }. A baseline entry is valid only while its file exists
// and still exceeds LIMIT; entries for shrunk files are reported for cleanup.
export function checkFileSizes(files, baseline = BASELINE_LIMITS) {
  const failures = [];
  const tighten = [];
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b));
  for (const [file, lines] of entries) {
    const recorded = baseline[file];
    if (recorded === undefined) {
      if (lines > LIMIT) failures.push(`${file}: ${lines} lines exceeds the ${LIMIT}-line limit (split the file; do not add a baseline entry)`);
      continue;
    }
    if (lines > recorded) failures.push(`${file}: grew to ${lines} lines beyond its ratcheted ${recorded}-line baseline`);
    else if (lines <= LIMIT) failures.push(`${file}: ${lines} lines is within the ${LIMIT}-line limit; remove its BASELINE_LIMITS entry to tighten the ratchet`);
    else if (lines < recorded) tighten.push(`${file}: can tighten BASELINE_LIMITS from ${recorded} to ${lines}`);
  }
  for (const file of Object.keys(baseline).sort()) {
    if (!files.has(file)) failures.push(`${file}: BASELINE_LIMITS entry no longer exists; remove it to tighten the ratchet`);
  }
  return { failures, tighten };
}

export function runFileSizeCheck(base = root) {
  const files = measureFiles(base);
  const result = checkFileSizes(files);
  return { ...result, files: files.size, baselined: Object.keys(BASELINE_LIMITS).length };
}

const invokedAsMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedAsMain) {
  const result = runFileSizeCheck();
  if (result.failures.length > 0) {
    console.error(`file-sizes: FAIL (${result.failures.length} violation(s))`);
    for (const failure of result.failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(`file-sizes: ok (${result.files} files scanned, ${result.baselined} ratcheted, 0 over-limit)`);
  for (const note of result.tighten) console.log(`file-sizes: note — ${note}`);
}
