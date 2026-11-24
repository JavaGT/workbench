// Collaborative undo/redo integration reference (issue #13).
//
// Two-client semantics over one authoritative server: Alice and Bob edit
// through the ordinary dispatch path, and Alice's undo/redo must compensate
// ONLY her own surviving contribution while Bob's contribution remains. The
// tests prove the decided product contract:
//
//   - Alice undoes her own insertion after Bob edits elsewhere; Alice's
//     contribution is removed and Bob's remains.
//   - Redo after a successful undo re-applies only the intended contribution
//     with a fresh CRDT contribution (never the old op identity).
//   - Undo/redo stays per-principal and per-session; neither can target the
//     other user's action.
//   - Repeated/retried undo and redo are idempotent via durable receipts.
//   - An inverse whose exact target was already transformed by another client
//     is a durable no-op with no partial write (never a global rewind).
//   - Reload persistence: shutting down and reopening the same database file
//     preserves durable text and reconstructs the cursor from receipts.
//   - Two client replicas converge through the normal fold/ingest path across
//     insert, undo, and redo: real browser-engine sessions
//     (createAnnotatedTextHttpSession) bootstrap from the server snapshot and
//     ingest the fold envelopes the live-delivery seam emits for every
//     transition.
//   - Malformed or erased inverse facts fail closed with no partial write.
//   - No annotated-text undo/redo action stores a whole document-table image.
//
//   Scope: the tested slice is the text CRDT insert/undo/redo algebra. Delete
//   undo (undoing a deletion) and annotation/structural barrier semantics are
//   designed in docs/annotated-text-undo-algebra.md §3.2-3.4 and currently fail
//   closed; landing delete-undo is tracked against the compensation handler
//   (`src/entity/crud.mjs`, issue #55) and is out of scope here.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, durableHistory, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, read, ref, scope, write,
} from '../build/internal.mjs';
import {
  materializeText, restoreTextFamily,
} from '../build/annotated-text-continuous.mjs';
import { tryBuildAnnotatedTextFoldEnvelopes } from '../build/annotated-text-fold-envelope.mjs';
import { projectAnnotatedTextSnapshot } from '../build/annotated-text-snapshot.mjs';
import { ensureLease, ensureStream, hashClientNonce } from '../build/annotated-text-authoring-stream.mjs';
import { createAnnotatedTextHttpSession } from '../public/workbench-client.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

const SCOPE = 'Project:p1';
const ALICE = { type: 'user', id: 'alice' };
const BOB = { type: 'user', id: 'bob' };

function declaration() {
  const Project = entity('Project', {
    owner: ref('User'),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  const Document = entity('CollabDoc', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({ project: 'project', owner: 'owner' }).can(() => grant(read, write)),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  return { Project, Document };
}

async function setup(dbPath) {
  const db = new DatabaseSync(dbPath);
  const { Project, Document } = declaration();
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY)');
  db.exec("INSERT OR IGNORE INTO User (id) VALUES ('alice'), ('bob')");
  executeDDL(Project, db);
  db.exec("INSERT OR IGNORE INTO Project (id, owner) VALUES ('p1', 'alice')");
  executeDDL(Document, db);
  const app = workbench({
    db,
    entities: [Project, Document],
    history: durableHistory({ authorize: () => true, actions: {} }),
  });
  await app.start();
  if (!db.prepare("SELECT id FROM CollabDoc WHERE id = 'd1'").get()) {
    const created = await app.dispatch({
      actionId: 'create', type: 'CollabDoc.create',
      principal: ALICE,
      payload: { id: 'd1', project: 'p1', owner: 'alice', body: { version: 1, blocks: [{ text: 'hello' }] } },
    });
    assert.equal(created.ok, true, created.failure?.message);
  }
  return { app, db, Document: app.entities.get('CollabDoc') };
}

function bindingFor(ctx, principal) {
  const row = ctx.db.prepare('SELECT * FROM CollabDoc WHERE id = ?').get('d1');
  return withAuthoringBinding({
    db: ctx.db, entity: ctx.Document, Document: ctx.Document, row,
    principal, fieldName: 'body', descriptor: ctx.Document.fields.body,
  });
}

async function insert(ctx, actionId, principal, session, offset, textValue) {
  const binding = await bindingFor(ctx, principal);
  return ctx.app.dispatch({
    actionId, principal, scope: SCOPE, history: { session },
    type: 'CollabDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: actionId },
      edit: { kind: 'text.insert', at: { positionToken: binding.documentPositionToken, offset, affinity: 'right' }, text: textValue },
    },
  });
}

async function deleteRange(ctx, actionId, principal, fromOffset, toOffset) {
  const binding = await bindingFor(ctx, principal);
  return ctx.app.dispatch({
    actionId, principal, scope: SCOPE,
    type: 'CollabDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: actionId },
      edit: {
        kind: 'text.delete',
        from: { positionToken: binding.documentPositionToken, offset: fromOffset, affinity: 'left' },
        to: { positionToken: binding.documentPositionToken, offset: toOffset, affinity: 'right' },
      },
    },
  });
}

async function move(ctx, operation, actionId, principal = ALICE, session = 'tab-a') {
  const cursor = await ctx.app.history.cursor({ scope: SCOPE, principal, session });
  return ctx.app.history[operation]({ scope: SCOPE, principal, session, actionId, revision: cursor.revision });
}

function durableText(ctx) {
  const state = ctx.db.prepare("SELECT family_checkpoint FROM CollabDoc_body_state WHERE document_id = 'd1'").get();
  return materializeText(restoreTextFamily(JSON.parse(state.family_checkpoint)));
}

function operatedEvents(db) {
  return db.prepare("SELECT * FROM _Log WHERE eventType = 'CollabDoc.body.operated' ORDER BY seq").all();
}

function familyCheckpoint(db) {
  const state = db.prepare("SELECT family_checkpoint FROM CollabDoc_body_state WHERE document_id = 'd1'").get();
  return JSON.parse(state.family_checkpoint);
}

async function foldEnvelope(ctx, event, clientNonce = 'x'.repeat(43), principal = ALICE) {
  const document = {
    entity: ctx.Document, fieldName: 'body', descriptor: ctx.Document.fields.body,
    documentId: 'd1', clientNonce,
  };
  return tryBuildAnnotatedTextFoldEnvelopes(
    { event: { ...event, data: JSON.parse(event.eventData) }, scope: SCOPE, principal, db: ctx.db, document },
    { db: ctx.db, document },
  );
}

// Spawn a REAL browser-engine annotated-text session (the public client's one
// reconciliation path). It bootstraps from a server-side authorized snapshot
// and ingests every later transition as a fold envelope pushed through its SSE
// source — the same delivery the live-delivery seam ships. `push` builds the
// fold with THIS session's authoring client nonce and returns the envelope so
// the test can also inspect the exact transition the client folded.
async function spawnClientSession(ctx, principal, t) {
  const sources = [];
  let bootstrapGets = 0;
  let clientNonce;
  let bootstrapCursor;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: ctx.Document, field: { fieldName: 'body' }, documentId: 'd1' },
    historySession: 'tab-a',
    createActionId: () => 'client-session',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: bootstrapCursor }) };
      }
      bootstrapGets += 1;
      const parsed = new URL(url);
      clientNonce = parsed.searchParams.get('authoringClient');
      assert.match(clientNonce, /^[A-Za-z0-9_-]{43}$/);
      const row = ctx.db.prepare('SELECT * FROM CollabDoc WHERE id = ?').get('d1');
      const prefix = 'CollabDoc_body';
      const stream = ensureStream({
        db: ctx.db, prefix, documentId: 'd1',
        principalType: principal.type, principalId: principal.id,
      });
      const lease = ensureLease({
        db: ctx.db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce(clientNonce),
      });
      const fence = ctx.db.prepare('SELECT lastSeq FROM _Cursor WHERE scope = ?').get(SCOPE)?.lastSeq ?? 0;
      const snapshot = await projectAnnotatedTextSnapshot({
        db: ctx.db, entity: ctx.Document, row, principal,
        fieldName: 'body', descriptor: ctx.Document.fields.body,
        authoring: {
          streamToken: stream.id, leaseToken: lease.id, leaseId: lease.id,
          clientNonceHash: hashClientNonce(clientNonce), fence,
        },
      });
      bootstrapCursor = snapshot.authoring.acknowledgementFence;
      const { authoring, ...body } = snapshot;
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor: bootstrapCursor, authoring }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  t.after(() => { try { session.close(); } catch {} });
  return {
    session,
    clientNonce,
    bootstrapGets: () => bootstrapGets,
    push: async (event) => {
      const envelope = await foldEnvelope(ctx, event, clientNonce, principal);
      assert.equal(envelope[0].type, 'event', `expected a foldable envelope for ${event.actionId}`);
      sources[0].onmessage({ data: JSON.stringify(envelope) });
      return envelope;
    },
  };
}

async function waitForText(session, expected, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (session.document?.text === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for session text ${JSON.stringify(expected)}; got ${JSON.stringify(session.document?.text)}`);
}

// Seed a replica family from a server checkpoint, used to assert that each
// fold's operations are based on exactly the frontier the replica had reached.
function seedReplica(checkpoint) {
  const family = restoreTextFamily(structuredClone(checkpoint));
  return { family, text: materializeText(restoreTextFamily(structuredClone(checkpoint))) };
}

test('Alice undoes her own insertion after Bob edits elsewhere; Bob remains and redo re-applies only Alice', async (t) => {
  const c = await setup(':memory:');
  t.after(async () => { await c.app.shutdown(); c.db.close(); });

  assert.equal((await insert(c, 'alice-insert', ALICE, 'tab-a', 5, ' A')).ok, true);
  assert.equal((await insert(c, 'bob-insert', BOB, 'tab-b', 0, 'B ')).ok, true);
  assert.equal(durableText(c), 'B hello A');

  // No eligible annotated-text action ever stores a whole document-table image:
  // the contribution fact is the narrow v2 schema, and the operated event is the
  // exact v14 key set (no `tables`, no snapshot) that the fold seam requires.
  const original = JSON.parse(c.db.prepare("SELECT fact FROM _PrivateActionFact WHERE actionId = 'alice-insert'").get().fact);
  assert.equal(original.kind, 'annotated-text.contribution');
  assert.deepEqual(Object.keys(original).sort(), ['contribution', 'documentId', 'kind', 'version']);
  assert.deepEqual(Object.keys(original.contribution).sort(), ['anchor', 'kind', 'opId', 'scalarCount', 'text']);
  assert.equal(JSON.stringify(original).includes('tables'), false);
  const insertEvent = operatedEvents(c.db).at(-1);
  assert.equal(JSON.stringify(insertEvent.eventData).includes('tables'), false);

  const undone = await move(c, 'undo', 'alice-undo');
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(durableText(c), 'B hello');
  // Bob's contribution survives; the compensating op is a fresh delete.
  assert.equal(undone.events.length, 1);
  assert.equal(undone.events[0].data.operation.operation[5][0], 'delete');
  const undoFact = JSON.parse(c.db.prepare("SELECT fact FROM _PrivateActionFact WHERE actionId = 'alice-undo'").get().fact);
  assert.equal(undoFact.kind, 'annotated-text.compensation');
  assert.equal(undoFact.linkage.outcome, 'applied');
  assert.deepEqual(Object.keys(undoFact).sort(), ['contribution', 'documentId', 'kind', 'linkage', 'redo', 'version']);
  assert.equal(JSON.stringify(undoFact).includes('tables'), false);
  const undoEvent = operatedEvents(c.db).at(-1);
  assert.deepEqual(Object.keys(JSON.parse(undoEvent.eventData)).sort(), ['after', 'before', 'facts', 'id', 'operation', 'version']);
  assert.equal(JSON.stringify(undoEvent.eventData).includes('tables'), false);

  // Retrying the same undo id is idempotent via its durable receipt.
  const retried = await move(c, 'undo', 'alice-undo');
  assert.equal(retried.ok, true);
  assert.equal(retried.deduped, true);
  assert.equal(durableText(c), 'B hello');

  const redone = await move(c, 'redo', 'alice-redo');
  assert.equal(redone.ok, true, JSON.stringify(redone));
  assert.equal(durableText(c), 'B hello A');
  // Redo is a FRESH contribution, never the original op identity.
  assert.notDeepEqual(redone.events[0].data.operation.operation[2], original.contribution.opId);
  // Retrying the same redo id is idempotent via its durable receipt too.
  const redoneRetry = await move(c, 'redo', 'alice-redo');
  assert.equal(redoneRetry.ok, true);
  assert.equal(redoneRetry.deduped, true);
  assert.equal(durableText(c), 'B hello A');
  // Bob's own undo stack is untouched by Alice's move.
  const bobCursor = await c.app.history.cursor({ scope: SCOPE, principal: BOB, session: 'tab-b' });
  assert.deepEqual({ undo: bobCursor.undo, redo: bobCursor.redo }, { undo: 1, redo: 0 });
});

test('undo/redo is per-principal and per-session; neither can target another user', async (t) => {
  const c = await setup(':memory:');
  t.after(async () => { await c.app.shutdown(); c.db.close(); });

  assert.equal((await insert(c, 'alice-insert', ALICE, 'tab-a', 5, '!')).ok, true);
  assert.equal(durableText(c), 'hello!');

  // Bob (same session name, different principal) sees nothing and his move is a
  // durable empty no-op, not a jump into Alice's history.
  const bobCursor = await c.app.history.cursor({ scope: SCOPE, principal: BOB, session: 'tab-a' });
  assert.deepEqual({ undo: bobCursor.undo, redo: bobCursor.redo }, { undo: 0, redo: 0 });
  const empty = await move(c, 'undo', 'bob-undo', BOB, 'tab-a');
  assert.equal(empty.ok, true);
  assert.equal(empty.empty, true);
  assert.equal(durableText(c), 'hello!');

  // Alice in a different session sees nothing either, and her move is a durable
  // empty no-op rather than a jump into her other tab's history.
  const otherSession = await c.app.history.cursor({ scope: SCOPE, principal: ALICE, session: 'other' });
  assert.equal(otherSession.undo, 0);
  const otherEmpty = await move(c, 'undo', 'alice-other-undo', ALICE, 'other');
  assert.equal(otherEmpty.ok, true);
  assert.equal(otherEmpty.empty, true);
  assert.equal(durableText(c), 'hello!');

  // Alice in her own session can undo her own contribution.
  assert.equal((await move(c, 'undo', 'alice-undo')).ok, true);
  assert.equal(durableText(c), 'hello');
});

test('a concurrent client already deleted the contribution: undo is a durable no-op with no partial write', async (t) => {
  const c = await setup(':memory:');
  t.after(async () => { await c.app.shutdown(); c.db.close(); });

  assert.equal((await insert(c, 'alice-insert', ALICE, 'tab-a', 5, '!')).ok, true);
  assert.equal(durableText(c), 'hello!');
  // Bob deletes Alice's exact contribution ("hello!" → delete offset 5..6).
  const deleted = await deleteRange(c, 'bob-delete', BOB, 5, 6);
  assert.equal(deleted.ok, true, deleted.failure?.message);
  assert.equal(durableText(c), 'hello');

  const undone = await move(c, 'undo', 'alice-noop-undo');
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.deepEqual(undone.events, []);
  assert.equal(c.db.prepare("SELECT historyOutcome FROM _ActionReceipt WHERE actionId = 'alice-noop-undo'").get().historyOutcome, 'noop');
  assert.equal(durableText(c), 'hello');

  const redone = await move(c, 'redo', 'alice-noop-redo');
  assert.equal(redone.ok, true, JSON.stringify(redone));
  assert.deepEqual(redone.events, []);
  assert.equal(c.db.prepare("SELECT historyOutcome FROM _ActionReceipt WHERE actionId = 'alice-noop-redo'").get().historyOutcome, 'noop');
  assert.equal(durableText(c), 'hello');
});

test('reload persistence: durable text and the cursor survive a server restart on the same database file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-collab-undo-'));
  const dbPath = join(dir, 'collab.db');
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  let c = await setup(dbPath);
  await insert(c, 'alice-insert', ALICE, 'tab-a', 5, ' A');
  await insert(c, 'bob-insert', BOB, 'tab-b', 0, 'B ');
  assert.equal(durableText(c), 'B hello A');
  const undone = await move(c, 'undo', 'alice-undo');
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(durableText(c), 'B hello');
  await c.app.shutdown();
  c.db.close();

  // Reopen the same file: durable state persists and the cursor reconstructs.
  c = await setup(dbPath);
  assert.equal(durableText(c), 'B hello');
  const cursor = await c.app.history.cursor({ scope: SCOPE, principal: ALICE, session: 'tab-a' });
  assert.deepEqual({ undo: cursor.undo, redo: cursor.redo }, { undo: 0, redo: 1 });
  const redone = await move(c, 'redo', 'alice-redo');
  assert.equal(redone.ok, true, JSON.stringify(redone));
  assert.equal(durableText(c), 'B hello A');
  const afterRedo = await c.app.history.cursor({ scope: SCOPE, principal: ALICE, session: 'tab-a' });
  assert.deepEqual({ undo: afterRedo.undo, redo: afterRedo.redo }, { undo: 1, redo: 0 });

  await c.app.shutdown();
  c.db.close();
});

test('two client replicas converge through the normal fold/ingest path across insert, undo, and redo', async (t) => {
  const c = await setup(':memory:');
  t.after(async () => { await c.app.shutdown(); c.db.close(); });

  // Two REAL browser-engine clients bootstrap from the server snapshot before
  // any edit and ingest every transition as the fold envelope the live-delivery
  // seam emits — the client's one reconciliation path, not a hand-applied mirror.
  const alice = await spawnClientSession(c, ALICE, t);
  const bob = await spawnClientSession(c, BOB, t);

  const events = [];
  const serverText = [];
  const checkpoints = [];
  const folds = [];

  // Each transition is committed, then its fold envelope is built against the
  // family it produced and delivered to BOTH real clients, and each client's
  // folded document is awaited to the server's durable text before the next
  // transition commits — no intermediate state can race past an observation.
  await insert(c, 'alice-insert', ALICE, 'tab-a', 5, ' A');
  events.push(operatedEvents(c.db).at(-1)); serverText.push(durableText(c)); checkpoints.push(familyCheckpoint(c.db));
  folds.push(await alice.push(events.at(-1))); await waitForText(alice.session, serverText[0]);
  await bob.push(events.at(-1)); await waitForText(bob.session, serverText[0]);

  await insert(c, 'bob-insert', BOB, 'tab-b', 0, 'B ');
  events.push(operatedEvents(c.db).at(-1)); serverText.push(durableText(c)); checkpoints.push(familyCheckpoint(c.db));
  folds.push(await alice.push(events.at(-1))); await waitForText(alice.session, serverText[1]);
  await bob.push(events.at(-1)); await waitForText(bob.session, serverText[1]);

  await move(c, 'undo', 'alice-undo');
  events.push(operatedEvents(c.db).at(-1)); serverText.push(durableText(c)); checkpoints.push(familyCheckpoint(c.db));
  folds.push(await alice.push(events.at(-1))); await waitForText(alice.session, serverText[2]);
  await bob.push(events.at(-1)); await waitForText(bob.session, serverText[2]);

  await move(c, 'redo', 'alice-redo');
  events.push(operatedEvents(c.db).at(-1)); serverText.push(durableText(c)); checkpoints.push(familyCheckpoint(c.db));
  folds.push(await alice.push(events.at(-1))); await waitForText(alice.session, serverText[3]);
  await bob.push(events.at(-1)); await waitForText(bob.session, serverText[3]);

  // The server is the convergence reference for the whole transition series.
  assert.deepEqual(serverText, ['hello A', 'B hello A', 'B hello', 'B hello A']);

  // Each client folded every transition through its one reconciliation path: no
  // snapshot re-bootstrap (each fetched exactly the one bootstrap snapshot), no
  // recovery, no divergence from the server or from each other.
  assert.equal(alice.bootstrapGets(), 1, 'Alice folded every transition without snapshot recovery');
  assert.equal(bob.bootstrapGets(), 1, 'Bob folded every transition without snapshot recovery');
  assert.equal(alice.session.document.text, 'B hello A');
  assert.equal(bob.session.document.text, 'B hello A');
  assert.equal(alice.session.document.text, serverText[3]);

  // The folds the sessions ingested are real server output: undo is a fresh
  // delete, redo is a fresh insert (new opId), each based on exactly the
  // frontier the replica had reached (causal reconciliation).
  assert.equal(folds[2][0].fold.text.operations[0][5][0], 'delete');
  assert.equal(folds[3][0].fold.text.operations[0][5][0], 'insert');
  assert.notDeepEqual(folds[3][0].fold.text.operations[0][2], JSON.parse(events[0].eventData).operation.operation[2]);
  assert.equal(JSON.stringify(folds[2][0].fold.text.operations[0][4]), JSON.stringify(seedReplica(checkpoints[1]).family.checkpoint.frontier));
  assert.equal(JSON.stringify(folds[3][0].fold.text.operations[0][4]), JSON.stringify(seedReplica(checkpoints[2]).family.checkpoint.frontier));
});

test('malformed or erased inverse facts fail closed with no partial write', async (t) => {
  const c = await setup(':memory:');
  t.after(async () => { await c.app.shutdown(); c.db.close(); });

  assert.equal((await insert(c, 'alice-insert', ALICE, 'tab-a', 5, '!')).ok, true);

  // A malformed private fact cannot be canonical → forbidden, nothing written.
  c.db.prepare("UPDATE _PrivateActionFact SET fact = '{}' WHERE actionId = 'alice-insert'").run();
  const operatedBefore = operatedEvents(c.db).length;
  await assert.rejects(
    () => move(c, 'undo', 'alice-undo-malformed'),
    (error) => error?.status === 403,
  );
  assert.equal(durableText(c), 'hello!');
  assert.equal(operatedEvents(c.db).length, operatedBefore);
  assert.equal(c.db.prepare("SELECT COUNT(*) AS count FROM _ActionReceipt WHERE actionId = 'alice-undo-malformed'").get().count, 0);
  assert.equal(c.db.prepare("SELECT COUNT(*) AS count FROM _PrivateActionFact WHERE actionId = 'alice-undo-malformed'").get().count, 0);
  const cursorAfterMalformed = await c.app.history.cursor({ scope: SCOPE, principal: ALICE, session: 'tab-a' });
  assert.equal(cursorAfterMalformed.undo, 1);

  // An erased private fact is unavailable → rejects, nothing written.
  c.db.prepare("DELETE FROM _PrivateActionFact WHERE actionId = 'alice-insert'").run();
  await assert.rejects(
    () => move(c, 'undo', 'alice-undo-erased'),
    TypeError,
  );
  assert.equal(durableText(c), 'hello!');
  assert.equal(operatedEvents(c.db).length, operatedBefore);
  assert.equal(c.db.prepare("SELECT COUNT(*) AS count FROM _ActionReceipt WHERE actionId = 'alice-undo-erased'").get().count, 0);
  assert.equal(c.db.prepare("SELECT COUNT(*) AS count FROM _PrivateActionFact WHERE actionId = 'alice-undo-erased'").get().count, 0);
});
