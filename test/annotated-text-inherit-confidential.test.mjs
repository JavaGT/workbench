import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, entity, everyone as _everyone, executeDDL, executeFrameworkDDL,
  protectingAnnotation, grant, admin, read, write, subscribe, ref, scope as _scope, map,
  inherit, text as _text,
} from '../build/internal.mjs';
import { membership } from '../build/index.mjs';
import { materializeText, restoreTextFamily, importTextToFamily, textFamilyCheckpoint, resolveOffsetToEndpoint } from '../build/annotated-text-continuous.mjs';
import { projectAnnotatedTextSnapshot } from '../build/internal.mjs';
import { durableHistory } from '../build/internal.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';
import { attachAnnotationRange } from '../build/annotated-text-storage.mjs';

// #29 recipient projection, Scope shape: an inherit-child transcript whose
// confidentiality access resolves `is.owner()` through the PARENT Project's
// membership plane (Project_members role 'owner'). Owner recipients see the
// real text; everyone else sees the inline placeholder. Re-evaluated per
// recipient after edits and undo — the raw text never leaks.

const ACTOR = 'a'.repeat(32);

const confidentialityAccess = async ({ is }) => (await is.owner()) ? grant(read) : grant();

function declarations() {
  const Project = entity('Project', {
    members: map(ref('User'), { role: ['viewer', 'editor', 'owner'], default: {} }),
  });
  membership(Project, {
    viewer: { can: [read, subscribe], field: { role: 'viewer' } },
    editor: { can: [read, write, subscribe], field: { role: 'editor' } },
    owner: { can: [read, write, subscribe, admin], field: { role: 'owner' } },
  });
  const SecretDoc = entity('SecretDoc', {
    project: ref('Project'),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('sensitive', { empty: 'delete' }),
        protectingAnnotation('confidential', { protects: 'sensitive', placeholder: '[Confidential]', access: confidentialityAccess }),
      ],
    }),
    owner: ref('User'),
    grant: inherit(Project, { via: 'project' }),
  });
  return { Project, SecretDoc };
}

// Same shape as declarations(), but the confidentiality access body THROWS.
// A throwing access evaluation is a server-side fault: it must fail THIS span
// closed (inline placeholder) — never abort the whole document snapshot, and
// never disclose the protected text to any recipient.
function throwingAccessDeclarations() {
  const Project = entity('Project', {
    members: map(ref('User'), { role: ['viewer', 'editor', 'owner'], default: {} }),
  });
  membership(Project, {
    viewer: { can: [read, subscribe], field: { role: 'viewer' } },
    editor: { can: [read, write, subscribe], field: { role: 'editor' } },
    owner: { can: [read, write, subscribe, admin], field: { role: 'owner' } },
  });
  const SecretDoc = entity('SecretDoc', {
    project: ref('Project'),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('sensitive', { empty: 'delete' }),
        protectingAnnotation('confidential', {
          protects: 'sensitive',
          placeholder: '[Confidential]',
          access: async () => { throw new Error('sensitive-marker'); },
        }),
      ],
    }),
    owner: ref('User'),
    grant: inherit(Project, { via: 'project' }),
  });
  return { Project, SecretDoc };
}

async function setup(make = declarations, appOptions = {}) {
  const db = new DatabaseSync(':memory:');
  const { Project, SecretDoc } = make();
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('owner'), ('editor'), ('stranger')");
  executeDDL(Project, db);
  db.prepare("INSERT INTO Project (id) VALUES ('p1')").run();
  db.prepare("INSERT INTO Project_members (Project_id, member_id, role) VALUES ('p1', 'owner', 'owner')").run();
  db.prepare("INSERT INTO Project_members (Project_id, member_id, role) VALUES ('p1', 'editor', 'editor')").run();
  executeDDL(SecretDoc, db);
  const app = workbench({
    db,
    entities: [Project, SecretDoc],
    history: durableHistory({ authorize: () => true, actions: {} }),
    ...appOptions,
  });
  await app.start();
  await app.ready;
  return { app, db, Project, SecretDoc, SecretDocBound: app.entities.get('SecretDoc'), ProjectBound: app.entities.get('Project'), scope: 'Project:p1' };
}

function seedDocument(db, Doc, text, annotations = []) {
  db.prepare("INSERT INTO SecretDoc (id, project, owner) VALUES ('d1', 'p1', 'owner')").run();
  const family = importTextToFamily('d1', ACTOR, text);
  db.prepare('INSERT INTO SecretDoc_body_state (document_id, structure_version, family_checkpoint) VALUES (?, 1, ?)').run('d1', JSON.stringify(textFamilyCheckpoint(family)));
  for (const annotation of annotations) {
    db.prepare('INSERT INTO SecretDoc_body_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)')
      .run(annotation.id, 'd1', 'p1', 'owner', annotation.family);
    const start = resolveOffsetToEndpoint(family, annotation.start, family.checkpoint.frontier, 'right');
    const end = resolveOffsetToEndpoint(family, annotation.end, family.checkpoint.frontier, 'right');
    attachAnnotationRange(db, 'SecretDoc_body', 'd1', annotation.id, start, end, 0);
    if (annotation.protectedTargetIds) {
      for (const target of annotation.protectedTargetIds) {
        db.prepare('INSERT INTO SecretDoc_body_annotation_protected_target (annotation_id, target_annotation_id) VALUES (?, ?)').run(annotation.id, target);
      }
    }
  }
  return family;
}

async function recipientSnapshot(ctx, principalId) {
  const { db, SecretDocBound } = ctx;
  const row = db.prepare('SELECT * FROM SecretDoc WHERE id = ?').get('d1');
  return projectAnnotatedTextSnapshot({
    db, entity: SecretDocBound, row, principal: { type: 'user', id: principalId, attributes: {} },
    fieldName: 'body', descriptor: SecretDocBound.fields.body,
  });
}

test('recipient projection: project owner sees real text, editor and stranger see the placeholder', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  seedDocument(ctx.db, ctx.SecretDoc, 'open secret tail', [
    { id: 's1', family: 'sensitive', start: 5, end: 11 },
    { id: 'c1', family: 'confidential', start: 5, end: 11, protectedTargetIds: ['s1'] },
  ]);

  const ownerView = await recipientSnapshot(ctx, 'owner');
  assert.equal(ownerView.kind, 'workbench.annotatedText.recipient');
  assert.equal(ownerView.text, 'open secret tail');
  assert.equal(Object.hasOwn(ownerView, 'redactions'), false);

  const editorView = await recipientSnapshot(ctx, 'editor');
  assert.equal(editorView.kind, 'workbench.annotatedText.recipient');
  assert.equal(editorView.text, 'open  tail');
  assert.deepEqual(editorView.redactions, [{ start: 5, end: 5, placeholder: '[Confidential]' }]);
  assert.equal(JSON.stringify(editorView).includes('secret'), false);

  const strangerView = await recipientSnapshot(ctx, 'stranger');
  assert.equal(strangerView.kind, 'workbench.annotatedText.recipient');
  assert.equal(strangerView.text, 'open  tail');
  assert.deepEqual(strangerView.redactions, [{ start: 5, end: 5, placeholder: '[Confidential]' }]);
  assert.equal(JSON.stringify(strangerView).includes('secret'), false);
});

async function dispatchTextInsert(ctx, actionId, principalId, session, offset, textValue) {
  const row = ctx.db.prepare('SELECT * FROM SecretDoc WHERE id = ?').get('d1');
  const binding = await withAuthoringBinding({
    db: ctx.db, entity: ctx.SecretDocBound, Document: ctx.SecretDocBound, row,
    principal: { id: principalId }, fieldName: 'body', descriptor: ctx.SecretDocBound.fields.body,
  });
  return ctx.app.dispatch({
    actionId, principal: { id: principalId }, scope: ctx.scope, history: { session },
    type: 'SecretDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: actionId },
      edit: { kind: 'text.insert', at: { positionToken: binding.documentPositionToken, offset, affinity: 'right' }, text: textValue },
    },
  });
}

async function applyAnnotationSpan(ctx, actionId, annotationValue, fromOffset, toOffset) {
  const row = ctx.db.prepare('SELECT * FROM SecretDoc WHERE id = ?').get('d1');
  const binding = await withAuthoringBinding({
    db: ctx.db, entity: ctx.SecretDocBound, Document: ctx.SecretDocBound, row,
    principal: { id: 'owner' }, fieldName: 'body', descriptor: ctx.SecretDocBound.fields.body,
  });
  return ctx.app.dispatch({
    actionId, principal: { id: 'owner' }, scope: ctx.scope,
    type: 'SecretDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: actionId },
      edit: {
        kind: 'annotation.apply',
        annotation: annotationValue,
        from: { positionToken: binding.documentPositionToken, offset: fromOffset, affinity: 'left' },
        to: { positionToken: binding.documentPositionToken, offset: toOffset, affinity: 'right' },
      },
    },
  });
}

async function undoLast(ctx, principalId, session) {
  const cursor = await ctx.app.history.cursor({ scope: ctx.scope, principal: { id: principalId }, session });
  return ctx.app.history.undo({ scope: ctx.scope, principal: { id: principalId }, session, actionId: `undo-${randomUUID()}`, revision: cursor.revision });
}

function durableText(ctx) {
  const state = ctx.db.prepare('SELECT family_checkpoint FROM SecretDoc_body_state WHERE document_id = ?').get('d1');
  return materializeText(restoreTextFamily(JSON.parse(state.family_checkpoint)));
}

test('per-recipient re-evaluation: an edit inside the confidential span and its undo never leak to an unauthorized recipient', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  seedDocument(ctx.db, ctx.SecretDoc, '');

  const seeded = await dispatchTextInsert(ctx, 'seed', 'owner', 'tab-owner', 0, 'hello secret world');
  assert.equal(seeded.ok, true, seeded.failure?.message);

  const themed = await applyAnnotationSpan(ctx, 'sensitive-apply', { id: 's1', family: 'sensitive', fields: {} }, 6, 12);
  assert.equal(themed.ok, true, themed.failure?.message);
  const protectedResult = await applyAnnotationSpan(ctx, 'protect', { id: 'c1', family: 'confidential', fields: {}, protectedTargetIds: ['s1'] }, 6, 12);
  assert.equal(protectedResult.ok, true, protectedResult.failure?.message);

  // Unauthorized editor sees the placeholder BEFORE the edit, never the raw text.
  const deniedBefore = await recipientSnapshot(ctx, 'editor');
  assert.equal(deniedBefore.kind, 'workbench.annotatedText.recipient');
  assert.equal(JSON.stringify(deniedBefore).includes('secret'), false);

  // The owner edits INSIDE the confidential span.
  const edited = await dispatchTextInsert(ctx, 'edit-inside', 'owner', 'tab-owner', 8, 'X');
  assert.equal(edited.ok, true, edited.failure?.message);
  assert.equal(durableText(ctx), 'hello seXcret world');

  // The editor's projection re-evaluates against the edited document and still
  // never discloses the secret (nor the newly inserted character).
  const deniedAfter = await recipientSnapshot(ctx, 'editor');
  assert.equal(deniedAfter.kind, 'workbench.annotatedText.recipient');
  assert.equal(deniedAfter.text, 'hello  world');
  assert.deepEqual(deniedAfter.redactions, [{ start: 6, end: 6, placeholder: '[Confidential]' }]);
  assert.equal(JSON.stringify(deniedAfter).includes('secret'), false);
  assert.equal(JSON.stringify(deniedAfter).includes('seXcret'), false);
  assert.equal(JSON.stringify(deniedAfter).includes('X'), false);

  // Undo the insert; the unauthorized projection still never leaks.
  const undone = await undoLast(ctx, 'owner', 'tab-owner');
  assert.equal(undone.ok, true, undone.failure?.message);
  const deniedAfterUndo = await recipientSnapshot(ctx, 'editor');
  assert.equal(deniedAfterUndo.kind, 'workbench.annotatedText.recipient');
  assert.equal(deniedAfterUndo.text, 'hello  world');
  assert.deepEqual(deniedAfterUndo.redactions, [{ start: 6, end: 6, placeholder: '[Confidential]' }]);
  assert.equal(JSON.stringify(deniedAfterUndo).includes('secret'), false);
  assert.equal(JSON.stringify(deniedAfterUndo).includes('seXcret'), false);
  assert.equal(JSON.stringify(deniedAfterUndo).includes('X'), false);

  // The owner still sees the real continuous text.
  const ownerView = await recipientSnapshot(ctx, 'owner');
  assert.equal(ownerView.text, 'hello secret world');
  assert.equal(JSON.stringify(ownerView).includes('secret'), true);
  assert.equal(Object.hasOwn(ownerView, 'redactions'), false);
});

test('a throwing confidentiality access denies the span inline instead of aborting the snapshot', async (t) => {
  const logEntries = [];
  const ctx = await setup(throwingAccessDeclarations, {
    log: { level: 'debug', output: (level, channel, msg, details) => logEntries.push({ level, channel, msg, details }) },
  });
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  seedDocument(ctx.db, ctx.SecretDoc, 'open secret tail', [
    { id: 's1', family: 'sensitive', start: 5, end: 11 },
    { id: 'c1', family: 'confidential', start: 5, end: 11, protectedTargetIds: ['s1'] },
  ]);

  // The access body throws for EVERY principal — including the project owner.
  // The projection must not fail: the span denies inline as a placeholder and
  // the raw text never appears in any serialized recipient document.
  for (const principalId of ['owner', 'editor', 'stranger']) {
    const view = await recipientSnapshot(ctx, principalId);
    assert.equal(view.kind, 'workbench.annotatedText.recipient');
    assert.equal(view.text, 'open  tail');
    assert.deepEqual(view.redactions, [{ start: 5, end: 5, placeholder: '[Confidential]' }]);
    assert.equal(JSON.stringify(view).includes('secret'), false);
  }

  // The exception message is a possible sink for row or annotation data and is
  // never logged: no captured auth entry carries the marker.
  assert.equal(JSON.stringify(logEntries).includes('sensitive-marker'), false);
});

// A child row whose owning-project FK dangles (no parent row): the inherit-child
// capability resolution cannot build a parent `is`, so the span denies inline.
// The snapshot still materializes for every recipient — never a whole-document
// failure, and never raw text on any wire.
function seedDanglingProjectDocument(db) {
  // Orphaned child rows are reachable (e.g. a partially applied migration), so
  // bypass the FK gate for the seed itself; the projection under test must still
  // fail the span closed rather than fail the whole snapshot. The gate stays OFF
  // across the ENTIRE seed (parent row and every annotation row) because each
  // annotation row also carries project_id='missing-project'.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.prepare("INSERT INTO SecretDoc (id, project, owner) VALUES ('d1', 'missing-project', 'owner')").run();
    const family = importTextToFamily('d1', ACTOR, 'open secret tail');
    db.prepare('INSERT INTO SecretDoc_body_state (document_id, structure_version, family_checkpoint) VALUES (?, 1, ?)').run('d1', JSON.stringify(textFamilyCheckpoint(family)));
    for (const annotation of [
      { id: 's1', family: 'sensitive', start: 5, end: 11 },
      { id: 'c1', family: 'confidential', start: 5, end: 11, protectedTargetIds: ['s1'] },
    ]) {
      db.prepare('INSERT INTO SecretDoc_body_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)')
        .run(annotation.id, 'd1', 'missing-project', 'owner', annotation.family);
      const start = resolveOffsetToEndpoint(family, annotation.start, family.checkpoint.frontier, 'right');
      const end = resolveOffsetToEndpoint(family, annotation.end, family.checkpoint.frontier, 'right');
      attachAnnotationRange(db, 'SecretDoc_body', 'd1', annotation.id, start, end, 0);
      if (annotation.protectedTargetIds) {
        for (const target of annotation.protectedTargetIds) {
          db.prepare('INSERT INTO SecretDoc_body_annotation_protected_target (annotation_id, target_annotation_id) VALUES (?, ?)').run(annotation.id, target);
        }
      }
    }
    return family;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

test('a dangling owning-project FK denies the confidential span inline instead of failing the whole snapshot', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  seedDanglingProjectDocument(ctx.db);

  for (const principalId of ['owner', 'editor', 'stranger']) {
    const view = await recipientSnapshot(ctx, principalId);
    assert.equal(view.kind, 'workbench.annotatedText.recipient');
    assert.equal(view.text, 'open  tail');
    assert.deepEqual(view.redactions, [{ start: 5, end: 5, placeholder: '[Confidential]' }]);
    assert.equal(JSON.stringify(view).includes('secret'), false);
  }
});
