// The annotated-text field kind's contribution to the Kernel and Pipeline.
// Kernel and pipeline stay thin generic assemblers: annotatedText authorization,
// generated history (undo/redo compensation) actions, composed region-action
// compilation, and compound commit/compensation hooks live here, in the module
// that owns the kind, and are contributed as a seam rather than hand-listed in
// kernel.ts or pipeline.ts.

import { ANNOTATED_COMPENSATION_INPUT } from './annotated-text-crud.mjs';
import { admitRow } from './row-grant.mjs';
import { write } from './grant.mjs';
import { rawRow } from './entity/query.mjs';
import { tryParseScopeKey } from './scope-handle.mjs';
import * as eventHandles from './event-handle.mjs';
import { ValidationError } from './field-strategy.mjs';
import { canonicalStringify } from './canonical-json.mjs';
import {
  compileCompoundContributionPolicy,
  compileNativeInsertContributionPolicy,

} from './history-contribution-policy.mjs';
import { compileRegionFieldPolicy,                                   } from './annotated-text-region-operation.mjs';
import { ANNOTATED_TEXT_STALE } from './annotated-text-region-limits.mjs';
import {
  loadRegionCompensationContext,
  planRegionCompensation,
  readMoveCompensationTarget,
} from './annotated-text-region-compensation.mjs';
import {
  applicationPrivateFactView,
  canonicalJsonEqual,
  constructCompoundCompensationEnvelope,
  constructCompoundOriginEnvelope,
  parseCompoundApplicationTransition,
  parseCompoundApplicationTransitionInput,
  validateApplicationTransition,
} from './compound-contribution-fact.mjs';





















function compoundHistoryTranslation(type        , input     , direction                 ) {
  // A composed action's undo/redo is ONE outer re-dispatch with handler-only
  // compound input (scope#992 rev 3 §1). The outer payload is the origin's
  // canonical payload; the handler input carries the expected/replacement
  // application transition the package validator will check.
  const fact = (input.fact ?? null)                                  ;
  if (!fact) throw new Error(`compound history translation for '${type}' requires the origin application fact`);
  void direction;
  const origin = input.origin                                     ;
  const payload = origin?.payload ?? {};
  // Undo: expected = head.after, replacement = head.before. Redo mirrors it.
  const expected = fact.after ?? null;
  const replacement = fact.before ?? null;
  return { type, payload, input: { version: 1, expected, replacement } };
}

/**
 * Compile a registered action's closed `operations` declaration of
 * `annotatedTextOperation` handles at app-assembly time. Returns `null` when
 * the action declares no annotated operations.
 */
export function compileComposedAnnotatedTextAction(
  declaration     ,
  entities                  ,
  db     ,
)                                         {
  const operations = declaration.operations === undefined ? [] : declaration.operations;
  if (!Array.isArray(operations)) {
    throw new Error(`registered action '${declaration.type}' operations must be an array`);
  }
  if (operations.length === 0) return null;
  if (operations.length > 1) {
    throw new Error(`registered action '${declaration.type}' may declare at most one annotated operation (single-dispatch composition)`);
  }
  const handle = operations[0]                                ;
  if (!handle || (handle                         ).__brand !== 'annotatedTextOperation') {
    throw new Error(`registered action '${declaration.type}' operations must contain annotatedTextOperation handles`);
  }
  const compoundContributionPolicy = compileRegionFieldPolicy(handle, entities, db);
  // A composed action is single-dispatch and may never return a top-level
  // privateFact; Workbench constructs the compound envelope.
  if ((declaration                             ).privateFact === true) {
    throw new Error(`registered action '${declaration.type}' is composed and cannot return a top-level privateFact`);
  }
  const contributionPolicy = compileCompoundContributionPolicy(
    { entity: compoundContributionPolicy.entity, fieldName: compoundContributionPolicy.field },
    declaration.type,
    entities.get(compoundContributionPolicy.entity)?.fields?.[compoundContributionPolicy.field],
  );
  // A declaration-generated receipt matcher compares the exact canonical
  // outer payload (scope#992 W2): same actionId plus a different payload is
  // a conflict, not a replay.
  const dedupeReceiptMatches = (receipt     , request     ) =>
    receipt.actionType === declaration.type && receipt.actionData === canonicalStringify(request.payload);
  const historyAction = {
    inverse: (input     ) => compoundHistoryTranslation(declaration.type, input, 'undo'),
    redo: (input     ) => compoundHistoryTranslation(declaration.type, input, 'redo'),
  };
  return { compoundContributionPolicy, contributionPolicy, dedupeReceiptMatches, historyAction };
}

/**
 * Pipeline commit hook for composed annotated-text registered actions
 * (scope#992 W2/W3): transforms a composed action's commit or history
 * compensation inside the coordinated transaction, constructs its single
 * compound private-fact envelope, and unwraps the narrow application view for
 * opted-in projections.
 */
export function createAnnotatedTextCommitHook()                     {
  const hook                     = {
    isConflictCode(code         )          {
      return code === ANNOTATED_TEXT_STALE;
    },
    requiresPrivateFact(handler     )          {
      return Boolean(handler?.compoundContributionPolicy);
    },
    projectionPrivateFactView(privateFact                                   )                                    {
      return applicationPrivateFactView(privateFact);
    },
    async transformCommit({ db, handler, commit, type, payload, principal, scope, actionId, historyCommit, contributionPolicies }) {
      const composedPolicy = handler?.compoundContributionPolicy;
      if (!composedPolicy) {
        if (Object.hasOwn(commit, 'annotatedText') || Object.hasOwn(commit, 'applicationTransition')) {
          // scope#992 W2: a region descriptor is only lawful through a DECLARED
          // annotated operation. Returning one from an undeclared handler would be
          // ambient operation authority — fail closed, never silently drop it.
          throw new TypeError(`undeclared annotated operation was admitted for action '${type}'`);
        }
        return commit;
      }
      if (Array.isArray(payload) || type === '$batch') {
        throw new TypeError(`composed action '${type}' is single-dispatch and batch-forbidden`);
      }
      // History moves (durable-history.move re-dispatches the outer composed
      // action with handler-only compound input). W3 (#145) owns the applied
      // document compensation: the contribution policy plans the inverse of
      // the TARGET receipt's region against CURRENT state and, when safely
      // applicable, emits a fresh v16 operated compensation event plus an
      // `applied` compensation envelope with linkage. An unsafe target (or a
      // target with nothing to compensate) commits the explicit whole-compound
      // no-op compensation envelope (rev 2 Finding 3 outcome): zero document
      // events, lineage preserved, cursor advanced.
      if (historyCommit?.handlerInputs && historyCommit.apply) {
        const moveInput = historyCommit.handlerInputs[0];
        const applicationRaw = commit.applicationTransition;
        if (!applicationRaw || typeof applicationRaw !== 'object'
          || !Object.hasOwn(applicationRaw, 'before') || !Object.hasOwn(applicationRaw, 'after')) {
          throw new TypeError(`composed action '${type}' history applicationTransition must be { before, after }`);
        }
        const metadata = historyCommit.metadata ?? {};
        const direction = moveInput?.operation === 'redo' ? 'redo' : 'undo';
        const rootActionId = metadata.historyRootActionId ?? actionId;
        const targetActionId = metadata.historyTargetActionId ?? actionId;
        const policy = contributionPolicies?.policyFor(type);
        const fieldDeclaration = policy?.fieldDeclaration;

        const target = readMoveCompensationTarget(db, {
          scope, entity: composedPolicy.entity, field: composedPolicy.field,
          rootActionId, targetActionId,
        });
        const targetLinkageNoop = 'linkage' in target.envelope && target.envelope.linkage.outcome === 'noop';
        if (target.event && !targetLinkageNoop) {
          const documentId = target.event.id;
          const context = loadRegionCompensationContext(
            db, { entity: composedPolicy.entity, field: composedPolicy.field }, documentId, fieldDeclaration, principal                                  , scope, actionId,
          );
          const planned = planRegionCompensation({ target: target.event, contribution: target.contribution, context, actionId });
          if (planned.outcome === 'applied') {
            const originApplication = target.originApplication
              ?? parseCompoundApplicationTransition({ before: null, after: null }, 'history origin application');
            const targetApplication = parseCompoundApplicationTransition(
              target.envelope.application, `composed action '${type}' history target application`,
            );
            const translatedInput = parseCompoundApplicationTransitionInput(moveInput.input);
            const returned = validateApplicationTransition({
              originApplication,
              targetApplication,
              translatedInput,
              returnedApplication: applicationRaw,
            });
            const operatedHandle = eventHandles.native(composedPolicy.entity, composedPolicy.field, 'operated');
            return {
              events: [Object.freeze({
                handle: operatedHandle,
                type: operatedHandle.type,
                scope: context.owningScope,
                data: Object.freeze(planned.event),
                v16Capability: planned.capability,
              })],
              privateFact: constructCompoundCompensationEnvelope({
                application: returned,
                contributions: planned.contribution ? [planned.contribution] : [],
                linkage: {
                  rootActionId,
                  targetActionId,
                  direction,
                  outcome: 'applied',
                },
              }),
              historyOutcome: 'applied',
            };
          }
        }
        const application = parseCompoundApplicationTransition(applicationRaw, `composed action '${type}' history applicationTransition`);
        return {
          events: [],
          privateFact: constructCompoundCompensationEnvelope({
            application,
            contributions: [],
            linkage: {
              rootActionId,
              targetActionId,
              direction,
              outcome: 'noop',
            },
          }),
          historyOutcome: 'noop',
        };
      }

      const composedKeys = ['events', 'annotatedText', 'applicationTransition'];
      const ownKeys = Object.keys(commit).filter((key) => !['directive', 'canonicalPayload', 'effects', 'historyOutcome', 'claimedBlobs'].includes(key));
      if (ownKeys.some((key) => !composedKeys.includes(key)) || !Array.isArray(commit.annotatedText) || commit.annotatedText.length !== 1) {
        throw new TypeError(`composed action '${type}' must return exactly { events, annotatedText, applicationTransition }`);
      }
      if (Object.hasOwn(commit, 'privateFact') && commit.privateFact !== undefined) {
        throw new TypeError(`composed action '${type}' cannot return a top-level privateFact`);
      }
      const applicationTransition = commit.applicationTransition;
      if (!applicationTransition || typeof applicationTransition !== 'object'
        || !Object.hasOwn(applicationTransition, 'before') || !Object.hasOwn(applicationTransition, 'after')) {
        throw new TypeError(`composed action '${type}' applicationTransition must be { before, after }`);
      }
      // An applied origin transition must differ by canonical equality (rev 3
      // rule 8); the full 8-rule semantic validator runs on history moves.
      {
        const { before, after } = applicationTransition                                       ;
        if (canonicalJsonEqual(before, after)) {
          throw new ValidationError(`composed action '${type}' applicationTransition before and after must differ`);
        }
      }
      const plan = await composedPolicy.admitAndPlan(db, commit.annotatedText[0], principal, { scope, actionId });
      // Append the package-authored operated event to the handler's domain
      // events; all commit together under one receipt.
      const operatedHandle = eventHandles.native(composedPolicy.entity, composedPolicy.field, 'operated');
      const { annotatedText: _annotatedText, applicationTransition: _transition, ...restCommit } = commit                           ;
      void _annotatedText;
      void _transition;
      return {
        ...restCommit,
        events: [...(Array.isArray(commit.events) ? commit.events : []), Object.freeze({
          handle: operatedHandle,
          type: operatedHandle.type,
          scope: plan.owningScope,
          data: Object.freeze(plan.envelope),
          // W1b (#149 round 2): single-use v16 admission nonce. The
          // NOW-token deep copy strips the envelope's symbol brand, so the
          // capability rides the event frame and is consumed exactly once by
          // committed-log's append. Opaque; minted only by the v16 constructor
          // inside admitAndPlan.
          v16Capability: plan.v16Capability,
        })],
        privateFact: constructCompoundOriginEnvelope({
          application: { before: applicationTransition.before, after: applicationTransition.after },
          contributions: plan.contribution ? [plan.contribution] : [],
        }),
      };
    },
  };
  return Object.freeze(hook);
}

export function createAnnotatedTextKernelSeam(entities                  )                          {
  const annotatedScopeEntities = new Set(
    [...entities.values()]
      .filter((entity     ) => Object.values(entity.fields).some((field     ) => field.kind === 'annotatedText'))
      .map((entity     ) => entity.name),
  );
  const annotatedActionDetails = new Map();
  for (const entity of entities.values()) for (const [fieldName, field] of Object.entries(entity.fields)) {
    if ((field       ).kind !== 'annotatedText') continue;
    annotatedActionDetails.set(`${entity.name}.${fieldName}.operation`, { entity, fieldName, field });
    annotatedActionDetails.set(`${entity.name}.${fieldName}.compensate`, { entity, fieldName, field, compensation: true });
  }

  // Compile-produced native-insert contribution policies (scope#992 Finding 6):
  // one policy entry per native annotated `.operation` and `.compensate` action
  // type, so the history engine's eligibility/barrier/retry decisions are
  // policy-owned rather than classifier-name-driven.
  const nativeInsertPolicies                                       = Object.freeze(
    [...annotatedActionDetails.keys()].map((actionType) =>
      compileNativeInsertContributionPolicy(
        { entity: annotatedActionDetails.get(actionType).entity.name, fieldName: annotatedActionDetails.get(actionType).fieldName },
        actionType,
      )),
  );
  // Declaration-derived read-privacy scope set. Used ONLY by the history
  // actions()/events() read boundary (rev 3 §3).
  const privateHistoryScopes                      = new Set(annotatedScopeEntities);

  // Annotated text history is a package-owned compensation action. It is not a
  // public action and is admitted only through the trusted history capability.
  const historyActions                      = {};
  for (const [type, detail] of annotatedActionDetails) {
    if (detail?.compensation) continue;
    historyActions[type] = {
      inverse: ({ origin, target, targetFact }     ) => ({ type: `${type.replace(/\.operation$/, '')}.compensate`, payload: { version: 1, id: origin.payload.id, history: { version: 1, rootActionId: origin.actionId, targetActionId: target.actionId, direction: 'undo' } }, input: { kind: ANNOTATED_COMPENSATION_INPUT, targetFact } }),
      redo: ({ origin, target, targetFact }     ) => ({ type: `${type.replace(/\.operation$/, '')}.compensate`, payload: { version: 1, id: origin.payload.id, history: { version: 1, rootActionId: origin.actionId, targetActionId: target.actionId, direction: 'redo' } }, input: { kind: ANNOTATED_COMPENSATION_INPUT, targetFact } }),
    };
  }

  // Returns true/false when the action is an annotated-text action, or null
  // when it is not — the Kernel then falls through to registered actions and
  // generated CRUD admission.
  async function authorize(context     , app     )                          {
    for (const entity of entities.values()) {
      for (const [fieldName, field] of Object.entries(entity.fields)) {
        if ((field       ).kind !== 'annotatedText') continue;
        for (const annotation of (field       ).annotations ?? []) {
          for (const [actionName, action] of Object.entries(annotation.actions ?? {})                        ) {
            const actionType = `${entity.name}.${fieldName}.${annotation.annotationName}.${actionName}`;
            if (context.type !== actionType) continue;
            const id = context.payload?.id;
            const row = typeof id === 'string' ? rawRow(app.db, entity.name, id) : null;
            if (!row) return false;
            if (!(await admitRow({ kind: 'fieldOp', entity, row: entity.deserializeRow({ ...row }), fieldName, capability: write, principal: context.principal }))) return false;
            if (action.kind === 'annotationAction') return true;
            const targetName = typeof (field       ).annotations?.find((candidate     ) => candidate.annotationName === annotation.annotationName)?.fields?.[action.relation]?.target === 'string'
              ? (field       ).annotations.find((candidate     ) => candidate.annotationName === annotation.annotationName).fields[action.relation].target
              : (field       ).annotations.find((candidate     ) => candidate.annotationName === annotation.annotationName).fields[action.relation].target?.name;
            const target = targetName ? app.entities?.get(targetName) : null;
            if (!target || !target.grant) return false;
            const candidate                      = { id: 'authorization-probe', [action.project]: row[(field       ).project], [action.author]: context.principal?.id };
            for (const [publicName, entityField] of Object.entries(action.input ?? {})) candidate[entityField          ] = context.payload?.values?.[publicName];
            if (!(await admitRow({ kind: 'verb', entity: target, row: candidate, verb: 'create', principal: context.principal }))) return false;
            return true;
          }
        }
      }
    }
    const annotated = annotatedActionDetails.get(context.type);
    if (annotated) {
      const id = context.payload?.id;
      if (typeof id !== 'string' || id.length === 0) return false;
      const row = rawRow(app.db, annotated.entity.name, id);
      if (!row) return false;
      return admitRow({
        kind: 'fieldOp',
        entity: annotated.entity,
        row: annotated.entity.deserializeRow({ ...row }),
        fieldName: annotated.fieldName,
        capability: write,
        principal: context.principal,
      });
    }
    return null;
  }

  // A mutation on an entity that carries an annotatedText field must also be
  // admitted against the owning "project" scope (the document's container), so
  // editing a document requires access to the project it lives in.
  async function admitProject({ entityName, verb, principal, event }     , app     )                   {
    const entity = app.entities?.get(entityName);
    const descriptor = entity && Object.values(entity.fields).find((field     ) => field.kind === 'annotatedText');
    if (!descriptor) return true;
    const project = tryParseScopeKey(event?.scope);
    const projectEntity = project && app.entities?.get(project.entity);
    // Declarations may target an externally-owned project table. When that
    // declaration is registered, it is the package authorization boundary.
    if (!projectEntity) return true;
    let row = null;
    try { row = projectEntity.findById(project.id, principal); } catch { row = null; }
    return admitRow({ kind: 'verb', entity: projectEntity, row, principal, verb });
  }

  const commitHook = createAnnotatedTextCommitHook();

  return { historyActions, nativeInsertPolicies, privateHistoryScopes, commitHook, authorize, admitProject };
}
