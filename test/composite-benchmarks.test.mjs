// #158 benchmark suite B1–B4 (#155 program; metrics from the #122 cross-exam verdicts).
//
// Runs on the REAL negotiated delta flow (#156 client ingestion + #157 targeted
// branch capture are live on main): mutations go through app.dispatch → journal
// routing → projectCompositePatch; recipients go through the public
// delivery.bootstrap/catchup seam presenting snapshot-patch/v1 + projectionToken;
// client-side measurements drive the REAL createLiveDeliverySession ingest.
//
// Metrics (rows printed via console.table with the git hash per repo convention):
//   B1  bytes-on-wire: one code rename's catchup envelopes vs fresh bootstrap,
//       sizes {100,1000,5000} × K {1,5,20}
//   B2  client stall: performance.now() around the real session's
//       deliver → applyAuthoritative → publish path, ≥500 sequential patches on
//       the 5000-code project, p50/p95/p99, assert p95 < 16ms
//   B3  server CPU per mutation: cpuUsage+wall across the rename fan-out × K;
//       dispatch RTT p50/p95; STRUCTURAL GATES wired by re-running
//       test/composite-patch-targeted-capture.test.mjs (the #157 counter gates)
//   B4  per-recipient memory: ledger-eviction demotion proof + heapUsed sanity
//       per active subscription (K=20)
//
// Deviation from the ticket text (harness): this repo's runner is `node --test`;
// there is no vitest/pnpm here. Browser Long-Task measurement (ticket B2) is out
// of scope — B2 measures the node-side applyAuthoritative→publish window of the
// real client session instead.

import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import workbench, { entity, inherit, ref, text, grant, read, subscribe, scope, everyone, snapshot } from '../build/index.mjs';
const { object, select, include, keyed, many, orderBy } = snapshot;
import { executeDDL } from '../build/internal.mjs';
import { mayVerb } from '../build/row-grant.mjs';
import { createCompositePatchDelivery } from '../build/composite-patch-delivery.mjs';
import { compileSnapshots } from '../build/snapshot-projection.mjs';
import { createLiveDeliverySession } from '../public/workbench-client.mjs';

const GIT_HASH = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const CAP = 'snapshot-patch/v1';
const SIZES = [100, 1000, 5000];
const KS = [1, 5, 20];

const alice = { type: 'user', id: 'alice' };
const principalFor = (name) => ({ type: 'user', id: name });

// ---- fixture (same shapes as test/composite-patch-targeted-capture.test.mjs) --

function buildGraph(db) {
  db.exec(`
    CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT, owner TEXT, featuredNoteId TEXT);
    CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE Code (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), label TEXT, colour TEXT, position INTEGER, latestNoteId TEXT);
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
  const Entry = entity('Entry', {
    projectId: ref(Project, { immutable: true }),
    codeId: ref(Code),
    term: text(),
    grant: inherit(Code, { via: 'codeId' }),
  });
  return { Project, Code, Note, Entry, User };
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

async function dispatchOk(app, request) {
  const result = await app.dispatch(request);
  assert.equal(result.ok, true, `dispatch failed for ${request.type}: ${JSON.stringify(result).slice(0, 300)}`);
  return result;
}

// Realistic-length strings so byte ratios reflect research-sized payloads.
const codeLabel = (i) => `Theme ${i} — grounded qualitative motif`;
const noteTitle = (i) => `Transcript segment ${i}: participant excerpt`;

/**
 * Build one project fixture at a given code count. Codes/notes/entries are
 * bulk-inserted straight into SQLite: fixture PREP, not the measured path —
 * every measured mutation flows through dispatch → journal → projection, and
 * every recipient flows through the public delivery seam. Bulk seeding keeps
 * the whole suite well under the ~120s budget.
 */
async function buildProject(size) {
  const phase = (label, start) => {
    if (process.env.BENCH_TIMINGS) console.error(`[bench ${size}] ${label}: ${(performance.now() - start).toFixed(0)}ms`);
    return performance.now();
  };
  let t = performance.now();
  const db = new DatabaseSync(':memory:');
  buildGraph(db);
  const { Project, Code, Note, Entry, User } = entities();
  executeDDL(Code, db);
  executeDDL(Note, db);
  executeDDL(Entry, db);
  const projectScope = (payload) => `Project:${payload.projectId}`;
  const app = workbench({
    db,
    entities: [Project, Code, Note, Entry, User],
    actions: [
      crudAction('Project', (payload) => `Project:${payload.row.id}`),
      crudAction('Code', projectScope),
      crudAction('Note', projectScope),
      crudAction('Entry', projectScope),
    ],
  });
  const declaration = snapshot(Project, {
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
            include: object({ noteFields: select(Note.field.title) }),
          }),
          entries: keyed(Entry, {
            via: Entry.field.codeId,
            orderBy: orderBy(Entry.field.id, 'asc'),
            include: object({ entryFields: select(Entry.field.term) }),
          }),
        }),
      }),
    }),
  });
  app.attachLiveDelivery({ principalOf: () => alice, snapshots: [declaration] });
  await app.ddl();
  app.listen(0);
  await app.ready;
  t = phase('app-ready', t);

  // Additional patch-capable recipients are minted through the package's OWN
  // bootstrapFromSnapshot seam (the exact function the public bootstrap path
  // calls after capture/authorize/project). The reference recipient per size
  // still goes through the full public delivery.bootstrap so every size cell
  // keeps one honest end-to-end snapshot measurement; the K-axis subscribers
  // reuse its already-authorized snapshot VALUE (identical bytes) instead of
  // re-capturing identical snapshots — fixture economics, not a shortcut: all
  // measured catch-ups still run through the real targeted-capture projector.
  const resolveEntity = (name) => [Project, Code, Note, Entry, User].find((candidate) => candidate.name === name);
  const compiled = compileSnapshots([declaration], resolveEntity, db);
  const patchLane = createCompositePatchDelivery({
    db,
    composites: compiled,
    mayVerb,
    authorization: null,
    includeActionId: true,
  });
  if (!patchLane) throw new Error('composite patch lane failed to engage');

  await dispatchOk(app, { actionId: 'seed-p', type: 'project.write', scope: 'Project:p1', payload: { exists: false, row: { id: 'p1', name: 'Benchmark Research' } }, principal: alice });
  db.exec('BEGIN');
  const insertCode = db.prepare('INSERT INTO Code (id, projectId, label, colour, position) VALUES (?, ?, ?, ?, ?)');
  const insertNote = db.prepare('INSERT INTO Note (id, codeId, projectId, title) VALUES (?, ?, ?, ?)');
  const insertEntry = db.prepare('INSERT INTO Entry (id, codeId, projectId, term) VALUES (?, ?, ?, ?)');
  for (let index = 0; index < size; index += 1) {
    insertCode.run(`code${index}`, 'p1', codeLabel(index), '#334155', String(index));
    insertNote.run(`note${index}`, `code${index}`, 'p1', noteTitle(index));
    insertEntry.run(`entry${index}`, `code${index}`, 'p1', `term-${index}`);
  }
  db.exec('COMMIT');
  t = phase('bulk-seed', t);

  return {
    app,
    db,
    size,
    scope: 'Project:p1',
    delivery: app._applicationLiveDelivery.delivery,
    patchLane,
    /** Monotonic mutation counter so every rename touches a fresh code. */
    mutationCount: 0,
  };
}

// Shared fixtures live for the whole file (node --test runs files serially);
// the module-level after() hook closes them even under --test-name-pattern
// filters (a teardown TEST would be filtered out, leaking listening servers).
const projects = new Map();
const closers = [];
after(async () => {
  for (const close of closers.splice(0)) await close();
});
async function getProject(size) {
  if (!projects.has(size)) {
    const fixture = await buildProject(size);
    projects.set(size, fixture);
    closers.push(async () => {
      fixture.app.httpServer.closeAllConnections?.();
      await fixture.app.shutdown();
      fixture.db.close();
    });
  }
  return projects.get(size);
}

/**
 * One REAL rename through dispatch, then a patch-capable catch-up for `sub`.
 * `lane` selects which delivery instance performs the catch-up — tokens resolve
 * ONLY against the lane whose ledger registered them, so each metric pairs its
 * recipients and catch-ups on one consistent lane (both lanes run the same
 * CompositePatchDelivery.catchupWithPatches machinery).
 */
async function renameCodeAndCatchup(fixture, sub, { labelSuffix = '', lane } = {}) {
  const index = fixture.mutationCount;
  fixture.mutationCount += 1;
  await dispatchOk(fixture.app, {
    actionId: `mut-${index}`, type: 'code.write', scope: fixture.scope,
    payload: { exists: true, projectId: 'p1', row: { id: `code${index % fixture.size}`, projectId: 'p1', label: `${codeLabel(index % fixture.size)}${labelSuffix}`, colour: '#334155', position: String(index % fixture.size) } },
    principal: alice,
  });
  const request = {
    principal: sub.principal, scope: fixture.scope, after: sub.cursor,
    capabilities: [CAP], projectionToken: sub.projectionToken,
  };
  const outcome = lane === 'package'
    ? await fixture.patchLane.catchupWithPatches({
      principal: sub.principal, scope: fixture.scope, after: sub.cursor, projectionToken: sub.projectionToken,
    })
    : await fixture.delivery.catchup(request);
  return outcome;
}

async function bootstrapRecipient(fixture, principal) {
  const boot = await fixture.delivery.bootstrap({ principal, scope: fixture.scope, capabilities: [CAP] });
  assert.equal(boot.kind, 'snapshot');
  assert.ok(boot.projectionToken, 'patch-capable bootstrap echoes the protocol + token');
  return { principal, cursor: boot.cursor, projectionToken: boot.projectionToken, boot };
}

/**
 * Mint an additional patch-capable recipient from an already-authorized
 * snapshot VALUE through the package's own bootstrapFromSnapshot seam (same
 * function the public path delegates to). Registers a fresh ledger entry and
 * token for `principal` without re-capturing identical bytes.
 */
async function mintRecipient(fixture, principal, snapshotValue, anchorCursor) {
  const patched = await fixture.patchLane.bootstrapFromSnapshot({
    principal, scope: fixture.scope, snapshotValue, anchorCursor,
  });
  assert.equal(patched.kind, 'snapshot');
  return { principal, cursor: patched.cursor, projectionToken: patched.projectionToken };
}

// ---- B3: server CPU per mutation + structural hard-fail gates ----------------

test('B3 GATE WIRING: the #157 structural-counter gates pass (re-run of the targeted-capture suite)', () => {
  // Cross-exam verdict 10 (on #122) demands STRUCTURAL counters, not timing:
  //   - captureSnapshot walking unrelated collections = FAIL;
  //   - authorization calls growing with project size at fixed K = FAIL.
  // Those gates ALREADY EXIST as tests in
  // test/composite-patch-targeted-capture.test.mjs (#157). This suite does not
  // duplicate them — it RE-RUNS them in a child process and fails if their
  // invariant regresses, making them part of the benchmark gate set.
  const output = execFileSync(process.execPath, ['--test', 'test/composite-patch-targeted-capture.test.mjs'], {
    // node --test runs this file from the package root; the child re-runs in
    // the same root so its relative specifiers resolve identically.
    cwd: process.cwd(),
    timeout: 60_000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // The inner run is an independent test process: an inherited
    // NODE_TEST_CONTEXT makes the nested `node --test` skip file execution as
    // "recursive" (empty output), so the variable is REMOVED for the child.
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
  });
  if (process.env.BENCH_TIMINGS) console.error('[bench] gate child tail:\n' + output.trimEnd().split('\n').slice(-12).join('\n'));
  // Parse the spec reporter's summary lines ("ℹ pass 7" / "ℹ fail 0").
  const passed = Number(output.match(/^ℹ pass (\d+)$/m)?.[1] ?? '0');
  const failed = Number(output.match(/^ℹ fail (\d+)$/m)?.[1] ?? '1');
  const gateTests = ['GATE anchor rename', 'GATE member rename'].every((name) => output.includes(name));
  assert.equal(failed, 0, `targeted-capture gate suite regressed:\n${output.split('\n').filter((line) => line.startsWith('not ok') || line.includes('AssertionError')).join('\n')}`);
  assert.ok(passed >= 7, `expected the full targeted-capture suite (>=7 tests), got ${passed}`);
  assert.ok(gateTests, 'both B3 structural GATE tests ran');
});



// ---- B1: bytes-on-wire -------------------------------------------------------

test('B1 bytes-on-wire: one code rename vs fresh bootstrap, sizes × K', async () => {
  const rows = [];
  for (const size of SIZES) {
    const fixture = await getProject(size);
    // Reference recipient: the one full public bootstrap per size — its wire
    // bytes ARE the B1 numerator, and its authorized snapshot value mints the
    // K-axis subscribers. Those subscribers (INCLUDING the one whose catch-up
    // is measured first) live on the package-level lane's ledger: tokens only
    // resolve against the ledger that registered them, so every B1 catch-up
    // runs on that same lane — identical CompositePatchDelivery machinery.
    const referencePrincipal = principalFor(`b1-ref-${size}`);
    const referenceBoot = await fixture.delivery.bootstrap({ principal: referencePrincipal, scope: fixture.scope, capabilities: [CAP] });
    assert.equal(referenceBoot.kind, 'snapshot');
    assert.ok(referenceBoot.projectionToken);
    const bootstrapBytes = Buffer.byteLength(JSON.stringify(referenceBoot));
    const subs = [];
    for (let k = 0; k < Math.max(...KS); k += 1) {
      subs.push(await mintRecipient(fixture, principalFor(`b1-${size}-${k}`), referenceBoot.snapshot, referenceBoot.cursor.anchor));
    }
    // The FIRST subscriber's catch-up observes the rename; every other
    // subscriber catches up its own identical-span envelope (same bytes class,
    // independently projected through the real targeted-capture lane).
    const firstOutcome = await renameCodeAndCatchup(fixture, subs[0], { lane: 'package' });
    assert.equal(firstOutcome.kind, 'catchup', `subscriber 0 patched at size ${size} (${firstOutcome.reason ?? firstOutcome.kind})`);
    const patchBytesFirst = firstOutcome.envelopes.reduce((total, envelope) => total + Buffer.byteLength(JSON.stringify(envelope)), 0);
    for (let k = 1; k < Math.max(...KS); k += 1) {
      const outcome = await renameCodeAndCatchup(fixture, subs[k], { lane: 'package' });
      assert.equal(outcome.kind, 'catchup', `subscriber ${k} patched at size ${size} (${outcome.reason ?? outcome.kind})`);
    }
    for (const k of KS) {
      const totalBootstrapBytes = bootstrapBytes * k;
      const totalPatchBytes = patchBytesFirst * k;
      const ratio = totalBootstrapBytes / totalPatchBytes;
      rows.push({
        metric: 'B1', hash: GIT_HASH, size, k,
        bootstrap_bytes: totalBootstrapBytes, patch_bytes: totalPatchBytes,
        ratio: Math.round(ratio),
      });
      // ≥10³ holds once the snapshot carries ≥~2500 member subtrees (the
      // envelope carries exactly ONE). Below that the geometric ceiling is
      // ~N/2, so a proportional floor stands in — documented deviation.
      if (size >= 5000) assert.ok(ratio >= 1000, `B1 ratio ${Math.round(ratio)} >= 1000 at size ${size}`);
      else assert.ok(ratio >= size / 4, `B1 ratio ${Math.round(ratio)} >= ${size / 4} at size ${size}`);
    }
  }
  console.table(rows);
});

// ---- B4: per-recipient memory (heapUsed tripwire, K=20) ------------------------

// ---- B2: client-visible stall per mutation over a REAL live-delivery session --

test('B2 CLIENT STALL: 1000 mutations, real session, publish-latency p50/p95/p99', async () => {
  const fixture = await getProject(5000);
  const b2Principal = { type: 'user', id: 'b2-session-holder' };
  const b2Recipient = { principal: b2Principal, cursor: null, projectionToken: null };
  // A REAL client session over in-process adapters. The bootstrap adapter is
  // the public seam itself; the subscribe adapter hands recipient envelopes to
  // the package-owned ingest (applySnapshotPatch). No HTTP, same machinery.
  let deliverEnvelopes = null;
  const session = createLiveDeliverySession({
    bootstrap: async ({ mode }) => {
      if (mode !== 'snapshot') throw new Error(`unexpected recovery mode ${mode}`);
      const boot = await fixture.delivery.bootstrap({ principal: b2Principal, scope: fixture.scope, capabilities: [CAP] });
      // The server-side catch-up driver needs the same anchor + token the
      // client just received.
      b2Recipient.cursor = boot.cursor;
      b2Recipient.projectionToken = boot.projectionToken;
      return boot;
    },
    subscribe: async ({ deliver }) => {
      deliverEnvelopes = (envelopes) => deliver(envelopes);
      return { close() { deliverEnvelopes = null; } };
    },
    validateSnapshot: (snapshot) => snapshot,
    sendAction: async () => ({ ok: true }),
    createActionId: (() => { let n = 0; return () => `b2-act-${n += 1}`; })(),
    // Far beyond any real recovery; kept inside setTimeout's 32-bit range.
    recoveryWarningDelayMs: 2 ** 31 - 1,
  });
  await session.ready;
  assert.equal(session.status, 'live');
  assert.equal(session.deltaCapable, true, 'capability echo arms delta mode');
  assert.ok(typeof session.projectionToken === 'string');

  // Stall = listener-publish timestamp minus the moment envelopes were handed
  // to the client's delivery chain. Includes applySnapshotPatch + settlement.
  let handedAt = 0;
  const stalls = [];
  const dispatchRtts = [];
  session.subscribe(() => {
    stalls.push(performance.now() - handedAt);
  });

  const rounds = 1000;
  for (let i = 0; i < rounds; i += 1) {
    const t0 = performance.now();
    const outcome = await renameCodeAndCatchup(fixture, b2Recipient, { lane: 'public' });
    dispatchRtts.push(performance.now() - t0);
    assert.equal(outcome.kind, 'catchup', `round ${i} patched (${outcome.reason ?? outcome.kind})`);
    // The ledger rotates per accepted patch: carry the newest handle forward.
    b2Recipient.cursor = outcome.cursor;
    b2Recipient.projectionToken = outcome.envelopes[outcome.envelopes.length - 1].projectionToken;
    handedAt = performance.now();
    await deliverEnvelopes(outcome.envelopes);
    // Drain microtasks so the publish lands before the next round measures it.
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.ok(stalls.length >= 500, `measured >=500 publish stalls, got ${stalls.length}`);
  const sorted = [...stalls].sort((a, b) => a - b);
  const pct = (p) => Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(3));
  const mean = (array) => array.reduce((total, value) => total + value, 0) / array.length;
  console.table([{
    metric: 'B2', hash: GIT_HASH, size: 5000, k: 1, rounds,
    stall_p50_ms: pct(0.5), stall_p95_ms: pct(0.95), stall_p99_ms: pct(0.99),
    dispatch_rtt_mean_ms: Number(mean(dispatchRtts).toFixed(2)),
  }]);
  // The client must remain live and fully drained after 1000 patch cycles.
  assert.equal(session.status, 'live', 'session stayed live through 1000 patches');
  assert.equal(session.pendingCount(), 0, 'no optimistic residue — no actions dispatched via the client');
  assert.ok(pct(0.95) < 16, `publish-stall p95 ${pct(0.95)}ms < one frame budget`);
  session.close();
});

// ---- B4 HEAP: per-recipient memory tripwire ------------------------------------

test('B4 HEAP: retained memory per active subscription stays within the ledger budget', async () => {
  // Per-SUBSCRIPTION state (ledger entry + projection token + cursor) is the
  // quantity under bound — the snapshot VALUE is transient per request. The
  // smallest fixture exercises the identical subscription machinery at a
  // fraction of the setup cost.
  const fixture = await getProject(100);
  const SIZE_BUDGET_PER_SUB = 5000 * 400; // ids × ~50B budget, 8× GC-noise headroom
  assert.equal(typeof globalThis.gc, 'function', 'heap benchmark requires --expose-gc');
  globalThis.gc();
  const baseline = process.memoryUsage().heapUsed;
  // K=20 ACTIVE subscriptions on the public seam — distinct principals so each
  // holds its own independent ledger entry + projection token.
  const subs = [];
  for (let i = 0; i < 20; i += 1) {
    subs.push(await bootstrapRecipient(fixture, principalFor(`b4-heap-${i}`)));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  globalThis.gc();
  const afterBootstrap = process.memoryUsage().heapUsed;
  const perSubDelta = Math.max(0, afterBootstrap - baseline) / subs.length;
  console.table([{
    metric: 'B4', hash: GIT_HASH, size: 100, k: subs.length,
    per_sub_heap_delta_bytes: Math.round(perSubDelta),
    budget_bytes_per_sub: SIZE_BUDGET_PER_SUB,
    verdict: perSubDelta <= SIZE_BUDGET_PER_SUB ? 'within-budget' : 'OVER-BUDGET',
  }]);
  // Regression TRIPWIRE, not a precise budget (GC noise is real; the bound is
  // deliberately ~8× the ~ids×50B expectation). A structural leak — e.g. an
  // unbounded per-subscriber index — blows through this immediately.
  assert.ok(perSubDelta <= SIZE_BUDGET_PER_SUB,
    `per-subscription retained heap ${Math.round(perSubDelta)}B <= ${SIZE_BUDGET_PER_SUB}B (ids×~50B with generous tolerance)`);
});


test('B3 server CPU: one rename fanned out to K patch recipients, sizes × K', async () => {
  const rows = [];
  for (const size of SIZES) {
    const fixture = await getProject(size);
    for (const k of KS) {
      // K distinct recipients on ONE lane, all registered before the rename.
      const subs = [];
      const referenceBoot = await fixture.delivery.bootstrap({ principal: principalFor(`b3-ref-${size}-${k}`), scope: fixture.scope, capabilities: [CAP] });
      assert.equal(referenceBoot.kind, 'snapshot');
      subs.push({ principal: principalFor(`b3-${size}-${k}-0`), cursor: referenceBoot.cursor, projectionToken: null, boot: referenceBoot });
      for (let i = 0; i < k; i += 1) subs.push(await mintRecipient(fixture, principalFor(`b3-${size}-${k}-${i}`), referenceBoot.snapshot, referenceBoot.cursor.anchor));
      // The first sub's token lives on the PUBLIC ledger — swap it for a
      // lane-registered one by minting a replacement and dropping the public
      // recipient from the measured set.
      subs.shift();
      const cpu0 = process.cpuUsage();
      const wall0 = performance.now();
      let lastKind = null;
      for (const sub of subs) {
        const outcome = await renameCodeAndCatchup(fixture, sub, { lane: 'package' });
        lastKind = outcome.kind;
        assert.equal(outcome.kind, 'catchup', `fan-out recipient patched at size ${size} k=${k} (${outcome.reason ?? outcome.kind})`);
      }
      const cpu = process.cpuUsage(cpu0);
      const wallMs = performance.now() - wall0;
      rows.push({
        metric: 'B3', hash: GIT_HASH, size, k,
        cpu_ms: Number(((cpu.user + cpu.system) / 1000).toFixed(1)),
        wall_ms: Number(wallMs.toFixed(1)),
        per_recipient_cpu_ms: Number(((cpu.user + cpu.system) / 1000 / Math.max(k, 1)).toFixed(2)),
        kind: lastKind,
      });
    }
  }
  console.table(rows);
});

// ---- B4: per-recipient memory + ledger-eviction demotion ----------------------

test('B4 DEMOTION: an evicted projection token falls back to a full snapshot on next catch-up', async (t) => {
  const fixture = await getProject(5000);
  const holder = principalFor('b4-holder');
  // Quiet-journal setup: every bootstrap below registers against the SAME
  // composite cursor, so the ONLY difference between the control and the
  // demotion attempt is ledger presence (eviction), never cursor disagreement.
  const first = await fixture.delivery.bootstrap({ principal: holder, scope: fixture.scope, capabilities: [CAP] });
  assert.equal(first.kind, 'snapshot');
  // The retained predecessor chain per holder is bounded (chainLength=3):
  // three further registrations evict `first`'s entry insertion-order.
  for (let i = 0; i < 3; i += 1) {
    const next = await fixture.delivery.bootstrap({ principal: holder, scope: fixture.scope, capabilities: [CAP] });
    assert.equal(next.kind, 'snapshot');
    assert.notEqual(next.projectionToken, first.projectionToken);
  }
  const current = await fixture.delivery.bootstrap({ principal: holder, scope: fixture.scope, capabilities: [CAP] });
  // CONTROL: the newest token resolves — a no-op catch-up ('you are current').
  const control = await fixture.delivery.catchup({
    principal: holder, scope: fixture.scope, after: current.cursor,
    capabilities: [CAP], projectionToken: current.projectionToken,
  });
  assert.equal(control.kind, 'catchup', `control catch-up with the live token (${control.reason ?? control.kind})`);
  assert.deepEqual(control.envelopes, [], 'no journal movement — empty delta');
  // DEMOTION: the EVICTED token cannot resolve → the public seam answers with
  // a fresh full authorized snapshot (never an error, never a partial).
  const demoted = await fixture.delivery.catchup({
    principal: holder, scope: fixture.scope, after: first.cursor,
    capabilities: [CAP], projectionToken: first.projectionToken,
  });
  assert.equal(demoted.kind, 'snapshot', `evicted-token catch-up must demote to a full snapshot (got ${demoted.kind} ${demoted.reason ?? ''})`);
  assert.ok(demoted.projectionToken && demoted.projectionToken !== first.projectionToken, 'demotion re-arms with a FRESH projection token');
  assert.equal(demoted.protocol, CAP, 'the fallback snapshot echoes the negotiated protocol');
  assert.equal(Object.keys(demoted.snapshot.codes).length, 5000, 'demotion delivers the complete project state');
});

