import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, boolean, entity, everyone, executeDDL, executeFrameworkDDL, grant,
  number, read, ref, scope, text, write,
} from '../build/internal.mjs';
import { defineSqliteSchema } from '../build/server.mjs';
import { annotatedTextCreateAction } from '../build/annotated-text-public.mjs';

const externalReferences = defineSqliteSchema({
  name: 'annotated-text-import-optional-fields',
  tables: [],
  externalTables: [{ name: 'Project', columns: ['id'] }],
});

// scope#3000: a timing-style family whose optional boolean field is ABSENT at
// import must import cleanly (absence is the optional contract), and explicit
// null must still reject on a non-nullable field.
function doc() {
  return entity('OptDoc', {
    project: ref('Project'), owner: ref('User'),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [annotation('timing', {
        appliesTo: 'text-range',
        cardinality: 'many',
        fields: {
          mediaStartMs: number(),
          mediaEndMs: number(),
          approximate: boolean({ optional: true }),
          note: text({ nullable: true, optional: true }),
        },
        empty: 'delete',
      })],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

async function appFor() {
  const db = new DatabaseSync(':memory:');
  const Document = doc();
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE Project (id TEXT PRIMARY KEY); CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO Project VALUES ('p1'); INSERT INTO User VALUES ('u1')");
  executeDDL(Document, db);
  const app = workbench({ db, schema: externalReferences, entities: [Document] });
  app.start(); await app.ready;
  return { app, db, Document };
}

function createDispatch(ctx, id, ranges) {
  return ctx.app.dispatch({
    actionId: `import-${id}`,
    principal: { id: 'u1' },
    ...annotatedTextCreateAction(ctx.Document, ctx.Document.body, {
      id,
      projectId: 'p1',
      ownerId: 'u1',
      source: {
        text: 'hello world',
        ranges,
      },
    }),
  });
}

test('import omits absent optional annotation fields instead of materializing null', async (t) => {
  const ctx = await appFor(); t.after(() => ctx.app.close?.());
  const created = await createDispatch(ctx, 'optdoc-1', [
    {
      annotationId: 'timing-1', family: 'timing', start: 0, end: 5,
      fields: { mediaStartMs: 0, mediaEndMs: 500 },
    },
  ]);
  assert.equal(created.ok, true, created.failure?.message);
  // The absent optional key stores SQL NULL (the absence sentinel); the absent
  // nullable key materializes null (explicit nullable contract).
  const stored = ctx.db.prepare("SELECT t.approximate, t.note FROM OptDoc_body_annotation_timing t JOIN OptDoc_body_annotation a ON a.id = t.annotation_id WHERE a.document_id = 'optdoc-1'").get();
  assert.ok(stored);
  assert.equal(stored.approximate, null);
  assert.equal(stored.note, null);
});

test('import rejects explicit null on an optional-but-not-nullable field', async (t) => {
  const ctx = await appFor(); t.after(() => ctx.app.close?.());
  const rejected = await createDispatch(ctx, 'optdoc-2', [
    {
      annotationId: 'timing-1', family: 'timing', start: 0, end: 5,
      fields: { mediaStartMs: 0, mediaEndMs: 500, approximate: null },
    },
  ]);
  assert.equal(rejected.ok, false);
  assert.match(rejected.failure?.message ?? '', /approximate/);
});
