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



// A compiled relation branch, flattened depth-first. Paths are OUTPUT paths
// (declaration keys), not storage columns: ["codes", "entries"] means the
// `entries` relation nested inside the `codes` relation of the anchor output.










































                                                                          





















function relationFrom(entry               , parentEntity        , parentBranchId        , path                   , branchId        )                    {
  const nestedEntries = entry.nested?.entries ?? [];
  const nestedSelectEntry = nestedEntries.find((candidate) => candidate.kind === 'select');
  const children                      = [];
  if (entry.nested) {
    for (const nestedEntry of nestedEntries) {
      if (nestedEntry.kind === 'select') continue;
      children.push(relationFrom(
        nestedEntry,
        entry.entity?.name          ,
        branchId,
        [...path, nestedEntry.key          ],
        `${branchId}.${nestedEntry.key          }`,
      ));
    }
  }
  return Object.freeze({
    branchId,
    path,
    parentEntity,
    parentBranchId,
    entity: entry.entity?.name          ,
    kind: entry.kind                             ,
    fk: entry.fk          ,
    inverse: Boolean(entry.inverse),
    selected: Object.freeze([...(entry.selected ?? [])]),
    nestedSelect: Object.freeze([...(nestedSelectEntry?.fields ?? [])]),
    order: entry.order ? Object.freeze({ field: entry.order.field          , direction: entry.order.direction           }) : null,
    require: entry.require
      ? Object.freeze({
        entity: entry.require.entity?.name          ,
        childRef: entry.require.childRef          ,
        fk: entry.require.fk          ,
      })
      : null,
    children: Object.freeze(children),
  });
}

// FNV-1a over the canonical plan description: a stable, dependency-free
// declaration-version fingerprint for projection-token binding. Uses a
// self-contained canonicalizer (the shared canonical-json module rejects
// non-plain values, which hand-bound test entities can legitimately carry).
function planVersion(plan                                  )         {
  const describe = (relation                   )                          => ({
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
  const canonical = (value         )         => {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (typeof value === 'object') {
      const names = Object.keys(value                           ).sort();
      return `{${names.map((name) => `${JSON.stringify(name)}:${canonical((value                           )[name])}`).join(',')}}`;
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
export function compileAnchorPatchPlan(declaration                     )                  {
  const branch = declaration.output                             ;
  const anchorName = branch.entity?.name          ;
  const anchorSelectEntry = (branch.entries ?? []).find((entry) => entry.kind === 'select');
  const relations                      = [];
  for (const entry of branch.entries ?? []) {
    if (entry.kind === 'select') continue;
    relations.push(relationFrom(entry, anchorName, 'anchor', [entry.key          ], entry.key          ));
  }
  const tombstone = declaration.tombstone                                        ;
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
export function compilePatchPlans(composites                                         )                                       {
  const plans = new Map                         ();
  for (const [name, declaration] of composites) plans.set(name, compileAnchorPatchPlan(declaration));
  return plans;
}

/**
 * Ledger address key for one delivered fragment (#157): branch identity plus
 * entity plus row id. The value is the fragment's keyed-ancestor member chain
 * — the provable pre-state placement removals under keyed ancestors need.
 * Shared by the projector (writer + reader) so the encoding has one home.
 */
export function compositeFragmentAddressKey(branchId        , entity        , id        )         {
  return `${branchId}\u0000${entity}\u0000${id}`;
}
