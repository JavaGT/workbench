// Compile-produced contribution-history policy registry (scope#992 W2/W3).
//
// Replaces the loose application-side classifier object (the retired
// per-action-type scopes/eligibility bag) with one registry keyed by outer
// registered action type and annotated contribution handle. The registry is
// compiled at application assembly time from the annotated field declarations
// and the registered compound actions' `operations` handles. It is inert data
// until durable-history movement consults it; it owns NO grant decisions —
// those go through `authorizationRequirements` and the central
// `authorize`/`admitRow` seam (scope#992 rev 2 Finding 9).
//
// Module authority (scope#992 Finding 7): this module is the sole home of
// contribution-policy compilation and classification. There is no second
// contribution classifier on the history engine.
//
// A policy entry is keyed by outer action type. Native annotated insert
// actions and registered compound actions both receive entries here; the
// retired compensation-symbol routing and the annotated-move special cases
// are subsumed by this single seam (#145 S5).

// W3_HISTORY_RETIRED
// ---------------------------------------------------------------------------
// #145 slice 5 completed: the special-case retirement census is done. The
// checker's retired-symbol rules, the movement module boundary, and the retired
// public classifier-option surface bans are ACTIVE from this marker onward
// (they were gated on its presence to allow incremental slices).

import type { DbHandle } from './driver.ts';
import type { CompoundContributionEnvelope } from './compound-contribution-fact.ts';
import { canonicalJsonEqual, parseCompoundContributionFact } from './compound-contribution-fact.ts';
import { assertV9AnnotatedTextOffsetEditPayload } from './entity/crud.ts';
import { forbidden } from './outcome.ts';

export type ContributionPolicyFilter = 'eligible' | 'barrier' | 'excluded';

export interface ContributionHandle {
  readonly entity: string;
  readonly fieldName: string;
}

/**
 * A compiled contribution policy for one outer action type. The policy owns
 * ordering (which checks run in which phase) but never grant decisions; every
 * authorization requirement is resolved by the central authorization seam.
 */
export interface HistoryContributionPolicy {
  readonly actionType: string;
  readonly handle: ContributionHandle;
  /**
   * Compiled annotated-text field declaration (descriptor carrying the
   * `annotations` config), supplied by the kernel for compound actions so the
   * transaction-bound compensation planner can derive the compiled metadata.
   * Undefined for native-insert policies (their compensation flows through the
   * existing generated handler).
   */
  readonly fieldDeclaration?: unknown;
  /**
   * Classify a canonical outer payload into cursor/move eligibility. A native
   * insert is eligible only when it is a text insert; a registered compound
   * action whose payload no longer carries an operable document is a barrier.
   */
  readonly classify: (payload: unknown) => ContributionPolicyFilter;
  /** Parse the complete origin envelope from a stored receipt row. */
  readonly parseOriginFact: (fact: Readonly<Record<string, unknown>>) => CompoundContributionEnvelope;
  /** Parse the complete target envelope from a stored receipt row. */
  readonly parseTargetFact: (fact: Readonly<Record<string, unknown>>) => CompoundContributionEnvelope;
  /**
   * Select and parse the target fact for a contribution chain, validating the
   * linkage (root/target/direction/outcome) and the document/action identity.
   * This is the registry-owned replacement for the retired hardcoded
   * annotated-move target-fact selection (#145 MAJOR 2): durable-history calls
   * it on every contribution move (first undo, redo-of-undo, later undo) and
   * never selects the target itself.
   */
  readonly selectAndParseTargetFact: (ctx: {
    origin: { actionId: string; payload: unknown };
    target: { actionId: string; historyTargetActionId: string | null };
    operation: 'undo' | 'redo';
    rootActionId: string;
    originFact: CompoundContributionEnvelope;
    targetFact: CompoundContributionEnvelope;
    receipt: { actionId: string; operation: string };
  }) => CompoundContributionEnvelope;
  /**
   * Validate a compound history translation target: same outer action type,
   * scope, and canonical origin payload, with handler-only input, and never a
   * native annotated target. The registry owns this decision; durable-history
   * calls it instead of action-name tests.
   */
  readonly validateTranslation: (ctx: {
    translated: readonly { type: string }[];
    origin: { type: string | null; payload: unknown; scope: string };
    operation: 'undo' | 'redo';
    scope: string;
  }) => void;
  /**
   * Policy-owned authorization sequencing. Phase is 'authorize' (before private
   * material is loaded) during first moves and deduped retries.
   */
  readonly authorizationRequirements: (phase: { phase: 'authorize'; origin: unknown; target: unknown }) => 'outer' | 'outer-field' | 'none';
}

export interface NativeInsertPolicyOptions {
  readonly entity: string;
  readonly fieldName: string;
}

/** Compile a native annotated text-insert contribution policy. */
export function compileNativeInsertContributionPolicy(handle: NativeInsertPolicyOptions, actionType: string): HistoryContributionPolicy {
  return compilePolicy({ actionType, handle, nativeInsert: true });
}

/** Compile a registered compound action's contribution policy. */
export function compileCompoundContributionPolicy(handle: ContributionHandle, actionType: string, fieldDeclaration?: unknown): HistoryContributionPolicy {
  return compilePolicy({ actionType, handle, nativeInsert: false, fieldDeclaration });
}

function compilePolicy(opts: { actionType: string; handle: ContributionHandle; nativeInsert: boolean; fieldDeclaration?: unknown }): HistoryContributionPolicy {
  const { actionType, handle, nativeInsert, fieldDeclaration } = opts;
  const policy: HistoryContributionPolicy = {
    actionType,
    handle,
    ...(fieldDeclaration === undefined ? {} : { fieldDeclaration }),
    classify(payload) {
      if (nativeInsert) {
        return classifyNativeInsert(handle, payload);
      }
      return documentIdPresent(payload) ? 'eligible' : 'barrier';
    },
    parseOriginFact(fact) {
      // Compound rows parse through the exact package parser; native rows ARE
      // their own canonical shape (returned unchanged). The policy owns the
      // parse — the caller never re-parses or re-shapes it.
      if (nativeInsert) return fact as unknown as CompoundContributionEnvelope;
      return parseCompoundContributionFact(fact);
    },
    parseTargetFact(fact) {
      if (nativeInsert) return fact as unknown as CompoundContributionEnvelope;
      return parseCompoundContributionFact(fact);
    },
    selectAndParseTargetFact({ origin, target, operation, rootActionId, originFact, targetFact, receipt }) {
      // A move compensates the HEAD receipt (rev 3 §1). The FIRST move of the
      // root targets the origin itself; any chain move targets the current head
      // receipt's OWN envelope — selected and linkage-validated HERE, never by
      // the history engine.
      if (origin.actionId === target.actionId) {
        if (nativeInsert) {
          // The chain-move branch below validates head receipts, but the
          // first move targets the origin's own fact — validate its shape
          // here. Without this, a malformed origin fact ({}, wrong
          // kind/version) passes through and fails late inside the handler,
          // where the pipeline converts the throw into a resolved failure
          // object instead of the fail-closed rejection the undo contract
          // requires (malformed/erased inverse facts fail closed).
          // Eligible native origins only: v2 contribution (text.insert,
          // annotation.paste) and v2 annotation-update, bound to the origin
          // document. Delete/barrier origins never reach selection (barriers
          // cleave the cursor); anything else fails closed here.
          const of = originFact as { version?: unknown; kind?: unknown; documentId?: unknown };
          if ((of?.kind !== 'annotated-text.contribution' && of?.kind !== 'annotated-text.annotation-update')
            || of?.version !== 2
            || of?.documentId !== (origin.payload as { id?: unknown } | null | undefined)?.id) throw forbidden();
        }
        return originFact;
      }
      void operation;
      const rawLink = (targetFact as { linkage?: unknown }).linkage ?? null;
      const linkage = rawLink && typeof rawLink === 'object'
        ? rawLink as { rootActionId?: unknown; targetActionId?: unknown; direction?: unknown; outcome?: unknown }
        : null;
      if (nativeInsert) {
        const tf = targetFact as { version?: unknown; kind?: unknown; documentId?: unknown };
        if (tf?.version !== 2 || tf.kind !== 'annotated-text.compensation'
          || tf.documentId !== (origin.payload as { id?: unknown } | null | undefined)?.id
          || linkage?.rootActionId !== rootActionId
          || linkage?.targetActionId !== target.historyTargetActionId
          || linkage?.direction !== receipt.operation
          || (linkage?.outcome !== 'applied' && linkage?.outcome !== 'noop')) throw forbidden();
        return targetFact;
      }
      // Compound compensation envelope: the linkage must exactly name this
      // chain (root, head target, the target receipt's own direction, and an
      // applied/noop outcome). A forged/mismatched head is opaque forbidden.
      if (!linkage || linkage.rootActionId !== rootActionId
        || linkage.targetActionId !== target.historyTargetActionId
        || linkage.direction !== receipt.operation
        || (linkage.outcome !== 'applied' && linkage.outcome !== 'noop')) throw forbidden();
      return targetFact;
    },
    validateTranslation({ translated, origin, operation, scope }) {
      void operation; void scope;
      if (nativeInsert) {
        // Native moves re-dispatch ONLY the field's own compensate action, bound
        // to the same document the origin operated on (handler-only input).
        const compensateType = `${handle.entity}.${handle.fieldName}.compensate`;
        if (translated.length !== 1 || translated[0].type !== compensateType) throw forbidden();
        const payload = (translated[0] as { payload?: unknown }).payload;
        if (!payload || typeof payload !== 'object'
          || (payload as { id?: unknown }).id !== (origin.payload as { id?: unknown } | null | undefined)?.id) throw forbidden();
        return;
      }
      // Compound moves re-dispatch the SAME outer action exactly once, with the
      // canonical origin payload and handler-only input (never a native target).
      if (translated.length !== 1 || translated[0].type !== actionType
        || !canonicalJsonEqual((translated[0] as { payload?: unknown }).payload, origin.payload)) throw forbidden();
    },
    authorizationRequirements() {
      return 'outer-field';
    },
  };
  return policy;
}

function documentIdPresent(payload: unknown): boolean {
  return !!payload && typeof payload === 'object'
    && typeof (payload as { id?: unknown }).id === 'string'
    && (payload as { id: string }).id.length > 0;
}

function classifyNativeInsert(handle: ContributionHandle, payload: unknown): ContributionPolicyFilter {
  if (!documentIdPresent(payload)) return 'barrier';
  // Strict-equivalent classification (hostile review MAJOR 1): the retired
  // classifier only called an action eligible after the FULL v9 offset-edit
  // shape validation (assertV9AnnotatedTextOffsetEditPayload) AND a non-empty
  // text.insert edit. A malformed persisted receipt (missing fields, wrong
  // types, bad offsets/position tokens) must never reconstruct as eligible on
  // cursor/list reconstruction. Per the rev-2 matrix, classification fails
  // CLOSED: malformed/non-insert native actions are BARRIERS (the "unsupported
  // annotated action is a barrier" law) — the cursor cleaves there instead of
  // exposing an older insert across it. There is no annotated-move special case.
  //
  // #174 exception: `annotation.update` is also ELIGIBLE — it is a semantic
  // atomic step whose compensation rides its own captured before/after image
  // fact (annotated-text.annotation-update), with compare-and-compensate no-ops
  // when the live state moved on.
  let command: { edit: { kind: string; text?: string } };
  try {
    command = assertV9AnnotatedTextOffsetEditPayload(handle.entity, handle.fieldName, payload);
  } catch {
    return 'barrier';
  }
  if (command.edit.kind === 'text.insert' && typeof command.edit.text === 'string' && command.edit.text.length > 0) {
    return 'eligible';
  }
  // A paste is a text insert with an annotation sidecar: the same insert
  // algebra applies, and the created annotation compensates atomically.
  if (command.edit.kind === 'annotation.paste' && typeof command.edit.text === 'string' && command.edit.text.length > 0) {
    return 'eligible';
  }
  if (command.edit.kind === 'annotation.update') {
    return 'eligible';
  }
  return 'barrier';
}

export interface HistoryContributionPolicyRegistry {
  readonly policies: ReadonlyMap<string, HistoryContributionPolicy>;
  /** Return the compiled policy for an outer action type, or null. */
  readonly policyFor: (actionType: string | null | undefined) => HistoryContributionPolicy | null;
  /** True when any policy is registered. */
  readonly hasAny: boolean;
  /** Classify a payload through its action type's policy. */
  readonly classify: (context: { type: string | null | undefined; payload: unknown }) => ContributionPolicyFilter | null;
  /** The frozen declaration-derived read-privacy scope set (for actions()/events() only). */
  readonly privateHistoryScopes: ReadonlySet<string>;
}

/**
 * Assemble a contribution-policy registry. `privateHistoryScopes` is the
 * declaration-derived set of annotation entity names used ONLY by the
 * history `actions()`/`events()` read boundary (rev 3 §3) — it has no
 * eligibility, barrier, target-selection, retry, or compensation role.
 */
export function createHistoryContributionPolicyRegistry({
  policies,
  privateHistoryScopes,
}: {
  policies: readonly HistoryContributionPolicy[];
  privateHistoryScopes: ReadonlySet<string> | readonly string[];
}): HistoryContributionPolicyRegistry {
  const map = new Map(policies.map((policy) => [policy.actionType, policy]));
  const scopes = new Set(privateHistoryScopes);
  const registry: HistoryContributionPolicyRegistry = {
    policies: map,
    hasAny: map.size > 0,
    policyFor(actionType: string | null | undefined) {
      if (typeof actionType !== 'string') return null;
      return map.get(actionType) ?? null;
    },
    classify({ type, payload }: { type: string | null | undefined; payload: unknown }) {
      const policy = type == null ? null : map.get(type);
      if (!policy) return null;
      return policy.classify(payload);
    },
    privateHistoryScopes: scopes,
  };
  return Object.freeze(registry);
}

// Re-exported for the move engine's authorization seam.
export type { DbHandle };
