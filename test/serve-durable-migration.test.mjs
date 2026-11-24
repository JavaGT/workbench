// Priority 1, Finding A — the HTTP CRUD dispatch runs through the durable kernel.
// A create/update/remove is no longer a raw INSERT/UPDATE/DELETE against app.db; it
// flows through `server.dispatch` (handler → event → Log append → projection →
// materialized row). Every mutation appends a committed row to the `_Log` table.
// bindReadScope + mayVerb still run (the two default-on auth layers, unchanged);
// only the WRITE mechanism moved onto the kernel (eng-review spec #5, #7, D1).

import { text, ref, scope, grant, read, write, subscribe } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity } from '../build/internal.mjs';

// An owner-scoped Note: only the owner may SEE a row, and the owner may
// read+write+subscribe. The owner field is server-assigned on create (readonly).
function ownedNote() {
  return entity('Note', {
        body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

test('HTTP create/update/remove flow through the durable kernel — every mutation appends to _Log', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  const NoteDeclaration = ownedNote();
  app.mount('/notes', NoteDeclaration);
  const _Note = app.entity(NoteDeclaration);
  await app.ddl(); // framework _Log/_Cursor + Note table
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  // create → a Note.created event is committed to _Log (not a raw INSERT).
  const r1 = await fetch(`${base}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'hi' }),
  });
  assert.equal(r1.status, 201);
  const created = await r1.json();
  assert.ok(created.id, 'create mints an id');
  assert.equal(created.body, 'hi');
  assert.equal(created.owner, 'u1', 'owner assigned from the principal');
  const createdLog = db.prepare("SELECT * FROM _Log WHERE eventType = 'Note.created'").all();
  assert.equal(createdLog.length, 1, 'create appended a Note.created event to _Log');
  assert.equal(createdLog[0].scope, `Note:${created.id}`);

  // update → a Note.updated event is committed to _Log.
  const r2 = await fetch(`${base}/notes/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'updated' }),
  });
  assert.equal(r2.status, 200);
  const updated = await r2.json();
  assert.equal(updated.body, 'updated');
  const updatedLog = db.prepare("SELECT * FROM _Log WHERE eventType = 'Note.updated'").all();
  assert.equal(updatedLog.length, 1, 'update appended a Note.updated event to _Log');

  // remove → a Note.removed event is committed to _Log, and the row is deleted.
  const r3 = await fetch(`${base}/notes/${created.id}`, { method: 'DELETE' });
  assert.equal(r3.status, 204);
  const removedLog = db.prepare("SELECT * FROM _Log WHERE eventType = 'Note.removed'").all();
  assert.equal(removedLog.length, 1, 'remove appended a Note.removed event to _Log');
  const rows = db.prepare('SELECT * FROM Note').all();
  assert.equal(rows.length, 0, 'the kernel projection deleted the row');
});

test('HTTP create denied by mayVerb writes nothing to _Log (txn rolled back is N/A — pre-check denies)', async (t) => {
  // A non-owner cannot update another principal's row: the row is in scope only
  // for the owner, so a non-owner gets 404 (not visible). That 404 must NOT append
  // to _Log — the dispatch never ran.
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  const NoteDeclaration = ownedNote();
  app.mount('/notes', NoteDeclaration);
  const Note = app.entity(NoteDeclaration);
  await app.ddl();
  // Seed a row owned by u1 (trusted insert bypasses the readonly owner check).
  Note.insert({ body: 'mine', owner: 'u1' });
  const seededId = Note.findAll()[0].id;
  app.listen(0, { principalOf: () => ({ id: 'u2' }) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  // u2 tries to update u1's row → 404 (out of scope, fail closed).
  const r = await fetch(`${base}/notes/${seededId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'hacked' }),
  });
  assert.equal(r.status, 404);
  const updatedLog = db.prepare("SELECT * FROM _Log WHERE eventType = 'Note.updated'").all();
  assert.equal(updatedLog.length, 0, 'a denied/404 mutation appends nothing to _Log');
});
