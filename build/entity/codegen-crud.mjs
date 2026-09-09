// CRUD-only entity() codegen over the action/event pipeline (#182).
//
// Derives, from an entity's field declarations, the declarative create/update/
// remove surface an app would otherwise hand-write: the shaped dispatch
// actions, the lifecycle events with reducers, the concrete mutation handlers,
// and the SPEC §7.3 inverses. Semantic operations, declarative effects, and
// non-CRUD verbs (text.insert, annotation.apply, membership.grant) stay
// hand-written — this module never emits them.
//
// Coverage is gated by the M1 conflict/merge policy (docs/conflict-merge-
// policy.md): a kind is covered only when its concurrent outcome is whole-
// value replace, the one outcome assignment codegen can express. Merge kinds
// (annotatedText, crdt), side-table stores (map, log, list), and stub kinds
// stay hand-written, and a payload that touches them is rejected here so the
// hand-written verb remains the only way to mutate them.
//
// The derivation composes the framework's ONE validation, admission, scoping,
// and event-identity seams (validateMutation, admitRow / admitRowTransition /
// mayFieldOp, scopeOf, resolveGeneratedEventScope, materializeCreateDefaults)
// — it derives per-declaration shapes, never a second implementation of those
// engines. The parity test (test/entity-codegen-crud-parity.test.mjs) is the
// designed kill switch: for the same mutation the derived action must produce
// byte-identical events (type, data, seq assignment, grants evaluated) to the
// hand-written action, or the kind stays hand-written and the coverage
// shrinks.
//
// Generated writes inherit SPEC §5.4 field access: a field with no `.can`
// strong-inherits the row grant (its edit floor is the row's write
// capability); a covered field with a declared `.can` runs that floor against
// the materialized row before the event is emitted — a denied field edit is a
// hard write reject (403), never a silent partial commit.

import { randomUUID } from 'node:crypto';
import { action, event } from '../pipeline.mjs';
import { created, updated, removed } from '../event-handle.mjs';
import { validateMutation, ValidationError,                      } from '../field-strategy.mjs';
import { admitRow, mayFieldOp } from '../row-grant.mjs';
import { write } from '../grant.mjs';
import { admitRowTransition } from '../field-admission.mjs';

import { materializeCreateDefaults, resolveGeneratedEventScope } from './crud.mjs';
import { forbidden } from '../outcome.mjs';

/** The `action(type)` handle shape (pipeline.ts — structural, the module exports no types). */





/** The `event(type, reduce)` declaration shape (pipeline.ts). */







// The row-grant engine's EntityRecord declares a mutable field map it only ever
// reads; the codegen's frozen declaration satisfies it at runtime. This alias
// is the one typed boundary at the admission seams (the same boundary cast
// http-crud-dispatch applies).


// ---------------------------------------------------------------------------
// M1 coverage — the whole-value replace kinds are the only ones assignment
// codegen can express. Everything else stays hand-written by the ticket's own
// terms; the parity test is the kill switch that keeps this table honest.
// ---------------------------------------------------------------------------

/** Field kinds whose M1 concurrent outcome is whole-value replace (last commit wins). */
export const CODEGEN_KINDS = Object.freeze(['value', 'hash', 'state', 'struct']         );

/** Merge / stub / coexist kinds: the outcome is not expressible by assignment codegen. */
export const HAND_WRITTEN_KINDS = Object.freeze(['annotatedText', 'crdt', 'store', 'ordered']         );

/** Framework-owned kinds: never client-writable (payload presence is a ValidationError). */
export const FRAMEWORK_KINDS = Object.freeze(['computed', 'projected', 'ephemeral']         );

/** The loose entity surface the codegen reads — the compiled `entity()` handle. */












/** Which verbs the codegen covers for one entity, derived from its declaration. */
















function fieldMode(descriptor                 )                                           {
  if (descriptor.readonly === true || descriptor.touch === true) return 'framework';
  if (descriptor.immutable === true) return 'create-only';
  return 'writable';
}

function kindCoverage(descriptor                 )                                             {
  const kind = String(descriptor.kind);
  if ((CODEGEN_KINDS                     ).includes(kind)) return 'expressed';
  if ((HAND_WRITTEN_KINDS                     ).includes(kind)) return 'hand-written';
  if ((FRAMEWORK_KINDS                     ).includes(kind)) return 'framework';
  return 'hand-written'; // unknown kinds fail closed — never claimed by codegen
}

/**
 * Classify one entity's fields per the M1 policy. `coversLifecycle` is false
 * when the entity opts into a history mode or live tier whose update/create
 * carry private facts the codegen does not derive (undo/redo moves compose
 * them through the conditional-history machinery, which stays hand-written).
 */
export function crudCodegenCoverage(entity               )               {
  const createFields           = [];
  const updateFields           = [];
  const handWrittenFields           = [];
  const frameworkFields           = [];
  for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
    switch (kindCoverage(descriptor)) {
      case 'expressed': {
        const mode = fieldMode(descriptor);
        if (mode !== 'framework') createFields.push(fieldName);
        if (mode === 'writable') updateFields.push(fieldName);
        else frameworkFields.push(fieldName);
        break;
      }
      case 'hand-written':
        handWrittenFields.push(fieldName);
        break;
      case 'framework':
        frameworkFields.push(fieldName);
        break;
    }
  }
  const coversLifecycle = entity.tier !== 'live'
    && entity.conditionalHistory !== true
    && entity.conditionalCreateHistory !== true;
  // An onRemove ref declares cascade removal: descendant removal events are
  // semantic, not assignment-shaped — remove stays hand-written for the entity.
  const coversRemove = !Object.values(entity.fields).some((descriptor) => descriptor.onRemove !== undefined);
  return Object.freeze({
    name: entity.name,
    createFields: Object.freeze(createFields),
    updateFields: Object.freeze(updateFields),
    handWrittenFields: Object.freeze(handWrittenFields),
    frameworkFields: Object.freeze(frameworkFields),
    coversRemove,
    coversLifecycle,
  });
}

function assertCoveredLifecycle(entity               , verb                                )       {
  if (entity.conditionalHistory === true || entity.conditionalCreateHistory === true || entity.tier === 'live') {
    throw new ValidationError(
      `${entity.name}.${verb} is not codegen-covered: the entity's history/tier mode ` +
        '(conditional history or live tier) carries lifecycle semantics this codegen does not ' +
        'derive. Keep the built-in (or hand-written) action for this entity.',
    );
  }
}

function assertPayloadKindIsCovered(
  entity               ,
  verb                     ,
  fieldName        ,
)       {
  const descriptor = entity.fields[fieldName];
  const kind = String(descriptor.kind);
  if ((HAND_WRITTEN_KINDS                     ).includes(kind)) {
    throw new ValidationError(
      `${entity.name}.${fieldName} is a ${kind} field: its mutation is not assignment-shaped ` +
        `(M1 merge/stub outcome). It stays hand-written — dispatch the hand-written verb ` +
        `(${handWrittenVerbHint(entity.name, fieldName, descriptor)}), never a CRUD payload.`,
    );
  }
  if ((FRAMEWORK_KINDS                     ).includes(kind)) {
    throw new ValidationError(`${entity.name}.${fieldName} is a ${kind} field and may not be set by the client.`);
  }
  if (verb === 'update' && descriptor.immutable === true) {
    throw new ValidationError(
      `${entity.name}.${fieldName} is immutable: a client may set it on create but may not change it.`,
    );
  }
}

/** The hand-written mutation route for one merge/stub kind (the M1 table's outcome owner). */
function handWrittenVerbHint(entityName        , fieldName        , descriptor                 )         {
  switch (descriptor.kind) {
    case 'store':
      return descriptor.type === 'log'
        ? `the log append on ${entityName}.${fieldName}`
        : `the row-handle mutation on ${entityName}.${fieldName} (row.${fieldName}.set)`;
    case 'ordered':
      return `the native list verb on ${entityName}.${fieldName} (list.insert / list.move)`;
    case 'crdt':
      return `the native verb on ${entityName}.${fieldName} (${entityName}.${fieldName}.apply)`;
    case 'annotatedText':
      return 'the semantic text/annotation verbs (text.insert, annotation.apply)';
    default:
      return `the ${descriptor.kind} field's hand-written verb`;
  }
}

// ---------------------------------------------------------------------------
// Derived action shapes — the client-facing half. The payload a client hands
// to dispatch is derived from the declaration's covered field set.
// ---------------------------------------------------------------------------






/**
 * Shape the `${name}.create` action payload. Unknown keys are left to the
 * pipeline's validation (fail closed server-side); hand-written-kind and
 * framework-owned keys are rejected here, at the seam where the client builds
 * the mutation, so a merge-kind field can never ride a CRUD payload.
 */
export function crudCreateAction(entity               , input                         )                   {
  assertCoveredLifecycle(entity, 'create');
  const { id: requestedId, ...fieldsPayload } = input;
  for (const fieldName of Object.keys(fieldsPayload)) {
    assertPayloadKindIsCovered(entity, 'create', fieldName);
  }
  if (requestedId !== undefined && (typeof requestedId !== 'string' || requestedId.length === 0)) {
    throw new ValidationError(`${entity.name}.id: expected a non-empty text id`);
  }
  return { type: `${entity.name}.create`, payload: { ...fieldsPayload, ...(requestedId !== undefined ? { id: requestedId } : {}) } };
}

/** Shape the `${name}.update` action payload (same coverage gate as create, minus immutable). */
export function crudUpdateAction(entity               , id        , input                         )                   {
  assertCoveredLifecycle(entity, 'update');
  if (typeof id !== 'string' || id.length === 0) {
    throw new ValidationError(`${entity.name}.update requires a non-empty row id`);
  }
  for (const fieldName of Object.keys(input)) {
    assertPayloadKindIsCovered(entity, 'update', fieldName);
  }
  return { type: `${entity.name}.update`, payload: { ...input, id } };
}

/** Shape the `${name}.remove` action payload. */
export function crudRemoveAction(entity               , id        )                   {
  assertCoveredLifecycle(entity, 'remove');
  if (!declarationRemovesByCascade(entity)) {
    throw new ValidationError(
      `${entity.name}.remove is not codegen-covered: an onRemove cascade owns the removal ` +
        'semantics (descendant events), which stays hand-written.',
    );
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new ValidationError(`${entity.name}.remove requires a non-empty row id`);
  }
  return { type: `${entity.name}.remove`, payload: { id } };
}

/** True when the declaration routes removal through an onRemove cascade (semantic, hand-written). */
function declarationRemovesByCascade(entity               )          {
  return Object.values(entity.fields).some((descriptor) => descriptor.onRemove !== undefined);
}

// ---------------------------------------------------------------------------
// Derived events — the lifecycle facts with their reducers. The reducer fold
// is the same whole-value merge the compiled verbs declare; the parity test
// proves a derived fold and the compiled fold agree on the same log event.
// ---------------------------------------------------------------------------







export function codegenCrudEvents(entity               )                {
  // The lifecycle fold is the whole-value merge the compiled verbs declare
  // (`{ ...state, ...data }`); removed marks the tombstone. The parity test
  // proves a derived fold and the compiled fold agree on the same log event.
  const foldFields = (state         , payload         ) => ({
    ...(state          ),
    ...(payload                                     ).data,
  });
  return {
    created: event(created(entity.name), foldFields),
    updated: event(updated(entity.name), foldFields),
    removed: event(removed(entity.name), (state         ) => ({ ...(state          ), _removed: true })),
  };
}

// ---------------------------------------------------------------------------
// Derived handlers — the CRUD actions apps stop hand-writing. Same kernel
// handler contract as the compiled CRUD handlers ({ payload, principal, db,
// scope, authorization }), composing the one validation/admission seams.
// ---------------------------------------------------------------------------









/** The narrow db seam the derived handlers read rows through (query.ts RawRowDb shape). */




/** The owner-role ref field of the declaration, if any (create stamps principal.id). */
export function codegenOwnerField(entity               )                {
  for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
    if (descriptor.type === 'ref' && descriptor.role && descriptor.readonly) return fieldName;
  }
  return null;
}

/**
 * The materialized current row, read through the bound record's query seam —
 * the same seam the compiled CRUD handlers use (a non-`inTransaction` handler
 * runs outside the transaction, where the context db is absent).
 */
function materializedRow(entity               , id        )                                 {
  if (typeof entity.findById !== 'function') return null;
  try {
    const row = (entity.findById                           )(id);
    return row && typeof row === 'object' ? (row                           ) : null;
  } catch {
    return null; // no durable database — admission skips its transition check (as the compiled handler does)
  }
}

/**
 * The derived `${name}.create` handler: validate → materialize defaults →
 * stamp the owner role → emit `created`. Create admission is the route gate +
 * read-scope story (no row exists to admit); the emitted event is what the
 * projection folds into the row.
 */
export function codegenCreateHandler(entity               )                     {
  const createdHandle = created(entity.name);
  return ({ payload, principal }) => {
    assertCoveredLifecycle(entity, 'create');
    if (Object.hasOwn(payload, '__workbench')) {
      throw new ValidationError(`${entity.name}.__workbench is reserved for framework event metadata`);
    }
    const { id: requestedId, ...fieldsPayload } = payload;
    for (const fieldName of Object.keys(fieldsPayload)) {
      assertPayloadKindIsCovered(entity, 'create', fieldName);
    }
    if (requestedId !== undefined && (typeof requestedId !== 'string' || requestedId.length === 0)) {
      throw new ValidationError(`${entity.name}.id: expected a non-empty text id`);
    }
    const validated = validateMutation(entity, fieldsPayload);
    const id = requestedId ?? randomUUID();
    const data = materializeCreateDefaults(entity, { ...validated, id });
    const ownerField = codegenOwnerField(entity);
    if (ownerField) data[ownerField] = principal?.id;
    return [{
      handle: createdHandle,
      type: createdHandle.type,
      scope: resolveGeneratedEventScope(entity, { id, payload: data }),
      data,
    }];
  };
}

/**
 * The derived `${name}.update` handler: validate → state-transition guard →
 * SPEC §5.4 field floors (declared `.can` on every changed covered field,
 * strong-inheriting the row grant) → proposed-transition row admission
 * (before AND after rows) → stamp touch fields → emit `updated`. A denied
 * field edit or a forbidden row move is a hard reject (403) with zero events.
 */
export function codegenUpdateHandler(entity               )                     {
  const updatedHandle = updated(entity.name);
  return async ({ payload, principal, scope, authorization }) => {
    assertCoveredLifecycle(entity, 'update');
    const { id, ...rest } = payload;
    if (!id) throw Object.assign(new Error('update requires an id'), { status: 400 });
    if (Object.keys(rest).length === 0) {
      throw new ValidationError(`${entity.name}.update requires at least one field to change`);
    }
    for (const fieldName of Object.keys(rest)) {
      assertPayloadKindIsCovered(entity, 'update', fieldName);
    }
    const validatedFields = validateMutation(entity, rest);
    // State fields keep their declared transition graph: the move is checked
    // against the current row before anything is emitted (validation, not merge).
    for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
      if (descriptor.kind !== 'state' || !(fieldName in validatedFields)) continue;
      const current = materializedRow(entity, String(id));
      if (!current || current[fieldName] == null) {
        throw new ValidationError(`${entity.name}.${fieldName}: illegal transition (no current state) -> ${validatedFields[fieldName]}`);
      }
      if (current[fieldName] === validatedFields[fieldName]) continue;
      const legalTargets = descriptor.transitions                                                  ;
      if (!legalTargets?.[current[fieldName]          ]?.includes(validatedFields[fieldName])) {
        throw new ValidationError(`${entity.name}.${fieldName}: illegal transition ${current[fieldName]} -> ${validatedFields[fieldName]}`);
      }
    }
    const data                          = { ...validatedFields, id };
    // Touch fields are framework-owned: stamped server-side on every mutation
    // (never client-supplied — validateMutation rejects them in the payload).
    for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
      if (descriptor.touch) data[fieldName] = new Date();
    }
    const before = materializedRow(entity, String(id));
    if (before) {
      // SPEC §5.4: every changed covered field runs its declared `.can` write
      // floor against the materialized row; no declared floor strong-inherits
      // the row grant below. A denied field edit hard-rejects before any event.
      for (const fieldName of Object.keys(validatedFields)) {
        const declaredFloor = entity.fields[fieldName]?.access;
        if (declaredFloor !== undefined && declaredFloor !== null
          && !(await mayFieldOp(entity                   , fieldName, write, before, principal))) {
          throw forbidden();
        }
      }
      const after = { ...before, ...data };
      if (!(await admitRowTransition({
        entity: entity                   ,
        verb: 'update',
        before,
        after,
        principal,
        authorization,
      }))) {
        throw forbidden();
      }
    }
    return [{
      handle: updatedHandle,
      type: updatedHandle.type,
      scope: resolveGeneratedEventScope(entity, { id: String(id), row: before ?? undefined, payload, scope }),
      data,
    }];
  };
}

/**
 * The derived `${name}.remove` handler: admit the row verb (`write` on the
 * stored row) → emit `removed`. Cascade removals (an `onRemove` ref) are not
 * codegen-covered — derive throws at registration time instead.
 */
/**
 * The derived `${name}.remove` handler: admit the row verb (`write` on the
 * stored row) → emit `removed`. Cascade removals (an `onRemove` ref) and
 * uncovered lifecycle modes refuse here at invocation — derivation stays
 * total so an entity's coverage can always be inspected before use.
 */
export function codegenRemoveHandler(entity               )                     {
  const removedHandle = removed(entity.name);
  return async ({ payload, principal, scope }) => {
    assertCoveredLifecycle(entity, 'remove');
    if (declarationRemovesByCascade(entity)) {
      throw new ValidationError(
        `${entity.name}.remove is not codegen-covered: an onRemove cascade owns the removal ` +
          'semantics (descendant events), which stays hand-written.',
      );
    }
    const { id } = payload;
    if (!id) throw Object.assign(new Error('remove requires an id'), { status: 400 });
    const admissionRow = materializedRow(entity, String(id));
    if (!admissionRow || !(await admitRow({ kind: 'verb', entity: entity                   , row: admissionRow, principal, verb: 'remove' }))) {
      throw forbidden();
    }
    return [{
      handle: removedHandle,
      type: removedHandle.type,
      scope: resolveGeneratedEventScope(entity, { id: String(id), row: admissionRow, payload, scope }),
      data: { id },
    }];
  };
}

/** The full derived handler map, keyed by action type (`${name}.create` etc.). */
export function codegenCrudHandlers(entity               )                                     {
  return {
    [`${entity.name}.create`]: codegenCreateHandler(entity),
    [`${entity.name}.update`]: codegenUpdateHandler(entity),
    [`${entity.name}.remove`]: codegenRemoveHandler(entity),
  };
}

// ---------------------------------------------------------------------------
// Derived inverses (SPEC §7.3) — server-side undo appends inverse domain
// events through the same pipeline; the log stays append-only. An inverse is
// derived from the forward event's data plus the captured preimage row.
// ---------------------------------------------------------------------------








/**
 * Derive the inverse action for one committed CRUD event. `preimageRow` is the
 * materialized pre-mutation row (the preimage the pipeline/undo captured);
 * `forwardData` is the committed event's data. Create inverts to remove,
 * remove to re-create, update to a whole-value restore of exactly the fields
 * the forward event changed (SPEC §7.3: inverse events, never state restore).
 * Returns null when the event is not a covered lifecycle event.
 */
export function codegenInverse(
  entity               ,
  verb                                ,
  { forwardData, preimageRow }                                                                                       ,
)                        {
  assertCoveredLifecycle(entity, verb);
  const id = forwardData?.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (verb === 'create') return { type: `${entity.name}.remove`, payload: { id } };
  if (preimageRow == null) return null;
  if (verb === 'remove') {
    // Re-create from the preimage. Preimage-null cells are omitted: the fresh
    // row's column stays null, which is the preimage value. (A null cannot ride
    // the payload — validateMutation rejects clearing a non-nullable field —
    // but omission materializes the same null cell.)
    const coverage = crudCodegenCoverage(entity);
    const payload                          = { id };
    for (const fieldName of coverage.createFields) {
      if (preimageRow[fieldName] !== undefined && preimageRow[fieldName] !== null) payload[fieldName] = preimageRow[fieldName];
    }
    return { type: `${entity.name}.create`, payload };
  }
  // update → restore exactly what the forward event changed, from the preimage.
  // A restore that would have to CLEAR a non-nullable field (preimage null) is
  // not expressible as a CRUD payload (validateMutation rejects the clear) —
  // the inverse returns null and that undo stays hand-written. This is the
  // kill-switch rule applied to inverses, not a silent partial restore.
  const payload                          = { id };
  for (const fieldName of Object.keys(forwardData)) {
    if (fieldName === 'id') continue;
    const descriptor = entity.fields[fieldName];
    if (!descriptor || kindCoverage(descriptor) !== 'expressed') continue;
    if (descriptor.immutable === true) continue;
    if (preimageRow[fieldName] === null && descriptor.nullable !== true) return null;
    payload[fieldName] = preimageRow[fieldName];
  }
  return { type: `${entity.name}.update`, payload };
}

// ---------------------------------------------------------------------------
// Derived action declarations — the whole surface in one record, for apps that
// register the generated CRUD without hand-writing any of it.
// ---------------------------------------------------------------------------









/**
 * The one codegen entry point: coverage + actions + events + handlers for one
 * entity. Registration is the app's (same shape the kernel hands the compiled
 * CRUD); nothing here bypasses the pipeline.
 */
export function codegenCrud(entity               )                     {
  return {
    name: entity.name,
    coverage: crudCodegenCoverage(entity),
    actions: {
      create: action(`${entity.name}.create`),
      update: action(`${entity.name}.update`),
      remove: action(`${entity.name}.remove`),
    },
    events: codegenCrudEvents(entity),
    handlers: codegenCrudHandlers(entity),
  };
}
