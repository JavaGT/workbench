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

  readHandlerPolicy,

  action,
  event,
} from './pipeline-kernel.mjs';

// ---- in-txn event application core ---------------------------------------
export {
  NOW,
  noAdmission,
  noBlobAdapter,

} from './pipeline-event-core.mjs';

// ---- named pipeline variants ---------------------------------------------
export { durableMutationVariant, liveMutationVariant } from './pipeline-variants.mjs';

// ---- one write coordinator per db handle --------------------------------
export { writeQueueForDatabase } from './pipeline-write-queue.mjs';

// ---- server / client entrypoints -----------------------------------------
export { createServer } from './pipeline-server.mjs';
export { createClient } from './pipeline-client.mjs';
