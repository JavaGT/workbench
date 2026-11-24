

import { MAP_SIDE_TABLE_STRATEGY } from './map.mjs';
import { ORDERED_SIDE_TABLE_STRATEGY } from './ordered.mjs';
import { LOG_SIDE_TABLE_STRATEGY } from './log.mjs';
import { EPHEMERAL_SIDE_TABLE_STRATEGY } from './ephemeral.mjs';
import { FTS_STRATEGY } from '../fts-strategy.mjs';

// Shared strategy helpers. Re-exported here so consumers that import from the
// strategy barrel (annotated-text-admit, auth/invitation via side-table-strategy)
// keep working; the per-strategy modules import them from ./shared.mjs directly.
export {
  authorizeFieldOp,
  mapMutationAction,
} from './shared.mjs';

// ---------------------------------------------------------------------------
// Shared strategy types
// ---------------------------------------------------------------------------

// The declared shape of a field. Each side-table strategy reads only the
// sub-shape it owns (kind/type/entry/of/roles); the index signature keeps
// unknown declared keys from closing the type to specific stores.










// [string, FieldDescriptor] pairs — the fieldEntries shape every strategy
// receives for its matched fields.


// The minimal principal handle a strategy reads: just the requesting identity.





// A hydrated target entity: the map strategy's toArray resolves a ref's target
// through entityOf and hydrates each member row with the requesting principal.





// A committed field event as seen by a projection consumer. Strategies read
// only data; identity is concentrated in the event handle.







// The dispatch result side-table handles read emitted events from.






// The dispatch function a handle must forward its field mutation to.










// The input a strategy's handle factory receives from the entity hydrator.












// The event/handle subset a strategy projection reader needs. `handle` is the
// full event handle — narrowing it by kind (as the projections do) exposes the
// field/nativeName variants — and `event` carries only the committed data.




// The input a strategy's projectionApply receives.








// The input a strategy's generated mutate handler receives.




// The one shape every side-table strategy implements. Matches decides whether a
// declared field belongs to the strategy; the rest derives DDL, event types,
// dispatch-level handlers, and the row projection from declared field entries.












// ---------------------------------------------------------------------------
// Strategy collection
// ---------------------------------------------------------------------------

// Resolved on demand, NOT at module evaluation. `scope-sql` loads
// `annotated-text-field`, which registers a field-kind contribution through this
// barrel while a direct `strategy/map` import is still evaluating its own
// strategy constant. A module-level `const` here would read that strategy in its
// temporal dead zone (ReferenceError); the function body only runs once callers
// actually collect strategies, by which time every strategy has initialized.
function sideTableStrategies()                               {
  return [
    FTS_STRATEGY,
    MAP_SIDE_TABLE_STRATEGY,
    ORDERED_SIDE_TABLE_STRATEGY,
    LOG_SIDE_TABLE_STRATEGY,
    EPHEMERAL_SIDE_TABLE_STRATEGY,
  ];
}






export function collectSideTableStrategies(fields                                 )                           {
  return sideTableStrategies()
    .map((strategy) => ({
      strategy,
      fields: Object.entries(fields).filter(([, descriptor]) => strategy.matches(descriptor)),
    }))
    .filter((entry) => entry.fields.length > 0);
}

export function sideTableDDL(entity                  , fieldName        , descriptor                 )                {
  const strategy = sideTableStrategies().find((candidate) => candidate.matches(descriptor));
  return strategy ? strategy.ddl(entity.name, fieldName, descriptor) : null;
}

// ---------------------------------------------------------------------------
// Field-kind contributions
// ---------------------------------------------------------------------------
//
// A side-table strategy derives runtime *storage* from a declared field shape.
// A field-kind contribution is the sibling seam for the *core loops*: it lets a
// kind that needs behavior inside the generic entity compiler, CRUD generator,
// projections, and live fan-out contribute named hooks instead of those modules
// hard-coding `descriptor.kind === '<kind>'` branches. This is a registry of
// real functions (authorization is always functions; identity lives with the
// kind that owns it) — NOT a config DSL that relocates behavior into data.
//
// Every hook is optional: a module queries the kind's contribution and falls
// through to its generic path when the kind contributes nothing for that seam.



































































// The registry is owned by this module; kind modules contribute themselves when
// they load (strategy/index must not import a kind). Registration is a module-load
// concern, never a per-request one.
//
// `scope-sql` (a transitive strategy dependency) loads `annotated-text-field`, so
// a kind can register while this module's dependencies are still evaluating. The
// hoisted function/`var` bindings keep that cycle safe — a `const` Map would still
// be in its temporal dead zone at registration time. FIELD_KIND_CONTRIBUTIONS is
// a frozen snapshot refreshed on registration, so readers always see a frozen
// array while the registry itself stays extensible.
var fieldKindRegistryState                                                ;

function fieldKindRegistry()                                     {
  if (fieldKindRegistryState === undefined) fieldKindRegistryState = new Map();
  return fieldKindRegistryState;
}

function fieldKindSnapshot()                                   {
  return Object.freeze([...fieldKindRegistry().values()]);
}

export var FIELD_KIND_CONTRIBUTIONS                                   = fieldKindSnapshot();

export function registerFieldKindContribution(contribution                       )       {
  if (!contribution || typeof contribution !== 'object'
    || typeof contribution.kind !== 'string' || contribution.kind.length === 0) {
    throw new TypeError('field-kind contribution requires a non-empty kind');
  }
  const registry = fieldKindRegistry();
  const existing = registry.get(contribution.kind);
  if (existing === contribution) return;
  if (existing !== undefined) {
    throw new Error(`field-kind contribution '${contribution.kind}' is already registered`);
  }
  registry.set(contribution.kind, contribution);
  FIELD_KIND_CONTRIBUTIONS = fieldKindSnapshot();
}

export function fieldKindContribution(kind         )                                    {
  return typeof kind === 'string' ? fieldKindRegistry().get(kind) : undefined;
}

/** The delivery reason declared by the kind owning any field of `fields`, if any. */
export function fieldKindSnapshotControlReason(
  fields                                                  ,
)                {
  for (const descriptor of Object.values(fields ?? {})) {
    const reason = fieldKindContribution(descriptor?.kind)?.snapshotControlReason;
    if (typeof reason === 'string' && reason.length > 0) return reason;
  }
  return null;
}

/** True when any declared field of `fields` is owned by a kind contributing `feature`. */
export function hasFieldKindFeature(
  fields                                                  ,
  feature                             ,
)          {
  return Object.values(fields ?? {}).some((descriptor) => Boolean(fieldKindContribution(descriptor?.kind)?.[feature]));
}

export function validateFieldKindEntities(entity        , fields                                           )       {
  for (const contribution of fieldKindRegistry().values()) contribution.validateEntityFields?.(entity, fields);
}

export function resolveFieldKindEventScope(entity                 , payload              )                {
  for (const contribution of fieldKindRegistry().values()) {
    if (typeof contribution.resolveEntityEventScope !== 'function') continue;
    const field = Object.values(entity.fields ?? {}).find((descriptor) => descriptor?.kind === contribution.kind);
    if (!field) continue;
    const scope = contribution.resolveEntityEventScope(entity, field, payload);
    if (typeof scope === 'string' && scope.length > 0) return scope;
  }
  return null;
}

export function markFieldKindProjections(projection        , fields                                           )       {
  for (const contribution of fieldKindRegistry().values()) contribution.markEntityProjection?.(projection, fields);
}

export function isFieldKindOperationEvent(
  fields                                                  ,
  context                           ,
)          {
  const field = fields?.[context.handle.field ?? ''];
  const contribution = fieldKindContribution(field?.kind);
  return contribution?.isOperationEvent?.(context) === true;
}

export function suppressesFieldKindDelta(context                       )          {
  return [...fieldKindRegistry().values()].some((contribution) => contribution.suppressesDelta?.(context) === true);
}

// ---------------------------------------------------------------------------
// Strategy constants
// ---------------------------------------------------------------------------

export { MAP_SIDE_TABLE_STRATEGY, ORDERED_SIDE_TABLE_STRATEGY, LOG_SIDE_TABLE_STRATEGY, EPHEMERAL_SIDE_TABLE_STRATEGY, FTS_STRATEGY };
