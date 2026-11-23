import { assertGuarded } from './guard/static.mjs';
import { buildCheckRegistry } from './registry.mjs';
import { isRuntimeGrantClause } from './scope.mjs';
import { compileReadScope, compileInheritScope } from './scope-sql.mjs';


// The grant declaration: either a thunk returning the clause array, or an
// `inherit(Parent, { via })` directive object (reserved for Phase 1's inherit
// path). The thunk form is resolved here so its `.can` bodies can be statically
// guarded at load.





















// Normalize the grant declaration into an array of clauses. A grant is either a
// thunk returning an array of `scope().can()` clauses (note.mjs) or — Phase 1
// reserved — an `inherit(Parent, { via })` directive (comment.mjs). The thunk
// form is resolved here so its `.can` bodies can be statically guarded at load.
function resolveGrantClauses(grant         )          {
  if (typeof grant === 'function') return (grant                 )();
  // an inherit directive (object) is carried through untouched for the authz
  // compiler to expand; Phase 1 lands the thunk form first.
  return grant;
}

export function compileEntityAuthz(name        , { fields, grant, declaredChecks, compiledChecks }                  )              {
  // Build the unified check registry — the ONE source of truth for every named
  // check, consulted by BOTH the scope→SQL compiler (harvest face) and the
  // per-row runtime evaluator (run face). Derived role checks (ref-role),
  // declared checks, and map-role names all land here; no second path.
  const baseRegistry = buildCheckRegistry({ fields, declaredChecks: declaredChecks                                             , entityName: name })                                         ;
  for (const checkName of Object.keys(compiledChecks ?? {})) {
    // A map role contributes only a runtime face; membership intentionally
    // completes/replaces that weaker entry with its paired harvest+run faces.
    // Ref-role and declared checks already have harvest faces and therefore
    // represent a competing canonical source, which must fail closed.
    if (baseRegistry[checkName]?.harvest) {
      throw new Error(
        `entity('${name}') membership check '${checkName}' collides with an existing ` +
          'ref-role or declared check; authorization checks must have one source',
      );
    }
  }
  const registry = Object.freeze({ ...baseRegistry, ...compiledChecks })                           ;

  // Statically guard every runtime `.can` body (not scope predicates — those
  // compile to SQL and never run as JS). At the same time, lower the entity's
  // READ half to its SQL template — a non-compilable scope is a load-time error
  // here, never a silent runtime fallback (SPEC §6.1). The read half is one of
  // two shapes: a thunk of `scope().can()` clauses (own scope), or an
  // `inherit(Parent, { via })` directive (the child inherits the parent's scope
  // through a typed FK, lowered to a correlated EXISTS).
  const clauses = resolveGrantClauses(grant);
  let readScope                               ;
  if (Array.isArray(clauses)) {
    // Every clause's runtime .can body is statically guarded.
    for (const clause of clauses) {
      if (isRuntimeGrantClause(clause)) {
        assertGuarded((clause                                            ).can, { where: `entity('${name}') grant .can` });
      }
    }
    // The row-filtering read-scope is derived from exactly ONE scope predicate.
    // Two scope clauses is a load-time error, never a silent first-wins: dropping
    // a second predicate from the SQL filter would fail OPEN if it was meant to
    // restrict reads. There is no union/intersection-of-scopes semantics in
    // Phase 1; an additive read scope, if ever needed, arrives as an explicit
    // named construct — not inferred from a second array element (fail-closed).
    const scoped = clauses.filter((c) => c && typeof (c                           ).predicate === 'function');
    if (scoped.length > 1) {
      throw new Error(
        `entity('${name}') declares ${scoped.length} scope clauses in one grant. ` +
          `A grant derives exactly one read-scope (one scope().can() clause); a ` +
          `second scope predicate would be silently dropped from the row filter — ` +
          `a fail-open hole. Phase 1 has no union-of-scopes semantics. Combine the ` +
          `conditions inside a single scope predicate (anyOf(...)/.and(...)), or ` +
          `inherit a parent's scope with inherit(Parent, { via }).`,
      );
    }
    if (scoped.length === 1) {
      readScope = compileReadScope((scoped[0]                                            ).predicate, {
        fields,
        where: `scope on entity('${name}')`,
        registry,
        entityName: name,
      });
    }
  } else if (clauses && (clauses                    ).inherit) {
    const directive = clauses                    ;
    // A child `.can` is a runtime capability body, so it gets the SAME load-time
    // await guard as an own grant `.can`. `.where` is a scope predicate: it
    // compiles to SQL and is harvested by compileInheritScope instead.
    if (directive.childCan !== undefined) {
      if (typeof directive.childCan !== 'function') {
        throw new Error(`entity('${name}') inherit .can must be a function`);
      }
      assertGuarded(directive.childCan                                   , {
        where: `entity('${name}') inherit .can`,
      });
    }
    readScope = compileInheritScope(directive, {
      where: `inherit on entity('${name}')`,
      fields,
      registry,
      entityName: name,
    });
  }

  // The harvested scope AST is retained (not just the SQL) so a child entity's
  // inherit directive can re-lower this scope under a join alias. The SQL is one
  // rendering of the AST; the AST is the durable artifact.
  const scopeAst = readScope ? readScope.ast : undefined;

  return Object.freeze({ registry, readScope, scopeAst, clauses });
}
