import { admitRowTransition } from './field-admission.ts';
import { CASCADE_PREAUTHORIZED } from './entity/removal-cascade.ts';
import {
  admitSystemMutation,
  clearRemovedScheduleReceipts,
  rearmChangedScheduleReceipts,
} from './schedule-runtime.ts';
import { createServer, durableMutationVariant, liveMutationVariant, HANDLER_POLICY, type HandlerPolicy } from './pipeline.ts';
import type { DataTier } from './live-tier.ts';
import { buildEffectsRegistry, validateEffects, executeEffectsForEvent } from './effect-compiler.ts';
import { User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor } from './auth/entities.ts';
import {
  admitInvitationAcceptance,
  admitInvitationCreation,
  isInvitationCreationAuthority,
} from './auth/invitation.ts';
import { createProjectedAsyncConsumer } from './projected-async.ts';
import { createSearchStalenessConsumer, reconcileSearchStaleness } from './search-staleness.ts';
import { buildDurableEffectsRegistry, createDurableEffectsConsumer } from './durable-effects.ts';
import { createBlobLifecycle } from './blob-lifecycle.ts';
import { createOperationalConsumers } from './operational-consumer.ts';
import { createPendingBlobLifecycle, runDeclaredActionWithBlobClaims } from './pending-blob.ts';
import { createQueryInvalidationConsumer } from './query-scoped-read.ts';
import { CRUD_CURSOR_POLICY } from './entity/crud.ts';
import { EventKind } from './event-handle.ts';
import { bindAuthorizedRows, isAuthorizedRows } from './action-authorization.ts';
import { replayPrivateFactProjections } from './post-commit-effects.ts';
import { txn } from './driver.ts';
import { installRemovalCascades } from './entity/removal-cascade.ts';
import { rawRow } from './entity/query.ts';
import { readDeletedRowAnchor } from './deleted-row-anchor.ts';
import { validateAnnotatedTextEntityActions } from './annotated-text-field.ts';
import { compileComposedAnnotatedTextAction, createAnnotatedTextKernelSeam } from './annotated-text-kernel.ts';
import { createAnnotatedTextMutationAdmission } from './annotated-text-admission.ts';
import { createHistoryContributionPolicyRegistry } from './history-contribution-policy.ts';
import { validateProtectedArtefactsDeclaration } from './protected-artefact-store.ts';

// Framework auth entities are always-available effect targets (an app's effect
// may target Inbox without mounting it — auth entities are never request-facing
// routes). They must be present in the validation set so the admission handshake
// can resolve them + their `admitsEffects`.
const FRAMEWORK_ENTITIES = [User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor];

// A registered action's emitted events carry the DECLARING action type on an
// enumerable symbol. Object spread (pipeline's eventWithHandle / finalizeEvents)
// preserves enumerable own symbols, so the marker survives intact to both
// durable admission gates. Generated CRUD events never carry it. The bypass is
// therefore keyed on registered-action provenance AND the declared event.type:
// a generated CRUD event can no longer borrow the bypass merely because some
// registered action happens to declare a projection on the same event.type.
const REGISTERED_ACTION_EVENT: unique symbol = Symbol('workbench.registered-action-event');

function tagRegisteredActionEvents(commit: any, actionType: string): any {
  if (!commit || typeof commit !== 'object') return commit;
  const tag = (event: any) => {
    if (!event || typeof event !== 'object') return event;
    // Events may be frozen (compiled helpers); a shallow copy with an
    // enumerable symbol keeps every existing field and handle untouched.
    const tagged = { ...event };
    Object.defineProperty(tagged, REGISTERED_ACTION_EVENT, {
      value: actionType, enumerable: true, configurable: true, writable: false,
    });
    return tagged;
  };
  if (Array.isArray(commit)) return commit.map(tag);
  if (Array.isArray(commit.events)) return { ...commit, events: commit.events.map(tag) };
  return commit;
}

/**
 * Attach the handler's capability record as one typed policy under HANDLER_POLICY.
 * The pipeline reads that symbol through readHandlerPolicy; the own-property
 * mirror keeps legacy readers (the annotated-text kernel seam, app shims, tests)
 * working unchanged.
 */
export function attachHandlerPolicy(handler: any, policy: HandlerPolicy): any {
  const attached = Object.freeze({ ...policy });
  Object.defineProperty(handler, HANDLER_POLICY, { value: attached });
  for (const [key, value] of Object.entries(attached)) {
    if (value === undefined) continue;
    Object.defineProperty(handler, key, { value });
  }
  return handler;
}

function collectAppEntities(app: any) {
  const handlers: Record<string, any> = {};
  const projections: any[] = [];
  const cursorPolicy = new Map();
  const historyActions: Record<string, any> = {};
  const compoundPolicies: any[] = [];
  const entities: Map<string, any> = new Map(app.entities ?? []);
  validateAnnotatedTextEntityActions(entities.values());
  for (const entity of entities.values()) {
    Object.assign(handlers, entity.crudHandlers);
    projections.push(...(entity.projections ?? [entity.projection]));
    // Generated handler policy is explicit metadata, never inferred from names.
    for (const [actionType, policy] of Object.entries(entity.crudHandlers?.[CRUD_CURSOR_POLICY] ?? {})) {
      cursorPolicy.set(actionType, policy);
    }
  }
  for (const declaration of app.actions ?? []) {
    if (!declaration || typeof declaration.type !== 'string' || declaration.type.length === 0) {
      throw new Error('registered action requires a non-empty type');
    }
    if (typeof declaration.authorize !== 'function') {
      throw new Error(`registered action '${declaration.type}' requires an authorize function`);
    }
    if (typeof declaration.handler !== 'function') {
      throw new Error(`registered action '${declaration.type}' requires a handler function`);
    }
    if (declaration.erasure !== undefined && declaration.erasure !== true
      && (!declaration.erasure || typeof declaration.erasure !== 'object'
        || Object.keys(declaration.erasure).some((key) => !['prepare', 'tables', 'readTables'].includes(key))
        || !Array.isArray(declaration.erasure.tables)
        || declaration.erasure.tables.some((table: any) => typeof table !== 'string' || table.length === 0)
        || (declaration.erasure.readTables !== undefined
          && (!Array.isArray(declaration.erasure.readTables)
            || declaration.erasure.readTables.some((table: any) => typeof table !== 'string' || table.length === 0)))
        || typeof declaration.erasure.prepare !== 'function')) {
      throw new Error(`registered action '${declaration.type}' has an invalid erasure preparation`);
    }
    if (declaration.erasure && declaration.history?.cursor !== 'excluded') {
      throw new Error(`erasure action '${declaration.type}' must exclude its history cursor`);
    }
    // The bounded protected-artefact store is validated here so a malformed
    // declaration fails at app assembly, never at dispatch time.
    const protectedArtefactTables = validateProtectedArtefactsDeclaration(declaration.protectedArtefacts, declaration.type);
    if (handlers[declaration.type]) throw new Error(`action '${declaration.type}' is already registered`);

    // Registered-action composition (scope#992 W2): delegated to the
    // annotated-text kernel seam so kernel.ts stays a thin assembler.
    const composedAnnotated = compileComposedAnnotatedTextAction(declaration, entities, app.db);
    const compoundContributionPolicy = composedAnnotated?.compoundContributionPolicy ?? null;
    // Pending-blob claim validation, attestation scanning, and canonical
    // metadata rewriting belong to the module that owns the blob seam
    // (pending-blob.ts) — kernel stays a thin assembler.
    const handler = async (context: any) => {
      const commit = await runDeclaredActionWithBlobClaims({
        declaration, context, lifecycle: app.pendingBlobLifecycle,
      });
      return tagRegisteredActionEvents(commit, declaration.type);
    };
    if (composedAnnotated != null) compoundPolicies.push(composedAnnotated.contributionPolicy);
    // An action wrapped by `atomicOperation(...)` (S3/A6) carries its
    // in-transaction read + resolution registration on the raw handler. The
    // wrapper must forward it — commitEvents resolves and field-admits atomic
    // operations off the REGISTERED handler it runs, so an app-level atomic
    // action behaves exactly like the package-internal path.
    attachHandlerPolicy(handler, {
      inTransaction: true,
      ownedResources: declaration.ownedResources === true,
      ownedResourcePlans: declaration.ownedResources === true ? app.searchPlugins.purgePlans() : undefined,
      batchForbidden: compoundContributionPolicy != null
        || (app._blobLifecycleOptions?.fields ?? []).some((field: any) => field.actionName === declaration.type)
        || protectedArtefactTables.length > 0,
      erasureCapable: Boolean(declaration.erasure),
      erasurePrepare: declaration.erasure === true ? undefined : declaration.erasure?.prepare,
      erasurePreparationTables: declaration.erasure && declaration.erasure !== true
        ? Object.freeze([...declaration.erasure.tables]) : Object.freeze([]),
      erasurePreparationReadTables: declaration.erasure && declaration.erasure !== true
        ? Object.freeze([...(declaration.erasure.readTables ?? [])]) : Object.freeze([]),
      protectedArtefactTables,
      privateFactProjection: declaration.projections?.some((projection: any) => projection?.privateFact === true) ?? false,
      compoundContributionPolicy: composedAnnotated?.compoundContributionPolicy,
      dedupeReceiptMatches: composedAnnotated?.dedupeReceiptMatches,
      atomicOperation: declaration.handler?.atomicOperation,
    });
    handlers[declaration.type] = handler;
    for (const projection of declaration.projections ?? []) {
      if (!Array.isArray(projection?.eventTypes) || typeof projection.apply !== 'function') {
        throw new Error(`registered action '${declaration.type}' has an invalid projection`);
      }
      if (projection.privateFact !== undefined && projection.privateFact !== true) {
        throw new Error(`registered action '${declaration.type}' projection privateFact must be true when present`);
      }
      // Retain the declaring action identity internally. Event names are not a
      // private-fact authority: two actions may emit the same event type, but a
      // projection may observe only its own action's private canonical fact.
      projections.push(Object.freeze({ ...projection, actionType: declaration.type }));
    }
    // Registered action cursor policy from declaration metadata
    // Closed keys: only 'cursor' is valid on the history object
    const historyMeta = declaration.history;
    if (historyMeta !== undefined) {
      if (typeof historyMeta !== 'object' || historyMeta === null) {
        throw new Error(`registered action '${declaration.type}' history must be an object`);
      }
      const unknownKeys = Object.keys(historyMeta).filter((k) => k !== 'cursor');
      if (unknownKeys.length > 0) {
        throw new Error(`registered action '${declaration.type}' history has unknown keys '${unknownKeys.join(', ')}'`);
      }
      const policy = historyMeta.cursor;
      if (policy !== undefined) {
        if (policy !== 'eligible' && policy !== 'excluded') {
          throw new Error(`registered action '${declaration.type}' has invalid history.cursor '${policy}'`);
        }
        cursorPolicy.set(declaration.type, policy);
        // A composed action's undo/redo is one outer re-dispatch with
        // handler-only compound input (scope#992 rev 3 §1); the contribution
        // policy plans the document compensation and the package validator
        // gates the application transition. The translator registration is W2
        // compile work; the contribution-policy move execution rolls out under
        // W3 (#145).
        if (composedAnnotated != null && policy === 'eligible') {
          historyActions[declaration.type] = composedAnnotated.historyAction;
        }
      }
    }
  }
  return { handlers, projections, entities, cursorPolicy, historyActions, compoundPolicies };
}

function buildEffects(entities: Map<string, any>) {
  const effectsRegistry = buildEffectsRegistry([...entities.values()]);
  if (effectsRegistry.size > 0) {
    const forValidation = [...entities.values()];
    for (const fe of FRAMEWORK_ENTITIES) {
      if (fe && !entities.has(fe.name)) forValidation.push(fe);
    }
    validateEffects(forValidation);
  }
  return effectsRegistry;
}

function buildDurableAdmission(app: any, annotatedKernel: any) {
  const annotatedMutation = createAnnotatedTextMutationAdmission({
    entities: app.entities ?? new Map(),
    registration: app._annotatedTextAdmission,
  });
  // The bypass is keyed on the event type AND on provenance: the event must
  // have come from a registered action (its handler stamped the action type on
  // the event), not from generated CRUD that happens to emit the same event
  // type. Any registered action may emit a shared event type that another
  // registered action declares a projection on; generated CRUD may never borrow
  // that bypass, so Doc.create / Doc.remove keep their full admission gates.
  const registeredEventTypes = new Set<string>(
    (app.actions ?? []).flatMap((action: any) =>
      (action.projections ?? []).flatMap((projection: any) => projection.eventTypes ?? [])),
  );
  function isRegisteredActionProjectionEvent(event: any): boolean {
    return typeof event?.[REGISTERED_ACTION_EVENT] === 'string'
      && registeredEventTypes.has(event?.type);
  }
  function admissionRowId(event: any) {
    // Native field events are scoped to their parent row as `owner`; lifecycle
    // events use their entity row `id` (and may independently declare an owner
    // field). The parsed handle is the authoritative discriminator.
    return event?.handle?.kind === EventKind.native
      ? event.data?.owner ?? event.data?.id
      : event?.data?.id;
  }
  async function admitsExistingRow({ entityName, verb, principal, event }: any) {
    const entity = app.entities?.get(entityName);
    if (!entity) return false;
    const id = admissionRowId(event);
    if (id == null) return false;
    let row = null;
    try {
      row = entity.findById(String(id), principal);
    } catch {
      row = null;
    }
    // The injected authorization adapter (listen({ authorization })) is THE
    // admission engine for the whole app; with none injected the framework
    // row-grant default runs, unchanged. This is the same proposed-transition
    // seam the generated CRUD handlers use, so a durable-gate current-row check
    // can never contradict the handler's adapter-governed transition admission.
    return admitRowTransition({
      entity,
      verb,
      before: row,
      principal,
      authorization: app._authorization,
    });
  }
  return {
    ...(annotatedMutation === null ? {} : { annotatedMutation }),
    async beforeProjection({ entityName, verb, principal, event, payload, db: hookDb, now }: any) {
      if (isRegisteredActionProjectionEvent(event)) return true;
      if (event?.[CASCADE_PREAUTHORIZED]) return true;
      if (admitInvitationAcceptance({ event, principal })) return true;
      if (
        entityName === Invitation.name
        && verb === 'create'
        && isInvitationCreationAuthority(principal)
      ) {
        return admitInvitationCreation({
          Invitation: app.entities?.get(Invitation.name),
          event,
          principal,
        });
      }
      if (principal?.type === 'system' && principal.attributes?.source) {
        const entity = app.entities?.get(entityName);
        if (!entity) return false;
        return admitSystemMutation({
          entity,
          verb,
          rowId: admissionRowId(event),
          payload,
          principal,
          db: hookDb ?? app.db,
          now: now ?? Date.now(),
        });
      }
      if (principal?.type === 'system' && principal.attributes?.effect && verb !== 'create') {
        const granted = await admitsExistingRow({ entityName, verb, principal, event });
        if (granted && verb === 'update') {
          rearmChangedScheduleReceipts({
            entity: app.entities?.get(entityName),
            event,
            principal,
            db: hookDb ?? app.db,
          });
        }
        return granted;
      }
      if (verb === 'update' || verb === 'remove') {
        // The generated CRUD handler's own proposed-transition admission
        // (admitRowTransition) is the ONE governing gate for these events: it
        // evaluates the target row through the injected adapter
        // (app._authorization) on update AND remove, on /action, /batch, and
        // REST CRUD alike. This durable gate must not re-admit the current row
        // through the adapter on top of that — a duplicate consultation that
        // could contradict the handler's decision. With no adapter injected
        // the framework row-grant default still runs here, unchanged
        // (defense in depth over the same framework engine).
        const durableAdmission = app._authorization
          ? true
          : await admitsExistingRow({ entityName, verb, principal, event });
        const granted = durableAdmission
          && await annotatedKernel.admitProject({ entityName, verb, principal, event }, app);
        if (granted) {
          rearmChangedScheduleReceipts({
            entity: app.entities?.get(entityName),
            event,
            principal,
            db: hookDb ?? app.db,
          });
        }
        return granted;
      }
      return annotatedKernel.admitProject({ entityName, verb, principal, event }, app);
    },
    async afterProjection({ entityName, verb, principal, event, db: hookDb }: any) {
      if (isRegisteredActionProjectionEvent(event)) return true;
      if (
        entityName === Invitation.name
        && verb === 'create'
        && isInvitationCreationAuthority(principal)
      ) return true;
      if (verb === 'remove') {
        clearRemovedScheduleReceipts({
          entity: app.entities?.get(entityName),
          rowId: event?.data?.id,
          db: hookDb ?? app.db,
        });
      }
      if (verb !== 'create') return annotatedKernel.admitProject({ entityName, verb, principal, event }, app);
      return (await admitsExistingRow({ entityName, verb, principal, event }))
        && await annotatedKernel.admitProject({ entityName, verb, principal, event }, app);
    },
  };
}

// Post-commit consumers are contributed by the module that owns each seam.
// Kernel only assembles engaged seams — it does not implement fanout/latch,
// and it does not branch on kind: recovery mechanics live inside each
// consumer's own module (blob-lifecycle.mjs, projected-async.mjs,
// durable-effects.mjs, email-seam.mjs), never here. The `kind` tag below is
// documentation-as-data — it makes the recovery contracts a consumer can have
// visible at the one place they're assembled, instead of leaving a reader to
// infer it per-module:
//
//   - 'durable-projection-consumer' — advances a per-scope _ConsumerCursor
//     atomically with its work; a boot-time reconcile sweep (wired in
//     application-runtime.mjs) replays any scope whose _Log outran its
//     cursor. blob.finalize, projected.async, effect.durable, email, and
//     search-staleness all share this MECHANISM — but not the same idempotency
//     property: blob.finalize's underlying work (a filesystem rename) is
//     provably safe to replay (blob-store.mjs), so its replay is exactly-once in
//     effect even though
//     the mechanism is at-least-once. email's underlying work (an external
//     transport call) is NOT provably idempotent — a replay after a crash
//     between a successful send and its cursor write can duplicate the send.
//     This is documented, honest, at-least-once (email-seam.mjs), not
//     exactly-once — the taxonomy names the recovery MECHANISM, not a promise
//     that every consumer's side effect is safe to repeat.
//   - 'live-delivery-consumer' — re-authorizes at delivery time; the CLIENT
//     (not a server-side cursor) owns the reconnect/replay decision. Folding
//     this into the cursor contract above would be a second recovery model
//     for the same problem (AGENTS.md's no-second-path rule) — it stays
//     separate on purpose. app.live.createConsumer.
//   - 'best-effort-external-consumer' — no cursor, no reconcile sweep at all:
//     a crash between COMMIT and this consumer running silently drops the
//     work with no replay. Honestly at-least-once is a claim this kind
//     CANNOT make; it is unknown-handoff. No shipped consumer uses this kind
//     since search-staleness became cursor-backed (Wave 1); the taxonomy keeps
//     it named so a future unacknowledged handoff must declare itself as such
//     rather than quietly reusing the durable contract.
//
// A fourth kind named by the Wave 5/6 design council but not represented in
// this array — 'clock-driven maintenance starter' (the blob and log-retention
// reapers) — is registered on app.clock directly (application-runtime.mjs),
// not as a post-commit consumer: it runs on a timer, not per committed batch.
export const POST_COMMIT_CONSUMER_KINDS = Object.freeze([
  'durable-projection-consumer',
  'live-delivery-consumer',
  'best-effort-external-consumer',
]);

// The post-commit consumers wired into the app kernel's LIVE mutation lane
// (S3/A8, #114). The live lane writes no `_Log` row, so only the event-driven
// consumers with live meaning are engaged: live delivery (the lane's whole
// purpose), blob finalize (a live entity may carry blob fields — the in-txn
// adopt still needs its post-commit finalize), the projected.async recompute
// (a live row can declare projected fields), and the search-staleness ledger
// (whose `tier` column explicitly supports 'live'). The `_Log`-cursor-driven
// consumers stay on the durable lane: email + operational sweep committed
// `_Log` rows, durable effects anchor jobs to `_Log` seqs (live events have
// none), and the pending-blob reconcile scans its own claim table.
//
// RESTRICTION (#114 review #2): a live-tier entity must not rely on any of the
// excluded consumers. entity/compile.ts refuses durable effects on a live-tier
// entity at declaration (and buildDurableEffectsRegistry re-refuses raw
// records at registration); email + operational consumers are `_Log`-anchored
// and can never observe a live event, so a live action must not emit the event
// types they subscribe to. A live entity that needs one of these delivery
// paths must route that work through a history-tier entity instead.
const LIVE_LANE_CONSUMER_NAMES = new Set([
  'blob.finalize',
  'live',
  'projected.async',
  'search-staleness',
]);

function engagedPostCommitConsumerDescriptors(app: any, entities: any, { blobFinalizeConsumer, pendingBlobConsumer, durableEffectsRegistry, operationalConsumer }: any) {
  return [
    { name: 'blob.finalize', kind: 'durable-projection-consumer', consumer: blobFinalizeConsumer },
    { name: 'pending-blob.finalize', kind: 'durable-projection-consumer', consumer: pendingBlobConsumer },
    { name: 'live', kind: 'live-delivery-consumer', consumer: app._applicationLiveDelivery?.consumer ?? app.live?.createConsumer?.(app) },
    { name: 'projected.async', kind: 'durable-projection-consumer', consumer: createProjectedAsyncConsumer({ entities }) },
    { name: 'effect.durable', kind: 'durable-projection-consumer', consumer: createDurableEffectsConsumer({ durableEffectsRegistry, jobs: app.jobs }) },
    { name: 'email', kind: 'durable-projection-consumer', consumer: app._emailConsumer },
    { name: 'operational', kind: 'durable-projection-consumer', consumer: operationalConsumer },
    // The S4/A2 staleness ledger intake (review #109 finding 2): every
    // committed lifecycle event becomes a durable source-change record with its
    // committedAt proof. Cursor-backed since Wave 1 — recording + cursor advance
    // share one transaction, and application-runtime's boot sweep replays any
    // _Log row missed in the commit→notify window (see the taxonomy above).
    // Absent when the app never constructed the bridge (raw buildKernel usage).
    { name: 'search-staleness', kind: 'durable-projection-consumer', consumer: app.searchStaleness ? createSearchStalenessConsumer(app.searchStaleness) : null },
    // Query invalidation is a READ-side post-commit signal. When an app has
    // installed the hub (ensureQueryInvalidationHub), register it as a normal
    // kernel consumer so it flows through the SAME post-commit pipeline as
    // every other fan-out — not a transport-side observer bolted onto dispatch.
    // Unknown handoff by design: a dropped notice only causes a client refetch,
    // so its honest kind is best-effort-external, never cursor-backed.
    { name: 'query-invalidation', kind: 'best-effort-external-consumer', consumer: app.queryInvalidationHub ? createQueryInvalidationConsumer(app.queryInvalidationHub, app.db) : null },
  ].filter((d) => Boolean(d.consumer));
}

export function buildKernel(app: any) {
  const { handlers, projections, entities, cursorPolicy, historyActions: composedHistoryActions, compoundPolicies } = collectAppEntities(app);
  const generatedHistoryActions: Record<string, any> = {};
  for (const entity of entities.values()) {
    if (entity.historyActionRule) generatedHistoryActions[`${entity.name}.update`] = entity.historyActionRule;
    if (entity.createHistoryActionRule) generatedHistoryActions[`${entity.name}.create`] = entity.createHistoryActionRule;
  }
  Object.assign(generatedHistoryActions, composedHistoryActions);
  const sessionEntity = entities.get(Session.name);
  if (sessionEntity && app._sessionSchedule) {
    Object.defineProperty(sessionEntity, 'schedule', {
      value: app._sessionSchedule,
      enumerable: true,
      configurable: true,
    });
  }
  for (const fe of FRAMEWORK_ENTITIES) {
    if (fe && !entities.has(fe.name)) {
      const bound = app.entity(fe);
      // Session timing is app configuration, so override only the declarative
      // schedule while retaining the app-bound query and mutation closures.
      const entity = bound;
      entities.set(entity.name, entity);
      Object.assign(handlers, entity.crudHandlers);
      projections.push(entity.projection);
    }
  }
  installRemovalCascades(entities);
  app.entities = entities;

  const effectsRegistry = buildEffects(entities);
  const durableEffectsRegistry = buildDurableEffectsRegistry([...entities.values()]);
  const { blobAdapter, blobFinalizeConsumer, census, reconcileBlobFinalize } = createBlobLifecycle({
    blobs: app.blobs,
    entities,
    declaredBlobFields: app._blobLifecycleOptions?.fields ?? [],
  });
  app.blobCensus = census;
  if (app._blobLifecycleOptions) {
    // S6/A5 #21: the pending-blob delete path reads the named deleted-file /
    // privacy-erasure policies from the maintenance surface through the single
    // central evaluator (retentionMs) — never its own TTL literals.
    app.retentionPolicies = app._maintenance?.blobRetention;
    app.pendingBlobLifecycle = createPendingBlobLifecycle(app, app._blobLifecycleOptions);
  }
  app.durableEffectsRegistry = durableEffectsRegistry;
  app.reconcileBlobFinalize = reconcileBlobFinalize;
  // The search staleness ledger shares the bridge the app constructed at
  // workbench() time. Expose its cursor-backed boot sweep here (alongside the
  // other reconcilers kernel owns) so application-runtime can replay any commit
  // the post-commit consumer never saw. No-op when no bridge was constructed.
  app.reconcileSearchStaleness = app.searchStaleness
    ? () => reconcileSearchStaleness(app.db, app.searchStaleness)
    : async () => ({ recorded: 0, blocked: 0 });
  // emailSeam(...).install(app) (called by the app author before .listen(),
  // per email-seam.mjs's contract) stashes its reconcile sweep on app._... —
  // pick it up here alongside the other reconcile sweeps kernel already owns.
  // No-op default when the email seam was never installed.
  app.reconcileEmailDelivery = app._reconcileEmailDelivery ?? (async () => ({ delivered: 0 }));
  const operational = createOperationalConsumers(app.operationalConsumers as any, {
    writeQueue: app.writeQueue,
    onShutdown: app.onShutdown,
  } as any);
  operational.engage(app.db);
  app.reconcileOperationalConsumers = () => operational.reconcile(app.db);

  const postCommitConsumerDescriptors = engagedPostCommitConsumerDescriptors(app, entities, {
    blobFinalizeConsumer,
    pendingBlobConsumer: app.pendingBlobLifecycle?.consumer,
    durableEffectsRegistry,
    operationalConsumer: operational.declared.length ? operational.consumer : null,
  });
  app.postCommitConsumerDescriptors = postCommitConsumerDescriptors;
  const privateFactProjections = projections.filter((projection) => projection.privateFact === true && projection.replay !== false);
  app.replayPrivateFactProjections = () => app.writeQueue.run(
    () => txn(app.db, () => replayPrivateFactProjections(app.db, privateFactProjections)),
  );

  const registeredActions = new Map<string, any>((app.actions ?? []).map((action: any) => [action.type, action]));
  const annotatedKernel = createAnnotatedTextKernelSeam(entities);
  Object.assign(generatedHistoryActions, annotatedKernel.historyActions);

  // Assemble the compile-produced contribution-policy registry (scope#992
  // Findings 6/7): native insert policies from the annotated declarations plus
  // the compound policies compiled from registered `operations` handles, keyed
  // by outer action type. The registry drives history authorization ordering;
  // grants stay with the central authorize/admitRow seam. `privateHistoryScopes`
  // is the declaration-derived read-privacy set for the history read boundary.
  const contributionPolicies = createHistoryContributionPolicyRegistry({
    policies: [...annotatedKernel.nativeInsertPolicies, ...compoundPolicies],
    privateHistoryScopes: annotatedKernel.privateHistoryScopes,
  });

  // S3/A8 — wire the live (no-history) mutation lane into the app kernel
  // (JavaGT/workbench#114). `tierOfEvent` resolves an emitted event's handle to
  // its entity's live-data tier: a `live`-tier entity routes through the live
  // variant (no `_Log` append, `_LiveRevision` bump + `_InvalidationLedger`
  // marker, `_NoHistoryReceipt` idempotency, no `_ActionReceipt` payload
  // retention); everything else takes the durable lane byte-for-byte. Without
  // a database there is no durable lane to fork from and no live pipeline to
  // wire (its revision/receipt/invalidation tables exist only on a real
  // database), so the kernel keeps its ephemeral in-memory path — but the tier
  // resolver is STILL supplied, so the in-memory dispatch fails closed on any
  // live-tier mutation instead of silently degrading it to the durable
  // in-memory log (#114 review #1). The live pipeline shares the SAME
  // projection, admission, blob-adoption, and in-txn effect machinery as the
  // durable lane — only the post-commit fan-out is the live-relevant subset
  // (LIVE_LANE_CONSUMER_NAMES).
  const tierOfEvent = (handle: any): DataTier | undefined => {
    if (!handle || typeof handle.entity !== 'string') return undefined;
    return entities.get(handle.entity)?.tier === 'live' ? 'live' : 'history';
  };
  const livePostCommitConsumers = postCommitConsumerDescriptors
    .filter((descriptor) => LIVE_LANE_CONSUMER_NAMES.has(descriptor.name))
    .map((descriptor) => descriptor.consumer);

  // Generated CRUD is authorized by row admission. Registered actions own an
  // explicit authorization function which runs at both durable auth gates.
  return createServer({
    handlers,
    authorize: async (context) => {
      const annotatedVerdict = await annotatedKernel.authorize(context, app);
      if (annotatedVerdict !== null) return annotatedVerdict;
      const declaration = registeredActions.get(context.type);
      if (!declaration) {
        const [entityName, verb] = String(context.type).split('.');
        const entity = (verb === 'update' || verb === 'create' || verb === 'remove') ? app.entities?.get(entityName) : null;
        if (!entity
          || (verb === 'update' && !entity.conditionalHistory)
          || (verb === 'create' && !entity.conditionalCreateHistory)
          || (verb === 'remove' && !entity.conditionalCreateHistory)) return true;
        const id = context.payload?.id;
        if (typeof id !== 'string' || id.length === 0) return false;
        const stored = rawRow(app.db, entity.name, id)
          ?? (verb === 'create' ? readDeletedRowAnchor(app.db, entity.name, id) : null);
        // Initial creates have no row (or deletion anchor) to authorize yet;
        // normal lifecycle admission remains their authority. A history move
        // always has either the live row or its deletion anchor to check.
        if (!stored) return verb === 'create';
        const row = entity.deserializeRow({ ...stored });
        // The generated update handler's own proposed-transition admission
        // (admitRowTransition) is the ONE governing gate for an update move: it
        // evaluates BOTH the current row and the proposed after-row through the
        // injected adapter (app._authorization) exactly once. This pre-gate must
        // not re-run a second framework-default admission of the current row —
        // that would bypass the adapter and reject a transition the adapter
        // admits. A redo-create (undo of a remove) has no handler-side
        // transition admission, so its deletion-anchor admission is rerouted
        // through the same adapter-aware seam instead.
        if (verb === 'update') return true;
        if (verb === 'remove' && !app._authorization) {
          // The generated remove handler is the one gate for framework-default
          // admission. A HISTORY undo of a create has no handler-side transition
          // admission, so consult the injected adapter here when one exists;
          // without one, defer to the handler as before.
          return true;
        }
        return admitRowTransition({
          entity,
          verb: 'remove',
          before: row,
          principal: context.principal,
          authorization: app._authorization,
        });
      }
      // A composite (authorizedRows) action evaluates every affected row through
      // ONE adapter admit() call. The app's injected adapter (listen({ authorization }))
      // is THE admission engine for the whole app — HTTP, live, and these durable
      // actions alike; with none injected the framework default runs, unchanged.
      const authorize = isAuthorizedRows(declaration.authorize)
        ? bindAuthorizedRows(declaration.authorize, app, app._authorization)
        : declaration.authorize;
      return authorize({ ...context, db: app.db });
    },
    db: app.db,
    writeQueue: app.writeQueue,
    onConsumerError: app.onConsumerError,
    commitHook: annotatedKernel.commitHook,
    history: app._history,
    historyActions: generatedHistoryActions,
    cursorPolicy,
     contributionPolicies,
    // The app's injected authorization adapter (S5/A2) is THE admission engine
    // for the whole app — HTTP, live, registered actions, and the generated
    // CRUD handlers alike; with none injected each seam keeps its framework
    // default, unchanged. Threading it through createServer lets the CRUD
    // handlers pass it to the proposed-transition update admission.
    authorization: app._authorization,
    pipeline: durableMutationVariant({
      projectionConsumers: projections,
      admission: buildDurableAdmission(app, annotatedKernel),
      blobAdapter: blobAdapter as any,
      effectsRegistry: effectsRegistry.size > 0 ? effectsRegistry : null,
      executeEffectsForEvent,
      postCommitConsumers: [
        // A job enqueued inside the dispatch transaction buffers its live wake
        // until the outer commit. Release it here, on the post-commit lane,
        // before the normal consumers run (the kernel owns the commit boundary).
        () => { (app.jobs as { flushEvents?: () => number } | null | undefined)?.flushEvents?.(); },
        ...postCommitConsumerDescriptors.map((d) => d.consumer),
      ],
      onConsumerError: app.onConsumerError,
      // Composite journal routing (#122): compiled patch plans from the
      // attached live delivery. Undefined when no snapshots are declared —
      // journaling is skipped entirely and legacy behavior is unchanged.
      compositeJournal: ((app as { _compositeJournalPlans?: ReadonlyMap<string, unknown> | null })._compositeJournalPlans
        ? {
          plans: (app as { _compositeJournalPlans: ReadonlyMap<string, unknown> })._compositeJournalPlans,
          // Entities that gate other rows' visibility (cross-exam 9): a change
          // to any of these invalidates every composite that projects them.
          authorizationDependencies: (app as { _compositeAuthorizationDependencies?: readonly string[] })._compositeAuthorizationDependencies ?? ['User'],
        }
        : undefined),
    }),
    // The no-history mutation lane (S3/A2, #100): engaged only when a database
    // exists (createServer fails closed otherwise), always paired with its
    // tier resolver so a `live`-tier entity can never fall through to `_Log`.
    // The tier resolver is wired EVEN without a database: the in-memory
    // dispatch path uses it to refuse live-tier mutations (dispatch-time
    // fail-closed, #114 review #1) — a live entity must never silently degrade
    // to the in-memory durable log.
    livePipeline: app.db ? liveMutationVariant({
      projectionConsumers: projections,
      admission: buildDurableAdmission(app, annotatedKernel),
      blobAdapter: blobAdapter as any,
      effectsRegistry: effectsRegistry.size > 0 ? effectsRegistry : null,
      executeEffectsForEvent,
      postCommitConsumers: livePostCommitConsumers,
      onConsumerError: app.onConsumerError,
    }) : undefined,
    tierOfEvent,
  });
}
