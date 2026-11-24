// entity(name, { <fields>, grant, checks?, routes?, ... }) — the entity compiler.
//
// The declaration is fields-less: every top-level key that is not a reserved
// framework slot IS a field descriptor. Reserved slots are grant, checks, routes,
// create, effects, admitsEffects, schedule, gate, on. (The old `fields:` wrapper
// is retired — one way to declare a field, not two.)
//
// Compiles a declared entity into a frozen, validated record. This is where the
// fail-closed load-time guards live (SPEC §6.1, §13; ADRs #7, #16):
//
//  - No grant is a LOAD-TIME ERROR (ADR #7): there is no zero-to-one default
//    grant; the smoothest path is still an explicit one.
//  - A `ref` field with `role: 'x'` auto-derives a check `is.x()` — the ONE
//    thing the FK derives (SPEC §6.2): the single source of truth for "who is
//    the x of this row". A developer-declared check of the same name is a
//    LOAD-TIME ERROR: a ref-role check cannot be redeclared (DECISIONLOG #54;
//    the one registry derives both the SQL filter face and the runtime boolean
//    face from the one field — a second hand-written body is the split-brain
//    the unified registry exists to forbid).
//  - Every `.can` body is statically guarded (assertGuarded, ADR #16). A `scope`
//    predicate is NOT guarded: it compiles to SQL and never runs as JS, so its
//    `is.*` calls are correctly un-awaited (SPEC §6.1).

import { randomUUID } from 'node:crypto';
import { fieldHandle, bindReadScope } from '../scope-sql.mjs';
import { compileEntityAuthz } from '../authz.mjs';
import { getLog } from '../log.mjs';
import {
  serializeField, validateMutation, flattenStruct,
} from '../field-strategy.mjs';
import { materializeStoredRow } from './materialize-row.mjs';
import { action, event } from '../pipeline.mjs';
import * as eventHandle from '../event-handle.mjs';
import { created, updated, removed } from '../event-handle.mjs';
import { generateDDL } from '../ddl.mjs';
import { resolveRouteGate } from '../route-gate.mjs';
import { effectEntries, validateEffectDeclaration } from '../effect-compiler.mjs';
import { triggerList } from '../schedule.mjs';
import { compileMembershipAuthz } from '../auth/membership.mjs';
import { collectSideTableStrategies } from '../side-table-strategy.mjs';
import { createEntityProjection, createConditionalHistoryProjection, createConditionalCreateHistoryProjection, projectRowForRecipient } from './projection.mjs';
import { createCrudHandlers, materializeCreateDefaults } from './crud.mjs';
import { installEntityQueries, rawRow } from './query.mjs';
import { validateScheduleTrigger, autoStateScheduleTrigger, stateEffectEntries, assertSqlIdentifier, mintToken } from './schedule-compile.mjs';
import {
  hasFieldKindFeature,
  resolveFieldKindEventScope,
  validateFieldKindEntities,
} from '../strategy/index.mjs';
// Kind modules register their contributions at load; arming the registry here
// keeps entity compilation correct even when ddl.ts is not on the import path.
import '../annotated-text-field.mjs';
import { scopeOf } from '../scope-handle.mjs';
import { normalizeTierDeclaration } from '../live-tier.mjs';

// Reserved top-level declaration slots. Every other key on the declaration is a
// field descriptor. A field name that collides with a reserved slot is a
// load-time error: the developer would have written a field whose name the
// compiler owns, which silently drops the field (fail closed).
const RESERVED_DECLARATION_SLOTS = new Set([
  'fields', 'grant', 'checks', 'routes', 'create', 'effects', 'admitsEffects',
  'schedule', 'simulation', 'gate', 'on', 'membership', 'field', 'history', 'indexes', 'unique',
  'applicationHttpActions', 'live', 'tier',
]);
const APPLICATION_HTTP_CRUD_VERBS = Object.freeze(['create', 'update', 'remove']);

function looksLikeFieldDescriptor(value     ) {
  return value !== null && typeof value === 'object' && typeof value.kind === 'string';
}

// ---- declaration typing ----
//
// The compiler is untyped at runtime (declarations arrive as arbitrary
// records), but the SIGNATURE carries the declaration's shape: the returned
// entity's Row is derived from the declared field descriptors, so field
// handles (`Entity.field.name`) carry literal names and value types. Snapshot
// declarations and projection types flow from that — never hand-written.

/** Top-level declaration slots the compiler owns; never row fields. Mirrors RESERVED_DECLARATION_SLOTS below. */





/** The row value one declared field descriptor projects: optional descriptors may be absent/null. */




/** The hydrated row shape derived from an entity declaration record. */




/** The typed field namespace of a derived row: literal names carrying value/mode phantoms. */








/** The compiled entity handle as the runtime consumes it — loose beyond the typed name/field surface. */







export function entity                                                                              (
  name      ,
  declaration              = {}               ,
)                                           {
  // The compiler body stays untyped (declarations arrive as arbitrary records);
  // only the SIGNATURE above carries the derived row shape.
  const decl = declaration                       ;
  if (Object.hasOwn(decl, 'fields')) {
    throw new Error(
      `entity('${name}') uses the retired fields wrapper. Declare fields directly on ` +
        `the entity object; 'fields' is a reserved declaration slot.`,
    );
  }
  for (const key of RESERVED_DECLARATION_SLOTS) {
    const value = decl[key];
    const isDeclaredSimulation = key === 'simulation' && value?.kind === 'simulate';
    if (Object.hasOwn(decl, key) && looksLikeFieldDescriptor(value) && !isDeclaredSimulation) {
      throw new Error(
        `entity('${name}') field '${key}' collides with a reserved declaration slot. ` +
          `Rename the field.`,
      );
    }
  }

  const { grant, checks: declaredChecksIn = {}, membership: membershipDecl, routes, create: createPolicy, effects = null, admitsEffects = null, schedule = {}, simulation = null, gate: declaredGate = {}, history: historyDecl, live: liveDecl, tier: tierDecl, indexes: indexesDecl, unique: uniqueDecl, applicationHttpActions: declaredApplicationHttpActions } = decl;
  // S3/A1 — the tier declaration: `history`/`live`/`tier` normalize into a
  // resolved live-data tier (default `history`/full — zero behavior change for
  // existing declarations). Validation fails HERE at declaration compile, never
  // at query time: a live entity that also requests durable history (or undo)
  // is a hard error, and derived/operational are resource categories, not
  // entity mutation tiers.
  const resolvedTier = normalizeTierDeclaration({ history: historyDecl, live: liveDecl, tier: tierDecl }, `entity('${name}')`);
  const conditionalHistory = historyDecl?.update === 'conditional';
  const conditionalCreateHistory = historyDecl?.create === 'conditional';
  let applicationHttpActions                    = Object.freeze([]);
  if (declaredApplicationHttpActions !== undefined) {
    if (!Array.isArray(declaredApplicationHttpActions) || declaredApplicationHttpActions.length === 0) {
      throw new Error(`entity('${name}') applicationHttpActions must be a non-empty array of 'create' | 'update' | 'remove'`);
    }
    const seen = new Set();
    for (const verb of declaredApplicationHttpActions) {
      if (!APPLICATION_HTTP_CRUD_VERBS.includes(verb)) {
        throw new Error(
          `entity('${name}') applicationHttpActions has unknown verb '${verb}'. ` +
            `Allowed verbs are ${APPLICATION_HTTP_CRUD_VERBS.join(', ')}.`,
        );
      }
      if (seen.has(verb)) {
        throw new Error(`entity('${name}') applicationHttpActions lists '${verb}' more than once`);
      }
      seen.add(verb);
    }
    applicationHttpActions = Object.freeze(APPLICATION_HTTP_CRUD_VERBS.filter((verb) => seen.has(verb)));
  }

  // The entity name becomes a table name interpolated into SQL — validate first.
  assertSqlIdentifier('entity', name);

  // 'PrincipalSnapshot' is reserved for principal snapshot identity and cannot
  // be declared as a regular entity name.
  if (name === 'PrincipalSnapshot') {
    throw new Error(
      `entity('${name}') is a reserved framework name and cannot be declared as an entity.`,
    );
  }

  // Fields-less declaration: every non-reserved top-level key is a field
  // descriptor. A reserved-slot name used as a field is a load-time error (the
  // developer intended a field, the compiler owns the slot — fail closed rather
  // than silently drop the field).
  const fields                      = {};
  for (const [key, value] of Object.entries(decl)) {
    if (RESERVED_DECLARATION_SLOTS.has(key)) continue;
    fields[key] = value;
  }

  // membership: augments/replaces grant and checks from a declarative role→capability map.
  // If the developer wrote both `grant:` and `membership:`, the explicit `grant:` takes
  // precedence (the membership entry is a convenience shortcut, not a second path).
  let effectiveGrant = grant;
  let declaredChecks = { ...declaredChecksIn };
  let compiledMembershipChecks      = null;
  if (membershipDecl && (grant === undefined || grant === null)) {
    const membershipResult = compileMembershipAuthz(name, fields, membershipDecl);
    effectiveGrant = membershipResult.grant;
    // Membership checks are already registry entries with harvest + run faces.
    // `declaredChecks` contains app functions which buildCheckRegistry compiles
    // into that shape, so feeding entries through it would call an object as a
    // function while harvesting the scope predicate.
    compiledMembershipChecks = membershipResult.checks;
  }

  // ADR #7: an entity must declare a grant (explicitly via `grant:` or `membership:`,
  // or later via the standalone `membership()` call). No grant is allowed at compile
  // time for the standalone path — the entity has no readScope, so scopeFilter
  // returns '1=1' (the route gate is the first auth layer). The standalone
  // membership() call then sets a proper scope.
  if (effectiveGrant === undefined || effectiveGrant === null) {
    getLog().warn(
      'entity',
      `entity('${name}') has no grant at compile time — all access will be denied ` +
        `until a grant is set via membership() or an equivalent mechanism.`,
    );
  }

  // A structured field generates `<field>__<cell>` columns; a declared field or
  // sub-cell name containing the `__` separator could collide with a generated
  // column, so it is a load-time error (fail closed — the generated namespace
  // and the declared namespace must never alias).
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    // A field name becomes a column (and, for a struct, a `<field>__<cell>`
    // column) interpolated into SQL — validate it is a bare identifier first,
    // then reject the reserved '__' separator that would alias the generated
    // struct-column namespace.
    assertSqlIdentifier(`entity('${name}') field`, fieldName);
    if (descriptor.immutable === true && (descriptor.readonly === true || descriptor.touch === true)) {
      const conflictingMode = descriptor.touch === true ? 'touch' : 'readonly';
      throw new Error(
        `entity('${name}') field '${fieldName}' cannot combine immutable with ${conflictingMode}. ` +
          'Immutable fields are supplied by a client on create and frozen afterwards; ' +
          `${conflictingMode} fields are owned by the framework.`,
      );
    }
    if (fieldName.includes('__')) {
      throw new Error(
        `entity('${name}') field '${fieldName}' contains the reserved '__' separator, ` +
          `which is used to generate structured-field columns. Rename the field.`,
      );
    }
    // Lifecycle event handles are reserved member names on the entity handle
    // (Doc.created / Doc.updated / Doc.removed — typed event handles). A declared
    // field of the same name would shadow the handle, so it is a load-time error.
    if (fieldName === 'created' || fieldName === 'updated' || fieldName === 'removed') {
      throw new Error(
        `entity('${name}') field '${fieldName}' collides with the reserved lifecycle ` +
          `event handle ${name}.${fieldName}. Rename the field — the lifecycle handle ` +
          `is the derived identifier for effects keyed on ${name}.${fieldName}.`,
      );
    }
    if (descriptor.kind === 'struct') {
      for (const cellName of Object.keys(descriptor.cells)) {
        assertSqlIdentifier(`entity('${name}') field '${fieldName}' sub-cell`, cellName);
        if (cellName.includes('__')) {
          throw new Error(
            `entity('${name}') field '${fieldName}' has a sub-cell '${cellName}' containing ` +
              `the reserved '__' separator. Rename the sub-cell.`,
          );
        }
      }
    }
  }

  // Index constraints may only name stored main-table columns. One validation
  // authority for the composite `indexes` slot and the single-column `unique`
  // slot — they converge on the same DDL seam (fail closed on either path).
  function assertIndexableField(fieldName     , where        ) {
    const descriptor = fields[fieldName];
    if (typeof fieldName !== 'string' || !descriptor || !(
      descriptor.kind === 'value' || descriptor.kind === 'crdt' ||
      descriptor.kind === 'hash' || descriptor.kind === 'state'
    )) {
      throw new Error(`entity('${name}') ${where} field '${fieldName}' must be a stored main-table field`);
    }
  }

  const indexes        = [];
  if (indexesDecl !== undefined) {
    if (!Array.isArray(indexesDecl)) throw new Error(`entity('${name}') indexes must be an array`);
    const seenIndexes = new Set();
    for (const index of indexesDecl) {
      if (!index || typeof index !== 'object' || Array.isArray(index) || typeof index.unique !== 'boolean' || !Array.isArray(index.fields)
        || Object.keys(index).some((key) => key !== 'fields' && key !== 'unique')) {
        throw new Error(`entity('${name}') indexes entries must be { fields: [..], unique: boolean }`);
      }
      if (index.fields.length < 2 || index.fields.some((fieldName     ) => typeof fieldName !== 'string')) {
        throw new Error(`entity('${name}') index fields must contain at least two field names`);
      }
      const fieldsKey = [...index.fields].sort().join('\u0000');
      if (new Set(index.fields).size !== index.fields.length) {
        throw new Error(`entity('${name}') index fields must not contain duplicates`);
      }
      if (seenIndexes.has(fieldsKey)) {
        throw new Error(`entity('${name}') duplicate index declaration for fields [${index.fields.join(', ')}]`);
      }
      seenIndexes.add(fieldsKey);
      for (const fieldName of index.fields) assertIndexableField(fieldName, 'index');
      indexes.push(Object.freeze({ fields: Object.freeze([...index.fields]), unique: index.unique }));
    }
  }

  // Single-column UNIQUE constraints. Two equivalent declaration forms, one
  // normalized representation (`unique` on the compiled record) consumed by the
  // DDL generator:
  //   unique: ['email']            — one constraint per named field
  //   unique: [['tenant', 'email']] — one constraint per tuple (a 1-tuple is
  //                                  the explicit spelling of a single column)
  // Field-level `unique: true` is normalized into the same list. The explicit
  // `indexes` slot keeps its composite-only contract unchanged.
  const unique             = [];
  const seenUnique = new Set        (indexes.filter((index) => index.unique).map((index) => [...index.fields].sort().join('\u0000')));
  const addUnique = (fieldNames     , where        ) => {
    if (!Array.isArray(fieldNames) || fieldNames.length === 0 || fieldNames.some((fieldName) => typeof fieldName !== 'string')) {
      throw new Error(`entity('${name}') ${where} must be a non-empty array of field names (or an array of such arrays)`);
    }
    if (new Set(fieldNames).size !== fieldNames.length) {
      throw new Error(`entity('${name}') ${where} must not contain duplicate fields`);
    }
    for (const fieldName of fieldNames) assertIndexableField(fieldName, 'unique');
    const key = [...fieldNames].sort().join('\u0000');
    if (seenUnique.has(key)) return;
    seenUnique.add(key);
    unique.push([...fieldNames]);
  };
  if (uniqueDecl !== undefined) {
    if (!Array.isArray(uniqueDecl) || uniqueDecl.length === 0) {
      throw new Error(`entity('${name}') unique must be a non-empty array of field names`);
    }
    for (const entry of uniqueDecl) {
      addUnique(typeof entry === 'string' ? [entry] : entry, 'unique');
    }
  }
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor?.unique === true) addUnique([fieldName], `field '${fieldName}' unique`);
  }

  // Field kinds that need compile-time validation contribute it through the
  // registry; the compiler owns no per-kind validation branches.
  validateFieldKindEntities(name, fields);

  const { registry, readScope, scopeAst, clauses } = compileEntityAuthz(name, {
    fields,
    grant: effectiveGrant,
    declaredChecks,
    compiledChecks: compiledMembershipChecks,
  });

  // Self-handle for effects thunk resolution. The effects thunk receives a
  // handle that resolves field names to their typed handles — a minimal proxy
  // distinct from registerEntityHandle (which also sets runtime active-entity
  // state). Kept minimal so the two handles can't drift (same resolving logic,
  // different lifecycle purpose).
  const selfHandle = new Proxy(Object.create(null), {
    get(_target, key) {
      if (key === 'id') return { fieldName: 'id' };
      if (key === 'name') return name;
      if (key === 'created') return created(name);
      if (key === 'updated') return updated(name);
      if (key === 'removed') return removed(name);
      const fieldKey = typeof key === 'string' ? key : String(key);
      if (Object.prototype.hasOwnProperty.call(fields, fieldKey)) return fieldHandle(fieldKey, fields[fieldKey], name);
      return undefined;
    },
  });

  // Validate declared effects at load time (but not cycle detection — that runs
  // globally after all entities are defined). Each effect must have valid
  // { mutate, with, when? } shape. A non-compilable 'when' predicate is a
  // load-time error (ADR #22). Trigger handles resolve through the effect compiler;
  // map mutations use entity-specific typed handles such as
  // Doc.collaborators.added, not generic field-local aliases.
  const declaredEffectsArray = typeof effects === 'function' ? effects(selfHandle) : effects;
  const entries = [
    ...effectEntries(declaredEffectsArray, { sourceEntityName: name }),
    ...Object.entries(fields).flatMap(([fieldName, descriptor]) =>
      descriptor.kind === 'state' ? stateEffectEntries(name, fieldName, descriptor) : []),
  ];
  // S3/A8 review #2 (JavaGT/workbench#114): a live-tier entity may not declare
  // durable effects. A durable effect anchors its job to the triggering event's
  // _Log sequence, and live mutations write no _Log row — the row would commit
  // but the job would never enqueue (a silent behavioral loss). Compile-time
  // prohibition (ADR #22 fail-closed), matching the live lane's documented
  // consumer restriction (LIVE_LANE_CONSUMER_NAMES in kernel.ts).
  if (resolvedTier.tier === 'live') {
    const durableOnLive = entries.filter(([, effect]) =>
      effect !== null && typeof effect === 'object'
      && typeof (effect                         ).durable === 'string');
    if (durableOnLive.length > 0) {
      const kinds = durableOnLive.map(([, effect]) => (effect                         ).durable).join(', ');
      throw new Error(
        `entity('${name}') is a live-tier entity and cannot declare durable effects (${kinds}) — ` +
          'durable effects enqueue their job from the _Log sequence of the triggering event, ' +
          'and live mutations write no _Log row, so the effect would commit its row but never fire. ' +
          'Declare an in-transaction (mutate/self) effect instead, or move the durable work to a history-tier entity.',
      );
    }
  }
  const validatedEffects = entries.length > 0 ? Object.freeze([...entries]) : null;
  for (const [triggerHandle, effect] of entries) {
    if (effect && typeof effect === 'object' && typeof (effect       ).durable === 'string') continue;
    validateEffectDeclaration(effect, { triggerHandle, sourceEntityName: name });
  }

  const declaredSchedule = { ...schedule };
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor.kind !== 'state' || descriptor.auto == null) continue;
    const trigger = autoStateScheduleTrigger(name, fieldName, descriptor, fields);
    declaredSchedule.update = [...triggerList(declaredSchedule.update), trigger];
  }

  let validatedSchedule                             = null;
  const scheduleKeys = Object.keys(declaredSchedule);
  if (scheduleKeys.length > 0) {
    validatedSchedule = {};
    for (const [verbName, triggerOrTriggers] of Object.entries(declaredSchedule)) {
      if (typeof verbName !== 'string' || verbName.length === 0) {
        throw new Error(`schedule: verb name must be a non-empty string, got ${verbName}`);
      }
      if (!['create', 'update', 'remove'].includes(verbName)) {
        throw new Error(`schedule verb '${verbName}' must be one of create | update | remove (entity '${name}')`);
      }
      const triggers = triggerList(triggerOrTriggers);
      if (triggers.length === 0) {
        throw new Error(`schedule.${verbName}: expected at least one schedule trigger`);
      }
      const validated        = triggers.map((trigger) => validateScheduleTrigger({
        name,
        verbName,
        trigger,
        fields,
        registry,
      }       )       );
      const triggerIds = new Set();
      for (const trigger of validated) {
        if (
          verbName === 'update'
          && (trigger.kind === 'schedule.at' || trigger.kind === 'schedule.after')
          && !trigger.autoState
          && fields[trigger.fieldName]?.touch === true
        ) {
          throw new Error(
            `schedule.${verbName} on entity '${name}': deadline field '${trigger.fieldName}' ` +
              'cannot be a touch field because the scheduled update would move its own deadline and fire repeatedly',
          );
        }
        if (triggerIds.has(trigger.triggerId)) {
          throw new Error(
            `schedule.${verbName}: duplicate trigger identity '${trigger.triggerId}' on entity '${name}'; ` +
              `give each trigger a distinct { key }`,
          );
        }
        triggerIds.add(trigger.triggerId);
      }
      validatedSchedule[verbName] = triggers.length === 1 ? Object.freeze(validated[0]) : Object.freeze(validated);
    }
    validatedSchedule = Object.freeze(validatedSchedule);
  }

  // projected.async fields: each entry is [fieldName, { compute }] for the
  // post-commit consumer to iterate.
  const projectedAsyncFields = Object.entries(fields)
    .filter(([, d]) => d.kind === 'projected' && d.mode === 'async');
  // computed.stored fields: run in-transaction in the projection's apply handler.
  const storedComputedFields = Object.entries(fields)
    .filter(([, d]) => d.kind === 'computed' && d.mode === 'stored');
  if (conditionalHistory && storedComputedFields.length > 0) {
    throw new Error(`entity('${name}') conditional update history does not support stored computed fields`);
  }

  // The route gate is the FIRST default-on auth layer (SPEC §6.2, ADR #20). It
  // lives ON the entity declaration next to `grant` — one authorization story —
  // and is resolved once at compile time through the same resolveRouteGate the
  // router used to run: unknown verbs / non-function gates fail closed, and
  // every unlisted verb defaults to requireUser() (the default-on gate). The row
  // grant stays a separate layer and is untouched here.
  const gate = resolveRouteGate(declaredGate);

  const record      = {
    name,
    fields: Object.freeze({ ...fields }),
    // Only put grant on the record when it's defined, so the set trap can
    // store a later override (via membership()) without violating the Proxy
    // invariant (non-writable, non-configurable property with a different value).
    ...(effectiveGrant !== undefined && effectiveGrant !== null ? { grant: effectiveGrant } : {}),
    registry,
    // Keep a `checks` object for tests that read entity.checks.<name>(...).
    // Each key is the RUN face — the canonical home is `registry`, but existing
    // tests expect `checks` to expose callable functions. Uses `this.registry`
    // so it dynamically picks up overrides set by membership().
    get checks() {
      const checksObj                      = {};
      const registry                      = (this       ).registry ?? {};
      for (const [name, entry] of Object.entries(registry)) {
        if (entry.run) checksObj[name] = entry.run;
      }
      return Object.freeze(checksObj);
    },
    routes,
    gate,
    applicationHttpActions,
    inherit: (clauses       )?.inherit
      ? Object.freeze({ parent: (clauses       ).inherit.name, via: (clauses       ).via })
      : null,
    readScope: readScope ? Object.freeze({ sql: readScope.sql, params: readScope.params }) : undefined,
    scopeAst,
    scopeFilter(principal     ) {
      if (this.grant == null) return { sql: '1=0', params: {} };
      // Read the LIVE readScope from the record. The proxy's mutableAuth set
      // trap allows membership() and other post-compilation augmentations to
      // replace `readScope`; closing over the compile-time value would leave
      // scopeFilter silently disagreeing with `entity.readScope` — the field
      // the query layer now trusts to decide whether an entity is queryable.
      // NOTE: `1=1` here is intentional for a can-only grant: REST/live list
      // post-filter those rows through the runtime .can engine. The query
      // layer does NOT, and rejects such entities before reaching this point.
      const activeReadScope                   = (this       ).readScope;
      if (!activeReadScope) return { sql: '1=1', params: {} };
      const bound = bindReadScope(activeReadScope, principal);
      return bound ? { sql: bound.sql, params: bound.params } : { sql: '1=1', params: {} };
    },
    effects: validatedEffects,
    admitsEffects,
    schedule: validatedSchedule,
    simulation,
    projectedAsyncFields: Object.freeze(projectedAsyncFields),
    storedComputedFields: Object.freeze(storedComputedFields),
    conditionalHistory,
    conditionalCreateHistory,
    // The resolved live-data tier (S3/A1): `history` (default) or `live`.
    // S3/A2 routes live-tier mutations away from _Log on this value; the
    // historyMode sub-flag (full | conditional) distinguishes the full-log
    // default from the existing conditional undo/redo declarations.
    tier: resolvedTier.tier,
    historyMode: resolvedTier.historyMode,
    indexes: Object.freeze(indexes),
    unique: Object.freeze(unique.map((fieldNames) => Object.freeze(fieldNames))),
  };

  const sideTableStrategyEntries = collectSideTableStrategies(fields);
  if (conditionalCreateHistory && (sideTableStrategyEntries.length > 0 || storedComputedFields.length > 0 || hasFieldKindFeature(fields, 'blocksConditionalCreateHistory') || Object.values(fields).some((descriptor) => descriptor.kind === 'crdt' || descriptor.kind === 'struct' || descriptor.kind === 'hash'))) {
    throw new Error(`entity('${name}') conditional create history supports only replayable stored value fields`);
  }

  function createEntityHydrator({ record, entityName, fields, sideTableStrategyEntries, runtime }     ) {
    // Keep the long-standing public contract: callers may ignore this return
    // value and still observe the row deserialized in place. Lifecycle code
    // uses materializeStoredRow directly when it needs a detached snapshot.
    const deserializeStoredCells = (row     ) => {
      if (!row) return row;
      const materialized = materializeStoredRow(row, fields);
      for (const key of Object.keys(row)) {
        if (!Object.prototype.hasOwnProperty.call(materialized, key)) delete row[key];
      }
      Object.assign(row, materialized);
      return row;
    };

    const hydrate = (row     , principal      = null, dispatch      = null) => {
      if (!row) return row;
      row = deserializeStoredCells(row);
      for (const { strategy, fields: strategyFields } of sideTableStrategyEntries) {
        for (const [fieldName, descriptor] of strategyFields) {
          if (typeof strategy.handle === 'function') {
            row[fieldName] = strategy.handle({
              record,
              entityName,
              fieldName,
              descriptor,
              row,
              principal,
              dispatch,
              db: runtime.db,
              entityOf: runtime.entityOf,
            });
          }
        }
      }
      return row;
    };

    return { hydrate, deserializeStoredCells };
  }

  // insert(cells) — the trusted low-level write core: serialize each declared
  // field's value to its stored cell, INSERT, and return the hydrated new row.
  // It does NOT run validateMutation — its caller has already decided the cells
  // are legitimate (the generic create validates an untrusted payload first; a
  // create POLICY mints server-side cells it owns). This is the ONE place the
  // INSERT/return-row mechanics live; both write paths compose it (singular
  // system, deletion test: the policy override adds intent, not a second insert).
  record.verbs = Object.freeze({
    create: action(`${name}.create`),
    created: event(eventHandle.created(name), (state     , { data }     ) => ({ ...state, ...data })),
    update: action(`${name}.update`),
    updated: event(eventHandle.updated(name), (state     , { data }     ) => ({ ...state, ...data })),
    remove: action(`${name}.remove`),
    removed: event(eventHandle.removed(name), (state     ) => ({ ...state, _removed: true })),
  });

  record.removedEvent = (id     , db     ) => ({
    handle: record.verbs.removed.handle,
    type: record.verbs.removed.type,
    scope: resolveFieldKindEventScope({ name, fields }, rawRow(db, name, id) ?? {}) ?? scopeOf(name, id).key,
    data: { id },
  });

  record.projection = createEntityProjection({
    name,
    fields,
    verbs: record.verbs,
    storedComputedFields,
    sideTableStrategyEntries,
    conditionalHistory,
    conditionalCreateHistory,
  });
  record.projections = Object.freeze([
    record.projection,
    ...(conditionalHistory ? [createConditionalHistoryProjection({ name, verbs: record.verbs })] : []),
    ...(conditionalCreateHistory ? createConditionalCreateHistoryProjection({ name, verbs: record.verbs }) : []),
  ]);

  record.generateDDL = () => generateDDL(record);

  const LIFECYCLE_HANDLES = Object.freeze({
    created: (name     ) => created(name),
    updated: (name     ) => updated(name),
    removed: (name     ) => removed(name),
  });

  // Don't freeze the entire record — only `fields` is frozen (above). Auth-related
  // properties (grant, registry, readScope, scopeAst) are mutable so membership()
  // and similar post-compilation augmentations can set them in place.
  function handleProxy(target     , resolveEntity     , { mutableAuth = false }      = {}) {
    const fieldNamespace = new Proxy(Object.create(null), {
      get(_namespace, key) {
        if (key === 'id') return { fieldName: 'id' };
        if (typeof key === 'string' && Object.hasOwn(fields, key)) {
          return fieldHandle(key, fields[key], name, resolveEntity);
        }
        return undefined;
      },
      set() { return false; },
    });
    return new Proxy(target, {
      get(target, key, receiver) {
        if (key === 'field') return fieldNamespace;
        // Lifecycle handles and legacy direct field handles are resolved only
        // for string keys not owned by the record. `.field` is the unambiguous
        // path when a field name collides with entity metadata such as `name`.
        if (key in target || typeof key !== 'string') {
          return Reflect.get(target, key, receiver);
        }
        if (key === 'id') return { fieldName: 'id' };
        const lifecycleHandle = (LIFECYCLE_HANDLES                       )[key];
        if (lifecycleHandle) return lifecycleHandle(name);
        if (Object.hasOwn(fields, key)) {
          return fieldHandle(key, fields[key], name, resolveEntity);
        }
        return undefined;
      },
      set(target, key, value, _receiver) {
        if (mutableAuth && (key === 'grant' || key === 'registry' || key === 'readScope' || key === 'scopeAst' || key === 'scopeFilter')) {
          target[key] = value;
          return true;
        }
        return false;
      },
    });
  }

  // A declaration owns schema, policy, events, projection and DDL. It owns no
  // database operations. Binding is deliberately app-scoped so the same
  // declaration can be mounted by several applications without ambient state.
  Object.defineProperty(record, 'bind', {
    enumerable: false,
    value(runtime     ) {
      if (!runtime || typeof runtime.entityOf !== 'function') {
        throw new Error(`cannot bind entity '${name}' without an application runtime`);
      }
      const requireDb = () => {
        if (!runtime.db) {
          throw new Error(`entity '${name}' database operation requires an application database`);
        }
        return runtime.db;
      };
      // A database-less app can still resolve and inspect routes. Database
      // operations remain present but fail loudly when invoked, preserving one
      // facade shape across construction and startup.
      const queryDb = Object.freeze({
        prepare(...args       ) {
          return requireDb().prepare(...args);
        },
      });

      const boundRecord = Object.create(record);
      Object.defineProperties(boundRecord, {
        declaration: { value: proxy, enumerable: false },
        runtime: { value: runtime, enumerable: false },
      });
      const bound = handleProxy(boundRecord, runtime.entityOf, { mutableAuth: true });
      const { hydrate, deserializeStoredCells } = createEntityHydrator({
        record: bound,
        entityName: name,
        fields,
        sideTableStrategyEntries,
        runtime,
      });

      installEntityQueries(boundRecord, {
        name, hydrate: hydrate       , deserializeStoredCells,
        db: queryDb,
        projectRead: projectRowForRecipient       ,
      });

      const insert = (cells     ) => {
        const id = cells.id ?? randomUUID();
        const stored                      = { id };
        for (const [key, value] of Object.entries(cells)) {
          if (key === 'id') continue;
          const descriptor = fields[key];
          if (descriptor?.kind === 'store' && descriptor.type === 'map') continue;
          if (descriptor && (descriptor.kind === 'projected' || descriptor.kind === 'computed')) continue;
          if (descriptor?.kind === 'struct') {
            Object.assign(stored, flattenStruct(key, descriptor, value));
            continue;
          }
          if (descriptor) stored[key] = serializeField(descriptor, value);
        }
        const cols = Object.keys(stored);
        const db = requireDb();
        db
          .prepare(`INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`)
          .run(stored);
        return hydrate(db.prepare(`SELECT * FROM ${name} AS t0 WHERE t0.id = :id`).get({ id }));
      };

      boundRecord.create = (payload     ) => {
        if (typeof createPolicy === 'function') {
          return createPolicy(payload, { insert, mintToken });
        }
        const validated = validateMutation(bound, payload);
        return insert(materializeCreateDefaults(bound, validated));
      };
      boundRecord.insert = insert;
      boundRecord.delete = (id     ) => {
        requireDb().prepare(`DELETE FROM ${name} WHERE id = :id`).run({ id });
      };
      boundRecord.crudHandlers = createCrudHandlers({ record: bound, sideTableStrategyEntries, conditionalHistory, conditionalCreateHistory });
      if (conditionalHistory) boundRecord.historyActionRule = Object.freeze({
        inverse: ({ action, fact }     ) => ({ type: `${name}.update`, payload: { id: action.payload.id }, input: { expected: fact.after, replacement: fact.before } }),
        redo: ({ action, fact }     ) => ({ type: `${name}.update`, payload: { id: action.payload.id }, input: { expected: fact.before, replacement: fact.after } }),
      });
      if (conditionalCreateHistory) boundRecord.createHistoryActionRule = Object.freeze({
        inverse: ({ action, fact }     ) => ({ type: `${name}.remove`, payload: { id: action.payload.id }, input: { expected: fact.after, replacement: null } }),
        redo: ({ action, fact }     ) => ({ type: `${name}.create`, payload: { id: action.payload.id }, input: { expected: null, replacement: fact.after } }),
      });
      return bound;
    },
  });

  const proxy = handleProxy(
    record,
    (target     ) => typeof target === 'object' ? target : null,
    { mutableAuth: true },
  );
  return proxy;
}
