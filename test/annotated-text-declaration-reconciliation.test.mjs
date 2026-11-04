import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  admin, annotatedText, annotation, annotationAction, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, number as numberField, protectingAnnotation, read, ref, scope, subscribe, write,
} from '../build/internal.mjs';
import { annotatedTextCreateAction } from '../build/annotated-text-action.mjs';
import { projectAnnotatedTextSnapshot } from '../build/annotated-text-snapshot.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';
import { createAnnotatedTextHttpSession, materializeAnnotatedTextSnapshot } from '../public/workbench-client.mjs';
import { restoreTextFamily } from '../public/workbench-annotated-text-continuous.mjs';

const protectingAccess = async ({ is }) => (await is.owner()) ? grant(read) : grant();

function docDecl({ ownerOnly = false } = {}) {
  return entity('ReconDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('timing', {
          fields: {
            startMs: numberField({ validate: (value) => Number.isSafeInteger(value) && value >= 0 }),
            durationMs: numberField({ validate: (value) => Number.isSafeInteger(value) && value >= 0 }),
          },
          actions: {
            correct: annotationAction({
              input: {
                startMs: numberField({ validate: (value) => Number.isSafeInteger(value) && value >= 0 }),
                durationMs: numberField({ validate: (value) => Number.isSafeInteger(value) && value >= 0 }),
              },
              change({ input }) { return { fields: input }; },
            }),
          },
        }),
        annotation('transcriptionConfidence', {
          fields: { confidence: numberField({ validate: (value) => typeof value === 'number' && value >= 0 && value <= 1 }) },
          actions: {
            revise: annotationAction({
              input: { confidence: numberField({ validate: (value) => typeof value === 'number' && value >= 0 && value <= 1 }) },
              change({ input }) { return { fields: input }; },
            }),
          },
        }),
        annotation('comment', { empty: 'orphan' }),
        annotation('sensitive', { empty: 'delete' }),
        protectingAnnotation('confidential', { protects: 'sensitive', placeholder: '[REDACTED]', access: protectingAccess }),
      ],
    }).can(() => grant(read, write, subscribe)),
    applicationHttpActions: ['create', 'update', 'remove'],
    grant: [scope(() => everyone()).can(ownerOnly
      ? async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : grant()
      : () => grant(read, write, subscribe))],
  });
}

async function boot({ ownerOnly = false } = {}) {
  const db = new DatabaseSync(':memory:');
  const Doc = docDecl({ ownerOnly });
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write, subscribe, admin))],
  });
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1'), ('u2')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(Doc, db);
  const principalOf = (request) => {
    const url = new URL(request.url, 'http://local');
    return url.searchParams.get('viewAs') === 'u2'
      ? { type: 'user', id: 'u2', attributes: {} }
      : { type: 'user', id: 'u1', attributes: {} };
  };
  const app = workbench({ db, entities: [Project, Doc], log: { level: 'warn' } });
  app.attachLiveDelivery({ principalOf });
  app.listen(0, { principalOf });
  await app.ready;
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const create = annotatedTextCreateAction(Doc, Doc.body, { id: 'd1', projectId: 'p1', ownerId: 'u1' });
  const created = await fetch(`${origin}/workbench/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId: 'create', ...create, clientId: 'tab-a' }),
  });
  if (created.status !== 200) {
    const failure = await created.text();
    app.httpServer.closeAllConnections?.();
    await app.shutdown();
    db.close();
    assert.fail(`create failed: ${failure}`);
  }
  const binding = await withAuthoringBinding({
    db, entity: Doc, Document: Doc, row: db.prepare("SELECT * FROM ReconDoc WHERE id = 'd1'").get(),
    principal: { id: 'u1' }, fieldName: 'body', descriptor: Doc.fields.body,
  });
  const inserted = await app.dispatch({
    actionId: 'seed-text', type: 'ReconDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: 'seed-text' },
      edit: {
        kind: 'text.insert',
        at: { positionToken: binding.documentPositionToken, offset: 0, affinity: 'right' },
        text: 'hello world',
      },
    },
  });
  assert.equal(inserted.ok, true, inserted.failure?.message);
  return { app, db, Doc, origin, transferDocumentOwnership() { db.prepare("UPDATE ReconDoc SET owner = 'u2' WHERE id = 'd1'").run(); } };
}

function makeSession({ Doc, origin, viewAs = null, sources }) {
  let actionNumber = 0;
  return createAnnotatedTextHttpSession({
    baseUrl: `${origin}/live-delivery`,
    context: { entity: Doc, field: Doc.body, documentId: 'd1', ...(viewAs ? { viewAs } : {}) },
    historySession: 'tab-a',
    createActionId: () => `client-${++actionNumber}`,
    eventSourceFactory: (url) => {
      const controller = new AbortController();
      const source = {
        close() { controller.abort(); }, onmessage: null, onerror: null, frames: [],
      };
      sources.push(source);
      void (async () => {
        try {
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok || !response.body) {
            source.onerror?.(new Error(`SSE HTTP ${response.status}`));
            return;
          }
          source.connected = true;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) { source.ended = true; break; }
            buffer += decoder.decode(value, { stream: true });
            let separator;
            while ((separator = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, separator);
              buffer = buffer.slice(separator + 2);
              const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
              if (!dataLine) continue;
              const data = dataLine.slice('data: '.length);
              try { source.frames.push(JSON.parse(data)); } catch { source.frames.push({ malformed: true }); }
              source.onmessage?.({ data });
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) source.onerror?.(error);
        }
      })();
      return source;
    },
  });
}

async function freshRecipient(ctx, principalId = 'u1') {
  const row = ctx.db.prepare("SELECT * FROM ReconDoc WHERE id = 'd1'").get();
  const family = restoreTextFamily(JSON.parse(
    ctx.db.prepare("SELECT family_checkpoint FROM ReconDoc_body_state WHERE document_id = 'd1'").get().family_checkpoint,
  ));
  return materializeAnnotatedTextSnapshot(await projectAnnotatedTextSnapshot({
    db: ctx.db, entity: ctx.Doc, row, principal: { type: 'user', id: principalId, attributes: {} },
    fieldName: 'body', descriptor: ctx.Doc.fields.body, mintBasis: false,
  }), ctx.Doc.body, { family });
}

async function assertMatchesFresh(ctx, session, principalId = 'u1') {
  const fresh = await freshRecipient(ctx, principalId);
  assert.equal(session.document.text, fresh.text);
  assert.deepEqual(session.document.annotations, fresh.annotations);
  assert.deepEqual(session.document.ranges, fresh.ranges);
  assert.deepEqual(session.document.orphans, fresh.orphans);
  assert.deepEqual(session.document.measurements, fresh.measurements);
  return fresh;
}

test('own echo and foreign declaration actions reconcile through the real Deliver-loop', async (t) => {
  const ctx = await boot();
  t.after(async () => { ctx.app.httpServer.closeAllConnections?.(); await ctx.app.shutdown(); ctx.db.close(); });
  const sources = [];
  const session = makeSession({ ...ctx, sources });
  await session.ready;

  const correct = await session.applyAnnotationAction(ctx.Doc.body.annotations.timing.actions.correct, {
    mutationId: 'own-correct', from: { offset: 0, affinity: 'right' }, to: { offset: 5, affinity: 'left' },
    values: { startMs: 0, durationMs: 999 },
  });
  assert.equal(correct.ok, true, correct.failure?.message);
  await assertMatchesFresh(ctx, session);

  const foreignBinding = await withAuthoringBinding({
    db: ctx.db, entity: ctx.Doc, Document: ctx.Doc, row: ctx.db.prepare("SELECT * FROM ReconDoc WHERE id = 'd1'").get(),
    principal: { id: 'u1' }, fieldName: 'body', descriptor: ctx.Doc.fields.body,
  });
  const foreign = await ctx.app.dispatch({
    actionId: 'foreign-revise', type: 'ReconDoc.body.transcriptionConfidence.revise', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', basis: foreignBinding.documentPositionToken, mutationId: 'revise', from: 0, to: 5, values: { confidence: 0.5 } },
  });
  assert.equal(foreign.ok, true, foreign.failure?.message);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await assertMatchesFresh(ctx, session);
  assert.ok(
    sources.flatMap((source) => source.frames.flat()).some(
      (frame) => frame?.type === 'state' && frame.authoring?.family,
    ),
    'the real Deliver loop must deliver an authoritative state and family for annotation-only events',
  );
  session.close();
});

test('malformed, gap, and reconnect recovery all return to the fresh authorized snapshot', async (t) => {
  const ctx = await boot();
  t.after(async () => { ctx.app.httpServer.closeAllConnections?.(); await ctx.app.shutdown(); ctx.db.close(); });
  const sources = [];
  const session = makeSession({ ...ctx, sources });
  await session.ready;

  sources.at(-1).onmessage({ data: 'not-json{' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await session.ready;
  await assertMatchesFresh(ctx, session);

  sources.at(-1).onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'ReconDoc', id: 'd1', seq: 999, seqSpan: [999, 999],
    event: { type: 'ReconDoc.body.operated', data: {}, seq: 999 },
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await session.ready;
  await assertMatchesFresh(ctx, session);

  await session.reconnect();
  await session.ready;
  await assertMatchesFresh(ctx, session);
  session.close();
});

test('a denied protecting recipient recovers a snapshot that never leaks annotation details', async (t) => {
  const ctx = await boot();
  t.after(async () => { ctx.app.httpServer.closeAllConnections?.(); await ctx.app.shutdown(); ctx.db.close(); });
  const binding = await withAuthoringBinding({
    db: ctx.db, entity: ctx.Doc, Document: ctx.Doc, row: ctx.db.prepare("SELECT * FROM ReconDoc WHERE id = 'd1'").get(),
    principal: { id: 'u1' }, fieldName: 'body', descriptor: ctx.Doc.fields.body,
  });
  const sensitiveApply = await ctx.app.dispatch({
    actionId: 'sensitive-apply', type: 'ReconDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: 'sensitive-apply' },
      edit: {
        kind: 'annotation.apply', annotation: { id: 'sensitive-1', family: 'sensitive', fields: {} },
        from: { positionToken: binding.documentPositionToken, offset: 6, affinity: 'left' },
        to: { positionToken: binding.documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  });
  assert.equal(sensitiveApply.ok, true, sensitiveApply.failure?.message);
  const protectedApply = await ctx.app.dispatch({
    actionId: 'confidential-apply', type: 'ReconDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: 'confidential-apply' },
      edit: {
        kind: 'annotation.apply', annotation: { id: 'conf-1', family: 'confidential', fields: {}, protectedTargetIds: ['sensitive-1'] },
        from: { positionToken: binding.documentPositionToken, offset: 6, affinity: 'left' },
        to: { positionToken: binding.documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  });
  assert.equal(protectedApply.ok, true, protectedApply.failure?.message);

  const sources = [];
  const session = makeSession({ ...ctx, viewAs: 'u2', sources });
  await session.ready;
  assert.equal(session.document.annotations.some((entry) => entry.family === 'confidential'), false);
  assert.equal(session.document.annotations.some((entry) => entry.family === 'sensitive'), false);
  assert.equal(session.document.ranges.some((entry) => entry.annotationId === 'conf-1'), false);
  await assertMatchesFresh(ctx, session, 'u2');
  session.close();
});

test('document access is re-authorized before each live delivery batch', async (t) => {
  const ctx = await boot({ ownerOnly: true });
  t.after(async () => { ctx.app.httpServer.closeAllConnections?.(); await ctx.app.shutdown(); ctx.db.close(); });
  const sources = [];
  const session = makeSession({ ...ctx, sources });
  await session.ready;
  const connectedDeadline = Date.now() + 2_000;
  while (!sources[0].connected && Date.now() < connectedDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sources[0].connected, true, 'the live stream must be connected before revocation');
  ctx.transferDocumentOwnership();
  const binding = await withAuthoringBinding({
    db: ctx.db, entity: ctx.Doc, Document: ctx.Doc, row: ctx.db.prepare("SELECT * FROM ReconDoc WHERE id = 'd1'").get(),
    principal: { id: 'u2' }, fieldName: 'body', descriptor: ctx.Doc.fields.body,
  });
  const deliveredBeforeRevocation = sources[0].frames.length;
  const committed = await ctx.app.dispatch({
    actionId: 'post-revoke', type: 'ReconDoc.body.transcriptionConfidence.revise', scope: 'Project:p1', principal: { id: 'u2' },
    payload: { version: 1, id: 'd1', basis: binding.documentPositionToken, mutationId: 'post-revoke', from: 0, to: 5, values: { confidence: 0.25 } },
  });
  assert.equal(committed.ok, true, committed.failure?.message);
  const deadline = Date.now() + 2_000;
  while (!sources[0].ended && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sources[0].ended, true, 'revoked document access must terminate the live stream');
  assert.equal(sources[0].frames.length, deliveredBeforeRevocation, 'the denied event must not be delivered');
  session.close();
});
