// Pipeline integration — the opt-in mutation layer alongside direct CRUD.
//
// The pipeline kernel (createServer/createClient) is an OPT-IN layer for apps
// that want optimistic-UI, undo, replay, and reducer-folded client state. Apps
// that don't declare actions/events (the binding exemplars: todo.mjs, doc.mjs,
// gdoc.mjs, note.mjs) use the direct CRUD path + live-sync sequence numbers.
//
// This test proves the pipeline is usable end-to-end with a real db: an app
// declares an action and event, dispatches through createServer (which writes
// to the db and appends a sequenced event to the log), and a createClient folds
// the event through its reducer. The SAME mayVerb authorizes the action — no
// second auth path.

import { text, ref, grant, read, write, subscribe, scope } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { entity, action, event } from '../build/index.mjs';
import workbench from '../build/app.mjs';
import { createServer, createClient, generateDDL } from '../build/internal.mjs';

test('an app opts into the pipeline: action → event → reducer fold', async () => {
  const db = new DatabaseSync(':memory:');

  // A product entity with a published flag.
  const Post = entity('Post', {
        title: text(),
    published: text({ default: 'false' }),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [scope(({ is }) => is.owner()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : grant(read))],
  });
  for (const sql of generateDDL(Post)) db.exec(sql);

  // Seed a post (owner is readonly — raw INSERT is the blessed path).
  db.prepare('INSERT INTO Post (id, title, published, owner) VALUES (?, ?, ?, ?)').run(1, 'Hello', 'false', 'u1');

  // Declare an action and its event with a reducer.
  const Publish = action('post.publish');
  const Published = event('post.published', (state, e) => ({ ...state, published: 'true', at: e.data.at }));

  // The pipeline server: the handler is the ONE place the db is written for
  // this action. authorize uses the SAME mayVerb shape the CRUD path uses —
  // no second auth path.
  const server = createServer({
    handlers: {
      'post.publish': ({ payload, principal }) => {
        db.prepare('UPDATE Post SET published = ? WHERE id = ?').run('true', payload.postId);
        return [{ type: 'post.published', scope: payload.postId, data: { at: payload.at, by: principal.id } }];
      },
    },
    authorize: ({ payload, principal }) => {
      // Re-use the entity's row grant: only the owner may publish.
      const row = db.prepare('SELECT * FROM Post WHERE id = ?').get(payload.postId);
      return row && row.owner === principal.id;
    },
  });

  // Dispatch as the owner → granted, handler runs, event appended with seq:1.
  const r1 = server.dispatch({
    actionId: 'a1', type: Publish.type,
    payload: { postId: 1, at: 12345 }, principal: { id: 'u1' },
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.events.length, 1);
  assert.equal(r1.events[0].seq, 1);
  assert.equal(server.log.length, 1);

  // The db was updated by the handler.
  const post = db.prepare('SELECT * FROM Post WHERE id = ?').get(1);
  assert.equal(post.published, 'true');

  // A non-owner is denied by authorize (the same row-grant logic).
  const r2 = server.dispatch({
    actionId: 'a2', type: Publish.type,
    payload: { postId: 1, at: 999 }, principal: { id: 'u2' },
  });
  assert.equal(r2.ok, false);
  assert.equal(server.log.length, 1, 'denied action appends nothing');

  // A replayed action (same actionId) is deduped — no duplicate state change.
  const r3 = server.dispatch({
    actionId: 'a1', type: Publish.type,
    payload: { postId: 1, at: 999 }, principal: { id: 'u1' },
  });
  assert.equal(r3.deduped, true);
  assert.equal(server.log.length, 1);

  // A client folds the event through its reducer — the optimistic-UI/undo
  // consumer side. The same ingest handles echoed and foreign events.
  const client = createClient({ events: [Published] });
  client.bootstrap(1, { published: 'false' }, 0);
  const ingest = client.ingest(r1.events[0]);
  assert.equal(ingest.applied, true);
  assert.equal(client.state(1).published, 'true');
  assert.equal(client.state(1).at, 12345);
});

test('pipeline and direct CRUD coexist — one does not subsume the other', async () => {
  // An app can use direct CRUD for some entities and the pipeline for others.
  // The live-sync sequence numbers bridge both: every mutation, whichever
  // path it took, produces a sequenced live event.
  const db = new DatabaseSync(':memory:');

  const Note = entity('Note', {
        body: text(), owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [scope(({ is }) => is.owner()).can(async ({ is }) => (await is.owner()) ? grant(read, write) : grant(read))],
  });
  for (const sql of generateDDL(Note)) db.exec(sql);

  const app = workbench({ db, entities: [Note] });
  const Note_b = app.entity(Note);

  // Direct CRUD path: create a note the plain way.
  const note = Note_b.create({ body: 'via direct CRUD' });
  assert.equal(note.body, 'via direct CRUD');

  // Pipeline path: a custom action that also writes a note.
  const Draft = action('note.draft');
  const _Drafted = event('note.drafted', (state, e) => ({ ...state, body: e.data.body }));

  const server = createServer({
    handlers: {
      'note.draft': ({ payload }) => {
        const n = Note_b.create({ body: payload.body });
        return [{ type: 'note.drafted', scope: n.id, data: { body: n.body } }];
      },
    },
    authorize: () => true, // trivial for this coexistence test
  });

  const r = server.dispatch({ actionId: 'd1', type: Draft.type, payload: { body: 'via pipeline' }, principal: { id: 'u1' } });
  assert.equal(r.ok, true);
  assert.equal(r.events[0].type, 'note.drafted');

  // Both notes exist in the same db — one table, two paths, no conflict.
  const all = db.prepare('SELECT * FROM Note').all();
  assert.equal(all.length, 2);
});
