// Named, pre-validated dispatch pipeline variants (durable / live). Effects
// recurse through the SAME named variant (ADR #6, #22).


import { appendEvents, noHistoryReceiptFor, insertNoHistoryReceipt, bumpRevision, readRevision as readLiveRevision, guardExpectedRevision } from './committed-log.mjs';
import { isPlainObject, ValidationError } from './field-strategy.mjs';
import { isAtomicOperation } from './atomic-operations.mjs';
import { writeInvalidationInTxn } from './invalidation-ledger.mjs';
import { postCommitTurnsDrained } from './write-queue.mjs';
import { getLog } from './log.mjs';
import { captureCompositeBeforeEvidence, recordCompositeJournalEvidence } from './pipeline-composite.mjs';
import {
  effectEventsFor, noAdmission, noBlobAdapter, reportConsumerError,
  runPreProjectionAdmission, finalizeEvents, applyProjectionConsumers,
  runPostProjectionAdmission, runInTxnEffects,


} from './pipeline-event-core.mjs';

function createMutationVariant        ({
  name,
  label,
  options,
  beforeApply,
  prepareEvents,
  afterAnnotatedAdmission,
  afterEffects,
  recursiveArgs,
}








 ) {
  const {
    projectionConsumers = [],
    admission = noAdmission()                     ,
    blobAdapter = noBlobAdapter(),
    effectsRegistry = null,
    executeEffectsForEvent = null,
    postCommitConsumers = [],
    onConsumerError = null,
    maxEffectDepth = 8,
  } = options;
  if (!Number.isInteger(maxEffectDepth) || maxEffectDepth < 0) {
    throw new Error(`${label}: maxEffectDepth must be a non-negative integer`);
  }
  const effectsExecutor = effectEventsFor(effectsRegistry, executeEffectsForEvent);
  const variant = {
    name,
    async applyInTxn(db         , events       , args                ) {
      const {
        now,
        actionId,
        principal,
        depth = 0,
        payload,
        type,
        scope,
        privateFact,
        claimedBlobs,
      } = args;

      const shortCircuit = beforeApply?.(db            , args);
      if (shortCircuit !== null && shortCircuit !== undefined) return shortCircuit;

      // Pre-projection admission — runs IN-TXN against the PRE-mutation row,
      // before log/receipt writes and before projection. Denial leaves zero footprint.
      const annotatedState = await runPreProjectionAdmission(admission, db, events, {
        actionId, type, scope, principal, payload, now,
      });

      const { finalizedEvents, state } = prepareEvents(db            , events, args);

      await applyProjectionConsumers(projectionConsumers, db, finalizedEvents, {
        type, payload, privateFact, claimedBlobs,
      });

      // Blob adoption is in-txn and atomic with the projection + log/receipt writes.
      await blobAdapter.adoptInTxn(db, finalizedEvents);

      // Application-owned annotation admission runs after projection has
      // materialized the new annotation images and before any receipt write.
      if (admission.annotatedMutation !== undefined) {
        await admission.annotatedMutation.after({
          db, events: finalizedEvents, state: annotatedState, actionId, actionType: type, scope, principal, payload, now,
        });
      }

      afterAnnotatedAdmission?.(db            , finalizedEvents, args, state);

      await runPostProjectionAdmission(admission, db, finalizedEvents, { principal, now, payload });

      // Effects recurse through this SAME named variant (ADR #6, #22).
      await runInTxnEffects(effectsExecutor, {
        db,
        finalizedEvents,
        now,
        actionId,
        principal,
        depth,
        maxEffectDepth,
        recurse: async (effectEvents, effectPrincipal, nextDepth) => {
          await variant.applyInTxn(db, effectEvents, recursiveArgs(args, effectPrincipal, nextDepth));
        },
      });

      afterEffects?.(db            , finalizedEvents, args, state);

      return finalizedEvents;
    },
    requiresPrivateFact(events       , actionType         ) {
      return projectionConsumers.some((consumer) => consumer.privateFact === true
        && (consumer.actionType === undefined || consumer.actionType === actionType)
        && events.some((event) => consumer.eventTypes.includes(event.type)));
    },
    async afterCommit(events         , context         ) {
      const actionId = (context                                )?.actionId;
      // A hook passed to createServer (and threaded through commitEvents'
      // context) applies even when this variant was built without one.
      const consumerErrorHook = onConsumerError
        ?? (context                                                                   )?.onConsumerError
        ?? null;
      const dbForPostCommit = (context                          )?.db;
      for (const [consumerIndex, consumer] of postCommitConsumers.entries()) {
        try {
          await consumer(events, context);
          // A consumer may leave a cursor/ledger turn on the coordinator's
          // post-commit lane (a nested dispatch re-entering this same mutex
          // turn is the common case). Drain it before the next consumer so no
          // two consumers ever hold an open BEGIN IMMEDIATE on this connection.
          await postCommitTurnsDrained(dbForPostCommit);
        } catch (err) {
          // A post-commit fan-out failure never undoes the committed dispatch.
          // It is no longer silent: structured log + an optional app hook give
          // ops a truthful signal while the origin stays committed.
          getLog().warn('dispatch', 'post-commit consumer failed', {
            err, actionId, consumerIndex, variant: name,
          });
          reportConsumerError(consumerErrorHook, err, 'consumer', actionId, consumerIndex);
        }
      }
    },
  };
  return Object.freeze(variant);
}

export function durableMutationVariant({
  compositeJournal,
  ...options
}


  = {}) {
  return createMutationVariant                          ({
    name: 'durable.mutation',
    label: 'durableMutationVariant',
    options,
    prepareEvents(db, events, { now, actionId, nextSeq }) {
      // Append events to _Log with per-scope sequence numbers. NOW tokens are
      // resolved to the commit-time ISO before serialization (ADR #24).
      const finalizedEvents = finalizeEvents(events, {
        now,
        actionId,
        nextSeq: nextSeq ,
        preserveV16Capability: true,
      });
      appendEvents(db, finalizedEvents);
      // Composite journal evidence pass 1 (#122): capture private before-images
      // BEFORE this action's own projection consumers run.
      const state = captureCompositeBeforeEvidence(db, finalizedEvents, compositeJournal);
      return { finalizedEvents, state };
    },
    afterAnnotatedAdmission(db, finalizedEvents, { actionId, now, privateFact }, compositeEvidence) {
      // Composite journal evidence pass 2 + routing (#122): after projection,
      // capture after-images, route finalized events through patch plans, and
      // record entries atomically with _Log and _ActionReceipt.
      if (compositeJournal !== undefined && (compositeEvidence !== null || finalizedEvents.length > 0)) {
        recordCompositeJournalEvidence(db, finalizedEvents, compositeJournal, compositeEvidence, {
          actionId, now, privateFact,
        });
      }
    },
    recursiveArgs({ now, actionId, nextSeq, payload }, effectPrincipal, nextDepth) {
      return { now, actionId, nextSeq, principal: effectPrincipal, depth: nextDepth, payload };
    },
  });
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
export function liveMutationVariant(options                               = {}) {
  return createMutationVariant      ({
    name: 'live.mutation',
    label: 'liveMutationVariant',
    options,
    beforeApply(db, { scope, actionId }) {
      // Retry backstop: an already-receipted (scope, actionId) never applies a
      // second time — not even when the pre-handler dedupe missed (batch retry,
      // effect re-entrancy).
      if (noHistoryReceiptFor(db, scope          , actionId)) return [];
      return null;
    },
    prepareEvents(db, events, { now, actionId, payload, scope: owningScope }) {
      // No-history sequence allocation: events carry a transaction-local seq so
      // projections and consumers observe a monotonic per-scope order without
      // reading or writing `_Cursor`.
      const liveSeqs = new Map                ();
      const nextLiveSeq = (eventScope        )         => {
        const seq = (liveSeqs.get(eventScope) ?? 0) + 1;
        liveSeqs.set(eventScope, seq);
        return seq;
      };
      const finalizedEvents = finalizeEvents(events, {
        now,
        actionId,
        nextSeq: nextLiveSeq,
        preserveV16Capability: false,
      });

      // Expected-revision guard (S3/A2 hook; S3/A6 optimistic concurrency).
      const expectedRevision = isPlainObject(payload) ? (payload                           ).expectedRevision : undefined;
      if (expectedRevision !== undefined) {
        const guardScope = finalizedEvents[0]?.scope ?? owningScope;
        guardExpectedRevision(db, guardScope          , expectedRevision);
      }

      // Validate atomicOperations grammar before projection/receipt/revision bump.
      const atomicOperations = isPlainObject(payload) ? (payload                           ).atomicOperations : undefined;
      if (atomicOperations !== undefined
        && (!Array.isArray(atomicOperations) || !atomicOperations.every(isAtomicOperation))) {
        throw new ValidationError('atomicOperations must be an array of known atomic operations');
      }
      return { finalizedEvents, state: undefined };
    },
    recursiveArgs({ now, actionId, payload, type, scope }, effectPrincipal, nextDepth) {
      return { now, actionId, principal: effectPrincipal, depth: nextDepth, payload, type, scope };
    },
    afterEffects(db, finalizedEvents, { now, actionId, principal, scope: owningScope }) {
      // Revision bump and invalidation marker share this transaction with the
      // projection. The ledger proves live reconnect cursors without retaining
      // the mutation payload or creating a second history.
      const touched = new Map                ();
      for (const ev of finalizedEvents) {
        const revision = bumpRevision(db, ev.scope);
        touched.set(ev.scope, revision);
        writeInvalidationInTxn(db, {
          resourceKey: ev.scope,
          kind: 'resource',
          revision,
          updatedAt: now,
        });
      }
      const resourceKey = finalizedEvents[0]?.scope ?? (owningScope          );
      const committedRevision = touched.get(resourceKey) ?? readLiveRevision(db, resourceKey);
      const actor = principal                                                       ;
      insertNoHistoryReceipt(db, {
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
    },
  });
}
