// The mutation pipeline's type kernel: Action and Event (SPEC §7).
//
// An ACTION is an imperative client request that may be rejected. An EVENT is a
// past-tense fact the server emitted — it already happened. They are distinct
// branded types so neither is mistaken for the other: an action is dispatched
// and authorized; an event is folded into state through its reducer.
//
// The reducer is NON-OPTIONAL on an event (SPEC §7): an event with no reducer is
// a load-time error, because `ingest` is the only place an event becomes client
// state and it has nothing to fold without one — there is no second apply path
// (AGENTS.md, one reconciliation path).

// Lazy import of effect compiler (avoids circular dependency at module load time).
import { readSeq } from './committed-log.mjs';
import { appendEvents, receiptFor, eventsFromReceipt, insertReceipt, noHistoryReceiptFor, insertNoHistoryReceipt, bumpRevision, readRevision as readLiveRevision, guardExpectedRevision } from './committed-log.mjs';
import { routeCompositeEvent, recordCompositeChanges } from './composite-journal.mjs';

import { lifecycleVerb, parseEventType } from './event-handle.mjs';
import { prepareCached, txn,                                 } from './driver.mjs';
import { isPlainObject, ValidationError } from './field-strategy.mjs';
import { createRequire } from 'node:module';
import { createDurableHistoryRuntime } from './durable-history.mjs';
import { decideReplay } from './replay-decision.mjs';
import { getLog } from './log.mjs';
import { failure, failureFromError, failureOutcome, forbidden } from './outcome.mjs';
import { principalKeyOf } from './principal.mjs';
import { applyErasureDirective, isErasureDirective, isErasureDirectivePreparation, prepareErasureDirective } from './erasure-directive.mjs';
import { declarePostCommitEffectsInTxn } from './post-commit-effects.mjs';
import {
  applicationPrivateFactView,
  canonicalJsonEqual,
  constructCompoundCompensationEnvelope,
  constructCompoundOriginEnvelope,
  parseCompoundApplicationTransition,
  parseCompoundApplicationTransitionInput,
  validateApplicationTransition,
} from './compound-contribution-fact.mjs';
import { readMoveCompensationTarget, planRegionCompensation, loadRegionCompensationContext } from './annotated-text-region-compensation.mjs';
import { canonicalStringify } from './canonical-json.mjs';
import * as eventHandles from './event-handle.mjs';
import { protectedArtefactCapability } from './protected-artefact-store.mjs';


import { executeAtomicOperations, isAtomicOperation,                                                   } from './atomic-operations.mjs';
import { admitRowTransition } from './field-admission.mjs';
import { writeInvalidationInTxn } from './invalidation-ledger.mjs';
import { ownedResourcesCapability } from './owned-resource-purge.mjs';
import { ANNOTATED_TEXT_STALE } from './annotated-text-region-limits.mjs';

// `action(type)` — declare an imperative request type. The handler that turns it
// into events is attached later by the entity/dispatch wiring.
export function action(type        ) {
  return Object.freeze({ brand: 'action', type });
}

// `event(type, reduce)` — declare a past-tense fact and the reducer that folds
// it into state. The reducer is required; omitting it fails closed at load.
export function event(type                                                  , reduce                                               ) {
  const handle = type && typeof type === 'object' && type.brand === 'event-handle' ? type : undefined;
  const eventType = handle ? handle.type : (type          );
  if (typeof reduce !== 'function') {
    throw new Error(
      `event('${eventType}') has no reducer. An event with no reducer is a ` +
        `load-time error (SPEC §7): ingest is the only place an event becomes ` +
        `state, and it folds the event through this reducer. Declare one: ` +
        `event('${eventType}', (state, payload) => next).`,
    );
  }
  return Object.freeze({ brand: 'event', handle, type: eventType, reduce });
}

// ---- Shared in-txn event application core ----
//
// This is the core that BOTH the outer dispatch and the effect runtime use.
// It appends events to _Log (with per-scope seq), runs projection consumers,
// blob adopter (if any), and post-handler authorize — all inside the caller's
// open transaction. Effects JOIN the outer txn; they do NOT re-BEGIN.
//
// This is the "singular system" implementation (AGENTS.md): one event-application
// path, called by both the outer dispatch and in-txn effects (ADR #6, #22).

function eventWithHandle(event     , handle     )      {
  const out = { ...event };
  Object.defineProperty(out, 'handle', { value: handle, enumerable: false });
  return Object.freeze(out);
}

function eventWithParsedHandle(event     )      {
  if (event?.handle?.brand === 'event-handle') return eventWithHandle(event, event.handle);
  try {
    return eventWithHandle(event, parseEventType(event.type));
  } catch {
    return event;
  }
}

export const NOW = Symbol('workbench.now');

const CURSOR_UPSERT_SQL =
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

function requireAdmission(granted         ) {
  if (!granted) throw forbidden();
}

function effectEventsFor(registry         , executeEffectsForEvent         ) {
  if (!registry) return null;
  return (event         , { now, actionId, db }                                                )      => {
    const impl = executeEffectsForEvent ??
      createRequire(import.meta.url)('./effect-compiler.mjs').executeEffectsForEvent;
    return impl(event, registry, { now, actionId, db });
  };
}

export function durableMutationVariant({
  projectionConsumers = [],
  admission = noAdmission(),
  blobAdapter = noBlobAdapter(),
  effectsRegistry = null,
  executeEffectsForEvent = null,
  postCommitConsumers = [],
  maxEffectDepth = 8,
  compositeJournal,
}















                                        




  = {}) {
  if (!Number.isInteger(maxEffectDepth) || maxEffectDepth < 0) {
    throw new Error('durableMutationVariant: maxEffectDepth must be a non-negative integer');
  }
  const effectsExecutor = effectEventsFor(effectsRegistry, executeEffectsForEvent);
  const variant = {
    name: 'durable.mutation',
    async applyInTxn(db         , events       , {
      now,
      actionId,
      nextSeq,
      principal,
      depth = 0,
      payload,
      type,
      scope: _scope,
      privateFact,
      claimedBlobs,
    }










     ) {
      const finalizedEvents        = [];

      // Pre-projection admission — runs IN-TXN against the PRE-mutation row,
      // before the _Log append and before projection. Denial leaves zero
      // footprint. This shallow module interface keeps scheduler admission on
      // the durable variant instead of exporting low-level append/authorize
      // primitives across the seam.
      for (const e of events) {
        const withHandle = eventWithParsedHandle(e);
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

      // Append events to _Log with per-scope sequence numbers. NOW tokens in the
      // event data are resolved to the commit-time ISO here (ADR #24) — before
      // serialization, so the token never reaches _Log. The actual INSERT is
      // centralized in committed-log.mjs — one canonical write surface.
      for (const e of events) {
        const withHandle = eventWithParsedHandle(e);
        const scope = withHandle.scope;
        const seq = nextSeq(scope);
        const data = resolveNowTokens(withHandle.data ?? {}, now);
        const ev = { ...withHandle, data, seq, actionId, committedAt: now, ...(withHandle.v16Capability !== undefined ? { v16Capability: withHandle.v16Capability } : {}) };
        finalizedEvents.push(eventWithHandle(ev, withHandle.handle));
      }
      appendEvents(db            , finalizedEvents);

      // Composite journal evidence pass 1 (#122): capture private before-images
      // BEFORE this action's own projection consumers run. Update/remove rows
      // are still pre-image here; the post-projection pass below supplies
      // after-images. Identity-only — no recipient value is retained.
      let compositeEvidence                                                                                                                                 = null;
      if (compositeJournal !== undefined && finalizedEvents.some((e) => e?.handle)) {
        compositeEvidence = { before: new Map(), after: new Map() };
        for (const ev of finalizedEvents) {
          const entityName                     = ev?.handle?.entity;
          const rowId          = ev?.data?.id;
          if (!entityName || typeof rowId !== 'string') continue;
          if (!/\.updated$|\.removed$/.test(ev.type)) continue;
          try {
            const row = (db            ).prepare(`SELECT * FROM ${entityName} WHERE id = ?`).get(rowId)                                       ;
            if (row) {
              let rows = compositeEvidence.before.get(entityName);
              if (!rows) compositeEvidence.before.set(entityName, rows = new Map());
              rows.set(String(rowId), { ...row });
            }
          } catch {
            // No such table (e.g. tombstone-only entities are real tables, but
            // foreign event scopes may not be): the router invalidates on the
            // missing evidence instead of guessing.
          }
        }
      }

      // Projection consumers — materialize entity rows from events.
      // Registered-action projections pin actionType to the declaring action.
      // Batch commits use type '$batch'; admit a projection when its action is
      // one of the submitted batch members (same event-type filter still applies).
      const batchActionTypes = type === '$batch' && Array.isArray(payload)
        ? new Set(payload.map((action) => action?.type).filter((value) => typeof value === 'string'))
        : null;
      // Events project in EMISSION order (event-major, not consumer-major): a
      // generated action may span several entity projections and its handler
      // owns a load-bearing order between them — the annotation-entity remove
      // action must tear the annotation down BEFORE the related row whose FK
      // references it (ON DELETE RESTRICT), and compose must create the row
      // BEFORE its annotation. Each event still applies exactly once per
      // subscribing consumer, and per consumer the relative emission order of
      // its own events is unchanged.
      for (const ev of finalizedEvents) {
        for (const consumer of projectionConsumers) {
          if (consumer.eventTypes.includes(ev.type)) {
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

      // Blob adoption is in-txn and atomic with the log + projection writes.
      await blobAdapter.adoptInTxn(db, finalizedEvents);

      // Composite journal evidence pass 2 + routing (#122): after projection,
      // capture after-images, route every finalized event through the compiled
      // patch plans, and record the entries atomically with _Log and
      // _ActionReceipt. A journal failure fails the commit — an unrecorded
      // composite change would be a silent gap in the patch protocol.
      if (compositeJournal !== undefined && (compositeEvidence !== null || finalizedEvents.length > 0)) {
        const plans = compositeJournal.plans                                                                            ;
        const evidence                                                                                                                          = compositeEvidence ??= { before: new Map(), after: new Map() };
        for (const ev of finalizedEvents) {
          const entityName                     = ev?.handle?.entity;
          const rowId          = ev?.data?.id;
          if (!entityName || typeof rowId !== 'string') continue;
          if (!/\.created$|\.updated$/.test(ev.type)) continue;
          try {
            const row = (db            ).prepare(`SELECT * FROM ${entityName} WHERE id = ?`).get(rowId)                                       ;
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
        // {before, after} shape). The application view of compound facts
        // exposes `application`; plain facts expose themselves. Identity-only.
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
            db            ,
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
        recordCompositeChanges(db            , inputs, now);
      }

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

      // Effects recurse through this SAME named variant. The implementation is
      // local to the variant so dispatch and batch get identical depth behavior
      // and leverage one pipeline interface rather than an options lattice.
      if (effectsExecutor) {
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
            await variant.applyInTxn(db, effectEvents, {
              now,
              actionId,
              nextSeq,
              principal: effectPrincipal,
              depth: depth + 1,
              payload,
            });
          }
        }
      }

      return finalizedEvents;
    },
    requiresPrivateFact(events       , actionType         ) {
      return projectionConsumers.some((consumer) => consumer.privateFact === true
        && (consumer.actionType === undefined || consumer.actionType === actionType)
        && events.some((event) => consumer.eventTypes.includes(event.type)));
    },
    async afterCommit(events         , context         ) {
      for (const consumer of postCommitConsumers) {
        try {
          await consumer(events, context);
        } catch {
          // a post-commit fan-out failure never undoes the committed dispatch
        }
      }
    },
  };
  return Object.freeze(variant);
}

// liveMutationVariant — the no-history mutation lane (S3/A2, #100).
//
// A live-tier entity's mutation must NOT quietly write every mutation into
// `_Log` (that would preserve history despite the tier's purpose). This variant
// runs the SAME in-txn row-change machinery as the durable variant — pre/post
// admission, projection consumers that materialize the current row, in-txn blob
// adoption, and effect recursion — but with the durable _Log append REPLACED by
// the no-history core: bump the resource/collection revision, write the
// MINIMIZED idempotency receipt, and never touch `_Log` or `_Cursor`. No `_Log`
// row is ever produced for a live entity through this variant.
//
// The durable `_ActionReceipt` is also skipped for a live-only commit: it
// retains the request payload, which the no-history receipt must not
// (considerations #8/#9). The minimized `_NoHistoryReceipt` IS the idempotency
// proof; a retried (scope, actionId) settles to the same outcome without a
// second apply.
//
// The expected-revision guard is the S3/A6 hook surface: an edit may carry
// `expectedRevision` in its request payload; a mismatch rejects the action with
// a safe `conflict` classification before any row change lands — no blind
// last-write-wins.
//
// All writes join the caller's write-coordinator transaction (BEGIN IMMEDIATE);
// this variant never opens its own.
export function liveMutationVariant({
  projectionConsumers = [],
  admission = noAdmission(),
  blobAdapter = noBlobAdapter(),
  effectsRegistry = null,
  executeEffectsForEvent = null,
  postCommitConsumers = [],
  maxEffectDepth = 8,
}










  = {}) {
  if (!Number.isInteger(maxEffectDepth) || maxEffectDepth < 0) {
    throw new Error('liveMutationVariant: maxEffectDepth must be a non-negative integer');
  }
  const effectsExecutor = effectEventsFor(effectsRegistry, executeEffectsForEvent);
  const variant = {
    name: 'live.mutation',
    async applyInTxn(db         , events       , {
      now,
      actionId,
      principal,
      depth = 0,
      payload,
      type,
      scope: owningScope,
      privateFact,
      claimedBlobs,
    }









     ) {
      // Retry backstop: an already-receipted (scope, actionId) never applies a
      // second time — not even when the pre-handler dedupe missed (batch retry,
      // effect re-entrancy). No row change, no revision bump, no receipt re-
      // write; the existing receipt IS the settled outcome.
      if (noHistoryReceiptFor(db            , owningScope          , actionId)) {
        return [];
      }

      const finalizedEvents        = [];

      // Pre-projection admission — runs IN-TXN against the PRE-mutation row,
      // before the row change and before the receipt. Denial leaves zero
      // footprint, exactly as on the durable lane.
      for (const e of events) {
        const withHandle = eventWithParsedHandle(e);
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

      // No-history sequence allocation: events carry a transaction-local seq so
      // projections and consumers observe a monotonic per-scope order, but no
      // `_Cursor` row is read or written — the durable sequence space is never
      // consumed by a live entity.
      const liveSeqs = new Map                ();
      const nextLiveSeq = (eventScope        )         => {
        const seq = (liveSeqs.get(eventScope) ?? 0) + 1;
        liveSeqs.set(eventScope, seq);
        return seq;
      };
      for (const e of events) {
        const withHandle = eventWithParsedHandle(e);
        const eventScope = withHandle.scope;
        const data = resolveNowTokens(withHandle.data ?? {}, now);
        const ev = { ...withHandle, data, seq: nextLiveSeq(eventScope), actionId, committedAt: now };
        finalizedEvents.push(eventWithHandle(ev, withHandle.handle));
      }

      // Expected-revision guard (S3/A2 hook; the full atomic-op surface is
      // S3/A6). Optimistic concurrency for the no-history lane: an edit may
      // carry expectedRevision; a mismatch rejects the whole action with a safe
      // classification before any row change lands — no blind last-write-wins.
      const expectedRevision = isPlainObject(payload) ? (payload                           ).expectedRevision : undefined;
      if (expectedRevision !== undefined) {
        const guardScope = finalizedEvents[0]?.scope ?? owningScope;
        guardExpectedRevision(db            , guardScope          , expectedRevision);
      }

      // Atomic handlers resolve their operation against the current row inside
      // this coordinator transaction, then emit the ordinary update event. The
      // operation grammar is validated here as well, before projection, receipt,
      // and revision bump can make a malformed request observable.
      const atomicOperations = isPlainObject(payload) ? (payload                           ).atomicOperations : undefined;
      if (atomicOperations !== undefined
        && (!Array.isArray(atomicOperations) || !atomicOperations.every(isAtomicOperation))) {
        throw new ValidationError('atomicOperations must be an array of known atomic operations');
      }

      // Projection consumers — materialize entity rows from the events. Batch
      // commits use type '$batch'; admit a projection when its action is one of
      // the submitted batch members (same event-type filter still applies).
      const batchActionTypes = type === '$batch' && Array.isArray(payload)
        ? new Set(payload.map((action) => action?.type).filter((value) => typeof value === 'string'))
        : null;
      // Events project in EMISSION order (event-major, not consumer-major): a
      // generated action may span several entity projections and its handler
      // owns a load-bearing order between them — the annotation-entity remove
      // action must tear the annotation down BEFORE the related row whose FK
      // references it (ON DELETE RESTRICT), and compose must create the row
      // BEFORE its annotation. Each event still applies exactly once per
      // subscribing consumer, and per consumer the relative emission order of
      // its own events is unchanged.
      for (const ev of finalizedEvents) {
        for (const consumer of projectionConsumers) {
          if (consumer.eventTypes.includes(ev.type)) {
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

      // Blob adoption is in-txn and atomic with the projection + receipt writes.
      await blobAdapter.adoptInTxn(db, finalizedEvents);

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

      // Effects recurse through this SAME named variant (identical depth
      // semantics to the durable lane — ADR #6, #22).
      if (effectsExecutor) {
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
            await variant.applyInTxn(db, effectEvents, {
              now,
              actionId,
              principal: effectPrincipal,
              depth: depth + 1,
              payload,
              type,
              scope: owningScope,
            });
          }
        }
      }

      // Revision bump and invalidation marker share this transaction with the
      // projection. The ledger proves live reconnect cursors without retaining
      // the mutation payload or creating a second history.
      // The receipt records the FIRST resource's key and THAT resource's new
      // revision (single-resource actions are the live norm; multi-resource
      // atomicity is the S3/A6 surface).
      const touched = new Map                ();
      for (const ev of finalizedEvents) {
        const revision = bumpRevision(db            , ev.scope);
        touched.set(ev.scope, revision);
        writeInvalidationInTxn(db            , {
          resourceKey: ev.scope,
          kind: 'resource',
          revision,
          updatedAt: now,
        });
      }
      const resourceKey = finalizedEvents[0]?.scope ?? (owningScope          );
      const committedRevision = touched.get(resourceKey) ?? readLiveRevision(db            , resourceKey);
      const actor = principal                                                       ;
      insertNoHistoryReceipt(db            , {
        scope: owningScope          ,
        actionId,
        resourceKey,
        committedRevision,
        outcome: 'committed',
        actorType: typeof actor?.type === 'string' ? actor.type : null,
        actorId: typeof actor?.id === 'string' ? actor.id : null,
        safeErrorClassification: null,
        committedAt: now,
      });

      return finalizedEvents;
    },
    requiresPrivateFact(events       , actionType         ) {
      return projectionConsumers.some((consumer) => consumer.privateFact === true
        && (consumer.actionType === undefined || consumer.actionType === actionType)
        && events.some((event) => consumer.eventTypes.includes(event.type)));
    },
    async afterCommit(events         , context         ) {
      for (const consumer of postCommitConsumers) {
        try {
          await consumer(events, context);
        } catch {
          // a post-commit fan-out failure never undoes the committed dispatch
        }
      }
    },
  };
  return Object.freeze(variant);
}

// createServer({ handlers, authorize, db, effects }) — the server-side mutation handler
// (SPEC §7). It runs one pipeline for every action: dedupe by action id → run the
// handler → authorize + assign each emitted event a per-scope monotonic sequence
// number → append to the durable log → fan out. Authorize runs INSIDE the write
// transaction (Wave 4.4), atomic with log, cursor, projection, and receipt —
// not before it. The in-memory (no-db) path retains the original authorize-then-
// handler ordering since there is no transaction to join.
//
// Persistence is OPT-IN by engaged seam (AGENTS.md): pass a node:sqlite
// DatabaseSync as `db` and events are appended to the `_Log` table with per-scope
// sequences from the `_Cursor` table. Without `db`, the in-memory kernel runs
// (backwards-compatible, for clients that don't need durability). Both paths share
// the same shape — the persistence seam changes WHERE state lands, never HOW.
//
// Effects fire in-txn on committed CRUD events, re-entering through the SAME
// durable variant interface (ADR #6, #22). A target grant DENY rolls back the
// origin (in-txn atomic). Depth cap prevents runaway chains.
//
// `authorize` is REQUIRED and fails closed: there is no default. A default
// `() => true` would admit every action (fail OPEN), the opposite of the route

function successOutcome(events         , deduped = false) {
  return Object.freeze({ ok: true, deduped, events });
}

function deniedOutcome(details          ) {
  return failureOutcome(failure('denied', 'Forbidden.', details                                       ));
}

function unknownActionOutcome(type         , details          ) {
  return failureOutcome(failure(
    'unknown-action',
    `No action named '${String(type)}' is registered.`,
    details                                       ,
  ));
}

function executionFailure(error         , context                          = {}, details          ) {
  const validationDetails = error instanceof ValidationError && isPlainObject((error                         ).failure)
    ? (error                                        ).failure
    : undefined;
  const normalized = error instanceof ValidationError
    ? failure(validationDetails?.code === ANNOTATED_TEXT_STALE ? 'conflict' : 'invalid-input', (error         ).message, validationDetails)
    : failureFromError(error);
  if (normalized.category === 'internal') {
    getLog().error('dispatch', 'dispatch failed', { err: error, ...context });
  }
  const withDetails = details
    ? failure(normalized.category, normalized.message, { ...(normalized.details ?? {}), ...(details                           ) })
    : normalized;
  return failureOutcome(withDetails);
}

const BATCH_HANDLER_FAILURE = Symbol('workbench.batch-handler-failure');

function batchHandlerFailure(error         , actionIndex        ) {
  return Object.freeze({ [BATCH_HANDLER_FAILURE]: true, error, actionIndex });
}

// ── Shared dispatch-pipeline helpers ──
//
// The four dispatch paths (in-memory/durable × single/batch) each follow the
// same 4-step sequence — check handler → Fork C authorize → dedupe → run
// handler — but implementations differ between sync (in-memory) and async
// (durable). These helpers extract what IS pixel-identical across paths.
// The Fork C authorize try/catch is NOT shared because sync vs async wrapping
// differs; only the post-catch boolean guard is extracted here.

// Returns the handler function, or null if no handler is registered for `type`.
function checkHandler(handlers                     , type        )      {
  const handler = handlers[type];
  if (typeof handler !== 'function') return null;
  return handler;
}

// Returns the index of the first action without a handler, or -1 if all exist.
function checkHandlers(handlers                     , actions       )         {
  for (let i = 0; i < actions.length; i++) {
    if (typeof handlers[actions[i].type] !== 'function') return i;
  }
  return -1;
}

function atomicOperationsFor(payload         )                                                                     {
  if (!isPlainObject(payload)) return null;
  const operations = (payload                           ).atomicOperations;
  if (operations === undefined) return null;
  if (!Array.isArray(operations) || !operations.every(isAtomicOperation)) {
    throw new ValidationError('atomicOperations must be an array of known atomic operations');
  }
  return operations;
}

async function resolveAtomicOperation(handler     , context                                                                          )                                       {
  const registration = handler.atomicOperation;
  if (!registration) return undefined;
  const operations = atomicOperationsFor(context.payload);
  if (!operations) throw new ValidationError('atomic operation requires atomicOperations');
  const before = await registration.read(context);
  if (!isPlainObject(before)) throw new ValidationError('atomic operation target row was not found');
  const resolved = executeAtomicOperations(before, operations);
  for (const operation of operations) {
    requireAdmission(await admitRowTransition({
      entity: registration.entity,
      verb: 'update',
      before,
      after: resolved.row,
      fieldName: operation.field,
      principal: context.principal,
      authorization: context.authorization,
    }));
  }
  return resolved;
}

// Returns deniedOutcome(details) when `result` is falsy, or null when authorized.
function authorizedOrDenied(result         , details          ) {
  if (!result) return deniedOutcome(details);
  return null;
}

// In-memory dedupe mirrors the durable `(scope, actionId)` receipt identity.
function checkInMemoryDedupe(dispatched                                   , scope        , actionId        ) {
  const scoped = dispatched.get(scope);
  if (!scoped?.has(actionId)) return null;
  return successOutcome(scoped.get(actionId), true);
}

function recordInMemoryDispatch(dispatched                                   , scope        , actionId        , events         ) {
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

// The stable event handle for tier routing. A handler-emitted event may be a
// raw `{ type, ... }` with no attached handle — parse it; an unparseable type
// yields undefined (treated as the durable lane, i.e. no live routing).
function handleOfEvent(event     )      {
  if (event?.handle?.brand === 'event-handle') return event.handle;
  try {
    return parseEventType(event.type);
  } catch {
    return undefined;
  }
}

// A raw DatabaseSync has no async transaction mutex. Pipeline stages may await
// admission or projections, so serialize transaction entry per handle rather
// than allowing a second dispatch to begin inside the first transaction.
const transactionTails = new WeakMap                       ();
async function coordinatedTxn   (db          , fn                  )             {
  let release                          ;
  const previous = transactionTails.get(db          ) ?? Promise.resolve();
  const tail = new Promise      ((resolve) => { release = resolve; });
  transactionTails.set(db          , previous.then(() => tail));
  await previous;
  try {
    return await txn(db, fn)     ;
  } finally {
    release ();
  }
}

// commitEvents — the durable transaction brace shared by `dispatch` and
// `dispatchBatch`: BEGIN IMMEDIATE → durable variant applyInTxn → COMMIT →
// post-commit fan-out, with ROLLBACK on execution error. Expected failures are
// returned through the stable outcome grammar rather than thrown.
// The `payload` argument is the admission context each caller threads through:
// `dispatch` passes its single action's `payload`, `dispatchBatch` passes the
// `actions` array. The two genuinely differ there, so the brace is extracted but
// the `payload` value stays per-caller. Throws non-403 errors after rolling back;
// Post-commit delivery can no longer turn a committed mutation into a failure.
async function commitEvents(db     , events     , {
  now, actionId, principal, payload, pipeline, livePipeline, tierOfEvent, scope, type, authorize, historyCommit, handler,
  erasureActionContext, authorization, contributionPolicies = null,
}















 ) {
  // A batch and any in-transaction effects share one sequence allocator. The
  // first event for a scope reads its committed cursor once; later events use
  // the transaction-local value while still updating _Cursor immediately so
  // projections and admission observe the same cursor semantics as before.
  const sequences = new Map             ();
  const updateCursor = prepareCached             (db, CURSOR_UPSERT_SQL);
  const nextSeq = (eventScope     )         => {
    let seq = sequences.get(eventScope);
    if (seq === undefined) seq = readSeq(db, eventScope);
    seq += 1;
    sequences.set(eventScope, seq);
    updateCursor.run(eventScope, seq, seq);
    return seq;
  };
  let committed     ;
  try {
    // Wave 4.4 — Authorize INSIDE the transaction, atomic with log append,
    // cursor update, projection writes, and receipt insert. Both dispatch
    // (single action) and dispatchBatch (array of actions) thread their
    // authorize function through here:
    //
    //   Single dispatch: payload is the action payload ({ ...fields }),
    //     type is threaded separately via the closure.
    //   Batch dispatch: payload is the actions array, and each action's
    //     type/payload is authorized in sequence inside the txn.
    //
    // A denied action rolls back the entire transaction — no partial state.
    // Post-commit consumers (afterCommit) remain outside the txn as before.
    committed = await coordinatedTxn(db, async () => {
      if (authorize) {
        if (Array.isArray(payload)) {
          for (const action of payload) {
            const result = await authorize({ type: action.type, payload: action.payload, principal });
            if (!result) {
              throw forbidden();
            }
          }
        } else {
          const result = await authorize({ type, payload, principal });
          if (!result) {
            throw forbidden();
          }
        }
      }

      if (handler) {
        // A declared protected-artefact store hands the handler a transaction-
        // bound write/erase authority over exactly its declared application
        // tables, live only for this handler call. The capability joins this
        // origin transaction: any later failure rolls back its writes with the
        // log, cursor, projection, and receipt. It closes after the handler so
        // no later pipeline stage can reach the store.
        const protectedArtefact = handler.protectedArtefactTables?.length
          ? protectedArtefactCapability(db, handler.protectedArtefactTables)
          : null;
        const ownedResources = handler.ownedResources
          ? ownedResourcesCapability(db, handler.ownedResourcePlans ?? []) : null;
        try {
          atomicOperationsFor(payload);
          const atomic = await resolveAtomicOperation(handler, {
            payload, principal, db, now, scope, actionId, authorization,
          });
          events = await handler({
            payload, principal, db, now, scope, actionId,
            ...(atomic ? { atomic } : {}),
            ...(authorization !== undefined && authorization !== null ? { authorization } : {}),
            ...(protectedArtefact ? { protectedArtefact } : {}),
            ...(ownedResources ? { ownedResources } : {}),
            ...(historyCommit?.handlerInputs ? { history: historyCommit.handlerInputs[0] } : {}),
          });
        } finally {
          protectedArtefact?.close();
          ownedResources?.close();
        }
      }
      let commit = Array.isArray(events) ? { events } : events;
      if (!commit || !Array.isArray(commit.events)) {
        throw new TypeError(`action '${type}' handler must return an event array`);
      }
      const directive = commit.directive;
      if (directive !== undefined && (!handler?.erasureCapable || Array.isArray(payload) || historyCommit?.apply)) {
        throw new TypeError(`action '${type}' cannot return an erasure directive`);
      }
      // A protected-artefact action's request payload must never become the
      // receipt's canonical actionData (undo history reads it): the handler
      // must return a canonicalPayload containing only the non-sensitive IDs
      // and provenance needed to reference the protected artefacts.
      if (handler?.protectedArtefactTables?.length && directive === undefined && commit.canonicalPayload === undefined) {
        throw new TypeError(`action '${type}' declares protected artefacts and must return a canonicalPayload without protected payloads`);
      }

      // Registered-action composition adapter (scope#992 W2 / Finding 3): a
      // composed action carries a compiled compoundContributionPolicy. Its
      // handler returns a closed ComposedRegisteredActionCommit (events +
      // annotatedText + applicationTransition) and never a top-level privateFact.
      // Inside this coordinated transaction we admit+plan the declared region,
      // append the operational v15 event, and construct the single compound
      // private-fact envelope before any fact canonicalization.
      const composedPolicy = handler?.compoundContributionPolicy;
      if (composedPolicy) {
        if (Array.isArray(payload) || type === '$batch') {
          throw new TypeError(`composed action '${type}' is single-dispatch and batch-forbidden`);
        }
        // History moves (durable-history.move re-dispatches the outer composed
        // action with handler-only compound input). W3 (#145) owns the applied
        // document compensation: the contribution policy plans the inverse of
        // the TARGET receipt's region against CURRENT state and, when safely
        // applicable, emits a fresh v16 operated compensation event plus an
        // `applied` compensation envelope with linkage. An unsafe target (or a
        // target with nothing to compensate) commits the explicit whole-compound
        // no-op compensation envelope (rev 2 Finding 3 outcome): zero document
        // events, lineage preserved, cursor advanced. No snapshot restore is
        // ever used. An application CAS failure (validator throw) rolls back
        // the entire move.
        if (historyCommit?.handlerInputs && historyCommit.apply) {
          const moveInput = historyCommit.handlerInputs[0];
          const applicationRaw = commit.applicationTransition;
          if (!applicationRaw || typeof applicationRaw !== 'object'
            || !Object.hasOwn(applicationRaw, 'before') || !Object.hasOwn(applicationRaw, 'after')) {
            throw new TypeError(`composed action '${type}' history applicationTransition must be { before, after }`);
          }
          const metadata = historyCommit.metadata ?? {};
          const direction = moveInput?.operation === 'redo' ? 'redo' : 'undo';
          const rootActionId = metadata.historyRootActionId ?? actionId;
          const targetActionId = metadata.historyTargetActionId ?? actionId;
          const policy = contributionPolicies?.policyFor(type);
          const fieldDeclaration = policy?.fieldDeclaration;

          const target = readMoveCompensationTarget(db, {
            scope, entity: composedPolicy.entity, field: composedPolicy.field,
            rootActionId, targetActionId,
          });
          // A no-op target (its own linkage outcome is 'noop') or a target with
          // no applied document event has nothing to compensate.
          const targetLinkageNoop = 'linkage' in target.envelope && target.envelope.linkage.outcome === 'noop';
          if (target.event && !targetLinkageNoop) {
            const documentId = target.event.id;
            const context = loadRegionCompensationContext(
              db, { entity: composedPolicy.entity, field: composedPolicy.field }, documentId, fieldDeclaration, principal                                  , scope, actionId,
            );
            const planned = planRegionCompensation({ target: target.event, contribution: target.contribution, context, actionId });
            if (planned.outcome === 'applied') {
              // rev 3 §1: validate the application transition against the head
              // envelope before storing; a shape-valid but divergent fact throws
              // and rolls back the whole move.
              const originApplication = target.originApplication
                ?? parseCompoundApplicationTransition({ before: null, after: null }, 'history origin application');
              const targetApplication = parseCompoundApplicationTransition(
                target.envelope.application, `composed action '${type}' history target application`,
              );
              const translatedInput = parseCompoundApplicationTransitionInput(moveInput.input);
              const returned = validateApplicationTransition({
                originApplication,
                targetApplication,
                translatedInput,
                returnedApplication: applicationRaw,
              });
              const operatedHandle = eventHandles.native(composedPolicy.entity, composedPolicy.field, 'operated');
              commit = {
                events: [Object.freeze({
                  handle: operatedHandle,
                  type: operatedHandle.type,
                  scope: context.owningScope,
                  data: Object.freeze(planned.event),
                  v16Capability: planned.capability,
                })],
                privateFact: constructCompoundCompensationEnvelope({
                  application: returned,
                  contributions: planned.contribution ? [planned.contribution] : [],
                  linkage: {
                    rootActionId,
                    targetActionId,
                    direction,
                    outcome: 'applied',
                  },
                }),
                historyOutcome: 'applied',
              };
            } else {
              const application = parseCompoundApplicationTransition(applicationRaw, `composed action '${type}' history applicationTransition`);
              commit = {
                events: [],
                privateFact: constructCompoundCompensationEnvelope({
                  application,
                  contributions: [],
                  linkage: {
                    rootActionId,
                    targetActionId,
                    direction,
                    outcome: 'noop',
                  },
                }),
                historyOutcome: 'noop',
              };
            }
          } else {
            const application = parseCompoundApplicationTransition(applicationRaw, `composed action '${type}' history applicationTransition`);
            commit = {
              events: [],
              privateFact: constructCompoundCompensationEnvelope({
                application,
                contributions: [],
                linkage: {
                  rootActionId,
                  targetActionId,
                  direction,
                  outcome: 'noop',
                },
              }),
              historyOutcome: 'noop',
            };
          }
        } else {
          const composedKeys = ['events', 'annotatedText', 'applicationTransition'];
          const ownKeys = Object.keys(commit).filter((key) => !['directive', 'canonicalPayload', 'effects', 'historyOutcome', 'claimedBlobs'].includes(key));
          if (ownKeys.some((key) => !composedKeys.includes(key)) || !Array.isArray(commit.annotatedText) || commit.annotatedText.length !== 1) {
            throw new TypeError(`composed action '${type}' must return exactly { events, annotatedText, applicationTransition }`);
          }
          if (Object.hasOwn(commit, 'privateFact') && commit.privateFact !== undefined) {
            throw new TypeError(`composed action '${type}' cannot return a top-level privateFact`);
          }
          const applicationTransition = commit.applicationTransition;
          if (!applicationTransition || typeof applicationTransition !== 'object'
            || !Object.hasOwn(applicationTransition, 'before') || !Object.hasOwn(applicationTransition, 'after')) {
            throw new TypeError(`composed action '${type}' applicationTransition must be { before, after }`);
          }
          // An applied origin transition must differ by canonical equality (rev 3
          // rule 8); the full 8-rule semantic validator runs on history moves.
          {
            const { before, after } = applicationTransition                                       ;
            if (canonicalJsonEqual(before, after)) {
              throw new ValidationError(`composed action '${type}' applicationTransition before and after must differ`);
            }
          }
          const plan = await composedPolicy.admitAndPlan(db, commit.annotatedText[0], principal, { scope, actionId });
          // Append the package-authored operated event to the handler's domain
          // events; all commit together under one receipt.
          const operatedHandle = eventHandles.native(composedPolicy.entity, composedPolicy.field, 'operated');
          const { annotatedText: _annotatedText, applicationTransition: _transition, ...restCommit } = commit                           ;
          void _annotatedText;
          void _transition;
          commit = {
            ...restCommit,
            events: [...(Array.isArray(commit.events) ? commit.events : []), Object.freeze({
              handle: operatedHandle,
              type: operatedHandle.type,
              scope: plan.owningScope,
              data: Object.freeze(plan.envelope),
              // W1b (#149 round 2): single-use v16 admission nonce. The
              // NOW-token deep copy below strips the envelope's symbol brand,
              // so the capability rides the event frame and is consumed
              // exactly once by committed-log's append. Opaque; minted only
              // by the v16 constructor inside admitAndPlan.
              v16Capability: plan.v16Capability,
            })],
            privateFact: constructCompoundOriginEnvelope({
              application: { before: applicationTransition.before, after: applicationTransition.after },
              contributions: plan.contribution ? [plan.contribution] : [],
            }),
          };
        }
      } else if (Object.hasOwn(commit, 'annotatedText') || Object.hasOwn(commit, 'applicationTransition')) {
        // scope#992 W2: a region descriptor is only lawful through a DECLARED
        // annotated operation. Returning one from an undeclared handler would be
        // ambient operation authority — fail closed, never silently drop it.
        throw new TypeError(`undeclared annotated operation was admitted for action '${type}'`);
      }

      // S3/A2 tier routing — split the commit's events by resolved entity tier.
      // A `live`-tier event goes to the live (no-history) variant; everything
      // else goes through the durable variant byte-for-byte. Without a live
      // pipeline configured, every event takes the durable lane exactly as
      // before — this routing is a no-op for existing servers. The result is
      // reassembled in the handler's original emission order.
      const partition = (commit.events         ).map((e, index) => {
        const live = livePipeline !== undefined
          && tierOfEvent !== undefined
          && tierOfEvent(handleOfEvent(e)) === 'live';
        return { e, index, live };
      });
      const durableBatch = partition.filter((p) => !p.live).map((p) => p.e);
      const liveBatch = partition.filter((p) => p.live).map((p) => p.e);
      if (directive !== undefined && liveBatch.length > 0) {
        throw new TypeError(`action '${type}' returned an erasure directive for a live-tier entity — live entities have no undo history to erase`);
      }

      const requirePrivateFact = (pipeline.requiresPrivateFact?.(commit.events, type) ?? false)
        || (livePipeline?.requiresPrivateFact?.(commit.events, type) ?? false)
        || Boolean(handler?.compoundContributionPolicy);
      // Canonicalize and persist before any opted-in projection can observe the
      // fact. All writes remain inside this origin transaction. For a composed
      // action the adapter has already assigned the package-constructed compound
      // envelope to commit.privateFact; a missing envelope fails closed even for
      // a zero-event compensation no-op (scope#992 rev 4).
      const privateFact = declarePostCommitEffectsInTxn(db, {
        scope, actionId, committedAt: now, privateFact: commit.privateFact,
        effects: commit.effects, requirePrivateFact,
      });
      if (handler?.compoundContributionPolicy && commit.privateFact === undefined) {
        throw new TypeError('compound registered action requires a canonical private fact');
      }
      // Application projections observe only the narrow application view of a
      // compound envelope (scope#992 rev 4); the full canonical envelope stays
      // for storage and the package contribution policy.
      const projectionPrivateFact = privateFact === undefined ? undefined : applicationPrivateFactView(privateFact);
      const canonicalPayload = commit.canonicalPayload ?? payload;
      const durableResult = durableBatch.length > 0
        ? await pipeline.applyInTxn(db, durableBatch, {
          now, actionId, nextSeq, principal, payload: canonicalPayload, type, scope, privateFact: projectionPrivateFact,
          claimedBlobs: commit.claimedBlobs,
        })
        : [];
      const liveResult = liveBatch.length > 0
        ? await livePipeline.applyInTxn(db, liveBatch, {
          now, actionId, principal, payload: canonicalPayload, type, scope, privateFact: projectionPrivateFact,
          claimedBlobs: commit.claimedBlobs,
        })
        : [];
      // Reassemble the finalized events in the handler's original emission
      // order (both variants preserve their sub-batch order).
      const durableIndexes = partition.filter((p) => !p.live).map((p) => p.index);
      const liveIndexes = partition.filter((p) => p.live).map((p) => p.index);
      const result = (commit.events         ).map((_     , index        ) => {
        const livePosition = liveIndexes.indexOf(index);
        if (livePosition !== -1) return liveResult[livePosition];
        const durablePosition = durableIndexes.indexOf(index);
        if (durablePosition !== -1) return durableResult[durablePosition];
        return undefined;
      });
      const confirmedThrough = sequences.get(scope) ?? readSeq(db, scope);
      const resultData = commit.authoringReceipt
        ? await commit.authoringReceipt({ db, actionId, scope, confirmedThrough, finalizedEvents: result })
        : Object.freeze({ actionId, confirmedThrough });
      // The owning-stream action receipt (Wave 4.9): written atomically with
      // the events it references, so a retry's dedupe check and a crash
      // recovery always see either both or neither. A live-only commit SKIPS
      // `_ActionReceipt` — it would retain the request payload, which the
      // no-history lane must not (considerations #8/#9); the minimized
      // `_NoHistoryReceipt` was written inside the live variant, atomically
      // with the same commit.
      if (directive !== undefined) {
        const prepared = isErasureDirectivePreparation(directive) ? prepareErasureDirective(db, directive, { excludeActionId: actionId }       ) : directive;
        if (!isErasureDirective(prepared)) throw new TypeError(`action '${type}' returned an invalid erasure directive`);
        await applyErasureDirective(db, prepared, {
          scope, actionId, actionContext: { ...(erasureActionContext                  ?? {}), committedAt: now }, prepare: handler.erasurePrepare,
          tables: handler.erasurePreparationTables, readTables: handler.erasurePreparationReadTables,
        });
      }
      await historyCommit?.apply?.(db);
      // A live-ONLY commit skips `_ActionReceipt` entirely — it would retain the
      // request payload, which the no-history lane must not (considerations
      // #8/#9); the minimized `_NoHistoryReceipt` was written inside the live
      // variant, atomically with the same commit. Any commit that engages the
      // durable lane (including a zero-event durable action) still writes it.
      if (liveBatch.length === 0 || durableBatch.length > 0) {
        const receiptResultData = liveBatch.length > 0
          ? {
            __workbenchMixedReplay: {
              durableIndexes,
              liveIndexes,
              liveEvents: liveResult,
              resultData,
            },
          }
          : resultData;
        insertReceipt(db, scope, actionId, now, durableResult, directive === undefined
          ? {
            ...historyCommit?.metadata,
             actionType: type ?? historyCommit?.metadata?.actionType,
               actionData: commit.canonicalPayload ?? historyCommit?.metadata?.actionData ?? payload,
              resultData: receiptResultData,
              ...(commit.historyOutcome ? { historyOutcome: commit.historyOutcome } : {}),
          }
          : { actionType: type, actionData: { version: 1 }, operation: 'erasure' });
      }
      return Object.freeze({ events: result, resultData, durableEvents: durableResult, liveEvents: liveResult });
    });
  } catch (err) {
    const batchError = err                                                                                                   ;
    if (batchError?.[BATCH_HANDLER_FAILURE]) {
      return executionFailure(
        batchError.error,
        { actionId, type: (payload         )[batchError.actionIndex ?? 0]?.type },
        { actionIndex: batchError.actionIndex },
      );
    }
    return executionFailure(err, { actionId });
  }

  // Post-commit fan-out: the durable consumers see the durable events, the
  // live consumers see the live events (a consumer that must observe BOTH tiers
  // — e.g. the search-staleness seam — is wired into both pipelines). A
  // fan-out failure never turns a committed mutation into a reported failure.
  try {
    await pipeline.afterCommit(committed.durableEvents, { db, actionId });
  } catch (err) {
    getLog().error('dispatch', 'post-commit delivery failed', { err, actionId });
  }
  try {
    await livePipeline?.afterCommit?.(committed.liveEvents, { db, actionId });
  } catch (err) {
    getLog().error('dispatch', 'post-commit delivery failed', { err, actionId });
  }
  return Object.freeze({ ...successOutcome(committed.events), resultData: committed.resultData });
}

function receiptMetadata(request     , historyCommit     ) {
  const clientId = request.clientId;
  const historySession = request.history?.session;
  const historyIdentity = request.history?.identity;
  if (clientId === undefined) return historyCommit;
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new ValidationError('clientId must be a non-empty string');
  }
  if (historySession !== undefined && historySession !== clientId) {
    throw new ValidationError('clientId must match history.session when both are provided');
  }
  return {
    ...historyCommit,
    metadata: {
      ...historyCommit?.metadata,
      principalKey: principalKeyOf(request.principal),
      sessionId: historyIdentity ?? clientId,
    },
  };
}

// gate's default-on requireUser(). Authorization is always an explicit function
// (AGENTS.md: never a magic default); omitting it is a load-time error. When
// Phase 2 wires this kernel to a request path, `authorize` is where the route
// gate + grant engine compose — it is not a second, looser auth path.
export function createServer({ handlers = {}, authorize, db, pipeline = durableMutationVariant(), livePipeline, tierOfEvent, history, historyActions = {}, cursorPolicy, contributionPolicies = null, authorization }




            


                                                                    









  = {}) {
  if (typeof authorize !== 'function') {
    throw new Error(
      `createServer requires an authorize function. There is no default — a ` +
        `default-open authorize would admit every action (fail open). ` +
        `Authorization is always an explicit function: pass ` +
        `authorize: ({ type, payload, principal }) => boolean.`,
    );
  }
  if (db && pipeline?.name !== 'durable.mutation') {
    throw new Error(`durable createServer requires the 'durable.mutation' pipeline variant.`);
  }
  if (livePipeline && livePipeline.name !== 'live.mutation') {
    throw new Error(`live createServer requires the 'live.mutation' pipeline variant.`);
  }
  if (livePipeline && !db) {
    throw new Error('live mutations require a durable database.');
  }
  if (livePipeline && !tierOfEvent) {
    throw new Error(`live createServer requires a tierOfEvent resolver to route live-tier entities away from _Log.`);
  }
  if (history && !db) throw new Error('durable history requires a durable database');
  const authorizeFn = authorize                             ;

  // ---- ephemeral path (no db) — synchronous, in-memory ----
  if (!db) {
    const log        = [];     // append-only event log
    const sequences = new Map();    // scope → last assigned sequence number
    const dispatched = new Map();   // owning scope → action id → events (dedupe)

    function nextSeq(scope     ) {
      const seq = (sequences.get(scope) ?? 0) + 1;
      sequences.set(scope, seq);
      return seq;
    }

    // A live-tier event on the in-memory (no-db) kernel is a fail-closed
    // refusal (#114 review #1): the live lane's tables exist only on a real
    // database, so committing a live entity's mutation to the in-memory durable
    // log would silently degrade it to history semantics (no revision bump, no
    // minimized receipt, no invalidation marker). `createServer` refuses a
    // no-db live pipeline at assembly; this refuses at dispatch, before any
    // in-memory event/log entry is written.
    const emitsLiveTier = (events       ) => tierOfEvent !== undefined
      && events.some((e) => tierOfEvent(handleOfEvent(e)) === 'live');

    // A live-tier ATOMIC action must be refused with the same named error
    // BEFORE the handler runs (#114): the in-memory kernel has no transaction to
    // resolve the `atomic` context from, so an atomic handler invoked here would
    // throw an internal `atomic.row` error that bypasses the fail-closed refusal
    // (the post-hoc emitsLiveTier check below never sees its events). The tier
    // is resolved off the atomic registration's entity name — the handle the
    // handler's own update event would carry — so a `live`-tier entity is
    // refused before any handler/atomic context work. An unresolvable entity
    // name falls back to the durable lane (treated as not live), matching
    // handleOfEvent's unparseable-type fallback.
    const liveAtomicRefusal = (handler     , context                         , details          ) => {
      if (tierOfEvent === undefined || handler?.atomicOperation?.entity?.name === undefined) return null;
      let live = false;
      try {
        live = tierOfEvent(parseEventType(`${handler.atomicOperation.entity.name}.updated`)) === 'live';
      } catch {
        live = false;
      }
      if (!live) return null;
      return executionFailure(
        new ValidationError(
          'live-tier mutations require a durable database — live mutations write no _Log row ' +
          'and need the _LiveRevision, _InvalidationLedger, and _NoHistoryReceipt tables a database provides',
        ),
        context,
        details,
      );
    };

    function dispatch({ actionId, type, payload, principal, scope = '' }     ) {
      const handler = checkHandler(handlers, type);
      if (!handler) return unknownActionOutcome(type);
      // A protected-artefact store needs the durable transaction the in-memory
      // kernel cannot provide — fail closed instead of silently dropping the
      // capability (the handler would otherwise write nothing and commit anyway).
      if (handler.protectedArtefactTables?.length) {
        return executionFailure(
          new ValidationError(`action '${type}' declares protected artefacts and requires a durable database`),
          { actionId, type },
        );
      }

      // Fork C — AUTHORIZE FIRST. A retried action by a since-revoked principal
      // returns denied (403), even if the mutation already committed. This
      // reverses the old kernel which checked dedupe before authorize.
      let authorized;
      try {
        authorized = authorizeFn({ type, payload, principal });
      } catch (err) {
        return executionFailure(err, { actionId, type });
      }
      const denied = authorizedOrDenied(authorized);
      if (denied) return denied;

      try {
        handler.preDedupe?.({ payload, principal, scope });
      } catch (err) {
        return executionFailure(err, { actionId, type });
      }

      // Idempotent dedupe: a re-sent action returns its stored events without
      // re-running the handler — no duplicate state change (SPEC §7).
      const dedupe = checkInMemoryDedupe(dispatched, scope, actionId);
      if (dedupe) return dedupe;

      // Refuse a live-tier atomic action before running it (no-db fail-closed,
      // #114): the in-memory kernel cannot resolve its `atomic` context.
      const liveRefusal = liveAtomicRefusal(handler, { actionId, type });
      if (liveRefusal) return liveRefusal;

      // Run the handler, then assign each emitted event a per-scope monotonic
      // sequence number and append to the log.
      let events;
      try {
        const emitted = handler({
          payload, principal, scope,
          ...(authorization !== undefined && authorization !== null ? { authorization } : {}),
        });
        events = emitted.map((e     ) =>
          Object.freeze({ ...e, seq: nextSeq(e.scope), actionId }));
      } catch (err) {
        return executionFailure(err, { actionId, type });
      }
      if (emitsLiveTier(events)) {
        return executionFailure(
          new ValidationError(
            'live-tier mutations require a durable database — live mutations write no _Log row ' +
            'and need the _LiveRevision, _InvalidationLedger, and _NoHistoryReceipt tables a database provides',
          ),
          { actionId, type },
        );
      }
      for (const e of events) log.push(e);

      recordInMemoryDispatch(dispatched, scope, actionId, events);
      return successOutcome(events);
    }

    function dispatchBatch({ actionId, actions = [], principal, scope = '' }                                                                 ) {
      if (actions.length === 0) return successOutcome([]);
      const missingIdx = checkHandlers(handlers, actions);
      if (missingIdx !== -1) {
        return unknownActionOutcome(actions[missingIdx].type, { actionIndex: missingIdx });
      }
      const batchForbiddenIdx = actions.findIndex((action) => handlers[action.type].batchForbidden);
      if (batchForbiddenIdx !== -1) {
        return executionFailure(
          new ValidationError(`action '${actions[batchForbiddenIdx].type}' requires single dispatch`),
          { actionId, type: actions[batchForbiddenIdx].type },
          { actionIndex: batchForbiddenIdx },
        );
      }
      const privateProjectionIdx = actions.findIndex((action) => handlers[action.type].privateFactProjection);
      if (privateProjectionIdx !== -1) {
        return executionFailure(
          new ValidationError(`action '${actions[privateProjectionIdx].type}' with a private-fact projection requires single dispatch`),
          { actionId, type: actions[privateProjectionIdx].type },
          { actionIndex: privateProjectionIdx },
        );
      }
      for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
        const action = actions[actionIndex];
        let authorized;
        try {
          authorized = authorizeFn({ type: action.type, payload: action.payload, principal });
        } catch (err) {
          return executionFailure(err, { actionId, type: action.type }, { actionIndex });
        }
        const denied = authorizedOrDenied(authorized, { actionIndex });
        if (denied) return denied;
      }
      const dedupe = checkInMemoryDedupe(dispatched, scope, actionId);
      if (dedupe) return dedupe;
      // Refuse a live-tier atomic action before running ANY handler in the batch
      // (no-db fail-closed, #114): the in-memory kernel cannot resolve its
      // `atomic` context, and a batch is all-or-nothing — no handler may run
      // when a member would fail with the named live-tier refusal.
      for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
        const liveRefusal = liveAtomicRefusal(
          handlers[actions[actionIndex].type],
          { actionId, type: actions[actionIndex].type },
          { actionIndex },
        );
        if (liveRefusal) return liveRefusal;
      }
      const allEmitted = [];
      for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
        const action = actions[actionIndex];
        try {
          allEmitted.push(...handlers[action.type]({
            payload: action.payload, principal, scope,
            ...(authorization !== undefined && authorization !== null ? { authorization } : {}),
          }));
        } catch (err) {
          return executionFailure(err, { actionId, type: action.type }, { actionIndex });
        }
      }
      let events;
      try {
        events = allEmitted.map((e     ) =>
          Object.freeze({ ...e, seq: nextSeq(e.scope), actionId }));
      } catch (err) {
        return executionFailure(err, { actionId });
      }
      if (emitsLiveTier(events)) {
        return executionFailure(
          new ValidationError(
            'live-tier mutations require a durable database — live mutations write no _Log row ' +
            'and need the _LiveRevision, _InvalidationLedger, and _NoHistoryReceipt tables a database provides',
          ),
          { actionId, type: actions[0]?.type },
        );
      }
      for (const e of events) log.push(e);
      recordInMemoryDispatch(dispatched, scope, actionId, events);
      return successOutcome(events);
    }

    return { dispatch, dispatchBatch, log };
  }

  // ---- durable path (db engaged) — async, SQLite-backed ----

  // The durable dispatch: authorize (Fork C, outside txn — revoked-principal
  // detection before dedupe) → dedupe by actionId → run handler → commit
  // events inside a write transaction. Authorize ALSO runs INSIDE the
  // transaction (Wave 4.4), atomic with log, cursor, projection, and receipt.
  async function dispatch(request     ) {
    const { actionId, type, payload, principal, scope = '' } = request;
    const handler = checkHandler(handlers, type);
    if (!handler) return unknownActionOutcome(type);

    // Capture admitted request identity before authorization, pre-dedupe hooks,
    // or handlers can mutate application-owned request objects.
    let erasureActionContext;
    try {
      erasureActionContext = handler.erasurePrepare === undefined ? undefined : {
        id: actionId, type, scope, operation: 'erasure',
        payload: structuredClone(payload),
        principal: { type: principal.type, id: principal.id },
      };
    } catch (err) {
      return executionFailure(err, { actionId, type });
    }

    let historyCommit;
    try {
      historyCommit = receiptMetadata(request, request._historyCommit ?? historyRuntime?.normalCommit(request));
    } catch (err) {
      return executionFailure(err, { actionId, type });
    }

    // Fork C — AUTHORIZE FIRST (outside the transaction). A retried action by a
    // since-revoked principal returns denied (403), even if the mutation already
    // committed. The same authorize runs again inside commitEvents's txn (Wave 4.4)
    // for crash atomicity; the outer check is the Fork C semantic gate.
    let authResult;
    try {
      authResult = await authorizeFn({ type, payload, principal });
    } catch (err) {
      return executionFailure(err, { actionId, type });
    }
    const denied = authorizedOrDenied(authResult);
    if (denied) return denied;

    try {
      handler.preDedupe?.({ payload, principal, scope, db, ...(historyCommit?.handlerInputs ? { history: historyCommit.handlerInputs[0] } : {}) });
    } catch (err) {
      return executionFailure(err, { actionId, type });
    }

    // Dedupe by the owning-stream action receipt (scope, actionId) — Wave 4.9.
    // A re-sent action returns its committed events, in original emission
    // order, without re-running the handler (SPEC §7). Keying on the action's
    // own owning scope (not just actionId) means the same actionId reused
    // under a different owning scope is independent action identity, and a
    // zero-event action is durably deduped via its receipt even though it left
    // no _Log row to key on.
    const mixedDedupe = livePipeline
      ? checkMixedDedupe(db, scope, actionId, request, handler.dedupeReceiptMatches)
      : null;
    if (mixedDedupe) return mixedDedupe;
    const dedupe = checkDurableDedupe(db, scope, actionId, request, handler.dedupeReceiptMatches);
    if (dedupe) return dedupe;
    // S3/A2 — a retried live-tier action settles via its minimized receipt
    // (no second apply) before the handler re-runs. Mirrors the durable dedupe,
    // reading the `_NoHistoryReceipt` table instead of `_ActionReceipt`.
    if (livePipeline) {
      const liveDedupe = checkLiveDedupe(db, scope, actionId);
      if (liveDedupe) return liveDedupe;
    }

    // Run the handler — events only, no DB writes (Fork A: entity-as-projection).
    // The handler may be sync or async.
    let emitted = null;
    if (!handler.inTransaction && !historyCommit?.handlerInputs) {
      try {
        emitted = await handler({
          payload, principal, scope,
          ...(authorization !== undefined && authorization !== null ? { authorization } : {}),
        });
      } catch (err) {
        return executionFailure(err, { actionId, type });
      }
    }

    // Apply events and authorize inside a write transaction using the shared brace.
    // Wave 4.4: authorize is the first operation inside the txn, so auth failure
    // rolls back cleanly with no partial state. node:sqlite's DatabaseSync is
    // single-writer; BEGIN/COMMIT serialize writes.
    const now = new Date().toISOString();
    const committed = await commitEvents(db, emitted, {
      now, actionId, principal, payload, pipeline, livePipeline, tierOfEvent, scope, type, authorize, historyCommit,
      handler: handler.inTransaction || historyCommit?.handlerInputs ? handler : null, erasureActionContext,
      authorization, contributionPolicies,
    });
    return committed;
  }

  // dispatchBatch({ actionId, actions, principal }) — the batched mutation
  // (SPEC §11, ADR #13). N actions across one or more entities run in ONE
  // transaction = ONE composed commit (one actionId, one `now`). The batch is
  // all-or-nothing: any authorize/handler/post-grant denial rolls back the
  // ENTIRE batch (a half-applied multi-entity mutation is exactly the split the
  // one-transaction guarantee forbids). This is the singular-system extension
  // of `dispatch`: the same handler→durable variant path, looped over N actions
  // but with ONE BEGIN/COMMIT bracketing the concatenated events — not a second
  // pipeline (AGENTS.md). Effects fire in-txn exactly as in `dispatch`.
  //
  // Authorization runs at TWO points: Fork C outside the txn (revoked-principal
  // detection before dedupe/write) AND inside commitEvents's txn (Wave 4.4)
  // for crash atomicity with log, cursor, projection, and receipt writes.
  async function dispatchBatch(request     ) {
    const { actionId, actions = [], principal, scope = '' } = request                                                                   ;
    let historyCommit;
    try {
      historyCommit = receiptMetadata(request, request._historyCommit ?? historyRuntime?.normalCommit(request));
    } catch (err) {
      return executionFailure(err, { actionId });
    }

    if (actions.length === 0) {
      return successOutcome([]);
    }

    const missingIdx = checkHandlers(handlers, actions);
    if (missingIdx !== -1) {
      return unknownActionOutcome(actions[missingIdx].type, { actionIndex: missingIdx });
    }
    const batchForbiddenIdx = actions.findIndex((action) => handlers[action.type].batchForbidden);
    if (batchForbiddenIdx !== -1) {
      return executionFailure(
        new ValidationError(`action '${actions[batchForbiddenIdx].type}' requires single dispatch`),
        { actionId, type: actions[batchForbiddenIdx].type },
        { actionIndex: batchForbiddenIdx },
      );
    }
    const privateProjectionIdx = actions.findIndex((action) => handlers[action.type].privateFactProjection);
    if (privateProjectionIdx !== -1) {
      return executionFailure(
        new ValidationError(`action '${actions[privateProjectionIdx].type}' with a private-fact projection requires single dispatch`),
        { actionId, type: actions[privateProjectionIdx].type },
        { actionIndex: privateProjectionIdx },
      );
    }

    // Fork C — AUTHORIZE EVERY action FIRST (outside the txn). A retried
    // batch by a since-revoked principal returns denied (403). The same
    // authorize runs again inside commitEvents's txn (Wave 4.4) for crash
    // atomicity; the outer check is the Fork C semantic gate.
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const action = actions[actionIndex];
      let authResult;
      try {
        authResult = await authorizeFn({ type: action.type, payload: action.payload, principal });
      } catch (err) {
        return executionFailure(err, { actionId, type: action.type }, { actionIndex });
      }
      const denied = authorizedOrDenied(authResult, { actionIndex });
      if (denied) return denied;
    }

    // Dedupe the whole batch by its owning-stream action receipt (Wave 4.9) —
    // same (scope, actionId) identity as `dispatch`, one grammar for both.
    const mixedDedupe = livePipeline
      ? checkMixedDedupe(db, scope, actionId, actions, (receipt, retryActions) =>
        receipt.actionType === '$batch' && receipt.actionData === canonicalStringify(retryActions))
      : null;
    if (mixedDedupe) return mixedDedupe;
    const dedupe = checkDurableBatchDedupe(db, scope, actionId, actions);
    if (dedupe) return dedupe;
    // S3/A2 — a retried live-tier batch settles via its minimized receipt.
    // The receipt stores no envelope, so a reused actionId under the same scope
    // always dedupes (idempotency contract: same actionId, same settled
    // outcome); the durable batch's envelope fingerprint does not exist here.
    if (livePipeline) {
      const liveDedupe = checkLiveDedupe(db, scope, actionId);
      if (liveDedupe) return liveDedupe;
    }

    // Run every handler, concatenating their emitted events. Handlers are pure
    // (events only, no DB writes — Fork A), so the batch runs them in order and
    // folds all events into one commitEvents pass below. Atomic handlers are
    // resolved and admitted in that same transaction before receiving their
    // framework-owned atomic context. Authorization runs INSIDE commitEvents's
    // txn (Wave 4.4), before applyInTxn.
    //
    // Registered actions mark `inTransaction` so they receive db/now/scope inside
    // the write brace — same contract as single `dispatch`. Running them early
    // without that context made scope-checked handlers fail as Internal error.
    const runHandlers = async (transactionContext      = null) => {
      const handlerContext = transactionContext?.db
        ? {
          db: transactionContext.db,
          now: transactionContext.now,
          scope: transactionContext.scope,
          actionId: transactionContext.actionId,
          ...(authorization !== undefined && authorization !== null ? { authorization } : {}),
        }
        // Preserve the ordinary-batch handler contract: scope is available in
        // both batch modes, while db/clock/action identity are transaction-only.
        : {
          scope,
          ...(authorization !== undefined && authorization !== null ? { authorization } : {}),
        };
      const allEmitted = [];
      for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
        const action = actions[actionIndex];
        try {
          const historyInput = historyCommit?.handlerInputs?.[actionIndex];
          const atomic = transactionContext?.db
            ? await resolveAtomicOperation(handlers[action.type], {
              payload: action.payload,
              principal,
              db: transactionContext.db,
              now: transactionContext.now,
              scope: transactionContext.scope,
              actionId: transactionContext.actionId,
              authorization,
            })
            : undefined;
          const emitted = await handlers[action.type]({
            payload: action.payload, principal,
            ...handlerContext,
            ...(atomic ? { atomic } : {}),
            ...(historyInput ? { history: historyInput } : {}),
          });
          const commit = Array.isArray(emitted) ? { events: emitted } : emitted;
          if (!commit || !Array.isArray(commit.events) || commit.privateFact !== undefined
            || commit.effects !== undefined || commit.directive !== undefined) {
            throw new TypeError(`batched action '${action.type}' handler must return an event array`);
          }
          allEmitted.push(...commit.events);
        } catch (err) {
          throw batchHandlerFailure(err, actionIndex);
        }
      }
      // Receipt identity is the submitted batch envelope (Wave 4.9), not just events.
      return { events: allEmitted, canonicalPayload: actions };
    };
    const runInTxn = Boolean(historyCommit?.handlerInputs)
      || actions.some((action) => handlers[action.type].inTransaction || handlers[action.type].atomicOperation);
    let batchCommit = null;
    if (!runInTxn) {
      try { batchCommit = await runHandlers(); }
      catch (err) {
        const failure = err                                             ;
        return executionFailure(
          failure.error,
          { actionId, type: actions[failure.actionIndex ?? 0]?.type },
          { actionIndex: failure.actionIndex },
        );
      }
    }

    const now = new Date().toISOString();
    // The receipt binds the entire submitted envelope, not merely its emitted
    // events. A retry must prove it is the same batch before deduping.
    const committed = await commitEvents(db, batchCommit, {
      now, actionId, principal, payload: actions, pipeline, livePipeline, tierOfEvent, scope, type: '$batch', authorize, historyCommit,
      handler: runInTxn ? runHandlers : null,
      authorization, contributionPolicies,
    });
    return committed;
  }

  const historyRuntime = history
    ? createDurableHistoryRuntime({
       db, descriptor: history, generatedActions: historyActions, dispatch, dispatchBatch, authorize, cursorPolicy, contributionPolicies,
    })
    : undefined;
  return { dispatch, dispatchBatch, history: historyRuntime, db, log: [] };  // log is the durable _Log table; empty array for compat
}

// createClient({ events }) — the client-side reconciliation path (SPEC §7 stage
// 7, §7.1). `ingest` is the ONLY place an event becomes client state: it folds
// each event through its declared reducer exactly once and advances a per-scope
// sequence cursor. The same ingest handles the client's own echoed events and
// foreign live events — there is no second apply path (AGENTS.md, one
// reconciliation path).
//
// Replay decision is shared with LiveList via `decideReplay` (span-aware):
//  - duplicate — idempotent skip; no fold, cursor unchanged.
//  - gap       — do NOT apply; signal a resync.
//  - next      — reduce once, advance the cursor to span hi.
export function createClient({ events = [] }                                                                                  = {}) {
  // Reducer registry, keyed by event type. An event type with no reducer here
  // has nothing to fold — ingesting it is an error, not a silent drop.
  const reducers = new Map(events.map((e) => [e.type, e.reduce]));

  const states = new Map();   // scope → folded state
  const cursors = new Map();  // scope → last applied sequence number

  const cursor = (scope     ) => cursors.get(scope) ?? 0;
  const state = (scope     ) => states.get(scope);

  // Bootstrap: adopt a snapshot and set the cursor to the snapshot's sequence
  // BEFORE any live event is ingested. Ordering is load-bearing — a live event
  // ingested before the snapshot would resync into an empty state and then be
  // overwritten, losing the event (SPEC §7.1).
  function bootstrap(scope     , snapshot     , seq     ) {
    states.set(scope, snapshot);
    cursors.set(scope, seq);
  }

  function ingest(incoming     ) {
    const { type, scope, seq, seqSpan } = incoming;
    const reduce = reducers.get(type);
    if (typeof reduce !== 'function') {
      throw new Error(
        `no reducer for event type '${type}'. The client can only ingest event ` +
          `types it was created with. Declare event('${type}', reduce) and pass ` +
          `it in createClient({ events }).`,
      );
    }

    const decision = decideReplay(cursor(scope), seqSpan ?? seq);
    if (decision.kind === 'duplicate') {
      return { applied: false, duplicate: true };
    }
    if (decision.kind === 'gap') {
      return { applied: false, resync: true };
    }

    // next — fold exactly once and advance the cursor to span hi.
    states.set(scope, reduce(state(scope) ?? {}, incoming));
    cursors.set(scope, decision.cursor);
    return { applied: true };
  }

  return { ingest, bootstrap, state, cursor };
}
