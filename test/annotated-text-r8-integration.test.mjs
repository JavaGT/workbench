import { databaseImage, databaseFromImage } from './helpers/database-image.mjs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, boolean, entity, executeDDL, executeFrameworkDDL, grant, measurement, ref, read, scope, text, write, everyone,
  registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension, protectingAnnotation, annotationEntityAction, annotationEntityRemoveAction, admin, deny,
} from '../build/internal.mjs';
import { exportAnnotatedText } from '../build/index.mjs';
import { materializeText, restoreTextFamily } from '../build/annotated-text-continuous.mjs';
import { projectRangeToOffsets } from '../build/annotated-text-ranges.mjs';
import { native } from '../build/event-handle.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

const extension = {
  version: 1,
  validate() {},
  edit() {},
  partition({ blockText, utf16Offset, payload }) {
    return { version: 1, leftPayload: { ...payload, text: blockText.slice(0, utf16Offset) }, rightPayload: { ...payload, text: blockText.slice(utf16Offset) } };
  },
  combine({ left, right }) { return { version: 1, payload: { text: `${left?.payload?.text ?? ''}${right?.payload?.text ?? ''}` } }; },
};
registerAnnotatedTextContract('r8IntegrationSource', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('r8IntegrationSource', Object.freeze(extension));

function r8Doc({
  protectingAccess = async ({ is }) => (await is.owner()) ? grant(read) : grant(),
  access = () => grant(read, write),
  thread = false,
  codingCardinality = 'many',
  relationTarget = 'R8Comment',
  threadAction = annotationEntityAction({
    relation: 'comment', project: 'project', author: 'author', capability: write,
    input: { body: 'body' },
  }),
  removeAction = null,
} = {}) {
  return entity('R8IntegrationDocument', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('coding', { cardinality: codingCardinality }),
        annotation('tag', { fields: { value: boolean({ default: false }) } }),
        annotation('other', { fields: { value: boolean({ default: false }) } }),
         annotation('comment', {
           empty: 'orphan',
           ...(thread ? {
             fields: { comment: ref(relationTarget) },
              actions: { compose: threadAction, ...(removeAction ? { remove: removeAction } : {}) },
           } : {}),
         }),
        protectingAnnotation('confidential', { protects: 'coding', access: protectingAccess }),
      ],
      measurements: [measurement('source', { extension: 'r8IntegrationSource' })],
    }),
    grant: [scope(() => everyone()).can(access)],
    });
}

async function appFor(db = new DatabaseSync(':memory:'), principalId = null, options) {
  const Document = r8Doc(options);
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(async ({ is }) => (await is.owner()) ? grant(read, write, admin) : deny('not project owner'))],
  });
  const Comment = options?.thread ? entity('R8Comment', {
    project: ref('Project', { immutable: true }),
    author: ref('User'),
    body: text(),
    resolved: boolean({ default: false }),
    revision: text({ default: 'r1' }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  }) : null;
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(Document, db);
  if (Comment) executeDDL(Comment, db);
  const app = workbench({ db, entities: [Project, ...(Comment ? [Comment] : []), Document] });
  if (options?.deferStart) return { app, db, Document, Project, Comment };
  if (principalId !== null) app.listen(0, { principalOf: () => typeof principalId === 'function' ? principalId() : ({ id: principalId }) });
  else app.start();
  await app.ready;
  return { app, db, Document, Project, Comment };
}

async function setupDoc(docText, principalId = null, options) {
  const { app, db, Document, Project } = await appFor(new DatabaseSync(':memory:'), principalId, options);
  const created = await app.dispatch({
    actionId: 'create', type: 'R8IntegrationDocument.create',
    payload: {
      id: 'd1', project: 'p1', owner: 'u1',
      ...(docText ? { body: { version: 1, blocks: [{ text: docText }] } } : {}),
    },
    principal: { id: 'u1' },
  });
  assert.equal(created.ok, true, created.failure?.message);

  const row = db.prepare("SELECT * FROM R8IntegrationDocument WHERE id = 'd1'").get();
  const principal = { id: typeof principalId === 'function' ? (principalId()?.id ?? 'u1') : (principalId ?? 'u1') };
  const binding = await withAuthoringBinding({
    db, entity: Document, Document, row, principal, fieldName: 'body', descriptor: Document.fields.body,
  });

  async function refreshBinding(forPrincipal = principal) {
    const current = db.prepare("SELECT * FROM R8IntegrationDocument WHERE id = 'd1'").get();
    return withAuthoringBinding({
      db, entity: Document, Document, row: current, principal: forPrincipal,
      fieldName: 'body', descriptor: Document.fields.body,
    });
  }

  function authoringOf(b, mutationId = `m-${randomUUID()}`) {
    return { version: 1, stream: b.streamToken, lease: b.leaseToken, mutationId };
  }

  return {
    app, db, Document, Project, binding, refreshBinding, authoringOf,
    documentPositionToken: binding.documentPositionToken,
  };
}

function familyText(db) {
  const state = db.prepare("SELECT family_checkpoint FROM R8IntegrationDocument_body_state WHERE document_id = 'd1'").get();
  return materializeText(restoreTextFamily(JSON.parse(state.family_checkpoint)));
}

function durableAnnotatedTextState(db) {
  const prefix = 'R8IntegrationDocument_body';
  const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '${prefix}_*' ORDER BY name`)
    .all()
    .map(({ name }) => name)
    .filter((name) => !name.includes('_authoring_'));
  return tables.map((name) => {
    const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map((column) => column.name);
    const order = columns.map(quote).join(', ');
    return [name, db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${order}`).all()];
  });
}

async function setupThreadDoc(docText = 'hello world', principalId = 'u1', options = {}) {
  return setupDoc(docText, principalId, { thread: true, ...options });
}

function threadPayload(binding, { basis = binding.documentPositionToken, from = 0, to = 5, body = 'a comment', mutationId = `m-${randomUUID()}` } = {}) {
  return { version: 1, id: 'd1', basis, mutationId, from, to, values: { body } };
}

function dispatchThread(ctx, actionId, options = {}, principal = { id: 'u1' }) {
  return ctx.app.dispatch({
    actionId, type: 'R8IntegrationDocument.body.comment.compose', scope: 'Project:p1', principal,
    payload: threadPayload(ctx.binding, options),
  });
}

function threadCounts(db) {
  return {
    comments: db.prepare('SELECT COUNT(*) AS count FROM R8Comment').get().count,
    annotations: db.prepare('SELECT COUNT(*) AS count FROM R8IntegrationDocument_body_annotation').get().count,
  };
}

function assertNoThreadRows(db, message) {
  assert.deepEqual(threadCounts(db), { comments: 0, annotations: 0 }, message);
}

test('create imports continuous family text without block tables', async () => {
  const { app, db } = await setupDoc('hello world');
  assert.equal(familyText(db), 'hello world');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R8IntegrationDocument_body_state WHERE document_id = 'd1'").get().count, 1);
  const blockTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'R8IntegrationDocument_body_block*'").all();
  assert.equal(blockTables.length, 0);
  await app.shutdown();
});

test('annotation entity action atomically creates the related row and range', async () => {
  const ctx = await setupThreadDoc();
  const result = await dispatchThread(ctx, 'compose-1');
  assert.equal(result.ok, true, result.failure?.message);
  const comment = ctx.db.prepare('SELECT id, project, author, body, resolved FROM R8Comment').get();
  assert.equal(comment.project, 'p1');
  assert.equal(comment.author, 'u1');
  assert.equal(comment.body, 'a comment');
  assert.equal(comment.resolved, 0);
  const annotation = ctx.db.prepare('SELECT id FROM R8IntegrationDocument_body_annotation').get();
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM R8IntegrationDocument_body_membership WHERE annotation_id = ?').get(annotation.id).count, 1);
  await ctx.app.shutdown();
});

test('annotation entity actions reject hostile envelopes without partial related or annotation rows', async () => {
  const cases = [
    ['malformed and unknown values', async (ctx) => ({
      ...threadPayload(ctx.binding), values: { body: 'ok', unknown: true },
    })],
    ['malformed envelope', async (ctx) => ({
      ...threadPayload(ctx.binding), values: null,
    })],
    ['foreign basis', async (ctx) => threadPayload(ctx.binding, { basis: 'not-a-position-token' })],
    ['surrogate-splitting range', async (ctx) => threadPayload(ctx.binding, { from: 1, to: 2 })],
    ['cross-project scope and FK mismatch', async (ctx) => threadPayload(ctx.binding)],
    ['unauthorised writer', async (ctx) => threadPayload(ctx.binding)],
  ];

  for (const [label, payloadOf] of cases) {
    const ctx = await setupThreadDoc(label === 'surrogate-splitting range' ? '😀abc' : 'hello world');
    if (label === 'cross-project scope and FK mismatch') {
      ctx.db.exec("INSERT INTO Project (id, owner) VALUES ('p2', 'u1')");
    }
    if (label === 'unauthorised writer') ctx.db.exec("INSERT INTO User (id) VALUES ('u2')");
    const payload = await payloadOf(ctx);
    const result = await ctx.app.dispatch({
      actionId: `hostile-${label}`, type: 'R8IntegrationDocument.body.comment.compose',
      scope: label === 'cross-project scope and FK mismatch' ? 'Project:p2' : 'Project:p1',
      principal: label === 'unauthorised writer' ? { id: 'u2' } : { id: 'u1' }, payload,
    });
    assert.equal(result.ok, false, label);
    assertNoThreadRows(ctx.db, label);
    await ctx.app.shutdown();
  }
});

test('stale basis and failed requests leave both durable projections empty', async () => {
  const ctx = await setupThreadDoc();
  const before = threadCounts(ctx.db);
  const inserted = await ctx.app.dispatch({
    actionId: 'make-stale', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: ctx.authoringOf(ctx.binding, 'stale-edit'), edit: {
      kind: 'text.insert', at: { positionToken: ctx.documentPositionToken, offset: 5, affinity: 'right' }, text: '!',
    } },
  });
  assert.equal(inserted.ok, true, inserted.failure?.message);
  const result = await dispatchThread(ctx, 'stale-compose', { basis: ctx.documentPositionToken });
  assert.equal(result.ok, false);
  assert.deepEqual(threadCounts(ctx.db), before);
  await ctx.app.shutdown();
});

test('durable replay is idempotent, while changed payload conflicts', async () => {
  const ctx = await setupThreadDoc();
  const replayPayload = { body: 'same', mutationId: 'replay-mutation' };
  const first = await dispatchThread(ctx, 'replay-compose', replayPayload);
  assert.equal(first.ok, true, first.failure?.message);
  const identities = ctx.db.prepare('SELECT id FROM R8Comment').get().id;
  const annotationIdentity = ctx.db.prepare('SELECT id FROM R8IntegrationDocument_body_annotation').get().id;
  const second = await dispatchThread(ctx, 'replay-compose', replayPayload);
  assert.equal(second.ok, true, second.failure?.message);
  assert.deepEqual(threadCounts(ctx.db), { comments: 1, annotations: 1 });
  assert.equal(ctx.db.prepare('SELECT id FROM R8Comment').get().id, identities);
  assert.equal(ctx.db.prepare('SELECT id FROM R8IntegrationDocument_body_annotation').get().id, annotationIdentity);
  const conflict = await dispatchThread(ctx, 'replay-compose', { body: 'changed', mutationId: 'replay-mutation' });
  assert.equal(conflict.ok, false, 'same actionId with changed payload must conflict');
  assert.deepEqual(threadCounts(ctx.db), { comments: 1, annotations: 1 });
  await ctx.app.shutdown();
});

test('annotation entity declaration validation rejects malformed relation, project, author, capability, and input mappings', async () => {
  for (const [label, action] of [
    ['relation', annotationEntityAction({ relation: 'missing', project: 'project', author: 'author', capability: write, input: { body: 'body' } })],
    ['project', annotationEntityAction({ relation: 'comment', project: 'missing', author: 'author', capability: write, input: { body: 'body' } })],
    ['author', annotationEntityAction({ relation: 'comment', project: 'project', author: 'missing', capability: write, input: { body: 'body' } })],
  ]) {
    await assert.rejects(() => appFor(new DatabaseSync(':memory:'), null, { thread: true, threadAction: action }), new RegExp(label));
  }
  assert.throws(() => annotationEntityAction({ relation: 'comment', project: 'project', author: 'author', capability: {}, input: { body: 'body' } }), /capability/);
  assert.throws(() => annotationEntityAction({ relation: 'comment', project: 'project', author: 'author', capability: write, input: { 'bad-name': 'body' } }), /input/);
  const invalidMapping = await appFor(new DatabaseSync(':memory:'), null, {
      thread: true,
      threadAction: annotationEntityAction({
        relation: 'comment', project: 'project', author: 'author', capability: write,
        input: { body: 'id' },
      }),
      deferStart: true,
  });
  await assert.rejects(() => invalidMapping.app.start(), /framework-owned/);
  const unregisteredDb = new DatabaseSync(':memory:');
  await assert.rejects(() => appFor(unregisteredDb, null, {
    thread: true,
    relationTarget: 'MissingComment',
    deferStart: true,
  }), /not registered/);
  unregisteredDb.close();
});

test('annotation entity action rejects a basis issued to another principal without writes', async () => {
  const ctx = await setupThreadDoc();
  ctx.db.exec("INSERT INTO User (id) VALUES ('u2')");
  const foreign = await ctx.refreshBinding({ id: 'u2' });
  const result = await dispatchThread(
    ctx,
    'foreign-principal-basis',
    { basis: foreign.documentPositionToken },
    { id: 'u1' },
  );
  assert.equal(result.ok, false);
  assertNoThreadRows(ctx.db);
  await ctx.app.shutdown?.();
  ctx.db.close();
});

test('text.insert mutates the continuous family at an absolute offset', async () => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'insert', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-insert'),
      edit: { kind: 'text.insert', at: { positionToken: documentPositionToken, offset: 5, affinity: 'right' }, text: '!' },
    },
  });
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal(familyText(db), 'hello! world');
  await app.shutdown();
});

test('annotation.apply creates one document-scoped membership range', async () => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'apply-coding', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-apply-coding'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'coding-1', family: 'coding', fields: {} },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 5, affinity: 'right' },
      },
    },
  });
  assert.equal(result.ok, true, result.failure?.message);
  const ann = db.prepare("SELECT id, family FROM R8IntegrationDocument_body_annotation WHERE id = 'coding-1'").get();
  assert.equal(ann.family, 'coding');
  const memberships = db.prepare("SELECT * FROM R8IntegrationDocument_body_membership WHERE annotation_id = 'coding-1'").all();
  assert.equal(memberships.length, 1);
  assert.equal('block_id' in memberships[0], false);
  await app.shutdown();
});

test('pasting inside an exclusive annotation trims its range around the new annotation', async (t) => {
  const { app, db, binding, authoringOf, refreshBinding } = await setupDoc('hello', null, { codingCardinality: 'one' });
  t.after(async () => { await app.shutdown(); db.close(); });
  const apply = await app.dispatch({
    actionId: 'exclusive-apply', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: authoringOf(binding, 'exclusive-apply'), edit: {
      kind: 'annotation.apply', annotation: { id: 'original', family: 'coding', fields: {} },
      from: { positionToken: binding.documentPositionToken, offset: 0, affinity: 'left' },
      to: { positionToken: binding.documentPositionToken, offset: 5, affinity: 'right' },
    } },
  });
  assert.equal(apply.ok, true, apply.failure?.message);
  const fresh = await refreshBinding();
  const pasted = await app.dispatch({
    actionId: 'exclusive-paste', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: authoringOf(fresh, 'exclusive-paste'), edit: {
      kind: 'annotation.paste', annotation: { id: 'original', family: 'coding', fields: {} },
      at: { positionToken: fresh.documentPositionToken, offset: 2, affinity: 'right' }, text: 'zz',
    } },
  });
  assert.equal(pasted.ok, true, pasted.failure?.message);
  assert.equal(familyText(db), 'hezzllo');
  const family = restoreTextFamily(JSON.parse(db.prepare("SELECT family_checkpoint FROM R8IntegrationDocument_body_state WHERE document_id = 'd1'").get().family_checkpoint));
  const ranges = db.prepare('SELECT m.annotation_id, r.start_point, r.end_point FROM R8IntegrationDocument_body_membership m JOIN R8IntegrationDocument_body_range r ON r.id = m.range_id ORDER BY m.annotation_id, m.ordinal').all();
  const offsets = (range) => projectRangeToOffsets(family, { annotationId: range.annotation_id, start: JSON.parse(range.start_point), end: JSON.parse(range.end_point) });
  assert.deepEqual(ranges.filter((range) => range.annotation_id === 'original').map(offsets), [{ start: 0, end: 2 }, { start: 4, end: 7 }]);
  assert.deepEqual(ranges.filter((range) => range.annotation_id !== 'original').map(offsets), [{ start: 2, end: 4 }]);
});

test('annotation.paste on a document with an existing annotation mints a fresh id', async () => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('hello world');
  assert.equal((await app.dispatch({
    actionId: 'apply-coding', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-apply-coding'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'coding-1', family: 'coding', fields: {} },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 5, affinity: 'right' },
      },
    },
  })).ok, true);
  const pasted = await app.dispatch({
    actionId: 'paste-coding', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-paste-coding'),
      edit: {
        kind: 'annotation.paste',
        annotation: { id: 'coding-1', family: 'coding', fields: {} },
        at: { positionToken: documentPositionToken, offset: 6, affinity: 'right' },
        text: 'zz',
      },
    },
  });
  assert.equal(pasted.ok, true, pasted.failure?.message);
  assert.equal(familyText(db), 'hello zzworld');
  const annotations = db.prepare('SELECT id, family FROM R8IntegrationDocument_body_annotation ORDER BY id').all();
  assert.equal(annotations.length, 2);
  assert.ok(annotations.some((row) => row.id === 'coding-1'));
  assert.ok(annotations.some((row) => row.id !== 'coding-1' && row.family === 'coding'));
  await app.shutdown();
});

test('protecting annotation.apply records protected targets; remove deletes both cleanly', async () => {
  const { app, db, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('hello world');
  assert.equal((await app.dispatch({
    actionId: 'apply-coding', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-coding'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'coding-1', family: 'coding', fields: {} },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  })).ok, true);
  const next = await refreshBinding();
  assert.equal((await app.dispatch({
    actionId: 'apply-protect', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-protect'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'protect-1', family: 'confidential', fields: {}, protectedTargetIds: ['coding-1'] },
        from: { positionToken: next.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: next.documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  })).ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM R8IntegrationDocument_body_annotation_protected_target').get().count, 1);

  const afterProtect = await refreshBinding();
  const removed = await app.dispatch({
    actionId: 'remove-protect', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(afterProtect, 'm-remove-protect'),
      edit: { kind: 'annotation.remove', annotationId: 'protect-1' },
    },
  });
  assert.equal(removed.ok, true, removed.failure?.message);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R8IntegrationDocument_body_annotation WHERE id = 'protect-1'").get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM R8IntegrationDocument_body_annotation_protected_target').get().count, 0);
  await app.shutdown();
});

test('annotation.remove is an explicit delete; tampered replay is rejected without writes', async () => {
  const { app, db, Document, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('tag me');
  assert.equal((await app.dispatch({
    actionId: 'apply-tag', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-tag'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'tag-1', family: 'tag', fields: { value: true } },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 3, affinity: 'right' },
      },
    },
  })).ok, true);
  const next = await refreshBinding();
  const preimage = databaseImage(db);
  const removed = await app.dispatch({
    actionId: 'remove-tag', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-remove-tag'),
      edit: { kind: 'annotation.remove', annotationId: 'tag-1' },
    },
  });
  assert.equal(removed.ok, true, removed.failure?.message);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R8IntegrationDocument_body_annotation WHERE id = 'tag-1'").get().count, 0);

  const tampered = structuredClone(removed.events[0].data);
  tampered.facts.removedAnnotationIds = ['forged-id'];
  const replay = databaseFromImage(preimage);
  try {
    const replayPreimage = databaseImage(replay.db);
    assert.throws(
      () => Document.projection.apply({ handle: native('R8IntegrationDocument', 'body', 'operated'), data: tampered }, replay.db),
    );
    assert.deepEqual(databaseImage(replay.db), replayPreimage);
  } finally { replay.close(); }
  await app.shutdown();
});

test('orphan-policy annotations survive text delete that empties their range', async () => {
  const { app, db, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('hello world');
  assert.equal((await app.dispatch({
    actionId: 'orphan-comment', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-orphan-comment'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'keep-comment', family: 'comment', fields: {} },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 5, affinity: 'right' },
      },
    },
  })).ok, true);
  const next = await refreshBinding();
  const deleted = await app.dispatch({
    actionId: 'delete-span', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-delete-span'),
      edit: {
        kind: 'text.delete',
        from: { positionToken: next.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: next.documentPositionToken, offset: 5, affinity: 'right' },
      },
    },
  });
  assert.equal(deleted.ok, true, deleted.failure?.message);
  assert.equal(familyText(db), ' world');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R8IntegrationDocument_body_annotation WHERE id = 'keep-comment'").get().count, 1);
  assert.equal(db.prepare("SELECT saved_quote FROM R8IntegrationDocument_body_annotation_orphan_state WHERE annotation_id = 'keep-comment'").get().saved_quote, 'hello');
  await app.shutdown();
});

test('export produces blockless canonical; retire fences reuse', async () => {
  const { app, db, Project } = await setupDoc('retired secret');
  const Doc = r8Doc();
  const exportRequest = {
    app, entity: Doc, field: Doc.body, documentId: 'd1',
    expectedOwningScope: { entity: Project, id: 'p1' },
  };
  const exported = await exportAnnotatedText({ ...exportRequest, principal: { id: 'u1' } });
  assert.equal(exported.kind, 'workbench.annotatedText.canonical');
  assert.equal(exported.text, 'retired secret');
  assert.equal(Object.hasOwn(exported, 'blocks'), false);
  assert.deepEqual(exported.ranges, []);
  assert.deepEqual(exported.annotations, []);

  const retired = await app.dispatch({
    actionId: 'retire-d1', type: 'R8IntegrationDocument.annotatedText.retire', scope: 'Project:p1', principal: { id: 'u1' }, payload: { id: 'd1' },
  });
  assert.equal(retired.ok, true, retired.failure?.message);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R8IntegrationDocument_body_retired WHERE document_id = 'd1'").get().count, 1);
  await assert.rejects(exportAnnotatedText({ ...exportRequest, principal: { id: 'u1' } }));
  const reused = await app.dispatch({
    actionId: 'reuse-d1', type: 'R8IntegrationDocument.create', scope: 'Project:p1', principal: { id: 'u1' }, payload: { id: 'd1', project: 'p1', owner: 'u1' },
  });
  assert.equal(reused.ok, false);
  await app.shutdown();
});

test('HTTP snapshot redacts for non-owner; replay requires a fresh snapshot', async (t) => {
  let principal = { id: 'u1' };
  const { app, db, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('secret text', () => principal, {
    protectingAccess: async ({ is }) => (await is.owner()) ? grant(read) : grant(),
  });
  t.after(async () => { await app.shutdown(); db.close(); });

  assert.equal((await app.dispatch({
    actionId: 'coding', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-coding'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'coding-1', family: 'coding', fields: {} },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  })).ok, true);
  const next = await refreshBinding();
  assert.equal((await app.dispatch({
    actionId: 'protect', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-protect'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'protect-1', family: 'confidential', fields: {}, protectedTargetIds: ['coding-1'] },
        from: { positionToken: next.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: next.documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  })).ok, true);

  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const owner = await (await fetch(`${origin}/snapshot/R8IntegrationDocument/d1`, { signal: AbortSignal.timeout(5_000) })).json();
  assert.equal(owner.snapshot.body.text, 'secret text');
  assert.equal(Object.hasOwn(owner.snapshot.body, 'blocks'), false);
  assert.equal('basis' in owner.snapshot.body, false);

  principal = { id: 'u2' };
  const denied = await (await fetch(`${origin}/snapshot/R8IntegrationDocument/d1`, { signal: AbortSignal.timeout(5_000) })).json();
  assert.equal(denied.snapshot.body.kind, 'workbench.annotatedText.recipient');
  assert.equal(JSON.stringify(denied.snapshot.body).includes('secret text'), false);

  principal = { id: 'u1' };
  const replay = await fetch(`${origin}/events-since/R8IntegrationDocument/d1?cursor=0`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { resync: 'stale', reason: 'annotated-text-snapshot-required' });
});

test('direct events-since never exposes composed comment data or generated id', async (t) => {
  const ctx = await setupThreadDoc();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const composed = await dispatchThread(ctx, 'direct-catchup-compose', { body: 'secret composed comment' });
  assert.equal(composed.ok, true, composed.failure?.message);
  const commentId = ctx.db.prepare('SELECT id FROM R8Comment').get().id;
  const origin = `http://127.0.0.1:${ctx.app.httpServer.address().port}`;
  const response = await fetch(`${origin}/events-since/R8IntegrationDocument/d1?cursor=0`, { signal: AbortSignal.timeout(5_000) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(body).includes('secret composed comment'), false);
  assert.equal(JSON.stringify(body).includes(commentId), false);
});

test('v9 receipt dedupe and foreign position tokens reject without mutation', async () => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('hello');
  const first = await app.dispatch({
    actionId: 'dedupe-insert', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-dedupe'),
      edit: { kind: 'text.insert', at: { positionToken: documentPositionToken, offset: 5, affinity: 'right' }, text: '!' },
    },
  });
  assert.equal(first.ok, true, first.failure?.message);
  const again = await app.dispatch({
    actionId: 'dedupe-insert', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-dedupe'),
      edit: { kind: 'text.insert', at: { positionToken: documentPositionToken, offset: 5, affinity: 'right' }, text: '!' },
    },
  });
  assert.equal(again.ok, true);
  assert.equal(again.deduped === true || again.events?.length === 0 || familyText(db) === 'hello!', true);

  const before = durableAnnotatedTextState(db);
  const foreign = await app.dispatch({
    actionId: 'foreign-token', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-foreign'),
      edit: { kind: 'text.insert', at: { positionToken: randomBytes(32).toString('base64url'), offset: 0, affinity: 'right' }, text: 'x' },
    },
  });
  assert.equal(foreign.ok, false);
  assert.deepEqual(durableAnnotatedTextState(db), before);
  await app.shutdown();
});

test('block-era structure edits and invalid families are rejected without partial writes', async () => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('hello world');
  const before = durableAnnotatedTextState(db);
  for (const [actionId, edit] of [
    ['split', { kind: 'block.split', at: { positionToken: documentPositionToken, offset: 5, affinity: 'right' }, temporaryBlock: 'a'.repeat(43) }],
    ['merge', { kind: 'block.merge', leftPositionToken: documentPositionToken, rightPositionToken: documentPositionToken }],
    ['continue', { kind: 'block.continue', at: { positionToken: documentPositionToken, offset: 5, affinity: 'right' }, temporaryBlock: 'b'.repeat(43) }],
    ['unknown-family', {
      kind: 'annotation.apply',
      annotation: { id: 'x', family: 'not-declared', fields: {} },
      from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
      to: { positionToken: documentPositionToken, offset: 5, affinity: 'right' },
    }],
    ['bad-offset', {
      kind: 'annotation.apply',
      annotation: { id: 'y', family: 'coding', fields: {} },
      from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
      to: { positionToken: documentPositionToken, offset: 99, affinity: 'right' },
    }],
  ]) {
    const result = await app.dispatch({
      actionId, type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
      payload: { version: 9, id: 'd1', authoring: authoringOf(binding, `m-${actionId}`), edit },
    });
    assert.equal(result.ok, false, actionId);
  }
  assert.deepEqual(durableAnnotatedTextState(db), before);
  await app.shutdown();
});

// Boundary insert affinity is the behavior the browser demo tests assert (the
// editor's interval markers and the client-side fold projection both follow
// it). Pin it server-side so the client projection and the demo tests cannot
// drift from the authoritative family projection.
test('boundary inserts join the range at its start and stay out at its end', async () => {
  let binding;
  const at = (offset, affinity = 'right') => ({ positionToken: binding.documentPositionToken, offset, affinity });
  const dispatch = (ctx, b, actionId, edit) => ctx.app.dispatch({
    actionId, type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: ctx.authoringOf(b, `m-${actionId}`), edit },
  });
  const committedRange = async ({ db, refreshBinding }) => {
    binding = await refreshBinding();
    const state = db.prepare("SELECT family_checkpoint FROM R8IntegrationDocument_body_state WHERE document_id = 'd1'").get();
    const family = restoreTextFamily(JSON.parse(state.family_checkpoint));
    const membership = db.prepare("SELECT range.start_point, range.end_point FROM R8IntegrationDocument_body_membership AS membership JOIN R8IntegrationDocument_body_range AS range ON range.id = membership.range_id WHERE membership.annotation_id = 'edge-1'").get();
    return {
      text: materializeText(family),
      range: membership
        ? projectRangeToOffsets(family, {
          annotationId: 'edge-1',
          start: JSON.parse(membership.start_point),
          end: JSON.parse(membership.end_point),
        })
        : null,
    };
  };
  const applyRange = async (ctx) => {
    const applied = await dispatch(ctx, ctx.binding, `edge-apply-${Math.random()}`, {
      kind: 'annotation.apply',
      annotation: { id: 'edge-1', family: 'comment', fields: {} },
      from: at(1, 'right'),
      to: at(3, 'right'),
    });
    assert.equal(applied.ok, true, applied.failure?.message);
    return committedRange(ctx);
  };

  // Insert at the range START joins the comment: the range grows to include it.
  {
    const ctx = await setupDoc('abcd');
    binding = ctx.binding;
    const before = await applyRange(ctx);
    assert.deepEqual(before.range, { start: 1, end: 3 });
    const applied = await dispatch(ctx, binding, 'edge-insert-start', {
      kind: 'text.insert', at: at(1, 'right'), text: 'X',
    });
    assert.equal(applied.ok, true, applied.failure?.message);
    const after = await committedRange(ctx);
    assert.equal(after.text, 'aXbcd');
    assert.deepEqual(after.range, { start: 1, end: 4 }, 'insert at the range start joins the range');
    await ctx.app.shutdown();
  }

  // Insert at the range END stays outside: the range is unchanged.
  {
    const ctx = await setupDoc('abcd');
    binding = ctx.binding;
    await applyRange(ctx);
    const applied = await dispatch(ctx, binding, 'edge-insert-end', {
      kind: 'text.insert', at: at(3, 'right'), text: 'X',
    });
    assert.equal(applied.ok, true, applied.failure?.message);
    const after = await committedRange(ctx);
    assert.equal(after.text, 'abcXd');
    assert.deepEqual(after.range, { start: 1, end: 3 }, 'insert at the range end stays outside');
    await ctx.app.shutdown();
  }

  // A replace covering the range empties it (orphan policy): the membership
  // disappears from the projection.
  {
    const ctx = await setupDoc('abcd');
    binding = ctx.binding;
    await applyRange(ctx);
    const applied = await dispatch(ctx, binding, 'edge-replace', {
      kind: 'text.replace',
      from: at(0, 'right'),
      to: at(4, 'right'),
      text: 'XY',
    });
    assert.equal(applied.ok, true, applied.failure?.message);
    const after = await committedRange(ctx);
    assert.equal(after.text, 'XY');
    assert.equal(after.range, null, 'a covering replace empties the range (orphan)');
    await ctx.app.shutdown();
  }
});

// -- Generated annotation-entity REMOVE action (compose's lifecycle inverse) --

function removeDeclaration({ invariant } = {}) {
  return annotationEntityRemoveAction({
    relation: 'comment', project: 'project', author: 'author', stale: 'revision', capability: write,
    ...(invariant ? { invariant } : {}),
  });
}

async function setupRemoveDoc(options = {}) {
  return setupThreadDoc('hello world', 'u1', { removeAction: removeDeclaration(options.removeOptions), ...options });
}

async function composeComment(ctx, actionId, body = 'a comment') {
  const result = await dispatchThread(ctx, actionId, { body });
  assert.equal(result.ok, true, result.failure?.message);
}

function annotationAnchorFor(db, relatedId) {
  return db.prepare(`
    SELECT annotation.id, annotation.family, annotation.document_id, fields.comment
    FROM R8IntegrationDocument_body_annotation AS annotation
    JOIN R8IntegrationDocument_body_annotation_comment AS fields ON fields.annotation_id = annotation.id
    WHERE fields.comment = ?`).get(relatedId);
}

function dispatchRemove(ctx, actionId, { annotationId, relatedId, expected, mutationId = `m-${randomUUID()}` }, principal = { id: 'u1' }) {
  return ctx.app.dispatch({
    actionId, type: 'R8IntegrationDocument.body.comment.remove', scope: 'Project:p1', principal,
    payload: { version: 1, id: 'd1', mutationId, annotationId, relatedId, expected },
  });
}

test('remove action erases the annotation and its related row in ONE settlement', async (t) => {
  const ctx = await setupRemoveDoc();
  t.after(() => ctx.app.shutdown());
  await composeComment(ctx, 'compose-1');
  const comment = ctx.db.prepare('SELECT * FROM R8Comment').get();
  const anchor = annotationAnchorFor(ctx.db, comment.id);
  assert.ok(anchor, 'compose must anchor the comment to its related row');

  const result = await dispatchRemove(ctx, 'remove-1', {
    annotationId: anchor.id, relatedId: comment.id, expected: comment.revision,
  });
  assert.equal(result.ok, true, result.failure?.message);
  assert.deepEqual({ ...result.resultData }, { actionId: 'remove-1', confirmedThrough: result.resultData.confirmedThrough, annotationId: anchor.id, relatedId: comment.id });
  assert.deepEqual(threadCounts(ctx.db), { comments: 0, annotations: 0 }, 'one settlement must remove both rows');

  // Event order is load-bearing: annotation removal FIRST, related row SECOND
  // (the related row's annotation FK is ON DELETE RESTRICT).
  const events = ctx.db.prepare("SELECT eventType, eventData FROM _Log WHERE actionId = 'remove-1' AND scope = 'Project:p1' ORDER BY seq").all();
  assert.deepEqual(events.map((event) => event.eventType), [
    native('R8IntegrationDocument', 'body', 'operated').type,
    'R8Comment.removed',
  ]);
  const annotationPlan = JSON.parse(events[0].eventData);
  assert.equal(annotationPlan.operation.kind, 'annotation.remove');
  assert.deepEqual(annotationPlan.facts.removedAnnotationIds, [anchor.id]);
});

test('removing one comment leaves sibling comments and their anchors untouched', async (t) => {
  const ctx = await setupRemoveDoc();
  t.after(() => ctx.app.shutdown());
  await composeComment(ctx, 'compose-root', 'root thread');
  await composeComment(ctx, 'compose-other', 'unrelated thread');
  const [root, other] = ctx.db.prepare('SELECT * FROM R8Comment ORDER BY id').all();
  const rootAnchor = annotationAnchorFor(ctx.db, root.id);

  const result = await dispatchRemove(ctx, 'remove-root', {
    annotationId: rootAnchor.id, relatedId: root.id, expected: root.revision,
  });
  assert.equal(result.ok, true, result.failure?.message);
  assert.deepEqual(threadCounts(ctx.db), { comments: 1, annotations: 1 });
  const surviving = ctx.db.prepare('SELECT id, body FROM R8Comment').get();
  assert.equal(surviving.id, other.id, 'exactly the non-removed row survives');
  assert.equal(surviving.body, other.body);
  assert.ok(annotationAnchorFor(ctx.db, other.id), 'the sibling anchor survives');
  assert.equal(annotationAnchorFor(ctx.db, root.id), undefined);
});

test('remove action rejects stale tokens, foreign anchors, cross-document ids, non-authors, and malformed envelopes', async (t) => {
  // Stale compare-and-set: the token must match the row's declared column.
  {
    const ctx = await setupRemoveDoc();
    t.after(() => ctx.app.shutdown());
    await composeComment(ctx, 'compose-1');
    const comment = ctx.db.prepare('SELECT * FROM R8Comment').get();
    const anchor = annotationAnchorFor(ctx.db, comment.id);
    const stale = await dispatchRemove(ctx, 'remove-stale', {
      annotationId: anchor.id, relatedId: comment.id, expected: 'r2',
    });
    assert.equal(stale.ok, false);
    assert.match(stale.failure?.message ?? '', /stale/);
    assert.deepEqual(threadCounts(ctx.db), { comments: 1, annotations: 1 });
    // The exact stored cell value is accepted.
    const fresh = await dispatchRemove(ctx, 'remove-fresh', {
      annotationId: anchor.id, relatedId: comment.id, expected: comment.revision,
    });
    assert.equal(fresh.ok, true, fresh.failure?.message);
    assert.deepEqual(threadCounts(ctx.db), { comments: 0, annotations: 0 });
  }

  // Relation-field mismatch: the annotation anchors a DIFFERENT related row.
  {
    const ctx = await setupRemoveDoc();
    t.after(() => ctx.app.shutdown());
    await composeComment(ctx, 'compose-1', 'first');
    await composeComment(ctx, 'compose-2', 'second');
    const [first, second] = ctx.db.prepare('SELECT * FROM R8Comment ORDER BY id').all();
    const firstAnchor = annotationAnchorFor(ctx.db, first.id);
    const mismatch = await dispatchRemove(ctx, 'remove-mismatch', {
      annotationId: firstAnchor.id, relatedId: second.id, expected: first.revision,
    });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.failure?.message ?? '', /does not anchor/);
    assert.deepEqual(threadCounts(ctx.db), { comments: 2, annotations: 2 });
    await ctx.app.shutdown();
  }

  // Cross-document annotation id: the anchor belongs to another document.
  {
    const ctx = await setupRemoveDoc();
    t.after(() => ctx.app.shutdown());
    await composeComment(ctx, 'compose-1');
    const comment = ctx.db.prepare('SELECT * FROM R8Comment').get();
    const anchor = annotationAnchorFor(ctx.db, comment.id);
    const created = await ctx.app.dispatch({
      actionId: 'create-d2', type: 'R8IntegrationDocument.create', scope: 'Project:p1', principal: { id: 'u1' },
      payload: { id: 'd2', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'second doc' }] } },
    });
    assert.equal(created.ok, true, created.failure?.message);
    const crossDocument = await ctx.app.dispatch({
      actionId: 'remove-cross', type: 'R8IntegrationDocument.body.comment.remove', scope: 'Project:p1', principal: { id: 'u1' },
      payload: { version: 1, id: 'd2', mutationId: `m-${randomUUID()}`, annotationId: anchor.id, relatedId: comment.id, expected: comment.revision },
    });
    assert.equal(crossDocument.ok, false);
    assert.match(crossDocument.failure?.message ?? '', /does not belong to this document/);
    assert.deepEqual(threadCounts(ctx.db), { comments: 1, annotations: 1 });
    await ctx.app.shutdown();
  }

  // Author-only: another principal (even a project peer) cannot remove.
  {
    const ctx = await setupRemoveDoc();
    t.after(() => ctx.app.shutdown());
    ctx.db.exec("INSERT INTO User (id) VALUES ('u2')");
    await composeComment(ctx, 'compose-1');
    const comment = ctx.db.prepare('SELECT * FROM R8Comment').get();
    const anchor = annotationAnchorFor(ctx.db, comment.id);
    const foreign = await dispatchRemove(ctx, 'remove-foreign', {
      annotationId: anchor.id, relatedId: comment.id, expected: comment.revision,
    }, { id: 'u2' });
    assert.equal(foreign.ok, false);
    assert.match(foreign.failure?.message ?? '', /author may remove/);
    assert.deepEqual(threadCounts(ctx.db), { comments: 1, annotations: 1 });
    await ctx.app.shutdown();
  }

  // Malformed envelopes fail closed before any row is touched.
  {
    const ctx = await setupRemoveDoc();
    t.after(() => ctx.app.shutdown());
    await composeComment(ctx, 'compose-1');
    const comment = ctx.db.prepare('SELECT * FROM R8Comment').get();
    const anchor = annotationAnchorFor(ctx.db, comment.id);
    const malformed = [
      { version: 1, id: 'd1', mutationId: 'm1', annotationId: anchor.id, relatedId: comment.id },
      { version: 2, id: 'd1', mutationId: 'm1', annotationId: anchor.id, relatedId: comment.id, expected: '0' },
      { version: 1, id: 'd1', mutationId: 'm1', annotationId: anchor.id, relatedId: comment.id, expected: '0', extra: true },
      { version: 1, id: 'd1', mutationId: 'm1', annotationId: anchor.id, relatedId: comment.id, expected: 0 },
    ];
    for (const [index, payload] of malformed.entries()) {
      const result = await ctx.app.dispatch({
        actionId: `malformed-remove-${index}`, type: 'R8IntegrationDocument.body.comment.remove', scope: 'Project:p1', principal: { id: 'u1' },
        payload,
      });
      assert.equal(result.ok, false, `malformed envelope ${index} must fail`);
      assert.match(result.failure?.message ?? '', /closed removal payload/);
    }
    assert.deepEqual(threadCounts(ctx.db), { comments: 1, annotations: 1 });
    await ctx.app.shutdown();
  }
});

test('remove action invariant runs atomically: throwing rejects, returning a value rejects, async rejects', async (t) => {
  // A throwing invariant (e.g. "no replies exist") blocks the whole removal.
  {
    const ctx = await setupRemoveDoc({ removeOptions: { invariant: ({ relatedRow }) => {
      if (relatedRow.body === 'protected') throw new Error('replies exist');
      t.after(() => ctx.app.shutdown());
    } } });
    await composeComment(ctx, 'compose-1', 'protected');
    const comment = ctx.db.prepare('SELECT * FROM R8Comment').get();
    const anchor = annotationAnchorFor(ctx.db, comment.id);
    const blocked = await dispatchRemove(ctx, 'remove-blocked', {
      annotationId: anchor.id, relatedId: comment.id, expected: comment.revision,
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.failure?.message ?? '', /precondition failed/);
    assert.doesNotMatch(blocked.failure?.message ?? '', /replies exist/, 'application invariant text must not reach the client envelope');
    assert.deepEqual(threadCounts(ctx.db), { comments: 1, annotations: 1 }, 'an invariant rejection must leave both rows');
    await ctx.app.shutdown();
  }

  // The invariant must be a synchronous void predicate.
  {
    const ctx = await setupRemoveDoc({ removeOptions: { invariant: () => false } });
    t.after(() => ctx.app.shutdown());
    await composeComment(ctx, 'compose-1');
    const comment = ctx.db.prepare('SELECT * FROM R8Comment').get();
    const anchor = annotationAnchorFor(ctx.db, comment.id);
    const value = await dispatchRemove(ctx, 'remove-value', {
      annotationId: anchor.id, relatedId: comment.id, expected: comment.revision,
    });
    assert.equal(value.ok, false);
    assert.match(value.failure?.message ?? '', /invariant returned a value/);
    assert.deepEqual(threadCounts(ctx.db), { comments: 1, annotations: 1 });
    await ctx.app.shutdown();
  }
  {
    const ctx = await setupRemoveDoc({ removeOptions: { invariant: () => Promise.resolve() } });
    t.after(() => ctx.app.shutdown());
    await composeComment(ctx, 'compose-1');
    const comment = ctx.db.prepare('SELECT * FROM R8Comment').get();
    const anchor = annotationAnchorFor(ctx.db, comment.id);
    const async = await dispatchRemove(ctx, 'remove-async', {
      annotationId: anchor.id, relatedId: comment.id, expected: comment.revision,
    });
    assert.equal(async.ok, false);
    assert.match(async.failure?.message ?? '', /invariant returned a value/);
    assert.deepEqual(threadCounts(ctx.db), { comments: 1, annotations: 1 });
    await ctx.app.shutdown();
  }
});

test('remove action dedupe replays the receipt; a changed payload conflicts', async (t) => {
  const ctx = await setupRemoveDoc();
  t.after(() => ctx.app.shutdown());
  await composeComment(ctx, 'compose-1');
  const comment = ctx.db.prepare('SELECT * FROM R8Comment').get();
  const anchor = annotationAnchorFor(ctx.db, comment.id);
  const payload = { annotationId: anchor.id, relatedId: comment.id, expected: comment.revision, mutationId: 'fixed-mutation' };
  const first = await dispatchRemove(ctx, 'remove-1', payload);
  assert.equal(first.ok, true, first.failure?.message);
  const replay = await dispatchRemove(ctx, 'remove-1', payload);
  assert.equal(replay.ok, true, replay.failure?.message);
  assert.equal(replay.resultData?.confirmedThrough, first.resultData?.confirmedThrough);
  assert.deepEqual(threadCounts(ctx.db), { comments: 0, annotations: 0 });
  const conflict = await dispatchRemove(ctx, 'remove-1', { ...payload, expected: 'r2' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.failure?.category, 'conflict');
});

test('remove action works without a declared capability ("if declared" semantics)', async (t) => {
  const ctx = await setupThreadDoc('hello world', 'u1', {
    removeAction: annotationEntityRemoveAction({ relation: 'comment', project: 'project', author: 'author', stale: 'revision' }),
  });
  t.after(() => ctx.app.shutdown());
  assert.equal(ctx.Document.body.annotations.comment.actions.remove.capability, undefined, 'the compiled handle must not invent a capability');
  await composeComment(ctx, 'compose-1');
  const comment = ctx.db.prepare('SELECT * FROM R8Comment').get();
  const anchor = annotationAnchorFor(ctx.db, comment.id);
  const result = await dispatchRemove(ctx, 'remove-1', {
    annotationId: anchor.id, relatedId: comment.id, expected: comment.revision,
  });
  assert.equal(result.ok, true, result.failure?.message);
  assert.deepEqual(threadCounts(ctx.db), { comments: 0, annotations: 0 });
});

test('remove action rejects a compare-and-set column that is not a text field', async () => {
  const deferred = await appFor(new DatabaseSync(':memory:'), null, {
    thread: true,
    removeAction: annotationEntityRemoveAction({ relation: 'comment', project: 'project', author: 'author', stale: 'resolved', capability: write }),
    deferStart: true,
  });
  await assert.rejects(() => deferred.app.start(), /text field/);
  deferred.db.close();
});

test('remove action declaration validation rejects framework-owned and missing stale columns', async () => {
  for (const [label, removeAction] of [
    ['framework-owned', annotationEntityRemoveAction({ relation: 'comment', project: 'project', author: 'author', stale: 'id', capability: write })],
    ['missing column', annotationEntityRemoveAction({ relation: 'comment', project: 'project', author: 'author', stale: 'nope', capability: write })],
  ]) {
    const deferred = await appFor(new DatabaseSync(':memory:'), null, {
      thread: true, removeAction, deferStart: true,
    });
    await assert.rejects(() => deferred.app.start(), new RegExp(label === 'framework-owned' ? 'framework-owned' : 'stale'));
    deferred.db.close();
  }
});

test('the compiled remove handle is data-only: the invariant never reaches it', async (t) => {
  const ctx = await setupRemoveDoc({ removeOptions: { invariant: () => {} } });
  t.after(() => ctx.app.shutdown());
  const handle = ctx.Document.body.annotations.comment.actions.remove;
  assert.equal(handle.kind, 'annotationEntityRemoveAction');
  assert.equal(handle.stale, 'revision');
  assert.equal(handle.relation, 'comment');
  assert.equal('invariant' in handle, false, 'the server-side invariant must stay off the compiled handle');
  assert.equal(Object.isFrozen(handle), true);
});
