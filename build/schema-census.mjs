// schema-census.ts — S2/A2 pre-touch declaration validation + global object
// ownership census (epic scope#23, considerations #5/#8/#10/#12).
//
// One global ownership census maps every database object (table, index,
// trigger, virtual table) to exactly one owner kind: framework, entity
// (main + generated side tables + their indexes), schema (ordinary declared),
// plugin (declared plugin resource incl. virtual tables), or sqlite-artifact
// (FTS shadow tables of a declared plugin resource).
//
// The module is PURE: it accepts declaration data and returns
// `{ census, errors }`. It never accepts or touches a database handle — the
// `db?: never` field on the input is a compile-time poison pill so a handle
// can never be threaded in. Every check runs before any DDL or migration.
//
// Classification rules (consideration #8) are first-class outcomes:
//   - an object declared by exactly one lifecycle participant → owned by that
//     participant (valid);
//   - SQLite implementation artifacts such as FTS `_shadow` tables → attributed
//     to their declared plugin resource (valid while the plugin declaration
//     owns them);
//   - an observed object declared by NO participant → `undeclared` error.

import {
  collectEntityObjects,
  frameworkObjects,

} from './schema-table-census.mjs';

import { migrationIdentityKey } from './migration-identity.mjs';




// One ownership claim in the census.
















// A compiled entity declaration (the shape the DDL generators consume).




























































// A physical object observed in the database (e.g. from sqlite_master during
// the boot validation phase), classified against the census.



















                         











const RESERVED_MIGRATION_NAMESPACE = 'workbench';

function folded(name        )         {
  return name.toLowerCase();
}

export function censusKey(objectKind                             , name        )         {
  return `${objectKind}:${folded(name)}`;
}

// ---------------------------------------------------------------------------
// Claim bookkeeping
// ---------------------------------------------------------------------------






// SQLite shares one namespace for tables, indexes, and virtual tables (an
// index may not share a table's name), so relation-name collisions across
// those kinds are real conflicts. Trigger names live in their own namespace.
function isTriggerLike(kind                             )          {
  return kind === 'trigger';
}

// A per-name ownership ledger used while building the census. The census map
// keys by (kind, folded name) so consumers can look objects up the way they
// observe them; the relation/trigger maps key by folded name alone and enforce
// SQLite's shared/separate namespaces.
class ClaimBook {
           census = new Map                     ();
                   relation = new Map                     ();
                   triggers = new Map                     ();

  // Claim an object. Returns the winning entry and any error. `conflictCode`
  // overrides the default duplicate-claim classification (used for
  // entity-vs-plain). A claim by the same participant of an object it already
  // holds (`allowSameOwner`) is a no-op — used when a plugin's ownedObjects
  // re-lists a virtual table (or shadow) the schema already attributed to it.
  claim(
    objectKind                             ,
    name        ,
    ownerKind           ,
    owner        ,
    options                                                                        = {},
  )              {
    const key = censusKey(objectKind, name);
    const existing = this.census.get(key);
    if (existing !== undefined) {
      if (options.allowSameOwner === true && existing.kind === ownerKind && existing.owner === owner) {
        return { entry: existing, error: null };
      }
      return {
        entry: existing,
        error: {
          code: options.conflictCode ?? 'duplicate-claim',
          message: `duplicate claim of ${objectKind} "${name}": claimed by ${existing.kind} "${existing.owner}" and ${ownerKind} "${owner}"`,
          objectKind,
          name,
          participants: [`${existing.kind}:${existing.owner}`, `${ownerKind}:${owner}`],
        },
      };
    }

    const namespace = isTriggerLike(objectKind) ? this.triggers : this.relation;
    const priorRelation = namespace.get(folded(name));
    if (priorRelation !== undefined) {
      return {
        entry: priorRelation,
        error: {
          code: options.conflictCode ?? 'duplicate-claim',
          message: `duplicate claim of ${objectKind} "${name}": ${priorRelation.objectKind} "${name}" is already claimed by ${priorRelation.kind} "${priorRelation.owner}" (the names would collide under the SQLite relation namespace)`,
          objectKind,
          name,
          participants: [`${priorRelation.kind}:${priorRelation.owner}`, `${ownerKind}:${owner}`],
        },
      };
    }

    const entry              = Object.freeze({ kind: ownerKind, owner, objectKind, name });
    this.census.set(key, entry);
    namespace.set(folded(name), entry);
    return { entry, error: null };
  }

  ownerOfRelation(name        )                          {
    return this.relation.get(folded(name));
  }
}

// ---------------------------------------------------------------------------
// Column model for cross-graph FK validation
// ---------------------------------------------------------------------------












// SQLite affinity of a declared column type (CREATE TABLE type grammar).
function affinityOf(type                    )         {
  const t = (type ?? '').toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT';
  if (t.includes('BLOB') || t === '') return 'BLOB';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}

// The columns an entity main table declares (mirrors the entity DDL generator:
// id TEXT PRIMARY KEY plus stored fields).
function entityMainColumns(entity                   )               {
  const columns               = [{ name: 'id', type: 'TEXT', primaryKey: true }];
  for (const [name, descriptor] of Object.entries(entity.fields ?? {})) {
    const field = descriptor                                     ;
    if (field.kind === 'computed' && field.mode === 'pull') continue;
    if (field.kind === 'struct') {
      for (const cell of Object.keys((field.cells ?? {})                           )) {
        columns.push({ name: `${name}_${cell}`, type: 'TEXT' });
      }
      continue;
    }
    if (!['value', 'crdt', 'hash', 'state', 'projected'].includes(String(field.kind))
      && !(field.kind === 'computed' && field.mode === 'stored')) {
      continue;
    }
    const type = field.type === 'boolean' || field.type === 'date' ? 'INTEGER' : field.type === 'number' ? 'REAL' : 'TEXT';
    columns.push({ name, type });
  }
  return columns;
}

// ---------------------------------------------------------------------------
// Census construction
// ---------------------------------------------------------------------------

export function buildOwnershipCensus(input             )               {
  const errors                = [];
  const book = new ClaimBook();

  // --- framework claims (reserved namespace) -------------------------------
  // A duplicate within the framework derivation is a package-level invariant
  // violation, not an app declaration conflict — fail fast.
  const reserved = new Map                     (); // folded name -> framework entry
  const authEntityOf = new Map                (); // folded object name -> auth entity name
  const claimFramework = (objectKind            , name        , fromAuthEntity         )       => {
    const result = book.claim(objectKind, name, 'framework', 'framework');
    if (result.error !== null) throw result.error;
    reserved.set(folded(name), result.entry );
    if (fromAuthEntity !== undefined) authEntityOf.set(folded(name), folded(fromAuthEntity));
  };

  if (input.framework === undefined) {
    for (const object of frameworkObjects) {
      claimFramework(object.kind, object.name, object.fromAuthEntity);
    }
  } else {
    const framework = input.framework;
    for (const name of framework.tables ?? []) claimFramework('table', name);
    for (const name of framework.indexes ?? []) claimFramework('index', name);
    for (const name of framework.triggers ?? []) claimFramework('trigger', name);
    for (const name of framework.virtualTables ?? []) claimFramework('virtual-table', name);
  }

  const reservedNames = new Set(reserved.keys());

  // --- entity claims -------------------------------------------------------
  // Phase A: side tables, generated indexes, triggers, virtual tables.
  // Entity MAIN tables are held back until Phase C so a schema may take over an
  // entity main table (the schema-owned-entity-table feature) without tripping
  // the duplicate-claim rule.
  const entities = input.entities ?? [];
  const entityByName = new Map(entities.map((entity) => [folded(entity.name), entity]));
  const entityObjects = new Map                        ();

  const isAuthOwnedBySameEntity = (name        , entity                   )          =>
    authEntityOf.get(folded(name)) === folded(entity.name);

  const refuseReserved = (objectKind            , name        , claimerKind           , owner        )          => {
    if (!reservedNames.has(folded(name))) return false;
    errors.push({
      code: 'reserved-namespace',
      message: `${claimerKind} "${owner}" declares ${objectKind} "${name}", which is in the framework-reserved namespace`,
      objectKind,
      name,
      participants: ['framework', `${claimerKind}:${owner}`],
    });
    return true;
  };

  for (const entity of entities) {
    if (typeof entity.name !== 'string' || entity.name.length === 0) {
      errors.push({ code: 'invalid-declaration', message: 'entity declarations must declare a non-empty name' });
      continue;
    }
    let objects                ;
    try {
      objects = collectEntityObjects(entity);
    } catch (err) {
      errors.push({
        code: 'invalid-declaration',
        message: `cannot derive entity "${entity.name}" objects: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    entityObjects.set(folded(entity.name), objects);
    const claims                                         = [
      ['table', objects.tables.filter((name) => folded(name) !== folded(entity.name))],
      ['index', objects.indexes],
      ['trigger', objects.triggers],
      ['virtual-table', objects.virtualTables],
    ];
    for (const [kind, names] of claims) {
      for (const name of names) {
        // An auth entity re-mounting its own generated object: the framework
        // already owns it — skip rather than claim (a duplicate claim would be
        // a false conflict).
        if (isAuthOwnedBySameEntity(name, entity)) continue;
        if (refuseReserved(kind, name, 'entity', entity.name)) continue;
        const result = book.claim(kind, name, 'entity', entity.name);
        if (result.error !== null) errors.push(result.error);
      }
    }
  }

  // --- schema claims -------------------------------------------------------
  const schemas = input.schemaDeclarations ?? [];
  const schemaTablesByEntityName = new Map                                                               ();
  const columnModel = new Map                   ();
  // Entity side-table names (no declared column model), filled from Phase A
  // results after entities are processed — used to skip column checks on FKs
  // targeting generated side tables.
  const entitySideTableNames = new Set        ();
  for (const [entityKey, objects] of entityObjects) {
    for (const name of objects.tables) {
      if (folded(name) !== entityKey) entitySideTableNames.add(folded(name));
    }
  }

  for (const schema of schemas) {
    for (const table of schema.tables ?? []) {
      columnModel.set(folded(table.name), { columns: table.columns, primaryKey: table.primaryKey });
      if (reservedNames.has(folded(table.name))) {
        errors.push({
          code: 'reserved-namespace',
          message: `schema "${schema.name}" declares table "${table.name}", which is in the framework-reserved namespace`,
          objectKind: 'table',
          name: table.name,
          participants: ['framework', `schema:${schema.name}`],
        });
        continue;
      }
      const priorRelation = book.ownerOfRelation(table.name);
      if (priorRelation !== undefined && priorRelation.kind === 'entity') {
        // Entity main tables are claimed only in Phase C, so any entity
        // relation claim at this point is a generated side table / index /
        // trigger / virtual table — the entity/plain conflict.
        errors.push({
          code: 'entity-plain-conflict',
          message: `schema "${schema.name}" declares table "${table.name}", which conflicts with a generated ${priorRelation.objectKind} owned by entity "${priorRelation.owner}"`,
          objectKind: 'table',
          name: table.name,
          participants: [`entity:${priorRelation.owner}`, `schema:${schema.name}`],
        });
        continue;
      }
      const result = book.claim('table', table.name, 'schema', schema.name);
      if (result.error !== null) errors.push(result.error);
      schemaTablesByEntityName.set(folded(table.name), { schemaName: schema.name, table });
    }
    for (const table of schema.tables ?? []) {
      for (const index of table.indexes ?? []) {
        if (refuseReserved('index', index.name, 'schema', schema.name)) continue;
        const result = book.claim('index', index.name, 'schema', schema.name);
        if (result.error !== null) errors.push(result.error);
      }
      for (const trigger of table.triggers ?? []) {
        if (refuseReserved('trigger', trigger.name, 'schema', schema.name)) continue;
        const result = book.claim('trigger', trigger.name, 'schema', schema.name);
        if (result.error !== null) errors.push(result.error);
      }
    }
    for (const virtualTable of schema.virtualTables ?? []) {
      if (refuseReserved('virtual-table', virtualTable.name, 'schema', schema.name)) continue;
      const pluginIds = new Set((input.plugins ?? []).map((plugin) => folded(plugin.id)));
      if (!pluginIds.has(folded(virtualTable.ownerPluginId))) {
        errors.push({
          code: 'plugin-ownership',
          message: `schema "${schema.name}" declares virtual table "${virtualTable.name}" owned by plugin "${virtualTable.ownerPluginId}", which is not a declared plugin`,
          objectKind: 'virtual-table',
          name: virtualTable.name,
          participants: [folded(virtualTable.ownerPluginId)],
        });
        continue;
      }
      const result = book.claim('virtual-table', virtualTable.name, 'plugin', virtualTable.ownerPluginId);
      if (result.error !== null) errors.push(result.error);
      for (const shadow of virtualTable.shadowTables ?? []) {
        if (reservedNames.has(folded(shadow))) {
          errors.push({
            code: 'reserved-namespace',
            message: `virtual table "${virtualTable.name}" declares shadow table "${shadow}", which is in the framework-reserved namespace`,
            objectKind: 'shadow-table',
            name: shadow,
            participants: ['framework', `plugin:${virtualTable.ownerPluginId}`],
          });
          continue;
        }
        const shadowResult = book.claim('table', shadow, 'sqlite-artifact', virtualTable.ownerPluginId, { allowSameOwner: true });
        if (shadowResult.error !== null) errors.push(shadowResult.error);
      }
    }
    for (const external of schema.externalTables ?? []) {
      // External tables are declarations of knowledge about tables the schema
      // does not create, so they are attributed to the declaring schema but
      // never treated as exclusive ownership claims (re-declaration by another
      // schema is valid — consideration #8: declared by another participant).
      // A framework-reserved name is still off-limits: an external declaration
      // claims knowledge of the name, and the reserved namespace may not be
      // claimed by any participant.
      if (refuseReserved('table', external.name, 'schema', schema.name)) continue;
      if (!book.census.has(censusKey('table', external.name))) {
        book.claim('table', external.name, 'schema', schema.name);
      }
      columnModel.set(folded(external.name), {
        columns: external.columns.map((name) => ({ name })),
      });
    }
    // Triggers the fixture/app created out-of-band on external or framework
    // tables (declared knowledge, same non-exclusive attribution as external
    // tables: another participant may claim the same trigger name).
    for (const trigger of schema.externalTriggers ?? []) {
      if (refuseReserved('trigger', trigger.name, 'schema', schema.name)) continue;
      if (!book.census.has(censusKey('trigger', trigger.name))) {
        book.claim('trigger', trigger.name, 'schema', schema.name);
      }
    }
  }

  // --- entity main tables (Phase C) ----------------------------------------
  for (const entity of entities) {
    const objects = entityObjects.get(folded(entity.name));
    if (objects === undefined) continue;
    const mainTable = objects.tables.find((name) => folded(name) === folded(entity.name));
    if (mainTable === undefined) continue;
    if (reservedNames.has(folded(mainTable))) {
      // An auth entity re-mounting its own main table is fine (framework wins).
      if (isAuthOwnedBySameEntity(mainTable, entity)) continue;
      errors.push({
        code: 'reserved-namespace',
        message: `entity "${entity.name}" declares main table "${mainTable}", which is in the framework-reserved namespace`,
        objectKind: 'table',
        name: mainTable,
        participants: ['framework', `entity:${entity.name}`],
      });
      continue;
    }
    const heldBySchema = book.ownerOfRelation(mainTable);
    if (heldBySchema !== undefined && heldBySchema.kind === 'schema' && heldBySchema.objectKind === 'table') {
      // Schema-owned entity table — the schema owns the main table; the entity
      // still owns its side tables and generated indexes.
      continue;
    }
    const claim = book.claim('table', mainTable, 'entity', entity.name);
    if (claim.error !== null) errors.push(claim.error);
    columnModel.set(folded(mainTable), { columns: entityMainColumns(entity) });
  }

  // --- plugin ownedObjects (Phase D) ---------------------------------------
  for (const plugin of input.plugins ?? []) {
    for (const object of plugin.ownedObjects ?? []) {
      // A plugin re-listing a virtual table (or its shadow) the schema already
      // attributed to the same plugin is the same claim, not a duplicate.
      const existing = book.census.get(censusKey(object.kind, object.name));
      const alreadySamePlugin = existing !== undefined
        && ((existing.kind === 'plugin' && folded(existing.owner) === folded(plugin.id))
          || (existing.kind === 'sqlite-artifact' && folded(existing.owner) === folded(plugin.id)));
      if (alreadySamePlugin) continue;
      if (refuseReserved(object.kind, object.name, 'plugin', plugin.id)) continue;
      const result = book.claim(object.kind, object.name, 'plugin', plugin.id);
      if (result.error !== null) errors.push(result.error);
    }
  }

  // --- cross-graph FK validation -------------------------------------------
  // Schema-declared FKs: target tables may live in any schema, the external
  // table set, an entity main table, or the framework. Entity ref FKs preserve
  // app.ts today's rule: a physical ref target must be a registered entity, and
  // a schema-owned target must expose a TEXT id primary key.
  const knownTables = new Set        ();
  for (const schema of schemas) {
    for (const table of schema.tables ?? []) knownTables.add(folded(table.name));
    for (const external of schema.externalTables ?? []) knownTables.add(folded(external.name));
  }
  for (const entity of entities) knownTables.add(folded(entity.name));
  for (const name of reservedNames) knownTables.add(name);

  const columnInfoOf = (tableName        , columnName        )                         =>
    columnModel.get(folded(tableName))?.columns.find((column) => folded(column.name) === folded(columnName));

  const isIntegerPrimaryKey = (tableName        , columnName        )          => {
    const table = columnModel.get(folded(tableName));
    const column = table?.columns.find((candidate) => folded(candidate.name) === folded(columnName));
    if (column === undefined) return false;
    if (affinityOf(column.type) !== 'INTEGER') return false;
    if (column.primaryKey === true) return true;
    return (table?.primaryKey ?? []).some((name) => folded(name) === folded(columnName));
  };

  const validateSchemaForeignKeys = (schema                   )       => {
    for (const table of schema.tables ?? []) {
      for (const foreignKey of table.foreignKeys ?? []) {
        const targetName = foreignKey.references.table;
        if (!knownTables.has(folded(targetName))) {
          errors.push({
            code: 'fk-target',
            message: `table "${table.name}" in schema "${schema.name}" has a foreign key referencing missing table "${targetName}"`,
            objectKind: 'table',
            name: table.name,
          });
          continue;
        }
        if (foreignKey.columns.length !== foreignKey.references.columns.length) {
          errors.push({
            code: 'fk-count',
            message: `foreign key on table "${table.name}" references "${targetName}" with mismatched column counts`,
            objectKind: 'table',
            name: table.name,
          });
          continue;
        }
        for (let i = 0; i < foreignKey.columns.length; i += 1) {
          const sourceColumn = columnInfoOf(table.name, foreignKey.columns[i]);
          if (sourceColumn === undefined) {
            errors.push({
              code: 'fk-column',
              message: `foreign key on table "${table.name}" references missing column "${foreignKey.columns[i]}"`,
              objectKind: 'table',
              name: table.name,
            });
          }
          const targetColumn = columnInfoOf(targetName, foreignKey.references.columns[i]);
          if (targetColumn === undefined) {
            // Framework tables and entity side tables have no declared column
            // model, so a reference into them cannot be column-checked.
            if (!reservedNames.has(folded(targetName)) && !entitySideTableNames.has(folded(targetName))) {
              errors.push({
                code: 'fk-column',
                message: `foreign key on table "${table.name}" references column "${foreignKey.references.columns[i]}" of "${targetName}", which is not a declared column of that table`,
                objectKind: 'table',
                name: table.name,
              });
            }
            continue;
          }
          // Columns without a declared type (external-table columns, entity
          // side tables) cannot be affinity-checked.
          if (sourceColumn === undefined || sourceColumn.type === undefined || targetColumn.type === undefined) {
            continue;
          }
          // SQLite FK rule: the child column's affinity must match the parent
          // column's affinity, unless the parent column is an INTEGER PRIMARY
          // KEY (which any affinity may reference).
          if (!isIntegerPrimaryKey(targetName, foreignKey.references.columns[i])
            && affinityOf(sourceColumn.type) !== affinityOf(targetColumn.type)) {
            errors.push({
              code: 'fk-affinity',
              message: `foreign key on table "${table.name}" (${foreignKey.columns[i]}) references "${targetName}" (${foreignKey.references.columns[i]}) with incompatible column affinity`,
              objectKind: 'table',
              name: table.name,
            });
          }
        }
      }
    }
  };

  for (const schema of schemas) validateSchemaForeignKeys(schema);

  for (const entity of entities) {
    for (const [fieldName, descriptor] of Object.entries(entity.fields ?? {})) {
      const field = descriptor                                     ;
      if (field.physical !== true || field.kind !== 'value' || field.type !== 'ref') continue;
      const targetValue = field.target;
      const targetName = (typeof targetValue === 'string' ? undefined : (targetValue                                        )?.name)
        ?? (targetValue === entity.name ? entity.name : null);
      if (typeof targetName !== 'string' || targetName.length === 0) continue;
      if (!entityByName.has(folded(targetName))) {
        errors.push({
          code: 'fk-target',
          message: `entity "${entity.name}" field "${fieldName}" references unregistered Workbench entity "${targetName}"`,
          objectKind: 'table',
          name: entity.name,
        });
        continue;
      }
      const schemaOwned = schemaTablesByEntityName.get(folded(targetName));
      if (schemaOwned !== undefined) {
        const id = schemaOwned.table.columns.find((column) => folded(column.name) === 'id');
        if (id === undefined || String(id.type ?? '').toLowerCase() !== 'text' || id.primaryKey !== true) {
          errors.push({
            code: 'fk-shape',
            message: `entity "${entity.name}" field "${fieldName}" ref target "${targetName}" must have a TEXT id primary key`,
            objectKind: 'table',
            name: targetName,
          });
        }
      }
    }
  }

  // --- migration namespace rules (consideration #12) -----------------------
  // A namespace is claimed by at most one schema declaration across the census,
  // and one schema may claim it across several ledger versions (the `scope@1` →
  // `scope@2` split): each (namespace, version) pair is claimed at most once.
  // Ordering and contiguity of those versions belong to the runner
  // (`migration-ledger.ts`), not to this pre-touch census. Ownership is tracked
  // per schema declaration (by ordinal, not just name) so two distinct schema
  // declarations sharing a name cannot silently share a namespace.
  const namespaceOwner = new Map                                             ();
  for (const [schemaOrdinal, schema] of schemas.entries()) {
    const claimedVersions = new Set        ();
    for (const migration of schema.migrations ?? []) {
      const namespaceKey = folded(migration.namespace);
      if (namespaceKey === RESERVED_MIGRATION_NAMESPACE) {
        errors.push({
          code: 'migration-reserved',
          message: `schema "${schema.name}" declares migration namespace "${migration.namespace}", which is reserved for the package (consideration #12)`,
          name: migration.namespace,
        });
        continue;
      }
      const versionKey = migrationIdentityKey(migration.namespace, migration.version);
      if (claimedVersions.has(versionKey)) {
        errors.push({
          code: 'namespace-claim',
          message: `schema "${schema.name}" declares migration namespace "${migration.namespace}" version ${migration.version} more than once`,
          name: migration.namespace,
          participants: [schema.name, schema.name],
        });
        continue;
      }
      const prior = namespaceOwner.get(namespaceKey);
      if (prior !== undefined && prior.ordinal !== schemaOrdinal) {
        errors.push({
          code: 'namespace-claim',
          message: `migration namespace "${migration.namespace}" is claimed by both schema "${prior.schema}" and schema "${schema.name}"`,
          name: migration.namespace,
          participants: [prior.schema, schema.name],
        });
        continue;
      }
      claimedVersions.add(versionKey);
      namespaceOwner.set(namespaceKey, { schema: schema.name, ordinal: schemaOrdinal });
    }
  }

  // --- observed-object classification (consideration #8) -------------------
  for (const observed of input.observed ?? []) {
    const classified = classifyObservedObject(observed, book.census);
    if (classified.kind === 'undeclared') {
      errors.push({
        code: 'undeclared',
        message: `observed ${observed.type} "${observed.name}" is not declared by any lifecycle participant`,
        objectKind: observed.type,
        name: observed.name,
      });
    }
  }

  return Object.freeze({
    census: book.census,
    errors: Object.freeze(errors),
    objectCount: book.census.size,
  });
}

// ---------------------------------------------------------------------------
// Observed-object classification
// ---------------------------------------------------------------------------





// Classify ONE physical object against the census. A virtual table is
// physically a table, so an observed `table` may resolve to a `virtual-table`
// census entry; FTS shadow tables resolve to their sqlite-artifact entry.
export function classifyObservedObject(
  observed                ,
  census                                  ,
)              {
  const keys = observed.type === 'table'
    ? [censusKey('table', observed.name), censusKey('virtual-table', observed.name)]
    : [censusKey(observed.type, observed.name)];
  for (const key of keys) {
    const entry = census.get(key);
    if (entry !== undefined) return { kind: 'owned', owner: entry };
  }
  return { kind: 'undeclared', object: observed };
}

export function classifyObservedObjects(
  observed                           ,
  census                                  ,
)                         {
  return Object.freeze(observed.map((object) => classifyObservedObject(object, census)));
}


