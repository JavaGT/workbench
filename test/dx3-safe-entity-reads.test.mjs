// Principal-scoped Entity read helpers (fail-closed reads).
//
// findById/findAll are trusted internal primitives: no read scope, no row
// grant, no field projection. findByIdFor/findAllFor must compose all three,
// reject an omitted principal before touching SQLite, and never disclose an
// unauthorized row or an unreadable field.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { entity, everyone, grant, read, ref, scope, subscribe, text, write } from '../build/index.mjs';
import workbench from '../build/internal.mjs';

const alice = { type: 'user', id: 'alice' };
const bob = { type: 'user', id: 'bob' };
const outsider = { type: 'user', id: 'dave' };

// Row grant: owner gets full access, a named member gets a read-class grant,
// everyone else is denied the row outright. The `secret` field has its own
// owner-only `.can`, so a member can read the row but not that field.
function declareDoc() {
  return entity('Doc', {
    title: text(),
    owner: text(),
    member: text(),
    secret: text().can(async ({ is }) => (await is.owner() ? grant(read, write) : grant())),
    checks: {
      owner: ({ entity: row, principal }) => row.owner === principal.id,
      member: ({ entity: row, principal }) => row.member === principal.id,
    },
    grant: () => [scope(() => everyone()).can(async ({ is }) => (
      await is.owner() ? grant(read, write, subscribe)
        : await is.member() ? grant(read, subscribe)
          : grant()
    ))],
  });
}

function bootDoc() {
  const declaration = declareDoc();
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Doc (id TEXT, title TEXT, owner TEXT, member TEXT, secret TEXT)');
  db.prepare('INSERT INTO Doc VALUES (?, ?, ?, ?, ?)').run('d1', 'Report', 'alice', 'bob', 'top-secret-value');
  db.prepare('INSERT INTO Doc VALUES (?, ?, ?, ?, ?)').run('d2', 'Invoice', 'alice', 'carol', 'other-secret-value');
  const app = workbench({ db, entities: [declaration] });
  return { db, Doc: app.entity(declaration) };
}

// A scope-only grant confers read to every row handed to mayRow; the only
// tenant boundary is the compiled read scope. This is where a helper that
// called mayRow alone would fail open across tenants.
function declareTenantNote() {
  return entity('TenantNote', {
    title: text(),
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(({ is }) => is.owner())],
  });
}

function bootTenantNote() {
  const declaration = declareTenantNote();
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE TenantNote (id TEXT, title TEXT, owner TEXT)');
  db.prepare('INSERT INTO TenantNote VALUES (?, ?, ?)').run('n1', 'Alice note', 'alice');
  db.prepare('INSERT INTO TenantNote VALUES (?, ?, ?)').run('n2', 'Bob note', 'bob');
  const app = workbench({ db, entities: [declaration] });
  return { db, TenantNote: app.entity(declaration) };
}

test('missing/null principal throws before any read (fail closed)', async () => {
  const { Doc } = bootDoc();
  for (const bad of [undefined, null]) {
    await assert.rejects(Doc.findByIdFor('d1', bad), TypeError, /requires an explicit principal/);
    await assert.rejects(Doc.findAllFor(bad), TypeError, /requires an explicit principal/);
  }
  // The unscoped primitives stay callable without a principal (backwards compat).
  assert.equal(Doc.findById('d1').id, 'd1');
  assert.equal(Doc.findAll().length, 2);
});

test('unauthorized principal gets null from findByIdFor and [] from findAllFor', async () => {
  const { Doc } = bootDoc();
  assert.equal(await Doc.findByIdFor('d1', outsider), null);
  assert.equal(await Doc.findByIdFor('missing', alice), null);
  assert.deepEqual(await Doc.findAllFor(outsider), []);
});

test('authorized principal sees only permitted rows and only permitted fields', async () => {
  const { Doc } = bootDoc();

  // Owner sees the row and the owner-only field.
  const forAlice = await Doc.findByIdFor('d1', alice);
  assert.equal(forAlice.title, 'Report');
  assert.equal(forAlice.secret, 'top-secret-value');

  // A member can read the row but the confidential field is stripped entirely.
  const forBob = await Doc.findByIdFor('d1', bob);
  assert.equal(forBob.title, 'Report');
  assert.equal('secret' in forBob, false);
  assert.equal(JSON.stringify(forBob).includes('top-secret-value'), false);

  // List: alice sees both rows; bob sees only the row he is a member of, with
  // the confidential field stripped from it.
  assert.deepEqual((await Doc.findAllFor(alice)).map((r) => r.id).sort(), ['d1', 'd2']);
  const bobRows = await Doc.findAllFor(bob);
  assert.deepEqual(bobRows.map((r) => r.id), ['d1']);
  assert.equal('secret' in bobRows[0], false);
  assert.equal(JSON.stringify(bobRows).includes('top-secret-value'), false);
});

test('predicate filtering works with findAllFor(principal, predicate)', async () => {
  const { Doc } = bootDoc();
  const rows = await Doc.findAllFor(alice, Doc.title.is('Invoice'));
  assert.deepEqual(rows.map((r) => r.id), ['d2']);
  // A predicate never widens the authorized set.
  assert.deepEqual(await Doc.findAllFor(outsider, Doc.title.is('Invoice')), []);
});

test('compiled read scope is enforced even for a scope-only grant', async () => {
  const { TenantNote } = bootTenantNote();
  assert.equal((await TenantNote.findByIdFor('n1', alice))?.title, 'Alice note');
  // mayRow('read') alone would admit this row — the read scope must exclude it.
  assert.equal(await TenantNote.findByIdFor('n1', bob), null);
  assert.deepEqual((await TenantNote.findAllFor(alice)).map((r) => r.id), ['n1']);
  assert.deepEqual((await TenantNote.findAllFor(bob)).map((r) => r.id), ['n2']);
  assert.deepEqual(await TenantNote.findAllFor(outsider), []);
});
