// The mutation pipeline's type kernel: Action and Event (SPEC §7).
//
// An ACTION is an imperative client request that may be rejected. An EVENT is a
// past-tense fact the server emitted — it already happened. They are distinct
// branded types so neither is mistaken for the other: an action is dispatched
// and authorized; an event is folded into state through its reducer.
//
// The reducer is NON-OPTIONAL on an event (SPEC §7): an event with no reducer is
// a load-time error, because `ingest` is the only place an event becomes client
// state and it has nothing to fold without one — there is no second apply path
// (AGENTS.md, one reconciliation path).
//
// Handler policy and action/event declarations live here so every pipeline-*
// module can share them without importing the barrel.



// ---- Typed handler policy -------------------------------------------------
//
// The kernel attaches these capabilities to a registered handler as ONE typed
// record under a symbol; the pipeline reads them back through one accessor.
// This replaces scattered untyped own-property writes/reads. Legacy own
// properties remain readable so handlers assembled outside the kernel (tests,
// app-level shims) keep behaving exactly as before.

export const HANDLER_POLICY = Symbol('workbench.handlerPolicy');

















const LEGACY_HANDLER_POLICY_KEYS = [
  'inTransaction',
  'ownedResources',
  'ownedResourcePlans',
  'batchForbidden',
  'erasureCapable',
  'erasurePrepare',
  'erasurePreparationTables',
  'erasurePreparationReadTables',
  'protectedArtefactTables',
  'privateFactProjection',
  'compoundContributionPolicy',
  'dedupeReceiptMatches',
  'atomicOperation',
]                                                    ;

export function readHandlerPolicy(handler     )                {
  if (!handler) return {};
  const attached = handler[HANDLER_POLICY];
  if (attached) return attached                 ;
  const legacy                          = {};
  for (const key of LEGACY_HANDLER_POLICY_KEYS) {
    if (handler[key] !== undefined) legacy[key] = handler[key];
  }
  return legacy                 ;
}

/**
 * Optional domain-kind commit hook wired by the kernel seam (e.g., composed
 * annotated-text registered actions) so `pipeline.ts` stays free of field-kind
 * specific commit/compensation logic.
 */


















// `action(type)` — declare an imperative request type. The handler that turns it
// into events is attached later by the entity/dispatch wiring.
export function action(type        ) {
  return Object.freeze({ brand: 'action', type });
}

// `event(type, reduce)` — declare a past-tense fact and the reducer that folds
// it into state. The reducer is required; omitting it fails closed at load.
export function event(type                                                  , reduce                                               ) {
  const handle = type && typeof type === 'object' && type.brand === 'event-handle' ? type : undefined;
  const eventType = handle ? handle.type : (type          );
  if (typeof reduce !== 'function') {
    throw new Error(
      `event('${eventType}') has no reducer. An event with no reducer is a ` +
        `load-time error (SPEC §7): ingest is the only place an event becomes ` +
        `state, and it folds the event through this reducer. Declare one: ` +
        `event('${eventType}', (state, payload) => next).`,
    );
  }
  return Object.freeze({ brand: 'event', handle, type: eventType, reduce });
}
