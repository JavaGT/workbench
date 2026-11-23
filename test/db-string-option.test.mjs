// db-string-option.test.mjs — the `db:` option accepts a string the framework
// opens itself (a bare path or ':memory:'), so an app never imports DatabaseSync
// just to hand the framework an instance it could open from the same string.
// Since S1/A2 a string is opened through the sqlite adapter: the directory is
// owned (derived data.sqlite + lock sidecar + protected subdirectories), the
// PRAGMAs come from the centralized layer, and shutdown checkpoints + closes.
// A pre-built handle still works unchanged.

import { entity, text, ref, grant, read, write, subscribe, scope } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import workbench from '../build/internal.mjs';

// A minimal owned entity (the note.mjs floor), used to confirm a string-opened
// db yields a working app whose entity table is created by prepareSchema.
function makeNote() {
  return entity('Note', {
        body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

test('workbench({ db: ":memory:" }) yields a working app whose entity table exists', async () => {
  const app = workbench({ db: ':memory:' }).mount('/notes', makeNote());
  await app.prepareSchema();
  const row = app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Note'").get();
  assert.ok(row, 'the Note entity table was created by prepareSchema');
  await app.shutdown();
});

test('a file-path db string opens an owned directory with the derived physical layout', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'express-db-string-'));
  const file = path.join(dir, 'sub', 'todo.db');
  const app = workbench({ db: file }).mount('/notes', makeNote());
  await app.prepareSchema();
  try {
    // The adapter owns the directory and derives the physical db filename; the
    // app never sees it as a bare self-opened file.
    assert.equal(existsSync(file), false, 'the raw string path is not used verbatim');
    assert.ok(existsSync(path.join(dir, 'sub', 'data.sqlite')), 'the derived data.sqlite exists');
    assert.ok(existsSync(path.join(dir, 'sub', 'lock.sqlite')), 'the lock sidecar exists');
    // The installed handle supports SQL on either runtime.
    if (typeof globalThis.Bun === 'undefined') assert.ok(app.db instanceof DatabaseSync);
    assert.equal(app.db.prepare('SELECT 1 AS value').get().value, 1);
    const row = app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Note'").get();
    assert.ok(row, 'the entity table exists in the adapter-owned db');
  } finally {
    await app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('passing an existing DatabaseSync instance still works (unchanged behavior)', async () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/notes', makeNote());
  await app.prepareSchema();
  try {
    assert.equal(app.db, db, 'a pre-built handle is passed through unchanged');
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Note'").get();
    assert.ok(row, 'the entity table exists on the passed-in handle');
  } finally {
    db.close();
  }
});
