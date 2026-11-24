import { readSeq, insertReceipt } from './committed-log.ts';
import { txn, prepareCached, type DbHandle, type DbStatement } from './driver.ts';
import { forbidden } from './outcome.ts';
import { getLog } from './log.ts';
import { postCommitTurnsDrained } from './write-queue.ts';
import { protectedArtefactCapability } from './protected-artefact-store.ts';
import { ownedResourcesCapability } from './owned-resource-purge.ts';
import { applyErasureDirective, isErasureDirective, isErasureDirectivePreparation, prepareErasureDirective } from './erasure-directive.ts';
import { declarePostCommitEffectsInTxn } from './post-commit-effects.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import type { DataTier } from './live-tier.ts';
import type { WriteQueue } from './write-queue.ts';
import { readHandlerPolicy, type PipelineCommitHook } from './pipeline-kernel.ts';
import { CURSOR_UPSERT_SQL, reportConsumerError, type PostCommitConsumerErrorHook } from './pipeline-event-core.ts';
import { executionFailure, BATCH_HANDLER_FAILURE, DEDUPED_IN_TXN, successOutcome, atomicOperationsFor, resolveAtomicOperation } from './pipeline-outcomes.ts';
import { handleOfEvent } from './pipeline-dedupe.ts';

// commitEvents — the durable transaction brace shared by `dispatch` and
// `dispatchBatch`: BEGIN IMMEDIATE → durable variant applyInTxn → COMMIT →
// post-commit fan-out, with ROLLBACK on execution error. Expected failures are
// returned through the stable outcome grammar rather than thrown.
// The `payload` argument is the admission context each caller threads through:
// `dispatch` passes its single action's `payload`, `dispatchBatch` passes the
// `actions` array. The two genuinely differ there, so the brace is extracted but
// the `payload` value stays per-caller. Throws non-403 errors after rolling back;
// Post-commit delivery can no longer turn a committed mutation into a failure.
export async function commitEvents(db: any, events: any, {
  now, actionId, principal, payload, pipeline, livePipeline, tierOfEvent, scope, type, authorize, historyCommit, handler,
  erasureActionContext, authorization, contributionPolicies = null, writeQueue = null, commitHook = null, recheckDedupe = null, onConsumerError = null,
}: {
  now: string;
  actionId: string;
  principal: unknown;
  payload: unknown;
  pipeline: any;
  livePipeline?: any;
  tierOfEvent?: (handle: any) => DataTier | undefined;
  scope: string;
  type: unknown;
  authorize?: (context: any) => unknown | Promise<unknown>;
  historyCommit?: any;
  handler?: any;
  erasureActionContext?: unknown;
  authorization?: AuthorizationAdapter | null;
  contributionPolicies?: any;
  writeQueue?: WriteQueue | null;
  commitHook?: PipelineCommitHook | null;
  /** Re-runs the caller's dedupe decision inside the write-queue turn and txn, after any concurrent retry may have committed. */
  recheckDedupe?: ((db: DbHandle) => unknown) | null;
  onConsumerError?: PostCommitConsumerErrorHook | null;
}) {
  // A batch and any in-transaction effects share one sequence allocator. The
  // first event for a scope reads its committed cursor once; later events use
  // the transaction-local value while still updating _Cursor immediately so
  // projections and admission observe the same cursor semantics as before.
  const sequences = new Map<any, number>();
  const updateCursor = prepareCached<DbStatement>(db, CURSOR_UPSERT_SQL);
  const nextSeq = (eventScope: any): number => {
    let seq = sequences.get(eventScope);
    if (seq === undefined) seq = readSeq(db, eventScope);
    seq += 1;
    sequences.set(eventScope, seq);
    updateCursor.run(eventScope, seq, seq);
    return seq;
  };
  // Serialize transaction entry through the single platform WriteQueue when not
  // already inside an owned coordinator turn (never a second nested mutex).
  const runTransaction = <T>(fn: () => Promise<T>): Promise<T> => (
    writeQueue && !writeQueue.owned
      ? writeQueue.run(() => txn(db, fn))
      : txn(db, fn)
  ) as Promise<T>;
  let committed: any;
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
    committed = await runTransaction(async () => {
      // Concurrent-retry backstop: both callers can pass the pre-handler dedupe
      // before either commits. The writeQueue serializes transaction entry, so
      // the loser sees the winner's receipt here — settle to that exact stored
      // outcome BEFORE authorize, any inTransaction handler, projections, and
      // insertReceipt (which would otherwise collide on the (scope, actionId) PK).
      const deduped = recheckDedupe?.(db as DbHandle);
      if (deduped) return { [DEDUPED_IN_TXN]: true, outcome: deduped };

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
        const policy = readHandlerPolicy(handler);
        // A declared protected-artefact store hands the handler a transaction-
        // bound write/erase authority over exactly its declared application
        // tables, live only for this handler call. The capability joins this
        // origin transaction: any later failure rolls back its writes with the
        // log, cursor, projection, and receipt. It closes after the handler so
        // no later pipeline stage can reach the store.
        const protectedArtefact = policy.protectedArtefactTables?.length
          ? protectedArtefactCapability(db, policy.protectedArtefactTables)
          : null;
        const ownedResources = policy.ownedResources
          ? ownedResourcesCapability(db, policy.ownedResourcePlans ?? []) : null;
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
      if (directive !== undefined && (!readHandlerPolicy(handler).erasureCapable || Array.isArray(payload) || historyCommit?.apply)) {
        throw new TypeError(`action '${type}' cannot return an erasure directive`);
      }
      // A protected-artefact action's request payload must never become the
      // receipt's canonical actionData (undo history reads it): the handler
      // must return a canonicalPayload containing only the non-sensitive IDs
      // and provenance needed to reference the protected artefacts.
      if (readHandlerPolicy(handler).protectedArtefactTables?.length && directive === undefined && commit.canonicalPayload === undefined) {
        throw new TypeError(`action '${type}' declares protected artefacts and must return a canonicalPayload without protected payloads`);
      }

      // Domain-kind commit hook (e.g., composed annotated-text registered
      // actions): transforms the handler's commit inside this coordinated
      // transaction and fails closed on undeclared ambient operations.
      if (commitHook?.transformCommit) {
        commit = await commitHook.transformCommit({
          db,
          handler,
          commit,
          type,
          payload,
          principal,
          scope,
          actionId,
          historyCommit,
          contributionPolicies,
        });
      } else if (readHandlerPolicy(handler).compoundContributionPolicy) {
        throw new TypeError(`composed action '${type}' requires a configured commit hook`);
      }

      // S3/A2 tier routing — split the commit's events by resolved entity tier.
      // A `live`-tier event goes to the live (no-history) variant; everything
      // else goes through the durable variant byte-for-byte. Without a live
      // pipeline configured, every event takes the durable lane exactly as
      // before — this routing is a no-op for existing servers. The result is
      // reassembled in the handler's original emission order.
      const partition = (commit.events as any[]).map((e, index) => {
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

      const hookRequiresPrivateFact = commitHook?.requiresPrivateFact?.(handler) ?? false;
      const requirePrivateFact = (pipeline.requiresPrivateFact?.(commit.events, type) ?? false)
        || (livePipeline?.requiresPrivateFact?.(commit.events, type) ?? false)
        || hookRequiresPrivateFact;
      // Canonicalize and persist before any opted-in projection can observe the
      // fact. All writes remain inside this origin transaction.
      const privateFact = declarePostCommitEffectsInTxn(db, {
        scope, actionId, committedAt: now, privateFact: commit.privateFact,
        effects: commit.effects, requirePrivateFact,
      });
      if (hookRequiresPrivateFact && commit.privateFact === undefined) {
        throw new TypeError('compound registered action requires a canonical private fact');
      }
      // Application projections observe only the narrow application view of a
      // compound envelope when a commit hook supplies one.
      const projectionPrivateFact = privateFact === undefined
        ? undefined
        : (commitHook?.projectionPrivateFactView ? commitHook.projectionPrivateFactView(privateFact) : privateFact);
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
      const result = (commit.events as any[]).map((_: any, index: number) => {
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
        const prepared = isErasureDirectivePreparation(directive) ? prepareErasureDirective(db, directive, { excludeActionId: actionId } as any) : directive;
        if (!isErasureDirective(prepared)) throw new TypeError(`action '${type}' returned an invalid erasure directive`);
        const erasurePolicy = readHandlerPolicy(handler);
        await applyErasureDirective(db, prepared, {
          scope, actionId, actionContext: { ...(erasureActionContext as object | null ?? {}), committedAt: now },
          prepare: erasurePolicy.erasurePrepare,
          tables: erasurePolicy.erasurePreparationTables && [...erasurePolicy.erasurePreparationTables],
          readTables: erasurePolicy.erasurePreparationReadTables && [...erasurePolicy.erasurePreparationReadTables],
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
    const batchError = err as { [BATCH_HANDLER_FAILURE]?: boolean; error?: unknown; actionIndex?: number } | null | undefined;
    if (batchError?.[BATCH_HANDLER_FAILURE]) {
      return executionFailure(
        batchError.error,
        { actionId, type: (payload as any[])[batchError.actionIndex ?? 0]?.type },
        { actionIndex: batchError.actionIndex },
        commitHook,
      );
    }
    return executionFailure(err, { actionId }, undefined, commitHook);
  }

  // A retry that lost the race returns the winner's stored outcome as-is. No
  // new commit happened, so there is nothing to fan out.
  if (committed?.[DEDUPED_IN_TXN]) return committed.outcome;

  // Post-commit fan-out: the durable consumers see the durable events, the
  // live consumers see the live events (a consumer that must observe BOTH tiers
  // — e.g. the search-staleness seam — is wired into both pipelines). A
  // fan-out failure never turns a committed mutation into a reported failure.
  try {
    await pipeline.afterCommit(committed.durableEvents, { db, actionId, onConsumerError });
  } catch (err) {
    getLog().error('dispatch', 'post-commit delivery failed', { err, actionId, phase: 'durable-delivery' });
    reportConsumerError(onConsumerError, err, 'durable-delivery', actionId);
  }
  try {
    await livePipeline?.afterCommit?.(committed.liveEvents, { db, actionId, onConsumerError });
  } catch (err) {
    getLog().error('dispatch', 'post-commit delivery failed', { err, actionId, phase: 'live-delivery' });
    reportConsumerError(onConsumerError, err, 'live-delivery', actionId);
  }
  // The dispatch must not return with a post-commit DB turn still queued: that
  // turn would run later on the same connection, outside the fan-out's ordering
  // and potentially inside the next dispatch's transaction.
  await postCommitTurnsDrained(db as object | null | undefined);
  return Object.freeze({ ...successOutcome(committed.events), resultData: committed.resultData });
}
