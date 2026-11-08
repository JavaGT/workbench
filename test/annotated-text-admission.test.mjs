// Commit-time admission for annotated-text mutations (Workbench #273).
//
// A registered application guard must see the old and new stored image of
// every annotation changed by the committing transaction, and a refusal must
// leave no log row, annotation row, or receipt. The same structural seam covers
// generated operations, text edits that shift/empty annotations, history
// undo/redo, composed registered actions, and document retirement.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotationAction, annotatedText, annotation, durableHistory, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, read, ref, scope, text, write,
} from '../build/internal.mjs';
import { defineSqliteSchema } from '../build/server.mjs';
import { annotatedTextOperation } from '../build/annotated-text-region-operation.mjs';
import {
  materializeText, projectEndpointToOffset, resolveOffsetToEndpoint, restoreTextFamilySerialized, textFamilyBasis,
} from '../build/annotated-text-continuous.mjs';
import { attachAnnotationRange, loadAnnotationImages } from '../build/annotated-text-storage.mjs';
import { computeAffectedClosure, digestAffectedClosure } from '../build/annotated-text-region-reducer.mjs';
import { sha256Utf8 } from '../build/annotated-text-region-limits.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

const SCOPE = 'Project:p1';
const ALICE = { type: 'user', id: 'alice', attributes: {} };
const PREFIX = 'AdmissionDoc_body';

const schema = defineSqliteSchema({
  name: 'annotated-text-admission',
  tables: [],
  externalTables: [
    { name: 'Project', columns: ['id'] },
    { name: 'SpeakerProfile', columns: ['id'] },
  ],
});

function declaration() {
  const Project = entity('Project', {
    owner: ref('User'),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  const SpeakerProfile = entity('SpeakerProfile', {
    name: text(),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  const Document = entity('AdmissionDoc', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('speakers', { appliesTo: 'text-range', cardinality: 'one', fields: { speaker: ref('SpeakerProfile') }, empty: 'delete' }),
        annotation('notes', {
          appliesTo: 'text-range', cardinality: 'many', fields: { label: text() }, empty: 'delete',
          actions: { relabel: annotationAction({ change: () => ({ fields: { label: 'relabeled' } }) }) },
        }),
      ],
    }).can(() => grant(read, write)),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  return { Project, SpeakerProfile, Document };
}

function installSchema(db, { withSpeaker = true } = {}) {
  const { Project, SpeakerProfile, Document } = declaration();
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('alice')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'alice')");
  executeDDL(SpeakerProfile, db);
  if (withSpeaker) db.exec("INSERT INTO SpeakerProfile (id, name) VALUES ('sp1', 'Ada'), ('sp2', 'Grace')");
  executeDDL(Document, db);
  return { Project, SpeakerProfile, Document };
}

async function setup({ admit } = {}) {
  const db = new DatabaseSync(':memory:');
  const { Document } = installSchema(db);
  const changes = [];
  const state = { refuse: false };
  const app = workbench({
    db,
    schema,
    entities: [Document],
    history: durableHistory({ authorize: () => true, actions: {} }),
    annotatedTextAdmission: {
      families: ['speakers'],
      admit(change) {
        changes.push(change);
        if (state.refuse) return false;
        return admit ? admit(change) : true;
      },
    },
  });
  await app.start();
  const created = await app.dispatch({
    actionId: 'create', type: 'AdmissionDoc.create', principal: ALICE,
    payload: { id: 'd1', project: 'p1', owner: 'alice', body: { version: 1, blocks: [{ text: 'hello world' }] } },
  });
  assert.equal(created.ok, true, created.failure?.message);
  const document = app.entities.get('AdmissionDoc');
  const binding = () => {
    const row = db.prepare('SELECT * FROM AdmissionDoc WHERE id = ?').get('d1');
    return withAuthoringBinding({
      db, entity: document, Document: document, row,
      principal: ALICE, fieldName: 'body', descriptor: document.fields.body,
    });
  };
  const authoring = (bind, mutationId) => ({ version: 1, stream: bind.streamToken, lease: bind.leaseToken, mutationId });
  async function dispatchEdit(actionId, edit) {
    const bind = await binding();
    return app.dispatch({
      actionId, principal: ALICE, scope: SCOPE, type: 'AdmissionDoc.body.operation',
      payload: { version: 9, id: 'd1', authoring: authoring(bind, actionId), edit },
    });
  }
  // The position token is document-scoped but must be current.
  async function applySpeakerAt(actionId, annotationId, speaker, from, to) {
    const bind = await binding();
    return app.dispatch({
      actionId, principal: ALICE, scope: SCOPE, type: 'AdmissionDoc.body.operation',
      payload: {
        version: 9, id: 'd1', authoring: authoring(bind, actionId),
        edit: {
          kind: 'annotation.apply',
          annotation: { id: annotationId, family: 'speakers', fields: { speaker } },
          from: { positionToken: bind.documentPositionToken, offset: from, affinity: 'left' },
          to: { positionToken: bind.documentPositionToken, offset: to, affinity: 'right' },
        },
      },
    });
  }
  async function updateSpeaker(actionId, annotationId, speaker) {
    const bind = await binding();
    return app.dispatch({
      actionId, principal: ALICE, scope: SCOPE, type: 'AdmissionDoc.body.operation', history: { session: 'tab-a' },
      payload: {
        version: 9, id: 'd1', authoring: authoring(bind, actionId),
        edit: { kind: 'annotation.update', annotationId, fields: { speaker } },
      },
    });
  }
  async function deleteText(actionId, from, to) {
    const bind = await binding();
    return app.dispatch({
      actionId, principal: ALICE, scope: SCOPE, type: 'AdmissionDoc.body.operation',
      payload: {
        version: 9, id: 'd1', authoring: authoring(bind, actionId),
        edit: {
          kind: 'text.delete',
          from: { positionToken: bind.documentPositionToken, offset: from, affinity: 'left' },
          to: { positionToken: bind.documentPositionToken, offset: to, affinity: 'right' },
        },
      },
    });
  }
  return { db, app, changes, state, applySpeaker: applySpeakerAt, updateSpeaker, deleteText, dispatchEdit };
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

test('admission sees the old and new speakers image for apply, update, and emptying text edits', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const applied = await ctx.applySpeaker('a1', 's1', 'sp1', 0, 5);
  assert.equal(applied.ok, true, applied.failure?.message);
  let change = ctx.changes.at(-1);
  assert.equal(change.actionType, 'AdmissionDoc.body.operation');
  assert.equal(change.family, 'speakers');
  assert.equal(change.annotationId, 's1');
  assert.equal(change.before, null);
  assert.equal(change.after.fields.speaker, 'sp1');
  assert.equal(change.after.memberships.length, 1);
  assert.equal(change.documentId, 'd1');
  assert.equal(change.scope, SCOPE);

  const updated = await ctx.updateSpeaker('a2', 's1', 'sp2');
  assert.equal(updated.ok, true, updated.failure?.message);
  change = ctx.changes.at(-1);
  assert.equal(change.annotationId, 's1');
  assert.equal(change.before.fields.speaker, 'sp1');
  assert.equal(change.after.fields.speaker, 'sp2');

  // A text delete displaces the whole range: the speakers annotation is gone.
  const deleted = await ctx.deleteText('a3', 0, 11);
  assert.equal(deleted.ok, true, deleted.failure?.message);
  change = ctx.changes.at(-1);
  assert.equal(change.annotationId, 's1');
  assert.equal(change.before.fields.speaker, 'sp2');
  assert.equal(change.after, null);

  // Non-registered families never reach the hook.
  assert.equal(ctx.changes.every((entry) => entry.family === 'speakers'), true);
});

test('a refusal leaves no log row, annotation row, or receipt', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const seeded = await ctx.applySpeaker('seed', 's1', 'sp1', 0, 5);
  assert.equal(seeded.ok, true, seeded.failure?.message);
  const before = {
    log: count(ctx.db, '_Log'),
    receipts: count(ctx.db, '_ActionReceipt'),
    annotations: count(ctx.db, `${PREFIX}_annotation`),
  };

  ctx.state.refuse = true;
  const refused = await ctx.applySpeaker('refused', 's2', 'sp2', 6, 11);
  assert.equal(refused.ok, false);
  assert.equal(count(ctx.db, '_Log'), before.log);
  assert.equal(count(ctx.db, '_ActionReceipt'), before.receipts);
  assert.equal(count(ctx.db, `${PREFIX}_annotation`), before.annotations);
  assert.equal(ctx.db.prepare(`SELECT 1 FROM ${PREFIX}_annotation WHERE id = 's2'`).get(), undefined);
});

test('undo and redo reach the admission hook', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const applied = await ctx.applySpeaker('a1', 's1', 'sp1', 0, 5);
  assert.equal(applied.ok, true, applied.failure?.message);
  const updated = await ctx.updateSpeaker('a2', 's1', 'sp2');
  assert.equal(updated.ok, true, updated.failure?.message);
  const cursor = await ctx.app.history.cursor({ scope: SCOPE, principal: ALICE, session: 'tab-a' });
  const undo = await ctx.app.history.undo({
    scope: SCOPE, principal: ALICE, session: 'tab-a', actionId: 'undo-1', revision: cursor.revision,
  });
  assert.equal(undo.ok, true, undo.failure?.message);
  let change = ctx.changes.at(-1);
  assert.equal(change.before.fields.speaker, 'sp2');
  assert.equal(change.after.fields.speaker, 'sp1');

  const redoCursor = await ctx.app.history.cursor({ scope: SCOPE, principal: ALICE, session: 'tab-a' });
  const redo = await ctx.app.history.redo({
    scope: SCOPE, principal: ALICE, session: 'tab-a', actionId: 'redo-1', revision: redoCursor.revision,
  });
  assert.equal(redo.ok, true, redo.failure?.message);
  change = ctx.changes.at(-1);
  assert.equal(change.before.fields.speaker, 'sp1');
  assert.equal(change.after.fields.speaker, 'sp2');
});

test('document removal reaches the admission hook with the pre-removal image', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const applied = await ctx.applySpeaker('a1', 's1', 'sp1', 0, 5);
  assert.equal(applied.ok, true, applied.failure?.message);
  const removed = await ctx.app.dispatch({
    actionId: 'remove-doc', type: 'AdmissionDoc.remove', principal: ALICE,
    payload: { id: 'd1' },
  });
  assert.equal(removed.ok, true, removed.failure?.message);
  const change = ctx.changes.at(-1);
  assert.equal(change.family, 'speakers');
  assert.equal(change.annotationId, 's1');
  assert.equal(change.before.fields.speaker, 'sp1');
  assert.equal(change.after, null);
});

// ---- Composed registered action ------------------------------------------

function regionDescriptor(db) {
  const family = restoreTextFamilySerialized(db.prepare(`SELECT family_checkpoint FROM ${PREFIX}_state WHERE document_id = 'd1'`).get().family_checkpoint);
  const images = loadAnnotationImages(db, {
    prefix: PREFIX, documentId: 'd1',
    declarations: [{ annotationName: 'speakers', fields: { speaker: { type: 'ref', target: 'SpeakerProfile' } } }, { annotationName: 'notes', fields: { label: { type: 'text' } } }],
  }).map((image) => ({
    id: image.id, family: image.family, fields: image.fields,
    protectedTargetIds: image.protectedTargetIds, memberships: image.memberships,
    prerequisites: image.prerequisites, empty: 'delete', cardinality: image.family === 'speakers' ? 'one' : 'many',
  }));
  const closure = computeAffectedClosure({ annotations: images, family, from: 0, to: 5, namedIds: [] });
  const covered = [];
  for (const image of closure) {
    for (const entry of image.memberships) {
      const start = projectEndpointToOffset(family, entry.start);
      const end = projectEndpointToOffset(family, entry.end);
      if (Math.min(end, 5) - Math.max(start, 0) > 0) { covered.push(image.id); break; }
    }
  }
  return {
    version: 10, kind: 'region.edit', id: 'd1', basis: textFamilyBasis(family),
    from: 0, to: 5,
    coveredTextDigest: sha256Utf8(materializeText(family).slice(0, 5)),
    affectedClosureDigest: digestAffectedClosure(closure),
    expectedCoveredAnnotationIds: covered.sort(),
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'n1', ranges: [{ start: 0, end: 5 }] }],
  };
}

test('a composed registered action reaches the admission hook', async () => {
  const db = new DatabaseSync(':memory:');
  const { Document } = installSchema(db);
  const changes = [];
  const region = annotatedTextOperation(Document, { fieldName: 'body' });
  const app = workbench({
    db, schema, entities: [Document],
    history: durableHistory({ authorize: () => true, actions: {} }),
    annotatedTextAdmission: {
      families: ['notes'],
      admit(change) { changes.push(change); return true; },
    },
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      history: { cursor: 'eligible' },
      operations: [region],
      handler: ({ payload }) => ({
        events: [{ type: 'correction.recorded', scope: SCOPE, data: { id: payload.actionRef } }],
        annotatedText: [region.region(regionDescriptor(db))],
        applicationTransition: { before: null, after: { correctionId: payload.actionRef } },
      }),
    }],
  });
  await app.start();
  const created = await app.dispatch({
    actionId: 'create', type: 'AdmissionDoc.create', principal: ALICE,
    payload: { id: 'd1', project: 'p1', owner: 'alice', body: { version: 1, blocks: [{ text: 'hello world' }] } },
  });
  assert.equal(created.ok, true, created.failure?.message);
  // Seed one speakers annotation through storage so the region edit's
  // transition names a real image (the generated path is covered above).
  const family = restoreTextFamilySerialized(db.prepare(`SELECT family_checkpoint FROM ${PREFIX}_state WHERE document_id = 'd1'`).get().family_checkpoint);
  db.prepare(`INSERT INTO ${PREFIX}_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)`).run('n1', 'd1', 'p1', 'alice', 'notes');
  db.prepare(`INSERT INTO ${PREFIX}_annotation_notes (annotation_id, label) VALUES (?, ?)`).run('n1', 'seed');
  attachAnnotationRange(db, PREFIX, 'd1', 'n1',
    resolveOffsetToEndpoint(family, 0, family.checkpoint.frontier, 'left'),
    resolveOffsetToEndpoint(family, 5, family.checkpoint.frontier, 'right'), 0);
  const applied = await app.dispatch({
    actionId: 'composed', type: 'correction.apply', scope: SCOPE, principal: ALICE,
    payload: { id: 'd1', actionRef: 'composed' }, clientId: 'tab-a', history: { session: 'tab-a' },
  });
  assert.equal(applied.ok, true, applied.failure?.message);
  assert.equal(changes.length > 0, true);
  assert.equal(changes.every((change) => change.actionType === 'correction.apply'), true);
  await app.shutdown();
  db.close();
});

test('annotated action census names every action type that reaches the hook', async () => {
  const db = new DatabaseSync(':memory:');
  const { Document } = installSchema(db);
  const app = workbench({
    db, schema, entities: [Document],
    history: durableHistory({ authorize: () => true, actions: {} }),
    annotatedTextAdmission: { families: ['speakers'], admit: () => true },
  });
  await app.start();
  const { annotatedTextActionCensus } = await import('../build/annotated-text-admission.mjs');
  assert.deepEqual(
    annotatedTextActionCensus({ entities: app.entities, actions: app.actions }),
    ['AdmissionDoc.body.compensate', 'AdmissionDoc.body.notes.relabel', 'AdmissionDoc.body.operation'],
  );
  await app.shutdown();
  db.close();
});
