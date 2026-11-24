// search-response.ts — the S4/A6 search REQUEST/RESPONSE contract.
//
// The plugin contract (S4/A1, search-plugin.ts) defines what a plugin receives
// and returns; this module defines the PLATFORM-facing contract around it:
//
//   1. STALENESS DISCLOSURE — every returned result carries the authoritative
//      `{ pluginId, generation, staleness }` stamp (considerations #13/#8), so a
//      caller can disclose fresh/stale/rebuilding results instead of silently
//      presenting them as current. The stamp maps from the registry's health
//      state (`ready`→fresh, `stale`→stale, `building`→rebuilding,
//      `failed`→stale) and is always registry-derived — a plugin cannot spoof
//      its own health (S4/A1).
//   2. BOUNDED LIMITS — a request's result bound is clamped to a hard cap (max
//      results / page); nothing unbounded ever reaches the plugin (consideration
//      #22). The registry owns the window: a plugin is always invoked from
//      offset 0 for the full span the caller's window needs, and the registry
//      applies that window to the plugin's output exactly once.
//   3. CANCELLATION + TIMEOUT — searchWithDeadline races a plugin's search
//      against the caller's AbortSignal and a hard deadline, returning a closed
//      cancelled/timed-out/completed outcome instead of a thrown state leak.
//      The registry's search composition (search-plugin.ts) runs every plugin
//      search through it, so an uncooperative plugin can never hang a search.
//   4. DETERMINISTIC TIE-BREAKING — equal ranks are ordered by a stable key;
//      the shared comparator is what the A4/A5 plugin implementations import.
//      buildSearchResponse ties EVERY response's hits by (rank, key), and
//      rejects a duplicate key fail-closed (the tie-break is total only over a
//      unique key set).
//   5. FAIL CLOSED — a denied/policy-error/cancelled/timed-out search is a
//      response with ok:false, a closed reason, and ALWAYS an empty hit set,
//      never a 500 leak and never result content from a search that did not
//      complete authorized and in time (S5/A2 mirror).



// The closed staleness vocabulary a response may disclose. `fresh` = the index
// reflects the source up to the current fence; `stale` = a source change
// invalidated the index but reconciliation has not consumed it; `rebuilding` =
// a materialization cycle is in progress (or nothing has materialized yet).


// Map the registry's health state to the disclosed staleness. `failed` maps to
// `stale`, never `fresh` and never `rebuilding`: a failed index is not current
// (stale) but nothing is actively materializing it either (not rebuilding). An
// unknown state — vocabulary this contract does not recognize — also maps to
// `stale` (fail closed: never claim freshness on a state we cannot vouch for).
export function searchStalenessOf(state                   )                  {
  switch (state) {
    case 'ready': return 'fresh';
    case 'building': return 'rebuilding';
    case 'stale':
    case 'failed':
    default: return 'stale';
  }
}

// ---- bounded limits ----------------------------------------------------------

// The hard upper bound on any single search response's result count. A request
// cannot ask past this cap; the plugin never sees an unbounded result bound.
export const SEARCH_MAX_RESULTS_CAP = 1000;
// The hard upper bound on a single page's size.
export const SEARCH_MAX_PAGE_SIZE = 100;
// The default result bound when a request does not state one.
export const SEARCH_DEFAULT_LIMIT = 50;
// The hard upper bound on a caller's whole result window (`offset + limit`).
// A plugin is always invoked from offset 0 with the full span, so this is the
// bound on work a single search may ask a plugin to do — not just on the slice
// finally disclosed. Windows past it are rejected before any plugin runs.
export const SEARCH_MAX_WINDOW = 10_000;
// Alias for callers that name the bound by its role rather than its namespace.
export const MAX_SEARCH_WINDOW = SEARCH_MAX_WINDOW;
// The default page size when a request pages without stating a size.
export const SEARCH_DEFAULT_PAGE_SIZE = 25;
// The default hard deadline for a search run, in milliseconds. The registry's
// search composition applies this when the caller supplies no timeout, so a
// search can never hang the registry regardless of the plugin's cooperation.
export const SEARCH_DEFAULT_TIMEOUT_MS = 5000;

// Clamp a requested result bound into the bounded range [1, cap]. A missing,
// non-finite, zero, or negative request collapses to the fallback — a bound of
// zero or less would mean "return nothing", which is a caller mistake, not a
// search feature, so it is refused rather than honored.
export function boundSearchLimit(
  requested                           ,
  fallback         = SEARCH_DEFAULT_LIMIT,
  cap         = SEARCH_MAX_RESULTS_CAP,
)         {
  const value = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : Math.floor(fallback);
  return Math.max(1, Math.min(value, Math.max(1, Math.floor(cap))));
}














// A requested window exceeded the server-side bound. This is a caller mistake,
// not a search feature: it is rejected before any plugin is invoked, never
// silently clamped to a different result set.
export class SearchWindowValidationError extends RangeError {
           name = 'SearchWindowValidationError';
           offset        ;
           limit        ;
  constructor(offset        , limit        ) {
    super(`search window offset ${offset} + limit ${limit} exceeds the ${SEARCH_MAX_WINDOW} result bound`);
    this.offset = offset;
    this.limit = limit;
  }
}

// Resolve a request's window to `{ offset, limit }`. Paging and flat
// limit/offset are mutually exclusive: a page request wins (the page is the
// bounded unit); otherwise the flat offset/limit apply. Both paths clamp the
// page/limit bounds, then reject any whole window past SEARCH_MAX_WINDOW.
export function searchPageWindow(request                   )                                                      {
  let offset        ;
  let limit        ;
  if (typeof request.page === 'number' && Number.isFinite(request.page) && request.page >= 1) {
    const page = Math.floor(request.page);
    const size = boundSearchLimit(request.pageSize, SEARCH_DEFAULT_PAGE_SIZE, SEARCH_MAX_PAGE_SIZE);
    offset = Math.max(0, (page - 1) * size);
    limit = size;
  } else {
    offset = typeof request.offset === 'number' && Number.isFinite(request.offset) && request.offset > 0
      ? Math.floor(request.offset)
      : 0;
    limit = boundSearchLimit(request.limit);
  }
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || offset + limit > SEARCH_MAX_WINDOW) {
    throw new SearchWindowValidationError(offset, limit);
  }
  return { offset, limit };
}

// ---- deterministic tie-breaking ----------------------------------------------

// A plugin-provided relevance value: a numeric score (bm25 rank, cosine
// similarity) or a rank/score string. Missing and non-finite values sort AFTER
// every present finite value (deterministic, never a NaN comparison).


// The ordering of the primary rank: 'asc' (FTS-style: lower is better) or
// 'desc' (vector-style: higher is better).


// The numeric reading of a rank, or null when it is missing or non-finite. A
// numeric-string rank ('7') compares as the number 7, mirroring SQLite's text
// coercion; a non-numeric string ('ab') is not a score and falls back to the
// lexicographic ordering below.
function numericRank(value         )                {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

// Compare two ranks deterministically. Present finite numeric ranks order by
// value in the requested direction; a missing/non-finite rank sorts after every
// present one in BOTH directions (inverting the order must not drag a missing
// rank above a real score); two missing ranks order by their raw forms
// lexicographically, so a fully unranked set is still deterministic.
export function compareSearchRanks(a            , b            , order              = 'asc')         {
  const av = numericRank(a);
  const bv = numericRank(b);
  if (av !== null && bv !== null) {
    const diff = av === bv ? 0 : av < bv ? -1 : 1;
    return order === 'desc' ? -diff : diff;
  }
  if (av !== null) return -1;
  if (bv !== null) return 1;
  const as = a == null ? '' : String(a);
  const bs = b == null ? '' : String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

// The stable secondary identity a deterministic tie-break falls back to. The
// key must be unique within the plugin's index (a source row id, for example);
// with a unique key, the ordering is a TOTAL order regardless of sort stability.
export function compareSearchKeys(a        , b        )         {
  return a < b ? -1 : a > b ? 1 : 0;
}







// Order hits deterministically: primary rank (in the plugin's direction), then
// the stable key. The input is never mutated. This is the tie-break A4 (FTS
// rank) and A5 (vector similarity) share — same comparator, one direction each.
export function tieBreakSearchHits      (
  hits                 ,
  options                             ,
)         {
  const order = options.order ?? 'asc';
  return [...hits].sort((a, b) => {
    const byRank = compareSearchRanks(options.rankOf(a), options.rankOf(b), order);
    if (byRank !== 0) return byRank;
    return compareSearchKeys(options.keyOf(a), options.keyOf(b));
  });
}

// ---- cancellation + timeout --------------------------------------------------

// The canonical cancelled search error. A plugin whose internal signal aborts
// (or a cooperative cancel path) throws this; the platform maps it to a
// cancelled response rather than an error leak.
export class SearchCancelledError extends Error {
           name = 'SearchCancelledError';
  constructor(message = 'search cancelled') {
    super(message);
  }
}

// The canonical timeout search error, sibling to SearchCancelledError.
export class SearchTimeoutError extends Error {
           name = 'SearchTimeoutError';
  constructor(message = 'search timed out') {
    super(message);
  }
}

// A response assembly refused the result set: two hits shared a tie-break key.
// The deterministic tie-break is a TOTAL order only over a unique key set — a
// duplicate key makes the ordering (and any pagination over it) unstable, so
// the response builder rejects it fail-closed instead of silently returning a
// non-deterministic order.
export class SearchDuplicateKeyError extends Error {
           name = 'SearchDuplicateKeyError';
  constructor(message = 'duplicate search tie-break key in the response') {
    super(message);
  }
}

// The closed outcome of a bounded/cancellable search run. `completed` carries
// the value; `cancelled` means the caller's signal aborted (or was already
// aborted before the run started); `timed-out` means the deadline elapsed. The
// run's own exceptions still throw — only cancellation and timeout are reduced
// to a closed outcome.














// Run a plugin search under the caller's cancellation signal and a hard
// deadline. `run` receives the combined AbortSignal so a cooperative plugin can
// stop work; aborting that signal does NOT throw — the outcome is the closed
// `cancelled`/`timed-out` value. The run is RACED against the deadline and the
// abort signal, so an uncooperative plugin (one that ignores the signal) cannot
// hang a timed-out or cancelled search — the outcome returns at the deadline /
// abort regardless of the plugin's cooperation. Any other exception from `run`
// propagates unchanged (the caller/registry owns failure isolation); a run that
// settles late (after the race already decided) is observed silently.
export async function searchWithDeadline   (
  run                                         ,
  options                        = {},
)                                    {
  // An already-aborted signal cancels BEFORE the run is invoked — a cancelled
  // search never queries the plugin.
  if (options.signal?.aborted) return { kind: 'cancelled' };

  const controller = new AbortController();

  const deadline = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0;
  let timedOut = false;
  let timer                                       = null;
  // The race arms: the run settles to a closed { completed | failed } value
  // (never rejects — a late rejection after the race decided must not surface
  // as an unhandled rejection), the deadline arm resolves when the timer fires,
  // and the abort arm resolves when the caller's signal fires.
  let fireDeadline                      = null;
  let fireOuterAbort                      = null;
  const deadlineArm = new Promise      ((resolve) => { fireDeadline = resolve; });
  const abortArm = new Promise      ((resolve) => { fireOuterAbort = resolve; });
  const onOuterAbortFire = () => {
    controller.abort();
    fireOuterAbort?.();
  };

  const runSettled = Promise.resolve().then(() => run(controller.signal))
    .then((value) => ({ kind: 'completed'         , value }))
    .catch((err         ) => ({ kind: 'failed'         , err }));

  const arms

      = [runSettled];
  if (deadline) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      fireDeadline?.();
    }, options.timeoutMs);
    arms.push(deadlineArm.then(() => ({ kind: 'timed-out'          })));
  }
  if (options.signal !== undefined) {
    options.signal.addEventListener('abort', onOuterAbortFire, { once: true });
    arms.push(abortArm.then(() => ({ kind: 'cancelled'          })));
  }

  try {
    const outcome = await Promise.race(arms);
    if (outcome.kind === 'failed') {
      const { err } = outcome;
      if (timedOut) return { kind: 'timed-out' };
      if (options.signal?.aborted) return { kind: 'cancelled' };
      if (controller.signal.aborted) return { kind: 'timed-out' };
      if (err instanceof SearchCancelledError) return { kind: 'cancelled' };
      if (err instanceof SearchTimeoutError) return { kind: 'timed-out' };
      throw err;
    }
    return outcome;
  } finally {
    if (timer !== null) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbortFire);
  }
}

// ---- the response contract ---------------------------------------------------

// The per-result stamp every search result carries (spec 1): the plugin that
// produced it, the index generation it was produced from, and the disclosed
// staleness. Callers show the stamp so stale/rebuilding results are never
// silently presented as current.






// One returned search result: the platform stamp plus the plugin hit and its
// deterministic ordering identity. `key` is the stable, index-unique tie-break
// identity; `rank` is the plugin's relevance value. `excerpt` is present only
// when the excerpt's source field admitted (S4/A6: no unreadable-field
// excerpts — an admitted row whose excerpt field denies still returns the hit,
// just without the excerpt).







// The closed error vocabulary of a failed response. `denied` = the search (or
// its scope) was denied; `policy-error` = a policy body threw (S5/A2 fail
// closed — never a 500); `not-found` = the plugin/resource does not exist;
// `error` = the plugin search itself failed (isolated, per S4/A1).


// The platform search response. `ok` is true only for a completed, authorized,
// uncancelled, in-time search. `hits` are already admitted (per-result
// authorization ran) and tie-broken; `omitted` discloses how many candidates
// were dropped by authorization (deny → omit), so a caller can tell a bounded
// result from a filtered one.
































// Build a frozen search response, stamping every hit with the response's
// `{ pluginId, generation, staleness }`. `ok` is derived FIRST — a denied,
// cancelled, timed-out, or error response is never `ok` AND always carries an
// EMPTY hit set (fail closed: a response for a search that did not complete
// authorized and in time never surfaces result content). The hits of an ok
// response are deterministically tie-broken by (rank, key) — the platform owns
// the total order, never the plugin's return order — and a duplicate tie-break
// key rejects the whole response (the order is total only over unique keys).
// This is the one place the response shape is assembled, so every search
// surface (HTTP handler, live delivery, library callers) returns an identical
// contract.
export function buildSearchResponse      (input                           )                       {
  const cancelled = input.cancelled ?? false;
  const timedOut = input.timedOut ?? false;
  const error = input.error ?? null;
  const ok = error === null && !cancelled && !timedOut;
  const ordered = tieBreakSearchHits(ok ? (input.hits ?? []) : [], {
    rankOf: (entry) => entry.rank,
    keyOf: (entry) => entry.key,
    order: input.order ?? 'asc',
  });
  // Uniqueness invariant: two hits sharing a tie-break key make the ordering
  // non-deterministic (and pagination unstable) — reject fail-closed rather
  // than silently return a non-total order. The check spans the FULL sorted
  // list (a Set over keys), not just adjacent entries: equal keys at different
  // ranks are never adjacent after sorting, so an adjacent-only scan would
  // admit a duplicate whose copies sit at non-adjacent positions.
  const seenKeys = new Set        ();
  for (const entry of ordered) {
    if (seenKeys.has(entry.key)) {
      throw new SearchDuplicateKeyError(`duplicate search tie-break key '${entry.key}' in the response`);
    }
    seenKeys.add(entry.key);
  }
  const hits = Object.freeze(ordered.map((entry) => Object.freeze({
    pluginId: input.pluginId,
    generation: input.generation,
    staleness: input.staleness,
    key: entry.key,
    rank: entry.rank,
    hit: entry.hit,
    ...(entry.excerpt !== undefined ? { excerpt: entry.excerpt } : {}),
  })));
  return Object.freeze({
    ok,
    pluginId: input.pluginId,
    generation: input.generation,
    staleness: input.staleness,
    hits,
    omitted: input.omitted ?? 0,
    cancelled,
    timedOut,
    error,
  });
}

// ---- hybrid retrieval composer (RRF / weighted fusion) ----------------------

// Standard Reciprocal Rank Fusion smoothing constant k in `weight / (k + rank)`.
export const HYBRID_SEARCH_DEFAULT_RRF_K = 60;





































function defaultHybridKeyOf(hit         )         {
  if (hit !== null && typeof hit === 'object') {
    const record = hit                                   ;
    if (typeof record.key === 'string' && record.key.length > 0) return record.key;
    if (typeof record.id === 'string' && record.id.length > 0) return record.id;
  }
  return '';
}

function worstStaleness(states                            )                  {
  if (states.length === 0) return 'fresh';
  if (states.includes('stale')) return 'stale';
  if (states.includes('rebuilding')) return 'rebuilding';
  return 'fresh';
}

// Fuse multiple authorized ranked hit lists (e.g. FTS5 BM25 + vector cosine)
// via Reciprocal Rank Fusion (`weight / (k + rank)`, 1-based rank) with
// deterministic `(score DESC, key ASC)` tie-breaking. Callers pass already-
// authorized hits so unauthorized rows can never influence RRF ranks.
export function composeHybridSearch                                          (
  sources                                          ,
  options                      = {},
)                           {
  const k = options.k ?? HYBRID_SEARCH_DEFAULT_RRF_K;
  if (typeof k !== 'number' || !Number.isFinite(k) || k <= 0) {
    throw new RangeError(`hybrid search RRF k must be a positive finite number, got ${String(k)}`);
  }










  const byKey = new Map                     ();
  const stalenessStates                    = [];

  for (const source of sources) {
    const weight = source.weight ?? 1;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      throw new RangeError(`hybrid search weight for '${source.pluginId}' must be a non-negative finite number`);
    }
    if (source.staleness !== undefined) stalenessStates.push(source.staleness);
    const keyOf = source.keyOf ?? defaultHybridKeyOf;
    const seenInSource = new Set        ();
    let rank = 0;
    for (const hit of source.hits) {
      const key = keyOf(hit);
      if (key.length === 0 || seenInSource.has(key)) continue;
      seenInSource.add(key);
      rank += 1;
      const contribution = weight / (k + rank);
      const record = hit !== null && typeof hit === 'object' ? (hit                           ) : null;
      const excerpt = typeof record?.excerpt === 'string' ? record.excerpt : undefined;
      const excerptField = typeof record?.excerptField === 'string' ? record.excerptField : undefined;

      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, {
          key,
          score: contribution,
          hit,
          ...(excerpt !== undefined ? { excerpt } : {}),
          ...(excerptField !== undefined ? { excerptField } : {}),
          sources: { [source.pluginId]: Object.freeze({ rank, contribution }) },
        });
      } else {
        existing.score += contribution;
        existing.sources[source.pluginId] = Object.freeze({ rank, contribution });
        if (existing.excerpt === undefined && excerpt !== undefined) existing.excerpt = excerpt;
        if (existing.excerptField === undefined && excerptField !== undefined) existing.excerptField = excerptField;
      }
    }
  }

  const fused = [...byKey.values()].sort((a, b) => {
    if (a.score > b.score) return -1;
    if (a.score < b.score) return 1;
    return compareSearchKeys(a.key, b.key);
  });

  const hasWindow = options.limit !== undefined
    || options.offset !== undefined
    || options.page !== undefined
    || options.pageSize !== undefined;
  const sliced = hasWindow
    ? (() => {
      const { offset, limit } = searchPageWindow(options);
      return fused.slice(offset, offset + limit);
    })()
    : fused;

  const hits = Object.freeze(sliced.map((entry) => Object.freeze({
    key: entry.key,
    score: entry.score,
    hit: entry.hit,
    ...(entry.excerpt !== undefined ? { excerpt: entry.excerpt } : {}),
    ...(entry.excerptField !== undefined ? { excerptField: entry.excerptField } : {}),
    sources: Object.freeze({ ...entry.sources }),
  })));

  return Object.freeze({
    ok: true,
    hits,
    totalCandidates: fused.length,
    staleness: worstStaleness(stalenessStates),
    k,
  });
}
