// Type definitions for workbench-client — the browser-side live sync SDK.
//
// Source of truth: public/workbench-client.mjs
// Projection for TypeScript app authors. JS users see no change.

import type {
  AnnotatedTextAnnotationActionValues,
  AnnotatedTextAnnotationEntityActionHandle,
  AnnotatedTextAnnotationEntityRemoveActionHandle,
  AnnotatedTextFieldHandle,
  AnyWorkbenchEntity,
  WorkbenchEntity,
} from './index.js';
import type { AnnotatedTextRange, AnnotatedTextRedactionMarker } from './annotated-text-coords.js';

// ---------------------------------------------------------------------------
// LiveChannel — WebSocket transport layer
// ---------------------------------------------------------------------------

export class LiveChannel {
  constructor(baseUrl: string, options?: LiveChannelOptions);

  subscribe(
    entity: string,
    id: string | number,
    optionsOrOnEvent?: SubscribeOptions | OnEvent,
    maybeOnEvent?: OnEvent,
  ): Promise<{ currentSeq: number }>;

  subscribeScope(
    scope: string,
    optionsOrOnEvent?: ScopeSubscribeOptions | OnEvent,
    maybeOnEvent?: OnEvent,
  ): Promise<{ currentSeq: number }>;

  unsubscribe(entity: string, id: string | number): Promise<void>;
  unsubscribeScope(scope: string): Promise<void>;
  updateCaret(input: CaretUpdate): boolean;
  clearCaret(input: CaretClear): boolean;
  close(): void;
  onConnectionChange(cb: (status: ConnectionStatus) => void): () => void;
}

export interface LiveChannelOptions {
  maxBackoff?: number;
  backoffBase?: number;
  socketFactory?: (url: string) => WebSocket;
}

export type FieldInterest = Record<string, true>;

export type PaceSelection =
  | { profile: string }
  | { coalesce: { window: number; by: string } };

export interface SubscriptionCheckpoint {
  currentSeq: number;
}

export interface SubscribeOptions {
  fields?: FieldInterest;
  pace?: PaceSelection;
  carets?: string[];
  onCaret?: OnCaret;
  onCheckpoint?: (checkpoint: SubscriptionCheckpoint) => void;
}

export interface ScopeSubscribeOptions {
  interest?: {
    entity?: string;
    id?: string | number;
    fields?: FieldInterest;
    pace?: PaceSelection;
    carets?: string[];
  };
  fields?: FieldInterest;
  pace?: PaceSelection;
  carets?: string[];
  onCaret?: OnCaret;
  onCheckpoint?: (checkpoint: SubscriptionCheckpoint) => void;
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting';

export type OnEvent = (envelope: WsEnvelope) => void;
export type OnCaret = (frame: AnnotatedTextCaretFrame) => void;

export interface CaretUpdate {
  entity: string;
  id: string;
  field: string;
  offset: number;
}

export interface CaretClear {
  entity: string;
  id: string;
  field: string;
}

export type AnnotatedTextCaretFrame = AnnotatedTextCaretUpsert | AnnotatedTextCaretRemove | AnnotatedTextCaretOwn;

export interface AnnotatedTextCaretUpsert {
  type: 'annotated-text-caret';
  version: 1;
  entity: string;
  id: string;
  field: string;
  change: { op: 'upsert'; value: AnnotatedTextVisibleCaret | AnnotatedTextRestrictedCaret | AnnotatedTextSelectionCaret };
}

export interface AnnotatedTextCaretRemove {
  type: 'annotated-text-caret';
  version: 1;
  entity: string;
  id: string;
  field: string;
  change: { op: 'remove'; presence: string };
}

export interface AnnotatedTextCaretOwn {
  type: 'annotated-text-caret';
  version: 1;
  entity: string;
  id: string;
  field: string;
  change: { op: 'own'; presence: string };
}

export interface AnnotatedTextVisibleCaret {
  kind: 'caret';
  presence: string;
  /** Document-absolute UTF-16 offset into the canonical text (the wire is blockless). */
  offset: number;
  /** The source user's public display label, or '' when the app supplies none. */
  name: string;
  /** The source principal's stable id, for attribution only (may be ''). */
  sourceId: string;
}

export interface AnnotatedTextRestrictedCaret {
  kind: 'edge';
  presence: string;
  edge: 'start';
  /** The source user's public display label, or '' when the app supplies none. */
  name: string;
  /** The source principal's stable id, for attribution only (may be ''). */
  sourceId: string;
}

export interface AnnotatedTextSelectionCaret {
  kind: 'selection';
  presence: string;
  /** The source user's public display label, or '' when the app supplies none. */
  name: string;
  /** The source principal's stable id, for attribution only (may be ''). */
  sourceId: string;
  from: number;
  to: number;
}

// ---------------------------------------------------------------------------
// Wire protocol envelopes (server → client)
// ---------------------------------------------------------------------------

export type WsEnvelope =
  | WsSubscribedEnvelope
  | WsUnsubscribedEnvelope
  | WsErrorEnvelope
  | WsEventEnvelope;

export interface WsSubscribedEnvelope {
  type: 'subscribed';
  requestId?: number | string;
  scope?: string;
  entity?: string;
  id?: string | number;
  currentSeq: number;
}

export interface WsUnsubscribedEnvelope {
  type: 'unsubscribed';
  scope?: string;
  entity?: string;
  id?: string | number;
}

export interface WsErrorEnvelope {
  type: 'error';
  requestId?: number | string;
  failure: WorkbenchFailure;
}

export class WorkbenchFailureError extends Error {
  readonly failure: WorkbenchFailure;
  constructor(failure: WorkbenchFailure);
}

export interface WsEventEnvelope {
  type: 'event';
  entity?: string;
  id?: string | number;
  seq: number;
  seqSpan: [number, number];
  event: { type: string; data?: unknown; actionId?: string };
  delta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// LiveList — single-document live state
// ---------------------------------------------------------------------------

export class LiveList<Row extends Record<string, unknown> = Record<string, unknown>> {
  constructor(config: LiveListConfig);

  get state(): Row | null;
  get cursor(): number;
  get ready(): Promise<void>;

  subscribe(): Promise<void>;
  onRender(cb: (state: Row | null) => void): () => void;
  close(): Promise<void>;
}

export interface LiveListConfig {
  entity: string;
  id: string | number;
  channel: LiveChannel;
  fetchImpl?: typeof globalThis.fetch;
  snapshotUrl: (entity: string, id: string | number) => string;
  eventsSinceUrl: (entity: string, id: string | number, cursor: number) => string;
  fields?: FieldInterest;
  pace?: PaceSelection;
  maxBufferedEvents?: number;
  resyncBackoffBase?: number;
  maxResyncBackoff?: number;
}

// ---------------------------------------------------------------------------
// REST contract types
// ---------------------------------------------------------------------------

export interface SnapshotResponse<Row> {
  snapshot: Row;
  seq: number;
}

export interface EventsSinceResponse {
  events: Array<{
    seq: number;
    type: string;
    data?: unknown;
    actionId?: string;
  }>;
}

export interface StaleResponse<Row> {
  resync: 'stale';
  reason: string;
}

// ---------------------------------------------------------------------------
// decodeResult — HTTP response decoder
// ---------------------------------------------------------------------------

export type FailureCategory =
  | 'invalid-input'
  | 'denied'
  | 'unknown-action'
  | 'not-found'
  | 'conflict'
  | 'internal';

export interface WorkbenchFailure {
  readonly category: FailureCategory;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type DecodeResult<T = unknown> =
  | { ok: true; httpStatus: number; value: T | undefined }
  | { ok: false; httpStatus: number; failure: WorkbenchFailure }
  | { ok: false; httpStatus: number; error: string };

export function decodeResult<T = unknown>(res: Response): Promise<DecodeResult<T>>;

// ---------------------------------------------------------------------------
// createLiveStore — client SDK store
// ---------------------------------------------------------------------------

export interface LiveStoreConfig {
  baseUrl: string;
  name: string;
  path: string;
  channel?: LiveChannel;
  fetchImpl?: typeof globalThis.fetch;
  replicaState?: TextReplicaState;
}

export interface TextReplicaState {
  reserve(document: string, generate: (reservation: { actor: string; counter: number; lamport: number; frontier: Array<[string, number]>; epoch: string | null }) => unknown): Promise<TextOutboxRecord>;
  head(document: string): Promise<TextOutboxRecord | null>;
  commit(document: string, counter: number): Promise<void>;
  block(document: string, counter: number, failure: WorkbenchFailure): Promise<void>;
  reconcile(document: string, observation: { epoch?: string; frontier: Array<[string, number]>; lamport: number }): Promise<TextOutboxRecord[]>;
}

export interface TextOutboxRecord {
  operation: unknown;
  actionId: string;
  counter: number;
  replica: string;
  body: string;
  status: 'pending' | 'blocked';
  failure: WorkbenchFailure | null;
}

export function createIndexedDbReplicaState(options?: { indexedDB?: IDBFactory; database?: string }): TextReplicaState;

export type DispatchResult =
  | {
      ok: true;
      status: 'committed';
      opId: string;
      id?: string | number;
      row?: unknown;
      value?: unknown;
    }
  | {
      ok: false;
      status: 'failed-rolled-back';
      opId: string;
      failure: WorkbenchFailure;
    }
  | {
      ok: false;
      status: 'outcome-unknown';
      opId: string;
      deliveryError: { message: string };
    };

export type TextDispatchResult = DispatchResult
  | {
      ok: false;
      status: 'failed-rolled-back';
      opId: null;
      failure: WorkbenchFailure;
    }
  | {
      ok: false;
      status: 'queued';
      opId: string;
      waitingFor: string;
    }
  | {
      ok: false;
      status: 'blocked';
      opId: string;
      failure: WorkbenchFailure | null;
    };

export interface OverlayStatus {
  status: 'pending' | 'confirmed';
  kind: 'create' | 'update' | 'remove';
  error: string | null;
  opId: string;
}

export interface PendingCreateEntry {
  opId: string;
  id: string | number | null;
  kind: 'create';
  optimistic: Record<string, unknown>;
  status: 'pending';
  row: null;
  confirmedSeq: null;
}

export interface LiveStore<Row extends Record<string, unknown> = Record<string, unknown>> {
  subscribe: (id: string | number, options?: SubscribeOptions) => LiveList<Row>;
  dispatch: (type: string, payload: Record<string, unknown>) => Promise<DispatchResult>;
  create: (payload: Record<string, unknown>) => Promise<DispatchResult>;
  update: (id: string | number, payload: Record<string, unknown>) => Promise<DispatchResult>;
  remove: (id: string | number) => Promise<DispatchResult>;
  apply: (id: string | number, field: string, operation: unknown) => Promise<DispatchResult>;
  text: (id: string | number, field: string) => {
    insert(input: { at: number; text: string }): Promise<TextDispatchResult>;
    delete(input: { start: number; end: number }): Promise<TextDispatchResult>;
  };
  retryText: (id: string | number, field: string) => Promise<TextDispatchResult>;
  action: (actionType: string, config: { method: string; path: string }) => (body?: unknown) => Promise<DispatchResult>;
  close: () => void;
  overlayFor: (id: string | number) => Row | null;
  overlayStatusFor: (id: string | number) => OverlayStatus | null;
  pendingCreates: () => PendingCreateEntry[];
  onRender: (cb: () => void) => () => void;
  [key: string]: unknown;
}

export function createLiveStore<Row extends Record<string, unknown> = Record<string, unknown>>(
  config: LiveStoreConfig,
): LiveStore<Row>;

// ---------------------------------------------------------------------------
// createLiveDeliverySession — recipient-envelope delivery and recovery
// ---------------------------------------------------------------------------

export interface LiveDeliveryEventEnvelope {
  readonly type: 'event';
  readonly seq: number;
  readonly seqSpan?: readonly [number, number];
  readonly event: { readonly type: string; readonly data?: unknown; readonly actionId?: string };
  readonly delta?: Readonly<Record<string, unknown>>;
}

export interface LiveDeliveryResyncEnvelope {
  readonly type: 'resync';
  readonly seq: number;
  readonly reason: string;
}

/**
 * S3/A7 replacement projection for a live resource. `seq` is the live
 * revision. A live row carries the recipient-projected declared-field view
 * under `state`; a live collection carries its bounded membership replacement
 * (additions/removals/reorderings/rows). An authoritative `state` replaces
 * the client's cached state and reconciles a pending placeholder exactly as a
 * logged `event` does.
 */
export interface LiveDeliveryStateEnvelope {
  readonly type: 'state';
  readonly entity?: string;
  readonly id?: string;
  readonly seq: number;
  readonly seqSpan?: readonly [number, number];
  readonly state?: Readonly<Record<string, unknown>>;
  /** Document-bound annotated-text states carry the authoring checkpoint that
   * validates and installs the matching family in the same delivery turn. */
  readonly authoring?: Readonly<Record<string, unknown>>;
  readonly additions?: readonly Record<string, unknown>[];
  readonly removals?: readonly string[];
  readonly reorderings?: readonly { id: string; from: number; to: number }[];
  readonly rows?: readonly Record<string, unknown>[];
}

/**
 * S3/A7 bounded-overflow / resnapshot-required boundary for a live resource.
 * The client must resnapshot/refresh the resource; it never reconciles a
 * placeholder from the invalidated content. For a bounded collection the
 * truncated membership view may still be carried (informational).
 */
export interface LiveDeliveryStateInvalidateEnvelope {
  readonly type: 'state-invalidate';
  readonly entity?: string;
  readonly id?: string;
  readonly seq: number;
  readonly reason?: string;
  readonly additions?: readonly Record<string, unknown>[];
  readonly removals?: readonly string[];
  readonly reorderings?: readonly { id: string; from: number; to: number }[];
  readonly rows?: readonly Record<string, unknown>[];
}

/**
 * S3/A7 derived/operational notification. This kind is distinct from the
 * authoritative `event`/`state` kinds and is NEVER authoritative: the client
 * must reject it as a domain mutation and never reconcile optimistic state
 * from it.
 */
export interface LiveDeliveryNotificationEnvelope {
  readonly type: 'notification';
  readonly kind: string;
  readonly seq?: number;
}

export type LiveDeliveryEnvelope =
  | LiveDeliveryEventEnvelope
  | LiveDeliveryResyncEnvelope
  | LiveDeliveryStateEnvelope
  | LiveDeliveryStateInvalidateEnvelope
  | LiveDeliveryNotificationEnvelope;

export type LiveDeliveryCursor = number | Readonly<{ anchor: number; aggregate: number }>;

export type LiveDeliveryBootstrap<Snapshot> =
  | { kind: 'snapshot'; snapshot: Snapshot; cursor: LiveDeliveryCursor }
  | { kind: 'catchup'; envelopes: readonly LiveDeliveryEnvelope[]; cursor: LiveDeliveryCursor }
  | { kind: 'revoked'; reason?: unknown }
  | { kind: 'retry'; reason?: LiveRetryReason };

/**
 * Additive machine-readable diagnostics on bootstrap-path retries (#815).
 * Opaque to the session runtime: retry behavior is unchanged.
 */
export type LiveRetryReason = 'cursor-moved' | 'fence-mismatch' | 'lease-budget-exhausted' | 'snapshot-contention';

export interface LiveDeliverySubscription {
  close?: () => void;
}

/**
 * A composite action is settled only after its positive receipt fence is
 * covered by an authorized replacement snapshot. This never appears in live
 * envelopes, which remain opaque recipient-safe recovery controls.
 */
export type LiveDeliveryActionReceipt =
  | { ok?: true; value?: unknown; cursor?: number; seq?: number }
  | { ok?: true; value?: unknown; actionId: string; confirmedThrough: number }
  | { ok: false; failure?: unknown; error?: unknown };

export type LiveDeliverySettlement = {
  readonly opId: string;
  wait(options?: { signal?: AbortSignal }): Promise<
    | { opId: string; status: 'reconciled' }
    | { opId: string; status: 'unavailable' | 'revoked' | 'closed' }
    | { opId: string; status: 'failed'; error: unknown }
    | { opId: string; status: 'cancelled' }
  >;
};

export type LiveDeliveryDispatchResult =
  | { ok: true; status: 'committed'; opId: string; settlement: LiveDeliverySettlement; value?: unknown }
  | { ok: false; status: 'failed-rolled-back'; opId: string; settlement: LiveDeliverySettlement; failure: unknown }
  | { ok: false; status: 'outcome-unknown'; opId: string; settlement: LiveDeliverySettlement; deliveryError: { message: string } };

export interface LiveDeliverySessionConfig<Snapshot, Payload = unknown> {
  bootstrap(input: { after?: LiveDeliveryCursor; mode: 'snapshot' | 'catchup' }): Promise<LiveDeliveryBootstrap<Snapshot>>;
  subscribe(input: {
    after: LiveDeliveryCursor;
    deliver: (envelopes: readonly LiveDeliveryEnvelope[]) => Promise<void>;
    revoke: (reason?: unknown) => void;
    closed: () => void;
  }): Promise<LiveDeliverySubscription>;
  validateSnapshot(snapshot: unknown): Snapshot;
  /**
   * Fold an authoritative full-log `event` onto the snapshot. `state`
   * envelopes are NOT folded — they replace the snapshot wholesale and
   * reconcile pending placeholders exactly as a logged event does;
   * `state-invalidate`/`resync` trigger a resnapshot and `notification`
   * envelopes are never authoritative.
   */
  fold?: (snapshot: Snapshot, envelope: LiveDeliveryEventEnvelope) => Snapshot;
  optimistic?: (snapshot: Snapshot, action: { actionId: string; type: string; payload: Payload }) => Snapshot;
  /** Snapshot-only sessions require `{ actionId, confirmedThrough }` on success. */
  sendAction(action: { actionId: string; type: string; payload: Payload }): Promise<LiveDeliveryActionReceipt | void>;
  sendBatch?(batch: LiveDeliveryBatchEnvelope<Payload>): Promise<LiveDeliveryActionReceipt | void>;
  createActionId?: () => string;
  onRecoveryStart?: () => void;
}

export interface LiveDeliveryBatchAction<Payload = unknown> {
  type: string;
  payload: Payload;
}

export interface LiveDeliveryBatchEnvelope<Payload = unknown> {
  actionId: string;
  actions: readonly LiveDeliveryBatchAction<Payload>[];
}

export interface LiveDeliverySession<Snapshot, Payload = unknown> {
  readonly snapshot: Snapshot | null;
  /**
   * The pre-projection view: the last server-installed snapshot, with no pending
   * operation's optimistic reducer applied.
   *
   * `snapshot` is the MERGED view (confirmed base plus every pending
   * projection) and is what a UI should render. A consumer that must
   * distinguish a CONFIRMED row from a merely PROJECTED one — reconciling an
   * optimistic write, for example — reads this instead, because a projected
   * row is indistinguishable from a confirmed one in the merged view.
   *
   * Both objects are already held in memory; this is a reference, not a copy.
   * It is `null` exactly when `snapshot` is `null`.
   */
  readonly confirmedSnapshot: Snapshot | null;
  readonly cursor: LiveDeliveryCursor;
  readonly status: 'bootstrapping' | 'recovering' | 'catching-up' | 'live' | 'unavailable' | 'revoked';
  readonly ready: Promise<void>;
  dispatch(type: string, payload: Payload, options?: { actionId?: string }): Promise<LiveDeliveryDispatchResult>;
  batch(actions: readonly LiveDeliveryBatchAction<Payload>[]): Promise<LiveDeliveryDispatchResult>;
  retry(opId: string): Promise<LiveDeliveryDispatchResult>;
  reconnect(): Promise<void>;
  operations(): Array<{ opId: string; actionId: string; status: 'pending'; error: unknown }>;
  pendingCount(): number;
  subscribe(listener: (snapshot: Snapshot | null) => void): () => void;
  close(): void;
}

export interface LiveDeliveryHistorySession {
  /** Uses the package-owned authenticated session cursor. */
  undo(): Promise<ScopeDispatchResult>;
  redo(): Promise<ScopeDispatchResult>;
}

export interface LiveDeliveryHttpSession<Snapshot, Payload = unknown> extends LiveDeliverySession<Snapshot, Payload> {
  readonly history: LiveDeliveryHistorySession;
}

export function createLiveDeliverySession<Snapshot, Payload = unknown>(
  config: LiveDeliverySessionConfig<Snapshot, Payload>,
): LiveDeliverySession<Snapshot, Payload>;

export interface LiveDeliveryHttpSessionConfig<Snapshot, Payload = unknown> {
  baseUrl: string;
  scope: string;
  validateSnapshot: (snapshot: unknown) => Snapshot;
  fold?: (snapshot: Snapshot, envelope: LiveDeliveryEventEnvelope) => Snapshot;
  optimistic?: (snapshot: Snapshot, action: { actionId: string; type: string; payload: Payload }) => Snapshot;
  /** Override the package-owned POST /workbench/actions transport. */
  sendAction?: LiveDeliverySessionConfig<Snapshot, Payload>['sendAction'];
  sendBatch?: LiveDeliverySessionConfig<Snapshot, Payload>['sendBatch'];
  /** Absolute action endpoint; defaults to /workbench/actions on this origin. */
  actionUrl?: string;
  /** Binds ordinary actions and one-step history moves to one durable session cursor. */
  historySession: string;
  fetchImpl?: typeof globalThis.fetch;
  eventSourceFactory?: (url: string, options: EventSourceInit) => EventSource;
  createActionId?: () => string;
  onRecoveryStart?: () => void;
  /** Package-owned entity identity used to derive a server-side scope. */
  requestIdentity?: Readonly<Record<string, string>> | null;
}

export function createLiveDeliveryHttpSession<Snapshot, Payload = unknown>(
  config: LiveDeliveryHttpSessionConfig<Snapshot, Payload>,
): LiveDeliveryHttpSession<Snapshot, Payload>;

export interface PrincipalSnapshotHttpSession<Snapshot> {
  readonly snapshot: Snapshot | null;
  readonly status: 'bootstrapping' | 'recovering' | 'catching-up' | 'live' | 'unavailable' | 'revoked';
  readonly ready: Promise<void>;
  subscribe(listener: (snapshot: Snapshot | null) => void): () => void;
  reconnect(): Promise<void>;
  close(): void;
}

export interface PrincipalSnapshotHttpSessionConfig<Snapshot> {
  baseUrl: string;
  declaration: string;
  principal: Readonly<{ type: Exclude<import('./index.d.ts').PrincipalType, 'anonymous'>; id: string }>;
  validateSnapshot(snapshot: unknown): Snapshot;
  fetchImpl?: typeof globalThis.fetch;
  eventSourceFactory?: (url: string, options: EventSourceInit) => EventSource;
}

export function createPrincipalSnapshotHttpSession<Snapshot>(
  config: PrincipalSnapshotHttpSessionConfig<Snapshot>,
): PrincipalSnapshotHttpSession<Snapshot>;

// ---------------------------------------------------------------------------
// createScopeLiveStore — composite scope projection
// ---------------------------------------------------------------------------

export interface ScopeEvent {
  scope: string;
  seq: number;
  seqSpan: [number, number];
  type: string;
  data?: unknown;
  actionId?: string;
  committedAt?: string;
  delta?: Record<string, unknown>;
}

export interface ScopeAction<Payload = unknown> {
  actionId: string;
  scope: string;
  type: string;
  payload: Payload;
}

export type ScopeDispatchReceipt =
  | { ok: true; cursor?: number; seq?: number; value?: unknown }
  | { ok: false; failure?: unknown; error?: unknown };

export interface ScopeOperation<Payload = unknown> {
  opId: string;
  actionId: string;
  action: ScopeAction<Payload>;
  status: 'pending' | 'failed';
  error: unknown;
  delivered: boolean;
  confirmedCursor: number | null;
  echoCursor: number | null;
}

/**
 * A document-path dispatch result (`applyAnnotation` / `applyAnnotationAction`
 * / `removeAnnotation`). Mirrors `LiveDeliveryDispatchResult`: a dispatched
 * mutation carries the operation's `settlement`, whose `wait()` resolves
 * `reconciled` once the positive receipt fence (`confirmedThrough`) is covered
 * by an authorized replacement snapshot. The field is optional because the
 * legacy `ScopeLiveStore.dispatch` path and plain local conflict shapes
 * predate settlements and never carry one.
 */
export type ScopeDispatchResult =
  | { ok: true; status: 'committed'; opId: string; settlement?: LiveDeliverySettlement; value?: unknown }
  | { ok: false; status: 'failed-rolled-back'; opId: string; settlement?: LiveDeliverySettlement; failure: unknown }
  | { ok: false; status: 'outcome-unknown'; opId: string; settlement?: LiveDeliverySettlement; failure: unknown };

export interface ScopeLiveStoreConfig<Snapshot> {
  baseUrl: string;
  scope: string;
  validateSnapshot: (snapshot: unknown) => Snapshot;
  fold: (snapshot: Snapshot, event: ScopeEvent) => Snapshot;
  optimistic?: (snapshot: Snapshot, action: ScopeAction) => Snapshot;
  sendAction: (action: ScopeAction) => Promise<ScopeDispatchReceipt | void>;
  channel?: LiveChannel;
  fetchImpl?: typeof globalThis.fetch;
  snapshotUrl?: string;
  eventsSinceUrl?: (cursor: number) => string;
  createActionId?: () => string;
  resyncBackoffBase?: number;
  maxResyncBackoff?: number;
}

export interface ScopeLiveStore<Snapshot> {
  readonly snapshot: Snapshot | null;
  readonly cursor: number;
  readonly ready: Promise<void>;
  dispatch(type: string, payload: unknown): Promise<ScopeDispatchResult>;
  operations(): ScopeOperation[];
  pendingCount(): number;
  failedCount(): number;
  discardFailed(opId: string): void;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
  close(): void;
}

export function createScopeLiveStore<Snapshot>(config: ScopeLiveStoreConfig<Snapshot>): ScopeLiveStore<Snapshot>;

// ---------------------------------------------------------------------------
// createAuthClient — register/login/logout
// ---------------------------------------------------------------------------

export interface AuthClientConfig {
  baseUrl: string;
  fetchImpl?: typeof globalThis.fetch;
}

export interface LoginResult {
  user: { id: string; username: string };
}

export interface AuthClient {
  register(username: string, password: string): Promise<LoginResult>;
  login(username: string, password: string): Promise<LoginResult>;
  logout(): Promise<{ ok: boolean }>;
}

export function createAuthClient(config?: AuthClientConfig): AuthClient;

// ---------------------------------------------------------------------------
// materializeAnnotatedTextSnapshot — browser snapshot materialization
// ---------------------------------------------------------------------------

/** An annotation on the continuous document (issue #33). Its character extent
 * lives in `AnnotatedTextDocument.ranges`; `owner` is disclosed only to the
 * owning recipient. */
export interface AnnotatedTextAnnotation {
  readonly id: string;
  readonly family: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly owner?: string;
}

/** An orphaned annotation: its range was emptied and the server preserved the
 * annotation under its saved quote instead of deleting it. */
export interface AnnotatedTextOrphan {
  readonly id: string;
  readonly family: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly savedQuote: string;
  readonly owner?: string;
}

/** A measurement on the continuous document. `formatVersion` and `payload`
 * are validated by the field's declared measurement extension. */
export interface AnnotatedTextMeasurement {
  readonly id: string;
  readonly family: string;
  readonly formatVersion: number;
  readonly payload: unknown;
}

/**
 * The blockless recipient document (issue #33): ONE continuous `text` with
 * document-absolute UTF-16 annotation `ranges`. Read `text`, `ranges`,
 * `annotations`, `measurements`, `capabilities`, `orphans`, and `redactions`
 * directly.
 */
export interface AnnotatedTextDocument {
  readonly kind: 'workbench.annotatedText.recipient';
  readonly version: 1 | 2 | 3;
  readonly text: string;
  readonly ranges: readonly AnnotatedTextRange[];
  readonly annotations: readonly AnnotatedTextAnnotation[];
  readonly orphans?: readonly AnnotatedTextOrphan[];
  readonly measurements?: readonly AnnotatedTextMeasurement[];
  readonly capabilities: readonly string[] | null;
  readonly capabilityHints?: readonly string[];
  readonly restricted?: boolean;
  readonly redactions?: readonly AnnotatedTextRedactionMarker[];
}

export function materializeAnnotatedTextSnapshot(
  snapshot: Record<string, unknown>,
  declaration: AnnotatedTextFieldHandle,
  options?: { readonly binding?: unknown; readonly family?: unknown; readonly consume?: boolean },
): AnnotatedTextDocument;

/** Project a historical-basis endpoint to an absolute UTF-16 offset. */
export function projectEndpointToOffset(family: unknown, endpoint: unknown): number;

// ---------------------------------------------------------------------------
// createAnnotatedTextHttpSession — document-bound typed authoring
// ---------------------------------------------------------------------------

/** A document-absolute UTF-16 position in the one continuous text. */
export interface AnnotatedTextPosition {
  readonly offset: number;
  readonly affinity: 'left' | 'right';
}

export interface AnnotatedTextAuthoringContext {
  readonly entity: AnyWorkbenchEntity;
  readonly field: AnnotatedTextFieldHandle;
  readonly documentId: string;
  /** Optional recipient override included in server authoring requests. */
  readonly viewAs?: string;
}

export interface AnnotatedTextHttpSessionConfig {
  readonly baseUrl: string;
  readonly context: AnnotatedTextAuthoringContext;
  readonly historySession: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly eventSourceFactory?: (url: string, options: EventSourceInit) => EventSource;
  readonly createActionId?: () => string;
  readonly onRecoveryDelayed?: (delayed: boolean) => void;
  /** Opt-in fold timing hook: called after each client-side fold with its applied duration in ms. */
  readonly onFoldApplied?: (fold: unknown, elapsedMs: number) => void;
  /** Idle window used to coalesce contiguous inserts; defaults to 75ms. Set to 0 to disable. */
  readonly typingBurstIdleMs?: number;
  /** Maximum age of a continuously active typing burst; defaults to 150ms. */
  readonly typingBurstMaxMs?: number;
  /** Opt in to volatile collaborator carets over the document WebSocket. */
  readonly carets?: {
    readonly wsBaseUrl: string;
    readonly socketFactory?: (url: string) => WebSocket;
  };
}

/** A client-side position into the document's single continuous text frame:
 * absolute UTF-16 offset plus placeholder-edge affinity. The session stamps
 * its own position token server-side. */
export interface AnnotatedTextEditPosition {
  readonly offset: number;
  readonly affinity: 'left' | 'right';
}

export interface AnnotatedTextHttpSession {
  readonly document: AnnotatedTextDocument | null;
  readonly family: unknown;
  readonly history: LiveDeliveryHistorySession;
  /** Number of optimistic document operations not yet reconciled by ingest. */
  pendingCount(): number;
  readonly status: LiveDeliverySession<AnnotatedTextDocument>['status'];
  readonly ready: Promise<void>;
  insert(input: { readonly mutationId?: string; readonly at: AnnotatedTextEditPosition; readonly text: string }): Promise<LiveDeliveryDispatchResult>;
  delete(input: { readonly mutationId?: string; readonly from: AnnotatedTextEditPosition; readonly to: AnnotatedTextEditPosition }): Promise<LiveDeliveryDispatchResult>;
  /**
   * Annotation-aware paste: inserts `text` at `at` and anchors one fresh
   * server-minted annotation of `annotation.family` (with `fields`) over the
   * inserted run, in ONE operated event and ONE undo step. Protection edges
   * are never copied. The annotation id arrives on the confirmed echo.
   */
  paste(input: { readonly mutationId?: string; readonly at: AnnotatedTextEditPosition; readonly text: string; readonly annotation: { readonly family: string; readonly fields?: Readonly<Record<string, unknown>> } }): Promise<LiveDeliveryDispatchResult>;
  replace(input: { readonly mutationId?: string; readonly from: AnnotatedTextEditPosition; readonly to: AnnotatedTextEditPosition; readonly text: string }): Promise<LiveDeliveryDispatchResult | null>;
  applyAnnotation(input: { readonly mutationId: string; readonly annotation: { readonly id: string; readonly family: string; readonly fields: Readonly<Record<string, unknown>>; readonly protectedTargetIds?: readonly string[] }; readonly from: AnnotatedTextEditPosition; readonly to: AnnotatedTextEditPosition }): Promise<ScopeDispatchResult>;
  applyAnnotationAction<Action extends AnnotatedTextAnnotationEntityActionHandle>(actionHandle: Action, input: { readonly mutationId: string; readonly from: AnnotatedTextEditPosition; readonly to: AnnotatedTextEditPosition; readonly values: AnnotatedTextAnnotationActionValues<Action> }): Promise<ScopeDispatchResult>;
  /** Removes an annotation-owned related entity row and its anchor annotation in ONE settlement. `expected` is the declared stale column's opaque version token. */
  removeAnnotationEntity<Action extends AnnotatedTextAnnotationEntityRemoveActionHandle>(actionHandle: Action, input: { readonly mutationId: string; readonly annotationId: string; readonly relatedId: string; readonly expected: string }): Promise<ScopeDispatchResult>;
  removeAnnotation(input: { readonly mutationId: string; readonly annotationId: string }): Promise<ScopeDispatchResult>;
  publishCaret?(input: { readonly offset: number }): boolean;
  clearCaret?(): boolean;
  onCaret?(listener: OnCaret): () => void;
  reconnect(): Promise<void>;
  recoverFromUnresolvableRange(): void;
  /** Each accepted projection publication supplies a fresh immutable document identity; duplicate delivery produces no publication; family and document are installed atomically. */
  subscribe(listener: (document: AnnotatedTextDocument | null) => void): () => void;
  close(): void;
}

export function createAnnotatedTextHttpSession(config: AnnotatedTextHttpSessionConfig): AnnotatedTextHttpSession;

export interface AnnotatedTextEditorBinding {
  focus(): void;
  getSelection(): AnnotatedTextEditorSelection | null;
  setAnnotationHighlight(annotationId: string, active: boolean): void;
  selectAnnotation(annotationId: string): void;
  close(): void;
}

export interface AnnotatedTextEditorPosition {
  readonly offset: number;
  readonly affinity: 'left' | 'right';
}

export interface AnnotatedTextEditorSelection {
  readonly from: AnnotatedTextEditorPosition;
  readonly to: AnnotatedTextEditorPosition;
}

export function bindAnnotatedTextEditor(config: {
  readonly element: HTMLElement;
  readonly session: AnnotatedTextHttpSession;
  readonly onError?: (error: unknown) => void;
}): AnnotatedTextEditorBinding;
