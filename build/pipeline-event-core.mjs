// Shared in-txn event application core. One event-application path, used by
// both the outer dispatch and in-txn effects (ADR #6, #22, AGENTS.md).

import { createRequire } from 'node:module';
import { lifecycleVerb, parseEventType } from './event-handle.mjs';
import { isPlainObject } from './field-strategy.mjs';
import { getLog } from './log.mjs';
import { forbidden } from './outcome.mjs';

// ---- Shared in-txn event application core ----
//
// This is the core that BOTH the outer dispatch and the effect runtime use.
// It appends events to _Log (with per-scope seq), runs projection consumers,
// blob adopter (if any), and post-handler authorize — all inside the caller's
// open transaction. Effects JOIN the outer txn; they do NOT re-BEGIN.
//
// This is the "singular system" implementation (AGENTS.md): one event-application
// path, called by both the outer dispatch and in-txn effects (ADR #6, #22).

export function eventWithHandle(event     , handle     )      {
  const out = { ...event };
  Object.defineProperty(out, 'handle', { value: handle, enumerable: false });
  return Object.freeze(out);
}

export function eventWithParsedHandle(event     )      {
  if (event?.handle?.brand === 'event-handle') return eventWithHandle(event, event.handle);
  try {
    return eventWithHandle(event, parseEventType(event.type));
  } catch {
    return event;
  }
}

export const NOW = Symbol('workbench.now');

export const CURSOR_UPSERT_SQL =
  'INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET lastSeq = ?';

// Deep-walk an event's `data`, replacing every NOW token with the commit-time
// `now` ISO string. Returns a fresh structure (does not mutate the handler's
// emitted object — which may be frozen). Only recurses into PLAIN objects and
// arrays — a Date, Buffer, or class instance passes through untouched (a Date's
// ISO form comes from its toJSON at serialization; flattening it to {} would
// lose the value).
function resolveNowTokens(value         , now        )          {
  if (value === NOW) return now;
  if (Array.isArray(value)) return value.map((v) => resolveNowTokens(v, now));
  if (isPlainObject(value)) {
    const source = value                           ;
    const out                          = {};
    for (const k of Object.keys(source)) out[k] = resolveNowTokens(source[k], now);
    return out;
  }
  return value;
}

export function noAdmission() {
  return Object.freeze({
    beforeProjection: async () => true,
    afterProjection: async () => true,
  });
}

export function noBlobAdapter() {
  return Object.freeze({
    adoptInTxn: async () => {},
  });
}

export function requireAdmission(granted         ) {
  if (!granted) throw forbidden();
}

// Lazy import of effect compiler (avoids circular dependency at module load time).
export function effectEventsFor(registry         , executeEffectsForEvent         ) {
  if (!registry) return null;
  return (event         , { now, actionId, db }                                                )      => {
    const impl = executeEffectsForEvent ??
      createRequire(import.meta.url)('./effect-compiler.mjs').executeEffectsForEvent;
    return impl(event, registry, { now, actionId, db });
  };
}










/**
 * Observability seam for a post-commit consumer failure. The committed origin
 * is NEVER changed by a consumer throw: the hook is a side-channel so an app
 * can page/metric a broken delivery without a second write path. A hook that
 * itself throws is contained — it must not turn a committed dispatch into a
 * reported failure.
 */






export function reportConsumerError(
  hook                                    ,
  error         ,
  phase                                                   ,
  actionId         ,
  consumerIndex         ,
)       {
  if (!hook) return;
  try {
    hook(error, { phase, actionId, consumerIndex });
  } catch (hookErr) {
    // The hook is observability, never a second commit path. Its failure is
    // logged and contained so the committed origin stays a success.
    getLog().warn('dispatch', 'post-commit consumer error hook failed', { err: hookErr, actionId, phase });
  }
}
















                                      























export async function runPreProjectionAdmission(
  admission                   ,
  db         ,
  events       ,
  { actionId, type, scope, principal, payload, now }






   ,
) {
  const admittedEvents        = [];
  for (const e of events) {
    const withHandle = eventWithParsedHandle(e);
    admittedEvents.push(withHandle);
    const verb = lifecycleVerb(withHandle.handle);
    if (!verb) continue;
    requireAdmission(await admission.beforeProjection({
      entityName: withHandle.handle.entity,
      verb,
      principal,
      eventType: withHandle.type,
      event: withHandle,
      db,
      now,
      payload,
    }));
  }
  // Application-owned annotation admission: snapshot the pre-image now and
  // compare it after projection, inside the same transaction.
  const annotatedState = admission.annotatedMutation?.before({
    db, events: admittedEvents, actionId, actionType: type, scope, principal, payload, now,
  }) ?? null;
  return annotatedState;
}

export function finalizeEvents(
  events       ,
  { now, actionId, nextSeq, preserveV16Capability }




   ,
)        {
  const finalizedEvents        = [];
  for (const e of events) {
    const withHandle = eventWithParsedHandle(e);
    const scope = withHandle.scope;
    const seq = nextSeq(scope);
    const data = resolveNowTokens(withHandle.data ?? {}, now);
    const ev = {
      ...withHandle,
      data,
      seq,
      actionId,
      committedAt: now,
      ...(preserveV16Capability && withHandle.v16Capability !== undefined ? { v16Capability: withHandle.v16Capability } : {}),
    };
    finalizedEvents.push(eventWithHandle(ev, withHandle.handle));
  }
  return finalizedEvents;
}

// Projection consumers — materialize entity rows from events.
// Registered-action projections pin actionType to the declaring action.
// Batch commits use type '$batch'; admit a projection when its action is
// one of the submitted batch members (same event-type filter still applies).
// Events project in EMISSION order (event-major, not consumer-major): a
// generated action may span several entity projections and its handler
// owns a load-bearing order between them — the annotation-entity remove
// action must tear the annotation down BEFORE the related row whose FK
// references it (ON DELETE RESTRICT), and compose must create the row
// BEFORE its annotation.
export async function applyProjectionConsumers(
  projectionConsumers       ,
  db         ,
  finalizedEvents       ,
  { type, payload, privateFact, claimedBlobs }




   ,
) {
  const batchActionTypes = type === '$batch' && Array.isArray(payload)
    ? new Set(payload.map((action) => action?.type).filter((value) => typeof value === 'string'))
    : null;
  for (const ev of finalizedEvents) {
    for (const consumer of projectionConsumers) {
      if (!consumer.eventTypes.includes(ev.type)) continue;
      if (consumer.actionType !== undefined && consumer.actionType !== type
        && !(batchActionTypes?.has(consumer.actionType))) continue;
      if (consumer.privateFact === true) {
        if (privateFact === undefined) throw new TypeError('private-fact projection requires a canonical private fact');
        await (consumer.applyAsync ?? consumer.apply)(ev, db, Object.freeze({ privateFact, ...(claimedBlobs ? { claimedBlobs } : {}) }));
      } else if (claimedBlobs) {
        await (consumer.applyAsync ?? consumer.apply)(ev, db, Object.freeze({ claimedBlobs }));
      } else {
        await (consumer.applyAsync ?? consumer.apply)(ev, db);
      }
    }
  }
}

export async function runPostProjectionAdmission(
  admission                   ,
  db         ,
  finalizedEvents       ,
  { principal, now, payload }                                                       ,
) {
  // Post-projection admission — runs IN-TXN after projection. Create
  // row-grants need this deep visibility: the row exists only after the
  // projection consumer has materialized it.
  for (const ev of finalizedEvents) {
    const verb = lifecycleVerb(ev.handle);
    if (!verb) continue;
    requireAdmission(await admission.afterProjection({
      entityName: ev.handle.entity,
      verb,
      principal,
      eventType: ev.type,
      event: ev,
      db,
      now,
      payload,
    }));
  }
}

export async function runInTxnEffects(
  effectsExecutor                                    ,
  { db, finalizedEvents, now, actionId, principal, depth, maxEffectDepth, recurse }








   ,
) {
  if (!effectsExecutor) return;
  for (const ev of finalizedEvents) {
    const effectEvents = effectsExecutor(ev, { now, actionId, db });
    if (effectEvents && effectEvents.length > 0) {
      if (depth >= maxEffectDepth) {
        throw new Error(
          `Effect reentrancy depth limit exceeded (max: ${maxEffectDepth}). ` +
          'This is a runtime backstop against runaway effect chains (ADR #22).',
        );
      }
      const effectPrincipal = effectEvents[0]?._effectPrincipal ?? principal;
      await recurse(effectEvents, effectPrincipal, depth + 1);
    }
  }
}
