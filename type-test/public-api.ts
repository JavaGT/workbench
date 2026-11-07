import workbench, {
  action, event, entity, text, date, ref, number, projected, computed, ephemeral, inherit, log, state,
  schedule, tick,
  admin, authorizedRows, principal, read, write, grant, membership, parseCookies, SESSION_COOKIE,
  apiKeyPrincipalOf, createInvitationApi as createRootInvitationApi, emailSeam,
  FAILURE_CATEGORIES, failure, failureOutcome, isWorkbenchFailure, sanitizeUnexpectedFailure,
  createAuditor, createDenialAuditor, isOpaqueId, sanitizeOpaqueId, noopAuditSink,
  matchRoute, noopTransport, serveStatic, sessionCookie, sessionPrincipalOf,
  sessionTokenOf, registerAnnotatedTextStructuralExtension as registerRootAnnotatedTextStructuralExtension,
  durableHistory,
  acknowledge, atomicOperation, claim, executeAtomicOperation, executeAtomicOperations, increment,
  isAtomicOperation, setAdd, setRemove, toggleTo,
  normalizeTierDeclaration, tierOf, isDataTier, isEntityTier, DATA_TIERS, ENTITY_TIERS, TIER_DESCRIPTIONS,
  type DataTier, type EntityTier, type HistoryMode, type HistoryVerb, type HistoryVerbMode,
  type ResolvedTier, type TierDeclaration,
  type OperationalConsumerName, type OperationalEffectResult,
  type ActionHandle, type BatchAction, type CommittedEvent, type DispatchRequest,
  type DispatchResult, type EventHandle, type FailureCategory, type FailureOutcome,
  type InheritDirective, type Principal, type WorkbenchFailure,
  type AuditActor, type AuditClassification, type AuditEvent, type AuditInput, type AuditOutcome,
  type AuditSink, type Auditor, type AuditorOptions, type DenialAuditor, type DenialInput,
  type RetentionConfig,
  type ErasurePreparationContext, type ErasurePreparationReads,
  type AtomicExecution, type AtomicOperation, type AtomicOperationContext, type AtomicOperationHandler, type AtomicOperationRegistration,
  type OrdinaryRegisteredProjection, type PrivateFactRegisteredProjection,
  type DeclaredClaimedBlob, type RegisteredAction, type WorkbenchApp, type WorkbenchEntity, type WriteQueue,
} from 'workbench';
import {
  assertNoFrameworkTableSql, compileBlobCensus, createBlobStore, createInvitationApi, createJobQueue, createLiveDelivery, declaredBlobField, declaredTableNames,
  frameworkTableNames, readCommittedCursor,
  runMigrations, describeEntityStorage, describeSqliteStorage,
  claimedBlobLifecycle, operationalConsumerAdmin, createPostCommitEffectRunner,
  type BlobStore, type SqliteStorageDescription,
  type Invitation, type JobQueue, type JobRow, type LiveDelivery, type LiveDeliveryActivation, type LiveDeliveryBootstrap, type LiveDeliveryCatchup, type LiveDeliveryEnvelope as ServerLiveDeliveryEnvelope, type Migration, type UserPrincipal,
  type ClaimedBlobLifecycle, type ClaimedBlobLifecycleState, type WorkbenchDatabase, type OperationalConsumerAdmin, type OperationalFailure, type PostCommitEffectRunner,
  type OperationalRetry as ServerOperationalRetry,
   type ByteStore, type ByteStoreCapabilities, type ByteStoreDurability,
   type BlobCleanupState,
   createSearchPluginRegistry, createSearchSourceReader, createSearchOwnedIndexCapability, createVectorPlugin,
   type SearchPlugin, type SearchPluginContext, type SearchOwnedIndex, type SearchSourceReader,
   type SearchOwnedIndexCapabilityOptions, type VectorPlugin,
 } from 'workbench/server';
import {
  LiveChannel, LiveList, WorkbenchFailureError, createAuthClient, createLiveStore,
  createLiveDeliverySession, createScopeLiveStore, decodeResult, materializeAnnotatedTextSnapshot,
  type EventsSinceResponse, type LiveDeliveryCursor as ClientLiveDeliveryCursor, type LiveDeliverySession, type LiveStore, type ScopeLiveStore, type SnapshotResponse,
  type StaleResponse, type WsEnvelope,
  type LiveDeliverySettlement, type ScopeDispatchResult,
} from 'workbench/client';
import {
  annotatedText, annotation, annotationAction, measurement, protectingAnnotation,
  annotatedTextAction, annotatedTextCreateAction,
  registerAnnotatedTextContract,
  registerAnnotatedTextStructuralExtension,
  type AnnotatedTextFieldHandle, type AnnotatedTextOptions,
  type AnnotatedTextCanonicalDocument, type AnnotatedTextRecipientDocument,
} from 'workbench/annotated-text';
import {
  changedRange, classifyDisplayOffset, displayToWirePosition, placeholderDisplayWidth,
  scalarEnd, scalarStart,
  selectionCrossesDisplayRedaction, wireToDisplayPosition,
  type AnnotatedTextChangedRange, type AnnotatedTextCoordinatedPosition,
  type AnnotatedTextRange, type AnnotatedTextRedactionMarker,
} from 'workbench/annotated-text-coords';
import {
  acknowledgeAndPruneSnapshot, buildAuthoringEnvelope, ensureLease, ensureStream,
  hashClientNonce, issueAuthoringSnapshot, projectEndpointToOffset,
  restoreTextFamilySerialized, textFamilyBasis,
  type AuthoringDatabase, type AuthoringFrontier, type AuthoringSnapshot,
  type ContinuousTextFamily, type AuthoringStructuralEndpoint,
} from 'workbench/annotated-text-authoring';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';

// ── S3/A1 live-data tier vocabulary (published surface) ────────────────────
const allTiers: readonly DataTier[] = DATA_TIERS;
const entityOnlyTiers: readonly EntityTier[] = ENTITY_TIERS;
const derivedDescription: string = TIER_DESCRIPTIONS.derived;
const tierPredicate: boolean = isDataTier('derived') && isEntityTier('live');
const historyVerb: HistoryVerb = 'create';
const reservedNoneMode: HistoryVerbMode = 'none';
const conditionalMode: HistoryMode = 'conditional';
const resolvedTier: ResolvedTier = { tier: 'live' };
const liveOnlyResolved: ResolvedTier = normalizeTierDeclaration({ live: true });
const tierDeclaration: TierDeclaration = { history: { create: 'none' }, live: true };
const classifiedTier: DataTier = tierOf({ live: true });
void [allTiers, entityOnlyTiers, derivedDescription, tierPredicate, historyVerb, reservedNoneMode, conditionalMode, resolvedTier, liveOnlyResolved, tierDeclaration, classifiedTier];

const atomicValue: AtomicOperation = increment('count');
const atomicExecution: AtomicExecution = executeAtomicOperations({ count: 0 }, [atomicValue]);
const atomicContext: AtomicOperationContext = {
  payload: { atomicOperations: [atomicValue] }, principal: null, db: {}, now: '', scope: '', actionId: '',
};
const atomicRegistration: AtomicOperationRegistration = {
  entity: entity('AtomicNote', { count: number(), grant: grant(read) }),
  read: () => ({ count: 0 }),
};
const atomicHandler: AtomicOperationHandler = atomicOperation(atomicRegistration, ({ atomic }) => {
  const one = executeAtomicOperation(atomic.row, increment('count'));
  return [one];
});
void [acknowledge, claim, executeAtomicOperation, increment, isAtomicOperation, setAdd, setRemove, toggleTo, atomicExecution, atomicContext, atomicHandler];

declare const claimedBlobApp: WorkbenchApp;
const claimedBlobApi: ClaimedBlobLifecycle = claimedBlobLifecycle(claimedBlobApp);
const claimedBlobState: ClaimedBlobLifecycleState = claimedBlobApi.inspect('blob-1');
if (claimedBlobState.kind === 'available') claimedBlobState.readRange([0, 1]);

const annotatedTextOptions: AnnotatedTextOptions = {
  project: 'project', owner: 'owner',
  annotations: [annotation('note', { actions: { pin: annotationAction({ change: () => ({ fields: {} }) }) } })],
  measurements: [measurement('wordCount', { extension: 'wordMeasurement' })],
};
const annotatedTextField = annotatedText(annotatedTextOptions);
const annotatedTextHandle: AnnotatedTextFieldHandle | undefined = annotatedTextField.__value;
const protecting = protectingAnnotation('restricted');
registerAnnotatedTextContract('wordMeasurement', { kind: 'measurement' });
registerRootAnnotatedTextStructuralExtension('wordMeasurement', {
  version: 1,
  validate: function validate(_input) {},
  edit: function edit(input) { return input; },
  partition: function partition(input) {
    return { version: 1, leftPayload: input.payload, rightPayload: input.payload };
  },
  combine: function combine(input) {
    return { version: 1, payload: input.left?.payload ?? input.right?.payload ?? null };
  },
});
registerAnnotatedTextStructuralExtension('invalidReturnMeasurement', {
  version: 1,
  // @ts-expect-error validators return undefined or throw
  validate: function validate(_input) { return true; },
  edit: function edit(input) { return input; },
  partition: function partition(input) {
    return { version: 1, leftPayload: input.payload, rightPayload: input.payload };
  },
  combine: function combine(input) {
    return { version: 1, payload: input.left?.payload ?? input.right?.payload ?? null };
  },
});
registerAnnotatedTextStructuralExtension('invalidAsyncMeasurement', {
  version: 1,
  // @ts-expect-error validators are synchronous
  validate: async function validate(_input) {},
  edit: function edit(input) { return input; },
  partition: function partition(input) {
    return { version: 1, leftPayload: input.payload, rightPayload: input.payload };
  },
  combine: function combine(input) {
    return { version: 1, payload: input.left?.payload ?? input.right?.payload ?? null };
  },
});
void [annotatedTextHandle, protecting];

// ── ScopeDispatchResult carries an optional settlement (workbench#72) ───────
// A legacy literal without a settlement must keep compiling (Scope deprecation
// path); a dispatched document-path result carries one, mirroring the shell.
const scopeResultWithoutSettlement: ScopeDispatchResult = { ok: true, status: 'committed', opId: 'op-1' };
declare const scopeResultWithSettlement: ScopeDispatchResult;
if (scopeResultWithSettlement.settlement) {
  const scopeSettlement: LiveDeliverySettlement = scopeResultWithSettlement.settlement;
  void scopeSettlement.wait();
}
const scopeFailedResultWithSettlement: ScopeDispatchResult = {
  ok: false,
  status: 'failed-rolled-back',
  opId: 'op-2',
  settlement: {
    opId: 'op-2',
    wait: async () => ({ opId: 'op-2', status: 'failed', error: new Error('failed') }),
  },
  failure: new Error('failed'),
};
const scopeUnknownResultWithSettlement: ScopeDispatchResult = {
  ok: false,
  status: 'outcome-unknown',
  opId: 'op-3',
  settlement: {
    opId: 'op-3',
    wait: async () => ({ opId: 'op-3', status: 'unavailable' }),
  },
  failure: new Error('unknown'),
};
void [scopeResultWithoutSettlement, scopeResultWithSettlement, scopeFailedResultWithSettlement, scopeUnknownResultWithSettlement];

declare const coordsMarkers: readonly AnnotatedTextRedactionMarker[];
const wirePosition: AnnotatedTextCoordinatedPosition = wireToDisplayPosition({ offset: 2, affinity: 'right' }, coordsMarkers);
const displayPosition: AnnotatedTextCoordinatedPosition = displayToWirePosition(wirePosition, coordsMarkers);
const displayOffset = classifyDisplayOffset(wirePosition.offset, coordsMarkers);
const crosses: boolean = selectionCrossesDisplayRedaction(wirePosition.offset, displayPosition.offset, coordsMarkers);
const placeholderWidth: number = placeholderDisplayWidth(coordsMarkers);
const scalarStartOffset: number = scalarStart('ab', 1);
const scalarEndOffset: number = scalarEnd('ab', 1);
const change: AnnotatedTextChangedRange = changedRange('ab', 'ac');
declare const sourceRanges: readonly AnnotatedTextRange[];
const offsetRange: AnnotatedTextRange = { annotationId: 'note-1', start: 0, end: 2 };
const anchoredRange: AnnotatedTextRange = {
  annotationId: 'note-1',
  start: { point: ['point', ['root'], 'left'], basisFrontier: [] },
  end: { point: ['point', ['root'], 'right'], basisFrontier: [] },
};
const offsetStart: number = typeof offsetRange.start === 'number' ? offsetRange.start : 0;
const anchoredPoint = typeof anchoredRange.start === 'number' ? null : anchoredRange.start.point;
void [displayPosition, displayOffset, crosses, placeholderWidth, scalarStartOffset, scalarEndOffset, change, sourceRanges, offsetRange, anchoredRange, offsetStart, anchoredPoint];

declare const annotatedTextEntity: WorkbenchEntity;
declare const requiredAnnotatedTextHandle: AnnotatedTextFieldHandle;
annotatedTextCreateAction(annotatedTextEntity, requiredAnnotatedTextHandle, { id: 'document-1', projectId: 'project-1', ownerId: 'owner-1' });
annotatedTextCreateAction(annotatedTextEntity, requiredAnnotatedTextHandle, {
  id: 'document-1', projectId: 'project-1', ownerId: 'owner-1',
  source: {
    text: 'hello',
    ranges: [{ annotationId: 'a1', family: 'note', start: 0, end: 5 }],
  },
});
// @ts-expect-error block-shaped create input does not exist; source is continuous text
annotatedTextCreateAction(annotatedTextEntity, requiredAnnotatedTextHandle, { id: 'document-1', projectId: 'project-1', ownerId: 'owner-1', source: { blocks: [{ text: 'hello', annotations: [] }] } });
// @ts-expect-error block-shaped create input does not exist; measurements come whole-document
annotatedTextCreateAction(annotatedTextEntity, requiredAnnotatedTextHandle, { id: 'document-1', projectId: 'project-1', ownerId: 'owner-1', source: { blocks: [{ text: 'hello', measurements: [{ id: 'raw-id', family: 'wordCount', formatVersion: 1, payload: {} }] }] } });
annotatedTextAction(annotatedTextEntity, requiredAnnotatedTextHandle, {
  kind: 'text.insert', id: 'document-1',
  authoring: { version: 1, stream: 'stream', lease: 'lease', mutationId: 'insert-1' },
  at: { positionToken: 'token', offset: 1, affinity: 'right' }, text: 'x',
});
// @ts-expect-error public positions carry an opaque position token, never blockId
annotatedTextAction(annotatedTextEntity, requiredAnnotatedTextHandle, { kind: 'text.insert', id: 'document-1', authoring: { version: 1, stream: 'stream', lease: 'lease', mutationId: 'insert-1' }, at: { blockId: 'block-1', offset: 1, affinity: 'right' }, text: 'x' });
// @ts-expect-error public positions require an authoring position token
annotatedTextAction(annotatedTextEntity, requiredAnnotatedTextHandle, { kind: 'text.insert', id: 'document-1', authoring: { version: 1, stream: 'stream', lease: 'lease', mutationId: 'insert-1' }, at: { offset: 1, affinity: 'right' }, text: 'x' });
// @ts-expect-error block commands are not part of the public command kinds
annotatedTextAction(annotatedTextEntity, requiredAnnotatedTextHandle, { kind: 'block.split', id: 'document-1', authoring: { version: 1, stream: 'stream', lease: 'lease', mutationId: 'split-1' }, at: { positionToken: 'token', offset: 1, affinity: 'right' } });
// @ts-expect-error public commands carry an authoring binding, not a bare mutationId
annotatedTextAction(annotatedTextEntity, requiredAnnotatedTextHandle, { kind: 'text.insert', id: 'document-1', mutationId: 'insert-1', at: { positionToken: 'token', offset: 1, affinity: 'right' }, text: 'x' });

// Blockless document shapes (issue #33): one continuous text, document-scoped ranges.
declare const canonicalDoc: AnnotatedTextCanonicalDocument;
const canonicalText: string = canonicalDoc.text;
const canonicalRanges: readonly { annotationId: string; start: number; end: number }[] = canonicalDoc.ranges;
declare const recipientDoc: AnnotatedTextRecipientDocument;
const recipientText: string = recipientDoc.text;
const recipientRanges: AnnotatedTextRecipientDocument['ranges'] = recipientDoc.ranges;
// @ts-expect-error the blockless canonical document has no blocks
canonicalDoc.blocks;
// @ts-expect-error the blockless canonical document has no memberships
canonicalDoc.memberships;
// @ts-expect-error the blockless recipient projection has no blocks
recipientDoc.blocks;
// @ts-expect-error the blockless recipient projection has no memberships
recipientDoc.memberships;
void [canonicalText, canonicalRanges, recipientText, recipientRanges];

declare const projectedAnnotatedTextSnapshot: Record<string, unknown>;
declare const compiledAnnotatedTextHandle: AnnotatedTextFieldHandle;
const projectedAnnotatedText = materializeAnnotatedTextSnapshot(
  projectedAnnotatedTextSnapshot,
  compiledAnnotatedTextHandle,
);
const projectedKind: 'workbench.annotatedText.recipient' = projectedAnnotatedText.kind;
const projectedText: string = projectedAnnotatedText.text;
const materializedRanges: readonly AnnotatedTextRange[] = projectedAnnotatedText.ranges;
// The materializer always projects the wire capabilityHints into a public
// `capabilities` array (restricted recipients are review-only with null).
const projectedCapabilities: readonly string[] | null = projectedAnnotatedText.capabilities;
// @ts-expect-error restricted recipients are review-only: capabilities is nullable
const grantedOnlyCapabilities: readonly string[] = projectedAnnotatedText.capabilities;
// @ts-expect-error recipient snapshots never expose authoring basis state
projectedAnnotatedText.basis;
// @ts-expect-error the continuous document has no synthetic blocks
projectedAnnotatedText.blocks;
// @ts-expect-error the continuous document has no memberships
projectedAnnotatedText.memberships;
// @ts-expect-error the continuous document has no caret blockId grammar
projectedAnnotatedText.blockId;
void [projectedKind, projectedText, materializedRanges, projectedCapabilities, grantedOnlyCapabilities];

type ProjectRow = { id: string; name: string; owner: string; summary: string };
const category: FailureCategory = FAILURE_CATEGORIES[0];
const expectedFailure: WorkbenchFailure = failure(category, 'Invalid project.', { field: 'name' });
const expectedOutcome: FailureOutcome = failureOutcome(expectedFailure);
const unexpectedFailure: WorkbenchFailure = sanitizeUnexpectedFailure(new Error('secret'));
const recognizedFailure: boolean = isWorkbenchFailure(expectedFailure);
void [expectedOutcome, unexpectedFailure, recognizedFailure];
const Project = entity('Project', {
  name: text(),
  owner: ref('User'),
  summary: projected.async({
    from: ['Project.created'],
    compute: async (row) => String(row.name ?? ''),
  }),
  grant: grant(read, write),
  routes: (routes) => routes.resource(),
});
entity('ProjectIndex', {
  name: text(),
  ownerId: ref('User'),
  indexes: [{ fields: ['ownerId', 'name'], unique: true }],
});
entity('ProjectIndexInvalid', {
  name: text(),
  ownerId: ref('User'),
  indexes: [
    // @ts-expect-error composite unique indexes require at least two declared fields
    { fields: ['ownerId'], unique: true },
  ],
});
const frameworkTables: readonly string[] = frameworkTableNames;
const projectTables: readonly string[] = declaredTableNames([Project]);
assertNoFrameworkTableSql('SELECT id FROM Project');
void [frameworkTables, projectTables];
declaredBlobField({
  actionName: 'file.upload', field: 'blob', resourceField: 'fileId',
  owningResource: 'File', erasureCategory: 'deletable',
  canonicalEventMetadata: { byteLength: ['file', 'size'], mediaType: ['file', 'mime'] },
});
// @ts-expect-error projected is a namespace; asynchronous projections use projected.async(...)
projected({ compute: async () => 'invalid' });

const Rename: ActionHandle<{ id: string; name: string }> = action('Project.rename');
const Renamed: EventHandle<ProjectRow, { name: string }> = event(
  'Project.renamed',
  (state, payload) => ({ ...state, name: payload.name }),
);

declare const db: WorkbenchDatabase;
const nativeDb = new DatabaseSync(':memory:');
const nativeApp: WorkbenchApp = workbench({ db: nativeDb });
const searchRegistry = createSearchPluginRegistry();
const searchReader: SearchSourceReader = createSearchSourceReader(null, {
  plugin: 'notes-vector', interests: [{ entity: 'Note' }],
});
const vectorPlugin: VectorPlugin = createVectorPlugin({
  id: 'notes-vector', version: '1',
  source: { entity: 'Note', vector: 'embedding', model: 'embeddingModel', owns: () => true },
  modelSpace: { model: 'text-embedding', dimensions: 3 },
  admission: undefined,
});
const searchPlugin: SearchPlugin = vectorPlugin;
nativeApp.registerSearchPlugin(searchPlugin);
const appSearchPlugins = nativeApp.searchPlugins;
declare const searchPluginContext: SearchPluginContext;
declare const searchOwnedIndex: SearchOwnedIndex;
declare const searchCapabilityOptions: SearchOwnedIndexCapabilityOptions;
const ownedIndexFor = createSearchOwnedIndexCapability(searchCapabilityOptions);
void [searchRegistry, searchReader, appSearchPlugins, searchPluginContext, searchOwnedIndex, ownedIndexFor];
const writeQueue: WriteQueue = nativeApp.writeQueue;
const queuedValue: Promise<number> = writeQueue.run(() => 1);
const owned: boolean = writeQueue.owned;
const nestedQueuedValue: Promise<number> = writeQueue.run(async () => writeQueue.run(() => 2));
const declaredStorage: SqliteStorageDescription = describeEntityStorage(Project);
const liveStorage: SqliteStorageDescription = describeSqliteStorage(nativeDb, []);
// @ts-expect-error raw declarations are not compiled entities and have no storage name/fields
describeEntityStorage({ grant: grant(read) });
void [declaredStorage, liveStorage];
void [nativeApp, queuedValue, owned, nestedQueuedValue];
const migration: Migration = { namespace: 'app', name: 'seed', version: 1, up: (database) => database.exec('SELECT 1') };
const app: WorkbenchApp = workbench({
  db,
  migrations: [migration],
  requireEnv: ['SESSION_SECRET'],
  blobReapIntervalMs: 60_000,
  blobReapTtlMs: 3_600_000,
  logRetentionDays: 30,
  logRetentionIntervalMs: 60_000,
  blobRetention: { replacedGenerationRetentionMs: 123_000 },
  blobLowDiskHeadroomBytes: 42,
}).mount('/projects', Project);
const startedApp: Promise<WorkbenchApp> = app.start();
app.onShutdown('typed cleanup', () => undefined, { timeoutMs: 1000 });
const stoppedApp: Promise<void> = app.shutdown();
void app.prepareSchema();
const Projects = app.entity(Project);
const namedProjects: PromiseLike<ProjectRow[]> = Projects
  .findAll(Projects.field.name.is('Research'))
  .sort(Projects.field.name, 'asc')
  .limit(10);
const projectedProjects: Array<Pick<ProjectRow, 'id' | 'name'>> = Projects.findAll().select(
  Projects.field.id,
  Projects.field.name,
);
// @ts-expect-error a projection does not contain fields that were not selected
const wronglyFullProjects: ProjectRow[] = projectedProjects;
void [namedProjects, projectedProjects, wronglyFullProjects];
const request: DispatchRequest = {
  actionId: 'action-1',
  type: Rename.type,
  payload: { id: 'project-1', name: 'Research' },
  principal: principal({ type: 'user', id: 'user-1' }),
};
const dispatchResult: Promise<DispatchResult> = app.dispatch(request);
const scopeAwareAction: RegisteredAction = {
  type: 'Project.rename',
  authorize: () => true,
  handler: ({ scope }) => [{ type: 'Project.renamed', scope, data: {} }],
};
const adminAuthorizedAction: RegisteredAction<{ projectId: string }> = {
  type: 'Project.admin',
  authorize: authorizedRows(({ payload }) => [{ entity: Project, id: payload.projectId, capability: admin }]),
  handler: ({ scope }) => [{ type: 'Project.administered', scope, data: {} }],
};
void adminAuthorizedAction;
const forgedAdminAuthorizedAction: RegisteredAction<{ projectId: string }> = {
  type: 'Project.forgedAdmin',
  // @ts-expect-error authorizedRows requires the exported admin singleton, not a structural lookalike
  authorize: authorizedRows(({ payload }) => [{ entity: Project, id: payload.projectId, capability: { capability: 'admin' } }]),
  handler: ({ scope }) => [{ type: 'Project.forgedAdministered', scope, data: {} }],
};
void forgedAdminAuthorizedAction;
const clonedAdmin = { ...admin };
const clonedAdminAuthorizedAction: RegisteredAction<{ projectId: string }> = {
  type: 'Project.clonedAdmin',
  // @ts-expect-error authorizedRows requires the admin singleton, not a clone
  authorize: authorizedRows(({ payload }) => [{ entity: Project, id: payload.projectId, capability: clonedAdmin }]),
  handler: ({ scope }) => [{ type: 'Project.clonedAdministered', scope, data: {} }],
};
void clonedAdminAuthorizedAction;
const claimedBlobAction: RegisteredAction<{ id: string; blob: unknown }> = {
  type: 'File.upload',
  authorize: () => true,
  handler: ({ claimedBlobs }) => {
    const blob: DeclaredClaimedBlob | undefined = claimedBlobs?.blob;
    if (blob) void [blob.blobId, blob.resourceId, blob.sha256, blob.md5, blob.byteLength, blob.mediaType];
    return [];
  },
};
void claimedBlobAction;
const historyAwareAction: RegisteredAction<Record<string, unknown>> = {
  type: 'Project.restoreName',
  authorize: () => true,
  handler: ({ history }) => {
    if (history) {
      const operation: 'undo' | 'redo' = history.operation;
      const input: unknown = history.input;
      void [operation, input];
    }
    return [];
  },
};
const purgeAction: RegisteredAction<{ rootId: string }> = {
  type: 'Project.purge',
  authorize: () => true,
  history: { cursor: 'excluded' },
  erasure: {
    tables: ['CleanupOutbox'], readTables: ['Project'],
    prepare({ context, reads }) {
      const typedContext: ErasurePreparationContext<{ rootId: string }> = context;
      const typedReads: ErasurePreparationReads = reads;
      const committedAt: string = typedContext.action.committedAt;
      void [committedAt, typedContext.action.payload.rootId, typedReads.find('Project', { id: context.subject.id })];
    },
  },
  handler: () => [],
};
void purgeAction;
declare const committedEvent: CommittedEvent;
scopeAwareAction.projections?.[0]?.apply(committedEvent, db);
scopeAwareAction.projections?.[0]?.apply(committedEvent, db, { claimedBlobs: {} });
// @ts-expect-error ordinary projections cannot receive private facts
scopeAwareAction.projections?.[0]?.apply(committedEvent, db, { privateFact: { before: {}, after: {} } });

type PrivateFact = Readonly<{ before: { value: string }; after: { value: string } }>;
const privateProjection: PrivateFactRegisteredProjection<PrivateFact> = {
  eventTypes: ['Project.privateRenamed'],
  privateFact: true,
  apply(_event, _database, { privateFact }) { void privateFact.after.value; },
};
const privateAction: RegisteredAction<Record<string, unknown>, typeof privateProjection> = {
  type: 'Project.privateRename',
  authorize: () => true,
  handler: () => ({ events: [], privateFact: { before: {}, after: {} } }),
  projections: [privateProjection],
};
// @ts-expect-error private-fact projections require their explicit private context
privateAction.projections?.[0]?.apply(committedEvent, db);
privateAction.projections?.[0]?.apply(committedEvent, db, {
  privateFact: { before: { value: 'before' }, after: { value: 'after' } },
});
const mixedPublicProjectionSurface: readonly (OrdinaryRegisteredProjection | PrivateFactRegisteredProjection)[] = [
  ...(scopeAwareAction.projections ?? []), privateProjection,
];
void [scopeAwareAction, privateAction, mixedPublicProjectionSurface];

const configuredHistory = durableHistory({
  authorize: ({ operation, scope: historyScope, principal: historyPrincipal }) =>
    operation === 'read' && historyScope.length > 0 && historyPrincipal.id !== null,
  actions: {
    'Project.rename': {
      inverse: ({ action: committedAction, fact }) => ({
        type: committedAction.type ?? 'note.restore',
        payload: committedAction.payload as Record<string, unknown>,
        scope: committedAction.scope,
        input: fact.before,
      }),
      redo: ({ action: committedAction }) => ({
        type: committedAction.type ?? 'note.restore',
        payload: committedAction.payload as Record<string, unknown>,
        scope: committedAction.scope,
      }),
    },
  },
});
void [configuredHistory, historyAwareAction];
const batchActions: readonly BatchAction[] = [
  { type: Rename.type, payload: { id: 'project-1', name: 'Research' } },
];
const batchResult: Promise<DispatchResult> = app.batch(
  batchActions,
  { principal: request.principal },
);
const plannedBatchResult: Promise<DispatchResult> = app.batch(
  () => batchActions,
  { principal: request.principal },
);
// @ts-expect-error batch planning is synchronous so it stays inside one write-queue turn
app.batch(async () => batchActions, { principal: request.principal });
app.listen(() => undefined);
app.listen({ principalOf: () => request.principal, requestLog: true });
app.listen(0, { onListening: () => undefined, hsts: true });
// @ts-expect-error maintenance belongs to the application runtime, not one HTTP transport
app.listen({ blobReapTtlMs: 1000 });
// @ts-expect-error resource expansion belongs only to an entity routes callback
app.resource();
const maybeServer: import('node:http').Server | undefined = app.httpServer;
const registeredEntities: ReadonlyMap<string, import('workbench').AnyWorkbenchEntity> = app.entities;
void [startedApp, stoppedApp, dispatchResult, batchResult, plannedBatchResult, maybeServer, registeredEntities];

const inherited: InheritDirective = inherit(Project, { via: 'projectId' });
const Child = entity('Child', { projectId: ref(Project), grant: inherited });
void Child;
const AuditedChild = entity('AuditedChild', {
  projectId: ref(Project, { immutable: true }),
  createdAt: date({ readonly: true, default: () => new Date().toISOString() }),
  updatedAt: date({ touch: true, default: () => new Date().toISOString() }),
  grant: inherited,
});
void AuditedChild;

const pceRunner: PostCommitEffectRunner = createPostCommitEffectRunner({ db });
void pceRunner;
const consumerAdmin: OperationalConsumerAdmin = operationalConsumerAdmin(app);
const adminFailures: Promise<readonly OperationalFailure[]> = consumerAdmin.listFailures('test' as unknown as import('workbench').OperationalConsumerName);
void adminFailures;
const queue: JobQueue = createJobQueue({ db, sharedSecret: 'secret' });
const job: JobRow = queue.enqueue({ kind: 'index', payload: { projectId: 'project-1' } });
// A conforming byte store is constructible against the published ByteStore
// type and pluggable into createBlobStore by shape.
const customByteStore: ByteStore = {
  capabilities: {
    durability: 'durable', atomicPromotion: true, rangeSupport: true,
    deleteVerification: true, consistency: 'single-node-strong',
  },
  writePending: (id, bytes) => void [id, bytes],
  writePendingStream: async (id, bytes) => {
    let byteLength = 0;
    for await (const chunk of bytes) byteLength += chunk.length;
    void id;
    return { byteLength, sha256: '', md5: '' };
  },
  finalizePending: () => '',
  readRange: () => Buffer.alloc(0),
  readPending: () => Buffer.alloc(0),
  readRangeStream: () => new Readable(),
  readPendingStream: () => new Readable(),
  remove: () => {},
  exists: () => false,
};
const blobs: BlobStore = createBlobStore({ db, bytes: customByteStore });
// @ts-expect-error a capability declaration is closed: no extra members allowed
customByteStore.capabilities.purgeOnStart;
// @ts-expect-error an ephemeral durability string is not a durability literal
const bogusDurability: ByteStoreDurability = 'volatile';
const surfacedCapabilities: ByteStoreCapabilities = blobs.capabilities;
const declaredDurability: ByteStoreDurability = surfacedCapabilities.durability;
const orphanDanglerCounts: Promise<{ orphans: number; danglers: number }> = blobs.reap({ ttl: 60_000, census: compileBlobCensus({ entities: new Map() }) });
void orphanDanglerCounts;
blobs.discardPending('pending-1');
blobs.discard('final-1');
// @ts-expect-error pathFor was retired from the portable ByteStore surface (S6/A2)
customByteStore.pathFor;
// @ts-expect-error pathFor was retired from the portable BlobStore surface (S6/A2)
blobs.pathFor;
// S6/A5 generation replacement + durable cleanup surface:
blobs.replace('gen-old', { bytes: 'new-bytes' });
const switched: { adopted: number; replaced: number } = blobs.switchReplacement(db, 'gen-old', 'gen-new');
const cleanup: BlobCleanupState | undefined = blobs.cleanupState('gen-old');
const pendingCleanupIds: readonly string[] = blobs.pendingCleanups();
const freeBytesNow: number | null | undefined = customByteStore.freeBytes?.();
void [switched, cleanup, pendingCleanupIds, freeBytesNow];
void [job, blobs, customByteStore, surfacedCapabilities, declaredDurability, bogusDurability, orphanDanglerCounts, runMigrations(db, [migration]), readCommittedCursor(db, 'Project:project-1')];
const live: LiveDelivery = createLiveDelivery({ db, entities: new Map(), mayVerb: () => true });
createLiveDelivery({ db, entities: new Map(), mayVerb: () => true, snapshots: [] });
const liveAbort = new AbortController();
const liveBootstrap: Promise<LiveDeliveryBootstrap> = live.bootstrap({
  principal: request.principal,
  scope: 'Project:project-1',
});
const liveCatchup: Promise<LiveDeliveryCatchup> = live.catchup({
  principal: request.principal,
  scope: 'Project:project-1',
  after: 0,
});
const liveActivation: Promise<LiveDeliveryActivation> = live.subscribe({
  principal: request.principal,
  scope: 'Project:project-1',
  signal: liveAbort.signal,
  deliver: async (batch) => {
    for (const envelope of batch) {
      if (envelope.type === 'event') void envelope.event.data;
      else if (envelope.type === 'state') void [envelope.state, envelope.rows];
      else if (envelope.type === 'notification') void envelope.kind;
      else void envelope.reason;
    }
  },
});
// @ts-expect-error public delivery requires per-subscription cancellation
live.subscribe({ principal: request.principal, scope: 'Project:project-1', deliver: async () => {} });
void [live, liveActivation, liveBootstrap, liveCatchup];

const actor: Principal = principal({ type: 'apiKey', id: 'key-1' });
void actor;
declare const Invitations: import('workbench').BoundWorkbenchEntity<Invitation>;
const invitationApi = createInvitationApi({ Invitation: Invitations });
const invitationUser: UserPrincipal = principal({ type: 'user', id: 'user-1' });
const createdInvitation: Promise<Invitation> = invitationApi.createInvitation({
  targetEntity: 'Project', targetId: 'project-1', role: 'member',
  principal: invitationUser,
});
const apiKeyActor = principal({ type: 'apiKey', id: 'key-1' });
invitationApi.createInvitation({
  targetEntity: 'Project', targetId: 'project-1', role: 'member',
  // @ts-expect-error only a human user principal can create an invitation
  principal: apiKeyActor,
});
// @ts-expect-error only a human user principal can accept an invitation
invitationApi.acceptInvitation('invite-token', apiKeyActor);
// @ts-expect-error only a human user principal can reject an invitation
invitationApi.rejectInvitation('invite-token', apiKeyActor);
const rejectedInvitation: Promise<void> = invitationApi.rejectInvitation(
  'invite-token',
  invitationUser,
);
// @ts-expect-error only a human user principal can list invitations
invitationApi.listInvitationsForUser(apiKeyActor);
void [createdInvitation, rejectedInvitation];
const channel = new LiveChannel('https://example.test', {
  socketFactory: (url) => new WebSocket(url),
});
const liveFailureError = new WorkbenchFailureError(expectedFailure);
const liveFailure: WorkbenchFailure = liveFailureError.failure;
channel.subscribe('Project', 'project-1', {
  fields: { cursor: true },
  pace: { profile: '15fps' },
  onCheckpoint: ({ currentSeq }) => { void currentSeq; },
}, () => {});
const list: LiveList<ProjectRow> = new LiveList({ id: 'project-1', snapshot: [], cursor: 0 } as never);
const store: LiveStore<ProjectRow> = createLiveStore({
  baseUrl: 'https://example.test', name: 'Project', path: '/projects', channel,
});
const scopeStore: ScopeLiveStore<{ projects: ProjectRow[] }> = createScopeLiveStore({
  baseUrl: 'https://example.test',
  scope: 'workspace:one',
  channel,
  validateSnapshot: (value) => value as { projects: ProjectRow[] },
  fold: (current) => current,
  optimistic: (current) => current,
  sendAction: async () => ({ ok: true }),
});
const deliverySession: LiveDeliverySession<{ projects: ProjectRow[] }> = createLiveDeliverySession({
  bootstrap: async () => ({ kind: 'snapshot', snapshot: { projects: [] }, cursor: 0 }),
  subscribe: async ({ deliver }) => {
    const recipientBatch = null as unknown as readonly ServerLiveDeliveryEnvelope[];
    await deliver(recipientBatch);
    return { close() {} };
  },
  validateSnapshot: (value) => value as { projects: ProjectRow[] },
  fold: (current) => current,
  sendAction: async () => ({ ok: true }),
});
const aggregateDeliveryCursor: ClientLiveDeliveryCursor = { anchor: 1, aggregate: 2 };
void [aggregateDeliveryCursor, deliverySession.cursor];
const auth = createAuthClient({ baseUrl: 'https://example.test' });
void [list, store, scopeStore, deliverySession, auth.register('researcher', 'password'), auth.login('researcher', 'password'), decodeResult(new Response(null, { status: 204 }))];

declare const envelope: WsEnvelope;
declare const snapshot: SnapshotResponse<ProjectRow>;
declare const eventsSince: EventsSinceResponse;
declare const stale: StaleResponse<ProjectRow>;
void [envelope, snapshot, eventsSince, stale, Renamed, liveFailure];

// The retired word-evidence mechanism is absent from every public surface: the
// root entry, the annotated-text entry, and the server entry expose no
// constructor, reader, handle, table name, payload validator, or payload type.
// @ts-expect-error word evidence was retired into ordinary annotations
declare const removedWordEvidenceFamily: typeof import('workbench').wordEvidenceFamily;
// @ts-expect-error word evidence was retired into ordinary annotations
declare const removedWordEvidenceRead: typeof import('workbench').readWordEvidence;
// @ts-expect-error word evidence was retired into ordinary annotations
declare const removedWordEvidenceFieldHandle: typeof import('workbench').wordEvidenceFieldHandle;
// @ts-expect-error word evidence was retired into ordinary annotations
declare const removedWordEvidenceTableName: typeof import('workbench').wordEvidenceTableName;
// @ts-expect-error word evidence was retired into ordinary annotations
declare const removedWordEvidencePayload: typeof import('workbench').assertWordEvidencePayload;
// @ts-expect-error the annotated-text entry also no longer exports word evidence
declare const removedAnnotatedTextWordEvidence: typeof import('workbench/annotated-text').wordEvidenceFamily;
// @ts-expect-error the annotated-text entry no longer exports the payload validator
declare const removedAnnotatedTextWordEvidenceRead: typeof import('workbench/annotated-text').readWordEvidence;
// @ts-expect-error the word-evidence payload type is gone from the public types
declare const removedWordEvidenceType: import('workbench').AnnotatedTextWordEvidenceFamily;
void [removedWordEvidenceFamily, removedWordEvidenceRead, removedWordEvidenceFieldHandle, removedWordEvidenceTableName, removedWordEvidencePayload, removedAnnotatedTextWordEvidence, removedAnnotatedTextWordEvidenceRead, removedWordEvidenceType];

const boundWithMembership = membership(app.entity(Project), {
  member: { can: [read] },
});
const stillBound: import('workbench').BoundWorkbenchEntity<ProjectRow> = boundWithMembership;
const parsedCookie: Record<string, string> = parseCookies(`${SESSION_COOKIE}=token`);
const rootInvitationApi = createRootInvitationApi({ Invitation: Invitations as unknown as NonNullable<Parameters<typeof createRootInvitationApi>[0]>['Invitation'] });
const routeMatch = matchRoute([], 'GET', '/health');
const staticHandler = serveStatic('/tmp');
const staticHandlerWithOptions = serveStatic('/tmp', {
  precompressed: true,
  cacheControl: { '/assets/': 'public, max-age=31536000, immutable', '/index.html': 'no-cache' },
  isManagedPath: (resolved) => resolved.startsWith('/managed'),
});
const staticHandlerPrefixOption: import('workbench').ServeStaticOptions = { prefix: '/files' };
const appForStaticProbe = workbench();
const staticAppReturn: import('workbench').WorkbenchApp = appForStaticProbe.static('/', '/tmp/dist', {
  precompressed: true,
  cacheControl: { '/assets/': 'public, max-age=31536000, immutable' },
});
void [staticHandler, staticHandlerWithOptions, staticHandlerPrefixOption, staticAppReturn];
const cookieHeader: string = sessionCookie('token');
const sessionToken: string | undefined = sessionTokenOf({ headers: { cookie: cookieHeader } });
const principalFromSession = sessionPrincipalOf(db);
const principalFromApiKey = apiKeyPrincipalOf(db);
const mail = emailSeam({ transport: noopTransport });
void [
  stillBound, parsedCookie, rootInvitationApi, routeMatch, staticHandler,
  sessionToken, principalFromSession, principalFromApiKey, mail,
];

// ── generic audit + denial contract (S5/A4) ─────────────────────────────
const auditRetention: RetentionConfig = { security: '12m', diagnostic: '30d' };
const auditSink: AuditSink = { write: (event: AuditEvent, retention: string) => void [event, retention] };
const auditOptions: AuditorOptions = { sink: auditSink, retentionConfig: auditRetention, now: () => 1, id: () => 'evt-1' };
const auditor: Auditor = createAuditor(auditOptions);
const securityInput: AuditInput = {
  principal: invitationUser, operation: 'read', resourceCategory: 'entity', resourceId: 'n1',
  outcome: 'deny', reasonCode: 'no-capability',
};
const securityEvent: AuditEvent = auditor.auditSecurity(securityInput);
const diagnosticEvent: AuditEvent = auditor.auditDiagnostic({
  principal: invitationUser, operation: 'read', resourceCategory: 'entity',
  outcome: 'allow', reasonCode: null,
});
const eventActor: AuditActor = securityEvent.actor;
const eventOutcome: AuditOutcome = securityEvent.outcome;
const eventClassification: AuditClassification = diagnosticEvent.classification;
const denialAuditor: DenialAuditor = createDenialAuditor({ auditor });
const denialInput: DenialInput = {
  principal: invitationUser, operation: 'read', resourceCategory: 'entity', reasonCode: 'no-capability',
};
const denialEvent: AuditEvent | null = denialAuditor.auditDenial(denialInput);
const denialKey: string = denialAuditor.keyOf({ type: 'user', id: 'user-1', status: 'active' }, 'anonymous');
const opaqueCheck: boolean = isOpaqueId('n1');
const sanitizedId: string | null = sanitizeOpaqueId('alice@example.com');
noopAuditSink.write(securityEvent, '12m');
void [securityEvent, diagnosticEvent, eventActor, eventOutcome, eventClassification, denialAuditor, denialInput, denialEvent, denialKey, opaqueCheck, sanitizedId, securityInput];
// @ts-expect-error retentionConfig is required
createAuditor({ sink: auditSink });

// ── field-constructor contract parity ──────────────────────────────────

// computed({ compute })
const computedPull = computed({ compute: (row) => String(row.name ?? '') });
// @ts-expect-error computed requires a compute function
computed({});
// @ts-expect-error compute must be a function, not a string
computed({ compute: 'not a function' });
void computedPull;

// computed.stored({ compute })
const computedStored = computed.stored({ compute: (row) => Number(row.count) });
// @ts-expect-error computed.stored requires a compute function
computed.stored({});
void computedStored;

// ephemeral({ cell: descriptor })
const ephem = ephemeral({ cursor: text(), selection: text() });
const emptyEphem = ephemeral();
// @ts-expect-error ephemeral requires an object of descriptors, not a bare descriptor
ephemeral(text());
void [ephem, emptyEphem];

// log({ field: descriptor })
const chatLog = log({ sender: ref('User'), body: text() });
const emptyLog = log();
// @ts-expect-error log entry must be an object, not a bare descriptor
log(text());
// @ts-expect-error log has no options argument in the runtime API
log({ body: text() }, {});
void [chatLog, emptyLog];

// state(...).transition(...)
const statusField = state({ values: ['draft', 'shared', 'archived'] });
const tx = state.transition('draft', 'shared');
const transitionType: 'transition:draft->shared' = tx.type;
// @ts-expect-error transition requires two string arguments
state.transition();
void [statusField, tx, transitionType];

// schedule/tick lifecycle guards are synchronous row predicates
const dueAt = date();
schedule.at<{ status: string }>(dueAt, {
  key: 'publish',
  when: ({ row }) => row.status === 'ready',
  with: { status: 'published' },
});
tick.every<{ status: string }>('1m', {
  while: ({ fields }) => fields.status.is('ready'),
  when: ({ row }) => row.status === 'ready',
});
// @ts-expect-error when must be a function
schedule.at(dueAt, { when: 'ready' });
// @ts-expect-error lifecycle guards must return a boolean synchronously
tick.hz(10, { when: async () => true });
// @ts-expect-error trigger keys must be strings
schedule.after(dueAt, '1m', { key: 42 });

// projected.async(...)
const proj = projected.async({
  compute: async (row) => String(row.name ?? ''),
  from: ['Project.created'],
});
// @ts-expect-error projected.async requires a compute function
projected.async({});
// @ts-expect-error projected.async invalid: from should be string array, not number
projected.async({ compute: async () => 'x', from: 42 });
void proj;

// workbench/annotated-text-authoring — the server-side authoring seam. The
// database parameter is structural, so a node:sqlite DatabaseSync (the
// consumer's server handle) satisfies it without a cast.
declare const authoringDb: AuthoringDatabase;
const nativeAuthoringDb: AuthoringDatabase = nativeDb;
const authoringStream = ensureStream({
  db: authoringDb, prefix: 'annotatedText', documentId: 'document-1',
  principalType: 'user', principalId: 'user-1',
});
const authoringLease = ensureLease({
  db: authoringDb, prefix: 'annotatedText', streamId: authoringStream.id,
  clientNonceHash: hashClientNonce('client-nonce'),
});
const authoringLeaseFence: number | undefined = authoringLease?.acknowledgedFence;
const authoringSnapshot = issueAuthoringSnapshot({
  db: authoringDb, prefix: 'annotatedText', leaseId: 'lease-1', fence: 0,
  positions: [{ familyCheckpoint: { version: 1 }, visibleAtIssue: true }],
});
const authoringEnvelope = buildAuthoringEnvelope({
  streamToken: authoringStream.id, leaseToken: 'lease-1', snapshotToken: 'snapshot-1',
  fence: 0, positionFrames: [{ token: 'token-1' }],
});
const authoringEnvelopeVersion: 1 = authoringEnvelope.version;
const authoringEnvelopeToken: string | undefined = authoringEnvelope.positionFrames[0]?.positionToken;
const acknowledged = acknowledgeAndPruneSnapshot({
  db: authoringDb, prefix: 'annotatedText', snapshotId: 'snapshot-1', leaseId: 'lease-1',
});
const acknowledgedFence: number | undefined = acknowledged?.fence;
const family: ContinuousTextFamily = restoreTextFamilySerialized('{"id":"document-1","checkpoint":{"version":1}}');
const basis = textFamilyBasis(family);
const basisVersion: 1 = basis.version;
const basisFrontier: AuthoringFrontier = basis.frontier;
const endpoint: AuthoringStructuralEndpoint = { point: ['point', ['root'], 'left'], basisFrontier: [] };
const endpointOffset: number = projectEndpointToOffset(family, endpoint);
const authoringSnapshotId: string | undefined = authoringSnapshot?.snapshot.id;
const authoringSnapshotShape: AuthoringSnapshot | undefined = authoringSnapshot?.snapshot;
void [authoringLeaseFence, authoringEnvelopeVersion, authoringEnvelopeToken, acknowledgedFence, basisVersion, basisFrontier, endpointOffset, authoringSnapshotId, authoringSnapshotShape, nativeAuthoringDb];
const retryResult: OperationalEffectResult = { kind: 'retry', afterMs: 30_000, code: 'canonical-unavailable' };
const invalidEventRetry: OperationalEffectResult = { kind: 'retry', afterMs: 0, code: 'invalid-event' };
const invariantRetry: OperationalEffectResult = { kind: 'retry', afterMs: 0, code: 'invariant-violation' };
const retryCode: string | undefined = retryResult.kind === 'retry' ? retryResult.code : undefined;
const serverRetry: ServerOperationalRetry = {
	consumer: 'scope-speaker-profile-removed' as OperationalConsumerName,
	scopeId: 'Project:project-1',
	committedEventId: 'Project:project-1:1',
	code: 'canonical-unavailable',
	status: 'retry',
	nextAttemptAt: Date.now()
};
void [retryCode, serverRetry, invalidEventRetry, invariantRetry];
