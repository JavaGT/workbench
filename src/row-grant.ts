// The row grant's RUNTIME half — the second default-on auth layer (SPEC §6).
//
// Two default-on auth layers protect every request. The route GATE (route-gate.mjs)
// decides admission to a route from the request principal. The row GRANT decides,
// per row, what the principal may DO with it. The grant itself has two halves:
//
//   - the SQL scope (scope-sql.mjs / bindReadScope) — which rows are VISIBLE; and
//   - the `.can` capability body — given a visible row, which capabilities
//     (read / write / subscribe / admin) the principal holds on it.
//
// This module runs the `.can` half. It builds the entity's `is` checks bound to a
// concrete { row, principal }, runs the grant clause's `.can` body through the
// await-backstop (resolveDecision), and returns the conferred capability set. The
// HTTP dispatcher calls mayVerb on every admitted verb so a principal who passed
// the route gate still cannot write a row it does not own — no second auth path,
// the grant runs every verb.

import { check, resolveDecision } from './check.ts';
import type { CheckFnFunc } from './check.ts';
import { read, write, subscribe, admin } from './grant.ts';
import type { Capability, GrantDecision } from './grant.ts';
import { getLog } from './log.ts';
import { isRuntimeGrantClause } from './scope.ts';
import { operationCategory } from './operation.ts';

// Entity declarations are compiled once and their grant thunk is immutable for
// the lifetime of that declaration. Runtime membership overlays replace the
// entity's `grant` property, so the declaration reference is also the cache
// invalidation key. The row-auth path asks for the grant several times while
// admitting one row (inheritance detection, own-can detection, and capability
// evaluation); resolve the thunk once and reuse its clauses across those asks.
// A WeakMap keeps this cache bounded by the entity records themselves.
const GRANT_CLAUSES_CACHE = new WeakMap<object, { declaration: unknown; clauses: unknown }>();

// A check-registry entry as the runtime half sees it. `run` is the per-row
// boolean face; `harvest` belongs to the scope compiler (not consumed here).
interface CheckEntry {
  run?: (ctx: { entity: unknown; principal: unknown; runtime: unknown }) => unknown;
  harvest?: unknown;
}

// A field descriptor's access seam (the field `.can(fn)` body) — same shape as
// field.ts's access, kept local so this module stays decoupled from the
// descriptor constructors.
type FieldAccessFn = (context: Record<string, unknown>, defaults?: unknown) => unknown;

// The inherit directive (`inherit(Parent, { via })`) as the runtime sees it.
// `childCan` is the optional child capability refinement; `.where(...)` is
// compile-only (harvested into the child's read-scope) and has no runtime half.
interface InheritDirective {
  readonly inherit: unknown;
  readonly via: string;
  readonly childCan?: unknown;
}

// The compiled entity record the row-grant reads: name, the unified check
// registry, the declared fields (for the field `.can` seam), and the runtime
// (needed to resolve an inherit-child's parent entity object).
export interface EntityRecord {
  name: string;
  grant?: unknown;
  registry?: Record<string, CheckEntry>;
  fields?: Record<string, { access?: unknown }>;
  runtime?: unknown;
}

// The capability decision a grant body confers: granted + the token set (or a
// denial). `is` is the bound check proxy the `.can` body destructured.
export interface CapabilityDecision {
  granted: boolean;
  capabilities: readonly Capability[];
}

interface RowDecision extends CapabilityDecision {
  is: Record<string, CheckFnFunc>;
}

// A declaration may resolve to a bare, already-decided `grant(...)`/`deny(...)`
// object instead of a clause array (`grant: () => grant(read, subscribe)`).
// It is a complete capability opinion, not a scope and not an inherit directive.
// Recognize it structurally but narrowly: a boolean `granted` plus an explicit
// capability list for an admission, or `granted: false` with a denial reason.
function bareGrantDecision(value: unknown): GrantDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const decision = value as { granted?: unknown; capabilities?: unknown };
  if (typeof decision.granted !== 'boolean') return null;
  if (decision.granted === true && !Array.isArray(decision.capabilities)) return null;
  return value as GrantDecision;
}

// The runtime `.can` body on a clause — a function receiving `{ is, entity }`
// and returning a grant()/deny() decision. The declaration-facing type of a
// clause (scope.ts) types `.can` as the chaining builder; the RUNTIME clause's
// `.can` is this body, so the call site lowers it explicitly.
type RuntimeClauseBody = (ctx: { is: Record<string, CheckFnFunc>; entity: unknown }) =>
  GrantDecision | Promise<GrantDecision>;

// Build the `is` proxy the .can body destructures: each entity check, bound to
// this row + principal, wrapped as an awaitable check so `await is.owner()`
// works and an un-awaited use is caught by the backstop. An undeclared role is
// a thrown error (fail closed) rather than a silent false.
function makeIs(entityRecord: EntityRecord, row: unknown, principal: unknown): Record<string, CheckFnFunc> {
  const is: Record<string, CheckFnFunc> = {};
  const { runtime } = entityRecord;
  for (const [role, entry] of Object.entries(entityRecord.registry ?? {})) {
    const run = entry.run;
    if (run) {
      is[role] = check(() => run({ entity: row, principal, runtime }), { name: role });
    }
  }
  return is;
}

// Protecting annotations are authorization subjects of the owning entity. This
// reuses the row grant's check registry and decision backstop; it does not add
// a policy evaluator beside Workbench authorization.
//
// a policy evaluator beside Workbench authorization. An inherit-child (e.g. a
// Transcript owning via Project) resolves its checks against the ultimate
// parent row the same way mayRow/rowCapabilities do — the checks live on the
// grant-owning entity's registry.
export async function protectingAnnotationCapabilities(
  entityRecord: EntityRecord,
  row: unknown,
  annotation: unknown,
  access: unknown,
  principal: unknown,
): Promise<CapabilityDecision> {
  if (typeof access !== 'function') return { granted: false, capabilities: [] };
  try {
    const accessFn = access as FieldAccessFn;
    let effectiveRecord = entityRecord;
    let effectiveRow = row;
    const seen = new Set<EntityRecord>();

    while (true) {
      const inherited = inheritedGrant(effectiveRecord);
      if (!inherited) break;
      if (seen.has(effectiveRecord)) return { granted: false, capabilities: [] };
      seen.add(effectiveRecord);

      const parentRow = inheritedParentRow(effectiveRecord, effectiveRow, principal);
      if (parentRow == null) return { granted: false, capabilities: [] };
      const parentRecord = resolveInheritedParent(effectiveRecord, inherited) as EntityRecord | null;
      if (!parentRecord) return { granted: false, capabilities: [] };

      effectiveRecord = parentRecord;
      effectiveRow = parentRow;
    }

    const is = makeIs(effectiveRecord, effectiveRow, principal);
    let decision: GrantDecision | undefined;
    await resolveDecision(
      async () => {
        decision = (await accessFn({ is, entity: row, annotation })) as GrantDecision | undefined;
        return decision?.granted === true;
      },
      [],
      { where: `the protecting annotation access body on entity('${entityRecord.name}')` },
    );
    if (!decision || decision.granted !== true || !Array.isArray(decision.capabilities)) {
      return { granted: false, capabilities: [] };
    }
    return { granted: true, capabilities: decision.capabilities };
  } catch {
    // A throwing access body (or a throwing check run-face) is a server-side
    // fault: fail THIS span closed — an inline placeholder — mirroring the
    // row-admission path's catch-all deny. It never aborts the whole document
    // snapshot and never discloses the protected text to any recipient. The
    // exception message is intentionally NOT logged: it can embed row or
    // annotation data that must not leave the server.
    getLog().debug('auth', 'protecting annotation access failed; denying span', {
      entity: entityRecord.name,
    });
    return { granted: false, capabilities: [] };
  }
}

// Run the grant clause's `.can` body against a materialized row + principal and
// return its decision: { granted, capabilities } from grant(...), or
// { granted: false } from deny(...). The body runs through resolveDecision so an
// un-awaited check fails closed instead of silently granting.
//
// The read-scope already decided this row is VISIBLE; the .can body decides the
// capabilities held on it.
export async function rowCapabilities(
  entityRecord: EntityRecord,
  row: unknown,
  principal: unknown,
): Promise<RowDecision> {
  // An inherit-child has no own `.can` body — its grant is an `inherit` directive,
  // not a runtime clause. The capability half must resolve the parent the same way
  // `mayRow` resolves the parent (D1): load the parent row via the `via` FK and run
  // the PARENT's `.can`. Otherwise a no-`.can` field's `defaults` is {granted:false}
  // and every inherit-child field without an explicit `.can` is silently unreadable
  // — the §6 "strong-inherit is half-built" trap. `mayRow` already recurses; this
  // is the field-defaults half of the same move (one capability-resolution path).
  const inherited = inheritedGrant(entityRecord);
  if (inherited) {
    // A child `.can` refines the inherited authority instead of replacing it:
    // run it against the child row and intersect its capabilities with the
    // parent's (a scope-only parent contributes none, so the child decides).
    if (typeof inherited.childCan === 'function') {
      return await inheritChildCapabilities(entityRecord, row, principal);
    }
    const parentRow = inheritedParentRow(entityRecord, row, principal);
    if (!parentRow) return { granted: false, capabilities: [], is: makeIs(entityRecord, row, principal) };
    const parentRecord = resolveInheritedParent(entityRecord, inherited) as EntityRecord;
    return await rowCapabilities(parentRecord, parentRow, principal);
  }
  // Resolve through the SAME `grantClauses` the sibling resolvers use
  // (hasOwnCanGrant / inheritedGrant). A grant may be a function (a thunk
  // returning the clause array) OR a bare clause array — `owner.only()` returns
  // the array directly, and the compile half (resolveGrantClauses) already
  // accepts that shape. Resolving it here too is one reconciliation path: the
  // handwritten thunk and the `owner.only()` expansion run the identical code.
  // Inherit directives were handled and returned above.
  const clauses = grantClauses(entityRecord);
  const is = makeIs(entityRecord, row, principal);
  // A bare decision is honored EXACTLY: its granted flag and capability list
  // are the whole authority. `grant(read, subscribe)` never implies write or
  // admin, and a scope-only array is never silently inferred from it.
  const bare = bareGrantDecision(clauses);
  if (bare) {
    return bare.granted
      ? { granted: true, capabilities: bare.capabilities, is }
      : { granted: false, capabilities: [], is };
  }
  // A scope-only grant confers exactly the read-class capabilities. Keeping
  // this here (not just in mayRow) is what makes fieldCapabilities agree: a
  // field with no own `.can` strong-inherits these, so row reads and field
  // reads share one authority while every write stays denied.
  if (isScopeOnlyClauses(clauses)) {
    return { granted: true, capabilities: SCOPE_ONLY_CAPABILITIES, is };
  }
  const clause = Array.isArray(clauses)
    ? clauses.find((c) => isRuntimeGrantClause(c))
    : null;
  if (!clause) return { granted: false, capabilities: [], is };

  // resolveDecision awaits the body once and rejects an escaped (un-awaited)
  // check; here the body returns a grant()/deny() object, not a boolean, so we
  // run the body directly under the same backstop by inspecting its result.
  let decision: GrantDecision | undefined;
  await resolveDecision(
    async () => {
      decision = await (clause.can as unknown as RuntimeClauseBody)({ is, entity: row });
      // hand the backstop a boolean so its thenable-escape check applies to the
      // body's control flow, not to the grant object it returns.
      return decision.granted;
    },
    [],
    { where: `the .can grant body on entity('${entityRecord.name}')` },
  );
  const grantDecision = decision as GrantDecision;
  const result = grantDecision.granted
    ? { granted: true, capabilities: grantDecision.capabilities ?? [] }
    : { granted: false, capabilities: [] };
  return { ...result, is };
}

// Run a child's `inherit(Parent, { via }).can(fn)` refinement. The parent's
// resolved decision is passed as `defaults` (the same seam field `.can` uses),
// and the resulting capabilities are the INTERSECTION with the parent's — the
// child can only take authority away, never widen it. A scope-only parent
// contributes no capabilities, so the child body is then the capability
// authority over an already scope-visible row. Checks are built from the
// CHILD's registry/row; the parent's are evaluated in rowCapabilities.
type InheritCanBody = (ctx: { is: Record<string, CheckFnFunc>; entity: unknown }, defaults?: CapabilityDecision) => GrantDecision | Promise<GrantDecision>;

// Does this record (or the inherit chain it delegates to) actually CONFER
// capabilities? Distinguishes "scope-only parent, no capability opinion" from
// "parent's .can denied" — a denied parent must never be re-granted by a child
// refinement. A cycle fails closed (no authority contributed).
function contributesCapabilities(record: EntityRecord, seen = new Set<EntityRecord>()): boolean {
  if (seen.has(record)) return false;
  seen.add(record);
  if (hasOwnCanGrant(record)) return true;
  const inherited = inheritedGrant(record);
  if (!inherited) return false;
  if (typeof inherited.childCan === 'function') return true;
  const parent = resolveInheritedParent(record, inherited) as EntityRecord | null;
  return parent ? contributesCapabilities(parent, seen) : false;
}

async function inheritChildCapabilities(
  entityRecord: EntityRecord,
  row: unknown,
  principal: unknown,
): Promise<RowDecision> {
  const is = makeIs(entityRecord, row, principal);
  const denied = (): RowDecision => ({ granted: false, capabilities: [], is });
  const inherited = inheritedGrant(entityRecord);
  const childCan = inherited?.childCan as InheritCanBody | undefined;
  if (!inherited || typeof childCan !== 'function') return denied();

  const parentRow = inheritedParentRow(entityRecord, row, principal);
  if (!parentRow) return denied();
  const parentRecord = resolveInheritedParent(entityRecord, inherited) as EntityRecord;
  const parent = await rowCapabilities(parentRecord, parentRow, principal);
  // A parent that has a capability opinion and DENIED stays denied — the child
  // may only narrow, never re-grant. A scope-only parent has no such opinion.
  if (contributesCapabilities(parentRecord) && !parent.granted) return denied();

  let childDecision: GrantDecision | undefined;
  await resolveDecision(
    async () => {
      childDecision = await childCan({ is, entity: row }, parent);
      return childDecision.granted;
    },
    [],
    { where: `the inherit .can grant body on entity('${entityRecord.name}')` },
  );
  if (!childDecision || childDecision.granted !== true || !Array.isArray(childDecision.capabilities)) return denied();
  const childCapabilities: readonly Capability[] = childDecision.capabilities;

  const capabilities = parent.granted
    ? parent.capabilities.filter((capability) => childCapabilities.includes(capability))
    : childCapabilities;
  return { granted: true, capabilities, is };
}

// The capability each CRUD verb requires, derived through the SINGLE
// operation-category normalizer (operation.ts, S5/A1): verb → category → the
// capability that GRANTS it. Reads (list/read) need `read`; mutations
// (create/update/remove) need `write`; live re-authorization needs `subscribe`;
// management (admin) needs `admin`. This is the allowlist: a verb names the
// capability that GRANTS it, never a condition that denies it. Categories with
// no row-grant capability (execute/search/blob-read) and unknown verbs have NO
// entry and therefore fail closed in mayVerb.
const CATEGORY_CAPABILITY: Readonly<Record<string, Capability>> = Object.freeze({
  read,
  subscribe,
  create: write,
  update: write,
  delete: write,
  administrative: admin,
});

// The capability a category confers — throwing here means a verb was mapped to
// a category with no row-grant capability, an authoring bug, not a runtime
// denial (the seven verbs below all resolve).
function capabilityFor(verb: string): Capability {
  const category = operationCategory(verb);
  const required = CATEGORY_CAPABILITY[category.operation];
  if (!required) {
    throw new Error(
      `operation '${verb}' maps to category '${category.operation}', which has no ` +
        `row-grant capability (fail closed — likely a missing category→capability entry).`,
    );
  }
  return required;
}

export const VERB_CAPABILITY: Readonly<Record<string, Capability>> = Object.freeze({
  list: capabilityFor('list'),
  read: capabilityFor('read'),
  create: capabilityFor('create'),
  update: capabilityFor('update'),
  remove: capabilityFor('remove'),
  subscribe: capabilityFor('subscribe'),
  admin: capabilityFor('admin'),
});

// A scope-only grant (`scope(predicate)` with NO `.can`) declares row VISIBILITY
// through the SQL read-scope and nothing else. It is NOT an implicit CRUD grant:
// the framework must never invent a write capability the author did not confer.
// The ONLY authority such a grant carries is read-class — the row was admitted
// to the result set by its scope, so list/read/subscribe stay coherent with the
// visible set; create/update/remove/admin are denied because no capability
// confers them. These three decision surfaces share this ONE constant:
// `rowCapabilities` (what the row confers), `fieldCapabilities` (which inherits
// it for fields with no own `.can`), and `mayRow` (the transport admission).
const SCOPE_ONLY_CAPABILITIES: readonly Capability[] = Object.freeze([read, subscribe]);

// True when the resolved grant is a clause array with a scope predicate but no
// runtime `.can` body. An empty/absent grant is NOT scope-only (it denies); an
// inherit directive is handled by its own recursion before this is consulted.
function isScopeOnlyClauses(clauses: unknown): boolean {
  return Array.isArray(clauses)
    && !clauses.some((c) => isRuntimeGrantClause(c))
    && clauses.some((c) => c && typeof (c as { predicate?: unknown }).predicate === 'function');
}

// True iff the entity's grant carries its OWN `.can` body (a scope(...).can(fn)
// clause). Inherit children (grant is an `inherit` directive) and scope-only
// grants have NO own `.can`; mayRow owns those cases before falling through to
// mayVerb for entities with an own runtime capability body.
function grantClauses(entityRecord: EntityRecord): unknown {
  const declaration = entityRecord.grant;
  const cached = GRANT_CLAUSES_CACHE.get(entityRecord);
  if (cached && cached.declaration === declaration) return cached.clauses;

  // Preserve the existing method-call `this` value for unusual declaration
  // thunks that inspect their entity receiver.
  const clauses = typeof declaration === 'function'
    ? (declaration as (this: EntityRecord) => unknown).call(entityRecord)
    : declaration;
  GRANT_CLAUSES_CACHE.set(entityRecord, { declaration, clauses });
  return clauses;
}

export function hasOwnCanGrant(entityRecord: EntityRecord): boolean {
  const grant = grantClauses(entityRecord);
  // A bare decision carries its own capability opinion (even a denial), so an
  // inherit-child refinement must treat it as authority it may narrow, never
  // as a scope-only parent with no opinion of its own.
  return bareGrantDecision(grant) !== null
    || (Array.isArray(grant) && grant.some((c) => isRuntimeGrantClause(c)));
}

export function inheritedGrant(entityRecord: EntityRecord): InheritDirective | null {
  const grant = grantClauses(entityRecord);
  return grant && (grant as { inherit?: unknown }).inherit ? grant as InheritDirective : null;
}

// True iff the principal holds the capability `verb` requires on this row. The
// dispatcher calls this on every admitted verb (the row grant runs every verb,
// regardless of the route gate). An unknown verb fails closed.
export async function mayVerb(
  entityRecord: EntityRecord,
  verb: string,
  row: unknown,
  principal: unknown,
): Promise<boolean> {
  const required = VERB_CAPABILITY[verb];
  if (!required) return false;
  const decision = await rowCapabilities(entityRecord, row, principal);
  if (!decision.granted) {
    getLog().debug('auth', `${verb} denied`, { entity: entityRecord.name, id: rowId(row), principal: principalId(principal), verb, reason: 'grant returned no capabilities' });
    return false;
  }
  const allowed = decision.capabilities.includes(required);
  if (!allowed) {
    getLog().debug('auth', `${verb} denied`, { entity: entityRecord.name, id: rowId(row), principal: principalId(principal), verb, reason: `missing ${required.capability}` });
  }
  return allowed;
}

function rowId(row: unknown): unknown {
  return (row as Record<string, unknown> | null | undefined)?.id;
}

function principalId(principal: unknown): unknown {
  const p = principal as { id?: string | null } | null | undefined;
  return p?.id ?? 'anon';
}

// The one row-authorization decision every transport consumes.
//
//   - Inherit directive → load the parent row through the declared FK and recurse
//     into the parent's mayRow decision, so inherited visibility and inherited
//     capabilities stay one concept.
//   - Scope-only grant → the read-scope alone decided VISIBILITY, which confers
//     only read-class verbs (list/read/subscribe) via SCOPE_ONLY_CAPABILITIES.
//     A scope predicate is NOT an implicit CRUD grant: create/update/remove and
//     admin are denied unless an explicit `.can` body confers `write`/`admin`.
//     This is the same authority rowCapabilities/fieldCapabilities report.
//   - Own `.can` grant → run mayVerb inside a try/catch and fail CLOSED on throw
//     (return false). A thrown `.can` body is a server bug; fail-closed denies
//     rather than leaking the row.
//
// Callers own their transport's deny action (REST sendJson 403, authorizeRow
// returns {status:403}, live return/continue/this.error, list filter skip, the
// create hook returns false) — the decision is uniform, the rendering is not.
//
// `authz` (optional) overrides the mayVerb engine used — the live server injects
// its own mayVerb param (apps/tests can customize authorization there), so it
// passes that through; REST dispatch uses the framework default.
function inheritedParentRow(entityRecord: EntityRecord, row: unknown, principal: unknown): unknown {
  const inherited = inheritedGrant(entityRecord);
  if (!inherited) return null;
  const parentId = (row as Record<string, unknown> | null | undefined)?.[inherited.via];
  if (parentId == null) return null;
  const parentRecord = resolveInheritedParent(entityRecord, inherited);
  if (typeof (parentRecord as { findById?: unknown } | null | undefined)?.findById !== 'function') return null;
  return (parentRecord as { findById: (id: string, principal: unknown) => unknown }).findById(String(parentId), principal);
}

function resolveInheritedParent(entityRecord: EntityRecord, inherited: InheritDirective): unknown {
  const parent = inherited.inherit;
  const { runtime } = entityRecord;
  return runtime ? (runtime as { entityOf: (target: unknown) => unknown }).entityOf(parent) : parent;
}

type MayVerbFn = (entityRecord: EntityRecord, verb: string, row: unknown, principal: unknown) => Promise<boolean>;

export async function mayRow(
  entityRecord: EntityRecord,
  verb: string,
  row: unknown,
  principal: unknown,
  authz: MayVerbFn = mayVerb,
): Promise<boolean> {
  try {
    if (entityRecord.grant == null) return false;
    // A bare `grant(...)`/`deny(...)` decision is already resolved: apply its
    // exact capability list to this verb directly, even when a caller injects
    // its own mayVerb — the capability tokens are the one authority.
    const bare = bareGrantDecision(grantClauses(entityRecord));
    if (bare) {
      const required = VERB_CAPABILITY[verb];
      return bare.granted === true && required !== undefined && bare.capabilities.includes(required);
    }
    const inherited = inheritedGrant(entityRecord);
    if (inherited) {
      const parentRow = inheritedParentRow(entityRecord, row, principal);
      if (!parentRow) return false;
      const parentRecord = resolveInheritedParent(entityRecord, inherited) as EntityRecord;
      const parentAdmitted = await mayRow(parentRecord, verb, parentRow, principal, authz);
      if (!parentAdmitted) return false;
      // An inherit child with its own `.can` must additionally pass that
      // refinement (its capabilities are already intersected with the
      // parent's); a plain inherit is unchanged — one recursion, no new path.
      if (typeof inherited.childCan === 'function') {
        const decision = await inheritChildCapabilities(entityRecord, row, principal);
        if (!decision.granted) return false;
        const required = VERB_CAPABILITY[verb];
        return required ? decision.capabilities.includes(required) : false;
      }
      return true;
    }
    if (!hasOwnCanGrant(entityRecord)) {
      // Fail CLOSED on writes: a `scope(predicate)` with no `.can` never
      // silently admits create/update/remove (or admin). It admits only the
      // read-class verbs its read-scope visibility implies, using the SAME
      // capability set rowCapabilities/fieldCapabilities report for this row.
      if (!isScopeOnlyClauses(grantClauses(entityRecord))) return false;
      const required = VERB_CAPABILITY[verb];
      return required ? SCOPE_ONLY_CAPABILITIES.includes(required) : false;
    }
    return await authz(entityRecord, verb, row, principal);
  } catch {
    return false;
  }
}

// Field-level capability authority (SPEC §6, AGENTS Authorization § "one auth
// engine"). A field with `.can(fn)` owns its capability rule — `access({ is },
// defaults)` → grant(...)/deny(...). A field WITHOUT `.can` strong-inherits the
// row grant: the field-readable/writable check falls through to the ROW grant's
// read/write capability (no second auth path — the SAME `makeIs` + rowCapabilities
// runs for both, and the field `.can` body receives the same `is` proxy and the
// row-grant decision as its `defaults`).
//
// Principal-present = request path = enforced. Principal-absent (null) = trusted
// query API = bypassed, mirroring `mayVerb` which also runs only in dispatch
// (DECISIONLOG #41). A null principal means "not a request path — skip field
// authz"; the caller is trusted server code (or the trusted query API).
export async function fieldCapabilities(
  entityRecord: EntityRecord,
  fieldName: string,
  row: unknown,
  principal: unknown,
): Promise<CapabilityDecision> {
  const { is, ...defaults } = await rowCapabilities(entityRecord, row, principal);
  const access = entityRecord.fields?.[fieldName]?.access;
  if (!access) return defaults;                       // strong-inherit row grant
  const accessFn = access as FieldAccessFn;
  let decision: GrantDecision | undefined;
  await resolveDecision(
    async () => {
      decision = (await accessFn({ is, entity: row }, defaults)) as GrantDecision;
      return decision.granted;
    },
    [],
    { where: `the field .can body on entity('${entityRecord.name}').${fieldName}` },
  );
  return decision && decision.granted
    ? { granted: true, capabilities: decision.capabilities ?? [] }
    : { granted: false, capabilities: [] };
}

// True iff the principal holds `capability` (read|write) on this field of this
// row. Runs the field's `.can` pipeline (or the strong-inherited row grant when
// the field has no `.can`).
export async function mayFieldOp(
  entityRecord: EntityRecord,
  fieldName: string,
  capability: Capability,
  row: unknown,
  principal: unknown,
): Promise<boolean> {
  const decision = await fieldCapabilities(entityRecord, fieldName, row, principal);
  if (!decision.granted) return false;
  return decision.capabilities.includes(capability);
}

// The ONE row-admission decision every admission path asks: given a materialized
// row, does `principal` hold the requested operation on it? The operation is a
// named whole — either a row VERB (mayRow: create/update/remove/read/...) or a
// FIELD operation (mayFieldOp: the `capability` on the named field) — never a
// set of orthogonal flags. An absent row is a denial (fail closed): every
// admission site already treated a missing row as deny, just spelled differently
// (`!row`, `!!row &&`, `!admissionRow ||`, `row &&`), so the helper owns that
// default once. A site that genuinely needs a different absent-row policy (the
// create-history move admits a missing anchor; the remove handler short-circuits
// the Invitation fallback on a missing row) keeps that decision at its own site
// and passes a present row only.
export type AdmitRowRequest =
  | { kind: 'verb'; entity: EntityRecord; row: unknown; principal: unknown; verb: string }
  | { kind: 'fieldOp'; entity: EntityRecord; row: unknown; principal: unknown; fieldName: string; capability: Capability };

export async function admitRow(request: AdmitRowRequest): Promise<boolean> {
  const { entity, row, principal } = request;
  if (!row) return false;
  if (request.kind === 'fieldOp') {
    return mayFieldOp(entity, request.fieldName, request.capability, row, principal);
  }
  return mayRow(entity, request.verb, row, principal);
}
