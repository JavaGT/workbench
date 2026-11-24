// W2 production-path compound private-fact commit (scope#992 rev 4).
// Every case dispatches through the real application server and
// pipeline.ts:commitEvents — never through the canonicalizer/parsers directly
// as the assertion path. Proves: one receipt/fact/cursor frame/operated event/
// domain event per composed dispatch, envelope storage round-trip, dependency
// indexing, application-view projection unwrapping, exact retry dedupe +
// changed-payload conflict, undeclared-ops fail closed, and zero-write
// inventories on rejection.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, durableHistory, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, read, ref, scope, text as _text, write,
} from '../build/internal.mjs';
import { readCommittedCursor, defineSqliteSchema } from '../build/server.mjs';
import {
  importTextToFamily,
  materializeText,
  projectEndpointToOffset,
  resolveOffsetToEndpoint,
  restoreTextFamilySerialized,
  serializeCompactTextFamilyCheckpoint,
  textFamilyBasis,
} from '../build/annotated-text-continuous.mjs';
import { readAnnotatedTextFamilyCheckpoint } from '../build/annotated-text-authoring-stream.mjs';
import { attachAnnotationRange, loadAnnotationImages } from '../build/annotated-text-storage.mjs';
import {
  computeAffectedClosure,
  digestAffectedClosure,
} from '../build/annotated-text-region-reducer.mjs';
import { annotatedTextOperation } from '../build/annotated-text-region-operation.mjs';
import { annotatedTextHistorySession as _annotatedTextHistorySession } from '../build/annotated-text-field.mjs';
import { sha256Utf8 } from '../build/annotated-text-region-limits.mjs';

const ACTOR = 'a'.repeat(32);

const compoundSchema = defineSqliteSchema({
  name: 'compound-private-fact',
  tables: [],
  externalTables: [
    { name: 'CorrectionLedger', columns: ['id', 'content'] },
    { name: 'Project', columns: ['id'] },
  ],
});

function declaredEntity() {
  return entity('Transcript', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('note', { fields: {} }),
      ],
    }).can(() => grant(read, write)),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

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
  executeDDL(declaredEntity(), db);
  // Every boot now validates the settled census: the schema declares this
  // out-of-band ledger, so create it here for every case (the helper is
  // idempotent, so cases that seed it explicitly stay valid).
  installCorrectionLedger(db);
}

function membershipOf(family, start, end) {
  return {
    ordinal: 0,
    start: resolveOffsetToEndpoint(family, start, family.checkpoint.frontier, 'left'),
    end: resolveOffsetToEndpoint(family, end, family.checkpoint.frontier, 'right'),
  };
}

function seedDocument(db, { text, annotations = [] }) {
  const family = importTextToFamily('doc-1', ACTOR, text);
  db.exec("INSERT INTO Transcript (id, project, owner) VALUES ('doc-1', 'p1', 'u1')");
  db.prepare('INSERT INTO Transcript_body_state (document_id, structure_version, family_checkpoint) VALUES (?, ?, ?)')
    .run('doc-1', 1, serializeCompactTextFamilyCheckpoint(family));
  for (const image of annotations) {
    db.prepare('INSERT INTO Transcript_body_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)')
      .run(image.id, 'doc-1', 'p1', 'u1', image.family);
    const fieldNames = Object.keys(image.fields);
    if (fieldNames.length) {
      db.prepare(`INSERT INTO Transcript_body_annotation_${image.family} (annotation_id, ${fieldNames.join(', ')}) VALUES (?, ${fieldNames.map(() => '?').join(', ')})`)
        .run(image.id, ...fieldNames.map((name) => image.fields[name]));
    }
    for (const entry of image.memberships) {
      attachAnnotationRange(db, 'Transcript_body', 'doc-1', image.id, entry.start, entry.end, entry.ordinal);
    }
  }
  return family;
}

function liveFamily(db) {
  return restoreTextFamilySerialized(readAnnotatedTextFamilyCheckpoint(db, 'Transcript_body', 'doc-1'));
}

// Build a region.edit descriptor against the current live DB state.
function currentDescriptor(db, { from, to, replacement, transitions = [], id = 'doc-1' }) {
  const family = liveFamily(db);
  const baseImages = loadAnnotationImages(db, {
    prefix: 'Transcript_body',
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
  const namedIds = transitions.map((transition) => (
    transition.kind === 'create' ? transition.annotation.id : transition.annotationId
  ));
  const closure = computeAffectedClosure({ annotations: regionImages, family, from, to, namedIds });
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
    id,
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

const ZERO_WRITE_TABLES = [
  '_PrivateActionFact',
  '_PrivateActionFactDependency',
  '_Log',
  '_ActionReceipt',
  '_HistoryCursor',
  '_PostCommitEffect',
  'Transcript',
  'Transcript_body_state',
  'Transcript_body_annotation',
  'Transcript_body_membership',
  'Transcript_body_range',
  'CorrectionLedger',
];

function tableCounts(db) {
  return Object.fromEntries(ZERO_WRITE_TABLES.map((table) => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
}

function assertNoNewWrites(db, baseline) {
  const after = tableCounts(db);
  for (const table of ZERO_WRITE_TABLES) {
    assert.equal(after[table], baseline[table], `expected no new writes in ${table}`);
  }
}

function makeRegionHandle() {
  const transcript = declaredEntity();
  return annotatedTextOperation(transcript, { fieldName: 'body' });
}

function _composedAppFactory(_db) {
  const region = makeRegionHandle();
  const actions = [{
    type: 'correction.apply',
    authorize: () => true,
    operations: [region],
    handler: null,
  }];
  return { region, actions };
}

test('one composed dispatch commits one receipt, fact, and operated event atomically', async () => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  installCorrectionLedger(db);
  db.exec("INSERT INTO CorrectionLedger (id, content) VALUES ('correction-1', 'kept')");
  const seedFamily = importTextToFamily('doc-1', ACTOR, 'hello world');
  seedDocument(db, {
    text: 'hello world',
    annotations: [{ id: 'note-1', family: 'note', fields: {}, memberships: [membershipOf(seedFamily, 0, 5)] }],
  });
  const transcript = declaredEntity();
  const region = annotatedTextOperation(transcript, { fieldName: 'body' });
  const app = workbench({
    db,
    schema: compoundSchema,
    entities: [declaredEntity()],
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      operations: [region],
      handler: ({ payload }) => {
        void payload;
        const descriptor = currentDescriptor(db, {
          from: 0, to: 5, replacement: 'hallo',
          transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
        });
        return {
          events: [{ type: 'correction.recorded', scope: 'Project:p1', data: { id: 'correction-1', applied: true } }],
          annotatedText: [region.region(descriptor)],
          applicationTransition: { before: null, after: { correctionId: 'correction-1' } },
        };
      },
    }],
  });
  await app.start();

  const result = await app.dispatch({
    actionId: 'composed-1', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal: { type: 'user', id: 'u1', attributes: {} },
  });
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal(result.events.length, 2, 'exactly one operated event plus one domain event');
  const types = result.events.map((event) => event.type).sort();
  assert.deepEqual(types, ['Transcript.body.operated', 'correction.recorded']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _PrivateActionFact').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 2);
  // No history session on this dispatch: no cursor row and no history frame
  // are created — the composed dispatch alone is not a history entry.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _HistoryCursor').get().count, 0);
  assert.equal(readCommittedCursor(db, 'Project:p1'), 2);
  const stored = JSON.parse(db.prepare('SELECT fact FROM _PrivateActionFact').get().fact);
  assert.equal(stored.kind, 'workbench.compound-origin');
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.application, { before: null, after: { correctionId: 'correction-1' } });
  assert.equal(stored.contributions.length, 1, 'a text replacement carries its delete contribution');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Transcript_body_annotation').get().count, 1, 'range.set preserves the annotation row');
  assert.equal(materializeText(liveFamily(db)), 'hallo world');
  // Delete contribution dependency rows: the document itself.
  const deps = db.prepare('SELECT entity, entityId FROM _PrivateActionFactDependency').all();
  assert.equal(JSON.stringify(deps), JSON.stringify([{ entity: 'document', entityId: 'doc-1' }]));
  db.close();
});

test('exact retry dedupes; changed payload conflicts with zero new writes', async () => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  seedDocument(db, { text: 'hello world', annotations: [] });
  const region = makeRegionHandle();
  const app = workbench({
    db,
    schema: compoundSchema,
    entities: [declaredEntity()],
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      operations: [region],
      handler: ({ payload }) => {
        const regionPayload = payload.region
          || currentDescriptor(db, { from: 0, to: 5, replacement: 'hallo', transitions: [] });
        return {
          events: [{ type: 'correction.recorded', scope: 'Project:p1', data: { id: 'correction-1' } }],
          annotatedText: [region.region(regionPayload)],
          applicationTransition: { before: null, after: { correctionId: 'correction-1' } },
        };
      },
    }],
  });
  await app.start();

  const first = {
    actionId: 'composed-retry', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal: { type: 'user', id: 'u1', attributes: {} },
  };
  const r1 = await app.dispatch(first);
  assert.equal(r1.ok, true);
  const r2 = await app.dispatch(first);
  assert.equal(r2.ok, true);
  assert.equal(r2.deduped, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 2);

  const factCount = db.prepare('SELECT COUNT(*) AS count FROM _PrivateActionFact').get().count;
  const changed = await app.dispatch({
    ...first,
    payload: {
      id: 'doc-1',
      region: currentDescriptor(db, { from: 6, to: 11, replacement: 'world!', transitions: [] }),
    },
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.failure.category, 'conflict');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _PrivateActionFact').get().count, factCount);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 2);
  db.close();
});

test('same payload with reordered object keys dedupes as one receipt', async () => {
  // The receipt stores the canonical payload and the dedupe matcher compares
  // with the SAME canonical serializer: a retry whose object keys are inserted
  // in a different order is JSON-equivalent and must dedupe, not conflict.
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  seedDocument(db, { text: 'hello world', annotations: [] });
  const region = makeRegionHandle();
  const app = workbench({
    db,
    schema: compoundSchema,
    entities: [declaredEntity()],
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      operations: [region],
      handler: ({ payload }) => {
        // Rebuild the region descriptor from live state so a reordered-key
        // retry still plans against current state (the payload itself is the
        // dedupe subject).
        void payload;
        const descriptor = currentDescriptor(db, { from: 0, to: 5, replacement: 'hallo', transitions: [] });
        return {
          events: [{ type: 'correction.recorded', scope: 'Project:p1', data: { id: 'correction-1' } }],
          annotatedText: [region.region(descriptor)],
          applicationTransition: { before: null, after: { correctionId: 'correction-1' } },
        };
      },
    }],
  });
  await app.start();

  const first = {
    actionId: 'composed-key-order', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1', meta: { z: 1, a: { q: 2, b: 3 } } },
    principal: { type: 'user', id: 'u1', attributes: {} },
  };
  const r1 = await app.dispatch(first);
  assert.equal(r1.ok, true, r1.failure?.message);
  // Reordered insertion order at every level, same JSON content: must be the
  // SAME receipt.
  const reordered = {
    actionId: 'composed-key-order', type: 'correction.apply', scope: 'Project:p1',
    payload: { meta: { a: { b: 3, q: 2 }, z: 1 }, id: 'doc-1' },
    principal: { type: 'user', id: 'u1', attributes: {} },
  };
  const r2 = await app.dispatch(reordered);
  assert.equal(r2.ok, true, r2.failure?.message);
  assert.equal(r2.deduped, true, 'reordered-key retry must dedupe, not conflict');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 2);

  // Genuinely different content is still a conflict.
  const changed = await app.dispatch({
    ...reordered,
    payload: { meta: { a: { b: 3, q: 2 }, z: 2 }, id: 'doc-1' },
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.failure.category, 'conflict');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 1);
  db.close();
});

test('undeclared operations fail closed at app assembly', async () => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const app = workbench({
    db,
    schema: compoundSchema,
    entities: [declaredEntity()],
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      operations: [{ __brand: 'not-an-annotatedTextOperation' }],
      handler: () => ({ events: [], annotatedText: [], applicationTransition: { before: null, after: { x: 1 } } }),
    }],
  });
  await assert.rejects(app.start(), /annotatedTextOperation handles/);
  db.close();
});

test('foreign-field annotated operation is rejected inside the transaction', async () => {
  // The declared operation binds one entity/field handle. A handler returning
  // a descriptor bound to a DIFFERENT handle's region grammar must fail closed
  // inside admitAndPlan — the descriptor's document id does not match the
  // declared entity's document, so the planner rejects before any write.
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  installCorrectionLedger(db);
  seedDocument(db, { text: 'hello world', annotations: [] });
  const region = makeRegionHandle();
  const app = workbench({
    db,
    schema: compoundSchema,
    entities: [declaredEntity()],
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      operations: [region],
      handler: () => {
        // A descriptor naming a document that is not a row of the DECLARED
        // entity (it lives in a foreign entity's table) must fail closed inside
        // admitAndPlan: the planner reads the declared entity's row and rejects
        // before any write — no ambient foreign-field authority.
        const descriptor = currentDescriptor(db, { from: 0, to: 5, replacement: 'hallo', transitions: [], id: 'foreign-doc-9' });
        return {
          events: [],
          annotatedText: [region.region(descriptor)],
          applicationTransition: { before: null, after: { x: 1 } },
        };
      },
    }],
  });
  await app.start();
  const baseline = tableCounts(db);
  const result = await app.dispatch({
    actionId: 'composed-foreign', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal: { type: 'user', id: 'u1', attributes: {} },
  });
  assert.equal(result.ok, false, result.failure?.message);
  assertNoNewWrites(db, baseline);
  db.close();
});

test('composed dispatch payload carrying a Date rejects with zero writes', async () => {
  // canonicalStringify fails closed on non-plain values: a Date in the request
  // payload must never become a receipt identity (two different Dates would
  // otherwise collapse to one receipt). The constructed Date reaches receipt
  // storage, the canonicalizer throws before the _PrivateActionFact insert,
  // and the whole txn rolls back.
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  installCorrectionLedger(db);
  seedDocument(db, { text: 'hello world', annotations: [] });
  const region = makeRegionHandle();
  const app = workbench({
    db,
    schema: compoundSchema,
    entities: [declaredEntity()],
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      operations: [region],
      handler: ({ payload }) => {
        void payload;
        const descriptor = currentDescriptor(db, { from: 0, to: 5, replacement: 'hallo', transitions: [] });
        return {
          events: [{ type: 'correction.recorded', scope: 'Project:p1', data: { id: 'correction-1' } }],
          annotatedText: [region.region(descriptor)],
          applicationTransition: { before: null, after: { correctionId: 'correction-1' } },
        };
      },
    }],
  });
  await app.start();
  const baseline = tableCounts(db);
  const result = await app.dispatch({
    actionId: 'composed-date-payload', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1', stampedAt: new Date('2026-08-25T00:00:00Z') },
    principal: { type: 'user', id: 'u1', attributes: {} },
  });
  assert.equal(result.ok, false, 'a Date payload must fail closed');
  // The canonicalizer's typed rejection surfaces as invalid-input (it extends
  // ValidationError) with the offending path named.
  assert.equal(result.failure.category, 'invalid-input');
  assert.match(result.failure.message, /canonical JSON value at .*stampedAt.*is a Date/);
  assertNoNewWrites(db, baseline);
  db.close();
});

test('composed dispatch payload with a null-prototype object rejects with zero writes', async () => {
  // A null-prototype object is not plain JSON; canonicalStringify must reject it
  // rather than emit identity-collapsing output.
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  installCorrectionLedger(db);
  seedDocument(db, { text: 'hello world', annotations: [] });
  const region = makeRegionHandle();
  const app = workbench({
    db,
    schema: compoundSchema,
    entities: [declaredEntity()],
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      operations: [region],
      handler: ({ payload }) => {
        void payload;
        const descriptor = currentDescriptor(db, { from: 0, to: 5, replacement: 'hallo', transitions: [] });
        return {
          events: [{ type: 'correction.recorded', scope: 'Project:p1', data: { id: 'correction-1' } }],
          annotatedText: [region.region(descriptor)],
          applicationTransition: { before: null, after: { correctionId: 'correction-1' } },
        };
      },
    }],
  });
  await app.start();
  const baseline = tableCounts(db);
  const result = await app.dispatch({
    actionId: 'composed-null-proto-payload', type: 'correction.apply', scope: 'Project:p1',
    payload: Object.assign(Object.create(null), { id: 'doc-1' }),
    principal: { type: 'user', id: 'u1', attributes: {} },
  });
  assert.equal(result.ok, false, 'a null-prototype payload must fail closed');
  assert.equal(result.failure.category, 'invalid-input');
  assert.match(result.failure.message, /canonical JSON value at .*non-plain object/);
  assertNoNewWrites(db, baseline);
  db.close();
});

test('composed handler with a top-level privateFact fails closed with zero writes', async () => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  installCorrectionLedger(db);
  const region = makeRegionHandle();
  const app = workbench({
    db,
    schema: compoundSchema,
    entities: [declaredEntity()],
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      operations: [region],
      handler: () => ({
        events: [],
        annotatedText: [],
        applicationTransition: { before: null, after: { x: 1 } },
        privateFact: { before: null, after: { x: 1 } },
      }),
    }],
  });
  await app.start();
  const baseline = tableCounts(db);
  const result = await app.dispatch({
    actionId: 'composed-private', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal: { type: 'user', id: 'u1', attributes: {} },
  });
  assert.equal(result.ok, false);
  assertNoNewWrites(db, baseline);
  db.close();
});

function installCorrectionLedger(db) {
  db.exec('CREATE TABLE IF NOT EXISTS CorrectionLedger (id TEXT PRIMARY KEY, content TEXT)');
}

test('applied origin transition where before == after fails closed', async () => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  installCorrectionLedger(db);
  seedDocument(db, { text: 'hello world', annotations: [] });
  const region = makeRegionHandle();
  const app = workbench({
    db,
    schema: compoundSchema,
    entities: [declaredEntity()],
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      operations: [region],
      handler: () => {
        const descriptor = currentDescriptor(db, { from: 0, to: 5, replacement: 'hallo', transitions: [] });
        return {
          events: [],
          annotatedText: [region.region(descriptor)],
          applicationTransition: { before: { x: 1 }, after: { x: 1 } },
        };
      },
    }],
  });
  await app.start();
  const baseline = tableCounts(db);
  const result = await app.dispatch({
    actionId: 'composed-degenerate', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal: { type: 'user', id: 'u1', attributes: {} },
  });
  assert.equal(result.ok, false);
  assert.match(result.failure.message, /must differ/);
  assertNoNewWrites(db, baseline);
  db.close();
});

test('no-text-change region commits an envelope with zero contributions', async () => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  installCorrectionLedger(db);
  seedDocument(db, { text: 'hello world', annotations: [] });
  const region = makeRegionHandle();
  const app = workbench({
    db,
    schema: compoundSchema,
    entities: [declaredEntity()],
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      operations: [region],
      handler: () => {
        const descriptor = currentDescriptor(db, { from: 0, to: 5, replacement: 'hello', transitions: [] });
        return {
          events: [{ type: 'correction.recorded', scope: 'Project:p1', data: { id: 'correction-1' } }],
          annotatedText: [region.region(descriptor)],
          applicationTransition: { before: null, after: { x: 1 } },
        };
      },
    }],
  });
  await app.start();
  const result = await app.dispatch({
    actionId: 'composed-noop-text', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal: { type: 'user', id: 'u1', attributes: {} },
  });
  assert.equal(result.ok, true, result.failure?.message);
  // A no-text-change region still emits one operated event (W1 law) plus the
  // handler's domain event.
  assert.equal(result.events.length, 2);
  const stored = JSON.parse(db.prepare('SELECT fact FROM _PrivateActionFact').get().fact);
  assert.equal(stored.kind, 'workbench.compound-origin');
  assert.equal(stored.contributions.length, 0, 'a no-text-change region contributes nothing');
  db.close();
});

test('composed dispatch with history session writes exactly one cursor frame', async () => {
  // The duration of a composed dispatch in a document-local history session:
  // the _HistoryCursor row holds exactly ONE past frame for the composed
  // receipt, and the composed action is the single entry (root == head). This
  // is the receipt-integrity inventory's cursor side.
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  installCorrectionLedger(db);
  seedDocument(db, { text: 'hello world', annotations: [] });
  const region = makeRegionHandle();
  const app = workbench({
    db,
    schema: compoundSchema,
    entities: [declaredEntity()],
    history: durableHistory({ authorize: () => true, actions: {} }),
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      history: { cursor: 'eligible' },
      operations: [region],
      handler: ({ payload }) => {
        void payload;
        return {
          events: [{ type: 'correction.recorded', scope: 'Project:p1', data: { id: 'correction-1' } }],
          annotatedText: [region.region(currentDescriptor(db, { from: 0, to: 5, replacement: 'hallo', transitions: [] }))],
          applicationTransition: { before: null, after: { correctionId: 'correction-1' } },
        };
      },
    }],
  });
  await app.start();
  const result = await app.dispatch({
    actionId: 'composed-cursor-frame', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal: { type: 'user', id: 'u1', attributes: {} },
    clientId: 'session-1', history: { session: 'session-1' },
  });
  assert.equal(result.ok, true, result.failure?.message);
  // Exactly one receipt + one cursor row + one past frame pointing at itself.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 1);
  const cursorRows = db.prepare('SELECT * FROM _HistoryCursor').all();
  assert.equal(cursorRows.length, 1, 'exactly one cursor row for the composed session');
  const past = JSON.parse(cursorRows[0].past);
  assert.equal(past.length, 1, 'exactly one past frame for the composed receipt');
  assert.equal(past[0].rootActionId, 'composed-cursor-frame');
  assert.equal(past[0].headActionId, 'composed-cursor-frame');
  assert.equal(JSON.parse(cursorRows[0].future).length, 0);

  const cursor = await app.history.cursor({ scope: 'Project:p1', principal: { type: 'user', id: 'u1', attributes: {} }, session: 'session-1' });
  assert.equal(cursor.undo, 1);
  assert.equal(cursor.redo, 0);
  db.close();
});

