// The mutation pipeline (SPEC §7). This file is the coordinator/barrel: it
// owns no implementation, only the public surface assembled from the cohesive
// pipeline-* siblings. See docs/architecture-map.md for where each loop lives.
//
// Layering is strictly one-way: shared kernel/types -> event core -> variants,
// outcomes, dedupe, commit -> server/client -> this barrel. No sibling imports
// this barrel, so the import DAG stays acyclic.

// ---- typed kernel (action / event / handler policy) -----------------------
export {
  HANDLER_POLICY,
  type HandlerPolicy,
  readHandlerPolicy,
  type PipelineCommitHook,
  action,
  event,
} from './pipeline-kernel.ts';

// ---- in-txn event application core ---------------------------------------
export {
  NOW,
  noAdmission,
  noBlobAdapter,
  type PostCommitConsumerErrorHook,
} from './pipeline-event-core.ts';

// ---- named pipeline variants ---------------------------------------------
export { durableMutationVariant, liveMutationVariant } from './pipeline-variants.ts';

// ---- one write coordinator per db handle --------------------------------
export { writeQueueForDatabase } from './pipeline-write-queue.ts';

// ---- server / client entrypoints -----------------------------------------
export { createServer } from './pipeline-server.ts';
export { createClient } from './pipeline-client.ts';
