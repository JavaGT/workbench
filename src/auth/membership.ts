// membership — concentrates the two-plane membership pattern into a single declaration.
//
// Before (15 lines of boilerplate per entity):
//   checks: { member: ({ Project, principal: p }) => Project.members.has(p.id) },
//   grant: () => [scope(({ is }) => anyOf(is.owner(), is.member())).can(async ({ is }) => {
//     if (await is.owner()) return grant(read, write, subscribe, admin);
//     if (await is.member()) return grant(read, subscribe);
//     return deny('not authorized');
//   })],
//
// After (inside the entity declaration):
//   membership: { member: { can: [read, subscribe] } }
//
// Or standalone (on an already-compiled entity):
//   membership(Project, { member: { can: [read, subscribe] } })
//
// The function generates checks (harvest + run faces), builds a scope predicate
// using anyOf, and produces a grant thunk. Uses ONLY existing primitives
// (map, checks, scope, grant, deny, anyOf — no new engine).

import {
  compileReadScope,
  bindReadScope,
  makeNode,
  PRINCIPAL_ID_PARAM,
  membershipTable,
  membershipOwnerCol,
  MEMBER_COLUMN,
  anyOf,
} from '../scope-sql.ts';
import type { AstNode, ReadScopeTemplate } from '../scope-sql.ts';
import { scope } from '../scope.ts';
import type { RuntimeGrantClause } from '../scope.ts';
import { grant, deny, read, write, subscribe, admin } from '../grant.ts';
import type { Capability, GrantDecision } from '../grant.ts';
import type { FieldDescriptor } from '../field-strategy.ts';

// Owner always receives the full capability set.
const OWNER_CAPABILITIES: readonly Capability[] = Object.freeze([read, write, subscribe, admin]);

// A membership declaration: one named role → the capabilities it confers on the
// rows it belongs to, plus an optional explicit field selector. `can` is the
// allowlist that grants the role its capabilities (never a denylist).
interface MembershipRoleConfig {
  field?: { name?: string; role?: string | string[] };
  can: Capability[];
}

type MembershipConfig = Record<string, MembershipRoleConfig>;

// The compiled per-role mapping: which map field backs the role and the role
// values stored in the side-table's role column.
interface MembershipFieldMapping {
  fieldName: string;
  dbRoles: string[];
  capabilities: Capability[];
}

// The `is` proxy every scope predicate / .can body destructures. Harvest calls
// mint AST nodes; the scope compiler injects the proxy before the predicate runs.
type MembershipIs = Record<string, () => AstNode>;

// A membership check-registry entry: harvest (SQL-compilable scope face) + run
// (per-row boolean face) — the same two-face shape the unified registry uses.
interface MembershipCheckEntry {
  harvest: () => AstNode;
  run: (ctx: { entity: { id: unknown }; principal: { id: unknown }; runtime: MembershipRunRuntime }) => boolean;
}

// The minimal runtime surface a membership `run` face reads: the db handle with
// a prepare().get() path. The concrete driver satisfies this structurally.
interface MembershipRunRuntime {
  db: {
    prepare(sql: string): { get(params: Record<string, unknown>): unknown };
  };
}

// A compiled entity record as membership() reads and augments it. Auth-bearing
// properties are mutable so the standalone overlay can set them in place.
interface MembershipEntityRecord {
  name: string;
  fields: Record<string, FieldDescriptor>;
  grant?: unknown;
  registry?: Record<string, { harvest?: unknown }>;
  readScope?: { sql: string; params: Record<string, unknown> };
  scopeAst?: unknown;
  scopeFilter?: (principal: unknown) => { sql: string; params: Record<string, unknown> };
}

// ---- Core: compile a membership declaration into { grant, checks } ----
// Called by the entity compiler when `membership:` is present in the declaration.
// Also called by the standalone `membership()` wrapper function.
//
// Returns:
//   { grant: () => [clause], checks: { [role]: registryEntry, ... }, fieldMappings }
// The `checks` values are registry-style entries { harvest, run }.
export function compileMembershipAuthz(entityName: string, fields: Record<string, FieldDescriptor>, config: MembershipConfig): {
  grant: () => RuntimeGrantClause[];
  checks: Record<string, MembershipCheckEntry>;
  fieldMappings: Map<string, MembershipFieldMapping>;
  scopePredicate: ({ is }: { is: unknown }) => AstNode;
  canBody: ({ is }: { is: unknown }) => Promise<GrantDecision>;
  hasOwner: boolean;
} {
  if (!config || typeof config !== 'object' || Object.keys(config).length === 0) {
    throw new Error(
      `compileMembershipAuthz('${entityName}'): config must be a non-empty object`,
    );
  }

  const roleNames = Object.keys(config);
  const fieldMappings = new Map<string, MembershipFieldMapping>(); // roleName -> { fieldName, dbRoles, capabilities }
  const checks: Record<string, MembershipCheckEntry> = {};

  for (const roleName of roleNames) {
    const roleConfig = config[roleName];
    if (!roleConfig || typeof roleConfig !== 'object') {
      throw new Error(
        `membership role '${roleName}' config must be an object with { can: [...] }`,
      );
    }
    if (!roleConfig.can || !Array.isArray(roleConfig.can)) {
      throw new Error(
        `membership role '${roleName}' must declare { can: [read, ...] }`,
      );
    }

    const { field: fieldSpec, can: capabilities } = roleConfig;

    // Find the matching map field
    const fieldName = resolveFieldName(fields, roleName, fieldSpec);
    const descriptor = fields[fieldName];

    // Determine DB role values for runtime and SQL filtering.
    const descriptorRoles = resolveDescriptorRoles(descriptor);
    const dbRoles = fieldSpec?.role
      ? (Array.isArray(fieldSpec.role) ? fieldSpec.role.map((r) => String(r)) : [String(fieldSpec.role)])
      : (descriptorRoles.includes(roleName) ? [roleName] : descriptorRoles);

    fieldMappings.set(roleName, { fieldName, dbRoles, capabilities });

    // Build the check entry (harvest + run faces)
    checks[roleName] = buildCheckEntry(entityName, fieldName, dbRoles);
  }

  // Check if owner role exists (auto-derived from ref-role field)
  const hasOwner = Object.values(fields).some(
    (f) => f?.type === 'ref' && f.role === 'owner',
  );

  // Build scope predicate: anyOf(is.owner(), is.<role>(), ...)
  const scopePredicate = ({ is }: { is: unknown }): AstNode => {
    const isChecks = is as MembershipIs;
    const predicateChecks: AstNode[] = [];
    if (hasOwner) predicateChecks.push(isChecks.owner());
    for (const roleName of roleNames) predicateChecks.push(isChecks[roleName]());
    if (predicateChecks.length === 0) {
      throw new Error(
        `membership: no checks to include in scope predicate (no owner, no roles) on entity '${entityName}'`,
      );
    }
    return anyOf(...predicateChecks);
  };

  // Build .can body
  const canBody = async ({ is }: { is: unknown }): Promise<GrantDecision> => {
    const isChecks = is as MembershipIs;
    if (hasOwner && (await isChecks.owner())) return grant(...OWNER_CAPABILITIES);
    for (const roleName of roleNames) {
      if (await isChecks[roleName]()) {
        const caps = fieldMappings.get(roleName)!.capabilities;
        return grant(...caps);
      }
    }
    return deny('not authorized');
  };

  // Build grant thunk
  const grantThunk = (): RuntimeGrantClause[] => [scope(scopePredicate).can(canBody)];

  return { grant: grantThunk, checks, fieldMappings, scopePredicate, canBody, hasOwner };
}

// ---- Standalone: augment a compiled entity record in place ----
// Sets entity.grant, entity.registry, entity.readScope, entity.checks, and
// entity.scopeFilter on the record it receives. Passing a declaration defines
// the policy inherited by future bindings; passing an app-bound facade creates
// an application-local policy overlay without changing the declaration.
export function membership(entityRecord: MembershipEntityRecord, config: MembershipConfig): MembershipEntityRecord {
  if (!entityRecord || typeof entityRecord !== 'object' || !entityRecord.name) {
    throw new Error(
      'membership(entity, config): first argument must be a compiled entity record (from entity())',
    );
  }

  const entityName = entityRecord.name;
  const fields = entityRecord.fields;

  const { grant: grantThunk, checks: newChecks, scopePredicate } =
    compileMembershipAuthz(entityName, fields, config);

  // Read the existing registry before overriding
  const existingRegistry = entityRecord.registry ?? {};
  for (const checkName of Object.keys(newChecks)) {
    // A runtime-only map-role entry is the weak face membership is intended to
    // complete. A harvest-capable ref-role or declared check is already a full
    // canonical authority and must never be silently replaced.
    if (existingRegistry[checkName]?.harvest) {
      throw new Error(
        `entity('${entityName}') membership check '${checkName}' collides with an existing ` +
          'ref-role or declared check; authorization checks must have one source',
      );
    }
  }
  const newRegistry = Object.freeze({ ...existingRegistry, ...newChecks });

  // Compile the read-scope from the scope predicate (uses the new registry)
  const readScopeResult = compileReadScope(scopePredicate, {
    fields,
    where: `membership scope on entity('${entityName}')`,
    registry: newRegistry,
    entityName,
  });

  const newReadScope = readScopeResult
    ? Object.freeze({ sql: readScopeResult.sql, params: readScopeResult.params })
    : undefined;
  const newScopeAst = readScopeResult ? readScopeResult.ast : undefined;

  // Build scopeFilter function (re-bound to new readScope)
  const scopeFilterFn = (principal: unknown): { sql: string; params: Record<string, unknown> } => {
    if (!newReadScope) return { sql: '1=0', params: {} };
    const bound = bindReadScope(newReadScope as ReadScopeTemplate, principal);
    return bound ? { sql: bound.sql, params: bound.params } : { sql: '1=0', params: {} };
  };

  // In-place mutation: set properties on the entity proxy. The proxy's set trap
  // stores these on the record. `checks` is NOT set here — it's a getter on the
  // record that dynamically computes from `this.registry`, so setting `registry`
  // alone is sufficient.
  entityRecord.grant = grantThunk;
  entityRecord.registry = newRegistry;
  entityRecord.readScope = newReadScope;
  entityRecord.scopeAst = newScopeAst;
  entityRecord.scopeFilter = scopeFilterFn;

  return entityRecord;
}

// ---- Internal helpers ----

// Find which map field on the entity to use for a given role name.
function resolveFieldName(fields: Record<string, FieldDescriptor>, roleName: string, fieldSpec?: MembershipRoleConfig['field']): string {
  // Explicit field name in config
  if (fieldSpec?.name) {
    const name = fieldSpec.name;
    const descriptor = fields[name];
    if (!descriptor) {
      throw new Error(
        `membership: field '${name}' not found on entity (for role '${roleName}')`,
      );
    }
    if (descriptor.kind !== 'store' || descriptor.type !== 'map') {
      throw new Error(
        `membership: field '${name}' is not a map field (kind=${descriptor.kind}, type=${descriptor.type})`,
      );
    }
    return name;
  }

  // Find all map fields
  const mapFields = Object.entries(fields).filter(
    ([, d]) => d?.kind === 'store' && d.type === 'map',
  );

  if (mapFields.length === 0) {
    throw new Error(
      `membership: no map field found on entity for role '${roleName}'. ` +
        `Declare a map field (e.g. members: map(ref('User'), { role: [...] })).`,
    );
  }

  // Try to match by role name in the descriptor's role array
  for (const [fName, desc] of mapFields) {
    const roles = resolveDescriptorRoles(desc);
    if (roles.includes(roleName)) return fName;
  }

  // Try singular → plural convention: roleName + 's'
  const pluralName = roleName + 's';
  if (mapFields.some(([n]) => n === pluralName)) return pluralName;

  // If only one map field, use it
  if (mapFields.length === 1) return mapFields[0][0];

  // Ambiguous — ask for explicit field name
  throw new Error(
    `membership: cannot determine which map field to use for role '${roleName}'. ` +
      `Found map fields: ${mapFields.map(([n]) => `'${n}'`).join(', ')}. ` +
      `Specify the field name explicitly with field: { name: 'fieldName' }.`,
  );
}

// Extract role values from a field descriptor, normalized to an array.
// map() stores declared roles on `descriptor.roles`; accept `descriptor.role`
// too for callers passing a hand-constructed descriptor.
function resolveDescriptorRoles(descriptor: FieldDescriptor | undefined): string[] {
  if (!descriptor) return [];
  const role = descriptor.roles ?? descriptor.role;
  if (Array.isArray(role)) return role.map((r) => String(r));
  if (role) return [String(role)];
  return [];
}

// Build a check entry with harvest (SQL-compilable) and run (runtime) faces.
function buildCheckEntry(entityName: string, fieldName: string, dbRoles: string[]): MembershipCheckEntry {
  const table = membershipTable(entityName, fieldName);
  const ownerCol = membershipOwnerCol(entityName);

  // Harvest face: returns an existsMembership AST node for scope→SQL lowering.
  // When a role constraint is present, carry it onto the AST node so SQL
  // scope filtering excludes unauthorized roles identically to `run`.
  const harvest = (): AstNode => {
    return makeNode({
      node: 'existsMembership',
      table,
      ownerCol,
      param: PRINCIPAL_ID_PARAM,
      ...(dbRoles.length > 0 ? { roles: Object.freeze([...dbRoles]) } : {}),
    });
  };

  // Run face: queries the membership side-table at runtime.
  const run = ({ entity: row, principal, runtime }: {
    entity: { id: unknown };
    principal: { id: unknown };
    runtime: MembershipRunRuntime;
  }): boolean => {
    const db = runtime.db;
    if (dbRoles.length > 0) {
      const roleParams: Record<string, unknown> = {};
      const conditions = dbRoles.map((role, i) => {
        const key = `__role_${i}`;
        roleParams[key] = role;
        return `:${key}`;
      });
      const stmt = db.prepare(
        `SELECT 1 FROM ${table} WHERE ${ownerCol} = :__owner AND ${MEMBER_COLUMN} = :__member AND role IN (${conditions.join(', ')})`,
      );
      return (
        stmt.get({ __owner: row.id, __member: principal.id, ...roleParams }) !== undefined
      );
    }
    const stmt = db.prepare(
      `SELECT 1 FROM ${table} WHERE ${ownerCol} = :__owner AND ${MEMBER_COLUMN} = :__member`,
    );
    return stmt.get({ __owner: row.id, __member: principal.id }) !== undefined;
  };

  return { harvest, run };
}
