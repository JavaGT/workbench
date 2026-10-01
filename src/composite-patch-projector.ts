// Recipient patch projector (#122 design §5–§7, #157 targeted capture).
//
// Projects a composite-journal slice into one recipient's `snapshot-patch`
// operations through the SAME seam as full snapshots: capture → authorize →
// project. Every emitted value is recipient-projected state; raw _Log.eventData
// and action payload fields never enter a patch.
//
// #157 targeted branch capture: the candidate graph is SPARSE. It contains the
// anchor row plus, per touched branch, exactly the ancestor-instance spine and
// affected content the patch needs — affected fragments with their nested value
// subtrees and required-related rows, the smallest affected `many` instance,
// and ledger-addressed instances whose own rows are already gone. Only when
// the anchor op must assemble complete branch values are untouched branches
// captured whole, flagged ledger-admitted so authorizeSnapshot skips their
// per-row admit call: the recipient's ledger proves prior delivery, and grant
// or membership flips force a declaration-wide invalidation upstream, so a
// non-invalidating slice can never move the grant graph. authorizeSnapshot and
// projectSnapshot then run UNCHANGED on the sparse graph — identical per-row
// admission decisions and identical projection shapes, at O(affected) cost.
// One honest residual: an anchor-touched batch still READS its related rows
// once, because the replace-fields grammar demands the node's complete
// retained key set — but those reads carry no authorization work.
//
// Successor visibility is likewise incremental: the previous ledger content is
// patched with the captured post-state of affected fragments instead of
// re-derived from a full walk. Membership of untouched branches cannot have
// changed (a change would have routed affected entries), so clone-and-delta
// equals what a fresh derivation would produce.
//
// Removals are ledger-gated: an operation may name a row as REMOVED only when
// the recipient's visibility ledger proves that exact recipient previously
// received it (design §7). Rows absent from both the prior ledger and the
// fresh authorized projection are named by NOTHING — no id, no path, no
// ordering fact. Authorization loss on a previously delivered row is exactly
// such a proof (it was admitted at delivery time), so revocation REMOVES
// rather than discloses.
//
// Operation addressing: paths are absolute OUTPUT paths from the anchor root;
// every ancestor level contributes `<relationKey>` and, for keyed levels, the
// `<memberId>` segment, so a nested relation under keyed member c1 of `codes`
// reads like ["codes", "c1", "entries"]. `many` relations are replaced
// wholesale at the smallest affected relation instance (authoritative ordering,
// no index-move grammar, design §4/§6) — one operation PER affected instance.
// The ancestor-instance address of every delivered fragment is recorded in the
// recipient's ledger (#157), so a later removal under keyed (or many) ancestors
// patches exactly instead of falling back to a full snapshot: the prior address
// IS the provable pre-state placement.
//
// Any anomaly THROWS: callers convert every failure into full-snapshot
// recovery, never into a partial patch (fail closed, design §7).

import type { AnchorPatchPlan, PatchPlanRelation } from './composite-patch-plan.ts';
import { compositeFragmentAddressKey } from './composite-patch-plan.ts';
import type { CompositeCursorV1, SnapshotPatchOperationV1 } from './composite-patch-envelope.ts';

// Structural views over snapshot-projection's compiled shapes (the module
// keeps them package-private). Wide enough for targeted capture to read
// fk/inverse/order/require/nested straight off the declaration.
interface CompiledEntityLike {
  readonly name: string;
}
interface CompiledEntryLike {
  readonly key: string;
  readonly kind: 'select' | 'user' | 'one' | 'many' | 'keyed' | 'count';
  readonly entity?: CompiledEntityLike;
  readonly fk?: string;
  readonly inverse?: boolean;
  readonly fields?: readonly string[];
  readonly selected?: readonly string[] | null;
  readonly nested?: CompiledBranchLike | null;
  readonly order?: { readonly field: string; readonly direction: string } | null;
  readonly require?: { readonly entity: CompiledEntityLike; readonly childRef: string; readonly fk: string } | null;
}
interface CompiledBranchLike {
  readonly entity: CompiledEntityLike;
  readonly entries: ReadonlyArray<CompiledEntryLike>;
}
interface SnapshotNodeLike {
  raw: Record<string, unknown>;
  children: Map<unknown, SnapshotNodeLike[]>;
  /** Mirrors snapshot-projection's ledger-admission shortcut (#157). */
  ledgerAdmitted?: boolean;
  required?: unknown;
}
interface SnapshotDeclarationLike {
  anchor: { name: string };
  output: CompiledBranchLike;
  tombstone: unknown;
  tombstones?: readonly unknown[];
}
import { authorizeSnapshot, projectSnapshot, readRows, readRowsByIds, readUser } from './snapshot-projection.ts';
import type { StoredCompositeChange } from './composite-journal.ts';
import type { Principal } from './principal.ts';

export interface PatchProjectorInput {
  db: import('./driver.ts').DbHandle;
  principal: Principal;
  /** Owning composite scope, e.g. `Project:p1`. */
  scope: string;
  plan: AnchorPatchPlan;
  /** The compiled declaration behind `plan`; capture/authorize/project consume its runtime branches. */
  declaration: SnapshotDeclarationLike;
  mayVerb: unknown;
  authorization: unknown;
  from: CompositeCursorV1;
  to: CompositeCursorV1;
  /** Journal slice (from, to]: the routing evidence for this batch. */
  changes: readonly StoredCompositeChange[];
  includeActionId: boolean;
  /** Proven visibility of THIS recipient before this batch (from the projection ledger). */
  priorVisible: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
  /**
   * Ancestor-instance addresses the ledger proved for THIS recipient before
   * this batch (#157): addressKey -> the id of each ancestor instance, aligned
   * with the branch's ancestor levels. Removals address through this map.
   */
  priorAddresses: ReadonlyMap<string, readonly string[]>;
  /** Re-reads the composite cursor for the stable-read fence check. */
  readCompositeSeq: () => number;
  /**
   * Re-reads the owning scope's _Cursor (anchor fence, FIX 6): a patch
   * projected from an older snapshot must never advance a recipient to a
   * newer anchor — BOTH fences are captured and re-checked before emitting,
   * matching aggregateSnapshot's stable-read discipline.
   */
  readAnchorSeq: () => number;
}

export interface PatchProjection {
  readonly operations: readonly SnapshotPatchOperationV1[];
  /** Actions whose effect is VISIBLE in this patch (put/remove/replace ops). */
  readonly actionIds: readonly string[];
  /**
   * Actions routed through the journal whose committed effect is provably
   * INVISIBLE here (empty-affected entries — cross-exam 6). These, and only
   * these, may settle optimistic state on an empty patch.
   */
  readonly routedInvisibleActionIds: readonly string[];
  /** true: the anchor row is gone — callers run revoke/deleted handling, never a normal patch. */
  readonly revokedAnchor: boolean;
  /** Visibility AFTER this batch, per branch — the successor ledger content. */
  readonly visibleAfter: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
  /**
   * Ancestor-instance addresses AFTER this batch (#157) — the successor ledger
   * addressing content. Untouched fragments keep their prior addresses.
   */
  readonly addressesAfter: ReadonlyMap<string, readonly string[]>;
}

// ---- plan navigation ----

function findRelation(plan: AnchorPatchPlan, branchId: string): PatchPlanRelation | null {
  const visit = (relations: readonly PatchPlanRelation[]): PatchPlanRelation | null => {
    for (const relation of relations) {
      if (relation.branchId === branchId) return relation;
      const nested = visit(relation.children);
      if (nested) return nested;
    }
    return null;
  };
  return branchId === 'anchor' ? null : visit(plan.relations);
}

function branchChain(plan: AnchorPatchPlan, branchId: string): PatchPlanRelation[] {
  const segments = branchId.split('.');
  const chain: PatchPlanRelation[] = [];
  for (let end = 1; end <= segments.length; end += 1) {
    const relation = findRelation(plan, segments.slice(0, end).join('.'));
    if (!relation) throw new Error('journal names a branch outside the compiled plan');
    chain.push(relation);
  }
  return chain;
}

function keyOf(relation: PatchPlanRelation): string {
  return relation.branchId.slice(relation.branchId.lastIndexOf('.') + 1);
}

/**
 * Output path of a branch instance from its ancestor-instance ids (#157):
 * every level contributes its relation key; keyed levels additionally insert
 * the member id at that level. `levels` is aligned with the chain's ancestor
 * positions (chain minus its final relation).
 */
function instancePathFromLevels(chain: readonly PatchPlanRelation[], levels: readonly string[]): string[] {
  const segments: string[] = [];
  for (let index = 0; index < chain.length - 1; index += 1) {
    segments.push(keyOf(chain[index]));
    if (chain[index].kind === 'keyed') {
      const memberId = levels[index];
      if (typeof memberId !== 'string') throw new Error('keyed ancestor member id missing for patch path');
      segments.push(memberId);
    }
  }
  segments.push(keyOf(chain[chain.length - 1]));
  return segments;
}

/**
 * Compiled declaration entry for a plan relation, via the relation's declared
 * output path. The compiled entry carries the bound runtime entity (scope
 * filter, hydrate), physical fk direction, ordering, and requirement that
 * targeted capture must reproduce exactly.
 */
function compiledEntryAt(output: CompiledBranchLike, path: readonly string[]): CompiledEntryLike {
  let branch = output;
  let entry: CompiledEntryLike | null = null;
  for (const key of path) {
    entry = branch.entries.find((candidate) => candidate.key === key) ?? null;
    if (!entry || !entry.nested) continue;
    branch = entry.nested;
  }
  if (!entry) throw new Error('plan names an output path outside the compiled declaration');
  return entry;
}

// ---- affected-fragment resolution -------------------------------------------

/** One ancestor level's placement evidence (aligned with the chain position). */
interface AncestorLevel {
  readonly raw: Record<string, unknown>;
  /** Set when this level's relation is `keyed` (its id addresses the path). */
  readonly memberId: string | null;
}

/**
 * One affected row's placement evidence, resolved BEFORE capture from scoped
 * post-state reads alone (never a full-graph walk). `row` is null when the
 * row no longer exists (removed or hidden) — its address then comes from the
 * recipient's ledger, or the removal is unnamed (never delivered here).
 */
interface AffectedFragment {
  readonly row: Record<string, unknown> | null;
  /** Ancestor rows for every level above the touched relation. */
  readonly levels: readonly AncestorLevel[];
}

/**
 * Resolve every affected id of one touched branch: a scoped by-ids read for
 * the rows themselves, then an upward fk-walk (one scoped read per level) for
 * the ancestor chain. O(affected × depth) reads — the smallest evidence set
 * that addresses the fragments. Throws (fail closed, snapshot recovery
 * upstream) when a step is not an inverse relation or a row cannot be read:
 * placement is then unknowable cheaply.
 */
function resolveFragments(db: import('./driver.ts').DbHandle, principal: Principal, declaration: SnapshotDeclarationLike, plan: AnchorPatchPlan, branchId: string, ids: ReadonlySet<string>, tombstones: readonly unknown[] | null): Map<string, AffectedFragment> {
  const chain = branchChain(plan, branchId);
  const finalEntry = compiledEntryAt(declaration.output, chain[chain.length - 1].path);
  if (!finalEntry.entity) throw new Error('touched branch lacks a compiled entity');
  const found = new Map<string, AffectedFragment>();
  if (ids.size === 0) return found;
  const rows = readRowsByIds(db, finalEntry.entity as never, principal, [...ids], null, tombstones as never);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      found.set(id, { row: null, levels: [] });
      continue;
    }
    const levels: AncestorLevel[] = [];
    let current: Record<string, unknown> = row;
    for (let index = chain.length - 1; index >= 1; index -= 1) {
      const step = chain[index];
      // Accepted scope (#157 re-review finding 4): ancestor steps must be
      // inverse (child holds the fk). A FORWARD `one` step (parent row holds
      // the fk) has no cheap scoped reverse lookup yet — a mutation that moves
      // a row INTO such a branch cannot be addressed, so it fails closed here
      // and recovers through a full snapshot. See the ticket constraint.
      if (step.inverse !== true) throw new Error('targeted capture supports inverse relation chains only');
      const parentId = current[step.fk];
      if (typeof parentId !== 'string' || parentId.length === 0) throw new Error('affected fragment lacks a readable ancestor reference');
      const parentRelation = chain[index - 1];
      const parentEntry = compiledEntryAt(declaration.output, parentRelation.path);
      if (!parentEntry.entity) throw new Error('ancestor branch lacks a compiled entity');
      const parentRows = readRowsByIds(db, parentEntry.entity as never, principal, [parentId], null, tombstones as never);
      if (parentRows.length !== 1) throw new Error('affected fragment ancestor could not be read');
      levels.unshift({ raw: parentRows[0], memberId: parentRelation.kind === 'keyed' ? parentId : null });
      current = parentRows[0];
    }
    found.set(id, { row, levels });
  }
  return found;
}

// ---- sparse candidate graph --------------------------------------------------

interface CaptureContext {
  db: import('./driver.ts').DbHandle;
  principal: Principal;
  declaration: SnapshotDeclarationLike;
  plan: AnchorPatchPlan;
  tombstones: readonly unknown[] | null;
  touched: Map<string, Set<string>>;
  anchorTouched: boolean;
  resolution: Map<string, Map<string, AffectedFragment>>;
  /** Per touched branch: addressing instances (post-state ∪ ledger-addressed). */
  instances: Map<string, Map<string, InstanceGroup>>;
  /**
   * Finding 1 (#157): per touched branch, surviving rows whose LEDGER address
   * (pre-move) differs from their current ancestry — keyed as
   * `branchId\u0000rowId` → old-instance levels. Their old instance must be
   * re-emitted (wholesale kinds) or explicitly removed (keyed) alongside the
   * new-path write, or the client keeps a stale copy under the old path.
   */
  departed: Map<string, Map<string, readonly string[]>>;
}

/** One addressing instance of one touched branch. */
interface InstanceGroup {
  /** Ancestor-instance ids, aligned with the chain's ancestor positions. */
  readonly levels: readonly string[];
  /** Affected ids resolved at this instance. */
  readonly ids: Set<string>;
  /**
   * Finding 1 (#157): true for wholesale-kind instances registered ONLY
   * because a member moved away — no journal event named this instance's
   * remaining rows, so it is absent from `touched`. The whole instance is
   * captured and re-emitted so its replacement value reflects the departure.
   */
  departedOnly?: boolean;
}

function newNode(raw: Record<string, unknown>, ledgerAdmitted: boolean): SnapshotNodeLike {
  const node: SnapshotNodeLike = { raw, children: new Map() };
  if (ledgerAdmitted) node.ledgerAdmitted = true;
  return node;
}

/** Requirement side-capture shared by every capture mode (see captureSnapshot). */
function attachRequirement(ctx: CaptureContext, entry: CompiledEntryLike, child: Record<string, unknown>, holderRaw: Record<string, unknown>, node: SnapshotNodeLike): void {
  if (!entry.require) return;
  const { db, principal, tombstones } = ctx;
  node.required = false;
  const related = readRows(db, entry.require.entity as never, principal, 'id', child[entry.require.childRef], false, null, tombstones as never);
  // The related row must be co-owned by this exact branch parent.
  if (related.length === 1 && related[0][entry.require.fk] === holderRaw.id) {
    // The required node must carry its entity — authorizeSnapshot walks
    // `node.required.entity` when it re-authorizes the requirement. newNode()
    // omits it, and a missing entity makes that walk authorize(undefined, …),
    // which throws into the fail-closed catch and DENIES every affected row of
    // a require-carrying branch (a Scope code rename projected as remove-keyed
    // instead of put-keyed). Mirror the full-capture shape in snapshot-projection.
    node.required = Object.freeze({ entity: entry.require.entity, raw: related[0], children: new Map() });
  }
}

function nestedEntriesOf(entry: CompiledEntryLike): ReadonlyArray<CompiledEntryLike> {
  return entry.nested ? entry.nested.entries.filter((nested) => nested.kind !== 'select') : [];
}

/**
 * Capture the COMPLETE value subtree of one compiled entry under one row —
 * every relation level below it, required-related rows included. Used for
 * affected fragments (fresh admission) and for untouched branches when the
 * anchor op must assemble complete values (ledger-admitted). Mirrors
 * captureSnapshot's per-entry behavior exactly, plus the admission flag.
 */
function fillCompleteEntry(ctx: CaptureContext, parentRaw: Record<string, unknown>, entry: CompiledEntryLike, ledgerAdmitted: boolean): SnapshotNodeLike[] {
  const { db, principal, tombstones } = ctx;
  if (entry.kind === 'user') {
    const user = parentRaw[entry.fk as string] == null ? null : readUser(db, parentRaw[entry.fk as string], tombstones as never);
    return user ? [Object.freeze({ raw: user, children: new Map<unknown, SnapshotNodeLike[]>() })] : [];
  }
  if (!entry.entity) throw new Error('captured branch lacks a compiled entity');
  const rows = readRows(db, entry.entity as never, principal, entry.fk as string, entry.inverse ? parentRaw.id : parentRaw[entry.fk as string], entry.inverse === true, entry.order as never, tombstones as never);
  return rows.map((child) => {
    const node = newNode(child, ledgerAdmitted);
    attachRequirement(ctx, entry, child, parentRaw, node);
    for (const nestedEntry of nestedEntriesOf(entry)) {
      node.children.set(nestedEntry, fillCompleteEntry(ctx, child, nestedEntry, ledgerAdmitted));
    }
    return Object.freeze(node);
  });
}

/** One captured affected row: fresh admission, complete value subtree, requirement honored. */
function finishFragmentNode(ctx: CaptureContext, entry: CompiledEntryLike, raw: Record<string, unknown>, holderRaw: Record<string, unknown>): SnapshotNodeLike {
  const node = newNode(raw, false);
  attachRequirement(ctx, entry, raw, holderRaw, node);
  for (const nestedEntry of nestedEntriesOf(entry)) {
    node.children.set(nestedEntry, fillCompleteEntry(ctx, raw, nestedEntry, false));
  }
  return Object.freeze(node);
}

/**
 * Read one ancestor instance row by id (scoped, tombstone-aware) — used when
 * a ledger-addressed instance's spine rows are not part of any surviving
 * fragment's post-state evidence.
 */
function fetchAncestorRow(ctx: CaptureContext, entry: CompiledEntryLike, id: string): Record<string, unknown> {
  if (!entry.entity) throw new Error('ancestor branch lacks a compiled entity');
  const rows = readRowsByIds(ctx.db, entry.entity as never, ctx.principal, [id], null, ctx.tombstones as never);
  if (rows.length !== 1) throw new Error('ledger-addressed ancestor instance could not be read');
  return rows[0];
}

/**
 * Targeted capture of ONE touched branch (#157): for every addressing
 * instance — post-state or ledger-addressed — rebuild exactly the ancestor
 * spine nodes the output path needs, then capture the smallest affected
 * content at the final relation: affected keyed members, or the whole
 * instance for wholesale kinds. Fresh admission for every captured row.
 * `into` is the container the branch's TOP-LEVEL entry lives in; deeper
 * spine levels hang off their parent instance's node, which a previous
 * group (or the level above, this pass) has already placed.
 */
function fillAffectedBranch(ctx: CaptureContext, rootRaw: Record<string, unknown>, branchId: string, into: Map<unknown, SnapshotNodeLike[]>): void {
  const { db, principal, tombstones } = ctx;
  const chain = branchChain(ctx.plan, branchId);
  const groups = ctx.instances.get(branchId);
  if (!groups) throw new Error('addressing instances unresolved for a touched branch');
  const fragments = ctx.resolution.get(branchId);
  if (!fragments) throw new Error('affected fragments unresolved for a touched branch');

  for (const [, group] of groups) {
    // Finding 3 (#157 re-review): validate the group's address chain against
    // CURRENT ancestry BEFORE building or emitting through it. Consecutive
    // spine rows must still be fk-linked (every keyed ancestor step is
    // inverse: the child row holds the parent's id). A stale ledger chain —
    // e.g. after an unnoticed reparent or id recycle — fails closed here and
    // recovers through a full snapshot instead of patching an instance that
    // moved. Evidence rows are post-state so they pass by construction; only
    // fetched (ledger-only) rows can fail, which is exactly the staleness
    // signal.
    const spineRaws: Array<Record<string, unknown>> = [];
    for (let level = 0; level < chain.length - 1; level += 1) {
      const levelRelation = chain[level];
      const levelEntry = compiledEntryAt(ctx.declaration.output, levelRelation.path);
      if (!levelEntry.entity) throw new Error('ancestor branch lacks a compiled entity');
      const memberId = group.levels[level];
      const evidence = [...fragments.values()].find((candidate) => String(candidate.levels[level]?.raw.id) === memberId);
      const raw = evidence?.levels[level]?.raw ?? fetchAncestorRow(ctx, levelEntry, memberId);
      // EVERY link is validated, including level 0 against the ANCHOR itself
      // (#157 final review): skipping the anchor link let a readable-but-
      // foreign first ancestor patch a ghost instance silently. The anchor is
      // simply level -1 of the spine.
      const parent = level > 0 ? spineRaws[level - 1] : rootRaw;
      if (String(raw[levelRelation.fk]) !== String(parent.id)) {
        throw new Error('ledger address no longer matches current ancestry');
      }
      spineRaws.push(raw);
    }

    // Walk/build the ancestor spine, outermost first. Every level's node is
    // REUSED when already present in its parent's children (placed by an
    // earlier group or touched branch) and only read+captured when missing.
    // Raw rows come from the validated spine pass above.
    let parentNode = { raw: rootRaw, children: into } as SnapshotNodeLike;
    for (let level = 0; level < chain.length - 1; level += 1) {
      const relation = chain[level];
      if (relation.kind !== 'keyed') {
        // Grammar boundary already rejects non-keyed ancestors upstream;
        // reaching here would mean an unnavigable path.
        throw new Error('targeted capture supports keyed-ancestor spines only');
      }
      const levelEntry = compiledEntryAt(ctx.declaration.output, relation.path);
      if (!levelEntry.entity) throw new Error('ancestor branch lacks a compiled entity');
      const memberId = group.levels[level];
      const existing = (parentNode.children.get(levelEntry) ?? []) as SnapshotNodeLike[];
      let node = existing.find((candidate) => String(candidate.raw.id) === memberId) ?? null;
      if (!node) {
        // Raw row comes from the validated spine pass above.
        node = newNode(spineRaws[level], false);
        // Spine rows are addressed, not emitted: nested entries stay empty
        // unless a later touched branch fills them under this same node.
        for (const nestedEntry of nestedEntriesOf(levelEntry)) node.children.set(nestedEntry, []);
        existing.push(Object.freeze(node));
        parentNode.children.set(levelEntry, existing);
      }
      parentNode = node;
    }

    const finalRelation = chain[chain.length - 1];
    const finalEntry = compiledEntryAt(ctx.declaration.output, finalRelation.path);
    if (!finalEntry.entity) throw new Error('touched branch lacks a compiled entity');
    const holderRaw = parentNode.raw;

    if (finalRelation.kind === 'keyed') {
      // Affected members only — the smallest affected set.
      const existing = (parentNode.children.get(finalEntry) ?? []) as SnapshotNodeLike[];
      for (const id of group.ids) {
        const fragment = fragments.get(id);
        if (!fragment?.row) continue; // removed: handled as remove-keyed, no node needed
        if (existing.some((candidate) => String(candidate.raw.id) === id)) continue;
        existing.push(Object.freeze(finishFragmentNode(ctx, finalEntry, fragment.row, holderRaw)));
      }
      parentNode.children.set(finalEntry, existing);
      continue;
    }

    // many / count / one: wholesale replacement of THIS instance — read the
    // whole (smallest) instance with authoritative ordering.
    const rows = finalRelation.inverse
      ? readRows(db, finalEntry.entity as never, principal, finalEntry.fk as string, holderRaw.id, true, finalEntry.order as never, tombstones as never)
      : readRows(db, finalEntry.entity as never, principal, finalEntry.fk as string, holderRaw[finalEntry.fk as string], false, finalEntry.order as never, tombstones as never);
    parentNode.children.set(finalEntry, rows.map((child) => Object.freeze(finishFragmentNode(ctx, finalEntry, child, holderRaw))));
  }
}

/**
 * Build the sparse candidate graph for this batch (#157). Returns null when
 * the anchor row is gone (revoked-anchor handling upstream, identical to
 * captureSnapshot's contract).
 */
function captureAffectedGraph(ctx: CaptureContext, handleId: string): SnapshotNodeLike | null {
  const { db, principal, declaration, tombstones } = ctx;
  const anchorRows = readRows(db, declaration.anchor as never, principal, 'id', handleId, false, null, tombstones as never);
  if (anchorRows.length !== 1) return null;
  const root = newNode(anchorRows[0], false);
  const output = declaration.output;

  // Group the touched branches by their TOP-LEVEL output entry: a touched
  // `codes.notes` lives under the `codes` entry, which must therefore not be
  // treated as untouched even though `codes` itself is not in the slice.
  const touchedUnder = new Map<string, string[]>();
  for (const branchId of ctx.touched.keys()) {
    const topLevel = branchId.split('.')[0];
    const existing = touchedUnder.get(topLevel);
    if (existing) existing.push(branchId);
    else touchedUnder.set(topLevel, [branchId]);
  }

  for (const entry of output.entries) {
    if (entry.kind === 'select') continue;
    const under = touchedUnder.get(entry.key);
    if (!under && !ctx.anchorTouched) {
      // Sparse absence: nothing under this branch is touched and no anchor op
      // is emitted, so nobody reads its value. Nothing is captured, admitted,
      // hydrated, or projected for it.
      root.children.set(entry, []);
      continue;
    }
    if (!under) {
      // Anchor-op value assembly for an untouched branch: the replace-fields
      // value must carry every branch's current value, so capture whole —
      // ledger-admitted (no per-row admit calls) but fully hydrated so the
      // values stay byte-identical to a fresh snapshot.
      root.children.set(entry, fillCompleteEntry(ctx, root.raw, entry, true));
      continue;
    }
    if (ctx.anchorTouched) {
      // Mixed batch (anchor fields AND this branch in one slice): the anchor
      // op needs the complete branch value anyway, so capture whole with FRESH
      // admission — touched rows must never ride on the ledger shortcut.
      root.children.set(entry, fillCompleteEntry(ctx, root.raw, entry, false));
      continue;
    }
    // Sparse path: rebuild only the addressed instances under this entry.
    for (const branchId of under) {
      fillAffectedBranch(ctx, root.raw, branchId, root.children);
    }
  }
  return root;
}

// ---- projected-shape navigation ----

function navigate(projected: unknown, segments: readonly string[]): unknown {
  let current: unknown = projected;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Full post-projection visibility, per plan branch: every (branch, entity, id)
 * fragment present in the recipient's fresh authorized projection, PLUS the
 * ancestor-instance address of every fragment (#157). Derived in ONE walk
 * against the plan — never incrementally accumulated, so bootstrap ledger
 * state always equals "what a fresh snapshot contains right now". Steady-state
 * patches update both maps incrementally instead (no walk).
 */
export function deriveVisibilityExtended(plan: AnchorPatchPlan, projected: Record<string, unknown>): { visible: Map<string, Map<string, Set<string>>>; addresses: Map<string, readonly string[]> } {
  const visible = new Map<string, Map<string, Set<string>>>();
  const addresses = new Map<string, readonly string[]>();
  const record = (branchId: string, entity: string, id: string, levels: readonly string[]): void => {
    let entities = visible.get(branchId);
    if (!entities) visible.set(branchId, entities = new Map());
    let ids = entities.get(entity);
    if (!ids) entities.set(entity, ids = new Set());
    ids.add(id);
    addresses.set(compositeFragmentAddressKey(branchId, entity, id), Object.freeze([...levels]));
  };
  const walkRelations = (relations: readonly PatchPlanRelation[], container: unknown, levels: readonly string[]): void => {
    for (const relation of relations) {
      if (!container || typeof container !== 'object') continue;
      const value: unknown = (container as Record<string, unknown>)[keyOf(relation)];
      if (relation.kind === 'count') continue; // counts expose no row identity
      if (relation.kind === 'one') {
        if (value && typeof value === 'object') {
          record(relation.branchId, relation.entity, String((value as Record<string, unknown>).id), levels);
          walkRelations(relation.children, value, levels);
        }
        continue;
      }
      if (relation.kind === 'many') {
        if (Array.isArray(value)) {
          for (const row of value) {
            record(relation.branchId, relation.entity, String(row.id), levels);
            walkRelations(relation.children, row, [...levels, String(row.id)]);
          }
        }
        continue;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [memberId, row] of Object.entries(value as Record<string, unknown>)) {
          record(relation.branchId, relation.entity, memberId, levels);
          walkRelations(relation.children, row, [...levels, memberId]);
        }
      }
    }
  };
  walkRelations(plan.relations, projected, []);
  return { visible, addresses };
}

/**
 * Compatibility wrapper: bootstrap and legacy callers that only need the
 * visibility map. See deriveVisibilityExtended for the addressed form (#157).
 */
export function deriveVisibility(plan: AnchorPatchPlan, projected: Record<string, unknown>): Map<string, Map<string, Set<string>>> {
  return deriveVisibilityExtended(plan, projected).visible;
}

function provenVisible(prior: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>, branchId: string, entity: string, id: string): boolean {
  return prior.get(branchId)?.get(entity)?.has(id) ?? false;
}

function cloneVisible(source: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  for (const [branch, entities] of source) {
    const entityCopy = new Map<string, Set<string>>();
    for (const [entity, ids] of entities) entityCopy.set(entity, new Set(ids));
    out.set(branch, entityCopy);
  }
  return out;
}

function cloneAddresses(source: ReadonlyMap<string, readonly string[]>): Map<string, readonly string[]> {
  return new Map(source);
}

/** Per-branch entity->ids bucket in the successor visibility map. */
function visibleBucket(visible: Map<string, Map<string, Set<string>>>, branchId: string, entity: string): Set<string> {
  let entities = visible.get(branchId);
  if (!entities) visible.set(branchId, entities = new Map());
  let ids = entities.get(entity);
  if (!ids) entities.set(entity, ids = new Set());
  return ids;
}

/**
 * Project one recipient's patch for a journal slice. Throws on any anomaly —
 * callers MUST convert throws into full-snapshot recovery (fail closed).
 */
export async function projectCompositePatch(input: PatchProjectorInput): Promise<PatchProjection> {
  const { principal, scope, plan, declaration, changes, from, to, priorVisible, priorAddresses } = input;
  const handleId = scope.slice(scope.indexOf(':') + 1);
  const tombstones = (declaration.tombstones ?? null) as readonly unknown[] | null;

  const actionIds = new Set<string>();
  const routedInvisible = new Set<string>();
  const touched = new Map<string, Set<string>>();
  let anchorTouched = false;
  for (const change of changes) {
    if (change.actionId && change.affected.length === 0) {
      // Routed but provably invisible to this declaration/recipient: the ONLY
      // disposition that may settle an optimistic op on an empty patch
      // (cross-exam 6).
      routedInvisible.add(change.actionId);
    } else if (change.actionId) {
      actionIds.add(change.actionId);
    }
    if (change.invalidating) throw new Error('journal slice contains an invalidating change');
    if (change.scope !== scope) throw new Error('journal slice spans foreign scopes');
    for (const affected of change.affected) {
      if (affected.branch === 'anchor') anchorTouched = true;
      let ids = touched.get(affected.branch);
      if (!ids) touched.set(affected.branch, ids = new Set());
      ids.add(affected.id);
    }
  }

  // Empty slice: an empty patch still advances the cursor (design §6).
  if (touched.size === 0 && !anchorTouched) {
    return { operations: [], actionIds: [...actionIds], routedInvisibleActionIds: [...routedInvisible], revokedAnchor: false, visibleAfter: cloneVisible(priorVisible), addressesAfter: cloneAddresses(priorAddresses) };
  }

  // --- resolve affected placements BEFORE capture (O(affected × depth)) -----
  const resolution = new Map<string, Map<string, AffectedFragment>>();
  for (const [branchId, ids] of touched) {
    if (branchId === 'anchor') continue;
    if (!findRelation(plan, branchId)) throw new Error('journal names a branch outside the compiled plan');
    resolution.set(branchId, resolveFragments(input.db, principal, declaration, plan, branchId, ids, tombstones));
  }

  // --- group affected ids per addressing instance ---------------------------
  // A surviving row addresses through its post-state fk-walk; a removed row
  // through the LEDGER's provable pre-state address; a wholesale-kind instance
  // whose own affected row vanished may borrow a SIBLING branch's surviving
  // fragment of the same entity (routing fans one event onto every branch
  // projecting that entity). A removed id the ledger proves delivered but
  // never addressed cannot be placed — fail closed. An id never delivered to
  // this recipient is simply not ours to name.
  const instancesByBranch = new Map<string, Map<string, InstanceGroup>>();
  // Finding 1 (#157): surviving rows reparented between keyed instances,
  // keyed branchId\u0000rowId -> the OLD instance's levels.
  const departedByBranch = new Map<string, Map<string, readonly string[]>>();

  for (const [branchId, ids] of touched) {
    if (branchId === 'anchor') continue;
    const relation = findRelation(plan, branchId);
    if (!relation) throw new Error('journal names a branch outside the compiled plan');
    const fragments = resolution.get(branchId);
    if (!fragments) throw new Error('affected fragments unresolved for a touched branch');
    const chain = branchChain(plan, branchId);
    // Grammar boundary (#157): output paths navigate OBJECTS — keyed levels
    // contribute `<key>, <memberId>` pairs and one levels contribute objects —
    // but a many (or count) ANCESTOR leaves an array (or number) in the path
    // that no patch operation can address. Such branches fail closed here:
    // the caller recovers through a full snapshot instead of emitting an
    // unnavigable path. (A many as the FINAL relation is fine — its own emit
    // path stops before entering the array.)
    for (let level = 0; level < chain.length - 1; level += 1) {
      if (chain[level].kind === 'many' || chain[level].kind === 'count') {
        throw new Error('targeted capture cannot address below a many/count ancestor');
      }
    }

    const levelsOf = (id: string, fragment: AffectedFragment): readonly string[] | null => {
      if (fragment.row) return fragment.levels.map((level) => level.memberId ?? String(level.raw.id));
      const addressed = priorAddresses.get(compositeFragmentAddressKey(branchId, relation.entity, id));
      if (addressed) {
        // Legacy-address-length guard: addresses must cover every level.
        if (addressed.length === chain.length - 1) return addressed;
        throw new Error('ledger address does not match the branch depth');
      }
      if (provenVisible(priorVisible, branchId, relation.entity, id)) {
        throw new Error('removed fragment lacks a provable ancestor address');
      }
      return null; // never delivered to this recipient: named by nothing
    };

    const siblingLevels = (entity: string, expectedDepth: number): readonly string[] | null => {
      for (const [otherBranchId, otherFragments] of resolution) {
        if (otherBranchId === branchId) continue;
        const otherRelation = findRelation(plan, otherBranchId);
        if (!otherRelation || otherRelation.entity !== entity) continue;
        for (const otherFragment of otherFragments.values()) {
          if (!otherFragment.row) continue;
          const levels = otherFragment.levels.map((level) => level.memberId ?? String(level.raw.id));
          // A sibling branch of the same entity may sit at a DIFFERENT
          // declaration depth; borrowing levels of the wrong shape would
          // address a foreign path. Fail safe: borrow only depth-matched evidence.
          if (levels.length !== expectedDepth) continue;
          return levels;
        }
      }
      return null;
    };

    let groups = instancesByBranch.get(branchId);
    if (!groups) instancesByBranch.set(branchId, groups = new Map());
    for (const id of ids) {
      const fragment = fragments.get(id);
      if (!fragment) throw new Error('affected fragment unresolved');
      const levels = levelsOf(id, fragment)
        ?? ((relation.kind !== 'keyed') ? siblingLevels(relation.entity, chain.length - 1) : null);
      if (!levels) continue;
      // Finding 1 (#157): a SURVIVING row whose ledger address differs from
      // its CURRENT ancestry was reparented between keyed ancestor instances.
      // The client still holds it under the old path; register the old
      // instance so emission cleans it up there too.
      if (fragment.row) {
        const priorAddress = priorAddresses.get(compositeFragmentAddressKey(branchId, relation.entity, id));
        if (fragment.row && priorAddress && priorAddress.length === chain.length - 1
          && priorAddress.some((level, index) => level !== levels[index])) {
          departedByBranch.set(branchId, (departedByBranch.get(branchId) ?? new Map()).set(id, priorAddress));
          // Make the moved row resolvable at its OLD instance for capture and
          // authorization: synthesize a fragment carrying the old spine.
          if (!fragments.has(`${id}@departed`)) {
            const oldSpine: AncestorLevel[] = [];
            let cursorRow: Record<string, unknown> | null = fragment.row;
            for (let level = chain.length - 2; level >= 0; level -= 1) {
              const ancestorId = priorAddress[level];
              const ancestorRelation = chain[level];
              const ancestorEntry = compiledEntryAt(declaration.output, ancestorRelation.path);
              if (!ancestorEntry.entity || !cursorRow) throw new Error('departed row cannot rebuild its old spine');
              const ancestorRows = readRowsByIds(input.db, ancestorEntry.entity as never, principal, [ancestorId], null, tombstones as never);
              if (ancestorRows.length !== 1) throw new Error('departed row ancestor could not be read');
              oldSpine.unshift({ raw: ancestorRows[0], memberId: ancestorRelation.kind === 'keyed' ? ancestorId : null });
              cursorRow = ancestorRows[0];
            }
            fragments.set(`${id}@departed`, { row: fragment.row, levels: oldSpine });
          }
        }
      }
      const key = levels.join('\u0000');
      let group = groups.get(key);
      if (!group) groups.set(key, group = { levels, ids: new Set() });
      group.ids.add(id);
    }
  }

  // Finding 1 (#157): for every departed row, register its OLD instance as a
  // group so capture rebuilds it and emission cleans the row's stale copy.
  // Wholesale kinds (many/count/one) re-emit the whole instance (the
  // replacement value reflects the departure); keyed instances are handled
  // at emission with an explicit remove-keyed, since capturing there would
  // misplace the moved row into the old parent.
  for (const [branchId, departedRows] of departedByBranch) {
    let groups = instancesByBranch.get(branchId);
    if (!groups) instancesByBranch.set(branchId, groups = new Map());
    // One group per DISTINCT old instance; every row that left through it is
    // named as `rowId@departed` so emission can clean the stale client copy.
    for (const [, priorAddress] of departedRows) {
      const key = `departed\u0000${priorAddress.join('\u0000')}`;
      let group = groups.get(key);
      if (!group) {
        group = { levels: [...priorAddress], ids: new Set(), departedOnly: true };
        groups.set(key, group);
      }
      for (const [rowId, prior] of departedRows) {
        if (prior.join('\u0000') === priorAddress.join('\u0000')) group.ids.add(`${rowId}@departed`);
      }
    }
  }

  // Dual-fence discipline (re-review GAP 4): the anchor fence is read BEFORE
  // capture begins and re-checked after projection. A commit landing between
  // the two reads means the candidate graph spans a commit boundary — the
  // throw routes through the caller's retry/snapshot recovery instead of
  // emitting a patch that would advance the recipient to an unearned anchor.
  const anchorFenceBeforeCapture = input.readAnchorSeq();

  // --- one TARGETED capture → authorize → project pass for the WHOLE batch --
  const captured = captureAffectedGraph({ db: input.db, principal, declaration, plan, tombstones, touched, anchorTouched, resolution, instances: instancesByBranch, departed: departedByBranch }, handleId);
  if (!captured) {
    return { operations: [], actionIds: [...actionIds], routedInvisibleActionIds: [...routedInvisible], revokedAnchor: true, visibleAfter: new Map(), addressesAfter: new Map() };
  }
  const auth = await authorizeSnapshot({
    principal,
    anchor: declaration.anchor as never,
    candidate: captured as never,
    mayVerb: input.mayVerb as never,
    authorization: input.authorization as never,
  });
  if (!auth.anchorAllowed) throw new Error('composite patch anchor reauthorization denied');
  const projected = projectSnapshot({ anchor: declaration.anchor as never, candidate: captured as never, output: declaration.output as never, authorized: auth.authorized }) as Record<string, unknown> | null;
  if (!projected) throw new Error('composite patch projection failed');
  // Dual-fence check (FIX 6): the anchor _Cursor must be UNCHANGED between
  // capture and emission — movement means the candidate graph was captured
  // across a commit (retry/fallback upstream). The delivered to.anchor is the
  // CURRENT head, so the patch leaves the recipient exactly at the anchor its
  // new state was projected from — never past it, never behind it.
  if (input.readAnchorSeq() !== anchorFenceBeforeCapture) throw new Error('anchor cursor moved during patch capture');
  if (anchorFenceBeforeCapture < from.anchor) throw new Error('anchor cursor moved backwards during patch projection');
  if (input.readCompositeSeq() !== to.composite) throw new Error('composite journal moved during patch projection');

  const operations: SnapshotPatchOperationV1[] = [];

  // --- anchor selected-field replacement ------------------------------------
  // The value carries the COMPLETE retained key set of the node — selected
  // fields AND every current relation-branch value — so the client's
  // exact-set replacement deletes only genuinely removed keys and untouched
  // relation branches round-trip unchanged (re-review GAP 3b). Untouched
  // branch values came from the ledger-admitted capture above.
  if (anchorTouched) {
    const selectEntry = declaration.output.entries.find((entry) => entry.kind === 'select');
    const fields = ['id', ...(selectEntry && selectEntry.kind === 'select' ? (selectEntry.fields ?? []) : [])];
    const relationKeys = declaration.output.entries.filter((entry) => entry.kind !== 'select').map((entry) => entry.key);
    const value: Record<string, unknown> = {};
    for (const field of [...fields, ...relationKeys]) value[field] = (projected as Record<string, unknown>)[field];
    operations.push({ op: 'replace-fields', path: [], value });
  }

  // --- successor ledger state (incremental, #157) ----------------------------
  // Untouched branches cannot have changed membership (a change would have
  // routed affected entries), so cloning the prior maps and applying the
  // captured post-state of affected fragments equals a fresh derivation.
  const visibleAfter = cloneVisible(priorVisible);
  const addressesAfter = cloneAddresses(priorAddresses);

  // --- relation branches -----------------------------------------------------
  for (const [branchId, groups] of instancesByBranch) {
    const relation = findRelation(plan, branchId);
    if (!relation) throw new Error('journal names a branch outside the compiled plan');
    const chain = branchChain(plan, branchId);
    const fragments = resolution.get(branchId);
    if (!fragments) throw new Error('affected fragments unresolved for a touched branch');

    for (const [, group] of groups) {
      const path = instancePathFromLevels(chain, group.levels);

      if (relation.kind === 'one' || relation.kind === 'count') {
        const value = navigate(projected, path);
        operations.push(relation.kind === 'count'
          ? { op: 'replace-value', path, value }
          : { op: 'replace-one', path, value: (value ?? null) as Record<string, unknown> | null });
        if (relation.kind === 'one') {
          const idSet = visibleBucket(visibleAfter, branchId, relation.entity);
          // Finding 2 (#157 re-review): a one-relation batch may remove or
          // replace SEVERAL candidate rows in one commit, and visibility
          // updates every affected id — but only ONE row survives under the
          // relation. Derive the successor identity from the PROJECTED VALUE
          // (never group order) and clear every prior entry ADDRESSED AT THIS
          // SAME INSTANCE (levels-equal; the address key is instance-blind,
          // so branch+entity alone would nuke sibling instances' successors)
          // from visibility AND the address ledger.
          const prefix = compositeFragmentAddressKey(branchId, relation.entity, '');
          const priorEntries: Array<{ id: string; levels: readonly string[] }> = [];
          for (const [key, levels] of addressesAfter) {
            if (key.startsWith(prefix)) priorEntries.push({ id: key.slice(prefix.length), levels });
          }
          const successorId = value && typeof value === 'object' && !Array.isArray(value)
            ? String((value as Record<string, unknown>).id)
            : null;
          const sameInstance = (candidate: readonly string[]): boolean => (
            candidate.length === group.levels.length && group.levels.every((level, index) => candidate[index] === level)
          );
          for (const prior of priorEntries) {
            if (prior.id === successorId || !sameInstance(prior.levels)) continue;
            addressesAfter.delete(compositeFragmentAddressKey(branchId, relation.entity, prior.id));
            idSet.delete(prior.id);
          }
          // The projected value is the SINGLE source of visible identity for
          // a one relation: surviving candidate rows that are not selected do
          // NOT become visible, and a removed row that lost selection does
          // not stay visible merely because group.ids names it.
          if (successorId !== null) {
            // The address key is single-valued per (branch, entity, id); when
            // the same row occupies several instances across this batch,
            // .set() naturally yields LAST group wins — mirroring
            // deriveVisibilityExtended's overwrite order against a fresh snapshot.
            idSet.add(successorId);
            addressesAfter.set(compositeFragmentAddressKey(branchId, relation.entity, successorId), Object.freeze([...group.levels]));
          }
        }
        continue;
      }

      if (relation.kind === 'many') {
        const value = navigate(projected, path);
        if (!Array.isArray(value)) throw new Error('projected many relation is not an array');
        operations.push({ op: 'replace-many', path, value: value.map((row) => ({ ...row })) });
        // Successor visibility + addresses for the replaced instance's rows.
        const idSet = visibleBucket(visibleAfter, branchId, relation.entity);
        const surviving = new Set<string>();
        for (const row of value) {
          const rowId = String((row as Record<string, unknown>).id);
          surviving.add(rowId);
          idSet.add(rowId);
          addressesAfter.set(compositeFragmentAddressKey(branchId, relation.entity, rowId), Object.freeze([...group.levels]));
        }
        for (const id of group.ids) {
          // An affected row that vanished from this instance is gone — but
          // only if THIS recipient was ever proven to see it.
          if (!surviving.has(id) && idSet.has(id)) idSet.delete(id);
        }
        continue;
      }

      // keyed: member-level put/remove; removals ledger-gated.
      for (const id of group.ids) {
        // Finding 1 (#157): `id@departed` names a row that MOVED AWAY from
        // this instance. The client still holds its old copy — remove it.
        if (id.endsWith('@departed')) {
          const realId = id.slice(0, -'@departed'.length);
          if (provenVisible(priorVisible, branchId, relation.entity, realId)) {
            operations.push({ op: 'remove-keyed', path, id: realId });
            addressesAfter.delete(compositeFragmentAddressKey(branchId, relation.entity, realId));
            visibleBucket(visibleAfter, branchId, relation.entity).delete(realId);
          }
          continue;
        }
        const collection = navigate(projected, path);
        const current = collection && typeof collection === 'object' && !Array.isArray(collection)
          ? (collection as Record<string, unknown>)[id]
          : undefined;
        if (current && typeof current === 'object') {
          operations.push({ op: 'put-keyed', path, id, value: { ...(current as Record<string, unknown>) } });
          addressesAfter.set(compositeFragmentAddressKey(branchId, relation.entity, id), Object.freeze([...group.levels]));
          visibleBucket(visibleAfter, branchId, relation.entity).add(id);
          continue;
        }
        if (provenVisible(priorVisible, branchId, relation.entity, id)) {
          operations.push({ op: 'remove-keyed', path, id });
          addressesAfter.delete(compositeFragmentAddressKey(branchId, relation.entity, id));
          visibleBucket(visibleAfter, branchId, relation.entity).delete(id);
          continue;
        }
        // Not admitted now and never proven delivered: named by nothing.
      }
    }
  }

  return { operations, actionIds: [...actionIds], routedInvisibleActionIds: [...routedInvisible], revokedAnchor: false, visibleAfter, addressesAfter };
}
