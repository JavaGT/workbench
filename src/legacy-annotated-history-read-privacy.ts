// Legacy annotated-text history read-privacy isolation (scope#992 rev 3 §3).
//
// This module is the ONLY home of retained legacy action-name/entity/event-ref
// scanning that keeps annotated-text scopes out of public history reads. It is
// a VOID-only capability: it returns `void` or throws `forbidden()`. It exports
// no booleans, no receipt classifier, no eligibility or barrier value, no
// parsed receipt, and no fact. It therefore cannot be (re)used by movement
// code for eligibility, target selection, retries, or compensation.
//
// Import boundary (enforced by scripts/check-annotated-text-single-authority.mjs
// and rev 3 §3):
//   - only src/history-read.ts (and its direct focused test) may import this
//     module;
//   - only the actions()/events() read functions may call it;
//   - durable-history.ts, contribution-policy modules, cursor modules,
//     pipeline, and kernel must contain no import or reference to this module
//     or to the retired history-read scanners (which live only here).

import { tryParseScopeKey } from './scope-handle.ts';
import type { DbHandle } from './driver.ts';
import { forbidden } from './outcome.ts';

function parseJson(value: unknown, fallback: unknown): unknown {
  if (value == null) return fallback;
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return fallback; }
}

interface ReceiptRowLike {
  scope?: unknown;
  actionType?: unknown;
  actionData?: unknown;
  eventRefs?: unknown;
}

/**
 * Fail closed a public history read when the scope is (or ever contained)
 * annotated-text material. `privateHistoryScopes` is the frozen declaration-
 * derived set of annotated entity names; legacy action-type and event-ref
 * scanning over retained receipts is retained here so older receipts continue
 * to deny reads. Returns void on success; throws `forbidden()` otherwise.
 * This produces no policy decision.
 */
export function assertLegacyAnnotatedHistoryReadable(
  db: DbHandle,
  scope: string,
  privateHistoryScopes: ReadonlySet<string>,
): void {
  const handle = tryParseScopeKey(scope);
  if (handle && privateHistoryScopes.has(handle.entity)) throw forbidden('history.forbidden', 'history.forbidden');

  // Legacy receipt scanning: a receipt is annotated when it is a native
  // annotated action, a batch containing one, or its event refs reference an
  // annotated scope. This is read-denial only.
  const receipts = db.prepare(
    'SELECT scope, actionType, actionData, eventRefs FROM _ActionReceipt WHERE scope = :scope',
  ).all({ scope }) as ReceiptRowLike[];
  for (const receipt of receipts) {
    if (receiptIsAnnotated(receipt, privateHistoryScopes)) throw forbidden('history.forbidden', 'history.forbidden');
  }
}

function receiptIsAnnotated(receipt: ReceiptRowLike, privateHistoryScopes: ReadonlySet<string>): boolean {
  if (typeof receipt.actionType === 'string') {
    if (receipt.actionType === '$batch') {
      const actions = parseJson(receipt.actionData, null) as { actions?: unknown } | { type?: unknown }[] | null;
      const listed = Array.isArray(actions) ? actions
        : Array.isArray((actions as { actions?: unknown } | null)?.actions) ? (actions as { actions: unknown[] }).actions : [];
      if (listed.some((action) => action && typeof action === 'object'
        && typeof (action as { type?: unknown }).type === 'string'
        && annotatedActionType((action as { type: string }).type, privateHistoryScopes))) {
        return true;
      }
    } else if (annotatedActionType(receipt.actionType, privateHistoryScopes)) {
      return true;
    }
  }
  const refs = parseJson(receipt.eventRefs, null);
  if (!Array.isArray(refs)) return true;
  return refs.some((ref) => !!ref && typeof ref === 'object'
    && typeof (ref as { scope?: unknown }).scope === 'string'
    && annotatedScope((ref as { scope: string }).scope, privateHistoryScopes));
}

function annotatedActionType(actionType: string, privateHistoryScopes: ReadonlySet<string>): boolean {
  // A native annotated action is `<Entity>.<field>.operation`. Deny only when
  // the entity is a declaration-derived annotated scope.
  const operator = actionType.lastIndexOf('.', actionType.lastIndexOf('.') - 1);
  const entity = operator > 0 ? actionType.slice(0, operator) : actionType.split('.')[0];
  return privateHistoryScopes.has(entity) && actionType.endsWith('.operation');
}

function annotatedScope(scope: string, privateHistoryScopes: ReadonlySet<string>): boolean {
  const handle = tryParseScopeKey(scope);
  return !!handle && privateHistoryScopes.has(handle.entity);
}
