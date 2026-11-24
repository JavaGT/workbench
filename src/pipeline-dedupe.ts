// Idempotency decisions for the (scope, actionId) identity. The pre-handler
// check and the in-txn recheck share the same decision functions.

import { receiptFor, eventsFromReceipt, noHistoryReceiptFor } from './committed-log.ts';
import { parseEventType } from './event-handle.ts';
import { canonicalStringify } from './canonical-json.ts';
import { isPlainObject } from './field-strategy.ts';
import { failure, failureOutcome } from './outcome.ts';
import type { DbHandle } from './driver.ts';
import { successOutcome } from './pipeline-outcomes.ts';
import { eventWithParsedHandle } from './pipeline-event-core.ts';

// In-memory dedupe mirrors the durable `(scope, actionId)` receipt identity.
export function checkInMemoryDedupe(dispatched: Map<string, Map<string, unknown>>, scope: string, actionId: string) {
  const scoped = dispatched.get(scope);
  if (!scoped?.has(actionId)) return null;
  return successOutcome(scoped.get(actionId), true);
}

export function recordInMemoryDispatch(dispatched: Map<string, Map<string, unknown>>, scope: string, actionId: string, events: unknown) {
  let scoped = dispatched.get(scope);
  if (!scoped) {
    scoped = new Map();
    dispatched.set(scope, scoped);
  }
  scoped.set(actionId, events);
}

// Durable dedupe: returns successOutcome when the actionId receipt exists,
// or null for a fresh action. Handlers with private receipts can require an
// exact request match before their resultData is replayed.
function checkDurableDedupe(db: unknown, scope: string, actionId: string, request: any, receiptMatches?: (receipt: any, request: any) => boolean) {
  const receipt = receiptFor(db as DbHandle, scope, actionId);
  if (!receipt) return null;
  if (receiptMatches && !receiptMatches(receipt, request)) {
    return failureOutcome(failure('conflict', 'Action ID is already committed for a different request.'));
  }
  return Object.freeze({ ...successOutcome(eventsFromReceipt(db as DbHandle, receipt, parseEventType), true), resultData: receipt.resultData });
}

function checkDurableBatchDedupe(db: unknown, scope: string, actionId: string, actions: any[]) {
  const receipt = receiptFor(db as DbHandle, scope, actionId);
  if (!receipt) return null;
  if (receipt.actionType !== '$batch' || receipt.actionData !== canonicalStringify(actions)) {
    return failureOutcome(failure('conflict', 'Action ID is already committed for a different batch.'));
  }
  return Object.freeze({ ...successOutcome(eventsFromReceipt(db as DbHandle, receipt, parseEventType), true), resultData: receipt.resultData });
}

// Mixed-tier commits have both receipts: the durable receipt replays its _Log
// events while its internal replay metadata carries the live events (which must
// not enter _Log). Reassemble them at their original emission indexes only when
// both receipts prove the whole action committed.
function checkMixedDedupe(db: unknown, scope: string, actionId: string, request: unknown, receiptMatches?: (receipt: any, request: any) => boolean) {
  const durableReceipt = receiptFor(db as DbHandle, scope, actionId);
  const liveReceipt = noHistoryReceiptFor(db as DbHandle, scope, actionId);
  if (!durableReceipt || !liveReceipt) return null;
  if (receiptMatches && !receiptMatches(durableReceipt, request)) {
    return failureOutcome(failure('conflict', 'Action ID is already committed for a different request.'));
  }
  const replay = isPlainObject(durableReceipt.resultData)
    ? (durableReceipt.resultData as Record<string, unknown>).__workbenchMixedReplay
    : undefined;
  if (!isPlainObject(replay)
    || !Array.isArray(replay.durableIndexes)
    || !Array.isArray(replay.liveIndexes)
    || !Array.isArray(replay.liveEvents)) return null;
  const durableEvents = eventsFromReceipt(db as DbHandle, durableReceipt, parseEventType);
  const events: any[] = [];
  for (let index = 0; index < replay.durableIndexes.length; index += 1) {
    events[replay.durableIndexes[index] as number] = durableEvents[index];
  }
  for (let index = 0; index < replay.liveIndexes.length; index += 1) {
    events[replay.liveIndexes[index] as number] = eventWithParsedHandle(replay.liveEvents[index]);
  }
  return Object.freeze({
    ...successOutcome(events, true),
    resultData: replay.resultData,
  });
}

// No-history lane dedupe (S3/A2): a retried (scope, actionId) reads its
// minimized `_NoHistoryReceipt` and settles to the same outcome WITHOUT a
// second apply. There are no stored events to replay — the no-history receipt
// carries none by design — so the retry returns an empty event set plus the
// receipt's committed revision as resultData.
function checkLiveDedupe(db: unknown, scope: string, actionId: string) {
  const receipt = noHistoryReceiptFor(db as DbHandle, scope, actionId);
  if (!receipt) return null;
  return Object.freeze({
    ...successOutcome([], true),
    resultData: Object.freeze({ actionId, resourceKey: receipt.resourceKey, committedRevision: receipt.committedRevision }),
  });
}

// The full dedupe decision for one (scope, actionId), shared by the pre-handler
// check AND the in-transaction recheck. Two concurrent retries can both pass the
// pre-handler check before either commits; the serialized transaction re-runs
// this exact decision so the loser settles to the winner's stored outcome instead
// of colliding on the (scope, actionId) receipt PK.
export function singleDispatchDedupe(db: unknown, { scope, actionId, request, receiptMatches, livePipeline }: {
  scope: string;
  actionId: string;
  request: any;
  receiptMatches?: (receipt: any, request: any) => boolean;
  livePipeline?: any;
}) {
  const mixed = livePipeline ? checkMixedDedupe(db, scope, actionId, request, receiptMatches) : null;
  if (mixed) return mixed;
  const durable = checkDurableDedupe(db, scope, actionId, request, receiptMatches);
  if (durable) return durable;
  if (livePipeline) {
    const live = checkLiveDedupe(db, scope, actionId);
    if (live) return live;
  }
  return null;
}

export function batchDispatchDedupe(db: unknown, { scope, actionId, actions, livePipeline }: {
  scope: string;
  actionId: string;
  actions: any[];
  livePipeline?: any;
}) {
  const mixed = livePipeline
    ? checkMixedDedupe(db, scope, actionId, actions, (receipt, retryActions) =>
      receipt.actionType === '$batch' && receipt.actionData === canonicalStringify(retryActions))
    : null;
  if (mixed) return mixed;
  const durable = checkDurableBatchDedupe(db, scope, actionId, actions);
  if (durable) return durable;
  if (livePipeline) {
    const live = checkLiveDedupe(db, scope, actionId);
    if (live) return live;
  }
  return null;
}

// The stable event handle for tier routing. A handler-emitted event may be a
// raw `{ type, ... }` with no attached handle — parse it; an unparseable type
// yields undefined (treated as the durable lane, i.e. no live routing).
export function handleOfEvent(event: any): any {
  if (event?.handle?.brand === 'event-handle') return event.handle;
  try {
    return parseEventType(event.type);
  } catch {
    return undefined;
  }
}
