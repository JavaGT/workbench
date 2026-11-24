// Synchronous, in-memory kernel path (no db engaged). Same dispatch grammar as
// the durable path, without a transaction to join.

import { ValidationError } from './field-strategy.mjs';
import { parseEventType } from './event-handle.mjs';


import { readHandlerPolicy } from './pipeline-kernel.mjs';
import { checkHandler, checkHandlers, unknownActionOutcome, executionFailure, authorizedOrDenied, successOutcome } from './pipeline-outcomes.mjs';
import { handleOfEvent, checkInMemoryDedupe, recordInMemoryDispatch } from './pipeline-dedupe.mjs';

export function createInMemoryServer({ handlers, authorizeFn, tierOfEvent, authorization }




 ) {

  // ---- ephemeral path (no db) — synchronous, in-memory ----
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
      const atomicOperation = readHandlerPolicy(handler).atomicOperation;
      if (tierOfEvent === undefined || atomicOperation?.entity?.name === undefined) return null;
      let live = false;
      try {
        live = tierOfEvent(parseEventType(`${atomicOperation.entity.name}.updated`)) === 'live';
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
      if (readHandlerPolicy(handler).protectedArtefactTables?.length) {
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
