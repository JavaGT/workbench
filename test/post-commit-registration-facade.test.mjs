import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import workbench, {
  defineOperationalEvent,
  operationalConsumer,
  postCommitEffect,
  principal,
  text,
  grant,
  read,
  write,
  subscribe,
} from '../build/index.mjs';
import { entity } from '../build/internal.mjs';
import { defineSqliteSchema } from '../build/server.mjs';

// Fixture table created out-of-band and written by the app's projection.
const fixtureSchema = defineSqliteSchema({
  name: 'post-commit-registration-facade-fixtures',
  tables: [],
  externalTables: [
    { name: 'Artefact', columns: ['id', 'project'] },
  ],
});
import {
  operationalConsumerAdmin,
  createPostCommitEffectRunner,
} from '../build/server.mjs';

function noteEntity() {
  return entity('Note', {
    title: text(),
    secret: text(),
    grant: () => grant(read, write, subscribe),
  });
}

test('app registers operational consumers via public options without selecting framework tables', async (t) => {
  const delivered = [];
  const consumer = operationalConsumer({
    name: 'facade.search',
    declarationVersion: 'v1',
    projectionId: 'facade.v1',
    effectId: 'facade.index.v1',
    event: defineOperationalEvent({
      eventType: 'Note.created',
      fields: ['id', 'title'],
      project: (fields, metadata) => ({
        id: fields.id,
        title: fields.title,
        event: metadata.committedEventId,
      }),
    }),
    idempotencyKey: ({ metadata }) => `facade:${metadata.committedEventId}`,
    handle: async (delivery) => {
      delivered.push(delivery);
      return { kind: 'ack' };
    },
  });

  const db = new DatabaseSync(':memory:');
  const app = workbench({
    db,
    schema: fixtureSchema,
    entities: [noteEntity()],
    operationalConsumers: [consumer],
  });
  app.mount('/notes', app.entity('Note'));
  app.listen(0);
  await app.ready;
  t.after(async () => {
    await app.shutdown();
    db.close();
  });

  const outcome = await app.dispatch({
    actionId: 'facade-action-1',
    type: 'Note.create',
    payload: { id: 'n1', title: 'visible', secret: 'never' },
    principal: principal({ type: 'user', id: 'u1' }),
  });
  assert.equal(outcome.ok, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.title, 'visible');
  assert.equal('secret' in delivered[0].payload, false);

  const admin = operationalConsumerAdmin(app);
  assert.equal(typeof admin.listFailures, 'function');
  assert.equal(typeof admin.listRetries, 'function');
  assert.equal(typeof admin.retryFailure, 'function');
  assert.deepEqual(await admin.listFailures('facade.search'), []);
  assert.deepEqual(await admin.listRetries('facade.search'), []);
});

test('host auto-wires postCommitEffects; createPostCommitEffectRunner remains advanced-only export', async (t) => {
  assert.equal(typeof createPostCommitEffectRunner, 'function');
  assert.equal(typeof operationalConsumerAdmin, 'function');
  assert.equal(typeof postCommitEffect, 'function');

  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE Artefact (id TEXT PRIMARY KEY, project TEXT NOT NULL); INSERT INTO Artefact VALUES ('a1', 'source')");
  const app = workbench({
    db,
    schema: fixtureSchema,
    actions: [{
      type: 'artefact.transfer',
      authorize: () => true,
      handler({ payload }) {
        return {
          events: [
            { type: 'artefact.transferred', scope: `project:${payload.source}`, data: { id: payload.id, project: payload.target } },
          ],
          privateFact: {
            before: { project: payload.source },
            after: { project: payload.target },
          },
          effects: [
            postCommitEffect({
              file: 'media',
              operation: 'copy',
              key: payload.id,
              verification: 'target-sha',
              payload: { from: payload.source, to: payload.target },
            }),
          ],
        };
      },
      projections: [{
        eventTypes: ['artefact.transferred'],
        apply(event, database) {
          database.prepare('UPDATE Artefact SET project = ? WHERE id = ?').run(event.data.project, event.data.id);
        },
      }],
    }],
  });
  await app.start();
  t.after(async () => {
    await app.shutdown();
    db.close();
  });

  assert.ok(app.postCommitEffects, 'runner is host-wired when db is configured');
  assert.equal(typeof app.postCommitEffects.claim, 'function');

  const outcome = await app.dispatch({
    actionId: 'facade-effect-1',
    scope: 'project:source',
    type: 'artefact.transfer',
    payload: { id: 'a1', source: 'source', target: 'target' },
    principal: { type: 'user', id: 'editor', attributes: {} },
  });
  assert.equal(outcome.ok, true);
  const claimed = app.postCommitEffects.claim('facade-worker');
  assert.ok(claimed, 'effect is claimable without app SQL on _Log');
  assert.equal(claimed.id.file, 'media');
  assert.equal(claimed.id.operation, 'copy');
});

test('server entry re-exports operationalConsumerAdmin and createPostCommitEffectRunner', async () => {
  const server = await import('../build/server.mjs');
  assert.equal(typeof server.operationalConsumerAdmin, 'function');
  assert.equal(typeof server.createPostCommitEffectRunner, 'function');
  assert.equal(typeof server.createHistoryReader, 'function');
});
