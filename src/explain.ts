import { rowCapabilities, mayVerb, mayRow, fieldCapabilities } from './row-grant.ts';
import { isRuntimeGrantClause } from './scope.ts';
import type { GrantDecision } from './grant.ts';

interface CheckEntry {
  run?: (...args: unknown[]) => unknown;
  harvest?: unknown;
}

interface FieldDescriptor {
  type?: string;
  role?: string;
  kind?: string;
  roles?: string[];
  access?: unknown;
}

interface EntityRecord {
  name: string;
  grant?: unknown;
  registry?: Record<string, CheckEntry>;
  fields?: Record<string, FieldDescriptor>;
  scopeFilter?: (principal: unknown) => { sql: string; params: Record<string, unknown> };
  runtime?: unknown;
}

interface SourceInfo {
  kind: string;
  field: string | null;
  scopeAvailable: boolean;
}

interface InheritDirective {
  inherit: { name: string };
  via?: string;
}

interface GrantInfoBase {
  capabilities: unknown[];
  verbAdmitted: boolean;
  verbRequired: string | null;
}

type GrantInfo =
  | (GrantInfoBase & { type: 'inherit'; chain: { parentEntity: string; via?: string } })
  | (GrantInfoBase & { type: 'scope-only' })
  | (GrantInfoBase & { type: 'own-scope' })
  | (GrantInfoBase & { type: 'bare' })
  | (GrantInfoBase & { type: 'none' });

interface ScopeInfo {
  sql: string;
  params: Record<string, unknown>;
}

interface ExplainInput {
  entity: EntityRecord;
  row: unknown;
  principal: unknown;
  verb: string;
  field?: string;
}

interface ExplainOutput {
  verb: string;
  entity: string;
  admitted: boolean;
  checks: Record<string, { source: string; scope: boolean; result: boolean }>;
  grant: GrantInfo;
  scope: { sql: string; params: Record<string, unknown> } | null;
  field?: { name: string; hasAccessFn: boolean; admitted: boolean };
}

function grantClauses(entityRecord: EntityRecord): unknown {
  const grant = entityRecord.grant;
  return typeof grant === 'function' ? (grant as () => unknown)() : grant;
}

// A declaration may resolve to a bare grant()/deny() object rather than a
// clause array. Recognize it narrowly and report its exact capability list —
// never infer scope-only read-class capabilities from a bare decision.
function bareGrantDecision(value: unknown): GrantDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const decision = value as { granted?: unknown; capabilities?: unknown };
  if (typeof decision.granted !== 'boolean') return null;
  if (decision.granted === true && !Array.isArray(decision.capabilities)) return null;
  return value as GrantDecision;
}

function checksSource(entityRecord: EntityRecord): Record<string, SourceInfo> {
  const fields = entityRecord.fields || {};
  const sources: Record<string, SourceInfo> = {};

  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor?.type === 'ref' && descriptor.role) {
      sources[descriptor.role] = { kind: 'ref-role', field: fieldName, scopeAvailable: true };
    }
  }

  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor?.kind === 'store' && descriptor.type === 'map') {
      const roles = descriptor.roles;
      if (roles && roles.length > 0) {
        for (const roleName of roles) {
          if (!sources[roleName]) {
            sources[roleName] = { kind: 'map-role', field: fieldName, scopeAvailable: false };
          }
        }
      }
    }
  }

  return sources;
}

export async function explain({ entity, row, principal, verb, field }: ExplainInput): Promise<ExplainOutput> {
  const checks: Record<string, { source: string; scope: boolean; result: boolean }> = {};
  const registry = entity.registry || {};
  const mappedSources = checksSource(entity);

  for (const [name, entry] of Object.entries(registry)) {
    if (!entry.run) continue;
    let result: boolean;
    try {
      const raw = entry.run({ entity: row, principal, runtime: entity.runtime });
      if (raw instanceof Promise) {
        result = await raw;
      } else {
        result = Boolean(raw);
      }
    } catch {
      result = false;
    }
    const source = mappedSources[name] || { kind: 'declared', field: null, scopeAvailable: Boolean(entry.harvest) };
    checks[name] = { source: source.kind, scope: source.scopeAvailable, result };
  }

  let grantInfo: GrantInfo;
  let scopeInfo: ScopeInfo | null;
  const clauses = grantClauses(entity);
  const bare = bareGrantDecision(clauses);

  if (bare) {
    // No scope or clause body runs for a bare decision: its flags ARE the
    // decision. mayRow below applies the same list to the requested verb.
    grantInfo = {
      type: 'bare',
      capabilities: bare.granted ? bare.capabilities.map((c) => c.capability) : [],
      verbAdmitted: false,
      verbRequired: null,
    };
    scopeInfo = null;
  } else if (clauses && (clauses as InheritDirective).inherit) {
    grantInfo = {
      type: 'inherit',
      chain: { parentEntity: (clauses as InheritDirective).inherit.name, via: (clauses as InheritDirective).via },
      capabilities: [],
      verbAdmitted: false,
      verbRequired: null,
    };
    const scoped = entity.scopeFilter!(principal);
    scopeInfo = scoped.sql !== '1=1' ? scoped : null;
  } else if (Array.isArray(clauses)) {
    const hasCan = clauses.some((c) => isRuntimeGrantClause(c));
    const scoped = clauses.find((c) => c && typeof (c as { predicate?: unknown }).predicate === 'function');
    if (scoped) {
      const filtered = entity.scopeFilter!(principal);
      scopeInfo = filtered.sql !== '1=1' ? filtered : null;
    } else {
      scopeInfo = null;
    }

    if (!hasCan) {
      grantInfo = { type: 'scope-only', capabilities: [], verbAdmitted: true, verbRequired: null };
    } else {
      grantInfo = { type: 'own-scope', capabilities: [], verbAdmitted: false, verbRequired: null };
    }
  } else {
    grantInfo = { type: 'none', capabilities: [], verbAdmitted: false, verbRequired: null };
    scopeInfo = null;
  }

  let admitted = false;

  if (grantInfo.type === 'bare') {
    // Honor the decision's exact granted flag and capability list. mayRow
    // applies that same list to the verb, so read+subscribe admits only those
    // verbs and write/admin stay denied — one authority, no second engine.
    try {
      grantInfo.capabilities = bare!.granted
        ? bare!.capabilities.map((c: { capability: string }) => c.capability)
        : [];
      grantInfo.verbAdmitted = await mayRow(entity, verb, row, principal);
      grantInfo.verbRequired = verb;
      admitted = grantInfo.verbAdmitted;
    } catch {
      admitted = false;
    }
  } else if (grantInfo.type === 'scope-only') {
    // Scope-only means row VISIBILITY, not an implicit CRUD grant. Report the
    // exact decision mayRow makes (Wave 1): list/read/subscribe are admitted,
    // create/update/remove/admin are denied. Both the capability list and the
    // verb verdict come from the row-grant engine — never a second list here.
    try {
      const capabilities = await rowCapabilities(entity, row, principal);
      grantInfo.capabilities = (capabilities.capabilities || []).map((c: { capability: string }) => c.capability);
      grantInfo.verbAdmitted = await mayRow(entity, verb, row, principal);
      grantInfo.verbRequired = verb;
      admitted = grantInfo.verbAdmitted;
    } catch {
      admitted = false;
    }
  } else if (grantInfo.type === 'own-scope') {
    try {
      const capabilities = await rowCapabilities(entity, row, principal);
      grantInfo.capabilities = (capabilities.capabilities || []).map((c: { capability: string }) => c.capability);
      grantInfo.verbAdmitted = await mayVerb(entity, verb, row, principal);
      grantInfo.verbRequired = verb;
      admitted = grantInfo.verbAdmitted;
    } catch {
      admitted = false;
    }
  } else if (grantInfo.type === 'inherit') {
    try {
      const capabilities = await rowCapabilities(entity, row, principal);
      grantInfo.capabilities = (capabilities.capabilities || []).map((c: { capability: string }) => c.capability);
      grantInfo.verbAdmitted = await mayVerb(entity, verb, row, principal);
      grantInfo.verbRequired = verb;
      admitted = grantInfo.verbAdmitted;
    } catch {
      admitted = false;
    }
  }

  const out: ExplainOutput = {
    verb,
    entity: entity.name,
    admitted,
    checks,
    grant: grantInfo,
    scope: scopeInfo ? { sql: scopeInfo.sql, params: { ...scopeInfo.params } } : null,
  };

  if (field) {
    const fieldDescriptor = entity.fields?.[field];
    try {
      const caps = await fieldCapabilities(entity, field, row, principal);
      const fieldAdmitted = caps.granted;
      out.field = {
        name: field,
        hasAccessFn: Boolean(fieldDescriptor?.access),
        admitted: fieldAdmitted,
      };
      out.admitted = fieldAdmitted && admitted;
    } catch {
      out.field = { name: field, hasAccessFn: Boolean(fieldDescriptor?.access), admitted: false };
      out.admitted = false;
    }
  }

  return out;
}
