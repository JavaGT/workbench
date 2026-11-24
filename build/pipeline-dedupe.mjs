// Idempotency decisions for the (scope, actionId) identity. The pre-handler
// check and the in-txn recheck share the same decision functions.

import { receiptFor, eventsFromReceipt, noHistoryReceiptFor } from './committed-log.mjs';
import { parseEventType } from './event-handle.mjs';
import { canonicalStringify } from './canonical-json.mjs';
import { isPlainObject } from './field-strategy.mjs';
import { failure, failureOutcome } from './outcome.mjs';

import { successOutcome } from './pipeline-outcomes.mjs';
import { eventWithParsedHandle } from './pipeline-event-core.mjs';

// In-memory dedupe mirrors the durable `(scope, actionId)` receipt identity.
export function checkInMemoryDedupe(dispatched                                   , scope        , actionId        ) {
  const scoped = dispatched.get(scope);
  if (!scoped?.has(actionId)) return null;
  return successOutcome(scoped.get(actionId), true);
}

export function recordInMemoryDispatch(dispatched                                   , scope        , actionId        , events         ) {
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
function checkDurableDedupe(db         , scope        , actionId        , request     , receiptMatches                                          ) {
  const receipt = receiptFor(db            , scope, actionId);
  if (!receipt) return null;
  if (receiptMatches && !receiptMatches(receipt, request)) {
    return failureOutcome(failure('conflict', 'Action ID is already committed for a different request.'));
  }
  return Object.freeze({ ...successOutcome(eventsFromReceipt(db            , receipt, parseEventType), true), resultData: receipt.resultData });
}

function checkDurableBatchDedupe(db         , scope        , actionId        , actions       ) {
  const receipt = receiptFor(db            , scope, actionId);
  if (!receipt) return null;
  if (receipt.actionType !== '$batch' || receipt.actionData !== canonicalStringify(actions)) {
    return failureOutcome(failure('conflict', 'Action ID is already committed for a different batch.'));
  }
  return Object.freeze({ ...successOutcome(eventsFromReceipt(db            , receipt, parseEventType), true), resultData: receipt.resultData });
}

// Mixed-tier commits have both receipts: the durable receipt replays its _Log
// events while its internal replay metadata carries the live events (which must
// not enter _Log). Reassemble them at their original emission indexes only when
// both receipts prove the whole action committed.
function checkMixedDedupe(db         , scope        , actionId        , request         , receiptMatches                                          ) {
  const durableReceipt = receiptFor(db            , scope, actionId);
  const liveReceipt = noHistoryReceiptFor(db            , scope, actionId);
  if (!durableReceipt || !liveReceipt) return null;
  if (receiptMatches && !receiptMatches(durableReceipt, request)) {
    return failureOutcome(failure('conflict', 'Action ID is already committed for a different request.'));
  }
  const replay = isPlainObject(durableReceipt.resultData)
    ? (durableReceipt.resultData                           ).__workbenchMixedReplay
    : undefined;
  if (!isPlainObject(replay)
    || !Array.isArray(replay.durableIndexes)
    || !Array.isArray(replay.liveIndexes)
    || !Array.isArray(replay.liveEvents)) return null;
  const durableEvents = eventsFromReceipt(db            , durableReceipt, parseEventType);
  const events        = [];
  for (let index = 0; index < replay.durableIndexes.length; index += 1) {
    events[replay.durableIndexes[index]          ] = durableEvents[index];
  }
  for (let index = 0; index < replay.liveIndexes.length; index += 1) {
    events[replay.liveIndexes[index]          ] = eventWithParsedHandle(replay.liveEvents[index]);
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
function checkLiveDedupe(db         , scope        , actionId        ) {
  const receipt = noHistoryReceiptFor(db            , scope, actionId);
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
export function singleDispatchDedupe(db         , { scope, actionId, request, receiptMatches, livePipeline }





 ) {
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

export function batchDispatchDedupe(db         , { scope, actionId, actions, livePipeline }




 ) {
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
export function handleOfEvent(event     )      {
  if (event?.handle?.brand === 'event-handle') return event.handle;
  try {
    return parseEventType(event.type);
  } catch {
    return undefined;
  }
}
