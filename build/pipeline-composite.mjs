// Composite-journal evidence capture and routing (#122). Runs inside the
// origin transaction, atomically with _Log and _ActionReceipt.


import { routeCompositeEvent, recordCompositeChanges,                           } from './composite-journal.mjs';


export function captureCompositeBeforeEvidence(
  db          ,
  finalizedEvents       ,
  compositeJournal                                    ,
)                           {
  if (compositeJournal === undefined || !finalizedEvents.some((e) => e?.handle)) return null;
  const evidence                    = { before: new Map(), after: new Map() };
  for (const ev of finalizedEvents) {
    const entityName                     = ev?.handle?.entity;
    const rowId          = ev?.data?.id;
    if (!entityName || typeof rowId !== 'string') continue;
    if (!/\.updated$|\.removed$/.test(ev.type)) continue;
    try {
      const row = db.prepare(`SELECT * FROM ${entityName} WHERE id = ?`).get(rowId)                                       ;
      if (row) {
        let rows = evidence.before.get(entityName);
        if (!rows) evidence.before.set(entityName, rows = new Map());
        rows.set(String(rowId), { ...row });
      }
    } catch {
      // No such table: the router invalidates on missing evidence instead of guessing.
    }
  }
  return evidence;
}

export function recordCompositeJournalEvidence(
  db          ,
  finalizedEvents       ,
  compositeJournal                        ,
  compositeEvidence                          ,
  { actionId, now, privateFact }                                                         ,
) {
  const plans = compositeJournal.plans                                                                            ;
  const evidence                    = compositeEvidence ?? { before: new Map(), after: new Map() };
  for (const ev of finalizedEvents) {
    const entityName                     = ev?.handle?.entity;
    const rowId          = ev?.data?.id;
    if (!entityName || typeof rowId !== 'string') continue;
    if (!/\.created$|\.updated$/.test(ev.type)) continue;
    try {
      const row = db.prepare(`SELECT * FROM ${entityName} WHERE id = ?`).get(rowId)                                       ;
      if (row) {
        let rows = evidence.after.get(entityName);
        if (!rows) evidence.after.set(entityName, rows = new Map());
        rows.set(String(rowId), { ...row });
      }
    } catch {
      // Absent table/row: the router invalidates on missing evidence.
    }
  }
  const inputs                         = [];
  // Declared routing facts (cross-exam 2): registered actions may declare
  // touched rows via a `compositeRouting` block on their private fact —
  // at the fact's top level or inside its `after` half (the canonical
  // {before, after} shape).
  let declaredRoutingFacts                                                                    ;
  {
    const fact = privateFact                                       ;
    const candidates            = [fact];
    if (fact && typeof fact === 'object') {
      candidates.push((fact                             ).application);
      const after = (fact                       ).after;
      candidates.push(after);
      if (after && typeof after === 'object' && (after                             ).application !== undefined) {
        candidates.push((after                             ).application);
      }
    }
    for (const source of candidates) {
      const block = source && typeof source === 'object' ? (source                                  ).compositeRouting : undefined;
      if (Array.isArray(block)) {
        declaredRoutingFacts = block.filter((entry) => entry !== null && typeof entry === 'object')                                                          ;
        break;
      }
    }
  }
  for (const ev of finalizedEvents) {
    for (const entry of routeCompositeEvent(
      db,
      plans,
      {
        type: ev.type          ,
        scope: ev.scope          ,
        seq: ev.seq          ,
        actionId,
        data: (ev                                      ).data,
        declaredRoutingFacts: declaredRoutingFacts ?? [],
      },
      evidence,
    )) {
      inputs.push({ ...entry, actionId });
    }
  }
  // Authorization-dependency invalidation (cross-exam 3/9): a committed
  // change to a declared grant/membership entity can flip ANY row's
  // admission in affected scopes — record an explicit invalidating entry.
  const authDeps = compositeJournal.authorizationDependencies;
  if (authDeps !== undefined && authDeps.length > 0) {
    for (const ev of finalizedEvents) {
      const depEntity                     = ev?.handle?.entity;
      if (!depEntity || !authDeps.includes(depEntity)) continue;
      for (const plan of plans.values()) {
        const scopeEntityName = plan.declaration;
        const isAnchorScopeEvent = ev.scope.startsWith(`${scopeEntityName}:`);
        inputs.push({
          scope: isAnchorScopeEvent ? ev.scope : '',
          declaration: scopeEntityName,
          actionId,
          eventRefs: [{ scope: ev.scope, seq: ev.seq }],
          affected: [],
          invalidating: true,
        });
      }
    }
  }
  recordCompositeChanges(db, inputs, now);
}
