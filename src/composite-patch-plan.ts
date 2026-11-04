// Declaration-derived patch plans (#122 design §5).
//
// One compiled view drives BOTH snapshot capture and composite patch
// projection. The plan is derived from the already-compiled SnapshotDeclaration
// (never a second traversal with partially duplicated meaning): each relation
// branch gains a stable identity, its output path, parent linkage, selected
// fields, ordering, requirement, and the declaration's tombstone rule. The
// composite change journal routes from this plan, and the recipient patch
// projector compiles its operations against it — so a field the plan does not
// select can never leak into a patch, and a branch the snapshot cannot express
// is a branch patches can never name.

import type { SnapshotDeclaration } from './snapshot-projection.ts';

// A compiled relation branch, flattened depth-first. Paths are OUTPUT paths
// (declaration keys), not storage columns: ["codes", "entries"] means the
// `entries` relation nested inside the `codes` relation of the anchor output.
export interface PatchPlanRelation {
  /** Stable branch identity: the dot-joined relation keys, rooted at 'anchor'. */
  readonly branchId: string;
  /** Output-path segments (declaration keys only; row ids are appended by consumers). */
  readonly path: readonly string[];
  /** Entity that HOLDS this relation key (the parent row in the projected shape). */
  readonly parentEntity: string;
  /** branchId of the parent branch ('anchor' at the root). */
  readonly parentBranchId: string;
  readonly entity: string;
  readonly kind: 'one' | 'many' | 'keyed' | 'count';
  /** Foreign-key column; interpretation depends on `inverse`. */
  readonly fk: string;
  /** true: the CHILD row holds `fk` pointing at its parent row's id. */
  readonly inverse: boolean;
  /** Child selected fields when the relation declares select(...) (flat child rows). */
  readonly selected: readonly string[];
  /** Child's own select(...) when the relation declares include(...) (nested branch). */
  readonly nestedSelect: readonly string[];
  readonly order: { readonly field: string; readonly direction: string } | null;
  readonly require: { readonly entity: string; readonly childRef: string; readonly fk: string } | null;
  readonly children: readonly PatchPlanRelation[];
}

export interface PatchPlanTombstone {
  readonly entity: string;
  readonly entityId: string;
  readonly scopeId: string | null;
  readonly targetScopeId: string | null;
  readonly kind: string;
  readonly state: string;
  readonly kindValue: string;
  readonly hidden: readonly string[];
}

export interface AnchorPatchPlan {
  /** Anchor (declaration) entity name; composite scopes are `${name}:${id}`. */
  readonly declaration: string;
  readonly anchorSelect: readonly string[];
  /** Flattened depth-first relation branches. */
  readonly relations: readonly PatchPlanRelation[];
  readonly tombstone: PatchPlanTombstone | null;
  /** Declaration-version hash bound into projection tokens (#122 design §8). */
  readonly version: string;
}

interface PlanEntryLike {
  key?: string;
  kind?: string;
  entity?: { name?: string } | null;
  fk?: string;
  inverse?: boolean;
  selected?: readonly string[] | null;
  fields?: readonly string[];
  order?: { field?: string; direction?: string } | null;
  require?: { entity?: { name?: string }; childRef?: string; fk?: string } | null;
  nested?: PlanBranchLike | null;
}

interface PlanBranchLike {
  entity?: { name?: string };
  entries?: readonly PlanEntryLike[];
}

function relationFrom(entry: PlanEntryLike, parentEntity: string, parentBranchId: string, path: readonly string[], branchId: string): PatchPlanRelation {
  const nestedEntries = entry.nested?.entries ?? [];
  const nestedSelectEntry = nestedEntries.find((candidate) => candidate.kind === 'select');
  const children: PatchPlanRelation[] = [];
  if (entry.nested) {
    for (const nestedEntry of nestedEntries) {
      if (nestedEntry.kind === 'select') continue;
      children.push(relationFrom(
        nestedEntry,
        entry.entity?.name as string,
        branchId,
        [...path, nestedEntry.key as string],
        `${branchId}.${nestedEntry.key as string}`,
      ));
    }
  }
  return Object.freeze({
    branchId,
    path,
    parentEntity,
    parentBranchId,
    entity: entry.entity?.name as string,
    kind: entry.kind as PatchPlanRelation['kind'],
    fk: entry.fk as string,
    inverse: Boolean(entry.inverse),
    selected: Object.freeze([...(entry.selected ?? [])]),
    nestedSelect: Object.freeze([...(nestedSelectEntry?.fields ?? [])]),
    order: entry.order ? Object.freeze({ field: entry.order.field as string, direction: entry.order.direction as string }) : null,
    require: entry.require
      ? Object.freeze({
        entity: entry.require.entity?.name as string,
        childRef: entry.require.childRef as string,
        fk: entry.require.fk as string,
      })
      : null,
    children: Object.freeze(children),
  });
}

// FNV-1a over the canonical plan description: a stable, dependency-free
// declaration-version fingerprint for projection-token binding. Uses a
// self-contained canonicalizer (the shared canonical-json module rejects
// non-plain values, which hand-bound test entities can legitimately carry).
function planVersion(plan: Omit<AnchorPatchPlan, 'version'>): string {
  const describe = (relation: PatchPlanRelation): Record<string, unknown> => ({
    branchId: relation.branchId,
    entity: relation.entity,
    kind: relation.kind,
    fk: relation.fk,
    inverse: relation.inverse,
    selected: [...relation.selected],
    nestedSelect: [...relation.nestedSelect],
    order: relation.order ? { ...relation.order } : null,
    require: relation.require ? { ...relation.require } : null,
    children: relation.children.map(describe),
  });
  const description = {
    declaration: plan.declaration,
    anchorSelect: [...plan.anchorSelect],
    relations: plan.relations.map(describe),
    tombstone: plan.tombstone ? { ...plan.tombstone, hidden: [...plan.tombstone.hidden] } : null,
  };
  const canonical = (value: unknown): string => {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (typeof value === 'object') {
      const names = Object.keys(value as Record<string, unknown>).sort();
      return `{${names.map((name) => `${JSON.stringify(name)}:${canonical((value as Record<string, unknown>)[name])}`).join(',')}}`;
    }
    return `"${String(value)}"`;
  };
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(canonical(description), 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `plan-v1-${hash.toString(16)}`;
}

/**
 * Derive the patch plan of one compiled snapshot declaration. Pure structural
 * derivation — the compiled declaration remains the sole authority.
 */
export function compileAnchorPatchPlan(declaration: SnapshotDeclaration): AnchorPatchPlan {
  const branch = declaration.output as unknown as PlanBranchLike;
  const anchorName = branch.entity?.name as string;
  const anchorSelectEntry = (branch.entries ?? []).find((entry) => entry.kind === 'select');
  const relations: PatchPlanRelation[] = [];
  for (const entry of branch.entries ?? []) {
    if (entry.kind === 'select') continue;
    relations.push(relationFrom(entry, anchorName, 'anchor', [entry.key as string], entry.key as string));
  }
  const tombstone = declaration.tombstone as unknown as PatchPlanTombstone | null;
  const partial = {
    declaration: anchorName,
    anchorSelect: Object.freeze([...(anchorSelectEntry?.fields ?? [])]),
    relations: Object.freeze(relations),
    tombstone: tombstone ? Object.freeze({
      entity: tombstone.entity,
      entityId: tombstone.entityId,
      scopeId: tombstone.scopeId ?? null,
      targetScopeId: tombstone.targetScopeId ?? null,
      kind: tombstone.kind,
      state: tombstone.state,
      kindValue: tombstone.kindValue,
      hidden: Object.freeze([...tombstone.hidden]),
    }) : null,
  };
  return Object.freeze({ ...partial, version: planVersion(partial) });
}

/** Patch plans for every compiled composite declaration, keyed by anchor name. */
export function compilePatchPlans(composites: Iterable<[string, SnapshotDeclaration]>): ReadonlyMap<string, AnchorPatchPlan> {
  const plans = new Map<string, AnchorPatchPlan>();
  for (const [name, declaration] of composites) plans.set(name, compileAnchorPatchPlan(declaration));
  return plans;
}

/**
 * Ledger address key for one delivered fragment (#157): branch identity plus
 * entity plus row id. The value is the fragment's keyed-ancestor member chain
 * — the provable pre-state placement removals under keyed ancestors need.
 * Shared by the projector (writer + reader) so the encoding has one home.
 */
export function compositeFragmentAddressKey(branchId: string, entity: string, id: string): string {
  return `${branchId}\u0000${entity}\u0000${id}`;
}
