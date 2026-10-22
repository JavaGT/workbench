// Public, transport-neutral committed delivery. The package owns reread,
// authorization, projection, and cursor semantics; adapters only deliver the
// recipient-safe batch and acknowledge it by resolving their callback.

import { classifyLiveScope, createLiveDeliveryCore } from './live-delivery-core.ts';
import type { CoreProjectContext, LiveDeliveryCore } from './live-delivery-core.ts';
import { createLiveEnvelopeBuilder } from './live-delivery-envelope.ts';
import { tryBuildAnnotatedTextFoldEnvelopes } from './annotated-text-fold-envelope.ts';
import { normalizeOperatedEvent } from './annotated-text-operated-event.ts';
import { projectAnnotatedTextSnapshot } from './annotated-text-snapshot.ts';
import { authoringRedactionsForRecipient } from './annotated-text-recipient-projection.ts';
import { tryParseScopeKey } from './scope-handle.ts';
import type { ScopeHandle } from './scope-handle.ts';
import { readSeq } from './committed-log.ts';
import { invalidationRecovery } from './invalidation-ledger.ts';
import { readSnapshotTxn } from './driver.ts';
import { compileSnapshots, captureSnapshot, authorizeSnapshot, projectSnapshot } from './snapshot-projection.ts';
import { compilePatchPlans } from './composite-patch-plan.ts';
import type { AnchorPatchPlan } from './composite-patch-plan.ts';
import { createCompositePatchDelivery, parseRequestedCapabilities, SNAPSHOT_PATCH_CAPABILITY } from './composite-patch-delivery.ts';
import { hasAnnotatedTextFields, projectEntitySnapshot } from './entity-snapshot-projection.ts';
import { resolveAnnotatedTextOwningScope } from './annotated-text-field.ts';
import { rawRow } from './entity/query.ts';
import { projectRowForRecipient } from './entity/projection.ts';
import { mayReadField, readableFieldNames } from './field-admission.ts';
import { mayRow } from './row-grant.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import { ensureStream, ensureLease, hashClientNonce, resolveStream, resolveLease, acknowledgeAndPruneSnapshot, countLiveLeases, AUTHORING_STREAM_LIMITS } from './annotated-text-authoring-stream.ts';
import { createPrincipalSnapshotDelivery, isPrincipalSnapshotScope, validatePrincipalSnapshotDeclarations } from './principal-snapshot-delivery.ts';
import type { PrincipalSnapshotAuthorize } from './principal-snapshot-delivery.ts';
import type { Principal } from './principal.ts';
import type { FrameworkLog } from './log.ts';
import type { LiveDatabase, LiveEntityRecord, MayVerb, FieldDescriptor } from './live-fanout.ts';
import type { CompiledSubscriptionRule, SubscriptionRule } from './subscription-rule.ts';

function jsonSnapshot(value: unknown, path = 'snapshot', ancestors = new Set<unknown>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`${path} must not contain cycles`);
    ancestors.add(value);
    const copy = value.map((entry, index) => jsonSnapshot(entry, `${path}[${index}]`, ancestors));
    ancestors.delete(value);
    return Object.freeze(copy);
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${path} must be a JSON value`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain cycles`);
  ancestors.add(value);
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = jsonSnapshot(entry, `${path}.${key}`, ancestors);
  ancestors.delete(value);
  return Object.freeze(copy);
}

// ---------------------------------------------------------------------------
// Package-private shared delivery shapes
// ---------------------------------------------------------------------------

export interface LiveCommittedEvent extends Record<string, unknown> {
  scope?: string;
  eventType?: string;
  type?: string;
  data?: Record<string, unknown>;
  seq?: number;
  actionId?: string;
  committedAt?: string;
}

export interface SnapshotEntry {
  kind?: string;
  entity?: LiveEntityRecord;
  selected?: readonly string[];
  fields?: readonly string[];
  nested?: SnapshotBranch | null;
  [key: string]: unknown;
}

export interface SnapshotBranch {
  entries: ReadonlyArray<SnapshotEntry>;
}

export interface SnapshotTombstone {
  entity?: LiveEntityRecord;
  terminalScope?: LiveEntityRecord | null;
  target?: LiveEntityRecord;
  [key: string]: unknown;
}

export interface SnapshotDeclaration {
  anchor: LiveEntityRecord;
  output: SnapshotBranch;
  tombstone?: SnapshotTombstone | null;
  tombstones?: readonly SnapshotTombstone[];
  [key: string]: unknown;
}

export type CompiledSnapshots = Map<string, SnapshotDeclaration> & { requiredEntities?: Set<string> };

export interface SnapshotResyncRelevance {
  relevantFields: Map<string, Set<string>>;
  alwaysRelevant: Set<string>;
}

export interface AnnotatedTextDocument {
  scope: string;
  entity: LiveEntityRecord;
  documentId: string;
  fieldName: string;
  descriptor: FieldDescriptor | null | undefined;
  clientNonce?: string | null;
  row?: unknown;
}

export type PublicCursor = number | Readonly<{ anchor: number; aggregate: number }> | Readonly<{ anchor: number; composite: number }>;

export type PublicBootstrapResult =
  | { kind: 'snapshot'; snapshot: unknown; cursor: PublicCursor; authoring?: unknown; projectionToken?: string; protocol?: typeof SNAPSHOT_PATCH_CAPABILITY }
  | { kind: 'revoked' }
  // `reason` is additive diagnostics (#815): a machine-readable label for why
  // the attempt could not produce a snapshot ('cursor-moved',
  // 'fence-mismatch', 'lease-budget-exhausted', 'snapshot-contention').
  // Clients treat it as opaque; the retry semantics are unchanged.
  | { kind: 'retry'; reason?: PublicBootstrapRetryReason };

export type PublicCatchupResult =
  | { kind: 'catchup'; envelopes: unknown[]; cursor: PublicCursor }
  | { kind: 'revoked' }
  | { kind: 'snapshot'; snapshot: unknown; cursor: PublicCursor; authoring?: unknown }
  | { kind: 'retry'; reason?: PublicBootstrapRetryReason };

// Closed diagnostic vocabulary for bootstrap-path retry results (#815).
// Additive and client-opaque: existing clients ignore it, new clients can
// distinguish transient cursor churn from a wedged authoring stream.
export type PublicBootstrapRetryReason =
  | 'cursor-moved'
  | 'fence-mismatch'
  | 'lease-budget-exhausted'
  | 'snapshot-contention';

export interface PublicActivation {
  activate(): Promise<PublicCursor | undefined>;
}

export interface PublicSubscribeInput {
  principal: Principal;
  scope: string;
  after?: PublicCursor;
  signal: AbortSignal;
  deliver: (batch: readonly unknown[]) => void | Promise<void>;
  revoke?: () => void;
  document?: AnnotatedTextDocument | null;
  paused?: boolean;
  // Collection subscriptions carry their declarative rule; the shared core
  // requires it for a collection scope and compiles it at registration.
  rule?: SubscriptionRule | CompiledSubscriptionRule;
  // Protocol negotiation (#122 design §12). Unadvertised capability support:
  // servers ACCEPT 'snapshot-patch/v1' but never require or advertise it.
  // Absent/unknown capabilities keep the exact legacy snapshot-only behavior.
  capabilities?: readonly string[];
  /** Opaque projection-token ledger handle from a previous bootstrap/patch. */
  projectionToken?: string;
}

export interface OwnedLiveDelivery {
  resolveAnnotatedTextDocument(identity: { entity: string; field: string; documentId: string }): AnnotatedTextDocument | null;
  authorizeAnnotatedTextDocument(document: AnnotatedTextDocument, principal: Principal): Promise<Record<string, unknown> | null>;
  subscribe(input: PublicSubscribeInput): Promise<PublicActivation>;
    bootstrap(input: { principal: Principal; scope: string; document?: AnnotatedTextDocument | null; capabilities?: readonly string[] }): Promise<PublicBootstrapResult>;
  catchup(input: { principal: Principal; scope: string; after?: PublicCursor; document?: AnnotatedTextDocument | null; capabilities?: readonly string[]; projectionToken?: string }): Promise<PublicCatchupResult>;
  wake(scope: string): void;
  acknowledgeAuthoringSnapshot(input: { document: AnnotatedTextDocument; principal: Principal; stream: string; lease: string; snapshot: string }): Promise<{ acknowledgedThrough: number } | null>;
}

export interface OwnedLiveDeliveryOptions {
  db: LiveDatabase;
  entities: Map<string, LiveEntityRecord> | ((name: string) => LiveEntityRecord | undefined);
  mayVerb: MayVerb;
  authorization?: AuthorizationAdapter | null;
  snapshots?: unknown;
  principalSnapshots?: unknown;
  // Host reauthorization for principal snapshots (see
  // PrincipalSnapshotAuthorize). Principal snapshots have no row scope to
  // admit against, so this is a distinct seam from the entity `authorization`
  // adapter; the app supplies a membership-aware implementation and every
  // access fails closed without one.
  principalSnapshotAuthorize?: PrincipalSnapshotAuthorize | null;
  schema?: unknown;
  log?: FrameworkLog | null;
  maxCatchupEvents?: number;
  includeActionId?: boolean;
}

// Package-private assembly for an application-owned activation. The public
// factory below deliberately returns only the delivery protocol; application
// lifecycle wiring retains the committed consumer, the shared core (which the
// WebSocket transport presents over the same authority), and shutdown.
export function createOwnedLiveDelivery({ db, entities, mayVerb, authorization, snapshots, principalSnapshots, principalSnapshotAuthorize, schema, log = null, maxCatchupEvents = 1000, includeActionId = true }: OwnedLiveDeliveryOptions): { delivery: OwnedLiveDelivery; consumer: (events: readonly LiveCommittedEvent[]) => Promise<void>; close: () => void; core: LiveDeliveryCore; patchPlans: ReadonlyMap<string, AnchorPatchPlan> } {
  if (!Number.isSafeInteger(maxCatchupEvents) || maxCatchupEvents < 1) throw new TypeError('maxCatchupEvents must be a positive safe integer');
  const resolveEntity = typeof entities === 'function' ? entities : (name: string) => entities.get(name);
  const composites = compileSnapshots(snapshots, resolveEntity, db as never) as unknown as CompiledSnapshots;
  // Composite patch plans derive from the SAME compiled declarations (#122):
  // one structural source for snapshot capture, resync relevance, and patch
  // projection. Exposed package-internally so the delivery lane and the commit
  // pipeline's journal router share this exact map.
  const patchPlans = compilePatchPlans(composites as unknown as Map<string, never>);
  validatePrincipalSnapshotDeclarations(principalSnapshots as never, schema as never);
  const principalDelivery = (principalSnapshots as readonly unknown[] | undefined)?.length
    ? createPrincipalSnapshotDelivery({ db: db as never, declarations: principalSnapshots as never, authorize: principalSnapshotAuthorize })
    : null;
  const requiredEntities = composites.requiredEntities ?? new Set();
  // Composite patch lane (#122): derived from the SAME compiled declarations.
  // Null without snapshots; engages only for callers presenting the
  // unadvertised snapshot-patch capability (rollout step 1).
  const patchDelivery = createCompositePatchDelivery({
    db: db as never,
    composites: composites as never,
    mayVerb,
    authorization,
    includeActionId,
  });

  // A composite snapshot output reads a bounded set of member fields. Resync is
  // only warranted when a committed event can change one of those fields (or the
  // anchor / tombstone identity itself). Without this, EVERY member event in the
  // scope — including annotated-text body edits that touch no selected field —
  // forces a full composite re-bootstrap.
  const resyncRelevance = buildSnapshotResyncRelevance(composites);
  function eventTouchesComposite(declaration: SnapshotDeclaration, event: LiveCommittedEvent): boolean {
    return snapshotEventTouchesComposite(resyncRelevance, declaration, event);
  }

  const aggregateRevision = (): number => Number(db.prepare("SELECT revision FROM _CommittedRevision WHERE name = 'actions'").get()!.revision);
  // The one subscribe-row admission for this app-integrated seam (S5/A2): an
  // injected adapter is THE authority for both subscribe-time admission and
  // re-authorization; without one the framework mayVerb engine runs, unchanged.
  async function admitSubscribeRow(entity: LiveEntityRecord, row: unknown, principal: Principal): Promise<boolean> {
    if (authorization) {
      const decision = await authorization.admit({
        category: 'entity',
        verb: 'subscribe',
        operation: 'subscribe',
        principal,
        entity: entity as never,
        row,
        resourceId: (row as { id?: unknown } | null | undefined)?.id as string | null | undefined,
      });
      return decision.admitted;
    }
    return mayRow(entity as never, 'subscribe', row, principal, mayVerb as never);
  }
  async function aggregateSnapshot({ principal, scope, declaration, patchCapable = false }: { principal: Principal; scope: string; declaration: SnapshotDeclaration; patchCapable?: boolean }): Promise<PublicBootstrapResult> {
    const handle = tryParseScopeKey(scope);
    // No transaction crosses authorization awaits. Each attempt detaches a
    // complete candidate graph and its two committed fences before authorizing.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let captured: { anchor: number; aggregate: number; candidate: unknown } | undefined;
      try {
        captured = (await readSnapshotTxn(db as never, () =>
          Object.freeze({
            anchor: readSeq(db, scope),
            aggregate: aggregateRevision(),
            candidate: captureSnapshot({ db: db as never, principal, anchor: declaration.anchor as never, id: handle!.id, output: declaration.output as never, tombstones: declaration.tombstones as never }),
          }),
        )) as { anchor: number; aggregate: number; candidate: unknown };
      } catch {
        // A visibility read that cannot establish absence is a denied snapshot,
        // never a partially projected recipient view. The read snapshot txn is
        // already released (the door COMMITs in a finally before rethrowing).
        return { kind: 'revoked' };
      }
      if (!captured!.candidate) return { kind: 'revoked' };
      const auth = await authorizeSnapshot({ principal, anchor: declaration.anchor as never, candidate: captured!.candidate as never, mayVerb: mayVerb as never, authorization });
      if (!auth.anchorAllowed) return { kind: 'revoked' };
      const value = jsonSnapshot(projectSnapshot({ anchor: declaration.anchor as never, candidate: captured!.candidate as never, output: declaration.output as never, authorized: auth.authorized }));
      if (readSeq(db, scope) === captured!.anchor && aggregateRevision() === captured!.aggregate) {
        // Patch-capable bootstrap (#122 §8): register the recipient visibility
        // ledger from the projected value and mint the bootstrap token. The
        // snapshot itself is IDENTICAL to the legacy path — negotiation only
        // adds the opaque handle.
        if (patchCapable && patchDelivery) {
          const patched = await patchDelivery.bootstrapFromSnapshot({ principal, scope, snapshotValue: value as Record<string, unknown>, anchorCursor: captured!.anchor });
          return patched as unknown as PublicBootstrapResult;
        }
        return Object.freeze({ kind: 'snapshot', snapshot: value, cursor: Object.freeze({ anchor: captured!.anchor, aggregate: captured!.aggregate }) }) as unknown as PublicBootstrapResult;
      }
      await Promise.resolve();
    }
    // The caller receives only an opaque recovery result, never an unstable pair.
    return { kind: 'retry', reason: 'snapshot-contention' };
  }
  async function authorizedAnnotatedTextRow(document: AnnotatedTextDocument, principal: Principal): Promise<Record<string, unknown> | null> {
    const project = tryParseScopeKey(document.scope);
    const projectEntity = project && resolveEntity(project.entity);
    if (projectEntity) {
      const projectScope = projectEntity.scopeFilter(principal);
      const projectRow = db.prepare(`SELECT * FROM ${projectEntity.name} AS t0 WHERE ${projectScope.sql} AND t0.id = :id`)
        .get({ ...projectScope.params, id: project.id });
      if (!projectRow || !(await admitSubscribeRow(projectEntity as never, projectRow, principal))) return null;
    }
    const { sql, params } = document.entity.scopeFilter(principal);
    const row = db.prepare(`SELECT * FROM ${document.entity.name} AS t0 WHERE ${sql} AND t0.id = :id`)
      .get({ ...params, id: document.documentId });
    if (!row || !(await admitSubscribeRow(document.entity as never, row, principal))) return null;
    // Field-read admission (S5/A3) on the annotated-text field: a principal who
    // cannot READ the field must not receive document content, snapshot
    // recovery, or fold envelopes — the same admission the row projection runs.
    if (!(await mayReadField(document.entity as never, document.fieldName, row, principal, authorization))) return null;
    return row;
  }

  // Public delivery deliberately has no connection state. It emits only
  // recipient-hydrated lifecycle snapshots or opaque recovery controls.
  const envelopes = createLiveEnvelopeBuilder({ stateful: false, includeActionId });

  async function annotationStateEnvelope(base: CoreProjectContext, committedEvent: LiveCommittedEvent, document: AnnotatedTextDocument): Promise<object[] | null> {
    let operated;
    try {
      operated = normalizeOperatedEvent(committedEvent.data, { entity: document.entity.name, field: document.fieldName });
    } catch {
      return null;
    }
    if (operated.id !== document.documentId
      || (operated.kind !== 'annotation.apply-range' && operated.kind !== 'annotation.remove')) return null;

    const entityName = tryParseScopeKey(base.scope)?.entity ?? document.entity.name;
    const id = tryParseScopeKey(base.scope)?.id ?? document.documentId;
    const row = rawRow(db, document.entity.name, document.documentId);
    if (!row || typeof document.clientNonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(document.clientNonce)) return null;

    try {
      const recipient = await projectAnnotatedTextSnapshot({
        db, entity: document.entity, row, principal: base.principal,
        fieldName: document.fieldName, descriptor: document.descriptor, mintBasis: false,
      });
      if (recipient.restricted
        || (recipient.redactions?.length ?? 0) > 0
        || authoringRedactionsForRecipient(recipient).length > 0) return null;

      const prefix = `${document.entity.name}_${document.fieldName}`;
      const stream = ensureStream({
        db: db as never, prefix, documentId: document.documentId,
        principalType: base.principal?.type ?? 'principal', principalId: base.principal?.id ?? '',
      });
      const lease = ensureLease({
        db: db as never, prefix, streamId: stream.id, clientNonceHash: hashClientNonce(document.clientNonce),
      });
      if (!lease) return null;
      const state = await projectEntitySnapshot({
        db: db as never, entity: document.entity as never, row,
        principal: base.principal, authoring: {
          streamToken: stream.id, leaseToken: lease.id, leaseId: lease.id, fence: base.event.seq,
        }, authorization,
      });
      const annotated = (state as Record<string, any>)[document.fieldName];
      const authoring = annotated?.authoring;
      if (!authoring?.family || authoring.acknowledgementFence !== base.event.seq) return null;
      const publicState = Object.freeze({
        ...state,
        [document.fieldName]: Object.freeze(Object.fromEntries(Object.entries(annotated).filter(([key]) => key !== 'authoring'))),
      });
      return [Object.freeze({
        type: 'state', entity: entityName, id, seq: base.event.seq,
        state: publicState, authoring,
      })];
    } catch {
      return null;
    }
  }

  const core: LiveDeliveryCore = createLiveDeliveryCore({
    db,
    entities,
    mayVerb,
    authorization,
    projectRecipient: async (context: CoreProjectContext) => {
      // The public projector must never receive raw _Log eventData. The
      // envelope grammar uses only metadata plus the recipient-hydrated row.
      const { data: _data, eventData: _eventData, ...event } = context.event;
      const handle = tryParseScopeKey(context.scope);
      // Field-read projection (S5/A3): the envelope grammar sees only the
      // recipient's readable field subset — lifecycle data, deltas, and reducer
      // seeds alike — so a field the principal cannot read never reaches the
      // recipient.
      let readableFields: ReadonlySet<string> | undefined;
      let row = context.row;
      if (row) {
        readableFields = await readableFieldNames(context.entity as never, row, context.principal, authorization);
        row = await projectRowForRecipient(context.entity as never, row, context.principal, { readable: readableFields, authorization });
      }
      const base = { ...context, row, readableFields, event, composite: !!handle && composites.has(handle.entity) };
      // Document-bound annotated-text operated events may fold as a single
      // recipient-safe CRDT transition. Valid annotation-only events instead
      // carry one authoritative state+family replacement; unsafe or malformed
      // fall-throughs retain the ordinary opaque snapshot recovery.
      // The fold builder needs the full committed event (including data);
      // buildEnvelope must keep the stripped event (raw eventData never leaves).
      let document = base.document;
      if (document) {
        const row = await authorizedAnnotatedTextRow(document as AnnotatedTextDocument, context.principal as Principal);
        if (!row) throw new Error('annotated-text document reauthorization denied');
        document = Object.freeze({ ...document, row });
      }
      if (document && (context.event as { eventType?: string }).eventType?.startsWith(`${(document as { entity?: LiveEntityRecord }).entity?.name}.`)) {
        const folded = await tryBuildAnnotatedTextFoldEnvelopes({ ...base, document, event: context.event } as never, { db: db as never, document: document as never });
        if (folded) return folded;
        const state = await annotationStateEnvelope(base as CoreProjectContext, context.event as LiveCommittedEvent, document as AnnotatedTextDocument);
        if (state) return state;
      }
      // A composite shell subscriber resyncs only when the committed event can
      // change the composite output. Without this gate the shared envelope
      // builder returns a resync for EVERY event on the composite's scope, so
      // an annotated-text body edit (committed to the owning Project scope)
      // re-bootstraps the whole shell per keystroke.
      if (base.composite && !document) {
        const declaration = composites.get(handle!.entity);
        if (declaration?.output && !eventTouchesComposite(declaration, context.event as LiveCommittedEvent)) {
          return [];
        }
      }
      return envelopes.buildEnvelope(base as never);
    },
    scopeVisible: ({ entity, principal, scope: handle }: { entity: LiveEntityRecord; principal: Principal; scope: ScopeHandle }) => {
      const declaration = composites.get(entity.name);
      if (!declaration?.tombstones?.some((rule) => rule.target === entity)) return true;
      try {
        return captureSnapshot({ db: db as never, principal, anchor: declaration.anchor as never, id: handle.id, output: declaration.output as never, tombstones: declaration.tombstones as never }) !== null;
      } catch {
        return false;
      }
    },
    log,
  });

  const delivery: OwnedLiveDelivery = {
    resolveAnnotatedTextDocument({ entity: entityName, field: fieldName, documentId }: { entity: string; field: string; documentId: string }): AnnotatedTextDocument | null {
      const entity = resolveEntity(entityName);
      const descriptor = entity?.fields?.[fieldName];
      if (!entity || descriptor?.kind !== 'annotatedText' || typeof documentId !== 'string' || !documentId) return null;
      const row = rawRow(db, entity.name, documentId);
      if (!row) return null;
      return Object.freeze({ scope: resolveAnnotatedTextOwningScope(descriptor, entity.fields as Record<string, any>, row as Record<string, any>).key, entity, row, fieldName, descriptor, documentId });
    },
    async authorizeAnnotatedTextDocument(document: AnnotatedTextDocument, principal: Principal): Promise<Record<string, unknown> | null> {
      return authorizedAnnotatedTextRow(document, principal);
    },
    // Public subscribers always acknowledge before any durable batch drains.
    subscribe(input: PublicSubscribeInput): Promise<PublicActivation> {
      const { paused: _paused, signal, revoke, ...subscription } = (input ?? {}) as PublicSubscribeInput;
      if (!signal || typeof signal.addEventListener !== 'function') {
        throw new Error('live delivery subscription requires an AbortSignal');
      }
      if (signal.aborted) {
        throw new Error('live delivery subscription is aborted');
      }
      if (isPrincipalSnapshotScope(subscription.scope)) {
        return principalDelivery
          ? principalDelivery.subscribe({ ...subscription, signal, revoke } as never)
          : Promise.reject(Object.assign(new Error('principal snapshot delivery is not attached'), { code: 'live-delivery-revoked' }));
      }
      const handle = tryParseScopeKey(subscription.scope);
      const declaration = handle && composites.get(handle.entity);
      if ((subscription.document && requiredEntities.has(subscription.document.entity.name)) || (handle && requiredEntities.has(handle.entity))) {
        revoke?.();
        return Promise.resolve({ activate: async () => undefined });
      }
      const supplied = subscription.after;
      const after = (declaration && supplied && typeof supplied === 'object' ? supplied.anchor : supplied) as number | undefined;
      let recoveryQueued = false;
      const authorizeDocument = input.document
        ? this.authorizeAnnotatedTextDocument(input.document, subscription.principal).then((row) => {
          if (!row) {
            revoke?.();
            return { activate: async () => undefined };
          }
          // Document-bound subscriptions carry the resolved document (including
          // optional authoring client nonce) so fold emission can mint frames.
          const document = Object.freeze({ ...input.document, row });
          return core.subscribe({ ...subscription, after, signal, paused: true, revoke, document });
        })
        : core.subscribe({ ...subscription, after, signal, paused: true, revoke });
      const activation = Promise.resolve(authorizeDocument).then((value) => value).catch((error) => {
        if ((error as { code?: unknown } | null | undefined)?.code !== 'live-delivery-revoked') throw error;
        revoke?.();
        return { activate: async () => undefined };
      });
      if (!declaration) return activation as unknown as Promise<PublicActivation>;
      return activation.then((value) => ({
        activate: async (): Promise<PublicCursor | undefined> => {
          // Admission is async, so latch stale-cursor recovery only after the
          // paused subscription has been installed. Compare now: a commit may
          // have completed while admission awaited its anchor grant.
          if (!supplied || typeof supplied !== 'object' || !('aggregate' in supplied) || supplied.aggregate !== aggregateRevision()) {
            core.resync(subscription.scope, { type: 'resync', entity: handle!.entity, id: handle!.id, seq: after ?? 0, reason: 'recipient-snapshot-required' });
            recoveryQueued = true;
          }
          const anchor = await value?.activate();
          // Activation can await delivery. A member commit in that interval is
          // not represented by the anchor cursor, so never acknowledge it.
          const aggregate = aggregateRevision();
          if (supplied && typeof supplied === 'object' && (!('aggregate' in supplied) || supplied.aggregate !== aggregate)) {
            if (!recoveryQueued) core.resync(subscription.scope, { type: 'resync', entity: handle!.entity, id: handle!.id, seq: after ?? 0, reason: 'recipient-snapshot-required' });
            return anchor === undefined ? undefined : Object.freeze({ anchor, aggregate });
          }
          return anchor === undefined ? undefined : Object.freeze({ anchor, aggregate });
        },
      }));
    },
    async bootstrap({ principal, scope, document = null, capabilities }: { principal: Principal; scope: string; document?: AnnotatedTextDocument | null; capabilities?: readonly string[] }): Promise<PublicBootstrapResult> {
      if (isPrincipalSnapshotScope(scope)) {
        return principalDelivery
          ? principalDelivery.bootstrap({ principal: principal as never, scope })
          : Object.freeze({ kind: 'revoked' });
      }
      const handle = tryParseScopeKey(scope);
      if ((document && requiredEntities.has(document.entity.name)) || (handle && requiredEntities.has(handle.entity))) {
        return { kind: 'revoked' };
      }
      if (document) {
        if (document.scope !== scope) return { kind: 'revoked' };
        const row = await this.authorizeAnnotatedTextDocument(document, principal);
        if (!row) return { kind: 'revoked' };
        const before = readSeq(db, scope);
        // A refused lease is distinguishable from an absent one (#815): when the
        // stream already holds its full budget of LIVE leases, surface that
        // distinctly so clients stop retrying a bootstrap that cannot succeed
        // until a lease expires. The snapshot itself is unaffected — only the
        // authoring envelope is withheld.
        const leaseAttempt = document.descriptor?.kind === 'annotatedText' && typeof document.clientNonce === 'string' && /^[A-Za-z0-9_-]{43}$/.test(document.clientNonce)
          ? (() => {
            const prefix = `${document.entity.name}_${document.fieldName}`;
            const stream = ensureStream({ db: db as never, prefix, documentId: document.documentId, principalType: principal.type ?? 'principal', principalId: principal.id ?? '' });
            const lease = ensureLease({ db: db as never, prefix, streamId: stream.id, clientNonceHash: hashClientNonce(document.clientNonce) });
            // ensureLease refuses only when the cap is reached with nothing
            // evictable; recounting live leases confirms the refusal cause.
            const exhausted = !lease && countLiveLeases(db as never, prefix, stream.id) >= AUTHORING_STREAM_LIMITS.maxLeasesPerStream;
            return {
              attempted: true,
              exhausted,
              authoring: lease ? { streamToken: stream.id, leaseToken: lease.id, leaseId: lease.id, fence: before } : null,
            };
          })()
          : { attempted: false, exhausted: false, authoring: null };
        const snapshot = await projectEntitySnapshot({ db: db as never, entity: document.entity as never, row, principal, authoring: leaseAttempt.authoring, authorization });
        if (readSeq(db, scope) !== before) return Object.freeze({ kind: 'retry', reason: 'cursor-moved' });
        const annotated = (snapshot as Record<string, any>)[document.fieldName];
        const envelope = annotated?.authoring;
        if (!envelope) {
          // No lease was sought (no usable client nonce): unchanged historical
          // behavior — a bare retry with no diagnostic added (#815 additive).
          if (!leaseAttempt.attempted) return Object.freeze({ kind: 'retry' });
          return Object.freeze({ kind: 'retry', reason: leaseAttempt.exhausted ? 'lease-budget-exhausted' : 'fence-mismatch' });
        }
        if (envelope.acknowledgementFence !== before) return Object.freeze({ kind: 'retry', reason: 'fence-mismatch' });
        const publicSnapshot = Object.freeze({ ...snapshot, [document.fieldName]: Object.freeze(Object.fromEntries(Object.entries(annotated).filter(([key]) => key !== 'authoring'))) });
        return Object.freeze({ kind: 'snapshot', snapshot: publicSnapshot, cursor: before, authoring: envelope });
      }
      // The declaration is selected by the package scope grammar, before the
      // core pairs its synchronous result with the committed cursor.
      const aggregate = handle && composites.get(handle.entity);
      if (aggregate) return aggregateSnapshot({ principal, scope, declaration: aggregate, patchCapable: parseRequestedCapabilities(capabilities).patchCapable });
      const result = await core.bootstrap({
        principal,
        scope,
        snapshot: ({ principal: recipient, scope: snapshotScope }) => {
          const row = core.snapshot({ principal: recipient, scope: snapshotScope });
          const direct = tryParseScopeKey(snapshotScope);
          const entity = direct && resolveEntity(direct.entity);
          if (!entity || !hasAnnotatedTextFields(entity as never)) return row;
          return projectEntitySnapshot({ db: db as never, entity: entity as never, row, principal: recipient, authorization });
        },
      });
       return result;
    },
    async catchup(input: { principal: Principal; scope: string; after?: PublicCursor; document?: AnnotatedTextDocument | null; capabilities?: readonly string[]; projectionToken?: string }): Promise<PublicCatchupResult> {
      if (isPrincipalSnapshotScope(input.scope)) {
        return principalDelivery
          ? principalDelivery.catchup(input as never) as unknown as Promise<PublicCatchupResult>
          : Object.freeze({ kind: 'revoked' });
      }
      const handle = tryParseScopeKey(input.scope);
      if ((input.document && requiredEntities.has(input.document.entity.name)) || (handle && requiredEntities.has(handle.entity))) {
        return { kind: 'revoked' };
      }
      const liveScope = classifyLiveScope(input.scope, resolveEntity);
      if (liveScope) {
        const after = typeof input.after === 'number' ? input.after : 0;
        // A live revision has no replay payload. The bounded ledger can only
        // establish that this revision is current; every other result converges
        // through the same authorized snapshot used for bootstrap.
        if (invalidationRecovery(db as never, input.scope, liveScope.kind, after).status !== 'current') {
          return this.bootstrap({ principal: input.principal, scope: input.scope, document: input.document });
        }
        // Collection state is materialized by its compiled rule at transport
        // subscription time; an unruled public catch-up cannot disclose it.
        if (liveScope.kind === 'collection') return { kind: 'revoked' };
      }
      if (input.document) {
        // Document-bound catch-up may still fold sequential text envelopes when
        // the core can project them; long gaps and non-foldable ops bootstrap.
        if (core.exceedsCatchupLimit(input.scope, typeof input.after === 'object' ? input.after?.anchor ?? 0 : input.after ?? 0, maxCatchupEvents)) {
          return this.bootstrap({ principal: input.principal, scope: input.scope, document: input.document });
        }
        const row = await this.authorizeAnnotatedTextDocument(input.document, input.principal);
        if (!row) return { kind: 'revoked' };
        const document = Object.freeze({ ...input.document, row });
        return core.catchup({ ...input, after: input.after as number | undefined, document }) as unknown as Promise<PublicCatchupResult>;
      }
      const declaration = handle && composites.get(handle.entity);
      if (declaration) {
        const cursor = input.after;
        // Patch-capable catch-up (#122 §10): token + journal replay. ANY
        // fallback returns the full authorized snapshot — never a partial.
        const patchRequest = parseRequestedCapabilities((input as { capabilities?: unknown }).capabilities);
        if (patchRequest.patchCapable && patchDelivery && cursor && typeof cursor === 'object' && 'composite' in cursor && typeof (cursor as { composite?: unknown }).composite === 'number' && typeof input.projectionToken === 'string') {
          if (typeof cursor.anchor !== 'number') return this.bootstrap({ principal: input.principal, scope: input.scope, capabilities: input.capabilities });
          const outcome = await patchDelivery.catchupWithPatches({
            principal: input.principal,
            scope: input.scope,
            after: cursor as { anchor: number; composite: number },
            projectionToken: input.projectionToken,
          });
          if (outcome.kind === 'catchup') return { kind: 'catchup', envelopes: outcome.envelopes, cursor: outcome.cursor } as unknown as PublicCatchupResult;
          if (outcome.kind === 'revoked') return { kind: 'revoked' };
          void outcome.reason;
          return this.bootstrap({ principal: input.principal, scope: input.scope, capabilities: input.capabilities });
        }
        if (!cursor || typeof cursor !== 'object' || !('aggregate' in cursor) || cursor.aggregate !== aggregateRevision()) {
          return this.bootstrap({ principal: input.principal, scope: input.scope });
        }
        const result = await core.catchup({ ...input, after: cursor.anchor });
        // Core admission awaits authorization. Never return an anchor catch-up
        // paired with the aggregate revision observed before that await.
        if (aggregateRevision() !== cursor.aggregate) {
          return this.bootstrap({ principal: input.principal, scope: input.scope });
        }
        return result.kind === 'revoked' ? result : { ...result, cursor: Object.freeze({ anchor: result.cursor as number, aggregate: cursor.aggregate }) };
      }      // Never materialize an unbounded retained history merely to discover it
      // cannot fit a transport frame. A fresh paired recipient snapshot is the
      // canonical opaque recovery for a long gap.
      if (core.exceedsCatchupLimit(input.scope, input.after as never, maxCatchupEvents)) {
        return this.bootstrap({ principal: input.principal, scope: input.scope });
      }
      return core.catchup(input as unknown as { principal: Principal; scope: string; after?: number; document?: unknown }) as unknown as Promise<PublicCatchupResult>;
    },
    wake(scope: string): void {
      if (isPrincipalSnapshotScope(scope)) {
        principalDelivery?.wake(scope as never, undefined as never);
        return;
      }
      // A wake is only a payloadless hint; it is not a delivery barrier.
      void core.wake(scope);
    },
    async acknowledgeAuthoringSnapshot({ document, principal, stream, lease, snapshot }: { document: AnnotatedTextDocument; principal: Principal; stream: string; lease: string; snapshot: string }): Promise<{ acknowledgedThrough: number } | null> {
      const documentIdentity = { entity: document.entity.name, field: document.fieldName, documentId: document.documentId };
      const resolved = this.resolveAnnotatedTextDocument(documentIdentity);
      if (!resolved) return null;
      const row = await this.authorizeAnnotatedTextDocument(resolved, principal);
      if (!row) return null;
       const prefix = `${document.entity.name}_${document.fieldName}`;
        const resolvedStream = resolveStream({ db: db as never, prefix, streamToken: stream, documentId: document.documentId, principalType: principal.type ?? 'principal', principalId: principal.id ?? '' });
      if (!resolvedStream) return null;
      const resolvedLease = resolveLease({ db: db as never, prefix, leaseToken: lease, streamId: resolvedStream.id });
      if (!resolvedLease) return null;
        const result = acknowledgeAndPruneSnapshot({ db: db as never, prefix, snapshotId: snapshot, leaseId: resolvedLease.id });
        if (!result) return null;
        return { acknowledgedThrough: result.fence };
    },
  };

  return {
    delivery,
    /** Compiled patch plans (#122) — the commit pipeline's journal router consumes these. */
    patchPlans,
    consumer: async (events: readonly LiveCommittedEvent[]): Promise<void> => {      const scopes = new Set<string>();
      for (const event of events) {
        if (event?.scope) scopes.add(event.scope);
      }
      for (const scope of scopes) core.wake(scope);
      const invalidatedAnchors = new Set<string>();
      for (const event of events) {
        const handle = tryParseScopeKey(event?.scope as string);
        if (!handle) continue;
        for (const [anchorName, declaration] of composites) {
          // Resync only when the event can actually change the composite output
          // (anchor/tombstone identity, member presence, or a selected field).
          // This keeps per-keystroke annotated-text body edits from forcing a
          // full composite snapshot re-bootstrap for every shell subscriber.
          if (declaration.output && eventTouchesComposite(declaration, event)) {
            invalidatedAnchors.add(anchorName);
          }
        }
      }
      // Member events invalidate every live aggregate of that declaration. The
      // deliberate broad fan-out needs no pre-image cache, so deletion and both
      // sides of a reparent are authoritative.
      for (const anchorName of invalidatedAnchors) {
        core.resyncEntity(anchorName, (scope) => {
          const anchor = tryParseScopeKey(scope);
          return { type: 'resync', entity: anchorName, id: anchor!.id, seq: 0, reason: 'recipient-snapshot-required' };
        });
      }
    },
    close(): void {
      core.close();
      principalDelivery?.close();
      patchDelivery?.close();
    },
    // The committed-event core behind the public delivery protocol. The
    // WebSocket transport consumes this SAME authority, so SSE and WebSocket
    // share one re-read/re-authorise/project/deliver path (never a second
    // committed-delivery machine).
    core,
  };
}

/**
 * Build the per-anchor resync-relevance map for a compiled snapshot set: which
 * member entities appear in the composite output and which of their fields the
 * output reads. The composite resync gate uses this so member events that touch
 * no selected field (e.g. annotated-text body edits) do not force a full
 * composite snapshot re-bootstrap.
 */
export function buildSnapshotResyncRelevance(composites: CompiledSnapshots): Map<string, Readonly<SnapshotResyncRelevance>> {
  const resyncRelevance = new Map<string, Readonly<SnapshotResyncRelevance>>();
  for (const [anchorName, declaration] of composites) {
    const relevantFields = new Map<string, Set<string>>();
    const collect = (branch: SnapshotBranch | null | undefined, isRoot: boolean): void => {
      for (const entry of branch?.entries ?? []) {
        const entityName = entry.entity?.name;
        if (entityName) {
          const fields = relevantFields.get(entityName) ?? new Set<string>();
          for (const field of entry.selected ?? []) fields.add(field);
          relevantFields.set(entityName, fields);
        } else if (isRoot && entry.kind === 'select') {
          const fields = relevantFields.get(anchorName) ?? new Set<string>();
          for (const field of entry.fields ?? []) fields.add(field);
          relevantFields.set(anchorName, fields);
        }
        if (entry.nested) collect(entry.nested, false);
      }
    };
    collect(declaration.output, true);
    const tombstone = declaration.tombstone;
    // Tombstone identity events always resync; the anchor's own selected fields
    // are captured in relevantFields (its create/remove also resync via
    // presence, and identity-only updates are covered by the field gate below).
    const alwaysRelevant = new Set<string>();
    if (tombstone?.entity?.name) alwaysRelevant.add(tombstone.entity.name);
    if (tombstone?.terminalScope?.name) alwaysRelevant.add(tombstone.terminalScope.name);
    resyncRelevance.set(anchorName, Object.freeze({ relevantFields, alwaysRelevant }));
  }
  return resyncRelevance;
}

/**
 * Decide whether a committed event can change a composite's output. Anchor and
 * tombstone identity events always resync; member create/remove resync when the
 * member appears in the output; member update/native events resync only when
 * they touch a field the output reads.
 */
export function snapshotEventTouchesComposite(relevance: Map<string, Readonly<SnapshotResyncRelevance>>, declaration: SnapshotDeclaration, event: LiveCommittedEvent): boolean {
  const handle = tryParseScopeKey(event?.scope as string);
  const entityName = handle?.entity;
  if (!entityName) return false;
  const anchorRelevance = relevance.get(declaration.anchor.name);
  if (!anchorRelevance) return true;
  const kind = event.eventType ?? event.type ?? '';
  const isPresence = kind.endsWith('.created') || kind.endsWith('.removed');
  // Tombstone identity events always resync.
  if (isPresence && anchorRelevance.alwaysRelevant.has(entityName)) return true;
  // An entity entirely absent from the output never resyncs.
  const fields = anchorRelevance.relevantFields.get(entityName);
  if (fields === undefined) return false;
  // A member create/remove changes presence in the composite tree; always
  // resync when that entity appears in the output at all.
  if (isPresence) return true;
  // Update/native events resync only when they touch a selected field.
  return Object.keys(event.data ?? {}).some((field) => fields.has(field));
}

/**
 * Direct transport-neutral delivery factory.
 *
 * This is for hosts that already own their entity registry and authorization
 * kernel. Workbench applications should use app.attachLiveDelivery() instead,
 * so the package binds delivery to the application's own authority.
 */
export function createLiveDelivery(options: OwnedLiveDeliveryOptions): OwnedLiveDelivery {
  return createOwnedLiveDelivery(options).delivery;
}
