// Outcome grammar and the synchronous/dispatch-agnostic helpers shared by the
// four dispatch paths. No transport or transaction concerns live here.

import { failure, failureFromError, failureOutcome } from './outcome.ts';
import { isPlainObject, ValidationError } from './field-strategy.ts';
import { getLog } from './log.ts';
import { executeAtomicOperations, isAtomicOperation, type AtomicExecution, type AtomicOperationContext } from './atomic-operations.ts';
import { admitRowTransition } from './field-admission.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import { readHandlerPolicy, type PipelineCommitHook } from './pipeline-kernel.ts';
import { requireAdmission } from './pipeline-event-core.ts';

export function successOutcome(events: unknown, deduped = false) {
  return Object.freeze({ ok: true, deduped, events });
}

export function deniedOutcome(details?: unknown) {
  return failureOutcome(failure('denied', 'Forbidden.', details as Record<string, unknown> | undefined));
}

export function unknownActionOutcome(type: unknown, details?: unknown) {
  return failureOutcome(failure(
    'unknown-action',
    `No action named '${String(type)}' is registered.`,
    details as Record<string, unknown> | undefined,
  ));
}

export function executionFailure(error: unknown, context: Record<string, unknown> = {}, details?: unknown, commitHook?: PipelineCommitHook | null) {
  const validationDetails = error instanceof ValidationError && isPlainObject((error as { failure?: unknown }).failure)
    ? (error as { failure: Record<string, unknown> }).failure
    : undefined;
  const isConflict = validationDetails !== undefined
    && (commitHook?.isConflictCode?.(validationDetails.code) === true || validationDetails.code === 'annotated-text-stale');
  const normalized = error instanceof ValidationError
    ? failure(isConflict ? 'conflict' : 'invalid-input', (error as Error).message, validationDetails)
    : failureFromError(error);
  if (normalized.category === 'internal') {
    getLog().error('dispatch', 'dispatch failed', { err: error, ...context });
  }
  const withDetails = details
    ? failure(normalized.category, normalized.message, { ...(normalized.details ?? {}), ...(details as Record<string, unknown>) })
    : normalized;
  return failureOutcome(withDetails);
}

export const BATCH_HANDLER_FAILURE = Symbol('workbench.batch-handler-failure');
// Marks a transaction that settled on an already-committed retry: the outcome
// is returned as-is without post-commit fan-out (no new commit happened).
export const DEDUPED_IN_TXN = Symbol('workbench.deduped-in-txn');

export function batchHandlerFailure(error: unknown, actionIndex: number) {
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
export function checkHandler(handlers: Record<string, any>, type: string): any {
  const handler = handlers[type];
  if (typeof handler !== 'function') return null;
  return handler;
}

// Returns the index of the first action without a handler, or -1 if all exist.
export function checkHandlers(handlers: Record<string, any>, actions: any[]): number {
  for (let i = 0; i < actions.length; i++) {
    if (typeof handlers[actions[i].type] !== 'function') return i;
  }
  return -1;
}

export function atomicOperationsFor(payload: unknown): readonly import('./atomic-operations.ts').AtomicOperation[] | null {
  if (!isPlainObject(payload)) return null;
  const operations = (payload as Record<string, unknown>).atomicOperations;
  if (operations === undefined) return null;
  if (!Array.isArray(operations) || !operations.every(isAtomicOperation)) {
    throw new ValidationError('atomicOperations must be an array of known atomic operations');
  }
  return operations;
}

export async function resolveAtomicOperation(handler: any, context: AtomicOperationContext & { authorization?: AuthorizationAdapter | null }): Promise<AtomicExecution | undefined> {
  const registration = readHandlerPolicy(handler).atomicOperation;
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
export function authorizedOrDenied(result: unknown, details?: unknown) {
  if (!result) return deniedOutcome(details);
  return null;
}
