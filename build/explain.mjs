import { rowCapabilities, mayVerb, mayRow, fieldCapabilities } from './row-grant.mjs';
import { isRuntimeGrantClause } from './scope.mjs';





































































function grantClauses(entityRecord              )          {
  const grant = entityRecord.grant;
  return typeof grant === 'function' ? (grant                 )() : grant;
}

function checksSource(entityRecord              )                             {
  const fields = entityRecord.fields || {};
  const sources                             = {};

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

export async function explain({ entity, row, principal, verb, field }              )                         {
  const checks                                                                      = {};
  const registry = entity.registry || {};
  const mappedSources = checksSource(entity);

  for (const [name, entry] of Object.entries(registry)) {
    if (!entry.run) continue;
    let result         ;
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

  let grantInfo           ;
  let scopeInfo                  ;
  const clauses = grantClauses(entity);

  if (clauses && (clauses                    ).inherit) {
    grantInfo = {
      type: 'inherit',
      chain: { parentEntity: (clauses                    ).inherit.name, via: (clauses                    ).via },
      capabilities: [],
      verbAdmitted: false,
      verbRequired: null,
    };
    const scoped = entity.scopeFilter (principal);
    scopeInfo = scoped.sql !== '1=1' ? scoped : null;
  } else if (Array.isArray(clauses)) {
    const hasCan = clauses.some((c) => isRuntimeGrantClause(c));
    const scoped = clauses.find((c) => c && typeof (c                           ).predicate === 'function');
    if (scoped) {
      const filtered = entity.scopeFilter (principal);
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

  if (grantInfo.type === 'scope-only') {
    // Scope-only means row VISIBILITY, not an implicit CRUD grant. Report the
    // exact decision mayRow makes (Wave 1): list/read/subscribe are admitted,
    // create/update/remove/admin are denied. Both the capability list and the
    // verb verdict come from the row-grant engine — never a second list here.
    try {
      const capabilities = await rowCapabilities(entity, row, principal);
      grantInfo.capabilities = (capabilities.capabilities || []).map((c                        ) => c.capability);
      grantInfo.verbAdmitted = await mayRow(entity, verb, row, principal);
      grantInfo.verbRequired = verb;
      admitted = grantInfo.verbAdmitted;
    } catch {
      admitted = false;
    }
  } else if (grantInfo.type === 'own-scope') {
    try {
      const capabilities = await rowCapabilities(entity, row, principal);
      grantInfo.capabilities = (capabilities.capabilities || []).map((c                        ) => c.capability);
      grantInfo.verbAdmitted = await mayVerb(entity, verb, row, principal);
      grantInfo.verbRequired = verb;
      admitted = grantInfo.verbAdmitted;
    } catch {
      admitted = false;
    }
  } else if (grantInfo.type === 'inherit') {
    try {
      const capabilities = await rowCapabilities(entity, row, principal);
      grantInfo.capabilities = (capabilities.capabilities || []).map((c                        ) => c.capability);
      grantInfo.verbAdmitted = await mayVerb(entity, verb, row, principal);
      grantInfo.verbRequired = verb;
      admitted = grantInfo.verbAdmitted;
    } catch {
      admitted = false;
    }
  }

  const out                = {
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
