import { databaseImage } from './helpers/database-image.mjs';
// Create-source annotation ranges (issue #216): a diarized transcript imports
// its text AND its speaker/annotation ranges atomically in the create action —
// no post-create applies. Ranges use legacy document-absolute offsets over the
// concatenated source block texts; import canonicalization inserts LF run
// boundaries and translates those offsets before seeding the continuous family.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  admin, annotatedText, annotation, deny, entity, everyone, executeDDL, executeFrameworkDDL, grant, number as numberField, read, ref, scope, text, write,
} from '../build/internal.mjs';
import { materializeText, restoreTextFamily } from '../build/annotated-text-continuous.mjs';
import { projectRangeToOffsets } from '../build/annotated-text-ranges.mjs';
import { exportAnnotatedText } from '../build/annotated-text-public.mjs';
import { attachAnnotationRange } from '../build/annotated-text-storage.mjs';

function doc() {
  return entity('RangeDoc', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('turn', { fields: { label: text({ optional: true, nullable: true }) } }),
        annotation('mention', { fields: { user: ref('User', { optional: true, nullable: true }), label: text({ optional: true, nullable: true }) } }),
        annotation('code', { fields: {} }),
        annotation('timing', { fields: { startMs: numberField({ validate: (value) => Number.isSafeInteger(value) && value >= 0 }), durationMs: numberField({ validate: (value) => Number.isSafeInteger(value) && value >= 0 }) } }),
        annotation('transcriptionConfidence', { fields: { confidence: numberField({ validate: (value) => typeof value === 'number' && value >= 0 && value <= 1 }) } }),
      ],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

function project() {
  return entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(async ({ is }) => (await is.owner()) ? grant(read, write, admin) : deny('not project owner'))],
  });
}

async function appFor() {
  const db = new DatabaseSync(':memory:');
  const Document = doc();
  const Project = project();
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('u1')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(Document, db);
  const app = workbench({ db, entities: [Project, Document] });
  app.start();
  await app.ready;
  return { app, db, Document, Project };
}

function createWithRanges(app, id, ranges, blocks = [{ text: 'hello world' }]) {
  return app.dispatch({
    actionId: `create-${id}`,
    type: 'RangeDoc.create',
    principal: { id: 'u1' },
    payload: { id, project: 'p1', owner: 'u1', body: { version: 1, blocks, ...(ranges ? { ranges } : {}) } },
  });
}

function committedMemberships(db, documentId) {
  return db.prepare('SELECT membership.annotation_id, range.start_point, range.end_point FROM RangeDoc_body_membership AS membership JOIN RangeDoc_body_range AS range ON range.id = membership.range_id').all()
    .filter((row) => {
      const annotation = db.prepare('SELECT document_id FROM RangeDoc_body_annotation WHERE id = ?').get(row.annotation_id);
      return annotation?.document_id === documentId;
    });
}

async function committedOffsets(db, documentId, annotationId) {
  const state = db.prepare("SELECT family_checkpoint FROM RangeDoc_body_state WHERE document_id = ?").get(documentId);
  const family = restoreTextFamily(JSON.parse(state.family_checkpoint));
  const membership = db.prepare('SELECT range.start_point, range.end_point FROM RangeDoc_body_membership AS membership JOIN RangeDoc_body_range AS range ON range.id = membership.range_id WHERE membership.annotation_id = ?').get(annotationId);
  return {
    text: materializeText(family),
    range: membership
      ? projectRangeToOffsets(family, { annotationId, start: JSON.parse(membership.start_point), end: JSON.parse(membership.end_point) })
      : null,
  };
}

test('create with source.ranges lands text and ranges atomically', async () => {
  const { app, db, Document, Project } = await appFor();
  const created = await createWithRanges(app, 'd1', [
    { annotationId: 'turn-1', family: 'turn', start: 0, end: 5, fields: { label: 'SPEAKER_A' } },
    { annotationId: 'turn-2', family: 'turn', start: 6, end: 11, fields: {} },
  ], [{ text: 'hello world' }]);
  assert.equal(created.ok, true, created.failure?.message);

  assert.deepEqual((await committedOffsets(db, 'd1', 'turn-1')).range, { start: 0, end: 5 });
  assert.deepEqual((await committedOffsets(db, 'd1', 'turn-2')).range, { start: 6, end: 11 });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM RangeDoc_body_annotation WHERE document_id = 'd1'").get().count, 2);
  assert.equal(db.prepare("SELECT label FROM RangeDoc_body_annotation_turn WHERE annotation_id = 'turn-1'").get().label, 'SPEAKER_A');
  // Absent optional/nullable fields normalize to null.
  assert.equal(db.prepare("SELECT label FROM RangeDoc_body_annotation_turn WHERE annotation_id = 'turn-2'").get().label, null);

  // The canonical export round-trips the ranges.
  const exported = await exportAnnotatedText({ app, entity: Document, field: Document.body, documentId: 'd1', expectedOwningScope: { entity: Project, id: 'p1' }, principal: { id: 'u1' } });
  assert.equal(exported.kind, 'workbench.annotatedText.canonical');
  assert.equal(exported.text, 'hello world');
  assert.deepEqual(exported.ranges.map((r) => ({ annotationId: r.annotationId, start: r.start, end: r.end })), [
    { annotationId: 'turn-1', start: 0, end: 5 },
    { annotationId: 'turn-2', start: 6, end: 11 },
  ]);
  await app.close?.();
});

test('create with source.ranges inserts LF boundaries and translates legacy offsets', async () => {
  const { app, db } = await appFor();
  const created = await createWithRanges(app, 'd2', [
    { annotationId: 'turn-1', family: 'turn', start: 0, end: 6, fields: { label: 'A' } },
    { annotationId: 'turn-2', family: 'turn', start: 6, end: 11, fields: { label: 'B' } },
  ], [{ text: 'hello ' }, { text: 'world' }]);
  assert.equal(created.ok, true, created.failure?.message);
  // The public import range remains [6, 11], while the canonical document is
  // LF-delimited and the second range moves to [7, 12].
  assert.deepEqual((await committedOffsets(db, 'd2', 'turn-1')).text, 'hello \nworld');
  assert.deepEqual((await committedOffsets(db, 'd2', 'turn-1')).range, { start: 0, end: 6 });
  assert.deepEqual((await committedOffsets(db, 'd2', 'turn-2')).range, { start: 7, end: 12 });
  assert.equal(committedMemberships(db, 'd2').length, 2);
  await app.close?.();
});

test('create with source.ranges preserves a range spanning a block boundary', async () => {
  const { app, db } = await appFor();
  const created = await createWithRanges(app, 'spanning-boundary', [
    { annotationId: 'turn-1', family: 'turn', start: 4, end: 8, fields: {} },
  ], [{ text: 'hello ' }, { text: 'world' }]);
  assert.equal(created.ok, true, created.failure?.message);
  assert.equal((await committedOffsets(db, 'spanning-boundary', 'turn-1')).text, 'hello \nworld');
  // Legacy [4, 8] covers `o wo`; the inserted LF shifts only its end.
  assert.deepEqual((await committedOffsets(db, 'spanning-boundary', 'turn-1')).range, { start: 4, end: 9 });
  await app.close?.();
});

test('create with source.ranges translates multiple boundaries in a three-block import', async () => {
  const { app, db } = await appFor();
  const created = await createWithRanges(app, 'three-blocks', [
    { annotationId: 'turn-1', family: 'turn', start: 1, end: 10, fields: {} },
    { annotationId: 'turn-2', family: 'turn', start: 6, end: 11, fields: {} },
  ], [{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
  assert.equal(created.ok, true, created.failure?.message);
  assert.equal((await committedOffsets(db, 'three-blocks', 'turn-1')).text, 'one\ntwo\nthree');
  // Legacy [1, 10] crosses both boundaries; [6, 11] starts at the second
  // boundary and covers the whole third source block.
  assert.deepEqual((await committedOffsets(db, 'three-blocks', 'turn-1')).range, { start: 1, end: 12 });
  assert.deepEqual((await committedOffsets(db, 'three-blocks', 'turn-2')).range, { start: 8, end: 13 });
  await app.close?.();
});

test('create with source.ranges preserves an existing LF and translates later blocks', async () => {
  const { app, db } = await appFor();
  const created = await createWithRanges(app, 'existing-lf', [
    { annotationId: 'turn-1', family: 'turn', start: 0, end: 2, fields: {} },
    { annotationId: 'turn-2', family: 'turn', start: 3, end: 8, fields: {} },
  ], [{ text: 'hi\n' }, { text: 'there' }]);
  assert.equal(created.ok, true, created.failure?.message);
  assert.equal((await committedOffsets(db, 'existing-lf', 'turn-1')).text, 'hi\n\nthere');
  assert.deepEqual((await committedOffsets(db, 'existing-lf', 'turn-2')).range, { start: 4, end: 9 });
  await app.close?.();
});

test('independent timing and confidence annotations share only an exactly equal structural range', async () => {
  const { app, db } = await appFor();
  const created = await createWithRanges(app, 'shared-range', [
    { annotationId: 'timing-1', family: 'timing', start: 0, end: 5, fields: { startMs: 0, durationMs: 420 } },
    { annotationId: 'confidence-1', family: 'transcriptionConfidence', start: 0, end: 5, fields: { confidence: 0.98 } },
    { annotationId: 'timing-2', family: 'timing', start: 6, end: 11, fields: { startMs: 430, durationMs: 470 } },
  ]);
  assert.equal(created.ok, true, created.failure?.message);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM RangeDoc_body_range').get().count, 2);
  const links = db.prepare("SELECT annotation_id, range_id FROM RangeDoc_body_membership WHERE annotation_id IN ('timing-1', 'confidence-1') ORDER BY annotation_id").all();
  assert.equal(links[0].range_id, links[1].range_id);
  assert.throws(() => db.prepare('UPDATE RangeDoc_body_range SET start_point = start_point WHERE id = ?').run(links[0].range_id), /immutable/);
  await app.close?.();
});

test('reordered endpoint keys canonicalize to the same immutable range', async () => {
  const { app, db } = await appFor();
  const created = await createWithRanges(app, 'reordered-keys', [
    { annotationId: 'timing-1', family: 'timing', start: 0, end: 5, fields: { startMs: 0, durationMs: 420 } },
  ]);
  assert.equal(created.ok, true, created.failure?.message);
  const stored = db.prepare("SELECT range.start_point, range.end_point, range.id FROM RangeDoc_body_membership AS membership JOIN RangeDoc_body_range AS range ON range.id = membership.range_id WHERE membership.annotation_id = 'timing-1'").get();
  const start = JSON.parse(stored.start_point);
  const end = JSON.parse(stored.end_point);
  // The same structural endpoints serialized with REORDERED object keys must
  // intern to the identical range row: canonicalization reads point and
  // basisFrontier by key, never by property order.
  const reorderedStart = { basisFrontier: start.basisFrontier, point: start.point };
  const reorderedEnd = { basisFrontier: end.basisFrontier, point: end.point };
  db.prepare("INSERT INTO RangeDoc_body_annotation (id, document_id, project_id, owner_id, family) VALUES ('timing-reordered', 'reordered-keys', 'p1', 'u1', 'timing')").run();
  db.prepare("INSERT INTO RangeDoc_body_annotation_timing (annotation_id, startMs, durationMs) VALUES ('timing-reordered', 0, 420)").run();
  attachAnnotationRange(db, 'RangeDoc_body', 'reordered-keys', 'timing-reordered', reorderedStart, reorderedEnd, 0);
  const reorderedRangeId = db.prepare("SELECT range_id FROM RangeDoc_body_membership WHERE annotation_id = 'timing-reordered'").get().range_id;
  assert.equal(reorderedRangeId, stored.id, 'reordered endpoint keys must canonicalize to the same range row');
  await app.close?.();
});

test('create with source.ranges rejects malformed ranges fail-closed', async () => {
  const { app } = await appFor();
  const cases = [
    ['out-of-bounds', [{ annotationId: 'x', family: 'turn', start: 0, end: 99, fields: {} }], /end <= 11|out-of-bounds|offsets/],
    ['unknown family', [{ annotationId: 'x', family: 'nope', start: 0, end: 5, fields: {} }], /family 'nope' is not declared|'nope' is not declared/],
    ['duplicate id', [
      { annotationId: 'x', family: 'turn', start: 0, end: 5, fields: {} },
      { annotationId: 'x', family: 'code', start: 6, end: 11, fields: {} },
    ], /duplicate annotationId 'x'/],
    ['unknown key', [{ annotationId: 'x', family: 'turn', start: 0, end: 5, fields: {}, bogus: 1 }], /unknown key 'bogus'/],
    ['unknown field', [{ annotationId: 'x', family: 'turn', start: 0, end: 5, fields: { bogus: 1 } }], /unknown field 'bogus'|has unknown field 'bogus'/],
    ['zero width', [{ annotationId: 'x', family: 'turn', start: 3, end: 3, fields: {} }], /0 <= start < end/],
  ];
  for (const [label, ranges, pattern] of cases) {
    const result = await createWithRanges(app, `reject-${label}`, ranges);
    assert.equal(result.ok, false, `${label} should fail`);
    assert.match(result.failure?.message ?? '', pattern, label);
  }
  await app.close?.();
});

test('create with source.ranges rejects a range ending mid-surrogate', async () => {
  const { app } = await appFor();
  // '😀' is a surrogate pair at offsets 1-2; a range ending at 2 is mid-scalar.
  const result = await createWithRanges(app, 'surrogate', [
    { annotationId: 's-1', family: 'turn', start: 0, end: 2, fields: {} },
  ], [{ text: 'a😀b' }]);
  assert.equal(result.ok, false);
  assert.match(result.failure?.message ?? '', /surrogate|scalar|offset/i);
  await app.close?.();
});

test('create with source.ranges stores ref annotation fields and null-nullable refs', async () => {
  const { app, db } = await appFor();
  const created = await createWithRanges(app, 'd4', [
    { annotationId: 'm-1', family: 'mention', start: 0, end: 5, fields: { user: 'u1', label: 'hi' } },
    { annotationId: 'm-2', family: 'mention', start: 6, end: 11, fields: {} },
  ], [{ text: 'hello world' }]);
  assert.equal(created.ok, true, created.failure?.message);
  assert.equal(db.prepare("SELECT user, label FROM RangeDoc_body_annotation_mention WHERE annotation_id = 'm-1'").get().user, 'u1');
  assert.equal(db.prepare("SELECT user, label FROM RangeDoc_body_annotation_mention WHERE annotation_id = 'm-1'").get().label, 'hi');
  // Absent optional/nullable ref + text both normalize to null.
  const m2 = db.prepare("SELECT user, label FROM RangeDoc_body_annotation_mention WHERE annotation_id = 'm-2'").get();
  assert.equal(m2.user, null);
  assert.equal(m2.label, null);
  await app.close?.();
});

test('create with source.ranges leaves the durable state empty when rejected', async () => {
  const { app, db } = await appFor();
  const before = databaseImage(db);
  const result = await createWithRanges(app, 'd3', [{ annotationId: 'x', family: 'nope', start: 0, end: 5, fields: {} }]);
  assert.equal(result.ok, false);
  assert.deepEqual(databaseImage(db), before);
  await app.close?.();
});

test('a transcript-sized import creates ordinary timing/confidence records in one atomic committed batch', async () => {
  const { app, db } = await appFor();
  // A diarized transcript: hundreds of timing + confidence ranges over one text.
  const words = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ');
  const ranges = [];
  let offset = 0;
  for (let i = 0; i < 120; i += 1) {
    const width = `w${i}`.length;
    ranges.push({ annotationId: `timing-${i}`, family: 'timing', start: offset, end: offset + width, fields: { startMs: i * 100, durationMs: 60 } });
    ranges.push({ annotationId: `confidence-${i}`, family: 'transcriptionConfidence', start: offset, end: offset + width, fields: { confidence: 0.5 + (i % 40) / 100 } });
    offset += width + 1;
  }
  const created = await createWithRanges(app, 'transcript', ranges, [{ text: words }]);
  assert.equal(created.ok, true, created.failure?.message);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM RangeDoc_body_annotation').get().count, 240);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM RangeDoc_body_membership').get().count, 240);
  // Exact common geometry: every timing-i / confidence-i pair interns ONE range.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM RangeDoc_body_range').get().count, 120);

  // The whole batch was ONE ordinary committed create — no separate evidence
  // consumer, no second write path.
  const events = db.prepare("SELECT eventType FROM _Log WHERE scope = 'Project:p1' ORDER BY seq").all();
  assert.deepEqual(events.map((row) => row.eventType), ['RangeDoc.created']);

  // A malformed range anywhere in a transcript-sized batch rejects atomically.
  const badRanges = [...ranges];
  badRanges[60] = { ...badRanges[60], fields: { confidence: 2 } };
  const before = databaseImage(db);
  const rejected = await createWithRanges(app, 'transcript-bad', badRanges, [{ text: words }]);
  assert.equal(rejected.ok, false);
  assert.deepEqual(databaseImage(db), before);
  await app.close?.();
});

// The create projection's async surface must actually release the event loop
// while seeding a large imported range batch (the production "crashed after
// diarizing" hang): during the dispatch a 0ms timer must fire, which a fully
// synchronous block would prevent. All ranges still commit atomically.
test('large annotated-text create yields to the event loop during range seeding', async () => {
  const { app, db, Document, Project } = await appFor();
  const text = 'a'.repeat(10_000);
  const ranges = [];
  for (let i = 0; i < 2000; i += 1) {
    ranges.push({ annotationId: `t-${i}`, family: 'timing', start: i * 5, end: i * 5 + 3, fields: { startMs: i, durationMs: 1 } });
  }
  let turns = 0;
  const ticker = setInterval(() => { turns += 1; }, 0);
  let created;
  try {
    created = await createWithRanges(app, 'big', ranges, [{ text }]);
    assert.equal(created.ok, true, created.failure?.message);
  } finally {
    clearInterval(ticker);
  }
  // The seeding loop yields (await setImmediate) every ANNOTATED_SEED_YIELD_EVERY
  // ranges, so a 0ms interval must interleave with the dispatch instead of being
  // starved for its whole duration.
  assert.ok(turns > 0, 'expected the large create dispatch to yield to the event loop');
  // The async path commits every range exactly like the synchronous one.
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM RangeDoc_body_annotation WHERE document_id = 'big'").get().count, 2000);
  assert.equal(committedMemberships(db, 'big').length, 2000);
  // And the canonical export still round-trips a sample of the ranges.
  const exported = await exportAnnotatedText({ app, entity: Document, field: Document.body, documentId: 'big', expectedOwningScope: { entity: Project, id: 'p1' }, principal: { id: 'u1' } });
  assert.equal(exported.kind, 'workbench.annotatedText.canonical');
  assert.equal(exported.text, text);
  assert.equal(exported.ranges.length, 2000);
  await app.close?.();
});
