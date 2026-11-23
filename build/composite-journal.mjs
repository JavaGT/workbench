// Composite change journal (#122 design §3).
//
// A durable, per-composite-scope record of which compiled snapshot branches a
// committed action may have changed, written transactionally with _Log,
// _ActionReceipt, and the private before/after facts inside the commit
// pipeline. The journal owns the composite cursor sequence: `composite` is a
// per-scope counter over these entries, never the global aggregate revision.
//
// Recipient safety: entries carry identities and ROUTING reasons only — never
// recipient-projected field values, never raw _Log.eventData. Routing derives
// exclusively from the compiled patch plan plus in-transaction before/after
// row evidence; when the evidence cannot identify the affected scope the entry
// is marked invalidating (declaration-wide resync), never guessed.

import { prepareCached,               } from './driver.mjs';
import { tryParseScopeKey } from './scope-handle.mjs';
import { EventKind, parseEventType,                          } from './event-handle.mjs';


export function compositeChangeTableDDL() {
  return `CREATE TABLE IF NOT EXISTS _CompositeChange (
  scope TEXT NOT NULL,
  seq INTEGER NOT NULL,
  declaration TEXT NOT NULL,
  actionId TEXT NOT NULL,
  eventRefs TEXT NOT NULL,
  affected TEXT NOT NULL,
  invalidating INTEGER NOT NULL DEFAULT 0,
  committedAt TEXT NOT NULL,
  PRIMARY KEY (scope, seq)
);`;
}

export function compositeChangeCursorTableDDL() {
  return `CREATE TABLE IF NOT EXISTS _CompositeChangeCursor (
  scope TEXT NOT NULL PRIMARY KEY,
  lastSeq INTEGER NOT NULL
);`;
}

export function compositeChangeIndexDDL() {
  return 'CREATE INDEX IF NOT EXISTS idx__CompositeChange_actionId ON _CompositeChange (actionId);';
}

export function compositeJournalDDL()           {
  return [compositeChangeTableDDL(), compositeChangeCursorTableDDL(), compositeChangeIndexDDL()];
}

// ---- shapes ----

















                                                  




















function rowOf(evidence             , phase                    , entity        , id         )                                 {
  if (typeof id !== 'string' || id.length === 0) return null;
  const row = evidence[phase].get(entity)?.get(id);
  return row ?? null;
}

// The Event-type grammar authority is parseEventType (event-handle.ts). For
// grammar events the router derives both entity and phase from its handle —
// never from a local suffix/regex re-derivation — so dotted field events
// (Note.title.set, kind 'fieldSet') and lifecycle events agree with every other
// grammar consumer. Application-defined event types the authority rejects keep
// only a prefix-based entity extraction, so custom events still fan out an
// invalidation instead of being silently dropped.
function tryParseEventType(eventType        )                             {
  try {
    return parseEventType(eventType);
  } catch {
    return null;
  }
}

/** Entity name from the grammar handle ('Code.updated' -> 'Code'), else null. */
function classifyEntityName(eventType        )                {
  const handle = tryParseEventType(eventType);
  if (handle) return handle.entity;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\./.exec(eventType);
  return match ? match[1] : null;
}








// Routing policy, NOT a re-derivation of the Event grammar: parseEventType
// alone decides an event's entity, field and kind. This set says which *field*
// operations the journal may route precisely — the annotated-text verbs whose
// mutations change no projected selected field. Every other native verb stays
// unclassifiable so a custom application event (code.merged.raw, ...) can never
// be silently swallowed by a precise route that finds no branch to update.
const ROUTABLE_NATIVE_VERBS = new Set(['operated', 'retired', 'restored']);

function classify(eventType        )                             {
  const handle = tryParseEventType(eventType);
  if (!handle) return null;
  switch (handle.kind) {
    case EventKind.created: return { phase: 'created' };
    case EventKind.updated: return { phase: 'updated' };
    case EventKind.removed: return { phase: 'removed' };
    // A dotted field-set event (Note.title.set) is a field mutation, exactly
    // like a native field op — never an unclassifiable lifecycle event.
    case EventKind.fieldSet: return { phase: 'native', field: handle.field };
    case EventKind.native:
      return ROUTABLE_NATIVE_VERBS.has(handle.nativeName)
        ? { phase: 'native', field: handle.field }
        : null;
    default: return null;
  }
}

/** All plan branches (depth-first) whose child entity matches `entity`, including the synthetic anchor branch. */
function branchesForEntity(plan                 , entity        )                      {
  const found                      = [];
  const visit = (relations                              )       => {
    for (const relation of relations) {
      if (relation.entity === entity) found.push(relation);
      visit(relation.children);
    }
  };
  visit(plan.relations);
  return found;
}

/**
 * Resolve the owning composite scope(s) a member row belongs to, from one plan
 * branch. Inverse relations read the child's fk column directly; forward
 * ('one') relations require a bounded reverse lookup of parent ids. Returns
 * null when the parent linkage cannot be established from the supplied row.
 */
/**
 * Resolve the owning composite scope(s) a member row belongs to, from one plan
 * branch. Nested branches walk UP their parent chain: the child's fk names its
 * immediate parent row, the parent's own fk names ITS parent, and so on until
 * the anchor id is proven (design §3, "nested parent paths"). Returns null
 * when any hop lacks evidence — the caller invalidates rather than guesses.
 */
function parentScopesFor(db          , plans                                      , plan                 , relation                   , row                         )                  {
  // Build the branch chain from root to this relation for upward walking.
  const chain                      = [];
  const segments = relation.branchId.split('.');
  for (let end = 1; end <= segments.length; end += 1) {
    const found = findBranch(plans.get(plan.declaration), segments.slice(0, end).join('.'));
    if (!found) return null;
    chain.push(found);
  }
  // The row's id at each chain level; start from the changed row itself.
  let currentRow = row;
  let currentEntity = relation.entity;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const step = chain[index];
    if (step.entity !== currentEntity) return null;
    if (step.inverse) {
      const parentId = currentRow[step.fk];
      if (typeof parentId !== 'string' || parentId.length === 0) return null;
      if (index === 0) return [`${plan.declaration}:${parentId}`];
      // Read the parent row to continue the walk.
      try {
        const parentRow = db.prepare(`SELECT * FROM ${step.parentEntity} WHERE id = ?`).get(parentId)                                       ;
        if (!parentRow) return null;
        const parentRelation = chain[index - 1];
        currentRow = parentRow;
        currentEntity = step.parentEntity;
        void parentRelation;
      } catch {
        return null;
      }
    } else {
      // Forward step: parent rows holding fk = this row's id. Bounded reverse
      // lookup; each match is one candidate scope path.
      const identifier = step.fk.replace(/[^A-Za-z0-9_]/g, '');
      if (!identifier || identifier !== step.fk || index !== 0) return null;
      const rows = db.prepare(`SELECT id FROM ${step.parentEntity} WHERE ${identifier} = ?`).all(currentRow.id);
      return rows.map((parent) => `${plan.declaration}:${String(parent.id)}`);
    }
  }
  return null;
}

/** Locate a plan branch by id within one plan (or across none). */
function findBranch(plan                             , branchId        )                           {
  if (!plan) return null;
  const visit = (relations                              )                           => {
    for (const relation of relations) {
      if (relation.branchId === branchId) return relation;
      const nested = visit(relation.children);
      if (nested) return nested;
    }
    return null;
  };
  return visit(plan.relations);
}























/**
 * Route one finalized committed event into per-composite-scope change entries,
 * using the compiled plan and in-transaction before/after evidence only.
 *
 * Invalidate-by-default (#122 cross-exam 1): an event whose type cannot be
 * classified, or whose scope handle cannot be parsed, produces a
 * declaration-wide invalidating entry for every declared composite on that
 * scope's entity — NEVER silence. The only silent outcome is an event whose
 * entity provably appears nowhere (scope entity unknown to ALL declarations),
 * which cannot affect any subscriber of any declaration.
 */
export function routeCompositeEvent(db          , plans                                      , event             , evidence             )                         {
  const entries = new Map                              ();

  // Dedupe key is (scope, declaration) (re-review round 3, GAP 1): fan-out
  // invalidations all use scope '' and MUST coexist per declaration, and two
  // declarations can also legitimately target the same concrete scope.
  const add = (input                                         )       => {
    const key = `${input.scope}\u0000${input.declaration}`;
    const existing = entries.get(key);
    if (!existing) {
      entries.set(key, { ...input, eventRefs: [{ scope: event.scope, seq: event.seq }] });
      return;
    }
    const merged = [...existing.affected];
    for (const affected of input.affected) {
      if (!merged.some((candidate) => candidate.branch === affected.branch && candidate.id === affected.id && candidate.reason === affected.reason)) merged.push(affected);
    }
    entries.set(key, { ...existing, affected: merged, invalidating: existing.invalidating || Boolean(input.invalidating) });
  };

  // --- anchor events -------------------------------------------------------
  // The event TYPE names the changed row's entity; the event SCOPE only names
  // the owning composite scope (member rows inherit it). Route as an anchor
  // change only when the type's entity IS the declaration anchor.
  const handle = tryParseScopeKey(event.scope);
  if (!handle) {
    // Unparseable scope (cross-exam FIX 1): the affected composite scopes
    // cannot be proven, so EVERY declaration that projects any entity named by
    // this event — or every declaration when even the entity is unknown — is
    // invalidated. Never silence: a silently unrouted change leaves
    // subscribers permanently stale with no error anywhere.
    const eventTypeEntity0 = classifyEntityName(event.type);
    if (eventTypeEntity0 !== null) {
      for (const plan of plans.values()) {
        if (branchesForEntity(plan, eventTypeEntity0).length > 0 || plan.declaration === eventTypeEntity0) {
          return [{ scope: '', declaration: plan.declaration, actionId: event.actionId, eventRefs: [], affected: [], invalidating: true }];
        }
      }
    }
    return [...plans.values()].map((plan) => ({
      scope: '', declaration: plan.declaration, actionId: event.actionId, eventRefs: []                                    , affected: [], invalidating: true,
    }));
  }
  const eventTypeEntity = classifyEntityName(event.type);
  const anchorPlan = plans.get(handle.entity);
  const isAnchorEvent = anchorPlan !== undefined && eventTypeEntity === handle.entity;

  // --- declared routing facts (cross-exam 2 / FIX 2) --------------------------
  // A custom event (code.merged, artefact.transcript.linked, ...) carries a
  // `compositeRouting` declaration from its action's private fact. When the
  // declaration FULLY validates — every fact names a known declaration, a
  // concrete scope, and a concrete row id, and all facts resolve inside THIS
  // event's scope — the declared entries replace the generic invalidation.
  // Any partial/invalid declaration invalidates instead: declared-but-broken
  // is worse than undeclared, because it looks authoritative while guessing.
  let factsUsable = false;
  if (!isAnchorEvent && event.declaredRoutingFacts !== undefined && event.declaredRoutingFacts.length > 0) {
    // Scope-membership check (re-review GAP 2): every fact's scope must
    // resolve to a scope of ITS OWN declared declaration — otherwise the fact
    // routes a custom event to an unrelated composite while suppressing the
    // generic invalidation. A fact scoped to another declaration is valid ONLY
    // when that declaration genuinely owns the scope.
    const allResolved = event.declaredRoutingFacts.every((fact) => {
      if (typeof fact.declaration !== 'string' || !plans.has(fact.declaration)) return false;
      if (typeof fact.scope !== 'string' || fact.scope.length === 0) return false;
      if (typeof fact.id !== 'string' || fact.id.length === 0) return false;
      const factHandle = tryParseScopeKey(fact.scope);
      // The fact's scope MUST belong to the fact's own declaration: routing a
      // Project-projected effect into a Code:... scope (or any unrelated
      // scope) would disclose/mutate state outside the declared projection.
      if (!factHandle || factHandle.entity !== fact.declaration) return false;
      // Entity + branch must exist in the COMPILED plan for that declaration
      // (re-review GAP 2): a forged fact naming an unprojected entity or an
      // unknown branch must neither route nor suppress invalidation.
      const factPlan = plans.get(fact.declaration);
      if (!factPlan) return false;
      const factEntity = String(fact.entity ?? fact.declaration);
      const entityIsAnchor = factEntity === factPlan.declaration;
      const entityBranches = branchesForEntity(factPlan, factEntity);
      // The fact's ENTITY must actually be projected by the declaration — as
      // the anchor or via some relation branch.
      if (!entityIsAnchor && entityBranches.length === 0) return false;
      // The fact's BRANCH must BELONG to that entity (re-review round 4, GAP B):
      //   - branch omitted → defaults to 'anchor', valid ONLY for anchor-entity
      //     facts; a relation-entity fact without a branch is ambiguous and is
      //     rejected rather than guessed.
      //   - an explicit branch must be one whose relation targets exactly this
      //     entity. {entity:'Code', branch:'users'} passes neither check when
      //     'users' is a different entity's branch.
      const explicitBranch = typeof fact.branch === 'string' ? fact.branch : null;
      if (explicitBranch === null) {
        if (!entityIsAnchor) return false;
      } else if (explicitBranch === 'anchor') {
        if (!entityIsAnchor) return false;
      } else {
        const owningBranches = entityBranches.filter((branch) => branch.branchId === explicitBranch);
        if (owningBranches.length === 0) return false;
      }
      return true;
    });
    if (allResolved) {
      for (const fact of event.declaredRoutingFacts) {
        add({
          scope: fact.scope          ,
          declaration: fact.declaration          ,
          actionId: event.actionId,
          affected: [{ branch: typeof fact.branch === 'string' ? fact.branch : 'anchor', entity: String(fact.entity ?? fact.declaration), id: String(fact.id), reason: fact.reason ?? 'update' }],
        });
      }
      factsUsable = true;
    }
  }

  // Fan-out helper (re-review GAP 1): EVERY declaration whose compiled plan
  // projects the touched entity — as anchor or as any relation branch — must
  // receive an invalidation, not just the first matching plan.
  const invalidateAllProjectingDeclarations = (touchedEntity               )       => {
    // Application event types may case-differ from the entity name
    // ('code.merged' vs entity 'Code'); match case-insensitively.
    const touchedLower = touchedEntity === null ? null : touchedEntity.toLowerCase();
    for (const plan of plans.values()) {
      // The scope's own anchor declaration is always affected — the event was
      // committed to ITS scope.
      if (plan.declaration === handle.entity) {
        add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
        continue;
      }
      const planLower = plan.declaration.toLowerCase();
      const projectsIt = touchedLower !== null
        && (planLower === touchedLower
            || (touchedEntity !== null && branchesForEntity(plan, touchedEntity).some((branch) => branch.entity.toLowerCase() === touchedLower)));
      if (projectsIt) add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
    }
  };

  if (!anchorPlan && !eventTypeEntity && !factsUsable) {
    // Unclassifiable custom event type on a declared composite scope: the
    // declaration-wide invalidation signal (cross-exam 1). The catch-up path
    // answers any invalidating entry with a full snapshot — never silence —
    // UNLESS fully-validated declared routing facts already routed it (FIX 2).
    // Fan-out covers every declaration projecting this entity.
    invalidateAllProjectingDeclarations(handle.entity);
    return [...entries.values()];
  }
  const classified = classify(event.type);
  if (!classified && !factsUsable) {
    // A recognized-entity event with an unrecognized verb could still touch
    // projected state through application reducers: invalidate every
    // declaration that projects it, never silence, unless validated declared
    // routing facts covered this exact effect.
    invalidateAllProjectingDeclarations(eventTypeEntity ?? handle.entity);
    return [...entries.values()];
  }
  if (!classified) {
    // Declared facts routed this custom event; no lifecycle routing remains.
    return [...entries.values()];
  }
  if (anchorPlan && isAnchorEvent) {
    if (classified.phase === 'created') {
      add({ scope: event.scope, declaration: anchorPlan.declaration, actionId: event.actionId, affected: [{ branch: 'anchor', entity: handle.entity, id: handle.id, reason: 'create' }] });
    } else if (classified.phase === 'removed') {
      // Terminal anchor deletion: existing revoke/deleted handling consumes the
      // tombstone; the journal still records the terminal change so catch-up
      // chains stay continuous.
      add({ scope: event.scope, declaration: anchorPlan.declaration, actionId: event.actionId, affected: [{ branch: 'anchor', entity: handle.entity, id: handle.id, reason: 'remove' }] });
    } else {
      const changed = Object.keys((event                                      ).data ?? {}).filter((field) => field !== 'id');
      const selectedChanged = changed.filter((field) => anchorPlan.anchorSelect.includes(field));
      if (selectedChanged.length > 0) {
        add({ scope: event.scope, declaration: anchorPlan.declaration, actionId: event.actionId, affected: [{ branch: 'anchor', entity: handle.entity, id: handle.id, reason: 'update' }] });
      }
      // An unselected anchor-field update produces no entry: nothing the
      // declaration projects changed (generalizes snapshotEventTouchesComposite).
    }
  }

  // --- tombstone-rule events ----------------------------------------------
  for (const plan of plans.values()) {
    const rule = plan.tombstone;
    if (!rule || rule.entity !== handle.entity) continue;
    if (classified.phase === 'native') continue;
    const afterRow = rowOf(evidence, 'after', rule.entity, (event                               ).data?.id)
      ?? rowOf(evidence, 'before', rule.entity, (event                               ).data?.id);
    if (!afterRow || typeof afterRow[rule.entityId] !== 'string') {
      // Tombstone identity without a readable row: the target scope is unknowable.
      add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
      continue;
    }
    const targetScopeValue = rule.scopeId ? afterRow[rule.scopeId] : null;
    if (rule.scopeId && (typeof targetScopeValue !== 'string' || targetScopeValue.length === 0)) {
      add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
      continue;
    }
    const scope = rule.scopeId ? `${plan.declaration}:${targetScopeValue          }` : `${plan.declaration}:${String(afterRow[rule.entityId])}`;
    const beforeRow = rowOf(evidence, 'before', rule.entity, afterRow.id);
    const hiddenStates = rule.hidden                     ;
    const stateOf = (row                                )                 => row == null ? null : hiddenStates.includes(String(row[rule.state]));
    const hiddenBefore = stateOf(beforeRow);
    const hiddenAfter = stateOf(afterRow);
    if (classified.phase === 'created' || hiddenBefore === false && hiddenAfter === true) {
      // Entering a hidden state.
      add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: 'anchor', entity: String(afterRow[rule.entityId]), id: String(afterRow[rule.entityId]), reason: 'tombstone' }] });
    } else if (classified.phase === 'removed' || hiddenBefore === true && hiddenAfter === false) {
      // Leaving a hidden state (restore) or physical tombstone deletion.
      add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: 'anchor', entity: String(afterRow[rule.entityId]), id: String(afterRow[rule.entityId]), reason: 'tombstone' }] });
    } else {
      // Visibility unchanged (e.g. GC of a visible-era row): an empty entry
      // still advances the composite cursor (design §6, tombstone GC row).
      add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [] });
    }
  }

  // --- member events -------------------------------------------------------
  for (const plan of plans.values()) {
    // Skip only the declaration whose ANCHOR is this event's entity — its
    // anchor routing already happened above. Other declarations that project
    // this entity as a MEMBER branch still get routed here (re-review GAP 1:
    // first-match-wins abolished).
    if (isAnchorEvent && plan.declaration === handle.entity) continue;
    // A DIFFERENT declaration anchored on this same entity: its anchor is
    // touched by this event (re-review GAP 1).
    if (eventTypeEntity !== null && plan.declaration === eventTypeEntity) {
      // The event's OWN row is this plan's anchor row; its identity comes from
      // the payload id and its scope from that same id.
      const rowId = typeof (event                               ).data?.id === 'string'
        ? (event                                       ).data.id
        : null;
      const changed = Object.keys((event                                      ).data ?? {}).filter((field) => field !== 'id');
      const selectedChanged = changed.filter((field) => plan.anchorSelect.includes(field));
      if (rowId !== null) {
        add({
          scope: `${plan.declaration}:${rowId}`,
          declaration: plan.declaration,
          actionId: event.actionId,
          affected: [{ branch: 'anchor', entity: eventTypeEntity, id: rowId, reason: classified.phase === 'created' ? 'create' : classified.phase === 'removed' ? 'remove' : selectedChanged.length > 0 ? 'update' : 'invalidate' }],
          invalidating: classified.phase === 'updated' && selectedChanged.length === 0,
        });
      } else {
        add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
      }
      continue;
    }
    const branches = branchesForEntity(plan, eventTypeEntity ?? '');
    if (branches.length === 0) continue;
    // The changed MEMBER row's identity: the event type names its entity and
    // the payload names its id — NOT the scope handle's id (which is the
    // anchor's for inherited scopes).
    const memberId = typeof (event                               ).data?.id === 'string' ? ((event                                       ).data.id) : null;
    const id = memberId ?? handle.id;

    if (classified.phase === 'removed') {
      // Removal routing needs the pre-image to locate the owning scope; the
      // public event payload ({id}) deliberately cannot provide it.
      const beforeRow = rowOf(evidence, 'before', eventTypeEntity ?? '', id);
      if (!beforeRow) {
        add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
        continue;
      }
      for (const branch of branches) {
        const scopes = parentScopesFor(db, plans, plan, branch, beforeRow);
        if (!scopes) {
          add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
          continue;
        }
        for (const scope of scopes) {
          add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: branch.branchId, entity: eventTypeEntity ?? plan.declaration, id, reason: 'remove' }] });
        }
      }
      continue;
    }

    const afterRow = rowOf(evidence, 'after', eventTypeEntity ?? '', id);
    if (!afterRow) {
      // An upsert/lifecycle mutation whose projected row cannot be read is
      // indistinguishable from a broken projection: invalidate rather than guess.
      const beforeFallback = rowOf(evidence, 'before', handle.entity, id);
      if (beforeFallback) {
        for (const branch of branches) {
          const scopes = parentScopesFor(db, plans, plan, branch, beforeFallback);
          for (const scope of scopes ?? []) {
            add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: branch.branchId, entity: eventTypeEntity ?? plan.declaration, id, reason: 'invalidate' }], invalidating: true });
          }
        }
      }
      add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
      continue;
    }

    for (const branch of branches) {
      const scopes = parentScopesFor(db, plans, plan, branch, afterRow);
      if (!scopes) {
        add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
        continue;
      }
      const changed = Object.keys((event                                      ).data ?? {}).filter((field) => field !== 'id');
      const relevant = new Set        ([...branch.selected, ...branch.nestedSelect]);
      if (branch.order) relevant.add(branch.order.field);
      if (branch.require) relevant.add(branch.require.childRef);

      for (const scope of scopes) {
        if (classified.phase === 'created') {
          add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: branch.branchId, entity: eventTypeEntity ?? plan.declaration, id, reason: 'create' }] });
          continue;
        }
        // updated / native
        const touched = changed.filter((field) => relevant.has(field));
        const beforeRowForCompare = rowOf(evidence, 'before', eventTypeEntity ?? '', id);
        const reparenting = branch.inverse
          && changed.includes(branch.fk)
          && beforeRowForCompare !== null
          && beforeRowForCompare[branch.fk] !== afterRow[branch.fk];
        if (reparenting) {
          const beforeRow = beforeRowForCompare;
          const previousParent = beforeRow ? beforeRow[branch.fk] : undefined;
          if (typeof previousParent !== 'string' || previousParent.length === 0) {
            // The old placement is unknowable from private evidence: the old
            // scope's removal cannot be proven — declaration-wide resync.
            add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
            continue;
          }
          const oldScope = `${plan.declaration}:${previousParent}`;
          add({ scope: oldScope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: branch.branchId, entity: eventTypeEntity ?? plan.declaration, id, reason: 'reparent' }] });
          if (oldScope !== scope) {
            add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: branch.branchId, entity: eventTypeEntity ?? plan.declaration, id, reason: 'reparent' }] });
          } else {
            // Same-parent fk rewrite still replaces branch membership ordering.
            add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: branch.branchId, entity: eventTypeEntity ?? plan.declaration, id, reason: 'order' }] });
          }
          continue;
        }
        if (touched.length > 0) {
          const reason = branch.order && touched.includes(branch.order.field) ? 'order' : 'update';
          add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: branch.branchId, entity: eventTypeEntity ?? plan.declaration, id, reason }] });
        }
        // Native annotated-text edits touch no selected field of any branch:
        // they produce no entry (the exact gate snapshotEventTouchesComposite
        // implements today, derived from the plan instead).
      }
    }
  }

  // Required-relation exposure changes: a related row appearing or disappearing
  // admits/denies every child pointing at it through the branch requirement.
  for (const plan of plans.values()) {
    if (classified.phase === 'native') continue;
    const relatedBranches = branchesForRelatedEntity(plan, handle.entity);
    for (const { branch } of relatedBranches) {
      const require = branch.require ;
      const row = rowOf(evidence, 'after', handle.entity, handle.id) ?? rowOf(evidence, 'before', handle.entity, handle.id);
      if (!row) {
        add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
        continue;
      }
      // Children admitted through this related row live in its parent's scope.
      const parentId = row[require.fk];
      if (typeof parentId !== 'string' || parentId.length === 0) {
        add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
        continue;
      }
      const scope = `${plan.declaration}:${parentId}`;
      const childRows = db.prepare(`SELECT id FROM ${branch.entity} WHERE ${require.childRef.replace(/[^A-Za-z0-9_]/g, '')} = ?`).all(row.id);
      for (const child of childRows) {
        add({
          scope, declaration: plan.declaration, actionId: event.actionId,
          affected: [{ branch: branch.branchId, entity: branch.entity, id: String(child.id), reason: classified.phase === 'removed' ? 'remove' : 'update' }],
        });
      }
    }
  }

  // --- declared routing facts (cross-exam 2) ---------------------------------
  // Custom application events (code.merged, artefact.transcript.linked, ...)
  // carry no lifecycle suffix and no data.id. Registered actions declare their
  // touched rows through the EXISTING privateFact seam: a `compositeRouting`
  // block on the action's private fact lists (entity, id) pairs the journal
  // can trust. Facts arrive via pipeline as `declaredFacts`.
  for (const fact of event.declaredRoutingFacts ?? []) {
    const plan = typeof fact.declaration === 'string' ? plans.get(fact.declaration) : undefined;
    if (!plan) continue; // fact names an entity no composite declares
    if (!fact.scope || typeof fact.scope !== 'string') {
      add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
      continue;
    }
    add({
      scope: fact.scope,
      declaration: plan.declaration,
      actionId: event.actionId,
      affected: [{ branch: fact.branch ?? 'anchor', entity: String(fact.entity ?? plan.declaration), id: String(fact.id ?? ''), reason: fact.reason ?? 'update' }],
      invalidating: fact.invalidating === true,
    });
  }

  // --- authorization-dependency invalidation (cross-exam 3/9) ----------------
  // Grant/membership-table changes are not row-relation changes: no compiled
  // branch covers them, yet they can revoke or admit ANY row in the scope.
  // The pipeline supplies `authorizationSensitive` when the changed entity is
  // a declared authorization dependency. Invalidate the whole declaration.
  if (event.authorizationSensitive && anchorPlan && isAnchorEvent) {
    // Membership change on the ANCHOR scope itself.
    add({ scope: event.scope, declaration: anchorPlan.declaration, actionId: event.actionId, affected: [], invalidating: true });
  } else if (event.authorizationSensitive) {
    for (const plan of plans.values()) {
      if (eventTypeEntity !== null && branchesForEntity(plan, eventTypeEntity).length > 0) {
        add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
      }
    }
  }

  return [...entries.values()];
}





function branchesForRelatedEntity(plan                 , entity        )               {
  const hits               = [];
  const visit = (relations                              )       => {
    for (const relation of relations) {
      if (relation.require && relation.require.entity === entity) hits.push({ branch: relation });
      visit(relation.children);
    }
  };
  visit(plan.relations);
  return hits;
}

// ---- write ----

/**
 * Record composite change entries inside the caller's open transaction,
 * immediately after the action's events are appended. Atomic with _Log and
 * _ActionReceipt: the per-scope counter bump and every entry commit together
 * or not at all (design §3).
 */
export function recordCompositeChanges(db          , inputs                                 , committedAt        )       {
  if (inputs.length === 0) return;
  const insertCounter = prepareCached(db,
    'INSERT INTO _CompositeChangeCursor (scope, lastSeq) VALUES (:scope, 0) ON CONFLICT(scope) DO NOTHING',
  );
  const readCounter = prepareCached(db, 'SELECT lastSeq AS last FROM _CompositeChangeCursor WHERE scope = :scope');
  const bumpCounter = prepareCached(db, 'UPDATE _CompositeChangeCursor SET lastSeq = :next WHERE scope = :scope');
  const insertChange = prepareCached(db,
    `INSERT INTO _CompositeChange (scope, seq, declaration, actionId, eventRefs, affected, invalidating, committedAt)
     VALUES (:scope, :seq, :declaration, :actionId, :eventRefs, :affected, :invalidating, :committedAt)`,
  );
  for (const input of inputs) {
    let seq        ;
    if (input.scope === '') {
      // Declaration-wide invalidations live on their own per-declaration
      // sequence, so a recipient cursor can order against them.
      seq = bumpDeclarationWideSeq(db);
    } else {
      insertCounter.run({ scope: input.scope });
      seq = (readCounter.get({ scope: input.scope })                    ).last + 1;
      bumpCounter.run({ scope: input.scope, next: seq });
    }
    insertChange.run({
      scope: input.scope,
      seq,
      declaration: input.declaration,
      actionId: input.actionId,
      eventRefs: JSON.stringify(input.eventRefs),
      affected: JSON.stringify(input.affected),
      invalidating: input.invalidating ? 1 : 0,
      committedAt,
    });
  }
}

// ---- read ----

/**
 * Retained composite changes for one scope with seq > after, ordered by seq.
 * At most `limit` rows are returned — a result of exactly `limit` rows means
 * the caller must treat the slice as OVERFLOWING and fall back to a snapshot
 * rather than materialize an unbounded replay (cross-exam 7). Catch-up replays
 * THESE rows, never raw _Log rows (design §10).
 */
export function readCompositeChangesSince(db          , scope        , after        , limit = 500)                          {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive safe integer');
  const rows = prepareCached(db,
    'SELECT * FROM _CompositeChange WHERE scope = :scope AND seq > :after ORDER BY seq LIMIT :limit',
  ).all({ scope, after, limit })                                  ;
  return rows.map(parseChangeRow);
}

/**
 * Declaration-wide invalidating entries (stored under scope '') affecting the
 * given declaration above `after`. These apply to EVERY composite scope of the
 * declaration — per-scope catch-up must merge them into its slice.
 */
export function readDeclarationWideChangesSince(db          , declaration        , after        )                          {
  const rows = prepareCached(db,
    "SELECT * FROM _CompositeChange WHERE scope = '' AND declaration = :declaration AND seq > :after ORDER BY seq",
  ).all({ declaration, after })                                  ;
  return rows.map(parseChangeRow);
}

// The single wide-counter key shared by bump + read (re-review round 4, GAP A:
// writer and reader MUST agree or the read always returns 0).
const WIDE_SEQ_KEY = '\u0000wide';

/**
 * Sequence for declaration-wide entries: ONE global counter (keyed
 * `'\u0000wide'` in the same cursor table) so wide entries — which all share
 * the synthetic scope '' — never collide on the (scope, seq) primary key,
 * while still giving every recipient cursor a monotonic axis to order against.
 */
function bumpDeclarationWideSeq(db          )         {
  const key = WIDE_SEQ_KEY;
  prepareCached(db,
    "INSERT INTO _CompositeChangeCursor (scope, lastSeq) VALUES (:scope, 0) ON CONFLICT(scope) DO NOTHING",
  ).run({ scope: key });
  const next = (db.prepare('SELECT lastSeq AS last FROM _CompositeChangeCursor WHERE scope = :scope').get({ scope: key })                    ).last + 1;
  db.prepare('UPDATE _CompositeChangeCursor SET lastSeq = :next WHERE scope = :scope').run({ scope: key, next });
  return next;
}

/** Oldest retained composite seq for a scope, or null when none exist. */
export function minCompositeSeq(db          , scope        )                {
  const row = db.prepare('SELECT MIN(seq) AS min FROM _CompositeChange WHERE scope = :scope').get({ scope })                          ;
  return row?.min ?? null;
}

/** Current declaration-wide sequence (global wide-invalidation counter). */
export function currentDeclarationWideSeq(db          )         {
  const row = db.prepare('SELECT lastSeq AS last FROM _CompositeChangeCursor WHERE scope = :scope').get({ scope: WIDE_SEQ_KEY })                                ;
  return row?.last ?? 0;
}

/** Current composite sequence for a scope (the `composite` cursor component). */
export function currentCompositeSeq(db          , scope        )         {
  const row = db.prepare('SELECT lastSeq AS last FROM _CompositeChangeCursor WHERE scope = :scope').get({ scope })                                ;
  return row?.last ?? 0;
}

function parseChangeRow(row                         )                        {
  return Object.freeze({
    scope: row.scope          ,
    seq: row.seq          ,
    declaration: row.declaration          ,
    actionId: row.actionId          ,
    eventRefs: JSON.parse(row.eventRefs          ),
    affected: JSON.parse(row.affected          ),
    invalidating: row.invalidating === 1,
  });
}

/**
 * Journal retention follows _Log retention exactly: receipts may reference
 * either journal, so both must fall back to snapshot recovery together
 * (design §14, Retention).
 */
export function pruneCompositeChanges(db          , cutoffIso        )       {
  db.prepare('DELETE FROM _CompositeChange WHERE committedAt < :cutoff').run({ cutoff: cutoffIso });
}
