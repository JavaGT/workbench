// Node-only capabilities used to assemble and operate a Workbench application.
// Declaration grammar stays at `workbench`; the zero-import browser runtime
// stays at `workbench/client`. This module deliberately does not expose the
// ambient database, raw kernel, or raw DDL machinery.

export {
  sessionCookie,
  sessionPrincipalOf,
  sessionTokenOf,
  apiKeyPrincipalOf,
  parseCookies,
  SESSION_COOKIE,
} from './auth/session.mjs';
export {
  createInvitationApi,
} from './auth/invitation.mjs';
export { emailSeam, noopTransport } from './email-seam.mjs';
export {
  frameworkTableNames,
  declaredTableNames,
  // App-lint helper: fail closed when SQL names a framework-owned table.
  assertNoFrameworkTableSql,
} from './schema-table-census.mjs';
export { matchRoute } from './http-route-match.mjs';
export { serveStatic } from './views.mjs';
export { createJobQueue } from './job-queue.mjs';
export { createBlobStore } from './blob-store.mjs';
export { compileBlobCensus } from './blob-census.mjs';
export { runMigrations } from './migrations.mjs';
export { defineSqliteSchema } from './sqlite-schema.mjs';
export { createSchemaReport,                                                                       } from './schema-report.mjs';
export { describeEntityStorage, describeSqliteStorage } from './sqlite-storage-description.mjs';
export { readSeq as readCommittedCursor } from './committed-log.mjs';
export { createLiveDelivery } from './live-delivery-public.mjs';
export { createLiveDeliveryHttpHandler } from './live-delivery-http.mjs';
// App-safe operational consumer admin — inspect retry waits and retry terminal failures.
// Consumers are registered via `workbench({ operationalConsumers: [...] })` and
// reconciled automatically. See `defineOperationalEvent` / `operationalConsumer`
// in the root package for declaration.
export { operationalConsumerAdmin } from './operational-consumer.mjs';
// Advanced: creates a runner for post-commit effects declared via
// `postCommitEffect()` in action handlers. In normal app usage the runner is
// auto-created at `app.postCommitEffects` when a database is configured; this
// export is for custom wiring only.
export { createPostCommitEffectRunner } from './post-commit-effects.mjs';
export { pendingBlobStager, declaredBlobField, readClaimedBlob, claimedBlobLifecycle, stagedBlobReader } from './pending-blob.mjs';
export { readBlob, readBlobStream, BlobReadDeniedError,                                            } from './authorized-blob-read.mjs';
export { BlobSlotNotFoundError, BlobTooLargeError } from './fs-blobs.mjs';
export { createHistoryReader } from './history-read.mjs';
// Search plugins are server-only: they receive constrained source and
// index capabilities, never a raw application database handle.
export {
  createSearchPluginRegistry,
  createSearchSourceReader,
} from './search-plugin.mjs';
export { createSearchOwnedIndexCapability } from './index-capability.mjs';
export { createVectorPlugin } from './vector-plugin.mjs';
