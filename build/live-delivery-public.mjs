// Public, transport-neutral committed delivery. The package owns reread,
// authorization, projection, and cursor semantics; adapters only deliver the
// recipient-safe batch and acknowledge it by resolving their callback.

import { classifyLiveScope, createLiveDeliveryCore } from './live-delivery-core.mjs';

import { createLiveEnvelopeBuilder } from './live-delivery-envelope.mjs';
import { tryBuildAnnotatedTextFoldEnvelopes } from './annotated-text-fold-envelope.mjs';
import { normalizeOperatedEvent } from './annotated-text-operated-event.mjs';
import { projectAnnotatedTextSnapshot } from './annotated-text-snapshot.mjs';
import { authoringRedactionsForRecipient } from './annotated-text-recipient-projection.mjs';
import { tryParseScopeKey } from './scope-handle.mjs';

import { readSeq } from './committed-log.mjs';
import { invalidationRecovery } from './invalidation-ledger.mjs';
import { readSnapshotTxn } from './driver.mjs';
import { compileSnapshots, captureSnapshot, authorizeSnapshot, projectSnapshot } from './snapshot-projection.mjs';
import { compilePatchPlans } from './composite-patch-plan.mjs';

import { createCompositePatchDelivery, parseRequestedCapabilities, SNAPSHOT_PATCH_CAPABILITY } from './composite-patch-delivery.mjs';
import { hasAnnotatedTextFields, projectEntitySnapshot } from './entity-snapshot-projection.mjs';
import { resolveAnnotatedTextOwningScope } from './annotated-text-field.mjs';
import { rawRow } from './entity/query.mjs';
import { projectRowForRecipient } from './entity/projection.mjs';
import { mayReadField, readableFieldNames } from './field-admission.mjs';
import { mayRow } from './row-grant.mjs';

import { ensureStream, ensureLease, hashClientNonce, resolveStream, resolveLease, acknowledgeAndPruneSnapshot, countLiveLeases, AUTHORING_STREAM_LIMITS } from './annotated-text-authoring-stream.mjs';
import { createPrincipalSnapshotDelivery, isPrincipalSnapshotScope, validatePrincipalSnapshotDeclarations } from './principal-snapshot-delivery.mjs';






function jsonSnapshot(value         , path = 'snapshot', ancestors = new Set         ())          {
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
  const copy                          = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = jsonSnapshot(entry, `${path}.${key}`, ancestors);
  ancestors.delete(value);
  return Object.freeze(copy);
}

// ---------------------------------------------------------------------------
// Package-private shared delivery shapes
// ---------------------------------------------------------------------------









































































// Closed diagnostic vocabulary for bootstrap-path retry results (#815).
// Additive and client-opaque: existing clients ignore it, new clients can
// distinguish transient cursor churn from a wedged authoring stream.






















                                        




































// Package-private assembly for an application-owned activation. The public
// factory below deliberately returns only the delivery protocol; application
// lifecycle wiring retains the committed consumer, the shared core (which the
// WebSocket transport presents over the same authority), and shutdown.
export function createOwnedLiveDelivery({ db, entities, mayVerb, authorization, snapshots, principalSnapshots, principalSnapshotAuthorize, schema, log = null, maxCatchupEvents = 1000, includeActionId = true }                          )                                                                                                                                                                                                   {
  if (!Number.isSafeInteger(maxCatchupEvents) || maxCatchupEvents < 1) throw new TypeError('maxCatchupEvents must be a positive safe integer');
  const resolveEntity = typeof entities === 'function' ? entities : (name        ) => entities.get(name);
  const composites = compileSnapshots(snapshots, resolveEntity, db         )                                ;
  // Composite patch plans derive from the SAME compiled declarations (#122):
  // one structural source for snapshot capture, resync relevance, and patch
  // projection. Exposed package-internally so the delivery lane and the commit
  // pipeline's journal router share this exact map.
  const patchPlans = compilePatchPlans(composites                                 );
  validatePrincipalSnapshotDeclarations(principalSnapshots         , schema         );
  const principalDelivery = (principalSnapshots                                  )?.length
    ? createPrincipalSnapshotDelivery({ db: db         , declarations: principalSnapshots         , authorize: principalSnapshotAuthorize })
    : null;
  const requiredEntities = composites.requiredEntities ?? new Set();
  // Composite patch lane (#122): derived from the SAME compiled declarations.
  // Null without snapshots; engages only for callers presenting the
  // unadvertised snapshot-patch capability (rollout step 1).
  const patchDelivery = createCompositePatchDelivery({
    db: db         ,
    composites: composites         ,
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
  function eventTouchesComposite(declaration                     , event                    )          {
    return snapshotEventTouchesComposite(resyncRelevance, declaration, event);
  }

  const aggregateRevision = ()         => Number(db.prepare("SELECT revision FROM _CommittedRevision WHERE name = 'actions'").get() .revision);
  // The one subscribe-row admission for this app-integrated seam (S5/A2): an
  // injected adapter is THE authority for both subscribe-time admission and
  // re-authorization; without one the framework mayVerb engine runs, unchanged.
  async function admitSubscribeRow(entity                  , row         , principal           )                   {
    if (authorization) {
      const decision = await authorization.admit({
        category: 'entity',
        verb: 'subscribe',
        operation: 'subscribe',
        principal,
        entity: entity         ,
        row,
        resourceId: (row                                       )?.id                             ,
      });
      return decision.admitted;
    }
    return mayRow(entity         , 'subscribe', row, principal, mayVerb         );
  }
  async function aggregateSnapshot({ principal, scope, declaration, patchCapable = false }                                                                                                   )                                 {
    const handle = tryParseScopeKey(scope);
    // No transaction crosses authorization awaits. Each attempt detaches a
    // complete candidate graph and its two committed fences before authorizing.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let captured                                                                       ;
      try {
        captured = (await readSnapshotTxn(db         , () =>
          Object.freeze({
            anchor: readSeq(db, scope),
            aggregate: aggregateRevision(),
            candidate: captureSnapshot({ db: db         , principal, anchor: declaration.anchor         , id: handle .id, output: declaration.output         , tombstones: declaration.tombstones          }),
          }),
        ))                                                             ;
      } catch {
        // A visibility read that cannot establish absence is a denied snapshot,
        // never a partially projected recipient view. The read snapshot txn is
        // already released (the door COMMITs in a finally before rethrowing).
        return { kind: 'revoked' };
      }
      if (!captured .candidate) return { kind: 'revoked' };
      const auth = await authorizeSnapshot({ principal, anchor: declaration.anchor         , candidate: captured .candidate         , mayVerb: mayVerb         , authorization });
      if (!auth.anchorAllowed) return { kind: 'revoked' };
      const value = jsonSnapshot(projectSnapshot({ anchor: declaration.anchor         , candidate: captured .candidate         , output: declaration.output         , authorized: auth.authorized }));
      if (readSeq(db, scope) === captured .anchor && aggregateRevision() === captured .aggregate) {
        // Patch-capable bootstrap (#122 §8): register the recipient visibility
        // ledger from the projected value and mint the bootstrap token. The
        // snapshot itself is IDENTICAL to the legacy path — negotiation only
        // adds the opaque handle.
        if (patchCapable && patchDelivery) {
          const patched = await patchDelivery.bootstrapFromSnapshot({ principal, scope, snapshotValue: value                           , anchorCursor: captured .anchor });
          return patched                                    ;
        }
        return Object.freeze({ kind: 'snapshot', snapshot: value, cursor: Object.freeze({ anchor: captured .anchor, aggregate: captured .aggregate }) })                                    ;
      }
      await Promise.resolve();
    }
    // The caller receives only an opaque recovery result, never an unstable pair.
    return { kind: 'retry', reason: 'snapshot-contention' };
  }
  async function authorizedAnnotatedTextRow(document                       , principal           )                                          {
    const project = tryParseScopeKey(document.scope);
    const projectEntity = project && resolveEntity(project.entity);
    if (projectEntity) {
      const projectScope = projectEntity.scopeFilter(principal);
      const projectRow = db.prepare(`SELECT * FROM ${projectEntity.name} AS t0 WHERE ${projectScope.sql} AND t0.id = :id`)
        .get({ ...projectScope.params, id: project.id });
      if (!projectRow || !(await admitSubscribeRow(projectEntity         , projectRow, principal))) return null;
    }
    const { sql, params } = document.entity.scopeFilter(principal);
    const row = db.prepare(`SELECT * FROM ${document.entity.name} AS t0 WHERE ${sql} AND t0.id = :id`)
      .get({ ...params, id: document.documentId });
    if (!row || !(await admitSubscribeRow(document.entity         , row, principal))) return null;
    // Field-read admission (S5/A3) on the annotated-text field: a principal who
    // cannot READ the field must not receive document content, snapshot
    // recovery, or fold envelopes — the same admission the row projection runs.
    if (!(await mayReadField(document.entity         , document.fieldName, row, principal, authorization))) return null;
    return row;
  }

  // Public delivery deliberately has no connection state. It emits only
  // recipient-hydrated lifecycle snapshots or opaque recovery controls.
  const envelopes = createLiveEnvelopeBuilder({ stateful: false, includeActionId });

  async function annotationStateEnvelope(base                    , committedEvent                    , document                       )                           {
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
        db: db         , prefix, documentId: document.documentId,
        principalType: base.principal?.type ?? 'principal', principalId: base.principal?.id ?? '',
      });
      const lease = ensureLease({
        db: db         , prefix, streamId: stream.id, clientNonceHash: hashClientNonce(document.clientNonce),
      });
      if (!lease) return null;
      const state = await projectEntitySnapshot({
        db: db         , entity: document.entity         , row,
        principal: base.principal, authoring: {
          streamToken: stream.id, leaseToken: lease.id, leaseId: lease.id, fence: base.event.seq,
        }, authorization,
      });
      const annotated = (state                       )[document.fieldName];
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

  const core                   = createLiveDeliveryCore({
    db,
    entities,
    mayVerb,
    authorization,
    projectRecipient: async (context                    ) => {
      // The public projector must never receive raw _Log eventData. The
      // envelope grammar uses only metadata plus the recipient-hydrated row.
      const { data: _data, eventData: _eventData, ...event } = context.event;
      const handle = tryParseScopeKey(context.scope);
      // Field-read projection (S5/A3): the envelope grammar sees only the
      // recipient's readable field subset — lifecycle data, deltas, and reducer
      // seeds alike — so a field the principal cannot read never reaches the
      // recipient.
      let readableFields                                 ;
      let row = context.row;
      if (row) {
        readableFields = await readableFieldNames(context.entity         , row, context.principal, authorization);
        row = await projectRowForRecipient(context.entity         , row, context.principal, { readable: readableFields, authorization });
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
        const row = await authorizedAnnotatedTextRow(document                         , context.principal             );
        if (!row) throw new Error('annotated-text document reauthorization denied');
        document = Object.freeze({ ...document, row });
      }
      if (document && (context.event                          ).eventType?.startsWith(`${(document                                 ).entity?.name}.`)) {
        const folded = await tryBuildAnnotatedTextFoldEnvelopes({ ...base, document, event: context.event }         , { db: db         , document: document          });
        if (folded) return folded;
        const state = await annotationStateEnvelope(base                      , context.event                      , document                         );
        if (state) return state;
      }
      // A composite shell subscriber resyncs only when the committed event can
      // change the composite output. Without this gate the shared envelope
      // builder returns a resync for EVERY event on the composite's scope, so
      // an annotated-text body edit (committed to the owning Project scope)
      // re-bootstraps the whole shell per keystroke.
      if (base.composite && !document) {
        const declaration = composites.get(handle .entity);
        if (declaration?.output && !eventTouchesComposite(declaration, context.event                      )) {
          return [];
        }
      }
      return envelopes.buildEnvelope(base         );
    },
    scopeVisible: ({ entity, principal, scope: handle }                                                                        ) => {
      const declaration = composites.get(entity.name);
      if (!declaration?.tombstones?.some((rule) => rule.target === entity)) return true;
      try {
        return captureSnapshot({ db: db         , principal, anchor: declaration.anchor         , id: handle.id, output: declaration.output         , tombstones: declaration.tombstones          }) !== null;
      } catch {
        return false;
      }
    },
    log,
  });

  const delivery                    = {
    resolveAnnotatedTextDocument({ entity: entityName, field: fieldName, documentId }                                                       )                               {
      const entity = resolveEntity(entityName);
      const descriptor = entity?.fields?.[fieldName];
      if (!entity || descriptor?.kind !== 'annotatedText' || typeof documentId !== 'string' || !documentId) return null;
      const row = rawRow(db, entity.name, documentId);
      if (!row) return null;
      return Object.freeze({ scope: resolveAnnotatedTextOwningScope(descriptor, entity.fields                       , row                       ).key, entity, row, fieldName, descriptor, documentId });
    },
    async authorizeAnnotatedTextDocument(document                       , principal           )                                          {
      return authorizedAnnotatedTextRow(document, principal);
    },
    // Public subscribers always acknowledge before any durable batch drains.
    subscribe(input                      )                            {
      const { paused: _paused, signal, revoke, ...subscription } = (input ?? {})                        ;
      if (!signal || typeof signal.addEventListener !== 'function') {
        throw new Error('live delivery subscription requires an AbortSignal');
      }
      if (signal.aborted) {
        throw new Error('live delivery subscription is aborted');
      }
      if (isPrincipalSnapshotScope(subscription.scope)) {
        return principalDelivery
          ? principalDelivery.subscribe({ ...subscription, signal, revoke }         )
          : Promise.reject(Object.assign(new Error('principal snapshot delivery is not attached'), { code: 'live-delivery-revoked' }));
      }
      const handle = tryParseScopeKey(subscription.scope);
      const declaration = handle && composites.get(handle.entity);
      if ((subscription.document && requiredEntities.has(subscription.document.entity.name)) || (handle && requiredEntities.has(handle.entity))) {
        revoke?.();
        return Promise.resolve({ activate: async () => undefined });
      }
      const supplied = subscription.after;
      const after = (declaration && supplied && typeof supplied === 'object' ? supplied.anchor : supplied)                      ;
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
        if ((error                                         )?.code !== 'live-delivery-revoked') throw error;
        revoke?.();
        return { activate: async () => undefined };
      });
      if (!declaration) return activation                                        ;
      return activation.then((value) => ({
        activate: async ()                                    => {
          // Admission is async, so latch stale-cursor recovery only after the
          // paused subscription has been installed. Compare now: a commit may
          // have completed while admission awaited its anchor grant.
          if (!supplied || typeof supplied !== 'object' || !('aggregate' in supplied) || supplied.aggregate !== aggregateRevision()) {
            core.resync(subscription.scope, { type: 'resync', entity: handle .entity, id: handle .id, seq: after ?? 0, reason: 'recipient-snapshot-required' });
            recoveryQueued = true;
          }
          const anchor = await value?.activate();
          // Activation can await delivery. A member commit in that interval is
          // not represented by the anchor cursor, so never acknowledge it.
          const aggregate = aggregateRevision();
          if (supplied && typeof supplied === 'object' && (!('aggregate' in supplied) || supplied.aggregate !== aggregate)) {
            if (!recoveryQueued) core.resync(subscription.scope, { type: 'resync', entity: handle .entity, id: handle .id, seq: after ?? 0, reason: 'recipient-snapshot-required' });
            return anchor === undefined ? undefined : Object.freeze({ anchor, aggregate });
          }
          return anchor === undefined ? undefined : Object.freeze({ anchor, aggregate });
        },
      }));
    },
    async bootstrap({ principal, scope, document = null, capabilities }                                                                                                                    )                                 {
      if (isPrincipalSnapshotScope(scope)) {
        return principalDelivery
          ? principalDelivery.bootstrap({ principal: principal         , scope })
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
            const stream = ensureStream({ db: db         , prefix, documentId: document.documentId, principalType: principal.type ?? 'principal', principalId: principal.id ?? '' });
            const lease = ensureLease({ db: db         , prefix, streamId: stream.id, clientNonceHash: hashClientNonce(document.clientNonce) });
            // ensureLease refuses only when the cap is reached with nothing
            // evictable; recounting live leases confirms the refusal cause.
            const exhausted = !lease && countLiveLeases(db         , prefix, stream.id) >= AUTHORING_STREAM_LIMITS.maxLeasesPerStream;
            return {
              attempted: true,
              exhausted,
              authoring: lease ? { streamToken: stream.id, leaseToken: lease.id, leaseId: lease.id, fence: before } : null,
            };
          })()
          : { attempted: false, exhausted: false, authoring: null };
        const snapshot = await projectEntitySnapshot({ db: db         , entity: document.entity         , row, principal, authoring: leaseAttempt.authoring, authorization });
        if (readSeq(db, scope) !== before) return Object.freeze({ kind: 'retry', reason: 'cursor-moved' });
        const annotated = (snapshot                       )[document.fieldName];
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
          if (!entity || !hasAnnotatedTextFields(entity         )) return row;
          return projectEntitySnapshot({ db: db         , entity: entity         , row, principal: recipient, authorization });
        },
      });
       return result;
    },
    async catchup(input                                                                                                                                                                    )                               {
      if (isPrincipalSnapshotScope(input.scope)) {
        return principalDelivery
          ? principalDelivery.catchup(input         )
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
        if (invalidationRecovery(db         , input.scope, liveScope.kind, after).status !== 'current') {
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
        return core.catchup({ ...input, after: input.after                      , document })                                           ;
      }
      const declaration = handle && composites.get(handle.entity);
      if (declaration) {
        const cursor = input.after;
        // Patch-capable catch-up (#122 §10): token + journal replay. ANY
        // fallback returns the full authorized snapshot — never a partial.
        const patchRequest = parseRequestedCapabilities((input                              ).capabilities);
        if (patchRequest.patchCapable && patchDelivery && cursor && typeof cursor === 'object' && 'composite' in cursor && typeof (cursor                           ).composite === 'number' && typeof input.projectionToken === 'string') {
          if (typeof cursor.anchor !== 'number') return this.bootstrap({ principal: input.principal, scope: input.scope, capabilities: input.capabilities });
          const outcome = await patchDelivery.catchupWithPatches({
            principal: input.principal,
            scope: input.scope,
            after: cursor                                         ,
            projectionToken: input.projectionToken,
          });
          if (outcome.kind === 'catchup') return { kind: 'catchup', envelopes: outcome.envelopes, cursor: outcome.cursor }                                  ;
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
        return result.kind === 'revoked' ? result : { ...result, cursor: Object.freeze({ anchor: result.cursor          , aggregate: cursor.aggregate }) };
      }      // Never materialize an unbounded retained history merely to discover it
      // cannot fit a transport frame. A fresh paired recipient snapshot is the
      // canonical opaque recovery for a long gap.
      if (core.exceedsCatchupLimit(input.scope, input.after         , maxCatchupEvents)) {
        return this.bootstrap({ principal: input.principal, scope: input.scope });
      }
      return core.catchup(input                                                                                          )                                           ;
    },
    wake(scope        )       {
      if (isPrincipalSnapshotScope(scope)) {
        principalDelivery?.wake(scope         , undefined         );
        return;
      }
      // A wake is only a payloadless hint; it is not a delivery barrier.
      void core.wake(scope);
    },
    async acknowledgeAuthoringSnapshot({ document, principal, stream, lease, snapshot }                                                                                                            )                                                  {
      const documentIdentity = { entity: document.entity.name, field: document.fieldName, documentId: document.documentId };
      const resolved = this.resolveAnnotatedTextDocument(documentIdentity);
      if (!resolved) return null;
      const row = await this.authorizeAnnotatedTextDocument(resolved, principal);
      if (!row) return null;
       const prefix = `${document.entity.name}_${document.fieldName}`;
        const resolvedStream = resolveStream({ db: db         , prefix, streamToken: stream, documentId: document.documentId, principalType: principal.type ?? 'principal', principalId: principal.id ?? '' });
      if (!resolvedStream) return null;
      const resolvedLease = resolveLease({ db: db         , prefix, leaseToken: lease, streamId: resolvedStream.id });
      if (!resolvedLease) return null;
        const result = acknowledgeAndPruneSnapshot({ db: db         , prefix, snapshotId: snapshot, leaseId: resolvedLease.id });
        if (!result) return null;
        return { acknowledgedThrough: result.fence };
    },
  };

  return {
    delivery,
    /** Compiled patch plans (#122) — the commit pipeline's journal router consumes these. */
    patchPlans,
    consumer: async (events                               )                => {      const scopes = new Set        ();
      for (const event of events) {
        if (event?.scope) scopes.add(event.scope);
      }
      for (const scope of scopes) core.wake(scope);
      const invalidatedAnchors = new Set        ();
      for (const event of events) {
        const handle = tryParseScopeKey(event?.scope          );
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
          return { type: 'resync', entity: anchorName, id: anchor .id, seq: 0, reason: 'recipient-snapshot-required' };
        });
      }
    },
    close()       {
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
export function buildSnapshotResyncRelevance(composites                   )                                                 {
  const resyncRelevance = new Map                                           ();
  for (const [anchorName, declaration] of composites) {
    const relevantFields = new Map                     ();
    const collect = (branch                                   , isRoot         )       => {
      for (const entry of branch?.entries ?? []) {
        const entityName = entry.entity?.name;
        if (entityName) {
          const fields = relevantFields.get(entityName) ?? new Set        ();
          for (const field of entry.selected ?? []) fields.add(field);
          relevantFields.set(entityName, fields);
        } else if (isRoot && entry.kind === 'select') {
          const fields = relevantFields.get(anchorName) ?? new Set        ();
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
    const alwaysRelevant = new Set        ();
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
export function snapshotEventTouchesComposite(relevance                                                , declaration                     , event                    )          {
  const handle = tryParseScopeKey(event?.scope          );
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
export function createLiveDelivery(options                          )                    {
  return createOwnedLiveDelivery(options).delivery;
}
