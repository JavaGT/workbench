// Composite patch delivery (#122 design §8/§10/§12).
//
// Glue between the owned live-delivery seam and the composite patch
// machinery: capability parsing, bootstrap-with-ledger, catch-up over the
// journal, and per-recipient envelope assembly. Kept OUT of
// live-delivery-public.ts so that module stays the snapshot-only authority;
// this module composes it, never duplicates it.

import { tryParseScopeKey } from './scope-handle.mjs';

import { readSeq } from './committed-log.mjs';
import { currentCompositeSeq, minCompositeSeq, readCompositeChangesSince, readDeclarationWideChangesSince } from './composite-journal.mjs';
import { compilePatchPlans } from './composite-patch-plan.mjs';

                                                                                                 import { createProjectionLedger } from './projection-token.mjs';

import { projectCompositePatch } from './composite-patch-projector.mjs';




/** The unadvertised capability string servers accept during rollout step 1. */
export const SNAPSHOT_PATCH_CAPABILITY = 'snapshot-patch/v1';



















export function parseRequestedCapabilities(capabilities         )                            {
  if (!Array.isArray(capabilities)) return { patchCapable: false };
  return { patchCapable: capabilities.includes(SNAPSHOT_PATCH_CAPABILITY) };
}

/**
 * Create the composite patch lane for one owned delivery. Returns null when no
 * composite declarations exist — hosts without snapshots keep today's exact
 * behavior with zero new state.
 */
// Bounded catch-up (cross-exam 7): max journal rows per patch request.
const COMPOSITE_PATCH_MAX_CHANGES = 500;
// Retry symmetry with aggregateSnapshot's 3 attempts (cross-exam 8).
const COMPOSITE_PATCH_ATTEMPTS = 3;
// Sustained-failure threshold before the backpressure warning fires.
const COMPOSITE_PATCH_BACKPRESSURE_THRESHOLD = 10;

export function createCompositePatchDelivery({ db, composites, mayVerb, authorization, includeActionId }                               )                                {
  const compiled = [...composites.entries()]                            ;
  if (compiled.length === 0) return null;
  // The public SnapshotDeclaration is structurally wider (looser) than the
  // compiled one; the plan compiler reads only the shared structural shape.
  const plans = compilePatchPlans(compiled         );
  const ledger = createProjectionLedger();
  return new CompositePatchDelivery(db, new Map(compiled), plans, ledger, mayVerb, authorization, includeActionId);
}

export class CompositePatchDelivery {
                   db          ;
                   composites                              ;
                   plans                                      ;
                   ledger                  ;
                   mayVerb         ;
                   authorization         ;
                   includeActionId         ;
                   maxCatchupChanges        ;
  /** Consecutive fallback outcomes — reset on any successful projection. */
          fallbackStreak = 0;
          backpressureWarned = false;

  constructor(db          , composites                              , plans                                      , ledger                  , mayVerb         , authorization         , includeActionId         , maxCatchupChanges = COMPOSITE_PATCH_MAX_CHANGES) {
    this.db = db;
    this.composites = composites;
    this.plans = plans;
    this.ledger = ledger;
    this.mayVerb = mayVerb;
    this.authorization = authorization;
    this.includeActionId = includeActionId;
    this.maxCatchupChanges = maxCatchupChanges;
  }

  planFor(scopeHandle             )                         {
    return this.plans.get(scopeHandle.entity) ?? null;
  }

  /**
   * Bootstrap for a patch-capable recipient: run the host's ordinary snapshot
   * result through the SAME capture/authorize/project seam (the caller supplies
   * its already-authorized snapshot value), then register the visibility
   * ledger and mint the first token.
   */
  async bootstrapFromSnapshot({ principal, scope, snapshotValue, anchorCursor }






   )                                {
    const handle = tryParseScopeKey(scope);
    const plan = handle ? this.plans.get(handle.entity) : null;
    const declaration = handle ? this.composites.get(handle.entity         ) : undefined;
    if (!handle || !plan || !declaration) return { kind: 'revoked' };
    // Derive visibility AND keyed-ancestor addresses from the projected value
    // itself — one walk against the plan (#157); the patch lane updates both
    // incrementally afterwards, so bootstrap is their only full derivation.
    const { visible, addresses } = deriveVisibilityExtendedExport(plan, snapshotValue);
    const cursor                    = Object.freeze({ anchor: anchorCursor, composite: currentCompositeSeq(this.db, scope) });
    const { projectionToken } = this.ledger.register({ principal, scope, planVersion: plan.version, cursor, visible, addresses });
    return {
      kind: 'snapshot',
      snapshot: snapshotValue,
      cursor,
      projectionToken,
      protocol: SNAPSHOT_PATCH_CAPABILITY,
    };
  }

  /**
   * Catch-up for a patch-capable recipient: validate token + cursor, replay
   * the journal slice into ONE coalesced patch envelope, rotate the token.
   *
   * Bounded (cross-exam 7): reads at most `maxChanges` journal rows; overflow
   * falls back to a snapshot rather than materializing an unbounded slice.
   * Retry-symmetric (cross-exam 8): the projector's stable-fence check is
   * retried up to `attempts` times — the same bounded discipline
   * aggregateSnapshot uses — before any fallback.
   */
  async catchupWithPatches(input                                                                                            )



    {
    const handle = tryParseScopeKey(input.scope);
    const plan = handle ? this.plans.get(handle.entity) : null;
    if (!handle || !plan) return { kind: 'revoked' };
    const entry = this.ledger.resolve({
      token: input.projectionToken,
      principal: input.principal,
      scope: input.scope,
      planVersion: plan.version,
      cursor: input.after,
    });
    if (!entry) return { kind: 'snapshot-fallback', reason: 'projection-token-missing-or-mismatched' };

    // The effective journal head for this recipient is the MAX of its scope's
    // own sequence and the declaration-wide invalidation sequence (FIX 2):
    // a wide invalidation must pull every lagging recipient into recovery even
    // though their own scope counter did not move. Because the two sequences
    // are independent counters, presence (not magnitude) is what matters: ANY
    // declaration-wide invalidating entry forces this catch-up to snapshot —
    // invalidations are rare, so the conservative cost is one resnapshot per
    // invalidation event across subscribers.
    const wideChanges = readDeclarationWideChangesSince(this.db, plan.declaration, 0);
    if (wideChanges.length > 0) {
      return { kind: 'snapshot-fallback', reason: 'declaration-wide-invalidation' };
    }
    const toComposite = currentCompositeSeq(this.db, input.scope);
    if (input.after.composite > toComposite) return { kind: 'snapshot-fallback', reason: 'cursor-ahead-of-journal' };
    if (input.after.composite === toComposite) {
      return { kind: 'catchup', envelopes: [], cursor: input.after };
    }
    // Bounded read (cross-exam 7): one row beyond the budget proves overflow.
    // Declaration-wide invalidating entries (scope '') apply to EVERY scope of
    // this declaration and must be merged into the slice.
    const changes = [
      ...readCompositeChangesSince(this.db, input.scope, input.after.composite, this.maxCatchupChanges + 1),
      ...readDeclarationWideChangesSince(this.db, plan.declaration, input.after.composite),
    ].sort((left, right) => left.seq - right.seq);
    const scopedChanges = changes.filter((change) => change.scope === input.scope);
    if (scopedChanges.length > this.maxCatchupChanges) {
      return { kind: 'snapshot-fallback', reason: 'catchup-budget-exceeded' };
    }
    // Internal contiguity (FIX 4): a retained slice with INTERNAL holes
    // (e.g. [1,3]) is unfillable mid-history — the recipient cannot replay a
    // gap. Every returned scoped seq must equal previous + 1 starting at the
    // cursor.
    let expected = input.after.composite + 1;
    for (const change of scopedChanges) {
      if (change.seq !== expected) {
        return { kind: 'snapshot-fallback', reason: 'journal-gap' };
      }
      expected += 1;
    }
    const min = minCompositeSeq(this.db, input.scope);
    if (changes.length === 0 || (min !== null && min > input.after.composite + 1)) {
      return { kind: 'snapshot-fallback', reason: 'journal-gap' };
    }
    if (changes.some((change) => change.invalidating)) {
      return { kind: 'snapshot-fallback', reason: 'journal-invalidating-change' };
    }

    // Retry symmetry with aggregateSnapshot (cross-exam 8): a moving journal
    // fence is retried, not immediately failed; contention exhaustion is a
    // retry outcome, not silent success.
    let projection                         = null;
    let lastError          = null;
    let capturedAnchorFence = input.after.anchor;
    for (let attempt = 0; attempt < COMPOSITE_PATCH_ATTEMPTS; attempt += 1) {
      try {
        const declaration = this.composites.get(handle.entity) ;
        // The anchor fence is captured BEFORE each capture pass begins
        // (re-review GAP 4) and delivered as `to.anchor` — identical semantics
        // to aggregateSnapshot's captured.anchor: the patch's state was read
        // AT this anchor, so the recipient advances exactly there and never
        // further. The projector re-reads the fence after projection; any
        // movement throws into the retry below.
        const anchorFenceBeforeCapture = readSeq(this.db, input.scope);
        capturedAnchorFence = anchorFenceBeforeCapture;
        projection = await projectCompositePatch({
          db: this.db,
          principal: input.principal,
          scope: input.scope,
          plan,
          declaration: declaration         ,
          mayVerb: this.mayVerb,
          authorization: this.authorization,
          from: input.after,
          to: { anchor: anchorFenceBeforeCapture, composite: toComposite },
          changes,
          includeActionId: this.includeActionId,
          priorVisible: entry.visible,
          priorAddresses: entry.addresses ?? new Map(),
          readCompositeSeq: () => currentCompositeSeq(this.db, input.scope),
          readAnchorSeq: () => readSeq(this.db, input.scope),
        });
        if (projection.revokedAnchor === false && projection.operations.length >= 0 && input.after.composite > toComposite) {
          throw new Error('journal moved during patch projection');
        }
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (projection === null) {
      // Backpressure counter (cross-exam 8): sustained failure storms are
      // surfaced to the host log so chronic token/ledger churn is observable;
      // the recipient still receives the canonical full snapshot.
      this.fallbackStreak += 1;
      if (this.fallbackStreak >= COMPOSITE_PATCH_BACKPRESSURE_THRESHOLD && !this.backpressureWarned) {
        this.backpressureWarned = true;
        console.warn('[composite-patch] sustained patch-projection fallback storm', { scope: input.scope, streak: this.fallbackStreak });
      }
      void lastError;
      return { kind: 'snapshot-fallback', reason: lastError instanceof Error ? lastError.message : 'patch-projection-failed' };
    }
    this.fallbackStreak = 0;
    this.backpressureWarned = false;
    try {
      if (projection.revokedAnchor) return { kind: 'revoked' };
      // GAP 4: the ledger + envelope advance to the SAME fence the state was
      // projected at — never a fresher readSeq taken after projection.
      const cursorAfter                    = Object.freeze({ anchor: capturedAnchorFence, composite: toComposite });
      const { projectionToken } = this.ledger.register({
        principal: input.principal,
        scope: input.scope,
        planVersion: plan.version,
        cursor: cursorAfter,
        visible: projection.visibleAfter,
        addresses: projection.addressesAfter,
      });
      const envelope                           = {
        type: 'snapshot-patch',
        protocol: 'snapshot-patch/v1',
        declaration: plan.declaration,
        from: input.after,
        to: cursorAfter,
        seqSpan: [input.after, cursorAfter],
        ...(this.includeActionId && projection.actionIds.length > 0 ? { actionIds: projection.actionIds } : {}),
        ...(this.includeActionId && projection.routedInvisibleActionIds.length > 0 ? { routedInvisibleActionIds: projection.routedInvisibleActionIds } : {}),
        operations: projection.operations,
        projectionToken,
      };
      return { kind: 'catchup', envelopes: [envelope], cursor: cursorAfter };
    } catch (error) {
      return { kind: 'snapshot-fallback', reason: error instanceof Error ? error.message : 'patch-projection-failed' };
    }
  }

  close()       {
    this.ledger.clear();
  }
}

// One shared visibility walk (kept out of the projector's export surface to
// avoid a public API beyond what tests consume; both call sites use this).
import { deriveVisibilityExtended } from './composite-patch-projector.mjs';
function deriveVisibilityExtendedExport(plan                 , projected                         )                                                                                                {
  return deriveVisibilityExtended(plan, projected);
}
