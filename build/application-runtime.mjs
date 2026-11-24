// Application runtime ownership. This is the one boot path for both headless
// and HTTP applications: declaration/schema finalization, Kernel assembly,
// recovery, maintenance, clocks, and graceful shutdown registration.

import { randomUUID } from 'node:crypto';

import { buildKernel } from './kernel.mjs';
import { installGracefulShutdown } from './lifecycle.mjs';
import {
  pruneInactiveScheduleReceipts,
  startClockTriggers,
} from './schedule-runtime.mjs';
import { reconcileProjectedRecovery } from './projected-async.mjs';
import { reconcileDurableEffects } from './durable-effects.mjs';
import { startSimulation } from './simulate.mjs';
import { compactReceiptResultData, retentionPrune } from './committed-log.mjs';
import { getLog, withLog } from './log.mjs';

import { EMPTY_BLOB_CENSUS,                 } from './blob-census.mjs';
import { blobRetentionDefaults, retentionMs, validateBlobRetentionPolicies,                            } from './blob-retention.mjs';

import { installBatchHttpDispatcher, installHistoryHttpDispatcher } from './application-action-http.mjs';
import { resolveAnnotatedTextOwningScope } from './annotated-text-field.mjs';
import { rawRow } from './entity/query.mjs';


const BLOB_REAP_INTERVAL_MS = 10 * 60_000;

// S6/A5 #5 low-disk guard default: refuse new uploads below 256 MiB of free
// disk so a full disk can never compromise SQLite/WAL durability mid-commit.
// Configurable via the maintenance options; 0 disables the guard.
export const DEFAULT_LOW_DISK_HEADROOM_BYTES = 256 * 1024 * 1024;






                                           









                                                                         








                                                                      



                                             




























/** The structural shape of a read-only recovery health probe result. */






























































function installRuntimeShutdown(app            )       {
  if (app._runtimeShutdownInstalled) return;
  installGracefulShutdown(app         );
  app._runtimeShutdownInstalled = true;
  app.onShutdown('job queue', () => void app.jobs?.stop?.(), { timeoutMs: 1000 });
  app.onShutdown('clock', () => void app.clock?.stop?.(), { timeoutMs: 1000 });
}

function wireMutationSurface(app            )                             {
  const dispatch = (args         ) =>
    withLog(app.log, () => app.writeQueue.run(() => app.kernel.dispatch(bindAnnotatedTextScope(app, args         ))));
  app.dispatch = dispatch;
  const kernelHistory = app.kernel.history                             ;
  app.history = kernelHistory && Object.freeze({
    cursor: kernelHistory.cursor,
    undo: (args         ) => withLog(app.log, () => app.writeQueue.run(() => kernelHistory.undo(args))),
    redo: (args         ) => withLog(app.log, () => app.writeQueue.run(() => kernelHistory.redo(args))),
  });
  // The HTTP skin receives a private queued dispatcher, not a cursor capability.
  // Reading and moving happen under one package write-queue turn.
  if (kernelHistory) {
    installHistoryHttpDispatcher(app         , ((command        , args                         ) => withLog(app.log, () => app.writeQueue.run(async () => {
      const cursor = await kernelHistory.cursor(args);
      return (kernelHistory                                                         )[command]({ ...args, revision: (cursor                          ).revision });
    })))         );
  }
  const dispatchBatch = (request         ) => withLog(app.log, () => app.writeQueue.run(() => app.kernel.dispatchBatch(request)));
  installBatchHttpDispatcher(app         , dispatchBatch         );
  app.batch = async (actionsOrFactory         , { principal, clientId, scope }                                                               = {}) =>
    withLog(app.log, () => app.writeQueue.run(() => {
      const actions = typeof actionsOrFactory === 'function'
        ? actionsOrFactory()
        : actionsOrFactory;
      if (actions && typeof (actions                      ).then === 'function') {
        throw new TypeError('app.batch action factory must return a synchronous action array');
      }
      if (!Array.isArray(actions)) {
        throw new TypeError('app.batch requires an action array or synchronous action-array factory');
      }
      return app.kernel.dispatchBatch({ actionId: randomUUID(), actions, principal, clientId, scope });
    }));
  return dispatch;
}


function bindAnnotatedTextScope(app            , args                                            )                                             {
  if (!args?.type || !args?.payload || typeof args.payload !== 'object') return args;
  const type = args.type          ;
  const entity = [...app.entities.values()].find((candidate) => type.startsWith(`${candidate.name}.`));
  const annotatedFields = entity && Object.entries(entity.fields                                   ).filter(([, field]) => field.kind === 'annotatedText');
  if (!annotatedFields?.length || !entity) return args;
  const operationType = annotatedFields.find(([name]) => type === `${entity.name}.${name}.operation`)
    ?? annotatedFields[0];
  const descriptor = operationType[1];
  if (type !== `${entity.name}.create` && type !== `${entity.name}.update` && type !== `${entity.name}.remove`
    && type !== `${entity.name}.annotatedText.retire` && type !== `${entity.name}.${operationType[0]}.operation`) return args;
  const id = (args.payload                           ).id;
  if (typeof id !== 'string' || !id) return args;
  const row = type === `${entity.name}.create`
    ? args.payload
    : rawRow(app.db, entity.name, id);
  if (!row) return args;
  return { ...args, scope: resolveAnnotatedTextOwningScope(descriptor, entity.fields                       , row                       ).key };
}

function engageMaintenance(app            , log              )       {
  const options = app._maintenance;
  if (app.blobs) {
    app.sweepBlobs = () => app.writeQueue.run(() =>
      app.blobs .reap({
        // The named 'abandoned-upload' policy (S6/A5) is the SINGLE authority
        // for the orphan TTL — the legacy blobReapTtlMs scalar is its alias and
        // can never diverge (validateMaintenanceOptions folds it into the
        // policy).
        ttl: retentionMs(options.blobRetention, 'abandoned-upload'),
        census: app.blobCensus ?? EMPTY_BLOB_CENSUS,
        // The named 'replaced-generation' policy (S6/A5): replaced generations
        // are reclaimed only once this retention window has elapsed.
        replacedRetentionMs: retentionMs(options.blobRetention, 'replaced-generation'),
        // Route replaced/dangling generations through the S1/A6 recycling bin
        // (S6/A5 #4) when the app owns a recycle seam.
        ...(app.blobRecycleSeam ? { recycle: app.blobRecycleSeam } : {}),
      })
    );
    app.clock.add({
      name: 'blob-reaper',
      intervalMs: options.blobReapIntervalMs,
      fn: () => void app.sweepBlobs ().catch((err) => log.warn('system', 'blob reap failed', { err })),
    });
  }
  if (app.pendingBlobLifecycle) {
    app.sweepPendingBlobs = () => app.writeQueue.run(() => app.pendingBlobLifecycle .reap());
    app.clock.add({
      name: 'pending-blob-reaper',
      intervalMs: options.blobReapIntervalMs,
      fn: () => void app.sweepPendingBlobs ().catch((err) => log.warn('system', 'pending blob reap failed', { err })),
    });
  }
  if (options.logRetentionDays > 0) {
    app.sweepLog = () => app.writeQueue.run(async () => {
      const cutoff = new Date(Date.now() - options.logRetentionDays * 86_400_000).toISOString();
      await retentionPrune(app.db         , cutoff);
      (app.db                   ).prepare('DELETE FROM _ProjectedCursor WHERE lastSeq = 0').run();
    });
    app.clock.add({
      name: 'log-reaper',
      intervalMs: options.logRetentionIntervalMs,
      fn: () => void app.sweepLog ().catch((err) => log.warn('system', 'log retention sweep failed', { err })),
    });
  }
  if (options.resultDataRetentionDays > 0) {
    app.sweepReceiptResultData = () => app.writeQueue.run(() => {
      const cutoff = new Date(Date.now() - options.resultDataRetentionDays * 86_400_000).toISOString();
      const compacted = compactReceiptResultData(app.db         , cutoff);
      if (compacted > 0) log.info('system', 'receipt resultData compaction', { compacted });
    });
    app.clock.add({
      name: 'receipt-result-compactor',
      intervalMs: options.logRetentionIntervalMs,
      fn: () => void app.sweepReceiptResultData ().catch((err) => log.warn('system', 'receipt resultData compaction sweep failed', { err })),
    });
  }
}

async function bootApplication(app            )                      {
  const log = app.log ?? getLog();
  // When HTTP was selected, fail the same boot promise on bind errors before
  // acquiring the durable/background owners.
  await app._transportReady;
  if (app._shutdownStarted) return app;
  await app.resolveRoutes();
  if (app._shutdownStarted) return app;
  if (app.db && typeof app.db.exec === 'function') await app.prepareSchema();
  if (app._shutdownStarted) return app;

  // Optional recovery/backup probe. When an app wires one (e.g. the sqlite
  // adapter's read-only file probe, or a backup/recovery manager), boot runs it
  // BEFORE the kernel and any writer, so a database that needs recovery fails
  // closed instead of serving a commit log SQLite cannot be trusted to keep.
  // A probe failure is a boot failure, never a degradation.
  if (typeof app.probeRecovery === 'function') {
    let probeResult                            ;
    try {
      probeResult = await app.probeRecovery();
    } catch (err) {
      log.error('system', 'recovery probe threw during boot', { err });
      throw err;
    }
    if (probeResult && probeResult.ok === false) {
      const reason = probeResult.reason ?? 'recovery probe reported an unhealthy database';
      const findings = probeResult.findings ?? [];
      log.error('system', 'recovery probe failed — refusing to boot', { reason, findings });
      throw new Error(`recovery probe failed: ${reason}${findings.length > 0 ? ` (${findings.join('; ')})` : ''}`);
    }
  }
  if (app._shutdownStarted) return app;

  app.kernel = buildKernel(app)                            ;
  const dispatch = wireMutationSurface(app);

  // S6/A5 #4: materialize the app's S1/A6 recycle seam now that the compiled
  // blob census exists (the recycle manager resolves backup blob names over
  // it). A failed assembly is a degradation — sweeps still remove live bytes,
  // just without binning — never a boot failure, but it is logged so ops
  // notice the bin is not engaged.
  if (!app.blobRecycleSeam && typeof app.assembleBlobRecycleSeam === 'function') {
    try {
      app.assembleBlobRecycleSeam();
    } catch (err) {
      log.warn('system', 'blob recycle seam assembly failed — replaced/deleted generations will not route through the recycling bin', { err });
    }
  }

  if (app.db) {
    if (typeof app.db.exec === 'function') {
      pruneInactiveScheduleReceipts({ db: app.db         , entities: app.entities          });
    }
    startClockTriggers({ db: app.db         , entities: app.entities         , dispatch, clock: app.clock          });
    app.simulation = startSimulation({
      db: app.db         ,
      entities: app.entities,
      dispatch,
      clock: app.clock         ,
    });
  }

  try {
    await app.writeQueue.run(() => reconcileProjectedRecovery(app.db         , app.entities         ));
  } catch (err) {
    log.warn('system', 'projected recovery sweep failed', { err });
  }
  if (app._shutdownStarted) return app;
  const reconcileBlobFinalize = app.reconcileBlobFinalize;
  if (app.db && reconcileBlobFinalize) {
    try {
      await app.writeQueue.run(() => reconcileBlobFinalize(app.db));
    } catch (err) {
      log.warn('system', 'blob finalize recovery sweep failed', { err });
    }
  }
  const pendingBlobLifecycle = app.pendingBlobLifecycle;
  if (pendingBlobLifecycle) {
    try {
      await app.writeQueue.run(() => pendingBlobLifecycle.reconcile());
    } catch (err) {
      log.warn('system', 'pending blob lifecycle recovery sweep failed', { err });
    }
  }
  if (app._shutdownStarted) return app;
  const reconcileEmailDelivery = app.reconcileEmailDelivery;
  if (app.db && reconcileEmailDelivery) {
    try {
      await app.writeQueue.run(() => reconcileEmailDelivery(app.db));
    } catch (err) {
      log.warn('system', 'email delivery recovery sweep failed', { err });
    }
  }
  const reconcileOperationalConsumers = app.reconcileOperationalConsumers;
  if (app.db && reconcileOperationalConsumers) {
    try {
      await app.writeQueue.run(() => reconcileOperationalConsumers());
    } catch (err) {
      log.warn('system', 'operational consumer recovery sweep failed', { err });
    }
  }
  if (app._shutdownStarted) return app;
  // Search staleness is cursor-backed: replay any _Log row committed before a
  // crash in the commit→notify window so the source-change ledger is complete
  // before the app serves searches. Same write-queue wrapping and degradation
  // policy as the other cursor-backed reconcilers above.
  const reconcileSearchStaleness = app.reconcileSearchStaleness;
  if (app.db && reconcileSearchStaleness) {
    try {
      await app.writeQueue.run(() => reconcileSearchStaleness());
    } catch (err) {
      log.warn('system', 'search staleness recovery sweep failed', { err });
    }
  }
  if (app._shutdownStarted) return app;
  const durableEffectsRegistry = app.durableEffectsRegistry;
  if (app.jobs && durableEffectsRegistry) {
    try {
      await app.writeQueue.run(() =>
        reconcileDurableEffects(app.db         , {
          durableEffectsRegistry: durableEffectsRegistry         ,
          jobs: app.jobs         ,
        }),
      );
    } catch (err) {
      log.warn('system', 'durable effects recovery sweep failed', { err });
    }
  }

  engageMaintenance(app, log);
  app.jobs?.startReaper?.();
  app.clock._schedule();
  log.info('system', app.httpServer
    ? `server listening on port ${app.httpServer.address()?.port}`
    : 'application started');
  return app;
}

export function startApplication(app            )                      {
  // A start call is an idempotent read of the singular boot promise. Callers
  // must not need to reach into the private promise to await application boot.
  if (app._startFailed && app._startPromise) return app._startPromise;
  if (app._shutdownStarted) {
    return Promise.reject(new Error('application has been shut down and cannot be started again'));
  }
  if (app._startPromise) return app._startPromise;

  app._startupMode = app._transportAttached ? 'http' : 'headless';
  installRuntimeShutdown(app);
  app._startPromise = (withLog(app.log, () => bootApplication(app))                       ).catch(async (err) => {
    app._startFailed = true;
    if (!app._shutdownStarted) await app._shutdownFromStartFailure?.();
    throw err;
  })                       ;
  app.ready = app._startPromise;
  return app._startPromise;
}

export const maintenanceDefaults                               = Object.freeze({
  blobReapIntervalMs: BLOB_REAP_INTERVAL_MS,
  // The abandoned-upload TTL is a named policy (S6/A5) — the scalar remains for
  // back-compat, defaulting from the policy so no TTL literal lives here.
  blobReapTtlMs: blobRetentionDefaults.abandonedUploadTtlMs,
  logRetentionDays: 0,
  logRetentionIntervalMs: BLOB_REAP_INTERVAL_MS,
  resultDataRetentionDays: 0,
  payloadCompressionMinBytes: 0,
  blobRetention: blobRetentionDefaults,
  blobLowDiskHeadroomBytes: DEFAULT_LOW_DISK_HEADROOM_BYTES,
});

export function validateMaintenanceOptions(options                    )                               {
  for (const name of ['blobReapIntervalMs', 'logRetentionIntervalMs']         ) {
    const value = options[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a finite number greater than zero`);
    }
  }
  for (const name of ['blobReapTtlMs', 'logRetentionDays', 'resultDataRetentionDays', 'payloadCompressionMinBytes']         ) {
    const value = options[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be a finite non-negative number`);
    }
  }
  // The named retention policies (S6/A5) validate centrally in
  // blob-retention.ts; absent → the shared defaults.
  let blobRetention = validateBlobRetentionPolicies(options.blobRetention);
  // S6/A5 #21: the legacy scalar blobReapTtlMs is an ALIAS of the named
  // 'abandoned-upload' policy — the policy is the single authority, so the two
  // can never diverge. An explicitly-set scalar (a legacy spelling of the same
  // knob) folds INTO the policy; a scalar that conflicts with an explicitly-set
  // policy value is a config error (fail closed).
  const explicitScalar = options.blobReapTtlMs !== maintenanceDefaults.blobReapTtlMs;
  const explicitPolicyValue = options.blobRetention !== maintenanceDefaults.blobRetention
    && options.blobRetention?.abandonedUploadTtlMs !== undefined;
  if (explicitScalar && explicitPolicyValue && options.blobReapTtlMs !== options.blobRetention .abandonedUploadTtlMs) {
    throw new TypeError(
      "blobReapTtlMs is an alias of blobRetention.abandonedUploadTtlMs — the two are the same knob and must agree",
    );
  }
  if (explicitScalar) {
    blobRetention = validateBlobRetentionPolicies({ ...blobRetention, abandonedUploadTtlMs: options.blobReapTtlMs });
  }
  const blobLowDiskHeadroomBytes = options.blobLowDiskHeadroomBytes ?? maintenanceDefaults.blobLowDiskHeadroomBytes;
  if (typeof blobLowDiskHeadroomBytes !== 'number' || !Number.isFinite(blobLowDiskHeadroomBytes) || blobLowDiskHeadroomBytes < 0) {
    throw new TypeError('blobLowDiskHeadroomBytes must be a finite non-negative number of bytes (0 disables the guard)');
  }
  return Object.freeze({
    blobReapIntervalMs: options.blobReapIntervalMs,
    // The mirror of the policy: always retentionMs(blobRetention,
    // 'abandoned-upload') — the alias value can never diverge from the policy.
    blobReapTtlMs: retentionMs(blobRetention, 'abandoned-upload'),
    logRetentionDays: options.logRetentionDays,
    logRetentionIntervalMs: options.logRetentionIntervalMs,
    resultDataRetentionDays: options.resultDataRetentionDays,
    payloadCompressionMinBytes: options.payloadCompressionMinBytes,
    blobRetention,
    blobLowDiskHeadroomBytes,
  });
}
