import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, boolean, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, measurement, read, ref, scope, text, write,
} from '../build/internal.mjs';
import { defineSqliteSchema } from '../build/server.mjs';
import { registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension } from '../build/internal.mjs';

registerAnnotatedTextContract('sourceInit', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('sourceInit', Object.freeze({
  version: 1,
  validate() {}, edit() {},
  partition({ blockText, utf16Offset, payload }) {
    return Object.freeze({ version: 1, leftPayload: Object.freeze({ ...payload, text: blockText.slice(0, utf16Offset) }), rightPayload: Object.freeze({ ...payload, text: blockText.slice(utf16Offset) }) });
  },
  combine({ left, right }) { return Object.freeze({ version: 1, payload: Object.freeze({ text: `${left?.payload.text ?? ''}${right?.payload.text ?? ''}` }) }); },
}));

const externalReferences = defineSqliteSchema({
  name: 'annotated-text-import-optional-fields',
  tables: [],
  externalTables: [{ name: 'Project', columns: ['id'] }],
});

function doc() {
  return entity('InitDoc', {
    project: ref('Project'), owner: ref('User'),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('flag', { appliesTo: 'text-range', cardinality: 'many', fields: { approximate: boolean({ optional: true }) }, empty: 'delete' }),
        annotation('tagged', { appliesTo: 'text-range', cardinality: 'many', fields: { label: text() }, empty: 'delete' }),
      ],
      measurements: [measurement('source', { extension: 'sourceInit' })],
    }).can(() => grant(read, write)),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

async function app() {
  const db = new DatabaseSync(':memory:');
  const Document = doc();
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE Project (id TEXT PRIMARY KEY); CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO Project VALUES ('p1'); INSERT INTO User VALUES ('u1'); INSERT INTO User VALUES ('u2')");
  executeDDL(Document, db);
  const app = workbench({ db, schema: externalReferences, entities: [Document] });
  app.start(); await app.ready;
  return { app, db };
}

async function create(ctx, actionId, ranges) {
  return ctx.app.dispatch({
    actionId,
    type: 'InitDoc.create',
    principal: { id: 'u1' },
    payload: {
      id: 'd1', project: 'p1', owner: 'u1',
      body: { version: 1, blocks: [{ text: 'hello world' }], ...(ranges ? { ranges } : {}) },
    },
  });
}

test('imported ranges may omit an optional boolean annotation field', async () => {
  const ctx = await app();
  const result = await create(ctx, 'create-optional-absent', [
    { annotationId: 'f1', family: 'flag', start: 0, end: 5 },
  ]);
  assert.equal(result.ok, true, result.failure?.message);
});

test('imported ranges may provide the optional boolean field explicitly', async () => {
  const ctx = await app();
  const result = await create(ctx, 'create-optional-present', [
    { annotationId: 'f1', family: 'flag', start: 0, end: 5, fields: { approximate: true } },
  ]);
  assert.equal(result.ok, true, result.failure?.message);
});

test('imported ranges still reject a missing required field', async () => {
  const ctx = await app();
  const result = await create(ctx, 'create-required-absent', [
    { annotationId: 't1', family: 'tagged', start: 0, end: 5 },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.failure?.message ?? '', /missing required field 'label'/);
});

test('imported ranges still reject a wrong-typed optional field', async () => {
  const ctx = await app();
  const result = await create(ctx, 'create-optional-wrongtype', [
    { annotationId: 'f2', family: 'flag', start: 0, end: 5, fields: { approximate: 'yes' } },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.failure?.message ?? '', /approximate: expected a boolean/);
});
