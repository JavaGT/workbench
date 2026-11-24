// search-response.test.mjs — the S4/A6 search response contract + search
// authorization seam (epic scope#23).
//
// Covers, per the ticket:
//   - generation + staleness disclosed on every response/result (ready→fresh,
//     stale→stale, building→rebuilding, failed→stale — never a silent current);
//   - pre-scope + per-result admission through the S5/A2 adapter (the 
//     pre-scope gate is auth + registration; the per-result gate re-verifies
//     each candidate against the CURRENT registered scope under the CURRENT
//     collapsed principal);
//   - the red line: a result whose access was revoked AFTER indexing is
//     omitted, and an excerpt is never carved from a field the principal cannot
//     read;
//   - cancellation / timeout / bounded limits / deterministic tie-break.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  text, ref, scope, grant, deny, read, write, subscribe,
  principal, anonymous, allowAnonymous,
} from '../build/index.mjs';
import { entity, NonCompilableError } from '../build/internal.mjs';
import { createAuthorizationAdapter } from '../build/authorization-adapter.mjs';
import { createSearchPluginRegistry, SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION } from '../build/search-plugin.mjs';
import {
  createSearchSourceRegistry,
  admitSearchSourceScope,
  admitSearchResult,
  admitSearchExcerpt,
  admitSearchHits,
} from '../build/search-auth.mjs';
import {
  searchStalenessOf,
  boundSearchLimit,
  searchPageWindow,
  SEARCH_MAX_RESULTS_CAP,
  SEARCH_MAX_PAGE_SIZE,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_DEFAULT_PAGE_SIZE,
  compareSearchRanks,
  compareSearchKeys,
  tieBreakSearchHits,
  searchWithDeadline,
  SearchCancelledError,
  SearchDuplicateKeyError,
  buildSearchResponse,
} from '../build/search-response.mjs';

// ---- fixtures ---------------------------------------------------------------

// An owner-scoped source: alice sees her own rows through the registered scope.
const alice = principal({ type: 'user', id: 'alice' });
const bob = principal({ type: 'user', id: 'bob' });
const aliceRow = { id: 'n1', title: 'hello', owner: 'alice' };
const bobRow = { id: 'n2', title: 'secret', owner: 'bob' };

function ownerAdapter(trace = false) {
  const adapter = createAuthorizationAdapter({ trace });
  const registry = createSearchSourceRegistry(adapter);
  registry.register({
    pluginId: 'notes-fts',
    scope: ({ is }) => is.owner(),
    fields: { owner: ref('User', { role: 'owner' }) },
    // Purely in-memory policy fixture: no SQL table backs these rows, so opt in
    // to single-row evaluation explicitly (production registrations do not).
    allowRowScopeFallback: true,
  });
  return { adapter, registry };
}

// ---- generation + staleness in responses ------------------------------------

describe('search response contract — staleness disclosure', () => {
  test('searchStalenessOf maps the registry health state to the closed vocabulary', () => {
    assert.equal(searchStalenessOf('ready'), 'fresh');
    assert.equal(searchStalenessOf('stale'), 'stale');
    assert.equal(searchStalenessOf('building'), 'rebuilding');
    // A failed index is not current (stale) but nothing is actively
    // materializing it either (never 'rebuilding'); an unknown state is never
    // claimed fresh.
    assert.equal(searchStalenessOf('failed'), 'stale');
    assert.equal(searchStalenessOf('mystery'), 'stale');
  });

  test('the staleness is derived from the registry, not claimed by the plugin', async () => {
    const registry = createSearchPluginRegistry();
    registry.register({
      contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
      id: 'notes-fts',
      version: '1.0.0',
      ownedObjects: [{ kind: 'virtual-table', name: 'notes_fts', ddl: ['CREATE VIRTUAL TABLE notes_fts USING fts5(title);'], disposition: { kind: 'schema-only' } }],
      sourceInterests: [{ entity: 'Note' }],
      stalenessKey: (change) => (change.entity === 'Note' ? `${change.entity}:${change.rowId}` : null),
      prepare: () => {},
      validate: () => {},
      reconcile: () => ({ counts: {} }),
      rebuild: () => ({ counts: {} }),
      search: () => ({ hits: [] }),
    });
    assert.equal(searchStalenessOf(registry.stateOf('notes-fts').state), 'rebuilding');
    await registry.rebuild('notes-fts');
    assert.equal(registry.stateOf('notes-fts').state, 'ready');
    assert.equal(searchStalenessOf(registry.stateOf('notes-fts').state), 'fresh');
    registry.notifyChange('notes-fts', { entity: 'Note', rowId: 'n1', kind: 'updated' });
    assert.equal(searchStalenessOf(registry.stateOf('notes-fts').state), 'stale');
  });

  test('buildSearchResponse stamps every result and freezes the whole response', () => {
    const response = buildSearchResponse({
      pluginId: 'notes-fts',
      generation: 2,
      staleness: 'stale',
      hits: [
        { key: 'n1', rank: 1, hit: { id: 'n1' }, excerpt: 'hello' },
        { key: 'n2', rank: 2, hit: { id: 'n2' } },
      ],
      omitted: 1,
    });
    assert.equal(response.ok, true);
    assert.equal(response.pluginId, 'notes-fts');
    assert.equal(response.generation, 2);
    assert.equal(response.staleness, 'stale');
    assert.equal(response.omitted, 1);
    assert.equal(response.cancelled, false);
    assert.equal(response.timedOut, false);
    assert.equal(response.error, null);
    assert.equal(response.hits.length, 2);
    for (const hit of response.hits) {
      assert.equal(hit.pluginId, 'notes-fts');
      assert.equal(hit.generation, 2);
      assert.equal(hit.staleness, 'stale');
    }
    assert.equal(response.hits[0].excerpt, 'hello');
    assert.equal('excerpt' in response.hits[1], false);
    assert.ok(Object.isFrozen(response));
    assert.ok(Object.isFrozen(response.hits));
    assert.ok(Object.isFrozen(response.hits[0]));
  });

  test('a denied / cancelled / timed-out response is never ok', () => {
    const denied = buildSearchResponse({ pluginId: 'x', generation: 0, staleness: 'rebuilding', error: 'denied' });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, 'denied');
    assert.deepEqual(denied.hits, []);
    const cancelled = buildSearchResponse({ pluginId: 'x', generation: 0, staleness: 'fresh', cancelled: true });
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.cancelled, true);
    const timedOut = buildSearchResponse({ pluginId: 'x', generation: 0, staleness: 'fresh', timedOut: true });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.timedOut, true);
  });
});

// ---- bounded limits ----------------------------------------------------------

describe('search response contract — bounded limits', () => {
  test('boundSearchLimit clamps a requested bound into [1, cap]', () => {
    assert.equal(boundSearchLimit(5), 5);
    assert.equal(boundSearchLimit(undefined), SEARCH_DEFAULT_LIMIT);
    assert.equal(boundSearchLimit(100_000), SEARCH_MAX_RESULTS_CAP);
    assert.equal(boundSearchLimit(-3), SEARCH_DEFAULT_LIMIT);
    assert.equal(boundSearchLimit(0), SEARCH_DEFAULT_LIMIT);
    assert.equal(boundSearchLimit(Number.NaN), SEARCH_DEFAULT_LIMIT);
    assert.equal(boundSearchLimit(7.9), 7);
    assert.equal(boundSearchLimit(500, 25, 100), 100);
    assert.equal(boundSearchLimit(undefined, 25, 100), 25);
  });

  test('searchPageWindow bounds paging and flat windows deterministically', () => {
    assert.deepEqual(searchPageWindow({ page: 2, pageSize: 20 }), { offset: 20, limit: 20 });
    assert.deepEqual(searchPageWindow({ page: 1 }), { offset: 0, limit: SEARCH_DEFAULT_PAGE_SIZE });
    // a requested page size past the cap is clamped, never honored
    assert.deepEqual(searchPageWindow({ page: 3, pageSize: 5000 }), { offset: 200, limit: SEARCH_MAX_PAGE_SIZE });
    assert.deepEqual(searchPageWindow({ page: 0 }), { offset: 0, limit: SEARCH_DEFAULT_LIMIT });
    assert.deepEqual(searchPageWindow({ limit: 30, offset: 10 }), { offset: 10, limit: 30 });
    assert.deepEqual(searchPageWindow({ offset: -5 }), { offset: 0, limit: SEARCH_DEFAULT_LIMIT });
    assert.deepEqual(searchPageWindow({}), { offset: 0, limit: SEARCH_DEFAULT_LIMIT });
  });
});

// ---- deterministic tie-breaking ---------------------------------------------

describe('search response contract — deterministic tie-breaking', () => {
  test('compareSearchRanks orders numerically with a direction, missing last in both orders', () => {
    assert.equal(compareSearchRanks(1, 2), -1);
    assert.equal(compareSearchRanks(1, 2, 'desc'), 1);
    // numeric-string ranks compare as numbers (SQLite-style coercion)
    assert.equal(compareSearchRanks('7', 7), 0);
    assert.equal(compareSearchRanks('10', '9'), 1);
    // missing / non-finite ranks sort AFTER every present rank in EITHER order
    assert.equal(compareSearchRanks(null, 1), 1);
    assert.equal(compareSearchRanks(1, undefined), -1);
    assert.equal(compareSearchRanks(Number.NaN, 1, 'desc'), 1);
    // two missing / non-numeric ranks fall back to a lexicographic raw form
    assert.equal(compareSearchRanks(null, undefined), 0);
    assert.equal(compareSearchRanks('b', 'a'), 1);
  });

  test('tieBreakSearchHits orders by rank then key, and never mutates the input', () => {
    const asc = tieBreakSearchHits(
      [
        { key: 'b', rank: 1 },
        { key: 'a', rank: 1 },
        { key: 'c', rank: 0 },
        { key: 'd', rank: null },
      ],
      { rankOf: (hit) => hit.rank, keyOf: (hit) => hit.key, order: 'asc' },
    );
    assert.deepEqual(asc.map((hit) => hit.key), ['c', 'a', 'b', 'd']);

    const desc = tieBreakSearchHits(
      [
        { key: 'a', rank: 1 },
        { key: 'b', rank: 2 },
        { key: 'c', rank: 2 },
        { key: 'z', rank: null },
      ],
      { rankOf: (hit) => hit.rank, keyOf: (hit) => hit.key, order: 'desc' },
    );
    assert.deepEqual(desc.map((hit) => hit.key), ['b', 'c', 'a', 'z']);

    const source = [{ key: 'b', rank: 1 }, { key: 'a', rank: 1 }];
    const out = tieBreakSearchHits(source, { rankOf: (hit) => hit.rank, keyOf: (hit) => hit.key });
    assert.deepEqual(source.map((hit) => hit.key), ['b', 'a'], 'input is not mutated');
    assert.deepEqual(out.map((hit) => hit.key), ['a', 'b']);
    assert.notEqual(out, source);
  });

  test('compareSearchKeys is the deterministic total-order fallback', () => {
    assert.equal(compareSearchKeys('a', 'b'), -1);
    assert.equal(compareSearchKeys('b', 'a'), 1);
    assert.equal(compareSearchKeys('same', 'same'), 0);
  });
});

// ---- cancellation + timeout --------------------------------------------------

describe('search response contract — cancellation and timeout', () => {
  test('an already-aborted signal cancels before the run is invoked', async () => {
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    const outcome = await searchWithDeadline(() => {
      invoked = true;
      return 42;
    }, { signal: controller.signal });
    assert.deepEqual(outcome, { kind: 'cancelled' });
    assert.equal(invoked, false, 'a cancelled search never queries the plugin');
  });

  test('an abort during the run cancels', async () => {
    const controller = new AbortController();
    const pending = searchWithDeadline(async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (signal.aborted) throw new SearchCancelledError();
      return 1;
    }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    assert.deepEqual(await pending, { kind: 'cancelled' });
  });

  test('a cooperative plugin that self-cancels maps to cancelled', async () => {
    const outcome = await searchWithDeadline(async () => {
      throw new SearchCancelledError();
    });
    assert.deepEqual(outcome, { kind: 'cancelled' });
  });

  test('a timeout aborts the run signal and wins even against an uncooperative plugin', async () => {
    let receivedSignal = null;
    const outcome = await searchWithDeadline((signal) => {
      receivedSignal = signal;
      // ignores the signal entirely and never resolves
      return new Promise(() => {});
    }, { timeoutMs: 10 });
    assert.deepEqual(outcome, { kind: 'timed-out' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(receivedSignal.aborted, true, 'the run received an aborted signal at the deadline');
  });

  test('an abort wins even against an uncooperative plugin', async () => {
    const controller = new AbortController();
    const pending = searchWithDeadline(() => new Promise(() => {}), { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    assert.deepEqual(await pending, { kind: 'cancelled' });
  });

  test('a completed run returns its value; unrelated failures propagate', async () => {
    const ok = await searchWithDeadline(() => 42, { timeoutMs: 100 });
    assert.deepEqual(ok, { kind: 'completed', value: 42 });
    await assert.rejects(
      () => searchWithDeadline(async () => { throw new Error('query exploded'); }),
      /query exploded/,
      'a real plugin failure is the caller/registry problem, not a closed outcome',
    );
  });
});

// ---- pre-scope + per-result admission ----------------------------------------

describe('search authorization — pre-scope admission', () => {
  test('registration compiles the source scope at registration (S5/A2 mirror)', () => {
    const adapter = createAuthorizationAdapter();
    const registry = createSearchSourceRegistry(adapter);
    registry.register({
      pluginId: 'notes-fts',
      scope: ({ is }) => is.owner(),
      fields: { owner: ref('User', { role: 'owner' }) },
    });
    assert.equal(registry.adapter, adapter, 'the registry is bound to the adapter it was created against');
    assert.equal(registry.has('notes-fts'), true);
    assert.deepEqual(registry.ids(), ['notes-fts']);
    assert.equal(registry.size, 1);

    // a raw boolean is not an AST → refused at registration
    assert.throws(() => registry.register({ pluginId: 'bad', scope: () => true }), NonCompilableError);
    // a scope-less resource would load every row and filter in JS → refused
    assert.throws(() => registry.register({ pluginId: 'noless' }), /scope predicate/);
    assert.throws(() => registry.register({ pluginId: '', scope: () => true }), /pluginId/);
    // a registry is never created without a real adapter
    assert.throws(() => createSearchSourceRegistry(null), /adapter/);
    // nothing is recorded for a refused registration
    assert.equal(registry.has('bad'), false);
    assert.equal(registry.has('noless'), false);
  });

  test('an active user with a registered scope admits; an unregistered plugin denies', async () => {
    const { adapter, registry } = ownerAdapter();
    const admitted = await admitSearchSourceScope(adapter, registry, { pluginId: 'notes-fts', principal: alice });
    assert.deepEqual(admitted, { admitted: true, reasonCode: null });
    const missing = await admitSearchSourceScope(adapter, registry, { pluginId: 'ghost', principal: alice });
    assert.deepEqual(missing, { admitted: false, reasonCode: 'no-resource' });
  });

  test('anonymous and revoked principals deny identically — no status oracle', async () => {
    const { adapter, registry } = ownerAdapter();
    const anon = await admitSearchSourceScope(adapter, registry, { pluginId: 'notes-fts', principal: anonymous });
    assert.equal(anon.admitted, false);
    const revoked = principal({ type: 'user', id: 'alice', status: 'revoked' });
    const revokedDecision = await admitSearchSourceScope(adapter, registry, { pluginId: 'notes-fts', principal: revoked });
    assert.equal(revokedDecision.admitted, false);
    assert.equal(revokedDecision.reasonCode, anon.reasonCode, 'revoked collapses to anonymous on the decision surface');
  });

  test('a registry created against one adapter refuses a different adapter (identity check)', async () => {
    const { adapter: adapterA, registry } = ownerAdapter();
    const adapterB = createAuthorizationAdapter();
    // The same plugin/resource shape registered on B is still refused: the
    // registry only admits through the adapter it was created against.
    const bRegistry = createSearchSourceRegistry(adapterB);
    bRegistry.register({
      pluginId: 'notes-fts',
      scope: ({ is }) => is.owner(),
      fields: { owner: ref('User', { role: 'owner' }) },
    });
    assert.notEqual(registry.adapter, adapterB);
    const wrong = await admitSearchSourceScope(adapterB, registry, { pluginId: 'notes-fts', principal: alice });
    assert.deepEqual(wrong, { admitted: false, reasonCode: 'no-resource' });
    // the bound adapter still admits through its own registry
    const right = await admitSearchSourceScope(adapterA, registry, { pluginId: 'notes-fts', principal: alice });
    assert.deepEqual(right, { admitted: true, reasonCode: null });
  });

  test('a caller serving public search opts into allowAnonymous(); the scope still constrains every row', async () => {
    const adapter = createAuthorizationAdapter();
    const registry = createSearchSourceRegistry(adapter);
    registry.register({
      pluginId: 'public-notes',
      scope: ({ fields }) => fields.visibility.is('public'),
      fields: { visibility: text() },
      // In-memory policy fixture: evaluate the supplied row against the scope.
      allowRowScopeFallback: true,
    });
    const pre = await admitSearchSourceScope(adapter, registry, {
      pluginId: 'public-notes',
      principal: anonymous,
      gate: allowAnonymous(),
    });
    assert.equal(pre.admitted, true, 'allowAnonymous() admits the pre-scope gate');
    // ...but the per-result admission still requires the registered scope
    const visible = await admitSearchResult(adapter, { pluginId: 'public-notes', principal: anonymous, row: { id: 'p1', visibility: 'public' } });
    assert.equal(visible.admitted, true);
    const hidden = await admitSearchResult(adapter, { pluginId: 'public-notes', principal: anonymous, row: { id: 'p2', visibility: 'private' } });
    assert.equal(hidden.admitted, false);
  });

  test('a throwing adapter is a fail-closed policy-error, never a throw', async () => {
    const throwing = { admit: async () => { throw new Error('boom'); }, registerResource: () => {} };
    const registry = createSearchSourceRegistry(throwing);
    registry.register({
      pluginId: 'notes-fts',
      scope: ({ is }) => is.owner(),
      fields: { owner: ref('User', { role: 'owner' }) },
    });
    const decision = await admitSearchSourceScope(throwing, registry, { pluginId: 'notes-fts', principal: alice });
    assert.deepEqual(decision, { admitted: false, reasonCode: 'policy-error' });
  });
});

describe('search authorization — per-result admission', () => {
  test('a candidate inside the registered scope admits; outside denies with a closed code', async () => {
    const { adapter } = ownerAdapter();
    const inScope = await admitSearchResult(adapter, { pluginId: 'notes-fts', principal: alice, row: aliceRow });
    assert.deepEqual(inScope, { admitted: true, reasonCode: null });
    const outOfScope = await admitSearchResult(adapter, { pluginId: 'notes-fts', principal: alice, row: bobRow });
    assert.deepEqual(outOfScope, { admitted: false, reasonCode: 'no-row-scope' });
    // the owner-side direction holds too: bob's own rows admit for bob
    const bobOwn = await admitSearchResult(adapter, { pluginId: 'notes-fts', principal: bob, row: bobRow });
    assert.deepEqual(bobOwn, { admitted: true, reasonCode: null });
  });

  test('admitSearchHits keeps only admitted candidates and reports the omitted count', async () => {
    const { adapter } = ownerAdapter();
    const outcome = await admitSearchHits(adapter, {
      pluginId: 'notes-fts',
      generation: 3,
      staleness: 'fresh',
      principal: alice,
      candidates: [
        { hit: { id: 'n1' }, key: 'n1', rank: 1, row: aliceRow },
        { hit: { id: 'n2' }, key: 'n2', rank: 2, row: bobRow },
        // the source row no longer exists (erased since indexing) → omitted
        { hit: { id: 'n3' }, key: 'n3', rank: 3, row: null },
      ],
    });
    assert.equal(outcome.omitted, 2);
    assert.equal(outcome.hits.length, 1);
    assert.equal(outcome.hits[0].key, 'n1');
    assert.equal(outcome.hits[0].rank, 1);
    assert.equal(outcome.hits[0].hit.id, 'n1');
    assert.equal(outcome.hits[0].pluginId, 'notes-fts');
    assert.equal(outcome.hits[0].generation, 3);
    assert.equal(outcome.hits[0].staleness, 'fresh');
  });

  test('the red line — access revoked AFTER indexing omits the result', async () => {
    const { adapter } = ownerAdapter();

    // At index time the row was alice's; alice's search returns it.
    const before = await admitSearchHits(adapter, {
      pluginId: 'notes-fts', generation: 1, staleness: 'fresh', principal: alice,
      candidates: [{ hit: { id: 'n1' }, key: 'n1', rank: 1, row: aliceRow }],
    });
    assert.equal(before.hits.length, 1);

    // After indexing, ownership transferred in the SOURCE row. The index still
    // contains the hit, but the current row no longer admits — the index is
    // never trusted to carry authorization.
    const transferredRow = { ...aliceRow, owner: 'bob' };
    const afterTransfer = await admitSearchHits(adapter, {
      pluginId: 'notes-fts', generation: 1, staleness: 'fresh', principal: alice,
      candidates: [{ hit: { id: 'n1' }, key: 'n1', rank: 1, row: transferredRow }],
    });
    assert.equal(afterTransfer.hits.length, 0);
    assert.equal(afterTransfer.omitted, 1);

    // Principal revocation after indexing omits the same way — even though the
    // row is unchanged and the index still holds it.
    const revokedAlice = principal({ type: 'user', id: 'alice', status: 'revoked' });
    const afterRevoke = await admitSearchHits(adapter, {
      pluginId: 'notes-fts', generation: 1, staleness: 'fresh', principal: revokedAlice,
      candidates: [{ hit: { id: 'n1' }, key: 'n1', rank: 1, row: aliceRow }],
    });
    assert.equal(afterRevoke.hits.length, 0);
    assert.equal(afterRevoke.omitted, 1);
  });

  test('a field-scoped resource admits per row through the same seam', async () => {
    const adapter = createAuthorizationAdapter();
    const registry = createSearchSourceRegistry(adapter);
    registry.register({
      pluginId: 'articles',
      scope: ({ fields }) => fields.status.is('published'),
      fields: { status: text() },
      // In-memory policy fixture: evaluate the supplied row against the scope.
      allowRowScopeFallback: true,
    });
    const published = await admitSearchResult(adapter, { pluginId: 'articles', principal: anonymous, row: { id: 'a1', status: 'published' } });
    assert.equal(published.admitted, true);
    const draft = await admitSearchResult(adapter, { pluginId: 'articles', principal: anonymous, row: { id: 'a2', status: 'draft' } });
    assert.equal(draft.admitted, false);
    assert.equal(draft.reasonCode, 'no-row-scope');
  });
});

// ---- per-excerpt admission: no unreadable-field excerpts ----------------------

describe('search authorization — per-excerpt admission', () => {
  function noteWithSecret() {
    return entity('Note', {
      title: text(),
      body: text(),
      secret: text().can(async () => deny('no field access')),
      owner: ref('User', { role: 'owner', readonly: true }),
      grant: () => [
        scope(({ is }) => is.owner()).can(async ({ is }) =>
          (await is.owner()) ? grant(read, write, subscribe) : deny('no'),
        ),
      ],
    });
  }

  test("a readable field's excerpt is returned; a denied field's excerpt is omitted", async () => {
    const { adapter } = ownerAdapter();
    const Note = noteWithSecret();
    const outcome = await admitSearchHits(adapter, {
      pluginId: 'notes-fts', generation: 4, staleness: 'stale', principal: alice,
      candidates: [
        // body has no .can → the row grant's read capability confers the field
        { hit: { id: 'n1' }, key: 'n1', rank: 1, row: aliceRow, excerpt: { entity: Note, fieldName: 'body', text: 'visible snippet' } },
        // secret denies → the hit survives WITHOUT the excerpt
        { hit: { id: 'n2' }, key: 'n2', rank: 2, row: aliceRow, excerpt: { entity: Note, fieldName: 'secret', text: 'forbidden snippet' } },
      ],
    });
    assert.equal(outcome.hits.length, 2, 'both rows admit; only the excerpt is withheld');
    assert.equal(outcome.hits[0].excerpt, 'visible snippet');
    assert.equal(outcome.hits[1].excerpt, undefined);
    assert.equal('excerpt' in outcome.hits[1], false);
  });

  test('admitSearchExcerpt is the one-candidate primitive and fails closed', async () => {
    const Note = noteWithSecret();
    const adapter = createAuthorizationAdapter();
    const readable = await admitSearchExcerpt(adapter, { entity: Note, row: aliceRow, fieldName: 'body', principal: alice });
    assert.equal(readable.admitted, true);
    const denied = await admitSearchExcerpt(adapter, { entity: Note, row: aliceRow, fieldName: 'secret', principal: alice });
    assert.equal(denied.admitted, false);
    assert.equal(denied.reasonCode, 'no-field-access');

    // a throwing field .can is a fail-closed policy-error, never a 500
    const ThrowingNote = entity('Note', {
      secret: text().can(() => { throw new Error('boom'); }),
      owner: ref('User', { role: 'owner' }),
      grant: () => [scope(({ is }) => is.owner()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : deny('no'))],
    });
    const throwing = await admitSearchExcerpt(adapter, { entity: ThrowingNote, row: aliceRow, fieldName: 'secret', principal: alice });
    assert.deepEqual(throwing, { admitted: false, reasonCode: 'policy-error' });
  });

  test('an unknown/mismatched field name on the source entity denies the excerpt', async () => {
    const { adapter } = ownerAdapter();
    const Note = noteWithSecret();
    // 'snippet' is not a declared field on Note — the strong-inherit row-grant
    // default must NOT be reachable through a fabricated field name (fail
    // closed: an excerpt is only ever carved from a field the entity declares).
    const unknown = await admitSearchExcerpt(adapter, { entity: Note, row: aliceRow, fieldName: 'snippet', principal: alice });
    assert.deepEqual(unknown, { admitted: false, reasonCode: 'no-field-access' });
    // even a field the ROW grant could read must not admit under a name the
    // entity does not declare
    const wrongCase = await admitSearchExcerpt(adapter, { entity: Note, row: aliceRow, fieldName: 'Owner', principal: alice });
    assert.deepEqual(wrongCase, { admitted: false, reasonCode: 'no-field-access' });
    // a declared field still admits through the entity field seam
    const declared = await admitSearchExcerpt(adapter, { entity: Note, row: aliceRow, fieldName: 'owner', principal: alice });
    assert.equal(declared.admitted, true);
  });

  test('admitSearchHits withholds an excerpt carved from an undeclared field', async () => {
    const { adapter } = ownerAdapter();
    const Note = noteWithSecret();
    const outcome = await admitSearchHits(adapter, {
      pluginId: 'notes-fts', generation: 4, staleness: 'stale', principal: alice,
      candidates: [
        { hit: { id: 'n1' }, key: 'n1', rank: 1, row: aliceRow, excerpt: { entity: Note, fieldName: 'nope', text: 'forged snippet' } },
      ],
    });
    assert.equal(outcome.hits.length, 1, 'the row admits; only the excerpt is withheld');
    assert.equal('excerpt' in outcome.hits[0], false);
  });
});

// ---- composed: an authorized search response ----------------------------------

describe('search authorization — composed response', () => {
  test('an authorized search produces a stamped, frozen, admitted response', async () => {
    const { adapter } = ownerAdapter();
    const admission = await admitSearchHits(adapter, {
      pluginId: 'notes-fts', generation: 2, staleness: 'stale', principal: alice,
      candidates: [
        { hit: { id: 'n1', title: 'hello' }, key: 'n1', rank: 0.5, row: aliceRow },
        { hit: { id: 'n2', title: 'secret' }, key: 'n2', rank: 0.5, row: bobRow },
      ],
    });
    const response = buildSearchResponse({
      pluginId: 'notes-fts', generation: 2, staleness: 'stale',
      hits: admission.hits, omitted: admission.omitted,
    });
    assert.equal(response.ok, true);
    assert.equal(response.staleness, 'stale', 'a stale index is disclosed, never presented as fresh');
    assert.equal(response.hits.length, 1, 'bob’s row was omitted by per-result admission');
    assert.equal(response.omitted, 1);
    assert.equal(response.hits[0].key, 'n1');
    assert.equal(response.hits[0].generation, 2);
    assert.equal(response.hits[0].hit.title, 'hello');
  });

  test('a denied search never leaks: the pre-scope denial is a response, not a throw', async () => {
    const { adapter, registry } = ownerAdapter();
    const pre = await admitSearchSourceScope(adapter, registry, { pluginId: 'notes-fts', principal: anonymous });
    assert.equal(pre.admitted, false);
    const response = buildSearchResponse({
      pluginId: 'notes-fts', generation: 0, staleness: 'rebuilding', error: 'denied',
    });
    assert.equal(response.ok, false);
    assert.equal(response.error, 'denied');
    assert.deepEqual(response.hits, []);
  });

  test('the composition ties every ok response by (rank, key) — never the plugin’s return order', () => {
    const response = buildSearchResponse({
      pluginId: 'notes-fts', generation: 2, staleness: 'fresh',
      hits: [
        { key: 'z', rank: 1, hit: { id: 'z' } },
        { key: 'a', rank: 1, hit: { id: 'a' } },
        { key: 'm', rank: 0, hit: { id: 'm' } },
      ],
    });
    assert.deepEqual(response.hits.map((hit) => hit.key), ['m', 'a', 'z'], 'equal ranks fall back to the stable key order');
  });

  test('a duplicate tie-break key rejects the whole response fail-closed', () => {
    assert.throws(
      () => buildSearchResponse({
        pluginId: 'notes-fts', generation: 2, staleness: 'fresh',
        hits: [
          { key: 'dup', rank: 1, hit: { id: 'x' } },
          { key: 'dup', rank: 2, hit: { id: 'y' } },
        ],
      }),
      SearchDuplicateKeyError,
    );
    // a non-ok response never assembles hits, so it can never trip the key check
    const closed = buildSearchResponse({ pluginId: 'x', generation: 0, staleness: 'rebuilding', error: 'denied' });
    assert.deepEqual(closed.hits, []);
  });

  test('a duplicate tie-break key is rejected across the FULL sorted list, not just adjacent ranks', () => {
    // After sorting by (rank, key) these hits order as dup@1, other@2, dup@3 —
    // the duplicate copies are at ranks 1 and 3 with a different key between
    // them, so an adjacent-only scan would miss them.
    assert.throws(
      () => buildSearchResponse({
        pluginId: 'notes-fts', generation: 2, staleness: 'fresh',
        hits: [
          { key: 'dup', rank: 1, hit: { id: 'a' } },
          { key: 'other', rank: 2, hit: { id: 'b' } },
          { key: 'dup', rank: 3, hit: { id: 'c' } },
        ],
      }),
      SearchDuplicateKeyError,
      'a key duplicated at non-adjacent ranks must still reject fail-closed',
    );
  });
});
