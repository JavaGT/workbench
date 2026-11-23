// Wave 3b (#292): annotatedText RGA/checkpoint performance, fast-path visible
// edit/fold & shared visible snapshots, and Scope2 admission/rebase semantics.

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, entity, everyone, executeDDL, executeFrameworkDDL,
  protectingAnnotation, grant, admin, read, ref, scope, text, write, durableHistory,
} from '../build/internal.mjs';
import {
  applyTextOp,
  buildRgaPieces,
  compactTextCheckpoint,
  createTextState,
  materializeText as materializeStateText,
  restoreTextCheckpoint,
  textCheckpoint,
  textStateElementCount,
  textStateMaxLamport,
} from '../build/annotated-text.mjs';
import {
  applyTextOperation,
  importTextToFamily,
  materializeRange,
  materializeText,
  projectEndpointToOffset,
  resolveOffsetToEndpoint,
  restoreTextFamilySerialized,
  textFamilyElementCount,
  textFamilyMaxLamport,
  textOperationForOffsetEdit,
} from '../build/annotated-text-continuous.mjs';
import { rgaTraversal } from '../build/annotated-text-family.mjs';
import {
  evaluateAnnotatedTextVisibility,
  projectAnnotatedTextSnapshot,
} from '../build/annotated-text-snapshot.mjs';
import { tryBuildAnnotatedTextFoldEnvelopes } from '../build/annotated-text-fold-envelope.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

function actorHex(index) {
  return (index + 1).toString(16).padStart(32, '0');
}

// ---------------------------------------------------------------------------
// Pillar 1: RGA & Checkpoint Performance
// ---------------------------------------------------------------------------

test('restoreCompactTextCheckpoint replays shuffled causal chains linearly in O(ops) and fails closed on broken deps', () => {
  const actorA = actorHex(1);
  const actorB = actorHex(2);
  let state = createTextState();
  state = applyTextOp(state, ['workbench.text', 1, [actorA, 1], 1, [], ['insert', ['root'], 'seed']]);
  let expected = 'seed';
  let countA = 1;
  let countB = 0;
  let lastOp = [actorA, 1];
  const N = 600;
  for (let i = 2; i <= N; i += 1) {
    const useA = i % 2 === 0;
    const actor = useA ? actorA : actorB;
    const nextCounter = useA ? (countA += 1) : (countB += 1);
    const op = ['workbench.text', 1, [actor, nextCounter], i, state.frontier, ['insert', ['element', [lastOp, 0]], 'x']];
    state = applyTextOp(state, op);
    lastOp = [actor, nextCounter];
    expected += 'x';
  }
  assert.equal(materializeStateText(state).length, expected.length);
  assert.equal(textStateMaxLamport(state), N);
  assert.equal(textStateElementCount(state), expected.length);

  // Shuffle the compact checkpoint's operations object into worst-case reverse order.
  const compact = compactTextCheckpoint(state);
  const reversedOps = Object.fromEntries(Object.entries(compact.operations).reverse());
  const shuffled = { ...compact, operations: reversedOps };

  const started = performance.now();
  const restored = restoreTextCheckpoint(shuffled);
  const elapsedMs = performance.now() - started;

  assert.equal(materializeStateText(restored), materializeStateText(state));
  assert.deepEqual(restored.frontier, state.frontier);
  assert.equal(textStateMaxLamport(restored), N);
  assert.equal(textStateElementCount(restored), expected.length);
  assert.ok(elapsedMs < 1000, `expected linear O(ops) compact restore of ${N} ops, took ${elapsedMs.toFixed(1)}ms`);

  // Missing dependency fails closed.
  const brokenOps = { ...reversedOps };
  delete brokenOps[`${actorA}:1`];
  assert.throws(
    () => restoreTextCheckpoint({ ...compact, operations: brokenOps }),
    /not causally reducible/,
  );

  // Out-of-range anchor ordinal fails closed.
  const badAnchorOp = ['workbench.text', 1, [actorHex(99), 1], N + 1, state.frontier, ['insert', ['element', [[actorA, 1], 999]], 'z']];
  const badOps = {
    ...compact.operations,
    [`${actorHex(99)}:1`]: { digest: JSON.stringify(badAnchorOp), op: badAnchorOp },
  };
  assert.throws(
    () => restoreTextCheckpoint({ ...compact, frontier: [...compact.frontier, [actorHex(99), 1]].sort(([l], [r]) => (l < r ? -1 : 1)), operations: badOps }),
    /not causally reducible/,
  );
});

test('200k-char transcript import, edits, maxLamport, and endpoint projection stay fast and exact', () => {
  const actor0 = actorHex(0);
  const baseText = 'The quick brown fox jumps over the lazy dog. '.repeat(4445); // ~200,025 chars (~36k words)
  assert.ok(baseText.length >= 200_000);

  const t0 = performance.now();
  let family = importTextToFamily('big-doc', actor0, baseText);
  const importMs = performance.now() - t0;
  assert.equal(materializeText(family).length, baseText.length);
  assert.equal(textFamilyMaxLamport(family), 1);
  assert.equal(textFamilyElementCount(family), baseText.length);

  // Anchor a span near the middle before editing.
  const spanStart = resolveOffsetToEndpoint(family, 100_000, family.checkpoint.frontier, 'left');
  const spanEnd = resolveOffsetToEndpoint(family, 100_040, family.checkpoint.frontier, 'right');
  const originalSlice = baseText.slice(100_000, 100_040);
  assert.equal(materializeRange(family, spanStart, spanEnd), originalSlice);

  let expectedText = baseText;
  const t1 = performance.now();
  for (let i = 1; i <= 50; i += 1) {
    const actor = actorHex(100 + i);
    const lamport = textFamilyMaxLamport(family) + 1;
    if (i % 5 === 0) {
      const from = i * 500;
      const to = from + 3;
      const op = textOperationForOffsetEdit(family, { kind: 'text.delete', from: { offset: from }, to: { offset: to } }, actor, lamport);
      family = applyTextOperation(family, op);
      expectedText = expectedText.slice(0, from) + expectedText.slice(to);
    } else {
      const at = i * 500;
      const inserted = 'ab';
      const op = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: at, affinity: 'right' }, text: inserted }, actor, lamport);
      family = applyTextOperation(family, op);
      expectedText = expectedText.slice(0, at) + inserted + expectedText.slice(at);
    }
  }
  const editsMs = performance.now() - t1;

  assert.equal(materializeText(family), expectedText);
  // 1 initial insert + 40 insert edits create elements (10 deletes tombstone existing elements).
  assert.equal(textFamilyMaxLamport(family), 41);
  assert.equal(materializeRange(family, spanStart, spanEnd), originalSlice);
  // 40 inserts (+2 each = +80) and 10 deletes (-3 each = -30) all occurred before offset 100,000 => net +50.
  assert.equal(projectEndpointToOffset(family, spanStart), 100_050);
  assert.equal(projectEndpointToOffset(family, spanEnd), 100_090);
  assert.ok(importMs < 1000, `importTextToFamily(200k) took ${importMs.toFixed(1)}ms`);
  assert.ok(editsMs < 1000, `50 edits on 200k-char doc took ${editsMs.toFixed(1)}ms`);
});

test('run/piece traversal matches scalar rgaTraversal with concurrent inserts, inverted lamports, deletes, and astral scalars', () => {
  const A = actorHex(10);
  const B = actorHex(11);
  const C = actorHex(12);
  let state = createTextState();
  state = applyTextOp(state, ['workbench.text', 1, [A, 1], 5, [], ['insert', ['root'], 'a😀bc']]);
  // Concurrent insert with LOWER lamport than parent run (tests piece-split ordering).
  state = applyTextOp(state, ['workbench.text', 1, [B, 1], 2, [[A, 1]], ['insert', ['element', [[A, 1], 1]], '🌟']]);
  // Concurrent insert with HIGHER lamport at same anchor.
  state = applyTextOp(state, ['workbench.text', 1, [C, 1], 9, [[A, 1]], ['insert', ['element', [[A, 1], 1]], 'X']]);
  // Delete the emoji in A:1 (ordinal 1) and 'b' (ordinal 2).
  state = applyTextOp(state, ['workbench.text', 1, [A, 2], 10, state.frontier, ['delete', [[[A, 1], 1, 2]]]]);

  const scalarOrder = rgaTraversal(textCheckpoint(state));
  const scalarText = scalarOrder.filter(([, el]) => el.deletedBy.length === 0).map(([, el]) => el.scalar).join('');
  const pieceText = buildRgaPieces(state).filter((p) => !p.deleted).map((p) => p.text).join('');
  assert.equal(pieceText, scalarText);
  assert.equal(materializeStateText(state), scalarText);
});

// ---------------------------------------------------------------------------
// Pillar 2: Fast-path visible edit/fold & shared visible snapshots
// ---------------------------------------------------------------------------

test('shared visible snapshot cache reuses projection across 15 recipients and invalidates on every mutation', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('owner'), ('reader')");
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write, admin))],
  });
  const Doc = entity('SharedSnapDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('code', { fields: { label: text() }, empty: 'orphan' }),
        protectingAnnotation('secret', {
          protects: 'code',
          placeholder: '[REDACTED]',
          access: async ({ is }) => ((await is.owner()) ? grant(read) : grant()),
        }),
      ],
    }).can(async ({ principal }) => (principal?.id?.startsWith('ro-') ? grant(read) : grant(read, write))),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'owner')");
  executeDDL(Doc, db);

  const app = workbench({ db, entities: [Project, Doc], history: durableHistory({ authorize: () => true, actions: {} }) });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });

  const bodyText = 'alpha beta gamma delta epsilon '.repeat(200);
  const ranges = Array.from({ length: 1000 }, (_, i) => ({
    annotationId: `c-${i}`,
    family: 'code',
    start: i * 5,
    end: i * 5 + 4,
    fields: { label: `L${i % 10}` },
  }));
  const created = await app.dispatch({
    actionId: 'create',
    type: 'SharedSnapDoc.create',
    principal: { type: 'user', id: 'owner', attributes: {} },
    payload: {
      id: 'd1',
      project: 'p1',
      owner: 'owner',
      body: { version: 1, blocks: [{ text: bodyText }], ranges },
    },
  });
  assert.equal(created.ok, true, created.failure?.message);

  const entityRec = app.entities.get('SharedSnapDoc');
  const row = db.prepare('SELECT * FROM SharedSnapDoc WHERE id = ?').get('d1');

  // First recipient warms the cache; next 14 recipients reuse the exact frozen v3 wire object.
  let cacheHits = 0;
  let fullSqlLoads = 0;
  const cold = await projectAnnotatedTextSnapshot({
    db, entity: entityRec, row, principal: { type: 'user', id: 'w-0', attributes: {} },
    fieldName: 'body', descriptor: entityRec.fields.body, mintBasis: false,
    profile(phase) {
      if (phase === 'annotation SQL, row load, and decode') fullSqlLoads += 1;
      if (phase === 'shared snapshot cache hit') cacheHits += 1;
    },
  });
  assert.equal(cold.version, 3);
  assert.equal(cold.annotations.length, 1000);
  assert.equal(fullSqlLoads, 1);
  assert.equal(cacheHits, 0);

  for (let i = 1; i <= 14; i += 1) {
    const snap = await projectAnnotatedTextSnapshot({
      db, entity: entityRec, row, principal: { type: 'user', id: `w-${i}`, attributes: {} },
      fieldName: 'body', descriptor: entityRec.fields.body, mintBasis: false,
      profile(phase) {
        if (phase === 'annotation SQL, row load, and decode') fullSqlLoads += 1;
        if (phase === 'shared snapshot cache hit') cacheHits += 1;
      },
    });
    assert.equal(snap, cold, 'identically-visible recipients with same capabilities must share one frozen v3 payload');
  }
  assert.equal(fullSqlLoads, 1, '15 recipients must share ONE SQLite annotation load');
  assert.equal(cacheHits, 14);

  // Fields-only annotation.update does not increment structure_version, but MUST invalidate the cache!
  const binding = await withAuthoringBinding({
    db, entity: entityRec, Document: entityRec, row,
    principal: { type: 'user', id: 'owner', attributes: {} }, fieldName: 'body', descriptor: entityRec.fields.body,
  });
  const updated = await app.dispatch({
    actionId: 'update-c0',
    type: 'SharedSnapDoc.body.operation',
    scope: 'Project:p1',
    principal: { type: 'user', id: 'owner', attributes: {} },
    payload: {
      version: 9,
      id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: 'update-c0' },
      edit: { kind: 'annotation.update', annotationId: 'c-0', fields: { label: 'UPDATED' } },
    },
  });
  assert.equal(updated.ok, true, updated.failure?.message);
  const afterUpdate = await projectAnnotatedTextSnapshot({
    db, entity: entityRec, row, principal: { type: 'user', id: 'w-1', attributes: {} },
    fieldName: 'body', descriptor: entityRec.fields.body, mintBasis: false,
  });
  assert.notEqual(afterUpdate, cold);
  assert.equal(afterUpdate.annotations.find((a) => a.id === 'c-0')?.fields.label, 'UPDATED');

  // Lightweight visibility evaluator skips loading the 1000 non-protecting annotations.
  const vis = await evaluateAnnotatedTextVisibility({
    db, entity: entityRec, row, principal: { type: 'user', id: 'reader', attributes: {} },
    fieldName: 'body', descriptor: entityRec.fields.body,
  });
  assert.equal(vis.fullyVisible, true);
  assert.equal(vis.restricted, false);
  assert.deepEqual(vis.redactions, []);

  // Adding a protector without changing text invalidates both cache and visibility fast-path.
  const bind2 = await withAuthoringBinding({
    db, entity: entityRec, Document: entityRec, row,
    principal: { type: 'user', id: 'owner', attributes: {} }, fieldName: 'body', descriptor: entityRec.fields.body,
  });
  const protect = await app.dispatch({
    actionId: 'add-protector',
    type: 'SharedSnapDoc.body.operation',
    scope: 'Project:p1',
    principal: { type: 'user', id: 'owner', attributes: {} },
    payload: {
      version: 9,
      id: 'd1',
      authoring: { version: 1, stream: bind2.streamToken, lease: bind2.leaseToken, mutationId: 'add-protector' },
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'prot-1', family: 'secret', fields: {}, protectedTargetIds: ['c-0'] },
        from: { positionToken: bind2.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: bind2.documentPositionToken, offset: 4, affinity: 'right' },
      },
    },
  });
  assert.equal(protect.ok, true, protect.failure?.message);

  // Denied reader sees redaction; owner stays fully visible!
  const readerVis = await evaluateAnnotatedTextVisibility({
    db, entity: entityRec, row, principal: { type: 'user', id: 'reader', attributes: {} },
    fieldName: 'body', descriptor: entityRec.fields.body,
  });
  assert.equal(readerVis.fullyVisible, false);
  assert.equal(readerVis.redactions.length, 1);
  assert.deepEqual(readerVis.redactions[0], { visibleStart: 0, start: 0, end: 4 });

  const ownerVis = await evaluateAnnotatedTextVisibility({
    db, entity: entityRec, row, principal: { type: 'user', id: 'owner', attributes: {} },
    fieldName: 'body', descriptor: entityRec.fields.body,
  });
  assert.equal(ownerVis.fullyVisible, true);

  // Mixed visibility snapshot: owner gets v3, reader gets v1 redacted (no secret leak).
  const ownerSnap = await projectAnnotatedTextSnapshot({
    db, entity: entityRec, row, principal: { type: 'user', id: 'owner', attributes: {} },
    fieldName: 'body', descriptor: entityRec.fields.body, mintBasis: false,
  });
  const readerSnap = await projectAnnotatedTextSnapshot({
    db, entity: entityRec, row, principal: { type: 'user', id: 'reader', attributes: {} },
    fieldName: 'body', descriptor: entityRec.fields.body, mintBasis: false,
  });
  assert.equal(ownerSnap.version, 3);
  assert.equal(readerSnap.version, 1);
  assert.equal(readerSnap.redactions.length, 1);
  assert.equal(readerSnap.text.startsWith('a beta'), true);

  // Live fold fast-path: text edit folds for owner (fully visible) and returns resync for reader (redacted).
  const bind3 = await withAuthoringBinding({
    db, entity: entityRec, Document: entityRec, row,
    principal: { type: 'user', id: 'owner', attributes: {} }, fieldName: 'body', descriptor: entityRec.fields.body,
  });
  const inserted = await app.dispatch({
    actionId: 'edit-tail',
    type: 'SharedSnapDoc.body.operation',
    scope: 'Project:p1',
    principal: { type: 'user', id: 'owner', attributes: {} },
    payload: {
      version: 9,
      id: 'd1',
      authoring: { version: 1, stream: bind3.streamToken, lease: bind3.leaseToken, mutationId: 'edit-tail' },
      edit: { kind: 'text.insert', at: { positionToken: bind3.documentPositionToken, offset: 20, affinity: 'right' }, text: 'Z' },
    },
  });
  assert.equal(inserted.ok, true, inserted.failure?.message);
  const logRow = db.prepare("SELECT * FROM _Log WHERE eventType = 'SharedSnapDoc.body.operated' ORDER BY seq DESC LIMIT 1").get();
  const foldEvent = { ...logRow, data: JSON.parse(logRow.eventData) };
  const foldDoc = { entity: entityRec, documentId: 'd1', fieldName: 'body', descriptor: entityRec.fields.body, clientNonce: 'n'.repeat(43) };

  const ownerFold = await tryBuildAnnotatedTextFoldEnvelopes(
    { event: foldEvent, scope: 'Project:p1', principal: { type: 'user', id: 'owner', attributes: {} } },
    { db, document: foldDoc },
  );
  assert.equal(ownerFold[0].type, 'event');
  assert.equal(ownerFold[0].fold.version, 5);
  assert.equal(ownerFold[0].fold.familyElementCount, bodyText.length + 1);

  const readerFold = await tryBuildAnnotatedTextFoldEnvelopes(
    { event: foldEvent, scope: 'Project:p1', principal: { type: 'user', id: 'reader', attributes: {} } },
    { db, document: foldDoc },
  );
  assert.equal(readerFold[0].type, 'resync');
});

// ---------------------------------------------------------------------------
// Pillar 3: Scope2 Admission (`includeWording`, content-sensitive diff, rebase)
// ---------------------------------------------------------------------------

test('annotatedTextAdmission with includeWording detects interior text edits, ignores pure offset shifts, and rolls back refusals', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('alice')");
  const Project = entity('Project', {
    owner: ref('User'),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  const Transcript = entity('WordingTranscript', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [annotation('codes', { appliesTo: 'text-range', cardinality: 'many', fields: { code: text() }, empty: 'orphan' })],
    }).can(() => grant(read, write)),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'alice')");
  executeDDL(Transcript, db);

  const changes = [];
  let refuseNext = false;
  const app = workbench({
    db,
    entities: [Project, Transcript],
    annotatedTextAdmission: {
      families: ['codes'],
      includeWording: true,
      admit(change) {
        changes.push(change);
        if (refuseNext) return false;
        return true;
      },
    },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });

  const alice = { type: 'user', id: 'alice', attributes: {} };
  const created = await app.dispatch({
    actionId: 'create',
    type: 'WordingTranscript.create',
    principal: alice,
    payload: { id: 'd1', project: 'p1', owner: 'alice', body: { version: 1, blocks: [{ text: 'I 😀 felt ignored.' }] } },
  });
  assert.equal(created.ok, true, created.failure?.message);
  const docEntity = app.entities.get('WordingTranscript');

  async function edit(actionId, makeEdit) {
    const bind = await withAuthoringBinding({
      db, entity: docEntity, Document: docEntity,
      row: db.prepare("SELECT * FROM WordingTranscript WHERE id = 'd1'").get(),
      principal: alice, fieldName: 'body', descriptor: docEntity.fields.body,
    });
    const at = (offset, affinity) => ({ positionToken: bind.documentPositionToken, offset, affinity });
    return app.dispatch({
      actionId, principal: alice, scope: 'Project:p1', type: 'WordingTranscript.body.operation',
      payload: {
        version: 9, id: 'd1',
        authoring: { version: 1, stream: bind.streamToken, lease: bind.leaseToken, mutationId: actionId },
        edit: makeEdit(at),
      },
    });
  }

  // Apply code over "felt ignored" (UTF-16 offsets 5..17 because "😀" is 2 UTF-16 units).
  const applied = await edit('apply-c1', (at) => ({
    kind: 'annotation.apply',
    annotation: { id: 'c1', family: 'codes', fields: { code: 'empathy' } },
    from: at(5, 'left'),
    to: at(17, 'right'),
  }));
  assert.equal(applied.ok, true, applied.failure?.message);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].before, null);
  assert.deepEqual(changes[0].after.wording, [{ ordinal: 0, start: 5, end: 17, text: 'felt ignored' }]);

  // Insert strictly OUTSIDE the span ("really " at offset 5 with left affinity -> before "felt").
  // Shifts UTF-16 offsets to 12..24 without altering wording text => admit MUST NOT fire!
  const outside = await edit('outside-shift', (at) => ({
    kind: 'text.insert', at: at(5, 'left'), text: 'really ',
  }));
  assert.equal(outside.ok, true, outside.failure?.message);
  assert.equal(changes.length, 1, 'pure offset shift outside coded span must not trigger admit');

  // Insert INSIDE the span ("often " after "felt " at offset 17) => wording changes => admit MUST fire!
  const inside = await edit('inside-edit', (at) => ({
    kind: 'text.insert', at: at(17, 'right'), text: 'often ',
  }));
  assert.equal(inside.ok, true, inside.failure?.message);
  assert.equal(changes.length, 2, 'interior wording change must reach admit even though endpoints did not change');
  assert.deepEqual(changes[1].before.wording, [{ ordinal: 0, start: 12, end: 24, text: 'felt ignored' }]);
  assert.deepEqual(changes[1].after.wording, [{ ordinal: 0, start: 12, end: 30, text: 'felt often ignored' }]);

  // Refusing an interior edit rolls back the text change completely.
  refuseNext = true;
  const refused = await edit('refused-inside', (at) => ({
    kind: 'text.insert', at: at(17, 'right'), text: 'BAD ',
  }));
  assert.equal(refused.ok, false);
  const cp = db.prepare("SELECT family_checkpoint FROM WordingTranscript_body_state WHERE document_id = 'd1'").get();
  assert.equal(materializeText(restoreTextFamilySerialized(cp.family_checkpoint)), 'I 😀 really felt often ignored.');
  refuseNext = false;

  // Deleting the whole span orphans the annotation => after.wording is [] and after.orphan carries savedQuote.
  const collapsed = await edit('collapse-span', (at) => ({
    kind: 'text.delete', from: at(12, 'left'), to: at(30, 'right'),
  }));
  assert.equal(collapsed.ok, true, collapsed.failure?.message);
  const last = changes.at(-1);
  assert.deepEqual(last.before.wording, [{ ordinal: 0, start: 12, end: 30, text: 'felt often ignored' }]);
  assert.deepEqual(last.after.wording, []);
  assert.equal(last.after.orphan?.savedQuote, 'felt often ignored');
});

test('stale plain text.insert rebases on fully-visible documents while destructive edits, anchor deletion, and redacted docs fail closed', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('u1'), ('u2')");
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write, admin))],
  });
  const Doc = entity('RebaseDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('theme'),
        protectingAnnotation('confidential', {
          protects: 'theme',
          placeholder: '[REDACTED]',
          access: async ({ is }) => ((await is.owner()) ? grant(read) : grant()),
        }),
      ],
    }).can(() => grant(read, write)),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(Doc, db);

  const app = workbench({ db, entities: [Project, Doc], history: durableHistory({ authorize: () => true, actions: {} }) });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });

  const u1 = { type: 'user', id: 'u1', attributes: {} };
  const u2 = { type: 'user', id: 'u2', attributes: {} };
  const created = await app.dispatch({
    actionId: 'create', type: 'RebaseDoc.create', principal: u1,
    payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello world' }] } },
  });
  assert.equal(created.ok, true, created.failure?.message);
  const docEntity = app.entities.get('RebaseDoc');

  const bindFor = (principal) => withAuthoringBinding({
    db, entity: docEntity, Document: docEntity,
    row: db.prepare("SELECT * FROM RebaseDoc WHERE id = 'd1'").get(),
    principal, fieldName: 'body', descriptor: docEntity.fields.body,
  });
  const dispatchWith = (actionId, principal, bind, edit) => app.dispatch({
    actionId, principal, scope: 'Project:p1', type: 'RebaseDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: bind.streamToken, lease: bind.leaseToken, mutationId: actionId },
      edit,
    },
  });
  const currentText = () => materializeText(restoreTextFamilySerialized(
    db.prepare("SELECT family_checkpoint FROM RebaseDoc_body_state WHERE document_id = 'd1'").get().family_checkpoint,
  ));

  // Both u1 and u2 capture position frames against "hello world".
  const bindU1 = await bindFor(u1);
  const bindU2 = await bindFor(u2);

  // u1 inserts "PREFIX " at offset 0 -> "PREFIX hello world".
  const first = await dispatchWith('u1-prefix', u1, bindU1, {
    kind: 'text.insert',
    at: { positionToken: bindU1.documentPositionToken, offset: 0, affinity: 'right' },
    text: 'PREFIX ',
  });
  assert.equal(first.ok, true, first.failure?.message);
  assert.equal(currentText(), 'PREFIX hello world');

  // u2 submits a stale plain text.insert at offset 11 (after 'd' in "hello world") using old token ->
  // must rebase cleanly to offset 18 ("PREFIX hello world!")!
  const rebased = await dispatchWith('u2-stale-insert', u2, bindU2, {
    kind: 'text.insert',
    at: { positionToken: bindU2.documentPositionToken, offset: 11, affinity: 'right' },
    text: '!',
  });
  assert.equal(rebased.ok, true, rebased.failure?.message);
  assert.equal(currentText(), 'PREFIX hello world!');

  // Stale plain insert at offset 0 (root anchor) also rebases cleanly!
  const rebasedRoot = await dispatchWith('u2-stale-root', u2, bindU2, {
    kind: 'text.insert',
    at: { positionToken: bindU2.documentPositionToken, offset: 0, affinity: 'right' },
    text: '>',
  });
  assert.equal(rebasedRoot.ok, true, rebasedRoot.failure?.message);
  assert.equal(currentText(), '>PREFIX hello world!');

  // Destructive edits (text.delete, text.replace) with a stale token MUST fail closed with position-stale!
  const staleDelete = await dispatchWith('u2-stale-delete', u2, bindU2, {
    kind: 'text.delete',
    from: { positionToken: bindU2.documentPositionToken, offset: 0, affinity: 'left' },
    to: { positionToken: bindU2.documentPositionToken, offset: 5, affinity: 'right' },
  });
  assert.equal(staleDelete.ok, false);
  assert.equal(staleDelete.failure.details.code, 'position-stale');

  const staleReplace = await dispatchWith('u2-stale-replace', u2, bindU2, {
    kind: 'text.replace',
    text: 'HI',
    from: { positionToken: bindU2.documentPositionToken, offset: 0, affinity: 'left' },
    to: { positionToken: bindU2.documentPositionToken, offset: 5, affinity: 'right' },
  });
  assert.equal(staleReplace.ok, false);
  assert.equal(staleReplace.failure.details.code, 'position-stale');

  // If u1 deletes the anchor character u2 was anchored to, stale plain insert MUST fail closed (ambiguous)!
  const freshU1 = await bindFor(u1);
  const freshU2 = await bindFor(u2);
  // Delete 'P' at offset 1 (the character right after '>').
  const delAnchor = await dispatchWith('u1-del-p', u1, freshU1, {
    kind: 'text.delete',
    from: { positionToken: freshU1.documentPositionToken, offset: 1, affinity: 'left' },
    to: { positionToken: freshU1.documentPositionToken, offset: 2, affinity: 'right' },
  });
  assert.equal(delAnchor.ok, true, delAnchor.failure?.message);
  // u2 tries stale insert at offset 2 (anchored to the now-deleted 'P') -> must fail closed!
  const ambiguous = await dispatchWith('u2-deleted-anchor', u2, freshU2, {
    kind: 'text.insert',
    at: { positionToken: freshU2.documentPositionToken, offset: 2, affinity: 'right' },
    text: 'X',
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.failure.details.code, 'position-stale');

  // Redacted document: stale plain insert MUST fail closed with position-stale!
  const bTheme = await bindFor(u1);
  assert.equal((await dispatchWith('apply-theme', u1, bTheme, {
    kind: 'annotation.apply',
    annotation: { id: 't1', family: 'theme', fields: {} },
    from: { positionToken: bTheme.documentPositionToken, offset: 0, affinity: 'left' },
    to: { positionToken: bTheme.documentPositionToken, offset: 6, affinity: 'right' },
  })).ok, true);
  const bProt = await bindFor(u1);
  assert.equal((await dispatchWith('apply-prot', u1, bProt, {
    kind: 'annotation.apply',
    annotation: { id: 'p1', family: 'confidential', fields: {}, protectedTargetIds: ['t1'] },
    from: { positionToken: bProt.documentPositionToken, offset: 0, affinity: 'left' },
    to: { positionToken: bProt.documentPositionToken, offset: 6, affinity: 'right' },
  })).ok, true);

  const redactedU2 = await bindFor(u2);
  const freshU1AfterProt = await bindFor(u1);
  assert.equal((await dispatchWith('u1-move-frontier', u1, freshU1AfterProt, {
    kind: 'text.insert',
    at: { positionToken: freshU1AfterProt.documentPositionToken, offset: currentText().length, affinity: 'right' },
    text: '?',
  })).ok, true);

  const staleRedactedInsert = await dispatchWith('u2-stale-redacted-insert', u2, redactedU2, {
    kind: 'text.insert',
    at: { positionToken: redactedU2.documentPositionToken, offset: 2, affinity: 'right' },
    text: 'Y',
  });
  assert.equal(staleRedactedInsert.ok, false);
  assert.equal(staleRedactedInsert.failure.details.code, 'position-stale');
});
