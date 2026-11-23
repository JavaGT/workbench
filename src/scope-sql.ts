// The scope→SQL compiler: the grant's READ half, lowered to a parameterized
// SQL WHERE fragment (SPEC §6.1, §11, §13; ADR #2).
//
// A `scope(predicate)` predicate is harvested ONCE at entity-load by invoking it
// with an `{ is, fields }` builder. The calls produce a small closed-set AST;
// `lowerToSql` turns that AST into `{ sql, params }`. The predicate never runs
// as JS per row — it is read once to produce SQL, so the database never returns
// a forbidden row. A predicate that cannot lower is a LOAD-TIME ERROR: there is
// no silent JS fallback (the whole point of the scope/can split).
//
// Concentration (deletion test): one compiler serves role-checks (Eq through a
// typed FK), value predicates (In/IsNull), and — when inherit lands — child
// grant inheritance (Join). The `is`/`fields` builders are constructed per
// entity-load from the frozen field descriptors; there is no per-request cost.

import { serializeField, structCellColumn } from './field-strategy.ts';
import type { FieldDescriptor as StrategyFieldDescriptor } from './field-strategy.ts';
import * as eventHandle from './event-handle.ts';
import { getAnnotatedTextCompiledMetadata } from './annotated-text-field.ts';

// The logical name of the param a role check (`is.<role>()`) emits — the one
// placeholder the query layer rebinds per request to the concrete principal id.
// Named here so the compiler that mints it and the binder that fills it share
// one handle instead of an implicit string (house style: no magic strings).
export const PRINCIPAL_ID_PARAM = 'principalId';

// The logical name of the param a link-principal check (`is.linkHolder()`)
// emits — the placeholder the query layer rebinds per request to the link
// principal's `attributes.token`. Sibling to PRINCIPAL_ID_PARAM; one house
// style, two named slots (a link principal is identified by its token, a user
// principal by its id — never one field overloaded for both).
export const PRINCIPAL_ATTR_PARAM = 'principalAttrToken';

// Membership side-table naming convention (singular system: one helper each, so
// the lowering, the write path, and the schema migration all agree).
export const MEMBER_COLUMN = 'member_id';
export const membershipTable = (entityName: string, fieldName: string): string => `${entityName}_${fieldName}`;
export const membershipOwnerCol = (entityName: string): string => `${entityName}_id`;

// A branded token the harvester injects as `principal.id` so a map `.has()` can
// tell "this is the requesting principal → emit a rebindable principalId param"
// from a literal value. Exported so the registry can reference it.
export const PRINCIPAL_ID_TOKEN = Symbol('principalId');

// A branded token the harvester injects as `principal.attributes.token` so a
// struct sub-cell `.is()` can tell "this is the link principal's token → emit a
// rebindable principalAttrToken param" from a literal value. Mirror of
// PRINCIPAL_ID_TOKEN for the link-identity axis.
export const PRINCIPAL_ATTR_TOKEN = Symbol('principalAttrToken');
// Module-private provenance for closed declaration grammar handles lives in
// snapshot.ts (the grammar must stay dependency-free), which also owns the
// predicate. Real handles register here at creation so `related(...)` and any
// other brand check accept them.
export { isSnapshotFieldHandle } from './snapshot.ts';
import { registerSnapshotFieldHandle } from './snapshot.ts';

// A typed load-time failure, sibling to UnawaitedCheckError. Raised when a scope
// predicate cannot be lowered to SQL.
export class NonCompilableError extends Error {
  where: string | null;

  constructor(message: string, { where }: { where?: string } = {}) {
    super(where ? `${message} (in ${where})` : message);
    this.name = 'NonCompilableError';
    this.where = where ?? null;
  }
}

// ---- AST nodes (closed set, frozen, each tagged by `node`) ------------------
// True/False are the deliberate developer-written extremes (everyone()/never()).
// Eq/In/IsNull are leaf comparisons against a declared field. Not/And compose.
// Or is RESERVED (Phase 2); Phase 1 lowers anyOf via De Morgan and never emits
// it. A Join (reserved here, exercised when inherit lands) traverses a typed FK.
// The AST node is an open record tagged by `node`; each lowering case reads its
// own fields (loose by design — the op set is closed and frozen).
export interface AstNode {
  readonly node: string;
  readonly and: (other: AstNode) => AstNode;
  readonly not: () => AstNode;
  readonly [key: string]: unknown;
}

const TRUE: AstNode = Object.freeze({ node: 'true' }) as unknown as AstNode;
const FALSE: AstNode = Object.freeze({ node: 'false' }) as unknown as AstNode;

export function isNode(x: unknown): x is AstNode {
  return x !== null && typeof x === 'object' && typeof (x as { node?: unknown }).node === 'string';
}

// Attach the fluent combinators (.and/.not) to every node so `a.and(b)` works.
export function makeNode(props: Record<string, unknown>): AstNode {
  const node: Record<string, unknown> = { ...props };
  node.and = (other: AstNode): AstNode => makeNode({ node: 'and', operands: [Object.freeze(node), other] });
  node.not = (): AstNode => makeNode({ node: 'not', operand: Object.freeze(node) });
  return Object.freeze(node) as unknown as AstNode;
}

// ---- the inherit directive (imported by the developer) ----------------------
// `inherit(Parent, { via })` declares that a child entity's grant IS its
// parent's, reached through the typed FK named `via`. It takes the compiled
// parent ENTITY OBJECT (not a string name): no registry, no global namespace —
// the parent must be defined above the child. The directive is a plain frozen
// record the entity compiler recognizes; it carries the parent's harvested scope
// AST (so the child can re-lower it under a join alias) and the FK column name.
export function inherit(parent: unknown, { via }: { via?: unknown } = {}): { inherit: unknown; via: unknown } {
  if (parent === undefined || parent === null || typeof parent !== 'object' || !(parent as { name?: unknown }).name) {
    throw new NonCompilableError(
      'inherit(Parent, { via }) requires the compiled parent entity object, ' +
        'not a name. Define the parent above the child and pass it directly.',
    );
  }
  if (typeof via !== 'string' || via.length === 0) {
    throw new NonCompilableError(
      `inherit(${(parent as { name: unknown }).name}, { via }) requires a 'via' FK column name (string).`,
    );
  }
  return Object.freeze({ inherit: parent, via });
}

// ---- top-level combinators (imported by the developer) ----------------------
export const everyone: () => AstNode = () => TRUE;
export const never: () => AstNode = () => FALSE;
// De Morgan: anyOf(a,b,c) == NOT(AND(NOT a, NOT b, NOT c)). Built only from the
// Phase 1 op set (and+not); reserves the native Or node for Phase 2.
export const anyOf = (...nodes: AstNode[]): AstNode =>
  makeNode({ node: 'and', operands: nodes.map((n) => makeNode({ node: 'not', operand: n })) }).not();

// ---- the per-entity predicate builders --------------------------------------
// `is.<name>()` resolves through the REGISTRY — the same registry that produces
// the runtime (per-row) faces for row-grant.mjs. This is the ONE check registry
// evaluated in both modes (compile and runtime), not two independent paths.
//
// A name with a `harvest` face → invoke it (returns an AST node).
// A name in the registry WITHOUT a harvest face → runtime-only, throw.
// A name NOT in the registry at all → throw.
function makeIsProxy(registry: Record<string, unknown>, where: string): unknown {
  return new Proxy({}, {
    get(_t, name) {
      const entry = registry[name as string] as { harvest?: () => AstNode } | undefined;
      if (entry) {
        const harvest = entry.harvest;
        if (harvest) {
          return () => harvest();
        }
        return () => {
          throw new NonCompilableError(
            `check '${String(name)}' is runtime-only and cannot be used in scope ` +
              `(it inspects a per-row payload the SQL filter never sees)`,
            { where },
          );
        };
      }
      return () => {
        throw new NonCompilableError(`no check '${String(name)}' on this entity`, { where });
      };
    },
  });
}

// The typed handle one compilable field exposes: the value ops (is/in/isNull/
// gte/lte) plus the special forms the field's kind adds (has for a map,
// matches for FTS text, nearest for a vector, native event handles for a
// membership/list/log field). The `__value`/`__mode` phantoms are type-level
// only (never set at runtime): they let declaration utilities read a handle's
// value type and absence mode, mirroring FieldDescriptor.
export interface FieldHandle {
  fieldName: string;
  entityName?: string | undefined;
  readonly __value?: unknown;
  readonly __mode?: 'required' | 'optional';
  is: (value: unknown) => AstNode;
  in: (values: Iterable<unknown>) => AstNode;
  isNull: () => AstNode;
  gte: (value: unknown) => AstNode;
  lte: (value: unknown) => AstNode;
  has?: (value: unknown) => AstNode;
  matches?: (query: unknown) => AstNode;
  nearest?: (query: unknown, k: number) => AstNode;
  [key: string]: unknown;
}

// A field descriptor as the scope compiler reads it: kind/type/role decide which
// ops exist, cells names a struct's sub-cells, target names a ref's FK target.
type FieldDescriptor = StrategyFieldDescriptor;

// A typed handle for one field, exposing the compilable value ops. This is the
// ONE handle definition: the scope compiler reaches it through makeFieldsProxy
// (where the field name comes from a `fields.<name>` access), and the runtime
// query API attaches it directly on the compiled entity (Entity.<name>) so a
// hand-written handler can write `User.username.is(name)`. The handle also
// carries its own `fieldName`, so it doubles as a `.select(...)` projection
// handle. Ops on a non-compilable field kind (crdt/ordered/store) throw.
// Every produced handle registers as a closed snapshot-grammar handle.
export function fieldHandle(
  name: string,
  descriptor: FieldDescriptor | undefined,
  entityName?: string,
  resolveEntity?: (target: unknown) => unknown,
): FieldHandle {
  const handle = buildFieldHandle(name, descriptor, entityName, resolveEntity);
  registerSnapshotFieldHandle(handle);
  return handle;
}

function buildFieldHandle(
  name: string,
  descriptor: FieldDescriptor | undefined,
  entityName?: string,
  resolveEntity?: (target: unknown) => unknown,
): FieldHandle {
  if (descriptor === undefined) {
    const fail = (where?: string): never => {
      throw new NonCompilableError(`no field '${String(name)}' on this entity`, { where });
    };
    return {
      fieldName: name,
      entityName,
      is: () => fail(),
      in: () => fail(),
      isNull: () => fail(),
      gte: () => fail(),
      lte: () => fail(),
    };
  }
  // A structured field (the `link` kind) is a NAMESPACE of named value sub-cells.
  // The struct itself is not comparable (you compare a sub-cell, not the whole
  // struct) — its own .is/.in/.isNull throw, like any non-value field. Each
  // declared sub-cell resolves to an ORDINARY value handle bound to its own
  // generated column (`<field>__<cell>`): the SAME `.is()` a flat field uses, so
  // linkShare.token.is(x) lowers to `t0.linkShare__token = :p` through the
  // existing value path (concentrate, not a second comparison path).
  if (descriptor.kind === 'struct') {
    const fail = (): never => {
      throw new NonCompilableError(
        `field '${String(name)}' is a structured (${descriptor.type}) field and cannot be ` +
          `compared as a whole — compare one of its sub-cells (e.g. ${String(name)}.token)`,
      );
    };
    const handle: FieldHandle = { fieldName: name, entityName, is: fail, in: fail, isNull: fail, gte: fail, lte: fail };
    for (const [cellName, cellDescriptor] of Object.entries(descriptor.cells ?? {})) {
      handle[cellName] = fieldHandle(structCellColumn(name, cellName), cellDescriptor);
    }
    return handle;
  }
  // A map field (the `store` kind, `type: 'map'`) is an owned membership collection
  // living in a side-table. Whole-value comparison of the map is still forbidden
  // (`.is/.in/.isNull` throw — a map is not a scalar). But MEMBERSHIP is a
  // compilable fact: `.has(value)` mints an `existsMembership` node that lowers
  // to a correlated EXISTS over the membership side-table. When the value is the
  // branded principal-id token, the compiler emits a rebindable principalId param
  // (so bindReadScope fills it per request); otherwise the literal is baked in.
  if (descriptor.kind === 'store' && descriptor.type === 'map') {
    const fail = (): never => {
      throw new NonCompilableError(
        `field '${String(name)}' is a ${descriptor.kind} field and cannot be compared in scope`,
      );
    };
    // If we don't have an entity name (e.g. called from makeFieldsProxy without
    // a self handle), .has() cannot construct the table name — throw a helpful
    // error rather than silently emitting a wrong table.
    const tableName = entityName ? membershipTable(entityName, name) : null;
    const ownerCol = entityName ? membershipOwnerCol(entityName) : null;
    const handle: FieldHandle = {
      fieldName: name,
      is: fail,
      in: fail,
      isNull: fail,
      gte: fail,
      lte: fail,
      has: (value: unknown) => {
        if (tableName === null) {
          throw new NonCompilableError(
            `field '${String(name)}' is a map field but no entity name is available ` +
              `to construct the membership table — use the entity-name handle, not 'fields'.`,
          );
        }
        // If the value is the principal-id TOKEN (branded), emit a rebindable
        // principalId param so bindReadScope fills it per request. A literal
        // member id is baked into the node directly — it is NOT the requesting
        // principal, so it must not be rebound.
        if (value === PRINCIPAL_ID_TOKEN) {
          return makeNode({
            node: 'existsMembership',
            table: tableName,
            ownerCol,
            param: PRINCIPAL_ID_PARAM,
          });
        }
        return makeNode({
          node: 'existsMembership',
          table: tableName,
          ownerCol,
          value,
        });
      },
    };
    // Typed native event handles for the map field's mutations: the derived
    // identifiers the effect compiler matches against (a field handle is the
    // single source — no separate `native('E','f','added')` string path). Only
    // attached when the entity name is known (entity-handle access), since the
    // handle needs the entity name to build the event type.
    if (entityName) {
      handle.added = eventHandle.native(entityName, name, 'added');
      handle.roleChanged = eventHandle.native(entityName, name, 'roleChanged');
      handle.removed = eventHandle.native(entityName, name, 'removed');
    }
    return handle;
  }

  // An ordered list field (the `ordered` kind) exposes typed native event
  // handles for its mutations, like the map field. Whole-value comparison is
  // still forbidden (an ordered collection is not a scalar).
  if (descriptor.kind === 'ordered') {
    const fail = (): never => {
      throw new NonCompilableError(
        `field '${String(name)}' is an ${descriptor.kind} field and cannot be compared in scope`,
      );
    };
    const handle: FieldHandle = {
      fieldName: name,
      is: fail,
      in: fail,
      isNull: fail,
      gte: fail,
      lte: fail,
    };
    if (entityName) {
      handle.inserted = eventHandle.native(entityName, name, 'inserted');
      handle.moved = eventHandle.native(entityName, name, 'moved');
      handle.reordered = eventHandle.native(entityName, name, 'reordered');
      handle.removed = eventHandle.native(entityName, name, 'removed');
    }
    return handle;
  }

  // A log field (the `store` kind, `type: 'log'`) exposes its typed native
  // `appended` event handle. Whole-value comparison is forbidden.
  if (descriptor.kind === 'store' && descriptor.type === 'log') {
    const fail = (): never => {
      throw new NonCompilableError(
        `field '${String(name)}' is a ${descriptor.kind} field and cannot be compared in scope`,
      );
    };
    const handle: FieldHandle = {
      fieldName: name,
      is: fail,
      in: fail,
      isNull: fail,
      gte: fail,
      lte: fail,
    };
    if (entityName) {
      handle.appended = eventHandle.native(entityName, name, 'appended');
    }
    return handle;
  }

  // An annotatedText field exposes a frozen handle with typed annotations,
  // measurements, and capabilities collections. Whole-value comparison is
  // forbidden. The handle is compiled from the declaration metadata, never
  // from physical tables or encoding internals.
  if (descriptor.kind === 'annotatedText') {
    const fail = (): never => {
      throw new NonCompilableError(
        `field '${String(name)}' is an annotatedText field and cannot be compared in scope`,
      );
    };
    const meta = getAnnotatedTextCompiledMetadata(descriptor) as
      { annotationHandles?: unknown; measurementHandles?: unknown; capabilityHandles?: unknown } | null | undefined;
    const handle: FieldHandle = {
      fieldName: name,
      is: fail,
      in: fail,
      isNull: fail,
      gte: fail,
      lte: fail,
      annotations: meta?.annotationHandles ?? Object.freeze({}),
      measurements: meta?.measurementHandles ?? Object.freeze({}),
      capabilities: meta?.capabilityHandles ?? null,
    };
    return handle;
  }

  if (descriptor.kind !== 'value') {
    const fail = (): never => {
      throw new NonCompilableError(
        `field '${String(name)}' is a ${descriptor.kind} field and cannot be compared in scope`,
      );
    };
    return { fieldName: name, is: fail, in: fail, isNull: fail, gte: fail, lte: fail };
  }
  const handle: FieldHandle = {
    fieldName: name,
    entityName,
    // .is(undefined) is the deliberate FALSE value (never IS NULL); .is(v) mints
    // a literal-valued equality. The literal is baked in its SERIALIZED
    // (stored-cell) form via the field's strategy — a boolean becomes 1/0, a
    // Date epoch millis — so the param is bindable by node:sqlite, which refuses
    // a JS boolean. One serialize, used here and by the write path.
    is: (value: unknown) => {
      // The link-identity token: emit a rebindable principalAttrToken param (the
      // struct sub-cell lives on a generated `<field>__<cell>` column, bound per
      // request to principal.attributes.token). A literal value is baked in
      // below — it is NOT the requesting principal, so it must not be rebound.
      if (value === PRINCIPAL_ATTR_TOKEN) {
        return makeNode({ node: 'eq', field: name, param: PRINCIPAL_ATTR_PARAM });
      }
      return value === undefined
        ? FALSE
        : makeNode({ node: 'eq', field: name, value: serializeField(descriptor, value) });
    },
    in: (values: Iterable<unknown>) =>
      makeNode({ node: 'in', field: name, values: [...values].map((v) => serializeField(descriptor, v)) }),
    isNull: () => makeNode({ node: 'isNull', field: name }),
    gte: (value: unknown) => value === undefined
      ? FALSE
      : makeNode({ node: 'gte', field: name, value: serializeField(descriptor, value) }),
    lte: (value: unknown) => value === undefined
      ? FALSE
      : makeNode({ node: 'lte', field: name, value: serializeField(descriptor, value) }),
  };
  // FTS-indexed text fields expose a .matches(query) predicate that compiles to
  // a correlated EXISTS over the FTS5 virtual table. Requires entityName to
  // construct the table name (available on the entity handle, and — after
  // entityName threading — in the fields proxy too).
  if (descriptor.indexed === 'fts') {
    if (entityName) {
      handle.matches = (query: unknown) => {
        if (typeof query !== 'string' || query.length === 0) {
          throw new NonCompilableError(
            `field '${String(name)}'.matches(query) requires a non-empty search string`,
          );
        }
        return makeNode({ node: 'match', entity: entityName, field: name, value: query });
      };
    } else {
      handle.matches = () => {
        throw new NonCompilableError(
          `field '${String(name)}'.matches(query) requires an entity name to construct the FTS table. ` +
            `Use the entity handle (e.g. Doc.${String(name)}.matches(...)) rather than the fields proxy.`,
        );
      };
    }
  } else {
    // Non-fts fields: .matches() is not supported. Throw a clear error.
    handle.matches = () => {
      throw new NonCompilableError(
        `field '${String(name)}' is not FTS-indexed. ` +
          `Declare it with text({ indexed: 'fts' }) to enable full-text search.`,
      );
    };
  }
  // vector fields expose a .nearest(query, k) predicate for top-K similarity
  // search. The predicate harvests to an AST node; the SQL lowerer stores the
  // nearest config and produces no-op SQL; the query layer post-filters rows
  // after computing cosine similarity in pure JS (brute-force, zero deps).
  if (descriptor.type === 'vector') {
    handle.nearest = (query: unknown, k: number) => {
      if (!Array.isArray(query)) {
        throw new NonCompilableError(
          `field '${String(name)}'.nearest(query, k) requires a query vector (number[]).`,
        );
      }
      if (!entityName) {
        throw new NonCompilableError(
          `field '${String(name)}'.nearest(query, k) requires an entity name to load rows. ` +
            `Use the entity handle (e.g. Entity.${String(name)}.nearest(...)).`,
        );
      }
      return makeNode({ node: 'nearest', entity: entityName, field: name, query, k });
    };
  } else {
    handle.nearest = () => {
      throw new NonCompilableError(
        `field '${String(name)}' is not a vector field. ` +
          `Only vector(dimensions) fields support .nearest().`,
      );
    };
  }

  registerSnapshotFieldHandle(handle);
  if (descriptor.type !== 'ref' || descriptor.role || typeof resolveEntity !== 'function') {
    return handle;
  }
  const targetReference = descriptor.target;
  const targetName = typeof targetReference === 'string'
    ? targetReference
    : (targetReference as { name?: unknown } | undefined)?.name;
  const target = targetReference ? resolveEntity(targetReference) : null;
  const targetRecord = target as { name?: unknown; fields?: Record<string, FieldDescriptor> } | null;
  if (!targetRecord?.fields) {
    return handle;
  }
  for (const [targetFieldName, targetDescriptor] of Object.entries(targetRecord.fields)) {
    if (targetDescriptor?.kind === 'store' && targetDescriptor.type === 'map') {
      handle[targetFieldName] = relationMapHandle({
        refFieldName: name,
        targetEntityName: String(targetRecord.name ?? targetName),
        targetFieldName,
      });
    }
  }
  return handle;
}

function relationMapHandle({ refFieldName, targetEntityName, targetFieldName }: {
  refFieldName: string;
  targetEntityName: string;
  targetFieldName: string;
}): FieldHandle {
  const fail = (): never => {
    throw new NonCompilableError(
      `field '${String(refFieldName)}.${String(targetFieldName)}' is a map field and cannot be compared in scope`,
    );
  };
  const tableName = membershipTable(targetEntityName, targetFieldName);
  const ownerCol = membershipOwnerCol(targetEntityName);
  return {
    fieldName: targetFieldName,
    is: fail,
    in: fail,
    isNull: fail,
    gte: fail,
    lte: fail,
    has: (value: unknown) => {
      if (value === PRINCIPAL_ID_TOKEN) {
        return makeNode({
          node: 'existsMembership',
          table: tableName,
          ownerCol,
          ownerField: refFieldName,
          param: PRINCIPAL_ID_PARAM,
        });
      }
      return makeNode({
        node: 'existsMembership',
        table: tableName,
        ownerCol,
        ownerField: refFieldName,
        value,
      });
    },
  };
}

// `fields.<name>` is a handle exposing the compilable value ops. Ops on a
// non-compilable field kind (crdt/ordered/store) are load-time errors. The
// proxy delegates to fieldHandle so there is one handle definition; it adds
// the scope-context `where` to the undeclared/non-value error messages.
function makeFieldsProxy(fields: Record<string, FieldDescriptor>, where: string, entityName?: string): unknown {
  return new Proxy({}, {
    get(_t, name) {
      const descriptor = fields[name as string];
      if (descriptor === undefined) {
        throw new NonCompilableError(`no field '${String(name)}' on this entity`, { where });
      }
      // struct delegates to fieldHandle (the namespace handle: sub-cells are
      // value handles, the struct's own .is throws). Other non-value kinds keep
      // the scope-context `where` on their non-compilable error.
      if (descriptor.kind !== 'value' && descriptor.kind !== 'struct') {
        const fail = (): never => {
          throw new NonCompilableError(
            `field '${String(name)}' is a ${descriptor.kind} field and cannot be compared in scope`,
            { where },
          );
        };
        return { is: fail, in: fail, isNull: fail, gte: fail, lte: fail };
      }
      return fieldHandle(name as string, descriptor, entityName);
    },
  });
}

// Harvest the AST by invoking the predicate once with the builders. Any throw is
// re-wrapped as NonCompilableError; a non-AST return is a NonCompilableError.
// The `registry` is the unified check registry (built by buildCheckRegistry) — it
// provides both harvest AND run faces, and the scope compiler consults its harvest
// faces exclusively.
export function harvest(
  predicate: (ctx: { is: unknown; fields: unknown }) => unknown,
  { fields, where, registry, entityName }: {
    fields: Record<string, unknown>;
    where: string;
    registry: Record<string, unknown>;
    entityName?: string;
  },
): AstNode {
  const is = makeIsProxy(registry, where);
  const fieldsProxy = makeFieldsProxy(fields as Record<string, FieldDescriptor>, where, entityName);
  let ast: unknown;
  try {
    ast = predicate({ is, fields: fieldsProxy });
  } catch (err) {
    if (err instanceof NonCompilableError) throw err;
    throw new NonCompilableError(`scope predicate threw: ${(err as Error).message}`, { where });
  }
  if (!isNode(ast)) {
    throw new NonCompilableError('scope predicate returned a non-AST value', { where });
  }
  return ast;
}

// ---- lowering ----------------------------------------------------------------
// lowerToSql(ast, ctx) -> { sql, params }. ctx carries the base table alias and
// a monotonic counter (via a mutable `next`) so composed fragments never collide
// on param names. Param keys are `:p<n>_<logical>`.
export interface LowerContext {
  alias?: string;
  state?: { n: number };
  params?: Record<string, unknown>;
  where?: string;
}

export interface NearestScope {
  entity: string;
  field: string;
  query: unknown;
  k: number;
}

export function lowerToSql(ast: AstNode, ctx: LowerContext = {}): { sql: string; params: Record<string, unknown>; nearest: NearestScope | null } {
  const alias = ctx.alias ?? 't0';
  const state = ctx.state ?? { n: 0 };
  const params: Record<string, unknown> = ctx.params ?? {};
  const col = (field: unknown) => `${alias}.${field}`;
  const freshParam = (logical: unknown) => `p${state.n += 1}_${logical}`;
  let nearestResult: NearestScope | null = null;

  const lower = (node: AstNode): string => {
    switch (node.node) {
      case 'true': return '1 = 1';
      case 'false': return '1 = 0';
      case 'eq': {
        if ('param' in node) {
          const key = freshParam(node.param);
          params[key] = null; // bound by the query layer to the concrete principal
          return `${col(node.field)} = :${key}`;
        }
        const key = freshParam('val');
        params[key] = node.value;
        return `${col(node.field)} = :${key}`;
      }
      case 'in': {
        const keys = (node.values as unknown[]).map((value, i) => {
          const key = `p${state.n += 1}_${i}`;
          params[key] = value;
          return `:${key}`;
        });
        return `${col(node.field)} IN (${keys.join(', ')})`;
      }
      case 'isNull': return `${col(node.field)} IS NULL`;
      case 'gte': {
        const key = freshParam('val');
        params[key] = node.value;
        return `${col(node.field)} >= :${key}`;
      }
      case 'lte': {
        const key = freshParam('val');
        params[key] = node.value;
        return `${col(node.field)} <= :${key}`;
      }
      case 'not': return `NOT (${lower(node.operand as AstNode)})`;
      case 'and': return `(${(node.operands as AstNode[]).map(lower).join(' AND ')})`;
      // A child's inherited scope: the row is admitted iff a parent row exists
      // that the FK points at AND that satisfies the parent's own scope. The
      // parent scope is re-lowered under a fresh subquery alias, sharing this
      // call's param state so its principalId placeholder lands in the same
      // params object (and so bindReadScope fills it once for the whole tree).
      case 'join': {
        const parentAlias = `j${state.n += 1}`;
        const inner = lower2(node.parentAst as AstNode, {
          alias: parentAlias,
          state,
          params,
          where: ctx.where,
        });
        const joinOn = `${parentAlias}.id = ${col(node.via)}`;
        return `EXISTS (SELECT 1 FROM ${node.parentName} AS ${parentAlias} WHERE ${joinOn} AND (${inner}))`;
      }
      // A map-membership check: the row is admitted iff the side-table
      // has a row whose owner FK points at THIS entity row AND whose member column
      // matches (plus optional role filter when `roles` is declared on the node).
      // When the node carries a `param` field, it uses the rebindable
      // principalId param; when it carries a `value` field, the literal is baked
      // in (not the requesting principal, so it must not be rebound per request).
      case 'existsMembership': {
        const mAlias = `j${state.n += 1}`;
        const ownerExpr = `${alias}.${node.ownerField ?? 'id'}`;
        let memberKey: string;
        if ('param' in node) {
          memberKey = freshParam(node.param);
          params[memberKey] = null;
        } else {
          // Literal value branch: bake the literal member id directly.
          memberKey = freshParam(MEMBER_COLUMN);
          params[memberKey] = node.value;
        }
        let roleClause = '';
        if (Array.isArray(node.roles) && node.roles.length > 0) {
          const roleKeys = (node.roles as unknown[]).map((role, i) => {
            const key = freshParam(`role_${i}`);
            params[key] = role;
            return `:${key}`;
          });
          roleClause = ` AND ${mAlias}.role IN (${roleKeys.join(', ')})`;
        }
        return `EXISTS (SELECT 1 FROM ${node.table} AS ${mAlias} WHERE ${mAlias}.${node.ownerCol} = ${ownerExpr} AND ${mAlias}.${MEMBER_COLUMN} = :${memberKey}${roleClause})`;
      }
      // A full-text-search MATCH predicate: the row is admitted iff the FTS5
      // virtual table has an entry for this row that matches the query. The
      // FTS table naming convention is {entity}_{field}_fts, with an
      // {entity}_id UNINDEXED column to correlate back to the main table.
      // MATCH must reference the full table name (FTS5 does not support table
      // aliases in the MATCH operator in node:sqlite's bundled SQLite).
      case 'match': {
        const ftsTable = `${node.entity}_${node.field}_fts`;
        const entityIdCol = `${node.entity}_id`;
        const mAlias = `j${state.n += 1}`;
        const key = freshParam('ftsQuery');
        params[key] = node.value;
        return `EXISTS (SELECT 1 FROM ${ftsTable} AS ${mAlias} WHERE ${ftsTable} MATCH :${key} AND ${mAlias}.${entityIdCol} = ${alias}.id)`;
      }
      // A nearest-neighbour vector search: the SQL produces no additional filter
      // (1=1); the query layer post-processes the result set by computing cosine
      // similarity in pure JS and returning the top-K rows. Only one nearest
      // predicate is valid per scope.
      case 'nearest': {
        if (nearestResult !== null) {
          throw new NonCompilableError(
            'only one .nearest() predicate is allowed per scope',
            { where: ctx.where },
          );
        }
        nearestResult = { entity: node.entity as string, field: node.field as string, query: node.query, k: node.k as number };
        return '1=1';
      }
      default:
        throw new NonCompilableError(`cannot lower AST node '${node.node}'`, { where: ctx.where });
    }
  };

  const sql = lower(ast);
  return { sql, params, nearest: nearestResult };
}

// A thin alias so the `join` case can recurse into lowerToSql for the parent's
// AST under a different alias while threading the same param state. Named so the
// recursion reads as "lower this sub-AST" rather than a bare self-reference.
function lower2(ast: AstNode, ctx: LowerContext): string {
  return lowerToSql(ast, ctx).sql;
}

// The compiled read-scope template: the parameterized SQL fragment plus the
// harvested AST (retained so a child entity's inherit directive can re-lower it
// under a join alias — the AST is the durable artifact, the SQL one rendering).
export interface ReadScopeTemplate {
  sql: string;
  params: Record<string, unknown>;
  nearest: NearestScope | null;
  ast: AstNode;
}

// Compile a scope predicate to its read-scope SQL template at entity-load, also
// returning the harvested AST so a child entity can re-lower it under a join
// alias (the inherit path). The AST is the durable artifact; the SQL is one
// rendering of it.
export function compileReadScope(
  predicate: (ctx: { is: unknown; fields: unknown }) => unknown,
  { fields, where, registry, entityName }: {
    fields: Record<string, unknown>;
    where: string;
    registry: Record<string, unknown>;
    entityName?: string;
  },
): ReadScopeTemplate {
  const ast = harvest(predicate, { fields, where, registry, entityName });
  return { ...lowerToSql(ast, { where }), ast };
}

// Compile an `inherit(Parent, { via })` directive to the child's read-scope
// template. The child has no scope of its own; its readability is a correlated
// EXISTS over the parent's compiled scope AST, joined through the `via` FK. The
// parent must carry its harvested scope AST (entity() stores it as `scopeAst`).
export function compileInheritScope(
  directive: { inherit: unknown; via?: unknown },
  { where }: { where: string },
): ReadScopeTemplate {
  const parent = directive.inherit as { name: string; scopeAst?: AstNode };
  if (!parent.scopeAst) {
    throw new NonCompilableError(
      `inherit(${parent.name}, ...) requires the parent to have a compiled ` +
        `read-scope, but ${parent.name} declares none.`,
      { where },
    );
  }
  const joinAst = Object.freeze({
    node: 'join',
    parentName: parent.name,
    parentAst: parent.scopeAst,
    via: directive.via,
  });
  return { ...lowerToSql(joinAst as unknown as AstNode, { where }), ast: joinAst as unknown as AstNode };
}

// The request-time bridge: bind a principal into a compiled read-scope template.
// The compiler leaves every principalId placeholder as `null`; here we copy the
// params and fill those placeholders with this principal's id (an anonymous
// principal's id is null, so its bound scope matches no owned row — fail-closed
// by construction, no special case). The SQL string is unchanged; the entity's
// stored template is never mutated (a fresh params object is returned), so one
// compiled scope serves every request concurrently.
export { cosineSimilarity, nearest } from './vector.ts';

export function bindReadScope(readScope: ReadScopeTemplate | undefined, principal: unknown): { sql: string; params: Record<string, unknown> } | undefined {
  if (readScope === undefined) return undefined;
  const params: Record<string, unknown> = {};
  const record = principal as { id?: unknown; attributes?: Record<string, unknown> } | null | undefined;
  for (const [key, value] of Object.entries(readScope.params)) {
    if (key.endsWith(`_${PRINCIPAL_ID_PARAM}`)) {
      params[key] = record?.id ?? null;   // the user principal's id (null if absent)
    } else if (key.endsWith(`_${PRINCIPAL_ATTR_PARAM}`)) {
      // The link principal's token (absent for a non-link principal → NULL →
      // `col = NULL` is false in SQL → the linkHolder arm never admits a row:
      // fail-closed, no special case for "no token").
      params[key] = record?.attributes?.token ?? null;
    } else {
      params[key] = value;
    }
  }
  return { sql: readScope.sql, params };
}

// ---- single-row scope evaluation (the authorization adapter's resource gate) --
//
// Evaluate a compiled read-scope template against ONE materialized row for a
// principal — pure JS, no database. The authorization adapter uses this so a
// registered resource's scope actually CONSTRAINS admission instead of being a
// registration-time validation artifact: the caller's read happened under this
// compiled scope, and admit() re-verifies the supplied row satisfies it.
//
// Value predicates (eq/in/isNull/gte/lte and the not/and/true/false combinators)
// evaluate against the row's STORED cells (the form SQL returns), mirroring
// SQLite's numeric/text coercion for equality and relational comparisons. A
// principal-id param resolves to the principal's id (an anonymous principal's
// id is null → the eq is unevaluable, exactly like `col = NULL` in SQL).
//
// The evaluator is THREE-VALUED (Kleene / SQL 3VL), not boolean. In SQL a NULL
// comparison (`col = NULL`, `col IN (NULL)`, `NULL >= x`) is neither true nor
// false — a WHERE clause treats it as "not satisfied", and NOT of it is STILL
// not satisfied. A boolean evaluator would reduce those to `false`, which `not`
// then flips to `true`, admitting rows the SQL path denies. So every decision
// the row alone cannot prove — a SQL NULL comparison, a membership/join/FTS
// predicate (their side tables are not visible to one row), or a caller-supplied
// row that omits a field the SQL path always returns — yields UNEVALUABLE,
// which `not` propagates (`NOT UNEVALUABLE === UNEVALUABLE`). Under `and`,
// `false AND UNEVALUABLE === false` (matching SQL 3VL): a provably false
// branch short-circuits `and` so De Morgan `anyOf(true, UNEVALUABLE)` =
// `NOT(AND(false, UNEVALUABLE))` = `true` (e.g. `anyOf(is.owner(), is.member())`
// still admits the owner in DB-less mode), while `true AND UNEVALUABLE ===
// UNEVALUABLE` (fail closed when no branch proves true). `nearest` lowers to no
// SQL filter (1=1), so it imposes no constraint and evaluates TRUE.

interface ScopeEvalContext {
  row: Record<string, unknown>;
  principal: unknown;
}

// The unevaluable third value: not `false`, so `not` cannot flip it to true and
// `and` cannot sweep it away. Only `=== true` at the top admits the row.
const UNEVALUABLE: unique symbol = Symbol('scope.unevaluable');
type ScopeTruth = true | false | typeof UNEVALUABLE;

// SQL NULL on either operand: `col = NULL`, `NULL = NULL`, and `NOT (col = NULL)`
// are all NULL in SQLite — none of them satisfy a WHERE clause.
const sqlNull = (value: unknown): boolean => value === null || value === undefined;

// The stored cell a predicate reads, distinguishing "the row omits this field"
// from "the field is present and NULL". A row the SQL path returns always
// carries every column, so an absent property is a caller-supplied incomplete
// row — it must not satisfy ANY predicate (not even isNull), and must not be
// flippable by negation, so absence is UNEVALUABLE, never a boolean.
function scopeCell(node: AstNode, ctx: ScopeEvalContext): unknown | typeof UNEVALUABLE {
  const row = ctx.row;
  const field = String(node.field);
  if (row === null || typeof row !== 'object' || !Object.hasOwn(row, field)) return UNEVALUABLE;
  const value = row[field];
  return value === undefined ? UNEVALUABLE : value;
}

// SQLite equality: `'1' = 1` is TRUE in SQL (the text is coerced to a number),
// so a stored text cell compares equal to a numeric literal and vice versa.
// Everything else is strict — NULL never equals a value (not even NULL; a NULL
// comparison is UNEVALUABLE upstream, never a boolean here) — and the coercion
// is deliberately narrow (only finite numeric text), never JS's `==` semantics.
function sqliteEqual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'string') {
    const numericB = Number(b);
    return Number.isFinite(numericB) && a === numericB;
  }
  if (typeof a === 'string' && typeof b === 'number') {
    const numericA = Number(a);
    return Number.isFinite(numericA) && numericA === b;
  }
  return false;
}

function evaluateScopeNode(node: AstNode, ctx: ScopeEvalContext): ScopeTruth {
  switch (node.node) {
    case 'true': return true;
    case 'false': return false;
    case 'eq': {
      const cell = scopeCell(node, ctx);
      if (cell === UNEVALUABLE) return UNEVALUABLE;
      // A rebindable principal param resolves to the principal's identity; an
      // absent identity binds NULL, and `col = NULL` is NULL in SQL. A NULL
      // operand is unevaluable, not false, so `NOT (col = v)` cannot flip it.
      const want = 'param' in node
        ? scopeParamValue(node, ctx)
        : node.value;
      if (sqlNull(want) || sqlNull(cell)) return UNEVALUABLE;
      return sqliteEqual(cell, want);
    }
    case 'in': {
      const cell = scopeCell(node, ctx);
      if (cell === UNEVALUABLE || sqlNull(cell)) return UNEVALUABLE;
      const values = node.values as unknown[];
      // `x IN (v...)` is `x = v1 OR ...` in SQLite. A NULL list value makes its
      // own comparison NULL: a real match still admits (TRUE OR NULL = TRUE),
      // but no match alongside a NULL entry is NULL → unevaluable.
      if (values.some((value) => !sqlNull(value) && sqliteEqual(cell, value))) return true;
      if (values.some(sqlNull)) return UNEVALUABLE;
      return false;
    }
    case 'isNull': {
      const cell = scopeCell(node, ctx);
      // An absent field is NOT SQL NULL — it is an incomplete row — so it can
      // neither satisfy `IS NULL` nor be flipped by an enclosing `not`.
      if (cell === UNEVALUABLE) return UNEVALUABLE;
      return cell === null;
    }
    // SQLite relational operators coerce both sides to numbers when either is
    // numeric; JS relational operators do the same, so plain >= / <= mirror the
    // SQL for both numeric and text columns. A NULL operand is unevaluable.
    case 'gte': {
      const cell = scopeCell(node, ctx);
      if (cell === UNEVALUABLE || sqlNull(cell) || sqlNull(node.value)) return UNEVALUABLE;
      return (cell as number) >= (node.value as number);
    }
    case 'lte': {
      const cell = scopeCell(node, ctx);
      if (cell === UNEVALUABLE || sqlNull(cell) || sqlNull(node.value)) return UNEVALUABLE;
      return (cell as number) <= (node.value as number);
    }
    case 'not': {
      const inner = evaluateScopeNode(node.operand as AstNode, ctx);
      return inner === UNEVALUABLE ? UNEVALUABLE : !inner;
    }
    case 'and': {
      // Standard SQL / Kleene three-valued logic:
      //   false AND anything === false  (so De Morgan anyOf(true, UNEVALUABLE) === true)
      //   true AND UNEVALUABLE === UNEVALUABLE (fail closed when no branch proves true)
      //   true AND true === true
      let hasUnevaluable = false;
      for (const operand of node.operands as AstNode[]) {
        const inner = evaluateScopeNode(operand as AstNode, ctx);
        if (inner === false) return false;
        if (inner === UNEVALUABLE) hasUnevaluable = true;
      }
      return hasUnevaluable ? UNEVALUABLE : true;
    }
    // `nearest` lowers to no SQL filter (1=1) — the query layer post-filters.
    case 'nearest': return true;
    // existsMembership / join / match need their side tables — unverifiable
    // against a single row without a database, so unevaluable (fail closed, and
    // never flippable by `not`).
    default: return UNEVALUABLE;
  }
}

function scopeParamValue(node: AstNode, ctx: ScopeEvalContext): unknown {
  const record = ctx.principal as { id?: unknown; attributes?: Record<string, unknown> } | null | undefined;
  if (node.param === PRINCIPAL_ID_PARAM) return record?.id ?? null;
  if (node.param === PRINCIPAL_ATTR_PARAM) return record?.attributes?.token ?? null;
  return null;
}

export function rowMatchesScope(
  template: ReadScopeTemplate,
  row: Record<string, unknown>,
  principal: unknown,
): boolean {
  try {
    return evaluateScopeNode(template.ast, { row, principal }) === true;
  } catch {
    return false;
  }
}
