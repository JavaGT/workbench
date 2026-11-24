import { durableMutationVariant } from './pipeline-variants.ts';
import type { WriteQueue } from './write-queue.ts';
import type { DataTier } from './live-tier.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import { resolveServerWriteQueue } from './pipeline-write-queue.ts';
import { createInMemoryServer } from './pipeline-in-memory.ts';
import { readHandlerPolicy, type PipelineCommitHook } from './pipeline-kernel.ts';
import { ValidationError } from './field-strategy.ts';
import { principalKeyOf } from './principal.ts';
import { createDurableHistoryRuntime } from './durable-history.ts';
import type { PostCommitConsumerErrorHook } from './pipeline-event-core.ts';
import { checkHandler, checkHandlers, unknownActionOutcome, executionFailure, successOutcome, authorizedOrDenied, resolveAtomicOperation, batchHandlerFailure } from './pipeline-outcomes.ts';
import { singleDispatchDedupe, batchDispatchDedupe } from './pipeline-dedupe.ts';
import { commitEvents } from './pipeline-commit.ts';

function receiptMetadata(request: any, historyCommit: any) {
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

// gate's default-on requireUser(). Authorization is always an explicit function
// (AGENTS.md: never a magic default); omitting it is a load-time error. When
// Phase 2 wires this kernel to a request path, `authorize` is where the route
// gate + grant engine compose — it is not a second, looser auth path.

export function createServer({ handlers = {}, authorize, db, pipeline = durableMutationVariant(), livePipeline, tierOfEvent, history, historyActions = {}, cursorPolicy, contributionPolicies = null, authorization, writeQueue = null, commitHook = null, onConsumerError = null }: {
  handlers?: Record<string, any>;
  authorize?: (context: any) => any;
  db?: any;
  pipeline?: any;
  // S3/A2 — the no-history mutation lane. `livePipeline` is a
  // `liveMutationVariant()`; `tierOfEvent` resolves an event's handle to its
  // live-data tier ('live' events route to the live pipeline, everything else
  // through the durable pipeline). Both must be supplied together — a live
  // pipeline without a resolver routes nothing, which would silently keep
  // writing live entities into `_Log`.
  livePipeline?: any;
  tierOfEvent?: (handle: any) => DataTier | undefined;
  history?: any;
  historyActions?: Record<string, any>;
  cursorPolicy?: any;
  contributionPolicies?: any;
  authorization?: AuthorizationAdapter | null;
  /** Optional platform WriteQueue; when omitted on a durable server, the handle's attached queue is reused (or one is created and attached). */
  writeQueue?: WriteQueue | null;
  /** Optional domain-kind commit hook wired by the kernel seam. */
  commitHook?: PipelineCommitHook | null;
  /** Optional consumer-failure observability hook; never changes the committed outcome. */
  onConsumerError?: PostCommitConsumerErrorHook | null;
} = {}) {
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
  const authorizeFn = authorize as (context: any) => unknown;


  if (!db) return createInMemoryServer({ handlers, authorizeFn, tierOfEvent, authorization });


  // ---- durable path (db engaged) — async, SQLite-backed ----
  // A caller-supplied WriteQueue is THE platform mutex; never substitute a
  // private one for it (that would let other coordinated writers interleave).
  // Without one, reuse the handle's attached coordinator (or create + attach
  // exactly one) so two servers over the same db never mint rival mutexes.
  const serverWriteQueue = resolveServerWriteQueue(db, writeQueue);

  // The durable dispatch: authorize (Fork C, outside txn — revoked-principal
  // detection before dedupe) → dedupe by actionId → run handler → commit
  // events inside a write transaction. Authorize ALSO runs INSIDE the
  // transaction (Wave 4.4), atomic with log, cursor, projection, and receipt.
  async function dispatch(request: any) {
    const { actionId, type, payload, principal, scope = '' } = request;
    const handler = checkHandler(handlers, type);
    if (!handler) return unknownActionOutcome(type);

    // Capture admitted request identity before authorization, pre-dedupe hooks,
    // or handlers can mutate application-owned request objects.
    let erasureActionContext;
    try {
      erasureActionContext = readHandlerPolicy(handler).erasurePrepare === undefined ? undefined : {
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
    const dedupeArgs = { scope, actionId, request, receiptMatches: readHandlerPolicy(handler).dedupeReceiptMatches, livePipeline };
    const dedupe = singleDispatchDedupe(db, dedupeArgs);
    if (dedupe) return dedupe;

    // Run the handler — events only, no DB writes (Fork A: entity-as-projection).
    // The handler may be sync or async.
    let emitted = null;
    if (!readHandlerPolicy(handler).inTransaction && !historyCommit?.handlerInputs) {
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
      handler: readHandlerPolicy(handler).inTransaction || historyCommit?.handlerInputs ? handler : null, erasureActionContext,
      authorization, contributionPolicies, writeQueue: serverWriteQueue, commitHook, onConsumerError,
      recheckDedupe: (txnDb) => singleDispatchDedupe(txnDb, dedupeArgs),
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
  async function dispatchBatch(request: any) {
    const { actionId, actions = [], principal, scope = '' } = request as { actionId: any; actions?: any[]; principal: any; scope?: any };
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
    const batchForbiddenIdx = actions.findIndex((action) => readHandlerPolicy(handlers[action.type]).batchForbidden);
    if (batchForbiddenIdx !== -1) {
      return executionFailure(
        new ValidationError(`action '${actions[batchForbiddenIdx].type}' requires single dispatch`),
        { actionId, type: actions[batchForbiddenIdx].type },
        { actionIndex: batchForbiddenIdx },
      );
    }
    const privateProjectionIdx = actions.findIndex((action) => readHandlerPolicy(handlers[action.type]).privateFactProjection);
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
    const dedupeArgs = { scope, actionId, actions, livePipeline };
    const dedupe = batchDispatchDedupe(db, dedupeArgs);
    if (dedupe) return dedupe;

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
    const runHandlers = async (transactionContext: any = null) => {
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
      || actions.some((action) => {
        const policy = readHandlerPolicy(handlers[action.type]);
        return policy.inTransaction || policy.atomicOperation;
      });
    let batchCommit = null;
    if (!runInTxn) {
      try { batchCommit = await runHandlers(); }
      catch (err) {
        const failure = err as { error?: unknown; actionIndex?: number };
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
      authorization, contributionPolicies, writeQueue: serverWriteQueue, commitHook, onConsumerError,
      recheckDedupe: (txnDb) => batchDispatchDedupe(txnDb, dedupeArgs),
    });
    return committed;
  }

  const historyRuntime = history
    ? createDurableHistoryRuntime({
       db, descriptor: history, generatedActions: historyActions, dispatch, dispatchBatch, authorize, cursorPolicy, contributionPolicies,
    })
    : undefined;
  // Expose the coordinating mutex for observability and tests (one per db).
  return { dispatch, dispatchBatch, history: historyRuntime, db, writeQueue: serverWriteQueue, log: [] };  // log is the durable _Log table; empty array for compat
}
