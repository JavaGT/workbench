// The field-type plugin contract (Phase 1, SPEC §5.1 / §5.4, ADR #9).
//
// A field constructor returns an immutable FIELD DESCRIPTOR. The descriptor is
// the seam every later layer attaches to: the mutation pipeline reads its
// persistence strategy and validate; the entity compiler reads its kind, target
// FK, and derived-check role; the access engine reads its `.can` function (or,
// when absent, strong-inherits the row grant per ADR #4).
//
// The KINDS are named wholes, not a flag enum (ADR #9): `value` (single stored
// value, whole-value diff — text/boolean/date/number/ref; `blob` is a value with
// a marker), `crdt` (custom merge with per-element deltas), `hash` (one-way
// salted digest, never queryable — its own kind so scope refuses to compare),
// `store` (internally-keyed owned collection — map/log), `ordered` (fractional-
// index keyspace — list), `ephemeral` (live cells), `state` (transition-enforced
// state machine), `struct` (nested structure). Each is deferred-incremental: the
// descriptor ships at import; its persistence/merge/diff strategy fires later.

import { assertGuarded } from './guard/static.mjs';

// The descriptor's runtime access function (a field `.can(fn)` body). The shape
// is deliberately loose: the row-grant engine invokes it as
// `access({ is, entity: row }, defaults)` and a protecting annotation as
// `access({ is, entity: row, annotation })`.


// A declared `validate` option: returns `true` or a human-readable reason.


// Absence mode a declaration utility reads off a descriptor: required fields
// always project; optional ones may be missing/null on a delivered row.


// A field descriptor is frozen so no later layer can mutate a declared field.
// `.can(fn)` returns a NEW frozen descriptor carrying the access function — it
// never mutates the original (declarations are immutable). The `__value`/
// `__mode` phantoms are type-level only (never set at runtime): they carry the
// field's value type and absence mode so entity rows and snapshot projections
// are DERIVED from the declaration instead of hand-written beside it.













// The absence mode a descriptor carries for an options literal: `optional`
// makes the projected key omittable; everything else projects always.


// The value a descriptor carries for an options literal: `nullable` widens the
// base value with null (a column that stores NULL projects null).


function makeDescriptor(props              )                  {
  const descriptor                          = { access: undefined, ...props };
  descriptor.can = (fn               )                  => {
    // A field `.can` body is a runtime authorization body exactly like an
    // entity grant `.can`: reject an un-awaited `is.*` check at DECLARATION
    // time, not at request time (ADR #16 static guard). The runtime backstop
    // in check.ts stays as defense in depth.
    assertGuarded(fn                                   , { where: 'field .can body' });
    const { can, ...fields } = descriptor;
    return makeDescriptor({ ...fields, access: fn });
  };
  return Object.freeze(descriptor)                              ;
}

// `value` kind — a single stored value with whole-value diff. The default
// mechanism (the bare kind is the sensible default per the naming rule).
export function text                                    (options          = {}           )                                                                         {
  const { oneOf, validate, canonicalize, indexed, ...rest } = options;
  if (canonicalize !== undefined && typeof canonicalize !== 'function') {
    throw new Error('text({ canonicalize }) requires a function');
  }
  if (indexed !== undefined && indexed !== 'fts') {
    throw new Error(`text({ indexed }) only supports 'fts', got ${JSON.stringify(indexed)}`);
  }
  if (oneOf !== undefined) {
    if (!Array.isArray(oneOf) || oneOf.length === 0) {
      throw new Error('text({ oneOf }) requires a non-empty array of allowed values');
    }
    const values = Object.freeze([...oneOf]);
    const allowed = new Set(values);
    return makeDescriptor({
      kind: 'value',
      type: 'text',
      oneOf: values,
      validate: (v         ) => {
        if (!allowed.has(v)) return `expected one of [${values.join(', ')}]`;
        return typeof validate === 'function' ? validate(v) : true;
      },
      ...(canonicalize ? { canonicalize } : {}),
      ...(indexed ? { indexed } : {}),
      ...rest,
    })                                                                          ;
  }
  return makeDescriptor({ kind: 'value', type: 'text', validate, ...(canonicalize ? { canonicalize } : {}), ...(indexed ? { indexed } : {}), ...rest })                                                                          ;
}

export function annotatedText(options               = {})                  {
  return makeDescriptor({
    kind: 'annotatedText',
    type: 'annotatedText',
    annotations: Object.freeze([]),
    measurements: Object.freeze([]),
    ...options,
  });
}

// Declarative annotation/measurement constructors — re-exported from
// annotated-text-field.mjs for the public surface. Named here so the
// import-surface contract (index.mjs, internal.mjs) stays in field.mjs.
export { annotation, protectingAnnotation, measurement, annotationAction, annotationEntityAction, annotationEntityRemoveAction } from './annotated-text-field.mjs';
// Live-data tier vocabulary + declaration normalization (S3/A1) — the entity
// declaration slice. Re-exported here so the import-surface contract
// (index.mjs, internal.mjs) stays in field.mjs, matching the pattern above.
// `history`/`live`/`tier` are entity-level declaration options normalized into
// a resolved tier by normalizeTierDeclaration (default `history`/full — zero
// behavior change); tierOf() classifies a declared entity or resource.
export {
  normalizeTierDeclaration,
  tierOf,
  isDataTier,
  isEntityTier,
  DATA_TIERS,
  ENTITY_TIERS,
  TIER_DESCRIPTIONS,







} from './live-tier.mjs';
// `text.crdt()` — the `crdt` kind instance for collaborative text. One instance
// of the crdt contract, not a privileged special case (ADR #9).



(text               ).crdt = (options               = {}) =>
  makeDescriptor({ kind: 'crdt', type: 'text', ...options });

// `raster.crdt()` — the crdt kind instance for collaborative pixel buffers
// (photo-editor). Stores binary pixel data per-layer; per-region Porter-Duff
// compositing merge is deferred (whole-value replace for MVP).
export const raster = {
  crdt: (options               = {}) =>
    makeDescriptor({ kind: 'crdt', type: 'raster', ...options }),
};

// `polyline.crdt()` — the crdt kind instance for collaborative vector drawing
// (drawing-canvas). Stores an ordered array of point segments; per-element
// merge is deferred (whole-value replace for MVP).
export const polyline = {
  crdt: (options               = {}) =>
    makeDescriptor({ kind: 'crdt', type: 'polyline', ...options }),
};

export function boolean                                    (options          = {}           )                                                                          {
  return makeDescriptor({ kind: 'value', type: 'boolean', ...options })                                                                           ;
}

export function date                                    (options          = {}           )                                                                         {
  return makeDescriptor({ kind: 'value', type: 'date', ...options })                                                                          ;
}

// `number()` — a value-kind scalar (integer or float), stored as-is (SQLite
// binds JS numbers directly).
export function number                                    (options          = {}           )                                                                         {
  return makeDescriptor({ kind: 'value', type: 'number', ...options })                                                                          ;
}

// `json(shape)` — a value-kind structured JSON cell stored as TEXT. `shape` is
// declared config retained for future path/index support; app-specific runtime
// validation still belongs in the ordinary `validate` option.
export function json                                    (shape          = null, options          = {}           )                                                                          {
  return makeDescriptor({ kind: 'value', type: 'json', shape, ...options })                                                                           ;
}

// `hash()` — a one-way salted password digest. Its own KIND (not `value`): a
// plaintext password is digested on write and is NEVER queryable, so the scope
// compiler refuses to compare it (a hash handle's .is throws — fail closed). A
// hydrated row exposes `row.<field>.verify(plaintext)`; the stored cell is the
// salted digest, never the plaintext.
// `vector(dimensions)` — a fixed-length array of numbers stored as JSON TEXT.
// The field validates dimensions at write time (e.g. vector(1024) rejects a
// vector of length 1536). Cosine similarity search is brute-force (pure JS,
// zero runtime dependencies) — loads all rows, computes similarity, returns
// top-K. Same pattern as Scope's `Json` Prisma type.
export function vector                                    (dimensions        , options          = {}           )                                                                           {
  if (typeof dimensions !== 'number' || dimensions <= 0 || !Number.isInteger(dimensions)) {
    throw new Error('vector(dimensions) requires a positive integer dimension count');
  }
  return makeDescriptor({ kind: 'value', type: 'vector', dimensions, ...options })                                                                            ;
}

export function hash(options               = {})                  {
  return makeDescriptor({ kind: 'hash', type: 'hash', ...options });
}

// `ref(Target)` — a typed foreign key. `target` is explicit (no opaque sugar).
// `role` lets the entity compiler derive `is.<role>()` from the FK (the only
// thing the FK derives — no zero-to-one default grant, ADR #7). A ref projects
// (and queries by) the target row's TEXT id.
export function ref                                    (target         , options          = {}           )                                                                         {
  return makeDescriptor({ kind: 'value', type: 'ref', target, ...options })                                                                          ;
}

// `blob()` — a value-kind TEXT holding a blob id (a reference into the
// BlobStore). It is stored and validated as an ordinary text id; the `blob:
// true` marker is what buildKernel reads to auto-wire the blob adopter — a
// create/update carrying a blob id adopts that blob IN the dispatch commit
// (spec #2). The marker rides the descriptor; one declared field feeds the
// read/write/grant paths AND the adopter, not a parallel registration.
export function blob                                    (options          = {}           )                                                                         {
  return makeDescriptor({ kind: 'value', type: 'text', blob: true, ...options })                                                                          ;
}

// `link({ tiers, tier, token })` — the framework's first STRUCTURED field: one
// declared field owning several named STORED sub-cells plus declared CONFIG.
// It is the `struct` KIND — a namespace of named value sub-cells, each a real
// flat column, so a nested handle (linkShare.token.is(x)) reuses the ordinary
// value-handle `.is()` (the structured field is not a second comparison path;
// it is a namespace over the SAME value handle). The bare kind is `struct`;
// `type: 'link'` is the named instance (type-first, mechanism-second).
//
//   - token  — autogenerated opaque share token (per-row stored cell)
//   - tier   — the CURRENT tier this link grants (per-row stored cell)
//   - tiers  — allowed-tier domain config (declared once, NEVER a column)
//
// `cells` is the persisted half (each a `value`/text sub-descriptor); every
// other option (`tiers`, the `tier`/`token` defaults) is config. The split is
// explicit so the write path serializes only `cells` and the handle exposes a
// value sub-handle only for `cells` — `tiers` is not a queryable handle because
// it is not row data.
// `map(of, { role, default })` — an internally-keyed owned collection (the
// `store` KIND), each member keyed by id and carrying a value of the declared
// per-member descriptor `of` (doc.mjs: `map(ref('User'), { role:['viewer',
// 'editor'], default:{} })` — a set of collaborators, each a User FK carrying a
// role). It is the framework's owned-collection field: membership lives ON the
// owning entity (AGENTS: an owned relation is a field, not a standalone table),
// not a join table.
//
//   - of    — the per-member value descriptor (a ref, a text, …)
//   - role  — the role names a member may hold (feeds the role-derived checks
//             is.viewer()/is.editor() when the grant is compiled; declared CONFIG,
//             never a per-row column)
//   - default — the empty-collection default
//
// Import-surface scope: this constructor delivers the descriptor the entity
// compiler accepts. On a loaded row the field hydrates into a write handle
// exposing `.set(memberId, { role })`/`.remove(memberId)`/`.has(memberId)`/
// `.toArray()` against the `<Entity>_<field>` side-table (entity.mjs
// makeMapHandle). Map mutation events are entity-specific native event handles
// (`native('Doc', 'collaborators', 'added')`), not generic descriptor properties.
export function map(of         , { role, default: fallback }                                                   = {})                  {
  return makeDescriptor({
    kind: 'store',
    type: 'map',
    of,
    // role names are declared config (the membership's role domain), never a
    // per-row column — frozen so a later layer cannot mutate the declared set.
    roles: Object.freeze([...(role ?? [])]),
    default: fallback,
  });
}

// `log(entry)` — an append-only, internally-keyed owned collection of STRUCTURED
// entries (the `store` KIND, `type: 'log'`). Each entry has named sub-fields
// declared by the `entry` shape (doc.mjs: `log({ sender: ref('User'), body:
// text() })` — a chat log whose entries each carry a User-FK sender and text
// body). Like `map`, membership lives ON the owning entity (AGENTS: an owned
// relation is a field, not a separate entries table), not a separate entries table.
//
//   - entry — the per-entry sub-field descriptor map (each a value/ref/text
//             descriptor); declared shape, frozen so a later layer cannot mutate it.
//
// Import-surface scope: this constructor delivers the descriptor the entity
// compiler accepts. The append mutation, the `:appended:<id>` event handle, and
// any per-entry query are the `store` kind's Phase-2 merge/event behavior (the
// strategy's apply/diff already fail closed with a loud Phase-2 throw).
export function log(entry                          = {})                  {
  return makeDescriptor({
    kind: 'store',
    type: 'log',
    entry: Object.freeze({ ...entry }),
  });
}

// `list(of)` — the `ordered` KIND's first instance: a fractional-index
// keyspace. Each element has a STABLE `id` (identity, never re-keyed) and a
// fractional `key` (the sort position, mutable). insertAt mints a key BETWEEN
// the neighbor keys — siblings keep their keys (no renumber, the hallmark of
// fractional indexing vs an array shift); move re-keys ONLY the moved element;
// reorder re-keys the lot to a fresh evenly-spaced sequence (sugar over move).
//
//   - of — the per-element value descriptor (a text/ref/number …). Drives the
//          item's storage/serialization shape; scalar items store as a single
//          JSON cell on the side-table.
//
// Import-surface scope: this constructor delivers the descriptor the entity
// compiler accepts + the side-table DDL (ddl.mjs orderedTableDDL). On a loaded
// row the field hydrates into a write handle exposing `.insertAt(i, value)`/
// `.move(id, i)`/`.reorder([id, …])`/`.remove(id)`/`.toArray()` against the
// `<Entity>_<field>` side-table (entity.mjs makeOrderedListHandle). The
// per-element diff reconciles to this stored model in P6e's delta broadcast.
export function list(of         , options               = {})                  {
  return makeDescriptor({
    kind: 'ordered',
    type: 'list',
    of,
    ...options,
  });
}

// `computed({ compute })` — a read-time computed field. It stores no column;
// hydration recomputes it from the row every time.


export function computed({ compute }                          = {})                  {
  if (typeof compute !== 'function') {
    throw new Error('computed requires a compute function');
  }
  return makeDescriptor({
    kind: 'computed',
    mode: 'pull',
    compute,
    readonly: true,
  });
}

;


(computed                   ).stored = ({ compute }                          = {}) => {
  if (typeof compute !== 'function') {
    throw new Error('computed.stored requires a compute function');
  }
  return makeDescriptor({
    kind: 'computed',
    mode: 'stored',
    compute,
    readonly: true,
  });
};

// `projected.async({ compute })` — a stored computed field updated by a
// post-commit projection over the committed event log (ADR #12, SPEC §5.3).
// Unlike `computed()` (read-time pull), the value is materialized in the main
// table so it is queryable and sortable; unlike `computed.stored()` (cheap
// in-transaction compute), the compute MAY be expensive/async/external (e.g.
// thumbnail generation, embedding compute, image export). The column stores
// a JSON-serialized value; the compute function receives the current row
// (hydrated) plus the committed db handle and returns a JSON-serializable result.
//
// The field is implied readonly — a client may NOT set it; the projection
// writes it. A read sees the last-written value (may be stale between writes
// — the staleness contract is explicit, not silently invisible).
export const projected = {
  async: ({ compute, from }                                          = {}) => {
    if (typeof compute !== 'function') {
      throw new Error('projected.async requires a compute function');
    }
    return makeDescriptor({
      kind: 'projected',
      mode: 'async',
      compute,
      from: from ?? null,
      readonly: true,
    });
  },
};

// `ephemeral(cells)` — the general NON-PERSISTING field kind. Accepts an author-
// declared cell shape (richer than boolean toggles — e.g. a drawing canvas can
// hold a 60Hz in-progress stroke). It is its own KIND (`ephemeral`), a namespace
// of named live sub-cells. Its ephemerality is EMERGENT: it engages no persistence
// seam (no strategy entry, so it never serializes), per DECISIONLOG #51 — the
// absent seam IS the ephemerality. A side-table MAY hold per-connection cells
// (that is NOT the "persistence seam" — that's STRATEGIES/_Log); it's allowed.
//
//   - cells — the declared live sub-cells; the shape is config, frozen so a later
//             layer cannot mutate the declared set.
//
// Import-surface scope: this constructor delivers the descriptor the entity
// compiler accepts. The per-connection broadcast and volatile coalescing are
// the ephemeral kind's deferred live behavior.
export function ephemeral(cells                          = {})                  {
  return makeDescriptor({
    kind: 'ephemeral',
    type: 'ephemeral',
    cells: Object.freeze({ ...cells }),
  });
}

// `state({ values, transitions, effects, auto })` — a finite-state-machine
// field (its own KIND `state`). The field's value is one of a CLOSED `values`
// domain, and the only legal moves are those named in the `transitions` graph
// (fail closed: a move not in the graph is rejected — the value is not a
// free-form column the app may set to anything). doc.mjs: a Doc `status` moving
// draft → shared → archived, with an effect on shared→archived and an `auto`
// rule archiving a shared doc after 90 days.
//
//   - values      — the closed value domain (frozen; never a free column)
//   - transitions — the legal-move graph { from: [to, …] } (frozen)
//   - effects      — keyed by a `state.transition(from, to)` handle → an
//                    in-transaction effect ({ with } / { mutate, with })
//   - auto         — a time-driven auto-transition ({ when, after, to, from }),
//                    sugar lowered by the entity compiler into schedule.after
//                    using the explicit `from` date/number anchor (ADR #19)
//
// `state.transition(from, to)` is a STATIC method returning a typed, stable,
// stringifiable transition handle for transition-keyed effects.
//
// Import-surface scope: this constructor delivers the descriptor the entity
// compiler accepts. The compiler owns transition enforcement and auto lowering.
export function state                                                                                                                                                 (options          = {}           )                                                     {
  const { values, transitions, effects, auto } = options;
  return makeDescriptor({
    kind: 'state',
    type: 'state',
    values: Object.freeze([...(values ?? [])]),
    transitions: Object.freeze({ ...(transitions ?? {}) }),
    effects: Object.freeze({ ...(effects ?? {}) }),
    auto,
  })                                                      ;
}

// A state field's row value: the closed declared domain when it is a literal
// tuple of names, else plain string.
                                                                                                                                    ;
// A typed transition handle. It stringifies to a stable identifier encoding the
// from→to pair, so the same pair always yields the same computed-object key in
// an `effects` map — a derived identifier, never a magic string literal.







(state

 ).transition = (from         , to         )                   => {
  const handle                          = { brand: 'state-transition-handle', from, to };
  Object.defineProperty(handle, 'type', { value: `transition:${from}->${to}`, enumerable: true });
  Object.defineProperty(handle, 'toString', { value: () => handle.type, enumerable: false });
  return Object.freeze(handle)                               ;
};

export function link({ tiers, tier, token }                                                                  = {})                  {
  return makeDescriptor({
    kind: 'struct',
    type: 'link',
    cells: Object.freeze({ token: text(), tier: text() }),
    // config carried on the descriptor, never stored per row
    tiers: Object.freeze([...(tiers ?? [])]),
    // the materialization intents for the stored cells (write-path defaults):
    // `token: 'autogen'` means the framework mints the opaque token; `tier` is
    // the starting tier this link grants.
    tokenIntent: token,
    tierDefault: tier,
  });
}
