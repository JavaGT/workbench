import type { EventIdentityHandle } from '../event-handle.ts';
import type { DbHandle } from '../driver.ts';
import { MAP_SIDE_TABLE_STRATEGY } from './map.ts';
import { ORDERED_SIDE_TABLE_STRATEGY } from './ordered.ts';
import { LOG_SIDE_TABLE_STRATEGY } from './log.ts';
import { EPHEMERAL_SIDE_TABLE_STRATEGY } from './ephemeral.ts';
import { FTS_STRATEGY } from '../fts-strategy.ts';

// Shared strategy helpers. Re-exported here so consumers that import from the
// strategy barrel (annotated-text-admit, auth/invitation via side-table-strategy)
// keep working; the per-strategy modules import them from ./shared.mjs directly.
export {
  authorizeFieldOp,
  mapMutationAction,
} from './shared.ts';

// ---------------------------------------------------------------------------
// Shared strategy types
// ---------------------------------------------------------------------------

// The declared shape of a field. Each side-table strategy reads only the
// sub-shape it owns (kind/type/entry/of/roles); the index signature keeps
// unknown declared keys from closing the type to specific stores.
export interface FieldDescriptor {
  kind: string;
  type?: string;
  indexed?: string;
  roles?: readonly string[];
  entry?: Readonly<Record<string, FieldDescriptor>>;
  of?: Readonly<{ kind?: string; type?: string; target?: unknown }>;
  [key: string]: unknown;
}

// [string, FieldDescriptor] pairs — the fieldEntries shape every strategy
// receives for its matched fields.
export type FieldEntries = [string, FieldDescriptor][];

// The minimal principal handle a strategy reads: just the requesting identity.
export interface StrategyPrincipal {
  id?: unknown;
  [key: string]: unknown;
}

// A hydrated target entity: the map strategy's toArray resolves a ref's target
// through entityOf and hydrates each member row with the requesting principal.
export interface EntityHandle {
  name: string;
  hydrate(row: Record<string, unknown>, principal?: unknown): unknown;
}

// A committed field event as seen by a projection consumer. Strategies read
// only data; identity is concentrated in the event handle.
export interface FieldEvent {
  type: string;
  scope?: string;
  seq?: number;
  data?: Record<string, unknown> | null;
}

// The dispatch result side-table handles read emitted events from.
export interface DispatchResult {
  ok: boolean;
  failure?: unknown;
  events?: readonly FieldEvent[];
}

// The dispatch function a handle must forward its field mutation to.
export interface Dispatch {
  (input: {
    actionId: string;
    type: string;
    payload: unknown;
    principal?: unknown;
    scope?: string;
  }): Promise<DispatchResult>;
}

// The input a strategy's handle factory receives from the entity hydrator.
export interface SideTableHandleInput {
  record: unknown;
  entityName: string;
  fieldName: string;
  descriptor: FieldDescriptor;
  row: Readonly<Record<string, unknown>>;
  principal: StrategyPrincipal | null | undefined;
  dispatch: Dispatch;
  db: DbHandle;
  entityOf: (value: unknown) => EntityHandle | null | undefined;
}

// The event/handle subset a strategy projection reader needs. `handle` is the
// full event handle — narrowing it by kind (as the projections do) exposes the
// field/nativeName variants — and `event` carries only the committed data.
export interface ProjectionEvent {
  data?: Record<string, unknown>;
}

// The input a strategy's projectionApply receives.
export interface SideTableProjectionInput {
  entityName: string;
  fieldEntries: FieldEntries;
  handle: EventIdentityHandle;
  event: ProjectionEvent;
  db: DbHandle;
}

// The input a strategy's generated mutate handler receives.
export type MutateHandlerInput = {
  payload: Record<string, unknown> | null | undefined;
};

// The one shape every side-table strategy implements. Matches decides whether a
// declared field belongs to the strategy; the rest derives DDL, event types,
// dispatch-level handlers, and the row projection from declared field entries.
export interface SideTableStrategy {
  matches(descriptor: FieldDescriptor): boolean;
  handle?(input: SideTableHandleInput): unknown;
  eventTypes(entityName: string, fieldEntries: FieldEntries): string[];
  mutateHandlers(
    entityName: string,
    fieldEntries: FieldEntries,
  ): Record<string, (input: MutateHandlerInput) => unknown>;
  projectionApply(input: SideTableProjectionInput): boolean;
  ddl(entityName: string, fieldName: string, descriptor: FieldDescriptor): string | null;
}

// ---------------------------------------------------------------------------
// Strategy collection
// ---------------------------------------------------------------------------

// Resolved on demand, NOT at module evaluation. `scope-sql` loads
// `annotated-text-field`, which registers a field-kind contribution through this
// barrel while a direct `strategy/map` import is still evaluating its own
// strategy constant. A module-level `const` here would read that strategy in its
// temporal dead zone (ReferenceError); the function body only runs once callers
// actually collect strategies, by which time every strategy has initialized.
function sideTableStrategies(): readonly SideTableStrategy[] {
  return [
    FTS_STRATEGY,
    MAP_SIDE_TABLE_STRATEGY,
    ORDERED_SIDE_TABLE_STRATEGY,
    LOG_SIDE_TABLE_STRATEGY,
    EPHEMERAL_SIDE_TABLE_STRATEGY,
  ];
}

export interface SideTableStrategyEntry {
  strategy: SideTableStrategy;
  fields: FieldEntries;
}

export function collectSideTableStrategies(fields: Record<string, FieldDescriptor>): SideTableStrategyEntry[] {
  return sideTableStrategies()
    .map((strategy) => ({
      strategy,
      fields: Object.entries(fields).filter(([, descriptor]) => strategy.matches(descriptor)),
    }))
    .filter((entry) => entry.fields.length > 0);
}

export function sideTableDDL(entity: { name: string }, fieldName: string, descriptor: FieldDescriptor): string | null {
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

export type FieldKindRow = Record<string, unknown>;

export interface FieldKindEntity {
  readonly name: string;
  readonly fields: Readonly<Record<string, FieldDescriptor>>;
}

export interface FieldKindEventHandle {
  entity?: string;
  field?: string;
  kind?: string;
  nativeName?: string;
}

export interface FieldKindOperationContext {
  readonly handle: FieldKindEventHandle;
  readonly eventScope?: string;
  readonly directScope?: string;
}

export interface FieldKindDeltaContext {
  readonly scopeAnchored: boolean;
  readonly isOperationEvent: boolean;
  readonly ephemeralField: string | null;
  readonly entityHasContributedKind: boolean;
}

export interface FieldKindSnapshotEntity extends FieldKindEntity {
  deserializeRow(row: FieldKindRow): FieldKindRow;
}

export interface FieldKindSnapshotContext {
  readonly db: unknown;
  readonly entity: FieldKindSnapshotEntity;
  readonly row: FieldKindRow;
  readonly principal: unknown;
  readonly fieldName: string;
  readonly descriptor: FieldDescriptor;
  readonly authoring?: unknown;
}

export interface FieldKindContribution {
  /** The declared field kind this contribution owns. */
  readonly kind: string;
  /** Compile-time validation of every field of this kind in one entity. */
  validateEntityFields?(entity: string, fields: Readonly<Record<string, FieldDescriptor>>): void;
  /** This kind is not replayable through conditional create history. */
  readonly blocksConditionalCreateHistory?: boolean;
  /** Owning scope for an entity's lifecycle event, or null to use the default. */
  resolveEntityEventScope?(entity: FieldKindEntity, field: FieldDescriptor, payload: FieldKindRow): string | null;
  /** Why a plain update payload may not set a field of this kind, or null when allowed. */
  rejectsPlainUpdate?(field: FieldDescriptor): string | null;
  /** Redacted value for an unreadable recipient row field of this kind. */
  projectRowField?(field: FieldDescriptor, fieldName: string, row: FieldKindRow, principal: unknown): unknown;
  /** Mark a compiled entity projection as participating in this kind. */
  markEntityProjection?(projection: object, fields: Readonly<Record<string, FieldDescriptor>>): void;
  /** Project a readable field into a recipient snapshot. Returns its value. */
  snapshotField?(context: FieldKindSnapshotContext): Promise<unknown> | unknown;
  /** Whether an event is this kind's native operation event. */
  isOperationEvent?(context: FieldKindOperationContext): boolean;
  /** Whether this kind requires the delta projection to be skipped. */
  suppressesDelta?(context: FieldKindDeltaContext): boolean;
  /** Delivery reason a generic layer emits when this kind needs a fresh snapshot. */
  readonly snapshotControlReason?: string;
}

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
var fieldKindRegistryState: Map<string, FieldKindContribution> | undefined;

function fieldKindRegistry(): Map<string, FieldKindContribution> {
  if (fieldKindRegistryState === undefined) fieldKindRegistryState = new Map();
  return fieldKindRegistryState;
}

function fieldKindSnapshot(): readonly FieldKindContribution[] {
  return Object.freeze([...fieldKindRegistry().values()]);
}

export var FIELD_KIND_CONTRIBUTIONS: readonly FieldKindContribution[] = fieldKindSnapshot();

export function registerFieldKindContribution(contribution: FieldKindContribution): void {
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

export function fieldKindContribution(kind: unknown): FieldKindContribution | undefined {
  return typeof kind === 'string' ? fieldKindRegistry().get(kind) : undefined;
}

/** The delivery reason declared by the kind owning any field of `fields`, if any. */
export function fieldKindSnapshotControlReason(
  fields: Readonly<Record<string, any>> | null | undefined,
): string | null {
  for (const descriptor of Object.values(fields ?? {})) {
    const reason = fieldKindContribution(descriptor?.kind)?.snapshotControlReason;
    if (typeof reason === 'string' && reason.length > 0) return reason;
  }
  return null;
}

/** True when any declared field of `fields` is owned by a kind contributing `feature`. */
export function hasFieldKindFeature(
  fields: Readonly<Record<string, any>> | null | undefined,
  feature: keyof FieldKindContribution,
): boolean {
  return Object.values(fields ?? {}).some((descriptor) => Boolean(fieldKindContribution(descriptor?.kind)?.[feature]));
}

export function validateFieldKindEntities(entity: string, fields: Readonly<Record<string, FieldDescriptor>>): void {
  for (const contribution of fieldKindRegistry().values()) contribution.validateEntityFields?.(entity, fields);
}

export function resolveFieldKindEventScope(entity: FieldKindEntity, payload: FieldKindRow): string | null {
  for (const contribution of fieldKindRegistry().values()) {
    if (typeof contribution.resolveEntityEventScope !== 'function') continue;
    const field = Object.values(entity.fields ?? {}).find((descriptor) => descriptor?.kind === contribution.kind);
    if (!field) continue;
    const scope = contribution.resolveEntityEventScope(entity, field, payload);
    if (typeof scope === 'string' && scope.length > 0) return scope;
  }
  return null;
}

export function markFieldKindProjections(projection: object, fields: Readonly<Record<string, FieldDescriptor>>): void {
  for (const contribution of fieldKindRegistry().values()) contribution.markEntityProjection?.(projection, fields);
}

export function isFieldKindOperationEvent(
  fields: Readonly<Record<string, any>> | null | undefined,
  context: FieldKindOperationContext,
): boolean {
  const field = fields?.[context.handle.field ?? ''];
  const contribution = fieldKindContribution(field?.kind);
  return contribution?.isOperationEvent?.(context) === true;
}

export function suppressesFieldKindDelta(context: FieldKindDeltaContext): boolean {
  return [...fieldKindRegistry().values()].some((contribution) => contribution.suppressesDelta?.(context) === true);
}

// ---------------------------------------------------------------------------
// Strategy constants
// ---------------------------------------------------------------------------

export { MAP_SIDE_TABLE_STRATEGY, ORDERED_SIDE_TABLE_STRATEGY, LOG_SIDE_TABLE_STRATEGY, EPHEMERAL_SIDE_TABLE_STRATEGY, FTS_STRATEGY };
