// W1/W3 single-authority gate for the composite annotated-text seam
// (scope#992 Finding 7). W1 enforces the v10 descriptor parser and the
// operated-envelope constructor. W3 rules activate once their owner files exist.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(root, 'src');
const publicRoot = join(root, 'public');
const buildRoot = join(root, 'build');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) walk(path, out);
    else if (name.name.endsWith('.ts') || name.name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

function rel(path) {
  return relative(root, path).replaceAll('\\', '/');
}

function fail(authority, owners) {
  const list = Array.isArray(owners) ? owners : [owners];
  throw new Error(`annotated-text single authority violation: ${authority} has ${list.length} owners (${list.join(', ')})`);
}

function retired(symbol) {
  throw new Error(`retired annotated history symbol remains: ${symbol}`);
}

function failBoundary(path) {
  throw new Error(`legacy annotated history privacy crossed read boundary: ${path}`);
}

function retiredAnnotatedHistory(path) {
  throw new Error(`retired annotatedHistory classifier surface remains: ${path}`);
}

const sources = [...walk(srcRoot), ...walk(publicRoot)];
const straySourceModules = sources.filter((path) => rel(path).startsWith('src/') && path.endsWith('.mjs'));
if (straySourceModules.length > 0) fail('authored TypeScript source', straySourceModules.map(rel));

const declarations = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.d.ts'))
  .map((entry) => join(root, entry.name));
const emitted = walk(buildRoot);
const checkedFiles = [...sources, ...emitted, ...declarations];
const byRel = new Map(checkedFiles.map((path) => [rel(path), readFileSync(path, 'utf8')]));

function tokens(source) {
  const out = [];
  const pattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\[\s\S]|[^`])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[A-Za-z_$][\w$]*|\d+|[{}():,=;]/g;
  for (const match of source.matchAll(pattern)) {
    const value = match[0];
    if (value.startsWith('//') || value.startsWith('/*') || value.startsWith('`')) continue;
    out.push((value.startsWith("'") || value.startsWith('"')) ? value.slice(1, -1) : value);
  }
  return out;
}

function declaredFunctions(_path, source, names) {
  const found = [];
  const words = tokens(source);
  for (let index = 0; index < words.length - 1; index += 1) {
    if (['function', 'const', 'let', 'var'].includes(words[index]) && names.has(words[index + 1])) found.push(words[index + 1]);
  }
  return found;
}

// This deliberately narrow syntax rule owns direct operated-envelope object
// literals. Computed/incremental assembly is prohibited by constructor-name
// ownership below; imports must resolve to the sole constructor module.
function hasDirectOperatedEnvelope(source) {
  const words = tokens(source);
  const stack = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === '{') {
      const prefix = words.slice(Math.max(0, index - 4), index);
      stack.push({ version: false, facts: false, type: prefix.includes('interface') || (prefix.includes('type') && words[index - 1] === '=') });
      continue;
    }
    if (word === '}') {
      const object = stack.pop();
      if (!object?.type && object?.version && object.facts) return true;
      continue;
    }
    const object = stack.at(-1);
    if (!object || words[index + 1] !== ':') continue;
    if (word === 'facts') object.facts = true;
    if (word === 'version' && ['14', '16'].includes(words[index + 2]) && words[index + 3] !== ';') object.version = true;
  }
  return false;
}

const V10_EXPORT = /export\s+(?:function|const|async function)\s+(parseRegionEditDescriptor|isRegionEditDescriptor)\b/;
const v10Owners = [];
for (const [path, source] of byRel) {
  if (path.startsWith('src/') && V10_EXPORT.test(source)) v10Owners.push(path);
}
if (v10Owners.length !== 1 || v10Owners[0] !== 'src/annotated-text-region-descriptor.ts') {
  fail('v10 descriptor grammar', v10Owners.length ? v10Owners : ['<missing>']);
}

const emittedV10Owners = [];
const declarationV10Owners = [];
for (const [path, source] of byRel) {
  if (path.startsWith('build/') && V10_EXPORT.test(source)) emittedV10Owners.push(path);
  if (path.endsWith('.d.ts') && /export\s+function\s+(?:parseRegionEditDescriptor|isRegionEditDescriptor)\b/.test(source)) declarationV10Owners.push(path);
}
if (emittedV10Owners.length !== 1 || emittedV10Owners[0] !== 'build/annotated-text-region-descriptor.mjs') {
  fail('emitted v10 descriptor grammar', emittedV10Owners.length ? emittedV10Owners : ['<missing>']);
}
if (declarationV10Owners.length !== 1 || declarationV10Owners[0] !== 'index.d.ts') {
  fail('declared v10 descriptor grammar', declarationV10Owners.length ? declarationV10Owners : ['<missing>']);
}

const ENVELOPE_CONSTRUCTOR = /export\s+function\s+(constructV14OperatedEvent|constructV15RegionEvent|constructV16RegionEvent|serializeV16OperatedEvent|parseStoredV16OperatedEvent)\b/;
const envelopeOwners = [];
for (const [path, source] of byRel) {
  if (path.startsWith('src/') && ENVELOPE_CONSTRUCTOR.test(source)) envelopeOwners.push(path);
}
if (envelopeOwners.length !== 1 || envelopeOwners[0] !== 'src/annotated-text-operated-event.ts') {
  fail('operated envelope construction', envelopeOwners.length ? envelopeOwners : ['<missing>']);
}

const constructorNames = new Set([
  'constructV14OperatedEvent',
  'constructV15RegionEvent',
  'constructV16RegionEvent',
  'serializeV16OperatedEvent',
  'parseStoredV16OperatedEvent',
]);
// W1b (#149): the v16 constructor has exactly one owner. The compiled region
// policy is the SOLE authorized caller (the new-emission path); every other
// module referencing these names is a second authority. The stored-text
// serializer/parser have NO other callers at all.
const V16_AUTHORITY_OWNER = 'src/annotated-text-operated-event.ts';
const V16_REGION_POLICY = 'src/annotated-text-region-operation.ts';
// W3 (#145): the contribution-policy compensation planner consumes the v16
// constructor for new compensation events. Persisted target events must go
// through committed-log's shared decoder, never the strict parser directly.
const V16_COMPENSATION_PLANNER = 'src/annotated-text-region-compensation.ts';
// committed-log is the one _Log write authority and calls the serializer to
// canonicalize/verify v16 eventData at its single insert point (W1b adapter).
const V16_LOG_ADAPTER = 'src/committed-log.ts';
// post-commit-effects is a sanctioned READER: its private-fact replay path
// decodes committed v16 rows through the strict stored parser (Finding 1,
// round 2). It may not re-export or re-implement any v16 authority.
const V16_FACT_READER = 'src/post-commit-effects.ts';
const V16_CONSTRUCTOR_NAME = 'constructV16RegionEvent';
const V16_SERIALIZER_NAME = 'serializeV16OperatedEvent';
for (const [path, source] of byRel) {
  if (!path.startsWith('src/') || path === V16_AUTHORITY_OWNER) continue;
  if (path === V16_REGION_POLICY) {
    // The policy may call the constructor but may not re-export or alias it
    // into a second authority surface.
    if (/export[^{]*constructV16RegionEvent/.test(source)) {
      fail('v16 operated authority', [V16_AUTHORITY_OWNER, path]);
    }
    continue;
  }
  if (path === V16_LOG_ADAPTER) {
    if (/export[^{]*serializeV16OperatedEvent/.test(source)) {
      fail('v16 operated authority', [V16_AUTHORITY_OWNER, path]);
    }
    continue;
  }
  if (path === V16_FACT_READER) {
    if (/export[^{]*(parseStoredV16OperatedEvent|serializeV16OperatedEvent|constructV16RegionEvent)/.test(source)) {
      fail('v16 operated authority', [V16_AUTHORITY_OWNER, path]);
    }
    continue;
  }
  if (path === V16_COMPENSATION_PLANNER) {
    // The planner may consume the constructor but may not re-export it or call
    // the stored parser directly; decodeLogRowData owns every _Log read.
    if (/export[^{]*constructV16RegionEvent/.test(source) || /\bparseStoredV16OperatedEvent\b/.test(source)) {
      fail('v16 operated authority', [V16_AUTHORITY_OWNER, path]);
    }
    continue;
  }
  for (const name of ['parseStoredV16OperatedEvent', V16_SERIALIZER_NAME]) {
    if (new RegExp(`\\b${name}\\b`).test(source)) {
      fail('v16 operated authority', [V16_AUTHORITY_OWNER, path]);
    }
  }
  if (new RegExp(`\\b${V16_CONSTRUCTOR_NAME}\\b`).test(source)) {
    fail('v16 operated authority', [V16_AUTHORITY_OWNER, path]);
  }
}
// New region writes must never lower to replay-only versions. The planner,
// policy, and reducer modules may not reference legacy constructors at all.
const REGION_EMITTER_FILES = [
  'src/annotated-text-region-descriptor.ts',
  'src/annotated-text-region-limits.ts',
  'src/annotated-text-region-plan.ts',
  'src/annotated-text-region-operation.ts',
  'src/annotated-text-region-reducer.ts',
];
for (const path of REGION_EMITTER_FILES) {
  const source = byRel.get(path);
  if (!source) continue;
  if (/\bconstructV1[45][A-Za-z]*\b/.test(source)) {
    fail('new region emitter version', [path]);
  }
}
const emittedEnvelopeOwners = [];
for (const [path, source] of byRel) {
  if (!path.startsWith('build/')) continue;
  if (declaredFunctions(path, source, constructorNames).length > 0) emittedEnvelopeOwners.push(path);
}
if (emittedEnvelopeOwners.length !== 1 || emittedEnvelopeOwners[0] !== 'build/annotated-text-operated-event.mjs') {
  fail('emitted operated envelope construction', emittedEnvelopeOwners.length ? emittedEnvelopeOwners : ['<missing>']);
}

const inlineOwners = [];
for (const [path, source] of byRel) {
  if (!path.startsWith('src/') || path === 'src/annotated-text-operated-event.ts') continue;
  if (hasDirectOperatedEnvelope(source)) inlineOwners.push(path);
}
if (inlineOwners.length > 0) fail('operated envelope construction', ['src/annotated-text-operated-event.ts', ...inlineOwners]);

for (const [path, source] of byRel) {
  if (!path.startsWith('src/') || path === 'src/annotated-text-operated-event.ts') continue;
  for (const match of source.matchAll(/import\s*{([^}]*)}\s*from\s*['"]([^'"]+)['"]/g)) {
    const imported = match[1].split(',').map((part) => part.trim().split(/\s+as\s+/)[0]);
    if (imported.some((name) => constructorNames.has(name)) && !match[2].endsWith('annotated-text-operated-event.ts')) {
      fail('operated envelope constructor import', [path]);
    }
  }
}

// The region path emits only v16: no region module may lower a region to the
// live-authoring v14 envelope constructor. The live authoring path
// (annotated-text-plan.ts / crud.ts) legitimately emits v14 and is not covered
// by this region-only rule.
const regionOnly = new Set([
  'src/annotated-text-region-descriptor.ts',
  'src/annotated-text-region-limits.ts',
  'src/annotated-text-region-plan.ts',
  'src/annotated-text-region-reducer.ts',
]);
const legacyRegionEmitters = [];
for (const path of regionOnly) {
  const source = byRel.get(path);
  if (!source) continue;
  if (/\bconstructV14OperatedEvent\b/.test(source)) legacyRegionEmitters.push(path);
}
if (legacyRegionEmitters.length > 0) {
  fail('region v13/v14 emitter', legacyRegionEmitters);
}

const w3Active = byRel.has('src/legacy-annotated-history-read-privacy.ts');
// Retirement is complete only when the registry module carries the explicit
// W3 retirement marker (added when the old classifier symbols are actually
// removed). The marker keeps the gate green across incremental W3 slices and
// activates the retire/read-privacy rules only at the converged state.
const W3_RETIRED_MARKER = 'W3_HISTORY_RETIRED';
const w3Retired = w3Active && (byRel.get('src/history-contribution-policy.ts') ?? '').includes(W3_RETIRED_MARKER);

if (w3Active) {
  // Active immediately: no module other than the history read boundary may
  // import the privacy capability. (The broader movement boundary for the
  // retired receipt/scope scanners activates at retirement completion below,
  // because durable-history still owns those scanners until then.)
  for (const [path, source] of byRel) {
    if (!path.startsWith('src/')) continue;
    if (path === 'src/legacy-annotated-history-read-privacy.ts' || path === 'src/history-read.ts') continue;
    for (const match of source.matchAll(/import\s*\{([^}]*)}\s*from\s*['"]([^'"]+)['"]/g)) {
      const imported = match[1].split(',').map((part) => part.trim().split(/\s+as\s+/)[0]);
      if (imported.includes('assertLegacyAnnotatedHistoryReadable')) {
        failBoundary(path);
      }
    }
  }

  void w3Retired;
}

if (w3Retired) {
  // rev 3 §3 movement boundary: durable-history, contribution-policy, cursor,
  // pipeline, and kernel must carry no reference to the privacy capability or
  // the retired receipt/scope scanners.
  const movementModules = [
    'src/durable-history.ts', 'src/history-contribution-policy.ts',
    'src/pipeline.ts', 'src/kernel.ts',
  ];
  for (const path of movementModules) {
    const source = byRel.get(path);
    if (!source) continue;
    if (new RegExp(`\\b(assertLegacyAnnotatedHistoryReadable|receiptContainsAnnotatedText|scopeContainsAnnotatedText)\\b`).test(source)) {
      failBoundary(path);
    }
  }
  const banned = ['annotatedMove', 'annotatedMoveActionTypes', 'hasAnnotatedMoveCapability', 'ANNOTATED_TEXT_COMPENSATION'];
  for (const symbol of banned) {
    for (const [path, source] of byRel) {
      if (!path.startsWith('src/') && !path.startsWith('public/')) continue;
      if (new RegExp(`\\b${symbol}\\b`).test(source)) retired(symbol);
    }
  }
  // The retired public `annotatedHistory` option surface is forbidden in source
  // (server.d.ts cover), emitted build, and declarations.
  for (const [path, source] of byRel) {
    if (!path.endsWith('.ts') && !path.endsWith('.mjs') && !path.endsWith('.d.ts')) continue;
    if (/\bannotatedHistory\b/.test(source)) retiredAnnotatedHistory(path);
  }
}

// #315 clean break: the retired operated versions must have no grammar path,
// and the single version gate must reject them fail-closed at runtime.
function retiredOperatedVersion(version) {
  throw new Error(`retired operated version ${version} still has a live grammar path`);
}
const operatedSource = byRel.get('src/annotated-text-operated-event.ts') ?? '';
if (/\bconstructV13OperatedEvent\b/.test(operatedSource)) retiredOperatedVersion(13);
if (/\bversion:\s*13\b/.test(operatedSource)) retiredOperatedVersion(13);
if (byRel.has('build/annotated-text-operated-event.mjs')) {
  const emitted = byRel.get('build/annotated-text-operated-event.mjs');
  if (/\bconstructV13OperatedEvent\b/.test(emitted)) retiredOperatedVersion(13);
}

const { normalizeOperatedEvent } = await import('../build/annotated-text-operated-event.mjs');
for (const version of [13, 15]) {
  const envelope = {
    version,
    id: 'x',
    before: { structuralRevision: 1, frontier: [] },
    after: { structuralRevision: 1, frontier: [] },
    operation: { kind: 'text.apply', operation: [] },
    facts: {},
  };
  let rejected = false;
  try {
    normalizeOperatedEvent(envelope, { entity: 'E', field: 'f' });
  } catch (error) {
    rejected = /only operated versions 14 and 16 are replayable/.test(error.message);
  }
  if (!rejected) retiredOperatedVersion(version);
}

console.log('annotated-text single authority: ok');
