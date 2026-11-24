// The unified check registry — the ONE source of truth for every named check
// on an entity, consulted by BOTH the scope→SQL compiler (harvest face) AND the
// per-row runtime evaluator (run face).
//
// A check named in a grant — is.owner(), is.collaborator(), is.editor() — is
// resolved through this registry alone. There is no second roleFieldMap or
// deriveRoleChecks path. The registry retires both old paths in the same change
// (AGENTS: "a new general mechanism retires the special-case it generalizes").
//
// THREE sources populate the registry. Source order determines face presence:
//
// 1. REF-ROLE FIELD — for each field where descriptor.type === 'ref' && descriptor.role,
//    the entry keyed by descriptor.role gets BOTH faces derived from the field name.
//
// 2. DECLARED CHECK — for each [name, fn] in declaredChecks, the entry gets BOTH
//    faces. The harvest face invokes fn with a compile self-handle (fieldHandle
//    per field, keyed by entityName) and requires an AST return. The run face
//    invokes fn with a runtime self-handle (row-based object that exposes .has()
//    for map fields) and the concrete principal.
//
// 3. MAP-ROLE NAMES — for each map field with descriptor.roles, each role name
//    gets a RUNTIME-ONLY entry (NO harvest face). Using is.editor() in scope
//    is a load-time error — fail closed.
//
// Collision rule (fail closed): a ref field carrying a `role` IS the single
// source of truth for that name — both faces are mechanically derived from the
// one field, so they cannot disagree. A declared `checks` entry that REDECLARES
// a ref-role-derived name is a LOAD-TIME ERROR ("ref-role checks cannot be
// redeclared"). Keeping the ref-role harvest face while letting a declared body
// supply the run face would fuse TWO independent definitions into one entry —
// exactly the split-brain (SQL filter says one thing, runtime says another) this
// registry exists to abolish. If a developer wants different behavior, they give
// it a DIFFERENT name. A map-role name that collides with a ref-role or declared
// name is the weaker (runtime-only) entry and is silently skipped.

import { fieldHandle } from './scope-sql.mjs';
import {
  PRINCIPAL_ID_PARAM,
  PRINCIPAL_ID_TOKEN,
  PRINCIPAL_ATTR_TOKEN,
  makeNode,
  isNode,
  NonCompilableError,
  membershipTable,
  membershipOwnerCol,
  MEMBER_COLUMN,
} from './scope-sql.mjs';





























export function buildCheckRegistry({ fields = {}, declaredChecks = {}, entityName }                      )                {
  const registry                             = {};

  // ---- Source 1: ref-role fields ----
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    const field = descriptor                                                         ;
    if (field?.type === 'ref' && field.role) {
      const role = String(field.role);
      // Two ref fields claiming one role would make the registry LAST-wins
      // while owner stamping is FIRST-wins — the named check would evaluate a
      // different FK than the one the row stores. Fail closed at compile time:
      // a role has exactly one source of truth (the declaring ref field).
      const prior = registry[role];
      if (prior) {
        throw new NonCompilableError(
          `ref fields '${prior.sourceField ?? role}' and '${fieldName}' both declare role '${role}'; ` +
            'a role may be derived from only one ref field (give the second a different role)',
          { where: `entity '${entityName}'` },
        );
      }
      registry[role] = {
        harvest: () => makeNode({ node: 'eq', field: fieldName, param: PRINCIPAL_ID_PARAM }),
        run: ({ entity: row, principal }) => row[fieldName] === principal.id,
        sourceField: fieldName,
      };
    }
  }

  // ---- Source 2: declared checks ----
  // Build the compile self-handle once (same shape makeIsProxy built today:
  // one fieldHandle per field, keyed by entityName).
  const compileSelfHandle                          = {};
  if (entityName) {
    for (const [fName, desc] of Object.entries(fields)) {
      compileSelfHandle[fName] = fieldHandle(
        fName,
        desc                   ,
        entityName,
        (target         ) => typeof target === 'object' ? target : null,
      );
    }
  }

  for (const [checkName, fn] of Object.entries(declaredChecks)) {
    // Collision with a ref-role-derived name is a load error: the ref field is
    // the single source of truth and cannot be redeclared (fail closed).
    if (registry[checkName]) {
      throw new NonCompilableError(
        `check '${checkName}' is already derived from a ref(..., { role: '${checkName}' }) field and cannot be redeclared in checks`,
        { where: `entity '${entityName}'` },
      );
    }

    // Run face: invoke fn per-row with a runtime self-handle.
    const run = ({ entity: row, principal, runtime }                 )          => {
      const runtimeSelf                          = {};
      if (entityName) {
        for (const [fName, desc] of Object.entries(fields)) {
          const descriptor = desc                                                                                          ;
          // For map fields, expose the membership handle. db comes from runtime.
          if (descriptor?.kind === 'store' && descriptor.type === 'map') {
            const table = membershipTable(entityName, fName);
            const ownerCol = membershipOwnerCol(entityName);
            runtimeSelf[fName] = membershipHandle(table, ownerCol, () => row.id, () => runtime.db);
          }
          // For struct fields (the `link` kind), expose each sub-cell as a value
          // handle with a runtime `.is(v)` — the run-time mirror of the harvest
          // value `.is()`. A check like `Doc.linkShare.token.is(principal.attributes.token)`
          // resolves here: the hydrated namespace (`row.linkShare = {token, tier}`)
          // supplies the stored value; `.is(undefined)` is false (fail-closed for
          // a non-link principal, mirroring the harvest FALSE + SQL NULL bind).
          else if (descriptor?.kind === 'struct') {
            const handle                                                  = {};
            for (const [cellName] of Object.entries((descriptor                                       ).cells                           )) {
              handle[cellName] = {
                is: (v         ) => v == null ? false : (row[fName]                                       )?.[cellName] === v,
              };
            }
            runtimeSelf[fName] = handle;
          }
          // For non-role typed FKs, expose target map handles so declared checks
          // can traverse ownership in the same shape the compiler sees:
          // Photo.album.collaborators.has(principal.id). Ref-role fields stay raw
          // because their identity check is already the single derived role face.
          else if (descriptor?.kind === 'value' && descriptor.type === 'ref' && !descriptor.role) {
            runtimeSelf[fName] = makeRuntimeRefHandle({
              fieldName: fName,
              descriptor: desc,
              row,
              runtime,
            });
          }
          // For value/ref-role fields, expose the raw column value so a check can
          // read other columns if it needs to (the check destructures the entity).
          else {
            runtimeSelf[fName] = row[fName];
          }
        }
      }
      const entityContext = entityName ? { [entityName]: runtimeSelf } : {};
      return fn({
        entity: runtimeSelf,
        ...entityContext,
        principal,
      });
    };

    // Harvest face: built from the declared check body under the compile
    // self-handle. The body composes framework field handles (e.g.
    // `Entity.collaborators.has(principal.id)`) that return AST nodes; a body
    // that returns a non-AST value (a raw boolean from a runtime-shaped check)
    // is rejected at load (fail closed — never silently dropped from the SQL
    // filter, which would widen row visibility).
    const harvest = ()          => {
      const entityContext = entityName ? { [entityName]: compileSelfHandle } : {};
      const result = fn({
        entity: compileSelfHandle,
        ...entityContext,
        principal: { id: PRINCIPAL_ID_TOKEN, attributes: { token: PRINCIPAL_ATTR_TOKEN } },
      });
      if (!isNode(result)) {
        throw new NonCompilableError(
          `declared check '${checkName}' returned a non-AST value`,
          { where: `entity '${entityName}'` },
        );
      }
      return result;
    };
    registry[checkName] = { harvest, run };
  }

  // ---- Source 3: map-role names (runtime-only) ----
  // For each map field with `roles`, add a runtime-only entry per role name.
  // These entries have NO harvest face — using them in scope must fail.
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    const field = descriptor                                                                            ;
    if (field?.kind === 'store' && field.type === 'map' && Array.isArray(field.roles) && field.roles.length > 0) {
      const table = membershipTable(entityName          , fieldName);
      const ownerCol = membershipOwnerCol(entityName          );

      for (const roleName of field.roles) {
        // If the name already exists from a ref-role or declared check, skip it.
        // Declared/ref-role entries carry both faces and are the canonical source;
        // a map-role with the same name would be a weaker runtime-only shadow.
        if (registry[String(roleName)]) continue;

        registry[String(roleName)] = {
          // NO harvest face — runtime-only. Calling is.editor() in scope must throw.
          harvest: undefined,
          run: ({ entity: row, principal, runtime }) => {
            const stmt = runtime.db.prepare(
              `SELECT 1 FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member AND role = :role`,
            );
            return (
              stmt.get({ owner: row.id, member: principal.id, role: roleName }) != null
            );
          },
        };
      }
    }
  }

  return Object.freeze(registry);
}

// Runtime `.has(memberId)` / `.get(memberId)` over a membership side-table.
// `.get` returns the raw side-table row (or undefined) so checks can inspect a
// member's role. `ownerId` may be null (unset FK) — fail closed. `dbOf` defers
// the handle's db resolution to the caller's capture policy.
function membershipHandle(
  table        ,
  ownerCol        ,
  ownerIdOf               ,
  dbOf                ,
) {
  return {
    has: (memberId         )          => {
      const ownerId = ownerIdOf();
      if (ownerId == null) return false;
      return dbOf().prepare(
        `SELECT 1 FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`,
      ).get({ owner: ownerId, member: memberId }) != null;
    },
    get: (memberId         )                                      => {
      const ownerId = ownerIdOf();
      if (ownerId == null) return undefined;
      return dbOf().prepare(
        `SELECT * FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`,
      ).get({ owner: ownerId, member: memberId }) ?? undefined;
    },
  };
}

function makeRuntimeRefHandle({ fieldName, descriptor, row, runtime }




 ) {
  const targetReference = (descriptor                        ).target;
  const targetName = typeof targetReference === 'string'
    ? targetReference
    : (targetReference                                  )?.name;
  const target = targetReference
    ? (runtime.entityOf(targetReference)                                                                          )
    : null;
  const refId = row[fieldName];
  if (!target?.fields) return refId;
  const targetFields = target.fields;
  const targetTable = (target.name ?? targetName)          ;

  const mapEntries                                                       = [];
  const mapHandles                                                      = {};
  for (const [targetFieldName, targetDescriptor] of Object.entries(targetFields)) {
    const td = targetDescriptor                                                  ;
    if (td?.kind === 'store' && td.type === 'map') {
      const table = membershipTable(targetTable, targetFieldName);
      const ownerCol = membershipOwnerCol(targetTable);
      const mh = membershipHandle(table, ownerCol, () => refId, () => runtime.db);
      mapEntries.push([targetFieldName, mh]);
      mapHandles[targetFieldName] = mh;
    }
  }

  const handle                          = { id: refId, ...mapHandles };

  handle.then = (resolve                          , reject                            )       => {
    try {
      if (refId == null) {
        const result                          = { id: refId };
        for (const [k, v] of mapEntries) result[k] = v;
        resolve(result);
        return;
      }
      const targetRow = runtime.db.prepare(
        `SELECT * FROM ${targetTable} WHERE id = :id`,
      ).get({ id: refId });
      const result                          = { id: refId };
      if (targetRow) {
        for (const [k] of Object.entries(targetFields)) {
          if (k === 'id') result[k] = targetRow[k];
          else if (Object.prototype.hasOwnProperty.call(targetRow, k)) {
            result[k] = targetRow[k];
          }
        }
      }
      for (const [k, v] of mapEntries) result[k] = v;
      resolve(result);
    } catch (e) {
      reject(e);
    }
  };

  return handle;
}
