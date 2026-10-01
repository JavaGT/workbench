import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// This is the intentionally supported package surface. Runtime exports may be
// wider while the migration is in progress; additions here are promises to
// consumers and therefore require both runtime and strict-TypeScript coverage.
export const PUBLIC_API = Object.freeze({
  workbench: Object.freeze({
    default: true,
    named: Object.freeze([
      'action', 'event', 'entity', 'scope',
      'text', 'boolean', 'date', 'number', 'json', 'ref', 'hash', 'blob',
      'link', 'map', 'list', 'log', 'ephemeral', 'state', 'computed',
      'projected', 'raster', 'polyline', 'vector',
      'owner', 'membership', 'read', 'write', 'subscribe', 'admin',
      'grant', 'deny', 'everyone', 'never', 'anyOf', 'inherit',
      'principal', 'anonymous', 'requireUser', 'allowAnonymous', 'router',
      'inc', 'dec', 'self', 'many', 'effect', 'schedule', 'tick',
      'simulate', 'now',
      'normalizeTierDeclaration', 'tierOf', 'isDataTier', 'isEntityTier',
      'DATA_TIERS', 'ENTITY_TIERS', 'TIER_DESCRIPTIONS',
      'createAuditor', 'createDenialAuditor', 'isOpaqueId', 'sanitizeOpaqueId',
      'annotatedTextClientHandle',
       'annotationEntityAction', 'annotatedTextAnnotationAction',
      'User', 'Session', 'Inbox', 'Credential', 'Invitation', 'ApiKey',
      'TwoFactor',
    ]),
  }),
  'workbench/server': Object.freeze({
    default: false,
    named: Object.freeze([
      'sessionCookie', 'sessionPrincipalOf', 'sessionTokenOf',
      'apiKeyPrincipalOf', 'parseCookies', 'SESSION_COOKIE',
      'createInvitationApi', 'emailSeam', 'noopTransport',
      'matchRoute', 'serveStatic', 'createJobQueue', 'createBlobStore',
      'runMigrations', 'frameworkTableNames', 'declaredTableNames',
      'assertNoFrameworkTableSql',
       'readCommittedCursor', 'createLiveDelivery', 'createLiveDeliveryHttpHandler',
       'createSearchPluginRegistry', 'createSearchSourceReader',
       'createSearchOwnedIndexCapability', 'createVectorPlugin',
     ]),
  }),
  'workbench/client': Object.freeze({
    default: false,
    named: Object.freeze([
      'LiveChannel', 'LiveList', 'WorkbenchFailureError', 'decodeResult', 'createLiveStore',
       'createScopeLiveStore', 'createLiveDeliverySession', 'createLiveDeliveryHttpSession', 'createAnnotatedTextHttpSession',
      'createAuthClient', 'projectEndpointToOffset',
    ]),
  }),
  'workbench/annotated-text': Object.freeze({
    default: false,
    exact: true,
    named: Object.freeze([
       'annotatedText', 'annotation', 'protectingAnnotation', 'measurement',
       'annotationAction', 'annotationEntityAction', 'registerAnnotatedTextContract',
        'registerAnnotatedTextStructuralExtension', 'annotatedTextAction', 'annotatedTextAnnotationAction', 'annotatedTextCreateAction', 'annotatedTextRetireAction', 'parseRegionEditDescriptor', 'isRegionEditDescriptor', 'annotationEntityRemoveAction', 'annotatedTextOperation', 'exportAnnotatedText', 'readAnnotatedTextForRecipient',
    ]),
  }),
  'workbench/annotated-text-coords': Object.freeze({
    default: false,
    exact: true,
    named: Object.freeze([
      'wireToDisplayPosition', 'displayToWirePosition', 'classifyDisplayOffset',
      'selectionCrossesDisplayRedaction', 'placeholderDisplayWidth',
      'scalarStart', 'scalarEnd', 'changedRange',
    ]),
  }),
  'workbench/annotated-text-authoring': Object.freeze({
    default: false,
    exact: true,
    named: Object.freeze([
      'ensureStream', 'ensureLease', 'issueAuthoringSnapshot', 'buildAuthoringEnvelope',
      'hashClientNonce', 'acknowledgeAndPruneSnapshot', 'readAnnotatedTextFamilyCheckpoint', 'readProjectedCursorFence',
      'restoreTextFamilySerialized', 'textFamilyBasis', 'projectEndpointToOffset',
    ]),
  }),
});

const PRIVATE_ENTRYPOINTS = Object.freeze([
  'workbench/internal',
  'workbench/build/committed-log.mjs',
  'workbench/build/history-read.mjs',
  'workbench/build/post-commit-effects.mjs',
  'workbench/build/operational-consumer.mjs',
  'workbench/build/durable-history.mjs',
  'workbench/build/pipeline.mjs',
  'workbench/build/driver.mjs',
]);

const root = fileURLToPath(new URL('..', import.meta.url));

test('the packed package exposes the supported runtime contract', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'workbench-public-contract-'));
  try {
    const packJson = execFileSync(
      'npm',
      ['pack', '--json', '--pack-destination', consumer],
      { cwd: root, encoding: 'utf8' },
    );
    const [{ filename }] = JSON.parse(packJson);
    execFileSync(
      'npm',
      ['install', '--ignore-scripts', '--no-package-lock', join(consumer, filename)],
      { cwd: consumer, stdio: 'pipe' },
    );

    writeFileSync(join(consumer, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(consumer, 'verify.mjs'),
      `const manifest = ${JSON.stringify(PUBLIC_API)};\n`
        + `for (const [entrypoint, contract] of Object.entries(manifest)) {\n`
        + `  const module = await import(entrypoint);\n`
        + `  if (contract.default && typeof module.default !== 'function') {\n`
        + `    throw new Error(entrypoint + ' must export a default function');\n`
        + `  }\n`
        + `  for (const symbol of contract.named) {\n`
        + `    if (!(symbol in module)) throw new Error(entrypoint + ' is missing ' + symbol);\n`
        + `  }\n`
        + `  if (contract.exact && JSON.stringify(Object.keys(module).sort()) !== JSON.stringify([...contract.named].sort())) {\n`
        + `    throw new Error(entrypoint + ' has an unexpected export surface');\n`
        + `  }\n`
        + `}\n`
        + `const prohibitedMigrationExports = ['WORKBENCH_MIGRATIONS', 'ensureWorkbenchMigrationTable', 'appliedWorkbenchVersion', 'runWorkbenchMigrations'];\n`
        + `for (const entrypoint of Object.keys(manifest)) {\n`
        + `  const module = await import(entrypoint);\n`
        + `  for (const symbol of prohibitedMigrationExports) {\n`
        + `    if (symbol in module) throw new Error(entrypoint + ' exposes package-owned migration runner ' + symbol);\n`
        + `  }\n`
        + `}\n`
        + `const { DatabaseSync } = await import('node:sqlite');\n`
        + `const { runMigrations } = await import('workbench/server');\n`
        + `const migrationDb = new DatabaseSync(':memory:');\n`
        + `try {\n`
        + `  let rejected = false;\n`
        + `  try { runMigrations(migrationDb, [{ namespace: 'WorkBench', name: 'impersonator', version: 1, up() {} }]); } catch { rejected = true; }\n`
        + `  if (!rejected) throw new Error('workbench/server can run reserved-namespace migrations');\n`
        + `} finally { migrationDb.close(); }\n`
        + `const root = await import('workbench');\n`
        + `const annotatedText = await import('workbench/annotated-text');\n`
        + `for (const symbol of ${JSON.stringify(['annotatedText', 'annotation', 'protectingAnnotation', 'measurement', 'annotationAction', 'registerAnnotatedTextContract', 'registerAnnotatedTextStructuralExtension', 'annotatedTextAction', 'annotatedTextCreateAction', 'annotatedTextRetireAction', 'parseRegionEditDescriptor', 'isRegionEditDescriptor', 'annotationEntityRemoveAction', 'annotatedTextOperation', 'exportAnnotatedText', 'readAnnotatedTextForRecipient'])}) {\n`
        + `  if (root[symbol] !== annotatedText[symbol]) throw new Error('workbench/annotated-text must share root binding ' + symbol);\n`
        + `}\n`
        + `for (const entrypoint of ${JSON.stringify(PRIVATE_ENTRYPOINTS)}) {\n`
        + `  try {\n`
        + `    await import(entrypoint);\n`
        + `  } catch (error) {\n`
        + `    if (error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') continue;\n`
        + `    throw error;\n`
        + `  }\n`
        + `  throw new Error(entrypoint + ' must not be exported');\n`
        + `}\n`
        + `const server = await import('workbench/server');\n`
        + `if (typeof server.assertNoFrameworkTableSql !== 'function') {\n`
        + `  throw new Error('workbench/server must export assertNoFrameworkTableSql');\n`
        + `}\n`
        + `try {\n`
        + `  server.assertNoFrameworkTableSql('SELECT * FROM _Log');\n`
        + `  throw new Error('assertNoFrameworkTableSql must reject framework tables');\n`
        + `} catch (error) {\n`
        + `  if (!String(error?.message || error).includes('framework table')) throw error;\n`
        + `}\n`
        + `server.assertNoFrameworkTableSql('SELECT * FROM Note');\n`,
    );

    let failure = null;
    try {
      execFileSync('node', ['verify.mjs'], { cwd: consumer, encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      failure = error;
    }
    assert.equal(
      failure,
      null,
      failure ? readFileSync(join(consumer, 'verify.mjs'), 'utf8') + '\n' + failure.stderr : '',
    );
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});
