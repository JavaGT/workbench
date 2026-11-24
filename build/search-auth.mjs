// search-auth.ts — the S4/A6 search AUTHORIZATION seam.
//
// Authorization for search runs at TWO boundaries (considerations #14/#15),
// both through the S5/A2 authorization adapter — never a second authority:
//
//   1. BEFORE SOURCE-SCOPE SELECTION — the principal must pass the search
//      scope gate before any plugin query runs. The adapter's RESOURCE
//      admission is row-conditional (a named resource without a candidate row
//      denies 'no-row-scope' — a row-less scope admit cannot be expressed), so
//      the pre-scope gate is deliberately COARSE and still adapter-backed: the
//      plugin's searchable scope must be registered on the adapter (the seam
//      tracks what it registered — the adapter exposes no registration query),
//      and the principal must pass the route gate (requireUser by default: a
//      revoked/non-active principal collapses to anonymous and denies at the
//      boundary — no status oracle). A pre-scope denial fails fast: no plugin
//      query runs, and nothing is 500-leaked.
//
//   2. BEFORE RETURNING EACH PROTECTED RESULT/EXCERPT — every candidate row is
//      admitted through the adapter's registered search scope (the row's
//      visibility is re-verified against the CURRENT registered scope under the
//      COLLAPSED principal). Deny → omit. Index-time authorization is NEVER
//      assumed current: a result whose access changed after indexing (ownership
//      transferred, principal revoked) re-admits against the current row and
//      principal, so the index cannot serve stale authorization (spec 2).
//
// The registered scope is the principal-aware SEARCHABLE SOURCE SCOPE — the
// same shape as a plugin's declared source interest, but written against the
// source entity's fields (is.owner()/is.collaborator()/field predicates). It
// compiles to constrained SQL at registration (a non-compilable scope refuses
// the whole declaration, mirroring S5/A2), and per-result admission
// re-verifies each row against that compiled scope. Field-level excerpt
// admission runs through the entity field `.can` seam (S5/A3) so an excerpt is
// never carved from a field the principal cannot read.

import { read,                 } from './grant.mjs';


import { requireUser,           } from './route-gate.mjs';








// A closed admission outcome: admitted plus the adapter's closed reason code
// (null on admit). A denied admission carries a generic code, never row content
// and never which non-active status applied — the S5/A2 surface unchanged.





// The registration input for a plugin's searchable source scope. `pluginId`
// names the resource; `scope` is the principal-aware scope predicate over the
// source entity; `fields`/`checks` supply the compile registry the scope may
// use (the source entity's field descriptors).







                                           











// The seam's own ledger of registered search resources. The adapter does not
// expose a registration query, so the seam tracks what IT registered — a
// search whose plugin was never registered here is refused ('no-resource')
// without ever calling the adapter. The registry is BOUND to the adapter
// instance it was created against: registration and every admission run
// through that adapter and only that adapter — a registry created against
// adapter A can never admit through adapter B (identity check, fail closed),
// because a resource registered on one adapter is never presumed present on
// another.










export function createSearchSourceRegistry(adapter                      )                       {
  if (
    adapter === null || typeof adapter !== 'object' ||
    typeof adapter.admit !== 'function' || typeof adapter.registerResource !== 'function'
  ) {
    throw new Error('createSearchSourceRegistry requires an authorization adapter (admit + registerResource)');
  }
  const registered = new Set        ();
  function register(input                            )       {
    if (input === null || typeof input !== 'object') {
      throw new Error('search resource registration requires an object');
    }
    if (typeof input.pluginId !== 'string' || input.pluginId.length === 0 || input.pluginId.includes('\0')) {
      throw new Error('search resource registration requires a non-empty pluginId without NUL bytes');
    }
    // Registration-time compile (S5/A2 mirror): a non-compilable scope — or a
    // missing scope (would load every row and filter in JS) — refuses here,
    // never at query time. The adapter throws for both; nothing is recorded.
    adapter.registerResource({
      category: 'search',
      name: input.pluginId,
      scope: input.scope,
      fields: input.fields,
      checks: input.checks,
      db: input.db,
      table: input.table,
      entity: input.entity,
      entityName: input.entityName,
      registry: input.registry,
      allowRowScopeFallback: input.allowRowScopeFallback,
    });
    registered.add(input.pluginId);
  }
  return Object.freeze({
    get size() {
      return registered.size;
    },
    get adapter() {
      return adapter;
    },
    register,
    has: (pluginId        ) => registered.has(pluginId),
    ids: () => Object.freeze([...registered]),
  });
}

// PRE-SCOPE admission (spec 2, first half): may this principal search this
// plugin's resources AT ALL, before any source scope is selected and before
// any plugin query runs? A plugin whose searchable scope was never registered
// denies 'no-resource'; the principal route gate runs through the adapter —
// default requireUser(), so anonymous and collapsed non-active principals deny
// with 'anonymous' (indistinguishable, per S5/A1; a caller serving public
// search passes allowAnonymous() and the registered scope still constrains
// every returned row). A throwing adapter/policy denies 'policy-error', never
// a 500 leak (S5/A2 fail closed). Admitted here is NOT authorization to read
// any particular result — the per-result admission below is the content
// boundary.
export async function admitSearchSourceScope(
  adapter                      ,
  registry                      ,
  input



   ,
)                           {
  // The registry is bound to the adapter it was created against: a DIFFERENT
  // adapter instance is refused even when it appears to carry the same
  // resource (identity check, fail closed — a resource registered on one
  // adapter is never presumed present on another).
  if (adapter !== registry.adapter) {
    return { admitted: false, reasonCode: 'no-resource' };
  }
  if (!registry.has(input.pluginId)) {
    return { admitted: false, reasonCode: 'no-resource' };
  }
  let decision;
  try {
    decision = await adapter.admit({
      category: 'principal',
      operation: 'search',
      principal: input.principal,
      resourceId: input.pluginId,
      gate: input.gate ?? requireUser(),
    });
  } catch {
    // The adapter already fails closed on a policy exception, but the boundary
    // must never leak an unexpected throw as a 500 either.
    return { admitted: false, reasonCode: 'policy-error' };
  }
  return { admitted: decision.admitted, reasonCode: decision.reasonCode };
}

// PER-RESULT admission (spec 2, second half): admit ONE candidate result row
// against the plugin's REGISTERED searchable scope. The row must be in STORED
// cell form (the shape SQL returns — the adapter's rowMatchesScope compares
// serialized literals against stored cells). Admission re-verifies the CURRENT
// row under the CURRENT collapsed principal every call: index-time
// authorization is never assumed current, so a result whose access was revoked
// after indexing (ownership changed in the source, principal status changed)
// denies and is omitted. Deny → omit is the caller's loop (admitSearchHits
// implements it); this primitive decides ONE candidate.
export async function admitSearchResult(
  adapter                      ,
  input                                                                                                     ,
)                           {
  let decision;
  try {
    decision = await adapter.admit({
      category: 'search',
      operation: 'search',
      principal: input.principal,
      resourceName: input.pluginId,
      row: input.row,
    });
  } catch {
    return { admitted: false, reasonCode: 'policy-error' };
  }
  return { admitted: decision.admitted, reasonCode: decision.reasonCode };
}

// PER-EXCERPT admission: may this principal read the FIELD an excerpt is carved
// from? Runs through the entity field `.can` seam (S5/A3) — the resource
// admission has no field surface, so the source entity's field admission is the
// one seam that knows field-level readability. A denied field means the excerpt
// is omitted (the admitted hit may still be returned without it): never an
// unreadable-field excerpt.
export async function admitSearchExcerpt(
  adapter                      ,
  input





   ,
)                           {
  // Fail closed on a field the source entity does not DECLARE: an unknown or
  // mismatched fieldName would otherwise route to the row grant's strong-
  // inherit default and could admit an excerpt for a field that does not exist
  // on the entity. Only a declared field may yield an excerpt.
  const declared = input.entity.fields;
  if (declared === undefined || !Object.hasOwn(declared, input.fieldName)) {
    return { admitted: false, reasonCode: 'no-field-access' };
  }
  let decision;
  try {
    decision = await adapter.admit({
      category: 'entity',
      verb: 'read',
      principal: input.principal,
      entity: input.entity,
      row: input.row,
      fieldName: input.fieldName,
      capability: input.capability ?? read,
    });
  } catch {
    return { admitted: false, reasonCode: 'policy-error' };
  }
  return { admitted: decision.admitted, reasonCode: decision.reasonCode };
}

// One candidate returned by a plugin's search, ready for admission. `hit` is
// the plugin's index row; `row` is the CURRENT source row (stored cell form) —
// null when the source row no longer exists (deleted/erased since indexing),
// in which case the candidate is omitted without consulting the adapter (a
// missing row can never be shown). `excerpt` names the field the snippet was
// carved from; the excerpt text is returned only when that field admits.














                                                          




// Admit EVERY candidate and keep only what admits (spec 2, second half). A
// candidate whose current source row is missing is omitted outright. A row that
// denies the registered scope is omitted. A candidate whose excerpt field
// denies keeps the hit but loses the excerpt. The returned hits carry the
// response stamp the caller supplies (S4/A6: generation + staleness on every
// result). Denial never throws — a policy exception is a denial ('policy-error'
// on that candidate), mirroring S5/A2 fail-closed.
export async function admitSearchHits      (
  adapter                      ,
  input





   ,
)                                    {
  const hits                          = [];
  let omitted = 0;
  for (const candidate of input.candidates) {
    if (candidate.row === null || candidate.row === undefined) {
      omitted += 1;
      continue;
    }
    const result = await admitSearchResult(adapter, {
      pluginId: input.pluginId,
      principal: input.principal,
      row: candidate.row,
    });
    if (!result.admitted) {
      omitted += 1;
      continue;
    }
    let excerpt                    ;
    if (candidate.excerpt !== undefined) {
      const field = await admitSearchExcerpt(adapter, {
        entity: candidate.excerpt.entity,
        row: candidate.row,
        fieldName: candidate.excerpt.fieldName,
        principal: input.principal,
      });
      excerpt = field.admitted ? candidate.excerpt.text : undefined;
    }
    hits.push(Object.freeze({
      pluginId: input.pluginId,
      generation: input.generation,
      staleness: input.staleness,
      key: candidate.key,
      rank: candidate.rank,
      hit: candidate.hit,
      ...(excerpt !== undefined ? { excerpt } : {}),
    }));
  }
  return { hits: Object.freeze(hits), omitted };
}
