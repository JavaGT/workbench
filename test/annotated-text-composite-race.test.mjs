// W2 transaction-bound admission race (scope#992 Finding 4). Native authoring
// edits and composed region edits reach the SAME commitEvents instance on the
// SAME app.db, so `coordinatedTxn` serializes their entry per handle. This test
// blocks one dispatch mid-coordinator (inside its in-txn handler) and issues
// the other; accepted outcomes are exclusively native-first/compound-stale or
// compound-first/native-stale. Failure signature:
// `annotated writers escaped the shared coordinator`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, read, ref, scope, text as _text, write,
} from '../build/internal.mjs';
import { defineSqliteSchema } from '../build/server.mjs';
import {
  importTextToFamily,
  materializeText,
  projectEndpointToOffset,
  resolveOffsetToEndpoint as _resolveOffsetToEndpoint,
  restoreTextFamilySerialized,
  serializeCompactTextFamilyCheckpoint,
  textFamilyBasis,
} from '../build/annotated-text-continuous.mjs';
import { readAnnotatedTextFamilyCheckpoint } from '../build/annotated-text-authoring-stream.mjs';
import { attachAnnotationRange as _attachAnnotationRange, loadAnnotationImages } from '../build/annotated-text-storage.mjs';
import {
  computeAffectedClosure,
  digestAffectedClosure,
} from '../build/annotated-text-region-reducer.mjs';
import { annotatedTextOperation } from '../build/annotated-text-region-operation.mjs';
import { sha256Utf8 } from '../build/annotated-text-region-limits.mjs';
import { withAuthoringBinding, authoringBinding } from './annotated-text-authoring-fixture.mjs';

const ACTOR = 'a'.repeat(32);

function docEntity(fieldGate = null) {
  if (fieldGate) {
    // In-transaction field admission gate: blocks the native authoring edit
    // ONLY while it is inside the shared coordinator (db.isTransaction), so
    // the reverse-order race is genuinely concurrent.
    return entity('RaceDoc', {
      project: ref('Project'),
      owner: ref('User', { role: 'owner' }),
      body: annotatedText({
        project: 'project',
        owner: 'owner',
        annotations: [annotation('note', { fields: {} })],
      }).can(async () => {
        if (dbOf()?.isTransaction === true) await fieldGate();
        return grant(read, write);
      }),
      grant: [scope(() => everyone()).can(() => grant(read, write))],
    });
  }
  return entity('RaceDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [annotation('note', { fields: {} })],
    }).can(() => grant(read, write)),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

let sharedDb = null;
function dbOf() {
  return sharedDb;
}

const raceSchema = defineSqliteSchema({
  name: 'annotated-text-composite-race',
  tables: [],
  externalTables: [{ name: 'Project', columns: ['id'] }],
});

function installSchema(db) {
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(docEntity(), db);
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  db.exec("INSERT INTO RaceDoc (id, project, owner) VALUES ('doc-1', 'p1', 'u1')");
  db.prepare('INSERT INTO RaceDoc_body_state (document_id, structure_version, family_checkpoint) VALUES (?, ?, ?)')
    .run('doc-1', 1, serializeCompactTextFamilyCheckpoint(family));
  return family;
}

function liveFamily(db) {
  return restoreTextFamilySerialized(readAnnotatedTextFamilyCheckpoint(db, 'RaceDoc_body', 'doc-1'));
}

function currentDescriptor(db, { from, to, replacement, transitions = [] }) {
  const family = liveFamily(db);
  const baseImages = loadAnnotationImages(db, {
    prefix: 'RaceDoc_body',
    documentId: 'doc-1',
    declarations: [{ annotationName: 'note', fields: {} }],
  });
  const regionImages = baseImages.map((image) => ({
    id: image.id,
    family: image.family,
    fields: image.fields,
    protectedTargetIds: image.protectedTargetIds,
    memberships: image.memberships,
    prerequisites: image.prerequisites,
    empty: 'delete',
    cardinality: 'many',
  }));
  const closure = computeAffectedClosure({ annotations: regionImages, family, from, to, namedIds: [] });
  const coveredIds = [];
  for (const image of closure) {
    for (const entry of image.memberships) {
      const start = projectEndpointToOffset(family, entry.start);
      const end = projectEndpointToOffset(family, entry.end);
      if (Math.min(end, to) - Math.max(start, from) > 0) { coveredIds.push(image.id); break; }
    }
  }
  return {
    version: 10,
    kind: 'region.edit',
    id: 'doc-1',
    basis: textFamilyBasis(family),
    from,
    to,
    coveredTextDigest: sha256Utf8(materializeText(family).slice(from, to)),
    affectedClosureDigest: digestAffectedClosure(closure),
    expectedCoveredAnnotationIds: coveredIds.sort(),
    replacement,
    transitions,
  };
}

function buildApp(db, defer) {
  const Document = docEntity();
  const region = annotatedTextOperation(Document, { fieldName: 'body' });
  const app = workbench({
    db,
    schema: raceSchema,
    entities: [Document],
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      operations: [region],
      handler: async ({ payload }) => {
        void payload;
        if (defer) await defer();
        const descriptor = currentDescriptor(db, { from: 0, to: 5, replacement: 'hallo', transitions: [] });
        return {
          events: [],
          annotatedText: [region.region(descriptor)],
          applicationTransition: { before: null, after: { correctionId: 'c-1' } },
        };
      },
    }],
  });
  return { app, region, Document };
}

async function nativeEditRequest(db, Document, principal) {
  const row = db.prepare("SELECT * FROM RaceDoc WHERE id = 'doc-1'").get();
  const binding = await withAuthoringBinding({
    db, entity: Document, Document, row, principal,
    fieldName: 'body', descriptor: Document.fields.body,
  });
  return {
    actionId: 'native-race', type: 'RaceDoc.body.operation', scope: 'Project:p1',
    principal,
    payload: {
      version: 9,
      id: 'doc-1',
      authoring: authoringBinding(binding.streamToken, binding.leaseToken, 'm-native'),
      edit: { kind: 'text.insert', at: { positionToken: binding.documentPositionToken, offset: 5, affinity: 'right' }, text: '!' },
    },
  };
}

test('composed dispatch blocked mid-coordinator: native edit waits, then native-first leaves compound stale', async (t) => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sawEntry = {};
  const { app, Document } = buildApp(db, async () => {
    sawEntry.compoundEntered = true;
    await gate;
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });

  const principal = { type: 'user', id: 'u1' };
  const native = await nativeEditRequest(db, Document, principal);

  // Start the composed dispatch; it acquires the coordinator and blocks in-tsn.
  const composed = app.dispatch({
    actionId: 'composed-race', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal,
  });
  // Wait until the composed handler has entered the coordinator transaction.
  await new Promise((resolve) => {
    const poll = () => (sawEntry.compoundEntered ? resolve() : setTimeout(poll, 1));
    poll();
  });
  assert.equal(sawEntry.compoundEntered, true);

  // The native dispatch must NOT resolve while the composed txn is open.
  let nativeSettled = false;
  const nativePromise = app.dispatch(native).then((result) => { nativeSettled = true; return result; });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(nativeSettled, false, 'native edit leaked past the coordinator while the composed txn was open');

  // Release the composed txn; then the native edit runs on the committed
  // basis. Its authoring position frame was issued against the ORIGINAL text,
  // so the frontier changed and it must fail stale (position-stale) — the
  // compound-first/native-stale outcome.
  release();
  const composedResult = await composed;
  assert.equal(composedResult.ok, true, composedResult.failure?.message);
  assert.equal(materializeText(liveFamily(db)), 'hallo world');
  const nativeResult = await nativePromise;
  assert.equal(nativeSettled, true, 'native edit must run after the coordinator released');
  assert.equal(nativeResult.ok, false, 'native edit must fail stale against the advanced basis');
  assert.match(String(nativeResult.failure?.message), /stale|basis/i);
  assert.equal(materializeText(liveFamily(db)), 'hallo world', 'the native edit wrote nothing');
});

test('native edit blocked mid-coordinator: composed waits, then native commits and compound fails stale', async (t) => {
  const db = new DatabaseSync(':memory:');
  sharedDb = db;
  installSchema(db);
  let releaseNative;
  let nativeEntered;
  const nativeHasEntered = new Promise((resolve) => { nativeEntered = resolve; });
  const nativeGate = new Promise((resolve) => { releaseNative = resolve; });

  // The native authoring edit's in-transaction field admission (.can) blocks
  // ONLY inside the shared coordinator (db.isTransaction), so the reverse-order
  // race is genuinely concurrent: the native dispatch holds the coordinator
  // while the composed dispatch is issued and must WAIT on the same tail.
  const Document = docEntity(async () => {
    nativeEntered();
    await nativeGate;
  });
  const region = annotatedTextOperation(Document, { fieldName: 'body' });
  const staleDescriptor = currentDescriptor(db, { from: 0, to: 5, replacement: 'hallo', transitions: [] });

  // ONE app owns both dispatches (shared coordinator + shared app.db), exactly
  // like the composed-first case. The composed handler returns a descriptor
  // computed against the PRE-edit basis; if the coordinator ever let it plan
  // against the post-native basis it would silently commit, which is the bug
  // this race forbids.
  const app = workbench({
    db,
    schema: raceSchema,
    entities: [Document],
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      operations: [region],
      handler: () => ({
        events: [],
        annotatedText: [region.region(staleDescriptor)],
        applicationTransition: { before: null, after: { correctionId: 'c-1' } },
      }),
    }],
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });

  const principal = { type: 'user', id: 'u1' };
  const native = await nativeEditRequest(db, Document, principal);

  // Dispatch the native edit FIRST. It enters the coordinator, blocks inside
  // its in-txn field admission. The composed dispatch issued next must NOT
  // resolve while the native holds the coordinator.
  let nativeSettled = false;
  const nativePromise = app.dispatch(native).then((result) => { nativeSettled = true; return result; });
  await nativeHasEntered;
  assert.equal(nativeSettled, false, 'native edit settled before its in-txn gate released');

  let composedSettled = false;
  const composedPromise = app.dispatch({
    actionId: 'composed-race-reverse', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal,
  }).then((result) => { composedSettled = true; return result; });

  // Both dispatches share one coordinator: while the native holds it, the
  // composed dispatch cannot even enter, let alone plan.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(nativeSettled, false, 'native dispatch not yet released');
  assert.equal(composedSettled, false, 'composed dispatch escaped the shared coordinator while the native held it');

  // Release the native txn: native commits its insert FIRST; the composed
  // dispatch then enters the coordinator, replans the stale descriptor against
  // the committed basis and must fail stale — the native-first/compound-stale
  // outcome, zero composed writes.
  releaseNative();
  assert.equal((await nativePromise).ok, true, 'native edit must commit');
  assert.equal(materializeText(liveFamily(db)), 'hello! world');
  const composedResult = await composedPromise;
  assert.equal(composedSettled, true, 'composed dispatch ran after the coordinator released');
  assert.equal(composedResult.ok, false, 'composed edit must fail stale against the committed basis');
  assert.match(String(composedResult.failure?.message), /stale|digest|basis|affected/i);
  assert.equal(materializeText(liveFamily(db)), 'hello! world', 'the composed edit wrote nothing');
  sharedDb = null;
});

function _buildAppWithDescriptor(db, descriptor) {
  void db;
  void descriptor;
  throw new Error('buildAppWithDescriptor is superseded by the single-app reverse-order race');
}