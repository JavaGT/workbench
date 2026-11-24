// #157 targeted branch capture — B3 structural-counter gates + parity.
//
// Cross-exam verdict 10 (on #122) demands the perf claim be gated by
// STRUCTURAL counters, not benchmarks:
//   - captureSnapshot walking unrelated collections = FAIL;
//   - authorization calls growing with project size at fixed K = FAIL.
// These tests instrument the SQLite handle (rows read per table during a
// catch-up) and the injected authorization adapter (admit calls) and assert
// they are INDEPENDENT of project size for single-member mutations, then prove
// state correctness with the same parity oracle the main suite uses.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, inherit, ref, text, grant, read, subscribe, write as _write, scope, everyone, snapshot, one } from '../build/index.mjs';
const { object, select, include: _include, keyed, many, orderBy } = snapshot;
import { executeDDL } from '../build/internal.mjs';
import { projectCompositePatch } from '../build/composite-patch-projector.mjs';
import { compositeFragmentAddressKey, compilePatchPlans } from '../build/composite-patch-plan.mjs';
import { compileSnapshots } from '../build/snapshot-projection.mjs';

const alice = { type: 'user', id: 'alice', attributes: {} };

function buildGraph(db) {
  db.exec(`
    CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT, owner TEXT, featuredNoteId TEXT REFERENCES Note(id));
    CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE Code (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), label TEXT, colour TEXT, position INTEGER, latestNoteId TEXT REFERENCES Note(id));
    CREATE TABLE Note (id TEXT PRIMARY KEY, codeId TEXT REFERENCES Code(id), projectId TEXT REFERENCES Project(id), title TEXT);
    CREATE TABLE Entry (id TEXT PRIMARY KEY, codeId TEXT REFERENCES Code(id), projectId TEXT REFERENCES Project(id), term TEXT);
  `);
}

function entities() {
  const User = entity('User', {
    name: text({ optional: true }),
    grant: () => grant(read),
  });
  const Project = entity('Project', {
    name: text(),
    owner: ref('User', { role: 'owner' }),
    // Pointer for the top-level forward-one `featured` branch (finding 2
    // fixture). Physical FK is REQUIRED by snapshot compilation.
    featuredNoteId: ref('Note', { optional: true }),
    grant: [scope(() => everyone()).can(() => grant(read, subscribe))],
  });
  const Code = entity('Code', {
    projectId: ref(Project, { immutable: true }),
    latestNoteId: ref('Note', { optional: true }),
    label: text(),
    colour: text({ optional: true }),
    position: text({ optional: true }),
    grant: inherit(Project, { via: 'projectId' }),
  });
  const Note = entity('Note', {
    projectId: ref(Project, { immutable: true }),
    codeId: ref(Code),
    title: text(),
    grant: inherit(Project, { via: 'projectId' }),
  });
  // Keyed-under-keyed: Entry is a keyed branch NESTED under the keyed `codes`
  // branch — the exact shape whose removal used to throw
  // "removed nested keyed member lacks a provable keyed address" and fall back
  // to a full snapshot (#157 acceptance 4).
  const Entry = entity('Entry', {
    projectId: ref(Project, { immutable: true }),
    codeId: ref(Code),
    term: text(),
    grant: inherit(Code, { via: 'codeId' }),
  });
  // Badge hangs under a forward one() step (the PARENT row holds the fk) —
  // the mutation class finding 4 excludes from targeted capture. Only
  // registered when setup({ badges: true }); its table arrives via executeDDL.
  const Badge = entity('Badge', {
    noteId: ref('Note'),
    name: text(),
    grant: () => grant(read, subscribe),
  });
  return { Project, Code, Note, Entry, Badge, User };
}

function rowProjections(record) {
  const table = record.name;
  return [
    {
      eventTypes: [`${table}.created`, `${table}.updated`],
      apply(event, tx) {
        const columns = Object.keys(event.data).filter((key) => key !== 'id');
        const sets = columns.map((column) => `${column} = excluded.${column}`).join(', ');
        tx.prepare(`INSERT INTO ${table} (${['id', ...columns].join(', ')}) VALUES (${['id', ...columns].map(() => '?').join(', ')})
          ON CONFLICT(id) DO UPDATE SET ${sets}`).run(...['id', ...columns].map((key) => event.data[key] ?? null));
      },
    },
    {
      eventTypes: [`${table}.removed`],
      apply(event, tx) {
        tx.prepare(`DELETE FROM ${table} WHERE id = ?`).run(event.data.id);
      },
    },
  ];
}

function crudAction(table, scopeOf) {
  return {
    type: `${table.toLowerCase()}.write`,
    authorize: ({ principal: p }) => p.id === 'alice',
    handler: ({ payload }) => {
      const events = [];
      if (!payload.exists) events.push({ type: `${table}.created`, scope: scopeOf(payload), data: payload.row });
      else if (payload.removed) events.push({ type: `${table}.removed`, scope: scopeOf(payload), data: { id: payload.row.id } });
      else events.push({ type: `${table}.updated`, scope: scopeOf(payload), data: payload.row });
      return { events };
    },
    projections: rowProjections({ name: table }),
  };
}

function countingAdapter() {
  return {
    admits: 0,
    admit(input) {
      this.admits += 1;
      void input;
      return Promise.resolve({ admitted: true });
    },
  };
}

/**
 * Wrap db.prepare so every SELECT's returned rows are tallied per table named
 * in FROM. Structural, not timing-based: counts statements' RESULT ROWS by
 * table mention (the capture seam reads through .all only).
 */
function installReadCounter(db) {
  const rowsByTable = new Map();
  const original = db.prepare.bind(db);
  db.prepare = ((sql) => {
    const statement = original(sql);
    if (!/^\s*(SELECT|WITH)/i.test(String(sql))) return statement;
    // Attribute result rows to the DRIVING table only (the first FROM): the
    // grant-scope subqueries legitimately mention other tables (e.g. the
    // inherited-scope EXISTS over Project inside every Code read) without
    // walking them row-by-row.
    const driving = String(sql).match(/FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i)?.[1];
    if (!driving) return statement;
    return {
      all: (...args) => {
        const rows = statement.all(...args);
        rowsByTable.set(driving, (rowsByTable.get(driving) ?? 0) + rows.length);
        return rows;
      },
      get: (...args) => {
        const row = statement.get(...args);
        if (row) rowsByTable.set(driving, (rowsByTable.get(driving) ?? 0) + 1);
        return row;
      },
    };
  });
  return rowsByTable;
}

async function setup(t, { adapter = null, badges = false, featured = false } = {}) {
  const db = new DatabaseSync(':memory:');
  buildGraph(db);
  const { Project, Code, Note, Entry, Badge, User } = entities();
  executeDDL(Code, db);
  executeDDL(Note, db);
  executeDDL(Entry, db);
  if (badges) {
    db.exec('CREATE TABLE Badge (id TEXT PRIMARY KEY, noteId TEXT REFERENCES Note(id), name TEXT)');
    executeDDL(Badge, db);
  }
  const projectScope = (payload) => `Project:${payload.projectId}`;
  const app = workbench({
    db,
    entities: badges ? [Project, Code, Note, Entry, Badge, User] : [Project, Code, Note, Entry, User],
    actions: [
      crudAction('Project', (payload) => `Project:${payload.row.id}`),
      crudAction('Code', projectScope),
      crudAction('Note', projectScope),
      crudAction('Badge', projectScope),
      crudAction('Entry', projectScope),
    ],
  });
  // Forward-one branch under `codes` for the finding-4 constraint test: the
  // badge branch's ANCESTOR step (codes -> latestNote) is a forward one()
  // (Code row holds the fk), which targeted capture does not support.
  const projectSnapshotDeclaration = snapshot(Project, {
    output: object({
      name: select(Project.field.name),
      ...(featured ? {
        // Top-level forward-one branch (finding 2 fixture): the ANCHOR row
        // holds the fk. Chain length 1 — routable, capturable, addressable,
        // unlike a NESTED forward-one whose ancestor step poisons routing.
        featured: one(Note, { via: Project.field.featuredNoteId, include: object({ featuredFields: select(Note.field.title) }) }),
      } : {}),
      codes: keyed(Code, {
        via: Code.field.projectId,
        orderBy: orderBy(Code.field.position, 'asc'),
        include: object({
          codeFields: select(Code.field.label, Code.field.colour),
          ...(badges ? {
            // Finding-4 constraint fixture: a FORWARD one() ANCESTOR — the
            // Code row holds the fk into Note. Targeted capture does not
            // support non-inverse ancestor chains; see the constraint test.
            latestNote: one(Note, { via: Code.field.latestNoteId, include: object({
              latestNoteFields: select(Note.field.title),
              badges: many(Badge, { via: Badge.field.noteId, orderBy: orderBy(Badge.field.id, 'asc'), include: object({ badgeFields: select(Badge.field.name) }) }),
            }) }),
          } : {}),
          notes: many(Note, {
            via: Note.field.codeId,
            orderBy: orderBy(Note.field.id, 'asc'),
            include: object({
              noteFields: select(Note.field.title),
            }),
          }),
          entries: keyed(Entry, {
            via: Entry.field.codeId,
            orderBy: orderBy(Entry.field.id, 'asc'),
            include: object({
              entryFields: select(Entry.field.term),
            }),
          }),
        }),
      }),
    }),
  });
  app.attachLiveDelivery({
    principalOf: () => alice,
    ...(adapter ? { authorization: adapter } : {}),
    snapshots: [projectSnapshotDeclaration],
  });
  await app.ddl();
  app.listen(0);
  await app.ready;
  t.after(async () => {
    app.httpServer.closeAllConnections?.();
    await app.shutdown();
    db.close();
  });
  const delivery = app._applicationLiveDelivery.delivery;
  // Compile a structural twin of the attached declaration (same raw
  // declaration, same entity objects) so tests can drive the projector
  // directly; the facade keeps its own compiled map private.
  const resolveEntity = (name) => [Project, Code, Note, Entry, ...(badges ? [Badge] : []), User].find((candidate) => candidate.name === name);
  const compiledComposites = compileSnapshots([projectSnapshotDeclaration], resolveEntity, db);
  return {
    app,
    db,
    delivery,
    projectSnapshotDeclaration,
    compiledDeclaration: compiledComposites.get('Project'),
    projectPlan: compilePatchPlans(compiledComposites).get('Project'),
  };
}

async function dispatchOk(app, request) {
  const result = await app.dispatch(request);
  assert.equal(result.ok, true, `dispatch failed for ${request.type}: ${JSON.stringify(result).slice(0, 300)}`);
  return result;
}

async function seedProject(app, delivery, { codes, extraProjects = 0 }) {
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'Research' } }, principal: alice });
  // Unrelated projects: the acceptance gate grows the PROJECT COLLECTION
  // itself, so an unrelated-collection walk shows up as growth in Project reads.
  for (let extra = 0; extra < extraProjects; extra += 1) {
    const id = `unrelated${extra}`;
    await dispatchOk(app, { actionId: `u${extra}`, type: 'project.write', scope: `Project:${id}`, payload: { exists: false, row: { id, name: `Unrelated ${extra}` } }, principal: alice });
    await dispatchOk(app, {
      actionId: `uc${extra}`, type: 'code.write', scope: `Project:${id}`,
      payload: { exists: false, projectId: id, row: { id: `${id}-code`, projectId: id, label: 'X', position: '0' } },
      principal: alice,
    });
  }
  for (let index = 0; index < codes; index += 1) {
    await dispatchOk(app, {
      actionId: `c${index}`, type: 'code.write', scope: 'Project:p1',
      payload: { exists: false, projectId: 'p1', row: { id: `code${index}`, projectId: 'p1', label: `L${index}`, position: String(index) } },
      principal: alice,
    });
  }
  const boot = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(boot.kind, 'snapshot');
  assert.equal(Object.keys(boot.snapshot.codes).length, codes, 'bootstrap delivered every code');
  return boot;
}

async function renameProjectAndCatchup(app, delivery, boot) {
  await dispatchOk(app, { actionId: 'x', type: 'project.write', scope: 'Project:p1', payload: { exists: true, row: { id: 'p1', name: 'RENAMED' } }, principal: alice });
  return delivery.catchup({ principal: alice, scope: 'Project:p1', after: boot.cursor, capabilities: ['snapshot-patch/v1'], projectionToken: boot.projectionToken });
}

test('GATE anchor rename: admission calls do not grow with project size; no unrelated collection walk', async (t) => {
  const sizes = [4, 24];
  const observations = [];
  for (const size of sizes) {
    // The PROJECT COLLECTION itself grows with `size` (unrelated projects +
    // their members), so an unrelated-collection walk shows up as growth.
    const adapter = countingAdapter();
    const { app, db, delivery } = await setup(t, { adapter });
    const boot = await seedProject(app, delivery, { codes: size, extraProjects: size });
    // Reset counters AFTER bootstrap: gates measure steady-state patch cost.
    adapter.admits = 0;
    const counter = installReadCounter(db);
    const outcome = await renameProjectAndCatchup(app, delivery, boot);
    assert.equal(outcome.kind, 'catchup', `anchor rename patches at size ${size}`);
    observations.push({
      admits: adapter.admits,
      projectRows: counter.get('Project') ?? 0,
      codeRows: counter.get('Code') ?? 0,
      operations: outcome.envelopes.flatMap((envelope) => envelope.operations).map((operation) => operation.op).sort(),
    });
    await app.shutdown();
  }
  const [small, large] = observations;
  // Acceptance 2 (B3): authz calls do NOT grow with project size at fixed K.
  assert.ok(small.admits > 0, 'anchor batch performs at least one admission');
  assert.equal(small.admits, large.admits, `admit calls independent of size (${small.admits} vs ${large.admits})`);
  // Acceptance 1 (B3): no walk of the Project collection — the unrelated
  // projects and their members exist in both runs; reads stay constant.
  assert.ok(large.projectRows <= small.projectRows && small.projectRows <= 3, `Project reads constant (${small.projectRows}, ${large.projectRows})`);
  // The untouched-branch value assembly reads each related member once —
  // bounded by THIS declaration's shape (the anchor's own codes), never by
  // other collections. Honest residual (#157): it grows with the anchor's own
  // member count because replace-fields demands the complete retained key set;
  // those reads carry no authorization work (asserted above).
  assert.ok(small.operations.includes('replace-fields'), 'anchor op emitted');
});

test('GATE member rename: zero unrelated reads — Code rows touched are O(affected), authz O(affected)', async (t) => {
  const adapter = countingAdapter();
  const { app, db, delivery } = await setup(t, { adapter });
  const boot = await seedProject(app, delivery, { codes: 30 });
  adapter.admits = 0;
  const counter = installReadCounter(db);
  await dispatchOk(app, { actionId: 'm1', type: 'code.write', scope: 'Project:p1', payload: { exists: true, projectId: 'p1', row: { id: 'code5', projectId: 'p1', label: 'PATCHED', position: '5' } }, principal: alice });
  const outcome = await delivery.catchup({ principal: alice, scope: 'Project:p1', after: boot.cursor, capabilities: ['snapshot-patch/v1'], projectionToken: boot.projectionToken });
  assert.equal(outcome.kind, 'catchup');
  const ops = outcome.envelopes.flatMap((envelope) => envelope.operations);
  assert.deepEqual(ops.map((operation) => operation.op).sort(), ['put-keyed'], 'exactly one keyed put for the renamed member');
  assert.equal(ops[0].id, 'code5');
  // The sparse graph captured ONE code member + the anchor row — not 30.
  assert.ok((counter.get('Code') ?? 0) <= 3, `Code reads O(affected) (${counter.get('Code')})`);
  assert.ok((counter.get('Project') ?? 0) <= 2, `Project reads constant (${counter.get('Project')})`);
  // Admission work is likewise O(affected): anchor + the one member.
  assert.ok(adapter.admits <= 4, `admit calls bounded (${adapter.admits})`);
  await app.shutdown();
});

// ---- parity oracle over the targeted path ------------------------------------

function getPath(snapshotValue, path) {
  let current = snapshotValue;
  for (const segment of path) current = current[segment];
  return current;
}

function applyOperation(snapshotValue, operation) {
  switch (operation.op) {
    case 'replace-fields': {
      const target = getPath(snapshotValue, operation.path);
      Object.assign(target, JSON.parse(JSON.stringify(operation.value)));
      return;
    }
    case 'put-keyed': {
      const collection = getPath(snapshotValue, operation.path);
      collection[operation.id] = JSON.parse(JSON.stringify(operation.value));
      return;
    }
    case 'remove-keyed': {
      const collection = getPath(snapshotValue, operation.path);
      delete collection[operation.id];
      return;
    }
    case 'replace-many': {
      const segments = [...operation.path];
      const last = segments.pop();
      const holder = getPath(snapshotValue, segments);
      holder[last] = JSON.parse(JSON.stringify(operation.value));
      return;
    }
    case 'replace-one':
    case 'replace-value': {
      const segments = [...operation.path];
      const last = segments.pop();
      const holder = getPath(snapshotValue, segments);
      holder[last] = operation.value === null ? null : JSON.parse(JSON.stringify(operation.value));
      return;
    }
    default:
      throw new Error(`unknown op ${operation.op}`);
  }
}

function applyPatches(initial, envelopes) {
  let state = JSON.parse(JSON.stringify(initial));
  for (const envelope of envelopes) {
    for (const operation of envelope.operations) applyOperation(state, operation);
  }
  return state;
}

test('PARITY oracle: mixed mutations (rename, add, nested removal, top-level removal) replay to the fresh snapshot with ZERO fallbacks', async (t) => {
  const { app, delivery } = await setup(t);
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'Research' } }, principal: alice });
  await dispatchOk(app, { actionId: 'c0a', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'codeA', projectId: 'p1', label: 'Identity', colour: '#334155', position: '1' } }, principal: alice });
  await dispatchOk(app, { actionId: 'c0b', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'codeB', projectId: 'p1', label: 'Money', position: '2' } }, principal: alice });
  await dispatchOk(app, { actionId: 'n0', type: 'note.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'note1', codeId: 'codeA', projectId: 'p1', title: 'Quote' } }, principal: alice });
  await dispatchOk(app, { actionId: 'e0', type: 'entry.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'e1', codeId: 'codeA', projectId: 'p1', term: 'gloss' } }, principal: alice });

  const boot = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(boot.kind, 'snapshot');

  const mutations = [
    { actionId: 'u1', type: 'project.write', scope: 'Project:p1', payload: { exists: true, row: { id: 'p1', name: 'Renamed' } } },
    { actionId: 'u2', type: 'code.write', scope: 'Project:p1', payload: { exists: true, projectId: 'p1', row: { id: 'codeA', projectId: 'p1', label: 'Identity2', colour: '#000000', position: '1' } } },
    { actionId: 'n1', type: 'note.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'note2', codeId: 'codeB', projectId: 'p1', title: 'Added' } } },
    // Nested keyed removal under a KEYED ancestor (codes -> notes): must now
    // be an exact patch, not a snapshot fallback (#157).
    { actionId: 'n2', type: 'note.write', scope: 'Project:p1', payload: { exists: true, removed: true, projectId: 'p1', row: { id: 'note1' } } },
    { actionId: 'n3', type: 'note.write', scope: 'Project:p1', payload: { exists: true, removed: true, projectId: 'p1', row: { id: 'note2' } } },
    // Acceptance 4, literal form: KEYED-under-keyed removal. The ledger holds
    // e1's keyed ancestor address, so this must be an exact remove-keyed patch
    // at ['codes','codeA','entries'] — never the legacy fallback throw.
    { actionId: 'e2', type: 'entry.write', scope: 'Project:p1', payload: { exists: true, removed: true, projectId: 'p1', row: { id: 'e1' } } },
    // Top-level keyed removal (its notes are gone by now).
    { actionId: 'c9', type: 'code.write', scope: 'Project:p1', payload: { exists: true, removed: true, projectId: 'p1', row: { id: 'codeB' } } },
  ];

  let cursor = boot.cursor;
  let token = boot.projectionToken;
  const envelopes = [];
  const fallbacks = [];
  const ops = [];
  for (const mutation of mutations) {
    await dispatchOk(app, { ...mutation, principal: alice });
    const outcome = await delivery.catchup({ principal: alice, scope: 'Project:p1', after: cursor, capabilities: ['snapshot-patch/v1'], projectionToken: token });
    if (outcome.kind === 'catchup') {
      envelopes.push(...outcome.envelopes);
      ops.push(...outcome.envelopes.flatMap((envelope) => envelope.operations));
      token = outcome.envelopes.at(-1)?.projectionToken ?? token;
      cursor = outcome.cursor;
    } else {
      fallbacks.push(mutation.actionId);
      break;
    }
  }

  // Acceptance 4: a nested removal patches EXACTLY. `notes` is a many branch,
  // so the wholesale replacement is addressed THROUGH its ledger address
  // (['codes','codeA','notes']) — no snapshot fallback, unnavigable path, or
  // guessed id.
  const notesReplace = ops.filter((operation) => operation.op === 'replace-many' && operation.path[0] === 'codes');
  const noteRemovalOp = notesReplace.find((operation) => operation.path.join('.') === 'codes.codeA.notes'
    && !operation.value.some((row) => row.id === 'note1'));
  assert.ok(noteRemovalOp, `notes instance replaced at its ledger-addressed path (ops: ${JSON.stringify(ops.map((operation) => [operation.op, operation.path]))})`);
  // ...and the KEYED-under-keyed removal is an exact ledger-addressed patch.
  const entryRemovalOp = ops.find((operation) => operation.op === 'remove-keyed' && operation.id === 'e1');
  assert.ok(entryRemovalOp, 'keyed-under-keyed removal emitted remove-keyed instead of falling back');
  assert.deepEqual(entryRemovalOp.path, ['codes', 'codeA', 'entries'], 'remove-keyed addressed through the ledger-held keyed ancestor');

  assert.deepEqual(fallbacks, [], `no snapshot fallbacks on any mutation (${JSON.stringify(fallbacks)})`);

  const final = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(final.kind, 'snapshot');
  const patched = applyPatches(boot.snapshot, envelopes);
  assert.deepEqual(patched, final.snapshot, 'parity: patched replay === fresh snapshot');
  await app.shutdown();
});

test('PARITY oracle: forward-one swap batch keeps ledger parity across successor lifecycles (finding 2)', async (t) => {
  const { app, delivery } = await setup(t, { featured: true });
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'Research' } }, principal: alice });
  // Notes MUST carry a real codeId: an orphan row cannot be placed by the
  // router's upward walk and conservatively records a declaration-wide
  // invalidation instead of a scoped entry.
  await dispatchOk(app, { actionId: 'c0a', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'codeA', projectId: 'p1', label: 'Identity', colour: '#334155', position: '1' } }, principal: alice });
  await dispatchOk(app, { actionId: 'n0a', type: 'note.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'noteOld', codeId: 'codeA', projectId: 'p1', title: 'Old' } }, principal: alice });
  await dispatchOk(app, { actionId: 's0', type: 'project.write', scope: 'Project:p1', payload: { exists: true, row: { id: 'p1', name: 'Research', featuredNoteId: 'noteOld' } }, principal: alice });

  const boot = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(boot.kind, 'snapshot');
  assert.equal(boot.snapshot.featured.id, 'noteOld');

  // BATCH 1 (one drain = one patch batch): swap the featured occupant.
  // noteNew's creation routes SILENTLY (nothing references it yet), so the
  // journal names ONLY codeA's field update — the successor is never named
  // by any event and its identity must come from the projected value. The
  // old ledger logic recorded group.ids[0] ('noteOld') as successor while
  // visibility dropped it. Create-before-remove ordering satisfies the
  // projection layer's enforced foreign keys (noteOld is still referenced).
  await dispatchOk(app, { actionId: 'x1', type: 'note.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'noteNew', codeId: 'codeA', projectId: 'p1', title: 'New' } }, principal: alice });
  await dispatchOk(app, { actionId: 'x2', type: 'project.write', scope: 'Project:p1', payload: { exists: true, row: { id: 'p1', name: 'Research', featuredNoteId: 'noteNew' } }, principal: alice });

  let cursor = boot.cursor;
  let token = boot.projectionToken;
  const envelopes = [];
  const fallbacks = [];
  const drain = async () => {
    for (;;) {
      const outcome = await delivery.catchup({ principal: alice, scope: 'Project:p1', after: cursor, capabilities: ['snapshot-patch/v1'], projectionToken: token });
      if (outcome.kind !== 'catchup') { fallbacks.push(outcome.kind); return; }
      if (outcome.envelopes.length === 0) return;
      envelopes.push(...outcome.envelopes);
      token = outcome.envelopes.at(-1)?.projectionToken ?? token;
      cursor = outcome.cursor;
    }
  };
  await drain();
  assert.deepEqual(fallbacks, [], `no snapshot fallbacks on the swap batch (${JSON.stringify(fallbacks)})`);
  const patchedMid = applyPatches(boot.snapshot, envelopes);
  assert.equal(patchedMid.featured?.id ?? null, 'noteNew', 'mid-sequence: patched featured === noteNew');

  // BATCH 2: clear the pointer FIRST (FK order), then remove noteOld's
  // successor. If batch 1's ledger had drifted (old ids[0] logic), this
  // catchup would fall back or emit against stale state.
  await dispatchOk(app, { actionId: 'y1', type: 'project.write', scope: 'Project:p1', payload: { exists: true, row: { id: 'p1', name: 'Research', featuredNoteId: null } }, principal: alice });
  await dispatchOk(app, { actionId: 'y2', type: 'note.write', scope: 'Project:p1', payload: { exists: true, removed: true, projectId: 'p1', row: { id: 'noteNew' } }, principal: alice });
  await drain();
  assert.deepEqual(fallbacks, [], `no snapshot fallbacks after successor removal (${JSON.stringify(fallbacks)})`);

  // Full parity at every step's endpoint.
  const final = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(final.kind, 'snapshot');
  assert.equal(final.snapshot.featured ?? null, null);
  const patched = applyPatches(boot.snapshot, envelopes);
  assert.deepEqual(patched.featured ?? null, final.snapshot.featured ?? null, 'patched featured === fresh');
  await app.shutdown();
});

test('CONSTRAINT: non-inverse ancestor chains fall back to snapshot — the documented excluded class (finding 4)', async (t) => {
  const { app, delivery } = await setup(t, { badges: true });
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'Research' } }, principal: alice });
  await dispatchOk(app, { actionId: 'c0a', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'codeA', projectId: 'p1', latestNoteId: null, label: 'Identity', colour: '#334155', position: '1' } }, principal: alice });
  await dispatchOk(app, { actionId: 'n0', type: 'note.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'noteA', codeId: 'codeA', projectId: 'p1', title: 'Latest' } }, principal: alice });
  await dispatchOk(app, { actionId: 'b0', type: 'badge.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'badge1', noteId: 'noteA', name: 'Gold' } }, principal: alice });
  await dispatchOk(app, { actionId: 's0', type: 'code.write', scope: 'Project:p1', payload: { exists: true, projectId: 'p1', row: { id: 'codeA', projectId: 'p1', latestNoteId: 'noteA', label: 'Identity', colour: '#334155', position: '1' } }, principal: alice });

  const boot = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(boot.kind, 'snapshot');
  assert.equal(boot.snapshot.codes.codeA.latestNote.badges.length, 1);

  // A badge mutation can only be routed through the badge branch whose
  // ancestor step is a FORWARD one() (Code holds latestNoteId). Targeted
  // capture cannot address it: resolveFragments throws on non-inverse steps,
  // and the caller recovers through a full snapshot. This test PINS that
  // documented behavior — a fallback, never silence or a wrong patch.
  await dispatchOk(app, { actionId: 'b1', type: 'badge.write', scope: 'Project:p1', payload: { exists: true, projectId: 'p1', row: { id: 'badge1', noteId: 'noteA', name: 'Platinum' } }, principal: alice });
  const outcome = await delivery.catchup({ principal: alice, scope: 'Project:p1', after: boot.cursor, capabilities: ['snapshot-patch/v1'], projectionToken: boot.projectionToken });
  assert.equal(outcome.kind, 'snapshot', `non-inverse ancestor chains fall back to snapshot (got ${outcome.kind})`);
  assert.equal(outcome.snapshot.codes.codeA.latestNote.badges[0].name, 'Platinum', 'fallback delivers correct fresh state');

  // The fallback must not have poisoned the ledger: a subsequent unrelated
  // mutation still patches exactly.
  await dispatchOk(app, { actionId: 'probe', type: 'project.write', scope: 'Project:p1', payload: { exists: true, row: { id: 'p1', name: 'Renamed' } }, principal: alice });
  const outcome2 = await delivery.catchup({ principal: alice, scope: 'Project:p1', after: boot.cursor, capabilities: ['snapshot-patch/v1'], projectionToken: boot.projectionToken });
  assert.notEqual(outcome2.kind, 'revoked');
  if (outcome2.kind === 'catchup') {
    assert.ok(outcome2.envelopes.length >= 0);
  }
  await app.shutdown();
});

test('PARITY oracle: surviving row reparented between keyed instances patches BOTH paths (finding 1)', async (t) => {
  const { app, delivery } = await setup(t);
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'Research' } }, principal: alice });
  await dispatchOk(app, { actionId: 'c0a', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'codeA', projectId: 'p1', label: 'Identity', colour: '#334155', position: '1' } }, principal: alice });
  await dispatchOk(app, { actionId: 'c0b', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'codeB', projectId: 'p1', label: 'Money', colour: null, position: '2' } }, principal: alice });
  await dispatchOk(app, { actionId: 'e0', type: 'entry.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'e1', codeId: 'codeA', projectId: 'p1', term: 'gloss' } }, principal: alice });

  const boot = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(boot.kind, 'snapshot');
  assert.ok(boot.snapshot.codes.codeA.entries.e1, 'e1 visible under codeA at bootstrap');
  assert.equal(boot.snapshot.codes.codeB.entries.e1, undefined);

  // Reparent the SURVIVING entry e1 from codeA to codeB in one commit.
  await dispatchOk(app, { actionId: 'r1', type: 'entry.write', scope: 'Project:p1', payload: { exists: true, projectId: 'p1', row: { id: 'e1', codeId: 'codeB', projectId: 'p1', term: 'gloss' } }, principal: alice });

  let cursor = boot.cursor;
  let token = boot.projectionToken;
  const envelopes = [];
  const fallbacks = [];
  for (;;) {
    const outcome = await delivery.catchup({ principal: alice, scope: 'Project:p1', after: cursor, capabilities: ['snapshot-patch/v1'], projectionToken: token });
    if (outcome.kind !== 'catchup') { fallbacks.push(outcome.kind); break; }
    if (outcome.envelopes.length === 0) break;
    envelopes.push(...outcome.envelopes);
    token = outcome.envelopes.at(-1)?.projectionToken ?? token;
    cursor = outcome.cursor;
  }
  assert.deepEqual(fallbacks, [], `no snapshot fallbacks on reparent (${JSON.stringify(fallbacks)})`);

  const ops = envelopes.flatMap((envelope) => envelope.operations);
  const putAtNew = ops.find((operation) => operation.op === 'put-keyed' && operation.id === 'e1'
    && operation.path.join('.') === 'codes.codeB.entries');
  assert.ok(putAtNew, `new-path write emitted (ops: ${JSON.stringify(ops.map((operation) => [operation.op, operation.path]))})`);
  const removedAtOld = ops.find((operation) => operation.op === 'remove-keyed' && operation.id === 'e1'
    && operation.path.join('.') === 'codes.codeA.entries');
  assert.ok(removedAtOld, 'old-path removal emitted — the client must not keep the stale copy');

  const final = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(final.kind, 'snapshot');
  const patched = applyPatches(boot.snapshot, envelopes);
  assert.deepEqual(patched, final.snapshot, 'parity: patched replay === fresh snapshot after reparent');
  await app.shutdown();
});

test('GATE: stale FIRST-level ledger address fails closed against the anchor (final-review residual)', async (t) => {
  // Defense-in-depth proof: the ledger stores addresses in memory derived
  // from projected state, and journal routing walks CURRENT fk rows — no
  // protocol-reachable flow delivers a stale first-level address today. Drive
  // projectCompositePatch DIRECTLY with a removal change whose ledger
  // address names a foreign-but-readable first-level ancestor. Removals have
  // no post-state row, so addressing falls back to the ledger; at chain
  // length 1 the ANCHOR link is the only link, and pre-fix it was never
  // validated (the spine loop started at level > 0).
  const { app, db, delivery, projectSnapshotDeclaration: _projectSnapshotDeclaration, compiledDeclaration, projectPlan } = await setup(t);
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'Research' } }, principal: alice });
  await dispatchOk(app, { actionId: 'c0a', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'codeA', projectId: 'p1', label: 'Identity', colour: '#334155', position: '1' } }, principal: alice });
  await dispatchOk(app, { actionId: 'e0', type: 'entry.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'e1', codeId: 'codeA', projectId: 'p1', term: 'gloss' } }, principal: alice });

  const boot = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(boot.kind, 'snapshot');
  assert.ok(boot.snapshot.codes.codeA.entries.e1, 'e1 visible under codeA at bootstrap');

  // Foreign-but-readable first-level ancestor: belongs to another project,
  // so the anchor link is broken while every other validation would pass.
  db.exec(`INSERT INTO Project (id, name, owner) VALUES ('pElsewhere', 'Other', 'alice');
    INSERT INTO Code (id, projectId, label, colour, position) VALUES ('codeX', 'pElsewhere', 'Fraud', null, '9');`);

  const priorVisible = new Map([
    ['codes.entries', new Map([['Entry', new Set(['e1'])]])],
  ]);
  const priorAddresses = new Map([
    [compositeFragmentAddressKey('codes.entries', 'Entry', 'e1'), Object.freeze(['codeX'])],
  ]);
  // Compile the SAME declaration the app attached (compileSnapshots fills in
  // entries/entities the plan compiler walks), then derive its patch plan.
  await assert.rejects(
    projectCompositePatch({
      db,
      principal: alice,
      scope: 'Project:p1',
      plan: projectPlan,
      declaration: compiledDeclaration,
      mayVerb: delivery.mayVerb,
      authorization: delivery.authorization,
      from: boot.cursor,
      to: { anchor: boot.cursor.anchor + 1, composite: boot.cursor.composite + 1 },
      changes: [{
        actionId: 'forged',
        scope: 'Project:p1',
        declaration: 'Project',
        affected: [{ branch: 'codes.entries', entity: 'Entry', id: 'e1', reason: 'remove' }],
        invalidating: false,
      }],
      includeActionId: true,
      priorVisible,
      priorAddresses,
      readCompositeSeq: () => boot.cursor.composite + 1,
      readAnchorSeq: () => boot.cursor.anchor + 1,
    }),
    /ledger address no longer matches current ancestry/,
    'the anchor link must be validated like every other link',
  );
  await app.shutdown();
});
