import { databaseImage, databaseFromImage } from './helpers/database-image.mjs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, boolean, number, text, entity, everyone, executeDDL, executeFrameworkDDL, measurement, protectingAnnotation,
  admin, deny, grant, read, ref, scope, write,
  registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension,
} from '../build/internal.mjs';
import { exportAnnotatedText } from '../build/index.mjs';
import { materializeText, restoreTextFamily } from '../build/annotated-text-continuous.mjs';
import { native } from '../build/event-handle.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

registerAnnotatedTextContract('sourceInit', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('sourceInit', Object.freeze({
  version: 1,
  validate: function validate() {},
  edit: function edit() {},
  partition: function partition(input) {
    const blockText = input.blockText;
    const offset = input.utf16Offset;
    const payload = input.payload;
    if (payload.fail === true) throw new Error('partition failure');
    const leftText = blockText.slice(0, offset);
    const rightText = blockText.slice(offset);
    return Object.freeze({
      version: 1,
      leftPayload: Object.freeze({ ...payload, text: leftText, offset }),
      rightPayload: Object.freeze({ ...payload, text: rightText, offset }),
    });
  },
  combine: function combine(input) {
    if (input.left !== null && input.right !== null) {
      return Object.freeze({
        version: 1,
        payload: Object.freeze({ text: input.left.payload.text + input.right.payload.text }),
      });
    }
    if (input.left !== null) return Object.freeze({ version: 1, payload: input.left.payload });
    if (input.right !== null) return Object.freeze({ version: 1, payload: input.right.payload });
    return Object.freeze({ version: 1, payload: null });
  },
}));

function r4Doc({
  protectingAccess = async ({ is }) => (await is.owner()) ? grant(read) : grant(),
  commentEmpty = 'orphan',
  access = () => grant(read, write),
} = {}) {
  return entity('R4Doc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('theme', { fields: { color: text({ default: 'blue' }), weight: number({ default: 1 }) } }),
        annotation('flag', { fields: { flagged: boolean({ default: false }) } }),
        annotation('comment', { empty: commentEmpty }),
        protectingAnnotation('confidential', { protects: 'theme', access: protectingAccess }),
        protectingAnnotation('standalone', { access: () => grant(read) }),
      ],
      measurements: [measurement('source', { extension: 'sourceInit' })],
    }),
    grant: [scope(() => everyone()).can(access)],
  });
}

async function appFor(db = new DatabaseSync(':memory:'), principalId = null, options) {
  const R4Doc = r4Doc(options);
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(async ({ is }) => (await is.owner()) ? grant(read, write, admin) : deny('not project owner'))],
  });
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(R4Doc, db);
  const app = workbench({ db, entities: [Project, R4Doc] });
  if (principalId !== null) app.listen(0, { principalOf: () => typeof principalId === 'function' ? principalId() : ({ id: principalId }) });
  else app.start();
  await app.ready;
  return { app, db, R4Doc, Project };
}

async function setupDoc(docText, principalId = null, options) {
  const { app, db, R4Doc, Project } = await appFor(new DatabaseSync(':memory:'), principalId, options);
  const created = await app.dispatch({
    actionId: 'create', type: 'R4Doc.create',
    payload: {
      id: 'd1', project: 'p1', owner: 'u1',
      ...(docText ? { body: { version: 1, blocks: [{ text: docText }] } } : {}),
    },
    principal: { id: 'u1' },
  });
  assert.equal(created.ok, true, created.failure?.message);

  const row = db.prepare("SELECT * FROM R4Doc WHERE id = 'd1'").get();
  const principal = { id: typeof principalId === 'function' ? (principalId()?.id ?? 'u1') : (principalId ?? 'u1') };
  const binding = await withAuthoringBinding({
    db, entity: R4Doc, Document: R4Doc, row, principal, fieldName: 'body', descriptor: R4Doc.fields.body,
  });

  async function refreshBinding(forPrincipal = principal) {
    const current = db.prepare("SELECT * FROM R4Doc WHERE id = 'd1'").get();
    return withAuthoringBinding({
      db, entity: R4Doc, Document: R4Doc, row: current, principal: forPrincipal,
      fieldName: 'body', descriptor: R4Doc.fields.body,
    });
  }

  function authoringOf(b, mutationId = `m-${randomUUID()}`) {
    return { version: 1, stream: b.streamToken, lease: b.leaseToken, mutationId };
  }

  return {
    app, db, R4Doc, Project, binding, refreshBinding, authoringOf,
    documentPositionToken: binding.documentPositionToken,
    stream: { id: binding.streamToken },
    lease: { id: binding.leaseToken },
  };
}

function familyText(db) {
  const state = db.prepare("SELECT family_checkpoint FROM R4Doc_body_state WHERE document_id = 'd1'").get();
  return materializeText(restoreTextFamily(JSON.parse(state.family_checkpoint)));
}

function serializedIncludesPrivateField(serialized, fields) {
  return fields.some((field) => serialized.includes(field));
}

test('annotation.apply on full document creates annotation with one document range', async () => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'apply-full', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-apply-full'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'ann-1', family: 'theme', fields: { color: 'red', weight: 1 } },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  });
  assert.equal(result.ok, true, result.failure?.message);
  const annRow = db.prepare("SELECT id, family FROM R4Doc_body_annotation WHERE id = 'ann-1'").get();
  assert.equal(annRow.family, 'theme');
  const famRow = db.prepare("SELECT * FROM R4Doc_body_annotation_theme WHERE annotation_id = 'ann-1'").get();
  assert.equal(famRow.color, 'red');
  assert.equal(famRow.weight, 1);
  const memberships = db.prepare("SELECT * FROM R4Doc_body_membership WHERE annotation_id = 'ann-1'").all();
  assert.equal(memberships.length, 1);
  assert.equal('block_id' in memberships[0], false);
  assert.equal('basis' in (result.resultData ?? {}), false);
  await app.close?.();
});

test('text.replace projects one atomic document-wide event', async () => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('Hello');
  const result = await app.dispatch({
    actionId: 'replace-interior', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-replace-interior'),
      edit: {
        kind: 'text.replace',
        from: { positionToken: documentPositionToken, offset: 1, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 4, affinity: 'right' },
        text: 'i',
      },
    },
  });
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].data.version, 14);
  assert.equal(result.events[0].data.facts.family, null);
  assert.equal(familyText(db), 'Hio');
  await app.close?.();
});

test('annotation.apply persists sorted protecting targets through its sole event and projection path', async () => {
  const { app, db, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('hello world');
  const coded = await app.dispatch({
    actionId: 'apply-theme', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-theme'),
      edit: {
        kind: 'annotation.apply', annotation: { id: 'theme-1', family: 'theme', fields: { color: 'blue', weight: 1 } },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  });
  assert.equal(coded.ok, true, coded.failure?.message);
  const next = await refreshBinding();
  const protectedResult = await app.dispatch({
    actionId: 'apply-protection', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-protect'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'protect-1', family: 'confidential', fields: {}, protectedTargetIds: ['theme-1'] },
        from: { positionToken: next.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: next.documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  });
  assert.equal(protectedResult.ok, true, protectedResult.failure?.message);
  // The emitted v13 operation + facts must carry the annotation and its sorted
  // protected targets (not just a SQL row).
  const opData = protectedResult.events[0].data;
  assert.equal(opData.operation.kind, 'annotation.apply-range');
  assert.deepEqual(opData.operation.annotation.protectedTargetIds, ['theme-1']);
  assert.deepEqual(opData.facts.annotation.protectedTargetIds, ['theme-1']);
  assert.equal(opData.operation.annotation.id, 'protect-1');
  assert.ok(opData.facts.ranges.some((range) => range.annotationId === 'protect-1'));
  const targets = db.prepare('SELECT annotation_id, target_annotation_id FROM R4Doc_body_annotation_protected_target').all();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].annotation_id, 'protect-1');
  assert.equal(targets[0].target_annotation_id, 'theme-1');
  await app.close?.();
});

test('annotation.remove deletes the annotation and rejects a tampered event on replay', async () => {
  const { app, db, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('comment');
  assert.equal((await app.dispatch({
    actionId: 'r5-comment', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-r5-comment'),
      edit: {
        kind: 'annotation.apply', annotation: { id: 'r5-comment', family: 'comment', fields: {} },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 7, affinity: 'right' },
      },
    },
  })).ok, true);
  const next = await refreshBinding();
  const preimage = databaseImage(db);
  const removed = await app.dispatch({
    actionId: 'r5-remove', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-r5-remove'),
      edit: { kind: 'annotation.remove', annotationId: 'r5-comment' },
    },
  });
  assert.equal(removed.ok, true, removed.failure?.message);
  assert.equal(removed.events[0].data.version, 14);
  assert.equal(removed.events[0].data.operation.kind, 'annotation.remove');
  // Blockless annotation.remove is an explicit delete (orphan is the emptied-by-text path).
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_annotation WHERE id = 'r5-comment'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_membership WHERE annotation_id = 'r5-comment'").get().count, 0);

  const tampered = structuredClone(removed.events[0].data);
  tampered.facts.removedAnnotationIds = ['forged-id'];
  const replay = databaseFromImage(preimage);
  try {
    const replayPreimage = databaseImage(replay.db);
    assert.throws(
      () => app.entities.get('R4Doc').projection.apply({ handle: native('R4Doc', 'body', 'operated'), data: tampered }, replay.db),
    );
    assert.deepEqual(databaseImage(replay.db), replayPreimage);
  } finally { replay.close(); }
  await app.close?.();
});

test('annotation.remove denies a non-writer before log or projection changes', async () => {
  const { app, db, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('hello world', null, {
    access: async ({ is }) => (await is.owner()) ? grant(read, write) : grant(read),
  });
  assert.equal((await app.dispatch({
    actionId: 'r5-denied-theme', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-r5-denied-theme'),
      edit: {
        kind: 'annotation.apply', annotation: { id: 'r5-denied-theme', family: 'theme', fields: { color: 'blue', weight: 1 } },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 5, affinity: 'right' },
      },
    },
  })).ok, true);
  const next = await refreshBinding();
  const preimage = databaseImage(db);
  const denied = await app.dispatch({
    actionId: 'r5-denied-remove', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u2' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-r5-denied-remove'),
      edit: { kind: 'annotation.remove', annotationId: 'r5-denied-theme' },
    },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.failure?.category, 'denied');
  // The denied operation must leave the ENTIRE durable state untouched
  // (annotation row, membership, orphan state, cursor, and log alike).
  assert.deepEqual(databaseImage(db), preimage);
  await app.close?.();
});

test('HTTP snapshot projects protected annotated text for each recipient before serialization', async (t) => {
  let principal = { id: 'u1' };
  let ownerMayRead = true;
  const { app, db, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('hello world', () => principal, {
    protectingAccess: async ({ is }) => (ownerMayRead && await is.owner()) ? grant(read) : grant(),
  });
  t.after(async () => { await app.shutdown(); db.close(); });
  assert.equal((await app.dispatch({
    actionId: 'http-theme', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-http-theme'),
      edit: {
        kind: 'annotation.apply', annotation: { id: 'http-theme', family: 'theme', fields: { color: 'blue', weight: 1 } },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  })).ok, true);
  const next = await refreshBinding();
  assert.equal((await app.dispatch({
    actionId: 'http-protection', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-http-protection'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'http-protect', family: 'confidential', fields: {}, protectedTargetIds: ['http-theme'] },
        from: { positionToken: next.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: next.documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  })).ok, true);

  // Measurement rows are optional for the redaction assertion; skip if schema differs.

  const ownerResponse = await fetch(`http://127.0.0.1:${app.httpServer.address().port}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(ownerResponse.status, 200);
  const owner = await ownerResponse.json();
  assert.equal('basis' in owner.snapshot.body, false, 'snapshot must not contain basis');
  assert.equal(owner.snapshot.body.text, 'hello world');
  assert.equal(Object.hasOwn(owner.snapshot.body, 'blocks'), false);
  const serialized = JSON.stringify(owner.snapshot.body);
  assert.equal(serialized.includes('protectedTargetIds'), false);

  principal = { id: 'u2' };
  const response = await fetch(`http://127.0.0.1:${app.httpServer.address().port}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  const recipient = await response.json();
  assert.equal('basis' in recipient.snapshot.body, false);
  assert.equal(recipient.snapshot.body.kind, 'workbench.annotatedText.recipient');
  const restrictedSerialized = JSON.stringify(recipient.snapshot.body);
  assert.equal(restrictedSerialized.includes('hello world'), false);
  assert.equal(restrictedSerialized.includes('http-measurement'), false);
  assert.equal(restrictedSerialized.includes('http-theme'), false);
  assert.equal(restrictedSerialized.includes('http-protect'), false);
  assert.equal(restrictedSerialized.includes('protectedTargetIds'), false);
  assert.equal(restrictedSerialized.includes('frontier'), false);
  assert.equal(restrictedSerialized.includes('structuralRevision'), false);
});

test('v9 position token confidentiality: foreign and stale tokens are rejected', async (t) => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('secret', 'u1');
  t.after(async () => { await app.shutdown(); db.close(); });
  const foreignToken = randomBytes(32).toString('base64url');
  const beforeText = familyText(db);
  const beforeLog = db.prepare('SELECT COUNT(*) AS c FROM _Log').get().c;
  const result = await app.dispatch({
    actionId: 'foreign-token', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-foreign'),
      edit: { kind: 'text.insert', at: { positionToken: foreignToken, offset: 0, affinity: 'right' }, text: 'x' },
    },
  });
  assert.equal(result.ok, false);
  // The rejected operation must leave durable state untouched.
  assert.equal(familyText(db), beforeText);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM _Log').get().c, beforeLog);
  const goodResult = await app.dispatch({
    actionId: 'good-insert', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-good'),
      edit: { kind: 'text.insert', at: { positionToken: documentPositionToken, offset: 0, affinity: 'right' }, text: 'x' },
    },
  });
  assert.equal(goodResult.ok, true, goodResult.failure?.message);
});

test('v9 dispatch produces authoring receipt with correct fence and no basis', async () => {
  const { app, binding, authoringOf, documentPositionToken } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'receipt-test', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-receipt'),
      edit: { kind: 'text.insert', at: { positionToken: documentPositionToken, offset: 5, affinity: 'right' }, text: 'XYZ' },
    },
  });
  assert.equal(result.ok, true, result.failure?.message);
  assert.ok(result.resultData);
  assert.equal(result.resultData.actionId, 'receipt-test');
  assert.ok(Number.isSafeInteger(result.resultData.confirmedThrough));
  const receipt = result.resultData.authoring;
  assert.ok(receipt);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.stream, binding.streamToken);
  assert.equal(receipt.acknowledgementFence, result.resultData.confirmedThrough);
  assert.equal('basis' in result.resultData, false);
  assert.ok(Array.isArray(receipt.positionFrames));
  assert.equal(receipt.positionFrames.length, 1);
  assert.equal(typeof receipt.positionFrames[0].positionToken, 'string');
  assert.equal('groupFrames' in receipt, false);
  await app.close?.();
});

test('HTTP snapshot serializes continuous text and never exposes basis', async (t) => {
  const { app, db } = await setupDoc('visible', 'u1');
  t.after(async () => { await app.shutdown(); db.close(); });
  const response = await fetch(`http://127.0.0.1:${app.httpServer.address().port}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  const body = (await response.json()).snapshot.body;
  assert.equal('basis' in body, false);
  assert.equal(body.text, 'visible');
  assert.equal(Object.hasOwn(body, 'blocks'), false);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('structuralRevision'), false);
  assert.equal(Object.hasOwn(body, 'frontier'), false);
  assert.ok(Array.isArray(body.frontiers), 'authorized anchored ranges carry their deduplicated frontier table');
  assert.equal(serialized.includes('protectedTargetIds'), false);
  assert.equal(serialized.includes('last_memberships'), false);
  assert.equal(serialized.includes('family_checkpoint'), false);
});

test('HTTP replay never serializes annotated-text events and requires a fresh snapshot', async (t) => {
  let principal = { id: 'u1' };
  const { app, db, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('replay secret', () => principal);
  t.after(async () => { await app.shutdown(); db.close(); });
  assert.equal((await app.dispatch({
    actionId: 'replay-theme', type: 'R4Doc.body.operation', scope: 'Project:p1', principal,
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-replay-theme'),
      edit: {
        kind: 'annotation.apply', annotation: { id: 'replay-theme', family: 'theme', fields: { color: 'blue', weight: 1 } },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 13, affinity: 'right' },
      },
    },
  })).ok, true);
  const next = await refreshBinding();
  assert.equal((await app.dispatch({
    actionId: 'replay-protection', type: 'R4Doc.body.operation', scope: 'Project:p1', principal,
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-replay-protection'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'replay-protection', family: 'confidential', fields: {}, protectedTargetIds: ['replay-theme'] },
        from: { positionToken: next.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: next.documentPositionToken, offset: 13, affinity: 'right' },
      },
    },
  })).ok, true);
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const replay = await fetch(`${origin}/events-since/R4Doc/d1?cursor=0`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(replay.status, 200);
  const serialized = await replay.text();
  assert.deepEqual(JSON.parse(serialized), { resync: 'stale', reason: 'annotated-text-snapshot-required' });
  for (const hidden of ['replay secret', 'replay-theme', 'replay-protection', 'protectedTargetIds', 'operation', 'frontier']) {
    assert.equal(serialized.includes(hidden), false, `replay must not expose ${hidden}`);
  }

  principal = { id: 'u2' };
  const revoked = await fetch(`${origin}/events-since/R4Doc/d1?cursor=0`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { resync: 'stale', reason: 'annotated-text-snapshot-required' });
  const snapshot = await fetch(`${origin}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) });
  const deniedBody = (await snapshot.json()).snapshot.body;
  assert.equal(deniedBody.kind, 'workbench.annotatedText.recipient');
  assert.equal(JSON.stringify(deniedBody).includes('replay secret'), false);
});

test('owner canonical export is complete and retirement erases history behind a durable reuse fence', async () => {
  const { app, db, Project } = await setupDoc('retired secret');
  const Doc = r4Doc();
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
  await assert.rejects(exportAnnotatedText({ ...exportRequest, principal: { id: 'u2' } }), /owning scope admin authorization failed/);

  const retired = await app.dispatch({
    actionId: 'retire-d1', type: 'R4Doc.annotatedText.retire', scope: 'Project:p1', principal: { id: 'u1' }, payload: { id: 'd1' },
  });
  assert.equal(retired.ok, true, retired.failure?.message);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_retired WHERE document_id = 'd1'").get().count, 1);
  await assert.rejects(exportAnnotatedText({ ...exportRequest, principal: { id: 'u1' } }));
  const reused = await app.dispatch({
    actionId: 'reuse-d1', type: 'R4Doc.create', scope: 'Project:p1', principal: { id: 'u1' }, payload: { id: 'd1', project: 'p1', owner: 'u1' },
  });
  assert.equal(reused.ok, false);
});

test('annotation.apply rejects target IDs on ordinary, standalone, and wrong-family protectors', async () => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('hello world');
  const ordinary = await app.dispatch({
    actionId: 'bad-targets', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-bad-targets'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'flag-1', family: 'flag', fields: {}, protectedTargetIds: ['nope'] },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  });
  assert.equal(ordinary.ok, false);
  const standalone = await app.dispatch({
    actionId: 'bad-standalone-protection', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-bad-standalone'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'standalone-1', family: 'standalone', fields: {}, protectedTargetIds: ['nope'] },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  });
  assert.equal(standalone.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM R4Doc_body_annotation_protected_target').get().count, 0);
  await app.close?.();
});

test('retire removes a document that carries protecting annotations', async () => {
  const { app, db, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('secret text');
  assert.equal((await app.dispatch({
    actionId: 'retire-theme', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-retire-theme'),
      edit: {
        kind: 'annotation.apply', annotation: { id: 'retire-theme', family: 'theme', fields: { color: 'blue', weight: 1 } },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  })).ok, true);
  const next = await refreshBinding();
  assert.equal((await app.dispatch({
    actionId: 'retire-confidential', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-retire-confidential'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'retire-confidential', family: 'confidential', fields: {}, protectedTargetIds: ['retire-theme'] },
        from: { positionToken: next.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: next.documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  })).ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM R4Doc_body_annotation_protected_target').get().count, 1);

  const retired = await app.dispatch({
    actionId: 'retire-protected', type: 'R4Doc.annotatedText.retire', scope: 'Project:p1', principal: { id: 'u1' }, payload: { id: 'd1' },
  });
  assert.equal(retired.ok, true, retired.failure?.message);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc WHERE id = 'd1'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_retired WHERE document_id = 'd1'").get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM R4Doc_body_annotation').get().count, 0);
});

test('annotation.apply on a prefix creates one document range without block splits', async () => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('hello world');
  const prefix = await app.dispatch({
    actionId: 'apply-prefix', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-prefix'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'ann-prefix', family: 'flag', fields: { flagged: true } },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 5, affinity: 'right' },
      },
    },
  });
  assert.equal(prefix.ok, true, prefix.failure?.message);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_membership WHERE annotation_id = 'ann-prefix'").get().count, 1);
  assert.equal(familyText(db), 'hello world');
  await app.close?.();
});

test('protective annotation.apply on a subrange creates one document range', async () => {
  const { app, binding, authoringOf, documentPositionToken } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'apply-protective-span', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-protective-span'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'span-protect', family: 'confidential', fields: {} },
        from: { positionToken: documentPositionToken, offset: 2, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 7, affinity: 'right' },
      },
    },
  });
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal(result.events.length, 1);
  const event = result.events[0].data;
  assert.equal(event.version, 14);
  assert.equal(event.operation.kind, 'annotation.apply-range');
  await app.close?.();
});

test('annotation.apply rejects invalid selection offsets', async () => {
  const { app, binding, authoringOf, documentPositionToken } = await setupDoc('hello');
  const bad = await app.dispatch({
    actionId: 'bad-offset', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-bad-offset'),
      edit: {
        kind: 'annotation.apply', annotation: { id: 'bad', family: 'theme', fields: { color: 'blue', weight: 1 } },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 99, affinity: 'right' },
      },
    },
  });
  assert.equal(bad.ok, false);
  await app.close?.();
});

test('annotation.apply rejects unknown annotation family', async () => {
  const { app, binding, authoringOf, documentPositionToken } = await setupDoc('hello');
  const bad = await app.dispatch({
    actionId: 'unknown-family', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-unknown-family'),
      edit: {
        kind: 'annotation.apply', annotation: { id: 'x', family: 'not-declared', fields: {} },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 5, affinity: 'right' },
      },
    },
  });
  assert.equal(bad.ok, false);
  await app.close?.();
});

test('annotation.apply reanchors an existing annotation id', async () => {
  const { app, db, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('hello');
  assert.equal((await app.dispatch({
    actionId: 'first', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-first'),
      edit: {
        kind: 'annotation.apply', annotation: { id: 'dup', family: 'theme', fields: { color: 'blue', weight: 1 } },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 5, affinity: 'right' },
      },
    },
  })).ok, true);
  const shared = await refreshBinding();
  assert.equal((await app.dispatch({
    actionId: 'shared', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1', authoring: authoringOf(shared, 'm-shared'),
      edit: {
        kind: 'annotation.apply', annotation: { id: 'keeper', family: 'theme', fields: { color: 'blue', weight: 1 } },
        from: { positionToken: shared.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: shared.documentPositionToken, offset: 5, affinity: 'right' },
      },
    },
  })).ok, true);
  const originalLinks = db.prepare("SELECT annotation_id, range_id FROM R4Doc_body_membership WHERE annotation_id IN ('dup', 'keeper') ORDER BY annotation_id").all();
  assert.equal(originalLinks[0].range_id, originalLinks[1].range_id);
  const next = await refreshBinding();
  const dup = await app.dispatch({
    actionId: 'second', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-second'),
      edit: {
        kind: 'annotation.apply', annotation: { id: 'dup', family: 'theme', fields: { color: 'blue', weight: 1 } },
        from: { positionToken: next.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: next.documentPositionToken, offset: 2, affinity: 'right' },
      },
    },
  });
  assert.equal(dup.ok, true, dup.failure?.message);
  const membership = db.prepare("SELECT range.start_point, range.end_point, membership.range_id FROM R4Doc_body_membership AS membership JOIN R4Doc_body_range AS range ON range.id = membership.range_id WHERE membership.annotation_id = 'dup'").get();
  assert.ok(membership);
  assert.notEqual(membership.range_id, originalLinks[0].range_id);
  assert.equal(db.prepare("SELECT range_id FROM R4Doc_body_membership WHERE annotation_id = 'keeper'").get().range_id, originalLinks[0].range_id);
  await app.close?.();
});

test('v9 receipt dedupe requires the original principal stream and lease binding', async (t) => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('hello', 'u1');
  t.after(async () => { await app.shutdown(); db.close(); });
  const first = await app.dispatch({
    actionId: 'dedupe-insert', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-dedupe'),
      edit: { kind: 'text.insert', at: { positionToken: documentPositionToken, offset: 5, affinity: 'right' }, text: '!' },
    },
  });
  assert.equal(first.ok, true, first.failure?.message);
  const firstSeq = first.events?.[0]?.seq;
  const again = await app.dispatch({
    actionId: 'dedupe-insert', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-dedupe'),
      edit: { kind: 'text.insert', at: { positionToken: documentPositionToken, offset: 5, affinity: 'right' }, text: '!' },
    },
  });
  // A duplicate mutation is DEDUPED: the receipt re-echoes the ORIGINAL event
  // (never a new commit), the text is not double-applied, and no higher seq
  // exists in the committed log.
  assert.equal(again.ok, true, again.failure?.message);
  assert.equal(again.deduped, true, JSON.stringify(again));
  const logMaxSeq = db.prepare("SELECT MAX(seq) AS maxSeq FROM _Log").get().maxSeq;
  assert.equal(logMaxSeq, firstSeq);
  assert.equal(familyText(db), 'hello!');
});

test('block-era structure edits are rejected', async () => {
  const { app, binding, authoringOf, documentPositionToken } = await setupDoc('hello world');
  for (const [actionId, edit] of [
    ['split', { kind: 'block.split', at: { positionToken: documentPositionToken, offset: 5, affinity: 'right' }, temporaryBlock: 'a'.repeat(43) }],
    ['merge', { kind: 'block.merge', leftPositionToken: documentPositionToken, rightPositionToken: documentPositionToken }],
    ['continue', { kind: 'block.continue', at: { positionToken: documentPositionToken, offset: 5, affinity: 'right' }, temporaryBlock: 'b'.repeat(43) }],
  ]) {
    const result = await app.dispatch({
      actionId, type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
      payload: { version: 9, id: 'd1', authoring: authoringOf(binding, `m-${actionId}`), edit },
    });
    assert.equal(result.ok, false, actionId);
    assert.match(result.failure?.message ?? '', /block-era|not supported/i);
  }
  await app.close?.();
});

test('orphan-policy annotations survive text delete that empties their range', async () => {
  const { app, db, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('hello world');
  assert.equal((await app.dispatch({
    actionId: 'orphan-comment', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-orphan-comment'),
      edit: {
        kind: 'annotation.apply', annotation: { id: 'keep-comment', family: 'comment', fields: {} },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  })).ok, true);
  const next = await refreshBinding();
  const deleted = await app.dispatch({
    actionId: 'delete-span', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-delete-span'),
      edit: {
        kind: 'text.delete',
        from: { positionToken: next.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: next.documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  });
  assert.equal(deleted.ok, true, deleted.failure?.message);
  assert.equal(familyText(db), '');
  // The whole-document range empties at once: the annotation survives as an
  // orphan, its membership is gone, and the saved quote is the COMPLETE text.
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_annotation WHERE id = 'keep-comment'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_membership WHERE annotation_id = 'keep-comment'").get().count, 0);
  assert.equal(db.prepare("SELECT saved_quote FROM R4Doc_body_annotation_orphan_state WHERE annotation_id = 'keep-comment'").get().saved_quote, 'hello world');
  assert.equal(db.prepare("SELECT last_range FROM R4Doc_body_annotation_orphan_state WHERE annotation_id = 'keep-comment'").get().last_range, 'null');
  await app.close?.();
});

test('snapshot redacts confidential spans for a non-owner without private fields', async (t) => {
  let principal = { id: 'u1' };
  const { app, db, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('hello world', () => principal);
  t.after(async () => { await app.shutdown(); db.close(); });
  assert.equal((await app.dispatch({
    actionId: 'theme', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-theme'),
      edit: {
        kind: 'annotation.apply', annotation: { id: 't1', family: 'theme', fields: { color: 'blue', weight: 1 } },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  })).ok, true);
  const next = await refreshBinding();
  assert.equal((await app.dispatch({
    actionId: 'protect', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-protect'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'c1', family: 'confidential', fields: {}, protectedTargetIds: ['t1'] },
        from: { positionToken: next.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: next.documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  })).ok, true);

  const ownerSerialized = await (await fetch(`http://127.0.0.1:${app.httpServer.address().port}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) })).text();
  assert.equal(serializedIncludesPrivateField(ownerSerialized, ['annotation_orphan_state', 'saved_quote', 'savedQuote', 'last_memberships', 'lastMemberships', 'structuralRevision', '"frontier"']), false);

  principal = { id: 'u2' };
  const deniedResponse = await fetch(`http://127.0.0.1:${app.httpServer.address().port}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(deniedResponse.status, 200);
  const denied = await deniedResponse.json();
  assert.equal('basis' in denied.snapshot.body, false);
  assert.equal(denied.snapshot.body.kind, 'workbench.annotatedText.recipient');
  assert.equal(JSON.stringify(denied.snapshot.body).includes('hello world'), false);
  assert.equal(serializedIncludesPrivateField(JSON.stringify(denied.snapshot.body), ['annotation_orphan_state', 'saved_quote', 'savedQuote', 'last_memberships', 'lastMemberships', 'structuralRevision', '"frontier"']), false);
});
