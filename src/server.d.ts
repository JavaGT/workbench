/// <reference types="node" />

import type { Readable } from 'node:stream';
import type {
  BoundWorkbenchEntity,
  EntityDeclaration,
  Principal,
  UserPrincipal,
  Handler,
  WorkbenchEntity,
  WorkbenchDatabase,
  WorkbenchStatement,
} from '../index.d.ts';
export type { WorkbenchDatabase, WorkbenchStatement, UserPrincipal } from '../index.d.ts';

// ---------------------------------------------------------------------------
// Search plugin contract
// ---------------------------------------------------------------------------

export type SearchPluginState = 'building' | 'ready' | 'stale' | 'failed';
export type SearchOwnedObjectKind = 'table' | 'index' | 'trigger' | 'virtual-table';
export type SearchPluginCounts = Readonly<Record<string, number>>;
export type ProjectPurgeDisposition = import('../index.d.ts').ProjectPurgeDisposition;
export interface SearchOwnedObject {
  readonly kind: SearchOwnedObjectKind;
  readonly name: string;
  readonly ddl: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly disposition: ProjectPurgeDisposition;
}
export interface SearchSourceInterest {
  readonly entity: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly scope?: (ctx: { is: unknown; fields: unknown }) => unknown;
}
export type SearchChangeKind = 'created' | 'updated' | 'removed';
export interface SearchChange {
  readonly entity: string;
  readonly rowId: string;
  readonly kind: SearchChangeKind;
  readonly data?: Readonly<Record<string, unknown>>;
}
export interface SearchRequest {
  readonly query: unknown;
  readonly entity?: string;
  readonly principal?: Principal;
  readonly limit?: number;
  readonly offset?: number;
  readonly signal?: AbortSignal;
}
export interface SearchMaterializeResult { readonly counts?: SearchPluginCounts; }
export interface SearchPluginSearchResult { readonly hits: readonly unknown[]; }
export interface SearchSourceHandle {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
}
export interface SearchRetryInfo {
  readonly message: string;
  readonly at: string;
  readonly attempt: number;
  readonly retryable: boolean;
}
export interface SearchPluginHealth {
  readonly id: string;
  readonly version: string;
  readonly generation: number;
  readonly fence: number;
  readonly state: SearchPluginState;
  readonly counts: SearchPluginCounts;
  readonly lastError: SearchRetryInfo | null;
}
export interface SearchOwnedIndex {
  query(request: { readonly sql: string; readonly params?: readonly unknown[] }): readonly Record<string, unknown>[];
  write(request: { readonly expectedFence: number; readonly statements: readonly SearchIndexStatement[] }): Promise<{ readonly changes: number }>;
}
export interface SearchSourceReader {
  readonly plugin: string;
  readonly writeCapable: false;
  readonly interests: readonly SearchSourceInterest[];
  sources(): readonly string[];
  rows(entity: string, options?: { readonly ids?: readonly string[]; readonly limit?: number }): readonly Record<string, unknown>[];
  row(entity: string, id: string): Record<string, unknown> | undefined;
}
export interface SearchPluginContext {
  readonly id: string;
  readonly version: string;
  readonly reader: SearchSourceReader;
  readonly index: SearchOwnedIndex;
  readonly generation: number;
  readonly fence: number;
}
export interface SearchLifecycleOutcome {
  readonly ok: boolean;
  readonly generation: number;
  readonly fence: number;
  readonly state: SearchPluginState;
  readonly counts: SearchPluginCounts;
  readonly lastError: SearchRetryInfo | null;
  readonly result: SearchMaterializeResult | null;
}
export interface SearchSearchOutcome {
  readonly ok: boolean;
  readonly generation: number;
  readonly fence: number;
  readonly state: SearchPluginState;
  readonly counts: SearchPluginCounts;
  readonly result: { readonly hits: readonly unknown[]; readonly generation: number; readonly fence: number; readonly state: SearchPluginState } | null;
  readonly lastError: SearchRetryInfo | null;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
}
export interface SearchNotification {
  readonly invalidated: boolean;
  readonly stalenessKey: string | null;
}
export interface SearchPluginCensusEntry { readonly source: string; readonly sql: string; }
export interface SearchPluginCensusObject extends SearchOwnedObject { readonly owner: string; readonly version: string; }
export interface SearchPluginCensus {
  readonly entries: readonly SearchPluginCensusEntry[];
  readonly objects: readonly SearchPluginCensusObject[];
}
export interface SearchPlugin {
  readonly contractVersion: number;
  readonly id: string;
  readonly version: string;
  readonly ownedObjects: readonly SearchOwnedObject[];
  readonly sourceInterests: readonly SearchSourceInterest[];
  readonly generationIdentity?: string;
  stalenessKey(change: SearchChange): string | null;
  prepare(ctx: SearchPluginContext): void | Promise<void>;
  validate(ctx: SearchPluginContext): void | Promise<void>;
  reconcile(ctx: SearchPluginContext, changes: readonly SearchChange[]): SearchMaterializeResult | Promise<SearchMaterializeResult>;
  rebuild(ctx: SearchPluginContext): SearchMaterializeResult | Promise<SearchMaterializeResult>;
  search(ctx: SearchPluginContext, request: SearchRequest): SearchPluginSearchResult | Promise<SearchPluginSearchResult>;
  health?(ctx: SearchPluginContext): unknown;
}
export interface SearchPluginRegistryOptions { now?: () => string; searchTimeoutMs?: number; }
export interface SearchPluginRegistry {
  readonly size: number;
  register(plugin: SearchPlugin): void;
  has(id: string): boolean;
  get(id: string): SearchPlugin | undefined;
  ids(): readonly string[];
  census(): SearchPluginCensus;
  stateOf(id: string): SearchPluginHealth;
  healthOf(id: string): SearchPluginHealth & { readonly plugin: unknown };
  bindSource(handle: SearchSourceHandle | null): void;
  bindIndex(index: ((id: string) => SearchOwnedIndex) | null): void;
  ownedIndex(id: string): SearchOwnedIndex;
  sourceReader(id: string): SearchSourceReader;
  notifyChange(id: string, change: SearchChange): SearchNotification;
  prepare(id: string): Promise<SearchLifecycleOutcome>;
  validate(id: string): Promise<SearchLifecycleOutcome>;
  reconcile(id: string, changes: readonly SearchChange[]): Promise<SearchLifecycleOutcome>;
  rebuild(id: string): Promise<SearchLifecycleOutcome>;
  search(id: string, request: SearchRequest): Promise<SearchSearchOutcome>;
}
export function createSearchSourceReader(
  handle: SearchSourceHandle | null,
  options: { plugin: string; interests: readonly SearchSourceInterest[] },
): SearchSourceReader;
export function createSearchPluginRegistry(options?: SearchPluginRegistryOptions): SearchPluginRegistry;

export interface SearchIndexStatement {
  readonly sql: string;
  readonly params?: readonly unknown[];
}
export interface SearchIndexAuthorizerHandle extends WorkbenchDatabase {
  setAuthorizer(callback: ((actionCode: number, arg1: string | null, arg2: string | null, dbName: string | null, triggerOrView: string | null) => number) | null): void;
  enableLoadExtension?(allow: boolean): void;
}
export interface SearchCensusEntry {
  readonly kind: 'framework' | 'entity' | 'schema' | 'plugin' | 'sqlite-artifact';
  readonly owner: string;
  readonly objectKind: SearchOwnedObjectKind | 'shadow-table';
  readonly name: string;
}
export interface SearchOwnedIndexCapabilityOptions {
  readonly db: SearchIndexAuthorizerHandle;
  readonly census: ReadonlyMap<string, SearchCensusEntry>;
  readonly writeCoordinator: { run<T>(fn: () => T | Promise<T>): Promise<T> };
  readonly fenceOf: (pluginId: string) => number;
  readonly maxStatements?: number;
  readonly maxRows?: number;
}
export function createSearchOwnedIndexCapability(options: SearchOwnedIndexCapabilityOptions): (pluginId: string) => SearchOwnedIndex;

export type VectorPluginValidationCode =
  | 'dimension-mismatch'
  | 'non-finite-value'
  | 'model-space-mismatch'
  | 'unauthorized-source-ownership'
  | 'invalid-vector';
export interface VectorModelSpace { readonly model: string; readonly dimensions: number; }
export interface VectorPluginSource {
  readonly entity: string;
  readonly vector: string;
  readonly model: string;
  readonly owns: (row: Readonly<Record<string, unknown>>) => boolean;
}
export interface VectorPluginOptions {
  readonly admission?: { readonly entity: { name: string }; readonly adapter: import('../index.d.ts').AuthorizationAdapter };
  readonly id: string;
  readonly version: string;
  readonly source: VectorPluginSource;
  readonly modelSpace: VectorModelSpace;
}
export interface SearchEntityCensus {
  readonly count: number;
  readonly digest: string | null;
}
export type SearchCensus = Readonly<Record<string, SearchEntityCensus>>;
export interface SearchShadowCapabilities {
  beginShadow(ctx: SearchPluginContext): void | Promise<void>;
  indexCensus(ctx: SearchPluginContext): SearchCensus;
  commitShadow(ctx: SearchPluginContext): void | Promise<void>;
  rollbackShadow(ctx: SearchPluginContext): void | Promise<void>;
  abortShadow(ctx: SearchPluginContext): void | Promise<void>;
  sourceCensus?(ctx: SearchPluginContext): SearchCensus;
}
export interface VectorPlugin extends SearchPlugin, SearchShadowCapabilities {
  readonly generationIdentity: string;
  readonly modelSpace: VectorModelSpace;
  validateSourceRow(row: Readonly<Record<string, unknown>>): void;
  setModelSpace(modelSpace: VectorModelSpace): void;
}
export function createVectorPlugin(options: VectorPluginOptions): VectorPlugin;
export type { PostCommitEffectRunner } from '../index.d.ts';
export function createPostCommitEffectRunner(options: {
  db: WorkbenchDatabase;
  leaseMs?: number;
  now?: () => number;
}): import('../index.d.ts').PostCommitEffectRunner;

export type OperationalFailure = Readonly<{
  consumer: import('../index.d.ts').OperationalConsumerName;
  scopeId: string;
  committedEventId: string;
  declarationFingerprint: string;
  code: string;
  detail: string;
  status: 'terminal';
}>;
export interface OperationalConsumerAdmin {
  listFailures(consumer: import('../index.d.ts').OperationalConsumerName): Promise<readonly OperationalFailure[]>;
  retryFailure(failure: Pick<OperationalFailure, 'consumer' | 'scopeId' | 'committedEventId'>): Promise<void>;
}
export function operationalConsumerAdmin(workbench: import('../index.d.ts').WorkbenchApp): OperationalConsumerAdmin;

export type PendingBlobKey = string & { readonly __brand: 'PendingBlobKey' };
export type PendingBlobClaim = Readonly<{ pendingKey: PendingBlobKey; claimToken: string & { readonly __brand: 'PendingBlobClaimToken' } }>;
export type ClaimedBlobRef = Readonly<{ blobId: string & { readonly __brand: 'ClaimedBlobId' } }>;
export type DeclaredClaimedBlob = import('../index.d.ts').DeclaredClaimedBlob;
export type DeclaredClaimedBlobs = import('../index.d.ts').DeclaredClaimedBlobs;
export type StagePendingBlobRequest = Readonly<{ scopeId: string; resourceId: string; bytes: Uint8Array | AsyncIterable<Uint8Array>; mediaType?: string }>;
export type StagedPendingBlob = Readonly<{ claim: PendingBlobClaim; pendingKey: PendingBlobKey; byteLength: number; contentDigest: string }>;
export interface PendingBlobStager { stage(request: StagePendingBlobRequest): Promise<StagedPendingBlob>; }
export function pendingBlobStager(workbench: import('../index.d.ts').WorkbenchApp, authenticatedPrincipal: Principal): PendingBlobStager;
export function readClaimedBlob(workbench: import('../index.d.ts').WorkbenchApp, blobId: ClaimedBlobRef['blobId']): Buffer;
export type ClaimedBlobLifecycleState =
  | Readonly<{ kind: 'available'; readRange(range?: readonly [number, number]): Buffer }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'failed' }>
  | Readonly<{ kind: 'missing' }>;
export interface ClaimedBlobLifecycle {
  inspect(blobId: string): ClaimedBlobLifecycleState;
  reconcile(): Promise<void>;
}
export function claimedBlobLifecycle(workbench: import('../index.d.ts').WorkbenchApp): ClaimedBlobLifecycle;
export type StagedBlobRead = Readonly<{ byteLength: number; sha256: string; readRange(range?: readonly [number, number]): Buffer }>;
export function stagedBlobReader(workbench: import('../index.d.ts').WorkbenchApp, authenticatedPrincipal: Principal, claim: PendingBlobClaim): StagedBlobRead;

/**
 * The pending-blob claim machinery mounted on a started app
 * (`app.pendingBlobLifecycle`): stages uploads as claims, admits reads only
 * through admitted claims, and owns finalization/deletion recovery.
 */
export interface PendingBlobLifecycle {
  stage(principal: Principal, request: StagePendingBlobRequest): Promise<StagedPendingBlob>;
  validateClaim(args: {
    claim: unknown;
    field: string;
    resourceId: string;
    actionName: string;
    actionId: string;
    authenticatedPrincipal: Principal;
    scopeId: string;
    committedEventId: string;
  }): Promise<import('../index.d.ts').DeclaredClaimedBlob>;
  requestDeletion(args: { blobId: unknown; resourceId: string; actionName: string; actionId: string; scopeId: string }): Promise<boolean>;
  /** Claim-gated byte read (S6/A4) — admitted claims ('claimed'/'finalized' rows) only. */
  readClaimed(blobId: string, range?: [start?: number, end?: number]): Buffer;
  /**
   * The streaming claimed read (#738 W1): the same claim admission and slot
   * fallback as {@link PendingBlobLifecycle.readClaimed}, served as a Node
   * Readable. Cancellable via an AbortSignal; no digest attestation — the
   * claim row IS the gate. A missing slot in BOTH slots throws the typed
   * `BlobSlotNotFoundError`.
   */
  readClaimedStream(blobId: string, range?: [start?: number, end?: number], options?: { signal?: AbortSignal }): Readable;
  /** Capability-gated staged-bytes reader (#691) — usable BEFORE the committing action exists. */
  readStagedClaim(authenticatedPrincipal: Principal, claim: unknown): StagedBlobRead;
  status(blobId: string): string | null;
  reconcile(): Promise<void>;
  reap(): Promise<void>;
  consumer(): Promise<void>;
  /** The declared blob fields the lifecycle was constructed with. */
  readonly fields: readonly DeclaredBlobField[];
  /** The lifecycle's construction options, frozen (pending/adopted-recovery TTLs). */
  readonly options: Readonly<{ pendingTtlMs: number; adoptedRecoveryTtlMs: number }>;
}

export type DeclaredBlobField = import('../index.d.ts').DeclaredBlobField;
export function declaredBlobField(field: DeclaredBlobField): DeclaredBlobField;

// ---------------------------------------------------------------------------
// Authorized blob reads (S6/A4)
// ---------------------------------------------------------------------------

export interface ReadBlobArgs {
  /** The requesting principal — a user principal (S5/A1) or a machine principal (S5/A5). The read is attributed to it. */
  principal: Principal;
  /**
   * The OWNING resource row (the entity whose blob field holds the bytes), in
   * stored cell form. Null/absent when the owning row is gone — admission
   * denies, never a distinguishable "blob missing".
   */
  resource: unknown;
  /** The declared blob field; names the resource registered on the adapter. */
  field: string;
  /** The operation category; defaults to the `blob-read` category. */
  operation?: string | { readonly operation: string };
  /** Optional half-open byte range `[start, end)`; passed through to `read`. */
  range?: [start?: number, end?: number];
  /** The S5 authorization adapter — the ONE admission engine. */
  authorize: import('../index.d.ts').AuthorizationAdapter;
  /** The claim-gated byte reader the app wires to the byte store / pending-blob claim machinery. */
  read: (range?: [start?: number, end?: number]) => Buffer;
}

/** The generic denial every blob-read failure collapses to — a plain 403 'forbidden', never an existence signal. */
export class BlobReadDeniedError extends Error {
  readonly status: 403;
  readonly failure: { readonly category: 'denied'; readonly message: string };
}

/**
 * Authorized blob read seam (S6/A4): admits through the S5 adapter under the
 * `blob` resource category, then serves bytes through the supplied claim-gated
 * reader. Every failure — denial, missing owning resource, missing bytes —
 * collapses into one generic BlobReadDeniedError.
 */
export function readBlob(args: ReadBlobArgs): Promise<Buffer>;

/** Streaming variant of {@link ReadBlobArgs} (#738 W1): the claim-gated reader returns a Node Readable instead of a Buffer. */
export interface ReadBlobStreamArgs extends Omit<ReadBlobArgs, 'read'> {
  /**
   * The claim-gated byte STREAM reader the app wires to the byte store /
   * pending-blob claim machinery. It runs only AFTER admission; a synchronous
   * failure constructing the stream (missing bytes → the typed missing-slot
   * error) surfaces as the same generic denial.
   */
  readonly read: (range?: [start?: number, end?: number]) => Readable;
}

/**
 * The authorized blob read, streaming variant (#738 W1): the SAME
 * admit-then-serve ordering as {@link readBlob} — admission completes before
 * `read` is called, so no chunk can flow through a denied or unadmitted read —
 * and the SAME generic-denial collapse. A synchronously throwing stream
 * construction denies BEFORE any streaming starts.
 */
export function readBlobStream(args: ReadBlobStreamArgs): Promise<Readable>;

// ---------------------------------------------------------------------------
// Framework table names (derived from DDL generators)
// ---------------------------------------------------------------------------

export const frameworkTableNames: readonly string[];

export function declaredTableNames(
  entities: readonly { name: string }[],
): readonly string[];

/** Reject SQL that references a framework-owned table (FROM/JOIN/INTO/UPDATE/TABLE/USING). */
export function assertNoFrameworkTableSql(sql: string): void;

// ---------------------------------------------------------------------------
// Job types — both raw rows and the parsed runtime shape
// ---------------------------------------------------------------------------

export interface JobRow {
  id: string;
  kind: string;
  payload: unknown;
  status: 'queued' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled';
  enqueuedAt: number;
  workerId: string | null;
  claimedAt: number | null;
  leaseUntil: number | null;
  scope: string | null;
  progress: number;
  stage: string | null;
  attempts: number;
  availableAt: number | null;
  // S5/A5 machine attribution persisted on the _Job row: the canonical
  // principal key and the normalized allowlist of the enqueue-time machine
  // principal (both null when the job is unattributed). Survives restart and
  // separate worker processes.
  principalKey: string | null;
  operations: readonly string[] | null;
}

export type SubmitResultOk =
  | { accepted: true; noop?: boolean }
  | { accepted: true; retried: true; attempts: number }
  | { accepted: true; deadLettered: true; attempts: number };

export type CancelJobResult = JobRow | { terminal: true } | { forbidden: true } | null;

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export interface Migration {
  /** Per-namespace migration ledger identity (S2/A4 namespaced ledger, #90). */
  namespace: string;
  /** Human-readable migration name, unique per namespace. */
  name: string;
  /** Positive version; identity is the (namespace, version) pair. */
  version: number;
  /** Cross-namespace dependencies, e.g. `"workbench@5"`. */
  dependencies?: readonly string[];
  /** Pinned immutable fingerprint; when absent the runner derives one from `up`. */
  checksum?: string;
  /** The package/app version that supplied this migration. */
  suppliedBy?: string;
  up(db: WorkbenchDatabase): void;
}

// ---------------------------------------------------------------------------
// Blob store
// ---------------------------------------------------------------------------

/** Durability of a byte store: `durable` bytes survive a process restart; `ephemeral` bytes live only within the owning process. */
export type ByteStoreDurability = 'durable' | 'ephemeral';

/** Consistency tag a backend declares for its byte storage. `single-node-strong` is the only tag shipped. */
export type ByteStoreConsistency = 'single-node-strong';

/** A byte store's closed, queryable declaration of what it guarantees. A backend must declare honestly and never overstate it. */
export interface ByteStoreCapabilities {
  readonly durability: ByteStoreDurability;
  readonly atomicPromotion: boolean;
  readonly rangeSupport: boolean;
  readonly deleteVerification: boolean;
  readonly consistency: ByteStoreConsistency;
}

/**
 * The byte-store contract's typed MISSING-SLOT signal. A conforming backend
 * MUST throw an instance of this (never a bare Error) when a read targets a
 * slot that has no bytes — the pending-blob claim machinery distinguishes "the
 * pending slot is gone, read the final slot" from "the bytes failed to read"
 * by this TYPE, never by a message string: a conforming backend phrases its
 * message however it likes (ENOENT-style, S3 NoSuchKey, …). Callers must never
 * treat any other error as a missing slot.
 */
export class BlobSlotNotFoundError extends Error {}

/**
 * The typed signal writePendingStream throws when a streamed payload exceeds
 * its `maxBytes` — raised MID-STREAM (the write aborts as soon as the bound is
 * crossed, never after buffering the whole payload). Consumers branch on this
 * TYPE, never on a message string, exactly like BlobSlotNotFoundError.
 */
export class BlobTooLargeError extends Error {
  readonly limit: number;
  readonly received: number;
}

/**
 * The byte-store contract — what `createBlobStore`'s `bytes` option must
 * provide, and what any conforming backend (fs, memory, or a future S3
 * adapter) guarantees. Each method's guarantee is PART OF THE TYPE: the blob
 * lifecycle in `createBlobStore` depends on these semantics. See
 * `src/fs-blobs.ts` for the same contract at the implementation boundary.
 */
export interface ByteStore {
  /** Queryable, honest capability declaration. A backend must not overstate it. */
  readonly capabilities: ByteStoreCapabilities;

  /**
   * Write `bytes` to the pending slot for `id`. Atomic enough that a crash
   * mid-write leaves NO partial FINAL blob — a torn pending write is fine (the
   * reaper sweeps it); a torn final write is not. Callers normalize strings to
   * Buffers before calling.
   */
  writePending(id: string, bytes: Uint8Array): void;

  /**
   * Promote the pending slot to the final slot. The durability MUST is scoped
   * by `capabilities.durability`: on a `durable` backend, after this returns
   * the bytes MUST survive a process restart (an adopted blob's final bytes are
   * the product of a committed dispatch). An `ephemeral` backend (memoryBlobs)
   * conforms structurally — atomic promotion, idempotence, readable final
   * bytes — and documents that its bytes live only in the owning process;
   * losing them at a process boundary is the declared price of `ephemeral`.
   * Idempotent: a missing pending slot (already finalized, or never uploaded)
   * is a no-op — the reaper and the post-commit finalize consumer both rely on
   * that.
   */
  finalizePending(id: string): string;

  /**
   * Return the FINAL-slot bytes in `[start, end)` as a Buffer. There is NO
   * fallback to the pending slot (S6/A4): an unclaimed blob id must never
   * serve bytes. `end` clamps to the byte length; `Infinity` (or an
   * absent/null `end`) is the accepted EOF sentinel — an open-ended range
   * reads to EOF. `start` stays strictly validated: negative / non-finite /
   * inverted bounds throw, never handed to the underlying store to misbehave
   * with. A slot with no bytes throws `BlobSlotNotFoundError` (message is
   * backend-specific — consumers branch on the type, never the text).
   */
  readRange(id: string, range?: [start?: number, end?: number]): Buffer;

  /**
   * Return the PENDING-slot bytes in `[start, end)` as a Buffer. The ONLY path
   * to pending bytes — its only caller is the pending-blob claim machinery
   * after its durable state transition selected a claimed generation. A claim
   * is the admission; there is no generic pending read. Same strict bounds as
   * readRange, and the same missing-slot signal (`BlobSlotNotFoundError`).
   */
  readPending(id: string, range?: [start?: number, end?: number]): Buffer;

  /**
   * Stream the FINAL-slot range `[start, end)` as a Node Readable, for large
   * media. Cancellable: an AbortSignal abort destroys the stream instead of
   * delivering the rest. Same strict bounds as readRange. A conforming backend
   * may serve the range as one chunk (memory) or stream it from real storage
   * (fs); the guarantee is the same bytes + cancellation.
   */
  readRangeStream(
    id: string,
    range?: [start?: number, end?: number],
    options?: { signal?: AbortSignal },
  ): Readable;

  /**
   * Stream the PENDING-slot range `[start, end)` as a Node Readable — the
   * streaming counterpart of readPending for large-media downloads in the
   * claimed window (#738 W1). Its only caller is the pending-blob claim
   * machinery after its durable state transition selected a claimed generation;
   * there is no generic pending stream. Same strict bounds as readPending; a
   * missing pending slot throws the typed `BlobSlotNotFoundError` BEFORE any
   * stream exists. Cancellable via an AbortSignal exactly like readRangeStream.
   */
  readPendingStream(
    id: string,
    range?: [start?: number, end?: number],
    options?: { signal?: AbortSignal },
  ): Readable;

  /**
   * Stream `bytes` into the pending slot WITHOUT materializing the whole
   * payload (#738 W2): chunks flow to storage under natural backpressure while
   * md5/sha256 are computed on the way past. Resolves with the attested
   * byteLength + digests of EXACTLY what landed. `maxBytes`, when given,
   * aborts MID-STREAM once exceeded (the typed `BlobTooLargeError`); every
   * chunk must be a Uint8Array (TypeError). A failed or aborted write removes
   * the torn pending slot (best-effort; residue is reaper-benign) — only a
   * COMPLETED write leaves a pending slot behind.
   */
  writePendingStream(
    id: string,
    bytes: AsyncIterable<Uint8Array>,
    options?: { maxBytes?: number },
  ): Promise<{ byteLength: number; sha256: string; md5: string }>;

  /**
   * Delete the pending (`pending: true`) or final (`pending: false`) slot.
   * Idempotent: a missing slot is a no-op (ENOENT-equivalent swallowed). Any
   * OTHER failure MUST throw — a delete-verification-capable backend never
   * reports success for an erasure that did not happen.
   */
  remove(id: string, options: { pending: boolean }): void;

  /**
   * True iff the pending / final slot has bytes. Used by the reaper to
   * reconcile (an adopted blob whose pending slot still exists needs
   * finalizing) and by tests.
   */
  exists(id: string, options: { pending: boolean }): boolean;

  /**
   * The free bytes available to this process on the backend's storage, or
   * `null` when the backend cannot declare it (S6/A5 low-disk guard). A
   * `durable` backend is expected to implement it — the upload guard refuses
   * new uploads when free space falls below the configured headroom, and
   * FAILS CLOSED when a durable backend cannot declare free space at all.
   * An `ephemeral` backend (memoryBlobs) has no disk to guard and returns
   * `null` (or omits the member).
   */
  freeBytes?(): number | null;
}

// Compiled blob-reference census (S6/A3): one deterministic registry of every
// declared blob reference, compiled at prepare time from entity declarations
// (`blob: true` fields) and action-level `declaredBlobField` declarations. It
// replaces the runtime `blobColumns` derivation for the reaper, the finalize
// consumer, backup manifests (S6/A6), and S8's blob/MediaFile classification.
// Ownership is explicit per reference — matching content hashes never merge or
// imply sharing (S6 consideration #7).
export type BlobLifecycleKind = 'pending' | 'adopt' | 'finalize';
export type BlobErasureCategory = 'deletable' | 'retained' | 'derived';
export type BlobOwnership = 'exclusive' | 'shared';
export interface BlobReference {
  table: string;
  column: string;
  owningResource: string;
  field: string;
  lifecycle: BlobLifecycleKind;
  erasureCategory: BlobErasureCategory;
  ownership: BlobOwnership;
}
export interface BlobCensus {
  references: readonly BlobReference[];
  entityReferences: readonly BlobReference[];
  byResource: ReadonlyMap<string, readonly BlobReference[]>;
  byTableColumn: ReadonlyMap<string, readonly BlobReference[]>;
}
export interface BlobCensusInput {
  entities: ReadonlyMap<string, { name: string; fields?: Readonly<Record<string, unknown>> }>;
  declaredBlobFields?: readonly BlobFieldDeclaration[];
}
export type BlobFieldDeclaration = Readonly<{
  actionName: string;
  field: string;
  resourceField: string;
  purgeActionName?: string;
  owningResource: string;
  erasureCategory: BlobErasureCategory;
  ownership?: BlobOwnership;
  lifecycle?: BlobLifecycleKind;
}>;
export function compileBlobCensus(input: BlobCensusInput): BlobCensus;
export const EMPTY_BLOB_CENSUS: BlobCensus;

export interface BlobStore {
  safeId(id: unknown): void;
  upload(options?: {
    bytes: string | Uint8Array;
    mime?: string;
    id?: string;
  }): { id: string; md5: string; sha256: string; size: number; mime: string | null };
  adopt(
    dbOrTxn: { prepare(sql: string): WorkbenchStatement },
    id: string,
  ): { adopted: number };
  finalize(id: string): string;
  readRange(id: string, range?: [start?: number, end?: number]): Buffer;
  readPending(id: string, range?: [start?: number, end?: number]): Buffer;
  readRangeStream(id: string, range?: [start?: number, end?: number], options?: { signal?: AbortSignal }): Readable;
  /**
   * Stream a PENDING-slot write WITHOUT materializing the bytes (#738 W2):
   * hash-while-write, mid-stream `maxBytes` abort (typed BlobTooLargeError),
   * no readable pending slot after a failed or aborted write. Records the
   * generation's 'pending' metadata row from the ATTESTED values — the same
   * row upload writes. The ONLY production caller is the pending-blob stager.
   */
  writePendingStream(id: string, bytes: AsyncIterable<Uint8Array>, options?: { maxBytes?: number; mime?: string }): Promise<{ byteLength: number; sha256: string; md5: string }>;
  readPendingStream(id: string, range?: [start?: number, end?: number], options?: { signal?: AbortSignal }): Readable;
  discardPending(id: string): void;
  discard(id: string): void;
  /**
   * Generation replacement (S6/A5): stage NEW bytes for an existing adopted
   * generation, validate the previous generation (exists, adopted, readable),
   * then switch atomically via switchReplacement in the caller's coordinated
   * turn. A failure at any point (stage, validation, adopt, or switch) leaves
   * the old generation readable and authoritative.
   */
  replace(
    previousId: string,
    options: { bytes: string | Uint8Array; mime?: string; id?: string },
  ): { id: string; previousId: string; md5: string; sha256: string; size: number; mime: string | null };
  /**
   * Atomically switch the generation inside the CALLER'S transaction: the
   * replacement generation is adopted (pending → adopted) AND the previous
   * generation is marked 'replaced' (replacement + switch instant recorded).
   * A failed switch throws and rolls back, leaving the old generation
   * authoritative.
   *
   * OWNING-REFERENCE INVARIANT: the switch pair AND the caller's UPDATE of the
   * owning reference to the new generation id MUST share this same coordinated
   * transaction — all three commit together or roll back together.
   */
  switchReplacement(
    dbOrTxn: { prepare(sql: string): WorkbenchStatement },
    previousId: string,
    newId: string,
  ): { adopted: number; replaced: number };
  reap(options: {
    ttl: number;
    /** Compiled blob-reference census (S6/A3) — the refcount sweep's ONLY column source. */
    census: BlobCensus;
    /**
     * Replaced-generation retention in ms (named policy 'replaced-generation',
     * S6/A5). A replaced generation is reclaimed only when unreferenced AND
     * this retention window has elapsed. Absent/0 → replaced rows are never
     * reaped by this sweep (fail closed).
     */
    replacedRetentionMs?: number;
    /** S1/A6 recycle seam: routes replaced/dangling generations to the recycling bin before live bytes are removed. */
    recycle?: { bin(deletion: { generations: readonly string[] }): Promise<unknown> };
  }): Promise<{ orphans: number; danglers: number }>;
  stat(
    id: string,
  ):
    | {
        id: string;
        status: string;
        md5: string;
        sha256: string;
        size: number;
        mime: string | null;
        createdAt: string;
        /** The generation id that replaced this generation (status 'replaced'). */
        replacedBy?: string | null;
        /** ISO instant the owning reference switched to the replacement generation. */
        replacedAt?: string | null;
        /** Durable cleanup state: last failure message while removing this generation's bytes. */
        cleanupError?: string | null;
        /** Durable cleanup state: how many byte-removal attempts failed so far. */
        cleanupAttempts?: number;
      }
    | undefined;
  /** Durable cleanup state for one generation (S6/A5), or undefined when the row is gone / never failed. */
  cleanupState(id: string): BlobCleanupState | undefined;
  /** Ids currently carrying durable cleanup state (a failed byte deletion awaiting retry). */
  pendingCleanups(): readonly string[];
  /**
   * TEST/DEBUG-ONLY introspection was RETIRED from the portable surface (S6/A2):
   * no code path may use a physical filesystem path to authorize, read, or
   * locate bytes. The concrete fs/memory byte-store objects still expose a
   * `pathFor` test handle at the `src/fs-blobs.ts` / `src/memory-blobs.ts`
   * boundary only.
   */
  readonly capabilities: ByteStoreCapabilities;
}

/**
 * Durable cleanup state for one generation (S6/A5): a failed byte deletion is
 * recorded on the row (cleanupError/cleanupAttempts) and retried by the next
 * sweep; cleanup is never reported complete until pending + final slots and the
 * metadata row are verified gone.
 */
export interface BlobCleanupState {
  id: string;
  status: string;
  replacedBy: string | null;
  replacedAt: string | null;
  cleanupError: string | null;
  cleanupAttempts: number;
}

// ---------------------------------------------------------------------------
// Email seam
// ---------------------------------------------------------------------------

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export type EmailTransport = (msg: EmailMessage) => Promise<void>;

export interface EmailSeam {
  install(app: { _emailConsumer?: unknown }): void;
  consumer(
    events: unknown[],
    context: { db: WorkbenchDatabase },
  ): Promise<void>;
  send(
    app: {
      jobs?: {
        enqueue: (job: {
          id: string;
          kind: string;
          payload: unknown;
        }) => unknown;
      };
    },
    msg: EmailMessage,
  ): void;
  transport: EmailTransport;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

export const SESSION_COOKIE: 'sid';

export function parseCookies(header?: string | null): Record<string, string>;

export function sessionCookie(
  token: string,
  options?: { secure?: boolean; env?: string },
): string;

export function sessionTokenOf(req: {
  headers?: { cookie?: string };
}): string | undefined;

export function sessionPrincipalOf(
  db: WorkbenchDatabase,
  options?: { durationMs?: number; now?: () => number },
): (req: { headers?: { cookie?: string } }) => Principal;

export function apiKeyPrincipalOf(
  db: WorkbenchDatabase,
): (req: { headers?: { authorization?: string } }) => Principal;

// ---------------------------------------------------------------------------
// Invitation helpers
// ---------------------------------------------------------------------------

export interface Invitation {
  id: string;
  token: string;
  targetEntity: string;
  targetId: string;
  role: string;
  targetUser: string | null;
  maxUses: number | null;
  useCount: number;
  expiresAt: number | null;
  createdBy: string;
  createdAt: unknown;
}

export interface InvitationApi {
  createInvitation(params: {
    targetEntity: string;
    targetId: string;
    role: string;
    principal: UserPrincipal;
    targetUser?: string;
    maxUses?: number;
    expiresAt?: number;
  }): Promise<Invitation>;
  acceptInvitation(token: string, user: UserPrincipal): Promise<{
    targetEntity: string;
    targetId: string;
    role: string;
  }>;
  rejectInvitation(token: string, user: UserPrincipal): Promise<void>;
  listInvitationsForUser(user: UserPrincipal): Invitation[];
}

export function createInvitationApi(options: {
  db?: WorkbenchDatabase;
  Invitation: BoundWorkbenchEntity<Invitation>;
}): InvitationApi;

// ---------------------------------------------------------------------------
// SQLite schema declaration
// ---------------------------------------------------------------------------

export interface ColumnDeclaration {
  name: string;
  type: 'text' | 'integer' | 'real' | 'blob';
  primaryKey?: boolean;
  notNull?: boolean;
  default?: string | number;
  defaultExpression?: 'CURRENT_DATE' | 'CURRENT_TIME' | 'CURRENT_TIMESTAMP' | "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";
  /** Column collation (e.g. `NOCASE`). */
  collation?: string;
  /** Raw CHECK expression for the column. */
  check?: string;
}

export interface ForeignKeyDeclaration {
  columns: readonly string[];
  references: { table: string; columns: readonly string[] };
  onDelete?: 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action';
  onUpdate?: 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action';
}

export interface UniqueConstraintDeclaration {
  /** Optional name; named unique constraints occupy SQLite's index namespace. */
  name?: string;
  columns: readonly string[];
}

export interface CheckConstraintDeclaration {
  name?: string;
  /** Raw CHECK expression. */
  expression: string;
}

export interface IndexDeclaration {
  name: string;
  /** Column terms. Optional when `expression` terms are declared instead. */
  columns?: readonly string[];
  /** Raw expression terms (e.g. `lower("title")`), emitted after column terms. */
  expression?: readonly string[];
  unique?: boolean;
  /** Partial-index predicate (raw boolean expression). */
  where?: string;
}

export interface TriggerDeclaration {
  name: string;
  timing: 'before' | 'after' | 'instead of';
  event: 'insert' | 'update' | 'delete';
  /** `UPDATE OF` column list — only valid for `event: 'update'`. */
  columnNames?: readonly string[];
  /** Raw WHEN predicate; `NEW.`/`OLD.` references must resolve to declared columns. */
  when?: string;
  /** Raw semicolon-terminated statements inside `BEGIN … END`. */
  body: string;
}

export interface VirtualTableDeclaration {
  name: string;
  /** Only `fts5` is available in this cut; other modules are rejected. */
  module: 'fts5';
  /** Raw module arguments, e.g. `title`, `content='articles'`, `tokenize='porter'`. */
  options: readonly string[];
  ownerPluginId: string;
  /** Shadow tables (e.g. FTS `_data`/`_idx`) this plugin owns — attributed in the census. */
  shadowTables: readonly string[];
}

export interface TableDeclaration {
  name: string;
  columns: readonly ColumnDeclaration[];
  foreignKeys?: readonly ForeignKeyDeclaration[];
  indexes?: readonly IndexDeclaration[];
  primaryKey?: readonly string[];
  /** Table-level UNIQUE constraints. */
  unique?: readonly UniqueConstraintDeclaration[];
  /** Table-level CHECK constraints. */
  check?: readonly CheckConstraintDeclaration[];
  /** Emit the STRICT table policy. */
  strict?: boolean;
  /** Emit WITHOUT ROWID; requires a declared primary key. */
  withoutRowid?: boolean;
  /** Declared triggers — compiled to DDL but never created at prepare time. */
  triggers?: readonly TriggerDeclaration[];
}

export interface NamespacedMigration extends Migration {}

export interface SqliteSchemaResult {
  readonly name: string;
  readonly tableNames: readonly string[];
  /** Immutable declarations used to verify schema-owned entity tables at startup. */
  readonly tables: readonly Readonly<TableDeclaration>[];
  /** Tables supplied outside this schema's lifecycle, used for startup census validation. */
  readonly externalTables: readonly { readonly name: string; readonly columns: readonly string[] }[];
  /** Triggers supplied outside this schema's lifecycle, used for startup census validation. */
  readonly externalTriggers: readonly { readonly name: string }[];
  readonly virtualTables: readonly Readonly<VirtualTableDeclaration>[];
  readonly triggers: readonly Readonly<TriggerDeclaration>[];
  readonly migrations: readonly NamespacedMigration[];
  /** Executed by `prepare`: CREATE TABLE / CREATE INDEX (IF NOT EXISTS). */
  readonly ddl: readonly string[];
  /** Plugin-owned virtual tables — compiled but NOT executed by `prepare`. */
  readonly virtualTableDdl: readonly string[];
  /** Declared triggers — compiled but NEVER created/dropped by `prepare`. */
  readonly triggerDdl: readonly string[];
  prepare(db: WorkbenchDatabase, options?: { skipMigrations?: boolean; skipIndexes?: boolean; now?: () => string }): void;
}

export function defineSqliteSchema(spec: {
  name: string;
  externalTables?: readonly { name: string; columns: readonly string[] }[];
  externalTriggers?: readonly { name: string }[];
  virtualTables?: readonly VirtualTableDeclaration[];
  tables: readonly TableDeclaration[];
  migrations?: readonly NamespacedMigration[];
}): SqliteSchemaResult;

export interface SqliteStorageColumnDescription {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly defaultValue: string | null;
  readonly primaryKeyPosition: number;
  readonly hidden: number;
}

export interface SqliteStorageIndexDescription {
  readonly name: string;
  readonly unique: boolean;
  readonly origin: string;
  readonly partial: boolean;
  readonly sql: string | null;
  readonly columns: readonly (string | null)[];
  readonly terms: readonly {
    readonly sequence: number;
    readonly columnId: number;
    readonly name: string | null;
    readonly descending: boolean;
    readonly collation: string | null;
    readonly key: true;
  }[];
}

export interface SqliteStorageForeignKeyDescription {
  readonly table: string;
  readonly columns: readonly string[];
  readonly referencedColumns: readonly (string | null)[];
  readonly onUpdate: string;
  readonly onDelete: string;
  readonly match: string;
}

export interface SqliteStorageTableDescription {
  readonly name: string;
  readonly sql: string;
  readonly virtual: boolean;
  readonly withoutRowid: boolean;
  readonly strict: boolean;
  readonly columns: readonly SqliteStorageColumnDescription[];
  readonly primaryKey: readonly string[];
  readonly foreignKeys: readonly SqliteStorageForeignKeyDescription[];
  readonly indexes: readonly SqliteStorageIndexDescription[];
}

export interface SqliteStorageDescription {
  readonly tableNames: readonly string[];
  readonly tables: readonly SqliteStorageTableDescription[];
}

export function describeSqliteStorage(
  db: WorkbenchDatabase,
  tableNames: readonly string[],
): SqliteStorageDescription;

export function describeEntityStorage(
  entity: Pick<WorkbenchEntity<Record<string, unknown>>, 'name' | 'fields'>,
): SqliteStorageDescription;

// ---------------------------------------------------------------------------
// Route / static helpers
// ---------------------------------------------------------------------------

export function matchRoute(
  routes: Array<{ method: string; path: string; handler?: Handler }>,
  method: string,
  pathname: string,
):
  | { route: { method: string; path: string; handler?: Handler }; params: Record<string, string> }
  | { route: null; params: null; pathMatched: boolean };

export interface ServeStaticOptions {
  prefix?: string;
  /** Refuse to serve files the predicate marks as adapter-owned (fail closed). */
  isManagedPath?: (resolvedPath: string) => boolean;
  /**
   * Cache-Control policies keyed by request path: exact path ('/index.html'),
   * path prefix ('/assets/'), or extension ('.svg'). Most-specific match wins;
   * unmatched paths get no cache header.
   */
  cacheControl?: Record<string, string>;
  /**
   * Serve precompressed `.br`/`.gz` siblings when Accept-Encoding admits them
   * (identity unless explicitly excluded; 406 only when nothing is acceptable).
   * Every 200 and any 406 carry `Vary` merged with any prior value.
   */
  precompressed?: boolean;
}

export function serveStatic(
  dir: string,
  options?: ServeStaticOptions,
): Handler;

// ---------------------------------------------------------------------------
// Job queue
// ---------------------------------------------------------------------------

interface ClockSpec {
  name: string;
  intervalMs: number;
  fn: () => void;
}

interface ClockHandle {
  remove(): void;
}

interface Clock {
  add(spec: ClockSpec): ClockHandle;
}

export interface JobQueue {
  registerWorker(presentedSecret: string): { workerId: string; token: string } | null;
  authenticate(bearer: string): string | null;
  enqueue(job: {
    kind: string;
    payload?: unknown;
    id?: string;
    scope?: string;
    // Optional machine attribution (S5/A5): the attributable machine principal
    // this job runs under. Must be a machinePrincipal; anything else throws.
    principal?: import('../index.d.ts').MachinePrincipal;
  }): JobRow;
  claim(workerId: string, options?: { kind?: string; scope?: string }): JobRow | null;
  heartbeat(jobId: string, workerId: string, options?: { now?: () => number }): boolean;
  submitResult(
    jobId: string,
    workerId: string,
    result: { status: 'completed' | 'failed'; output?: unknown },
  ): SubmitResultOk | { accepted: false };
  updateProgress(options: {
    jobId: string;
    workerId: string;
    progress: number;
    stage?: string;
  }): JobRow | null;
  cancelJob(options: { jobId: string; workerId?: string }): CancelJobResult;
  reap(options?: { now?: () => number }): {
    reassigned: number;
    deadLettered: number;
    revoked: number;
  };
  startReaper(): void;
  stop(): void;
  work(
    kind: string,
    fn: (job: JobRow) => unknown | Promise<unknown>,
    options: {
      // S5/A5: the attributable machine principal the worker runs under.
      principal: import('../index.d.ts').MachinePrincipal;
      // The handler/context allowlist: the operations this handler performs.
      // Dispatch validates the executing principal against it and denies on
      // mismatch (fail closed — the fn is never invoked).
      operations: readonly string[];
      pollIntervalMs?: number;
    },
  ): {
    once: () => Promise<{
      job: JobRow;
      result: SubmitResultOk | { accepted: false };
      // Present on a fail-closed denial: the operation the executing principal
      // was not granted (fn was never invoked).
      denied?: string;
    } | null>;
    stop: () => void;
    workerId: string;
  };
  onEvent(
    fn: (event: {
      type: string;
      scope: string | null;
      seq: number;
      data: unknown;
      actionId: string;
      committedAt: string;
    }) => void,
  ): () => void;
  list(options?: {
    scope?: string;
    kind?: string;
    status?: string;
    limit?: number;
  }): JobRow[];
}

export function createJobQueue(options: {
  db: WorkbenchDatabase;
  sharedSecret: string;
  leaseMs?: number;
  heartbeatGraceMs?: number;
  reapIntervalMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  clock?: Clock;
}): JobQueue;

// ---------------------------------------------------------------------------
// Blob store factory
// ---------------------------------------------------------------------------

export function createBlobStore(options: {
  /**
   * Explicit byte root (back-compat `blobs: { root }`), refused on overlap with
   * the owned directory. When omitted and the store is built through
   * `workbench()`, a file-mode app's byte store roots under the owned
   * directory's managed `blobs/` (pending slots in `staging/`) — inside the
   * owned directory when one exists, beside the db file otherwise; a relative
   * database path makes that owned directory cwd-relative (S6/A2 relocation) —
   * and a memory database uses the in-memory fake byte store (S6/A1).
   */
  root?: string;
  db: WorkbenchDatabase;
  bytes?: ByteStore;
  /**
   * Low-disk guard (S6/A5): the minimum free bytes a durable byte store must
   * declare before a new upload is accepted. 0 (the store-level default)
   * disables the guard here — the application's `maintenanceDefaults` policy
   * supplies the real headroom. Fail-closed: a durable byte store that cannot
   * declare free space refuses uploads.
   */
  lowDiskHeadroomBytes?: number;
}): BlobStore;

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export function runMigrations(
  db: WorkbenchDatabase,
  migrations?: Migration[],
  options?: { now?: () => string; suppliedBy?: string },
): void;

// ---------------------------------------------------------------------------
// Committed log reads
// ---------------------------------------------------------------------------

export function readCommittedCursor(
  db: WorkbenchDatabase,
  scope: string,
): number;

export type LiveDeliveryEnvelope =
  | {
      readonly type: 'event';
      readonly entity: string;
      readonly id: string;
      readonly seq: number;
      readonly seqSpan: readonly [number, number];
      readonly event: {
        readonly type: string;
        readonly scope: string;
        readonly seq: number;
      readonly actionId: string;
      readonly committedAt: string;
        readonly data: Readonly<Record<string, unknown>>;
      };
    }
  | {
      readonly type: 'resync';
      readonly entity: string;
      readonly id: string;
      readonly seq: number;
      readonly reason: 'recipient-snapshot-required' | 'annotated-text-snapshot-required';
    }
  | {
      // S3/A7: replacement projection for a live resource. `seq` is the live
      // revision. A live row carries the projected declared-field view under
      // `state`; a live collection carries its bounded membership replacement
      // (additions/removals/reorderings/rows).
      readonly type: 'state';
      readonly entity: string;
      readonly id: string;
      readonly seq: number;
      readonly state?: Readonly<Record<string, unknown>>;
      readonly authoring?: Readonly<Record<string, unknown>>;
      readonly additions?: readonly Record<string, unknown>[];
      readonly removals?: readonly string[];
      readonly reorderings?: readonly { id: string; from: number; to: number }[];
      readonly rows?: readonly Record<string, unknown>[];
    }
  | {
      // S3/A7: bounded-overflow / resnapshot-required boundary for a live
      // resource. The client must resnapshot/refresh instead of trusting its
      // cached state. A bounded collection's truncated membership view is
      // carried (informational) but never reconciles by itself.
      readonly type: 'state-invalidate';
      readonly entity: string;
      readonly id: string;
      readonly seq: number;
      readonly reason: string;
      readonly additions?: readonly Record<string, unknown>[];
      readonly removals?: readonly string[];
      readonly reorderings?: readonly { id: string; from: number; to: number }[];
      readonly rows?: readonly Record<string, unknown>[];
    }
  | {
      // S3/A7: a derived/operational notification. NEVER authoritative — clients
      // must reject it as a domain mutation and never reconcile optimistic state
      // from it.
      readonly type: 'notification';
      readonly kind: string;
      readonly seq?: number;
    };

export interface LiveDeliverySubscription {
  readonly principal: Principal;
  readonly scope: string;
  readonly after?: LiveDeliveryCursor;
  readonly signal: AbortSignal;
  readonly deliver: (batch: readonly LiveDeliveryEnvelope[]) => void | Promise<void>;
  readonly revoke?: (reason?: unknown) => void;
}

export interface LiveDeliveryActivation {
  activate(): Promise<LiveDeliveryCursor | undefined>;
}

export type LiveDeliveryCursor = number | Readonly<{ anchor: number; aggregate: number }>;

export type LiveDeliveryBootstrap<Snapshot = unknown> =
  | { readonly kind: 'snapshot'; readonly snapshot: Snapshot; readonly cursor: LiveDeliveryCursor }
  | { readonly kind: 'revoked'; readonly reason?: unknown }
  | { readonly kind: 'retry'; readonly reason?: LiveRetryReason };

export type LiveDeliveryCatchup =
  | {
      readonly kind: 'catchup';
      readonly envelopes: readonly LiveDeliveryEnvelope[];
    readonly cursor: LiveDeliveryCursor;
  }
  | { readonly kind: 'snapshot'; readonly snapshot: unknown; readonly cursor: LiveDeliveryCursor }
  | { readonly kind: 'revoked'; readonly reason?: unknown }
  | { readonly kind: 'retry'; readonly reason?: LiveRetryReason };

/**
 * Additive machine-readable diagnostics on bootstrap-path retries (#815).
 * Clients treat it as opaque; retry semantics are unchanged.
 */
export type LiveRetryReason = 'cursor-moved' | 'fence-mismatch' | 'lease-budget-exhausted' | 'snapshot-contention';

export interface LiveDeliveryEntity {
  readonly name: string;
  readonly fields: Readonly<Record<string, unknown>>;
  scopeFilter(principal: Principal): { sql: string; params: Readonly<Record<string, unknown>> };
  hydrate?(raw: unknown, principal: Principal): Record<string, unknown> | null | undefined;
}

export interface LiveDeliverySnapshot { readonly kind: 'snapshot'; readonly anchor: LiveDeliveryEntity; readonly output: object; }

export interface LiveDelivery {
  bootstrap(input: {
    readonly principal: Principal;
    readonly scope: string;
  }): Promise<LiveDeliveryBootstrap>;
  catchup(input: {
    readonly principal: Principal;
    readonly scope: string;
    readonly after: LiveDeliveryCursor;
  }): Promise<LiveDeliveryCatchup>;
  subscribe(input: LiveDeliverySubscription): Promise<LiveDeliveryActivation>;
  wake(scope: string): void;
}

export function createLiveDelivery(options: {
  db: WorkbenchDatabase;
  entities: ReadonlyMap<string, LiveDeliveryEntity> | ((name: string) => LiveDeliveryEntity | undefined);
  mayVerb: (entity: LiveDeliveryEntity, verb: 'subscribe', row: Record<string, unknown>, principal: Principal) => boolean | Promise<boolean>;
  /** The injected authorization adapter — THE admission path for subscription admission and re-authorization when provided. */
  authorization?: import('../index.d.ts').AuthorizationAdapter;
  /** Package-owned constrained relational snapshot declarations. */
  snapshots?: readonly LiveDeliverySnapshot[];
  log?: { error?: (channel: string, message: string, context?: Record<string, unknown>) => void } | null;
  maxCatchupEvents?: number;
}): LiveDelivery;

export function createLiveDeliveryHttpHandler(options: {
  delivery: LiveDelivery;
  principalOf(request: import('node:http').IncomingMessage): Principal | Promise<Principal>;
  path?: string;
  maxSubscriptions?: number;
}): (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Email seam factory
// ---------------------------------------------------------------------------

export function emailSeam(options?: {
  transport?: EmailTransport;
}): EmailSeam;

export const noopTransport: EmailTransport;

// ---------------------------------------------------------------------------
// History-read façade
// ---------------------------------------------------------------------------

export type RecipientProjectedEvent = Readonly<Record<string, unknown>>;

export interface ReadCommittedHistoryOptions {
  scope: string;
  principal: Principal;
  sinceSeq?: number;
  limit?: number;
}

export interface ReadCommittedHistoryResult {
  events: readonly RecipientProjectedEvent[];
  hasMore: boolean;
}

export interface ReceiptMetadata {
  scope: string;
  actionId: string;
  committedAt: string;
  eventRefs: readonly { scope: string; seq: number }[];
  actionType: string | null;
  operation: string;
}

export interface HistoryReader {
  readCommittedHistory(options: ReadCommittedHistoryOptions): Promise<ReadCommittedHistoryResult>;
  readReceipt(options: { scope: string; actionId: string; principal: Principal }): Promise<ReceiptMetadata | null>;
}

export type ProjectRecipientContext = Readonly<{
  entity: LiveDeliveryEntity;
  event: Readonly<Record<string, unknown>>;
  principal: Principal;
  row: Record<string, unknown>;
  scope: string;
}>;

export type ProjectRecipient = (context: ProjectRecipientContext) => readonly RecipientProjectedEvent[];

export type ScopeVisibleCheck = (context: Readonly<{
  entity: LiveDeliveryEntity;
  principal: Principal;
  scope: Readonly<{ entity: string; id: string }>;
}>) => boolean;

export function createHistoryReader(options: {
  db: WorkbenchDatabase;
  entities: ReadonlyMap<string, LiveDeliveryEntity> | ((name: string) => LiveDeliveryEntity | undefined);
  /** Defaults to the framework row-grant engine (same engine REST and live delivery use). */
  mayVerb?: (entity: LiveDeliveryEntity, verb: string, row: Record<string, unknown>, principal: Principal) => boolean | Promise<boolean>;
  /** Declaration-derived annotated scope set (rev 3 §3); denies actions()/events() only. */
  privateHistoryScopes?: ReadonlySet<string> | null;
  /** Required to read committed history; optional for receipt reads only. */
  projectRecipient?: ProjectRecipient;
  scopeVisible?: ScopeVisibleCheck;
}): HistoryReader;
