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



import { canonicalJsonEqual, parseCompoundContributionFact } from './compound-contribution-fact.mjs';
import { assertV9AnnotatedTextOffsetEditPayload } from './entity/crud.mjs';
import { forbidden } from './outcome.mjs';








/**
 * A compiled contribution policy for one outer action type. The policy owns
 * ordering (which checks run in which phase) but never grant decisions; every
 * authorization requirement is resolved by the central authorization seam.
 */






























































/** Compile a native annotated text-insert contribution policy. */
export function compileNativeInsertContributionPolicy(handle                           , actionType        )                            {
  return compilePolicy({ actionType, handle, nativeInsert: true });
}

/** Compile a registered compound action's contribution policy. */
export function compileCompoundContributionPolicy(handle                    , actionType        , fieldDeclaration          )                            {
  return compilePolicy({ actionType, handle, nativeInsert: false, fieldDeclaration });
}

function compilePolicy(opts                                                                                                       )                            {
  const { actionType, handle, nativeInsert, fieldDeclaration } = opts;
  const policy                            = {
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
      if (nativeInsert) return fact                                           ;
      return parseCompoundContributionFact(fact);
    },
    parseTargetFact(fact) {
      if (nativeInsert) return fact                                           ;
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
          const of = originFact                                                               ;
          if ((of?.kind !== 'annotated-text.contribution' && of?.kind !== 'annotated-text.annotation-update')
            || of?.version !== 2
            || of?.documentId !== (origin.payload                                       )?.id) throw forbidden();
        }
        return originFact;
      }
      void operation;
      const rawLink = (targetFact                         ).linkage ?? null;
      const linkage = rawLink && typeof rawLink === 'object'
        ? rawLink
        : null;
      if (nativeInsert) {
        const tf = targetFact                                                               ;
        if (tf?.version !== 2 || tf.kind !== 'annotated-text.compensation'
          || tf.documentId !== (origin.payload                                       )?.id
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
        const payload = (translated[0]                         ).payload;
        if (!payload || typeof payload !== 'object'
          || (payload                    ).id !== (origin.payload                                       )?.id) throw forbidden();
        return;
      }
      // Compound moves re-dispatch the SAME outer action exactly once, with the
      // canonical origin payload and handler-only input (never a native target).
      if (translated.length !== 1 || translated[0].type !== actionType
        || !canonicalJsonEqual((translated[0]                         ).payload, origin.payload)) throw forbidden();
    },
    authorizationRequirements() {
      return 'outer-field';
    },
  };
  return policy;
}

function documentIdPresent(payload         )          {
  return !!payload && typeof payload === 'object'
    && typeof (payload                    ).id === 'string'
    && (payload                  ).id.length > 0;
}

function classifyNativeInsert(handle                    , payload         )                           {
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
  let command                                           ;
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













/**
 * Assemble a contribution-policy registry. `privateHistoryScopes` is the
 * declaration-derived set of annotation entity names used ONLY by the
 * history `actions()`/`events()` read boundary (rev 3 §3) — it has no
 * eligibility, barrier, target-selection, retry, or compensation role.
 */
export function createHistoryContributionPolicyRegistry({
  policies,
  privateHistoryScopes,
}


 )                                    {
  const map = new Map(policies.map((policy) => [policy.actionType, policy]));
  const scopes = new Set(privateHistoryScopes);
  const registry                                    = {
    policies: map,
    hasAny: map.size > 0,
    policyFor(actionType                           ) {
      if (typeof actionType !== 'string') return null;
      return map.get(actionType) ?? null;
    },
    classify({ type, payload }                                                       ) {
      const policy = type == null ? null : map.get(type);
      if (!policy) return null;
      return policy.classify(payload);
    },
    privateHistoryScopes: scopes,
  };
  return Object.freeze(registry);
}

// Re-exported for the move engine's authorization seam.

