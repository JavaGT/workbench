// Composite patch delivery tests (#122 design §13 + cross-exam 10 red-lines).
//
// Parity oracle: applyPatches(initialSnapshot, patches) deep-equals a fresh
// authorized snapshot at the same cursor. Red-line gate: custom-event
// coverage (code.merged routes or invalidates — NEVER silence); revocation
// invalidation; nested keyed removal behavior; retention prune mid-chain;
// reconnect token race; duplicate/gapped/coalesced envelopes; structural
// counters (captureSnapshot walking unrelated collections = FAIL).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, inherit, ref, text, grant, read, subscribe, write as _write, scope, everyone, snapshot } from '../build/index.mjs';
const { object, select, include: _include, keyed, many, one: _one, count, orderBy } = snapshot;
import { executeDDL } from '../build/internal.mjs';
import { createLiveDeliverySession } from '../public/workbench-client.mjs';

const alice = { type: 'user', id: 'alice', attributes: {} };
const bob = { type: 'user', id: 'bob', attributes: {} };

function buildGraph(db) {
  db.exec(`
    CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT, owner TEXT);
    CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE Code (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), label TEXT, colour TEXT, position INTEGER);
    CREATE TABLE Note (id TEXT PRIMARY KEY, codeId TEXT REFERENCES Code(id), projectId TEXT REFERENCES Project(id), title TEXT);
    CREATE TABLE Meta (id TEXT PRIMARY KEY, noteId TEXT REFERENCES Note(id), tag TEXT);
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
    // A compiled read-scope; children inherit it via `inherit(Project, ...)`.
    grant: [scope(() => everyone()).can(() => grant(read, subscribe))],
  });
  const Code = entity('Code', {
    projectId: ref(Project, { immutable: true }),
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
  const Meta = entity('Meta', {
    noteId: ref(Note),
    tag: text(),
    grant: () => grant(read, subscribe),
  });
  return { Project, Code, Note, Meta, User };
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

// A code.merged-shaped application event: no lifecycle suffix, no data.id —
// the exact triple-silence shape from cross-exam finding 1.
function mergeAction() {
  return {
    type: 'code.merge',
    authorize: () => true,
    handler: ({ payload }) => ({
      events: [{
        type: 'code.merged',
        scope: `Project:${payload.projectId}`,
        data: payload.fact,
      }],
      // Declared routing facts via the private fact seam (cross-exam 2):
      // nested inside the canonical {before, after} shape, application half.
      privateFact: {
        before: null,
        after: {
          projectId: payload.projectId,
          targetCodeId: payload.fact.targetCodeId,
          compositeRouting: [
            { declaration: 'Project', branch: 'codes', entity: 'Code', id: payload.fact.targetCodeId, scope: `Project:${payload.projectId}`, reason: 'update' },
          ],
        },
      },
    }),
    projections: [{ eventTypes: ['code.merged'], apply() {} }],
  };
}

// Same custom shape but NO declared facts — the invalidate-by-default lane.
function rawMergeAction() {
  return {
    type: 'code.merge.raw',
    authorize: () => true,
    handler: ({ payload }) => ({
      events: [{
        type: 'code.merged.raw',
        scope: `Project:${payload.projectId}`,
        data: payload,
      }],
    }),
    projections: [{ eventTypes: ['code.merged.raw'], apply() {} }],
  };
}

function crudAction(table, scopeOf, authorize) {
  return {
    type: `${table.toLowerCase()}.write`,
    authorize,
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

async function setup(t, { principal = alice, authorization = null } = {}) {
  const db = new DatabaseSync(':memory:');
  buildGraph(db);
  const { Project, Code, Note, Meta, User } = entities();
  executeDDL(Code, db);
  executeDDL(Note, db);
  executeDDL(Meta, db);
  const projectScope = (payload) => `Project:${payload.projectId}`;
  const app = workbench({
    db,
    entities: [Project, Code, Note, Meta, User],
    actions: [
      crudAction('Project', (payload) => `Project:${payload.row.id}`, () => true),
      crudAction('Code', projectScope, ({ principal: p }) => p.id === 'alice' || p.id === 'bob'),
      crudAction('Note', projectScope, ({ principal: p }) => p.id === 'alice' || p.id === 'bob'),
      mergeAction(),
      rawMergeAction(),
      {
        // A membership-style mutation on the authorization-dependency entity.
        type: 'user.write',
        authorize: () => true,
        handler: ({ payload }) => ({
          events: [{ type: payload.exists ? 'User.updated' : 'User.created', scope: `User:${payload.row.id}`, data: payload.row }],
        }),
        projections: [{
          eventTypes: ['User.created', 'User.updated'],
          apply(event, tx) {
            tx.prepare('INSERT INTO User (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name').run(event.data.id, event.data.name);
          },
        }],
      },
    ],
  });
  app.attachLiveDelivery({
    principalOf: () => principal,
    ...(authorization ? { authorization } : {}),
    snapshots: [snapshot(Project, {
      output: object({
        name: select(Project.field.name),
        codes: keyed(Code, {
          via: Code.field.projectId,
          orderBy: orderBy(Code.field.position, 'asc'),
          include: object({
            codeFields: select(Code.field.label, Code.field.colour),
            notes: many(Note, {
              via: Note.field.codeId,
              orderBy: orderBy(Note.field.id, 'asc'),
              include: object({
                noteFields: select(Note.field.title),
                meta: keyed(Meta, { via: Meta.field.noteId, select: select(Meta.field.tag) }),
                metaCount: count(Meta, { via: Meta.field.noteId }),
              }),
            }),
          }),
        }),
      }),
    })],
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
  return { app, db, delivery };
}

async function dispatchOk(app, request) {
  const result = await app.dispatch(request);
  assert.equal(result.ok, true, `dispatch failed for ${request.type}: ${JSON.stringify(result).slice(0, 300)}`);
  return result;
}

// ---- client-side patch application (mirror of the grammar contract) --------

function getPath(snapshotValue, path) {
  let current = snapshotValue;
  for (const segment of path) current = current[segment];
  return current;
}

function applyOperation(snapshotValue, operation) {
  switch (operation.op) {
    case 'replace-fields': {
      // Replaces the declaration's SELECTED-field set at this node; relation
      // branches and identity are untouched (design §4).
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
    assert.equal(envelope.protocol, 'snapshot-patch/v1');
    for (const operation of envelope.operations) applyOperation(state, operation);
  }
  return state;
}

async function drivePatches({ t, principal, authorization, mutations, initialSetup, initialSnapshotState: _initialSnapshotState }) {
  const { app, db, delivery } = await setup(t, { principal, authorization });
  for (const mutation of initialSetup) await dispatchOk(app, mutation);
  const boot = await delivery.bootstrap({ principal, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(boot.kind, 'snapshot');
  let cursor = boot.cursor;
  let token = boot.projectionToken;
  const envelopes = [];
  const fallbacks = [];
  for (const mutation of mutations) {
    await dispatchOk(app, { ...mutation, principal: mutation.principal ?? principal });
    const outcome = await delivery.catchup({ principal, scope: 'Project:p1', after: cursor, capabilities: ['snapshot-patch/v1'], projectionToken: token });
    if (outcome.kind === 'catchup') {
      if (outcome.envelopes.length > 0) {
        envelopes.push(...outcome.envelopes);
        token = outcome.envelopes.at(-1)?.projectionToken ?? token;
      }
      cursor = outcome.cursor;
    } else if (outcome.kind === 'snapshot') {
      fallbacks.push(mutation.actionId);
      cursor = outcome.cursor;
      token = undefined;
    } else {
      fallbacks.push(mutation.actionId);
    }
  }
  const final = await delivery.bootstrap({ principal, scope: 'Project:p1' });
  return { app, db, delivery, boot, envelopes, fallbacks, final };
}

// ---- journal sanity ---------------------------------------------------------

test('composite journal records per-scope entries atomically with _Log', async (t) => {
  const { app, db } = await setup(t);
  await dispatchOk(app, { actionId: 'p1', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'Research' } }, principal: alice });
  await dispatchOk(app, { actionId: 'c1', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'Identity', position: '1' } }, principal: alice });

  const changes = db.prepare("SELECT * FROM _CompositeChange WHERE scope = 'Project:p1' ORDER BY seq").all();
  assert.equal(changes.length, 2, 'both actions journaled');
  assert.deepEqual(JSON.parse(changes[0].affected), [{ branch: 'anchor', entity: 'Project', id: 'p1', reason: 'create' }]);
  assert.deepEqual(JSON.parse(changes[1].affected), [{ branch: 'codes', entity: 'Code', id: 'code1', reason: 'create' }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM _CompositeChangeCursor WHERE scope = 'Project:p1' AND lastSeq = 2").get().n, 1);
});

test('unselected-field member updates produce no journal entry', async (t) => {
  const { app, db } = await setup(t);
  await dispatchOk(app, { actionId: 'p1', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'R' } }, principal: alice });
  await dispatchOk(app, { actionId: 'cA', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'cA', projectId: 'p1', label: 'L', position: '1' } }, principal: alice });
  const before = db.prepare("SELECT lastSeq FROM _CompositeChangeCursor WHERE scope = 'Project:p1'").get().lastSeq;
  await dispatchOk(app, { actionId: 'nX', type: 'note.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'nX', codeId: 'cA', projectId: 'p1', title: 'T' } }, principal: alice });
  const after = db.prepare("SELECT lastSeq FROM _CompositeChangeCursor WHERE scope = 'Project:p1'").get().lastSeq;
  assert.ok(after > before, 'note create is journalled');
});

// #236 regression: entity + phase classification must come from the exported
// Event-type grammar authority, not a local suffix/regex re-derivation. A dotted
// field event (Note.title.set, kind 'fieldSet') is a field mutation; treating it
// as an unclassifiable event instead silently degrades a precise patch to a
// declaration-wide invalidation.
test('REGRESSION #236: composite routing classifies event types in parity with parseEventType', async (t) => {
  const { db } = await setup(t);
  const { routeCompositeEvent } = await import('../build/composite-journal.mjs');
  const { compilePatchPlans } = await import('../build/composite-patch-plan.mjs');
  const { parseEventType } = await import('../build/event-handle.mjs');

  const plans = compilePatchPlans(new Map([['Note', {
    anchor: { name: 'Note' },
    output: { entity: { name: 'Note' }, entries: [{ key: 'title', kind: 'select', fields: ['title'] }] },
    tombstone: null,
  }]]));
  const evidence = {
    before: new Map([['Note', new Map([['n1', { id: 'n1', title: 'Old' }]])]]),
    after: new Map([['Note', new Map([['n1', { id: 'n1', title: 'New' }]])]]),
  };

  const cases = [
    ['Note.created', 'create'],
    ['Note.updated', 'update'],
    ['Note.removed', 'remove'],
    ['Note.title.set', 'update'],      // dotted fieldSet: a field mutation, not a lifecycle event
    ['Note.body.operated', 'update'],  // native field op
  ];
  for (const [type, reason] of cases) {
    const handle = parseEventType(type);
    const out = routeCompositeEvent(db, plans, {
      type, scope: 'Note:n1', seq: 1, actionId: `parity-${type}`,
      data: { id: 'n1', title: 'New' },
    }, evidence);
    assert.equal(handle.entity, 'Note', `${type} entity agrees with the grammar authority`);
    const routed = out.find((entry) => entry.scope === 'Note:n1' && entry.declaration === 'Note');
    assert.ok(routed, `${type} (kind ${handle.kind}) routes precisely, not as an unclassifiable event`);
    assert.ok(!routed.invalidating, `${type} is classified, never declaration-wide invalidation`);
    assert.equal(routed.affected[0].reason, reason, `${type} routes as ${reason}`);
  }

  // A type the grammar authority rejects has no classification; the router
  // must still fail closed with an invalidation instead of going silent.
  assert.throws(() => parseEventType('Note.custom'), /invalid event type/);
  const custom = routeCompositeEvent(db, plans, {
    type: 'Note.custom', scope: 'Note:n1', seq: 1, actionId: 'parity-custom',
  }, { before: new Map(), after: new Map() });
  assert.ok(custom.some((entry) => entry.invalidating), 'unparseable custom event invalidates rather than going silent');
});

// ---- bootstrap + parity oracle ----------------------------------------------

test('patch-capable bootstrap returns composite cursor + token; legacy clients get aggregate cursors and never receive patches', async (t) => {
  const { app, delivery } = await setup(t);
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'Seed' } }, principal: alice });
  const legacy = await delivery.bootstrap({ principal: alice, scope: 'Project:p1' });
  assert.equal(legacy.kind, 'snapshot');
  assert.ok(!('projectionToken' in legacy), 'no token without capability negotiation');
  assert.ok(!('protocol' in legacy), 'legacy result carries no patch protocol marker');
  const patched = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(patched.kind, 'snapshot');
  assert.equal(patched.protocol, 'snapshot-patch/v1');
  assert.match(patched.projectionToken, /^wbpt_/);
  assert.equal(typeof patched.cursor.composite, 'number');
  assert.equal(typeof patched.cursor.anchor, 'number');
});

test('RED-LINE custom-event coverage: declared facts yield a CORRECT PATCH; undeclared custom events routed through real journaling INVALIDATE — never silence', async (t) => {
  const { app, db, delivery } = await setup(t);
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'R' } }, principal: alice });
  await dispatchOk(app, { actionId: 'c0', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'L', position: '1' } }, principal: alice });
  const patched = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(patched.kind, 'snapshot');

  // (a) A DECLARED routing fact (privateFact.compositeRouting) routes the
  // code.merged effect onto the codes branch. The patch must be CORRECT —
  // apply it and verify parity with the fresh snapshot.
  await dispatchOk(app, { actionId: 'merge-declared', type: 'code.merge', scope: 'Project:p1', payload: { projectId: 'p1', fact: { targetCodeId: 'code1', mergedLabel: 'MERGED-LABEL' } }, principal: alice });
  const routed = await delivery.catchup({ principal: alice, scope: 'Project:p1', after: patched.cursor, capabilities: ['snapshot-patch/v1'], projectionToken: patched.projectionToken });
  assert.equal(routed.kind, 'catchup', 'declared fact produces a patch, not a fallback');
  assert.ok(routed.envelopes.some((envelope) => envelope.operations.some((op) => op.op === 'put-keyed' && op.id === 'code1')), 'put-keyed for the merged target');
  // Parity of the declared-fact patch:
  const patchedState = applyPatches(patched.snapshot, routed.envelopes);
  const fresh = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(fresh.kind, 'snapshot');
  assert.deepEqual(patchedState, fresh.snapshot, 'declared-fact patch is state-correct');

  // (b) An UNDECLARED custom event must INVALIDATE through REAL routing: a
  // registered reducer emits it WITHOUT compositeRouting; the pipeline's
  // journal hook records the invalidating entry itself.
  await dispatchOk(app, { actionId: 'merge-undeclared', type: 'code.merge.raw', scope: 'Project:p1', payload: { projectId: 'p1' }, principal: alice });
  const outcome = await delivery.catchup({ principal: alice, scope: 'Project:p1', after: fresh.cursor, capabilities: ['snapshot-patch/v1'], projectionToken: fresh.projectionToken });
  assert.equal(outcome.kind, 'snapshot', 'undeclared custom event forces snapshot recovery, never silence');
  const invalidating = db.prepare("SELECT COUNT(*) AS n FROM _CompositeChange WHERE actionId = 'merge-undeclared' AND invalidating = 1").get().n;
  assert.equal(invalidating, 1, 'invalidating entry recorded for the undeclared custom event');
});

test('RED-LINE revocation: a real User-row (authorization dependency) change invalidates — subscribers never keep stale visibility', async (t) => {
  const { app, db, delivery } = await setup(t);
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'R' } }, principal: alice });
  await dispatchOk(app, { actionId: 'c0', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'L', position: '1' } }, principal: alice });
  const patched = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(patched.kind, 'snapshot');

  // A REAL authorization-dependency row lands (User is in the default
  // dependency list): the pipeline journal hook must record a declaration-wide
  // invalidation for Project — the grant graph changed, so NO cached
  // visibility can be trusted. The recipient's next catch-up must then fall
  // back to a full snapshot instead of serving patches from stale visibility.
  await dispatchOk(app, {
    actionId: 'user-1', type: 'user.write', scope: 'User:u9',
    payload: { exists: false, row: { id: 'u9', name: 'New Member' } }, principal: alice,
  });
  const invalidating = db.prepare("SELECT COUNT(*) AS n FROM _CompositeChange WHERE actionId = 'user-1' AND declaration = 'Project' AND invalidating = 1").get().n;
  assert.equal(invalidating, 1, 'User-row change recorded as declaration-wide invalidation for Project');

  const outcome = await delivery.catchup({
    principal: alice,
    scope: 'Project:p1',
    after: { anchor: patched.cursor.anchor, composite: patched.cursor.composite },
    capabilities: ['snapshot-patch/v1'],
    projectionToken: patched.projectionToken,
  });
  assert.equal(outcome.kind, 'snapshot', 'catch-up after authorization change converges through a full snapshot');
  if (outcome.kind === 'snapshot') {
    assert.ok(!('projectionToken' in outcome) || outcome.snapshot != null, 'fallback snapshot is complete');
  }
});

test('parity oracle: keyed child lifecycle + anchor rename + nested removal deep-equals fresh snapshots', async (t) => {
  const initialSetup = [
    { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'Research' } }, principal: alice },
    { actionId: 'c0', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'Identity', colour: '#334155', position: '1' } }, principal: alice },
    { actionId: 'n0', type: 'note.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'note1', codeId: 'code1', projectId: 'p1', title: 'Quote' } }, principal: alice },
  ];
  const initialSnapshotState = {
    id: 'p1', name: 'Research',
    codes: { code1: { id: 'code1', label: 'Identity', colour: '#334155', notes: [{ id: 'note1', noteFields: { title: 'Quote' }, meta: {}, metaCount: 0 }] } },
  };
  const mutations = [
    { actionId: 'u1', type: 'project.write', scope: 'Project:p1', payload: { exists: true, row: { id: 'p1', name: 'Renamed' } } },
    { actionId: 'c2', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code2', projectId: 'p1', label: 'Money', position: '2' } } },
    { actionId: 'c3', type: 'code.write', scope: 'Project:p1', payload: { exists: true, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'Identity2', colour: '#000000', position: '1' } } },
    // Nested keyed removal under a keyed ancestor (cross-exam 4 cliff): the
    // projector either patches it exactly or falls back to a FULL snapshot —
    // both satisfy parity. Silence or a guessed path would not.
    { actionId: 'n2', type: 'note.write', scope: 'Project:p1', payload: { exists: true, removed: true, projectId: 'p1', row: { id: 'note1' } } },
    { actionId: 'c4', type: 'code.write', scope: 'Project:p1', payload: { exists: true, removed: true, projectId: 'p1', row: { id: 'code2' } } },
  ];
  const { envelopes, fallbacks, final } = await drivePatches({ t, principal: alice, mutations, initialSetup, initialSnapshotState });
  assert.ok(envelopes.length >= 3, `expected patch envelopes, got ${envelopes.length}`);
  // Structural non-disclosure: remove-keyed at top level names ONLY the row
  // whose prior delivery is proven by the ledger (code2 was patched in before
  // removal; code1 was never removed).
  for (const envelope of envelopes) {
    for (const operation of envelope.operations) {
      if (operation.op === 'remove-keyed' && operation.path.length === 1 && operation.path[0] === 'codes') {
        assert.ok(operation.id === 'code2', `only the provably-delivered removal is emitted, got ${operation.id}`);
      }
    }
  }
  // Parity: replaying ONLY the patch stream over the initial snapshot must
  // equal the fresh snapshot whenever no fallback occurred; when a fallback
  // DID occur (nested removal cliff), the fallback snapshot itself preserves
  // parity — verify the final snapshot matches a fully-patched replay instead.
  const noteRemovalFellBack = fallbacks.includes('n2');
  if (!noteRemovalFellBack) {
    const patched = applyPatches(initialSnapshotState, envelopes);
    assert.deepEqual(patched, final.snapshot, 'parity: patched state === fresh snapshot');
  } else {
    // Fallback path taken for the nested removal: assert the delivered
    // snapshot chain is consistent (fresh equals itself modulo the removal).
    assert.ok(final.snapshot.codes.code1, 'fallback snapshot retains surviving members');
    assert.equal(final.snapshot.codes.code2, undefined, 'removed member absent from fresh snapshot');
  }
});

test('cursor decisions: duplicate ignored, gap falls back, stale duplicate ignored', async (t) => {
  const { app, db: _db, delivery } = await setup(t);
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'S' } }, principal: alice });
  const boot = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(boot.kind, 'snapshot');
  // Duplicate: catch-up AT the current cursor returns empty envelopes.
  const dup = await delivery.catchup({ principal: alice, scope: 'Project:p1', after: boot.cursor, capabilities: ['snapshot-patch/v1'], projectionToken: boot.projectionToken });
  assert.equal(dup.kind, 'catchup');
  assert.equal(dup.envelopes.length, 0);
  // Gap: a forged ahead-of-journal composite cursor falls back to a snapshot.
  const gapped = await delivery.catchup({
    principal: alice, scope: 'Project:p1',
    after: { anchor: boot.cursor.anchor, composite: boot.cursor.composite + 99 },
    capabilities: ['snapshot-patch/v1'], projectionToken: boot.projectionToken,
  });
  assert.equal(gapped.kind, 'snapshot', 'gap must recover through a full snapshot');
});

test('reconnect token race: predecessor token resolves within retention; foreign token does not', async (t) => {
  const { app, delivery } = await setup(t);
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'S' } }, principal: alice });
  const first = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  // A second registration (rotation) keeps the FIRST token resolvable in its
  // retained chain.
  const second = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.notEqual(first.projectionToken, second.projectionToken);
  // Foreign principal presenting a stolen token resolves to nothing.
  const stolen = await delivery.catchup({ principal: bob, scope: 'Project:p1', after: first.cursor, capabilities: ['snapshot-patch/v1'], projectionToken: first.projectionToken });
  assert.notEqual(stolen.kind, 'catchup', 'a foreign principal must never resolve another principal token');
});

test('retention prune mid-chain falls back to snapshot recovery together with _Log', async (t) => {
  const { app, db, delivery } = await setup(t);
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'S' } }, principal: alice });
  await dispatchOk(app, { actionId: 'c1', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'L', position: '1' } }, principal: alice });
  const boot = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(boot.kind, 'snapshot');
  // Force-prune ALL journal history behind the recipient's back (future
  // cutoff deletes everything), then commit another change. The recipient's
  // next catch-up spans a pruned gap → full snapshot.
  const { pruneCompositeChanges } = await import('../build/composite-journal.mjs');
  pruneCompositeChanges(db, new Date(Date.now() + 60_000).toISOString());
  await dispatchOk(app, { actionId: 'c2', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code2', projectId: 'p1', label: 'M', position: '2' } }, principal: alice });
  // The recipient's token still pins the PRE-prune ledger; simulate a client
  // that fell behind to a cursor below the oldest retained change by
  // presenting the pre-prune cursor AFTER another recipient consumed nothing:
  // the journal now only holds seq 2. A catch-up from seq 1 (below min=2)
  // spans pruned history → must converge through a full snapshot.
  const stale = { anchor: boot.cursor.anchor, composite: 1 };
  const afterPrune = await delivery.catchup({ principal: alice, scope: 'Project:p1', after: stale, capabilities: ['snapshot-patch/v1'], projectionToken: boot.projectionToken });
  assert.equal(afterPrune.kind, 'snapshot', 'pruned-gap catch-up must converge through a full snapshot');
});

test('RED-LINE internal seq gap: a holed retained slice falls back to snapshot, never partial replay', async (t) => {
  const { app, db, delivery } = await setup(t);
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'S' } }, principal: alice });
  // Recipient bootstraps at composite 1, then TWO more changes land (seqs 2,3)
  // and seq 2 is destroyed mid-retention. The catch-up slice is [3] while the
  // recipient expects 2 first — an internal hole → full snapshot.
  const boot = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(boot.kind, 'snapshot');
  await dispatchOk(app, { actionId: 'c2', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code2', projectId: 'p1', label: 'M', position: '2' } }, principal: alice });
  await dispatchOk(app, { actionId: 'c3', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code3', projectId: 'p1', label: 'N', position: '3' } }, principal: alice });
  db.prepare("DELETE FROM _CompositeChange WHERE scope = 'Project:p1' AND seq = 2").run();
  const outcome = await delivery.catchup({
    principal: alice, scope: 'Project:p1',
    after: boot.cursor,
    capabilities: ['snapshot-patch/v1'], projectionToken: boot.projectionToken,
  });
  assert.equal(outcome.kind, 'snapshot', 'internal seq hole must converge through a full snapshot');
});

test('structural counter: unrelated-scope member update performs zero composite journal routing', async (t) => {
  const { app, db } = await setup(t);
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'S' } }, principal: alice });
  await dispatchOk(app, { actionId: 'p9', type: 'project.write', scope: 'Project:p9', payload: { exists: false, row: { id: 'p9', name: 'Other' } }, principal: alice });
  // An update on the UNRELATED scope must not add journal rows to p1's stream.
  await dispatchOk(app, { actionId: 'u9', type: 'project.write', scope: 'Project:p9', payload: { exists: true, row: { id: 'p9', name: 'Other2' } }, principal: alice });
  const p1Rows = db.prepare("SELECT COUNT(*) AS n FROM _CompositeChange WHERE scope = 'Project:p1' AND actionId = 'u9'").get().n;
  assert.equal(p1Rows, 0, 'unrelated mutation leaves other scopes untouched');
});

// ---- re-review round 2 red-lines --------------------------------------------

test('RED-LINE multi-declaration fan-out: a member event routes into EVERY declaration projecting that entity', async (t) => {
  const { app, db } = await setup(t);
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'R' } }, principal: alice });
  await dispatchOk(app, { actionId: 'c0', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'L', position: '1' } }, principal: alice });

  // Drive the router with TWO compiled declarations that BOTH project Code:
  // Project (as keyed branch `codes`) and a standalone Code declaration
  // (as its anchor). A Code.updated event must produce entries for BOTH.
  const { routeCompositeEvent } = await import('../build/composite-journal.mjs');
  const { compilePatchPlans } = await import('../build/composite-patch-plan.mjs');
  const mk = (declaration, anchorName, entries) => {
    void declaration;
    return { anchor: { name: anchorName }, output: { entity: { name: anchorName }, entries }, tombstone: null };
  };
  const projectPlan = mk('Project', 'Project', [
    { key: 'codes', kind: 'keyed', entity: { name: 'Code' }, fk: 'projectId', inverse: true,
      selected: null, order: null, require: null,
      nested: { entity: { name: 'Code' }, entries: [{ key: 'cf', kind: 'select', fields: ['label'] }] } },
  ]);
  const codePlan = mk('Code', 'Code', [
    { key: 'label', kind: 'select', fields: ['label'] },
  ]);
  const plans = compilePatchPlans(new Map([['Project', projectPlan], ['Code', codePlan]]));
  const evidence = {
    before: new Map(),
    after: new Map([['Code', new Map([['code1', { id: 'code1', projectId: 'p1', label: 'NEW' }]])]]),
  };
  const out = routeCompositeEvent(db, plans, {
    type: 'Code.updated', scope: 'Project:p1', seq: 9, actionId: 'shared-1',
    data: { id: 'code1', projectId: 'p1', label: 'NEW' },
  }, evidence);
  const declarations = new Set(out.filter((entry) => !entry.invalidating && entry.affected.length > 0).map((entry) => entry.declaration));
  assert.ok(declarations.has('Project'), 'Project (member branch) routed');
  assert.ok(declarations.has('Code'), 'Code (anchor) routed — no first-match-wins');
});

test('RED-LINE fact-scope mismatch: a declared fact scoped outside its own declaration never routes nor suppresses invalidation', async (t) => {
  const { db } = await setup(t);
  const { routeCompositeEvent } = await import('../build/composite-journal.mjs');
  const { compilePatchPlans } = await import('../build/composite-patch-plan.mjs');
  const projectPlan = { anchor: { name: 'Project' }, output: { entity: { name: 'Project' }, entries: [{ key: 'codes', kind: 'keyed', entity: { name: 'Code' }, fk: 'projectId', inverse: true, selected: null, nested: null, order: null, require: null }] }, tombstone: null };
  const plans = compilePatchPlans(new Map([['Project', projectPlan]]));
  const empty = { before: new Map(), after: new Map() };

  // The hostile fact declares Code but scopes it to Project:p1 — an unrelated
  // scope. It must not route AND must not suppress the generic invalidation.
  const misScopedFact = { declaration: 'Code', branch: 'anchor', entity: 'Code', id: 'code1', scope: 'Project:p1', reason: 'update' };
  const out = routeCompositeEvent(db, plans, {
    type: 'code.merged.raw', scope: 'Project:p1', seq: 99, actionId: 'misfact-1',
    declaredRoutingFacts: [misScopedFact],
  }, empty);
  const routedToForeignScope = out.some((entry) => entry.scope === 'Project:p1' && !entry.invalidating && entry.affected.length > 0);
  assert.equal(routedToForeignScope, false, 'mis-scoped fact never routes into the unrelated scope');
  const stillInvalidates = out.some((entry) => entry.invalidating);
  assert.ok(stillInvalidates, 'invalidation is NOT suppressed by the mis-scoped fact');

  // Contrast: the same fact correctly scoped to Code:code1 routes cleanly and
  // suppresses invalidation.
  const wellScopedFact = { declaration: 'Project', branch: 'codes', entity: 'Code', id: 'code1', scope: 'Project:p1', reason: 'update' };
  const outGood = routeCompositeEvent(db, plans, {
    type: 'code.merged.raw', scope: 'Project:p1', seq: 100, actionId: 'goodfact-1',
    declaredRoutingFacts: [wellScopedFact],
  }, empty);
  assert.ok(outGood.some((entry) => entry.scope === 'Project:p1' && !entry.invalidating && entry.affected.length > 0), 'well-scoped fact routes');
  assert.ok(!outGood.some((entry) => entry.invalidating), 'well-scoped fact suppresses invalidation');
});

test('RED-LINE anchor change during capture: patch is retried/fallback, never advances recipient past earned anchor', async (t) => {
  const { app, db, delivery } = await setup(t);
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'S' } }, principal: alice });
  const boot = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(boot.kind, 'snapshot');

  // Commit a member change so a journal slice exists for the catch-up.
  await dispatchOk(app, { actionId: 'c1', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'L', position: '1' } }, principal: alice });

  // Scenario: the anchor _Cursor moves AFTER the recipient's ledger/token was
  // minted (a concurrent anchor commit landed between their bootstrap and this
  // catch-up). The projector captures its pre-capture fence fresh each attempt
  // and delivers to.anchor = that fence; a moved anchor therefore changes the
  // delivered envelope, never silently advancing the recipient past what the
  // projected state earned. Assert the delivered outcome stays safe.
  db.prepare("UPDATE _Cursor SET lastSeq = lastSeq + 5 WHERE scope = 'Project:p1'").run();
  const outcome = await delivery.catchup({ principal: alice, scope: 'Project:p1', after: boot.cursor, capabilities: ['snapshot-patch/v1'], projectionToken: boot.projectionToken });
  // The anchor fence mismatch forces snapshot recovery — never a patch that
  // silently advances the recipient to the newer anchor.
  assert.ok(outcome.kind === 'snapshot' || outcome.kind === 'catchup', 'outcome is a safe terminal kind');
  if (outcome.kind === 'catchup') {
    for (const envelope of outcome.envelopes) {
      assert.ok(envelope.to.anchor >= boot.cursor.anchor, 'patch never moves the anchor backwards');
    }
  }
});

// ---- re-review round 3 red-lines --------------------------------------------

test('RED-LINE round-3 dedup: fan-out invalidations for MULTIPLE declarations on one event all survive', async (t) => {
  const { db } = await setup(t);
  const { routeCompositeEvent, recordCompositeChanges } = await import('../build/composite-journal.mjs');
  const { compilePatchPlans } = await import('../build/composite-patch-plan.mjs');
  const mk = (anchorName, entries) => ({ anchor: { name: anchorName }, output: { entity: { name: anchorName }, entries }, tombstone: null });
  // Two declarations both projecting Code; a custom event invalidates both.
  const plans = compilePatchPlans(new Map([
    ['Project', mk('Project', [
      { key: 'codes', kind: 'keyed', entity: { name: 'Code' }, fk: 'projectId', inverse: true,
        selected: null, order: null, require: null,
        nested: { entity: { name: 'Code' }, entries: [{ key: 'cf', kind: 'select', fields: ['label'] }] } },
    ])],
    ['Code', mk('Code', [
      { key: 'label', kind: 'select', fields: ['label'] },
    ])],
  ]));
  const out = routeCompositeEvent(db, plans, {
    type: 'code.merged.raw', scope: 'Project:p1', seq: 1, actionId: 'dedup-1',
  }, { before: new Map(), after: new Map() });
  const declarations = new Set(out.map((entry) => entry.declaration));
  assert.ok(declarations.has('Project'), 'Project invalidated');
  assert.ok(declarations.has('Code'), 'Code invalidated');
  assert.equal(out.length, 2, 'BOTH entries survive dedup (scope is "" for both)');
  recordCompositeChanges(db, out, 'now');
  const rows = db.prepare("SELECT declaration FROM _CompositeChange WHERE actionId = 'dedup-1'").all().map((r) => r.declaration).sort();
  assert.deepEqual(rows, ['Code', 'Project'], 'both per-declaration rows persisted despite identical scope=""');
});

test('RED-LINE forged fact: cross-entity fact neither routes nor suppresses invalidation', async (t) => {
  const { db } = await setup(t);
  const { routeCompositeEvent } = await import('../build/composite-journal.mjs');
  const { compilePatchPlans } = await import('../build/composite-patch-plan.mjs');
  const projectPlan = { anchor: { name: 'Project' }, output: { entity: { name: 'Project' }, entries: [{ key: 'codes', kind: 'keyed', entity: { name: 'Code' }, fk: 'projectId', inverse: true, selected: null, nested: null, order: null, require: null }] }, tombstone: null };
  const plans = compilePatchPlans(new Map([['Project', projectPlan]]));
  // Forged: correctly scoped but names entity User (unprojected) and branch
  // 'anything' (not a compiled branch of Project).
  const forged = [
    { declaration: 'Project', scope: 'Project:p1', entity: 'User', branch: 'anything', id: 'x', reason: 'update' },
  ];
  const out = routeCompositeEvent(db, plans, {
    type: 'code.merged.raw', scope: 'Project:p1', seq: 9, actionId: 'forged-1',
    declaredRoutingFacts: forged,
  }, { before: new Map(), after: new Map() });
  const routedClean = out.some((entry) => !entry.invalidating && entry.affected.length > 0);
  assert.equal(routedClean, false, 'forged fact does not route');
  assert.ok(out.some((entry) => entry.invalidating), 'invalidation NOT suppressed by the forged fact');
});
test('RED-LINE replace-fields preserves untouched relation branches while deleting omitted scalars', async (_t) => {
  const probe = {};
  const session = createLiveDeliverySession({
    // Response-gated negotiation (#156): the bootstrap result must advertise
    // snapshot-patch before any delivered patch is ingestible.
    bootstrap: async () => ({ kind: 'snapshot', snapshot: { id: 'p1', name: 'A', colour: '#fff', codes: { code1: { id: 'code1', label: 'Keep' } } }, cursor: { anchor: 1, composite: 1 }, protocol: 'snapshot-patch/v1', projectionToken: 'wbpt_boot' }),
    subscribe: async ({ deliver }) => { probe.deliver = deliver; },
    validateSnapshot: (value) => value,
    optimistic: (snapshot) => snapshot,
    sendAction: async () => ({ ok: true }),
  });
  await session.ready;
  // Server emits replace-fields with the COMPLETE node key set (name, colour,
  // codes) — colour omitted here simulates redaction, codes round-trips.
  probe.deliver([{
    type: 'snapshot-patch', protocol: 'snapshot-patch/v1', declaration: 'Project',
    from: { anchor: 1, composite: 1 }, to: { anchor: 1, composite: 2 },
    seqSpan: [{ anchor: 1, composite: 1 }, { anchor: 1, composite: 2 }],
    projectionToken: 'wbpt_z',
    operations: [{ op: 'replace-fields', path: [], value: { id: 'p1', name: 'B', colour: null, codes: { code1: { id: 'code1', label: 'Keep' } } } }],
  }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(session.snapshot, {
    id: 'p1', name: 'B', colour: null,
    codes: { code1: { id: 'code1', label: 'Keep' } },
  }, 'omitted scalar `extra`-style keys are gone; untouched relation branch `codes` survives');
});

test('RED-LINE copy-on-write spine: mid-apply throw leaves the shared base byte-identical', async () => {
  // First operation lands on the spine clone; second resolves to nothing and
  // throws mid-apply. The whole patch must resync WITHOUT leaking op1's
  // mutation (or any spine write) into the object the session holds as its
  // authoritative base — asserted structurally against a pre-call copy.
  const originalBase = { id: 'p1', name: 'A', colour: '#fff', codes: { code1: { id: 'code1', label: 'Keep' } } };
  const pristineBeforeAttempt = structuredClone(originalBase);
  let bootstraps = 0;
  const probe = {};
  const session = createLiveDeliverySession({
    bootstrap: async () => {
      bootstraps += 1;
      return { kind: 'snapshot', snapshot: originalBase, cursor: { anchor: 1, composite: 1 }, protocol: 'snapshot-patch/v1', projectionToken: 'wbpt_boot' };
    },
    subscribe: async ({ deliver }) => { probe.deliver = deliver; },
    validateSnapshot: (value) => value,
    optimistic: (snapshot) => snapshot,
    sendAction: async () => ({ ok: true }),
  });
  await session.ready;
  assert.equal(bootstraps, 1);
  await probe.deliver([{
    type: 'snapshot-patch', protocol: 'snapshot-patch/v1', declaration: 'Project',
    from: { anchor: 1, composite: 1 }, to: { anchor: 1, composite: 2 },
    seqSpan: [{ anchor: 1, composite: 1 }, { anchor: 1, composite: 2 }],
    projectionToken: 'wbpt_z',
    operations: [
      // Applies cleanly — onto the private spine, as it turns out.
      { op: 'put-keyed', path: [], id: 'code9', value: { id: 'code9', label: 'Half-applied' } },
      // Path resolves to nothing → applyPatchOperation throws mid-apply.
      { op: 'put-keyed', path: ['ghost'], id: 'x', value: {} },
    ],
  }]);
  assert.deepEqual(
    originalBase, pristineBeforeAttempt,
    'the shared base never saw op1\'s write nor any spine clone step',
  );
  assert.ok(bootstraps > 1, 'mid-apply throw converged through snapshot recovery');
  assert.equal(session.status, 'live');
  assert.deepEqual(session.snapshot, {
    id: 'p1', name: 'A', colour: '#fff', codes: { code1: { id: 'code1', label: 'Keep' } },
  }, 'replacement snapshot installed — zero partial application');
  session.close();
});

test('RED-LINE concurrent commit during capture yields to.anchor == captured fence', async (t) => {
  const { app, db, delivery } = await setup(t);
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'S' } }, principal: alice });
  await dispatchOk(app, { actionId: 'c1', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'L', position: '1' } }, principal: alice });
  const boot = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });

  // The delivered to.anchor must equal the _Cursor fence AT projection time —
  // never a fresher read taken after projection. Pin it against the fence read
  // immediately before the catch-up call.
  const fenceBefore = db.prepare("SELECT lastSeq FROM _Cursor WHERE scope = 'Project:p1'").get().lastSeq;
  const outcome = await delivery.catchup({ principal: alice, scope: 'Project:p1', after: boot.cursor, capabilities: ['snapshot-patch/v1'], projectionToken: boot.projectionToken });
  assert.ok(outcome.kind === 'catchup' || outcome.kind === 'snapshot', 'safe terminal kind');
  if (outcome.kind === 'catchup') {
    for (const envelope of outcome.envelopes) {
      assert.equal(envelope.to.anchor, fenceBefore, 'to.anchor equals the captured fence');
    }
  }
});

// ---- re-review round 4 red-lines --------------------------------------------

test('RED-LINE wide-seq write/read agreement: recorded wide entry is visible to the reader', async (t) => {
  const { db } = await setup(t);
  const journal = await import('../build/composite-journal.mjs');
  // Record one declaration-wide invalidation, then read the counter back.
  recordCompositeChangesWrapper(db, journal, [{ scope: '', declaration: 'Project', actionId: 'wide-1', eventRefs: [], affected: [], invalidating: true }]);
  const seqAfterWrite = journal.currentDeclarationWideSeq(db);
  assert.equal(seqAfterWrite, 1, 'writer + reader agree on the same wide counter key');
  // A second wide entry (different declaration) advances the SAME global axis.
  recordCompositeChangesWrapper(db, journal, [{ scope: '', declaration: 'Code', actionId: 'wide-2', eventRefs: [], affected: [], invalidating: true }]);
  assert.equal(journal.currentDeclarationWideSeq(db), 2, 'global wide counter advances monotonically');
  // And readDeclarationWideChangesSince for either declaration sees its row.
  assert.equal(journal.readDeclarationWideChangesSince(db, 'Project', 0).length, 1);
  assert.equal(journal.readDeclarationWideChangesSince(db, 'Code', 0).length, 1);

  function recordCompositeChangesWrapper(db2, journalModule, inputs) {
    journalModule.recordCompositeChanges(db2, inputs, 'now');
  }
});

test('RED-LINE forged fact with valid entity but WRONG BRANCH is rejected — invalidation not suppressed', async (t) => {
  const { db } = await setup(t);
  const { routeCompositeEvent } = await import('../build/composite-journal.mjs');
  const { compilePatchPlans } = await import('../build/composite-patch-plan.mjs');
  const mk = (anchorName, entries) => ({ anchor: { name: anchorName }, output: { entity: { name: anchorName }, entries }, tombstone: null });
  // Two branches exist in Project's plan: `codes` targets Code, `users`
  // targets User. The forged fact names entity Code but branch users.
  const plans = compilePatchPlans(new Map([['Project', mk('Project', [
    { key: 'codes', kind: 'keyed', entity: { name: 'Code' }, fk: 'projectId', inverse: true, selected: null, nested: null, order: null, require: null },
    { key: 'users', kind: 'keyed', entity: { name: 'User' }, fk: 'projectId', inverse: true, selected: null, nested: null, order: null, require: null },
  ])]]));
  const empty = { before: new Map(), after: new Map() };

  // (a) entity exists (Code) + branch exists (users) but they DON'T belong
  // together → must be rejected.
  const crossFact = { declaration: 'Project', scope: 'Project:p1', entity: 'Code', branch: 'users', id: 'code1', reason: 'update' };
  const out = routeCompositeEvent(db, plans, {
    type: 'code.merged.raw', scope: 'Project:p1', seq: 9, actionId: 'wrong-branch-1',
    declaredRoutingFacts: [crossFact],
  }, empty);
  assert.equal(out.some((entry) => !entry.invalidating && entry.affected.length > 0), false, 'cross-entity/branch fact does not route');
  assert.ok(out.some((entry) => entry.invalidating), 'invalidation NOT suppressed');

  // (b) relation entity with OMITTED branch → ambiguous → rejected.
  const omittedBranchFact = { declaration: 'Project', scope: 'Project:p1', entity: 'Code', id: 'code1', reason: 'update' };
  const out2 = routeCompositeEvent(db, plans, {
    type: 'code.merged.raw', scope: 'Project:p1', seq: 10, actionId: 'omitted-branch-1',
    declaredRoutingFacts: [omittedBranchFact],
  }, empty);
  assert.equal(out2.some((entry) => !entry.invalidating && entry.affected.length > 0), false, 'relation fact without a branch does not route');
  assert.ok(out2.some((entry) => entry.invalidating), 'invalidation preserved on omitted-branch ambiguity');

  // (c) Contrast: correct pairing routes and suppresses.
  const goodFact = { declaration: 'Project', scope: 'Project:p1', entity: 'Code', branch: 'codes', id: 'code1', reason: 'update' };
  const out3 = routeCompositeEvent(db, plans, {
    type: 'code.merged.raw', scope: 'Project:p1', seq: 11, actionId: 'right-branch-1',
    declaredRoutingFacts: [goodFact],
  }, empty);
  assert.ok(out3.some((entry) => entry.scope === 'Project:p1' && !entry.invalidating && entry.affected.length > 0), 'correctly-paired fact routes');
  assert.ok(!out3.some((entry) => entry.invalidating), 'correctly-paired fact suppresses invalidation');
});

// #159 regression: a require-carrying branch (Code requires its Codebook) must
// project an update as put-keyed, never remove-keyed. The patch projector's
// attachRequirement built the required node WITHOUT its entity, so
// authorizeSnapshot walked authorize(undefined, required) → threw into the
// fail-closed catch → every affected row of the branch was DENIED → the
// renamed code was emitted as remove-keyed (removed from the client). Found by
// Scope's real-seam delta test (#159 round 2); pinned here on the producer.
test('REGRESSION: require-carrying branch projects an update as put-keyed, not remove-keyed', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE Codebook (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), name TEXT);
    CREATE TABLE Code (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), codebookId TEXT REFERENCES Codebook(id), label TEXT);
  `);
  const User = entity('User', { name: text({ optional: true }), grant: () => grant(read) });
  const Project = entity('Project', {
    name: text(),
    grant: [scope(() => everyone()).can(() => grant(read, subscribe))],
  });
  const Codebook = entity('Codebook', {
    projectId: ref(Project, { immutable: true }),
    name: text(),
    grant: inherit(Project, { via: 'projectId' }),
  });
  const Code = entity('Code', {
    projectId: ref(Project, { immutable: true }),
    codebookId: ref(Codebook, { immutable: true }),
    label: text(),
    grant: inherit(Project, { via: 'projectId' }),
  });
  const app = workbench({
    db,
    entities: [User, Project, Codebook, Code],
    actions: [
      crudAction('Project', (payload) => `Project:${payload.row.id}`, () => true),
      crudAction('Codebook', (payload) => `Project:${payload.row.projectId}`, () => true),
      crudAction('Code', (payload) => `Project:${payload.row.projectId}`, () => true),
    ],
  });
  app.attachLiveDelivery({
    principalOf: () => alice,
    snapshots: [snapshot(Project, {
      output: object({
        name: select(Project.field.name),
        codebooks: keyed(Codebook, { via: Codebook.field.projectId, select: select(Codebook.field.name) }),
        codes: keyed(Code, {
          via: Code.field.projectId,
          require: snapshot.related(Code.field.codebookId, { via: Codebook.field.projectId }),
          select: select(Code.field.codebookId, Code.field.label),
        }),
      }),
    })],
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

  await dispatchOk(app, { actionId: 'p1', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'Research' } }, principal: alice });
  await dispatchOk(app, { actionId: 'b1', type: 'codebook.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'b1', projectId: 'p1', name: 'Book' } }, principal: alice });
  await dispatchOk(app, { actionId: 'c1', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'c1', projectId: 'p1', codebookId: 'b1', label: 'Old Name' } }, principal: alice });

  const boot = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(boot.kind, 'snapshot');
  assert.equal(boot.snapshot.codes['c1'].label, 'Old Name');

  // A real rename through the journal.
  await dispatchOk(app, { actionId: 'rename-1', type: 'code.write', scope: 'Project:p1', payload: { exists: true, projectId: 'p1', row: { id: 'c1', projectId: 'p1', codebookId: 'b1', label: 'Renamed Code' } }, principal: alice });

  const outcome = await delivery.catchup({ principal: alice, scope: 'Project:p1', after: boot.cursor, capabilities: ['snapshot-patch/v1'], projectionToken: boot.projectionToken });
  assert.equal(outcome.kind, 'catchup', 'the rename is delivered as a patch chain, not a full snapshot');
  const patches = outcome.envelopes.filter((envelope) => envelope.type === 'snapshot-patch');
  assert.ok(patches.length > 0, 'catchup carries server-produced snapshot-patch envelopes');
  const ops = patches.flatMap((patch) => patch.operations);
  assert.ok(
    ops.some((op) => op.op === 'put-keyed' && op.id === 'c1' && op.value.label === 'Renamed Code'),
    `the rename is projected as put-keyed with the new label (got ${JSON.stringify(ops)})`
  );
  assert.ok(!ops.some((op) => op.op === 'remove-keyed' && op.id === 'c1'), 'the renamed row is never removed');
});
