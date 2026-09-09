import { eventsFromReceipt, insertReceipt, receiptFor, rowToEvent, type EventRef, type LogEvent, type LogRowLike, type ParsedReceipt, type ReceiptMetadata } from './committed-log.ts';
import { readSeq } from './cursor.ts';
import { parseEventType } from './event-handle.ts';
import { txn, upsert, type DbHandle } from './driver.ts';
import { tryParseScopeKey } from './scope-handle.ts';
import { applicationPrivateFactView, parseCompoundContributionFact, compoundKindOf } from './compound-contribution-fact.ts';
import type { HistoryContributionPolicy, HistoryContributionPolicyRegistry } from './history-contribution-policy.ts';
import { forbidden } from './outcome.ts';

const HISTORY_DESCRIPTOR: unique symbol = Symbol('workbench.durable-history');

interface HistoryFrame {
  rootActionId: string;
  headActionId: string;
}

interface HistoryCursorState {
  past: HistoryFrame[];
  future: HistoryFrame[];
}

interface HistoryKey {
  principalKey: string;
  sessionId: string;
  scope: string;
}

interface HistoryAction {
  readonly scope: string;
  readonly order: number;
  readonly actionId: string;
  readonly type: string | null;
  readonly payload: unknown;
  readonly principal: string | null;
  readonly session: string | null;
  readonly operation: string;
  readonly committedAt: string;
  readonly events: readonly LogEvent[];
}

interface TranslatedAction {
  readonly type: string;
  readonly payload: unknown;
  readonly scope: string;
  readonly input?: unknown;
}

interface AuthorizeContext {
  type?: string | null;
  payload?: unknown;
  principal?: unknown;
  operation?: string;
  scope?: unknown;
  session?: unknown;
  action?: unknown;
}

interface HistoryTranslationContext {
  operation?: 'undo' | 'redo';
  origin?: HistoryAction;
  target?: HistoryAction;
  targetFact?: unknown;
  action?: HistoryAction;
  fact?: unknown;
  principal?: unknown;
  session?: unknown;
}

interface HistoryRule {
  inverse: (context: HistoryTranslationContext) => unknown;
  redo: (context: HistoryTranslationContext) => unknown;
}

export interface DurableHistoryDescriptor {
  readonly [HISTORY_DESCRIPTOR]: boolean;
  readonly authorize: (context: AuthorizeContext) => boolean | Promise<boolean>;
  readonly actions: Readonly<Record<string, HistoryRule>>;
}

export interface DurableHistoryOptions {
  authorize?: (context: AuthorizeContext) => boolean | Promise<boolean>;
  actions?: Readonly<Record<string, HistoryRule>>;
}

interface ReceiptRowLike {
  scope: string;
  actionId: string;
  actionType: string | null;
  actionData: string | null;
  operation: string;
  historyRootActionId: string | null;
  historyTargetActionId: string | null;
  [key: string]: unknown;
}

interface HistoryRuntime {
  actions: (args?: Record<string, unknown>) => Promise<readonly HistoryAction[]>;
  events: (args?: Record<string, unknown>) => Promise<readonly LogEvent[]>;
  cursor: (args?: Record<string, unknown>) => Promise<Readonly<{ undo: number; redo: number; revision: string }>>;
  undo: (args?: Record<string, unknown>) => Promise<unknown>;
  redo: (args?: Record<string, unknown>) => Promise<unknown>;
  undoToPoint: (args?: Record<string, unknown>) => Promise<unknown>;
  normalCommit: (request: NormalCommitRequest) => { metadata: ReceiptMetadata; apply?: (dbInTxn: DbHandle) => void };
}

interface NormalCommitRequest {
  type?: string;
  payload?: unknown;
  actions?: ReadonlyArray<{ type?: string; payload?: unknown }>;
  scope?: unknown;
  principal?: { type?: unknown };
  history?: { session?: unknown; identity?: unknown };
  actionId?: string;
}

interface IdentityArgs {
  scope?: unknown;
  session?: unknown;
  principal?: unknown;
}

interface ReadActionsArgs extends IdentityArgs {
  after?: number;
  limit?: number;
}

interface MoveArgs extends IdentityArgs {
  actionId?: unknown;
  revision?: unknown;
}

interface UndoToPointArgs extends IdentityArgs {
  actionId?: unknown;
  revision?: unknown;
  seq?: unknown;
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { status: 409 });
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function principalKey(principal: unknown): string {
  if (!principal || (principal as { id?: unknown } | null | undefined)?.id == null) throw forbidden();
  const p = principal as { type?: unknown; id?: unknown };
  return `${p.type ?? 'principal'}:${String(p.id)}`;
}

function parseJson(value: unknown, fallback: unknown): unknown {
  return value == null ? fallback : typeof value === 'string' ? JSON.parse(value) : value;
}

function historyStack(value: unknown, name: string): HistoryFrame[] {
  const stack = parseJson(value, []);
  if (!Array.isArray(stack) || stack.some((frame) => !frame || typeof frame !== 'object'
    || typeof frame.rootActionId !== 'string' || !frame.rootActionId
    || typeof frame.headActionId !== 'string' || !frame.headActionId)) {
    throw new TypeError(`malformed history cursor ${name}`);
  }
  return stack;
}

function actionFromRow(db: DbHandle, row: Record<string, unknown> | ParsedReceipt): HistoryAction {
  const r = row as unknown as Record<string, unknown>;
  const receipt = {
    ...r,
    eventRefs: (Array.isArray(r.eventRefs) ? r.eventRefs : parseJson(r.eventRefs, [])) as EventRef[],
  } as ParsedReceipt;
  return Object.freeze({
    scope: r.scope,
    order: r.historyOrder,
    actionId: r.actionId,
    type: r.actionType,
    payload: parseJson(r.actionData, null),
    principal: r.principalKey,
    session: r.sessionId,
    operation: r.operation,
    committedAt: r.committedAt,
    events: Object.freeze(eventsFromReceipt(db, receipt, parseEventType)),
  }) as HistoryAction;
}

function privateFactFromReceipt(db: DbHandle, receipt: ParsedReceipt): Readonly<Record<string, unknown>> {
  const row = db.prepare(
    'SELECT committedAt, fact FROM _PrivateActionFact WHERE scope = :scope AND actionId = :actionId',
  ).get({ scope: receipt.scope, actionId: receipt.actionId });
  if (!row || row.committedAt !== receipt.committedAt) {
    throw new TypeError('history action private fact is missing or erased');
  }
  let fact: unknown;
  try { fact = JSON.parse(row.fact as string); } catch { throw new TypeError('history action private fact is malformed'); }
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
    throw new TypeError('history action private fact is malformed');
  }
  // scope#992 rev 4: compound-envelope rows are parsed through the package
  // compound parser before the contribution-policy runtime consumes them; the
  // full deep-frozen canonical envelope is returned. Application translators
  // receive only the application view.
  if (compoundKindOf(fact) !== null) {
    // The policy runtime receives the complete envelope.
    return parseCompoundContributionFact(fact) as unknown as Readonly<Record<string, unknown>>;
  }
  return Object.freeze(structuredClone(fact as Record<string, unknown>));
}

function translatedActions(value: unknown, operation: 'undo' | 'redo', scope: string): readonly TranslatedAction[] {
  const name = operation === 'undo' ? 'inverse' : 'redo';
  const wrapper = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const actions: unknown = wrapper && Object.hasOwn(wrapper, 'actions') ? wrapper.actions : [value];
  const allowedWrapperKeys = wrapper && Object.hasOwn(wrapper, 'actions') ? ['actions'] : ['type', 'payload', 'scope', 'input'];
  if (!wrapper || Object.keys(wrapper).some((key) => !allowedWrapperKeys.includes(key))
    || !Array.isArray(actions) || actions.length === 0) {
    throw new TypeError(`durableHistory ${name} must return one action or a non-empty atomic batch`);
  }
  const normalized = actions.map((action, index) => {
    if (!action || typeof action !== 'object' || Array.isArray(action)
      || typeof action.type !== 'string' || action.type.length === 0
      || Object.keys(action).some((key) => !['type', 'payload', 'scope', 'input'].includes(key))) {
      throw new TypeError(`durableHistory ${name} action ${index} is malformed`);
    }
    if (action.scope !== undefined && action.scope !== scope) {
      throw new TypeError(`durableHistory ${name} must keep the original history scope`);
    }
    return Object.freeze({ type: action.type, payload: action.payload ?? {}, scope, input: action.input });
  });
  return Object.freeze(normalized);
}

function cursorRow(db: DbHandle, key: HistoryKey, receiptIsEligible: (receipt: ReceiptRowLike) => boolean, receiptIsBarrier: (receipt: ReceiptRowLike) => boolean): HistoryCursorState {
  const row = db.prepare(
    `SELECT past, future FROM _HistoryCursor
     WHERE principalKey = :principalKey AND sessionId = :sessionId AND scope = :scope`,
  ).get(key);
  if (row) return { past: historyStack(row.past, 'past'), future: historyStack(row.future, 'future') };
  const receipts = db.prepare(
    `SELECT actionId, actionType, actionData, operation, historyRootActionId, historyTargetActionId FROM _ActionReceipt
     WHERE scope = :scope AND principalKey = :principalKey AND sessionId = :sessionId
     ORDER BY historyOrder`,
  ).all(key) as ReceiptRowLike[];
  const cursor: HistoryCursorState = { past: [], future: [] };
  for (const receipt of receipts) {
      if (receipt.operation === 'action') {
       if (!receiptIsEligible(receipt)) {
         if (receiptIsBarrier(receipt)) cursor.past = [], cursor.future = [];
         continue;
       }
        if (receipt.historyRootActionId && receipt.historyTargetActionId) cursor.past.push({ rootActionId: receipt.historyRootActionId, headActionId: receipt.historyTargetActionId });
        else cursor.past.push({ rootActionId: receipt.actionId, headActionId: receipt.actionId });
       cursor.future = [];
    } else if (receipt.operation === 'undo') {
       const frame = cursor.past.pop();
       if (frame !== undefined) cursor.future.push({ rootActionId: frame.rootActionId, headActionId: receipt.actionId });
    } else if (receipt.operation === 'redo') {
       const frame = cursor.future.pop();
       if (frame !== undefined) cursor.past.push({ rootActionId: frame.rootActionId, headActionId: receipt.actionId });
    } else if (receipt.operation === 'undoToPoint') {
      const sourceActionIds = (parseJson(receipt.actionData, {}) as { sourceActionIds?: unknown }).sourceActionIds;
      if (!Array.isArray(sourceActionIds) || sourceActionIds.some((actionId) => typeof actionId !== 'string')) {
        throw new TypeError('malformed undoToPoint history receipt');
      }
      for (const actionId of sourceActionIds) {
        if (cursor.past.at(-1)?.rootActionId !== actionId) throw new TypeError('undoToPoint history receipt does not match cursor');
        cursor.future.push(cursor.past.pop() as HistoryFrame);
      }
    }
  }
  return cursor;
}

function sameCursor(left: HistoryCursorState, right: HistoryCursorState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function writeCursor(db: DbHandle, key: HistoryKey, cursor: HistoryCursorState): void {
  upsert(db, {
    table: '_HistoryCursor',
    keyColumns: ['principalKey', 'sessionId', 'scope'],
    columns: ['past', 'future'],
    values: { ...key, past: JSON.stringify(cursor.past), future: JSON.stringify(cursor.future) },
  });
}

async function admitted(config: { authorize: (context: AuthorizeContext) => boolean | Promise<boolean> }, context: AuthorizeContext): Promise<void> {
  if (!await config.authorize(context)) throw forbidden();
}

export function durableHistory({ authorize, actions = {} }: DurableHistoryOptions = {}): Readonly<DurableHistoryDescriptor> {
  if (typeof authorize !== 'function') {
    throw new TypeError('durableHistory requires an authorize function');
  }
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) {
    throw new TypeError('durableHistory actions must be an object');
  }
  for (const [type, rule] of Object.entries(actions)) {
    if (!rule || typeof rule !== 'object' || typeof rule.inverse !== 'function'
      || typeof rule.redo !== 'function' || Object.keys(rule).some((key) => key !== 'inverse' && key !== 'redo')) {
      throw new TypeError(`durableHistory action '${type}' requires explicit inverse and redo functions`);
    }
  }
  return Object.freeze({ [HISTORY_DESCRIPTOR]: true, authorize, actions: Object.freeze({ ...actions }) });
}

export function createDurableHistoryRuntime({
  db, descriptor, generatedActions = {}, dispatch, dispatchBatch, authorize, cursorPolicy, contributionPolicies = null,
}: {
  db: DbHandle;
  descriptor: DurableHistoryDescriptor | null | undefined;
  generatedActions?: Readonly<Record<string, HistoryRule>>;
  dispatch: (request: Record<string, unknown>) => unknown;
  dispatchBatch: (request: Record<string, unknown>) => unknown;
  authorize: (context: AuthorizeContext) => boolean | Promise<boolean>;
  cursorPolicy?: ReadonlyMap<string, 'eligible' | 'excluded'>;
  contributionPolicies?: HistoryContributionPolicyRegistry | null;
}): HistoryRuntime {
  if (!db) throw new Error('durable history requires a durable database');
  if (!descriptor?.[HISTORY_DESCRIPTOR]) {
    throw new TypeError('history must be created with durableHistory(...)');
  }
  const historyDescriptor = descriptor;
  if (cursorPolicy !== undefined) {
    if (!(cursorPolicy instanceof Map)) {
      throw new TypeError('cursorPolicy must be a Map if provided');
    }
    for (const [type, policy] of cursorPolicy) {
      if (typeof type !== 'string' || (policy !== 'eligible' && policy !== 'excluded')) {
        throw new TypeError(`cursorPolicy: invalid policy '${String(policy)}' for action '${type}'`);
      }
    }
  }
  if (!generatedActions || typeof generatedActions !== 'object' || Array.isArray(generatedActions)) {
    throw new TypeError('generated history actions must be an object');
  }
  for (const [type, rule] of Object.entries(generatedActions)) {
    if (!rule || typeof rule !== 'object' || typeof rule.inverse !== 'function' || typeof rule.redo !== 'function') {
      throw new TypeError(`generated history action '${type}' is invalid`);
    }
    if (descriptor.actions[type]) {
      throw new Error(`generated history action '${type}' cannot also declare a durableHistory rule`);
    }
  }
  const resolvedPolicy = cursorPolicy ?? new Map();
  const rules = Object.freeze({ ...generatedActions, ...descriptor.actions });

  // Policy-owned authorization sequencing (scope#992 rev 2 Finding 9). The
  // contribution policy returns its REQUIREMENTS for a phase; durable history
  // evaluates them through the existing central `authorize` seam (which the
  // kernel routes to row admission / field admission). The policy never decides
  // a grant itself, and no private-fact or event material is read until this
  // passes. First-move and deduped-retry paths both call this before loading
  // any private material.
  async function authorizeContributionPolicy(policy: HistoryContributionPolicy, ctx: {
    operation: 'undo' | 'redo';
    origin: { type: string | null; payload: unknown };
    target: { type: string | null; payload: unknown };
    principal: unknown;
  }): Promise<void> {
    const requirements = policy.authorizationRequirements({ phase: 'authorize', origin: ctx.origin, target: ctx.target });
    if (requirements === 'none') return;
    if (requirements === 'outer' || requirements === 'outer-field') {
      // Outer canonical action authorization. For annotated/compound flows the
      // central seam also performs the current owning-scope + annotated field
      // admission the kernel compiles into it.
      if (!await authorize({ type: ctx.origin.type, payload: ctx.origin.payload, principal: ctx.principal })) throw forbidden();
    }
  }

  // #145 S5: the retired annotated-scope / receipt-scanning classification is
  // GONE from this module (moved to the read-privacy boundary). History-read
  // privacy is the declaration-derived privateHistoryScopes set carried by the
  // contribution-policy registry — used ONLY by the actions()/events() read
  // functions. Movement code makes no scope or receipt-movement classification
  // decision.
  function requireReadableHistory(scope: string): void {
    const handle = tryParseScopeKey(scope);
    if (handle && contributionPolicies?.privateHistoryScopes.has(handle.entity)) throw forbidden();
  }

  function cursorPolicyFor(type: string): 'eligible' | 'excluded' {
    if (!rules[type]) return 'excluded';
    return resolvedPolicy.get(type) ?? 'eligible';
  }

  function classify(type: string | null | undefined, payload: unknown): 'eligible' | 'barrier' | 'excluded' | null {
    return contributionPolicies?.classify({ type, payload }) ?? null;
  }

  function cursorOrPolicyEligible(type: string, payload: unknown): boolean {
    const classified = classify(type, payload);
    if (classified !== null) return classified === 'eligible';
    return cursorPolicyFor(type) === 'eligible';
  }

  function receiptIsEligible(receipt: ReceiptRowLike): boolean {
    if (receipt.operation !== 'action') return false;
    // Retention redacts actionData while retaining the receipt for dispatch
    // dedupe. A reconstructed cursor must not revive that retired target.
    if (receipt.actionData == null) return false;
     if (receipt.actionType === '$batch') {
       const actions = parseJson(receipt.actionData, null);
       return Array.isArray(actions) && actions.every((action) =>
         action && typeof action.type === 'string' && cursorOrPolicyEligible(action.type, action.payload));
     }
    return cursorOrPolicyEligible(receipt.actionType ?? '', parseJson(receipt.actionData, null));
  }

  function receiptIsBarrier(receipt: ReceiptRowLike): boolean {
    if (receipt.operation !== 'action' || receipt.actionData == null) return false;
    try {
      return classify(receipt.actionType ?? null, parseJson(receipt.actionData, null)) === 'barrier';
    } catch {
      return false;
    }
  }

  function currentCursor(dbInTxn: DbHandle, key: HistoryKey): HistoryCursorState {
    return cursorRow(dbInTxn, key, receiptIsEligible, receiptIsBarrier);
  }

  function identity(args: IdentityArgs): HistoryKey {
    return {
      scope: requireText(args.scope, 'scope'),
      sessionId: requireText(args.session, 'session'),
      principalKey: principalKey(args.principal),
    };
  }

  function receiptMetadata(request: NormalCommitRequest, operation = 'action'): ReceiptMetadata {
    const session = request.history?.session;
    const historyIdentity = request.history?.identity ?? session;
    return {
      actionType: request.type ?? '$batch',
      actionData: request.type ? request.payload : request.actions,
      principalKey: principalKey(request.principal),
      sessionId: (historyIdentity ?? null) as string | null,
      operation,
    };
  }

  function normalCommit(request: NormalCommitRequest): { metadata: ReceiptMetadata; apply?: (dbInTxn: DbHandle) => void } {
    const metadata = receiptMetadata(request);
    if (!request.history?.session || request.principal?.type !== 'user') {
      return { metadata, apply: undefined };
    }
    // Batch: if any action is excluded (or a policy barrier), exclude cursor entry
    if (request.actions) {
       const allEligible = request.actions.every(
         (action) => cursorOrPolicyEligible(action.type ?? '', action.payload),
       );
      if (!allEligible) return { metadata, apply: undefined };
     } else {
       const classified = classify(request.type ?? null, request.payload);
       if (classified === 'barrier' && request.history?.session && request.principal?.type === 'user') {
         // A policy barrier (e.g. a native annotated action that is not a text
         // insert) cleaves history at that point: it clears the cursor rather
         // than exposing an older insert across it.
         const key = identity({ scope: request.scope, session: request.history.identity ?? request.history.session, principal: request.principal });
         return { metadata, apply(dbInTxn: DbHandle) { writeCursor(dbInTxn, key, { past: [], future: [] }); } };
       }
       if (classified !== null ? classified !== 'eligible' : cursorPolicyFor(request.type ?? '') === 'excluded') {
        return { metadata, apply: undefined };
      }
    }
    const key = identity({ scope: request.scope, session: request.history.identity ?? request.history.session, principal: request.principal });
    const expected = currentCursor(db, key);
    metadata.historyRootActionId = request.actionId;
    metadata.historyTargetActionId = request.actionId;
    return {
      metadata,
      apply(dbInTxn: DbHandle) {
        const current = currentCursor(dbInTxn, key);
        if (!sameCursor(current, expected)) throw new Error('history cursor changed during dispatch');
        writeCursor(dbInTxn, key, { past: [...current.past, { rootActionId: request.actionId ?? '', headActionId: request.actionId ?? '' }], future: [] });
      },
    };
  }

  async function actions(args: ReadActionsArgs = {}): Promise<readonly HistoryAction[]> {
    const { scope, principal, after = 0, limit = 100 } = args;
    const scopeText = requireText(scope, 'scope');
    await admitted(historyDescriptor, { operation: 'read', scope, principal });
    requireReadableHistory(scopeText);
    if (!Number.isInteger(after) || after < 0) throw new TypeError('after must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer from 1 to 1000');
    return db.prepare(`SELECT * FROM _ActionReceipt WHERE scope = :scope AND historyOrder > :after ORDER BY historyOrder LIMIT :limit`)
      .all({ scope: scopeText, after, limit }).map((row) => actionFromRow(db, row));
  }

  async function events(args: ReadActionsArgs = {}): Promise<readonly LogEvent[]> {
    const { scope, principal, after = 0, limit = 100 } = args;
    const scopeText = requireText(scope, 'scope');
    await admitted(historyDescriptor, { operation: 'read', scope, principal });
    requireReadableHistory(scopeText);
    if (!Number.isInteger(after) || after < 0) throw new TypeError('after must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer from 1 to 1000');
    return db.prepare('SELECT * FROM _Log WHERE scope = :scope AND seq > :after ORDER BY seq LIMIT :limit')
      .all({ scope: scopeText, after, limit }).map((row) => rowToEvent(row as unknown as LogRowLike, parseEventType));
  }

  function revision(value: HistoryCursorState): string {
  return JSON.stringify(value);
  }

  async function cursor(args: IdentityArgs = {}): Promise<Readonly<{ undo: number; redo: number; revision: string }>> {
    const key = identity(args);
    await admitted(historyDescriptor, { operation: 'read', scope: key.scope, session: args.session, principal: args.principal });
    const value = currentCursor(db, key);
    const result: { undo: number; redo: number; revision: string } = { undo: value.past.length, redo: value.future.length, revision: '' };
    Object.defineProperty(result, 'revision', { value: revision(value), enumerable: true });
    return Object.freeze(result);
  }

  async function move(operation: 'undo' | 'redo', args: MoveArgs = {}): Promise<unknown> {
    const key = identity(args);
    await admitted(historyDescriptor, { operation, scope: key.scope, session: args.session, principal: args.principal });
    const operationId = requireText(args.actionId, 'actionId');
    const expectedRevision = requireText(args.revision, 'revision');
    const retry = receiptFor(db, key.scope, operationId);
    if (retry) {
      if (retry.operation !== operation || retry.principalKey !== key.principalKey || retry.sessionId !== key.sessionId) {
        throw conflict('history action id is already bound to another operation');
      }
      // Policy-owned retry authorization (scope#992 rev 2 Finding 9): a receipt
      // whose action type has a contribution policy must re-run the policy's
      // authorization requirements BEFORE any event or private material is read,
      // so a revoked known action id is never a read oracle. This replaces the
      // retired classifier-dependent retry branch (#145 S5).
      const retryPolicy = contributionPolicies?.policyFor(retry.actionType ?? null);
      if (retryPolicy) {
        // Resolve the original root receipt through linkage, then authorize the
        // outer canonical action and the policy's field requirements.
        const rootActionId = retry.historyRootActionId ?? retry.actionId;
        const rootReceipt = rootActionId === retry.actionId ? retry : receiptFor(db, key.scope, rootActionId);
        if (!rootReceipt) throw forbidden();
        let rootAction: { type: string | null; payload: unknown };
        let targetPayload: unknown;
        try {
          rootAction = { type: rootReceipt.actionType, payload: parseJson(rootReceipt.actionData, null) };
          targetPayload = parseJson(retry.actionData, null);
        } catch {
          throw forbidden();
        }
        await authorizeContributionPolicy(retryPolicy, {
          operation,
          origin: rootAction,
          target: { type: retry.actionType, payload: targetPayload },
          principal: args.principal,
        });
      }
      const retried: { ok: boolean; deduped: boolean; events: readonly LogEvent[]; empty?: boolean } = { ok: true, deduped: true, events: Object.freeze(eventsFromReceipt(db, retry, parseEventType)) };
      if (retry.actionType === '$history.empty') retried.empty = true;
      return Object.freeze(retried);
    }
    const expected = currentCursor(db, key);
    if (expectedRevision !== revision(expected)) throw conflict('history cursor is stale');
    // #145 S5: the annotated-scope move barrier is GONE from movement
    // classification. History moves are governed by the contribution policy +
    // authorization, never by scope/receipt scanning.
    const source = operation === 'undo' ? expected.past : expected.future;
    const targetFrame = source[source.length - 1];
    const targetId = targetFrame?.headActionId;
    if (!targetFrame) {
      const now = new Date().toISOString();
      await txn(db, async () => {
        await admitted(historyDescriptor, { operation, scope: key.scope, session: args.session, principal: args.principal });
        const current = currentCursor(db, key);
        if (!sameCursor(current, expected)) throw conflict('history cursor changed during dispatch');
        insertReceipt(db, key.scope, operationId, now, [], {
          actionType: '$history.empty', actionData: { version: 1 }, principalKey: key.principalKey,
          sessionId: key.sessionId, operation,
        });
      });
      return Object.freeze({ ok: true, deduped: false, events: [], empty: true });
    }
    const originReceipt = receiptFor(db, key.scope, targetFrame.rootActionId);
    const receipt = receiptFor(db, key.scope, targetId ?? '');
    if (!originReceipt || !receipt) throw new Error(`history action '${targetId}' is no longer retained`);
    const origin = actionFromRow(db, originReceipt);
    const action = actionFromRow(db, receipt);
    const rule = rules[origin.type ?? ''];
    if (!rule) throw conflict(`history action '${origin.type}' is not undoable`);
    // Re-authorize the original canonical action before private material is
    // loaded or supplied to application translation code. Policy-owned ordering
    // (scope#992 rev 2 Finding 9): when the origin action has a contribution
    // policy, evaluate the policy's requirements through the central seam;
    // otherwise keep the ordinary canonical-action authorization.
    const movePolicy = contributionPolicies?.policyFor(origin.type ?? null);
    if (movePolicy) {
      await authorizeContributionPolicy(movePolicy, {
        operation,
        origin: { type: origin.type, payload: origin.payload },
        target: { type: action.type, payload: action.payload },
        principal: args.principal,
      });
    } else if (!await authorize({ type: origin.type, payload: origin.payload, principal: args.principal })) {
      throw forbidden();
    }
    const originRaw = privateFactFromReceipt(db, originReceipt);
    const originFact = movePolicy ? movePolicy.parseOriginFact(originRaw) : originRaw;
    // Policy-owned target selection for EVERY contribution chain (#145 MAJOR 2):
    // the registry (selectAndParseTargetFact) selects+validates the head target;
    // the history engine never hard-codes target-fact selection.
    const targetFact = movePolicy
      ? movePolicy.selectAndParseTargetFact({
          origin: { actionId: originReceipt.actionId, payload: origin.payload },
          target: { actionId: receipt.actionId, historyTargetActionId: receipt.historyTargetActionId },
          operation,
          rootActionId: targetFrame.rootActionId,
          originFact: originFact as unknown as Parameters<HistoryContributionPolicy['selectAndParseTargetFact']>[0]['originFact'],
          targetFact: (originReceipt.actionId === receipt.actionId
            ? originFact
            : movePolicy.parseTargetFact(privateFactFromReceipt(db, receipt))) as Parameters<HistoryContributionPolicy['selectAndParseTargetFact']>[0]['targetFact'],
          receipt: { actionId: receipt.actionId, operation: receipt.operation },
        })
      : originFact;
    const originIsPolicy = Boolean(movePolicy);
    if (!originIsPolicy && !compoundKindOf(originFact) && (!Object.hasOwn(originFact, 'before') || !Object.hasOwn(originFact, 'after'))) {
      throw new TypeError('history action private fact is malformed');
    }
    // #145 S5/S6: a compound action is history-eligible ONLY through its
    // compile-produced contribution policy. Generic history must never
    // interpret a compound envelope — if the policy is missing (deleted or a
    // broken assembly), the move refuses rather than compensating blindly.
    if (compoundKindOf(originFact) && !originIsPolicy) {
      throw new Error('compound action remained history eligible without its policy');
    }
    const translate = operation === 'undo' ? rule.inverse : rule.redo;
    // scope#992 rev 3/4: application translators receive only the application
    // half of a compound envelope. The contribution-policy runtime (W3) retains
    // the full envelope for applicability/linkage; this seam unwraps for the
    // translator boundary.
    const translatorTargetFact = applicationPrivateFactView(targetFact as Record<string, unknown>);
    // A contribution-policy move always compensates the HEAD receipt (rev 3 §1:
    // "Redo compensates the completed undo receipt"). The handler input is
    // therefore derived from the TARGET application transition for BOTH
    // directions — undo of the root origin, undo/redo of an applied
    // compensation, and redo of a completed undo all invert the head's
    // application transition, never the root origin's.
    const translated = translatedActions(
      await translate({ operation, origin, target: action, targetFact: translatorTargetFact, action: origin, fact: translatorTargetFact, principal: args.principal, session: args.session }), operation, key.scope,
    );
    // Policy-owned translation validation (#145 MAJOR 2): the registry decides
    // what a policy move may re-dispatch. For a non-policy origin, a translation
    // that re-targets a policy action stays forbidden (the policy owns that
    // chain) — no action-name classifier remains.
    if (movePolicy) {
      movePolicy.validateTranslation({ translated, origin: { type: origin.type, payload: origin.payload, scope: key.scope }, operation, scope: key.scope });
    } else {
      const translatedIntoPolicy = translated.some((child) => Boolean(contributionPolicies?.policyFor(child.type)));
      if (translatedIntoPolicy) throw forbidden();
    }
    const receiptAction = translated.length === 1 ? translated[0] : null;
    const transition = {
      handlerInputs: Object.freeze(translated.map((child) => Object.freeze({
        operation,
        input: child.input,
      }))),
      metadata: {
        actionType: receiptAction?.type ?? '$batch',
        actionData: receiptAction?.payload ?? translated.map(({ type, payload }) => ({ type, payload })),
        principalKey: key.principalKey,
        sessionId: key.sessionId,
        operation,
        historyRootActionId: targetFrame.rootActionId,
        historyTargetActionId: targetFrame.headActionId,
        historyOutcome: 'pending',
      },
      async apply(dbInTxn: DbHandle): Promise<void> {
        await admitted(historyDescriptor, { operation, scope: key.scope, session: args.session, principal: args.principal, action });
        if (!await authorize({ type: action.type, payload: action.payload, principal: args.principal })) throw forbidden();
        // In-transaction re-authorization of the outer canonical action when the
        // origin carries a contribution policy (rev 2 Finding 9 first-move step 4).
        const applyPolicy = contributionPolicies?.policyFor(origin.type ?? null);
        if (applyPolicy) {
          await authorizeContributionPolicy(applyPolicy, {
            operation,
            origin: { type: origin.type, payload: origin.payload },
            target: { type: action.type, payload: action.payload },
            principal: args.principal,
          });
        }
        privateFactFromReceipt(dbInTxn, contributionPolicies?.policyFor(origin.type ?? null) ? receipt : originReceipt);
        const current = currentCursor(dbInTxn, key);
        if (!sameCursor(current, expected)) throw new Error('history cursor changed during dispatch');
        const past = [...current.past];
        const future = [...current.future];
        if (operation === 'undo') {
          const frame = past.pop() as HistoryFrame;
          future.push({ rootActionId: frame.rootActionId, headActionId: operationId });
        } else {
          const frame = future.pop() as HistoryFrame;
          past.push({ rootActionId: frame.rootActionId, headActionId: operationId });
        }
        writeCursor(dbInTxn, key, { past, future });
      },
    };
    const request = {
      actionId: operationId,
      principal: args.principal,
      scope: key.scope,
      _historyCommit: transition,
    };
    return receiptAction
      ? dispatch({ ...request, type: receiptAction.type, payload: receiptAction.payload })
      : dispatchBatch({ ...request, actions: translated.map(({ type, payload }) => ({ type, payload })) });
  }

  async function undoToPoint(args: UndoToPointArgs = {}): Promise<unknown> {
    const key = identity(args);
    await admitted(historyDescriptor, { operation: 'undo', scope: key.scope, session: args.session, principal: args.principal });
    const operationId = requireText(args.actionId, 'actionId');
    const revisionArg = requireText(args.revision, 'revision');
    const seq = args.seq as number;
    if (!Number.isSafeInteger(seq) || seq < 0) throw new TypeError('seq must be a non-negative safe integer');
    if (seq > readSeq(db, key.scope)) throw conflict('history sequence boundary is beyond the scope cursor');
    const retry = receiptFor(db, key.scope, operationId);
    if (retry) {
      if (retry.operation !== 'undoToPoint' || retry.principalKey !== key.principalKey || retry.sessionId !== key.sessionId) {
        throw conflict('history action id is already bound to another operation');
      }
      return Object.freeze({ ok: true, deduped: true, events: Object.freeze(eventsFromReceipt(db, retry, parseEventType)) });
    }
    const expected = currentCursor(db, key);
    if (revisionArg !== revision(expected)) throw conflict('history cursor is stale');
    // #145 S5: no annotated-scope barrier on movement; the contribution policy
    // governs which receipts undoToPoint may compensate.
    const sourceActionIds: string[] = [];
    for (let index = expected.past.length - 1; index >= 0; index -= 1) {
      const rootActionId = expected.past[index].rootActionId;
      const receipt = receiptFor(db, key.scope, rootActionId);
      if (!receipt) throw new Error(`history action '${rootActionId}' is no longer retained`);
      const refs = parseJson(receipt.eventRefs, []) as EventRef[];
      if (refs.some((ref) => ref.scope === key.scope && ref.seq > seq)) sourceActionIds.push(receipt.actionId);
      else break;
    }
    if (sourceActionIds.length === 0) {
      const now = new Date().toISOString();
      await txn(db, async () => {
        await admitted(historyDescriptor, { operation: 'undo', scope: key.scope, session: args.session, principal: args.principal });
        if (!sameCursor(currentCursor(db, key), expected)) throw conflict('history cursor changed during dispatch');
        insertReceipt(db, key.scope, operationId, now, [], {
          actionType: '$history.empty', actionData: { version: 1, boundarySeq: seq, sourceActionIds }, principalKey: key.principalKey,
          sessionId: key.sessionId, operation: 'undoToPoint',
        });
      });
      return Object.freeze({ ok: true, deduped: false, events: [], empty: true });
    }
    const translated: TranslatedAction[] = [];
    for (const sourceActionId of sourceActionIds) {
      const receipt = receiptFor(db, key.scope, sourceActionId);
      if (!receipt) throw new Error(`history action '${sourceActionId}' is no longer retained`);
      const action = actionFromRow(db, receipt);
      const rule = historyDescriptor.actions[action.type ?? ''];
      if (!rule) throw conflict(`history action '${action.type}' is not undoable`);
      if (!await authorize({ type: action.type, payload: action.payload, principal: args.principal })) throw forbidden();
      // #145 round 3: undoToPoint resolves EACH source through the policy seam
      // — origin parsing (parseOriginFact) and per-source target selection
      // (selectAndParseTargetFact) run BEFORE any translator consumes private
      // material, exactly like the move path. A policy rejection is opaque
      // forbidden and writes nothing.
      const sourcePolicy = contributionPolicies?.policyFor(action.type ?? null);
      const rawFact = privateFactFromReceipt(db, receipt);
      const originFact = sourcePolicy ? sourcePolicy.parseOriginFact(rawFact) : rawFact;
      const seamTarget = sourcePolicy
        ? sourcePolicy.selectAndParseTargetFact({
            origin: { actionId: sourceActionId, payload: action.payload },
            target: { actionId: sourceActionId, historyTargetActionId: receipt.historyTargetActionId },
            operation: 'undo',
            rootActionId: receipt.historyRootActionId ?? sourceActionId,
            originFact: originFact as Parameters<HistoryContributionPolicy['selectAndParseTargetFact']>[0]['originFact'],
            targetFact: originFact as Parameters<HistoryContributionPolicy['selectAndParseTargetFact']>[0]['targetFact'],
            receipt: { actionId: sourceActionId, operation: receipt.operation },
          })
        : originFact;
      // Only the APPLICATION VIEW may cross into a translator on this path — the
      // full private envelope never reaches rule.inverse().
      const translatorFact = applicationPrivateFactView(seamTarget as Record<string, unknown>);
      const inverse = await rule.inverse({ action, fact: translatorFact, targetFact: translatorFact, principal: args.principal, session: args.session });
      translated.push(...translatedActions(inverse, 'undo', key.scope));
    }
    // #145 MAJOR 2: undoToPoint re-targets a contribution-policy action only when
    // the undone source is itself policy-owned and THAT policy validates the
    // translation (the registry owns the decision — no action-name classifier).
    const undoneByType = new Map<string, { type: string; payload: unknown }>();
    for (const sourceActionId of sourceActionIds) {
      const receipt = receiptFor(db, key.scope, sourceActionId);
      const action = receipt ? actionFromRow(db, receipt) : null;
      if (action && typeof action.type === 'string') undoneByType.set(action.type, { type: action.type, payload: action.payload });
    }
    for (const child of translated) {
      const scopePolicy = contributionPolicies?.policyFor(child.type);
      if (!scopePolicy) continue;
      const source = undoneByType.get(child.type);
      if (!source) throw forbidden();
      scopePolicy.validateTranslation({ translated: [child], origin: { type: source.type, payload: source.payload, scope: key.scope }, operation: 'undo', scope: key.scope });
    }
    const transition = {
      handlerInputs: Object.freeze(translated.map((child) => Object.freeze({ operation: 'undo', input: child.input }))),
      metadata: {
        actionType: '$batch', actionData: { version: 1, boundarySeq: seq, sourceActionIds, actions: translated.map(({ type, payload }) => ({ type, payload })) },
        principalKey: key.principalKey, sessionId: key.sessionId, operation: 'undoToPoint',
      },
      async apply(dbInTxn: DbHandle): Promise<void> {
        await admitted(historyDescriptor, { operation: 'undo', scope: key.scope, session: args.session, principal: args.principal });
        for (const sourceActionId of sourceActionIds) {
          const receipt = receiptFor(dbInTxn, key.scope, sourceActionId);
          if (!receipt) throw new Error(`history action '${sourceActionId}' is no longer retained`);
          const action = actionFromRow(dbInTxn, receipt);
          if (!await authorize({ type: action.type, payload: action.payload, principal: args.principal })) throw forbidden();
          privateFactFromReceipt(dbInTxn, receipt);
        }
        const current = currentCursor(dbInTxn, key);
        if (!sameCursor(current, expected)) throw new Error('history cursor changed during dispatch');
        writeCursor(dbInTxn, key, { past: current.past.slice(0, -sourceActionIds.length), future: [...current.future, ...current.past.slice(-sourceActionIds.length)] });
      },
    };
    return dispatchBatch({ actionId: operationId, principal: args.principal, scope: key.scope,
      actions: translated.map(({ type, payload }) => ({ type, payload })), _historyCommit: transition });
  }

  return Object.freeze({
    // Internal diagnostics only. The public application surface deliberately
    // exposes cursor/move operations, not canonical payload materialization.
    actions,
    events,
    cursor,
    undo: (args?: MoveArgs) => move('undo', args),
    redo: (args?: MoveArgs) => move('redo', args),
    undoToPoint,
    normalCommit,
  });
}
