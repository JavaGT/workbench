// The authorization adapter seam (S5/A2): the injectable, dependency-free
// AUTHORIZATION half of the auth/authz split. Authentication (request →
// principal, src/auth/session.ts) stays where it is; AUTHORIZATION (principal →
// admission) funnels through ONE adapter instance instead of module-global
// calls spread across REST dispatch, the route gate, and live delivery.
//
// The adapter's vocabulary is GENERIC — never app nouns (no ProjectMember/Scope
// names). Resources are keyed by `resourceCategory` (entity / blob / search /
// action / subscription / principal / policy) and denials carry a closed
// `reasonCode`, never row content.
//
// Two admission rules are enforced here at the boundary:
//
//   - TWO-VALUED status (S5/A1): a non-'active' principal collapses to
//     `anonymous` before any row/field gate runs, so a revoked and an unknown
//     principal are indistinguishable on the decision surface (no status
//     oracle). The REAL status rides the principal for statusOf() — the audit
//     reader — never on AdmissionDecision. The trace records only whether the
//     status check PASSED (a boolean), never which non-active status applied.
//   - FAIL CLOSED: a policy body (a `.can`/`scope` implementation) that throws
//     yields admitted:false with reasonCode 'policy-error', never a 500 leak.
//
// The default adapter keeps the existing row-grant function signatures as its
// implementation (mayRow / mayVerb / fieldCapabilities), so current callers of
// those module functions are unchanged; transports that already inject a
// mayVerb (live delivery) keep that injection shape untouched. The factory
// accepts overrides so a policy adapter is buildable and testable with zero
// HTTP, sockets, or global DB state.
//
// Non-entity resources (search/blob/action/plain live tables) admit through
// the SAME seam, keyed by resourceCategory. A resource's row scope must
// compile to constrained SQL AT REGISTRATION — a non-compilable scope throws
// there, never falling back to loading every row and filtering in JS.

import { getLog } from './log.ts';
import { read, write, subscribe, admin, type Capability } from './grant.ts';
import { operationCategory, type OperationCategory } from './operation.ts';
import { collapseForAdmission, statusOf, type Principal } from './principal.ts';
import type { Gate, PrincipalLike } from './route-gate.ts';
import { requireUser } from './route-gate.ts';
import { prepareCached, type DbHandle } from './driver.ts';
import {
  mayRow as moduleMayRow,
  fieldCapabilities as moduleFieldCapabilities,
  rowCapabilities,
  type EntityRecord,
} from './row-grant.ts';
import { buildCheckRegistry } from './registry.ts';
import {
  bindReadScope,
  compileInheritScope,
  compileReadScope,
  rowMatchesScope,
  type AstNode,
  type ReadScopeTemplate,
} from './scope-sql.ts';
import { DecisionTrace } from './decision-trace.ts';
import type { DecisionTraceEntry } from './decision-trace.ts';

// The generic resource categories. A decision's resourceCategory is always one
// of these — framework nouns, never app nouns. `entity` is a Workbench entity
// row; `blob`/`search`/`subscription`/`policy` are plugin resources admitted
// through the same seam (keyed by category + registered name); `action` is a
// composite (registered action) admission; `principal` is the route-gate /
// principal-status admission.
export type ResourceCategory =
  | 'entity'
  | 'blob'
  | 'search'
  | 'action'
  | 'subscription'
  | 'principal'
  | 'policy';

export type PluginResourceCategory = Exclude<ResourceCategory, 'entity' | 'principal' | 'action'>;

// The closed reason-code vocabulary. A denial carries exactly one generic code
// — never an app-domain name, never row content, never which non-active status
// applied. `principal-status` is reserved for policy adapters operating under
// an explicit audit context (A4); the default adapter's collapse path NEVER
// emits it, so a revoked and an unknown principal stay indistinguishable.
export type AdmissionReasonCode =
  | 'anonymous'
  | 'principal-status'
  | 'no-row-scope'
  | 'no-capability'
  | 'no-field-access'
  | 'no-resource'
  | 'unknown-category'
  | 'unknown-operation'
  | 'policy-error';

// The frozen decision every admit() returns. `trace` is null in the production
// default and a readonly check list when tracing is enabled (env/test flag).
// `operation` is null ONLY on an 'unknown-operation' denial — an operation the
// adapter does not recognize is not a category, so the decision carries no
// label under which admission could have legitimately run.
export interface AdmissionDecision {
  readonly admitted: boolean;
  readonly operation: OperationCategory | null;
  readonly resourceCategory: ResourceCategory;
  readonly resourceId: string | null;
  readonly reasonCode: AdmissionReasonCode | null;
  readonly capabilities: readonly Capability[];
  readonly trace: readonly DecisionTraceEntry[] | null;
}

// The operation an admit() input names: a category TOKEN or a verb/category
// NAME string (normalized through operationCategory, fail closed on unknown).
export type AdmissionOperation = OperationCategory | string;

// Entity-row admission: a materialized row (or null when the principal's read
// scope excluded it) plus the transport verb. A field admission (fieldName +
// capability) runs the field `.can` seam instead of the row verb.
export interface EntityAdmitInput {
  readonly category: 'entity';
  readonly verb: string;
  readonly principal: Principal;
  readonly entity: EntityRecord;
  readonly row: unknown;
  readonly operation?: AdmissionOperation;
  readonly fieldName?: string;
  readonly capability?: Capability;
  readonly resourceId?: string | null;
}

// Route-gate admission: does this principal pass the (per-verb) route gate?
// The gate defaults to requireUser(). Non-active principals collapse to
// anonymous BEFORE the gate runs, so a revoked and an unauthenticated caller
// are denied identically ('anonymous').
export interface PrincipalAdmitInput {
  readonly category: 'principal';
  readonly principal: Principal;
  readonly operation?: AdmissionOperation;
  readonly gate?: Gate;
  readonly resourceId?: string | null;
}

// One row a composite (registered) action must admit against.
export interface RowRequirement {
  readonly entity: EntityRecord;
  readonly verb: string;
  readonly row: unknown;
  readonly capability?: Capability;
}

// Composite admission: a registered action must admit against EVERY affected
// capability and row. All requirements are evaluated through ONE admit() call;
// any single denial denies the whole action.
export interface ActionAdmitInput {
  readonly category: 'action';
  readonly principal: Principal;
  readonly requirements: readonly RowRequirement[];
  readonly operation?: AdmissionOperation;
  readonly resourceId?: string | null;
}

export type AuthorizationDb = Pick<DbHandle, 'prepare'>;

export interface ResourceEntityLike {
  readonly name: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly registry?: Readonly<Record<string, unknown>>;
  readonly readScope?: ReadScopeTemplate | { readonly sql: string; readonly params: Record<string, unknown>; readonly nearest?: ReadScopeTemplate['nearest'] };
  readonly scopeAst?: AstNode;
  readonly scopeFilter?: (principal: unknown) => { sql: string; params: Record<string, unknown> };
  readonly runtime?: { readonly db?: AuthorizationDb } | unknown;
}

// Plugin-resource admission (blob / search / subscription / policy): keyed by
// category, optionally naming a resource registered on this adapter. A named
// but unregistered resource denies ('no-resource'); an absent row denies
// ('no-row-scope'). For a named registered resource, admit() verifies the
// supplied row against the resource's REGISTERED (compiled) scope before
// admitting: when a database handle is available (on the adapter, registered
// resource, or entity runtime), admission executes the compiled SQL scopeFilter
// (`SELECT 1 FROM <entity> AS t0 WHERE (<scopeSql>) AND t0.id = :__wb_id LIMIT 1`)
// — the one compiled SQL authz engine; when no database is available, admission
// falls back to single-row evaluation (`rowMatchesScope`), where `row` carries
// stored cell values.
export interface ResourceAdmitInput {
  readonly category: PluginResourceCategory;
  readonly principal: Principal;
  readonly operation?: AdmissionOperation;
  readonly resourceName: string;
  readonly row?: unknown;
  readonly resourceId?: string | null;
  readonly entity?: ResourceEntityLike;
  readonly db?: AuthorizationDb;
}

export type AdmitInput =
  | EntityAdmitInput
  | PrincipalAdmitInput
  | ActionAdmitInput
  | ResourceAdmitInput;

// Resource registration for the non-entity categories. The scope predicate
// (or inherit directive, or entity carrying a compiled read-scope) must compile
// to constrained SQL here (a non-compilable scope throws NonCompilableError at
// registration, never a silent load-all-then-filter fallback). `fields`/`checks`
// supply the compile registry the scope may use; `entity`/`table`/`entityName`/
// `db` bind the SQL evaluation target when a database is available.
export interface ResourceRegistration {
  readonly category: PluginResourceCategory;
  readonly name: string;
  readonly scope?: ((ctx: { is: unknown; fields: unknown }) => unknown) | { readonly inherit: unknown; readonly via?: unknown };
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly checks?: Readonly<Record<string, (ctx: unknown) => boolean>>;
  readonly registry?: Readonly<Record<string, unknown>>;
  readonly entity?: ResourceEntityLike;
  readonly entityName?: string;
  readonly table?: string;
  readonly db?: AuthorizationDb;
}

export type MayRowFn = (entity: EntityRecord, verb: string, row: unknown, principal: unknown) => Promise<boolean>;
export type MayVerbFn = (entity: EntityRecord, verb: string, row: unknown, principal: unknown) => Promise<boolean>;

export interface AuthorizationAdapterOptions {
  trace?: boolean;
  db?: AuthorizationDb;
  mayRow?: MayRowFn;
  mayVerb?: MayVerbFn;
  fieldCapabilities?: (entity: EntityRecord, fieldName: string, row: unknown, principal: Principal) => Promise<{ granted: boolean; capabilities: readonly Capability[] }>;
}

export interface AuthorizationAdapter {
  admit(input: AdmitInput): Promise<AdmissionDecision>;
  registerResource(input: ResourceRegistration): void;
}

// The env/test flag that turns dev decision traces on for the default adapter.
// An explicit `trace` option overrides it; the production default is null
// traces and generic failure strings only.
function traceDefault(): boolean {
  return typeof process !== 'undefined' && process.env?.WORKBENCH_AUTH_TRACE === '1';
}

const RESOURCE_KEY_SEPARATOR = '\u0000';
const resourceKey = (category: PluginResourceCategory, name: string): string => `${category}${RESOURCE_KEY_SEPARATOR}${name}`;
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const VERB_CAPABILITY: Readonly<Record<string, Capability>> = Object.freeze(
  Object.assign(Object.create(null), {
    list: read,
    read,
    create: write,
    update: write,
    remove: write,
    subscribe,
    admin,
  }),
);

interface RegisteredResource {
  readonly template: ReadScopeTemplate;
  readonly tableName: string;
  readonly explicitTable: boolean;
  readonly useEntityScopeFilter: boolean;
  readonly entity?: ResourceEntityLike;
  readonly db?: AuthorizationDb;
}

function runtimeDbOf(entity: ResourceEntityLike | undefined): AuthorizationDb | undefined {
  const db = (entity?.runtime as { db?: AuthorizationDb } | null | undefined)?.db;
  return db && typeof db.prepare === 'function' ? db : undefined;
}

function isMissingTableError(error: unknown): boolean {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && /no such table/i.test(message);
}

export function createAuthorizationAdapter(options: AuthorizationAdapterOptions = {}): AuthorizationAdapter {
  const traceEnabled = options.trace ?? traceDefault();
  const adapterDb = options.db && typeof options.db.prepare === 'function' ? options.db : undefined;
  const resources = new Map<string, RegisteredResource>();

  // Evaluate row admission and capture conferred capabilities in ONE pass so
  // `.can` (rowCapabilities) executes at most once per admitted entity request.
  // An injected mayRow/mayVerb retains authority without re-running `.can`.
  async function runMayRowWithCapabilities(
    entity: EntityRecord,
    verb: string,
    row: unknown,
    principal: Principal,
  ): Promise<{ allowed: boolean; capabilities: readonly Capability[] }> {
    if (options.mayRow) {
      const allowed = await options.mayRow(entity, verb, row, principal);
      if (!allowed) return { allowed: false, capabilities: [] };
      const required = VERB_CAPABILITY[verb];
      return { allowed: true, capabilities: required ? [required] : [] };
    }
    if (options.mayVerb) {
      const allowed = await moduleMayRow(entity, verb, row, principal, options.mayVerb);
      if (!allowed) return { allowed: false, capabilities: [] };
      const required = VERB_CAPABILITY[verb];
      return { allowed: true, capabilities: required ? [required] : [] };
    }
    let capabilities: readonly Capability[] = [];
    const allowed = await moduleMayRow(entity, verb, row, principal, async (targetEntity, targetVerb, targetRow, targetPrincipal) => {
      const required = VERB_CAPABILITY[targetVerb];
      if (!required) return false;
      const decision = await rowCapabilities(targetEntity, targetRow, targetPrincipal);
      if (!decision.granted) {
        getLog().debug('auth', `${targetVerb} denied`, {
          entity: targetEntity.name,
          id: (targetRow as Record<string, unknown> | null | undefined)?.id,
          principal: (targetPrincipal as { id?: string | null } | null | undefined)?.id ?? 'anon',
          verb: targetVerb,
          reason: 'grant returned no capabilities',
        });
        return false;
      }
      capabilities = decision.capabilities;
      const ok = decision.capabilities.includes(required);
      if (!ok) {
        getLog().debug('auth', `${targetVerb} denied`, {
          entity: targetEntity.name,
          id: (targetRow as Record<string, unknown> | null | undefined)?.id,
          principal: (targetPrincipal as { id?: string | null } | null | undefined)?.id ?? 'anon',
          verb: targetVerb,
          reason: `missing ${required.capability}`,
        });
      }
      return ok;
    });
    return { allowed, capabilities: allowed ? capabilities : [] };
  }
  const runFieldCapabilities = options.fieldCapabilities ?? moduleFieldCapabilities;

  function settle(
    input: AdmitInput,
    trace: DecisionTrace,
    admitted: boolean,
    reasonCode: AdmissionReasonCode | null,
    capabilities: readonly Capability[],
    resourceId: string | null,
    operation: OperationCategory | null,
  ): AdmissionDecision {
    return Object.freeze({
      admitted,
      operation,
      resourceCategory: input.category,
      resourceId,
      reasonCode: admitted ? null : reasonCode,
      capabilities: Object.freeze(capabilities),
      trace: trace.take(),
    });
  }

  // Normalize the input operation to a category token. The operation on the
  // decision is metadata (the checks carry the authority), so a MISSING
  // operation on a non-entity input is an access check labeled with the closest
  // generic category (read). An UNPARSEABLE operation — vocabulary the adapter
  // does not know — is not a category at all and FAILS CLOSED: this returns
  // null and admit() denies with reasonCode 'unknown-operation', never an
  // admitted 'read'.
  function operationOf(input: AdmitInput): OperationCategory | null {
    try {
      if (input.operation == null) {
        if (input.category === 'entity' && input.verb) return operationCategory(input.verb);
        return operationCategory('read');
      }
      return typeof input.operation === 'string'
        ? operationCategory(input.operation)
        : operationCategory(input.operation.operation);
    } catch {
      return null;
    }
  }

  async function admitEntity(input: EntityAdmitInput, collapsed: Principal, trace: DecisionTrace, operation: OperationCategory | null): Promise<AdmissionDecision> {
    const { entity, row } = input;
    trace.record('row.visible', row != null);
    if (row == null) return settle(input, trace, false, 'no-row-scope', [], resourceIdOf(input, row), operation);

    if (input.fieldName) {
      const decision = await runFieldCapabilities(entity, input.fieldName, row, collapsed);
      const capabilityOk = decision.granted && (input.capability == null || decision.capabilities.includes(input.capability));
      trace.record(`field.can.${input.fieldName}`, capabilityOk);
      if (!capabilityOk) return settle(input, trace, false, 'no-field-access', [], resourceIdOf(input, row), operation);
      return settle(input, trace, true, null, decision.capabilities, resourceIdOf(input, row), operation);
    }

    const { allowed, capabilities } = await runMayRowWithCapabilities(entity, input.verb, row, collapsed);
    trace.record(`row.may.${input.verb}`, allowed);
    if (!allowed) return settle(input, trace, false, 'no-capability', [], resourceIdOf(input, row), operation);
    return settle(input, trace, true, null, capabilities, resourceIdOf(input, row), operation);
  }

  function admitPrincipal(input: PrincipalAdmitInput, collapsed: Principal, trace: DecisionTrace, operation: OperationCategory | null): AdmissionDecision {
    const gate = input.gate ?? requireUser();
    const allowed = gate(collapsed as unknown as PrincipalLike);
    trace.record('route.gate', allowed);
    if (!allowed) return settle(input, trace, false, 'anonymous', [], input.resourceId ?? null, operation);
    return settle(input, trace, true, null, [], input.resourceId ?? null, operation);
  }

  async function admitAction(input: ActionAdmitInput, collapsed: Principal, trace: DecisionTrace, operation: OperationCategory | null): Promise<AdmissionDecision> {
    const { requirements } = input;
    trace.record('action.requirements', requirements.length > 0);
    if (requirements.length === 0) return settle(input, trace, false, 'no-row-scope', [], input.resourceId ?? null, operation);
    const grantedCapabilities: Capability[] = [];
    for (const requirement of requirements) {
      const label = `${requirement.entity?.name ?? 'row'}.${requirement.verb}`;
      trace.record(`requirement.${label}.visible`, requirement.row != null);
      if (requirement.row == null) return settle(input, trace, false, 'no-row-scope', [], input.resourceId ?? null, operation);
      const { allowed } = await runMayRowWithCapabilities(requirement.entity, requirement.verb, requirement.row, collapsed);
      trace.record(`requirement.${label}.may`, allowed);
      if (!allowed) return settle(input, trace, false, 'no-capability', [], input.resourceId ?? null, operation);
      if (requirement.capability) grantedCapabilities.push(requirement.capability);
    }
    return settle(input, trace, true, null, grantedCapabilities, input.resourceId ?? null, operation);
  }

  function evaluateResourceScope(
    registered: RegisteredResource,
    input: ResourceAdmitInput,
    collapsed: Principal,
  ): boolean {
    const db = (input.db && typeof input.db.prepare === 'function' ? input.db : undefined)
      ?? runtimeDbOf(input.entity)
      ?? registered.db
      ?? runtimeDbOf(registered.entity)
      ?? adapterDb;
    const tableName = input.entity?.name ?? registered.tableName;
    const rowId = rowIdOf(input.row, input.resourceId);

    if (db && SQL_IDENTIFIER.test(tableName) && rowId != null) {
      const bound = registered.useEntityScopeFilter && registered.entity?.scopeFilter
        ? registered.entity.scopeFilter(collapsed)
        : bindReadScope(registered.template, collapsed);
      if (!bound) return false;
      const sql = `SELECT 1 FROM ${tableName} AS t0 WHERE (${bound.sql}) AND t0.id = :__wb_id LIMIT 1`;
      try {
        const hit = prepareCached(db, sql).get({ ...bound.params, __wb_id: rowId });
        return hit !== undefined;
      } catch (error) {
        // If no table/entity was explicitly bound (e.g. a field-named blob
        // resource registered on a shared DB-backed adapter whose name is not a
        // SQL table), fall back to single-row evaluation; explicit tables fail
        // closed (rethrow -> policy-error).
        if (!registered.explicitTable && !input.entity && isMissingTableError(error)) {
          return rowMatchesScope(registered.template, input.row as Record<string, unknown>, collapsed);
        }
        throw error;
      }
    }

    return rowMatchesScope(registered.template, input.row as Record<string, unknown>, collapsed);
  }

  function admitResource(input: ResourceAdmitInput, collapsed: Principal, trace: DecisionTrace, operation: OperationCategory | null): AdmissionDecision {
    if (typeof input.resourceName === 'string' && input.resourceName.length > 0) {
      const registered = resources.get(resourceKey(input.category, input.resourceName));
      trace.record('resource.registered', registered !== undefined);
      if (!registered) return settle(input, trace, false, 'no-resource', [], input.resourceId ?? null, operation);
      trace.record('resource.row', input.row != null);
      if (input.row == null) return settle(input, trace, false, 'no-row-scope', [], input.resourceId ?? null, operation);
      const inScope = evaluateResourceScope(registered, input, collapsed);
      trace.record('resource.scope', inScope);
      if (!inScope) return settle(input, trace, false, 'no-row-scope', [], input.resourceId ?? null, operation);
      return settle(input, trace, true, null, [], input.resourceId ?? null, operation);
    }
    return settle(input, trace, false, 'no-resource', [], input.resourceId ?? null, operation);
  }

  async function admit(input: AdmitInput): Promise<AdmissionDecision> {
    const trace = new DecisionTrace(traceEnabled);
    try {
      // TWO-VALUED status collapse at the boundary: the principal entering
      // every check below is anonymous unless 'active'. statusOf reads the
      // REAL status for the trace boolean only (diagnostic — never a decision
      // input and never on the decision surface; it reports only whether the
      // check PASSED, never which non-active status applied).
      trace.record('principal.status', statusOf(input.principal) === 'active');
      const collapsed = collapseForAdmission(input.principal);

      // Fail closed on an operation outside the known vocabulary: an unknown
      // operation is not a category, so no check may run under a fabricated
      // 'read' label — deny before any gate.
      const operation = operationOf(input);
      if (operation === null) {
        trace.record('operation.vocabulary', false);
        return settle(input, trace, false, 'unknown-operation', [], input.resourceId ?? null, null);
      }

      switch (input.category) {
        case 'entity': return await admitEntity(input, collapsed, trace, operation);
        case 'principal': return admitPrincipal(input, collapsed, trace, operation);
        case 'action': return await admitAction(input, collapsed, trace, operation);
        case 'blob':
        case 'search':
        case 'subscription':
        case 'policy': return admitResource(input, collapsed, trace, operation);
        default: return settle(input as AdmitInput, trace, false, 'unknown-category', [], null, operation);
      }
    } catch {
      // A policy body (a .can/scope implementation) threw — fail CLOSED. Never
      // a 500 leak and never a silent admit: the caller sees admitted:false
      // with a closed reason code. The exception message is intentionally not
      // logged: it can embed row or principal data that must not leave the
      // server.
      getLog().debug('auth', 'authorization adapter policy error; denying', {
        category: input.category,
        operation: operationOf(input)?.operation,
      });
      return settle(input, trace, false, 'policy-error', [], input.resourceId ?? null, operationOf(input) ?? null);
    }
  }

  function registerResource(input: ResourceRegistration): void {
    const category = input.category as string;
    if (category === 'entity' || category === 'principal' || category === 'action') {
      throw new Error(
        `cannot register resource under category '${category}' — ` +
          'entity/principal/action admission is not registration-keyed',
      );
    }
    if (typeof input.name !== 'string' || input.name.length === 0) {
      throw new Error('resource registration requires a non-empty name');
    }
    const explicitTableName = input.table ?? input.entityName ?? input.entity?.name ?? null;
    if (explicitTableName !== null && !SQL_IDENTIFIER.test(explicitTableName)) {
      throw new Error(
        `resource '${input.category}/${input.name}' has invalid SQL table identifier '${explicitTableName}'`,
      );
    }
    const tableName = explicitTableName ?? input.name;
    const where = `authorization adapter resource '${input.category}/${input.name}'`;

    let template: ReadScopeTemplate;
    let useEntityScopeFilter = false;
    const scopeInput = input.scope;
    const isInheritDirective = scopeInput !== null
      && typeof scopeInput === 'object'
      && 'inherit' in scopeInput
      && Boolean((scopeInput as { inherit?: unknown }).inherit);

    if (typeof scopeInput === 'function') {
      const fields = (input.fields ?? input.entity?.fields ?? {}) as Record<string, unknown>;
      const builtRegistry = buildCheckRegistry({
        fields,
        declaredChecks: input.checks as Record<string, (ctx: unknown) => boolean> | undefined,
        entityName: tableName,
      });
      const mergedRegistry: Record<string, unknown> = { ...builtRegistry };
      if (input.entity?.registry) {
        for (const [key, entry] of Object.entries(input.entity.registry)) {
          if (!input.checks || !Object.hasOwn(input.checks, key)) {
            const existing = mergedRegistry[key] as { harvest?: unknown } | undefined;
            const incoming = entry as { harvest?: unknown } | undefined;
            if (!existing || (incoming?.harvest && !existing.harvest)) {
              mergedRegistry[key] = entry;
            }
          }
        }
      }
      if (input.registry) {
        Object.assign(mergedRegistry, input.registry);
      }
      template = compileReadScope(scopeInput, {
        fields,
        where,
        registry: mergedRegistry,
        entityName: tableName,
      });
    } else if (isInheritDirective) {
      template = compileInheritScope(scopeInput as { inherit: unknown; via?: unknown }, { where });
    } else if (scopeInput === undefined && input.entity?.readScope && input.entity?.scopeAst) {
      template = {
        sql: input.entity.readScope.sql,
        params: input.entity.readScope.params,
        nearest: input.entity.readScope.nearest ?? null,
        ast: input.entity.scopeAst,
      };
      useEntityScopeFilter = typeof input.entity.scopeFilter === 'function';
    } else {
      throw new Error(
        `resource '${input.category}/${input.name}' registration requires a scope predicate — ` +
          'a resource with no row scope would load every row and filter in JS (forbidden). ' +
          'Provide a scope that compiles to constrained SQL, or register none at all.',
      );
    }

    const resourceDb = input.db && typeof input.db.prepare === 'function' ? input.db : undefined;
    resources.set(resourceKey(input.category, input.name), {
      template,
      tableName,
      explicitTable: explicitTableName !== null,
      useEntityScopeFilter,
      entity: input.entity,
      db: resourceDb,
    });
  }

  return Object.freeze({ admit, registerResource });
}

function rowIdOf(row: unknown, fallbackId?: string | null): string | number | null {
  const id = (row as { id?: unknown } | null | undefined)?.id;
  if (typeof id === 'string' || typeof id === 'number') return id;
  if (fallbackId != null && fallbackId.length > 0) return fallbackId;
  return null;
}

function resourceIdOf(input: EntityAdmitInput, row: unknown): string | null {
  if (input.resourceId != null) return input.resourceId;
  const id = (row as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}
