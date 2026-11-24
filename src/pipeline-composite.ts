// Composite-journal evidence capture and routing (#122). Runs inside the
// origin transaction, atomically with _Log and _ActionReceipt.

import type { DbHandle } from './driver.ts';
import { routeCompositeEvent, recordCompositeChanges, type CompositeChangeInput } from './composite-journal.ts';
import type { CompositeEvidence, CompositeJournalConfig } from './pipeline-event-core.ts';

export function captureCompositeBeforeEvidence(
  db: DbHandle,
  finalizedEvents: any[],
  compositeJournal: CompositeJournalConfig | undefined,
): CompositeEvidence | null {
  if (compositeJournal === undefined || !finalizedEvents.some((e) => e?.handle)) return null;
  const evidence: CompositeEvidence = { before: new Map(), after: new Map() };
  for (const ev of finalizedEvents) {
    const entityName: string | undefined = ev?.handle?.entity;
    const rowId: unknown = ev?.data?.id;
    if (!entityName || typeof rowId !== 'string') continue;
    if (!/\.updated$|\.removed$/.test(ev.type)) continue;
    try {
      const row = db.prepare(`SELECT * FROM ${entityName} WHERE id = ?`).get(rowId) as Record<string, unknown> | undefined;
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
  db: DbHandle,
  finalizedEvents: any[],
  compositeJournal: CompositeJournalConfig,
  compositeEvidence: CompositeEvidence | null,
  { actionId, now, privateFact }: { actionId: string; now: string; privateFact: unknown },
) {
  const plans = compositeJournal.plans as ReadonlyMap<string, import('./composite-patch-plan.ts').AnchorPatchPlan>;
  const evidence: CompositeEvidence = compositeEvidence ?? { before: new Map(), after: new Map() };
  for (const ev of finalizedEvents) {
    const entityName: string | undefined = ev?.handle?.entity;
    const rowId: unknown = ev?.data?.id;
    if (!entityName || typeof rowId !== 'string') continue;
    if (!/\.created$|\.updated$/.test(ev.type)) continue;
    try {
      const row = db.prepare(`SELECT * FROM ${entityName} WHERE id = ?`).get(rowId) as Record<string, unknown> | undefined;
      if (row) {
        let rows = evidence.after.get(entityName);
        if (!rows) evidence.after.set(entityName, rows = new Map());
        rows.set(String(rowId), { ...row });
      }
    } catch {
      // Absent table/row: the router invalidates on missing evidence.
    }
  }
  const inputs: CompositeChangeInput[] = [];
  // Declared routing facts (cross-exam 2): registered actions may declare
  // touched rows via a `compositeRouting` block on their private fact —
  // at the fact's top level or inside its `after` half (the canonical
  // {before, after} shape).
  let declaredRoutingFacts: import('./composite-journal.ts').DeclaredRoutingFact[] | undefined;
  {
    const fact = privateFact as Record<string, unknown> | undefined;
    const candidates: unknown[] = [fact];
    if (fact && typeof fact === 'object') {
      candidates.push((fact as { application?: unknown }).application);
      const after = (fact as { after?: unknown }).after;
      candidates.push(after);
      if (after && typeof after === 'object' && (after as { application?: unknown }).application !== undefined) {
        candidates.push((after as { application?: unknown }).application);
      }
    }
    for (const source of candidates) {
      const block = source && typeof source === 'object' ? (source as { compositeRouting?: unknown }).compositeRouting : undefined;
      if (Array.isArray(block)) {
        declaredRoutingFacts = block.filter((entry) => entry !== null && typeof entry === 'object') as import('./composite-journal.ts').DeclaredRoutingFact[];
        break;
      }
    }
  }
  for (const ev of finalizedEvents) {
    for (const entry of routeCompositeEvent(
      db,
      plans,
      {
        type: ev.type as string,
        scope: ev.scope as string,
        seq: ev.seq as number,
        actionId,
        data: (ev as { data?: Record<string, unknown> }).data,
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
      const depEntity: string | undefined = ev?.handle?.entity;
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
