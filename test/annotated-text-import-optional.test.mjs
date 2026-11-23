// Issue #224 regression: annotated-text document import must treat an absent
// optional annotation field as absence, not as explicit null. Materializing
// null and running the value-type validator against it rejects every
// optional-but-not-nullable field (e.g. boolean({ optional: true })) with
// "expected a boolean". This file pins absence/round-trip/rejection behavior.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  admin, annotatedText, annotation, boolean, deny, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, number, read, ref, scope, text, write,
} from '../build/internal.mjs';
import { annotatedTextCreateAction, exportAnnotatedText } from '../build/annotated-text-public.mjs';

function entityDoc() {
  return entity('OptImportDoc', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [annotation('timing', {
        appliesTo: 'text-range',
        cardinality: 'many',
        fields: {
          startMs: number(),
          approximate: boolean({ optional: true }),
          confidence: number({ optional: true, validate: (value) => typeof value === 'number' && Number.isFinite(value) }),
          note: text({ optional: true }),
          nullableNote: text({ optional: true, nullable: true }),
        },
        empty: 'delete',
      })],
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
  const Project = project();
  const Document = entityDoc();
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('u1')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(Document, db);
  const app = workbench({ db, entities: [Project, Document] });
  app.start();
  await app.ready;
  return { app, db, Project, Document };
}

function createDispatch(ctx, id, fields) {
  return ctx.app.dispatch({
    actionId: `import-${id}`,
    principal: { id: 'u1' },
    ...annotatedTextCreateAction(ctx.Document, ctx.Document.body, {
      id,
      projectId: 'p1',
      ownerId: 'u1',
      source: {
        text: 'hello world',
        ranges: [{ annotationId: 'timing-1', family: 'timing', start: 0, end: 5, fields }],
      },
    }),
  });
}

function storedFields(ctx, id) {
  return ctx.db.prepare(`
    SELECT t.startMs, t.approximate, t.confidence, t.note, t.nullableNote
      FROM OptImportDoc_body_annotation_timing t
      JOIN OptImportDoc_body_annotation a ON a.id = t.annotation_id
     WHERE a.document_id = ?
  `).get(id);
}

async function exported(ctx, id) {
  return exportAnnotatedText({
    app: ctx.app,
    entity: ctx.Document,
    field: ctx.Document.body,
    documentId: id,
    expectedOwningScope: { entity: ctx.Project, id: 'p1' },
    principal: { id: 'u1' },
  });
}

test('import omits absent optional annotation fields and round-trips cleanly', async (t) => {
  const ctx = await appFor();
  t.after(() => ctx.app.close?.());

  // Only the required field is supplied; boolean/number/text optionals and the
  // nullable field are all absent. Absence must not reach the type validator.
  const created = await createDispatch(ctx, 'opt-absent', { startMs: 0 });
  assert.equal(created.ok, true, created.failure?.message);

  const stored = storedFields(ctx, 'opt-absent');
  assert.ok(stored);
  assert.equal(stored.startMs, 0);
  // Each absent field stores SQL NULL (the absence sentinel); no validator error.
  assert.equal(stored.approximate, null);
  assert.equal(stored.confidence, null);
  assert.equal(stored.note, null);
  assert.equal(stored.nullableNote, null);

  const document = await exported(ctx, 'opt-absent');
  assert.equal(document.kind, 'workbench.annotatedText.canonical');
  assert.equal(document.text, 'hello world');
  assert.deepEqual(document.ranges.map((range) => ({ start: range.start, end: range.end })), [{ start: 0, end: 5 }]);
  assert.equal(document.annotations.length, 1);
  assert.deepEqual(document.annotations[0].fields, {
    startMs: 0,
    approximate: null,
    confidence: null,
    note: null,
    nullableNote: null,
  });
});

test('import preserves supplied optional annotation fields through round-trip', async (t) => {
  const ctx = await appFor();
  t.after(() => ctx.app.close?.());

  const created = await createDispatch(ctx, 'opt-supplied', {
    startMs: 12,
    approximate: true,
    confidence: 0.8,
    note: 'later',
    nullableNote: null,
  });
  assert.equal(created.ok, true, created.failure?.message);

  const document = await exported(ctx, 'opt-supplied');
  assert.deepEqual(document.annotations[0].fields, {
    startMs: 12,
    approximate: true,
    confidence: 0.8,
    note: 'later',
    nullableNote: null,
  });
});

test('import still rejects invalid non-null values and explicit null on non-nullable optionals', async () => {
  const cases = [
    ['opt-bad-bool', { startMs: 0, approximate: 'yes' }, /approximate: expected a boolean/],
    ['opt-bad-text', { startMs: 0, note: 42 }, /note: expected a text value/],
    ['opt-bad-number', { startMs: 0, confidence: 'high' }, /confidence failed declared validation/],
    ['opt-null-bool', { startMs: 0, approximate: null }, /approximate/],
    ['opt-null-number', { startMs: 0, confidence: null }, /confidence/],
    ['opt-null-text', { startMs: 0, note: null }, /note/],
  ];
  for (const [id, fields, expected] of cases) {
    const ctx = await appFor();
    try {
      const rejected = await createDispatch(ctx, id, fields);
      assert.equal(rejected.ok, false, `${id} should have been rejected: ${rejected.failure?.message}`);
      assert.match(rejected.failure?.message ?? '', expected);
    } finally {
      await ctx.app.close?.();
    }
  }
});
